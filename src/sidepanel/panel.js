import { renderMarkdown } from './markdown.js';
import { currentLanguage, resolveLanguage, setLanguage, t } from './i18n.js';
import { bindSearch, escapeAttr, pickModel, renderPicker } from './model-picker.js';
import { createKeyStore } from './key-store.js';
import { createProviderForm } from './provider-form.js';
import { FEEDBACK_FORM_ID, afterDismissal, afterRating, sendFeedback, shouldAskForRating } from '../lib/feedback.js';

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

// The panel shows one session; the port name tells the worker which.
// The worker can be stopped while the panel stays open, which closes the port,
// so it reconnects lazily on the next message instead of looping on restarts.
let port = null;
let sessionId = null;
let sessionList = [];

function connect() {
  port = chrome.runtime.connect({ name: `panel:${sessionId}` });
  port.onMessage.addListener(onEvent);
  port.onDisconnect.addListener(() => { port = null; });
}

function send(message) {
  if (!port) connect();
  port.postMessage(message);
}

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
      traceBlock().append(Object.assign(document.createElement('div'), { className: 'step handoff', textContent: `⚡→🧠 ${event.reason}` }));
      scrollDown();
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
      if (ui.replayed) askForRating(); // live finals only, not the history replayed on open
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
    case 'sessions-changed':
      refreshSessions();
      break;
    case 'session-missing':
      showTabSession();
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

/** Consecutive tool steps and fast-layer hand-overs share one trace block. */
function traceBlock() {
  $('emptyState').hidden = true;
  if (!ui.trace) {
    ui.trace = document.createElement('div');
    ui.trace.className = 'trace';
    $('messages').append(ui.trace);
  }
  return ui.trace;
}

function addStep({ step, name, args, fast }) {
  const row = document.createElement('div');
  row.className = fast ? 'step fast' : 'step';
  const compact = JSON.stringify(args ?? {}).replace(/^\{|\}$/g, '');
  row.innerHTML = '<span class="mark">…</span><span class="name"></span><span class="args"></span>';
  row.querySelector('.name').textContent = `${step}. ${name}`;
  row.querySelector('.args').textContent = compact;
  traceBlock().append(row);
  ui.steps.set(step + name, row);
  scrollDown();
}

function clearMessages() {
  $('messages').querySelectorAll('.msg, .trace').forEach((n) => n.remove());
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
$('newChatBtn').addEventListener('click', async () => {
  const meta = await request('session-create');
  await chooseSession(meta.id);
});
document.querySelectorAll('.examples li').forEach((li) => li.addEventListener('click', () => {
  $('input').value = li.textContent;
  $('input').focus();
}));

// ---------- sessions ----------

// The panel follows the tab the user is looking at: each tab has its own session,
// a new tab starts on a blank one, and a tab where a task ran keeps its session.
let windowId = null;
let tabLookups = 0;

async function startSessions() {
  windowId = (await chrome.windows.getCurrent()).id;
  // Opened as a page in a tab (as the e2e tests do), the panel is that tab's own
  // and must not jump to the session of whichever tab gets focus.
  const ownTab = await chrome.tabs.getCurrent();
  if (!ownTab) {
    chrome.tabs.onActivated.addListener((info) => {
      if (info.windowId === windowId) showTabSession(info.tabId).catch(() => {}); // the tab may close mid-lookup
    });
  }
  await showTabSession(ownTab?.id);
  await refreshSessions();
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab?.id;
}

async function showTabSession(tabId) {
  const lookup = ++tabLookups;
  const id = await request('tab-session', { tabId: tabId ?? (await activeTabId()) });
  if (lookup === tabLookups) await openSession(id); // a later tab switch wins
}

/** A session picked by the user (from the list, or a new one) becomes the current tab's. */
async function chooseSession(id) {
  tabLookups += 1; // a tab lookup still in flight must not replace the user's pick
  await request('bind-tab', { tabId: await activeTabId(), sessionId: id });
  await openSession(id);
}

async function openSession(id) {
  closeSessionMenu();
  if (id === sessionId && port) return;
  port?.disconnect();
  port = null;
  sessionId = id;
  ui.replayed = false;
  ui.running = false;
  clearMessages();
  $('emptyState').hidden = false;
  connect();
  renderSessionTitle();
}

async function refreshSessions() {
  sessionList = await request('sessions-list');
  renderSessionTitle();
  if (!$('sessionMenu').hidden) renderSessionList();
}

function sessionLabel(meta) {
  return meta?.title || t('session.untitled');
}

function renderSessionTitle() {
  $('sessionTitle').textContent = sessionLabel(sessionList.find((s) => s.id === sessionId));
}

function renderSessionList() {
  const query = $('sessionSearch').value.trim().toLowerCase();
  // Every open panel starts on an empty session; only the current one of those is worth listing.
  // A running session is always listed, so another tab can open it.
  const shown = sessionList
    .filter((s) => s.titled || s.running || s.id === sessionId)
    .filter((s) => !query || sessionLabel(s).toLowerCase().includes(query));
  $('sessionList').replaceChildren(...shown.map(sessionRow));
}

function sessionRow(meta) {
  const row = document.createElement('li');
  row.className = `session-item${meta.id === sessionId ? ' active' : ''}`;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(meta.id === sessionId));
  const dot = document.createElement('span');
  dot.className = `dot${meta.running ? ' running' : ''}`;
  dot.title = meta.running ? t('session.running') : '';
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'session-open';
  // <bdi> keeps an English title readable in the Arabic list without flipping the row's alignment.
  title.append(Object.assign(document.createElement('bdi'), { textContent: sessionLabel(meta) }));
  title.addEventListener('click', () => chooseSession(meta.id));
  const rename = iconButton(ICONS.rename, t('session.rename'), () => startRename(row, title, meta));
  const remove = iconButton(ICONS.remove, t('session.delete'), () => deleteSessionAsked(meta));
  row.append(dot, title, rename, remove);
  return row;
}

const ICONS = {
  close: 'M6 6l12 12M18 6L6 18',
  rename: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  remove: 'M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3',
};

function iconButton(path, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost icon';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  button.append(svg);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

function startRename(row, title, meta) {
  const input = document.createElement('input');
  input.value = meta.title;
  input.dir = 'auto';
  input.className = 'session-rename';
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() && input.value.trim() !== meta.title) await request('session-rename', { id: meta.id, title: input.value });
    await refreshSessions();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  title.replaceWith(input);
  input.focus();
  input.select();
}

async function deleteSessionAsked(meta) {
  if (!window.confirm(t('session.confirmDelete', { title: sessionLabel(meta) }))) return;
  await request('session-delete', { id: meta.id });
  if (meta.id === sessionId) await showTabSession();
  else await refreshSessions();
}

function toggleSessionMenu() {
  if ($('sessionMenu').hidden) {
    $('sessionMenu').hidden = false;
    $('sessionBtn').setAttribute('aria-expanded', 'true');
    $('sessionSearch').value = '';
    renderSessionList();
    refreshSessions();
    $('sessionSearch').focus();
  } else {
    closeSessionMenu();
  }
}

function closeSessionMenu() {
  $('sessionMenu').hidden = true;
  $('sessionBtn').setAttribute('aria-expanded', 'false');
}

$('sessionBtn').addEventListener('click', toggleSessionMenu);
$('sessionSearch').addEventListener('input', renderSessionList);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('sessionMenu').hidden) closeSessionMenu();
});
document.addEventListener('click', (e) => {
  if (!$('sessionMenu').hidden && !$('sessionMenu').contains(e.target) && !$('sessionBtn').contains(e.target)) closeSessionMenu();
});

// ---------- feedback and ratings ----------

const STORE_REVIEWS_URL = `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
// Store installs carry update_url; an unpacked copy has no store page to review.
const fromStore = Boolean(chrome.runtime.getManifest().update_url);
let feedbackRating = 0;

async function ratingState() {
  try {
    return (await chrome.storage.local.get('reviewPrompt')).reviewPrompt ?? {};
  } catch {
    return {};
  }
}

async function saveRatingState(change) {
  await chrome.storage.local.set({ reviewPrompt: change(await ratingState()) });
}

/** Five star buttons; picking one calls onPick(n) and lights the stars up to n. */
function starRow(onPick) {
  const row = document.createElement('div');
  row.className = 'stars';
  for (let n = 1; n <= 5; n += 1) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star';
    star.textContent = '★';
    star.setAttribute('aria-label', t('rate.star', { n }));
    star.addEventListener('click', () => {
      row.querySelectorAll('.star').forEach((s, i) => s.classList.toggle('on', i < n));
      onPick(n);
    });
    row.append(star);
  }
  return row;
}

function feedbackFields(message, rating, email = '') {
  return { message, rating, email, version: chrome.runtime.getManifest().version, language: currentLanguage() };
}

async function askForRating() {
  if (!shouldAskForRating(await ratingState())) return;
  const card = add('msg rate-card', '');
  const question = document.createElement('span');
  question.textContent = t('rate.question');
  const close = iconButton(ICONS.close, t('rate.dismiss'), async () => {
    card.remove();
    await saveRatingState(afterDismissal);
  });
  const head = document.createElement('div');
  head.className = 'row between';
  head.append(question, close);
  const body = document.createElement('div');
  body.className = 'fields';
  card.append(head, starRow((n) => rated(n, body, close)), body);
}

async function rated(stars, body, close) {
  close.remove();
  await saveRatingState(afterRating);
  if (stars === 5) {
    body.replaceChildren(textLine(t('rate.thanks')));
    if (fromStore) {
      const link = Object.assign(document.createElement('a'), { href: STORE_REVIEWS_URL, target: '_blank', rel: 'noopener', textContent: t('rate.store') });
      body.append(link);
    }
    if (FEEDBACK_FORM_ID) sendFeedback(feedbackFields('', 5)).catch(() => {}); // a bare 5★ is a nice-to-know, not worth an error
    return;
  }
  const text = Object.assign(document.createElement('textarea'), { rows: 3, dir: 'auto', placeholder: t('rate.better') });
  const status = Object.assign(document.createElement('small'), { className: 'muted' });
  const send = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: t('feedback.send') });
  send.addEventListener('click', () => submitFeedback({ message: text.value.trim(), rating: stars }, status, () => body.replaceChildren(textLine(t('feedback.sent')))));
  const actions = document.createElement('div');
  actions.className = 'row between';
  actions.append(status, send);
  body.replaceChildren(text, actions);
  text.focus();
}

function textLine(text) {
  return Object.assign(document.createElement('span'), { textContent: text });
}

async function submitFeedback({ message, rating, email = '' }, status, onSent) {
  if (!message && !rating) {
    status.textContent = t('feedback.empty');
    return;
  }
  if (!FEEDBACK_FORM_ID) {
    status.textContent = t('feedback.notConfigured');
    return;
  }
  status.textContent = t('feedback.sending');
  try {
    await sendFeedback(feedbackFields(message, rating, email));
    onSent();
  } catch (err) {
    status.textContent = `✗ ${err.message}`;
  }
}

function toggleFeedbackMenu() {
  const opening = $('feedbackMenu').hidden;
  closeSessionMenu();
  $('feedbackMenu').hidden = !opening;
  if (!opening) return;
  feedbackRating = 0;
  $('feedbackStars').replaceWith(Object.assign(starRow((n) => { feedbackRating = n; }), { id: 'feedbackStars' }));
  $('feedbackStatus').textContent = '';
  $('feedbackText').focus();
}

$('feedbackBtn').addEventListener('click', toggleFeedbackMenu);
$('feedbackSend').addEventListener('click', () => submitFeedback(
  { message: $('feedbackText').value.trim(), rating: feedbackRating, email: $('feedbackEmail').value.trim() },
  $('feedbackStatus'),
  () => {
    $('feedbackText').value = '';
    $('feedbackStatus').textContent = t('feedback.sent');
  },
));
document.addEventListener('click', (e) => {
  if (!$('feedbackMenu').hidden && !$('feedbackMenu').contains(e.target) && !$('feedbackBtn').contains(e.target)) $('feedbackMenu').hidden = true;
});

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
  renderSessionTitle();
  syncFastProvider();
  syncFastFallback();
}

// ---------- settings ----------

const keyStore = createKeyStore();
const mainForm = createProviderForm($('mainProvider'), { request, getPresets: () => presets, keyStore });
const fallbackForm = createProviderForm($('fallbackProvider'), { request, getPresets: () => presets, keyStore });
keyStore.register($('fastApiKey'), () => $('fastProvider').value);
keyStore.register($('fastFallbackApiKey'), () => $('fastFallbackProvider').value);

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
  // The fast layer and its backup offer the same decision providers.
  const fastOptions = Object.entries(fastPresets).map(([id, p]) => `<option value="${id}">${escapeAttr(p.label)}</option>`).join('');
  $('fastProvider').innerHTML = fastOptions;
  $('fastFallbackProvider').innerHTML = fastOptions;
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
  keyStore.load(settings.keys);
  mainForm.fill(settings);
  fallbackForm.fill(settings.fallback);
  $('fallbackEnabled').checked = settings.fallback.enabled;
  syncFallback();
  $('maxSteps').value = settings.maxSteps;
  $('vision').checked = settings.vision;
  $('allowJavascript').checked = settings.allowJavascript;
  $('replyLangEnabled').checked = settings.replyLanguage.enabled;
  $('replyLang').value = settings.replyLanguage.language;
  syncReplyLanguage();
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
  next.replyLanguage = { enabled: $('replyLangEnabled').checked, language: $('replyLang').value };
  next.keys = keyStore.snapshot();
  return next;
}

// Off: the agent follows the language of the task, so the choice is hidden.
function syncReplyLanguage() {
  $('replyLangField').hidden = !$('replyLangEnabled').checked;
}

$('replyLangEnabled').addEventListener('change', syncReplyLanguage);

function syncFallback() {
  $('fallbackProvider').hidden = !$('fallbackEnabled').checked;
}

$('fallbackEnabled').addEventListener('change', () => {
  syncFallback();
  if ($('fallbackEnabled').checked) fallbackForm.loadModels();
});

/** A provider saved before the list was limited to decision providers falls back to TypeSafe. */
function knownFastProvider(slot) {
  if (fastPresets[slot.provider]) return slot;
  const { baseUrl, model, minProb } = fastPresets.typesafe;
  return { ...slot, provider: 'typesafe', baseUrl, model, ...(slot.minProb !== undefined ? { minProb } : {}) };
}

function fillFastForm(saved) {
  const fast = { ...knownFastProvider(saved), fallback: knownFastProvider(saved.fallback) };
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

// Backups are decision providers only, so the base URL is the preset's.
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

// TypeSafe has no model list; the other decision providers list theirs.
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
  keyStore.show($('fastApiKey'), $('fastProvider').value);
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
  keyStore.show($('fastFallbackApiKey'), $('fastFallbackProvider').value);
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
    showFastStatus('', '');
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

$('exportBtn').addEventListener('click', async () => {
  try {
    const data = await request('backup-export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: `browser-agent-backup-${data.exportedAt.slice(0, 10)}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000); // revoking at once can cancel the download
    showBackupStatus('ok', t('backup.exported'));
  } catch (err) {
    showBackupStatus('fail', `✗ ${err.message}`);
  }
});
$('restoreBtn').addEventListener('click', () => $('restoreFile').click());
$('restoreFile').addEventListener('change', async () => {
  const [file] = $('restoreFile').files;
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    settings = await request('backup-import', { data });
    fillForm();
    updateChip();
    showAuth(await request('auth-status'));
    mainForm.loadModels();
    showBackupStatus('ok', t('backup.restored'));
  } catch (err) {
    showBackupStatus('fail', `✗ ${err instanceof SyntaxError ? t('backup.notJson') : err.message}`);
  } finally {
    $('restoreFile').value = '';
  }
});

function showBackupStatus(state, text) {
  $('backupResult').dataset.state = state;
  $('backupResult').textContent = text;
}

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
  if (next.replyLanguage.enabled && !next.replyLanguage.language) return 'err.pickReplyLanguage';
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

startSessions().catch((err) => showSettingsError(err.message));
init().catch((err) => showSettingsError(err.message));
