# Reliability, Agent Tools and UX — Design

**Date:** 2026-10-10 · **Status:** approved by the owner, to be debated (Codex) before implementation
**Plan:** `docs/superpowers/plans/2026-10-10-reliability-and-ux.md`

> **Revision 2 (after debate round 1 with Codex):** where this design and the plan differ, the plan's revision 2 is authoritative. Main changes:
> - **Dates (§4.2):** a "Dates on this page" section from `datetime` attributes replaces the general shadow-DOM text walker.
> - **No vision (§4.3):** explicit phrases only, gated on status and on images being present.
> - **Retries (§4.4):** main and backup providers only, with a total 30 s budget. Classes are transient, exhausted and fatal. A `Retry-After` longer than the budget hands over to the backup.
> - **Text tool calls (§4.1):** only when the whole answer is call blocks; schema-typed arguments; a completed stream is required.
> - **Notes (§4.5):** the notebook is owned by the `SessionRunner` and saved with the session. Tool kinds drive batching and compaction.
> - **Autocomplete (§4.6):** options come from the listbox tied to the field; exactly one exact match is clicked; no blind Enter; the value is checked after the click.
> - **Notifications (§4.8):** generic translated text; routing kept in session storage; top-level listeners.
> - **Time and tokens (§4.9):** call, turn and model identities; cost deferred.
> - **Store build (§4.10):** effective-capability enforcement plus strip markers in the ZIP. The rationale is corrected: the Debugger API has a policy exception, so the removal lowers a risk rather than guaranteeing approval.
> - **New prerequisite:** the hard set is merged and runs are reproducible.

## 1. Problem

The showcase harness (`showcase/`, `npm run showcase`) ran the extension on two fixed task sets with six free models and Jev as the fast layer.

- **Basic set (2026-10-09):** the two best models passed 9/10.
- **Hard set (2026-10-10):** the best passed 6/10. Every failure was read from the transcripts and recordings:

| Cause | Runs lost (hard set) | Owner |
|---|---|---|
| Free-tier 429 / 503 on a single request ends the task | 21 / 60 | providers |
| GitHub release dates live in `<relative-time>` shadow roots; `innerText` skips them | 6 / 6 GitHub runs | page reading |
| Older pages are cut to 400 characters (`KEEP_FULL_OBSERVATIONS = 2`), so data from page 1 is gone by page 3 | 6 / 6 multi-page Mystery runs | conversation compaction |
| Autocomplete widgets (react-select) are not usable with type/click/select tools | 5 / 6 long-form runs | agent tools |
| A model writes its tool call as text (`<tool_call><function=…>`); the loop treats it as the final report | 2 | providers |
| vLLM's "multimodal processing is not enabled" is not recognised as a no-vision model | 1 | providers |

Users also lack: a known-good free setup, a way to learn that a long task finished while they work elsewhere, and visibility of time and tokens per step. The Chrome Web Store build still offers `run_javascript`, which the store's remote-code policy can treat as executing remotely supplied code.

## 2. Goals

1. A transient provider failure (429 rate limit, 502/503/504, network) does not end a task.
2. The agent can read text inside open shadow roots and machine-readable dates.
3. Tool calls a model writes as text are executed, not shown as a report.
4. Every known "no vision" error leads to a text-only retry, never a failed task.
5. Data collected on earlier pages survives compaction.
6. The agent can fill autocomplete and custom dropdown widgets.
7. New users get a one-click recommended free setup; optional task-done notifications; time and tokens per step.
8. The store build contains no `run_javascript` tool; the development build keeps it.

**Success metric** (hard set, same six models and Jev, after PR A and again after PR B):
- GitHub releases pass on ≥ 3 of the models that are not quota-blocked.
- Provider errors < 10 / 60.
- Mystery passes on ≥ 2 models; the long form on ≥ 3.

## 3. Non-goals

- Terminal / native-host control (owner decision 2026-10-10: not now).
- Changing the default provider (ChatGPT sign-in stays the default; the recommended setup is an offer).
- Closed shadow roots, iframes from other origins, canvas text.
- Paid-tier routing or automatic model switching beyond the existing backup provider.

## 4. Design

### 4.1 Text tool calls (providers)

- **Where:** `CompatibleSession.next`, after the stream ends, and only when it produced no native tool calls.
- **What is parsed:** two formats, only when the block is outside Markdown code fences.
  - Hermes/Qwen XML: `<tool_call><function=NAME><parameter=K>V</parameter>…</function></tool_call>`.
  - JSON inside `<tool_call>…</tool_call>`: `{"name", "arguments"}`.
- **Values:** a value that parses as JSON (number, boolean, object) is used as such; otherwise it is kept as a string.
- **Accepted calls:** only names in the session's tool list. Anything else stays text.
- **History:** the assistant message is rewritten as a `tool_calls` message, so the next request is a valid conversation. Ids are `text_call_<turn>_<n>`.
- **ChatGPT (Responses API):** no change; native function calls only.

### 4.2 Shadow DOM and dates (page reading)

- **Shared walker:** `snapshotPage` and `pageText` (injected functions) use one walker:
  - It reads the visible text of the light DOM and of every open shadow root, in document order.
  - It skips `display:none` / `visibility:hidden` nodes, as `innerText` does.
- **Dates:** `<time datetime>` and `<relative-time datetime>` (any element with a `datetime` attribute and short text) render as `shown text (ISO date)`.
- **Limits:** the existing character caps still apply. Closed roots are skipped.
- **Code duplication:** both functions are serialized separately by `chrome.scripting.executeScript`, so the walker is defined inside each. A unit test checks the two copies stay identical.

### 4.3 No-vision errors (providers)

- **Pattern:** the existing retry-without-images path now matches `/image input|support(?:s)? images?|vision|multimodal/i`.
- **Guard:** it is still used only when the conversation actually holds images, so it cannot loop.

### 4.4 Retries (new `src/lib/retry.js`)

- **API:** `withRetry(send, { signal, attempts = 3, notify })` wraps the request up to the response headers. It never replays a body stream that already started.
- **Retried:** HTTP 429, 502, 503 and 504, and fetch `TypeError` (network).
- **Not retried:**
  - A 429 whose body names a quota or billing limit (`exceeded your current quota`, `insufficient`, `billing`, `credits`). It fails at once, so the backup provider takes over.
  - Any other 4xx.
- **Wait:** the `Retry-After` header (seconds or HTTP date) capped at 30 s; otherwise 2 s, then 6 s, with ±20 % jitter.
- **Stop:** an abort during the wait rejects with `AbortError`.
- **Used by:** the main and backup providers (`CompatibleSession`, `ChatgptSession`) and the three fast-layer clients.
- **Notice:** one quiet panel notice per task ("The provider is busy; retrying…"), only when a wait exceeded 2 s.

### 4.5 Notes (agent tools + compaction)

- **New tools:**
  - `note({text})`: up to 1 500 characters. Appends to the task's notebook and returns `Saved (N notes).`.
  - `read_notes()`: returns the whole notebook.
- **Notebook:** belongs to the task and lives in the tool executor. It holds at most 12 000 characters; the oldest notes drop first, with a "[earlier notes dropped]" marker.
- **Visibility:** every full page observation ends with `Your notes so far:` + the notebook, so the notes never depend on old messages surviving compaction.
- **Compaction:** both providers skip `note` / `read_notes` results.
- **Persistence:** the notebook is copied into the `FallbackSession` log, so the handoff to a backup and a reopened session keep it.
- **Prompt:** collect-across-pages tasks must `note` each page's findings before leaving it, and build the report from the notes.

### 4.6 Autocomplete (agent tools)

- **Tool:** `choose_suggestion({index, text, option?})`. Implemented in the controller with page scripts:
  1. Focus and clear the field, then type `text` through CDP `insertText`.
  2. Wait for suggestions: settle, then up to 2 s for a visible `[role=option]`, an item inside `[role=listbox]`, an `li` under an `aria-expanded="true"` owner, or an element whose class matches `/__option|-option\b|autocomplete.*item|suggestion/i`.
  3. Click the suggestion whose text equals `option ?? text` (case-insensitive). If none is equal, click the first one that contains it.
  4. If no suggestions are visible, press ArrowDown, then Enter.
- **Result:** the chosen text, or the list of suggestions seen (≤ 10) when none matched.
- **Cursor:** the live cursor captions it as "Choosing “X”". The batch rules (§ earlier PR) apply: its result is short and it is a page-changing action for the batch guard.

### 4.7 Recommended free setup (settings)

- **Card:** at the top of the "AI model" tab.
  - **Main:** NVIDIA NIM `nvidia/nemotron-3-super-120b-a12b`.
  - **Backup:** OpenRouter `apodex/apodex-1.1-mini:free`.
  - Each shows its "Get a key" link and a key field.
- **"Use this setup":** fills both frames and turns the backup on. Nothing is saved until Save.
- **Visibility:** shown while no provider key and no ChatGPT sign-in exist. A "Recommended setup" link brings it back.
- **Source line:** the card cites its evidence (showcase, October 2026).

### 4.8 Notifications (optional permission)

- **Manifest:** `optional_permissions: ["notifications"]`.
- **Switch:** "Notify me when a task finishes or needs me". Turning it on requests the permission from the click handler; turning it off removes it.
- **When:**
  - **Events:** `final`, `error` and `ask`.
  - **Only if:** the session's current tab is not the active tab of the focused window.
- **Content:** the session title plus the first line of the report, error or question.
- **Click:** focuses the tab and opens the side panel.
- **Docs:** privacy policy and store justification updated.

### 4.9 Time and tokens (panel)

- **Timestamps:** `SessionRunner.emit` stamps every stored event with `at` (ms epoch).
- **Panel:**
  - Each step shows its duration (`tool-start` → `tool-end`), and each model turn its thinking time.
  - Each turn shows usage as "1.2k in · 300 out".
  - The final report shows the total time and total tokens.
- **Usage source:**
  - **`CompatibleSession`:** sends `stream_options: { include_usage: true }` for the presets openai, openrouter, nvidia, deepseek, gemini, opencode-zen and opencode-go.
  - **Custom endpoints:** it is sent only after an earlier response proved usage support.
  - **ChatGPT:** already reports usage.
- **Cost:** an estimate only for OpenRouter, from the per-token prices in its `/models` list (already fetched for the picker).

### 4.10 Store build without `run_javascript` (owner decision: remove from the store build only)

- **Flag file:** a new `src/lib/build.js` exports `STORE_BUILD = false` in the repository. `scripts/package.mjs` writes `STORE_BUILD = true` into the ZIP's copy.
- **Effect when true:**
  - `toolDefinitions()` leaves out `run_javascript`.
  - The settings page hides its switch.
  - `settings.allowJavascript` is ignored.
- **Store answers:** "Remote code: No" becomes accurate. `CHROMEWEBSTORE.md` drops the matching known-issue line.

## 5. Error handling and safety

- **Batch boundaries:** the existing rules stand (ask_user, failures and page changes end a batch). `note` and `read_notes` never end a batch; `choose_suggestion` behaves like `type_text`.
- **Untrusted page text:** text read from shadow roots stays data. The prompt's untrusted-content rule is unchanged.
- **Text tool-call parsing:** never executes a tool name the session did not offer. Sensitive tools keep their `ask_user` requirements.
- **Retries:** never retry a user Stop, a 4xx other than 429, or a quota-exhausted 429.
- **Notifications:** carry no page content beyond one line of the agent's own text.

## 6. Testing

- **Unit:** each item has tests (listed per task in the plan). New tests go in `test/retry.test.js`, plus additions to the providers, robustness, page-scripts, agent, tool-batch, fallback-session, runner, package and i18n tests.
- **e2e:** the e2e page gains a shadow-root date element and a delayed autocomplete. The scenarios assert both through real tool calls.
- **Live:** one GitHub releases `read_page`, one demoqa practice-form fill, and one NVIDIA text-tool-call reproduction.
- **Showcase:** the hard set is rerun after PR A and PR B, and the reports are published beside the first one.

## 7. Rollout

Four PRs (A reliability, B agent tools, C UX, D store build). Each is merged when CI passes and its review threads are resolved. The store ZIP is rebuilt after PR D.
