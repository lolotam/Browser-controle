# Provider fallback and failure notices — design

Date: 2026-10-08 · Status: proposed

## Goal

When the main model's provider fails (plan or quota exhausted, key rejected,
server error, no connection), a configured backup provider finishes the task.
The fast layer gets the same: a backup decision provider. Every failure is
shown as a persistent, dismissible notice under the header so the user knows
the backup is working and can act.

## Decisions (from the user)

- Switch on **any provider failure**. A user stop never triggers a switch.
- **Continue the same task** on the backup through a handoff message.
- **Each new task starts on the primary** again.
- Notices: red for the main model, amber for the fast layer; plain-language
  reason; stay for the chat session (survive closing the panel); closable;
  at most 3 visible, newest first.

## Main model: `FallbackSession`

A wrapper with the session interface `runAgent` already uses
(`addUserMessage`, `addToolResult`, `next`), so the agent loop is unchanged.

- Holds the primary session and a factory for the backup session.
- Keeps a provider-neutral log: the task and user notes, each tool call with
  the first line of its result, and the latest observation (text up to 3,000
  characters plus its screenshot, if any).
- `next()` on the primary throws (not an `AbortError`) → emit
  `{ type: 'notice', level: 'error', ... }`, build the backup session, add one
  handoff message, then call `next()` on the backup. Later calls go to the
  backup.
- Handoff message: "You are taking over a browser task from another model that
  stopped (reason). Task: … Steps already done: 1. … Latest page observation: …
  Continue from here; do not repeat completed steps."
- The backup also throws → the run fails with both reasons, and a red notice
  says both providers failed.
- New task after a switch: `startRun` builds a fresh primary session seeded with
  the same neutral log as a handoff, so the follow-up keeps the context.

## Fast layer: backup decision provider

`createFastLayer` takes an `ask` function. A composed ask tries the primary
client and, on error, the backup client for the same step (steps are
independent, so no handoff). After 3 primary failures in a task, it calls the
backup directly. Each switch emits an amber notice once per task. Only decision
providers are offered: TypeSafe Jev and Vercel AI Gateway (OpenRouter has no
decision model).

## Failure reasons

`describeFailure(error)` maps errors to short reasons: 429 → usage limit or
quota; 401/403 → key rejected or no access; `TypeError: Failed to fetch` → no
connection; 5xx → provider server error; otherwise the first 120 characters.
The full message is kept for the notice tooltip.

## Settings

```
fallback: { enabled, provider: 'chatgpt' | 'compatible',
            chatgpt: { model, effort },
            compatible: { preset, baseUrl, apiKey, model, effort } }
fast.fallback: { enabled, provider: 'typesafe' | 'vercel', baseUrl, apiKey, model, decision }
```

Defaults: disabled. Older stored settings merge to disabled.

## Interface

- A reusable provider form (provider, preset, base URL, key, model picker with
  search, reasoning effort) used by the main card and a new "Backup provider"
  card, instead of duplicating the form code.
- A "Backup decision provider" section inside the fast-layer card.
- Notices: a stack under the header; each shows an icon, the reason, which
  provider took over, and ×. They are transcript events in the service worker,
  so a reopened panel replays them; closing one sends `dismiss-notice`.

## Testing

- Unit: `FallbackSession` switches on failure and not on abort, the handoff holds
  the task, steps and latest observation, both-failed error, new task on the
  primary with the log; composed fast ask (per-step backup, primary skipped after
  3 failures); `describeFailure` mappings.
- E2E: the primary mock returns 429 mid-task, the backup mock finishes it, and
  the panel shows a red notice; Jev on the primary fails and the backup answers,
  with an amber notice.

## Out of scope

More than one backup per layer; automatic retry of the primary within a task.
