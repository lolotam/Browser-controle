// End-to-end check: loads the unpacked extension into Chromium, points it at
// scripted mock models, and verifies the agent really acts on a local page.
//
// Scenario "llm":  an OpenAI-compatible mock LLM drives every step (types,
//                  selects, clicks, screenshots, reads, reports).
// Scenario "fast": a mock Jev (TypeSafe System One) fast layer types and clicks
//                  on its own; the LLM is called once, only to write the report.
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

const find = (text, re) => {
  const m = text.match(re);
  if (!m) throw new Error(`mock could not find ${re} in:\n${text}`);
  return m[1];
};

/** Mock LLM for the "llm" scenario: drives the whole task itself. */
function scriptedLlm() {
  let sawImage = false;
  const steps = [
    () => ['read_page', {}],
    (last) => ['type_text', { index: Number(find(last, /\[(\d+)\] input[^\n]*placeholder="Search"/)), text: 'hello world' }],
    (last) => ['select_option', { index: Number(find(last, /\[(\d+)\] select/)), option: 'Blue' }],
    (last) => ['click', { index: Number(find(last, /\[(\d+)\] button "Go"/)) }],
    () => ['screenshot', {}],
    () => ['get_text', {}],
    (last) => ['done', { success: true, report: `## Done\n- ${last.match(/Result: [^\n]*/)?.[0] ?? 'NO RESULT'}\n- screenshot seen: ${sawImage}` }],
  ];
  let turn = 0;
  return (body) => {
    const lastTool = [...body.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
    const lastUser = body.messages.at(-1);
    if (Array.isArray(lastUser.content) && lastUser.content.some((c) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/jpeg'))) sawImage = true;
    return steps[Math.min(turn++, steps.length - 1)](lastTool);
  };
}

/** Mock LLM for the "fast" scenario: only reads the hand-over note and reports. */
function reportingLlm() {
  return (body) => {
    const handover = body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    return ['done', { success: true, report: `## Done\n- ${handover.match(/Result: [^\n]*/)?.[0] ?? 'NO RESULT'}\n- handover mentions fast steps: ${/executed automatically/.test(handover)}` }];
  };
}

/** Mock Jev: confident type → click, then "goal done". */
function scriptedJev() {
  let turn = 0;
  const choice = (picked) => ({ type: 'choice', choice: picked, confidence: 0.95, probabilities: { [picked]: 0.97 } });
  return (body) => {
    const els = body.state.INTERACTIVE_ELEMENTS;
    const answers = { risky: { type: 'noul', noul: 0.02 }, goal_done: { type: 'noul', noul: 0.05 } };
    if (turn === 0) {
      Object.assign(answers, { operation: choice('type'), target: choice(find(els, /^(e\d+): input[^\n]*placeholder="Search"/m)), text: choice('t0') });
    } else if (turn === 1) {
      Object.assign(answers, { operation: choice('click'), target: choice(find(els, /^(e\d+): button "Go"/m)) });
    } else {
      Object.assign(answers, { operation: choice('done'), goal_done: { type: 'noul', noul: 0.96 } });
    }
    turn += 1;
    return { model: 'jev-mock', answers, usage: { input_tokens: 1, output_tokens: 1 } };
  };
}

function startServer(handlers) {
  const counts = { llm: 0, jev: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        if (req.url === '/page') {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
        } else if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        } else if (req.url === '/v1/chat/completions') {
          counts.llm += 1;
          const [name, args] = handlers.llm(JSON.parse(raw));
          const id = `call_${counts.llm}`;
          const chunks = [
            { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
          ];
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
          res.end('data: [DONE]\n\n');
        } else if (req.url === '/v1/systemone') {
          counts.jev += 1;
          if (req.headers.authorization !== 'Bearer jev-key') throw new Error('missing Jev key');
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(handlers.jev(JSON.parse(raw))));
        } else {
          res.writeHead(404).end();
        }
      } catch (err) {
        console.error(err.message);
        res.writeHead(500).end(err.message);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, counts, base: `http://127.0.0.1:${server.address().port}` })));
}

async function runScenario(context, extensionId, { name, task, handlers, fast, expectReport, check }) {
  const { server, counts, base } = await startServer(handlers);
  const panel = await context.newPage();
  const pageErrors = [];
  panel.on('pageerror', (err) => pageErrors.push(err.message));
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    if (name === 'llm') {
      // Settings UI: switching to the compatible provider lists the mock server's models.
      await panel.waitForSelector('#settingsView:not([hidden])');
      await panel.selectOption('#provider', 'compatible');
      await panel.selectOption('#preset', 'custom');
      await panel.fill('#baseUrl', `${base}/v1`);
      await panel.click('#refreshModelsBtn');
      await panel.waitForFunction(() => [...document.querySelectorAll('#modelSelect option')].some((o) => o.value === 'mock-model'));
    }
    await panel.evaluate(([baseUrl, fastConfig]) => chrome.storage.local.set({
      settings: {
        provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' },
        fast: fastConfig ? { ...fastConfig, baseUrl } : { enabled: false },
        vision: true,
        maxSteps: 12,
      },
    }), [base, fast]);
    await panel.reload();
    await panel.click('#newChatBtn');

    const target = await context.newPage();
    await target.goto(`${base}/page`);
    await target.bringToFront();

    await panel.fill('#input', task);
    await panel.click('#sendBtn');
    const final = await panel.waitForSelector('.msg.final', { timeout: 60000 });
    const report = await final.innerText();
    const steps = await panel.$$eval('.step', (rows) => rows.map((r) => `${r.classList.contains('fast') ? '⚡' : ' '} ${r.innerText.replace(/\s+/g, ' ')}`));
    console.log(`\n== scenario: ${name} ==\n${steps.join('\n')}\n--- report ---\n${report}\n(LLM calls: ${counts.llm}, Jev calls: ${counts.jev})`);

    const failures = [];
    const pageResult = await target.textContent('#out');
    if (!report.includes(expectReport)) failures.push(`report missing "${expectReport}" (page shows "${pageResult}")`);
    if (steps.some((s) => s.includes('✗'))) failures.push('a tool step failed');
    if (pageErrors.length) failures.push(`side panel errors: ${pageErrors.join(' | ')}`);
    failures.push(...check({ counts, steps, report }));
    await target.close();
    return failures;
  } finally {
    await panel.close();
    server.close();
  }
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;

    const failures = [
      ...(await runScenario(context, extensionId, {
        name: 'llm',
        task: 'Fill the form and report the result',
        handlers: { llm: scriptedLlm() },
        expectReport: 'Result: hello world / Blue',
        check: ({ report }) => (report.includes('screenshot seen: true') ? [] : ['screenshot never reached the model']),
      })),
      ...(await runScenario(context, extensionId, {
        name: 'fast',
        task: 'Search for "hello world" and press Go',
        handlers: { llm: reportingLlm(), jev: scriptedJev() },
        fast: { enabled: true, mode: 'auto', apiKey: 'jev-key', model: 'jev-latest' },
        expectReport: 'Result: hello world / Red',
        check: ({ counts, steps, report }) => [
          ...(counts.llm === 1 ? [] : [`expected 1 LLM call, got ${counts.llm}`]),
          ...(steps.filter((s) => s.startsWith('⚡')).length === 2 ? [] : ['expected 2 fast steps']),
          ...(report.includes('handover mentions fast steps: true') ? [] : ['LLM was not told about fast steps']),
        ],
      })),
    ];
    if (failures.length) throw new Error(failures.join('; '));
    console.log('\nE2E PASSED');
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error('E2E FAILED:', err.message);
  process.exit(1);
});
