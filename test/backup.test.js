import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, store[k]])),
      set: async (obj) => Object.assign(store, obj),
    },
  },
};

const { exportBackup, importBackup } = await import('../src/lib/backup.js');

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

test('a backup carries the settings and the ChatGPT sign-in back after a reinstall', async () => {
  store.settings = { provider: 'compatible', compatible: { preset: 'openrouter', apiKey: 'or-key', model: 'm' } };
  store.chatgptAuth = { accessToken: 'at', refreshToken: 'rt' };
  const file = JSON.parse(JSON.stringify(await exportBackup()));

  for (const k of Object.keys(store)) delete store[k];
  await importBackup(file);

  assert.equal(store.settings.compatible.apiKey, 'or-key');
  assert.equal(store.settings.fallback.enabled, false, 'restored settings are merged with current defaults');
  assert.deepEqual(store.chatgptAuth, { accessToken: 'at', refreshToken: 'rt' });
});

test('a backup without a ChatGPT sign-in restores the settings only', async () => {
  await importBackup({ format: 'browser-agent-backup', version: 1, settings: { maxSteps: 12 }, chatgptAuth: null });
  assert.equal(store.settings.maxSteps, 12);
  assert.equal(store.chatgptAuth, undefined);
});

test('files that are not backups, or come from a newer format, are refused', async () => {
  await assert.rejects(importBackup({ tokens: {} }), /not a Postora Browser Agent backup/);
  await assert.rejects(importBackup({ format: 'browser-agent-backup', version: 99, settings: {} }), /newer version/);
  assert.deepEqual(store, {});
});
