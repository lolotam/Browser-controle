// Optional Google sign-in: the user's name, email and picture for the header and
// for replies to their feedback, plus a Drive access token for the settings backup
// (drive-backup.js). Google sends an OpenID Connect id_token and an access token
// straight back to https://<extension id>.chromiumapp.org/, an address only this
// extension receives, so no client secret and no backend are involved. The
// id_token's signature is not verified: the account is shown and sent with
// feedback, never used to authorise anything. The access token lives in session
// storage only; local storage keeps the profile.

import { decodeJwtClaims } from './jwt.js';

// A public OAuth client id (Web application type) whose redirect URI is this
// extension's chromiumapp.org address; it only works for the pinned extension id.
export const GOOGLE_CLIENT_ID = '422723670496-utf237ri9imn52cnben85ro49i80gkge.apps.googleusercontent.com';
const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.appdata';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const ACCOUNT_KEY = 'googleAccount';
const TOKEN_KEY = 'googleToken';
const TOKEN_MARGIN_MS = 60_000;

/** `silent` asks Google not to show any page (prompt=none), for renewing the token in the background. */
export function signInUrl({ clientId, redirectUri, nonce, loginHint, silent = false }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'id_token token',
    redirect_uri: redirectUri,
    scope: SCOPES,
    nonce,
    prompt: silent ? 'none' : 'select_account',
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return url.href;
}

/** The account and access token in Google's redirect; throws when sign-in was refused or the answer is not to this request. */
export function readRedirect(redirectUrl, { clientId, nonce, now = Date.now() }) {
  const params = new URLSearchParams(new URL(redirectUrl).hash.slice(1));
  if (params.get('error')) throw new Error(`Google sign-in failed: ${params.get('error')}`);
  const claims = decodeJwtClaims(params.get('id_token'));
  const matches = claims && claims.aud === clientId && ISSUERS.has(claims.iss) && claims.nonce === nonce && claims.exp * 1000 > now;
  if (!matches || !claims.email) throw new Error('Google sign-in returned a token that does not belong to this request.');
  return {
    account: { email: claims.email, name: claims.name || claims.email, picture: claims.picture ?? '' },
    accessToken: params.get('access_token'),
    expiresAt: now + Number(params.get('expires_in') ?? 0) * 1000,
  };
}

async function authorize({ interactive, loginHint }) {
  const nonce = crypto.randomUUID();
  const redirect = await chrome.identity.launchWebAuthFlow({
    url: signInUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri: chrome.identity.getRedirectURL(), nonce, loginHint, silent: !interactive }),
    interactive,
  });
  const result = readRedirect(redirect, { clientId: GOOGLE_CLIENT_ID, nonce });
  await chrome.storage.session.set({ [TOKEN_KEY]: { accessToken: result.accessToken, expiresAt: result.expiresAt } });
  return result;
}

export async function signInWithGoogle() {
  const { account } = await authorize({ interactive: true });
  await chrome.storage.local.set({ [ACCOUNT_KEY]: account });
  return account;
}

export async function googleAccount() {
  return (await chrome.storage.local.get(ACCOUNT_KEY))[ACCOUNT_KEY] ?? null;
}

/** A Drive access token: the cached one while it is valid, else renewed without showing Google's page. */
export async function googleAccessToken() {
  const { [TOKEN_KEY]: cached } = await chrome.storage.session.get(TOKEN_KEY);
  if (cached?.accessToken && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return cached.accessToken;
  const account = await googleAccount();
  if (!account) throw new Error('Sign in with Google first.');
  try {
    return (await authorize({ interactive: false, loginHint: account.email })).accessToken;
  } catch (err) {
    throw new Error(`Google needs you to sign in again (${err.message}).`);
  }
}

/** The Drive backup stays in the user's Drive; signing out only forgets the account here. */
export async function signOutOfGoogle() {
  await chrome.storage.local.remove(ACCOUNT_KEY);
  await chrome.storage.session.remove(TOKEN_KEY);
}
