import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elementAction } from '../src/browser/page-scripts.js';

// The smallest element elementAction('locate') reads, with the given attributes.
function locate(attrs, type = 'text') {
  const el = {
    isConnected: true,
    type,
    tagName: 'INPUT',
    innerText: '',
    style: {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30 }),
    getAttribute: (name) => attrs[name] ?? null,
  };
  globalThis.window = { __agentElements: [el] };
  return elementAction(0, 'locate', null, true);
}

test('locate marks password, payment and one-time-code fields as secret', () => {
  assert.equal(locate({}, 'password').secret, true);
  assert.equal(locate({ autocomplete: 'cc-number' }).secret, true);
  assert.equal(locate({ autocomplete: 'one-time-code' }).secret, true);
});

test('locate finds secret autocomplete tokens behind section and grouping prefixes', () => {
  assert.equal(locate({ autocomplete: 'section-checkout billing cc-number' }).secret, true);
  assert.equal(locate({ autocomplete: 'shipping  CC-CSC' }).secret, true);
  assert.equal(locate({ autocomplete: 'section-login current-password' }).secret, true);
});

test('locate leaves ordinary fields readable', () => {
  assert.equal(locate({ autocomplete: 'shipping email' }).secret, false);
  assert.equal(locate({ autocomplete: 'one-time-code-hint' }).secret, false);
  assert.equal(locate({ placeholder: 'Search' }).label, 'Search');
});
