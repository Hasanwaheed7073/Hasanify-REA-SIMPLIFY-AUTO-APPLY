/**
 * Hasanify — Content script
 * ---------------------------------------------------------------------------
 * Pipeline (per run):
 *
 *   scanFields()         find every fillable control (light DOM + open shadow roots)
 *        │               and group radios / checkbox groups into one logical field
 *        ▼
 *   collectSignals()     attributes, <label>, aria, placeholder, nearby text,
 *        │               container attrs, and the enclosing section (education/experience)
 *        ▼
 *   classify()           score each FIELD_DEF against those signals, pick the best
 *        │               (user customAnswers are checked first)
 *        ▼
 *   resolve value        read the profile (with repeated-section index for edu/exp)
 *        │               and turn it into a "desired" spec (text candidates / bool / file)
 *        ▼
 *   fill*()              native setter + input/change/blur events, or real click
 *                        sequences for radios, checkboxes and custom dropdowns
 *
 * A MutationObserver re-runs the pipeline (debounced) when new fields appear,
 * which covers multi-step wizards (Workday), "Add another" sections and SPA
 * route changes. Each element is processed once (tracked in `state.registry`).
 *
 * A note on React and isolated worlds
 * -----------------------------------
 * React keeps a per-element "value tracker" and ignores an `input` event when
 * the DOM value equals the tracked value. Page scripts therefore usually call
 * the *prototype* value setter to bypass React's instance-level override.
 * Content scripts run in an isolated JS world: React's override is not even
 * visible here, so our assignment always goes through the native setter and
 * React sees a changed value when our bubbling `input` event reaches its root
 * listener. We still call the prototype setter explicitly so this code keeps
 * working if it is ever moved to the MAIN world (world: "MAIN").
 */
(() => {
  'use strict';

  // Guard: the script can be injected twice (manifest + scripting.executeScript).
  // A copy left over from before an extension update/reload is DEAD (its
  // chrome.runtime connection is gone) and must not block the fresh one.
  if (globalThis.__hasanifyLoaded && globalThis.__hasanifyAlive?.()) return;
  globalThis.__hasanifyLoaded = true;
  const runtimeId = chrome.runtime?.id;
  globalThis.__hasanifyAlive = () => {
    try { return !!chrome.runtime?.id && chrome.runtime.id === runtimeId; } catch { return false; }
  };

  const { DEFAULT_PROFILE, DEFAULT_SETTINGS, mergeWithDefaults } = globalThis.HasanifySchema;

  // ═════════════════════════════════════════════════════════════════════════
  // 0. Configuration
  // ═════════════════════════════════════════════════════════════════════════

  const CONFIG = Object.freeze({
    MIN_SCORE: 3,              // minimum heuristic score to accept a classification
    MIN_OPTION_SCORE: 55,      // minimum score to accept a <select>/radio/listbox option
    MUTATION_DEBOUNCE_MS: 450,
    MAX_DEBOUNCE_MS: 1500,     // never postpone a run longer than this, however busy the page is
    ARMED_POLL_MS: 2500,       // while following an application, look for new fields this often
    LEARNED_MIN_SIMILARITY: 0.72, // learned answer ↔ question (concept-level similarity)
    REVIEW_OPTION_SCORE: 72,   // option matches below this are filled but flagged "check this"
    AI_MAX_BATCH: 20,          // questions per AI request
    OPTION_WAIT_MS: 2000,      // how long to wait for an async dropdown to render options
    BETWEEN_FIELDS_MS: 25,     // breathing room for frameworks that batch state updates
    MAX_TEXT_LEN: 300,         // longer "labels" are probably paragraphs, not labels
    ANCESTOR_DEPTH: 5,         // how far up we look for nearby label text
    SECTION_DEPTH: 14,         // how far up we look for an education/experience section
    MAX_RETRIES: 3,            // failed / page-reverted fields are retried on later runs
    DEBUG: false,
  });

  /** Everything we consider a potential form control. */
  const FIELD_SELECTOR = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"])' +
      ':not([type="image"]):not([type="password"]):not([type="range"]):not([type="color"])',
    'textarea',
    'select',
    'button[aria-haspopup="listbox"]',  // Workday-style "Select One" dropdowns
    '[role="combobox"]:not(input)',     // MUI / headless-UI div comboboxes
  ].join(',');

  /** Selectors for options rendered by custom dropdowns (often portaled to <body>). */
  const OPTION_SELECTOR = [
    '[role="option"]',
    '[data-automation-id="promptOption"]', // Workday
    '[class*="select__option"]',           // react-select (Greenhouse, Ashby)
    '[class*="-option"][id*="option"]',
    '.dropdown-location',                  // Lever location suggestions
    '.pac-item',                           // Google Places autocomplete
  ].join(',');

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  const log = (...a) => CONFIG.DEBUG && console.debug('[Hasanify]', ...a);

  // ═════════════════════════════════════════════════════════════════════════
  // 1. Runtime state
  // ═════════════════════════════════════════════════════════════════════════

  const state = {
    profile: null,
    settings: null,
    armed: false,          // when true, DOM mutations trigger fills automatically
    filling: false,        // re-entrancy guard
    pendingRun: false,     // a run was requested while one was in progress
    debounceTimer: 0,
    observer: null,
    observedRoots: new WeakSet(),
    lastUrl: location.href,
    /**
     * Element -> { regKey, status, retries, key }
     * status: 'filled' | 'skipped-user' | 'no-value' | 'no-option' | 'unmatched' | 'failed'
     * Iterable (not a WeakMap) because we use it to compute repeated-section indexes.
     */
    registry: new Map(),
    filledEver: new Set(), // every element ever filled on this page (multi-step total)
    uploads: new Map(),    // Element -> upload entry (resume / cover letter fields)
    learn: new Map(),      // Element -> learning entry (fields watched for user answers)
    reportedMissed: new Set(), // question keys already sent to the missed-questions history
    verifyTimers: [],
    lastStats: null,
    pickScores: [],        // option-match scores of the field being filled (→ confidence)
    companies: [],         // employers of other applications (wrong-company check)
    siteNote: null,        // what Hasanify learned about this site's form last time
    submitBypassUntil: 0,  // "Submit anyway" lets the next submit through
    aiNotice: '',          // why AI help was skipped (not configured, error…)
  };
  let regSeq = 0;          // ids for registry entries (widget "Looks right" buttons)

  // ═════════════════════════════════════════════════════════════════════════
  // 2. Generic helpers
  // ═════════════════════════════════════════════════════════════════════════

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Normalize any label/attribute into lowercase space-separated words:
   *   "legalNameSection_firstName" → "legal name section first name"
   *   "urls[LinkedIn]"             → "urls linked in"
   *   "First Name *"               → "first name"
   */
  const norm = (s) =>
    String(s ?? '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/['’]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .toLowerCase()
      .trim();

  const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Collapsed, length-capped visible text of a node. */
  const textOf = (node) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

  /** getElementById that respects shadow roots. */
  function byId(contextEl, id) {
    const root = contextEl.getRootNode();
    return (root.getElementById && root.getElementById(id)) || document.getElementById(id);
  }

  /** Parent that crosses shadow-root boundaries. */
  const parentOf = (node) => node.parentElement ?? (node.getRootNode() instanceof ShadowRoot ? node.getRootNode().host : null);

  /** Yields `root` and every open shadow root nested beneath it. */
  function* walkRoots(root = document) {
    yield root;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.shadowRoot) yield* walkRoots(n.shadowRoot);
    }
  }

  function queryAllDeep(selector) {
    const out = [];
    for (const root of walkRoots(document)) {
      out.push(...root.querySelectorAll(selector));
      if (root !== document) observeRoot(root); // keep the observer on new shadow roots
    }
    return out;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  /**
   * Visibility for the purposes of "should we fill this".
   *  • File inputs are almost always visually hidden behind a styled button.
   *  • Custom-styled radios/checkboxes hide the <input> but show the <label>.
   */
  function isFillable(el) {
    if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.closest('[aria-hidden="true"], [inert]')) return el.type === 'file';
    if (el.type === 'file') return true;
    if (isVisible(el)) return true;
    if (el.type === 'radio' || el.type === 'checkbox') {
      return [...(el.labels ?? [])].some(isVisible) || (el.parentElement && isVisible(el.parentElement));
    }
    return false;
  }

  /** Poll `fn` until it returns a truthy value or the timeout elapses. */
  async function waitFor(fn, timeout = CONFIG.OPTION_WAIT_MS, interval = 80) {
    const end = performance.now() + timeout;
    while (performance.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3. Signal extraction (what does the page say about this control?)
  // ═════════════════════════════════════════════════════════════════════════

  /** Text of a <label> without the text of controls nested inside it (e.g. <option>s). */
  function labelText(label) {
    const clone = label.cloneNode(true);
    clone.querySelectorAll('input, select, textarea, option, button, [role="listbox"]').forEach((n) => n.remove());
    return textOf(clone);
  }

  /** Explicit labelling: aria-labelledby → <label for>/wrapping label → closest label. */
  function getExplicitLabel(el) {
    const parts = [];
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const n = byId(el, id);
        if (n && n !== el) parts.push(textOf(n));
      }
    }
    for (const l of el.labels ?? []) parts.push(labelText(l));
    if (!parts.length) {
      const wrapping = el.closest('label');
      if (wrapping) parts.push(labelText(wrapping));
    }
    return [...new Set(parts.filter(Boolean))].join(' ').slice(0, CONFIG.MAX_TEXT_LEN);
  }

  /**
   * Implicit labelling for div-soup forms (Lever custom questions, Ashby, many
   * home-grown ATSs): walk up a few ancestors and take the closest preceding
   * sibling text that does not itself contain another field.
   */
  function getNearbyText(el) {
    let node = el;
    for (let depth = 0; depth < CONFIG.ANCESTOR_DEPTH && node && node !== document.body; depth++) {
      for (let sib = node.previousSibling, hops = 0; sib && hops < 4; sib = sib.previousSibling) {
        if (sib.nodeType === Node.TEXT_NODE) {
          const t = textOf(sib);
          if (t) return t.slice(0, CONFIG.MAX_TEXT_LEN);
          continue;
        }
        if (sib.nodeType !== Node.ELEMENT_NODE) continue;
        hops++;
        // Another control sits between us and the text → that text belongs to it.
        if (sib.matches(FIELD_SELECTOR) || sib.querySelector(FIELD_SELECTOR)) return '';
        const t = textOf(sib);
        if (t && t.length <= CONFIG.MAX_TEXT_LEN) return t;
      }
      node = parentOf(node);
    }
    return '';
  }

  /** Identifying attributes of the element itself. */
  function getAttrText(el) {
    return ['name', 'id', 'data-automation-id', 'data-qa', 'data-testid', 'data-test', 'data-field', 'formcontrolname', 'ng-model', 'v-model']
      .map((a) => el.getAttribute(a))
      .filter(Boolean)
      .join(' ');
  }

  /**
   * Attributes of the 3 nearest ancestors. Workday wraps each control in
   * <div data-automation-id="formField-startDate">, which is the only reliable
   * hint that a bare "Month" input belongs to the start date.
   */
  function getContainerAttrText(el) {
    const bits = [];
    let node = parentOf(el);
    for (let i = 0; i < 3 && node && node !== document.body; i++, node = parentOf(node)) {
      for (const a of ['data-automation-id', 'data-qa', 'data-testid', 'id', 'name']) {
        const v = node.getAttribute?.(a);
        if (v && v.length < 80) bits.push(v);
      }
    }
    return bits.join(' ');
  }

  const SECTION_PATTERNS = [
    ['education', /\b(educat|school|universit|college|academic|degree)/],
    ['experience', /\b(experience|employment|work history|job history|employer|positions? held|work ?experience)\b/],
  ];

  /**
   * Determine whether a control lives inside an Education or Experience block,
   * and if the block advertises its ordinal ("Work Experience 2", id="education-1").
   * The *closest* matching ancestor wins.
   */
  function getSection(el) {
    let node = parentOf(el);
    for (let depth = 0; depth < CONFIG.SECTION_DEPTH && node && node !== document.body; depth++, node = parentOf(node)) {
      const attrs = norm(['id', 'data-automation-id', 'data-qa', 'aria-label', 'class']
        .map((a) => node.getAttribute?.(a) ?? '')
        .join(' '));
      // Closest heading that precedes this ancestor (or its first heading child).
      const heading = node.querySelector?.(':scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [role="heading"]')
        ?? findPrecedingHeading(node);
      // Section headings are short ("Work Experience 2"). A long legend is a
      // question ("…sponsorship for employment…") and must not define a section.
      const rawHeading = textOf(heading);
      const headingText = rawHeading.length <= 50 ? norm(rawHeading) : '';
      // Page-level wrappers like "candidateExperience" / "user-experience" are not sections.
      const hay = `${attrs} ${headingText}`.replace(/\b(candidate|user|applicant|apply|application) experience\b/g, '');

      for (const [kind, rx] of SECTION_PATTERNS) {
        if (rx.test(hay)) {
          const m = hay.match(/(?:experience|education|employment)\D{0,15}?(\d{1,2})\b/);
          let index = null;
          if (m) {
            const n = Number(m[1]);
            index = n === 0 ? 0 : n - 1; // "Experience 1" is 1-based; "-0" ids are 0-based
          }
          return { kind, index };
        }
      }
    }
    return { kind: null, index: null };
  }

  function findPrecedingHeading(node) {
    for (let sib = node.previousElementSibling, hops = 0; sib && hops < 3; sib = sib.previousElementSibling, hops++) {
      if (sib.matches('h1, h2, h3, h4, h5, legend, [role="heading"]')) return sib;
    }
    return null;
  }

  // ---- Radio / checkbox groups --------------------------------------------

  /** The element enclosing all radios (or checkboxes) of the same question. */
  function getGroupContainer(el) {
    const explicit = el.closest('fieldset, [role="radiogroup"], [role="group"]');
    if (explicit) return explicit;
    if (el.name) {
      const scope = el.form ?? el.getRootNode();
      const peers = [...scope.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)];
      if (peers.length > 1) {
        let a = el.parentElement;
        while (a && !peers.every((p) => a.contains(p))) a = a.parentElement;
        return a;
      }
    }
    return null;
  }

  function getGroupMembers(el, container) {
    const type = el.type;
    if (el.name) {
      const scope = container ?? el.form ?? el.getRootNode();
      const same = [...scope.querySelectorAll(`input[type="${type}"][name="${CSS.escape(el.name)}"]`)];
      if (same.length > 1) return same;
    }
    return container ? [...container.querySelectorAll(`input[type="${type}"]`)] : [el];
  }

  /** The question text of a group (not the label of an individual option). */
  function getGroupQuestion(container, members) {
    if (!container) return '';
    const legend = container.querySelector(':scope > legend') ?? (container.tagName === 'FIELDSET' && container.querySelector('legend'));
    if (legend) return textOf(legend);
    const lb = container.getAttribute('aria-labelledby');
    if (lb) return lb.split(/\s+/).map((id) => textOf(byId(container, id))).join(' ');
    if (container.getAttribute('aria-label')) return container.getAttribute('aria-label');

    // First descendant text block that is not an option label.
    const optionLabels = new Set(members.flatMap((m) => [...(m.labels ?? []), m.closest('label')]).filter(Boolean));
    for (const n of container.querySelectorAll('label, legend, p, span, div, h1, h2, h3, h4, h5')) {
      if (optionLabels.has(n) || [...optionLabels].some((l) => l.contains(n) || n.contains(l))) continue;
      if (n.querySelector(FIELD_SELECTOR)) continue;
      const t = textOf(n);
      if (t && t.length <= CONFIG.MAX_TEXT_LEN) return t;
    }
    return getNearbyText(container);
  }

  /** Human-readable text of one radio/checkbox option. */
  function getOptionLabel(input) {
    return getExplicitLabel(input) || input.getAttribute('aria-label') || textOf(input.nextElementSibling) || input.value || '';
  }

  /**
   * Bundle every signal for a logical field.
   * Each source is normalized so the regexes below only need to handle
   * lowercase, space-separated words.
   */
  function collectSignals(field) {
    const { el, kind } = field;
    const isGroup = kind === 'radio' || kind === 'checkbox-group';

    let rawLabel = isGroup ? getGroupQuestion(field.container, field.members) : getExplicitLabel(el);
    let nearby = '';
    if (!rawLabel) {
      nearby = getNearbyText(isGroup && field.container ? field.container : el);
      rawLabel = nearby; // implicit label is the best we have
    }
    const section = getSection(el);

    return {
      kind,
      type: (el.getAttribute('type') ?? '').toLowerCase(),
      autocomplete: (el.getAttribute('autocomplete') ?? '').toLowerCase().trim(),
      rawLabel,
      label: norm(rawLabel),
      aria: norm([el.getAttribute('aria-label'), el.getAttribute('aria-description'), el.title].filter(Boolean).join(' ')),
      placeholder: norm(el.getAttribute('placeholder')),
      attrs: norm(getAttrText(el)),
      context: norm(getContainerAttrText(el)),
      section: section.kind,
      sectionIndex: section.index,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 4. Field definitions (the heuristic knowledge base)
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Each definition:
  //   key        unique id (also used for repeated-section counting)
  //   match      regexes tested against each normalized signal source
  //   exclude    regexes that disqualify (if hit in label/aria) or ignore a source
  //   autocomplete  HTML autocomplete tokens that are a definitive match
  //   types      input types that add a bonus (e.g. type=email)
  //   kinds      restrict to element kinds (text, textarea, select, radio, checkbox, ...)
  //   section    REQUIRE being inside 'education' | 'experience'
  //   notSection REFUSE when inside any of these sections
  //   date       value is a YYYY-MM(-DD) date that must be formatted per-field
  //   bool       value is boolean, rendered as Yes/No (or option matching)
  //   value      (profile, ctx) => raw value; ctx = { index, signals }
  //
  // ORDER MATTERS: on equal scores the earlier (more specific) definition wins.

  const P = (path) => (p) => getPath(p, path);
  const EDU = (f) => (p, ctx) => p.education?.[ctx.index]?.[f];
  const EXP = (f) => (p, ctx) => p.experience?.[ctx.index]?.[f];
  const TEXTISH = ['text', 'textarea', 'combobox', 'select', 'listbox'];
  const CHOICE = ['select', 'radio', 'combobox', 'listbox', 'checkbox', 'checkbox-group', 'text', 'textarea'];

  /** Whole years of work experience, overlapping jobs counted once. */
  function totalYears(experience) {
    const toMonth = (d) => { const m = /^(\d{4})-(\d{2})/.exec(d ?? ''); return m ? +m[1] * 12 + (+m[2] - 1) : null; };
    const now = new Date();
    const spans = (experience ?? []).map((e) => [toMonth(e.startDate), e.current || !e.endDate ? now.getFullYear() * 12 + now.getMonth() : toMonth(e.endDate)])
      .filter(([a, b]) => a != null && b != null && b >= a).sort((x, y) => x[0] - y[0]);
    if (!spans.length) return null;
    let months = 0, [cs, ce] = spans[0];
    for (const [a, b] of spans.slice(1)) {
      if (a <= ce) ce = Math.max(ce, b);
      else { months += ce - cs; [cs, ce] = [a, b]; }
    }
    months += ce - cs;
    return String(Math.floor(months / 12));
  }

  const FIELD_DEFS = [
    // ---- Documents ---------------------------------------------------------
    { key: 'documents.coverLetterFile', kinds: ['file'], match: [/cover ?letter/], value: () => null },
    { key: 'documents.resume', kinds: ['file'], match: [/resume|r sum|\bcv\b|curriculum/], exclude: [/cover/], value: P('documents.resume') },
    { key: 'documents.coverLetterText', kinds: ['textarea'], match: [/cover ?letter/], value: P('documents.coverLetterText') },

    // ---- Repeated sections first: they are strictly section-scoped --------
    { key: 'experience.current', section: 'experience', kinds: ['checkbox'], bool: true,
      match: [/currently (work|employed)|i (currently )?work here|current (job|role|position|employer)|present|still work/], value: EXP('current') },
    { key: 'experience.startDate', section: 'experience', date: true, kinds: TEXTISH,
      match: [/\bstart\b|\bfrom\b|\bbegin/], value: EXP('startDate') },
    { key: 'experience.endDate', section: 'experience', date: true, kinds: TEXTISH,
      match: [/\bend\b|\bto\b|until|\bfinish/], value: (p, c) => (p.experience?.[c.index]?.current ? '' : p.experience?.[c.index]?.endDate) },
    { key: 'experience.location', section: 'experience', kinds: TEXTISH, match: [/location|\bcity\b/], value: EXP('location') },
    { key: 'experience.description', section: 'experience', kinds: ['textarea', 'text'],
      match: [/description|responsibilit|achievement|duties|summary|role details/], value: EXP('description') },

    { key: 'education.current', section: 'education', kinds: ['checkbox'], bool: true,
      match: [/currently (attend|enrolled|studying)|i (currently )?attend|present/], value: EDU('current') },
    { key: 'education.startDate', section: 'education', date: true, kinds: TEXTISH,
      match: [/\bstart\b|\bfrom\b|\bbegin/], value: EDU('startDate') },
    { key: 'education.endDate', section: 'education', date: true, kinds: TEXTISH,
      match: [/\bend\b|\bto\b|graduat|completion|\bfinish/], value: EDU('endDate') },

    // ---- Names ---------------------------------------------------------------
    { key: 'personal.preferredName', kinds: TEXTISH,
      match: [/preferred (first )?name|nick ?name|goes by|known as|chosen name/],
      value: (p) => p.personal.preferredName || p.personal.firstName },
    { key: 'personal.firstName', kinds: TEXTISH, autocomplete: ['given-name'],
      match: [/\bfirst name\b|\bgiven name\b|\bfname\b|\bforename\b|\bfirst\b$/],
      exclude: [/preferred|nick|last|middle|emergency|reference|referr|company|school|manager|parent|spouse/],
      value: P('personal.firstName') },
    { key: 'personal.middleName', kinds: TEXTISH, autocomplete: ['additional-name'],
      match: [/middle (name|initial)/], value: P('personal.middleName') },
    { key: 'personal.lastName', kinds: TEXTISH, autocomplete: ['family-name'],
      match: [/\blast name\b|\bsurname\b|family name|\blname\b|\blast\b$/],
      exclude: [/emergency|reference|referr|manager|parent|spouse|maiden|previous|former/],
      value: P('personal.lastName') },
    { key: 'personal.fullName', kinds: TEXTISH, autocomplete: ['name'],
      match: [/\bfull name\b|\blegal name\b|\byour name\b|^name$|candidate name|applicant name|^name (first and last|first last)/],
      exclude: [/\bfirst\b|\blast\b|middle|company|school|employer|user ?name|reference|referr|emergency|manager|recruiter|signature|pronoun|pronunc|nick|preferred|call you/],
      value: (p) => [p.personal.firstName, p.personal.middleName, p.personal.lastName].filter(Boolean).join(' ') },
    { key: 'personal.pronouns', kinds: CHOICE, match: [/pronoun/], value: P('personal.pronouns') },

    // ---- Contact -------------------------------------------------------------
    { key: 'personal.email', kinds: TEXTISH, autocomplete: ['email'], types: ['email'],
      match: [/\be ?mail\b/], exclude: [/reference|referr|manager|recruiter|emergency|subscribe|newsletter/],
      value: P('personal.email') },
    { key: 'personal.phoneCountryCode', kinds: TEXTISH, autocomplete: ['tel-country-code'],
      match: [/country (phone )?code|dial(ing)? code|phone (country|prefix)|calling code|country region code/],
      value: (p) => p.personal.phoneCountryCode || (p.personal.address.country ? p.personal.address.country : '') },
    { key: 'personal.phoneType', kinds: ['select', 'listbox', 'combobox', 'radio'],
      match: [/phone (device )?type|type of phone/], value: () => 'Mobile' },
    { key: 'personal.phone', kinds: TEXTISH, autocomplete: ['tel', 'tel-national'], types: ['tel'],
      match: [/phone|mobile|\bcell\b|telephone|contact number/],
      exclude: [/code|extension|\bext\b|type|device|reference|emergency|consent|text message|sms/],
      value: P('personal.phone') },

    // ---- Address -------------------------------------------------------------
    { key: 'address.line2', kinds: TEXTISH, autocomplete: ['address-line2'],
      match: [/address (line )?2|apartment|\bapt\b|suite|\bunit\b/], value: P('personal.address.line2') },
    { key: 'address.line1', kinds: TEXTISH, autocomplete: ['address-line1', 'street-address'],
      match: [/address (line )?1|street|^address$|mailing address|home address|residential address|\baddress\b/],
      exclude: [/e ?mail|ip address|web|url|line 2|address 2|\bcity\b|\bstate\b|\bzip\b|postal/],
      value: P('personal.address.line1') },
    { key: 'address.city', kinds: TEXTISH, autocomplete: ['address-level2'],
      match: [/\bcity\b|\btown\b|locality/], exclude: [/ethnic|citizen/], value: P('personal.address.city') },
    { key: 'address.state', kinds: TEXTISH, autocomplete: ['address-level1'],
      match: [/\bstate\b|province|\bregion\b|prefecture/], exclude: [/status|statement/], value: P('personal.address.state') },
    { key: 'address.postalCode', kinds: TEXTISH, autocomplete: ['postal-code'],
      match: [/\bzip\b|postal|post ?code|zip ?code/], value: P('personal.address.postalCode') },
    { key: 'address.country', kinds: TEXTISH, autocomplete: ['country', 'country-name'],
      match: [/\bcountry\b/], exclude: [/code|phone|dial|citizen|authori|visa|sponsor|other than|outside/],
      value: P('personal.address.country') },
    // Location fields are usually autocompletes (Lever, Greenhouse). `suggest` makes
    // plain text inputs wait for a suggestion list; the candidate array goes from
    // most to least specific so the search query and the option match both work.
    { key: 'personal.location', kinds: TEXTISH, notSection: ['education', 'experience'], suggest: true,
      match: [/\blocation\b|where are you (currently )?(based|located)|current (city|location)|city (and|,) state/],
      exclude: [/preferred|desired|willing|relocat|office|job location|work location|which location/],
      value: (p) => {
        const { city, state, country } = p.personal.address;
        return [[city, state, country], [city, state], [city]].map((a) => a.filter(Boolean).join(', ')).filter(Boolean);
      } },

    // ---- Links ---------------------------------------------------------------
    { key: 'links.linkedin', kinds: TEXTISH, match: [/linked ?in/], value: P('links.linkedin') },
    { key: 'links.github', kinds: TEXTISH, match: [/git ?hub/], value: P('links.github') },
    { key: 'links.twitter', kinds: TEXTISH, match: [/twitter|\bx (profile|handle|url)\b/], value: P('links.twitter') },
    { key: 'links.portfolio', kinds: TEXTISH, match: [/portfolio|dribbble|behance/], value: (p) => p.links.portfolio || p.links.website },
    { key: 'links.website', kinds: TEXTISH, types: ['url'],
      match: [/website|personal (site|url|page)|\bblog\b|home ?page|^url$|other (link|url|website)|\blinks?\b/],
      exclude: [/linked ?in|git ?hub|company/], value: (p) => p.links.website || p.links.portfolio },

    // ---- Experience / education outside of explicit sections (Lever, Greenhouse) --
    { key: 'experience.company', kinds: TEXTISH, notSection: ['education'],
      match: [/\bcompany\b|employer|organi[sz]ation|\borg\b/],
      exclude: [/company (website|url|size)|why|hear about|previously (worked|employed)|related to|anyone/],
      value: EXP('company') },
    { key: 'experience.title', kinds: TEXTISH, notSection: ['education'],
      match: [/job title|\btitle\b|position|\brole\b|designation/],
      exclude: [/desired|applying|preferred|which|interested|salutation|prefix|honorific/],
      value: EXP('title') },
    { key: 'education.school', kinds: TEXTISH,
      match: [/\bschool\b|universit|college|institution|academy/], exclude: [/high school (diploma|graduate)|did you graduate|have you (ever )?attended/],
      value: EDU('school') },
    { key: 'education.fieldOfStudy', kinds: TEXTISH,
      match: [/\bmajor\b|field of study|discipline|concentration|area of study|specialization|degree field/],
      value: EDU('fieldOfStudy') },
    { key: 'education.degree', kinds: TEXTISH,
      match: [/\bdegree\b|qualification|level of education|education level|highest education/],
      exclude: [/field|discipline|major/], value: EDU('degree') },
    { key: 'education.minor', kinds: TEXTISH, match: [/\bminor\b/], value: EDU('minor') },
    { key: 'education.gpa', kinds: TEXTISH, match: [/\bgpa\b|grade point|\bcgpa\b/], value: EDU('gpa') },
    { key: 'education.graduation', kinds: TEXTISH, date: true,
      match: [/graduation (date|year)|grad(uation)? year|year of graduation|expected graduation|when did you graduate/],
      value: EDU('endDate') },

    // ---- Skills --------------------------------------------------------------
    { key: 'skills.languages', kinds: [...TEXTISH, 'checkbox-group'],
      match: [/languages? (do )?you speak|spoken languages?|language proficienc|languages? other than|language skills?|languages? (do you know|you are fluent)/],
      value: (p) => p.skills.spokenLanguages.map((l) => (l.proficiency ? `${l.language} (${l.proficiency})` : l.language)).join(', ') },
    { key: 'skills.technical', kinds: ['text', 'textarea', 'combobox'],
      match: [/\bskills?\b|technolog(y|ies)|tech stack|programming languages|tools/],
      exclude: [/years|rate your|how many/], value: (p) => p.skills.technical.join(', ') },
    { key: 'skills.certifications', kinds: ['text', 'textarea'], match: [/certific|licen[cs]e/],
      exclude: [/driver/], value: (p) => p.skills.certifications.join(', ') },

    // Total professional experience, computed from the work history (overlaps
    // merged). Skill-specific questions ("years with Python") are excluded:
    // a total would be the wrong answer there.
    { key: 'experience.totalYears', kinds: CHOICE, review: true,
      match: [/(how many|number of|total) years|years of (professional |relevant |industry |work |full.?time )?(work )?experience|total (work )?experience|experience level/],
      exclude: [/\b(with|using)\b|\b18\b|eighteen|\bage\b|old are you|years (at|in) (this|your current)/],
      value: (p) => totalYears(p.experience) },

    // ---- Work authorization (sponsorship first; it's the more specific question) --
    { key: 'workAuth.sponsorship', kinds: CHOICE, bool: true,
      match: [/sponsor|visa (support|transfer)|\bh ?1 ?b\b|immigration support/],
      value: P('workAuthorization.requiresSponsorship') },
    { key: 'workAuth.authorized', kinds: CHOICE, bool: true,
      match: [/authori[sz]ed to work|legally (authori[sz]ed|eligible|permitted|able) to work|right to work|eligible to work|work authori[sz]ation|permitted to work|legal right/],
      exclude: [/sponsor/], value: P('workAuthorization.authorizedToWork') },
    { key: 'workAuth.visaStatus', kinds: CHOICE,
      match: [/visa (status|type)|immigration status|work permit|current visa|residency status/],
      exclude: [/sponsor/], value: P('workAuthorization.visaStatus') },
    { key: 'workAuth.citizenship', kinds: CHOICE,
      match: [/citizenship|nationality|citizen of/], exclude: [/sponsor|authori/], value: P('workAuthorization.citizenship') },
    { key: 'workAuth.clearance', kinds: CHOICE,
      match: [/security clearance|clearance (level|status)|active clearance/], value: P('workAuthorization.securityClearance') },
    { key: 'prefs.over18', kinds: CHOICE, bool: true,
      match: [/\b(18|eighteen) (years|or older)|at least 18|legal (working )?age|of legal age/], value: P('preferences.over18') },

    // ---- Voluntary self-identification (EEO) --------------------------------
    { key: 'diversity.hispanic', kinds: CHOICE, match: [/hispanic|latin(o|a|x)/], value: P('diversity.hispanicOrLatino') },
    { key: 'diversity.race', kinds: CHOICE, match: [/\brace\b|ethnicit|ethnic (background|origin)|racial/], value: P('diversity.race') },
    { key: 'diversity.transgender', kinds: CHOICE, match: [/transgender|trans ?gender|identify as trans/], value: P('diversity.transgender') },
    { key: 'diversity.gender', kinds: CHOICE, match: [/\bgender\b|\bsex\b/], exclude: [/transgender|orientation/], value: P('diversity.gender') },
    { key: 'diversity.orientation', kinds: CHOICE, match: [/sexual orientation|\borientation\b/], value: P('diversity.sexualOrientation') },
    { key: 'diversity.veteran', kinds: CHOICE, match: [/veteran|military (service|status)|armed forces/], value: P('diversity.veteranStatus') },
    { key: 'diversity.disability', kinds: CHOICE, match: [/disabilit|handicap/], value: P('diversity.disabilityStatus') },

    // ---- Preferences ---------------------------------------------------------
    { key: 'prefs.salary', kinds: TEXTISH,
      match: [/salary|compensation|pay (expectation|range|requirement)|expected (pay|ctc)|desired pay|rate expectation/],
      exclude: [/current salary/], value: P('preferences.desiredSalary') },
    { key: 'prefs.notice', kinds: TEXTISH, match: [/notice period/], value: P('preferences.noticePeriod') },
    { key: 'prefs.earliestStart', kinds: TEXTISH, date: true, notSection: ['education', 'experience'],
      match: [/earliest start|available to start|availability date|when can you (start|join)|\bstart date\b|date available/],
      value: P('preferences.earliestStartDate') },
    { key: 'prefs.relocate', kinds: CHOICE, bool: true, match: [/relocat/], value: P('preferences.willingToRelocate') },
    { key: 'prefs.source', kinds: CHOICE,
      match: [/how (did )?you (hear|heard|find|found|learn|learned|come across|came across)|where did you (hear|find|see)|heard about (this|us|the)|referral source|source of (application|referral)|how were you referred/],
      value: P('preferences.howDidYouHear') },
  ];

  // Heuristic weights per signal source.
  const SOURCE_WEIGHTS = Object.freeze({ label: 5, aria: 4, placeholder: 3, attrs: 3, context: 2 });

  /** Score a definition against a field's signals. 0 = not this field. */
  function scoreDef(def, sig) {
    if (def.kinds && !def.kinds.includes(sig.kind)) return 0;
    if (def.section && sig.section !== def.section) return 0;
    if (def.notSection?.includes(sig.section)) return 0;

    // The autocomplete attribute is authored intent: treat it as definitive.
    if (sig.autocomplete && def.autocomplete?.includes(sig.autocomplete)) return 100;

    let score = 0;
    for (const [source, weight] of Object.entries(SOURCE_WEIGHTS)) {
      const text = sig[source];
      if (!text) continue;
      if (def.exclude?.some((rx) => rx.test(text))) {
        // A human-readable label that hits an exclusion is a hard "no".
        if (source === 'label' || source === 'aria') return 0;
        continue; // a machine attribute hit only discounts that source
      }
      if (def.match.some((rx) => rx.test(text))) score += weight;
    }
    // Date parts (Workday "Month"/"Year" inputs) carry their meaning only on the
    // wrapper ("formField-startDate"); the part name itself confirms the guess.
    if (def.date && score > 0 && /\b(month|year|date|mm|yyyy)\b/.test(`${sig.label} ${sig.aria} ${sig.placeholder} ${sig.attrs}`)) score += 2;
    if (score > 0 && def.types?.includes(sig.type)) score += 3;
    else if (def.types?.includes(sig.type) && !sig.label) score += 3; // unlabeled <input type=email>
    return score;
  }

  // ---- Learned-answer matching ---------------------------------------------
  // Learned answers store the whole question with the company replaced by
  // "{company}" ("why do you want to work at {company}"), so one answer serves
  // every employer. They match by word overlap, not substring.

  const STOP = new Set('a an the to of in on at for and or you your do does did are is be been have has had please if any this that with we us our i my me will would can could should from by as it its about currently presently now ever yet also any were was am'.split(' '));

  /**
   * Meaning, not spelling: words that ask the same thing collapse onto one
   * concept, so "Are you legally permitted to work in the US?" and "Do you
   * have US work authorization?" compare as the same question. Each group's
   * first word is the concept name.
   */
  const CONCEPTS = [
    ['authorize', 'authorized', 'authorised', 'authorization', 'authorisation', 'permitted', 'permit', 'eligible', 'eligibility', 'legally', 'lawfully', 'entitled', 'allowed'],
    ['sponsor', 'sponsorship', 'sponsored', 'visa', 'h1b', 'immigration'],
    ['require', 'requires', 'required', 'need', 'needs', 'necessitate'],
    ['work', 'worked', 'working', 'employment', 'employed', 'employ', 'employee', 'job'],
    ['us', 'usa', 'america', 'american', 'united', 'states'],
    ['relocate', 'relocation', 'relocating', 'move', 'moving'],
    ['start', 'join', 'begin', 'available', 'availability', 'commence'],
    ['salary', 'compensation', 'pay', 'remuneration', 'ctc', 'wage', 'rate'],
    ['expect', 'expected', 'expectation', 'expectations', 'desired', 'target', 'requirement', 'requirements'],
    ['year', 'years', 'yrs', 'yr'],
    ['experience', 'experienced', 'background', 'expertise'],
    ['onsite', 'office', 'in-office', 'in person', 'hybrid', 'commute', 'commuting'],
    ['remote', 'remotely', 'wfh', 'distributed'],
    ['refer', 'referred', 'referral', 'referrer'],
    ['hear', 'heard', 'learn', 'find', 'found', 'discover', 'source'],
    ['previously', 'before', 'formerly', 'past', 'prior'],
    ['contractor', 'contract', 'freelance', 'freelancer'],
    ['notice', 'resign', 'resignation'],
    ['clearance', 'cleared'],
    ['convict', 'conviction', 'convicted', 'felony', 'criminal', 'offense', 'offence'],
    ['travel', 'travelling', 'traveling'],
    ['shift', 'shifts', 'weekend', 'weekends', 'overtime', 'night', 'nights'],
    ['degree', 'diploma', 'qualification'],
    ['company', 'organization', 'organisation', 'firm', 'team'],
    ['why', 'motivation', 'motivates', 'interest', 'interested', 'excites', 'attracted'],
    ['age', '18', 'eighteen', 'older', 'adult'],
  ];
  const CONCEPT_OF = new Map();
  for (const group of CONCEPTS) for (const w of group) CONCEPT_OF.set(w, `~${group[0]}`);

  /** Light stemmer: enough to make "relocating"/"relocate", "sponsors"/"sponsor" meet. */
  const stem = (w) => (w.length > 5 ? w.replace(/(ations?|ings?|ed|es|s)$/, '') : w.length > 3 ? w.replace(/s$/, '') : w);
  const conceptOf = (w) => CONCEPT_OF.get(w) ?? CONCEPT_OF.get(stem(w)) ?? stem(w);

  const contentTokens = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w)).map(conceptOf));

  /** 0..1 — Jaccard over concepts, with partial credit when one question contains the other. */
  function similarity(a, b) {
    const A = contentTokens(a), B = contentTokens(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    const jaccard = inter / (A.size + B.size - inter);
    // "Will you require sponsorship?" ⊂ "Will you now or in the future require visa sponsorship?"
    const containment = Math.min(A.size, B.size) >= 3 ? inter / Math.min(A.size, B.size) : 0;
    return Math.max(jaccard, containment * 0.85);
  }

  // ---- Job context: which answer fits THIS application? ---------------------
  // Answers like salary, notice period or relocation differ between a senior
  // and a junior role, a remote and an on-site job, or another country. Each
  // learned answer remembers the context it was given in; matching prefers the
  // variant whose context fits the current job.

  let cachedJobCtx = null;
  function jobContext() {
    if (cachedJobCtx) return cachedJobCtx;
    const info = (() => { try { return getPageInfo(); } catch { return {}; } })();
    const title = String(info.title ?? '').toLowerCase();
    const ld = jobPostingLd();
    const head = `${title} ${(document.body?.innerText ?? '').slice(0, 4000)}`.toLowerCase();
    const seniority =
      /\b(intern|internship|co-?op|apprentice)\b/.test(title) ? 'intern' :
      /\b(junior|jr\.?|entry[- ]level|graduate|associate)\b/.test(title) ? 'junior' :
      /\b(principal|staff|distinguished|architect)\b/.test(title) ? 'staff' :
      /\b(head of|director|vp|vice president|chief|manager|lead)\b/.test(title) ? 'lead' :
      /\b(senior|sr\.?|iii|iv)\b/.test(title) ? 'senior' : 'mid';
    const remote = ld?.jobLocationType === 'TELECOMMUTE' || /\b(fully remote|remote[- ]first|100% remote|remote \(|\(remote|remote - |- remote|remote,|work from home)\b/.test(head)
      ? 'remote' : /\bhybrid\b/.test(head) ? 'hybrid' : 'onsite';
    const country = String(
      [ld?.jobLocation].flat().find((l) => l?.address?.addressCountry)?.address?.addressCountry?.name ??
      [ld?.jobLocation].flat().find((l) => l?.address?.addressCountry)?.address?.addressCountry ?? '',
    ).toLowerCase();
    cachedJobCtx = { site: siteOf(location.hostname), seniority, remote, country };
    return cachedJobCtx;
  }

  /** schema.org JobPosting JSON-LD (Greenhouse, Lever, Workday, Ashby… publish it). */
  function jobPostingLd() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const items = [JSON.parse(s.textContent)].flat().flatMap((x) => x?.['@graph'] ?? [x]);
        const jp = items.find((x) => /JobPosting/i.test(String(x?.['@type'])));
        if (jp) return jp;
      } catch { /* malformed JSON-LD */ }
    }
    return null;
  }

  /** How well a learned answer's context fits this job (0 = unknown/neutral). */
  function contextFit(ctx) {
    if (!ctx) return 0;
    const now = jobContext();
    let fit = 0;
    if (ctx.site && ctx.site === now.site) fit += 0.12;          // same employer/ATS: what you used here last time
    if (ctx.seniority) fit += ctx.seniority === now.seniority ? 0.06 : -0.03;
    if (ctx.remote) fit += ctx.remote === now.remote ? 0.04 : -0.02;
    if (ctx.country && now.country) fit += ctx.country === now.country ? 0.06 : -0.04;
    return fit;
  }

  let cachedCompany = null;
  function currentCompany() {
    if (cachedCompany === null) {
      try { cachedCompany = getPageInfo().company || ''; } catch { cachedCompany = ''; }
    }
    return cachedCompany;
  }

  /** Replace the employer's name with {company} so text transfers between applications. */
  function templatize(text) {
    const c = currentCompany();
    if (!text || !c || c.length < 3) return text;
    return text.replace(new RegExp(`\\b${escapeRx(c)}\\b`, 'gi'), '{company}');
  }
  const fillTemplate = (text) => String(text ?? '').replace(/\{company\}/gi, currentCompany() || 'your company');
  const questionKey = (question) => norm(templatize(question));

  /** Match a custom/learned answer against the field's question text. */
  function matchCustomAnswer(sig) {
    const question = sig.rawLabel || sig.aria || sig.placeholder;
    if (!question) return null;
    const nq = norm(question);
    const key = questionKey(question);
    let best = null, bestScore = 0, bestSim = 0;
    for (const ca of state.profile.customAnswers ?? []) {
      if (!ca?.question || ca.answer == null || ca.answer === '') continue;
      try {
        if (ca.source === 'learned') {
          const caKey = ca.key || norm(ca.question);
          const sim = caKey === key ? 1 : similarity(caKey, key);
          if (sim < CONFIG.LEARNED_MIN_SIMILARITY) continue;
          // Among variants of the same question, the one given in the most
          // similar context wins (same site > same seniority/remote/country).
          const score = sim + contextFit(ca.ctx);
          if (score > bestScore) { best = ca; bestScore = score; bestSim = sim; }
        } else if (ca.isRegex ? new RegExp(ca.question, 'i').test(question) : nq.includes(norm(ca.question))) {
          return { ...ca, answer: fillTemplate(ca.answer), sim: 1 }; // explicit phrases win immediately
        }
      } catch { /* invalid user regex: ignore */ }
    }
    return best ? { ...best, answer: fillTemplate(best.answer), sim: bestSim } : null;
  }

  /** Returns { def, score } | { custom } | null */
  function classify(sig) {
    const custom = matchCustomAnswer(sig);
    if (custom) return { custom, score: Infinity };

    let best = null;
    for (const def of FIELD_DEFS) {
      const score = scoreDef(def, sig);
      if (score >= CONFIG.MIN_SCORE && (!best || score > best.score)) best = { def, score };
    }
    return best;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 5. Scanning
  // ═════════════════════════════════════════════════════════════════════════

  function getKind(el) {
    if (el.tagName === 'SELECT') return 'select';
    if (el.tagName === 'TEXTAREA') return 'textarea';
    if (el.tagName === 'BUTTON' || (el.getAttribute('role') === 'combobox' && el.tagName !== 'INPUT')) return 'listbox';
    if (el.tagName !== 'INPUT') return null;
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (t === 'radio') return 'radio';
    if (t === 'checkbox') return 'checkbox';
    if (t === 'file') return 'file';
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list' ||
        el.closest('[class*="select__control"], [class*="Select-control"]')) return 'combobox';
    if (['text', 'email', 'tel', 'url', 'number', 'search', 'date', 'month', 'week', ''].includes(t)) return 'text';
    return null;
  }

  /**
   * Collects logical fields in document order. Radios and multi-checkbox
   * groups are collapsed into one field whose `el` is the first member.
   * Elements already handled (per registry) are skipped.
   */
  function scanFields() {
    const fields = [];
    const seenGroups = new Set();

    for (const el of queryAllDeep(FIELD_SELECTOR)) {
      if (el.closest('[data-hasanify-ignore]')) continue;
      forgetIfReused(el);
      const prior = state.registry.get(el);
      if (prior && (prior.status !== 'failed' || prior.retries >= CONFIG.MAX_RETRIES)) continue;

      let kind = getKind(el);
      if (!kind || !isFillable(el)) continue;

      const field = { el, kind };
      if (kind === 'radio' || kind === 'checkbox') {
        const container = getGroupContainer(el);
        const members = getGroupMembers(el, container);
        if (kind === 'checkbox' && members.length > 1) field.kind = 'checkbox-group';
        if (field.kind !== 'checkbox') {
          const groupKey = members[0];
          if (seenGroups.has(groupKey)) continue;
          seenGroups.add(groupKey);
          field.el = members[0];
          forgetIfReused(field.el);
          if (state.registry.has(field.el) && state.registry.get(field.el).status !== 'failed') continue;
        }
        field.container = container;
        field.members = members;
      }
      fields.push(field);
    }
    return fields;
  }

  /**
   * What makes a control "the same question". SPA wizards built with React or
   * Vue often REUSE the DOM nodes of step 1 for step 2 (same position, same
   * tag) and only swap name/id/labels. Without this check those nodes look
   * "already done" and the next step is silently skipped.
   */
  function identityOf(el) {
    return [el.name, el.id, el.type, el.getAttribute('aria-label'), el.getAttribute('aria-labelledby'),
      el.getAttribute('placeholder'), el.getAttribute('data-automation-id'), el.getAttribute('data-qa')].join('|');
  }

  function forgetIfReused(el) {
    const prior = state.registry.get(el);
    if (prior?.ident != null && prior.ident !== identityOf(el)) state.registry.delete(el);
  }

  /**
   * Which entry of profile.education/experience does this field refer to?
   *   1. explicit ordinal from the section ("Work Experience 2")
   *   2. otherwise, count same-key fields that precede it in the document
   */
  function computeIndex(el, regKey, sectionIndex) {
    if (sectionIndex != null) return sectionIndex;
    let i = 0;
    for (const [other, info] of state.registry) {
      if (other === el || info.regKey !== regKey || !other.isConnected) continue;
      if (other.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) i++;
    }
    return i;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 6. Value resolution → "desired" spec
  // ═════════════════════════════════════════════════════════════════════════
  //
  // desired = { type: 'text', candidates: string[] }
  //         | { type: 'bool', value: boolean }
  //         | { type: 'file', file: {fileName, mimeType, dataUrl} }

  const DECLINE_CANDIDATES = [
    'decline to self identify', 'i dont wish to answer', 'i do not wish to answer', 'prefer not to say',
    'prefer not to answer', 'prefer not to disclose', 'decline to answer', 'choose not to disclose',
    'i choose not to', 'not specified', 'decline',
  ];

  const VALUE_SYNONYMS = [
    [/decline|prefer not|not wish|dont wish|choose not/, DECLINE_CANDIDATES],
    [/^(male|man)$/, ['male', 'man']],
    [/^(female|woman)$/, ['female', 'woman']],
    [/^(non binary|nonbinary)$/, ['non binary', 'nonbinary', 'genderqueer']],
    [/^(united states( of america)?|usa?)$/, ['united states', 'united states of america', 'usa', 'us']],
    [/^(united kingdom|uk|great britain)$/, ['united kingdom', 'uk', 'great britain']],
    [/^(mobile|cell)$/, ['mobile', 'cell', 'cell phone', 'mobile phone']],
    [/^(linked ?in)$/, ['linkedin', 'linked in', 'job board', 'social media']],
  ];

  function toDesired(raw, def) {
    if (raw && typeof raw === 'object' && 'dataUrl' in raw) return { type: 'file', file: raw };
    if (typeof raw === 'boolean') return { type: 'bool', value: raw };
    if (def?.bool && typeof raw === 'string') {
      if (/^(yes|y|true)$/i.test(raw)) return { type: 'bool', value: true };
      if (/^(no|n|false)$/i.test(raw)) return { type: 'bool', value: false };
    }
    // A definition may return several phrasings, most specific first.
    const list = Array.isArray(raw) ? raw.map(String).filter(Boolean) : [String(raw)];
    const s = list[0];
    const n = norm(s);
    const candidates = [...list];
    for (const [rx, syns] of VALUE_SYNONYMS) if (rx.test(n)) candidates.push(...syns);
    if (/degree|education/.test(def?.key ?? '')) {
      for (const [rx, syns] of DEGREE_SYNONYMS) if (rx.test(n)) candidates.push(...syns);
    }
    const desired = { type: 'text', candidates: [...new Set(candidates)] };
    // Numbers ("4" years) can be matched against ranges: "3-5 years", "5+", "Less than 2".
    if (/^\d+(\.\d+)?$/.test(s.trim())) desired.number = parseFloat(s);
    return desired;
  }

  /** Degree equivalents: profile says "B.S. Computer Science", the dropdown says "Bachelor's Degree". */
  const DEGREE_SYNONYMS = [
    [/\b(bachelor|bachelors|b s|bs|bsc|b sc|ba|b a|be|b e|btech|b tech|beng|undergraduate)\b/,
      ["bachelor's degree", 'bachelors degree', 'bachelor', "bachelor's", 'bachelor of science', 'bachelor of arts', 'undergraduate degree', '4 year degree', 'four year degree']],
    [/\b(master|masters|m s|ms|msc|m sc|ma|m a|mba|mtech|m tech|meng|m eng)\b/,
      ["master's degree", 'masters degree', 'master', "master's", 'graduate degree', 'mba']],
    [/\b(phd|ph d|doctor|doctorate|doctoral|dphil)\b/, ['phd', 'ph d', 'doctorate', 'doctoral degree', 'doctor of philosophy']],
    [/\bassociate/, ["associate's degree", 'associate degree', 'associates', '2 year degree', 'two year degree']],
    [/high school|\bged\b|secondary|a levels?|matric|intermediate|hssc/, ['high school diploma', 'high school', 'ged', 'secondary school']],
  ];

  /**
   * How well an option like "3-5 years" / "5+" / "Less than 2 years" / "None"
   * fits a number. 0 = doesn't fit.
   */
  function rangeOptionScore(optText, n) {
    // Own normalization: norm() would strip the "+", "-" and "<" that carry the meaning.
    const t = String(optText ?? '').toLowerCase().replace(/[–—]/g, '-').replace(/\byrs?\b/g, 'years')
      .replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.!]$/, '');
    if (!/\d|none|no experience/.test(t)) return 0;
    if (/^(none|no experience|no)$/.test(t) || /\bno (prior |professional )?experience\b/.test(t)) return n === 0 ? 92 : 0;
    let m;
    if ((m = /(\d+(?:\.\d+)?) ?(?:-|to|and) ?(\d+(?:\.\d+)?)/.exec(t))) {
      const a = +m[1], b = +m[2];
      if (n >= a && n <= b) return n === b ? 86 : 92; // "3-5" vs 5 also fits "5+" — prefer the other
      if (n > b && n < b + 1) return 80;              // 5.5 → "3-5"
      return 0;
    }
    if ((m = /(\d+(?:\.\d+)?) ?(?:\+|or more|plus|and (?:above|over|more|up))|(?:more than|over|at least|minimum|min|above|greater than) (\d+(?:\.\d+)?)/.exec(t))) {
      const a = +(m[1] ?? m[2]);
      const strict = /more than|over|above|greater than/.test(t);
      return (strict ? n > a : n >= a) ? 90 : 0;
    }
    if ((m = /(?:less than|under|fewer than|below|up to|max(?:imum)?|<) ?(\d+(?:\.\d+)?)/.exec(t))) {
      const a = +m[1];
      const inclusive = /up to|max/.test(t);
      return (inclusive ? n <= a : n < a) ? 90 : 0;
    }
    if ((m = /^(\d+(?:\.\d+)?)(?: years?)?$/.exec(t))) return +m[1] === n ? 96 : 0;
    return 0;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function parseDate(raw) {
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(raw ?? '').trim());
    return m ? { y: +m[1], m: +m[2], d: m[3] ? +m[3] : 1 } : null;
  }

  /**
   * Format a YYYY-MM(-DD) profile date for this particular control:
   *   <input type=date|month>, split month/year selects (Workday),
   *   or a text box whose placeholder tells us the expected mask.
   */
  function formatDate(field, sig, raw) {
    const d = parseDate(raw);
    if (!d) return null;
    const { el, kind } = field;
    const mm = pad2(d.m), dd = pad2(d.d), yyyy = String(d.y);
    const monthName = MONTHS[d.m - 1];

    if (el.type === 'date') return { type: 'text', candidates: [`${yyyy}-${mm}-${dd}`] };
    if (el.type === 'month') return { type: 'text', candidates: [`${yyyy}-${mm}`] };

    const hint = `${sig.label} ${sig.aria} ${sig.placeholder} ${sig.attrs}`;
    const mentionsMonth = /\bmonth\b|\bmm\b/.test(hint);
    const mentionsYear = /\byear\b|\byyyy\b|\byy\b/.test(hint);

    if (mentionsYear && !mentionsMonth) return { type: 'text', candidates: [yyyy] };
    if (mentionsMonth && !mentionsYear) {
      return kind === 'text'
        ? { type: 'text', candidates: [mm] }
        : { type: 'text', candidates: [monthName, monthName.slice(0, 3), mm, String(d.m)] };
    }

    // Use the placeholder as a template when it looks like a date mask.
    const ph = (el.getAttribute('placeholder') ?? '').toUpperCase();
    if (/YYYY|MM|DD/.test(ph)) {
      const out = ph.replace(/YYYY/g, yyyy).replace(/YY/g, yyyy.slice(2)).replace(/MM/g, mm).replace(/DD/g, dd);
      return { type: 'text', candidates: [out] };
    }
    return { type: 'text', candidates: [`${mm}/${yyyy}`, `${monthName} ${yyyy}`] };
  }

  // ---- Option matching ---------------------------------------------------

  const NEGATION = /\b(no|not|dont|do not|never|none|false|cannot|cant|wont|will not)\b/;
  const AFFIRM = /\b(i am|i do|i will|i have|i can|authori[sz]ed|eligible|i require|require)\b/;

  /** How well option text answers a yes/no question. */
  function boolOptionScore(optText, want) {
    const t = norm(optText);
    if (!t) return 0;
    const isYes = /^(yes|y|true)\b/.test(t);
    const isNo = /^(no|n|false)\b/.test(t);
    if (want) {
      if (isYes) return 100;
      if (isNo || NEGATION.test(t)) return 0;
      return AFFIRM.test(t) ? 65 : 0;
    }
    if (isNo) return 100;
    if (isYes) return 0;
    return NEGATION.test(t) ? 65 : 0;
  }

  /** How well option text matches one desired string (both normalized). */
  function textOptionScore(optText, desired) {
    const o = norm(optText), d = norm(desired);
    if (!o || !d) return 0;
    if (o === d) return 100;
    const dRx = new RegExp(`\\b${escapeRx(d)}\\b`);
    if (dRx.test(o)) return o.startsWith(d) ? 85 : 72;
    if (o.length >= 3 && new RegExp(`\\b${escapeRx(o)}\\b`).test(d)) return 62;
    // Token overlap as a last resort ("Bachelor of Science" vs "Bachelor's Degree").
    const dt = new Set(d.split(' ').filter((w) => w.length > 2));
    const ot = o.split(' ').filter((w) => w.length > 2);
    if (!dt.size || !ot.length) return 0;
    const overlap = ot.filter((w) => dt.has(w)).length;
    return Math.round((overlap / Math.max(dt.size, ot.length)) * 58);
  }

  const PLACEHOLDER_OPTION = /^(select|choose|please select|pick|none selected|\s*-+\s*)/i;

  /** options: [{ text, value, el }] → best option or null */
  function pickOption(options, desired) {
    let best = null;
    for (const opt of options) {
      if (PLACEHOLDER_OPTION.test(opt.text ?? '') && !opt.value) continue;
      let score = 0;
      if (desired.type === 'bool') {
        score = Math.max(boolOptionScore(opt.text, desired.value), boolOptionScore(opt.value, desired.value));
      } else {
        if (desired.number != null && /\d|none|no experience/i.test(opt.text ?? '')) {
          // Numeric options are judged as ranges only ("Less than 5" must not match 5 by text).
          score = rangeOptionScore(opt.text, desired.number);
        } else {
          desired.candidates.forEach((c, i) => {
            const penalty = i === 0 ? 0 : 3; // prefer the literal profile value over synonyms
            score = Math.max(score, textOptionScore(opt.text, c) - penalty, textOptionScore(opt.value, c) - penalty - 5);
          });
        }
      }
      if (score >= CONFIG.MIN_OPTION_SCORE && (!best || score > best.score)) best = { ...opt, score };
    }
    if (best) state.pickScores.push(best.score); // → confidence of this fill (see processField)
    return best;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 7. Injection + event dispatch
  // ═════════════════════════════════════════════════════════════════════════

  /** Native value setter from the right prototype (bypasses framework overrides). */
  function nativeSetValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
      el instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
      HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function nativeSetChecked(el, checked) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set.call(el, checked);
  }

  /**
   * Focus in a way frameworks notice. If the page's window is not focused
   * (e.g. our popup is open), the browser defers real focus events, so we
   * synthesize them.
   */
  function focusElement(el) {
    el.focus({ preventScroll: true });
    if (!document.hasFocus()) {
      el.dispatchEvent(new FocusEvent('focus', { bubbles: false }));
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    }
  }

  function blurElement(el) {
    const hadRealFocus = document.activeElement === el && document.hasFocus();
    el.blur();
    if (!hadRealFocus) {
      // Angular "touched", Workday validation and Formik onBlur all hang off these.
      el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    }
  }

  /**
   * The canonical "user typed this" sequence:
   *   focus → (keydown) → native set → input → (keyup) → change → blur
   *
   *  • `input` (InputEvent, bubbles, composed) drives React's onChange,
   *    Vue's v-model and Angular's DefaultValueAccessor.
   *  • `change` drives Angular `(change)`, jQuery handlers, and v-model.lazy.
   *  • `blur`/`focusout` commits values in Workday and marks Angular controls
   *    as touched so validators run.
   *  • keydown/keyup with a neutral key wake up listeners that validate on key
   *    events without triggering shortcuts.
   */
  function setValueAndNotify(el, value) {
    focusElement(el);
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, key: 'Unidentified' }));
    nativeSetValue(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true, key: 'Unidentified' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    blurElement(el);
  }

  /** Full pointer + mouse + click sequence, as produced by a real click. */
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click(); // produces a trusted-shaped click and toggles native inputs
  }

  function pressKey(el, key) {
    for (const type of ['keydown', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, key, code: key }));
    }
  }

  // ---- Per-kind fillers. Each returns a status string. ---------------------

  function fillText(field, desired) {
    const { el } = field;
    let v = desired.type === 'bool' ? (desired.value ? 'Yes' : 'No') : String(desired.candidates[0]);
    if (el.type === 'number') v = v.replace(/[^\d.-]/g, '');
    if (el.type === 'url' && v && !/^https?:\/\//i.test(v)) v = `https://${v}`;
    if (el.maxLength > 0 && v.length > el.maxLength) v = v.slice(0, el.maxLength);
    if (!v) return 'no-value';

    setValueAndNotify(el, v);
    // Masked inputs (phone) may reformat — accept if the digits survived.
    const digits = (s) => s.replace(/\D/g, '');
    return el.value === v || (digits(v) && digits(el.value) === digits(v)) || el.value ? 'filled' : 'failed';
  }

  function fillSelect(field, desired) {
    const { el } = field;
    const options = [...el.options].filter((o) => !o.disabled).map((o) => ({ el: o, text: textOf(o), value: o.value }));
    const best = pickOption(options, desired);
    if (!best) return 'no-option';
    focusElement(el);
    nativeSetValue(el, best.value);
    best.el.selected = true; // belt and braces for duplicate option values
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    blurElement(el);
    return el.selectedIndex === best.el.index ? 'filled' : 'failed';
  }

  /** Click the visible surrogate for a (possibly hidden) radio/checkbox. */
  function toggleInput(input, wantChecked) {
    if (input.checked === wantChecked) return true;
    const target = isVisible(input) ? input : ([...(input.labels ?? [])].find(isVisible) ?? input);
    realClick(target);
    if (input.checked !== wantChecked) {
      // Fallback for widgets that swallow clicks: set + notify manually.
      nativeSetChecked(input, wantChecked);
      input.dispatchEvent(new Event('click', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return input.checked === wantChecked;
  }

  function fillRadio(field, desired) {
    const options = field.members.map((r) => ({ el: r, text: getOptionLabel(r), value: r.value }));
    const best = pickOption(options, desired);
    if (!best) return 'no-option';
    return toggleInput(best.el, true) ? 'filled' : 'failed';
  }

  function fillCheckbox(field, desired) {
    // Single checkbox answers a yes/no question ("I currently work here", "Are you 18+").
    const want = desired.type === 'bool' ? desired.value : boolOptionScore(desired.candidates[0], true) > 0;
    if (!want) return 'filled'; // leave unchecked
    return toggleInput(field.el, true) ? 'filled' : 'failed';
  }

  function fillCheckboxGroup(field, desired) {
    // "Select all that apply": a comma list ("English (Fluent), Urdu") ticks one
    // option per item; proficiency notes in parentheses are ignored for matching.
    const options = field.members.map((c) => ({ el: c, text: getOptionLabel(c), value: c.value }));
    const items = desired.type === 'bool'
      ? [desired]
      : String(desired.candidates[0]).split(/\s*[,;]\s*/).map((x) => x.replace(/\(.*?\)/g, '').trim()).filter(Boolean)
          .map((x) => toDesired(x));
    let ticked = 0;
    for (const item of items) {
      const best = pickOption(options, item);
      if (best && toggleInput(best.el, true)) ticked++;
    }
    return ticked ? 'filled' : 'no-option';
  }

  /**
   * Plain text input backed by a suggestion list (Lever location). Type a short
   * query, click the best suggestion; if none appears, keep the typed text.
   */
  async function fillSuggestText(field, desired) {
    const { el } = field;
    for (const query of searchQueries(desired)) {
      focusElement(el);
      nativeSetValue(el, '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
      // Type character by character: suggestion widgets usually debounce keyup/input.
      for (const ch of query) {
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ch }));
        nativeSetValue(el, el.value + ch);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ch }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ch }));
        await sleep(15);
      }
      const opt = await waitFor(() => pickOption(getVisibleOptions(el), desired), 3000);
      if (opt) {
        realClick(opt.el);
        await sleep(150);
        blurElement(el);
        return 'filled';
      }
    }
    // No suggestions appeared. Some widgets (Lever) only search on trusted
    // keystrokes and wipe free text on blur, so type the full value and check
    // it survived; otherwise report it so the widget asks the user.
    const status = fillText(field, desired);
    await sleep(700);
    return status === 'filled' && el.value.trim() ? 'filled' : 'no-option';
  }

  function dataUrlToFile({ dataUrl, fileName, mimeType }) {
    const [, meta = '', b64 = ''] = /^data:([^,]*),(.*)$/s.exec(dataUrl) ?? [];
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], fileName || 'resume.pdf', { type: mimeType || meta.split(';')[0] || 'application/pdf' });
  }

  function fillFile(field, desired) {
    if (field.el.files?.length) return 'skipped-user';
    attachFileToInput(field.el, dataUrlToFile(desired.file));
    return 'filled';
  }

  /** Put a File into an <input type=file> the way a user's file picker would. */
  function attachFileToInput(el, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // Some uploaders (react-dropzone variants) only listen for drop on a wrapper.
    if (!el.files?.length) {
      const zone = el.closest('[class*="drop"], [data-testid*="drop"], [class*="upload"]') ?? el.parentElement;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        zone?.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    }
  }

  // ---- Upload tracking (resume / cover letter) ------------------------------
  // Upload fields are listed in the widget so tailored files can be attached
  // per application, or so "manual" users see what still needs a file.

  let uploadSeq = 0;

  function trackUpload(field, sig, kind) {
    if (state.uploads.has(field.el)) return state.uploads.get(field.el);
    const el = field.el;
    const isFile = field.kind === 'file';
    const raw = (sig.rawLabel || '').replace(/\s*[*✱]\s*$/, '').trim();
    const entry = {
      id: ++uploadSeq,
      kind,                        // 'resume' | 'coverLetter' | 'other'
      isFile,
      label: kind === 'resume' ? 'Resume / CV' : kind === 'coverLetter' ? (isFile ? 'Cover letter' : 'Cover letter (text box)') : (raw.slice(0, 40) || 'File upload'),
      el,
      required: isRequired(field, sig.rawLabel),
      done: isFile ? el.files?.length > 0 : !!el.value?.trim(),
      fileName: isFile ? el.files?.[0]?.name ?? '' : '',
    };
    // Catches our own attachments AND the user using the page's upload button.
    el.addEventListener(isFile ? 'change' : 'input', () => {
      const f = isFile ? el.files?.[0] : null;
      entry.done = isFile ? !!f : !!el.value.trim();
      if (f) entry.fileName = f.name;
      emit('uploads-changed', {});
    });
    state.uploads.set(el, entry);
    return entry;
  }

  /** Attach a user-chosen File, or the saved resume ('saved'), to a tracked upload. */
  function attachToUpload(id, file) {
    const entry = [...state.uploads.values()].find((u) => u.id === id);
    if (!entry?.isFile || !entry.el.isConnected) return false;
    if (file === 'saved') {
      const saved = state.profile?.documents?.resume;
      if (!saved?.dataUrl) return false;
      file = dataUrlToFile(saved);
    }
    attachFileToInput(entry.el, file);
    entry.done = true;
    entry.fileName = file.name;
    emit('uploads-changed', {});
    return true;
  }

  function getUploads() {
    return [...state.uploads.values()]
      .filter((u) => u.el.isConnected || u.done)
      .map((u) => ({ ...u, done: u.isFile ? u.done : !!u.el.value?.trim() || u.done }));
  }

  /** Visible options belonging to the dropdown opened by `anchor`. */
  function getVisibleOptions(anchor) {
    const ids = [anchor.getAttribute('aria-controls'), anchor.getAttribute('aria-owns')]
      .filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
    const roots = ids.map((id) => byId(anchor, id)).filter(Boolean);
    // Most libraries portal the menu to <body>, so fall back to the document.
    const scopes = roots.length ? roots : [document];
    const out = [];
    for (const scope of scopes) {
      for (const o of scope.querySelectorAll(OPTION_SELECTOR)) {
        if (o.getAttribute('aria-disabled') === 'true' || !isVisible(o)) continue;
        out.push({ el: o, text: o.getAttribute('data-automation-label') || textOf(o), value: o.getAttribute('data-value') ?? '' });
      }
    }
    return out;
  }

  /**
   * Search-as-you-type queries. Location autocompletes often find nothing for
   * "Austin, TX, United States" but plenty for "Austin", so `suggest` fields
   * try shorter phrasings first.
   */
  function searchQueries(desired) {
    if (desired.type === 'bool') return [desired.value ? 'Yes' : 'No'];
    const first = String(desired.candidates[0]);
    if (desired.suggest) {
      const short = desired.candidates.slice(1).map(String);
      return [...new Set([...short.reverse(), first.split(',')[0].trim()])].slice(0, 2);
    }
    return [...new Set([first, first.split(',')[0].trim(), ''])];
  }

  /** react-select / Workday searchable prompt / Greenhouse location autocomplete. */
  async function fillCombobox(field, desired) {
    const { el } = field;
    for (const query of searchQueries(desired)) {
      focusElement(el);
      realClick(el); // opens the menu in most libraries
      nativeSetValue(el, query);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: query }));
      if (!query) pressKey(el, 'ArrowDown'); // empty query: just open the full list

      const opt = await waitFor(() => pickOption(getVisibleOptions(el), desired));
      if (opt) {
        realClick(opt.el);
        await sleep(50);
        blurElement(el);
        return 'filled';
      }
    }
    // Clean up our search text and close the menu.
    nativeSetValue(el, '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    pressKey(el, 'Escape');
    blurElement(el);
    return 'no-option';
  }

  /** Workday "Select One" button / div[role=combobox]: click to open, click option. */
  async function fillListbox(field, desired) {
    const { el } = field;
    realClick(el);
    const opt = await waitFor(() => pickOption(getVisibleOptions(el), desired));
    if (!opt) {
      pressKey(el, 'Escape');
      return 'no-option';
    }
    realClick(opt.el);
    await sleep(50);
    return 'filled';
  }

  /** Does the field already hold something the user (or the ATS prefill) put there? */
  function hasExistingValue(field) {
    const { el, kind } = field;
    switch (kind) {
      case 'text':
      case 'textarea':
        return el.value.trim() !== '';
      case 'select': {
        const opt = el.options[el.selectedIndex];
        return !!opt && el.selectedIndex > 0 && !PLACEHOLDER_OPTION.test(textOf(opt)) && opt.value !== '';
      }
      case 'radio':
      case 'checkbox-group':
        return field.members.some((m) => m.checked);
      case 'checkbox':
        return el.checked;
      case 'file':
        return el.files?.length > 0;
      case 'combobox': {
        // The chosen value is rendered next to the (now empty) search input.
        // Walk up a few levels, but never into a wrapper holding another combobox.
        let node = el;
        for (let i = 0; i < 5 && (node = node.parentElement); i++) {
          if (node.querySelectorAll('[role="combobox"]').length > 1) break;
          const shown = node.querySelector('[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [data-automation-id="selectedItem"]');
          if (shown && textOf(shown)) return true;
        }
        return el.value.trim() !== '';
      }
      case 'listbox': {
        const t = textOf(el);
        return !!t && !PLACEHOLDER_OPTION.test(t);
      }
      default:
        return false;
    }
  }

  const FILLERS = {
    text: fillText, textarea: fillText, select: fillSelect,
    radio: fillRadio, checkbox: fillCheckbox, 'checkbox-group': fillCheckboxGroup,
    file: fillFile, combobox: fillCombobox, listbox: fillListbox,
  };

  // ---- Visual feedback -----------------------------------------------------

  function ensureStyles() {
    if (document.getElementById('hasanify-style')) return;
    const style = document.createElement('style');
    style.id = 'hasanify-style';
    style.textContent = `
      [data-hasanify="filled"] { box-shadow: 0 0 0 2px rgba(22,163,74,.55) !important; transition: box-shadow .2s; }
      [data-hasanify="no-option"], [data-hasanify="failed"] { box-shadow: 0 0 0 2px rgba(234,179,8,.6) !important; }
      [data-hasanify="review"] { box-shadow: 0 0 0 2px rgba(245,158,11,.9), 0 0 0 5px rgba(245,158,11,.18) !important; background-color: rgba(254,243,199,.35) !important; }
      @keyframes hasanify-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(91,91,247,0) } 40% { box-shadow: 0 0 0 6px rgba(91,91,247,.35) } }
      .hasanify-pulse { animation: hasanify-pulse .9s ease-in-out 2 !important; border-radius: 6px; }
    `;
    (document.head ?? document.documentElement).appendChild(style);
  }

  function mark(field, status) {
    if (!state.settings?.highlightFields) return;
    const target = field.kind === 'radio' || field.kind === 'checkbox-group' ? field.container ?? field.el : field.el;
    if (target && !target.closest('[aria-hidden="true"]')) target.setAttribute('data-hasanify', status);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 8. Orchestration
  // ═════════════════════════════════════════════════════════════════════════

  async function loadContext() {
    const res = await chrome.runtime.sendMessage({ type: 'hasanify:getContext', site: siteOf(location.hostname) });
    if (!res?.ok) throw new Error(res?.error ?? 'Failed to load profile');
    state.profile = mergeWithDefaults(DEFAULT_PROFILE, res.profile);
    state.settings = mergeWithDefaults(DEFAULT_SETTINGS, res.settings);
    state.companies = res.companies ?? [];
    state.siteNote = res.siteNote ?? null;
  }

  /** Classify + fill one logical field. Returns its final status. */
  async function processField(field) {
    const sig = collectSignals(field);
    const match = classify(sig);
    const defKey = match?.def?.key ?? '';
    const uploadKind = defKey === 'documents.resume' ? 'resume' : defKey.startsWith('documents.coverLetter') ? 'coverLetter' : null;
    // Every file input (and cover-letter text box) is listed in the widget's Attachments card.
    if (field.kind === 'file' || uploadKind === 'coverLetter') trackUpload(field, sig, uploadKind ?? 'other');
    if (!match) return { status: field.kind === 'file' ? 'manual' : 'unmatched', sig };

    const key = match.custom ? `custom:${match.custom.question}` : match.def.key;

    // Tailored-application modes: leave these for the user (widget offers saved / choose file).
    if (uploadKind === 'resume' && state.settings.resumeMode !== 'auto') return { status: 'manual', key, sig };
    if (uploadKind === 'coverLetter' && (state.settings.coverLetterMode === 'manual' || field.kind === 'file')) {
      return { status: 'manual', key, sig };
    }
    // Month and year inputs of the same date share a key; keep them apart for counting.
    const part = /\bmonth\b/.test(sig.label + sig.attrs) ? ':m' : /\byear\b/.test(sig.label + sig.attrs) ? ':y' : '';
    const regKey = key + part;
    state.registry.set(field.el, { ...(state.registry.get(field.el) ?? { retries: 0 }), regKey, key, status: 'pending' });

    const index = computeIndex(field.el, regKey, sig.sectionIndex);
    let raw = match.custom ? match.custom.answer : match.def.value(state.profile, { index, signals: sig });
    if (Array.isArray(raw)) raw = raw.filter((x) => x != null && x !== '');
    if (raw == null || raw === '' || (Array.isArray(raw) && !raw.length)) return { status: 'no-value', key, sig };

    if (!state.settings.overwriteExisting && hasExistingValue(field)) return { status: 'skipped-user', key, sig };

    const desired = match.def?.date ? formatDate(field, sig, raw) : toDesired(raw, match.def);
    if (!desired) return { status: 'no-value', key, sig };
    if (desired.type === 'file' && field.kind !== 'file') return { status: 'no-value', key, sig };
    if (match.def?.suggest) desired.suggest = true;

    const filler = match.def?.suggest && field.kind === 'text' ? fillSuggestText : FILLERS[field.kind];
    let status;
    state.pickScores = [];
    try {
      status = await filler(field, desired);
    } catch (err) {
      log('fill error', key, err);
      status = 'failed';
    }
    log(status, key, { index, score: match.score, label: sig.rawLabel, el: field.el });
    return { status, key, sig, review: status === 'filled' ? reviewReason(match, field) : null };
  }

  /**
   * Confidence: null when Hasanify is sure, otherwise a short reason why the
   * user should glance at the field ("check this" highlight + widget list).
   */
  function reviewReason(match, field) {
    const worstOption = state.pickScores.length ? Math.min(...state.pickScores) : 100;
    if (match.custom) {
      if (match.custom.source === 'learned' && match.custom.sim < 0.9) return 'Answer from a similar question';
    } else {
      if (match.def.review) return field.kind === 'text' ? 'Calculated from your profile' : 'Picked from your profile — check the range';
      if (match.score < 3) return 'Guessed from the page layout'; // only nearby text matched, no label
    }
    if (worstOption < CONFIG.REVIEW_OPTION_SCORE) return 'Closest matching option';
    return null;
  }

  /**
   * One pass over the page. Safe to call repeatedly: processed elements are
   * remembered, and only new (or previously failed) fields are attempted.
   */
  async function runAutofill({ force = false } = {}) {
    if (state.filling) {
      state.pendingRun = true;
      return state.lastStats;
    }
    state.filling = true;
    try {
      if (!state.profile || force) await loadContext();
      ensureStyles();
      pruneRegistry();

      if (force) {
        // A manual fill retries everything that did not succeed earlier.
        for (const [el, info] of state.registry) if (info.status !== 'filled') state.registry.delete(el);
      }

      const fields = scanFields();
      const stats = { filled: 0, matched: 0, total: fields.length, unmatched: [] };
      // Nothing new (typical for class/focus churn): stay silent — no progress UI, no report.
      if (!fields.length && !force) return state.lastStats ?? stats;
      emit('run-start', { total: fields.length });

      let done = 0;
      const results = [];
      for (const field of fields) {
        if (!field.el.isConnected) continue;
        const { status, key, sig, review } = await processField(field);
        const prev = state.registry.get(field.el) ?? { retries: 0 };
        state.registry.set(field.el, {
          ...prev, id: prev.id ?? ++regSeq, key, status, field, label: sig?.rawLabel ?? '', ident: identityOf(field.el),
          retries: prev.retries + (status === 'failed' ? 1 : 0),
          review: review ?? null, reviewed: false,
        });
        results.push({ field, sig, status });

        if (status !== 'unmatched') stats.matched++;
        else if (sig?.rawLabel) stats.unmatched.push(sig.rawLabel.slice(0, 120));
        if (status === 'filled') {
          stats.filled++;
          state.filledEver.add(field.el); // survives step changes, for the toolbar badge
        }
        if (status !== 'unmatched' && status !== 'no-value' && status !== 'skipped-user' && status !== 'manual') {
          mark(field, status === 'filled' && review ? 'review' : status);
        }

        emit('progress', { done: ++done, total: fields.length, status, label: sig?.rawLabel ?? '' });
        await sleep(CONFIG.BETWEEN_FIELDS_MS);
      }

      // Second chance with AI for what the rules couldn't resolve (opt-in).
      await aiPass(results, stats);

      // Report + learn: watch missed fields for the user's answer, filled ones for corrections.
      const missedItems = [];
      for (const { field, sig } of results) {
        const status = state.registry.get(field.el)?.status;
        if (MISSED.has(status) || status === 'filled') watchForLearning(field, sig, status);
        if (MISSED.has(status) && isLearnable(field, sig?.rawLabel)) {
          missedItems.push({
            key: questionKey(sig.rawLabel),
            question: templatize(cleanLabel(sig.rawLabel)),
            reason: REASONS[status],
            required: isRequired(field, sig.rawLabel),
          });
        }
      }

      state.lastStats = stats;
      recordMissed(missedItems);
      if (stats.filled) noteCompany();
      const summary = getSummary();
      emit('run-end', summary);
      if (fields.length) {
        // Report page-cumulative totals (multi-step forms run many passes), not this pass only.
        const report = { ...stats, filled: state.filledEver.size, matched: summary.matched, total: summary.seen };
        chrome.runtime.sendMessage({ type: 'hasanify:report', stats: report }).catch(() => {});
      }
      // Keep the tab's application session fresh (and remember this site),
      // so the next page — even on another domain — is followed too.
      if (stats.filled && state.armed) setArmed(true);
      return stats;
    } catch (err) {
      if (/Extension context invalidated/i.test(String(err))) teardown();
      else log('run failed', err);
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      state.filling = false;
      // Re-check at several delays: slow hydration can wipe values seconds later.
      state.verifyTimers.forEach(clearTimeout);
      state.verifyTimers = (state.siteNote?.slow ? [1500, 4000, 9000, 15000] : [1500, 4000, 9000]).map((ms) => setTimeout(verifyFilled, ms));
      if (state.pendingRun) {
        state.pendingRun = false;
        scheduleRun();
      }
    }
  }

  /**
   * React/Vue apps can wipe our values after the fact: hydration finishing
   * after document_idle (Greenhouse job-boards), or a step re-rendering from
   * its own state. Re-check everything we filled and retry what was reverted
   * (bounded by CONFIG.MAX_RETRIES per field).
   */
  function verifyFilled() {
    refreshBaselines(); // values have settled (masks, hydration): edits from here are the user's
    let reverted = 0;
    for (const [el, info] of state.registry) {
      if (info.status !== 'filled' || !info.field || !el.isConnected) continue;
      // Uploaders replace their input; single checkboxes may be left unticked on purpose.
      if (info.field.kind === 'file' || info.field.kind === 'checkbox') continue;
      if (!hasExistingValue(info.field)) {
        info.status = 'failed';
        info.retries = (info.retries ?? 0) + 1;
        reverted++;
      }
    }
    if (reverted) {
      log(`${reverted} field(s) were reset by the page; retrying`);
      // Site memory: next time on this site, wait longer before the first pass
      // and keep re-checking longer, so it fills fully on the first try.
      if (!state.siteNote?.slow) {
        state.siteNote = { ...state.siteNote, slow: true };
        chrome.runtime.sendMessage({ type: 'hasanify:siteNote', site: siteOf(location.hostname), note: { slow: true } }).catch(() => {});
      }
      scheduleRun();
    }
  }

  /** Resolve once the DOM has been quiet for `quietMs` (or after `maxMs`). */
  function waitForQuiet(quietMs = 800, maxMs = 6000) {
    return new Promise((resolve) => {
      let timer = setTimeout(done, quietMs);
      const cap = setTimeout(done, maxMs);
      const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quietMs); });
      mo.observe(document, { childList: true, subtree: true, attributes: true });
      function done() { mo.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(); }
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // AI assist (opt-in): questions and options the rules couldn't resolve
  // ═════════════════════════════════════════════════════════════════════════
  //
  // After the rule-based pass, unrecognized questions and dropdowns with no
  // matching option go to the background in ONE batch. The background asks the
  // user's own model (their API key never reaches the page) to answer strictly
  // from the profile; anything it can't ground comes back empty. Every AI fill
  // is flagged "check this" — it is never treated as certain.

  const AI_KINDS = new Set(['select', 'radio', 'checkbox-group', 'combobox', 'listbox', 'text']);

  async function aiPass(results, stats) {
    if (!state.settings?.aiAssist) return;
    const todo = results.filter(({ field, sig, status }) =>
      (status === 'unmatched' || status === 'no-option' || status === 'no-value') &&
      AI_KINDS.has(field.kind) && field.el.isConnected && isLearnable(field, sig?.rawLabel) && !hasExistingValue(field));
    if (!todo.length) return;

    emit('progress', { done: 0, total: todo.length, status: 'ai', label: 'Asking AI about the remaining questions…' });
    const items = [];
    for (const [i, r] of todo.slice(0, CONFIG.AI_MAX_BATCH).entries()) {
      const options = r.field.kind === 'text' ? [] : await readOptions(r.field);
      if (r.field.kind !== 'text' && !options.length) continue;
      items.push({ id: i, question: cleanLabel(r.sig.rawLabel), kind: r.field.kind, options: options.slice(0, 80),
        multi: r.field.kind === 'checkbox-group', required: isRequired(r.field, r.sig.rawLabel), r });
    }
    if (!items.length) return;

    const info = (() => { try { return getPageInfo(); } catch { return {}; } })();
    const res = await chrome.runtime.sendMessage({
      type: 'hasanify:aiResolve',
      job: { title: info.title ?? '', company: currentCompany(), ...jobContext() },
      items: items.map(({ r, ...q }) => q),
    }).catch((err) => ({ ok: false, error: String(err) }));
    if (!res?.ok) {
      state.aiNotice = res?.error ?? 'AI unavailable';
      log('AI skipped:', state.aiNotice);
      return;
    }
    state.aiNotice = '';

    let done = 0;
    for (const ans of res.answers ?? []) {
      const item = items.find((q) => q.id === ans.id);
      const value = Array.isArray(ans.answer) ? ans.answer.filter(Boolean).join(', ') : String(ans.answer ?? '').trim();
      if (!item || !value || !item.r.field.el.isConnected) continue;
      const { field } = item.r;
      // Choice answers must be one of the real options: never invent one.
      if (item.options.length) {
        const picks = value.split(/\s*,\s*/);
        if (!picks.every((p) => item.options.some((o) => norm(o) === norm(p)))) continue;
      }
      state.pickScores = [];
      let status;
      try {
        status = await FILLERS[field.kind](field, { type: 'text', candidates: [value] });
      } catch { status = 'failed'; }
      emit('progress', { done: ++done, total: items.length, status, label: item.question });
      if (status !== 'filled') continue;
      const info2 = state.registry.get(field.el);
      Object.assign(info2, { status: 'filled', key: `ai:${questionKey(item.question)}`, review: 'AI suggestion — please check', reviewed: false, ai: true });
      stats.filled++;
      stats.matched++;
      state.filledEver.add(field.el);
      mark(field, 'review');
      await sleep(CONFIG.BETWEEN_FIELDS_MS);
    }
  }

  /** Option texts of any choice control. Custom dropdowns are opened briefly and closed again. */
  async function readOptions(field) {
    const { el, kind } = field;
    const clean = (list) => [...new Set(list.map((t) => String(t ?? '').replace(/\s+/g, ' ').trim()).filter((t) => t && !PLACEHOLDER_OPTION.test(t)))];
    if (kind === 'select') return clean([...el.options].filter((o) => !o.disabled).map(textOf));
    if (kind === 'radio' || kind === 'checkbox-group') return clean(field.members.map(getOptionLabel));
    if (kind === 'combobox' || kind === 'listbox') {
      try {
        focusElement(el);
        realClick(el);
        if (kind === 'combobox') pressKey(el, 'ArrowDown');
        const opts = await waitFor(() => { const o = getVisibleOptions(el); return o.length ? o : null; }, 1500);
        return clean((opts ?? []).map((o) => o.text));
      } finally {
        pressKey(el, 'Escape');
        if (kind === 'combobox') blurElement(el);
      }
    }
    return [];
  }

  /** Remember which employer this application is for (wrong-company check on later applications). */
  let notedCompany = '';
  function noteCompany() {
    const c = currentCompany();
    if (!c || c === notedCompany) return;
    notedCompany = c;
    chrome.runtime.sendMessage({ type: 'hasanify:noteCompany', company: c }).catch(() => {});
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Check before submit
  // ═════════════════════════════════════════════════════════════════════════
  //
  // When the user clicks the FINAL submit button of a form Hasanify worked on,
  // look for: required fields still empty, fills Hasanify wasn't sure about and
  // nobody checked, and answers/attachments that name a different employer
  // (a reused cover letter that still says "Globex"). If anything turns up the
  // submit is held and the widget asks "Fix" or "Submit anyway".

  const SUBMIT_TEXT = /\b(submit|send)\b|apply now|^apply$|^apply for (this )?(job|position|role)$|complete (my )?application|finish( application)?$|^done$/i;
  const NOT_SUBMIT_TEXT = /\b(next|continue|back|previous|search|subscribe|sign ?in|log ?in|sign ?up|upload|add (another|more)|save (and|&) (continue|next)|save draft|cancel)\b/i;

  function isFinalSubmit(btn) {
    if (!btn || btn.closest('[data-hasanify-ignore]')) return false;
    const text = (textOf(btn) || btn.value || btn.getAttribute('aria-label') || '').trim();
    return text.length <= 60 && SUBMIT_TEXT.test(text) && !NOT_SUBMIT_TEXT.test(text);
  }

  /** All fillable controls in scope (not only the ones Hasanify processed). */
  function allFields(scope) {
    const out = [];
    const seen = new Set();
    for (const el of queryAllDeep(FIELD_SELECTOR)) {
      if (scope && scope !== document && !scope.contains(el)) continue;
      if (el.closest('[data-hasanify-ignore]')) continue;
      const kind = getKind(el);
      if (!kind || !isFillable(el)) continue;
      const field = { el, kind };
      if (kind === 'radio' || kind === 'checkbox') {
        const container = getGroupContainer(el);
        const members = getGroupMembers(el, container);
        if (kind === 'checkbox' && members.length > 1) field.kind = 'checkbox-group';
        if (field.kind !== 'checkbox') {
          if (seen.has(members[0])) continue;
          seen.add(members[0]);
          field.el = members[0];
        }
        field.container = container;
        field.members = members;
      }
      out.push(field);
    }
    return out;
  }

  function uploadLooksDone(field) {
    const up = state.uploads.get(field.el);
    if (up?.done) return true;
    // Custom uploaders often clear the <input> after sending the file: trust a file name shown nearby.
    const box = field.el.closest('[class*="upload"], [class*="Upload"], [class*="drop"], [data-automation-id*="file"], fieldset, .field, li, div');
    return !!box && /\.(pdf|docx?|txt|rtf|odt|pages)\b/i.test(textOf(box));
  }

  function otherCompanyIn(text) {
    const current = norm(currentCompany());
    const own = new Set([...(state.profile?.experience ?? []).map((e) => norm(e.company)), ...(state.profile?.education ?? []).map((e) => norm(e.school))]);
    const t = ` ${norm(text)} `;
    for (const c of state.companies) {
      const n = norm(c);
      if (n.length < 3 || n === current || own.has(n) || (current && (current.includes(n) || n.includes(current)))) continue;
      if (t.includes(` ${n} `)) return c;
    }
    return null;
  }

  function collectSubmitIssues(scope) {
    const issues = [];
    for (const field of allFields(scope)) {
      const label = cleanLabel(collectSignals(field).rawLabel) || 'Unlabeled field';
      const info = state.registry.get(field.el);
      if (field.kind === 'file') {
        if (isRequired(field, label) && !hasExistingValue(field) && !uploadLooksDone(field)) issues.push({ kind: 'required', label, el: focusTarget(field) });
        const name = field.el.files?.[0]?.name ?? state.uploads.get(field.el)?.fileName ?? '';
        const other = name && otherCompanyIn(name.replace(/[_.-]+/g, ' '));
        if (other) issues.push({ kind: 'company', label, detail: `File “${name}” looks like it was made for ${other}`, el: focusTarget(field) });
        continue;
      }
      if (isRequired(field, label) && !hasExistingValue(field)) {
        issues.push({ kind: 'required', label, el: focusTarget(field) });
        continue;
      }
      if (info?.status === 'filled' && info.review && !info.reviewed) {
        issues.push({ kind: 'review', label, detail: info.review, el: focusTarget(field), id: info.id });
      }
      if (field.kind === 'text' || field.kind === 'textarea') {
        const v = field.el.value ?? '';
        if (/\{company\}/i.test(v)) issues.push({ kind: 'company', label, detail: 'Still contains the {company} placeholder', el: field.el });
        else if (v.length >= 12) {
          const other = otherCompanyIn(v);
          if (other) issues.push({ kind: 'company', label, detail: `Mentions ${other} — this application is for ${currentCompany() || 'another company'}`, el: field.el });
        }
      }
    }
    const order = { required: 0, company: 1, review: 2 };
    return issues.sort((a, b) => order[a.kind] - order[b.kind]);
  }

  /** Capture-phase gate in front of the page's own submit handlers. */
  function onPossibleSubmit(e) {
    if (!e.isTrusted || !state.settings?.preSubmitCheck || Date.now() < state.submitBypassUntil) return;
    if (!state.registry.size) return; // only on forms Hasanify actually worked on
    let btn = null, form = null;
    if (e.type === 'click') {
      const t = e.composedPath?.()[0] ?? e.target;
      btn = t instanceof Element ? t.closest('button, input[type="submit"], [role="button"], a') : null;
      if (!isFinalSubmit(btn)) return;
      form = btn.form ?? btn.closest('form');
    } else {
      form = e.target;
      btn = e.submitter;
      if (btn ? !isFinalSubmit(btn) : ![...form.querySelectorAll('button, input[type="submit"]')].some(isFinalSubmit)) return;
    }
    const issues = collectSubmitIssues(form ?? document);
    if (!issues.length) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    const proceed = () => {
      state.submitBypassUntil = Date.now() + 5000;
      if (e.type === 'submit' && form?.isConnected) {
        btn?.isConnected ? form.requestSubmit(btn) : form.requestSubmit();
      } else if (btn?.isConnected) {
        btn.click();
      }
    };
    if (presubmitUI) {
      emit('presubmit', { issues, proceed });
    } else {
      // No widget in this frame: a plain confirm still prevents the mistake.
      const lines = issues.slice(0, 8).map((i) => `• ${i.label}${i.detail ? ` — ${i.detail}` : i.kind === 'required' ? ' — required, empty' : ''}`);
      if (confirm(`Hasanify: before you submit\n\n${lines.join('\n')}\n\nSubmit anyway?`)) proceed();
    }
  }
  let presubmitUI = false; // the widget sets this when it can show the check
  window.addEventListener('click', onPossibleSubmit, true);
  window.addEventListener('submit', onPossibleSubmit, true);

  /** The user looked at / edited a flagged field: it no longer needs checking. */
  function clearReviewFor(e) {
    if (!e.isTrusted) return;
    const t = e.composedPath?.()[0] ?? e.target;
    if (!(t instanceof Element)) return;
    for (const info of state.registry.values()) {
      if (!info.review || info.reviewed || !info.field) continue;
      const f = info.field;
      if (f.el === t || f.el.contains(t) || f.members?.includes(t) || f.container?.contains(t) || t.closest?.('label')?.control === f.el) {
        confirmReview(info.id);
        return;
      }
    }
  }

  /** "Looks right": the user confirmed a field Hasanify flagged. */
  function confirmReview(id) {
    for (const info of state.registry.values()) {
      if (info.id !== id) continue;
      info.reviewed = true;
      if (info.field && info.status === 'filled') mark(info.field, 'filled');
    }
    emit('learning-changed', {});
  }

  // ---- Engine API for the in-page widget (ui/widget.js) -------------------
  // Lives in the content script's isolated world: page scripts cannot reach it.

  const events = new EventTarget();
  function emit(type, detail) {
    events.dispatchEvent(new CustomEvent(type, { detail }));
  }

  function isRequired(field, label) {
    const els = field.members ?? [field.el];
    return els.some((e) => e.required || e.getAttribute('aria-required') === 'true') || /\*\s*$/.test(label ?? '');
  }

  /** Element to scroll to / focus for a field (visible label for hidden radios). */
  function focusTarget(field) {
    if (field.kind === 'radio' || field.kind === 'checkbox-group') return field.container ?? field.el;
    return isVisible(field.el) ? field.el : (field.el.labels?.[0] ?? field.el.parentElement ?? field.el);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Unfilled-field report + learning from the user
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Every field Hasanify could not fill is reported (widget + history in the
  // dashboard). Those fields — and fields it DID fill — are then watched: when
  // the user answers a missed question or corrects a filled value through real
  // (trusted) interaction, the answer becomes a learned custom answer and is
  // used automatically next time.

  const MISSED = new Set(['unmatched', 'no-value', 'no-option', 'failed']);
  const REASONS = { unmatched: 'Not recognized', 'no-value': 'No saved answer', 'no-option': 'No matching option', failed: 'Couldn’t fill' };

  /** Never learned or reported: secrets, identifiers, payment, consent, search boxes. */
  const NEVER_LEARN = /password|passcode|\bssn\b|social security|national (id|insurance)|\bnin\b|tax (id|number)|passport (no|number)|licen[cs]e (no|number)|credit card|card number|\bcvv\b|\bcvc\b|expir(y|ation)|\bbank\b|routing|\biban\b|account number|signature|sign here|captcha|verification code|\botp\b|one.?time|security (question|answer)|today.?s date|date signed|\bsearch\b|i (agree|acknowledge|consent|certify|confirm)|terms (and|&) conditions|privacy (policy|notice)/i;

  const cleanLabel = (s) => String(s ?? '').replace(/\s*[*✱]\s*$/, '').replace(/\s+/g, ' ').trim();

  function isLearnable(field, label) {
    if (field.kind === 'file' || field.kind === 'checkbox') return false; // files; single consent checkboxes
    const q = cleanLabel(label);
    return q.length >= 3 && q.length <= 250 && !NEVER_LEARN.test(q) && !state.uploads.has(field.el);
  }

  /** The user's current answer in any kind of control ('' if empty). */
  function readAnswer(field) {
    const { el, kind } = field;
    switch (kind) {
      case 'text':
      case 'textarea':
        return el.value.trim();
      case 'select': {
        const opt = el.options[el.selectedIndex];
        const t = opt ? textOf(opt) : '';
        return opt && opt.value !== '' && !PLACEHOLDER_OPTION.test(t) ? t : '';
      }
      case 'radio':
        return field.members.filter((m) => m.checked).map(getOptionLabel).join(', ').trim();
      case 'checkbox-group':
        return field.members.filter((m) => m.checked).map(getOptionLabel).join(', ').trim();
      case 'combobox': {
        let node = el;
        for (let i = 0; i < 5 && (node = node.parentElement); i++) {
          if (node.querySelectorAll('[role="combobox"]').length > 1) break;
          const shown = node.querySelector('[class*="single-value"], [class*="singleValue"], [data-automation-id="selectedItem"]');
          if (shown && textOf(shown)) return textOf(shown);
        }
        return el.value.trim();
      }
      case 'listbox': {
        const t = textOf(el);
        return t && !PLACEHOLDER_OPTION.test(t) ? t : '';
      }
      default:
        return '';
    }
  }

  let learnSeq = 0;
  /** Start watching a field for user answers. origin: 'missed' | 'filled'. */
  function watchForLearning(field, sig, status) {
    const label = sig?.rawLabel;
    if (!isLearnable(field, label)) return;
    const existing = state.learn.get(field.el);
    if (existing) { existing.origin = MISSED.has(status) ? 'missed' : existing.origin; return; }
    state.learn.set(field.el, {
      id: ++learnSeq,
      field,
      question: cleanLabel(label),
      origin: MISSED.has(status) ? 'missed' : 'filled',
      reason: REASONS[status] ?? '',
      kind: ['text', 'textarea'].includes(field.kind) ? 'text' : 'choice',
      baseline: null,   // value after our fill settles; edits away from it are corrections
      touched: false,   // set only by TRUSTED user interaction inside this field
      answer: '',
      status: 'idle',   // idle | pending | saved | dismissed
    });
  }

  /** Our own fills must not look like corrections: snapshot values once they settle. */
  function refreshBaselines() {
    for (const entry of state.learn.values()) {
      if (entry.origin === 'filled' && !entry.touched && entry.field.el.isConnected) entry.baseline = readAnswer(entry.field);
    }
  }

  function entryForTarget(target) {
    for (const entry of state.learn.values()) {
      const f = entry.field;
      if (f.el === target || f.el.contains?.(target) || f.members?.some((m) => m === target || m.labels?.[0]?.contains(target))
          || (f.container && f.container.contains(target)) || target?.closest?.('label')?.control === f.el) return entry;
      // react-select / Workday: the click lands on the control wrapper around the input
      const wrap = f.el.closest('[class*="select__control"], [class*="container"], [data-automation-id^="formField"]');
      if (wrap && wrap.contains(target) && wrap.querySelectorAll(FIELD_SELECTOR).length === 1) return entry;
    }
    return null;
  }

  let harvestTimer = 0;
  function onUserInteraction(e) {
    if (!e.isTrusted || state.filling || state.settings?.learningMode === 'off') return;
    const target = e.composedPath?.()[0] ?? e.target;
    if (!(target instanceof Element) || target.closest('[data-hasanify-ignore]')) return;
    const entry = entryForTarget(target);
    if (entry) entry.touched = true;
    clearTimeout(harvestTimer);
    harvestTimer = setTimeout(harvestAnswers, 600);
  }

  /** Collect answers from touched fields; save (auto) or offer (ask). */
  function harvestAnswers() {
    if (state.filling) return;
    const mode = state.settings?.learningMode ?? 'ask';
    let changed = false;
    for (const entry of state.learn.values()) {
      if (!entry.touched || !entry.field.el.isConnected) continue;
      const answer = readAnswer(entry.field);
      if (!answer || answer === entry.answer) continue;
      if (entry.origin === 'filled' && answer === entry.baseline) continue; // not a correction
      entry.answer = answer;
      changed = true;
      if (mode === 'auto') saveLearned(entry.id);
      else entry.status = 'pending';
    }
    if (changed) emit('learning-changed', {});
  }

  async function saveLearned(id) {
    const entry = [...state.learn.values()].find((e) => e.id === id);
    if (!entry?.answer) return false;
    entry.status = 'saved';
    emit('learning-changed', {});
    const res = await chrome.runtime.sendMessage({
      type: 'hasanify:learnAnswer',
      question: templatize(entry.question),
      key: questionKey(entry.question),
      answer: templatize(entry.answer),
      kind: entry.kind,
      host: location.hostname,
      ctx: jobContext(), // which job this answer was given for (variants per context)
    }).catch(() => null);
    if (!res?.ok) { entry.status = 'pending'; emit('learning-changed', {}); return false; }
    return true;
  }

  function dismissLearned(id) {
    const entry = [...state.learn.values()].find((e) => e.id === id);
    if (entry) { entry.status = 'dismissed'; emit('learning-changed', {}); }
  }

  /** Send newly missed questions to the background's history (once per page). */
  function recordMissed(items) {
    const fresh = items.filter((i) => !state.reportedMissed.has(i.key));
    if (!fresh.length) return;
    fresh.forEach((i) => state.reportedMissed.add(i.key));
    chrome.runtime.sendMessage({ type: 'hasanify:recordMissed', items: fresh, host: location.hostname }).catch(() => {});
  }

  /** Report rows for the widget: every unfilled field with its learning state. */
  function getReport() {
    const rows = [];
    for (const info of state.registry.values()) {
      const f = info.field;
      if (!f || !f.el.isConnected || state.uploads.has(f.el)) continue;
      const entry = state.learn.get(f.el);
      const missed = MISSED.has(info.status);
      const corrected = entry?.origin === 'filled' && entry.status !== 'idle';
      const review = info.status === 'filled' && info.review && !info.reviewed && !corrected;
      if (!missed && !corrected && !review) continue;
      if (missed && !info.label) continue;
      rows.push({
        id: entry?.id ?? null,
        rid: info.id,
        label: cleanLabel(info.label) || 'Unlabeled field',
        reason: corrected ? 'You changed this' : review ? info.review : REASONS[info.status],
        review: !!review,
        value: review ? readAnswer(f).slice(0, 80) : '',
        required: isRequired(f, info.label),
        answered: !review && hasExistingValue(f),
        learn: entry && entry.status !== 'idle' ? { status: entry.status, answer: entry.answer } : null,
        learnable: !!entry,
        el: focusTarget(f),
      });
    }
    // Required unanswered first, then "check this", then learning prompts, then the rest.
    const rank = (r) => (r.required && !r.answered && !r.review ? 0 : r.review ? 1 : r.learn?.status === 'pending' ? 2 : 3);
    return rows.sort((a, b) => rank(a) - rank(b));
  }

  /**
   * Snapshot for the UI: how many fields were filled, plus the fields the
   * user still has to deal with (required + empty, or we failed on them).
   */
  function getSummary() {
    pruneRegistry();
    let filled = 0, matched = 0, seen = 0;
    const attention = [];
    for (const info of state.registry.values()) {
      if (!info.field) continue;
      seen++;
      if (info.status === 'filled') filled++;
      if (info.status !== 'unmatched') matched++;
      if (state.uploads.has(info.field.el)) continue; // shown in the Attachments card instead
      const problem = info.status === 'no-option' || info.status === 'failed';
      const missingRequired = (info.status === 'unmatched' || info.status === 'no-value') && isRequired(info.field, info.label);
      if ((problem || missingRequired) && !hasExistingValue(info.field)) {
        attention.push({ label: (info.label || 'Unlabeled field').replace(/\s*\*\s*$/, ''), el: focusTarget(info.field), status: info.status });
      }
    }
    const report = getReport();
    return { filled, matched, seen, attention, report, uploads: getUploads(), armed: state.armed,
      review: report.filter((r) => r.review).length, aiNotice: state.settings?.aiAssist ? state.aiNotice : '',
      learningMode: state.settings?.learningMode ?? 'ask' };
  }

  /** Classify (without filling) to decide whether this page is an application. */
  async function preview() {
    if (!state.profile) await loadContext();
    let matched = 0, total = 0;
    for (const f of scanFields()) {
      total++;
      if (classify(collectSignals(f))) matched++;
    }
    return { matched, total };
  }

  // ---- Quick copy: insert a profile value into the field the user last used --

  const EDITABLE = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), textarea, select';

  function trackFocus() {
    document.addEventListener('focusin', (e) => {
      if (!e.isTrusted) return;
      // composedPath()[0] reaches inside open shadow roots; our closed widget
      // only exposes its host, which carries data-hasanify-ignore.
      const el = e.composedPath?.()[0] ?? e.target;
      if (!(el instanceof Element) || el.closest('[data-hasanify-ignore]')) return;
      if (!el.matches(EDITABLE) && !el.isContentEditable) return;
      state.lastFocused = { el, at: Date.now() };
      emit('focus-target', {});
      // Tell the extension (background records tab + frame; side panel shows "Insert into …").
      const target = getFocusTarget();
      if (target) chrome.runtime.sendMessage({ type: 'hasanify:focusTarget', label: target.label, at: state.lastFocused.at }).catch(() => {});
    }, true);
  }

  // ---- Page info for the side panel's "Save application" -------------------

  const ATS_BY_HOST = [
    [/greenhouse\.io/, 'Greenhouse'], [/lever\.co/, 'Lever'], [/myworkdayjobs|myworkdaysite|workday/, 'Workday'],
    [/ashbyhq\.com/, 'Ashby'], [/smartrecruiters\.com/, 'SmartRecruiters'], [/icims\.com/, 'iCIMS'], [/jobvite\.com/, 'Jobvite'],
    [/bamboohr\.com/, 'BambooHR'], [/taleo\.net/, 'Taleo'], [/workable\.com/, 'Workable'], [/linkedin\.com/, 'LinkedIn'], [/indeed\.com/, 'Indeed'],
  ];
  const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

  function getPageInfo() {
    const host = location.hostname;
    const path = location.pathname.split('/').filter(Boolean);
    const ats = ATS_BY_HOST.find(([rx]) => rx.test(host))?.[1] ?? '';
    const meta = (n) => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.content?.trim() ?? '';

    // Company: ATS URL conventions first, then page metadata, then the domain.
    let company = '';
    if (/greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|jobvite\.com/.test(host) && path[0]) company = titleCase(path[0]);
    else if (/myworkdayjobs|myworkdaysite/.test(host)) company = titleCase(host.split('.')[0]);
    else if (/bamboohr\.com/.test(host)) company = titleCase(host.split('.')[0]);
    company ||= String(jobPostingLd()?.hiringOrganization?.name ?? '').trim() || meta('og:site_name') || titleCase(siteOf(host).split('.')[0]);

    const heading = document.querySelector('h1, [data-automation-id="jobPostingHeader"], .posting-headline h2, [class*="job-title" i]');
    let title = (heading?.textContent || meta('og:title') || document.title || '').replace(/\s+/g, ' ').trim();
    title = title.replace(new RegExp(`\\s*[-|–—@]\\s*${company}.*$`, 'i'), '').slice(0, 120);
    return { title, company, ats, url: location.href.split('#')[0] };
  }

  /** The page field Quick copy would insert into, with a human label. */
  function getFocusTarget() {
    const t = state.lastFocused;
    if (!t?.el?.isConnected || Date.now() - t.at > 15 * 60 * 1000) return null;
    const el = t.el;
    const label = (getExplicitLabel(el) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || getNearbyText(el) || el.name || 'this field')
      .replace(/\s*[*✱]\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 50);
    return { label };
  }

  async function insertText(text) {
    const el = state.lastFocused?.el;
    if (!el?.isConnected) return false;
    if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);
    } else {
      const field = { el, kind: getKind(el) ?? 'text' };
      let status;
      if (field.kind === 'select') status = fillSelect(field, toDesired(text));
      else if (field.kind === 'combobox') status = await fillCombobox(field, toDesired(text));
      else if (field.kind === 'listbox') status = await fillListbox(field, toDesired(text));
      else { setValueAndNotify(el, text); status = el.value ? 'filled' : 'failed'; }
      if (status !== 'filled') return false;
    }
    // Hand focus back so the user can keep typing / tab onwards.
    ensureStyles();
    el.focus({ preventScroll: true });
    el.classList.remove('hasanify-pulse');
    void el.offsetWidth;
    el.classList.add('hasanify-pulse');
    setTimeout(() => el.classList.remove('hasanify-pulse'), 1800);
    return true;
  }

  globalThis.HasanifyEngine = Object.freeze({
    saveLearned,
    dismissLearned,
    getFocusTarget,
    insertText,
    events,
    fill: () => { setArmed(true); return runAutofill({ force: true }); },
    preview,
    attachToUpload,
    hasSavedResume: () => !!state.profile?.documents?.resume?.dataUrl,
    savedResumeName: () => state.profile?.documents?.resume?.fileName ?? '',
    getSummary,
    isKnownAts: () => isKnownAts(),
    getSettings: () => state.settings,
    getProfile: () => state.profile,
    loadContext,
    setArmed: (v) => { setArmed(v); if (v) scheduleRun(); emit('armed', { armed: state.armed }); },
    confirmReview,
    setPresubmitUI: (v) => { presubmitUI = !!v; },
  });

  /**
   * Debounced run with a MAXIMUM wait. A plain debounce never fires on pages
   * that mutate continuously (spinners, carousels, focus/hover class churn on
   * a form wrapper, live character counters): each mutation pushed the run
   * back again, so the next step simply never got filled.
   */
  function scheduleRun() {
    clearTimeout(state.debounceTimer);
    const now = performance.now();
    state.firstRequestAt ??= now;
    const wait = Math.max(0, Math.min(CONFIG.MUTATION_DEBOUNCE_MS, state.firstRequestAt + CONFIG.MAX_DEBOUNCE_MS - now));
    state.debounceTimer = setTimeout(() => {
      state.firstRequestAt = null;
      runAutofill();
    }, wait);
  }

  /**
   * Safety net while armed: every few seconds, cheaply check for fillable
   * fields we have never processed. Catches reveals no mutation describes
   * (stylesheet swaps, `<details open>`, fields shown by a sibling's class,
   * pages that replace content inside closed shadow roots).
   */
  function startArmedPoll() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(() => {
      if (!state.armed || state.filling || document.hidden || !state.profile) return;
      if (state.debounceTimer && state.firstRequestAt != null) return; // a run is already queued
      try {
        if (scanFields().length) scheduleRun();
      } catch (err) {
        if (/Extension context invalidated/i.test(String(err))) teardown();
      }
    }, CONFIG.ARMED_POLL_MS);
  }

  /** Drop entries for elements that left the DOM (SPA step changes). */
  function pruneRegistry() {
    for (const el of state.registry.keys()) if (!el.isConnected) state.registry.delete(el);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 9. Mutation / navigation observation
  // ═════════════════════════════════════════════════════════════════════════

  /** Does this batch of mutations introduce (or reveal) form controls? */
  function mutationsAddFields(mutations) {
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType !== Node.ELEMENT_NODE) continue;
          if (n.closest?.('#hasanify-style')) continue;
          if (n.matches(FIELD_SELECTOR) || n.querySelector(FIELD_SELECTOR) || n.shadowRoot) return true;
        }
      } else if (m.type === 'attributes') {
        // Hidden → visible transitions: wizard steps toggled by class
        // (`.step.active`), accordions, conditional questions.
        const t = m.target;
        if (t.nodeType !== Node.ELEMENT_NODE || t.closest?.('[data-hasanify-ignore]')) continue;
        if (t.matches(FIELD_SELECTOR)) {
          // A control's own class flips on focus/validation: ignore; other attrs count.
          if (m.attributeName !== 'class') return true;
        } else if (t.querySelector(FIELD_SELECTOR)) {
          return true;
        }
      }
    }
    return false;
  }

  function onMutations(mutations) {
    // SPA navigation (pushState) cannot be hooked from the isolated world;
    // checking the URL on DOM churn is a cheap, reliable substitute.
    if (location.href !== state.lastUrl) {
      state.lastUrl = location.href;
      cachedCompany = null;
      cachedJobCtx = null;
      pruneRegistry();
      for (const el of state.learn.keys()) if (!el.isConnected) state.learn.delete(el);
      for (const el of state.uploads.keys()) if (!el.isConnected) state.uploads.delete(el);
    }
    if (!mutationsAddFields(mutations)) return;
    emit('fields-changed', {}); // lets the widget appear on SPA pages that render forms late
    if (!state.armed) return;
    if (state.filling) state.pendingRun = true;
    else scheduleRun();
  }

  function observeRoot(root) {
    if (!state.observer || state.observedRoots.has(root)) return;
    state.observedRoots.add(root);
    state.observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      // `class` is included because many wizards reveal the next step by
      // toggling a class. Focus-styling noise is cheap: a scan that finds no
      // new fields returns immediately (see runAutofill).
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'disabled'],
    });
  }

  function startObserver() {
    state.observer = new MutationObserver(onMutations);
    // Observe the Document node, not <html>: React 18 client-render fallback
    // (seen on Greenhouse job-boards) replaces the whole <html> element, which
    // would silently detach an observer bound to the old documentElement.
    observeRoot(document);
    window.addEventListener('popstate', () => state.armed && scheduleRun());
    // Back/forward cache restores a page without re-running content scripts.
    window.addEventListener('pageshow', (e) => e.persisted && state.armed && scheduleRun());
    // Safety net for step changes that produce no observable mutation (CSS
    // transitions, transforms, canvas-driven UIs): after a REAL click on a
    // button/link (Next, Continue, Save & continue), look again twice.
    document.addEventListener('click', (e) => {
      if (!e.isTrusted || !state.armed) return;
      if (!e.target.closest?.('button, a, [role="button"], input[type="submit"], input[type="button"]')) return;
      setTimeout(scheduleRun, 900);
      setTimeout(scheduleRun, 2500);
    }, true);
  }

  function teardown() {
    state.observer?.disconnect();
    state.armed = false;
    clearTimeout(state.debounceTimer);
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  // ---- Application-session arming (survives full page loads) ---------------

  /** Registrable-ish site: "wd5.myworkdayjobs.com" → "myworkdayjobs.com", "careers.acme.co.uk" → "acme.co.uk". */
  function siteOf(host) {
    const parts = host.split('.');
    if (parts.length <= 2 || /^\d+$/.test(parts.at(-1))) return host;
    const sld = parts.at(-2);
    const ccSecondLevel = parts.at(-1).length === 2 && sld.length <= 3; // co.uk, com.au, co.in
    return parts.slice(ccSecondLevel ? -3 : -2).join('.');
  }

  /** Arm/disarm auto-fill for this document AND remember it for the tab's later pages. */
  function setArmed(armed) {
    const changed = state.armed !== !!armed;
    state.armed = !!armed;
    if (state.armed) startArmedPoll();
    if (changed) emit('armed', { armed: state.armed });
    chrome.runtime.sendMessage({ type: 'hasanify:setTabArmed', site: siteOf(location.hostname), armed: state.armed }).catch(() => {});
  }

  /** → { armed: this site was filled earlier in this tab, recent: the tab filled something in the last ~20 min } */
  async function isTabArmed() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'hasanify:isTabArmed', site: siteOf(location.hostname) });
      return { armed: !!res?.armed, recent: !!res?.recent };
    } catch {
      return { armed: false, recent: false };
    }
  }

  /**
   * After a cross-domain hop (careers.acme.com → acme.icims.com), is this page
   * the continuation of the application? Needs an application-ish URL/title
   * AND real evidence in the form: an upload, or ≥2 fields we have values for.
   */
  function looksLikeApplication() {
    const text = `${location.href} ${document.title}`.toLowerCase();
    if (!/apply|application|candidate|career|jobs?\b|job[-_/]|recruit|talent|hiring|position|vacanc|opening/.test(text)) return false;
    let known = 0;
    for (const field of scanFields()) {
      if (field.kind === 'file') return true;
      const m = classify(collectSignals(field));
      if (m && !m.custom && ++known >= 2) return true;
    }
    return false;
  }

  function isKnownAts() {
    const host = location.hostname;
    return (state.settings?.knownAtsHosts ?? []).some((h) => host === h || host.endsWith(`.${h}`));
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 10. Messaging + bootstrap
  // ═════════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'hasanify:fill') {
      // tabs.sendMessage reaches every frame and the caller gets the FIRST reply.
      // Field-less subframes (captcha, ads) stay silent so the reply comes from the form.
      if (window !== window.top && !queryAllDeep(FIELD_SELECTOR).length) return false;
      setArmed(true); // after one manual fill, keep following later steps AND later pages
      runAutofill({ force: !!msg.force }).then((stats) => sendResponse({ ok: true, stats }));
      return true;
    }
    // Side panel → type a profile value into the field the user last focused
    // (sent to the exact frame the background recorded for that focus).
    if (msg?.type === 'hasanify:insertText') {
      if (!state.lastFocused?.el?.isConnected) return false;
      insertText(String(msg.text ?? '')).then((ok) => sendResponse({ ok }));
      return true;
    }
    if (msg?.type === 'hasanify:getPageInfo') {
      if (window !== window.top) return false;
      sendResponse({ ok: true, info: getPageInfo() });
      return false;
    }
    if (msg?.type === 'hasanify:debug') {
      if (window !== window.top && !queryAllDeep(FIELD_SELECTOR).length) return false;
      // Classification dump for tuning heuristics, without filling anything.
      (state.profile ? Promise.resolve() : loadContext()).then(() => {
        const rows = scanFields().map((f) => {
          const sig = collectSignals(f);
          const m = classify(sig);
          return { kind: f.kind, label: sig.rawLabel, attrs: sig.attrs, section: sig.section,
            key: m?.custom ? 'custom' : m?.def?.key ?? null, score: m?.score ?? 0 };
        });
        console.table(rows);
        sendResponse({ ok: true, rows });
      }, (err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    return false;
  });

  // Profile edited in the popup → reload lazily on the next run.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // Settings apply immediately (e.g. learning mode switched in the side panel).
    if (changes['hasanify.settings']?.newValue) state.settings = mergeWithDefaults(DEFAULT_SETTINGS, changes['hasanify.settings'].newValue);
    if ('hasanify.profile' in changes) state.profile = null; // reloaded lazily on the next run
  });

  trackFocus();
  // Learning: typing/clicking marks a field as user-touched; change/blur/click harvests answers.
  for (const type of ['input', 'keydown', 'change', 'click', 'focusout']) {
    document.addEventListener(type, (e) => {
      if (type === 'input' || type === 'keydown') {
        if (!e.isTrusted || state.filling) return;
        const t = e.composedPath?.()[0] ?? e.target;
        const entry = t instanceof Element ? entryForTarget(t) : null;
        if (entry) entry.touched = true;
        return;
      }
      if (type !== 'click' || e.isTrusted) clearReviewFor(e);
      onUserInteraction(e);
    }, true);
  }

  (async function init() {
    try {
      await loadContext();
    } catch {
      return; // extension reloaded/unavailable; manual trigger will re-inject
    }
    startObserver();
    // Auto-fill this page when it's a known ATS, or when the user already
    // filled an earlier page of this application in the same tab.
    const autoAts = state.settings.autoFillOnKnownATS && isKnownAts();
    const tab = await isTabArmed();
    if (autoAts || tab.armed) {
      state.armed = true;
      startArmedPoll();
      emit('armed', { armed: true });
      // Let the SPA finish hydrating before the first pass (longer on sites known to re-render late).
      await (state.siteNote?.slow ? waitForQuiet(1500, 10000) : waitForQuiet());
      scheduleRun();
    } else if (tab.recent) {
      // The application continued on another domain. Forms often render late,
      // so look a few times before giving up.
      await waitForQuiet();
      for (const delay of [0, 2500, 6000]) {
        await sleep(delay);
        if (state.armed) return; // the user clicked Autofill meanwhile
        if (looksLikeApplication()) {
          log('following the application onto', location.hostname);
          setArmed(true);
          scheduleRun();
          return;
        }
      }
    }
  })();
})();
