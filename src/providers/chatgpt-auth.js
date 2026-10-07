// "Sign in with ChatGPT" using the same OAuth client and device-code flow as
// the official Codex CLI (`codex login --device-auth`). The resulting tokens
// bill requests against the user's ChatGPT plan instead of an API key.

import { chatgptIdentity } from '../lib/jwt.js';

const ISSUER = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = `${ISSUER}/oauth/token`;
const STORAGE_KEY = 'chatgptAuth';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

let refreshInFlight = null;

export async function startDeviceLogin() {
  const res = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (res.status === 404) {
    throw new Error('Device-code login is not enabled. In ChatGPT → Settings → Security, enable device code authorization for Codex, or import auth.json instead.');
  }
  if (!res.ok) throw new Error(`Device-code request failed (HTTP ${res.status}).`);
  const body = await res.json();
  return {
    verificationUrl: `${ISSUER}/codex/device`,
    userCode: body.user_code ?? body.usercode,
    deviceAuthId: body.device_auth_id,
    interval: Math.max(1, Number.parseInt(body.interval, 10) || 5),
  };
}

/** Polls until the user approves the code in the browser, then stores tokens. */
export async function completeDeviceLogin(device, signal) {
  const started = Date.now();
  let code = null;
  while (!code) {
    if (signal?.aborted) throw new Error('Login cancelled.');
    if (Date.now() - started > DEVICE_LOGIN_TIMEOUT_MS) throw new Error('Login timed out after 15 minutes.');
    const res = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      signal,
    });
    if (res.ok) {
      code = await res.json();
    } else if (res.status === 403 || res.status === 404) {
      await sleep(device.interval * 1000, signal);
    } else {
      throw new Error(`Device login failed (HTTP ${res.status}).`);
    }
  }

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code.authorization_code,
    redirect_uri: `${ISSUER}/deviceauth/callback`,
    client_id: CLIENT_ID,
    code_verifier: code.code_verifier,
  });
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!tokenRes.ok) throw new Error(`Token exchange failed (HTTP ${tokenRes.status}): ${await safeText(tokenRes)}`);
  return storeTokens(await tokenRes.json());
}

/** Accepts the contents of ~/.codex/auth.json produced by `codex login`. */
export async function importCodexAuthJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That is not valid JSON.');
  }
  const tokens = parsed.tokens ?? parsed;
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('auth.json has no ChatGPT tokens. Run `codex login` with "Sign in with ChatGPT" first.');
  }
  return storeTokens(tokens);
}

export async function getAuthStatus() {
  const auth = await readAuth();
  if (!auth) return { connected: false };
  return { connected: true, email: auth.email, planType: auth.planType, accountId: auth.accountId };
}

export async function logout() {
  await chrome.storage.local.remove(STORAGE_KEY);
}

/** Returns a non-expired access token, refreshing it when close to expiry. */
export async function getValidAuth({ forceRefresh = false } = {}) {
  const auth = await readAuth();
  if (!auth) throw new Error('ChatGPT is not connected. Open settings and sign in.');
  const fresh = auth.expiresAt && auth.expiresAt - Date.now() > REFRESH_MARGIN_MS;
  if (fresh && !forceRefresh) return auth;
  refreshInFlight ??= refresh(auth.refreshToken).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refresh(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'openid profile email' }),
  });
  if (!res.ok) {
    const detail = await safeText(res);
    if (res.status === 400 || res.status === 401) await logout();
    throw new Error(`ChatGPT session expired, please sign in again (HTTP ${res.status}: ${detail}).`);
  }
  const body = await res.json();
  const previous = await readAuth();
  return storeTokens({
    id_token: body.id_token ?? previous?.idToken,
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? refreshToken,
  });
}

async function storeTokens(tokens) {
  const fromId = chatgptIdentity(tokens.id_token) ?? {};
  const fromAccess = chatgptIdentity(tokens.access_token) ?? {};
  const auth = {
    idToken: tokens.id_token ?? null,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: tokens.account_id ?? fromId.accountId ?? fromAccess.accountId ?? null,
    email: fromId.email ?? fromAccess.email ?? null,
    planType: fromId.planType ?? fromAccess.planType ?? null,
    expiresAt: fromAccess.expiresAt ?? Date.now() + 55 * 60 * 1000,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: auth });
  return auth;
}

async function readAuth() {
  const { [STORAGE_KEY]: auth } = await chrome.storage.local.get(STORAGE_KEY);
  return auth ?? null;
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Login cancelled.'));
    }, { once: true });
  });
}
