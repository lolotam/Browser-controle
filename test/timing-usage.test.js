import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/agent.js';
import { normalizeUsage } from '../src/lib/usage.js';
import { CompatibleSession } from '../src/providers/openai-compatible.js';
import { withRetry, ProviderHttpError } from '../src/lib/retry.js';

test('usage reads the Chat Completions, Responses and Jev shapes', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }), { input: 120, output: 30 });
  assert.deepEqual(normalizeUsage({ input_tokens: 9, output_tokens: 2 }), { input: 9, output: 2 });
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage(null), null);
});

test('turns report time, retry pauses apart, usage and the answering model; tool steps carry call ids and times', async () => {
  const turns = [
    { text: '', toolCalls: [{ id: 'c1', name: 'click', args: { index: 1 } }], usage: { prompt_tokens: 100, completion_tokens: 10 }, retryWaitMs: 2000 },
    { text: '', toolCalls: [{ id: 'c2', name: 'done', args: { report: 'ok', success: true } }] },
  ];
  const session = { model: 'NVIDIA NIM · nemotron', addUserMessage() {}, addToolResult() {}, next: async () => turns.shift() };
  const events = [];
  await runAgent({ session, task: 't', maxSteps: 5, emit: (e) => events.push(e), execute: async () => ({ output: 'ok' }) });

  const ends = events.filter((e) => e.type === 'turn-end');
  assert.equal(ends.length, 2);
  assert.deepEqual(ends[0].usage, { input: 100, output: 10 });
  assert.equal(ends[0].retryWaitMs, 2000);
  assert.equal(ends[0].model, 'NVIDIA NIM · nemotron');
  assert.ok(ends[0].ms >= 0);
  assert.equal(ends[1].usage, null); // the panel marks the totals partial
  const start = events.find((e) => e.type === 'tool-start');
  const end = events.find((e) => e.type === 'tool-end');
  assert.equal(start.callId, 'c1');
  assert.equal(end.callId, 'c1');
  assert.ok(Number.isFinite(end.ms));
});

test('the step-limit summary is timed too', async () => {
  const session = {
    addUserMessage() {}, addToolResult() {},
    next: async ({ toolChoice }) => (toolChoice === 'none' ? { text: 'summary', toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 1 } } : { text: '', toolCalls: [{ id: 'x', name: 'scroll', args: { direction: 'down' } }] }),
  };
  const events = [];
  await runAgent({ session, task: 't', maxSteps: 1, emit: (e) => events.push(e), execute: async () => ({ output: 'ok' }) });
  const summary = events.find((e) => e.type === 'turn-end' && e.turnId === 'summary');
  assert.deepEqual(summary.usage, { input: 5, output: 1 });
});

function sseOk() {
  return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}

test('usage is asked for only where the preset accepts it, and dropped once if the endpoint refuses it', async () => {
  const original = globalThis.fetch;
  const bodies = [];
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.stream_options && bodies.length === 2) {
        return new Response('{"error":{"message":"Unrecognized request argument supplied: stream_options"}}', { status: 400 });
      }
      return sseOk();
    };
    const base = { baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm', effort: '', thinkingStyle: 'none', systemPrompt: 's', tools: [] };
    const plain = new CompatibleSession(base);
    plain.addUserMessage('a');
    await plain.next({});
    assert.equal(bodies[0].stream_options, undefined);

    const counted = new CompatibleSession({ ...base, usage: true });
    counted.addUserMessage('a');
    const turn = await counted.next({});
    assert.deepEqual(bodies[1].stream_options, { include_usage: true });
    assert.equal(bodies[2].stream_options, undefined); // asked again without it
    assert.equal(turn.text, 'OK');
    counted.addUserMessage('b');
    await counted.next({});
    assert.equal(bodies[3].stream_options, undefined); // and not again in this session
  } finally {
    globalThis.fetch = original;
  }
});

test('retry pauses are reported so the panel can show them apart from model time', async () => {
  const waits = [];
  let calls = 0;
  await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new ProviderHttpError({ status: 503, detail: 'busy', retryAfterMs: null });
    return 'ok';
  }, { wait: async () => {}, random: () => 0.5, onWait: (ms) => waits.push(ms) });
  assert.deepEqual(waits, [2000, 6000]);
});
