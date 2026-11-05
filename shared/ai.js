/**
 * Hasanify — AI assist (runs in the background service worker only)
 * ---------------------------------------------------------------------------
 * Bring-your-own-key client for Anthropic (Claude), OpenAI, Google Gemini, or
 * any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter…).
 *
 * Used for two things the rules can't do:
 *   • understanding questions phrased in unexpected ways (#2)
 *   • choosing the right option when none matches the profile literally (#3)
 *
 * Safety rules:
 *   • The API key lives in chrome.storage.local under its own key and is read
 *     ONLY here. Content scripts never receive it.
 *   • The model gets the candidate's profile minus documents and EEO answers,
 *     and must answer strictly from it; unknown → null (field stays empty).
 *   • Choice answers are validated against the real option list by the
 *     content script; nothing invented is ever filled.
 *   • Results are cached per question+options and cleared when the profile changes.
 */
'use strict';

const AI_KEY = 'hasanify.ai';            // { provider, apiKey, model, baseUrl }
const AI_CACHE_KEY = 'hasanify.aiCache'; // { [hash]: { answer, confidence, at } }
const AI_CACHE_MAX = 600;
const AI_TIMEOUT_MS = 45000;

const AI_PROVIDERS = Object.freeze({
  anthropic: { label: 'Claude (Anthropic)', defaultModel: 'claude-haiku-5-5' },
  openai: { label: 'OpenAI', defaultModel: 'gpt-4.1-mini' },
  gemini: { label: 'Google Gemini', defaultModel: 'gemini-2.5-flash' },
  custom: { label: 'OpenAI-compatible (custom URL)', defaultModel: '' },
});

async function getAiConfig() {
  const { [AI_KEY]: c } = await chrome.storage.local.get(AI_KEY);
  return { provider: 'anthropic', apiKey: '', model: '', baseUrl: '', ...(c ?? {}) };
}

/** What extension pages may see: never the key itself. */
async function getAiPublicConfig() {
  const c = await getAiConfig();
  const p = AI_PROVIDERS[c.provider] ?? AI_PROVIDERS.anthropic;
  return {
    provider: c.provider, model: c.model, baseUrl: c.baseUrl, hasKey: !!c.apiKey,
    keyHint: c.apiKey ? `…${c.apiKey.slice(-4)}` : '', defaultModel: p.defaultModel,
    configured: !!(c.apiKey || (c.provider === 'custom' && c.baseUrl)),
    providers: Object.entries(AI_PROVIDERS).map(([id, v]) => ({ id, ...v })),
  };
}

async function saveAiConfig({ provider, apiKey, model, baseUrl, clearKey }) {
  const cur = await getAiConfig();
  const next = {
    provider: AI_PROVIDERS[provider] ? provider : cur.provider,
    model: String(model ?? cur.model ?? '').trim(),
    baseUrl: String(baseUrl ?? cur.baseUrl ?? '').trim().replace(/\/+$/, ''),
    // An empty key field means "keep the saved key" unless clearKey is set.
    apiKey: clearKey ? '' : (String(apiKey ?? '').trim() || cur.apiKey),
  };
  await chrome.storage.local.set({ [AI_KEY]: next });
  await clearAiCache();
  return { ok: true, config: await getAiPublicConfig() };
}

const clearAiCache = () => chrome.storage.local.remove(AI_CACHE_KEY);

// ---- Provider calls ---------------------------------------------------------

async function fetchJson(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const msg = data?.error?.message ?? data?.error ?? text.slice(0, 200);
      throw new Error(`${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The AI provider took too long to answer');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** One system+user exchange → the model's text. */
async function callModel(system, user, { maxTokens = 2000 } = {}) {
  const c = await getAiConfig();
  const model = c.model || AI_PROVIDERS[c.provider]?.defaultModel;
  if (c.provider !== 'custom' && !c.apiKey) throw new Error('No API key set — add one in Hasanify → Settings → AI assist');

  if (c.provider === 'anthropic') {
    const data = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': c.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: 'user', content: user }] }),
    });
    return (data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  if (c.provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const data = await fetchJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': c.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
      }),
    });
    return (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  }

  // OpenAI and OpenAI-compatible endpoints
  const base = c.provider === 'custom' ? c.baseUrl : 'https://api.openai.com/v1';
  if (!base) throw new Error('Set the base URL of your OpenAI-compatible endpoint');
  if (!model) throw new Error('Set a model name');
  const data = await fetchJson(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
    body: JSON.stringify({
      model, temperature: 0, max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  return data?.choices?.[0]?.message?.content ?? '';
}

/** First JSON value in a model reply (tolerates ```json fences and chatter). */
function parseModelJson(text) {
  const t = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const a = t.indexOf(open), b = t.lastIndexOf(close);
    if (a !== -1 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch { /* try the other shape */ }
    }
  }
  return null;
}

// ---- Question resolution ------------------------------------------------------

/** The facts the model may use: no files, no EEO answers, no ids. */
function profileFacts(profile) {
  const { documents, diversity, customAnswers, ...rest } = profile;
  const learned = (customAnswers ?? [])
    .filter((c) => c?.question && c.answer)
    .slice(-120)
    .map((c) => ({ q: c.question, a: c.answer, ...(c.ctx?.seniority ? { forRole: `${c.ctx.seniority}/${c.ctx.remote}` } : {}) }));
  return { ...rest, previousAnswers: learned };
}

const SYSTEM_PROMPT = `You fill in job application forms on behalf of a candidate.
You get the candidate's profile (JSON) and a list of form questions. Answer each question ONLY from facts in the profile or the candidate's previous answers. Never guess personal facts.

Rules:
- If the profile does not let you answer with confidence, answer null.
- For questions with "options": the answer MUST be copied exactly from the options (for "multi": true, an array of exact options). Pick the option that is true for this candidate: e.g. for "Years of experience" compute from the work history dates and choose the range that contains it; treat "BSc Computer Science" as a Bachelor's degree; "authorized to work" follows workAuthorization.
- For free-text questions, give a short factual value (a number, a date, a name, a URL), never an essay.
- Never answer questions about disability, race, ethnicity, gender, sexuality, veteran status or criminal history unless the profile contains that exact fact; otherwise null.
- "confidence" is 0..1: how sure you are that the answer is correct for this candidate.

Reply with JSON only: {"answers":[{"id":<id>,"answer":<string|array|null>,"confidence":<number>}]}`;

function hashKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * items: [{ id, question, kind, options[], multi, required }]
 * job:   { title, company, seniority, remote, country }
 * → { ok, answers: [{ id, answer, confidence }] }
 */
async function resolveQuestions(items, job, profile) {
  const cfg = await getAiPublicConfig();
  if (!cfg.configured) return { ok: false, error: 'AI assist is on but no API key is set' };
  const list = (items ?? []).slice(0, 25).map((q) => ({
    id: q.id, question: String(q.question ?? '').slice(0, 300), kind: q.kind,
    ...(q.options?.length ? { options: q.options.map((o) => String(o).slice(0, 160)).slice(0, 80) } : {}),
    ...(q.multi ? { multi: true } : {}),
  }));

  // Cache: same question + same options → same answer (until the profile changes).
  const { [AI_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(AI_CACHE_KEY);
  const keyOf = (q) => hashKey(`${q.question.toLowerCase()}|${q.kind}|${(q.options ?? []).join('|').toLowerCase()}`);
  const answers = [];
  const ask = [];
  for (const q of list) {
    const hit = cache[keyOf(q)];
    if (hit) answers.push({ id: q.id, answer: hit.answer, confidence: hit.confidence, cached: true });
    else ask.push(q);
  }

  if (ask.length) {
    const user = JSON.stringify({
      job: { title: job?.title ?? '', company: job?.company ?? '', seniority: job?.seniority ?? '', workplace: job?.remote ?? '', country: job?.country ?? '' },
      today: new Date().toISOString().slice(0, 10),
      profile: profileFacts(profile),
      questions: ask,
    });
    const text = await callModel(SYSTEM_PROMPT, user);
    const parsed = parseModelJson(text);
    const got = Array.isArray(parsed) ? parsed : parsed?.answers;
    if (!Array.isArray(got)) return { ok: false, error: 'The AI reply was not understood' };
    for (const q of ask) {
      const a = got.find((x) => x?.id === q.id);
      const answer = a?.answer ?? null;
      const confidence = Math.max(0, Math.min(1, Number(a?.confidence) || 0));
      cache[keyOf(q)] = { answer, confidence, at: Date.now() };
      answers.push({ id: q.id, answer, confidence });
    }
    const keys = Object.keys(cache);
    if (keys.length > AI_CACHE_MAX) {
      keys.sort((x, y) => cache[x].at - cache[y].at).slice(0, keys.length - AI_CACHE_MAX).forEach((k) => delete cache[k]);
    }
    await chrome.storage.local.set({ [AI_CACHE_KEY]: cache });
  }
  // Low-confidence answers are dropped: an empty field beats a wrong one.
  return { ok: true, answers: answers.filter((a) => a.answer != null && a.answer !== '' && a.confidence >= 0.5) };
}

/** Settings → "Test connection". */
async function testAi() {
  const text = await callModel('Reply with JSON only.', 'Reply exactly {"ok":true}', { maxTokens: 20 });
  return parseModelJson(text)?.ok === true ? { ok: true } : { ok: false, error: `Unexpected reply: ${String(text).slice(0, 80)}` };
}
