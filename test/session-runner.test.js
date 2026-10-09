import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = {
  debugger: { onDetach: { addListener() {} }, detach: async () => {} },
  tabs: { onRemoved: { addListener() {} } },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
      set: async (obj) => Object.assign(store, structuredClone(obj)),
      remove: async (keys) => [].concat(keys).forEach((k) => delete store[k]),
    },
  },
};

const { SessionRunner } = await import('../src/background/session-runner.js');
const sessions = await import('../src/sessions/store.js');

test('a deleted session is not written back by its last events', async () => {
  const meta = await sessions.createStoredSession('Doomed');
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });

  runner.dispose();
  await sessions.deleteSession(meta.id);
  runner.emit({ type: 'status', running: false }); // what a stopping task emits in its finally block
  await new Promise((r) => setTimeout(r, 700)); // past the save debounce

  assert.equal(`session:${meta.id}` in store, false);
  assert.deepEqual(await sessions.listSessions(), []);
});

test('what the panel sent while the session was loading is handled once it attaches', async () => {
  const meta = await sessions.createStoredSession('Woken');
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  const received = [];
  const port = { postMessage: (event) => received.push(event), onDisconnect: { addListener() {} }, onMessage: { addListener() {} } };

  runner.attach(port, [{ type: 'dismiss-notice', id: 'n1' }]);

  assert.deepEqual(received.map((e) => e.type), ['replay', 'notice-dismissed']);
  runner.dispose();
});

test('a panel that left while the session loaded does not swallow the next panel\'s events', async () => {
  const meta = await sessions.createStoredSession('Revisited');
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  const closed = {
    postMessage: () => { throw new Error('Attempting to use a disconnected port object'); },
    onDisconnect: { addListener() {} },
    onMessage: { addListener() {} },
  };
  const received = [];
  const open = { postMessage: (event) => received.push(event), onDisconnect: { addListener() {} }, onMessage: { addListener() {} } };

  runner.attach(closed, [{ type: 'dismiss-notice', id: 'n1' }]);
  runner.attach(open);
  runner.emit({ type: 'user', text: 'first task' });

  assert.deepEqual(received.map((e) => e.type), ['replay', 'user']);
  assert.equal(runner.ports.size, 1);
  runner.dispose();
});
