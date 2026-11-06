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
  const logo = () =>
    '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#1D1B17"/>' +
    '<path d="M10 8.5v15M21.5 8.5v15M10 16h11.5" stroke="#F3F0E8" stroke-width="3.1" stroke-linecap="square" fill="none"/>' +
    '<rect x="20" y="25.2" width="7" height="2.6" fill="#C2552F"/></svg>';
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
      --paper:#F3F0E8; --sheet:#FBF9F4; --ink:#1D1B17; --ink-2:#3F3B33; --muted:#736C60; --faint:#A39B8C;
      --line:#E3DDD0; --line-2:#CFC7B6; --soft:#ECE7DC;
      --brand:#A9442A; --brand-ink:#8C3720; --brand-soft:#F2E2D8; --brand-2:#8C3720;
      --ok:#3E6B48; --ok-bg:#E5EDDF; --warn:#9A6200; --warn-bg:#F5EBD2;
      --serif: "Iowan Old Style", "Sitka Text", Charter, Cambria, Georgia, serif;
      --mono: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace;
      position: fixed; right: 18px; z-index: 2147483646;
      display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
      font: 13px/1.45 "Segoe UI Variable Text", "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif;
      color: var(--ink); -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums;
    }
    svg { width: 100%; height: 100%; display: block; }
    button { font: inherit; color: inherit; border: 0; background: none; cursor: pointer; padding: 0; }
    button:focus-visible, [tabindex]:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--sheet), 0 0 0 4px rgba(169,68,42,.55); }

    /* Launcher: a plain ink tab on the page edge */
    .launcher {
      position: relative; width: 46px; height: 46px; border-radius: 6px; padding: 0;
      background: var(--ink); box-shadow: 0 1px 0 rgba(255,255,255,.08) inset, 0 10px 22px -12px rgba(29,27,23,.7);
      transition: transform .2s cubic-bezier(.3,1.4,.5,1), background .15s;
    }
    .launcher:hover { transform: translateX(-3px); }
    .launcher:active { transform: translateX(-1px) scale(.97); }
    .launcher svg { border-radius: 6px; }
    .launcher .count {
      position: absolute; top: -7px; left: -9px; min-width: 20px; height: 18px; padding: 0 5px; border-radius: 3px;
      background: var(--ok); color: #fff; font: 600 11px/18px var(--mono); text-align: center;
      box-shadow: 0 0 0 2px var(--paper);
    }
    .launcher .count.warn { background: var(--brand); }

    /* Panel: a sheet of paper */
    .panel {
      width: 344px; max-height: min(640px, calc(100vh - 40px)); display: flex; flex-direction: column;
      background: var(--paper); border-radius: 6px; overflow: hidden; border: 1px solid var(--line-2);
      box-shadow: 0 1px 0 rgba(61,47,25,.05), 0 22px 48px -24px rgba(61,47,25,.55);
      animation: pop .26s cubic-bezier(.3,1.25,.5,1);
    }
    @keyframes pop { from { opacity: 0; transform: translateX(10px); } }
    .head { display: flex; align-items: center; gap: 9px; padding: 11px 10px 10px 14px; cursor: grab; user-select: none;
      border-bottom: 2px solid var(--ink); }
    .head:active { cursor: grabbing; }
    .head .logo { width: 24px; height: 24px; flex: none; }
    .head .brand { font: 600 17px var(--serif); letter-spacing: -.01em; }
    .head .spacer { flex: 1; }
    .icon-btn { width: 26px; height: 26px; padding: 6px; border-radius: 3px; color: var(--muted); transition: background .15s, color .15s; }
    .icon-btn:hover { background: var(--soft); color: var(--ink); }

    .body { padding: 0 14px 14px; overflow-y: auto; }
    .job { padding: 12px 0 12px; border-bottom: 1px solid var(--line-2); margin-bottom: 12px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; font: 500 11px var(--mono); color: var(--brand); }
    .chip::before { content: ""; width: 6px; height: 6px; border-radius: 1px; background: currentColor; }
    .job .title { margin-top: 3px; font: 600 16px/1.25 var(--serif); color: var(--ink); }
    .job .meta { margin-top: 2px; color: var(--muted); font-size: 12px; }

    .cta {
      width: 100%; height: 40px; border-radius: 4px; display: flex; align-items: center; justify-content: center; gap: 8px;
      color: #FBF6EF; font-weight: 650; font-size: 14px;
      background: var(--brand); border: 1px solid var(--brand);
      transition: background .15s, transform .1s;
    }
    .cta:hover { background: var(--brand-ink); }
    .cta:active { transform: translateY(1px); }
    .cta:disabled { cursor: default; background: var(--muted); border-color: var(--muted); transform: none; }
    .cta .ico { width: 16px; height: 16px; }

    .progress { margin-top: 12px; }
    .bar { height: 3px; background: var(--line); overflow: hidden; }
    .bar > i { display: block; height: 100%; width: 0; background: var(--ink); transition: width .25s ease; }
    .progress .label { display: flex; justify-content: space-between; gap: 10px; margin-top: 6px; font-size: 12px; color: var(--muted); }
    .progress .label b { color: var(--ink-2); font-weight: 500; max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .progress .label span { font-family: var(--mono); font-size: 11.5px; }

    /* Stats: two numbers in a ruled row */
    .stats { display: grid; grid-template-columns: 1fr 1fr; margin-top: 12px; border-top: 1px solid var(--line-2); border-bottom: 1px solid var(--line-2); }
    .stat { padding: 9px 0 10px; }
    .stat + .stat { border-left: 1px solid var(--line); padding-left: 12px; }
    .stat .n { font: 600 26px/1.1 var(--serif); letter-spacing: -.02em; display: flex; align-items: baseline; gap: 6px; }
    .stat .n .dot { display: none; }
    .stat.ok .n { color: var(--ok); }
    .stat.warn .n { color: var(--brand); }
    .stat .k { color: var(--muted); font: 11.5px var(--mono); }

    .section-title { display: flex; align-items: center; gap: 8px; margin: 16px 0 6px; font: 600 11.5px var(--mono); color: var(--muted); }
    .section-title::after { content: ""; flex: 1; height: 1px; background: var(--line-2); }
    .list { display: flex; flex-direction: column; }
    .item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 8px 2px 8px 10px;
      border-bottom: 1px solid var(--line); border-left: 2px solid var(--brand); background: transparent; color: var(--ink); transition: background .15s; }
    .item:hover { background: var(--sheet); }
    .item .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .item .go { width: 15px; height: 15px; flex: none; color: var(--faint); transition: transform .15s, color .15s; }
    .item:hover .go { transform: translateX(2px); color: var(--ink); }

    /* Unfilled-field report */
    .st-count { font: 600 11.5px var(--mono); color: var(--ink); }
    .report-tip { margin: 0 0 6px; font-size: 11.5px; color: var(--muted); }
    .report-tip:empty { display: none; }
    .ritem { display: flex; flex-direction: column; }
    .item .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .item .meta { font-size: 11px; color: var(--muted); font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item.optional { border-left-color: var(--line-2); color: var(--ink-2); }
    .item.done { border-left-color: var(--ok); color: var(--muted); }
    .item.done .t { text-decoration: line-through; text-decoration-color: var(--faint); }
    .learn { margin: 0; padding: 8px 4px 10px 12px; border-left: 2px solid var(--ink); border-bottom: 1px solid var(--line); background: var(--sheet);
      font-size: 12px; color: var(--ink-2); }
    .learn q { display: block; margin: 3px 0 7px; color: var(--ink); font-family: var(--serif); font-size: 13px; font-style: italic; quotes: "“" "”";
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .learn .acts { display: flex; gap: 6px; }
    .learn button { height: 26px; padding: 0 10px; border-radius: 3px; font-size: 12px; font-weight: 600; transition: background .15s; }
    .learn .save { color: var(--paper); background: var(--ink); }
    .learn .save:hover { background: var(--brand); }
    .learn .skip { color: var(--muted); }
    .learn .skip:hover { background: var(--soft); color: var(--ink); }
    .learn.saved { border-left-color: var(--ok); color: var(--ok); font-weight: 600; }
    .more { margin-top: 4px; height: 28px; padding: 0 2px; color: var(--brand); font-size: 12px; font-weight: 600; text-align: left; }
    .more:hover { text-decoration: underline; text-underline-offset: 3px; }
    .all-done { display: flex; align-items: center; gap: 9px; padding: 10px 0; border-bottom: 1px solid var(--line-2);
      color: var(--ok); font-weight: 500; margin-top: 10px; }
    .all-done .ico { width: 16px; height: 16px; flex: none; }

    .profile-card { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding: 11px 12px; border-radius: 4px; border: 1px dashed var(--faint); }
    .ring { --p: 0; width: 34px; height: 34px; flex: none; border-radius: 3px; display: grid; place-items: center; border: 1px solid var(--line-2);
      background: linear-gradient(to top, var(--brand-soft) calc(var(--p) * 1%), var(--sheet) 0); font: 600 10.5px var(--mono); }
    .ring::before { content: attr(data-v); }
    .profile-card .txt { flex: 1; font-size: 12px; color: var(--muted); }
    .profile-card .txt b { display: block; color: var(--ink); font-size: 13px; }
    .link { color: var(--brand); font-weight: 600; font-size: 12.5px; }
    .link:hover { text-decoration: underline; text-underline-offset: 3px; }
    .foot-links { display: flex; gap: 12px; align-items: center; }
    .link.muted { color: var(--muted); font-weight: 500; font-size: 11.5px; }

    .foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px;
      border-top: 1px solid var(--line-2); background: var(--sheet); }
    .toggle { display: flex; align-items: center; gap: 9px; cursor: pointer; font-size: 12.5px; color: var(--ink-2); }
    .switch { width: 30px; height: 17px; border-radius: 99px; background: var(--line-2); position: relative; transition: background .2s; flex: none; }
    .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: var(--sheet);
      transition: transform .22s cubic-bezier(.3,1.4,.5,1); }
    .toggle[aria-checked="true"] .switch { background: var(--ink); }
    .toggle[aria-checked="true"] .switch::after { transform: translateX(13px); }
    .hidden { display: none !important; }

    /* Quick access: edge tab under the launcher + header button (open the side panel) */
    .qa-tab { width: 46px; height: 34px; padding: 8px 13px; border-radius: 6px; color: var(--ink-2); background: var(--paper);
      border: 1px solid var(--line-2); box-shadow: 0 10px 22px -14px rgba(29,27,23,.6); transition: transform .2s cubic-bezier(.3,1.4,.5,1), color .15s; }
    .qa-tab:hover { transform: translateX(-3px); color: var(--brand); }
    .qa-btn { display: flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px 0 6px; border-radius: 3px;
      font-size: 12px; font-weight: 600; color: var(--ink-2); border: 1px solid var(--line-2); background: var(--sheet); margin-right: 2px; transition: border-color .15s, color .15s; }
    .qa-btn svg { width: 15px; height: 15px; }
    .qa-btn:hover { border-color: var(--ink-2); color: var(--ink); }

    /* Attachments (resume / cover letter) */
    .uploads { display: flex; flex-direction: column; border-top: 1px solid var(--line-2); }
    .up { padding: 10px 0 11px; border-bottom: 1px solid var(--line); }
    .up-top { display: flex; align-items: center; gap: 10px; }
    .up-ico { width: 28px; height: 34px; border-radius: 2px 7px 2px 2px; flex: none; display: grid; place-items: center;
      background: #fff; border: 1px solid var(--line-2); color: var(--brand); font: 700 9px var(--mono); }
    .up.done .up-ico { color: var(--ok); }
    .up-txt { flex: 1; min-width: 0; }
    .up-txt b { display: block; font-size: 13px; font-weight: 600; }
    .up-txt span { display: block; font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .up.pending .up-txt span { color: var(--brand); }
    .up.done .up-txt span { color: var(--ok); }
    .up-go { width: 24px; height: 24px; padding: 5px; border-radius: 3px; color: var(--faint); flex: none; }
    .up-go:hover { background: var(--soft); color: var(--ink); }
    .up-actions { display: flex; gap: 6px; margin-top: 8px; padding-left: 38px; }
    .up-btn { flex: 1; height: 30px; border-radius: 3px; font-size: 12.5px; font-weight: 600; border: 1px solid var(--line-2);
      background: var(--sheet); color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 8px; transition: border-color .15s, background .15s; }
    .up-btn:hover { border-color: var(--ink-2); background: #fff; }
    .up-btn.primary { border-color: var(--ink); color: var(--paper); background: var(--ink); }
    .up-btn.primary:hover { background: var(--brand); border-color: var(--brand); }
    /* "Check this": filled but uncertain */
    .item.review { border-left-color: var(--warn); background: var(--warn-bg); }
    .item.review:hover { background: #F0E2C2; }
    .item.review .meta { color: var(--warn); }
    .looks-right { align-self: flex-end; margin: 4px 0 6px; height: 24px; padding: 0 9px; border-radius: 3px; font-size: 11.5px; font-weight: 600;
      color: var(--warn); border: 1px solid #DCC28A; background: var(--sheet); transition: background .15s; }
    .looks-right:hover { background: var(--warn-bg); }
    .ai-note { margin-top: 10px; font-size: 11.5px; color: var(--warn); border-left: 2px solid var(--warn); padding: 4px 0 4px 9px; }

    /* Check before submit */
    .presubmit { margin-top: 12px; border: 1px solid var(--brand); border-top-width: 3px; border-radius: 4px; padding: 11px 12px 12px; background: var(--sheet); }
    .ps-head { display: flex; align-items: flex-start; gap: 8px; color: var(--brand); font-size: 13.5px; }
    .ps-head b { font: 600 15px/1.3 var(--serif); color: var(--ink); }
    .ps-ico { width: 17px; height: 17px; flex: none; margin-top: 1px; }
    .ps-list { display: flex; flex-direction: column; margin: 10px 0 12px; max-height: 240px; overflow: auto; border-top: 1px solid var(--line); }
    .ps-item { text-align: left; padding: 7px 2px; border-bottom: 1px solid var(--line); font-size: 12.5px; transition: background .15s; }
    .ps-item:hover { background: #fff; }
    .ps-item b { display: block; font-weight: 600; color: var(--ink); }
    .ps-item span { display: block; color: var(--brand); font-size: 11.5px; margin-top: 1px; }
    .ps-item.review span { color: var(--warn); }
    .ps-acts { display: flex; gap: 8px; }
    .ps-acts button { flex: 1; height: 32px; border-radius: 3px; font-size: 13px; font-weight: 600; transition: background .15s, border-color .15s; }
    .ps-fix { color: #FBF6EF; background: var(--brand); border: 1px solid var(--brand); }
    .ps-fix:hover { background: var(--brand-ink); }
    .ps-go { color: var(--ink-2); background: transparent; border: 1px solid var(--line-2); }
    .ps-go:hover { border-color: var(--ink-2); color: var(--ink); }
    .logged { margin-top: 12px; padding: 7px 0 7px 10px; border-left: 2px solid var(--ok); color: var(--ok); font-size: 12.5px; font-weight: 500; }
    .mode-note { margin-top: 6px; font-size: 11.5px; color: var(--muted); }
    .mode-note button { color: var(--brand); font-weight: 600; font-size: 11.5px; }
    .mode-note button:hover { text-decoration: underline; text-underline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
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
          <div class="presubmit hidden" data-ref="presubmit" role="alertdialog" aria-label="Before you submit">
            <div class="ps-head"><span class="ps-ico">${I.alert}</span><b data-ref="psTitle">Before you submit</b></div>
            <div class="ps-list" data-ref="psList"></div>
            <div class="ps-acts">
              <button class="ps-fix" data-act="ps-fix">Let me fix</button>
              <button class="ps-go" data-act="ps-go">Submit anyway</button>
            </div>
          </div>

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
            <div class="section-title"><span>Attachments</span> <span class="st-count" data-ref="uploadCount"></span></div>
            <div class="uploads" data-ref="uploads"></div>
            <div class="mode-note" data-ref="modeNote"></div>
            <input type="file" data-ref="picker" accept=".pdf,.doc,.docx,.txt,.rtf,.odt" hidden />
          </div>

          <div class="logged hidden" data-ref="logged"></div>
          <div class="all-done hidden" data-ref="allDone"><span class="ico">${I.check}</span>Everything in your profile is filled. Read it over, then submit.</div>

          <div class="ai-note hidden" data-ref="aiNote"></div>

          <div class="hidden" data-ref="attentionWrap">
            <div class="section-title"><span data-ref="reportTitle">Unfilled fields</span> <span class="st-count" data-ref="reportCount"></span></div>
            <div class="report-tip" data-ref="reportTip"></div>
            <div class="list" data-ref="attention"></div>
            <button class="more hidden" data-ref="reportMore"></button>
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
          <span class="foot-links"><button class="link muted" data-act="diag" title="Copy the structure of this form (no personal values) to send for support">Copy diagnostics</button><button class="link" data-act="profile">Profile</button></span>
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
    // The engine decides what "needs you" means (summary.todo); every count shown agrees with it.
    const todo = summary.todo ?? pendingUploads;
    ref('stats').classList.toggle('hidden', !showResults);
    ref('filled').textContent = summary.filled;
    ref('todo').textContent = todo;

    renderReport(summary, showResults);
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

  /**
   * Unfilled-field report: every field Hasanify couldn't fill, why, and — when
   * the user answers one on the page — an offer to remember that answer.
   */
  function renderReport(summary, show) {
    const rows = summary.report ?? [];
    const mode = summary.learningMode ?? 'ask';
    const list = ref('attention');
    list.replaceChildren();

    // Rows that need you first, then ones you've already handled; optional
    // questions Hasanify didn't recognise stay folded (they don't count).
    const needs = rows.filter((r) => r.action);
    const handled = rows.filter((r) => !r.action && (r.answered || r.learn));
    const optional = rows.filter((r) => !needs.includes(r) && !handled.includes(r));
    const visible = ui.showAllMissed ? [...needs, ...handled, ...optional] : [...needs, ...handled];

    for (const r of visible) {
      const wrap = document.createElement('div');
      wrap.className = 'ritem';
      const b = document.createElement('button');
      const state = r.answered ? 'done' : r.required ? '' : 'optional';
      b.className = `item ${state}`;
      b.innerHTML = `<span class="txt"><span class="t"></span><span class="meta"></span></span><span class="go">${I.arrow}</span>`;
      b.querySelector('.t').textContent = r.label;
      b.querySelector('.meta').textContent = [r.answered ? '✓ Answered by you' : r.required ? 'Required' : 'Optional', r.reason].filter(Boolean).join(' · ');
      b.title = 'Show this field on the page';
      b.addEventListener('click', () => jumpTo(r.el));
      wrap.append(b);

      if (r.review) {
        // Filled, but Hasanify isn't sure: show what it put in + a one-click confirm.
        b.className = 'item review';
        b.querySelector('.meta').textContent = `Check this · ${r.reason}${r.value ? ` · “${r.value}”` : ''}`;
        const ok = document.createElement('button');
        ok.className = 'looks-right';
        ok.textContent = 'Looks right';
        ok.title = 'Confirm this answer';
        ok.addEventListener('click', () => engine.confirmReview(r.rid));
        wrap.append(ok);
      }

      if (r.learn?.status === 'pending') {
        const learn = document.createElement('div');
        learn.className = 'learn';
        learn.innerHTML = `Remember your answer for next time?<q></q><div class="acts"><button class="save">Save answer</button><button class="skip">Not now</button></div>`;
        learn.querySelector('q').textContent = r.learn.answer;
        learn.querySelector('.save').addEventListener('click', () => engine.saveLearned(r.id));
        learn.querySelector('.skip').addEventListener('click', () => engine.dismissLearned(r.id));
        wrap.append(learn);
      } else if (r.learn?.status === 'saved') {
        const learn = document.createElement('div');
        learn.className = 'learn saved';
        learn.textContent = '✓ Learned — Hasanify fills this next time';
        wrap.append(learn);
      }
      list.append(wrap);
    }

    const more = ref('reportMore');
    more.classList.toggle('hidden', !optional.length);
    more.textContent = ui.showAllMissed ? 'Hide optional questions'
      : `${optional.length} optional question${optional.length === 1 ? '' : 's'} Hasanify didn’t recognise — show`;
    more.onclick = () => { ui.showAllMissed = !ui.showAllMissed; render(); };

    // Title count = the same "needs you" number as the stat above (uploads have their own card).
    ref('reportCount').textContent = needs.length || (handled.length ? '' : optional.length);
    ref('reportTitle').textContent = needs.length
      ? (needs.every((r) => r.review) ? 'Please check' : 'Needs you')
      : handled.length ? 'Handled' : 'Optional questions';
    const aiNote = ref('aiNote');
    aiNote.textContent = summary.aiNotice ? `AI assist: ${summary.aiNotice}` : '';
    aiNote.classList.toggle('hidden', !summary.aiNotice || !show);
    ref('reportTip').textContent = rows.some((r) => r.review) && !rows.some((r) => !r.review && !r.answered)
      ? 'Hasanify filled these but wasn’t sure — the amber fields on the page. Click one to check it.'
      : mode === 'off' ? ''
      : rows.some((r) => !r.answered && r.learnable)
        ? (mode === 'auto' ? 'Answer these on the page — Hasanify learns your answers automatically.' : 'Answer these on the page — Hasanify will offer to remember them.')
        : '';
    ref('attentionWrap').classList.toggle('hidden', !show || !rows.length);
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
    ref('uploadCount').textContent = pending || '';
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

  // Check before submit: the engine held the submit and lists what looks wrong.
  engine.setPresubmitUI?.(true);
  engine.events.addEventListener('presubmit', (e) => {
    const { issues, proceed } = e.detail;
    ui.presubmit = { proceed };
    mount();
    if (!ui.open) setOpen(true);
    const n = (k) => issues.filter((i) => i.kind === k).length;
    ref('psTitle').textContent = n('required') ? `Before you submit — ${n('required')} required field${n('required') === 1 ? ' is' : 's are'} empty`
      : n('company') ? 'Before you submit — wrong company?' : `Before you submit — ${issues.length} answer${issues.length === 1 ? '' : 's'} to check`;
    const list = ref('psList');
    list.replaceChildren();
    for (const issue of issues.slice(0, 12)) {
      const b = document.createElement('button');
      b.className = `ps-item ${issue.kind}`;
      b.innerHTML = '<b></b><span></span>';
      b.querySelector('b').textContent = issue.label;
      b.querySelector('span').textContent = issue.detail ?? (issue.kind === 'required' ? 'Required — still empty' : '');
      b.addEventListener('click', () => {
        if (issue.kind === 'review' && issue.id != null) engine.confirmReview(issue.id);
        jumpTo(issue.el);
      });
      list.append(b);
    }
    ref('presubmit').classList.remove('hidden');
    panel.querySelector('.body').scrollTop = 0;
    ref('presubmit').querySelector('.ps-fix').focus();
  });

  function closePresubmit(jumpToFirst) {
    ref('presubmit').classList.add('hidden');
    const first = ref('psList').querySelector('.ps-item');
    if (jumpToFirst && first) first.click();
    ui.presubmit = null;
  }

  // Tracker: the final Submit was recorded.
  engine.events.addEventListener('application-logged', (e) => {
    const el = ref('logged');
    el.textContent = `Logged in your applications tracker${e.detail?.company ? ` — ${e.detail.company}` : ''}.`;
    el.classList.remove('hidden');
  });

  engine.events.addEventListener('uploads-changed', () => host.isConnected && render());
  engine.events.addEventListener('learning-changed', () => host.isConnected && render());

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
      <div style="width:260px;padding:14px 16px;border-radius:6px;background:#FBF9F4;color:#1D1B17;border:1px solid #CFC7B6;
        box-shadow:0 18px 40px -20px rgba(61,47,25,.55);font:13px/1.45 "Segoe UI",system-ui,sans-serif">
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
    if (act === 'close') { ui.dismissed = true; host.remove(); engine.setPresubmitUI?.(false); }
    if (act === 'ps-fix') closePresubmit(true);
    if (act === 'diag') {
      const btn = e.target.closest('[data-act="diag"]');
      try {
        await navigator.clipboard.writeText(engine.diagnostics());
        btn.textContent = 'Copied — paste it to support';
      } catch {
        btn.textContent = 'Copy failed — see console';
        console.log(engine.diagnostics());
      }
      setTimeout(() => { btn.textContent = 'Copy diagnostics'; }, 2500);
    }
    if (act === 'ps-go') { const go = ui.presubmit?.proceed; closePresubmit(false); go?.(); }
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
