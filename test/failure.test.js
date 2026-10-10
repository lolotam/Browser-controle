import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFailure } from '../src/lib/failure.js';

test('provider failures become reasons a user can act on', () => {
  const cases = [
    [new Error('ChatGPT usage limit reached for this plan. Resets at 18:00'), /usage limit/i],
    [new Error('Model request failed (HTTP 429): {"error":"rate limited"}'), /too many requests/i],
    [new Error('Model request failed (HTTP 429): {"error":{"message":"Quota exceeded","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}'), /usage limit|quota|credit/i],
    [new Error('Model request failed (HTTP 401): invalid api key'), /key/i],
    [new Error('Fast layer request failed (HTTP 403): no access'), /key|access/i],
    [new TypeError('Failed to fetch'), /connection/i],
    [new Error('Model request failed (HTTP 503): upstream down'), /server/i],
  ];
  for (const [error, expected] of cases) assert.match(describeFailure(error).reason, expected, error.message);
  assert.deepEqual(cases.map(([error]) => describeFailure(error).code), ['quota', 'rate-limit', 'quota', 'auth', 'auth', 'network', 'server']);
});

test('unknown failures keep a short reason and the full detail', () => {
  const message = `Something odd happened: ${'x'.repeat(300)}`;
  const { code, reason, detail } = describeFailure(new Error(message));
  assert.equal(code, 'other');
  assert.ok(reason.length <= 121);
  assert.equal(detail, message);
});
