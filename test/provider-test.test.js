import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testProviderSlot } from '../src/agent/model-session.js';
import { mergeSettings } from '../src/lib/settings.js';

const settings = mergeSettings({});
const slot = { provider: 'compatible', compatible: { preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or-key', model: 'openai/gpt-5', effort: 'low' } };

function stubChat(respond) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization });
    return respond();
  };
  return requests;
}

const sse = (...chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });

test('the test sends a real request with the task tools and reasoning setting, and reports the reply', async () => {
  const requests = stubChat(() => sse({ choices: [{ delta: { content: 'OK' } }] }));
  const result = await testProviderSlot(slot, settings);
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(requests[0].auth, 'Bearer or-key');
  assert.ok(requests[0].body.tools.length > 5, 'a model that rejects tools must fail the test, not the first task');
  assert.equal(requests[0].body.reasoning_effort, 'low');
  assert.equal(result.reply, 'OK');
  assert.equal(result.model, 'OpenRouter · openai/gpt-5');
});

test("a model without tool calls is named as the problem, not OpenRouter's advice to drop a tool", async () => {
  stubChat(() => new Response('{"error":{"message":"No endpoints found that support tool use. Try disabling \\"read_page\\".","code":404}}', { status: 404 }));
  await assert.rejects(testProviderSlot(slot, settings), (err) => /HTTP 404.*cannot call tools.*Pick another model/.test(err.message) && !/read_page/.test(err.message));
});

test("a provider error shows the provider's own message, not its JSON", async () => {
  stubChat(() => new Response('{"error":{"message":"Authentication Fails, Your api key: ****-bad is invalid","type":"authentication_error"}}', { status: 401 }));
  await assert.rejects(testProviderSlot(slot, settings), (err) => err.message === 'Model request failed (HTTP 401): Authentication Fails, Your api key: ****-bad is invalid');
});

test('a slot without a model is refused before any request', async () => {
  const requests = stubChat(() => sse());
  await assert.rejects(testProviderSlot({ ...slot, compatible: { ...slot.compatible, model: '' } }, settings), /Choose a model/);
  assert.equal(requests.length, 0);
});
