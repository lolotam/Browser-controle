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
//   E2E_SCREENSHOTS=out E2E_COLOR_SCHEME=dark npm run e2e   (save the panel after each scenario for visual review)

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
/** With askFirst the run starts by asking the user, so it stays running until a test answers. */
function scriptedLlm({ askFirst = false } = {}) {
  let sawImage = false;
  const steps = [
    ...(askFirst ? [() => ['ask_user', { question: 'Shall I start?' }]] : []),
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

/** Mock chat-model fast layer: answers like scriptedJev, in the chat judge's JSON shape. */
function scriptedJudge() {
  const jev = scriptedJev();
  return (body) => {
    const { answers } = jev({ state: JSON.parse(body.messages.at(-1).content) });
    return Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.type === 'noul' ? a.noul : { probabilities: a.probabilities }]));
  };
}

/** Mock Vercel decision API: answers like scriptedJev, in the gateway's answer shape. */
function scriptedGatewayJev() {
  const jev = scriptedJev();
  return (body) => {
    const { answers } = jev({ state: body.state });
    return {
      model: 'typesafe-ai/jev',
      answers: Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.type === 'noul'
        ? { type: 'boolean', probability: a.noul }
        : { type: 'choice', choice: a.choice, probabilities: a.probabilities }])),
    };
  };
}

function startServer(handlers) {
  const counts = { llm: 0, jev: 0, judge: 0, decision: 0, backup: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        if (req.url === '/page' || req.url.startsWith('/page?')) {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
        } else if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        } else if (req.url === '/v1/chat/completions' || req.url === '/b1/chat/completions') {
          const body = JSON.parse(raw);
          const isBackup = req.url.startsWith('/b1/');
          if (body.response_format) {
            counts.judge += 1;
            if (req.headers.authorization !== 'Bearer judge-key') throw new Error('missing judge key');
            const content = JSON.stringify(handlers.judge(body));
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ model: 'mock-judge', choices: [{ message: { role: 'assistant', content } }] }));
            return;
          }
          if (isBackup) counts.backup += 1;
          else counts.llm += 1;
          const scripted = (isBackup ? handlers.backup : handlers.llm)(body);
          if (scripted === 'quota') {
            res.writeHead(429, { 'Content-Type': 'application/json' }).end('{"error":{"message":"You exceeded your current quota"}}');
            return;
          }
          const [name, args] = scripted;
          const id = `call_${isBackup ? 'b' : ''}${counts.llm + counts.backup}`;
          const chunks = [
            { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
          ];
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
          res.end('data: [DONE]\n\n');
        } else if (req.url === '/v4/ai/decision-model') {
          counts.decision += 1;
          if (req.headers.authorization !== 'Bearer vercel-key' || req.headers['ai-model-id'] !== 'typesafe-ai/jev') throw new Error('bad decision request headers');
          const body = JSON.parse(raw);
          if (Object.values(body.questions).some((q) => q.type === 'noul')) throw new Error('noul must be sent as boolean');
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(handlers.decision(body)));
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

async function runScenario(context, extensionId, { name, task, handlers, fast, expectReport, check, stopWorker = false }) {
  const { server, counts, base } = await startServer(handlers);
  const panel = await context.newPage();
  const pageErrors = [];
  panel.on('pageerror', (err) => pageErrors.push(err.message));
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    if (name === 'llm') {
      // Settings UI: switching to the compatible provider lists the mock server's models.
      // Settings open by themselves only while no model is saved, which depends on scenario order.
      // The preset list is filled by init(), so this waits until the form is ready.
      await panel.waitForFunction(() => document.querySelectorAll('#preset option').length > 0);
      if (await panel.isHidden('#settingsView')) await panel.click('#settingsBtn');
      await panel.selectOption('#provider', 'compatible');
      await panel.selectOption('#preset', 'custom');
      await panel.fill('#baseUrl', `${base}/v1`);
      await panel.click('#refreshModelsBtn');
      await panel.waitForFunction(() => [...document.querySelectorAll('#modelSelect option')].some((o) => o.value === 'mock-model'));
    }
    await panel.evaluate(([baseUrl, fastConfig, fallback]) => chrome.storage.local.set({
      settings: {
        ...(fallback ? { fallback: { enabled: true, provider: 'compatible', compatible: { preset: 'custom', baseUrl: `${baseUrl}/b1`, apiKey: '', model: 'mock-backup', effort: '' } } } : {}),
        provider: 'compatible',
        compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' },
        fast: fastConfig ?? { enabled: false },
        vision: true,
        maxSteps: 12,
      },
    }), [base, fast?.(base), Boolean(handlers.backup)]);
    await panel.reload();
    await panel.click('#newChatBtn');

    const target = await context.newPage();
    await target.goto(`${base}/page`);
    await target.bringToFront();
    if (stopWorker) {
      // Chrome stops an idle worker while the panel stays open; the panel's first task must still arrive.
      const cdp = await context.newCDPSession(panel);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await panel.waitForTimeout(500);
    }

    await panel.fill('#input', task);
    await panel.click('#sendBtn');
    const final = await panel.waitForSelector('.msg.final', { timeout: 60000 });
    const report = await final.innerText();
    if (process.env.E2E_SCREENSHOTS) {
      await panel.setViewportSize({ width: 400, height: 720 });
      await panel.screenshot({ path: path.join(process.env.E2E_SCREENSHOTS, `${name}-${process.env.E2E_COLOR_SCHEME ?? 'light'}.png`) });
    }
    const steps = await panel.$$eval('.step', (rows) => rows.map((r) => `${r.classList.contains('fast') ? '⚡' : ' '} ${r.innerText.replace(/\s+/g, ' ')}`));
    console.log(`\n== scenario: ${name} ==\n${steps.join('\n')}\n--- report ---\n${report}\n(LLM calls: ${counts.llm}, Jev calls: ${counts.jev}, judge calls: ${counts.judge}, decision calls: ${counts.decision})`);

    const failures = [];
    const pageResult = await target.textContent('#out');
    if (!report.includes(expectReport)) failures.push(`report missing "${expectReport}" (page shows "${pageResult}")`);
    if (steps.some((s) => s.includes('✗'))) failures.push('a tool step failed');
    if (pageErrors.length) failures.push(`side panel errors: ${pageErrors.join(' | ')}`);
    const notices = await panel.$$eval('.notice.error', (rows) => rows.map((r) => r.innerText));
    if (notices.length) console.log(`notices: ${notices.join(' | ')}`);
    failures.push(...check({ counts, steps, report, notices }));
    await target.close();
    return failures;
  } finally {
    await panel.close();
    server.close();
  }
}

/** Primary model that answers once, then reports its quota as exhausted. */
function quotaAfterFirstTurn() {
  let turn = 0;
  return () => (turn++ === 0 ? ['read_page', {}] : 'quota');
}

/** Shared by both fast scenarios: two fast steps, then exactly one LLM call for the report. */
function fastChecks({ counts, steps, report }) {
  return [
    ...(counts.llm === 1 ? [] : [`expected 1 LLM call, got ${counts.llm}`]),
    ...(steps.filter((s) => s.startsWith('⚡')).length === 2 ? [] : ['expected 2 fast steps']),
    ...(report.includes('handover mentions fast steps: true') ? [] : ['LLM was not told about fast steps']),
  ];
}

/** One scripted LLM per conversation, keyed by its first user message, so parallel sessions stay apart. */
function perTask(makeScript) {
  const scripts = new Map();
  return (body) => {
    const first = body.messages.find((m) => m.role === 'user');
    const key = typeof first.content === 'string' ? first.content : JSON.stringify(first.content);
    if (!scripts.has(key)) scripts.set(key, makeScript(key));
    return scripts.get(key)(body);
  };
}

/**
 * Two sessions run tasks at the same time on two tabs. Each must finish its own
 * task, and each tab must end up in its own session's tab group.
 */
async function runParallelScenario(context, extensionId) {
  const { server, counts, base } = await startServer({ llm: perTask((task) => scriptedLlm({ askFirst: task.includes('session A') })) });
  const pages = [];
  const pageErrors = [];
  try {
    const openPanel = async () => {
      const panel = await context.newPage();
      panel.on('pageerror', (err) => pageErrors.push(err.message));
      pages.push(panel);
      await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
      return panel;
    };
    const panelA = await openPanel();
    await panelA.evaluate((baseUrl) => chrome.storage.local.set({
      settings: { provider: 'compatible', compatible: { preset: 'custom', baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model', effort: '' }, fast: { enabled: false }, vision: true, maxSteps: 12 },
    }), base);
    await panelA.reload();
    await panelA.click('#newChatBtn');
    const panelB = await openPanel();
    await panelB.click('#newChatBtn');

    const targetA = await context.newPage();
    await targetA.goto(`${base}/page?s=a`);
    const targetB = await context.newPage();
    await targetB.goto(`${base}/page?s=b`);
    pages.push(targetA, targetB);

    await targetA.bringToFront();
    await panelA.fill('#input', 'Fill the form and report the result (session A)');
    await panelA.click('#sendBtn');
    // A has claimed tab A and now waits on its question, so it is running for as long as the test needs.
    await panelA.waitForSelector('.msg.ask', { timeout: 30000 });
    // While A runs, the other panel must list it (with its running dot) so another tab can open it.
    await panelB.click('#sessionBtn');
    const runningListedInB = await panelB.waitForSelector('.session-item .dot.running', { timeout: 5000 }).then(() => true, () => false);
    await panelB.click('#sessionBtn');
    await targetB.bringToFront();
    await panelB.fill('#input', 'Fill the form and report the result (session B)');
    await panelB.click('#sendBtn');
    await panelB.waitForSelector('.step', { timeout: 30000 }); // B has claimed tab B
    await panelA.fill('#input', 'Yes, start');
    await panelA.click('#sendBtn');

    const [reportA, reportB] = await Promise.all([panelA, panelB].map(async (panel) => (await panel.waitForSelector('.msg.final', { timeout: 90000 })).innerText()));
    const groups = await panelA.evaluate(async () => Object.fromEntries((await chrome.tabs.query({})).filter((t) => t.url.includes('/page')).map((t) => [new URL(t.url).search, t.groupId])));
    const sessions = await panelA.evaluate(() => chrome.runtime.sendMessage({ type: 'sessions-list' }));
    console.log(`\n== scenario: parallel ==\nA: ${reportA.replace(/\s+/g, ' ')}\nB: ${reportB.replace(/\s+/g, ' ')}\ngroups ${JSON.stringify(groups)}, sessions ${sessions.result.length}, LLM calls ${counts.llm}`);

    const failures = [];
    for (const [name, report] of [['A', reportA], ['B', reportB]]) {
      if (!report.includes('Result: hello world / Blue')) failures.push(`session ${name} report is wrong: ${report}`);
    }
    if (!(groups['?s=a'] >= 0 && groups['?s=b'] >= 0 && groups['?s=a'] !== groups['?s=b'])) failures.push(`each tab should be in its own session group, got ${JSON.stringify(groups)}`);
    if (sessions.result.filter((s) => /session [AB]\)?/.test(s.title) || s.title.startsWith('Fill the form')).length < 2) failures.push('both sessions should be listed with titles from their tasks');
    if (!runningListedInB) failures.push('a running session was missing from the session list of the other panel');
    if (pageErrors.length) failures.push(`side panel errors: ${pageErrors.join(' | ')}`);
    return failures;
  } finally {
    for (const page of pages) await page.close();
    server.close();
  }
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    colorScheme: process.env.E2E_COLOR_SCHEME === 'dark' ? 'dark' : 'light',
    executablePath: process.env.CHROMIUM_PATH || undefined,
    // The default headless shell cannot load extensions; full Chromium in new headless mode can.
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;

    const failures = [
      ...(await runParallelScenario(context, extensionId)),
      ...(await runScenario(context, extensionId, {
        name: 'llm',
        task: 'Fill the form and report the result',
        handlers: { llm: scriptedLlm() },
        expectReport: 'Result: hello world / Blue',
        check: ({ report }) => (report.includes('screenshot seen: true') ? [] : ['screenshot never reached the model']),
      })),
      ...(await runScenario(context, extensionId, {
        name: 'worker-restart',
        task: 'Fill the form and report the result',
        handlers: { llm: scriptedLlm() },
        stopWorker: true,
        expectReport: 'Result: hello world / Blue',
        check: () => [],
      })),
      ...(await runScenario(context, extensionId, {
        name: 'fallback',
        task: 'Fill the form and report the result',
        handlers: { llm: quotaAfterFirstTurn(), backup: scriptedLlm() },
        expectReport: 'Result: hello world / Blue',
        check: ({ counts, notices }) => [
          ...(counts.llm === 2 && counts.backup >= 6 ? [] : [`expected 2 primary calls then the backup (primary ${counts.llm}, backup ${counts.backup})`]),
          ...(notices.length === 1 && /mock-backup/.test(notices[0]) ? [] : [`expected one red notice naming the backup, got ${JSON.stringify(notices)}`]),
        ],
      })),
      ...(await runScenario(context, extensionId, {
        name: 'fast',
        task: 'Search for "hello world" and press Go',
        handlers: { llm: reportingLlm(), jev: scriptedJev() },
        fast: (base) => ({ enabled: true, mode: 'auto', provider: 'typesafe', apiKey: 'jev-key', model: 'jev-latest', baseUrl: base }),
        expectReport: 'Result: hello world / Red',
        check: fastChecks,
      })),
      ...(await runScenario(context, extensionId, {
        name: 'vercel-jev',
        task: 'Search for "hello world" and press Go',
        handlers: { llm: reportingLlm(), decision: scriptedGatewayJev() },
        fast: (base) => ({ enabled: true, mode: 'auto', provider: 'vercel', decision: true, apiKey: 'vercel-key', model: 'typesafe-ai/jev', baseUrl: `${base}/v1`, minProb: 0.6 }),
        expectReport: 'Result: hello world / Red',
        check: (run) => [
          ...fastChecks(run),
          ...(run.counts.decision >= 2 && run.counts.judge === 0 ? [] : [`expected the decision API (decision ${run.counts.decision}, judge ${run.counts.judge})`]),
        ],
      })),
      ...(await runScenario(context, extensionId, {
        name: 'chat-fast',
        task: 'Search for "hello world" and press Go',
        handlers: { llm: reportingLlm(), judge: scriptedJudge() },
        fast: (base) => ({ enabled: true, mode: 'auto', provider: 'custom', apiKey: 'judge-key', model: 'mock-judge', baseUrl: `${base}/v1`, minProb: 0.75 }),
        expectReport: 'Result: hello world / Red',
        check: (run) => [
          ...fastChecks(run),
          ...(run.counts.judge >= 2 && run.counts.jev === 0 ? [] : [`expected the chat judge, not Jev (judge ${run.counts.judge}, jev ${run.counts.jev})`]),
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
