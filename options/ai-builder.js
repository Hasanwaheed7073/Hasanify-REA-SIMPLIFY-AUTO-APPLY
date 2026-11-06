/**
 * Hasanify — AI profile builder
 * ---------------------------------------------------------------------------
 * 1. Generates a prompt the user pastes into ChatGPT / Claude / Gemini along
 *    with their resumes, questionnaires and intake forms. The prompt carries
 *    Hasanify's exact profile format, extraction rules, and an interview
 *    protocol (ask about anything missing before producing the final JSON).
 * 2. Accepts the AI's final reply, extracts the JSON, coerces common LLM slips
 *    ("Yes" → true, "May 2023" → "2023-05", null strings → ""), previews it,
 *    and merges it into the stored profile without wiping known data.
 *
 * Runs after options.js and shares its globals (profile, send, toast, $).
 */
'use strict';

(() => {
  const { PROFILE_JSON_SCHEMA, DEFAULT_PROFILE, mergeWithDefaults, validateProfile, computeCompleteness } = globalThis.HasanifySchema;
  const el = (id) => document.getElementById(id);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // ═════════════════════════════════════════════════════════════════════════
  // 1. Prompt
  // ═════════════════════════════════════════════════════════════════════════

  /** The format, written as JSON whose values DESCRIBE each field. */
  const FORMAT = `{
  "schemaVersion": 1,
  "personal": {
    "firstName": "", "middleName": "", "lastName": "", "preferredName": "",
    "pronouns": "e.g. He/him, She/her, They/them, or empty",
    "email": "",
    "phone": "digits only, no country code, e.g. 4155550123",
    "phoneCountryCode": "e.g. +1",
    "address": { "line1": "street", "line2": "apt/suite", "city": "", "state": "state/province (abbreviation ok, e.g. TX)", "postalCode": "", "country": "full name, e.g. United States" }
  },
  "links": {
    "linkedin": "full URL", "github": "full URL", "portfolio": "full URL", "website": "full URL", "twitter": "full URL",
    "other": [ { "label": "", "url": "" } ]
  },
  "experience": [
    {
      "company": "", "title": "", "location": "City, State",
      "employmentType": "one of: Full-time, Part-time, Internship, Contract, Freelance",
      "startDate": "YYYY-MM", "endDate": "YYYY-MM, or empty if current", "current": false,
      "description": "2-5 achievement lines separated by \\n"
    }
  ],
  "education": [
    {
      "school": "",
      "degree": "one of: High School, Associate's, Bachelor's, Master's, MBA, PhD, Other",
      "fieldOfStudy": "", "minor": "", "gpa": "e.g. 3.8 or empty", "location": "City, State",
      "startDate": "YYYY-MM", "endDate": "YYYY-MM (expected date if still studying)", "current": false
    }
  ],
  "skills": {
    "technical": ["individual skills and tools, most relevant first, max 30"],
    "certifications": ["full certification names"],
    "spokenLanguages": [ { "language": "", "proficiency": "one of: Native, Fluent, Professional, Conversational, Basic" } ]
  },
  "workAuthorization": {
    "authorizedToWork": "true / false / null — legally authorized to work in my target country",
    "requiresSponsorship": "true / false / null — will need visa sponsorship now or in the future",
    "visaStatus": "e.g. US Citizen, Green Card, H-1B, F-1 OPT, Not applicable",
    "citizenship": "country name(s)",
    "securityClearance": "e.g. None, Secret, Top Secret"
  },
  "preferences": {
    "desiredSalary": "number only, e.g. 120000, or empty",
    "salaryCurrency": "e.g. USD",
    "noticePeriod": "e.g. 2 weeks, Immediately",
    "earliestStartDate": "YYYY-MM-DD or empty",
    "willingToRelocate": "true / false / null",
    "over18": "true / false / null",
    "howDidYouHear": "default answer, e.g. LinkedIn"
  },
  "diversity": {
    "gender": "Male, Female, Non-binary, or Decline to self-identify",
    "hispanicOrLatino": "Yes, No, or Decline to self-identify",
    "race": "e.g. Asian, White, Black or African American, Two or More Races, or Decline to self-identify",
    "veteranStatus": "I am a protected veteran, I am not a protected veteran, or Decline to self-identify",
    "disabilityStatus": "Yes, I have a disability, No, I do not have a disability, or Decline to self-identify",
    "sexualOrientation": "or Decline to self-identify",
    "transgender": "Yes, No, or Decline to self-identify"
  },
  "documents": { "resume": null, "coverLetterText": "" },
  "customAnswers": [
    { "question": "short lowercase phrase likely to appear in a form label, e.g. why do you want to work", "answer": "" }
  ]
}`;

  /** Current profile minus the (large, AI-irrelevant) resume file payload. */
  function currentProfileForPrompt() {
    const p = structuredClone(profile);
    const resumeName = p.documents?.resume?.fileName;
    if (p.documents) p.documents.resume = null;
    return { json: JSON.stringify(p, null, 2), resumeName };
  }

  function buildPrompt() {
    const include = el('includeCurrent').checked;
    const cur = include ? currentProfileForPrompt() : null;
    const hasData = include && computeCompleteness(profile).percent > 0;

    return `You are helping me build my job-application profile for Hasanify, a browser extension that autofills job applications (Workday, Greenhouse, Lever and others). Your final output will be imported automatically, so it must follow the exact format at the end of this message.

## What I'm giving you
My resume(s), questionnaires, intake forms, and possibly other documents (cover letters, LinkedIn export, transcripts).${hasData ? ' I am also including my CURRENT Hasanify profile at the bottom: update and complete it rather than starting over, and keep anything still correct.' : ''}

## Your process
1. Read every document carefully and extract everything relevant into the profile format.
2. BEFORE writing the final profile, ask me about anything missing, unclear or conflicting:
   - Ask in numbered batches of at most 8 short questions, most important first, then wait for my answers.
   - Always ask if unknown: full name, email, phone, city/state/country, whether I am legally authorized to work in my target country, whether I will need visa sponsorship now or in the future, and start/end dates for every job and degree.
   - Ask once about: desired salary, earliest start date, notice period, willingness to relocate, LinkedIn/GitHub/portfolio URLs, spoken languages, and my usual answer to "How did you hear about us?".
   - For voluntary self-identification (gender, race, Hispanic/Latino, veteran, disability, sexual orientation, transgender), ask ONE question: do I want to answer these or decline all? If I decline or skip, use "Decline to self-identify".
   - If documents conflict (e.g. two resumes with different dates or titles), ask which is correct.
   - If I say "skip" or "don't know", leave that field empty ("" or null) and do not ask again.
3. When everything is answered (or nothing was missing), output the final profile.

## Rules
- Never invent, guess or embellish facts. Use only my documents and my answers. Rewording for clarity is fine; new claims are not.
- Dates are "YYYY-MM" (e.g. "2023-05"). Only earliestStartDate uses "YYYY-MM-DD". Unknown dates are "".
- Booleans are true, false or null (unknown), never "Yes"/"No" strings.
- experience and education are ordered most recent first. For a current job or degree set "current": true and "endDate": "".
- experience.description: 2-5 concise achievement lines from my resume, separated by "\\n".
- phone: digits only without the country code; put the code in phoneCountryCode.
- country: full name (e.g. "United States", "Pakistan").
- customAnswers: turn every reusable question + answer from my questionnaires and intake forms into an entry (e.g. why I want to work somewhere, greatest strength, a project I'm proud of, leadership example, preferred work style). "question" is a short lowercase phrase that would appear inside an application form label. Write answers in first person, in my voice, under 120 words. Do not duplicate things that already have a field (name, salary, sponsorship, etc.).
- coverLetterText: only if I provide a cover letter or ask you to write one; otherwise "".
- documents.resume must stay null (I upload the file separately).
- Keep every key shown in the format, even when empty. Do not add other keys.

## Final output format
When you produce the final profile, reply with the line "Here is your Hasanify profile:" followed by ONE \`\`\`json code block containing valid JSON (no comments, no trailing commas) with this structure. The values below describe what belongs in each field:

${FORMAT}

After the code block, add: "Copy this whole message and paste it into Hasanify → AI profile builder → step 3."
${hasData ? `
## My current Hasanify profile${cur.resumeName ? ` (resume file "${cur.resumeName}" is already uploaded)` : ''}
\`\`\`json
${cur.json}
\`\`\`
` : ''}
Start now: read my attached documents. If I haven't attached any yet, ask me to upload my resume and any questionnaires or intake forms.`;
  }

  function renderPrompt() {
    el('aiPrompt').textContent = buildPrompt();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for contexts where the async clipboard is unavailable.
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 2. Parsing the AI reply
  // ═════════════════════════════════════════════════════════════════════════

  /** Strip things LLMs add that JSON.parse rejects. */
  function cleanJson(s) {
    return s
      .replace(/^﻿/, '')
      .replace(/^\s*\/\/.*$/gm, '')          // whole-line // comments (keeps https:// inside strings)
      .replace(/,\s*([}\]])/g, '$1')          // trailing commas
      .trim();
  }

  /** Find the profile object inside a chat reply (fenced block preferred). */
  function extractProfileJson(text) {
    const candidates = [...text.matchAll(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/g)].map((m) => m[1]);
    const first = text.indexOf('{'), last = text.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
    candidates.sort((a, b) => b.length - a.length); // the profile is the big block

    let lastError = null;
    for (const c of candidates) {
      try {
        const obj = JSON.parse(cleanJson(c));
        if (isObj(obj) && (obj.personal || obj.experience || obj.education)) return obj;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(lastError
      ? `Found something that looks like JSON but it isn't valid (${lastError.message}). Ask the AI to "output the final profile again as one valid json code block".`
      : 'No profile found. Paste the AI message that contains the ```json block.');
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const pad = (n) => String(n).padStart(2, '0');

  /** "May 2023" | "05/2023" | "2023-5" | "2023" | "Present" → "YYYY-MM" (or "YYYY-MM-DD" when allowDay). */
  function normalizeDate(raw, allowDay) {
    const s = String(raw ?? '').trim();
    if (!s || /^(present|current|now|ongoing|n\/?a|null|unknown|tbd)$/i.test(s)) return '';
    let m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return allowDay ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : `${m[1]}-${pad(m[2])}`;
    if ((m = /^(\d{4})[-/.](\d{1,2})$/.exec(s))) return `${m[1]}-${pad(m[2])}`;
    if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) return allowDay ? `${m[3]}-${pad(m[1])}-${pad(m[2])}` : `${m[3]}-${pad(m[1])}`;
    if ((m = /^(\d{1,2})[-/.](\d{4})$/.exec(s))) return `${m[2]}-${pad(m[1])}`;
    // "June 1, 2026" / "Jun 1 2026" and "1 June 2026"
    const full = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s) ?? (() => {
      const r = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})$/i.exec(s);
      return r && [r[0], r[2], r[1], r[3]];
    })();
    if (full) {
      const mo = MONTHS[full[1].slice(0, 4).toLowerCase()] ?? MONTHS[full[1].slice(0, 3).toLowerCase()];
      if (mo) return allowDay ? `${full[3]}-${pad(mo)}-${pad(full[2])}` : `${full[3]}-${pad(mo)}`;
    }
    if ((m = /^([a-z]{3,9})\.?,?\s+(\d{4})$/i.exec(s))) {
      const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (mo) return `${m[2]}-${pad(mo)}${allowDay ? '-01' : ''}`;
    }
    if ((m = /^(\d{4})$/.exec(s))) return `${m[1]}-01${allowDay ? '-01' : ''}`;
    return null; // unparseable
  }

  /**
   * Walk the value alongside the JSON schema and coerce it into the right
   * types. Every change is recorded in `notes` so the preview can show it.
   */
  function coerce(schema, value, path, notes) {
    const types = [].concat(schema?.type ?? []);
    if (!schema) return value;

    if ('const' in schema) return schema.const;

    if (types.includes('object') && !types.includes('null') || (types.includes('object') && isObj(value))) {
      if (!isObj(value)) return value == null && types.includes('null') ? null : {};
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = schema.properties?.[k] ? coerce(schema.properties[k], v, path ? `${path}.${k}` : k, notes) : v;
      }
      return out;
    }

    if (types.includes('array')) {
      if (value == null || value === '') return [];
      let arr = value;
      if (!Array.isArray(arr)) {
        arr = typeof arr === 'string' ? arr.split(/\s*[,;\n]\s*/).filter(Boolean) : [arr];
        notes.push(`${path}: converted to a list`);
      }
      // Drop placeholder rows the AI may have left (all values empty).
      arr = arr.filter((item) => !isObj(item) || Object.values(item).some((v) => v !== '' && v != null && v !== false));
      return arr.map((item, i) => coerce(schema.items, item, `${path}[${i}]`, notes));
    }

    if (types.includes('boolean')) {
      if (typeof value === 'boolean') return value;
      const nullable = types.includes('null');
      const s = String(value ?? '').trim().toLowerCase();
      let out;
      if (/^(true|yes|y|1)$/.test(s)) out = true;
      else if (/^(false|no|n|0)$/.test(s)) out = false;
      else out = nullable ? null : false;
      if (value !== null && value !== undefined) notes.push(`${path}: "${value}" → ${out}`);
      return out;
    }

    if (types.includes('integer') || types.includes('number')) {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }

    if (types.includes('string')) {
      if (value == null) return '';
      let s = typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : String(value);
      s = s.trim();
      if (schema.pattern && s) {
        const allowDay = schema.pattern.includes('(-\\d{2})?');
        const fixed = normalizeDate(s, allowDay);
        if (fixed === null) {
          notes.push(`${path}: couldn't read date "${s}", left empty`);
          return '';
        }
        if (fixed !== s) notes.push(`${path}: "${s}" → "${fixed}"`);
        return fixed;
      }
      return s;
    }
    return value;
  }

  /**
   * AI values win, but empty/unknown AI values never erase data the user
   * already has, and the uploaded resume file is always kept.
   */
  function smartMerge(base, incoming) {
    if (incoming === undefined) return base;
    if (isObj(base) && isObj(incoming)) {
      const out = { ...base };
      for (const k of Object.keys(incoming)) out[k] = smartMerge(base[k], incoming[k]);
      return out;
    }
    if (Array.isArray(incoming)) return incoming.length ? incoming : base ?? [];
    if (incoming === '' || incoming === null) return base ?? incoming;
    return incoming;
  }

  /** Full pipeline: text → { merged profile, notes, aiProfile } */
  function processReply(text) {
    const raw = extractProfileJson(text);
    const notes = [];
    const coerced = coerce(PROFILE_JSON_SCHEMA, raw, '', notes);
    if (coerced.documents) delete coerced.documents.resume; // file is managed separately
    // Experience/education rows marked current must not carry an end date.
    for (const row of [...(coerced.experience ?? []), ...(coerced.education ?? [])]) if (row.current) row.endDate = '';

    const base = mergeWithDefaults(DEFAULT_PROFILE, profile);
    const merged = mergeWithDefaults(DEFAULT_PROFILE, smartMerge(base, coerced));
    merged.schemaVersion = DEFAULT_PROFILE.schemaVersion;
    return { merged, notes, ai: coerced };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3. UI
  // ═════════════════════════════════════════════════════════════════════════

  let pending = null;

  function setStatus(text, isError = false) {
    const s = el('aiStatus');
    s.textContent = text;
    s.classList.toggle('error', isError);
  }

  function showPreview({ merged, notes, ai }) {
    const { percent, missing } = computeCompleteness(merged);
    const ring = el('aiRing');
    ring.style.setProperty('--p', percent);
    ring.dataset.v = `${percent}%`;

    const name = [merged.personal.firstName, merged.personal.lastName].filter(Boolean).join(' ') || 'Unnamed profile';
    el('aiPreviewTitle').textContent = `${name} — ready to import`;
    el('aiPreviewSub').textContent = missing.length
      ? `Still missing after import: ${missing.join(', ')}`
      : 'Profile will be 100% complete';

    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const chips = [
      [merged.personal.email, merged.personal.email || 'no email'],
      [merged.personal.phone, merged.personal.phone ? 'Phone' : 'no phone'],
      [ai.experience?.length, count(ai.experience?.length ?? 0, 'job')],
      [ai.education?.length, count(ai.education?.length ?? 0, 'school')],
      [ai.skills?.technical?.length, count(ai.skills?.technical?.length ?? 0, 'skill')],
      [ai.customAnswers?.length, count(ai.customAnswers?.length ?? 0, 'custom answer')],
      [merged.workAuthorization.authorizedToWork != null, merged.workAuthorization.authorizedToWork != null ? 'Work authorization' : 'work auth unknown'],
      [merged.workAuthorization.requiresSponsorship != null, merged.workAuthorization.requiresSponsorship != null ? 'Sponsorship' : 'sponsorship unknown'],
    ];
    el('aiStats').replaceChildren(...chips.map(([ok, label]) => {
      const span = document.createElement('span');
      span.textContent = `${ok ? '✓' : '!'} ${label}`;
      if (!ok) span.className = 'miss';
      return span;
    }));

    el('aiNotes').textContent = notes.length
      ? `Auto-fixed ${notes.length} formatting issue${notes.length === 1 ? '' : 's'}: ${notes.slice(0, 4).join(' · ')}${notes.length > 4 ? ' …' : ''}`
      : '';
    el('aiPreview').hidden = false;
  }

  function bind() {
    // Step 1 — prompt
    el('includeCurrent').addEventListener('change', renderPrompt);
    el('expandPrompt').addEventListener('click', () => {
      const box = el('aiPrompt').parentElement;
      box.classList.toggle('open');
      el('expandPrompt').textContent = box.classList.contains('open') ? 'Collapse' : 'Show full prompt';
    });
    el('copyPrompt').addEventListener('click', async () => {
      renderPrompt(); // always copy the freshest profile
      await copyText(el('aiPrompt').textContent);
      const btn = el('copyPrompt');
      btn.classList.add('copied');
      btn.querySelector('span').textContent = 'Copied';
      toast('Prompt copied — paste it into your AI with your documents');
      setTimeout(() => { btn.classList.remove('copied'); btn.querySelector('span').textContent = 'Copy prompt'; }, 2200);
    });

    // Step 3 — paste & import
    el('aiCheck').addEventListener('click', () => {
      el('aiPreview').hidden = true;
      pending = null;
      const text = el('aiPaste').value;
      if (!text.trim()) return setStatus('Paste the AI’s reply first.', true);
      try {
        const result = processReply(text);
        const { valid, errors } = validateProfile(result.merged);
        if (!valid) return setStatus(`Profile has problems: ${errors.slice(0, 3).join('; ')}`, true);
        pending = result;
        setStatus('');
        showPreview(result);
      } catch (err) {
        setStatus(err.message, true);
      }
    });
    el('aiPaste').addEventListener('input', () => { el('aiPreview').hidden = true; setStatus(''); });
    el('aiCancel').addEventListener('click', () => { el('aiPreview').hidden = true; pending = null; });

    el('aiImport').addEventListener('click', async () => {
      if (!pending) return;
      const res = await send('hasanify:saveProfile', { profile: pending.merged });
      if (!res?.ok) return setStatus(`Import failed: ${(res?.errors ?? [res?.error]).slice(0, 2).join('; ')}`, true);
      sessionStorage.setItem('hasanify.flash', 'Profile imported');
      location.hash = '#personal';
      location.reload();
    });
  }

  // Flash message carried across the reload after an import.
  const flash = sessionStorage.getItem('hasanify.flash');
  if (flash) {
    sessionStorage.removeItem('hasanify.flash');
    setTimeout(() => toast(flash), 400);
  }

  bind();
  renderPrompt();
  // options.js loads the stored profile asynchronously; refresh the preview once it lands.
  setTimeout(renderPrompt, 400);

  // Exposed for tests.
  globalThis.HasanifyAiBuilder = { buildPrompt, processReply, normalizeDate, extractProfileJson };
})();
