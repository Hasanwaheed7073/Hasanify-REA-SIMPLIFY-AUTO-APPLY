/**
 * Hasanify — Toolbar popup
 * Page status, one-click autofill, last results for this tab, profile
 * strength, and quick toggles. Full editing lives in the dashboard.
 */
'use strict';

const { computeCompleteness } = globalThis.HasanifySchema;
const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

const ATS_NAMES = [
  [/greenhouse\.io/, 'Greenhouse'], [/lever\.co/, 'Lever'], [/workday/, 'Workday'], [/ashbyhq\.com/, 'Ashby'],
  [/smartrecruiters\.com/, 'SmartRecruiters'], [/icims\.com/, 'iCIMS'], [/jobvite\.com/, 'Jobvite'],
  [/bamboohr\.com/, 'BambooHR'], [/taleo\.net/, 'Taleo'], [/workable\.com/, 'Workable'], [/rippling\.com/, 'Rippling'],
];

let settings = {};

const openDashboard = () => { chrome.runtime.openOptionsPage(); window.close(); };

function showResults(stats) {
  if (!stats || !stats.total) return;
  $('results').classList.remove('hidden');
  $('filled').textContent = stats.filled;
  $('todo').textContent = stats.todo ?? 0; // the same "needs you" count as the on-page assistant
  $('fillText').textContent = 'Autofill again';
}

async function init() {
  const [{ profile }, s, [tab]] = await Promise.all([
    send('hasanify:getProfile'), send('hasanify:getSettings'),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  settings = s.settings;

  // Page status
  let host = '';
  try { host = new URL(tab?.url ?? '').hostname; } catch { /* chrome:// etc. */ }
  const ats = ATS_NAMES.find(([rx]) => rx.test(host))?.[1];
  const scriptable = /^https?:/.test(tab?.url ?? '');
  $('status').classList.toggle('off', !ats);
  $('statusText').textContent = ats ? `${ats} detected` : scriptable ? host.replace(/^www\./, '') : 'Not available here';
  $('heroTitle').textContent = ats ? `Ready to fill this ${ats} application` : 'Autofill your application';
  if (!scriptable) {
    $('fill').disabled = true;
    $('heroSub').textContent = 'Open a job application to get started.';
  }

  // Profile strength
  const { percent, missing } = computeCompleteness(profile);
  $('ring').style.setProperty('--p', percent);
  $('ring').dataset.v = `${percent}%`;
  const name = profile.personal.firstName;
  $('profileTitle').textContent = percent === 100 ? `${name || 'Your'} profile is complete` : 'Complete your profile';
  $('profileHint').textContent = missing.length ? `Missing ${missing.slice(0, 3).join(', ').toLowerCase()}` : 'Everything Hasanify needs';

  for (const input of document.querySelectorAll('[data-setting]')) {
    input.checked = !!settings[input.dataset.setting];
    input.addEventListener('change', () => {
      settings[input.dataset.setting] = input.checked;
      send('hasanify:saveSettings', { settings });
    });
  }

  const { stats } = await send('hasanify:getTabStats');
  showResults(stats);
}

$('fill').addEventListener('click', async () => {
  $('fill').disabled = true;
  $('fillText').textContent = 'Filling…';
  const res = await send('hasanify:fillActiveTab');
  $('fill').disabled = false;
  $('fillText').textContent = 'Autofill again';
  if (!res?.ok) {
    $('heroSub').textContent = res?.error ?? 'Could not fill this page.';
    return;
  }
  showResults(res.stats);
  $('heroSub').textContent = res.stats.filled
    ? 'Filled. Check the highlighted fields before you submit.'
    : 'No fillable fields found on this page.';
});

// Side panel must be opened synchronously inside the click (user-gesture rule),
// so the window id is looked up ahead of time.
let currentWindowId = null;
chrome.windows.getCurrent().then((w) => { currentWindowId = w.id; });

$('quickCopy').addEventListener('click', () => {
  if (currentWindowId == null) return;
  chrome.sidePanel.open({ windowId: currentWindowId })
    .then(() => window.close())
    .catch((err) => { $('heroSub').textContent = `Couldn't open Quick access: ${err.message}`; });
});

$('settingsBtn').addEventListener('click', openDashboard);
$('dashLink').addEventListener('click', openDashboard);
$('profileCard').addEventListener('click', openDashboard);

init().catch((err) => { $('heroSub').textContent = String(err?.message ?? err); });
