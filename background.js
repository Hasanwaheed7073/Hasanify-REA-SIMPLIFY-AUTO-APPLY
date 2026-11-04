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

importScripts('shared/profile-schema.js');

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

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'fill-form') return;
  const tabId = await getActiveTabId();
  if (tabId != null) await triggerFill(tabId);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab?.id != null) triggerFill(tab.id);
});

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
  const sum = { filled: 0, matched: 0, total: 0, unmatched: [] };
  if (!frames) return sum;
  for (const s of frames.values()) {
    sum.filled += s.filled ?? 0;
    sum.matched += s.matched ?? 0;
    sum.total += s.total ?? 0;
    sum.unmatched.push(...(s.unmatched ?? []));
  }
  return sum;
}

chrome.tabs.onRemoved.addListener((tabId) => tabStats.delete(tabId));
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
  'hasanify:getContext': async () => ({ ok: true, profile: await getProfile(), settings: await getSettings() }),

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
  'hasanify:getTabStats': async () => ({ ok: true, stats: summarizeTab(await getActiveTabId()) }),

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
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true; // keep the channel open for the async response
});
