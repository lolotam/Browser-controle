import { renderMarkdown } from './markdown.js';
import { currentLanguage, resolveLanguage, setLanguage, t } from './i18n.js';
import { bindSearch, escapeAttr, pickModel, renderPicker } from './model-picker.js';
import { createProviderForm } from './provider-form.js';

const $ = (id) => document.getElementById(id);
const request = async (type, payload = {}) => {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? t('err.request'));
  return res.result;
};

const ui = { running: false, question: null, liveText: null, liveReasoning: null, trace: null, steps: new Map(), replayed: false, notices: [] };
const MAX_NOTICES = 3;
let settings = null;
let presets = {};
let fastPresets = {};
let fastModels = [];
let fastFallbackModels = [];
const loads = { fast: 0, fastFallback: 0 }; // newest request wins when lists load concurrently
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
    case 'notice':
      ui.notices.push(event);
      renderNotices();
      break;
    case 'notice-dismissed':
      ui.notices = ui.notices.filter((n) => n.id !== event.id);
      renderNotices();
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
  ui.notices = [];
  renderNotices();
}

const NOTICE_TEXT = { switched: 'notice.switched', 'both-failed': 'notice.bothFailed', 'fast-switched': 'notice.fastSwitched' };

/** Newest first; the full provider error is in the tooltip. */
function renderNotices() {
  $('notices').replaceChildren(...ui.notices.slice(-MAX_NOTICES).reverse().map((notice) => {
    const reason = notice.code && notice.code !== 'other' ? t(`failure.${notice.code}`) : notice.reason;
    const row = document.createElement('div');
    row.className = `notice ${notice.level}`;
    row.title = notice.detail ?? '';
    row.dir = 'auto';
    const text = document.createElement('span');
    text.textContent = `⚠ ${t(NOTICE_TEXT[notice.kind] ?? 'notice.switched', { from: notice.from ?? '', to: notice.to ?? '', reason })}`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ghost icon';
    close.textContent = '×';
    close.setAttribute('aria-label', t('notice.dismiss'));
    close.addEventListener('click', () => send({ type: 'dismiss-notice', id: notice.id }));
    row.append(text, close);
    return row;
  }));
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
  mainForm.rerender();
  fallbackForm.rerender();
  renderNotices();
  syncFastProvider();
  syncFastFallback();
}

// ---------- settings ----------

const mainForm = createProviderForm($('mainProvider'), { request, getPresets: () => presets });
const fallbackForm = createProviderForm($('fallbackProvider'), { request, getPresets: () => presets });

$('settingsBtn').addEventListener('click', () => toggleSettings(true));
$('closeSettingsBtn').addEventListener('click', () => toggleSettings(false));

function toggleSettings(open) {
  $('settingsView').hidden = !open;
  $('chatView').hidden = open;
  $('settingsError').hidden = true;
  if (open) {
    mainForm.loadModels();
    if ($('fallbackEnabled').checked) fallbackForm.loadModels();
    loadFastModels();
    loadFastFallbackModels();
  }
}

async function init() {
  const data = await request('get-settings');
  settings = data.settings;
  presets = data.presets;
  fastPresets = data.fastPresets;
  setLanguage(resolveLanguage(settings.uiLanguage, chrome.i18n.getUILanguage()));
  $('fastProvider').innerHTML = Object.entries(fastPresets).map(([id, p]) => `<option value="${id}">${escapeAttr(p.label)}</option>`).join('');
  $('fastFallbackProvider').innerHTML = Object.entries(fastPresets).filter(([, p]) => p.decision)
    .map(([id, p]) => `<option value="${id}">${escapeAttr(p.label)}</option>`).join('');
  fillForm();
  showAuth(await request('auth-status'));
  updateChip();
  if (!activeModel()) toggleSettings(true);
  mainForm.loadModels();
  loadFastModels();
}

// Tokens land in storage even when the worker that polled for them was restarted
// and its port to this panel is gone, so storage is the reliable sign-in signal.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.chatgptAuth) return;
  showAuth(await request('auth-status'));
  if (changes.chatgptAuth.newValue) {
    $('deviceBox').hidden = true;
    mainForm.loadModels();
  }
});

function fillForm() {
  mainForm.fill(settings);
  fallbackForm.fill(settings.fallback);
  $('fallbackEnabled').checked = settings.fallback.enabled;
  syncFallback();
  $('maxSteps').value = settings.maxSteps;
  $('vision').checked = settings.vision;
  $('allowJavascript').checked = settings.allowJavascript;
  fillFastForm(settings.fast);
}

function readForm() {
  const next = structuredClone(settings);
  Object.assign(next, mainForm.read());
  next.fallback = { ...fallbackForm.read(), enabled: $('fallbackEnabled').checked };
  next.fast = readFastForm();
  next.maxSteps = Number($('maxSteps').value) || 40;
  next.vision = $('vision').checked;
  next.allowJavascript = $('allowJavascript').checked;
  return next;
}

function syncFallback() {
  $('fallbackProvider').hidden = !$('fallbackEnabled').checked;
}

$('fallbackEnabled').addEventListener('change', () => {
  syncFallback();
  if ($('fallbackEnabled').checked) fallbackForm.loadModels();
});

function fillFastForm(fast) {
  $('fastEnabled').checked = fast.enabled;
  $('fastProvider').value = fast.provider;
  $('fastMode').value = fast.mode;
  $('fastApiKey').value = fast.apiKey;
  $('fastModel').value = fast.model;
  $('fastBaseUrl').value = fast.baseUrl;
  $('fastMinProb').value = fast.minProb;
  $('fastRiskyMax').value = fast.riskyMax;
  $('fastFallbackEnabled').checked = fast.fallback.enabled;
  $('fastFallbackProvider').value = fast.fallback.provider;
  $('fastFallbackApiKey').value = fast.fallback.apiKey;
  $('fastFallbackModel').value = fast.fallback.model;
  syncFast();
  syncFastProvider();
  syncFastFallback();
}

function readFastForm() {
  const provider = $('fastProvider').value;
  const preset = fastPresets[provider] ?? {};
  const model = $('fastModel').value.trim() || preset.model;
  return {
    enabled: $('fastEnabled').checked,
    mode: $('fastMode').value,
    provider,
    decision: isDecisionModel(provider, model),
    apiKey: $('fastApiKey').value.trim(),
    model,
    baseUrl: $('fastBaseUrl').value.trim() || preset.baseUrl,
    minProb: Number($('fastMinProb').value) || preset.minProb,
    riskyMax: Number($('fastRiskyMax').value) || 0.3,
    fallback: readFastFallback(),
  };
}

// Backups are decision providers only (TypeSafe or Vercel), so the base URL is the preset's.
function readFastFallback() {
  const provider = $('fastFallbackProvider').value;
  const preset = fastPresets[provider] ?? {};
  return {
    enabled: $('fastFallbackEnabled').checked,
    provider,
    baseUrl: preset.baseUrl,
    apiKey: $('fastFallbackApiKey').value.trim(),
    model: $('fastFallbackModel').value.trim() || preset.model,
    decision: true,
  };
}

// The fast list only holds decision models; a typed id counts as one when it is
// the preset's default (list not loaded yet) or was saved as one before.
function isDecisionModel(provider, model) {
  if (fastModels.some((m) => m.id === model)) return true;
  const preset = fastPresets[provider] ?? {};
  if (model === preset.model) return Boolean(preset.decision);
  return settings.fast.provider === provider && settings.fast.model === model && Boolean(settings.fast.decision);
}

function syncFast() {
  $('fastFields').hidden = !$('fastEnabled').checked;
}

// TypeSafe has no model list endpoint; every OpenAI-compatible provider does.
function syncFastProvider() {
  syncListedPicker($('fastProvider').value, fastPickerEls(), fastModels);
}

function syncFastFallback() {
  $('fastFallbackFields').hidden = !$('fastFallbackEnabled').checked;
  syncListedPicker($('fastFallbackProvider').value, fastFallbackPickerEls(), fastFallbackModels);
}

const fastPickerEls = () => ({ select: $('fastModelSelect'), input: $('fastModel'), search: $('fastModelSearch'), refresh: $('fastModelsBtn') });
const fastFallbackPickerEls = () => ({ select: $('fastFallbackModelSelect'), input: $('fastFallbackModel'), search: $('fastFallbackModelSearch'), refresh: $('fastFallbackModelsBtn') });

function syncListedPicker(provider, els, list) {
  const listed = provider !== 'typesafe';
  els.refresh.hidden = !listed;
  els.select.hidden = !listed;
  if (listed) renderPicker(els.select, els.input, list, els.search);
  else {
    els.input.hidden = false;
    els.search.hidden = true;
  }
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
bindSearch($('fastModelSearch'), $('fastModelSelect'), () => fastModels, syncFastProvider);
$('fastModelSelect').addEventListener('change', () => pickModel($('fastModelSelect'), $('fastModel')));

$('fastFallbackEnabled').addEventListener('change', () => {
  syncFastFallback();
  loadFastFallbackModels();
});
$('fastFallbackProvider').addEventListener('change', () => {
  $('fastFallbackModel').value = fastPresets[$('fastFallbackProvider').value].model;
  fastFallbackModels = [];
  syncFastFallback();
  loadFastFallbackModels();
});
$('fastFallbackModelsBtn').addEventListener('click', () => loadFastFallbackModels(true));
bindSearch($('fastFallbackModelSearch'), $('fastFallbackModelSelect'), () => fastFallbackModels, syncFastFallback);
$('fastFallbackModelSelect').addEventListener('change', () => pickModel($('fastFallbackModelSelect'), $('fastFallbackModel')));

async function loadFastModels(showErrors = false) {
  const config = readFastForm();
  if (!config.enabled || config.provider === 'typesafe') return;
  const load = ++loads.fast;
  try {
    const list = await request('list-fast-models', { config });
    if (load !== loads.fast) return;
    fastModels = list;
    syncFastProvider();
    showFastStatus('', list.length ? '' : t('fast.noDecisionModels'));
  } catch (err) {
    if (load === loads.fast && showErrors) showFastStatus('fail', `✗ ${err.message}`);
  }
}

async function loadFastFallbackModels(showErrors = false) {
  const config = readFastFallback();
  if (!$('fastEnabled').checked || !config.enabled || config.provider === 'typesafe') return;
  const load = ++loads.fastFallback;
  try {
    const list = await request('list-fast-models', { config });
    if (load !== loads.fastFallback) return;
    fastFallbackModels = list;
    syncFastFallback();
  } catch (err) {
    if (load === loads.fastFallback && showErrors) showFastStatus('fail', `✗ ${err.message}`);
  }
}

/** state: 'ok' (green), 'fail' (red) or '' (neutral); the button and the message share it. */
function showFastStatus(state, text) {
  $('fastTestBtn').dataset.state = state;
  $('fastTestResult').dataset.state = state;
  $('fastTestResult').textContent = text;
}

// A pass or fail describes the settings that were tested; editing them makes it stale.
['input', 'change'].forEach((type) => $('fastFields').addEventListener(type, (e) => {
  if (e.target !== $('fastTestBtn') && $('fastTestBtn').dataset.state) showFastStatus('', '');
}));

$('fastTestBtn').addEventListener('click', async () => {
  showFastStatus('', t('fast.testing'));
  const started = performance.now();
  try {
    const { model } = await request('fast-test', { config: readFastForm() });
    showFastStatus('ok', t('fast.testOk', { model, ms: Math.round(performance.now() - started) }));
  } catch (err) {
    showFastStatus('fail', `✗ ${err.message}`);
  }
});

function currentProviderSettings(s = settings) {
  return s.provider === 'chatgpt' ? s.chatgpt : s.compatible;
}

function activeModel() {
  return currentProviderSettings().model;
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
    mainForm.loadModels(true);
  } catch (err) {
    showSettingsError(err.message);
  }
});

$('saveBtn').addEventListener('click', async () => {
  const next = readForm();
  const problem = settingsProblem(next);
  if (problem) {
    showSettingsError(t(problem));
    return;
  }
  settings = await request('save-settings', { settings: next });
  updateChip();
  toggleSettings(false);
});

/** The i18n key of the first thing that blocks saving, or null. */
function settingsProblem(next) {
  if (!currentProviderSettings(next).model) return 'err.pickModel';
  if (next.fallback.enabled && !currentProviderSettings(next.fallback).model) return 'err.fallbackModel';
  if (next.fast.enabled && !next.fast.apiKey) return 'err.fastKey';
  if (next.fast.enabled && !next.fast.baseUrl) return 'err.fastUrl';
  if (next.fast.enabled && next.fast.fallback.enabled && !next.fast.fallback.apiKey) return 'err.fastFallbackKey';
  return null;
}

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

init().catch((err) => showSettingsError(err.message));
