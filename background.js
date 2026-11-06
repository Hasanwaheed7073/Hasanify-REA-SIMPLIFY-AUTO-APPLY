/**
 * Hasanify — Background service worker (Manifest V3)
 * ---------------------------------------------------------------------------
 * Responsibilities
 *   • Owns persistent state: the profile + settings in chrome.storage.local.
 *   • Acts as the message hub between popup ⇄ content scripts.
 *   • Triggers fills (toolbar popup, keyboard command, context menu), injecting
 *     the content script on demand into tabs opened before install/update.
 *   • Aggregates per-frame fill stats into a per-tab badge count.
 *
 * MV3 service workers are killed when idle. Nothing here relies on globals
 * surviving between events except the cosmetic stats Map (the badge itself is
 * persisted by Chrome, so losing the Map only loses the per-frame breakdown).
 */
'use strict';

importScripts('shared/profile-schema.js', 'shared/ai.js');

const { DEFAULT_PROFILE, DEFAULT_SETTINGS, mergeWithDefaults, validateProfile } = self.HasanifySchema;

const KEYS = Object.freeze({
  profile: 'hasanify.profile',
  settings: 'hasanify.settings',
});

const CONTENT_FILES = ['shared/profile-schema.js', 'content.js', 'ui/widget.js'];
const MENU_ID = 'hasanify-fill';

/** tabId -> Map(frameId -> { filled, matched, total, unmatched }) */
const tabStats = new Map();

// ───────────────────────────────────────────────────────────────────────────
// Storage helpers
// ───────────────────────────────────────────────────────────────────────────

async function getProfile() {
  const { [KEYS.profile]: stored } = await chrome.storage.local.get(KEYS.profile);
  // Always merge so content scripts never see missing keys after a schema bump.
  return mergeWithDefaults(DEFAULT_PROFILE, stored);
}

async function getSettings() {
  const { [KEYS.settings]: stored } = await chrome.storage.local.get(KEYS.settings);
  return mergeWithDefaults(DEFAULT_SETTINGS, stored);
}

async function saveProfile(input) {
  const merged = mergeWithDefaults(DEFAULT_PROFILE, input);
  const { valid, errors } = validateProfile(merged);
  if (!valid) return { ok: false, errors };
  await chrome.storage.local.set({ [KEYS.profile]: merged });
  await clearAiCache(); // AI answers were derived from the old profile
  return { ok: true, profile: merged };
}

async function saveSettings(input) {
  const merged = mergeWithDefaults(DEFAULT_SETTINGS, input);
  await chrome.storage.local.set({ [KEYS.settings]: merged });
  return { ok: true, settings: merged };
}

// ───────────────────────────────────────────────────────────────────────────
// Install / update: seed storage, migrate, register context menu
// ───────────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // First install → open the dashboard so the user sets up their profile.
  if (reason === 'install') chrome.runtime.openOptionsPage();

  // Re-saving through mergeWithDefaults is our migration step: new schema keys
  // receive defaults, existing user data is preserved.
  await chrome.storage.local.set({
    [KEYS.profile]: await getProfile(),
    [KEYS.settings]: await getSettings(),
  });

  // After an install/update/reload, tabs that were already open still run the
  // OLD content script, whose connection to the extension is now dead (buttons
  // do nothing). Inject the fresh scripts so open applications keep working
  // without the user having to refresh every tab.
  injectIntoOpenTabs();

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Hasanify: fill this application',
      contexts: ['page', 'frame', 'editable'],
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Fill triggering
// ───────────────────────────────────────────────────────────────────────────

/**
 * Ask every frame in the tab to fill. If no content script answers (tab was
 * open before the extension loaded, or it was reloaded), inject it into all
 * frames programmatically and retry once.
 */
async function triggerFill(tabId, { force = true } = {}) {
  const message = { type: 'hasanify:fill', force };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_FILES });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      // chrome://, the Web Store, PDF viewer etc. cannot be scripted.
      await chrome.action.setBadgeText({ tabId, text: '!' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
      return { ok: false, error: `Cannot fill this page: ${err.message}` };
    }
  }
}

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((t) =>
    chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: CONTENT_FILES }).catch(() => {})));
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

// ───────────────────────────────────────────────────────────────────────────
// Quick access side panel
// ───────────────────────────────────────────────────────────────────────────
// chrome.sidePanel.open() only works while a user gesture is active, so every
// caller invokes it synchronously — before any await.

function openSidePanel(windowId) {
  if (windowId == null) return Promise.resolve({ ok: false, error: 'No window' });
  return chrome.sidePanel.open({ windowId }).then(() => ({ ok: true }), (err) => ({ ok: false, error: err.message }));
}

chrome.commands.onCommand.addListener((command, tab) => {
  // Command keeps its original id so a user's existing Alt+Shift+C binding survives updates.
  if (command === 'open-quick-copy') {
    openSidePanel(tab?.windowId); // synchronous: keyboard shortcut is a user gesture
    return;
  }
  if (command === 'fill-form') getActiveTabId().then((tabId) => tabId != null && triggerFill(tabId));
});

/**
 * Last page field the user clicked into, per tab — including WHICH frame, so
 * the side panel's "Insert" reaches the right input even inside iframes.
 */
const focusByTab = new Map(); // tabId -> { frameId, label, at }

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab?.id != null) triggerFill(tab.id);
});

// ───────────────────────────────────────────────────────────────────────────
// Learning: answers the user gave, and questions Hasanify missed
// ───────────────────────────────────────────────────────────────────────────

const COMPANIES_KEY = 'hasanify.companies';   // employers of applications filled (newest first)
const APPS_KEY = 'hasanify.applications';      // tracker: [{ id, url, title, company, ats, status, savedAt, appliedAt, followUpAt, resume, source, notes, history }]

// ───────────────────────────────────────────────────────────────────────────
// Applications tracker
// ───────────────────────────────────────────────────────────────────────────
// Statuses move forward only when logged automatically: a re-submit never
// turns an "interview" back into "applied". The user can set anything by hand.

const APP_STATUSES = ['saved', 'applied', 'interview', 'offer', 'rejected', 'withdrawn'];
const DAY = 86400000;
/** Same posting even if the URL picked up tracking params or a /apply suffix. */
const urlKey = (u) => {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/(apply|application|thanks|thank-you|confirmation|submitted)\/?$/i, '').replace(/\/+$/, '')}`.toLowerCase();
  } catch { return String(u ?? '').toLowerCase(); }
};

async function logApplication(app) {
  if (!app?.url) return { ok: false, error: 'No URL' };
  const [{ [APPS_KEY]: apps = [] }, settings] = await Promise.all([chrome.storage.local.get(APPS_KEY), getSettings()]);
  const now = Date.now();
  const key = urlKey(app.url);
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const existing = apps.find((a) => urlKey(a.url) === key) ??
    apps.find((a) => app.company && app.title && norm(a.company) === norm(app.company) && norm(a.title) === norm(app.title) && now - (a.appliedAt ?? a.savedAt ?? 0) < 30 * DAY);
  const entry = existing ?? { id: `${now}-${Math.random().toString(36).slice(2, 7)}`, url: app.url, savedAt: now, history: [] };
  entry.title ||= app.title ?? '';
  entry.company ||= app.company ?? '';
  entry.ats ||= app.ats ?? '';
  if (app.resume) entry.resume = app.resume;
  entry.source ??= 'auto';
  if (!entry.status || entry.status === 'saved') {
    entry.status = 'applied';
    entry.appliedAt = now;
    entry.followUpAt ??= now + Math.max(1, Number(settings.followUpDays) || 7) * DAY;
    (entry.history ??= []).push({ status: 'applied', at: now, by: 'auto' });
  }
  if (!existing) apps.push(entry);
  await chrome.storage.local.set({ [APPS_KEY]: apps });
  return { ok: true, id: entry.id, created: !existing };
}
const SITE_NOTES_KEY = 'hasanify.siteNotes';   // { [site]: { slow, at } }
/** Dashboard / popup / side panel — not a web page's content script. */
const isExtensionPage = (sender) => !sender.tab || String(sender.url ?? '').startsWith(`chrome-extension://${chrome.runtime.id}/`);
const MISSED_KEY = 'hasanify.missed';          // { [key]: { question, count, firstSeen, lastSeen, hosts, reason, required, learned } }
const MISSED_IGNORED_KEY = 'hasanify.missedIgnored'; // [key]
const MISSED_CAP = 400;

/** Upsert a learned custom answer (keyed by normalized, {company}-templated question). */
/**
 * Learned answers keep VARIANTS per job context. The same question can have a
 * different right answer for a senior vs junior role, remote vs on-site, or
 * another country, and each site remembers what you used there last time.
 *   • same answer already known          → refresh that variant's context
 *   • same site, or same seniority/remote/country → that variant is replaced
 *   • otherwise                           → a new variant is added (max 6 per question)
 */
const ctxClass = (c) => `${c?.seniority ?? ''}|${c?.remote ?? ''}|${c?.country ?? ''}`;
const MAX_VARIANTS = 6;

async function learnAnswer({ question, key, answer, kind, host, ctx }) {
  if (!question || !key || !answer) return { ok: false, error: 'Nothing to learn' };
  const profile = await getProfile();
  const list = profile.customAnswers ?? [];
  const variants = list.filter((c) => c.source === 'learned' && c.key === key);
  const now = Date.now();
  const cleanCtx = ctx && typeof ctx === 'object'
    ? { site: String(ctx.site ?? ''), seniority: String(ctx.seniority ?? ''), remote: String(ctx.remote ?? ''), country: String(ctx.country ?? '') }
    : null;
  const existing =
    variants.find((c) => c.answer === answer) ??
    (cleanCtx && variants.find((c) => c.ctx?.site && c.ctx.site === cleanCtx.site)) ??
    (cleanCtx && variants.find((c) => c.ctx && ctxClass(c.ctx) === ctxClass(cleanCtx))) ??
    (!cleanCtx ? (variants.find((c) => !c.ctx) ?? variants[0]) : null);
  if (existing) {
    Object.assign(existing, { answer, kind, learnedFrom: host ?? existing.learnedFrom, updatedAt: now, ...(cleanCtx ? { ctx: cleanCtx } : {}) });
  } else {
    list.push({ question, answer, isRegex: false, source: 'learned', key, kind, learnedFrom: host ?? '', updatedAt: now, ...(cleanCtx ? { ctx: cleanCtx } : {}) });
    // Too many variants: drop the oldest.
    const all = list.filter((c) => c.source === 'learned' && c.key === key).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const old of all.slice(0, Math.max(0, all.length - MAX_VARIANTS))) list.splice(list.indexOf(old), 1);
  }
  profile.customAnswers = list;
  const res = await saveProfile(profile);
  if (!res.ok) return res;

  const { [MISSED_KEY]: missed = {} } = await chrome.storage.local.get(MISSED_KEY);
  if (missed[key]) {
    missed[key].learned = true;
    await chrome.storage.local.set({ [MISSED_KEY]: missed });
  }
  return { ok: true };
}

async function recordMissed(items, host) {
  const { [MISSED_KEY]: missed = {}, [MISSED_IGNORED_KEY]: ignored = [] } = await chrome.storage.local.get([MISSED_KEY, MISSED_IGNORED_KEY]);
  const profile = await getProfile();
  const learnedKeys = new Set((profile.customAnswers ?? []).filter((c) => c.source === 'learned').map((c) => c.key));
  const now = Date.now();
  for (const it of items ?? []) {
    if (!it?.key || ignored.includes(it.key)) continue;
    const row = missed[it.key] ?? { question: it.question, count: 0, firstSeen: now, hosts: [] };
    row.count += 1;
    row.lastSeen = now;
    row.reason = it.reason;
    row.required = !!(row.required || it.required);
    row.learned = learnedKeys.has(it.key);
    if (host && !row.hosts.includes(host)) row.hosts = [host, ...row.hosts].slice(0, 5);
    missed[it.key] = row;
  }
  // Cap history: drop the least recently seen.
  const keys = Object.keys(missed);
  if (keys.length > MISSED_CAP) {
    keys.sort((a, b) => missed[a].lastSeen - missed[b].lastSeen).slice(0, keys.length - MISSED_CAP).forEach((k) => delete missed[k]);
  }
  await chrome.storage.local.set({ [MISSED_KEY]: missed });
  return { ok: true };
}

// ───────────────────────────────────────────────────────────────────────────
// Stats / badge
// ───────────────────────────────────────────────────────────────────────────

async function recordReport(tabId, frameId, stats) {
  if (tabId == null) return;
  if (!tabStats.has(tabId)) tabStats.set(tabId, new Map());
  tabStats.get(tabId).set(frameId, stats);

  let filled = 0;
  for (const s of tabStats.get(tabId).values()) filled += s.filled ?? 0;

  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#16a34a' });
  await chrome.action.setBadgeText({ tabId, text: filled ? String(filled) : '' });
}

function summarizeTab(tabId) {
  const frames = tabStats.get(tabId);
  const sum = { filled: 0, matched: 0, total: 0, todo: 0, unmatched: [] };
  if (!frames) return sum;
  for (const s of frames.values()) {
    sum.filled += s.filled ?? 0;
    sum.matched += s.matched ?? 0;
    sum.total += s.total ?? 0;
    sum.todo += s.todo ?? 0;
    sum.unmatched.push(...(s.unmatched ?? []));
  }
  return sum;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStats.delete(tabId);
  focusByTab.delete(tabId);
  chrome.storage.session.remove(armKey(tabId)).catch(() => {});
});

// ───────────────────────────────────────────────────────────────────────────
// Tab "application session" arming
// ───────────────────────────────────────────────────────────────────────────
// A fill only lives as long as its document. Many applications are several
// full page loads (iCIMS, Taleo, SuccessFactors, company career sites), so
// once the user fills anything in a tab we remember that site for the tab and
// every later page of it auto-fills. Kept in storage.session so it survives
// service-worker restarts but not the browser session.

const armKey = (tabId) => `hasanify.armed.${tabId}`;

// Applications often hop domains mid-way (careers.acme.com → acme.icims.com,
// LinkedIn → Workday). Within this window after the last fill in the tab, a
// page on a NEW site that looks like an application is followed too.
const CROSS_SITE_FOLLOW_MS = 20 * 60 * 1000;

async function getArmState(tabId) {
  const { [armKey(tabId)]: v } = await chrome.storage.session.get(armKey(tabId));
  if (Array.isArray(v)) return { sites: v, at: 0 }; // pre-0.3.1 format
  return { sites: v?.sites ?? [], at: v?.at ?? 0 };
}

async function setTabArmed(tabId, site, armed) {
  if (tabId == null || !site) return;
  const state = await getArmState(tabId);
  const sites = new Set(state.sites);
  if (armed) sites.add(site); else sites.delete(site);
  await chrome.storage.session.set({
    [armKey(tabId)]: { sites: [...sites], at: armed ? Date.now() : (sites.size ? state.at : 0) },
  });
}

async function isTabArmed(tabId, site) {
  if (tabId == null) return { armed: false, recent: false };
  const { sites, at } = await getArmState(tabId);
  return { armed: sites.includes(site), recent: Date.now() - at < CROSS_SITE_FOLLOW_MS };
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // A real navigation (not an SPA pushState) resets the counter.
  if (info.status === 'loading' && info.url) {
    tabStats.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Message router
// ───────────────────────────────────────────────────────────────────────────

const HANDLERS = {
  // content script ← needs data to fill with
  'hasanify:getContext': async (msg) => {
    const { [COMPANIES_KEY]: companies = [], [SITE_NOTES_KEY]: notes = {}, 'hasanify.applications': apps = [] } =
      await chrome.storage.local.get([COMPANIES_KEY, SITE_NOTES_KEY, 'hasanify.applications']);
    const all = [...new Set([...companies, ...apps.map((a) => a?.company).filter(Boolean)])];
    return { ok: true, profile: await getProfile(), settings: await getSettings(), companies: all, siteNote: notes[msg.site] ?? null };
  },

  // content script → employer of an application it filled (for the wrong-company check)
  // popup → form structure of every frame in the active tab (for support; no field values)
  'hasanify:collectDiagnostics': async () => {
    const tabId = await getActiveTabId();
    if (tabId == null) return { ok: false, error: 'No active tab' };
    let results = [];
    try {
      results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => globalThis.HasanifyEngine?.diagnostics?.() ?? null });
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    const parts = results.map((r) => r.result).filter(Boolean);
    return parts.length
      ? { ok: true, text: parts.join('\n\n──── frame ────\n') }
      : { ok: false, error: 'Hasanify is not running on this page — reload it and try again' };
  },

  // content script → the user clicked the final Submit on a form Hasanify filled
  'hasanify:logApplication': (msg) => logApplication(msg.app),

  'hasanify:noteCompany': async (msg) => {
    const c = String(msg.company ?? '').trim();
    if (c.length < 3 || c.length > 60) return { ok: false };
    const { [COMPANIES_KEY]: list = [] } = await chrome.storage.local.get(COMPANIES_KEY);
    await chrome.storage.local.set({ [COMPANIES_KEY]: [c, ...list.filter((x) => x.toLowerCase() !== c.toLowerCase())].slice(0, 300) });
    return { ok: true };
  },
  // content script → what it learned about a site's form (e.g. re-renders late)
  'hasanify:siteNote': async (msg) => {
    if (!msg.site) return { ok: false };
    const { [SITE_NOTES_KEY]: notes = {} } = await chrome.storage.local.get(SITE_NOTES_KEY);
    notes[msg.site] = { ...notes[msg.site], ...msg.note, at: Date.now() };
    await chrome.storage.local.set({ [SITE_NOTES_KEY]: notes });
    return { ok: true };
  },

  // AI assist — the key never leaves the background
  'hasanify:aiResolve': async (msg) => {
    if (!(await getSettings()).aiAssist) return { ok: false, error: 'AI assist is off' };
    return resolveQuestions(msg.items, msg.job, await getProfile());
  },
  'hasanify:aiGetConfig': () => getAiPublicConfig().then((config) => ({ ok: true, config })),
  'hasanify:aiSaveConfig': (msg, sender) => (isExtensionPage(sender) ? saveAiConfig(msg) : { ok: false, error: 'Not allowed' }),
  'hasanify:aiTest': (msg, sender) => (isExtensionPage(sender) ? testAi() : { ok: false, error: 'Not allowed' }),

  // popup → persistence
  'hasanify:getProfile': async () => ({ ok: true, profile: await getProfile() }),
  'hasanify:saveProfile': (msg) => saveProfile(msg.profile),
  'hasanify:getSettings': async () => ({ ok: true, settings: await getSettings() }),
  'hasanify:saveSettings': (msg) => saveSettings(msg.settings),
  'hasanify:getSchema': () => ({ ok: true, schema: self.HasanifySchema.PROFILE_JSON_SCHEMA }),

  // popup → fill current tab
  'hasanify:fillActiveTab': async () => {
    const tabId = await getActiveTabId();
    if (tabId == null) return { ok: false, error: 'No active tab' };
    const res = await triggerFill(tabId);
    // Frames report asynchronously; give them a moment before summarizing.
    await new Promise((r) => setTimeout(r, 300));
    return { ok: res?.ok !== false, error: res?.error, stats: summarizeTab(tabId) };
  },
  // content script → learning
  'hasanify:learnAnswer': (msg) => learnAnswer(msg),
  'hasanify:recordMissed': (msg) => recordMissed(msg.items, msg.host),

  // content script → "user focused this field" (fuel for the side panel's Insert)
  'hasanify:focusTarget': (msg, sender) => {
    if (sender.tab?.id != null) focusByTab.set(sender.tab.id, { frameId: sender.frameId ?? 0, label: msg.label, at: msg.at });
    return { ok: true };
  },
  'hasanify:getFocusTarget': (msg) => ({ ok: true, target: focusByTab.get(msg.tabId) ?? null }),

  'hasanify:getTabStats': async () => ({ ok: true, stats: summarizeTab(await getActiveTabId()) }),

  // content script ↔ multi-page application session
  'hasanify:setTabArmed': (msg, sender) => setTabArmed(sender.tab?.id, msg.site, !!msg.armed).then(() => ({ ok: true })),
  'hasanify:isTabArmed': async (msg, sender) => ({ ok: true, ...(await isTabArmed(sender.tab?.id, msg.site)) }),

  // widget → open the profile dashboard
  'hasanify:openOptions': async (msg) => {
    if (msg.hash && /^[a-z-]+$/.test(msg.hash)) {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html#${msg.hash}`) });
    } else {
      await chrome.runtime.openOptionsPage();
    }
    return { ok: true };
  },

  // content script → stats after each run
  'hasanify:report': (msg, sender) => recordReport(sender.tab?.id, sender.frameId ?? 0, msg.stats).then(() => ({ ok: true })),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Must run synchronously inside the click that sent it (user-gesture rule).
  if (msg?.type === 'hasanify:openSidePanel') {
    openSidePanel(sender.tab?.windowId ?? msg.windowId).then(sendResponse);
    return true;
  }
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true; // keep the channel open for the async response
});
