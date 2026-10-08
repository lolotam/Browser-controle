import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const local = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in local).map((k) => [k, structuredClone(local[k])])),
      set: async (obj) => Object.assign(local, structuredClone(obj)),
    },
  },
};

const { afterGoogleSignIn, backUpToDrive, driveBackupState, restoreFromDrive } = await import('../src/lib/drive-backup.js');

const getToken = async () => 'ya29.token';
let drive; // the fake appDataFolder: { id, content } or null
let calls;

function stubDrive({ status } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    assert.equal(init.headers.Authorization, 'Bearer ya29.token');
    if (status) return new Response(JSON.stringify({ error: { message: 'Google Drive API has not been used in project 4227 before or it is disabled.' } }), { status });
    if (u.pathname === '/drive/v3/files' && !init.method) return Response.json({ files: drive ? [{ id: drive.id, modifiedTime: '2026-10-09T10:00:00Z' }] : [] });
    if (u.pathname === '/drive/v3/files' && init.method === 'POST') {
      drive = { id: 'file1', content: null };
      return Response.json({ id: 'file1' });
    }
    if (u.pathname === `/upload/drive/v3/files/${drive?.id}` && init.method === 'PATCH') {
      drive.content = JSON.parse(init.body);
      return Response.json({ id: drive.id });
    }
    if (u.pathname === `/drive/v3/files/${drive?.id}` && u.searchParams.get('alt') === 'media') return Response.json(drive.content);
    return new Response('{}', { status: 404 });
  };
}

const setUp = { provider: 'compatible', compatible: { preset: 'openrouter', apiKey: 'or-key', model: 'openai/gpt-5' } };

beforeEach(() => {
  for (const k of Object.keys(local)) delete local[k];
  drive = null;
  calls = [];
  stubDrive();
});

test('the first backup creates the file, later changes update it, unchanged settings upload nothing', async () => {
  local.settings = setUp;
  await backUpToDrive({ getToken });
  assert.equal(drive.content.settings.compatible.apiKey, 'or-key');

  calls = [];
  await backUpToDrive({ getToken });
  assert.deepEqual(calls, [], 'same settings: no Drive call');

  local.settings = { ...setUp, maxSteps: 25 };
  await backUpToDrive({ getToken });
  assert.deepEqual(calls, ['PATCH /upload/drive/v3/files/file1']);
  assert.equal(drive.content.settings.maxSteps, 25);
});

test('a reinstall gets its settings and ChatGPT sign-in back at Google sign-in', async () => {
  drive = { id: 'file1', content: { format: 'browser-agent-backup', version: 1, settings: setUp, chatgptAuth: { tokens: { refresh_token: 'r' } } } };
  const { restored } = await afterGoogleSignIn({ getToken });
  assert.equal(restored.compatible.apiKey, 'or-key');
  assert.deepEqual(local.chatgptAuth, { tokens: { refresh_token: 'r' } });

  calls = [];
  await backUpToDrive({ getToken });
  assert.deepEqual(calls, [], 'the restored settings are not uploaded straight back');
});

test('an install that is already set up keeps its settings and is told a backup exists', async () => {
  drive = { id: 'file1', content: { format: 'browser-agent-backup', version: 1, settings: { ...setUp, compatible: { ...setUp.compatible, apiKey: 'old' } } } };
  local.settings = setUp;
  const result = await afterGoogleSignIn({ getToken });
  assert.equal(result.available, '2026-10-09T10:00:00Z');
  assert.equal(local.settings.compatible.apiKey, 'or-key');
});

test('a Drive error is kept for the account menu, not thrown', async () => {
  local.settings = setUp;
  stubDrive({ status: 403 });
  const state = await backUpToDrive({ getToken });
  assert.match(state.error, /Google Drive API has not been used/);
  assert.match((await driveBackupState()).error, /disabled/);
});

test('restoring when Drive has no backup says so', async () => {
  await assert.rejects(restoreFromDrive({ getToken }), /no backup in Google Drive/);
});
