import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askGatewayDecision } from '../src/fast/gateway-decision-client.js';
import { askChatJudge } from '../src/fast/chat-judge-client.js';
import { fastClientFor } from '../src/fast/clients.js';
import { askJev } from '../src/fast/jev-client.js';

const questions = {
  operation: { type: 'choice', instructions: 'Which operation?', criteria: { click: 'Click', scroll_down: 'Scroll' } },
  risky: { type: 'noul', instructions: 'The next step is sensitive.' },
  goal_done: { type: 'noul', instructions: 'The goal is done.' },
};

function stubDecision(body, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return status === 200 ? Response.json(body) : new Response('{"error":{"message":"denied"}}', { status });
  };
  return calls;
}

test('Jev on Vercel is asked through the decision-model API with Jev-shaped answers back', async () => {
  const calls = stubDecision({
    model: 'typesafe-ai/jev',
    answers: {
      operation: { type: 'choice', choice: 'click', probabilities: { click: 0.9, scroll_down: 0.1 } },
      risky: { type: 'boolean', probability: 0.04 },
      goal_done: { type: 'refusal' },
    },
    usage: { inputTokens: 120 },
  });

  const { answers, model } = await askGatewayDecision({
    baseUrl: 'https://ai-gateway.vercel.sh/v1', apiKey: 'vk', model: 'typesafe-ai/jev', state: { GOAL: 'g' }, questions,
  });

  assert.equal(calls[0].url, 'https://ai-gateway.vercel.sh/v4/ai/decision-model');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer vk');
  assert.equal(calls[0].init.headers['ai-model-id'], 'typesafe-ai/jev');
  assert.equal(calls[0].init.headers['ai-decision-model-specification-version'], '4');
  assert.deepEqual(calls[0].body.state, { GOAL: 'g' });
  assert.equal(calls[0].body.questions.risky.type, 'boolean');
  assert.deepEqual(calls[0].body.questions.operation.criteria, questions.operation.criteria);
  assert.equal(model, 'typesafe-ai/jev');
  assert.equal(answers.operation.choice, 'click');
  assert.ok(Math.abs(answers.operation.confidence - 0.8) < 1e-9);
  assert.deepEqual(answers.risky, { type: 'noul', noul: 0.04 });
  assert.equal(answers.goal_done, undefined, 'a refusal must escalate, not count as an answer');
});

test('decision API errors are reported with their status', async () => {
  stubDecision(null, 403);
  await assert.rejects(
    askGatewayDecision({ baseUrl: 'https://ai-gateway.vercel.sh/v1', apiKey: 'vk', model: 'typesafe-ai/jev', state: {}, questions }),
    /HTTP 403/,
  );
});

test('the fast layer picks its client from the provider and the model kind', () => {
  assert.equal(fastClientFor({ provider: 'typesafe' }), askJev);
  assert.equal(fastClientFor({ provider: 'vercel', decision: true }), askGatewayDecision);
  assert.equal(fastClientFor({ provider: 'openrouter', decision: false }), askChatJudge);
});
