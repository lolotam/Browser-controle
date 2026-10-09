// Turns provider errors into a short reason the user can act on (top up credit,
// fix the key, check the connection). Provider clients embed "HTTP <status>" in
// their messages, so the status is read from the text. `code` lets the panel
// translate the reason; `reason` is the English fallback for "other".

const MAX_REASON = 120;
const REASONS = {
  quota: 'Usage limit or quota reached',
  auth: 'API key rejected or no access to this model',
  server: 'The provider’s server failed',
  network: 'No connection to the provider',
};

export function describeFailure(error) {
  const detail = String(error?.message ?? error);
  const code = codeFor(error, detail);
  const reason = REASONS[code] ?? (detail.length > MAX_REASON ? `${detail.slice(0, MAX_REASON)}…` : detail);
  return { code, reason, detail };
}

function codeFor(error, detail) {
  if (/usage limit|quota|insufficient.*(credit|balance)/i.test(detail)) return 'quota';
  const status = Number(detail.match(/HTTP (\d{3})/)?.[1]);
  if (status === 429) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'server';
  if (error instanceof TypeError && /fetch|network/i.test(detail)) return 'network';
  return 'other';
}

/**
 * The provider's own message from an error body, whose JSON shape differs by
 * provider ({error: {message}}, {detail: {message}}, {error: "..."}), else the raw text.
 */
export function providerMessage(text, max = 300) {
  let message = text;
  try {
    const body = JSON.parse(text);
    const inner = body.error ?? body.detail ?? body;
    message = typeof inner === 'string' ? inner : inner.message ?? inner.msg ?? text;
  } catch {
    // not JSON: an HTML error page or plain text, shown as it is
  }
  return String(message).slice(0, max);
}
