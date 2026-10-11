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

test('a new file git does not track yet changes the code hash; an ignored one does not', async () => {
  const { gitState } = await import('../showcase/manifest.mjs');
  const fsm = await import('node:fs');
  const os = await import('node:os');
  const p = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const repo = fsm.mkdtempSync(p.join(os.tmpdir(), 'manifest-git-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
  try {
    git('init', '-q');
    fsm.writeFileSync(p.join(repo, '.gitignore'), '.env*\n');
    fsm.writeFileSync(p.join(repo, 'main.js'), 'import "./helper.js";\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    assert.equal(gitState(repo).dirty, false);
    fsm.writeFileSync(p.join(repo, 'helper.js'), 'export const v = 1;\n');
    const first = gitState(repo);
    assert.equal(first.dirty, true);
    fsm.writeFileSync(p.join(repo, 'helper.js'), 'export const v = 2;\n');
    assert.notEqual(gitState(repo).diff, first.diff); // the new helper changed: different code
    fsm.writeFileSync(p.join(repo, '.env.showcase'), 'KEY=secret\n');
    const withEnv = gitState(repo);
    fsm.writeFileSync(p.join(repo, '.env.showcase'), 'KEY=other\n');
    assert.equal(gitState(repo).diff, withEnv.diff); // ignored files are not code
    // An untracked nested repository is listed as a directory: its files are hashed.
    fsm.mkdirSync(p.join(repo, 'nested'));
    execFileSync('git', ['init', '-q'], { cwd: p.join(repo, 'nested') });
    fsm.writeFileSync(p.join(repo, 'nested', 'tool.js'), 'a\n');
    const nested = gitState(repo);
    assert.doesNotMatch(nested.diff, /^unknown/);
    fsm.writeFileSync(p.join(repo, 'nested', 'tool.js'), 'b\n');
    assert.notEqual(gitState(repo).diff, nested.diff);
    // ...but what the outer repository ignores inside it is not code: not hashed, not walked.
    const before = gitState(repo).diff;
    fsm.writeFileSync(p.join(repo, 'nested', '.env.local'), 'KEY=1');
    assert.equal(gitState(repo).diff, before);
    fsm.writeFileSync(p.join(repo, 'nested', '.env.local'), 'KEY=2');
    assert.equal(gitState(repo).diff, before);
  } finally {
    fsm.rmSync(repo, { recursive: true, force: true });
  }
});
