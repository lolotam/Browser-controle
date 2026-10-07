// Read-only JWT helpers. Signatures are not verified: the tokens come straight
// from OpenAI's token endpoint and are only inspected for display and routing.

export function decodeJwtClaims(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Pulls the ChatGPT account, plan and email out of an OpenAI id/access token. */
export function chatgptIdentity(token) {
  const claims = decodeJwtClaims(token);
  if (!claims) return null;
  const auth = claims['https://api.openai.com/auth'] ?? {};
  const profile = claims['https://api.openai.com/profile'] ?? {};
  return {
    accountId: auth.chatgpt_account_id ?? null,
    planType: auth.chatgpt_plan_type ?? null,
    email: claims.email ?? profile.email ?? null,
    expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : null,
  };
}
