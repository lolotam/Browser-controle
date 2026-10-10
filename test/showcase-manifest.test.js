import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildManifest, claimManifest, parseArgs, redact } from '../showcase/manifest.mjs';

const sets = ['basic', 'hard'];

test('arguments: known flags parse, unknown ones and bad values are errors', () => {
  const a = parseArgs(['--set', 'hard', '--models', 'a,b', '--timeout', '480', '--no-jev'], { sets, today: '2026-10-10' });
  assert.deepEqual([a.set, a.models, a.timeout, a.jev, a.out], ['hard', ['a', 'b'], 480, false, '2026-10-10']);
  assert.throws(() => parseArgs(['--sett', 'hard'], { sets }), /Unknown option "--sett"/);
  assert.throws(() => parseArgs(['--set', 'harder'], { sets }), /Unknown task set "harder"/);
  assert.throws(() => parseArgs(['--out'], { sets }), /--out needs a value/);
  assert.throws(() => parseArgs(['--timeout', 'soon'], { sets }), /--timeout needs a number/);
});

test('recorded settings never carry a key', () => {
  const out = redact({ compatible: { apiKey: 'sk-secret', model: 'm' }, fast: { apiKey: 'jev-secret' }, keys: { openrouter: 'or-secret' } });
  assert.doesNotMatch(JSON.stringify(out), /secret/);
  assert.equal(out.compatible.model, 'm');
});

const base = {
  git: { commit: 'abc123', dirty: false },
  set: 'hard',
  tasks: [{ id: 't1' }],
  models: [{ id: 'm1', preset: 'nvidia', model: 'x', env: 'NVIDIA_API_KEY' }],
  jev: { provider: 'vercel', model: 'typesafe-ai/jev', env: 'AI_GATEWAY_API_KEY' },
  timeout: 480,
  settingsTemplate: { compatible: { apiKey: 'sk-1' }, fast: { apiKey: 'k' } },
};

test('the manifest id follows the content: same run, same id; other code, other id', () => {
  assert.equal(buildManifest(base).id, buildManifest(base).id);
  assert.notEqual(buildManifest(base).id, buildManifest({ ...base, git: { commit: 'def456', dirty: false } }).id);
  assert.doesNotMatch(JSON.stringify(buildManifest(base)), /sk-1|NVIDIA_API_KEY/);
});

test('a dirty tree with different edits is different code', () => {
  const a = buildManifest({ ...base, git: { commit: 'abc123', dirty: true, diff: '1111' } });
  const b = buildManifest({ ...base, git: { commit: 'abc123', dirty: true, diff: '2222' } });
  assert.notEqual(a.id, b.id);
});

test('a folder recorded before manifests is refused, not claimed', () => {
  for (const legacy of ['run.json', path.join('m1', 't1', 'result.json')]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    fs.mkdirSync(path.dirname(path.join(dir, legacy)), { recursive: true });
    fs.writeFileSync(path.join(dir, legacy), '{}');
    assert.throws(() => claimManifest(dir, buildManifest(base)), /recorded before run manifests/);
    assert.equal(fs.existsSync(path.join(dir, 'manifest.json')), false);
  }
});

test('a resume must match the folder manifest; it is written once and never overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
  const first = claimManifest(dir, buildManifest(base), { started: 'T0' });
  assert.equal(claimManifest(dir, buildManifest(base), { started: 'T1' }).started, 'T0');
  assert.throws(() => claimManifest(dir, buildManifest({ ...base, git: { commit: 'def456', dirty: false } })), /different commit/);
  assert.throws(() => claimManifest(dir, buildManifest({ ...base, timeout: 360 })), /different timeout/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).id, first.id);
});
