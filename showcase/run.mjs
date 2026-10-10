// Runs the fixed showcase (showcase/tasks.mjs) for each model in showcase/models.mjs,
// with Jev as the fast layer, in Chromium with the unpacked extension. Per run it
// records a video of the page (with the live cursor), a video of the side panel,
// the final report, and metrics, into showcase-results/<run>/<model>/<task>/.
// Finished runs are skipped, so an interrupted batch resumes where it stopped.
//
//   npm run showcase -- [--models a,b] [--tasks x,y] [--no-jev] [--out name] [--timeout 360] [--force]
//   npm run showcase:preflight          (checks every model with one real request)
//   npm run showcase -- --mock          (self-test of this harness with a scripted local model, no keys)
//
// Keys come from .env.showcase (git-ignored); the script never prints them.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { TASKS } from './tasks.mjs';
import { ENV_FILE, ENV_TEMPLATE, JEV, MODELS } from './models.mjs';
import { COMPATIBLE_PRESETS } from '../src/lib/settings.js';
import { findFfmpeg } from './ffmpeg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL_FPS = 2;
const VIDEO = { width: 1280, height: 800 };
const PANEL = { width: 420, height: 800 };

const args = parseArgs(process.argv.slice(2));
const env = args.mock ? { MOCK_KEY: 'mock' } : loadEnv();
const models = args.mock
  ? [{ id: 'mock', label: 'Scripted mock model', preset: 'custom', baseUrl: await startMockModel(), model: 'mock', env: 'MOCK_KEY' }]
  : MODELS.filter((m) => (!args.models || args.models.includes(m.id)) && env[m.env]);
const tasks = TASKS.filter((t) => (args.mock ? t.id === 'books' : !args.tasks || args.tasks.includes(t.id)));
if (args.mock) { args.jev = false; args.out = 'mock-selftest'; args.force = true; }
const skipped = MODELS.filter((m) => (!args.models || args.models.includes(m.id)) && !env[m.env]);
if (skipped.length) console.log(`Skipping (no key in ${ENV_FILE}): ${skipped.map((m) => m.id).join(', ')}`);
if (args.jev && !env[JEV.env]) throw new Error(`Jev needs ${JEV.env} in ${ENV_FILE} (or run with --no-jev).`);

if (args.preflight) {
  await preflight();
} else {
  const outDir = path.join(ROOT, 'showcase-results', args.out);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify({ started: new Date().toISOString(), jev: args.jev ? JEV : null, models, tasks: tasks.map(({ check, ...t }) => t) }, (k, v) => (k === 'env' ? undefined : v), 2));
  for (const model of models) {
    for (const task of tasks) {
      const dir = path.join(outDir, model.id, task.id);
      // A finished outcome is kept; a crash (browser, network, recorder) is tried again.
      const previous = path.join(dir, 'result.json');
      if (!args.force && fs.existsSync(previous) && JSON.parse(fs.readFileSync(previous, 'utf8')).status !== 'crashed') continue;
      process.stdout.write(`${model.id} · ${task.id} … `);
      const result = await runOne(model, task, dir).catch((err) => ({ status: 'crashed', error: err.message }));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ model: model.id, task: task.id, ...result }, null, 2));
      console.log(`${result.status}${result.grade ? ` · ${result.grade.pass ? 'PASS' : 'FAIL'} (${result.grade.notes})` : ''} · ${((result.ms ?? 0) / 1000).toFixed(1)} s`);
    }
  }
  console.log(`Results in ${path.relative(ROOT, outDir)}`);
  if (args.mock) process.exit(0); // the mock model's server keeps the process alive
}

async function runOne(model, task, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    viewport: VIDEO,
    locale: 'en-US',
    recordVideo: { dir: path.join(dir, 'raw'), size: VIDEO },
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  const errors = [];
  try {
    const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    const panel = await context.newPage();
    panel.on('pageerror', (e) => errors.push(`panel: ${e.message}`));
    await panel.setViewportSize(PANEL);
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
    await panel.evaluate((settings) => chrome.storage.local.set({ settings }), settingsFor(model));
    await panel.reload();

    const page = await context.newPage();
    const pageVideoStart = Date.now();
    await page.goto(task.startUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => errors.push(`start page: ${e.message}`));
    await page.bringToFront();

    const recorder = panelRecorder(panel, path.join(dir, 'panel.webm'));
    const started = Date.now();
    await panel.fill('#input', task.task);
    await panel.click('#sendBtn');
    // A run ends with a final report, or with an error (a provider refusing the request ends the task too).
    const ended = await panel.waitForFunction(() => {
      if (document.querySelector('.msg.final')) return 'final';
      return document.querySelector('.msg.error') ? 'error' : null;
    }, null, { timeout: args.timeout * 1000, polling: 250 }).then((h) => h.jsonValue(), () => 'timeout');
    const finished = ended === 'final';
    const ms = Date.now() - started;
    if (ended === 'timeout') await panel.click('#stopBtn').catch(() => {});
    await panel.waitForTimeout(1500); // the session saves 500 ms after its last event
    const session = await panel.evaluate(async () => {
      const { sessions = [] } = await chrome.storage.local.get('sessions');
      const latest = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
      return latest ? (await chrome.storage.local.get(`session:${latest.id}`))[`session:${latest.id}`] : null;
    });
    await recorder.stop();
    await page.screenshot({ path: path.join(dir, 'final-page.png') }).catch(() => {});
    await panel.screenshot({ path: path.join(dir, 'final-panel.png'), fullPage: true }).catch(() => {});

    const events = session?.transcript ?? [];
    const final = events.findLast((e) => e.type === 'final');
    const report = final?.report ?? '';
    const pageVideo = page.video();
    await context.close();
    const raw = pageVideo ? await pageVideo.path().catch(() => null) : null;
    if (raw && fs.existsSync(raw)) fs.renameSync(raw, path.join(dir, 'page.webm'));
    fs.rmSync(path.join(dir, 'raw'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, 'report.md'), report);
    fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(events, null, 1));
    return {
      // finished / gave-up: the agent wrote its report; error: the provider refused a request;
      // stalled: no report and no error within the time limit (a model call that never answered).
      status: finished ? (final?.success === false ? 'gave-up' : 'finished') : ended === 'error' ? 'error' : 'stalled',
      ms,
      grade: report ? task.check(report) : { pass: false, score: 0, notes: 'no report' },
      metrics: metricsOf(events),
      video: { page: 'page.webm', panel: 'panel.webm', panelOffsetMs: recorder.startedAt - pageVideoStart, panelFps: PANEL_FPS },
      errors: [...errors, ...events.filter((e) => e.type === 'error').map((e) => e.message)],
    };
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/** The extension's settings for one run: the model under test, Jev as the fast layer, no backup. */
function settingsFor(model) {
  const preset = COMPATIBLE_PRESETS[model.preset];
  return {
    provider: 'compatible',
    compatible: { preset: model.preset, baseUrl: model.baseUrl ?? preset.baseUrl, apiKey: env[model.env], model: model.model, effort: model.effort ?? '' },
    fallback: { enabled: false },
    fast: args.jev
      ? { enabled: true, mode: 'auto', provider: JEV.provider, baseUrl: JEV.baseUrl, apiKey: env[JEV.env], model: JEV.model, minProb: 0.6, riskyMax: 0.3, decision: true, fallback: { enabled: false } }
      : { enabled: false },
    vision: true,
    allowJavascript: false,
    showCursor: true,
    maxSteps: 30,
    uiLanguage: 'en',
    keys: {},
  };
}

function metricsOf(events) {
  const tools = events.filter((e) => e.type === 'tool-start');
  const usage = events.filter((e) => e.type === 'usage').map((e) => e.usage ?? {});
  const sum = (key) => usage.reduce((n, u) => n + (Number(u[key]) || 0), 0);
  return {
    llmTurns: events.filter((e) => e.type === 'thinking').length,
    actions: tools.length,
    jevActions: tools.filter((e) => e.fast).length,
    jevHandoffs: events.filter((e) => e.type === 'fast-handoff').length,
    failedActions: events.filter((e) => e.type === 'tool-end' && !e.ok).length,
    screenshots: tools.filter((e) => e.name === 'screenshot').length,
    tools: Object.fromEntries([...new Set(tools.map((e) => e.name))].map((n) => [n, tools.filter((e) => e.name === n).length])),
    promptTokens: sum('prompt_tokens') || null,
    completionTokens: sum('completion_tokens') || null,
    notices: events.filter((e) => e.type === 'notice').map((e) => e.kind ?? e.level),
  };
}

/**
 * Films the side panel as JPEG frames piped to Playwright's own ffmpeg (VP8 only),
 * at a steady PANEL_FPS: a late frame is written again to keep the timing true.
 */
function panelRecorder(panel, out) {
  const ffmpeg = findFfmpeg();
  // The same input options Playwright's own recorder passes to this ffmpeg build.
  const proc = spawn(ffmpeg, ['-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(PANEL_FPS), '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-y', '-an', '-c:v', 'vp8', '-deadline', 'realtime', '-speed', '8', '-b:v', '400k', out], { stdio: ['pipe', 'ignore', 'inherit'] });
  const startedAt = Date.now();
  let written = 0;
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const frame = await panel.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
      const due = Math.floor(((Date.now() - startedAt) / 1000) * PANEL_FPS) + 1;
      if (frame) while (written < due) { proc.stdin.write(frame); written += 1; }
      await new Promise((r) => setTimeout(r, 1000 / PANEL_FPS / 2));
    }
  })();
  return {
    startedAt,
    async stop() {
      stop = true;
      await loop;
      proc.stdin.end();
      await new Promise((r) => proc.on('close', r));
    },
  };
}


async function preflight() {
  const { testProviderSlot } = await import('../src/agent/model-session.js');
  console.log('Model                                    latency   reply');
  for (const model of models) {
    const settings = settingsFor(model);
    const result = await testProviderSlot(settings, { ...settings, vision: true, allowJavascript: false, replyLanguage: { enabled: false } })
      .then((r) => `${String(r.ms).padStart(6)} ms   ${JSON.stringify(r.reply)}`)
      .catch((err) => `FAILED   ${err.message.slice(0, 160)}`);
    console.log(`${model.id.padEnd(40)} ${result}`);
  }
}

/** A scripted model for --mock: reads the page, opens Travel, sorts nothing, reports the known answer. */
async function startMockModel() {
  let turn = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/v1/models') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[{"id":"mock"}]}');
      const body = JSON.parse(raw);
      const last = [...body.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
      const steps = [
        () => [['read_page', {}]],
        () => [['click', { index: Number(last.match(/\[(\d+)\] a "Travel"/)?.[1] ?? 0) }]],
        () => [['done', { success: true, report: '| Title | Price |\n|---|---|\n| The Road to Little Dribbling | £23.21 |\n| 1,000 Places to See Before You Die | £26.08 |\n| The Great Railway Bazaar | £30.54 |' }]],
      ];
      const calls = steps[Math.min(turn++, steps.length - 1)]();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      calls.forEach(([name, a], i) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: `m${turn}_${i}`, function: { name, arguments: JSON.stringify(a) } }] } }] })}\n\n`));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function loadEnv() {
  const file = path.join(ROOT, ENV_FILE);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, ENV_TEMPLATE);
    throw new Error(`Created ${ENV_FILE}: put your API keys in it, then run again.`);
  }
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter((m) => m && m[2])
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
}

function parseArgs(argv) {
  const out = { jev: true, timeout: 360, out: new Date().toISOString().slice(0, 10), force: false, preflight: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--models') out.models = argv[++i].split(',');
    else if (a === '--tasks') out.tasks = argv[++i].split(',');
    else if (a === '--no-jev') out.jev = false;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--force') out.force = true;
    else if (a === '--preflight') out.preflight = true;
    else if (a === '--mock') out.mock = true;
  }
  return out;
}
