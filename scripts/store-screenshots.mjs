// Store screenshots (1280×800) and the small promo tile (440×280), taken from the
// packaged build in dist/ running in Chromium against a local demo page and a
// scripted mock model. Also proves the store ZIP loads and works.
//
//   npm run package && npm run store-screenshots
//   (CHROMIUM_PATH=... if Playwright's Chromium is not installed)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'store-assets');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/** Extracts the store ZIP (our own deflate-only archive) so Chromium loads exactly what is uploaded. */
function unpack(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-pkg-'));
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const start = p + 30 + nameLen;
    fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), zlib.inflateRawSync(buf.subarray(start, start + size)));
    p = start + size;
  }
  return dir;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Flight search demo</title><style>
body{margin:0;font:15px system-ui,"Segoe UI",sans-serif;background:#f4f6fb;color:#1d2433}
header{background:#1f3a8a;color:#fff;padding:18px 32px;font-weight:600;font-size:18px}
main{padding:28px 32px}.card{background:#fff;border:1px solid #dde3ef;border-radius:12px;padding:20px;display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:14px;align-items:end}
label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:#56607a}input,select{font:inherit;padding:10px;border:1px solid #c9d1e3;border-radius:8px}
button{font:inherit;padding:11px 22px;border:0;border-radius:8px;background:#f59e0b;color:#1d2433;font-weight:600}
#results{margin-top:20px;display:grid;gap:10px}.r{background:#fff;border:1px solid #dde3ef;border-radius:10px;padding:14px 18px;display:flex;justify-content:space-between}
.r b{font-size:17px}</style></head><body><header>✈ Flight search (demo)</header><main>
<div class="card"><label>From<input id="from" placeholder="City"></label><label>To<input id="to" placeholder="City"></label>
<label>Date<select id="date"><option>18 Oct</option><option>19 Oct</option><option>20 Oct</option></select></label><button id="go">Search flights</button></div>
<div id="results"></div></main><script>
document.getElementById('go').onclick=()=>{document.getElementById('results').innerHTML=[['08:10','Direct · 4h 05m','$214'],['13:45','1 stop · 6h 30m','$176'],['21:20','Direct · 4h 10m','$239']]
.map(([t,d,p])=>'<div class="r"><span><b>'+t+'</b> &nbsp; '+d+'</span><b>'+p+'</b></div>').join('')}</script></body></html>`;

const REPORT = '## Cheapest flight: Cairo → Dubai, 20 Oct\n\n| Departure | Route | Price |\n|---|---|---|\n| **13:45** | 1 stop · 6h 30m | **$176** |\n| 08:10 | Direct · 4h 05m | $214 |\n| 21:20 | Direct · 4h 10m | $239 |\n\nThe cheapest option is **$176** (13:45, one stop). The cheapest direct flight is $214 at 08:10.';

let hold = null; // holds back the final report so the task is photographed while it runs
function llm(body) {
  const tool = [...body.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
  const idx = (re) => Number(tool.match(re)?.[1] ?? 0);
  const n = body.messages.filter((m) => m.role === 'tool').length;
  const steps = [
    () => ['read_page', {}],
    () => ['type_text', { index: idx(/\[(\d+)\] input[^\n]*placeholder="City"/), text: 'Cairo' }],
    (t) => ['type_text', { index: Number([...t.matchAll(/\[(\d+)\] input[^\n]*placeholder="City"/g)][1]?.[1] ?? 1), text: 'Dubai' }],
    () => ['select_option', { index: idx(/\[(\d+)\] select/), option: '20 Oct' }],
    () => ['click', { index: idx(/\[(\d+)\] button "Search flights"/) }],
    () => ['done', { success: true, report: REPORT }],
  ];
  return steps[Math.min(n, steps.length - 1)](tool);
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    if (req.url.startsWith('/page')) return res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    if (req.url === '/v1/models') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[{"id":"gpt-5"}]}');
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    const [name, args] = llm(JSON.parse(raw));
    if (name === 'done' && hold) await hold.promise;
    const id = `call_${Math.random().toString(36).slice(2)}`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const zipPath = path.join(ROOT, 'dist', `postora-browser-agent-v${version}.zip`);
if (!fs.existsSync(zipPath)) throw new Error(`Run "npm run package" first (missing ${path.relative(ROOT, zipPath)}).`);
const ext = unpack(zipPath);
const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'cws-shots-')), {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const errors = [];

const panel = await context.newPage();
panel.on('pageerror', (e) => errors.push(e.message));
await panel.setViewportSize({ width: 400, height: 800 });
await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
await panel.evaluate((b) => chrome.storage.local.set({ settings: {
  provider: 'compatible', vision: true, maxSteps: 20, uiLanguage: 'en',
  compatible: { preset: 'openai', baseUrl: `${b}/v1`, apiKey: 'sk-demo', model: 'gpt-5', effort: '' },
  fallback: { enabled: true, provider: 'compatible', compatible: { preset: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat', effort: '' } },
} }), base);
await panel.reload();

const page = await context.newPage();
await page.setViewportSize({ width: 880, height: 800 });
await page.goto(`${base}/page`);
await page.bringToFront();

const shot = async (p) => `data:image/png;base64,${(await p.screenshot()).toString('base64')}`;
const compose = async (file, left, right) => {
  const c = await context.newPage();
  await c.setViewportSize({ width: 1280, height: 800 });
  await c.setContent(`<body style="margin:0;display:flex;background:#fff"><img src="${left}" width="880" height="800"><img src="${right}" width="400" height="800" style="border-left:1px solid #d4d4d4;box-sizing:border-box"></body>`);
  await c.screenshot({ path: path.join(OUT, file) });
  await c.close();
};
fs.mkdirSync(OUT, { recursive: true });

// 1. Mid-task: the cursor glides to "Search flights" while the panel lists the steps.
hold = {};
hold.promise = new Promise((resolve) => { hold.resolve = resolve; });
await panel.fill('#input', 'Find the cheapest flight from Cairo to Dubai on 20 Oct and compare it with the direct flights');
await panel.click('#sendBtn');
await panel.waitForFunction(() => document.querySelectorAll('.step').length >= 5, null, { timeout: 30000 }); // the click step started
await new Promise((r) => setTimeout(r, 250)); // part-way through the cursor's glide
const working = await shot(page);
await compose('screenshot-1-working.png', working, await shot(panel));

// 2. The final report.
hold.resolve();
await panel.waitForSelector('.msg.final', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 600));
await compose('screenshot-2-report.png', await shot(page), await shot(panel));

// 3. Settings: main and backup providers, each in its own frame.
await panel.click('#settingsBtn');
await new Promise((r) => setTimeout(r, 500));
await panel.fill('#baseUrl', 'https://api.openai.com/v1'); // shown only, never saved: hides the local mock's address
await compose('screenshot-3-settings.png', await shot(page), await shot(panel));

// Small promo tile.
const tile = await context.newPage();
await tile.setViewportSize({ width: 440, height: 280 });
const logo = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'icons', 'logo-source.png')).toString('base64')}`;
await tile.setContent(`<body style="margin:0;width:440px;height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:linear-gradient(135deg,#0d0f14,#2a1846);color:#fff;font:600 26px 'Segoe UI',system-ui,sans-serif">
  <img src="${logo}" width="96" height="96" alt="">
  <div>Postora Browser Agent</div><div style="font:400 15px 'Segoe UI',system-ui,sans-serif;color:#f5b14c">Tell it the task. Watch it work.</div></body>`);
await tile.screenshot({ path: path.join(OUT, 'promo-small-440x280.png') });

await context.close();
server.close();
if (errors.length) throw new Error(`Side panel errors: ${errors.join(' | ')}`);
console.log(`Store assets written to ${path.relative(ROOT, OUT)}/ (extension ${extId} loaded from the store ZIP)`);
