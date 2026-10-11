import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/agent.js';

/** A steering inbox like SessionRunner's, driven by the test. */
function inbox() {
  const box = { items: [], controller: null };
  box.steering = {
    waiting: () => box.items.length > 0,
    take: () => box.items.splice(0),
    turnSignal: (signal) => {
      box.controller = new AbortController();
      return AbortSignal.any([signal ?? new AbortController().signal, box.controller.signal]);
    },
  };
  return box;
}

const call = (id, name, args = {}) => ({ id, name, args });

test('a message sent during a step reaches the model before its next turn, and the rest of the batch waits', async () => {
  const box = inbox();
  const users = [];
  const results = [];
  const turns = [
    { text: '', toolCalls: [call('1', 'click', { index: 1 }), call('2', 'click', { index: 2 }), call('3', 'done', { report: 'early', success: true })] },
    { text: '', toolCalls: [call('4', 'done', { report: 'used the new info', success: true })] },
  ];
  const session = { addUserMessage: (t) => users.push(t), addToolResult: (id, out) => results.push([id, out]), next: async () => turns.shift() };
  const events = [];
  await runAgent({
    session, task: 'go', maxSteps: 5, steering: box.steering, emit: (e) => events.push(e),
    execute: async (name, args) => {
      if (args.index === 1) box.items.push('use the blue one instead');
      return { output: 'ok' };
    },
  });
  assert.equal(users[1], 'Message from the user while you work (it may change or add to the task):\nuse the blue one instead');
  assert.deepEqual(results.map(([id]) => id), ['1', '2', '3', '4']);
  assert.match(results[1][1], /the user sent you a message/); // click 2 skipped
  assert.match(results[2][1], /the user sent you a message/); // and the early report too
  assert.equal(events.find((e) => e.type === 'final').report, 'used the new info');
});

test('"send now" cuts the model\'s turn short; the same step is asked again with the message', async () => {
  const box = inbox();
  const users = [];
  let calls = 0;
  const session = {
    addUserMessage: (t) => users.push(t),
    addToolResult() {},
    next: async ({ signal }) => {
      calls += 1;
      if (calls === 1) {
        // The user sends a message while the model is still thinking.
        setTimeout(() => { box.items.push('stop, search for flights instead'); box.controller.abort(); }, 10);
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }
      return { text: '', toolCalls: [call('d', 'done', { report: 'flights', success: true })] };
    },
  };
  const events = [];
  await runAgent({ session, task: 'go', maxSteps: 1, steering: box.steering, emit: (e) => events.push(e), execute: async () => ({ output: 'ok' }) });
  assert.equal(calls, 2);
  assert.match(users[1], /stop, search for flights instead/);
  assert.ok(events.some((e) => e.type === 'turn-interrupted'));
  assert.equal(events.find((e) => e.type === 'final').report, 'flights'); // within maxSteps 1: the cut turn did not count
});

test('the user\'s Stop still stops the task, not just the turn', async () => {
  const box = inbox();
  const stop = new AbortController();
  const session = {
    addUserMessage() {}, addToolResult() {},
    next: async ({ signal }) => {
      setTimeout(() => stop.abort(), 10);
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    },
  };
  await assert.rejects(runAgent({ session, task: 'go', maxSteps: 3, signal: stop.signal, steering: box.steering, emit: () => {}, execute: async () => ({ output: 'ok' }) }), { name: 'AbortError' });
});

test('an answer written while a message waited is followed by a turn that reads it', async () => {
  const box = inbox();
  const users = [];
  const turns = [{ text: 'Here is the report.', toolCalls: [] }, { text: 'Updated report with prices.', toolCalls: [] }];
  const session = {
    addUserMessage: (t) => users.push(t), addToolResult() {},
    next: async () => {
      const turn = turns.shift();
      if (turn.text === 'Here is the report.') box.items.push('add the prices too');
      return turn;
    },
  };
  const events = [];
  await runAgent({ session, task: 'go', maxSteps: 5, steering: box.steering, emit: (e) => events.push(e), execute: async () => ({ output: 'ok' }) });
  assert.match(users[1], /add the prices too/);
  assert.equal(events.filter((e) => e.type === 'final').length, 1);
  assert.equal(events.find((e) => e.type === 'final').report, 'Updated report with prices.');
});
