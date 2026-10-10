import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../src/lib/json.js';
import { fetchModel, readSse } from '../src/lib/sse.js';
import { CompatibleSession } from '../src/providers/openai-compatible.js';

test('request bodies never carry a lone surrogate from cut page text', () => {
  const cut = 'stars ⭐ and 🚀'.slice(0, -1); // ends with half of the rocket
  const json = requestJson({ text: cut, ok: '🚀' });
  assert.doesNotMatch(json, /\ud[89a-f]/i);
  assert.equal(JSON.parse(json).text.at(-1), '\uFFFD');
  assert.equal(JSON.parse(json).ok, '🚀');
});

test('a stream that goes quiet is stopped with a clear error', async () => {
  const silent = new Response(new ReadableStream({ start() {} }));
  await assert.rejects(async () => {
    for await (const _ of readSse(silent, null, { idleMs: 50 }));
  }, (err) => err.name === 'StalledError' && /sent nothing/.test(err.message));
});

test('keep-alive pings do not reset the limit: only model data does', async () => {
  const encoder = new TextEncoder();
  let ping;
  const pinging = new Response(new ReadableStream({
    start(controller) {
      ping = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 10);
    },
    cancel() { clearInterval(ping); },
  }));
  const started = Date.now();
  await assert.rejects(async () => {
    for await (const _ of readSse(pinging, null, { idleMs: 80 }));
  }, { name: 'StalledError' });
  clearInterval(ping);
  assert.ok(Date.now() - started < 1000);
});

test('response headers that never come end the request; the caller can still stop it', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  try {
    await assert.rejects(fetchModel('https://x.test', {}, 50), { name: 'StalledError' });
    const stop = new AbortController();
    const pending = fetchModel('https://x.test', { signal: stop.signal }, 10000);
    stop.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    globalThis.fetch = original;
  }
});

test('a model without vision gets the task again without screenshots, and later ones as a note', async () => {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(init.body);
    if (init.body.includes('image_url')) return new Response('{"error":{"message":"No endpoints found that support image input"}}', { status: 404 });
    return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const s = new CompatibleSession({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'm', effort: '', thinkingStyle: 'none', systemPrompt: 's', tools: [] });
  s.addUserMessage('task');
  s.addToolResult('c1', 'Screenshot attached', ['data:image/jpeg;base64,AAAA']);
  const turn = await s.next({});
  assert.equal(turn.text, 'OK');
  assert.equal(bodies.length, 2);
  assert.match(bodies[1], /cannot read images/);
  s.addToolResult('c2', 'Screenshot attached', ['data:image/jpeg;base64,BBBB']);
  await s.next({});
  assert.equal(bodies.length, 3);
  assert.doesNotMatch(bodies[2], /image_url/);
});
