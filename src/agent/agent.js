// The observe → decide → act loop. Provider-agnostic: a session exposes
// addUserMessage / addToolResult / next, and returns { text, toolCalls }.

const SUMMARY_PROMPT = 'You have reached the step limit. Stop using tools and write the final report now: what was done, all information collected with sources, and what remains.';

export async function runAgent({ session, execute, task, maxSteps, signal, emit }) {
  session.addUserMessage(task);

  for (let step = 1; step <= maxSteps; step += 1) {
    throwIfAborted(signal);
    emit({ type: 'thinking', step });
    const turn = await session.next({ signal, onEvent: emit });
    if (turn.usage) emit({ type: 'usage', usage: turn.usage });
    if (turn.text) emit({ type: 'assistant-text', text: turn.text });

    if (!turn.toolCalls.length) {
      emit({ type: 'final', report: turn.text || '(The model ended without a report.)', success: true });
      return;
    }

    // Every tool call must get a result, even when the run stops early, or the
    // provider rejects the conversation on the next follow-up message.
    const pending = [...turn.toolCalls];
    try {
      while (pending.length) {
        throwIfAborted(signal);
        const call = pending.shift();
        if (call.name === 'done') {
          session.addToolResult(call.id, 'Report delivered to the user.');
          emit({ type: 'final', report: call.args.report ?? '', success: call.args.success !== false });
          return;
        }
        emit({ type: 'tool-start', step, name: call.name, args: call.args });
        const result = await execute(call.name, call.args);
        emit({ type: 'tool-end', step, name: call.name, ok: !result.isError, summary: firstLine(result.output) });
        session.addToolResult(call.id, result.output, result.images ?? []);
      }
    } finally {
      for (const call of pending) session.addToolResult(call.id, 'Not executed: the run ended before this call.');
    }
  }

  session.addUserMessage(SUMMARY_PROMPT);
  const summary = await session.next({ signal, onEvent: emit, toolChoice: 'none' });
  emit({ type: 'final', report: summary.text || 'Step limit reached before the task was finished.', success: false });
}

function firstLine(text = '') {
  const line = String(text).split('\n')[0];
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Stopped by user', 'AbortError');
}
