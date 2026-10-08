import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/agent/prompt.js';

test('the agent answers in the task language unless a reply language is switched on', () => {
  assert.match(buildSystemPrompt({}), /same language the user wrote the task in/);
  assert.match(buildSystemPrompt({ replyLanguage: { enabled: false, language: 'ar' } }), /same language the user wrote the task in/);

  const arabic = buildSystemPrompt({ replyLanguage: { enabled: true, language: 'ar' } });
  assert.match(arabic, /in Arabic, whatever language the task is written in/);
  assert.doesNotMatch(arabic, /same language the user wrote the task in/);
  assert.match(buildSystemPrompt({ replyLanguage: { enabled: true, language: 'en' } }), /in English, whatever language/);
});
