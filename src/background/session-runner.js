// One session's runtime: its transcript, its model session, its running task and
// its browser controller (tab group). Several runners can run tasks at once.
// Storage stays the source of truth, so a runner can be dropped and rebuilt.

import { runAgent } from '../agent/agent.js';
import { createFastAsk, createModelSession, modelSessionKey } from '../agent/model-session.js';
import { describeTabContext } from '../agent/prompt.js';
import { createToolExecutor } from '../agent/tools.js';
import { BrowserController } from '../browser/controller.js';
import { createFastLayer } from '../fast/fast-layer.js';
import { loadSettings } from '../lib/settings.js';
import * as store from '../sessions/store.js';

const SAVE_DELAY_MS = 500;
const KEEP_ALIVE_MS = 20000;
const STREAMING = new Set(['text-delta', 'reasoning-delta']);

export class SessionRunner {
  constructor({ meta, body, color, isTakenByOther, onSessionsChanged }) {
    this.id = meta.id;
    this.title = meta.title;
    this.titled = meta.titled;
    this.transcript = body.transcript ?? [];
    this.storedLog = body.log;
    this.onSessionsChanged = onSessionsChanged;
    this.ports = new Set();
    this.session = null;
    this.sessionKey = null;
    this.abort = null;
    this.pendingQuestion = null;
    this.saveTimer = null;
    this.disposed = false;
    this.browser = new BrowserController({ title: meta.title || 'Browser Agent', color, isTakenByOther: (tab) => isTakenByOther(this.id, tab) });
    this.browser.groupId = body.groupId ?? null;
  }

  get running() {
    return Boolean(this.abort);
  }

  /** `early` holds what the panel sent before this session finished loading. */
  attach(port, early = []) {
    this.ports.add(port);
    port.postMessage({ type: 'replay', events: this.transcript, running: this.running, question: this.pendingQuestion?.question ?? null });
    port.onDisconnect.addListener(() => this.ports.delete(port));
    port.onMessage.addListener((msg) => this.receive(msg));
    for (const msg of early) this.receive(msg);
  }

  receive(msg) {
    if (msg.type === 'run') this.start(msg.text);
    else if (msg.type === 'stop') this.stop();
    else if (msg.type === 'answer') this.answer(msg.text);
    else if (msg.type === 'dismiss-notice') this.emit({ type: 'notice-dismissed', id: msg.id });
  }

  emit(event) {
    if (!STREAMING.has(event.type)) {
      this.transcript.push(event);
      this.scheduleSave();
    }
    for (const port of this.ports) port.postMessage(event);
  }

  notify = (notice) => this.emit({ type: 'notice', id: crypto.randomUUID(), ...notice });

  async start(text) {
    if (this.running) {
      this.emit({ type: 'error', message: 'A task is already running in this session. Stop it first.' });
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    // Extension API calls reset the service worker idle timer while the model thinks.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
    this.emit({ type: 'user', text });
    this.emit({ type: 'status', running: true });
    try {
      if (!this.titled) await this.nameAfter(text);
      this.onSessionsChanged(); // after naming, so other panels list it with its title
      const settings = await loadSettings();
      this.prepareModelSession(settings);
      this.browser.tabId = null; // each task starts on the tab the user is looking at
      const tab = await this.browser.currentTab();
      const execute = createToolExecutor(this.browser, { askUser: (q) => this.askUser(q, abort.signal) });
      const fastLayer = settings.fast.enabled && settings.fast.apiKey
        ? createFastLayer({ config: settings.fast, browser: this.browser, execute, task: text, ask: createFastAsk(settings.fast, this.notify) })
        : null;
      await runAgent({
        fastLayer,
        session: this.session,
        execute,
        task: text + describeTabContext(tab),
        maxSteps: Math.max(1, Number(settings.maxSteps) || 40),
        signal: abort.signal,
        emit: (event) => this.emit(event),
      });
    } catch (err) {
      this.emit(err.name === 'AbortError' ? { type: 'stopped' } : { type: 'error', message: err.message });
    } finally {
      clearInterval(keepAlive);
      this.abort = null;
      this.pendingQuestion = null;
      await this.browser.detachAll();
      this.emit({ type: 'status', running: false });
      this.onSessionsChanged();
    }
  }

  /**
   * Each task starts on the primary provider. A new model session is seeded with
   * the conversation so far when the backup finished the last task, the model
   * settings changed, or the session was reopened from storage.
   */
  prepareModelSession(settings) {
    const key = modelSessionKey(settings);
    if (this.session && this.sessionKey === key && !this.session.switched) return;
    const log = this.session?.log ?? this.storedLog;
    const reason = !this.session ? 'continuing an earlier session'
      : this.session.switched ? 'the previous task was finished by the backup provider'
        : 'the model was changed in settings';
    this.session = createModelSession(settings, { notify: this.notify, seed: log ? { log, reason } : null });
    this.sessionKey = key;
  }

  async nameAfter(task) {
    await store.titleFromFirstTask(this.id, task);
    const meta = (await store.listSessions()).find((s) => s.id === this.id);
    if (meta) await this.rename(meta.title);
  }

  async rename(title) {
    this.title = title;
    this.titled = true;
    await this.browser.rename(title);
  }

  stop() {
    this.abort?.abort();
  }

  /** For a deleted session: stop its task and never save again, or its last events would recreate it. */
  dispose() {
    this.disposed = true;
    clearTimeout(this.saveTimer);
    this.stop();
  }

  askUser(question, signal) {
    return new Promise((resolve, reject) => {
      this.pendingQuestion = { question, resolve };
      this.emit({ type: 'ask', question });
      signal.addEventListener('abort', () => reject(new DOMException('Stopped by user', 'AbortError')), { once: true });
    });
  }

  answer(text) {
    const pending = this.pendingQuestion;
    if (!pending) return;
    this.pendingQuestion = null;
    this.emit({ type: 'user', text });
    pending.resolve(text);
  }

  scheduleSave() {
    if (this.disposed) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  async save() {
    clearTimeout(this.saveTimer);
    if (this.disposed) return;
    await store.saveSession(this.id, { transcript: this.transcript, log: this.session?.log ?? this.storedLog, groupId: this.browser.groupId });
  }
}
