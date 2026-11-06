/**
 * Hasanify — Applications tracker (dashboard → Applications)
 * ---------------------------------------------------------------------------
 * Reads/writes `hasanify.applications`, the same list the side panel's
 * "Save application" uses and the content script appends to when you submit
 * a form Hasanify filled. Shows:
 *   • a tally (today vs goal, this week, total, response rate)
 *   • applications per week for the last 8 weeks
 *   • follow-ups that are due
 *   • the full list: status, follow-up date, notes, delete; search + filter
 *   • CSV export and manual entry
 *
 * Runs after options.js and shares its globals ($, $$, toast).
 */
'use strict';

(() => {
  const APPS_KEY = 'hasanify.applications';
  const DAY = 86400000;
  const STATUS = {
    saved: 'Saved', applied: 'Applied', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', withdrawn: 'Withdrawn',
  };
  let apps = [];
  let goal = 10;
  let followUpDays = 7;
  let filter = 'all';
  let query = '';
  let openNotes = null;
  let writing = false;

  // ── helpers ───────────────────────────────────────────────────────────
  const when = (a) => a.appliedAt ?? a.savedAt ?? 0;
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  /** Monday 00:00 of the week containing t. */
  const startOfWeek = (t) => { const d = new Date(startOfDay(t)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const fmtDate = (t, opts = { month: 'short', day: 'numeric' }) => (t ? new Date(t).toLocaleDateString(undefined, opts) : '');
  const isoDay = (t) => { if (!t) return ''; const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const applied = (a) => a.status && a.status !== 'saved';
  const followUpDue = (a) => a.status === 'applied' && a.followUpAt && !a.followedUpAt && a.followUpAt <= Date.now() + DAY;

  async function load() {
    const { [APPS_KEY]: list = [], 'hasanify.settings': s = {} } = await chrome.storage.local.get([APPS_KEY, 'hasanify.settings']);
    apps = Array.isArray(list) ? list : [];
    goal = Math.max(1, Number(s.dailyGoal) || 10);
    followUpDays = Math.max(1, Number(s.followUpDays) || 7);
  }

  async function save(msg) {
    writing = true;
    await chrome.storage.local.set({ [APPS_KEY]: apps });
    writing = false;
    render();
    if (msg) toast(msg);
  }

  function update(id, patch, msg) {
    const a = apps.find((x) => x.id === id);
    if (!a) return;
    if (patch.status && patch.status !== a.status) {
      (a.history ??= []).push({ status: patch.status, at: Date.now(), by: 'you' });
      if (patch.status !== 'saved' && !a.appliedAt) a.appliedAt = Date.now();
      if (patch.status === 'applied' && !a.followUpAt) a.followUpAt = Date.now() + followUpDays * DAY;
    }
    Object.assign(a, patch);
    save(msg);
  }

  // ── tally + weekly bars ───────────────────────────────────────────────
  function renderTally() {
    const now = Date.now();
    const sent = apps.filter(applied);
    const today = sent.filter((a) => when(a) >= startOfDay(now)).length;
    const week = sent.filter((a) => when(a) >= startOfWeek(now)).length;
    const heard = sent.filter((a) => ['interview', 'offer', 'rejected'].includes(a.status)).length;
    const responses = sent.filter((a) => ['interview', 'offer'].includes(a.status)).length;
    const cells = [
      [`${today}`, `of ${goal} today`, today >= goal],
      [`${week}`, 'this week'],
      [`${sent.length}`, 'applied in total'],
      [sent.length ? `${Math.round((responses / sent.length) * 100)}%` : '—', `interviews or offers${heard ? ` · ${heard} replied` : ''}`],
    ];
    const box = $('#appTally');
    box.replaceChildren(...cells.map(([n, k, hit]) => {
      const d = document.createElement('div');
      d.className = `tally-cell${hit ? ' hit' : ''}`;
      d.innerHTML = '<b></b><span></span>';
      d.querySelector('b').textContent = n;
      d.querySelector('span').textContent = k;
      return d;
    }));
  }

  function renderWeeks() {
    const thisWeek = startOfWeek(Date.now());
    const weeks = Array.from({ length: 8 }, (_, i) => thisWeek - (7 - i) * 7 * DAY);
    const counts = weeks.map((w) => apps.filter((a) => applied(a) && when(a) >= w && when(a) < w + 7 * DAY).length);
    // Scale to the busiest week (room for the number on top); the weekly goal
    // (5 working days × daily goal) is drawn as a line only if it fits the scale.
    const weeklyGoal = goal * 5;
    const max = Math.max(4, ...counts) * 1.15;
    const box = $('#appWeeks');
    box.replaceChildren(...weeks.map((w, i) => {
      const col = document.createElement('div');
      col.className = `week${i === 7 ? ' current' : ''}`;
      col.title = `Week of ${fmtDate(w)}: ${counts[i]} application${counts[i] === 1 ? '' : 's'}`;
      col.innerHTML = '<span class="wk-n"></span><span class="wk-bar"><i></i></span><span class="wk-d"></span>';
      col.querySelector('.wk-n').textContent = counts[i] || '';
      col.querySelector('i').style.height = `${(counts[i] / max) * 100}%`;
      col.querySelector('.wk-d').textContent = i === 7 ? 'this wk' : fmtDate(w);
      return col;
    }));
    box.style.setProperty('--goal-line', String(Math.min(1, weeklyGoal / max)));
    box.classList.toggle('goal-off', weeklyGoal > max);
    box.dataset.goal = `goal ${weeklyGoal}/wk`;
  }

  // ── follow-ups ────────────────────────────────────────────────────────
  function renderFollowups() {
    const due = apps.filter(followUpDue).sort((a, b) => a.followUpAt - b.followUpAt);
    $('#appFollowWrap').hidden = !due.length;
    $('#appFollowCount').textContent = due.length ? `${due.length} due` : '';
    $('#navFollowups').textContent = due.length ? `${due.length}` : '';
    const box = $('#appFollowups');
    box.replaceChildren(...due.slice(0, 8).map((a) => {
      const row = document.createElement('div');
      row.className = 'follow';
      const days = Math.round((Date.now() - when(a)) / DAY);
      row.innerHTML = `<div class="follow-txt"><b></b><span></span></div>
        <button class="btn btn-sm" data-act="done">Followed up</button>
        <button class="btn btn-sm btn-ghost" data-act="later">In 3 days</button>`;
      row.querySelector('b').textContent = `${a.company || 'Unknown company'} — ${a.title || 'role'}`;
      row.querySelector('span').textContent = `Applied ${days} day${days === 1 ? '' : 's'} ago, no reply recorded yet.`;
      row.querySelector('[data-act="done"]').addEventListener('click', () => update(a.id, { followedUpAt: Date.now() }, 'Marked as followed up'));
      row.querySelector('[data-act="later"]').addEventListener('click', () => update(a.id, { followUpAt: Date.now() + 3 * DAY }, 'Reminder moved 3 days'));
      return row;
    }));
  }

  // ── the list ──────────────────────────────────────────────────────────
  function renderTable() {
    const q = query.trim().toLowerCase();
    const rows = apps
      .filter((a) => filter === 'all' || a.status === filter || (filter === 'applied' && !a.status))
      .filter((a) => !q || `${a.company} ${a.title} ${a.url}`.toLowerCase().includes(q))
      .sort((a, b) => when(b) - when(a));
    $('#appCount').textContent = apps.length ? `${rows.length} of ${apps.length}` : '';
    const table = $('#appTable');
    table.replaceChildren();
    if (!rows.length && apps.length) table.dataset.emptyNow = 'Nothing matches this filter.';
    else delete table.dataset.emptyNow;

    for (const a of rows) {
      const row = document.createElement('div');
      row.className = `app-row s-${a.status || 'applied'}`;
      row.innerHTML = `
        <span class="app-date"></span>
        <div class="app-main"><a class="app-co" target="_blank" rel="noopener"></a><span class="app-meta"></span></div>
        <select class="app-status" aria-label="Status"></select>
        <input class="app-follow" type="date" aria-label="Follow up on" title="Follow up on" />
        <div class="app-acts">
          <button class="btn btn-sm btn-ghost" data-act="notes" title="Notes">Notes</button>
          <button class="btn btn-sm btn-danger-ghost" data-act="del" title="Delete">×</button>
        </div>`;
      row.querySelector('.app-date').textContent = fmtDate(when(a));
      const link = row.querySelector('.app-co');
      link.textContent = a.company || 'Unknown company';
      if (a.url) link.href = a.url; else link.removeAttribute('href');
      row.querySelector('.app-meta').textContent = [a.title, a.resume ? `resume: ${a.resume}` : '', a.source === 'auto' ? 'logged on submit' : '', a.notes ? '✎ notes' : '']
        .filter(Boolean).join(' · ');

      const sel = row.querySelector('.app-status');
      for (const [v, label] of Object.entries(STATUS)) sel.append(new Option(label, v));
      sel.value = a.status || 'applied';
      sel.addEventListener('change', () => update(a.id, { status: sel.value }, `Status: ${STATUS[sel.value]}`));

      const fu = row.querySelector('.app-follow');
      fu.value = isoDay(a.followUpAt);
      fu.disabled = a.status !== 'applied';
      fu.addEventListener('change', () => update(a.id, { followUpAt: fu.value ? new Date(`${fu.value}T09:00`).getTime() : null, followedUpAt: null }, 'Follow-up date saved'));

      row.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm(`Delete ${a.company || 'this application'} from your tracker?`)) return;
        apps = apps.filter((x) => x.id !== a.id);
        save('Application deleted');
      });
      row.querySelector('[data-act="notes"]').addEventListener('click', () => { openNotes = openNotes === a.id ? null : a.id; renderTable(); });

      if (openNotes === a.id) {
        const box = document.createElement('div');
        box.className = 'app-notes';
        box.innerHTML = '<textarea placeholder="Recruiter name, interview dates, salary discussed…"></textarea><div class="app-history"></div>';
        const ta = box.querySelector('textarea');
        ta.value = a.notes ?? '';
        ta.addEventListener('change', () => update(a.id, { notes: ta.value.trim() }, 'Notes saved'));
        box.querySelector('.app-history').textContent = (a.history ?? [])
          .map((h) => `${fmtDate(h.at)} ${STATUS[h.status] ?? h.status}${h.by === 'auto' ? ' (auto)' : ''}`).join('  →  ');
        row.append(box);
        setTimeout(() => ta.focus(), 0);
      }
      table.append(row);
    }
  }

  function render() {
    renderTally();
    renderWeeks();
    renderFollowups();
    renderTable();
  }

  // ── CSV ───────────────────────────────────────────────────────────────
  function exportCsv() {
    const cols = ['Date applied', 'Company', 'Role', 'Status', 'Follow up', 'Resume', 'Link', 'Notes'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.join(',')].concat([...apps].sort((a, b) => when(b) - when(a)).map((a) => [
      isoDay(when(a)), a.company, a.title, STATUS[a.status] ?? 'Applied', isoDay(a.followUpAt), a.resume, a.url, a.notes,
    ].map(esc).join(',')));
    const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv' });
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `hasanify-applications-${isoDay(Date.now())}.csv` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // ── wiring ────────────────────────────────────────────────────────────
  for (const b of $$('#appFilter button')) {
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      for (const x of $$('#appFilter button')) x.setAttribute('aria-pressed', String(x === b));
      renderTable();
    });
  }
  $('#appSearch').addEventListener('input', (e) => { query = e.target.value; renderTable(); });
  $('#appExportBtn').addEventListener('click', () => (apps.length ? exportCsv() : toast('Nothing to export yet', true)));
  $('#appAddBtn').addEventListener('click', () => { $('#appAddForm').hidden = false; $('#appAddForm [name=company]').focus(); });
  $('#appAddCancel').addEventListener('click', () => { $('#appAddForm').hidden = true; });
  $('#appAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const now = Date.now();
    const status = f.get('status');
    apps.push({
      id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
      company: String(f.get('company')).trim(), title: String(f.get('title')).trim(), url: String(f.get('url')).trim(),
      status, savedAt: now, appliedAt: status === 'saved' ? undefined : now, source: 'manual',
      followUpAt: status === 'applied' ? now + followUpDays * DAY : undefined,
      history: [{ status, at: now, by: 'you' }],
    });
    e.target.reset();
    e.target.hidden = true;
    save('Application added');
  });

  // Live: applications logged in other tabs / the side panel appear immediately.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || writing) return;
    if (APPS_KEY in changes || 'hasanify.settings' in changes) load().then(render);
  });

  globalThis.HasanifyTracker = { refresh: () => load().then(render) };
  load().then(render);
})();
