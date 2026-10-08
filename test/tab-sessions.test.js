import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const sessionStorage = {};
globalThis.chrome = {
  storage: {
    session: {
      get: async (key) => (key in sessionStorage ? { [key]: structuredClone(sessionStorage[key]) } : {}),
      set: async (obj) => Object.assign(sessionStorage, structuredClone(obj)),
    },
  },
};

const tabSessions = await import('../src/sessions/tab-sessions.js');

let saved;
let created;
const deps = (owners = {}) => ({
  ownerOf: async (tab) => owners[tab.groupId] ?? null,
  exists: async (id) => saved.has(id),
  createBlank: async (excluded) => {
    const reusable = [...saved].find((id) => id.startsWith('blank') && !excluded.has(id));
    if (reusable) return reusable;
    const id = `blank${(created += 1)}`;
    saved.add(id);
    return id;
  },
});

beforeEach(() => {
  delete sessionStorage.tabSessions;
  saved = new Set();
  created = 0;
});

test('each new tab gets its own blank session and keeps it when the user comes back', async () => {
  const first = await tabSessions.sessionForTab({ id: 1, groupId: -1 }, deps());
  const second = await tabSessions.sessionForTab({ id: 2, groupId: -1 }, deps());
  assert.notEqual(first, second, 'a blank session bound to one tab is not handed to another');
  assert.equal(await tabSessions.sessionForTab({ id: 1, groupId: -1 }, deps()), first);
});

test('two lookups for the same tab at once agree on one session', async () => {
  const [a, b] = await Promise.all([1, 1].map((id) => tabSessions.sessionForTab({ id, groupId: -1 }, deps())));
  assert.equal(a, b);
  assert.equal(created, 1);
});

test('a tab in a session\'s tab group shows that session', async () => {
  saved.add('task-session');
  assert.equal(await tabSessions.sessionForTab({ id: 5, groupId: 9 }, deps({ 9: 'task-session' })), 'task-session');
});

test('a session the user picks on a tab in another session\'s group wins over the group', async () => {
  saved.add('task-session');
  saved.add('picked');
  await tabSessions.bindTab(5, 'picked');
  assert.equal(await tabSessions.sessionForTab({ id: 5, groupId: 9 }, deps({ 9: 'task-session' })), 'picked');
});

test('a session the user picks becomes the tab\'s session until it is deleted', async () => {
  saved.add('picked');
  await tabSessions.bindTab(3, 'picked');
  assert.equal(await tabSessions.sessionForTab({ id: 3, groupId: -1 }, deps()), 'picked');

  saved.delete('picked');
  await tabSessions.unbindSession('picked');
  assert.match(await tabSessions.sessionForTab({ id: 3, groupId: -1 }, deps()), /^blank/);
});

test('closing a tab frees its blank session for the next new tab', async () => {
  const blank = await tabSessions.sessionForTab({ id: 1, groupId: -1 }, deps());
  await tabSessions.unbindTab(1);
  assert.equal(await tabSessions.sessionForTab({ id: 2, groupId: -1 }, deps()), blank);
});
