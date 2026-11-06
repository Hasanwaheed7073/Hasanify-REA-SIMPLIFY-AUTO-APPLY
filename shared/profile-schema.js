/**
 * Hasanify — Profile schema (shared)
 * ---------------------------------------------------------------------------
 * Loaded in BOTH contexts:
 *   • background.js via importScripts()  (classic service worker)
 *   • content scripts via manifest "js" array (runs before content.js)
 *
 * It exposes a single global: `globalThis.HasanifySchema`.
 *
 * Contents:
 *   1. PROFILE_JSON_SCHEMA  – a JSON-Schema (draft 2020-12) description of the profile.
 *   2. DEFAULT_PROFILE      – an empty profile that satisfies the schema.
 *   3. DEFAULT_SETTINGS     – extension behaviour toggles.
 *   4. mergeWithDefaults()  – deep-merge used for migrations / partial saves.
 *   5. validateProfile()    – tiny dependency-free validator for the subset of
 *                             JSON-Schema keywords used here.
 *
 * Conventions:
 *   • Dates are "YYYY-MM" (month precision is what ATS forms ask for). The one
 *     exception is preferences.earliestStartDate which may be "YYYY-MM-DD".
 *   • Booleans that can be "unanswered" are typed boolean|null. null = skip.
 *   • Diversity answers are free strings, matched fuzzily against whatever
 *     option labels the form offers. "Decline to self-identify" is understood
 *     by the matcher as any of the common decline variants.
 */
(() => {
  'use strict';
  if (globalThis.HasanifySchema) return; // guard against double injection

  const SCHEMA_VERSION = 1;
  const DECLINE = 'Decline to self-identify';

  // ---- Reusable schema fragments ------------------------------------------
  const str = { type: 'string' };
  const nullableBool = { type: ['boolean', 'null'] };
  const yearMonth = {
    type: 'string',
    pattern: '^(\\d{4}-(0[1-9]|1[0-2]))?$',
    description: 'YYYY-MM, or empty string when unknown',
  };
  const stringList = { type: 'array', items: str };

  // ---- 1. JSON Schema -----------------------------------------------------
  const PROFILE_JSON_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://hasanify.local/profile.schema.json',
    title: 'Hasanify Profile',
    type: 'object',
    required: ['schemaVersion', 'personal'],
    properties: {
      schemaVersion: { type: 'integer', const: SCHEMA_VERSION },

      personal: {
        type: 'object',
        required: ['firstName', 'lastName', 'email'],
        properties: {
          firstName: str,
          middleName: str,
          lastName: str,
          preferredName: str,
          pronouns: str,
          email: { type: 'string', format: 'email' },
          phone: str,               // national format, e.g. "4155550123"
          phoneCountryCode: str,    // e.g. "+1"
          address: {
            type: 'object',
            properties: {
              line1: str, line2: str, city: str, state: str, postalCode: str, country: str,
            },
          },
        },
      },

      links: {
        type: 'object',
        properties: {
          linkedin: str, github: str, portfolio: str, website: str, twitter: str,
          other: {
            type: 'array',
            items: { type: 'object', required: ['url'], properties: { label: str, url: str } },
          },
        },
      },

      // Ordered most-recent first. Index 0 is used for "current/most recent" questions.
      education: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            school: str, degree: str, fieldOfStudy: str, minor: str, gpa: str, location: str,
            startDate: yearMonth, endDate: yearMonth, current: { type: 'boolean' },
          },
        },
      },

      // Ordered most-recent first. Index 0 doubles as "current company/title".
      experience: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            company: str, title: str, location: str, employmentType: str,
            startDate: yearMonth, endDate: yearMonth, current: { type: 'boolean' },
            description: str,
          },
        },
      },

      skills: {
        type: 'object',
        properties: {
          technical: stringList,
          certifications: stringList,
          spokenLanguages: {
            type: 'array',
            items: { type: 'object', properties: { language: str, proficiency: str } },
          },
        },
      },

      workAuthorization: {
        type: 'object',
        properties: {
          authorizedToWork: nullableBool,     // "Are you legally authorized to work in …?"
          requiresSponsorship: nullableBool,  // "Will you now or in the future require sponsorship?"
          visaStatus: str,                    // e.g. "F-1 OPT", "H-1B", "Green Card", "Citizen"
          citizenship: str,
          securityClearance: str,
        },
      },

      preferences: {
        type: 'object',
        properties: {
          desiredSalary: str,
          salaryCurrency: str,
          noticePeriod: str,
          earliestStartDate: { type: 'string', pattern: '^(\\d{4}-\\d{2}(-\\d{2})?)?$' },
          willingToRelocate: nullableBool,
          over18: nullableBool,
          howDidYouHear: str,
        },
      },

      // Voluntary self-identification (EEO). Strings so "decline" is representable.
      diversity: {
        type: 'object',
        properties: {
          gender: str, transgender: str, sexualOrientation: str, race: str,
          hispanicOrLatino: str, veteranStatus: str, disabilityStatus: str,
        },
      },

      documents: {
        type: 'object',
        properties: {
          resume: {
            type: ['object', 'null'],
            properties: { fileName: str, mimeType: str, dataUrl: str }, // base64 data: URL
          },
          coverLetterText: str,
        },
      },

      // User-defined Q&A for anything the heuristics don't know about.
      // `question` is a phrase matched case-insensitively against the field's
      // label (or a regex source when isRegex is true).
      customAnswers: {
        type: 'array',
        items: {
          type: 'object',
          required: ['question', 'answer'],
          properties: {
            question: str, answer: str, isRegex: { type: 'boolean' },
            // Learned answers (captured from the user's own edits on applications)
            source: { type: 'string', enum: ['', 'manual', 'ai', 'learned'] },
            key: str,          // normalized question with the employer replaced by {company}
            kind: str,         // 'text' | 'choice'
            learnedFrom: str,  // hostname it was learned on
            updatedAt: { type: 'number' },
            // Job context the answer was given in (variants per context are kept):
            ctx: { type: 'object', properties: { site: str, seniority: str, remote: str, country: str } },
          },
        },
      },
    },
  };

  // ---- 2. Default (empty) profile ----------------------------------------
  const DEFAULT_PROFILE = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    personal: {
      firstName: '', middleName: '', lastName: '', preferredName: '', pronouns: '',
      email: '', phone: '', phoneCountryCode: '',
      address: { line1: '', line2: '', city: '', state: '', postalCode: '', country: '' },
    },
    links: { linkedin: '', github: '', portfolio: '', website: '', twitter: '', other: [] },
    education: [],
    experience: [],
    skills: { technical: [], certifications: [], spokenLanguages: [] },
    workAuthorization: {
      authorizedToWork: null, requiresSponsorship: null,
      visaStatus: '', citizenship: '', securityClearance: '',
    },
    preferences: {
      desiredSalary: '', salaryCurrency: 'USD', noticePeriod: '', earliestStartDate: '',
      willingToRelocate: null, over18: null, howDidYouHear: 'LinkedIn',
    },
    diversity: {
      gender: DECLINE, transgender: DECLINE, sexualOrientation: DECLINE, race: DECLINE,
      hispanicOrLatino: DECLINE, veteranStatus: DECLINE, disabilityStatus: DECLINE,
    },
    documents: { resume: null, coverLetterText: '' },
    customAnswers: [],
  });

  // ---- 3. Default settings ------------------------------------------------
  const DEFAULT_SETTINGS = Object.freeze({
    autoFillOnKnownATS: true,  // arm the MutationObserver automatically on ATS hosts
    overwriteExisting: false,  // never clobber values the user already typed
    highlightFields: true,     // outline fields Hasanify touched
    showWidget: true,          // floating in-page assistant on application pages
    resumeMode: 'auto',        // 'auto' attach saved | 'ask' choose per application | 'manual' never touch
    coverLetterMode: 'auto',   // 'auto' fill text boxes with saved letter | 'manual' leave to the user
    dailyGoal: 10,             // applications/day target shown in the side panel
    followUpDays: 7,           // tracker: suggest a follow-up this many days after applying
    learningMode: 'ask',       // 'ask' offer to save answers you type | 'auto' save silently | 'off'
    aiAssist: false,           // AI fallback for questions/options the rules can't resolve (needs an API key)
    preSubmitCheck: true,      // check required/uncertain fields and wrong company names before you submit
    knownAtsHosts: [
      'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'myworkdaysite.com', 'workday.com',
      'ashbyhq.com', 'smartrecruiters.com', 'icims.com', 'jobvite.com', 'bamboohr.com',
      'taleo.net', 'successfactors.com', 'workable.com', 'recruitee.com', 'breezy.hr',
      'applytojob.com', 'rippling.com', 'dover.com', 'teamtailor.com', 'personio.de',
    ],
  });

  // ---- 4. Deep merge -------------------------------------------------------
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /**
   * Returns a new object = defaults overlaid with `input`.
   *  • Objects merge recursively (so new schema keys get defaults on migration).
   *  • Arrays and primitives from `input` replace defaults wholesale.
   *  • Keys present in input but unknown to defaults are preserved.
   */
  function mergeWithDefaults(defaults, input) {
    if (!isPlainObject(input)) return structuredClone(defaults);
    const out = structuredClone(defaults);
    for (const [k, v] of Object.entries(input)) {
      out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeWithDefaults(out[k], v) : structuredClone(v);
    }
    return out;
  }

  // ---- 5. Minimal validator -----------------------------------------------
  const typeOf = (v) =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;

  function validate(schema, value, path, errors) {
    if (schema.type) {
      const allowed = [].concat(schema.type);
      const actual = typeOf(value);
      const ok = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
      if (!ok) {
        errors.push(`${path || '(root)'}: expected ${allowed.join('|')}, got ${actual}`);
        return;
      }
    }
    if ('const' in schema && value !== schema.const) errors.push(`${path}: must equal ${schema.const}`);
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
    if (typeof value === 'string') {
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: "${value}" does not match ${schema.pattern}`);
      if (schema.format === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push(`${path}: invalid email`);
    }
    if (isPlainObject(value)) {
      for (const req of schema.required ?? []) {
        if (!(req in value)) errors.push(`${path}.${req}: is required`);
      }
      for (const [k, sub] of Object.entries(schema.properties ?? {})) {
        if (k in value) validate(sub, value[k], path ? `${path}.${k}` : k, errors);
      }
    }
    if (Array.isArray(value) && schema.items) {
      value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`, errors));
    }
  }

  function validateProfile(profile) {
    const errors = [];
    validate(PROFILE_JSON_SCHEMA, profile, '', errors);
    return { valid: errors.length === 0, errors };
  }

  // ---- 6. Completeness (drives the progress ring in popup/dashboard/widget) --
  const COMPLETENESS_CHECKS = [
    ['First name', (p) => p.personal?.firstName],
    ['Last name', (p) => p.personal?.lastName],
    ['Email', (p) => p.personal?.email],
    ['Phone', (p) => p.personal?.phone],
    ['City', (p) => p.personal?.address?.city],
    ['Country', (p) => p.personal?.address?.country],
    ['LinkedIn', (p) => p.links?.linkedin],
    ['Education', (p) => p.education?.length],
    ['Experience', (p) => p.experience?.length],
    ['Skills', (p) => p.skills?.technical?.length],
    ['Work authorization', (p) => p.workAuthorization?.authorizedToWork != null],
    ['Sponsorship', (p) => p.workAuthorization?.requiresSponsorship != null],
    ['Resume', (p) => p.documents?.resume?.dataUrl],
  ];

  function computeCompleteness(profile) {
    const missing = COMPLETENESS_CHECKS.filter(([, test]) => !test(profile ?? {})).map(([label]) => label);
    const percent = Math.round(((COMPLETENESS_CHECKS.length - missing.length) / COMPLETENESS_CHECKS.length) * 100);
    return { percent, missing };
  }

  globalThis.HasanifySchema = Object.freeze({
    SCHEMA_VERSION,
    DECLINE,
    PROFILE_JSON_SCHEMA,
    DEFAULT_PROFILE,
    DEFAULT_SETTINGS,
    mergeWithDefaults,
    validateProfile,
    computeCompleteness,
  });
})();
