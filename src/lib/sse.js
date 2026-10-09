// Server-Sent Events parsing shared by every streaming provider.

/**
 * Splits a growing SSE text buffer into complete events.
 * Returns the parsed events and whatever trailing text is not yet a full event.
 */
export function parseSseChunk(buffer) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events = [];
  for (const block of blocks) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

// A model call that sends nothing for this long is treated as failed, so a hung
// provider ends the step (or hands it to the backup) instead of stalling the task.
// Generous on purpose: reasoning models can think for minutes before a token.
export const MODEL_IDLE_MS = 180000;

export class StalledError extends Error {
  constructor(ms) {
    super(`The model sent nothing for ${Math.round(ms / 1000)} s, so the request was stopped. Try again, pick a faster model or a lower reasoning effort, or turn on a backup provider.`);
    this.name = 'StalledError';
  }
}

/**
 * fetch for a model request that gives up when the response headers take longer
 * than `idleMs`. The caller's signal still stops it as before (AbortError).
 */
export async function fetchModel(url, init, idleMs = MODEL_IDLE_MS) {
  const controller = new AbortController();
  const outer = init.signal;
  if (outer?.aborted) controller.abort(outer.reason);
  outer?.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
  const timer = setTimeout(() => controller.abort(new StalledError(idleMs)), idleMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Yields `{event, data}` objects from a fetch Response body; stops after `idleMs` without data. */
export async function* readSse(response, signal, { idleMs = MODEL_IDLE_MS } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await readWithin(reader, idleMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buffer);
      buffer = rest;
      yield* events;
    }
    buffer += decoder.decode();
    const { events } = parseSseChunk(buffer + '\n\n');
    yield* events;
  } finally {
    reader.releaseLock();
  }
}

function readWithin(reader, ms) {
  let timer;
  const stalled = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new StalledError(ms)); // first: cancelling settles the pending read as done
      reader.cancel().catch(() => {});
    }, ms);
  });
  return Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
}
