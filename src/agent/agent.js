// The observe → decide → act loop. Provider-agnostic: a session exposes
// addUserMessage / addToolResult / next, and returns { text, toolCalls }.
// An optional fast layer (Jev) runs before each LLM turn and either executes a
// confident step itself or hands the step to the LLM with ranked options.

import { escalationMessage } from '../fast/fast-layer.js';

const SKIPPED_PAGE_CHANGED = 'Not executed: the page changed after an earlier action in this turn. Decide again from the new page state.';
const SKIPPED_AFTER_ERROR = 'Not executed: an earlier action in this turn failed. Decide again.';
const SKIPPED_AFTER_ASK = 'Not executed: you asked the user a question in this turn. Read the answer, then decide again.';
const SUMMARY_PROMPT = 'You have reached the step limit. Stop using tools and write the final report now: what was done, all information collected with sources, and what remains.';

export async function runAgent({ session, execute, task, maxSteps, signal, emit, fastLayer = null }) {
  session.addUserMessage(task);
  let fast = fastLayer;
  let fastActions = [];
  let llmHasSeenPage = false;

  for (let step = 1; step <= maxSteps; step += 1) {
    throwIfAborted(signal);

    if (fast) {
      const outcome = await fast.step({ signal });
      throwIfAborted(signal);
      if (outcome.kind === 'off') {
        fast = null;
        emit({ type: 'fast-handoff', reason: 'Fast layer failed 3 times; continuing with the main model only' });
      } else if (outcome.kind === 'acted') {
        emit({ type: 'tool-start', step, name: outcome.tool, args: outcome.args, fast: true });
        emit({ type: 'tool-end', step, name: outcome.tool, ok: !outcome.result.isError, summary: firstLine(outcome.result.output) });
        fastActions.push(`${outcome.label} → ${firstLine(outcome.result.output)}`);
        continue;
      } else {
        if (outcome.reason) emit({ type: 'fast-handoff', reason: outcome.reason });
        const note = escalationMessage({ fastActions, outcome, includePage: fastActions.length > 0 || !llmHasSeenPage });
        if (note) session.addUserMessage(note);
        fastActions = [];
      }
    }

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
        // Several actions in one turn: only the last returns the page state, which
        // saves a full page snapshot per action; an earlier one reports it only if
        // the page changed, and then the rest of the batch is not run.
        const last = !pending.some((c) => c.name !== 'done');
        emit({ type: 'tool-start', step, name: call.name, args: call.args });
        const result = await execute(call.name, call.args, { observe: last });
        emit({ type: 'tool-end', step, name: call.name, ok: !result.isError, summary: firstLine(result.output) });
        session.addToolResult(call.id, result.output, result.images ?? []);
        fast?.recordLlmAction(call.name, call.args);
        llmHasSeenPage = true;
        // The rest of the turn waits for the model to look again when an action
        // failed (a pending done must not report success), when the user was asked
        // something (an approval must be read before anything it governs runs), or
        // when the page changed under an earlier action.
        const reason = result.isError ? SKIPPED_AFTER_ERROR
          : call.name === 'ask_user' ? SKIPPED_AFTER_ASK
            : result.pageChanged ? SKIPPED_PAGE_CHANGED : null;
        if (reason) for (const skipped of pending.splice(0)) session.addToolResult(skipped.id, reason);
      }
    } finally {
      for (const call of pending) session.addToolResult(call.id, 'Not executed: the run ended before this call.');
    }
  }

  const unseen = fastActions.length ? `\n\nSteps executed by the fast layer you have not seen yet:\n${fastActions.join('\n')}` : '';
  session.addUserMessage(SUMMARY_PROMPT + unseen);
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
