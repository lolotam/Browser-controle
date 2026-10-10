import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTextToolCalls } from '../src/providers/text-tool-calls.js';
import { CompatibleSession } from '../src/providers/openai-compatible.js';
import { toolDefinitions } from '../src/agent/tools.js';

const tools = toolDefinitions({ vision: true, allowJavascript: false });

test('Hermes/Qwen XML and JSON call blocks become calls, typed by the tool schema', () => {
  const xml = '<tool_call>\n<function=history>\n<parameter=action>\nback\n</parameter>\n</function>\n</tool_call>';
  assert.deepEqual(parseTextToolCalls(xml, tools), [{ name: 'history', args: { action: 'back' } }]);
  const typed = '<tool_call><function=type_text><parameter=index>3</parameter><parameter=text>123</parameter><parameter=submit>true</parameter></function></tool_call>';
  assert.deepEqual(parseTextToolCalls(typed, tools), [{ name: 'type_text', args: { index: 3, text: '123', submit: true } }]); // "123" stays text
  const json = '<tool_call>{"name": "click", "arguments": {"index": 4}}</tool_call>\n<tool_call>{"name": "read_page", "arguments": {}}</tool_call>';
  assert.deepEqual(parseTextToolCalls(json, tools), [{ name: 'click', args: { index: 4 } }, { name: 'read_page', args: {} }]);
});

test('anything ambiguous stays text: prose, fences, unknown tools, bad types, enums, missing fields, duplicates', () => {
  const block = '<tool_call><function=click><parameter=index>4</parameter></function></tool_call>';
  for (const text of [
    `Done. For example: ${block}`,
    `\`\`\`\n${block}\n\`\`\``,
    '<tool_call><function=delete_everything></function></tool_call>',
    '<tool_call><function=click><parameter=index>four</parameter></function></tool_call>',
    '<tool_call><function=history><parameter=action>sideways</parameter></function></tool_call>',
    '<tool_call><function=type_text><parameter=text>hi</parameter></function></tool_call>', // index missing
    '<tool_call><function=click><parameter=index>4</parameter><parameter=force>1</parameter></function></tool_call>',
    `${block}${block}`,
    '<tool_call>{"name": "click", "arguments": {"index": "4"}}</tool_call>',
    '<tool_call><function=click>',
  ]) assert.equal(parseTextToolCalls(text, tools), null, text);
});

const stream = (...chunks) => new Response(`${chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')}`, { headers: { 'Content-Type': 'text/event-stream' } });
const session = (opts = {}) => new CompatibleSession({ baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm', effort: '', thinkingStyle: 'none', systemPrompt: 's', tools, textToolCalls: true, ...opts });
const callText = '<tool_call><function=history><parameter=action>back</parameter></function></tool_call>';

test('a completed text-call turn runs as tool calls, with a consistent history and the streamed text withdrawn', async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return stream({ choices: [{ delta: { content: callText }, finish_reason: 'stop' }] }, '[DONE]');
  };
  try {
    const s = session();
    const events = [];
    s.addUserMessage('go back');
    const turn = await s.next({ onEvent: (e) => events.push(e.type) });
    assert.equal(turn.text, '');
    assert.equal(turn.toolCalls.length, 1);
    assert.match(turn.toolCalls[0].id, /^textcall_1_0$/);
    assert.ok(events.includes('text-reset'));
    s.addToolResult(turn.toolCalls[0].id, 'Did back.');
    await s.next({});
    const history = bodies[1].messages;
    const assistant = history.find((m) => m.role === 'assistant');
    assert.equal(assistant.content, null);
    assert.equal(assistant.tool_calls[0].function.name, 'history');
    assert.equal(history.find((m) => m.role === 'tool').tool_call_id, 'textcall_1_0');
  } finally {
    globalThis.fetch = original;
  }
});

test('no parsing for a cut-off or filtered answer, without the preset flag, or when tools are off', async () => {
  const original = globalThis.fetch;
  try {
    for (const [finish, opts, toolChoice] of [['length', {}, 'auto'], ['content_filter', {}, 'auto'], ['stop', { textToolCalls: false }, 'auto'], ['stop', {}, 'none']]) {
      globalThis.fetch = async () => stream({ choices: [{ delta: { content: callText }, finish_reason: finish }] }, '[DONE]');
      const s = session(opts);
      s.addUserMessage('x');
      const turn = await s.next({ toolChoice });
      assert.equal(turn.toolCalls.length, 0, `${finish} ${JSON.stringify(opts)} ${toolChoice}`);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('a stream that ends without a finish reason or [DONE] is an error, not an answer', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => stream({ choices: [{ delta: { content: 'half an ans' } }] });
  try {
    const s = session();
    s.addUserMessage('x');
    await assert.rejects(s.next({}), /ended before the answer was complete/);
  } finally {
    globalThis.fetch = original;
  }
});

test('vLLM "multimodal processing is not enabled" drops screenshots once; other errors do not', async () => {
  const original = globalThis.fetch;
  try {
    const bodies = [];
    globalThis.fetch = async (_u, init) => {
      bodies.push(init.body);
      if (init.body.includes('image_url')) return new Response('{"error":{"message":"ValueError: Received multimodal data but multimodal processing is not enabled."}}', { status: 400 });
      return stream({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] });
    };
    const s = session();
    s.addUserMessage('x');
    s.addToolResult('c1', 'Screenshot attached', ['data:image/png;base64,AAAA']);
    assert.equal((await s.next({})).text, 'OK');
    assert.equal(bodies.length, 2);
    for (const [status, detail] of [[503, 'multimodal backend overloaded'], [400, 'invalid image data'], [401, 'invalid key']]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: detail } }), { status });
      const other = session();
      other.addUserMessage('x');
      other.addToolResult('c1', 'Screenshot attached', ['data:image/png;base64,AAAA']);
      await assert.rejects(other.next({}, Date.now() + 1000), new RegExp(`HTTP ${status}`));
      assert.equal(other.textOnly, undefined, detail);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('the same vLLM refusal sent inside an HTTP 200 stream also drops screenshots once', async () => {
  const original = globalThis.fetch;
  try {
    const bodies = [];
    const refusal = { error: { message: 'ValueError: Received multimodal data but multimodal processing is not enabled. Use --enable-multimodal flag to enable multimodal processing.' } };
    globalThis.fetch = async (_u, init) => {
      bodies.push(init.body);
      return init.body.includes('image_url') ? stream(refusal) : stream({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] });
    };
    const s = session();
    s.addUserMessage('x');
    s.addToolResult('c1', 'Screenshot attached', ['data:image/png;base64,AAAA']);
    assert.equal((await s.next({})).text, 'OK');
    assert.equal(bodies.length, 2);
    assert.equal(s.textOnly, true);
    // Any other error in the stream still fails the turn.
    globalThis.fetch = async () => stream({ error: { message: 'upstream exploded' } });
    const other = session();
    other.addUserMessage('x');
    other.addToolResult('c1', 'Screenshot attached', ['data:image/png;base64,AAAA']);
    await assert.rejects(other.next({}), /upstream exploded/);
  } finally {
    globalThis.fetch = original;
  }
});
