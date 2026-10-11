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

test('the reply language is stated up front, in the report tool, and with each task', async () => {
  const { replyLanguageReminder } = await import('../src/agent/prompt.js');
  const { toolDefinitions } = await import('../src/agent/tools.js');
  const arabic = buildSystemPrompt({ replyLanguage: { enabled: true, language: 'ar' } });
  assert.ok(arabic.indexOf('## Reply language') < arabic.indexOf('## How you work'));
  // The report tool no longer says "the user's language", which an English task would read as English.
  const done = toolDefinitions({ vision: true }).find((t) => t.name === 'done');
  assert.doesNotMatch(done.description, /user's language/);
  assert.match(replyLanguageReminder({ enabled: true, language: 'ar' }), /Reply language: Arabic\. Write every message, question and the final report in Arabic, even if this message is in another language/);
  assert.match(replyLanguageReminder({ enabled: false, language: 'ar' }), /language the user wrote this message in/);
  assert.match(replyLanguageReminder(undefined), /language the user wrote this message in/);
});
