# Fast Layer on Gateway Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the ⚡ fast layer run on OpenRouter, Vercel AI Gateway or any OpenAI-compatible model, chosen in settings with its own API key and model.

**Architecture:** A new client `askChatJudge` honours the exact contract of `askJev` (`{baseUrl, apiKey, model, state, questions, signal}` → `{answers, usage, model}`), answering all typed questions with one JSON-mode chat completion. `fastClientFor(provider)` picks the client; `createFastLayer` already accepts it as `ask`, so the gate and agent loop do not change.

**Tech Stack:** Chrome MV3 extension, plain ES modules, `node --test`, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-08-fast-layer-gateway-providers-design.md`

## Global Constraints

- Providers: `typesafe` | `openrouter` | `vercel` | `custom`; stored fast settings without `provider` become `typesafe`.
- OpenRouter base `https://openrouter.ai/api/v1`; Vercel AI Gateway base `https://ai-gateway.vercel.sh/v1`; default gateway model `anthropic/claude-haiku-5.5`.
- `minProb` default 0.75 for gateway presets, 0.6 for TypeSafe.
- Chat judge timeout 15 s; request uses `response_format: { type: 'json_object' }`.
- No new dependencies. Match file style: 2-space indent, single quotes, comments explain *why*.
- Tests: `npm test`; e2e: `CHROMIUM_PATH=F:/Dev/Runtimes/ms-playwright/chromium-1243/chrome-win64/chrome.exe npm run e2e`.

---

### Task 1: Chat judge client

**Files:**
- Create: `src/fast/chat-judge-client.js`
- Create: `src/fast/clients.js`
- Test: `test/chat-judge.test.js`

**Interfaces:**
- Produces: `askChatJudge({ baseUrl, apiKey, model, state, questions, signal })` → `Promise<{ answers, usage, model }>`; `toAnswers(questions, reply)` → answers object; `fastClientFor(provider)` → `askJev | askChatJudge`.
- Reply shape the model must return: `{ "<choice question>": { "probabilities": { "<key>": number } }, "<noul question>": number }`.

- [ ] **Step 1: Write the failing tests** — `test/chat-judge.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askChatJudge, toAnswers } from '../src/fast/chat-judge-client.js';

const questions = {
  operation: { type: 'choice', instructions: 'Which operation?', criteria: { click: 'Click', scroll_down: 'Scroll', think: 'Think' } },
  risky: { type: 'noul', instructions: 'The next step is sensitive.' },
  goal_done: { type: 'noul', instructions: 'The goal is done.' },
};

function stubCompletion(content, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    if (status !== 200) return new Response('rate limited', { status });
    return Response.json({ model: 'served-model', usage: { total_tokens: 9 }, choices: [{ message: { role: 'assistant', content } }] });
  };
  return calls;
}

test('chat judge sends one JSON-mode completion and returns Jev-shaped answers', async () => {
  const calls = stubCompletion(JSON.stringify({ operation: { probabilities: { click: 0.9, scroll_down: 0.1 } }, risky: 0.05, goal_done: 0.1 }));

  const { answers, model } = await askChatJudge({ baseUrl: 'https://gw.example/v1/', apiKey: 'k1', model: 'm1', state: { GOAL: 'g' }, questions });

  assert.equal(calls[0].url, 'https://gw.example/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k1');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.deepEqual(JSON.parse(calls[0].body.messages.at(-1).content), { GOAL: 'g' });
  assert.equal(model, 'served-model');
  assert.equal(answers.operation.choice, 'click');
  assert.ok(Math.abs(answers.operation.confidence - 0.8) < 1e-9);
  assert.deepEqual(answers.risky, { type: 'noul', noul: 0.05 });
});

test('unknown options are dropped, probabilities renormalised and unusable answers omitted', () => {
  const answers = toAnswers(questions, {
    operation: { probabilities: { click: 3, hack: 5, think: 1 } },
    risky: 'maybe',
  });

  assert.deepEqual(answers.operation.probabilities, { click: 0.75, think: 0.25 });
  assert.equal(answers.operation.choice, 'click');
  assert.equal(answers.risky, undefined, 'a missing risk answer must escalate, never default to safe');
  assert.equal(answers.goal_done, undefined);
});

test('a JSON reply wrapped in a markdown fence is still parsed', async () => {
  stubCompletion('```json\n{"risky": 0.2}\n```');
  const { answers } = await askChatJudge({ baseUrl: 'https://gw.example/v1', apiKey: 'k', model: 'm', state: {}, questions });
  assert.equal(answers.risky.noul, 0.2);
});

test('non-JSON replies and HTTP errors are reported as failures', async () => {
  stubCompletion('I think you should click.');
  await assert.rejects(askChatJudge({ baseUrl: 'https://gw.example/v1', apiKey: 'k', model: 'm', state: {}, questions }), /did not return JSON/);
  stubCompletion('', 429);
  await assert.rejects(askChatJudge({ baseUrl: 'https://gw.example/v1', apiKey: 'k', model: 'm', state: {}, questions }), /HTTP 429/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/chat-judge.test.js`
Expected: FAIL — `Cannot find module '../src/fast/chat-judge-client.js'`

- [ ] **Step 3: Implement `src/fast/chat-judge-client.js`**

```js
// Plays Jev's role on any OpenAI-compatible chat model (OpenRouter, Vercel AI
// Gateway, a local server): one JSON-mode completion answers every typed
// question. The probabilities are the model's own estimate, not calibrated like
// Jev's, which is why gateway presets ask for a higher minimum probability.

const REQUEST_TIMEOUT_MS = 15000;

export async function askChatJudge({ baseUrl, apiKey, model, state, questions, signal }) {
  if (!apiKey) throw new Error('Fast layer API key is missing.');
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    credentials: 'omit',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: judgeInstructions(questions) },
        { role: 'user', content: JSON.stringify(state) },
      ],
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Fast layer request failed (HTTP ${res.status}): ${detail}`);
  }
  const body = await res.json();
  return { answers: toAnswers(questions, parseReply(body.choices?.[0]?.message?.content)), usage: body.usage ?? null, model: body.model ?? model };
}

function judgeInstructions(questions) {
  const lines = [
    'You are the fast decision layer of a browser agent. The user message is the current STATE as JSON (GOAL, URL, TITLE, PAGE_TEXT, INTERACTIVE_ELEMENTS, LAST_ACTIONS).',
    'Answer every question below. Reply with one JSON object only, keyed by question name:',
    '- a "choice" question: {"probabilities": {"<option key>": <number 0..1>, ...}} over the listed option keys, most mass on the best option;',
    '- a "noul" question: one number from 0 to 1, the probability that the statement is true.',
    'Spread probability when unsure; never invent option keys.',
    '',
    'Questions:',
  ];
  for (const [name, q] of Object.entries(questions)) {
    lines.push(`${name} (${q.type}): ${q.instructions}`);
    if (q.type === 'choice') for (const [key, text] of Object.entries(q.criteria)) lines.push(`  - ${key}: ${text}`);
  }
  return lines.join('\n');
}

// JSON mode is emulated for some models behind gateways, which may still fence the object.
function parseReply(content) {
  const text = String(content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Fast layer model did not return JSON.');
  }
}

/** Converts the model's reply to Jev's answer shape; unusable answers are left out so the gate escalates. */
export function toAnswers(questions, reply) {
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const answer = q.type === 'choice' ? choiceAnswer(q.criteria, reply?.[name]) : noulAnswer(reply?.[name]);
    if (answer) answers[name] = answer;
  }
  return answers;
}

function choiceAnswer(criteria, raw) {
  const scores = Object.entries(raw?.probabilities ?? {})
    .filter(([key]) => Object.hasOwn(criteria, key))
    .map(([key, p]) => [key, clamp01(Number(p))])
    .filter(([, p]) => p > 0);
  const total = scores.reduce((sum, [, p]) => sum + p, 0);
  if (!total) return null;
  const ranked = scores.map(([key, p]) => [key, p / total]).sort((a, b) => b[1] - a[1]);
  const [[choice, first], [, second] = [null, 0]] = ranked;
  return { type: 'choice', choice, confidence: first - second, probabilities: Object.fromEntries(ranked) };
}

function noulAnswer(raw) {
  const p = typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(p) ? { type: 'noul', noul: clamp01(p) } : null;
}

function clamp01(x) {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}
```

- [ ] **Step 4: Implement `src/fast/clients.js`**

```js
import { askChatJudge } from './chat-judge-client.js';
import { askJev } from './jev-client.js';

/** TypeSafe answers System One questions natively; every other provider goes through a chat model. */
export function fastClientFor(provider) {
  return provider === 'typesafe' ? askJev : askChatJudge;
}
```

- [ ] **Step 5: Run tests** — `npm test` → all pass.

- [ ] **Step 6: Commit** — `git add src/fast test/chat-judge.test.js && git commit -m "feat(fast): chat-model judge client with Jev's answer contract"`

---

### Task 2: Settings presets and model-list filtering

**Files:**
- Modify: `src/lib/settings.js`
- Modify: `src/providers/openai-compatible.js:9-17` (`listCompatibleModels`)
- Test: `test/providers.test.js`

**Interfaces:**
- Produces: `FAST_PRESETS` (`{ [provider]: { label, baseUrl, model, minProb } }`), `DEFAULT_SETTINGS.fast.provider === 'typesafe'`.

- [ ] **Step 1: Failing tests** — append to `test/providers.test.js` and add imports `mergeSettings` from `../src/lib/settings.js` and `listCompatibleModels` to the existing openai-compatible import.

```js
test('fast settings saved before providers existed keep using TypeSafe Jev', () => {
  const { fast } = mergeSettings({ fast: { enabled: true, apiKey: 'jev', baseUrl: 'https://api.typesafe.ai' } });
  assert.equal(fast.provider, 'typesafe');
});

test('model lists skip image, video and embedding models from gateways', async () => {
  globalThis.fetch = async () => Response.json({ data: [
    { id: 'anthropic/claude-haiku-5.5', type: 'language' },
    { id: 'openai/text-embedding-3', type: 'embedding' },
    { id: 'google/veo', type: 'video' },
    { id: 'local-model' },
  ] });
  const models = await listCompatibleModels('https://gw.example/v1', 'k');
  assert.deepEqual(models.map((m) => m.id), ['anthropic/claude-haiku-5.5', 'local-model']);
});
```

- [ ] **Step 2: Run** `node --test test/providers.test.js` → both new tests FAIL.

- [ ] **Step 3: Implement** in `src/lib/settings.js` after `COMPATIBLE_PRESETS`:

```js
export const FAST_PRESETS = {
  typesafe: { label: 'TypeSafe Jev', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', minProb: 0.6 },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-haiku-5.5', minProb: 0.75 },
  vercel: { label: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1', model: 'anthropic/claude-haiku-5.5', minProb: 0.75 },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: '', model: '', minProb: 0.75 },
};
```

and `fast:` default becomes `{ enabled: false, mode: 'auto', provider: 'typesafe', baseUrl: 'https://api.typesafe.ai', apiKey: '', model: 'jev-latest', minProb: 0.6, riskyMax: 0.3 }`.

In `listCompatibleModels`:

```js
// Gateways such as Vercel's list image, video and embedding models next to chat models.
const NON_CHAT_TYPES = new Set(['embedding', 'image', 'video', 'reranking', 'speech', 'transcription', 'realtime', 'evaluation']);
...
  return (body.data ?? body.models ?? [])
    .filter((m) => !NON_CHAT_TYPES.has(m.type))
    .map((m) => ({ id: m.id ?? m.name, name: m.id ?? m.name, efforts: [] }));
```

- [ ] **Step 4:** `npm test` → all pass. **Step 5:** commit `feat(settings): fast-layer provider presets; skip non-chat gateway models`.

---

### Task 3: Service worker wiring

**Files:** Modify `src/background/service-worker.js`

**Interfaces:** Consumes `fastClientFor`, `FAST_PRESETS`, `listCompatibleModels`. Produces messages: `get-settings` → `{ settings, presets, fastPresets }`; `fast-test` (`{config}`) → `{ model, noul }`; `list-fast-models` (`{config}`) → `[{id, name}]`.

- [ ] **Step 1:** import `FAST_PRESETS` from settings and `fastClientFor` from `../fast/clients.js`; drop the `askJev` import.
- [ ] **Step 2:** `get-settings` returns `{ settings: await loadSettings(), presets: COMPATIBLE_PRESETS, fastPresets: FAST_PRESETS }`.
- [ ] **Step 3:** replace `case 'jev-test'` with:

```js
    case 'fast-test': {
      const ask = fastClientFor(msg.config.provider);
      const { answers, model } = await ask({
        ...msg.config,
        state: { message: 'Hello, can you hear me?' },
        questions: { greeting: { type: 'noul', instructions: 'The message is a greeting or a connection check.' } },
      });
      return { model, noul: answers.greeting?.noul ?? null };
    }
    case 'list-fast-models':
      return listCompatibleModels(msg.config.baseUrl, msg.config.apiKey);
```

- [ ] **Step 4:** `createFastLayer({ config: settings.fast, browser, execute, task: text, ask: fastClientFor(settings.fast.provider) })`.
- [ ] **Step 5:** `node --check src/background/service-worker.js && npm test`; commit `feat(fast): route the fast layer and its connection test by provider`.

---

### Task 4: Panel fields

**Files:** Modify `src/sidepanel/index.html` (fast card), `src/sidepanel/panel.js`

- [ ] **Step 1 (html):** fast card title becomes `⚡ الطبقة السريعة`; add before the mode field:

```html
        <label class="field">
          <span>المزوّد</span>
          <select id="fastProvider"></select>
        </label>
```

API key label `API Key`; model field becomes `<input id="fastModel" dir="ltr" list="fastModelList" /><datalist id="fastModelList"></datalist>` with a `<button type="button" id="fastModelsBtn" title="تحميل قائمة الموديلات">↻</button>` in the same row.

- [ ] **Step 2 (js):** `let fastPresets = {};` set in `init()` from `data.fastPresets` and fill `#fastProvider` options like `#preset`. Extract `fillFastForm(fast)` (used by `fillForm` and the main provider `change` handler, replacing their duplicated fast lines) that also sets `#fastProvider` and calls `syncFastProvider()`. `readFastForm()` adds `provider: $('fastProvider').value` and uses the preset for fallbacks:

```js
function readFastForm() {
  const provider = $('fastProvider').value;
  const preset = fastPresets[provider] ?? {};
  return {
    enabled: $('fastEnabled').checked,
    mode: $('fastMode').value,
    provider,
    apiKey: $('fastApiKey').value.trim(),
    model: $('fastModel').value.trim() || preset.model,
    baseUrl: $('fastBaseUrl').value.trim() || preset.baseUrl,
    minProb: Number($('fastMinProb').value) || preset.minProb,
    riskyMax: Number($('fastRiskyMax').value) || 0.3,
  };
}

function syncFastProvider() {
  $('fastModelsBtn').hidden = $('fastProvider').value === 'typesafe';
}

$('fastProvider').addEventListener('change', () => {
  const preset = fastPresets[$('fastProvider').value];
  $('fastBaseUrl').value = preset.baseUrl;
  $('fastModel').value = preset.model;
  $('fastMinProb').value = preset.minProb;
  $('fastModelList').innerHTML = '';
  syncFastProvider();
});

$('fastModelsBtn').addEventListener('click', async () => {
  $('fastTestResult').textContent = 'جاري تحميل الموديلات…';
  try {
    const list = await request('list-fast-models', { config: readFastForm() });
    $('fastModelList').innerHTML = list.map((m) => `<option value="${escapeAttr(m.id)}"></option>`).join('');
    $('fastTestResult').textContent = `${list.length} موديل متاح`;
  } catch (err) {
    $('fastTestResult').textContent = `✗ ${err.message}`;
  }
});
```

`fastTestBtn` requests `fast-test`; the save check message becomes `'الطبقة السريعة محتاجة API key.'`.

- [ ] **Step 3:** `npm test`; commit `feat(panel): choose the fast-layer provider, key and model`.

---

### Task 5: E2E scenario and docs

**Files:** Modify `test/e2e/run-e2e.mjs`, `README.md`, `docs/README.ar.md`

- [ ] **Step 1:** in `startServer`, count `judge` too; in `/v1/chat/completions` parse the body first and, when `body.response_format` is set, answer as the judge:

```js
          const body = JSON.parse(raw);
          if (body.response_format) {
            counts.judge += 1;
            if (req.headers.authorization !== 'Bearer judge-key') throw new Error('missing judge key');
            const content = JSON.stringify(handlers.judge(body));
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ model: 'mock-judge', choices: [{ message: { role: 'assistant', content } }] }));
            return;
          }
```

- [ ] **Step 2:** add the mock:

```js
/** Mock chat-model fast layer: answers like scriptedJev, in the chat judge's JSON shape. */
function scriptedJudge() {
  const jev = scriptedJev();
  return (body) => {
    const { answers } = jev({ state: JSON.parse(body.messages.at(-1).content) });
    return Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.type === 'noul' ? a.noul : { probabilities: a.probabilities }]));
  };
}
```

- [ ] **Step 3:** scenarios take `fast: (base) => ({...})`; storage uses `fast: fast ? fast(base) : { enabled: false }`. Existing Jev scenario: `fast: (base) => ({ enabled: true, mode: 'auto', provider: 'typesafe', apiKey: 'jev-key', model: 'jev-latest', baseUrl: base })`. New scenario `chat-fast` (same task and checks as `fast`, plus `counts.judge >= 2` and `counts.jev === 0`) with `fast: (base) => ({ enabled: true, mode: 'auto', provider: 'custom', apiKey: 'judge-key', model: 'mock-judge', baseUrl: `${base}/v1`, minProb: 0.75 })` and `handlers: { llm: reportingLlm(), judge: scriptedJudge() }`. Log line prints `judge calls`.

- [ ] **Step 4:** Run e2e (see Global Constraints) → `E2E PASSED` with three scenarios.

- [ ] **Step 5 (docs):** README feature bullet: fast layer runs on TypeSafe Jev or any chat model via OpenRouter / Vercel AI Gateway / OpenAI-compatible. `docs/README.ar.md` fast section: short subsection on choosing the provider, that gateway probabilities are the model's estimate (default min confidence 0.75), and that page text goes to the chosen provider. Run docs-guard on the changes.

- [ ] **Step 6:** commit `test(e2e): fast layer through a chat-model judge; docs`.
