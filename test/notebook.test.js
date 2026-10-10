import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Notebook, NOTEBOOK_MAX_CHARS } from '../src/agent/notebook.js';
import { runAgent } from '../src/agent/agent.js';
import { createToolExecutor } from '../src/agent/tools.js';
import { compactMessages } from '../src/providers/openai-compatible.js';
import { compactInput } from '../src/providers/chatgpt.js';
import { handoffMessage, emptyLog } from '../src/agent/fallback-session.js';

test('the notebook keeps the newest notes under its cap and says when older ones went', () => {
  const book = new Notebook();
  for (let i = 0; i < 12; i += 1) book.add(`note ${i} ${'x'.repeat(1400)}`, 'https://a.test/p');
  assert.ok(book.size <= NOTEBOOK_MAX_CHARS);
  assert.ok(book.dropped);
  const text = book.format();
  assert.match(text, /untrusted data/);
  assert.match(text, /earlier notes dropped/);
  assert.match(text, /note 11/);
  assert.doesNotMatch(text, /note 0 /);
  assert.deepEqual(Notebook.from(JSON.parse(JSON.stringify(book))).format(), text); // survives saving
});

function fakeBrowser() {
  return {
    overlay: { pointTo: async () => {}, say: async () => {} },
    currentTab: async () => ({ id: 1, url: 'https://shop.test/page-2' }),
    snapshot: async () => ({ url: 'https://shop.test/page-2', title: 'T', scroll: { y: 0, viewport: 100, height: 100 }, elements: [], offscreen: 0, text: 'page text' }),
    pressKey: async () => {},
  };
}

test('note saves with the page URL, rejects empty or long notes, and shows on the next observation', async () => {
  const notebook = new Notebook();
  let saved = 0;
  const execute = createToolExecutor(fakeBrowser(), { askUser: async () => '', notebook, onNotebookChange: () => { saved += 1; } });
  assert.equal((await execute('note', { text: 'Silkworm £23.05' })).output, 'Saved (1 note).');
  assert.equal(saved, 1);
  assert.match((await execute('note', { text: '' })).output, /empty/);
  assert.match((await execute('note', { text: 'x'.repeat(1501) })).output, /limit is 1500/);
  const page = (await execute('read_page', {})).output;
  assert.match(page, /Your notes[\s\S]*1\. Silkworm £23\.05 \(from https:\/\/shop\.test\/page-2\)/);
  assert.match((await execute('read_notes', {})).output, /Silkworm/);
});

test('a note after an action does not take the page state away from that action', async () => {
  const session = {
    results: [],
    turns: [
      { text: '', toolCalls: [{ id: '1', name: 'type_text', args: { index: 0, text: 'a' } }, { id: '2', name: 'note', args: { text: 'typed' } }] },
      { text: '', toolCalls: [{ id: '3', name: 'done', args: { report: 'ok', success: true } }] },
    ],
    addUserMessage() {},
    addToolResult(id, output) { this.results.push({ id, output }); },
    async next() { return this.turns.shift(); },
  };
  const seen = [];
  await runAgent({ session, task: 't', maxSteps: 5, emit: () => {}, execute: async (name, _args, opts) => { seen.push([name, opts.observe]); return { output: 'ok' }; } });
  assert.deepEqual(seen, [['type_text', true], ['note', true]]);
});

test('compaction: notes never push page observations out; only the latest notebook read stays whole', () => {
  const big = (label) => `${label} ${'y'.repeat(2000)}`;
  const call = (id, name) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] });
  const messages = [
    call('a', 'read_page'), { role: 'tool', tool_call_id: 'a', content: big('page1') },
    call('b', 'read_notes'), { role: 'tool', tool_call_id: 'b', content: big('notes-old') },
    call('c', 'click'), { role: 'tool', tool_call_id: 'c', content: big('page2') },
    call('d', 'note'), { role: 'tool', tool_call_id: 'd', content: 'Saved (1 note).' },
    call('e', 'note'), { role: 'tool', tool_call_id: 'e', content: 'Saved (2 notes).' },
    call('f', 'read_notes'), { role: 'tool', tool_call_id: 'f', content: big('notes-new') },
    call('g', 'scroll'), { role: 'tool', tool_call_id: 'g', content: big('page3') },
  ];
  compactMessages(messages);
  const content = (id) => messages.find((m) => m.tool_call_id === id).content;
  assert.match(content('a'), /trimmed/); // third-newest page
  assert.doesNotMatch(content('c'), /trimmed/); // still one of the last two pages despite the notes after it
  assert.doesNotMatch(content('g'), /trimmed/);
  assert.match(content('b'), /trimmed/);
  assert.doesNotMatch(content('f'), /trimmed/);
  assert.equal(content('e'), 'Saved (2 notes).');

  const input = [
    { type: 'function_call', call_id: 'a', name: 'read_page' }, { type: 'function_call_output', call_id: 'a', output: big('page1') },
    { type: 'function_call', call_id: 'c', name: 'click' }, { type: 'function_call_output', call_id: 'c', output: big('page2') },
    { type: 'function_call', call_id: 'd', name: 'note' }, { type: 'function_call_output', call_id: 'd', output: 'Saved (1 note).' },
    { type: 'function_call', call_id: 'g', name: 'scroll' }, { type: 'function_call_output', call_id: 'g', output: big('page3') },
  ];
  compactInput(input);
  const out = (id) => input.find((i) => i.type === 'function_call_output' && i.call_id === id).output;
  assert.match(out('a'), /trimmed/);
  assert.doesNotMatch(out('c'), /trimmed/);
});

test('ten notebook reads stay bounded: one full copy, the rest trimmed', () => {
  const messages = [];
  for (let i = 0; i < 10; i += 1) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `r${i}`, type: 'function', function: { name: 'read_notes', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: `r${i}`, content: 'n'.repeat(NOTEBOOK_MAX_CHARS) });
  }
  compactMessages(messages);
  const total = messages.filter((m) => m.role === 'tool').reduce((n, m) => n + m.content.length, 0);
  assert.ok(total < NOTEBOOK_MAX_CHARS + 10 * 500, `total ${total}`);
});

test('a backup provider or a reopened session gets the notebook in its handoff', () => {
  const book = new Notebook();
  book.add('A Time of Torment £48.35', 'https://books.test/mystery/page-1');
  const log = { ...emptyLog(), task: 'five-star mysteries' };
  assert.match(handoffMessage(log, 'quota', book), /A Time of Torment £48\.35 \(from https:\/\/books\.test\/mystery\/page-1\)/);
  assert.doesNotMatch(handoffMessage(log, 'quota', new Notebook()), /Your notes/);
});

test('old note calls keep only a marker once a later observation shows the notebook', () => {
  const header = new Notebook();
  header.add('first', 'https://a.test');
  const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const long = { text: 'Item '.repeat(200) };
  const messages = [
    call('n1', 'note', long), { role: 'tool', tool_call_id: 'n1', content: 'Saved (1 note).' },
    call('p1', 'read_page', {}), { role: 'tool', tool_call_id: 'p1', content: `Page state:\n...\n\n${header.format()}` },
    call('n2', 'note', long), { role: 'tool', tool_call_id: 'n2', content: 'Saved (2 notes).' },
  ];
  compactMessages(messages);
  assert.equal(messages[0].tool_calls[0].function.arguments, '{"text":"[saved to the notebook]"}');
  assert.equal(messages[4].tool_calls[0].function.arguments, JSON.stringify(long)); // not shown in any notebook copy yet

  const input = [
    { type: 'function_call', call_id: 'n1', name: 'note', arguments: JSON.stringify(long) }, { type: 'function_call_output', call_id: 'n1', output: 'Saved (1 note).' },
    { type: 'function_call', call_id: 'p1', name: 'read_page', arguments: '{}' }, { type: 'function_call_output', call_id: 'p1', output: header.format() },
  ];
  compactInput(input);
  assert.equal(input[0].arguments, '{"text":"[saved to the notebook]"}');
});

test('a very long page URL is cut, so one note cannot outgrow the notebook', () => {
  const book = new Notebook();
  book.add('Price £10', `https://shop.test/p?q=${'a'.repeat(50000)}`);
  assert.ok(book.size < 1000);
  assert.match(book.format(), /…\)$/);
});

test('choose_suggestion stopped while waiting for the list clicks nothing', async () => {
  const stop = new AbortController();
  const clicks = [];
  const browser = {
    ...fakeBrowser(),
    locate: async () => ({ x: 1, y: 1 }),
    clickAt: async (x, y) => clicks.push([x, y]),
    element: async () => ({}),
    insertText: async () => {},
    suggestions: async (_i, _w, mode) => {
      if (mode === 'scan') { stop.abort(); return { tied: true, total: 1, options: ['Delhi'], matches: 1 }; }
      return { x: 50, y: 60, text: 'Delhi' };
    },
  };
  const execute = createToolExecutor(browser, { askUser: async () => '', signal: stop.signal });
  const result = await execute('choose_suggestion', { index: 3, text: 'Del', option: 'Delhi' });
  assert.equal(result.isError, true);
  assert.match(result.output, /Stopped by user/);
  assert.deepEqual(clicks, [[1, 1]]); // only the click that focused the field
});
