# Fast layer on any gateway model — design

Date: 2026-10-08 · Status: approved

## Goal

Let the fast ("System One") layer run on OpenRouter, Vercel AI Gateway or any
OpenAI-compatible endpoint, not only TypeSafe's Jev. The user picks a provider,
enters an API key and a model.

## Context

`createFastLayer({ ..., ask = askJev })` already takes the client as a
parameter. A client receives `{ baseUrl, apiKey, model, state, questions, signal }`
and returns `{ answers, usage, model }`, where each answer is
`{ type: 'choice', choice, confidence, probabilities }` or
`{ type: 'noul', noul }`. `decide()` and the gate only read that shape, so a new
client that honours it needs no change to the gate or the agent loop.

## Decisions

- **Approach A — prompted JSON.** One `/chat/completions` call per step with
  `response_format: { type: 'json_object' }`. Logprobs were rejected: one call per
  question, and many gateway models (Claude, Gemini) return none.
- Probabilities are the model's own estimate, not calibrated, so gateway presets
  default `minProb` to **0.75** (Jev keeps 0.6).

## Settings

`fast.provider`: `typesafe` | `openrouter` | `vercel` | `custom`, plus the existing
`baseUrl`, `apiKey`, `model`, `minProb`, `riskyMax`, `mode`, `enabled`.

| preset | baseUrl | default model | minProb |
|---|---|---|---|
| typesafe (TypeSafe Jev) | `https://api.typesafe.ai` | `jev-latest` | 0.6 |
| openrouter | `https://openrouter.ai/api/v1` | `anthropic/claude-haiku-5.5` | 0.75 |
| vercel (Vercel AI Gateway) | `https://ai-gateway.vercel.sh/v1` | `anthropic/claude-haiku-5.5` | 0.75 |
| custom | (user) | (user) | 0.75 |

Stored settings without `provider` merge to `typesafe`, so existing Jev users
are unaffected. Switching preset in the panel fills `baseUrl`, `model` and
`minProb`; the user can edit all three.

## Components

- `src/fast/chat-judge-client.js` — `askChatJudge(request)`: same contract as
  `askJev`. Builds a system prompt describing each question (choice → pick one
  key from `criteria` and give a probability per key; noul → a number 0..1) and a
  user message with the `state`. Parses the JSON reply and normalises it:
  - unknown choice keys are dropped; probabilities clamp to 0..1 and renormalise
    to sum 1; `choice` is the top key; `confidence` = p(top) − p(second);
  - a question missing from the reply is omitted (the gate already treats a
    missing `risky` as 1 → escalate, and a missing `operation` → escalate);
  - non-JSON or HTTP errors throw with the status and a short body excerpt.
  Timeout 15 s (gateways are slower than Jev's 8 s).
- `src/fast/clients.js` — `fastClientFor(provider)` returns `askJev` for
  `typesafe`, otherwise `askChatJudge`. Used by the service worker for both the
  fast layer and the "test connection" button.
- `src/lib/settings.js` — `FAST_PRESETS` and the `provider` default.
- `listCompatibleModels` — skip non-language entries (`type` present and not
  `language`); Vercel's list includes image, video and embedding models.
- Panel — provider select, base URL, API key, model with the ↻ model list.

## Error handling

Unchanged fast-layer policy: any client error escalates that step to the main
LLM; three consecutive failures switch the fast layer off for the task.

## Testing

- Unit (`askChatJudge`, stubbed `fetch`): maps a valid reply to the answer shape;
  renormalises probabilities and drops unknown keys; omits missing questions;
  throws on malformed JSON and on HTTP errors; sends `response_format` and the
  bearer key to `<baseUrl>/chat/completions`.
- Unit (settings): stored fast settings without `provider` become `typesafe`.
- Unit (`listCompatibleModels`): non-language models are filtered out.
- E2E: a "chat-fast" scenario where a mock chat-completions server plays the
  fast layer instead of mock Jev.

## Out of scope

Full panel redesign (separate task), Vercel AI Gateway as a main-model preset,
logprob-based calibration.
