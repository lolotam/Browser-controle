// Background coordinator: routes each side panel to its session's runner,
// answers settings and model-list requests, and owns the ChatGPT sign-in.

import { SessionRunner } from './session-runner.js';
import { testProviderSlot } from '../agent/model-session.js';
import { fastClientFor } from '../fast/clients.js';
import { exportBackup, importBackup } from '../lib/backup.js';
import { COMPATIBLE_PRESETS, FAST_PRESETS, chatModelsFor, loadSettings, saveSettings } from '../lib/settings.js';
import * as chatgptAuth from '../providers/chatgpt-auth.js';
import { listChatgptModels } from '../providers/chatgpt.js';
import { listCompatibleModels } from '../providers/openai-compatible.js';
import * as store from '../sessions/store.js';
import * as tabSessions from '../sessions/tab-sessions.js';
import { afterGoogleSignIn, backUpToDrive, restoreFromDrive } from '../lib/drive-backup.js';
import { googleAccount } from '../lib/google-account.js';

const GROUP_COLORS = ['cyan', 'blue', 'green', 'yellow', 'purple', 'pink', 'orange', 'red'];
const runners = new Map(); // sessionId → SessionRunner
const loading = new Map(); // sessionId → Promise<SessionRunner>
const panels = new Set(); // every open panel port, for list updates and sign-in errors
// Blank sessions handed to a panel that has not connected yet; two panels opening
// at once must not both get the same one.
const reserved = new Set();
const RESERVATION_MS = 10000;
const DRIVE_BACKUP_DELAY_MS = 3000; // one upload for a burst of changes (a save writes several keys)
let driveBackupTimer = null;
let loginAbort = null;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(installHeaderRules);
chrome.runtime.onStartup.addListener(installHeaderRules);
chrome.tabs.onRemoved.addListener((tabId) => tabSessions.unbindTab(tabId));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.settings || changes.chatgptAuth)) return;
  clearTimeout(driveBackupTimer);
  driveBackupTimer = setTimeout(async () => {
    if (await googleAccount()) await backUpToDrive();
  }, DRIVE_BACKUP_DELAY_MS);
});

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

async function runnerFor(sessionId) {
  if (runners.has(sessionId)) return runners.get(sessionId);
  if (!loading.has(sessionId)) {
    loading.set(sessionId, store.loadSession(sessionId).then((loaded) => {
      if (!loaded?.meta) throw new Error('This session no longer exists.');
      const runner = new SessionRunner({
        meta: loaded.meta,
        body: loaded,
        color: GROUP_COLORS[runners.size % GROUP_COLORS.length],
        isTakenByOther,
        onSessionsChanged: broadcastSessions,
      });
      runners.set(sessionId, runner);
      return runner;
    }).finally(() => loading.delete(sessionId)));
  }
  return loading.get(sessionId);
}

/** The title of another session that is running a task in this tab's group, or null. */
function isTakenByOther(selfId, tab) {
  if (tab.groupId === undefined || tab.groupId < 0) return null;
  for (const runner of runners.values()) {
    if (runner.id !== selfId && runner.running && runner.browser.groupId === tab.groupId) return runner.title || 'another session';
  }
  return null;
}

function broadcastSessions() {
  for (const port of panels) port.postMessage({ type: 'sessions-changed' });
}

chrome.runtime.onConnect.addListener((port) => {
  const [kind, sessionId] = port.name.split(':');
  if (kind !== 'panel' || !sessionId) return;
  panels.add(port);
  reserved.delete(sessionId);
  port.onDisconnect.addListener(() => panels.delete(port));
  // A panel whose port closed when the worker stopped reconnects as it sends, so
  // its task arrives while the session is still loading; it waits for the runner
  // instead of being dropped.
  const early = [];
  const hold = (msg) => early.push(msg);
  port.onMessage.addListener(hold);
  runnerFor(sessionId).then(
    (runner) => {
      port.onMessage.removeListener(hold);
      runner.attach(port, early);
    },
    () => port.postMessage({ type: 'session-missing' }),
  );
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
      return { settings: await loadSettings(), presets: COMPATIBLE_PRESETS, fastPresets: FAST_PRESETS };
    case 'save-settings':
      return saveSettings(msg.settings);
    case 'auth-status':
      return chatgptAuth.getAuthStatus();
    case 'backup-export':
      return exportBackup();
    case 'backup-import':
      return importBackup(msg.data);
    case 'auth-start':
      return startLogin();
    case 'auth-cancel':
      loginAbort?.abort();
      return null;
    case 'auth-import':
      await chatgptAuth.importCodexAuthJson(msg.text);
      return chatgptAuth.getAuthStatus();
    case 'auth-logout':
      await chatgptAuth.logout();
      return chatgptAuth.getAuthStatus();
    case 'fast-test': {
      const ask = fastClientFor(msg.config);
      const { answers, model } = await ask({
        ...msg.config,
        state: { message: 'Hello, can you hear me?' },
        questions: { greeting: { type: 'noul', instructions: 'The message is a greeting or a connection check.' } },
      });
      return { model, noul: answers.greeting?.noul ?? null };
    }
    case 'provider-test':
      return testProviderSlot(msg.slot, await loadSettings());
    case 'list-fast-models': {
      const fixed = FAST_PRESETS[msg.config.provider]?.models;
      if (fixed) return fixed.map((id) => ({ id, name: id, efforts: [], decision: true }));
      return (await listCompatibleModels(msg.config.baseUrl, msg.config.apiKey)).filter((m) => m.decision);
    }
    case 'list-models': {
      const settings = msg.settings ?? (await loadSettings());
      if (settings.provider === 'chatgpt') return listChatgptModels();
      // The agent works through tool calls, so models known not to support them are left out.
      const list = (await listCompatibleModels(settings.compatible.baseUrl, settings.compatible.apiKey)).filter((m) => !m.decision && m.tools !== false);
      return chatModelsFor(settings.compatible.preset, list);
    }
    case 'sessions-list':
      return (await store.listSessions()).map((meta) => ({ ...meta, running: Boolean(runners.get(meta.id)?.running) }));
    case 'session-create': {
      const meta = await store.createStoredSession();
      broadcastSessions();
      return meta;
    }
    case 'session-rename':
      await store.renameSession(msg.id, msg.title);
      await runners.get(msg.id)?.rename(String(msg.title).trim());
      broadcastSessions();
      return null;
    case 'session-delete':
      return deleteSession(msg.id);
    case 'drive-after-sign-in':
      return afterGoogleSignIn();
    case 'drive-backup-now':
      return backUpToDrive();
    case 'drive-restore':
      return restoreFromDrive();
    case 'tab-session':
      return sessionForTab(await chrome.tabs.get(msg.tabId));
    case 'bind-tab':
      return tabSessions.bindTab(msg.tabId, msg.sessionId);
    default:
      throw new Error(`Unknown request ${msg.type}`);
  }
}

function sessionForTab(tab) {
  return tabSessions.sessionForTab(tab, {
    ownerOf: groupOwner,
    exists: async (id) => (await store.listSessions()).some((s) => s.id === id),
    createBlank: blankSession,
  });
}

/** The session whose tab group holds the tab; saved sessions count too, since the worker may have restarted. */
async function groupOwner(tab) {
  if (tab.groupId === undefined || tab.groupId < 0) return null;
  const live = [...runners.values()].find((r) => r.browser.ownsTab(tab));
  return live?.id ?? (await store.listSessions()).find((s) => s.groupId === tab.groupId)?.id ?? null;
}

/**
 * A fresh session for a tab that has none. An empty session no panel shows and no
 * other tab is bound to (`excluded`) is reused, so opening tabs does not pile up
 * blank sessions.
 */
async function blankSession(excluded = new Set()) {
  const unused = (await store.listSessions()).find((s) => {
    const runner = runners.get(s.id);
    return !s.titled && !reserved.has(s.id) && !excluded.has(s.id) && !runner?.running && !runner?.ports.size;
  });
  const id = unused?.id ?? (await store.createStoredSession()).id;
  reserved.add(id);
  setTimeout(() => reserved.delete(id), RESERVATION_MS);
  return id;
}

async function deleteSession(id) {
  const runner = runners.get(id);
  if (runner) {
    runner.dispose();
    await runner.browser.detachAll();
    runners.delete(id);
  }
  await store.deleteSession(id);
  await tabSessions.unbindSession(id);
  broadcastSessions();
  return null;
}

async function startLogin() {
  loginAbort?.abort();
  const device = await chatgptAuth.startDeviceLogin();
  const controller = new AbortController();
  loginAbort = controller;
  await chrome.tabs.create({ url: device.verificationUrl, active: true });
  // fetch/setTimeout polling does not count as activity; without this the worker
  // is killed ~30s in while the user signs in, and the poll silently dies.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  // Success reaches the panel through chrome.storage.onChanged; only failures need a message.
  chatgptAuth.completeDeviceLogin(device, controller.signal).finally(() => clearInterval(keepAlive)).catch((err) => {
    for (const port of panels) port.postMessage({ type: 'auth-error', message: err.message });
  });
  return { userCode: device.userCode, verificationUrl: device.verificationUrl };
}
