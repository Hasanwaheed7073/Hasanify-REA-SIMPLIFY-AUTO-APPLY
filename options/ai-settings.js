/**
 * Hasanify — AI assist settings (dashboard → Settings)
 * ---------------------------------------------------------------------------
 * Provider / model / API key for the optional AI fallback. The key is sent
 * once to the background (hasanify:aiSaveConfig) and never read back: the
 * page only learns whether a key exists and its last 4 characters.
 *
 * Runs after options.js and shares its globals ($, send, toast, settings).
 */
'use strict';

(() => {
  let cfg = null;
  const status = (text, kind = '') => {
    const el = $('#aiStatus');
    el.textContent = text;
    el.dataset.kind = kind;
  };

  function paint() {
    const sel = $('#aiProvider');
    if (!sel.options.length) {
      for (const p of cfg.providers) sel.append(new Option(p.label, p.id));
    }
    sel.value = cfg.provider;
    const def = cfg.providers.find((p) => p.id === sel.value)?.defaultModel ?? '';
    $('#aiModel').placeholder = def ? `${def} (default)` : 'Model name';
    $('#aiModel').value = cfg.model ?? '';
    $('#aiBaseUrl').value = cfg.baseUrl ?? '';
    $('#aiBaseRow').hidden = sel.value !== 'custom';
    $('#aiKey').value = '';
    $('#aiKey').placeholder = cfg.hasKey ? `Saved key ${cfg.keyHint} — paste a new one to replace it` : sel.value === 'custom' ? 'API key (optional for local models)' : 'Paste your API key';
    $('#aiClearKey').hidden = !cfg.hasKey;
    if (settings.aiAssist && !cfg.configured) status('AI assist is on — add an API key to use it', 'warn');
    else if (cfg.configured) status(`Ready · ${cfg.providers.find((p) => p.id === cfg.provider)?.label}`, 'ok');
    else status('');
  }

  async function load() {
    const res = await send('hasanify:aiGetConfig');
    if (res?.ok) { cfg = res.config; paint(); }
  }

  async function save(extra = {}) {
    const res = await send('hasanify:aiSaveConfig', {
      provider: $('#aiProvider').value,
      model: $('#aiModel').value,
      baseUrl: $('#aiBaseUrl').value,
      apiKey: $('#aiKey').value,
      ...extra,
    });
    if (!res?.ok) { toast(res?.error ?? 'Could not save', true); return false; }
    cfg = res.config;
    paint();
    return true;
  }

  $('#aiProvider').addEventListener('change', () => {
    const def = cfg.providers.find((p) => p.id === $('#aiProvider').value)?.defaultModel ?? '';
    $('#aiModel').value = '';
    $('#aiModel').placeholder = def ? `${def} (default)` : 'Model name';
    $('#aiBaseRow').hidden = $('#aiProvider').value !== 'custom';
  });
  $('#aiSave').addEventListener('click', async () => {
    if (await save()) toast('AI settings saved');
  });
  $('#aiClearKey').addEventListener('click', async () => {
    if (await save({ clearKey: true, apiKey: '' })) toast('API key removed');
  });
  $('#aiTest').addEventListener('click', async () => {
    if (!(await save())) return;
    status('Testing…');
    const res = await send('hasanify:aiTest');
    if (res?.ok) status('✓ Connected — the model answered', 'ok');
    else status(`✕ ${res?.error ?? 'No answer'}`, 'err');
  });
  // The aiAssist switch is bound by options.js; refresh the hint when it flips.
  document.querySelector('[data-setting="aiAssist"]')?.addEventListener('change', () => setTimeout(paint, 50));

  load();
})();
