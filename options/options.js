/**
 * Hasanify — Profile dashboard
 * Two-way binds the form to the profile/settings stored by the background
 * worker. Every edit autosaves (debounced) through `hasanify:saveProfile`,
 * which validates against the shared JSON schema.
 */
'use strict';

const { DEFAULT_PROFILE, mergeWithDefaults, computeCompleteness } = globalThis.HasanifySchema;
const ICONS = globalThis.HasanifyIcons;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

let profile = structuredClone(DEFAULT_PROFILE);
let settings = {};

// ── Path helpers ─────────────────────────────────────────────────────────
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

// ── Save pipeline ────────────────────────────────────────────────────────
let saveTimer = 0;
function setSaveState(kind, text) {
  const el = $('#saveState');
  el.className = `save-state ${kind}`;
  el.querySelector('span').textContent = text;
}

function scheduleSave() {
  setSaveState('saving', 'Saving…');
  updateCompleteness();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

async function saveNow() {
  saveTimer = 0; // no save pending (lets external-change sync proceed)
  const res = await send('hasanify:saveProfile', { profile });
  if (res?.ok) {
    setSaveState('', 'All changes saved');
  } else {
    setSaveState('error', 'Not saved — check fields');
    toast(res?.errors?.[0] ?? res?.error ?? 'Could not save', true);
  }
}

function toast(text, isError = false) {
  const t = $('#toast');
  t.className = `toast show${isError ? ' error' : ''}`;
  t.innerHTML = isError ? '' : ICONS.check;
  t.append(text);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ── Completeness ring ────────────────────────────────────────────────────
function updateCompleteness() {
  const { percent, missing } = computeCompleteness(profile);
  const ring = $('#ring');
  ring.style.setProperty('--p', percent);
  ring.dataset.v = `${percent}%`;
  $('#completenessTitle').textContent = percent === 100 ? 'Profile complete' : percent >= 70 ? 'Almost there' : 'Profile strength';
  $('#completenessHint').textContent = missing.length ? `Add ${missing.slice(0, 2).join(' & ').toLowerCase()} to fill more fields` : 'Ready to autofill everything';
  const name = profile.personal.firstName;
  $("#greeting").textContent = name ? `${name}’s application profile` : "Your application profile";
}

// ── Simple bound inputs: [data-path] ─────────────────────────────────────
function bindSimpleFields() {
  // Populate EEO selects from data-options.
  for (const sel of $$('select[data-options]')) {
    sel.innerHTML = sel.dataset.options.split('|').map((o) => `<option>${o}</option>`).join('');
  }
  for (const el of $$('[data-path]')) {
    const v = getPath(profile, el.dataset.path);
    if (el.tagName === 'SELECT' && v && ![...el.options].some((o) => o.value === v)) el.add(new Option(v, v)); // keep custom values
    el.value = v ?? '';
    el.addEventListener('input', () => {
      setPath(profile, el.dataset.path, el.value.trim() === '' ? '' : el.value);
      scheduleSave();
    });
  }
}

// ── Yes / No / Not set segmented controls: [data-bool] ───────────────────
function bindBooleans() {
  for (const seg of $$('[data-bool]')) {
    const path = seg.dataset.bool;
    seg.innerHTML = '<button type="button" data-v="true">Yes</button><button type="button" data-v="false">No</button><button type="button" data-v="null">Not set</button>';
    const paint = () => {
      const cur = String(getPath(profile, path) ?? null);
      for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.v === cur));
    };
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      setPath(profile, path, JSON.parse(b.dataset.v));
      paint();
      scheduleSave();
    });
    paint();
  }
}

// ── Chips: [data-chips] ──────────────────────────────────────────────────
function bindChips() {
  for (const box of $$('[data-chips]')) {
    const path = box.dataset.chips;
    const input = document.createElement('input');
    input.placeholder = box.dataset.placeholder ?? '';

    const render = () => {
      box.replaceChildren();
      for (const [i, value] of (getPath(profile, path) ?? []).entries()) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = value;
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.title = `Remove ${value}`;
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          getPath(profile, path).splice(i, 1);
          render();
          scheduleSave();
        });
        chip.append(x);
        box.append(chip);
      }
      box.append(input);
    };

    const commit = () => {
      const parts = input.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (!parts.length) return;
      const list = getPath(profile, path) ?? [];
      for (const p of parts) if (!list.some((x) => x.toLowerCase() === p.toLowerCase())) list.push(p);
      setPath(profile, path, list);
      input.value = '';
      render();
      input.focus();
      scheduleSave();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
      if (e.key === 'Backspace' && !input.value && getPath(profile, path)?.length) {
        getPath(profile, path).pop();
        render();
        input.focus();
        scheduleSave();
      }
    });
    input.addEventListener('blur', commit);
    box.addEventListener('click', () => input.focus());
    render();
  }
}

// ── Repeatable lists: [data-list] ────────────────────────────────────────
const LISTS = {
  experience: {
    path: 'experience', empty: 'No experience yet — add your most recent role.',
    blank: () => ({ company: '', title: '', location: '', employmentType: '', startDate: '', endDate: '', current: false, description: '' }),
    title: (e) => e.title || 'New role', subtitle: (e) => [e.company, range(e)].filter(Boolean).join(' · '), initial: (e) => e.company,
  },
  education: {
    path: 'education', empty: 'No education yet.',
    blank: () => ({ school: '', degree: '', fieldOfStudy: '', minor: '', gpa: '', location: '', startDate: '', endDate: '', current: false }),
    title: (e) => e.school || 'New school', subtitle: (e) => [[e.degree, e.fieldOfStudy].filter(Boolean).join(', '), range(e)].filter(Boolean).join(' · '), initial: (e) => e.school,
  },
  languages: {
    path: 'skills.spokenLanguages', empty: 'No languages added.',
    blank: () => ({ language: '', proficiency: '' }),
  },
  customAnswers: {
    path: 'customAnswers', empty: 'No custom answers yet.',
    blank: () => ({ question: '', answer: '', isRegex: false }),
  },
};

const fmtMonth = (ym) => {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1).toLocaleString(undefined, { month: 'short', year: 'numeric' });
};
const range = (e) => (e.startDate ? `${fmtMonth(e.startDate)} – ${e.current ? 'Present' : fmtMonth(e.endDate) || '…'}` : '');

function renderList(name) {
  const cfg = LISTS[name];
  const container = $(`[data-list="${name}"]`);
  container.dataset.empty = cfg.empty;
  container.replaceChildren();
  const items = getPath(profile, cfg.path) ?? [];

  items.forEach((item, i) => {
    const node = $(`#tpl-${name}`).content.firstElementChild.cloneNode(true);

    const paintHead = () => {
      if (!cfg.title) return;
      $('[data-title]', node).textContent = cfg.title(item);
      $('[data-subtitle]', node).textContent = cfg.subtitle(item) || 'Fill in the details below';
      $('[data-initial]', node).textContent = (cfg.initial(item) || '?').trim().charAt(0).toUpperCase();
      const end = $('[data-field="endDate"]', node);
      if (end && 'current' in item) end.disabled = !!item.current;
    };

    for (const input of $$('[data-field]', node)) {
      const f = input.dataset.field;
      if (input.type === 'checkbox') input.checked = !!item[f];
      else {
        if (input.tagName === 'SELECT' && item[f] && ![...input.options].some((o) => o.value === item[f])) input.add(new Option(item[f], item[f]));
        input.value = item[f] ?? '';
      }
      input.addEventListener(input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input', () => {
        item[f] = input.type === 'checkbox' ? input.checked : input.value;
        paintHead();
        scheduleSave();
      });
    }

    const badge = $('[data-badge]', node);
    if (badge && item.source === 'learned') {
      badge.hidden = false;
      badge.textContent = `Learned${item.learnedFrom && item.learnedFrom !== 'dashboard' ? ` · ${item.learnedFrom.replace(/^www\./, '')}` : ''}`;
    }

    $('[data-remove]', node)?.addEventListener('click', () => {
      items.splice(i, 1);
      renderList(name);
      scheduleSave();
    });
    for (const btn of $$('[data-move]', node)) {
      const j = i + Number(btn.dataset.move);
      btn.disabled = j < 0 || j >= items.length;
      btn.addEventListener('click', () => {
        [items[i], items[j]] = [items[j], items[i]];
        renderList(name);
        scheduleSave();
      });
    }
    paintHead();
    container.append(node);
  });
}

function bindLists() {
  for (const name of Object.keys(LISTS)) renderList(name);
  for (const btn of $$('[data-add]')) {
    btn.addEventListener('click', () => {
      const cfg = LISTS[btn.dataset.add];
      const items = getPath(profile, cfg.path) ?? [];
      items.push(cfg.blank());
      setPath(profile, cfg.path, items);
      renderList(btn.dataset.add);
      const last = $(`[data-list="${btn.dataset.add}"]`).lastElementChild;
      last?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('input, textarea', last)?.focus({ preventScroll: true });
      scheduleSave();
    });
  }
}

// ── Resume dropzone ──────────────────────────────────────────────────────
function paintResume() {
  const r = profile.documents.resume;
  const dz = $('#dropzone');
  dz.classList.toggle('has-file', !!r?.dataUrl);
  if (!r?.dataUrl) return;
  $('#resumeName').textContent = r.fileName;
  const bytes = Math.round((r.dataUrl.length - r.dataUrl.indexOf(',') - 1) * 0.75);
  $('#resumeSize').textContent = `${bytes > 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1e3)) + ' KB'} · ${RESUME_CAPTION[settings.resumeMode ?? 'auto'] ?? RESUME_CAPTION.auto}`;
  $('.file-badge').textContent = /\.docx?$/i.test(r.fileName) ? 'DOC' : 'PDF';
}

async function setResumeFile(file) {
  if (!file) return;
  if (file.size > 10e6) return toast('Resume must be under 10 MB', true);
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  profile.documents.resume = { fileName: file.name, mimeType: file.type || 'application/pdf', dataUrl };
  paintResume();
  scheduleSave();
  toast(`${file.name} uploaded`);
}

function bindResume() {
  const dz = $('#dropzone');
  const input = $('#resumeInput');
  dz.addEventListener('click', (e) => {
    if (dz.classList.contains('has-file') && !e.target.closest('#resumeReplace')) return;
    input.click();
  });
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => setResumeFile(input.files[0]));
  for (const t of ['dragenter', 'dragover']) dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); });
  for (const t of ['dragleave', 'drop']) dz.addEventListener(t, () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); setResumeFile(e.dataTransfer.files[0]); });
  $('#resumeRemove').addEventListener('click', (e) => {
    e.stopPropagation();
    profile.documents.resume = null;
    input.value = '';
    paintResume();
    scheduleSave();
  });
  paintResume();
}

// ── Settings ─────────────────────────────────────────────────────────────
const RESUME_CAPTION = {
  auto: 'attached to upload fields automatically',
  ask: 'offered in the Hasanify panel on each application',
  manual: 'saved — you upload resumes yourself',
};

function bindSettings() {
  // Radio choice cards: [data-choice="settingName"] containing radios named after it.
  for (const group of $$('[data-choice]')) {
    const key = group.dataset.choice;
    for (const radio of $$('input[type=radio]', group)) {
      radio.checked = (settings[key] ?? 'auto') === radio.value;
      radio.addEventListener('change', async () => {
        if (!radio.checked) return;
        settings[key] = radio.value;
        await send('hasanify:saveSettings', { settings });
        paintResume();
        toast('Preference saved');
      });
    }
  }
  for (const input of $$('[data-setting]')) {
    input.checked = !!settings[input.dataset.setting];
    input.addEventListener('change', async () => {
      settings[input.dataset.setting] = input.checked;
      await send('hasanify:saveSettings', { settings });
      toast('Settings updated');
    });
  }
}

// ── Import / export ──────────────────────────────────────────────────────
function bindImportExport() {
  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'hasanify-profile.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    try {
      const parsed = JSON.parse(await e.target.files[0].text());
      const res = await send('hasanify:saveProfile', { profile: parsed });
      if (!res.ok) return toast(res.errors?.[0] ?? 'Invalid profile file', true);
      location.reload();
    } catch (err) {
      toast(`Import failed: ${err.message}`, true);
    }
  });
}

// ── Scrollspy for the sidebar ───────────────────────────────────────────
function bindNav() {
  const links = $$('#nav a');
  const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      links.forEach((a) => a.classList.remove('active'));
      byId.get(entry.target.id)?.classList.add('active');
    }
  }, { rootMargin: '-20% 0px -70% 0px' });
  $$('section.card').forEach((s) => observer.observe(s));
  links[0]?.classList.add('active');
}

// ── Boot ─────────────────────────────────────────────────────────────────
(async function init() {
  const [p, s] = await Promise.all([send('hasanify:getProfile'), send('hasanify:getSettings')]);
  profile = mergeWithDefaults(DEFAULT_PROFILE, p?.profile);
  settings = s?.settings ?? {};
  bindSimpleFields();
  bindBooleans();
  bindChips();
  bindLists();
  bindResume();
  bindSettings();
  bindImportExport();
  bindNav();
  globalThis.HasanifyHydrateIcons();
  updateCompleteness();
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();

  // Answers learned on application tabs while this page is open: adopt them so
  // the next autosave here doesn't overwrite them with a stale copy.
  chrome.storage.onChanged.addListener((changes, area) => {
    const next = changes['hasanify.profile']?.newValue;
    if (area !== 'local' || !next || saveTimer) return;
    if (JSON.stringify(next.customAnswers ?? []) !== JSON.stringify(profile.customAnswers ?? [])) {
      profile.customAnswers = next.customAnswers ?? [];
      renderList('customAnswers');
      globalThis.HasanifyLearning?.refresh();
    }
  });
})();
