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
  assert.equal(calls[0].body.temperature, undefined, 'claude-haiku-5.5 and gpt-6.x on the gateways do not accept temperature');
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
