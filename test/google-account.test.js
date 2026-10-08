import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRedirect, signInUrl } from '../src/lib/google-account.js';

const clientId = 'client.apps.googleusercontent.com';
const now = Date.UTC(2026, 9, 9);
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const idToken = (claims) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;
const redirect = (fragment) => `https://bhoimdlegicacjkholpfcokajpiimbcn.chromiumapp.org/#${fragment}`;
const goodClaims = { iss: 'https://accounts.google.com', aud: clientId, nonce: 'n1', exp: now / 1000 + 3600, email: 'user@example.com', name: 'سارة', picture: 'https://lh3.googleusercontent.com/a/x' };

test('sign-in asks for the profile and Drive app-data access, sent back to the extension', () => {
  const url = new URL(signInUrl({ clientId, redirectUri: 'https://ext.chromiumapp.org/', nonce: 'n1' }));
  assert.equal(url.searchParams.get('response_type'), 'id_token token');
  assert.equal(url.searchParams.get('scope'), 'openid email profile https://www.googleapis.com/auth/drive.appdata');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://ext.chromiumapp.org/');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
});

test('background renewal shows no Google page and names the signed-in account', () => {
  const url = new URL(signInUrl({ clientId, redirectUri: 'https://ext.chromiumapp.org/', nonce: 'n1', loginHint: 'user@example.com', silent: true }));
  assert.equal(url.searchParams.get('prompt'), 'none');
  assert.equal(url.searchParams.get('login_hint'), 'user@example.com');
});

test('a matching answer gives the profile (UTF-8 names included) and the access token with its expiry', () => {
  const result = readRedirect(redirect(`id_token=${idToken(goodClaims)}&access_token=ya29.x&expires_in=3599`), { clientId, nonce: 'n1', now });
  assert.deepEqual(result.account, { email: 'user@example.com', name: 'سارة', picture: 'https://lh3.googleusercontent.com/a/x' });
  assert.equal(result.accessToken, 'ya29.x');
  assert.equal(result.expiresAt, now + 3599000);
});

test('a token that is not the answer to this request is refused', () => {
  const cases = [
    ['another app', { aud: 'other-client' }],
    ['a replayed sign-in', { nonce: 'old' }],
    ['an expired token', { exp: now / 1000 - 1 }],
    ['another issuer', { iss: 'https://evil.example' }],
  ];
  for (const [name, change] of cases) {
    assert.throws(() => readRedirect(redirect(`id_token=${idToken({ ...goodClaims, ...change })}`), { clientId, nonce: 'n1', now }), /does not belong/, name);
  }
});

test('a refused or cancelled consent reports Google\'s error', () => {
  assert.throws(() => readRedirect(redirect('error=access_denied'), { clientId, nonce: 'n1', now }), /access_denied/);
});
