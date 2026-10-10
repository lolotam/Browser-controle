// What a showcase run is: its arguments, and an immutable manifest (code commit,
// task set, models, fast layer, timeout, settings template without keys) written
// once per results folder. A resume must match it, so results from different
// code or settings never end up compared as one run.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FLAGS = {
  '--models': (out, v) => { out.models = v.split(','); },
  '--tasks': (out, v) => { out.tasks = v.split(','); },
  '--out': (out, v) => { out.out = v; },
  '--timeout': (out, v) => { out.timeout = Number(v); },
  '--set': (out, v) => { out.set = v; },
};
const SWITCHES = {
  '--no-jev': (out) => { out.jev = false; },
  '--force': (out) => { out.force = true; },
  '--preflight': (out) => { out.preflight = true; },
  '--mock': (out) => { out.mock = true; },
};

/** Parses the command line; an unknown flag, a missing value or an unknown task set is an error. */
export function parseArgs(argv, { sets, today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = { set: 'basic', jev: true, timeout: 360, out: today, force: false, preflight: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (SWITCHES[flag]) SWITCHES[flag](out);
    else if (FLAGS[flag]) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
      FLAGS[flag](out, value);
      i += 1;
    } else throw new Error(`Unknown option "${flag}". Options: ${[...Object.keys(FLAGS), ...Object.keys(SWITCHES)].join(', ')}.`);
  }
  if (sets && !sets.includes(out.set)) throw new Error(`Unknown task set "${out.set}"; use ${sets.join(' or ')}.`);
  if (!(out.timeout > 0)) throw new Error('--timeout needs a number of seconds.');
  return out;
}

/**
 * The checked-out commit, whether tracked files differ from it, and a hash of
 * that difference: two runs from the same dirty commit with different edits
 * must not look like the same code.
 */
export function gitState(root) {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    const diff = git('diff', 'HEAD', '--binary');
    return { commit: git('rev-parse', 'HEAD').trim(), dirty: diff !== '', diff: diff ? crypto.createHash('sha256').update(diff).digest('hex').slice(0, 16) : null };
  } catch {
    return { commit: 'unknown', dirty: true, diff: 'unknown' };
  }
}

/** Settings with every key replaced, safe to record. */
export function redact(settings) {
  return JSON.parse(JSON.stringify(settings, (k, v) => {
    if (k === 'keys' && v && typeof v === 'object') return Object.fromEntries(Object.keys(v).map((name) => [name, '[redacted]'])); // one key per provider
    return /apikey|key$|token/i.test(k) && typeof v === 'string' && v ? '[redacted]' : v;
  }));
}

/** The manifest's content (no timestamps), and its id: a hash of that content. */
export function buildManifest({ git, set, tasks, models, jev, timeout, settingsTemplate }) {
  const content = {
    commit: git.commit,
    dirty: git.dirty,
    diff: git.diff ?? null,
    set,
    tasks: tasks.map((t) => t.id),
    models: models.map(({ id, preset, model, effort }) => ({ id, preset, model, effort: effort ?? '' })),
    jev: jev ? { provider: jev.provider, model: jev.model } : null,
    timeout,
    settings: redact(settingsTemplate),
  };
  const id = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 12);
  return { id, ...content };
}

/**
 * Writes the manifest for a new results folder, or checks a resume against the
 * one already there. Throws when they differ: start a new folder with --out.
 */
export function claimManifest(outDir, manifest, { started = new Date().toISOString() } = {}) {
  const file = path.join(outDir, 'manifest.json');
  // A folder with results but no manifest was recorded before manifests: its code
  // and settings are unknown, so a new manifest must not claim them.
  if (!fs.existsSync(file) && (fs.existsSync(path.join(outDir, 'run.json')) || hasResults(outDir))) {
    throw new Error('This results folder was recorded before run manifests. Use --out with a new folder name.');
  }
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${JSON.stringify({ ...manifest, started }, null, 2)}\n`);
    return manifest;
  }
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (existing.id !== manifest.id) {
    const differs = ['commit', 'dirty', 'diff', 'set', 'tasks', 'models', 'jev', 'timeout', 'settings']
      .filter((k) => JSON.stringify(existing[k]) !== JSON.stringify(manifest[k]));
    throw new Error(`This results folder was started with different ${differs.join(', ')}. Use --out with a new folder name.`);
  }
  return existing;
}

function hasResults(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).some((model) => model.isDirectory()
    && fs.readdirSync(path.join(dir, model.name), { withFileTypes: true }).some((task) => task.isDirectory() && fs.existsSync(path.join(dir, model.name, task.name, 'result.json'))));
}
