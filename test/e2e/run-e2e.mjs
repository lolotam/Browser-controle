// End-to-end check: loads the unpacked extension into Chromium, points it at a
// scripted OpenAI-compatible mock model, and verifies the agent really types,
// selects, clicks, screenshots and reports on a local page.
//
//   npm install && npm run e2e
//   CHROMIUM_PATH=/path/to/chrome npm run e2e   (if Playwright's browser is not installed)

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PAGE = `<!doctype html><html><body>
<h1>Agent test page</h1>
<input id="q" name="q" placeholder="Search">
<select id="color"><option>Red</option><option>Blue</option></select>
<button id="go" onclick="document.getElementById('out').textContent = 'Result: ' + q.value + ' / ' + color.value">Go</button>
<div id="out"></div>
</body></html>`;

function scriptedModel() {
  let sawImage = false;
  const find = (text, re) => {
    const m = text.match(re);
    if (!m) throw new Error(`mock model could not find ${re} in:\n${text}`);
    return Number(m[1]);
  };
  const steps = [
    () => ['read_page', {}],
    (last) => ['type_text', { index: find(last, /\[(\d+)\] input[^\n]*placeholder="Search"/), text: 'hello world' }],
    (last) => ['select_option', { index: find(last, /\[(\d+)\] select/), option: 'Blue' }],
    (last) => ['click', { index: find(last, /\[(\d+)\] button "Go"/) }],
    () => ['screenshot', {}],
    () => ['get_text', {}],
    (last) => ['done', { success: true, report: `## Done\n- ${last.match(/Result: [^\n]*/)?.[0] ?? 'NO RESULT'}\n- screenshot seen: ${sawImage}` }],
  ];
  let turn = 0;
  return (body) => {
    const messages = body.messages;
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
    const lastUser = messages.at(-1);
    if (Array.isArray(lastUser.content) && lastUser.content.some((c) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/jpeg'))) sawImage = true;
    const [name, args] = steps[Math.min(turn, steps.length - 1)](lastTool);
    turn += 1;
    return [
      { choices: [{ delta: { content: `Step ${turn}. ` } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${turn}`, function: { name, arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
    ];
  };
}

async function main() {
  const model = scriptedModel();
  const server = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    } else if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    } else if (req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try {
          const chunks = model(JSON.parse(raw));
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
          res.end('data: [DONE]\n\n');
        } catch (err) {
          console.error(err.message);
          res.writeHead(500).end(err.message);
        }
      });
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;

    const panel = await context.newPage();
    const pageErrors = [];
    panel.on('pageerror', (err) => pageErrors.push(err.message));
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);

    // Settings UI: switching to the compatible provider lists the mock server's models.
    await panel.waitForSelector('#settingsView:not([hidden])');
    await panel.selectOption('#provider', 'compatible');
    await panel.selectOption('#preset', 'custom');
    await panel.fill('#baseUrl', `${base}/v1`);
    await panel.click('#refreshModelsBtn');
    await panel.waitForFunction(() => [...document.querySelectorAll('#modelSelect option')].some((o) => o.value === 'mock-model'));

    await panel.evaluate((baseUrl) => chrome.storage.local.set({
      settings: { provider: 'compatible', compatible: { preset: 'custom', baseUrl, apiKey: '', model: 'mock-model', effort: '' }, vision: true, maxSteps: 12 },
    }), `${base}/v1`);

    const target = await context.newPage();
    await target.goto(`${base}/page`);
    await target.bringToFront();

    await panel.fill('#input', 'Fill the form and report the result');
    await panel.click('#sendBtn');
    const final = await panel.waitForSelector('.msg.final', { timeout: 60000 });
    const report = await final.innerText();
    const steps = await panel.$$eval('.step', (rows) => rows.map((r) => r.innerText.replace(/\s+/g, ' ')));
    console.log(steps.join('\n'));
    console.log('---\n' + report);

    const pageResult = await target.textContent('#out');
    const failures = [];
    if (pageResult !== 'Result: hello world / Blue') failures.push(`page shows "${pageResult}"`);
    if (!report.includes('Result: hello world / Blue')) failures.push('report missing the page result');
    if (!report.includes('screenshot seen: true')) failures.push('screenshot never reached the model');
    if (steps.some((s) => s.startsWith('✗'))) failures.push('a tool step failed');
    if (pageErrors.length) failures.push(`side panel errors: ${pageErrors.join(' | ')}`);
    if (failures.length) throw new Error(failures.join('; '));
    console.log('\nE2E PASSED');
  } finally {
    await context.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('E2E FAILED:', err.message);
  process.exit(1);
});
