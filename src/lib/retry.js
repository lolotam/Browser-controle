// Retries for model requests (main and backup providers only; the fast layer
// fails fast on purpose). Free tiers often answer one request with 429 or 503
// and the next one normally; a short wait keeps the task alive. A limit that
// will not clear soon (a daily quota, credits, a plan's usage) is not retried,
// so the backup provider takes over at once.

import { MODEL_IDLE_MS } from './sse.js';

const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 30000;
const BACKOFF_MS = [2000, 6000];
const ERROR_BODY_BYTES = 4096;
// A notice only when the user would notice the pause.
const NOTICE_AFTER_MS = 2000;

/** A provider answered with an HTTP error; `detail` is its body (≤ 4 KB), read once. */
export class ProviderHttpError extends Error {
  constructor({ status, detail, retryAfterMs = null, message }) {
    super(message ?? `Model request failed (HTTP ${status})`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The request's time ran out across its attempts; not a user Stop, so the backup may take over. */
export class DeadlineError extends Error {
  constructor(ms) {
    super(`The model did not answer within ${Math.round(ms / 1000)} s, retries included.`);
    this.name = 'DeadlineError';
  }
}

/** Reads an error response once: status, body (capped) and Retry-After in ms. */
export async function readError(res) {
  const text = await res.text().catch(() => '');
  return { status: res.status, detail: text.slice(0, ERROR_BODY_BYTES), retryAfterMs: retryAfterMs(res.headers?.get?.('retry-after')) };
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.round(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

const EXHAUSTED_WORDS = /per ?day|daily|billing|insufficient[_ ](?:credits|funds|balance|quota)|payment required|credits? (?:exhausted|remaining: 0)/i;

/**
 * transient: worth a short wait (rate limit, overload, gateway, connection).
 * exhausted: a limit that will not clear soon; hand over to the backup.
 * fatal: anything else (bad request, key, model).
 */
export function classify(error, { provider = '' } = {}) {
  if (error?.network) return 'transient';
  const status = error?.status;
  if (!status) return 'fatal';
  const detail = String(error.detail ?? '');
  if (status === 402) return 'exhausted';
  if (status === 429) {
    // Google names the quota it hit: "...PerDay..." will not clear today, "...PerMinute..." will.
    const quotaId = detail.match(/"quotaId"\s*:\s*"([^"]+)"/)?.[1] ?? '';
    if (/PerDay/i.test(quotaId)) return 'exhausted';
    if (/PerMinute|PerSecond/i.test(quotaId)) return 'transient';
    if (EXHAUSTED_WORDS.test(detail)) return 'exhausted';
    // ChatGPT answers a used-up plan with 429 and no Retry-After; its rate limits carry one.
    if (provider === 'chatgpt' && error.retryAfterMs == null && !/rate.?limit/i.test(detail)) return 'exhausted';
    return 'transient';
  }
  if (status === 502 || status === 503 || status === 504) return 'transient';
  return 'fatal';
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

/**
 * Runs `attempt(remainingMs)` until it succeeds, a non-transient error comes, the
 * attempts run out, or the shared deadline would pass. `attempt` covers the
 * request up to its response headers only, so a started stream is never replayed.
 */
export async function withRetry(attempt, { signal, deadline = Date.now() + MODEL_IDLE_MS, provider = '', notify = null, wait = sleep, random = Math.random } = {}) {
  let notice = null; // id of the "trying again" notice, withdrawn once the retries end
  try {
    return await retryLoop(attempt, { signal, deadline, provider, wait, random, onPause: (err) => {
      if (notice !== null || !notify) return;
      notice = notify({ level: 'warning', kind: 'retrying', code: err.status === 429 ? 'rate-limit' : 'server', reason: `HTTP ${err.status ?? 'network'}`, detail: String(err.detail ?? err.message ?? '').slice(0, 300) }) ?? false;
    } });
  } finally {
    if (notice) notify({ dismiss: notice });
  }
}

async function retryLoop(attempt, { signal, deadline, provider, wait, random, onPause }) {
  for (let n = 1; ; n += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DeadlineError(MODEL_IDLE_MS);
    try {
      return await attempt(remaining);
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      if (n >= MAX_ATTEMPTS || classify(err, { provider }) !== 'transient') throw err;
      const jitter = 0.8 + random() * 0.4;
      const pause = err.retryAfterMs ?? Math.round(BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)] * jitter);
      // A provider asking for longer than we can wait: hand over now instead of retrying early.
      if (pause > Math.min(MAX_WAIT_MS, deadline - Date.now())) throw err;
      if (pause > NOTICE_AFTER_MS) onPause(err);
      await wait(pause, signal);
    }
  }
}
