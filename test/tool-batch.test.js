import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolExecutor } from '../src/agent/tools.js';

// A browser whose URL the test moves, with a snapshot that names the page it saw.
function fakeBrowser() {
  const browser = {
    url: 'https://a.test/',
    overlay: { pointTo: async () => {}, say: async () => {} },
    currentTab: async () => ({ id: 1, url: browser.url }),
    snapshot: async () => ({ url: browser.url, title: 'T', scroll: { y: 0, viewport: 100, height: 100 }, elements: ['[0] button "Go"'], offscreen: 0, text: 'page text' }),
    pressKey: async (key) => { if (key === 'Enter') browser.url = 'https://a.test/results'; },
  };
  return browser;
}

test('an action inside a batch that leaves the page alone skips the snapshot', async () => {
  const execute = createToolExecutor(fakeBrowser(), { askUser: async () => '' });
  const out = await execute('press_key', { key: 'Tab' }, { observe: false });
  assert.match(out.output, /^Pressed Tab\. \(Page state follows the last action of this turn\.\)$/);
  assert.equal(out.pageChanged, undefined);
});

test('an action inside a batch that changes the page reports the new page and flags it', async () => {
  const execute = createToolExecutor(fakeBrowser(), { askUser: async () => '' });
  const out = await execute('press_key', { key: 'Enter' }, { observe: false });
  assert.equal(out.pageChanged, true);
  assert.match(out.output, /URL: https:\/\/a\.test\/results/);
});

test('the last action of a turn, and read_page, always report the page', async () => {
  const execute = createToolExecutor(fakeBrowser(), { askUser: async () => '' });
  assert.match((await execute('press_key', { key: 'Tab' })).output, /Interactive elements/);
  assert.match((await execute('read_page', {}, { observe: false })).output, /Interactive elements/);
});
