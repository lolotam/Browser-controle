// Background coordinator: owns the agent run, the browser controller and the
// provider session, and talks to the side panel over a long-lived port.

import { runAgent } from '../agent/agent.js';
import { buildSystemPrompt, describeTabContext } from '../agent/prompt.js';
import { createToolExecutor, toolDefinitions } from '../agent/tools.js';
import { BrowserController } from '../browser/controller.js';
import { askJev } from '../fast/jev-client.js';
import { createFastLayer } from '../fast/fast-layer.js';
import { COMPATIBLE_PRESETS, loadSettings, saveSettings } from '../lib/settings.js';
import * as chatgptAuth from '../providers/chatgpt-auth.js';
import { ChatgptSession, listChatgptModels } from '../providers/chatgpt.js';
import { CompatibleSession, listCompatibleModels } from '../providers/openai-compatible.js';

const browser = new BrowserController();
const ports = new Set();
const state = {
  session: null,
  sessionKey: null,
  abort: null,
  pendingQuestion: null,
  transcript: [],
  loginAbort: null,
};

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(installHeaderRules);
chrome.runtime.onStartup.addListener(installHeaderRules);

// Requests from an extension carry an Origin header the Codex backend does not
// expect from its CLI; strip it for the two OpenAI hosts this extension calls.
async function installHeaderRules() {
  const rules = [1, 2].map((id, i) => ({
    id,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: {
      urlFilter: ['||chatgpt.com/backend-api/codex', '||auth.openai.com/'][i],
      initiatorDomains: [chrome.runtime.id],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1, 2], addRules: rules });
}

function emit(event) {
  if (event.type !== 'text-delta' && event.type !== 'reasoning-delta') state.transcript.push(event);
  for (const port of ports) port.postMessage(event);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  ports.add(port);
  port.postMessage({ type: 'replay', events: state.transcript, running: Boolean(state.abort), question: state.pendingQuestion?.question ?? null });
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((msg) => {
    if (msg.type === 'run') startRun(msg.text);
    else if (msg.type === 'stop') state.abort?.abort();
    else if (msg.type === 'answer') answerQuestion(msg.text);
    else if (msg.type === 'new-chat') newChat();
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleRequest(msg).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: err.message }),
  );
  return true;
});

async function handleRequest(msg) {
  switch (msg.type) {
    case 'get-settings':
      return { settings: await loadSettings(), presets: COMPATIBLE_PRESETS };
    case 'save-settings':
      return saveSettings(msg.settings);
    case 'auth-status':
      return chatgptAuth.getAuthStatus();
    case 'auth-start':
      return startLogin();
    case 'auth-cancel':
      state.loginAbort?.abort();
      return null;
    case 'auth-import':
      await chatgptAuth.importCodexAuthJson(msg.text);
      return chatgptAuth.getAuthStatus();
    case 'auth-logout':
      await chatgptAuth.logout();
      return chatgptAuth.getAuthStatus();
    case 'jev-test': {
      const { answers, model } = await askJev({
        ...msg.config,
        state: { message: 'Hello, can you hear me?' },
        questions: { greeting: { type: 'noul', instructions: 'The message is a greeting or a connection check.' } },
      });
      return { model, noul: answers.greeting?.noul ?? null };
    }
    case 'list-models': {
      const settings = msg.settings ?? (await loadSettings());
      if (settings.provider === 'chatgpt') return listChatgptModels(settings.chatgpt.clientVersion);
      return listCompatibleModels(settings.compatible.baseUrl, settings.compatible.apiKey);
    }
    default:
      throw new Error(`Unknown request ${msg.type}`);
  }
}

async function startLogin() {
  state.loginAbort?.abort();
  const device = await chatgptAuth.startDeviceLogin();
  const controller = new AbortController();
  state.loginAbort = controller;
  await chrome.tabs.create({ url: device.verificationUrl, active: true });
  chatgptAuth.completeDeviceLogin(device, controller.signal).then(
    async () => {
      const status = await chatgptAuth.getAuthStatus();
      for (const port of ports) port.postMessage({ type: 'auth-changed', status });
    },
    (err) => {
      for (const port of ports) port.postMessage({ type: 'auth-error', message: err.message });
    },
  );
  return { userCode: device.userCode, verificationUrl: device.verificationUrl };
}

function newChat() {
  state.abort?.abort();
  state.session = null;
  state.sessionKey = null;
  state.transcript = [];
  browser.detachAll();
}

function createSession(settings) {
  const tools = toolDefinitions(settings);
  const systemPrompt = buildSystemPrompt(settings);
  if (settings.provider === 'chatgpt') {
    if (!settings.chatgpt.model) throw new Error('Choose a ChatGPT model in settings first.');
    return new ChatgptSession({ ...settings.chatgpt, systemPrompt, tools });
  }
  const c = settings.compatible;
  if (!c.model) throw new Error('Choose a model in settings first.');
  const preset = COMPATIBLE_PRESETS[c.preset] ?? COMPATIBLE_PRESETS.custom;
  return new CompatibleSession({ ...c, thinkingStyle: preset.thinkingStyle, systemPrompt, tools });
}

async function startRun(text) {
  if (state.abort) {
    emit({ type: 'error', message: 'A task is already running. Stop it first.' });
    return;
  }
  const abort = new AbortController();
  state.abort = abort;
  // Extension API calls reset the service worker idle timer while the model thinks.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  emit({ type: 'user', text });
  emit({ type: 'status', running: true });
  try {
    const settings = await loadSettings();
    const key = JSON.stringify([settings.provider, settings.chatgpt, settings.compatible, settings.vision, settings.allowJavascript]);
    if (!state.session || state.sessionKey !== key) {
      state.session = createSession(settings);
      state.sessionKey = key;
    }
    browser.tabId = null; // Each task starts on whatever tab the user is looking at now.
    const tab = await browser.currentTab().catch(() => null);
    const execute = createToolExecutor(browser, { askUser: (q) => askUser(q, abort.signal) });
    const fastLayer = settings.fast.enabled && settings.fast.apiKey
      ? createFastLayer({ config: settings.fast, browser, execute, task: text })
      : null;
    await runAgent({
      fastLayer,
      session: state.session,
      execute,
      task: text + describeTabContext(tab),
      maxSteps: Math.max(1, Number(settings.maxSteps) || 40),
      signal: abort.signal,
      emit,
    });
  } catch (err) {
    emit(err.name === 'AbortError' ? { type: 'stopped' } : { type: 'error', message: err.message });
  } finally {
    clearInterval(keepAlive);
    state.abort = null;
    state.pendingQuestion = null;
    await browser.detachAll();
    emit({ type: 'status', running: false });
  }
}

function askUser(question, signal) {
  return new Promise((resolve, reject) => {
    state.pendingQuestion = { question, resolve };
    emit({ type: 'ask', question });
    signal.addEventListener('abort', () => reject(new DOMException('Stopped by user', 'AbortError')), { once: true });
  });
}

function answerQuestion(text) {
  const pending = state.pendingQuestion;
  if (!pending) return;
  state.pendingQuestion = null;
  emit({ type: 'user', text });
  pending.resolve(text);
}
