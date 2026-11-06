/**
 * Hasanify — Quick access side panel
 * ---------------------------------------------------------------------------
 * A Chrome side panel (chrome.sidePanel) that stays docked next to the page:
 *   • daily application counter with goal
 *   • Quick Access: autofill the current tab, save/mark the application,
 *     autofill settings
 *   • Profile: every value click-to-copy, searchable; "Insert" types a value
 *     into the field the user last clicked on the page (exact frame).
 *
 * The panel is global (one per window) and follows the active tab.
 */
'use strict';

const { DEFAULT_PROFILE, DEFAULT_SETTINGS, mergeWithDefaults, computeCompleteness } = globalThis.HasanifySchema;
const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

const KEYS = { profile: 'hasanify.profile', settings: 'hasanify.settings', apps: 'hasanify.applications' };

let profile = null;
let settings = { ...DEFAULT_SETTINGS };
let apps = [];
let tabId = null;      // the page this panel acts on
let windowId = null;
let focusTarget = null; // { frameId, label, at } for tabId

// Test/dev hook: ?tab=<id> pins the target tab (the panel normally follows the active tab).
const PINNED_TAB = Number(new URLSearchParams(location.search).get('tab')) || null;

// ═══════════════════════════════════════════════════════════════════════════
// Icons
// ═══════════════════════════════════════════════════════════════════════════
const svg = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  bolt: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  bookmark: svg('<path d="M6 3h12v18l-6-4-6 4z"/>'),
  sliders: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', 1.7),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  insert: svg('<path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>'),
  check: svg('<path d="m5 12 5 5 9-10"/>', 2.4),
};
function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]:not([data-icon-done])')) {
    const wrap = document.createElement('span');
    wrap.className = 'ico';
    wrap.innerHTML = ICONS[el.dataset.icon] ?? '';
    if (el.classList.contains('acc-ico') || el.classList.contains('icon-btn') || el.closest('.search')) el.innerHTML = ICONS[el.dataset.icon] ?? '';
    else el.prepend(wrap);
    el.setAttribute('data-icon-done', '');
  }
}

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ═══════════════════════════════════════════════════════════════════════════
// Target tab
// ═══════════════════════════════════════════════════════════════════════════
async function resolveTab() {
  if (PINNED_TAB) {
    tabId = PINNED_TAB;
  } else {
    windowId ??= (await chrome.windows.getCurrent()).id;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    tabId = tab?.id ?? null;
  }
  const res = tabId != null ? await send('hasanify:getFocusTarget', { tabId }).catch(() => null) : null;
  focusTarget = res?.target ?? null;
  await refreshPageInfo();
  renderProfile();
}

async function refreshPageInfo() {
  let info = null;
  if (tabId != null) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'hasanify:getPageInfo' }, { frameId: 0 });
      info = res?.info ?? null;
    } catch { /* restricted page or no content script yet */ }
  }
  pageInfo = info;
  const line = $('pageLine');
  if (info) {
    line.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = info.title || 'This page';
    line.append(b, document.createTextNode(` · ${info.company}${info.ats ? ` (${info.ats})` : ''}`));
  } else {
    line.textContent = 'Open a job application to autofill it.';
  }
  $('fillBtn').disabled = !info;
  // Prefill "Save application" unless the user is editing it.
  if (info && document.activeElement !== $('saveTitle') && document.activeElement !== $('saveCompany')) {
    $('saveTitle').value = info.title;
    $('saveCompany').value = info.company;
  }
}
let pageInfo = null;

// ═══════════════════════════════════════════════════════════════════════════
// Daily counter + saved applications
// ═══════════════════════════════════════════════════════════════════════════
const isToday = (ts) => new Date(ts).toDateString() === new Date().toDateString();

function renderCounter() {
  const goal = Math.max(1, Number(settings.dailyGoal) || 10);
  const n = apps.filter((a) => a.status === 'applied' && isToday(a.appliedAt ?? a.savedAt)).length;
  $('appliedToday').textContent = n;
  $('appliedWord').textContent = n === 1 ? 'Application' : 'Applications';
  $('goalText').textContent = `out of ${goal} today`;
  const bar = $('goalBar');
  bar.style.width = `${Math.min(100, (n / goal) * 100)}%`;
  bar.classList.toggle('done', n >= goal);
}

function renderRecent() {
  const box = $('recent');
  box.replaceChildren();
  const recent = [...apps].sort((a, b) => b.savedAt - a.savedAt).slice(0, 4);
  if (!recent.length) return;
  const title = document.createElement('div');
  title.className = 'recent-title';
  title.textContent = 'Recent';
  box.append(title);
  for (const a of recent) {
    const row = document.createElement('a');
    row.className = 'app';
    row.href = a.url;
    row.target = '_blank';
    row.innerHTML = '<div class="app-txt"><b></b><span></span></div><span class="pill"></span>';
    row.querySelector('b').textContent = a.title || a.url;
    row.querySelector('.app-txt span').textContent = `${a.company || ''}${a.company ? ' · ' : ''}${new Date(a.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    const pill = row.querySelector('.pill');
    pill.textContent = a.status === 'applied' ? 'Applied' : 'Saved';
    pill.classList.toggle('saved', a.status !== 'applied');
    box.append(row);
  }
}

async function saveApplication(status) {
  const url = pageInfo?.url;
  if (!url) {
    $('saveNote').textContent = 'Open the job page first.';
    $('saveNote').className = 'note err';
    return;
  }
  const now = Date.now();
  const existing = apps.find((a) => a.url === url);
  const entry = existing ?? { id: `${now}-${Math.random().toString(36).slice(2, 7)}`, url, savedAt: now };
  entry.title = $('saveTitle').value.trim() || pageInfo.title;
  entry.company = $('saveCompany').value.trim() || pageInfo.company;
  entry.ats = pageInfo.ats;
  if (status === 'applied' && entry.status !== 'applied') entry.appliedAt = now;
  entry.status = status === 'applied' ? 'applied' : entry.status ?? 'saved';
  if (!existing) apps.push(entry);
  await chrome.storage.local.set({ [KEYS.apps]: apps });
  $('saveNote').textContent = status === 'applied' ? `Marked as applied${existing ? ' (updated)' : ''}` : 'Saved for later';
  $('saveNote').className = 'note ok';
}

// ═══════════════════════════════════════════════════════════════════════════
// Profile: click to copy / insert
// ═══════════════════════════════════════════════════════════════════════════
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtYm = (ym) => {
  const m = /^(\d{4})-(\d{2})/.exec(ym ?? '');
  return m ? `${MONTH[+m[2] - 1]} ${m[1]}` : '';
};
const range = (e) => (e.startDate ? `${fmtYm(e.startDate)} – ${e.current ? 'Present' : fmtYm(e.endDate) || '…'}` : '');
const yesNo = (b) => (b === true ? 'Yes' : b === false ? 'No' : '');

/** [{ title, items: [[label, value], …] }] — empty values dropped. */
function buildGroups(p) {
  const me = p.personal ?? {}, a = me.address ?? {}, links = p.links ?? {}, wa = p.workAuthorization ?? {};
  const pr = p.preferences ?? {}, skills = p.skills ?? {}, docs = p.documents ?? {}, dv = p.diversity ?? {};
  const groups = [
    { title: 'Personal', items: [
      ['Full name', [me.firstName, me.middleName, me.lastName].filter(Boolean).join(' ')],
      ['First name', me.firstName], ['Last name', me.lastName], ['Preferred name', me.preferredName],
      ['Email', me.email], ['Phone', me.phone],
      ['Phone (with country code)', me.phone && me.phoneCountryCode ? `${me.phoneCountryCode} ${me.phone}` : ''],
      ['Pronouns', me.pronouns],
    ] },
    { title: 'Address', items: [
      ['Street', [a.line1, a.line2].filter(Boolean).join(', ')], ['City', a.city], ['State', a.state],
      ['Postal code', a.postalCode], ['Country', a.country], ['City, State', [a.city, a.state].filter(Boolean).join(', ')],
      ['Full address', [a.line1, a.line2, a.city, [a.state, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ')],
    ] },
    { title: 'Links', items: [
      ['LinkedIn', links.linkedin], ['GitHub', links.github], ['Portfolio', links.portfolio], ['Website', links.website], ['X / Twitter', links.twitter],
      ...(links.other ?? []).map((o) => [o.label || 'Link', o.url]),
    ] },
    ...(p.experience ?? []).map((e, i) => ({
      title: `Experience · ${e.company || `#${i + 1}`}`,
      items: [['Job title', e.title], ['Company', e.company], ['Location', e.location], ['Dates', range(e)],
        ['Start date', fmtYm(e.startDate)], ['End date', e.current ? 'Present' : fmtYm(e.endDate)], ['Description', e.description]],
    })),
    ...(p.education ?? []).map((e, i) => ({
      title: `Education · ${e.school || `#${i + 1}`}`,
      items: [['School', e.school], ['Degree', e.degree], ['Field of study', e.fieldOfStudy],
        ['Degree + field', [e.degree, e.fieldOfStudy].filter(Boolean).join(' in ')], ['GPA', e.gpa], ['Dates', range(e)], ['Graduation', fmtYm(e.endDate)]],
    })),
    { title: 'Skills', items: [
      ['Skills', (skills.technical ?? []).join(', ')], ['Certifications', (skills.certifications ?? []).join(', ')],
      ['Languages', (skills.spokenLanguages ?? []).map((l) => (l.proficiency ? `${l.language} (${l.proficiency})` : l.language)).join(', ')],
    ] },
    { title: 'Work authorization', items: [
      ['Authorized to work', yesNo(wa.authorizedToWork)], ['Requires sponsorship', yesNo(wa.requiresSponsorship)],
      ['Visa status', wa.visaStatus], ['Citizenship', wa.citizenship], ['Security clearance', wa.securityClearance],
    ] },
    { title: 'Preferences', items: [
      ['Desired salary', pr.desiredSalary], ['Notice period', pr.noticePeriod], ['Earliest start date', pr.earliestStartDate],
      ['Willing to relocate', yesNo(pr.willingToRelocate)], ['How did you hear about us', pr.howDidYouHear],
    ] },
    { title: 'Voluntary identification', items: [
      ['Gender', dv.gender], ['Race / ethnicity', dv.race], ['Hispanic or Latino', dv.hispanicOrLatino],
      ['Veteran status', dv.veteranStatus], ['Disability', dv.disabilityStatus],
    ] },
    { title: 'Answers', items: [...(p.customAnswers ?? []).map((c) => [c.question, c.answer]), ['Cover letter', docs.coverLetterText]] },
  ];
  return groups
    .map((g) => ({ ...g, items: g.items.filter(([, v]) => v != null && String(v).trim() !== '').map(([k, v]) => [k, String(v)]) }))
    .filter((g) => g.items.length);
}

function flash(row, cls) {
  row.classList.remove('copied', 'inserted');
  void row.offsetWidth;
  row.classList.add(cls);
  clearTimeout(row._t);
  row._t = setTimeout(() => row.classList.remove(cls), 1500);
}

async function copy(text, row) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  flash(row, 'copied');
}

async function insert(text, row) {
  if (!focusTarget || tabId == null) return copy(text, row);
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'hasanify:insertText', text }, { frameId: focusTarget.frameId });
    if (res?.ok) return flash(row, 'inserted');
  } catch { /* field gone / page navigated */ }
  await copy(text, row);
  toast('Couldn’t insert — copied instead');
}

function renderProfile() {
  const hasData = profile && computeCompleteness(profile).percent > 0;
  $('emptyProfile').hidden = !!hasData;
  $('profileArea').hidden = !hasData;
  if (!hasData) return;

  const tgt = $('target');
  if (focusTarget) {
    tgt.innerHTML = 'Insert into <b></b> · or click any value to copy';
    tgt.querySelector('b').textContent = `“${focusTarget.label}”`;
  } else {
    tgt.textContent = 'Click any value to copy it. Click into a form field to also get Insert.';
  }

  const q = $('search').value.trim().toLowerCase();
  const root = $('groups');
  root.replaceChildren();
  let shown = 0;
  for (const group of buildGroups(profile)) {
    const items = q ? group.items.filter(([k, v]) => `${group.title} ${k} ${v}`.toLowerCase().includes(q)) : group.items;
    if (!items.length) continue;
    const g = document.createElement('section');
    g.className = 'group';
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = group.title;
    g.append(title);
    for (const [label, value] of items) {
      shown++;
      const row = document.createElement('div');
      row.className = `item${value.length > 70 ? ' long' : ''}`;
      row.title = 'Click to copy';
      row.innerHTML = `<div class="item-main"><span class="k"></span><span class="v"></span></div>
        ${focusTarget ? `<button class="act insert" title="Insert into the field on the page">${ICONS.insert}Insert</button>` : ''}
        <button class="act copy" title="Copy">${ICONS.copy}</button>`;
      row.querySelector('.k').textContent = label;
      row.querySelector('.v').textContent = value;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.insert')) insert(value, row);
        else copy(value, row);
      });
      g.append(row);
    }
    root.append(g);
  }
  $('noMatch').hidden = shown > 0;
  $('noMatch').textContent = `No matches for “${q}”.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings accordion
// ═══════════════════════════════════════════════════════════════════════════
function renderSettings() {
  for (const el of document.querySelectorAll('[data-setting]')) {
    const v = settings[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
}
function bindSettings() {
  for (const el of document.querySelectorAll('[data-setting]')) {
    el.addEventListener('change', async () => {
      const key = el.dataset.setting;
      settings[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Math.max(1, Number(el.value) || 10) : el.value;
      await send('hasanify:saveSettings', { settings });
      toast('Setting saved');
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Boot + live updates
// ═══════════════════════════════════════════════════════════════════════════
async function loadAll() {
  const stored = await chrome.storage.local.get([KEYS.profile, KEYS.settings, KEYS.apps]);
  profile = mergeWithDefaults(DEFAULT_PROFILE, stored[KEYS.profile]);
  settings = mergeWithDefaults(DEFAULT_SETTINGS, stored[KEYS.settings]);
  apps = stored[KEYS.apps] ?? [];
}

function openDashboard(hash) {
  if (hash) chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html#${hash}`) });
  else chrome.runtime.openOptionsPage();
}

(async function init() {
  hydrateIcons();
  await loadAll();
  renderCounter();
  renderRecent();
  renderSettings();
  bindSettings();
  await resolveTab();

  $('openDashboard').addEventListener('click', () => openDashboard());
  $('editProfile').addEventListener('click', () => openDashboard());
  $('createProfile').addEventListener('click', () => openDashboard('ai'));
  $('search').addEventListener('input', renderProfile);
  $('markApplied').addEventListener('click', () => saveApplication('applied'));
  $('saveLater').addEventListener('click', () => saveApplication('saved'));
  $('fillBtn').addEventListener('click', async () => {
    $('fillBtn').disabled = true;
    $('fillNote').className = 'note';
    $('fillNote').textContent = 'Filling…';
    let res;
    try {
      res = await chrome.tabs.sendMessage(tabId, { type: 'hasanify:fill', force: true });
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    $('fillBtn').disabled = false;
    if (!res?.ok) {
      $('fillNote').className = 'note err';
      $('fillNote').textContent = 'Couldn’t fill this page — try reloading it.';
      return;
    }
    const s = res.stats ?? {};
    $('fillNote').className = 'note ok';
    $('fillNote').textContent = `Filled ${s.filled ?? 0} field${s.filled === 1 ? '' : 's'}. Review before submitting.`;
  });

  // Keep in sync with the browser and with edits made elsewhere.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (KEYS.profile in changes || KEYS.settings in changes || KEYS.apps in changes) {
      await loadAll();
      renderCounter();
      renderRecent();
      renderSettings();
      renderProfile();
    }
  });
  if (!PINNED_TAB) {
    chrome.tabs.onActivated.addListener((info) => { if (info.windowId === windowId) resolveTab(); });
    chrome.tabs.onUpdated.addListener((id, change) => { if (id === tabId && change.status === 'complete') resolveTab(); });
  }
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === 'hasanify:focusTarget' && sender.tab?.id === tabId) {
      focusTarget = { frameId: sender.frameId ?? 0, label: msg.label, at: msg.at };
      renderProfile();
    }
  });
  // Midnight rollover for "today".
  setInterval(renderCounter, 60_000);
})();
