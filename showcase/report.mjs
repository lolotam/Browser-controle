// Builds the showcase report page from a results folder:
//   1. compresses every run's videos into <run>/web/ (smaller, for upload),
//   2. writes <run>/report.html with the results embedded, pointing each video
//      at its uploaded asset id from <run>/assets.json ({"<file>": "<id>"}).
//
//   node showcase/report.mjs <run folder name> [--no-video]
//
// Without assets.json the page still renders; videos show as "not uploaded".

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TASKS } from './tasks.mjs';
import { MODELS } from './models.mjs';
import { findFfmpeg } from './ffmpeg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [runName, ...flags] = process.argv.slice(2);
if (!runName) throw new Error('Usage: node showcase/report.mjs <run folder name>');
const runDir = path.join(ROOT, 'showcase-results', runName);
const webDir = path.join(runDir, 'web');
fs.mkdirSync(webDir, { recursive: true });

const runs = [];
for (const model of MODELS) {
  for (const task of TASKS) {
    const dir = path.join(runDir, model.id, task.id);
    const file = path.join(dir, 'result.json');
    if (!fs.existsSync(file)) continue;
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    const report = fs.existsSync(path.join(dir, 'report.md')) ? fs.readFileSync(path.join(dir, 'report.md'), 'utf8') : '';
    const events = fs.existsSync(path.join(dir, 'transcript.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')) : [];
    const providerError = events.findLast((e) => e.type === 'error')?.message ?? null;
    // Runs recorded before the harness told errors from stalls said "timeout" for both,
    // and an error run's time was the full limit, not when the task actually ended.
    if (result.status === 'timeout') {
      result.status = providerError ? 'error' : 'stalled';
      if (providerError) result.ms = null;
    }
    // Grade again with the current checks, so a fixed check applies to every run.
    result.grade = report ? task.check(report) : { pass: false, score: 0, notes: providerError ? `provider error: ${providerError.slice(0, 160)}` : 'no report' };
    const videos = {};
    // A provider error ends the task at once, so its recording shows nothing but the wait.
    if (!flags.includes('--no-video') && result.status !== 'error') {
      for (const [kind, width, rate] of [['page', 960, '350k'], ['panel', 320, '150k']]) {
        const src = path.join(dir, `${kind}.webm`);
        const out = `${model.id}__${task.id}__${kind}.webm`;
        const target = path.join(webDir, out);
        if (fs.existsSync(src) && (!fs.existsSync(target) || fs.statSync(target).mtimeMs < fs.statSync(src).mtimeMs)) compress(src, target, width, rate);
        if (fs.existsSync(path.join(webDir, out))) videos[kind] = out;
      }
    }
    runs.push({ ...result, report: report.slice(0, 6000), videos });
  }
}

const assets = fs.existsSync(path.join(runDir, 'assets.json')) ? JSON.parse(fs.readFileSync(path.join(runDir, 'assets.json'), 'utf8')) : {};
const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
const data = {
  started: meta.started,
  // What this run really used (null for --no-jev), not today's settings.
  jev: meta.jev ? `${meta.jev.model} via ${meta.jev.provider === 'vercel' ? 'Vercel AI Gateway' : meta.jev.provider}` : null,
  models: MODELS.filter((m) => runs.some((r) => r.model === m.id)).map(({ id, label }) => ({ id, label })),
  tasks: TASKS.map(({ id, title, site, task }) => ({ id, title, site, task })),
  runs: runs.map((r) => ({ ...r, videos: Object.fromEntries(Object.entries(r.videos).map(([k, f]) => [k, assets[f] ? `/_blob/${assets[f]}` : null])) })),
};
const template = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'report-template.html'), 'utf8');
const html = template.replace('/*__DATA__*/null', JSON.stringify(data).replace(/</g, '\\u003c'));
fs.writeFileSync(path.join(runDir, 'report.html'), html);
const files = fs.readdirSync(webDir).filter((f) => f.endsWith('.webm'));
const mb = files.reduce((n, f) => n + fs.statSync(path.join(webDir, f)).size, 0) / 1048576;
console.log(`${runs.length} runs · ${files.length} videos (${mb.toFixed(1)} MB) in ${path.relative(ROOT, webDir)} · ${Object.keys(assets).length} uploaded · report.html written`);

/** Re-encodes with Playwright's own ffmpeg (VP8 only): narrower and at a lower bitrate. */
function compress(src, out, width, rate) {
  const res = spawnSync(findFfmpeg(), ['-loglevel', 'error', '-i', src, '-an', '-vf', `scale=${width}:-2`, '-c:v', 'vp8', '-b:v', rate, '-deadline', 'good', '-cpu-used', '4', '-y', out]);
  if (res.status !== 0) console.warn(`compress failed for ${src}: ${String(res.stderr).slice(0, 200)}`);
}
