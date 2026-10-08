// Optional Google sign-in: the user's name, email and picture for the header and
// for replies to their feedback. Google sends an OpenID Connect id_token straight
// back to https://<extension id>.chromiumapp.org/, an address only this extension
// receives, so no client secret and no backend are involved. The token's signature
// is not verified: the account is shown and sent with feedback, never used to
// authorise anything. Only the profile is stored, not the token.

import { decodeJwtClaims } from './jwt.js';

// A public OAuth client id (Web application type) whose redirect URI is this
// extension's chromiumapp.org address; it only works for the pinned extension id.
export const GOOGLE_CLIENT_ID = '422723670496-utf237ri9imn52cnben85ro49i80gkge.apps.googleusercontent.com';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const KEY = 'googleAccount';

export function signInUrl({ clientId, redirectUri, nonce }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'id_token',
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    nonce,
    prompt: 'select_account',
  });
  return url.href;
}

/** The account in Google's redirect; throws when sign-in was refused or the token is not the answer to this request. */
export function accountFromRedirect(redirectUrl, { clientId, nonce, now = Date.now() }) {
  const params = new URLSearchParams(new URL(redirectUrl).hash.slice(1));
  if (params.get('error')) throw new Error(`Google sign-in failed: ${params.get('error')}`);
  const claims = decodeJwtClaims(params.get('id_token'));
  const matches = claims && claims.aud === clientId && ISSUERS.has(claims.iss) && claims.nonce === nonce && claims.exp * 1000 > now;
  if (!matches || !claims.email) throw new Error('Google sign-in returned a token that does not belong to this request.');
  return { email: claims.email, name: claims.name || claims.email, picture: claims.picture ?? '' };
}

export async function signInWithGoogle() {
  const nonce = crypto.randomUUID();
  const redirect = await chrome.identity.launchWebAuthFlow({
    url: signInUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri: chrome.identity.getRedirectURL(), nonce }),
    interactive: true,
  });
  const account = accountFromRedirect(redirect, { clientId: GOOGLE_CLIENT_ID, nonce });
  await chrome.storage.local.set({ [KEY]: account });
  return account;
}

export async function googleAccount() {
  return (await chrome.storage.local.get(KEY))[KEY] ?? null;
}

export async function signOutOfGoogle() {
  await chrome.storage.local.remove(KEY);
}
