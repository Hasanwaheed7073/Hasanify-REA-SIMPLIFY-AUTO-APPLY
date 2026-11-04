/**
 * Hasanify — Learning & missed questions (dashboard section)
 * ---------------------------------------------------------------------------
 * Shows the history of questions Hasanify couldn't fill (recorded by the
 * content script via the background), lets the user answer one right here,
 * and marks which ones have been learned.
 *
 * Runs after options.js and shares its globals (profile, scheduleSave,
 * renderList, toast, $, $$).
 */
'use strict';

(() => {
  const MISSED_KEY = 'hasanify.missed';
  const IGNORED_KEY = 'hasanify.missedIgnored';
  let missed = {};
  let filter = 'open';

  const ago = (ts) => {
    const d = Math.round((Date.now() - ts) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  };
  const show = (q) => q.replace(/\{company\}/gi, '[company]');
  const learnedKeys = () => new Set((profile.customAnswers ?? []).filter((c) => c.source === 'learned').map((c) => c.key));

  async function load() {
    ({ [MISSED_KEY]: missed = {} } = await chrome.storage.local.get(MISSED_KEY));
  }

  function render() {
    const learned = learnedKeys();
    const rows = Object.entries(missed).map(([key, r]) => ({ key, ...r, learned: learned.has(key) }));
    const open = rows.filter((r) => !r.learned);
    $('#learnStats').textContent = rows.length
      ? `${open.length} not answered · ${rows.length - open.length} learned · ${(profile.customAnswers ?? []).filter((c) => c.source === 'learned').length} learned answers total`
      : '';

    const shown = rows
      .filter((r) => (filter === 'open' ? !r.learned : filter === 'learned' ? r.learned : true))
      .sort((a, b) => (b.required - a.required) || (b.count - a.count) || (b.lastSeen - a.lastSeen));

    const list = $('#missedList');
    list.dataset.empty = filter === 'learned'
      ? 'Nothing learned yet — answer a missed question below or on an application.'
      : rows.length ? 'All caught up — every missed question has an answer. 🎉' : 'No missed questions yet. They appear here after you autofill applications.';
    list.replaceChildren();

    for (const r of shown) {
      const card = document.createElement('div');
      card.className = `missed${r.learned ? ' learned' : ''}`;
      card.innerHTML = `
        <div class="missed-top">
          <span class="missed-count" title="Times seen"></span>
          <div class="missed-q"><b></b><span></span></div>
          <div class="missed-actions"></div>
        </div>`;
      card.querySelector('.missed-count').textContent = `${r.count}×`;
      card.querySelector('b').textContent = show(r.question);
      card.querySelector('.missed-q span').textContent = [
        r.learned ? '✓ Learned' : r.reason, r.required ? 'Required' : null,
        `last seen ${ago(r.lastSeen)}`, r.hosts?.length ? `on ${r.hosts.map((h) => h.replace(/^www\./, '')).join(', ')}` : null,
      ].filter(Boolean).join(' · ');

      const actions = card.querySelector('.missed-actions');
      const answerBtn = Object.assign(document.createElement('button'), { className: 'btn btn-sm', textContent: r.learned ? 'Edit answer' : 'Add answer' });
      const ignoreBtn = Object.assign(document.createElement('button'), { className: 'btn btn-sm btn-ghost', textContent: 'Ignore', title: 'Stop tracking this question' });
      actions.append(answerBtn, ignoreBtn);

      answerBtn.addEventListener('click', () => {
        if (card.querySelector('.missed-answer')) return;
        const existing = (profile.customAnswers ?? []).find((c) => c.source === 'learned' && c.key === r.key);
        const box = document.createElement('div');
        box.className = 'missed-answer';
        box.innerHTML = `<textarea placeholder="Your answer… (use {company} for the employer's name)"></textarea>
          <div class="row-end"><button class="btn btn-sm btn-ghost" data-cancel>Cancel</button><button class="btn btn-sm btn-primary" data-save>Save answer</button></div>`;
        const ta = box.querySelector('textarea');
        ta.value = existing?.answer ?? '';
        box.querySelector('[data-cancel]').addEventListener('click', () => box.remove());
        box.querySelector('[data-save]').addEventListener('click', () => saveAnswer(r, ta.value.trim()));
        card.append(box);
        ta.focus();
      });
      ignoreBtn.addEventListener('click', () => ignore(r.key));
      list.append(card);
    }
  }

  /** Answer from the dashboard → learned custom answer (same format the extension learns). */
  async function saveAnswer(r, answer) {
    if (!answer) return toast('Type an answer first', true);
    profile.customAnswers ??= [];
    const existing = profile.customAnswers.find((c) => c.source === 'learned' && c.key === r.key);
    if (existing) Object.assign(existing, { answer, updatedAt: Date.now() });
    else profile.customAnswers.push({ question: r.question, answer, isRegex: false, source: 'learned', key: r.key, kind: 'text', learnedFrom: 'dashboard', updatedAt: Date.now() });
    renderList('customAnswers');
    scheduleSave();
    missed[r.key] = { ...missed[r.key], learned: true };
    await chrome.storage.local.set({ [MISSED_KEY]: missed });
    render();
    toast('Answer saved — Hasanify will fill it from now on');
  }

  async function ignore(key) {
    const { [IGNORED_KEY]: ignored = [] } = await chrome.storage.local.get(IGNORED_KEY);
    delete missed[key];
    await chrome.storage.local.set({ [MISSED_KEY]: missed, [IGNORED_KEY]: [...new Set([...ignored, key])] });
    render();
    toast('Question ignored');
  }

  for (const b of $$('#missedFilter button')) {
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      for (const x of $$('#missedFilter button')) x.setAttribute('aria-pressed', String(x === b));
      render();
    });
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && MISSED_KEY in changes) { missed = changes[MISSED_KEY].newValue ?? {}; render(); }
  });

  globalThis.HasanifyLearning = { refresh: render };
  // options.js loads the profile asynchronously; render once it's there.
  load().then(() => setTimeout(render, 350));
})();
