import { renderMarkdown } from './markdown.js';

const $ = (id) => document.getElementById(id);
const request = async (type, payload = {}) => {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? 'Request failed');
  return res.result;
};

const EFFORT_LABELS = { '': 'افتراضي الموديل', off: 'بدون تفكير', on: 'تفكير مفعّل', minimal: 'minimal', none: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'ultra' };
const FALLBACK_EFFORTS = { chatgpt: ['low', 'medium', 'high', 'xhigh'], reasoning_effort: ['off', 'low', 'medium', 'high'], glm: ['on', 'off'] };

const ui = { running: false, question: null, liveText: null, liveReasoning: null, steps: new Map() };
let settings = null;
let presets = {};
let models = [];

// ---------- chat ----------

const port = chrome.runtime.connect({ name: 'panel' });
port.onMessage.addListener(onEvent);

function onEvent(event) {
  switch (event.type) {
    case 'replay':
      $('messages').querySelectorAll('.msg, .step').forEach((n) => n.remove());
      ui.steps.clear();
      event.events.forEach(onEvent);
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
      node.innerHTML = `<h3>${event.success ? '✅ التقرير النهائي' : '⚠️ تقرير (المهمة لم تكتمل)'}</h3>${renderMarkdown(event.report)}`;
      break;
    }
    case 'error':
      add('msg error', event.message);
      break;
    case 'stopped':
      add('msg error', 'تم إيقاف المهمة.');
      break;
    case 'auth-changed':
      showAuth(event.status);
      $('deviceBox').hidden = true;
      loadModels();
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
  const node = document.createElement('div');
  node.className = className;
  node.dir = 'auto';
  node.textContent = text;
  $('messages').append(node);
  scrollDown();
  return node;
}

function addStep({ step, name, args }) {
  $('emptyState').hidden = true;
  const row = document.createElement('div');
  row.className = 'step';
  const compact = JSON.stringify(args ?? {}).replace(/^\{|\}$/g, '');
  row.innerHTML = '<span class="mark">…</span><span class="name"></span><span class="args"></span>';
  row.querySelector('.name').textContent = `${step}. ${name}`;
  row.querySelector('.args').textContent = compact;
  $('messages').append(row);
  ui.steps.set(step + name, row);
  scrollDown();
}

function setQuestion(question) {
  ui.question = question;
  add('msg ask', `❓ ${question}`);
  $('hint').textContent = 'الوكيل مستني ردك…';
  $('input').focus();
}

function setRunning(running) {
  ui.running = running;
  $('statusDot').classList.toggle('running', running);
  $('stopBtn').hidden = !running;
  if (!running) {
    ui.question = null;
    $('hint').textContent = '';
  } else if (!ui.question) {
    $('hint').textContent = 'جاري التنفيذ…';
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
    port.postMessage({ type: 'answer', text });
    ui.question = null;
    $('hint').textContent = 'جاري التنفيذ…';
  } else if (ui.running) {
    $('hint').textContent = 'استنى المهمة الحالية تخلص أو اضغط إيقاف.';
    return;
  } else {
    port.postMessage({ type: 'run', text });
  }
  $('input').value = '';
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
$('stopBtn').addEventListener('click', () => port.postMessage({ type: 'stop' }));
$('newChatBtn').addEventListener('click', () => {
  port.postMessage({ type: 'new-chat' });
  $('messages').querySelectorAll('.msg, .step').forEach((n) => n.remove());
  $('emptyState').hidden = false;
});
document.querySelectorAll('.examples li').forEach((li) => li.addEventListener('click', () => {
  $('input').value = li.textContent;
  $('input').focus();
}));

// ---------- settings ----------

$('settingsBtn').addEventListener('click', () => toggleSettings(true));
$('closeSettingsBtn').addEventListener('click', () => toggleSettings(false));

function toggleSettings(open) {
  $('settingsView').hidden = !open;
  $('chatView').hidden = open;
  $('settingsError').hidden = true;
}

async function init() {
  const data = await request('get-settings');
  settings = data.settings;
  presets = data.presets;
  $('preset').innerHTML = Object.entries(presets).map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('');
  fillForm();
  showAuth(await request('auth-status'));
  updateChip();
  if (!activeModel()) toggleSettings(true);
  loadModels();
}

function fillForm() {
  $('provider').value = settings.provider;
  $('preset').value = settings.compatible.preset;
  $('baseUrl').value = settings.compatible.baseUrl;
  $('apiKey').value = settings.compatible.apiKey;
  $('maxSteps').value = settings.maxSteps;
  $('vision').checked = settings.vision;
  $('allowJavascript').checked = settings.allowJavascript;
  $('modelInput').value = activeModel();
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
  next.maxSteps = Number($('maxSteps').value) || 40;
  next.vision = $('vision').checked;
  next.allowJavascript = $('allowJavascript').checked;
  return next;
}

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
  renderEfforts('');
});

$('modelSelect').addEventListener('change', () => {
  $('modelInput').value = $('modelSelect').value;
  const model = models.find((m) => m.id === $('modelSelect').value);
  renderEfforts(model?.defaultEffort ?? '');
});
$('modelInput').addEventListener('input', () => renderEfforts($('effort').value));
$('refreshModelsBtn').addEventListener('click', () => loadModels(true));

async function loadModels(showErrors = false) {
  const draft = readForm();
  if (draft.provider === 'chatgpt' && !(await request('auth-status')).connected) return;
  $('modelInfo').textContent = 'جاري تحميل الموديلات…';
  try {
    models = await request('list-models', { settings: draft });
    renderModels();
    if (!$('modelInput').value && models[0]) {
      $('modelInput').value = models[0].id;
      renderEfforts(models[0].defaultEffort ?? '');
    }
    $('modelInfo').textContent = `${models.length} موديل متاح`;
  } catch (err) {
    $('modelInfo').textContent = showErrors ? err.message : 'اكتب اسم الموديل يدويًا أو اضغط ↻';
  }
}

function renderModels() {
  const current = $('modelInput').value;
  $('modelSelect').innerHTML = '<option value="">— اختر من القائمة —</option>'
    + models.map((m) => `<option value="${escapeAttr(m.id)}">${escapeAttr(m.name)}</option>`).join('');
  if (models.some((m) => m.id === current)) $('modelSelect').value = current;
}

function renderEfforts(selected) {
  const provider = $('provider').value;
  const model = models.find((m) => m.id === $('modelInput').value.trim());
  const style = provider === 'chatgpt' ? 'chatgpt' : presets[$('preset').value]?.thinkingStyle ?? 'reasoning_effort';
  const levels = model?.efforts?.length ? model.efforts : FALLBACK_EFFORTS[style];
  const options = ['', ...levels];
  $('effort').innerHTML = options.map((e) => `<option value="${e}">${EFFORT_LABELS[e] ?? e}${model?.defaultEffort === e ? ' (افتراضي)' : ''}</option>`).join('');
  $('effort').value = options.includes(selected) ? selected : '';
}

function showAuth(status) {
  $('authStatus').textContent = status.connected
    ? `متصل: ${status.email ?? 'ChatGPT'}${status.planType ? ` — ${status.planType}` : ''}`
    : 'غير متصل';
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
    showSettingsError('اختر موديل الأول.');
    return;
  }
  settings = await request('save-settings', { settings: next });
  updateChip();
  toggleSettings(false);
});

function updateChip() {
  const p = currentProviderSettings();
  const label = settings.provider === 'chatgpt' ? 'ChatGPT' : presets[settings.compatible.preset]?.label ?? 'API';
  $('modelChip').textContent = p.model ? `${label} · ${p.model}${p.effort ? ` · ${p.effort}` : ''}` : 'لم يتم اختيار موديل';
}

function showSettingsError(message) {
  $('settingsError').textContent = message;
  $('settingsError').hidden = false;
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

init().catch((err) => showSettingsError(err.message));
