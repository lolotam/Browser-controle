import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseChunk } from '../src/lib/sse.js';
import { chatgptIdentity } from '../src/lib/jwt.js';
import { compactInput, parseOutput, withoutId } from '../src/providers/chatgpt.js';
import { CompatibleSession, compactMessages, createAccumulator, listCompatibleModels } from '../src/providers/openai-compatible.js';
import { mergeSettings } from '../src/lib/settings.js';

const fakeJwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

test('parseSseChunk keeps an incomplete trailing event for the next chunk', () => {
  const { events, rest } = parseSseChunk('event: a\ndata: {"x":1}\n\ndata: par');
  assert.deepEqual(events, [{ event: 'a', data: '{"x":1}' }]);
  assert.equal(rest, 'data: par');
  const next = parseSseChunk(`${rest}t\r\n\r\n`);
  assert.deepEqual(next.events, [{ event: 'message', data: 'part' }]);
});

test('parseSseChunk joins multi-line data and skips comments', () => {
  const { events } = parseSseChunk(': keepalive\ndata: one\ndata: two\n\n');
  assert.deepEqual(events, [{ event: 'message', data: 'one\ntwo' }]);
});

test('chatgptIdentity reads account, plan, email and expiry from OpenAI claims', () => {
  const token = fakeJwt({
    exp: 2000000000,
    email: 'a@b.c',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc_1', chatgpt_plan_type: 'plus' },
  });
  assert.deepEqual(chatgptIdentity(token), { accountId: 'acc_1', planType: 'plus', email: 'a@b.c', expiresAt: 2000000000000 });
  assert.equal(chatgptIdentity('not-a-jwt'), null);
});

test('parseOutput extracts text and function calls from Responses items', () => {
  const items = [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'x' },
    { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Looking' }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'click', arguments: '{"index":3}' },
  ];
  const out = parseOutput(items);
  assert.equal(out.text, 'Looking');
  assert.deepEqual(out.toolCalls, [{ id: 'call_1', name: 'click', args: { index: 3 } }]);
  assert.equal('id' in withoutId(items[0]), false);
  assert.equal(withoutId(items[0]).encrypted_content, 'x');
});

test('compactInput trims all but the latest observations and screenshots', () => {
  const long = 'x'.repeat(2000);
  const input = [
    { type: 'function_call_output', call_id: '1', output: long },
    { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:a' }] },
    { type: 'function_call_output', call_id: '2', output: long },
    { type: 'function_call_output', call_id: '3', output: long },
    { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:b' }] },
  ];
  compactInput(input);
  assert.ok(input[0].output.endsWith('[older page state trimmed]'));
  assert.equal(input[2].output, long);
  assert.equal(input[3].output, long);
  assert.equal(input[1].content[0].type, 'input_text');
  assert.equal(input[4].content[0].type, 'input_image');
});

test('createAccumulator reassembles tool-call arguments split across chunks', () => {
  const acc = createAccumulator();
  acc.push({ choices: [{ delta: { content: 'Hi ' } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'navigate', arguments: '{"url":"ht' } }] } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tps://x.y"}' } }] } }] });
  const result = acc.result();
  assert.equal(result.text, 'Hi ');
  assert.deepEqual(result.toolCalls, [{ id: 'c1', name: 'navigate', args: { url: 'https://x.y' } }]);
  assert.equal(result.rawToolCalls[0].function.arguments, '{"url":"https://x.y"}');
});

test('compactMessages trims old tool observations only', () => {
  const long = 'y'.repeat(1000);
  const messages = [1, 2, 3].map((n) => ({ role: 'tool', tool_call_id: String(n), content: long }));
  compactMessages(messages);
  assert.ok(messages[0].content.length < 500);
  assert.equal(messages[2].content, long);
});

test('CompatibleSession maps effort to GLM thinking or reasoning_effort', () => {
  const base = { baseUrl: 'http://x/', apiKey: '', model: 'm', systemPrompt: 's', tools: [] };
  const glm = new CompatibleSession({ ...base, effort: 'off', thinkingStyle: 'glm' }).requestBody('auto');
  assert.deepEqual(glm.thinking, { type: 'disabled' });
  assert.equal(glm.reasoning_effort, undefined);
  const grok = new CompatibleSession({ ...base, effort: 'high', thinkingStyle: 'reasoning_effort' }).requestBody('auto');
  assert.equal(grok.reasoning_effort, 'high');
  const plain = new CompatibleSession({ ...base, effort: '', thinkingStyle: 'reasoning_effort' }).requestBody('auto');
  assert.equal('reasoning_effort' in plain, false);
});

test('fast settings saved before providers existed keep using TypeSafe Jev', () => {
  const { fast } = mergeSettings({ fast: { enabled: true, apiKey: 'jev', baseUrl: 'https://api.typesafe.ai' } });
  assert.equal(fast.provider, 'typesafe');
});

test('model lists skip image, video and embedding models and flag decision models', async () => {
  globalThis.fetch = async () => Response.json({ data: [
    { id: 'anthropic/claude-haiku-5.5', type: 'language' },
    { id: 'openai/text-embedding-3', type: 'embedding' },
    { id: 'google/veo', type: 'video' },
    { id: 'typesafe-ai/jev', type: 'evaluation' },
    { id: 'local-model' },
  ] });
  const models = await listCompatibleModels('https://gw.example/v1', 'k');
  assert.deepEqual(models.map((m) => [m.id, m.decision]), [
    ['anthropic/claude-haiku-5.5', false],
    ['typesafe-ai/jev', true],
    ['local-model', false],
  ]);
});

test('a public model list still loads when the key is missing or rejected', async () => {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(init.headers.Authorization ?? null);
    return init.headers.Authorization ? new Response('{"error":"bad key"}', { status: 401 }) : Response.json({ data: [{ id: 'typesafe-ai/jev', type: 'evaluation' }] });
  };
  const models = await listCompatibleModels('https://ai-gateway.vercel.sh/v1', 'typo-key');
  assert.deepEqual(sent, ['Bearer typo-key', null]);
  assert.deepEqual(models.map((m) => m.id), ['typesafe-ai/jev']);
});

test('settings saved before backups existed get disabled backups, and partial backups keep their fields', () => {
  const old = mergeSettings({ provider: 'chatgpt', fast: { enabled: true, provider: 'vercel' } });
  assert.equal(old.fallback.enabled, false);
  assert.equal(old.fallback.compatible.preset, 'openrouter');
  assert.equal(old.fast.fallback.enabled, false);
  assert.equal(old.fast.fallback.provider, 'typesafe');

  const partial = mergeSettings({ fallback: { enabled: true, compatible: { apiKey: 'or-key' } }, fast: { fallback: { enabled: true, apiKey: 'tk' } } });
  assert.equal(partial.fallback.compatible.apiKey, 'or-key');
  assert.equal(partial.fallback.compatible.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(partial.fast.fallback.apiKey, 'tk');
  assert.equal(partial.fast.fallback.model, 'jev-latest');
});
