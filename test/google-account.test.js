import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountFromRedirect, signInUrl } from '../src/lib/google-account.js';

const clientId = 'client.apps.googleusercontent.com';
const now = Date.UTC(2026, 9, 9);
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const idToken = (claims) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;
const redirect = (fragment) => `https://bhoimdlegicacjkholpfcokajpiimbcn.chromiumapp.org/#${fragment}`;
const goodClaims = { iss: 'https://accounts.google.com', aud: clientId, nonce: 'n1', exp: now / 1000 + 3600, email: 'user@example.com', name: 'سارة', picture: 'https://lh3.googleusercontent.com/a/x' };

test('the sign-in request asks Google for an id token with the profile, sent back to the extension', () => {
  const url = new URL(signInUrl({ clientId, redirectUri: 'https://ext.chromiumapp.org/', nonce: 'n1' }));
  assert.equal(url.searchParams.get('response_type'), 'id_token');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://ext.chromiumapp.org/');
  assert.equal(url.searchParams.get('nonce'), 'n1');
});

test('a matching token gives the name, email and picture (UTF-8 names included)', () => {
  const account = accountFromRedirect(redirect(`id_token=${idToken(goodClaims)}`), { clientId, nonce: 'n1', now });
  assert.deepEqual(account, { email: 'user@example.com', name: 'سارة', picture: 'https://lh3.googleusercontent.com/a/x' });
});

test('a token that is not the answer to this request is refused', () => {
  const cases = [
    ['another app', { aud: 'other-client' }],
    ['a replayed sign-in', { nonce: 'old' }],
    ['an expired token', { exp: now / 1000 - 1 }],
    ['another issuer', { iss: 'https://evil.example' }],
  ];
  for (const [name, change] of cases) {
    assert.throws(() => accountFromRedirect(redirect(`id_token=${idToken({ ...goodClaims, ...change })}`), { clientId, nonce: 'n1', now }), /does not belong/, name);
  }
});

test('a refused or cancelled consent reports Google\'s error', () => {
  assert.throws(() => accountFromRedirect(redirect('error=access_denied'), { clientId, nonce: 'n1', now }), /access_denied/);
});
