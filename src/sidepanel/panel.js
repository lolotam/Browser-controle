import { renderMarkdown } from './markdown.js';
import { currentLanguage, resolveLanguage, setLanguage, t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const request = async (type, payload = {}) => {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? t('err.request'));
  return res.result;
};

const TRANSLATED_EFFORTS = { '': 'effort.default', off: 'effort.off', on: 'effort.on' };
const FALLBACK_EFFORTS = { chatgpt: ['low', 'medium', 'high', 'xhigh'], reasoning_effort: ['off', 'low', 'medium', 'high'], glm: ['on', 'off'] };

const ui = { running: false, question: null, liveText: null, liveReasoning: null, trace: null, steps: new Map(), replayed: false };
let settings = null;
let presets = {};
let fastPresets = {};
let models = [];
let fastModels = [];
const CUSTOM_MODEL = '__custom__';
const loads = { main: 0, fast: 0 }; // newest request wins when lists load concurrently
let authStatus = { connected: false };

setLanguage(resolveLanguage('auto', chrome.i18n.getUILanguage()));

// ---------- chat ----------

// The worker can be stopped while the panel stays open, which closes this port.
// Reconnect lazily on the next message instead of looping on every restart.
let port = null;

function connect() {
  port = chrome.runtime.connect({ name: 'panel' });
  port.onMessage.addListener(onEvent);
  port.onDisconnect.addListener(() => { port = null; });
}

function send(message) {
  if (!port) connect();
  port.postMessage(message);
}

connect();

function onEvent(event) {
  switch (event.type) {
    case 'replay':
      // A restarted worker replays an empty transcript; keep what is on screen.
      if (!ui.replayed) {
        clearMessages();
        event.events.forEach(onEvent);
        ui.replayed = true;
      }
      setRunning(event.running);
      if (event.question) setQuestion(event.question);
      break;
    case 'status':
      setRunning(event.running);
      break;
    case 'user':
      add('msg user', event.text);
      break;
    case 'thinking':
      ui.liveText = null;
      ui.liveReasoning = null;
      break;
    case 'reasoning-delta':
      ui.liveReasoning ??= add('msg reasoning', '');
      ui.liveReasoning.textContent += event.delta;
      scrollDown();
      break;
    case 'text-delta':
      ui.liveText ??= add('msg assistant', '');
      ui.liveText.textContent += event.delta;
      scrollDown();
      break;
    case 'assistant-text':
      (ui.liveText ?? add('msg assistant', '')).innerHTML = renderMarkdown(event.text);
      ui.liveText = null;
      break;
    case 'tool-start':
      addStep(event);
      break;
    case 'fast-handoff':
      add('handoff', `⚡→🧠 ${event.reason}`);
      break;
    case 'tool-end': {
      const row = ui.steps.get(event.step + event.name);
      if (row) {
        row.classList.toggle('fail', !event.ok);
        row.querySelector('.mark').textContent = event.ok ? '✓' : '✗';
        row.title = event.summary;
      }
      break;
    }
    case 'ask':
      setQuestion(event.question);
      break;
    case 'final': {
      ui.liveText?.remove();
      ui.liveText = null;
      const node = add(`msg final${event.success ? '' : ' partial'}`, '');
      node.innerHTML = renderMarkdown(event.report);
      const heading = document.createElement('h3');
      heading.textContent = t(event.success ? 'report.final' : 'report.partial');
      node.prepend(heading);
      break;
    }
    case 'error':
      add('msg error', event.message);
      break;
    case 'stopped':
      add('msg error', t('msg.stopped'));
      break;
    case 'auth-error':
      $('deviceBox').hidden = true;
      showSettingsError(event.message);
      break;
    default:
      break;
  }
}

function add(className, text) {
  $('emptyState').hidden = true;
  ui.trace = null;
  const node = document.createElement('div');
  node.className = className;
  node.dir = 'auto';
  node.textContent = text;
  $('messages').append(node);
  scrollDown();
  return node;
}

/** Consecutive tool steps share one trace block. */
function addStep({ step, name, args, fast }) {
  $('emptyState').hidden = true;
  if (!ui.trace) {
    ui.trace = document.createElement('div');
    ui.trace.className = 'trace';
    $('messages').append(ui.trace);
  }
  const row = document.createElement('div');
  row.className = fast ? 'step fast' : 'step';
  const compact = JSON.stringify(args ?? {}).replace(/^\{|\}$/g, '');
  row.innerHTML = '<span class="mark">…</span><span class="name"></span><span class="args"></span>';
  row.querySelector('.name').textContent = `${step}. ${name}`;
  row.querySelector('.args').textContent = compact;
  ui.trace.append(row);
  ui.steps.set(step + name, row);
  scrollDown();
}

function clearMessages() {
  $('messages').querySelectorAll('.msg, .trace, .handoff').forEach((n) => n.remove());
  ui.steps.clear();
  ui.trace = null;
}

function setQuestion(question) {
  ui.question = question;
  add('msg ask', question);
  $('hint').textContent = t('status.waiting');
  $('sendBtn').hidden = false;
  $('input').focus();
}

function setRunning(running) {
  ui.running = running;
  $('statusDot').classList.toggle('running', running);
  $('stopBtn').hidden = !running;
  $('sendBtn').hidden = running && !ui.question;
  if (!running) {
    ui.question = null;
    $('hint').textContent = '';
  } else if (!ui.question) {
    $('hint').textContent = t('status.running');
  }
}

function scrollDown() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text) return;
  if (ui.question) {
    send({ type: 'answer', text });
    ui.question = null;
    $('hint').textContent = t('status.running');
    $('sendBtn').hidden = true;
  } else if (ui.running) {
    $('hint').textContent = t('status.busy');
    return;
  } else {
    send({ type: 'run', text });
  }
  $('input').value = '';
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
$('stopBtn').addEventListener('click', () => send({ type: 'stop' }));
$('newChatBtn').addEventListener('click', () => {
  send({ type: 'new-chat' });
  clearMessages();
  $('emptyState').hidden = false;
});
document.querySelectorAll('.examples li').forEach((li) => li.addEventListener('click', () => {
  $('input').value = li.textContent;
  $('input').focus();
}));

// ---------- language ----------

$('langBtn').addEventListener('click', async () => {
  const next = currentLanguage() === 'ar' ? 'en' : 'ar';
  applyLanguage(next);
  settings = await request('save-settings', { settings: { ...settings, uiLanguage: next } });
});

/** Static text is retranslated by setLanguage; text this file renders is redrawn here. */
function applyLanguage(language) {
  setLanguage(language);
  if (!settings) return;
  showAuth(authStatus);
  updateChip();
  renderModels();
  syncFastProvider();
  renderEfforts($('effort').value);
}

// ---------- settings ----------

$('settingsBtn').addEventListener('click', () => toggleSettings(true));
$('closeSettingsBtn').addEventListener('click', () => toggleSettings(false));

function toggleSettings(open) {
  $('settingsView').hidden = !open;
  $('chatView').hidden = open;
  $('settingsError').hidden = true;
  if (open) {
    loadModels();
    loadFastModels();
  }
}

async function init() {
  const data = await request('get-settings');
  settings = data.settings;
  presets = data.presets;
  fastPresets = data.fastPresets;
  setLanguage(resolveLanguage(settings.uiLanguage, chrome.i18n.getUILanguage()));
  $('preset').innerHTML = Object.entries(presets).map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('');
  $('fastProvider').innerHTML = Object.entries(fastPresets).map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('');
  fillForm();
  showAuth(await request('auth-status'));
  updateChip();
  if (!activeModel()) toggleSettings(true);
  loadModels();
  loadFastModels();
}

// Tokens land in storage even when the worker that polled for them was restarted
// and its port to this panel is gone, so storage is the reliable sign-in signal.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.chatgptAuth) return;
  showAuth(await request('auth-status'));
  if (changes.chatgptAuth.newValue) {
    $('deviceBox').hidden = true;
    loadModels();
  }
});

function fillForm() {
  $('provider').value = settings.provider;
  $('preset').value = settings.compatible.preset;
  $('baseUrl').value = settings.compatible.baseUrl;
  $('apiKey').value = settings.compatible.apiKey;
  $('maxSteps').value = settings.maxSteps;
  $('vision').checked = settings.vision;
  $('allowJavascript').checked = settings.allowJavascript;
  $('modelInput').value = activeModel();
  renderModels();
  fillFastForm(settings.fast);
  syncSections();
  renderEfforts(currentProviderSettings().effort);
}

function readForm() {
  const provider = $('provider').value;
  const next = structuredClone(settings);
  next.provider = provider;
  next.compatible.preset = $('preset').value;
  next.compatible.baseUrl = $('baseUrl').value.trim();
  next.compatible.apiKey = $('apiKey').value.trim();
  const target = provider === 'chatgpt' ? next.chatgpt : next.compatible;
  target.model = $('modelInput').value.trim();
  target.effort = $('effort').value;
  next.fast = readFastForm();
  next.maxSteps = Number($('maxSteps').value) || 40;
  next.vision = $('vision').checked;
  next.allowJavascript = $('allowJavascript').checked;
  return next;
}

function fillFastForm(fast) {
  $('fastEnabled').checked = fast.enabled;
  $('fastProvider').value = fast.provider;
  $('fastMode').value = fast.mode;
  $('fastApiKey').value = fast.apiKey;
  $('fastModel').value = fast.model;
  $('fastBaseUrl').value = fast.baseUrl;
  $('fastMinProb').value = fast.minProb;
  $('fastRiskyMax').value = fast.riskyMax;
  syncFast();
  syncFastProvider();
}

function readFastForm() {
  const provider = $('fastProvider').value;
  const preset = fastPresets[provider] ?? {};
  return {
    enabled: $('fastEnabled').checked,
    mode: $('fastMode').value,
    provider,
    apiKey: $('fastApiKey').value.trim(),
    model: $('fastModel').value.trim() || preset.model,
    baseUrl: $('fastBaseUrl').value.trim() || preset.baseUrl,
    minProb: Number($('fastMinProb').value) || preset.minProb,
    riskyMax: Number($('fastRiskyMax').value) || 0.3,
  };
}

function syncFast() {
  $('fastFields').hidden = !$('fastEnabled').checked;
}

// TypeSafe has no model list endpoint; every OpenAI-compatible provider does.
function syncFastProvider() {
  const listed = $('fastProvider').value !== 'typesafe';
  $('fastModelsBtn').hidden = !listed;
  $('fastModelSelect').hidden = !listed;
  if (listed) renderPicker($('fastModelSelect'), $('fastModel'), fastModels);
  else $('fastModel').hidden = false;
}

$('fastEnabled').addEventListener('change', syncFast);
$('fastProvider').addEventListener('change', () => {
  const preset = fastPresets[$('fastProvider').value];
  $('fastBaseUrl').value = preset.baseUrl;
  $('fastModel').value = preset.model;
  $('fastMinProb').value = preset.minProb;
  fastModels = [];
  syncFastProvider();
  loadFastModels();
});
$('fastModelsBtn').addEventListener('click', () => loadFastModels(true));
$('fastModelSelect').addEventListener('change', () => pickModel($('fastModelSelect'), $('fastModel')));

async function loadFastModels(showErrors = false) {
  const config = readFastForm();
  if (!config.enabled || config.provider === 'typesafe') return;
  const load = ++loads.fast;
  try {
    const list = await request('list-fast-models', { config });
    if (load !== loads.fast) return;
    fastModels = list;
    renderPicker($('fastModelSelect'), $('fastModel'), fastModels);
    $('fastTestResult').textContent = '';
  } catch (err) {
    if (load === loads.fast && showErrors) $('fastTestResult').textContent = `✗ ${err.message}`;
  }
}
$('fastTestBtn').addEventListener('click', async () => {
  $('fastTestResult').textContent = t('fast.testing');
  const started = performance.now();
  try {
    const { model } = await request('fast-test', { config: readFastForm() });
    $('fastTestResult').textContent = t('fast.testOk', { model, ms: Math.round(performance.now() - started) });
  } catch (err) {
    $('fastTestResult').textContent = `✗ ${err.message}`;
  }
});

function currentProviderSettings(s = settings) {
  return s.provider === 'chatgpt' ? s.chatgpt : s.compatible;
}

function activeModel() {
  return currentProviderSettings().model;
}

function syncSections() {
  const isChatgpt = $('provider').value === 'chatgpt';
  $('chatgptSection').hidden = !isChatgpt;
  $('compatibleSection').hidden = isChatgpt;
}

$('provider').addEventListener('change', () => {
  settings = readFormKeepingModel();
  $('modelInput').value = activeModel();
  fillFastForm(settings.fast);
  syncSections();
  models = [];
  renderModels();
  renderEfforts(currentProviderSettings().effort);
  loadModels();
});

// Switching provider must not copy one provider's model id into the other.
function readFormKeepingModel() {
  const next = readForm();
  const prevProvider = settings.provider;
  const prevTarget = prevProvider === 'chatgpt' ? next.chatgpt : next.compatible;
  const newTarget = next.provider === 'chatgpt' ? next.chatgpt : next.compatible;
  if (prevProvider !== next.provider) {
    prevTarget.model = $('modelInput').value.trim();
    prevTarget.effort = $('effort').value;
    newTarget.model = (next.provider === 'chatgpt' ? settings.chatgpt : settings.compatible).model;
    newTarget.effort = (next.provider === 'chatgpt' ? settings.chatgpt : settings.compatible).effort;
  }
  return next;
}

$('preset').addEventListener('change', () => {
  const preset = presets[$('preset').value];
  $('baseUrl').value = preset.baseUrl;
  $('modelInput').value = preset.model;
  models = [];
  renderModels();
  renderEfforts('');
  loadModels();
});

$('modelSelect').addEventListener('change', () => {
  pickModel($('modelSelect'), $('modelInput'));
  const model = models.find((m) => m.id === $('modelSelect').value);
  renderEfforts(model?.defaultEffort ?? '');
});
$('modelInput').addEventListener('input', () => renderEfforts($('effort').value));
$('refreshModelsBtn').addEventListener('click', () => loadModels(true));

async function loadModels(showErrors = false) {
  const draft = readForm();
  if (draft.provider === 'chatgpt' && !(await request('auth-status')).connected) return;
  const load = ++loads.main;
  $('modelInfo').textContent = t('model.loading');
  try {
    const list = await request('list-models', { settings: draft });
    if (load !== loads.main) return;
    models = list;
    if (!$('modelInput').value && models[0]) $('modelInput').value = models[0].id;
    renderModels();
    renderEfforts($('effort').value || (models.find((m) => m.id === $('modelInput').value)?.defaultEffort ?? ''));
    $('modelInfo').textContent = '';
  } catch (err) {
    if (load === loads.main) $('modelInfo').textContent = showErrors ? err.message : t('model.fallback');
  }
}

function renderModels() {
  renderPicker($('modelSelect'), $('modelInput'), models);
}

/**
 * One dropdown per model field. The id input is the saved value; it only shows
 * for "Other model" or while no list is available, so the model is never shown twice.
 */
function renderPicker(select, input, list) {
  const current = input.value.trim();
  const option = (m) => `<option value="${escapeAttr(m.id)}">${escapeAttr(m.name ?? m.id)}</option>`;
  const hidden = list.filter((m) => m.hidden);
  select.innerHTML = `<option value="" disabled>${escapeAttr(list.length ? t('model.pickCount', { n: list.length }) : t('model.pick'))}</option>`
    + list.filter((m) => !m.hidden).map(option).join('')
    + (hidden.length ? `<optgroup label="${escapeAttr(t('model.hiddenGroup'))}">${hidden.map(option).join('')}</optgroup>` : '')
    + `<option value="${CUSTOM_MODEL}">${escapeAttr(t('model.other'))}</option>`;
  const known = list.some((m) => m.id === current);
  select.value = known ? current : (current || !list.length ? CUSTOM_MODEL : '');
  input.hidden = select.value !== CUSTOM_MODEL;
}

function pickModel(select, input) {
  const custom = select.value === CUSTOM_MODEL;
  if (!custom) input.value = select.value;
  input.hidden = !custom;
  if (custom) input.focus();
}

function renderEfforts(selected) {
  const provider = $('provider').value;
  const model = models.find((m) => m.id === $('modelInput').value.trim());
  const style = provider === 'chatgpt' ? 'chatgpt' : presets[$('preset').value]?.thinkingStyle ?? 'reasoning_effort';
  const levels = model?.efforts?.length ? model.efforts : FALLBACK_EFFORTS[style];
  const options = ['', ...levels];
  $('effort').innerHTML = options.map((e) => `<option value="${e}">${TRANSLATED_EFFORTS[e] ? t(TRANSLATED_EFFORTS[e]) : e}${model?.defaultEffort === e ? t('effort.defaultMark') : ''}</option>`).join('');
  $('effort').value = options.includes(selected) ? selected : '';
}

function showAuth(status) {
  authStatus = status;
  $('authStatus').textContent = status.connected
    ? t('auth.connected', { who: `${status.email ?? 'ChatGPT'}${status.planType ? ` — ${status.planType}` : ''}` })
    : t('auth.disconnected');
  $('loginBtn').hidden = status.connected;
  $('logoutBtn').hidden = !status.connected;
}

$('loginBtn').addEventListener('click', async () => {
  $('settingsError').hidden = true;
  try {
    const { userCode, verificationUrl } = await request('auth-start');
    $('deviceCode').textContent = userCode;
    $('deviceLink').href = verificationUrl;
    $('deviceBox').hidden = false;
  } catch (err) {
    showSettingsError(err.message);
  }
});
$('cancelLoginBtn').addEventListener('click', async () => {
  await request('auth-cancel');
  $('deviceBox').hidden = true;
});
$('logoutBtn').addEventListener('click', async () => showAuth(await request('auth-logout')));
$('importBtn').addEventListener('click', async () => {
  try {
    showAuth(await request('auth-import', { text: $('authJson').value }));
    $('authJson').value = '';
    loadModels(true);
  } catch (err) {
    showSettingsError(err.message);
  }
});

$('saveBtn').addEventListener('click', async () => {
  const next = readForm();
  if (!currentProviderSettings(next).model) {
    showSettingsError(t('err.pickModel'));
    return;
  }
  if (next.fast.enabled && !next.fast.apiKey) {
    showSettingsError(t('err.fastKey'));
    return;
  }
  if (next.fast.enabled && !next.fast.baseUrl) {
    showSettingsError(t('err.fastUrl'));
    return;
  }
  settings = await request('save-settings', { settings: next });
  updateChip();
  toggleSettings(false);
});

function updateChip() {
  const p = currentProviderSettings();
  const label = settings.provider === 'chatgpt' ? 'ChatGPT' : presets[settings.compatible.preset]?.label ?? 'API';
  const fastTag = settings.fast.enabled && settings.fast.apiKey ? ' · ⚡' : '';
  $('modelChip').textContent = p.model ? `${label} · ${p.model}${p.effort ? ` · ${p.effort}` : ''}${fastTag}` : t('model.none');
}

function showSettingsError(message) {
  $('settingsError').textContent = message;
  $('settingsError').hidden = false;
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

init().catch((err) => showSettingsError(err.message));
