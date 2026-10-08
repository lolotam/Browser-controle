import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedbackPayload, shouldAskForRating, afterRating } from '../src/lib/feedback.js';

test('feedback carries the message, rating and app details, never page content', () => {
  const payload = feedbackPayload({ message: 'Love it', rating: 4, email: 'me@x.test', version: '0.1.0', language: 'ar' });
  assert.match(payload._subject, /4★/);
  assert.equal(payload.message, 'Love it');
  assert.equal(payload.rating, 4);
  assert.equal(payload.email, 'me@x.test', 'Formspree uses "email" as the reply-to address');
  assert.deepEqual(Object.keys(payload).sort(), ['_subject', 'email', 'extension_version', 'message', 'rating', 'ui_language']);
});

test('the rating prompt shows after tasks until the user rates or dismisses it three times', () => {
  assert.equal(shouldAskForRating({}), true);
  assert.equal(shouldAskForRating({ dismissals: 2 }), true);
  assert.equal(shouldAskForRating({ dismissals: 3 }), false);
  assert.equal(shouldAskForRating(afterRating({ dismissals: 1 })), false);
});
