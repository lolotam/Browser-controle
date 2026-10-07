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

/** Yields `{event, data}` objects from a fetch Response body. */
export async function* readSse(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
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
