/**
 * Hasanify — In-page assistant widget
 * ---------------------------------------------------------------------------
 * A floating launcher pinned to the right edge of application pages that
 * expands into a panel: detect → "Autofill" → live progress → summary with a
 * clickable list of fields that still need the user.
 *
 * Isolation:
 *   • Rendered inside a CLOSED shadow root: page CSS can't restyle it, and the
 *     engine's field scanner (which only walks open shadow roots) never sees
 *     the widget's own controls.
 *   • Talks to the engine through globalThis.HasanifyEngine (isolated world).
 */
(() => {
  'use strict';
  const engine = globalThis.HasanifyEngine;
  if (!engine) return;
  // One widget per live engine. After an extension update a fresh content.js
  // creates a NEW engine, so the widget re-initialises against it.
  if (globalThis.__hasanifyWidget === engine || (window.top !== window && innerWidth < 360)) return;
  globalThis.__hasanifyWidget = engine;
  const { computeCompleteness } = globalThis.HasanifySchema;

  // Remove buttons left on the page by a previous (now disconnected) version.
  document.querySelectorAll('hasanify-assistant').forEach((old) => old.remove());

  /** False once the extension was updated/reloaded under this page. */
  const alive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };

  const POS_KEY = 'hasanify.widget';
  const MIN_MATCHED_TO_SHOW = 3;

  const ATS_NAMES = [
    [/greenhouse\.io/, 'Greenhouse'], [/lever\.co/, 'Lever'], [/workday/, 'Workday'],
    [/ashbyhq\.com/, 'Ashby'], [/smartrecruiters\.com/, 'SmartRecruiters'], [/icims\.com/, 'iCIMS'],
    [/jobvite\.com/, 'Jobvite'], [/bamboohr\.com/, 'BambooHR'], [/taleo\.net/, 'Taleo'],
    [/workable\.com/, 'Workable'], [/successfactors/, 'SuccessFactors'], [/rippling\.com/, 'Rippling'],
  ];
  const atsName = () => ATS_NAMES.find(([rx]) => rx.test(location.hostname))?.[1] ?? 'Job application';

  const jobTitle = () => {
    const h1 = document.querySelector('h1, [data-automation-id="jobPostingHeader"], .posting-headline h2');
    const t = (h1?.textContent || document.title || '').replace(/\s+/g, ' ').trim();
    return t.length > 70 ? `${t.slice(0, 67)}…` : t;
  };

  // ── Icons (inline SVG, 1.75 stroke) ─────────────────────────────────────
  // Each logo copy needs its own gradient id: a gradient defined inside a
  // display:none element (the hidden launcher) can't be referenced by another SVG.
  let logoSeq = 0;
  const logo = () => {
    const id = `hasanify-g${++logoSeq}`;
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366F1"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#${id})"/><path d="M10 9v14M22 9v14M10 16h12" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><circle cx="25.5" cy="7" r="2.2" fill="#A7F3D0"/></svg>`;
  };
  const I = {
    bolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
    minus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>`,
    alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>`,
    arrow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`,
    idcard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16c.6-1.5 1.8-2.3 3.2-2.3s2.6.8 3.2 2.3M14.5 10h4M14.5 13.5h3"/></svg>`,
    user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>`,
    search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
    insert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>`,
    grip: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>`,
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root {
      --ink:#0B1220; --ink-2:#334155; --muted:#64748B; --line:#E7E9F0; --soft:#F5F6FA;
      --brand:#5B5BF7; --brand-2:#8B5CF6; --ok:#12B76A; --ok-bg:#ECFDF3; --warn:#DC6803; --warn-bg:#FFFAEB;
      position: fixed; right: 18px; z-index: 2147483646;
      font: 13px/1.45 ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
      color: var(--ink); -webkit-font-smoothing: antialiased;
    }
    svg { width: 100%; height: 100%; display: block; }
    button { font: inherit; color: inherit; border: 0; background: none; cursor: pointer; padding: 0; }

    /* Launcher */
    .launcher {
      position: relative; width: 52px; height: 52px; border-radius: 16px; padding: 7px;
      background: #fff; box-shadow: 0 10px 30px -8px rgba(30,27,75,.35), 0 0 0 1px rgba(15,23,42,.06);
      transition: transform .18s ease, box-shadow .18s ease;
    }
    .launcher:hover { transform: translateY(-2px) scale(1.03); box-shadow: 0 14px 34px -8px rgba(30,27,75,.45), 0 0 0 1px rgba(15,23,42,.06); }
    .launcher .count {
      position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px;
      background: var(--ok); color: #fff; font-size: 11px; font-weight: 700; line-height: 20px; text-align: center;
      box-shadow: 0 0 0 2px #fff;
    }
    .launcher .count.warn { background: var(--warn); }

    /* Panel */
    .panel {
      width: 340px; max-height: min(620px, calc(100vh - 40px)); display: flex; flex-direction: column;
      background: #fff; border-radius: 18px; overflow: hidden;
      box-shadow: 0 24px 60px -12px rgba(30,27,75,.35), 0 0 0 1px rgba(15,23,42,.07);
      animation: pop .22s cubic-bezier(.2,.9,.3,1.2);
    }
    @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.97); } }
    .head { display: flex; align-items: center; gap: 10px; padding: 14px 14px 12px 16px; cursor: grab; user-select: none; }
    .head:active { cursor: grabbing; }
    .head .logo { width: 30px; height: 30px; flex: none; }
    .head .brand { font-weight: 700; font-size: 15px; letter-spacing: -.01em; }
    .head .spacer { flex: 1; }
    .icon-btn { width: 28px; height: 28px; padding: 6px; border-radius: 8px; color: var(--muted); }
    .icon-btn:hover { background: var(--soft); color: var(--ink); }

    .body { padding: 0 16px 16px; overflow-y: auto; }
    .job { padding: 12px 14px; border-radius: 12px; background: var(--soft); margin-bottom: 14px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: var(--brand);
      text-transform: uppercase; letter-spacing: .04em; }
    .chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .job .title { margin-top: 4px; font-weight: 600; color: var(--ink); font-size: 13.5px; }
    .job .meta { margin-top: 2px; color: var(--muted); font-size: 12px; }

    .cta {
      width: 100%; height: 46px; border-radius: 12px; display: flex; align-items: center; justify-content: center; gap: 8px;
      color: #fff; font-weight: 650; font-size: 14.5px; letter-spacing: -.005em;
      background: linear-gradient(135deg, var(--brand), var(--brand-2));
      box-shadow: 0 8px 20px -8px rgba(91,91,247,.8), inset 0 1px 0 rgba(255,255,255,.2);
      transition: filter .15s, transform .15s;
    }
    .cta:hover { filter: brightness(1.06); }
    .cta:active { transform: translateY(1px); }
    .cta:disabled { cursor: default; filter: saturate(.6) brightness(1.05); }
    .cta .ico { width: 17px; height: 17px; }

    .progress { margin-top: 14px; }
    .bar { height: 6px; border-radius: 99px; background: var(--soft); overflow: hidden; }
    .bar > i { display: block; height: 100%; width: 0; border-radius: inherit;
      background: linear-gradient(90deg, var(--brand), var(--brand-2)); transition: width .2s ease; }
    .progress .label { display: flex; justify-content: space-between; margin-top: 7px; font-size: 12px; color: var(--muted); }
    .progress .label b { color: var(--ink-2); font-weight: 600; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 14px; }
    .stat { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
    .stat .n { font-size: 20px; font-weight: 700; letter-spacing: -.02em; display: flex; align-items: center; gap: 6px; }
    .stat .n .dot { width: 18px; height: 18px; border-radius: 50%; padding: 3px; color: #fff; }
    .stat.ok .dot { background: var(--ok); }
    .stat.warn .dot { background: var(--warn); }
    .stat .k { color: var(--muted); font-size: 12px; }

    .section-title { margin: 16px 0 8px; font-size: 11.5px; font-weight: 600; color: var(--muted);
      text-transform: uppercase; letter-spacing: .05em; }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 9px 10px 9px 12px;
      border-radius: 10px; background: var(--warn-bg); color: #7A2E0E; transition: background .15s; }
    .item:hover { background: #FEF0C7; }
    .item .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .item .go { width: 16px; height: 16px; flex: none; opacity: .7; }
    .all-done { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px;
      background: var(--ok-bg); color: #05603A; font-weight: 500; margin-top: 14px; }
    .all-done .ico { width: 18px; height: 18px; flex: none; }

    .profile-card { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding: 12px; border-radius: 12px; border: 1px dashed #C7C9F9; background: #F7F7FF; }
    .ring { --p: 0; width: 38px; height: 38px; flex: none; border-radius: 50%; display: grid; place-items: center;
      background: conic-gradient(var(--brand) calc(var(--p) * 1%), #E4E4FB 0); font-size: 10.5px; font-weight: 700; }
    .ring::before { content: attr(data-v); width: 30px; height: 30px; border-radius: 50%; background: #fff; display: grid; place-items: center; }
    .profile-card .txt { flex: 1; font-size: 12.5px; color: var(--ink-2); }
    .profile-card .txt b { display: block; color: var(--ink); font-size: 13px; }
    .link { color: var(--brand); font-weight: 600; font-size: 12.5px; }
    .link:hover { text-decoration: underline; }

    .foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px;
      border-top: 1px solid var(--line); background: #FCFCFD; }
    .toggle { display: flex; align-items: center; gap: 9px; cursor: pointer; font-size: 12.5px; color: var(--ink-2); }
    .switch { width: 32px; height: 18px; border-radius: 99px; background: #D0D5DD; position: relative; transition: background .15s; flex: none; }
    .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff;
      box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: transform .15s; }
    .toggle[aria-checked="true"] .switch { background: var(--brand); }
    .toggle[aria-checked="true"] .switch::after { transform: translateX(14px); }
    .hidden { display: none !important; }

    /* Quick access: edge tab under the launcher + header button (open the side panel) */
    .root { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .qa-tab { width: 52px; height: 40px; padding: 9px 14px; border-radius: 12px; color: #C3C8D4; background: #1E222B;
      box-shadow: 0 10px 24px -8px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.06); transition: transform .15s, color .15s; }
    .qa-tab:hover { transform: translateY(-1px); color: #fff; }
    .qa-btn { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px 0 7px; border-radius: 8px;
      font-size: 12px; font-weight: 600; color: var(--brand); background: var(--brand-soft, #EEEEFF); margin-right: 2px; }
    .qa-btn svg { width: 16px; height: 16px; }
    .qa-btn:hover { filter: brightness(.97); }

    /* Attachments (resume / cover letter) */
    .uploads { display: flex; flex-direction: column; gap: 8px; }
    .up { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: #fff; }
    .up.pending { border-color: #C7C9F9; background: #F8F8FF; }
    .up.done { border-color: #ABEFC6; background: var(--ok-bg); }
    .up-top { display: flex; align-items: center; gap: 10px; }
    .up-ico { width: 30px; height: 34px; border-radius: 7px; flex: none; display: grid; place-items: center;
      background: #EEF0FF; color: var(--brand); font-size: 9.5px; font-weight: 800; letter-spacing: .03em; }
    .up.done .up-ico { background: #D1FADF; color: #067647; }
    .up-txt { flex: 1; min-width: 0; }
    .up-txt b { display: block; font-size: 13px; font-weight: 600; }
    .up-txt span { display: block; font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .up.done .up-txt span { color: #067647; font-weight: 500; }
    .up-go { width: 26px; height: 26px; padding: 5px; border-radius: 7px; color: var(--muted); flex: none; }
    .up-go:hover { background: var(--soft); color: var(--ink); }
    .up-actions { display: flex; gap: 6px; margin-top: 9px; }
    .up-btn { flex: 1; height: 32px; border-radius: 8px; font-size: 12.5px; font-weight: 600; border: 1px solid var(--line);
      background: #fff; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 8px; }
    .up-btn:hover { background: var(--soft); }
    .up-btn.primary { border: 0; color: #fff; background: linear-gradient(135deg, var(--brand), var(--brand-2)); }
    .up-btn.primary:hover { filter: brightness(1.06); }
    .mode-note { margin-top: 6px; font-size: 11.5px; color: var(--muted); }
    .mode-note button { color: var(--brand); font-weight: 600; font-size: 11.5px; }
  `;

  // ── DOM ────────────────────────────────────────────────────────────────
  const host = document.createElement('hasanify-assistant');
  host.setAttribute('data-hasanify-ignore', '');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>${CSS}</style>
    <div class="root" part="root">
      <button class="launcher" title="Hasanify — autofill this application">
        ${logo()}<span class="count hidden"></span>
      </button>
      <button class="qa-tab" data-act="quick-access" title="Quick access — your profile, click to copy (Alt+Shift+C)">${I.idcard}</button>

      <section class="panel hidden" role="dialog" aria-label="Hasanify">
        <header class="head">
          <span class="logo">${logo()}</span>
          <span class="brand">Hasanify</span>
          <span class="spacer"></span>
          <button class="qa-btn" data-act="quick-access" title="Open Quick access side panel (Alt+Shift+C)">${I.idcard}<span>Quick access</span></button>
          <button class="icon-btn" data-act="minimize" title="Minimize">${I.minus}</button>
          <button class="icon-btn" data-act="close" title="Hide on this page">${I.close}</button>
        </header>

        <div class="body" data-view="autofill">
          <div class="job">
            <span class="chip" data-ref="ats"></span>
            <div class="title" data-ref="title"></div>
            <div class="meta" data-ref="detected"></div>
          </div>

          <button class="cta" data-act="fill"><span class="ico">${I.bolt}</span><span data-ref="ctaText">Autofill this page</span></button>

          <div class="progress hidden" data-ref="progress">
            <div class="bar"><i data-ref="bar"></i></div>
            <div class="label"><b data-ref="current"></b><span data-ref="count"></span></div>
          </div>

          <div class="stats hidden" data-ref="stats">
            <div class="stat ok"><div class="n"><span class="dot">${I.check}</span><span data-ref="filled">0</span></div><div class="k">fields filled</div></div>
            <div class="stat warn"><div class="n"><span class="dot">${I.alert}</span><span data-ref="todo">0</span></div><div class="k">need your input</div></div>
          </div>

          <div class="hidden" data-ref="uploadsWrap">
            <div class="section-title">Attachments</div>
            <div class="uploads" data-ref="uploads"></div>
            <div class="mode-note" data-ref="modeNote"></div>
            <input type="file" data-ref="picker" accept=".pdf,.doc,.docx,.txt,.rtf,.odt" hidden />
          </div>

          <div class="all-done hidden" data-ref="allDone"><span class="ico">${I.check}</span>Everything we know is filled. Review &amp; submit!</div>

          <div class="hidden" data-ref="attentionWrap">
            <div class="section-title">Needs your attention</div>
            <div class="list" data-ref="attention"></div>
          </div>

          <div class="profile-card hidden" data-ref="profileCard">
            <div class="ring" data-ref="ring" data-v="0%"></div>
            <div class="txt"><b data-ref="profileHeadline">Finish your profile</b><span data-ref="profileMissing"></span></div>
            <button class="link" data-act="profile">Edit</button>
          </div>
        </div>

        <footer class="foot">
          <div class="toggle" role="switch" tabindex="0" aria-checked="false" data-act="armed">
            <span class="switch"></span><span>Autofill next steps</span>
          </div>
          <button class="link" data-act="profile">Profile</button>
        </footer>
      </section>
    </div>`;

  const $ = (sel) => shadow.querySelector(sel);
  const ref = (name) => shadow.querySelector(`[data-ref="${name}"]`);
  const root = $('.root');
  const launcher = $('.launcher');
  const qaTab = $('.qa-tab');
  const panel = $('.panel');

  const ui = { open: false, running: false, hasRun: false, dismissed: false, top: 120, tab: 'autofill' };

  // ── Rendering ──────────────────────────────────────────────────────────
  function setOpen(open) {
    ui.open = open;
    panel.classList.toggle('hidden', !open);
    launcher.classList.toggle('hidden', open);
    qaTab.classList.toggle('hidden', open);
    savePos();
    if (open) render();
  }

  function clampTop(top) {
    const h = ui.open ? panel.offsetHeight || 420 : 52;
    return Math.max(12, Math.min(top, innerHeight - h - 12));
  }

  function applyTop() {
    root.style.top = `${clampTop(ui.top)}px`;
  }

  function renderProfileCard() {
    const profile = engine.getProfile();
    if (!profile) return;
    const { percent, missing } = computeCompleteness(profile);
    const card = ref('profileCard');
    card.classList.toggle('hidden', percent >= 100);
    const ring = ref('ring');
    ring.style.setProperty('--p', percent);
    ring.dataset.v = `${percent}%`;
    ref('profileHeadline').textContent = percent < 40 ? 'Set up your profile' : 'Finish your profile';
    ref('profileMissing').textContent = `Missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`;
  }

  function render() {
    const summary = engine.getSummary();
    ref('ats').textContent = atsName();
    ref('title').textContent = jobTitle();
    ref('detected').textContent = ui.detected
      ? `${ui.detected} field${ui.detected === 1 ? '' : 's'} recognized on this page`
      : 'Scanning page…';

    const showResults = ui.hasRun && !ui.running;
    const pendingUploads = renderUploads(summary.uploads ?? [], showResults);
    const todo = summary.attention.length + pendingUploads;
    ref('stats').classList.toggle('hidden', !showResults);
    ref('filled').textContent = summary.filled;
    ref('todo').textContent = todo;

    const list = ref('attention');
    list.replaceChildren();
    for (const item of summary.attention.slice(0, 12)) {
      const b = document.createElement('button');
      b.className = 'item';
      b.innerHTML = `<span class="t"></span><span class="go">${I.arrow}</span>`;
      b.querySelector('.t').textContent = item.label;
      b.title = item.status === 'no-option' ? 'Couldn’t find a matching option — pick one manually' : 'Required — fill this in';
      b.addEventListener('click', () => jumpTo(item.el));
      list.appendChild(b);
    }
    ref('attentionWrap').classList.toggle('hidden', !showResults || !summary.attention.length);
    ref('allDone').classList.toggle('hidden', !showResults || todo > 0 || !summary.filled);

    ref('ctaText').textContent = ui.running ? 'Filling…' : ui.hasRun ? 'Autofill again' : 'Autofill this page';
    $('[data-act="fill"]').disabled = ui.running;
    $('[data-act="armed"]').setAttribute('aria-checked', String(summary.armed));

    // Launcher badge: green = filled count, amber = items still to do.
    const badge = launcher.querySelector('.count');
    const n = todo || summary.filled;
    badge.textContent = n;
    badge.classList.toggle('hidden', !ui.hasRun || !n);
    badge.classList.toggle('warn', todo > 0);

    renderProfileCard();
    applyTop();
  }

  const RESUME_MODE_LABEL = { auto: 'Attach saved resume', ask: 'Ask me each time', manual: 'I upload it myself' };

  const fileBadge = (u) => {
    const ext = (u.fileName.split('.').pop() || '').toUpperCase();
    if (u.done && ext && ext.length <= 4) return ext;
    return u.kind === 'resume' ? 'CV' : u.kind === 'coverLetter' ? 'CL' : 'FILE';
  };

  /**
   * Attachments card: one row per resume / cover-letter / other upload field,
   * with "Use saved" and "Choose file…" so tailored files go in per application.
   * Returns how many still need the user.
   */
  function renderUploads(uploads, show) {
    const settings = engine.getSettings() ?? {};
    const mode = settings.resumeMode ?? 'auto';
    const box = ref('uploads');
    box.replaceChildren();
    let pending = 0;

    for (const u of uploads) {
      const isPending = !u.done && (u.required || u.kind !== 'other');
      if (isPending) pending++;
      const row = document.createElement('div');
      row.className = `up ${u.done ? 'done' : isPending ? 'pending' : ''}`;

      let sub;
      if (u.done) sub = u.isFile ? `✓ ${u.fileName || 'Attached'}` : '✓ Written';
      else if (!u.isFile) sub = 'Write your tailored cover letter here';
      else if (u.kind === 'resume') sub = mode === 'manual' ? 'Waiting for your tailored resume' : engine.hasSavedResume() ? 'Use your saved resume or a tailored one' : 'No saved resume — choose a file';
      else if (u.kind === 'coverLetter') sub = 'Attach your tailored cover letter';
      else sub = u.required ? 'Required upload' : 'Optional upload';

      row.innerHTML = `
        <div class="up-top">
          <div class="up-ico"></div>
          <div class="up-txt"><b></b><span></span></div>
          <button class="up-go" title="Show this field on the page">${I.arrow}</button>
        </div>`;
      row.querySelector('.up-ico').textContent = fileBadge(u);
      row.querySelector('b').textContent = u.label;
      row.querySelector('.up-txt span').textContent = sub;
      row.querySelector('.up-go').addEventListener('click', () => jumpTo(u.el));

      if (u.isFile && u.el.isConnected) {
        const actions = document.createElement('div');
        actions.className = 'up-actions';
        if (u.kind === 'resume' && engine.hasSavedResume() && mode !== 'manual' && !u.done) {
          const saved = document.createElement('button');
          saved.className = 'up-btn';
          saved.textContent = `Use saved · ${engine.savedResumeName()}`;
          saved.title = `Attach ${engine.savedResumeName()}`;
          saved.addEventListener('click', () => { engine.attachToUpload(u.id, 'saved'); render(); });
          actions.append(saved);
        }
        const choose = document.createElement('button');
        choose.className = `up-btn${u.done ? '' : ' primary'}`;
        choose.textContent = u.done ? 'Replace…' : u.kind === 'resume' ? 'Choose tailored file…' : 'Choose file…';
        choose.addEventListener('click', () => pickFileFor(u.id));
        actions.append(choose);
        row.append(actions);
      }
      box.append(row);
    }

    ref('uploadsWrap').classList.toggle('hidden', !show || !uploads.length);
    const note = ref('modeNote');
    note.innerHTML = `Resume: <b></b> · <button data-act="upload-settings">Change</button>`;
    note.querySelector('b').textContent = RESUME_MODE_LABEL[mode] ?? mode;
    return pending;
  }

  // One hidden picker inside the shadow root serves every upload row.
  let pickTarget = null;
  const picker = ref('picker');
  function pickFileFor(id) {
    pickTarget = id;
    picker.value = '';
    picker.click(); // runs inside the user's click → the browser allows the file dialog
  }
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    if (file && pickTarget != null) engine.attachToUpload(pickTarget, file);
    pickTarget = null;
    render();
  });


  function jumpTo(el) {
    if (!el?.isConnected) return render();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('hasanify-pulse');
    void el.offsetWidth; // restart animation
    el.classList.add('hasanify-pulse');
    setTimeout(() => el.classList.remove('hasanify-pulse'), 2000);
    const focusable = el.matches('input, textarea, select, button') ? el : el.querySelector('input, textarea, select, button');
    focusable?.focus({ preventScroll: true });
  }

  // ── Engine events ──────────────────────────────────────────────────────
  engine.events.addEventListener('run-start', () => {
    ui.running = true;
    ui.hasRun = true;
    if (!ui.dismissed) mount();
    ref('progress').classList.remove('hidden');
    ref('bar').style.width = '0%';
    render();
  });

  engine.events.addEventListener('progress', (e) => {
    const { done, total, label } = e.detail;
    ref('bar').style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
    ref('current').textContent = label || 'Working…';
    ref('count').textContent = `${done}/${total}`;
  });

  engine.events.addEventListener('run-end', (e) => {
    ui.running = false;
    setTimeout(() => ref('progress').classList.add('hidden'), 350);
    // "Ask me each time": pop the panel open once so the tailored-resume choice isn't missed.
    const waitingResume = (e.detail?.uploads ?? []).some((u) => u.kind === 'resume' && !u.done);
    if (engine.getSettings()?.resumeMode === 'ask' && waitingResume && !ui.openedForUpload && !ui.dismissed) {
      ui.openedForUpload = true;
      mount();
      if (!ui.open) setOpen(true);
    }
    render();
  });

  engine.events.addEventListener('uploads-changed', () => host.isConnected && render());

  engine.events.addEventListener('armed', render);

  let previewTimer = 0;
  engine.events.addEventListener('fields-changed', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(evaluatePage, 600);
  });

  // ── Interactions ───────────────────────────────────────────────────────
  // Disconnected (extension updated and this page wasn't refreshed or
  // re-injected): say so instead of silently doing nothing.
  shadow.addEventListener('click', (e) => {
    if (alive()) return;
    e.stopPropagation();
    e.preventDefault();
    root.innerHTML = `
      <div style="width:260px;padding:14px 16px;border-radius:14px;background:#fff;color:#0B1220;
        box-shadow:0 18px 40px -12px rgba(30,27,75,.35),0 0 0 1px rgba(15,23,42,.08);font:13px/1.45 system-ui,sans-serif">
        <b style="display:block;margin-bottom:4px">Hasanify was updated</b>
        Refresh this page to use autofill and Quick access again.
      </div>`;
  }, true);

  launcher.addEventListener('click', () => {
    if (ui.dragged) return;
    setOpen(true);
  });

  shadow.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    // Side panel must open inside this click (Chrome user-gesture rule): message synchronously.
    if (act === 'quick-access') chrome.runtime.sendMessage({ type: 'hasanify:openSidePanel' }).catch(() => {});
    if (act === 'fill') engine.fill();
    if (act === 'minimize') setOpen(false);
    if (act === 'close') { ui.dismissed = true; host.remove(); }
    if (act === 'armed') engine.setArmed(!engine.getSummary().armed);
    if (act === 'profile') chrome.runtime.sendMessage({ type: 'hasanify:openOptions' }).catch(() => {});
    if (act === 'upload-settings') chrome.runtime.sendMessage({ type: 'hasanify:openOptions', hash: 'documents' }).catch(() => {});
  });

  $('[data-act="armed"]').addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); engine.setArmed(!engine.getSummary().armed); }
  });

  // Vertical drag on the header (panel) or the launcher itself.
  function startDrag(e) {
    if (e.button !== 0 || e.target.closest('.icon-btn')) return;
    const startY = e.clientY, startTop = ui.top;
    ui.dragged = false;
    const move = (ev) => {
      if (Math.abs(ev.clientY - startY) > 3) ui.dragged = true;
      ui.top = clampTop(startTop + ev.clientY - startY);
      applyTop();
    };
    const up = () => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      savePos();
      setTimeout(() => { ui.dragged = false; }, 0);
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
  }
  $('.head').addEventListener('pointerdown', startDrag);
  launcher.addEventListener('pointerdown', startDrag);
  addEventListener('resize', applyTop);

  function savePos() {
    chrome.storage.local.set({ [POS_KEY]: { top: ui.top, open: ui.open } }).catch(() => {});
  }

  // ── Mounting ───────────────────────────────────────────────────────────
  function mount() {
    if (host.isConnected || ui.dismissed) return;
    document.documentElement.appendChild(host);
    applyTop();
  }

  /** Show the widget only on pages that look like applications. */
  async function evaluatePage() {
    try {
      const settings = engine.getSettings();
      if (settings && !settings.showWidget) return;
      const { matched } = await engine.preview();
      ui.detected = Math.max(ui.detected ?? 0, matched + engine.getSummary().matched);
      if (matched >= MIN_MATCHED_TO_SHOW || engine.isKnownAts() && matched > 0) mount();
      if (host.isConnected) render();
    } catch { /* extension reloaded */ }
  }

  (async function init() {
    try {
      const { [POS_KEY]: pos } = await chrome.storage.local.get(POS_KEY);
      if (pos?.top) ui.top = pos.top;
      ui.open = !!pos?.open;
    } catch { /* ignore */ }
    panel.classList.toggle('hidden', !ui.open);
    launcher.classList.toggle('hidden', ui.open);
    qaTab.classList.toggle('hidden', ui.open);
    // Let SPAs render their forms first.
    setTimeout(evaluatePage, 700);
  })();
})();
