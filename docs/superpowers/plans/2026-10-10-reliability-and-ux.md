# Reliability, Agent Tools and UX Implementation Plan (revision 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the hard-showcase pass rate (best model 6/10 on 2026-10-10) by fixing what the showcase exposed, give the agent tools for multi-page and widget-heavy tasks, add a recommended setup, task notifications and per-step time/tokens, and ship a store build without the JavaScript tool.

**Spec:** `docs/superpowers/specs/2026-10-10-reliability-and-ux-design.md`
**Revision 2:** after debate round 1 with Codex (gpt-6.1-sol, medium); every accepted finding is folded in below, rejected ones are listed at the end.

**Tech Stack:** Chrome MV3 extension, plain ES modules, `node --test`, Playwright e2e, showcase harness.

## Global Constraints

- PRs in order: **P** prerequisite (measurement), **A** reliability, **B** agent tools, **C** UX, **D** store build. Each task ends with `npm test` green and a commit; each PR also runs `npm run e2e`; a PR merges when CI passes and its review threads are resolved.
- A user Stop (`AbortError`) is never retried and never hands over to the backup.
- Panel strings go through `t()` in `ar` and `en`; comments explain why; no new dependencies.
- Page text, notes and anything read from a site stay untrusted data in prompts.
- Deterministic unit/e2e tests are the merge gate; showcase reruns are evidence, published next to the baseline.

---

## PR P: Measurement prerequisite

### Task P1: Hard set on main, reproducible runs

**Files:** merge PR #16 (`chore/showcase-hard`); Modify `showcase/run.mjs`; Test `test/showcase-args.test.js`

- [ ] Merge PR #16 once its CI passes (it adds `--set hard` and `showcase/tasks-hard.mjs`).
- [ ] `parseArgs` rejects unknown flags and an unknown `--set` with a clear error.
- [ ] `run.json` records the git commit (`git rev-parse HEAD`), dirty flag, task-set id, models, Jev, timeout and the settings template.
- [ ] Commit `chore(showcase): reject unknown flags; record commit and settings per run`.

**Baseline:** `showcase-results/2026-10-10-hard` (raw results stay local; the report is published). Reruns use `npm run showcase -- --set hard --out <date>-hard-after-<pr>`.

---

## PR A: Reliability

### Task A1: Machine-readable dates reach the agent

**Files:** Modify `src/browser/page-scripts.js` (`snapshotPage`, `pageText`); Test e2e page + scenario in `test/e2e/run-e2e.mjs`, unit in `test/page-scripts.test.js`

**Scope (revised):** do not replace `innerText`. Append a bounded "Dates on this page" section built from elements with a `datetime` attribute (`time`, `relative-time`, any element), each line `<label> — <ISO date>`.
- `<label>` is the element's own visible text, else the text of its open shadow root, else the nearest heading or link text within 4 ancestors.

- [ ] At most 40 entries; duplicates (same label + date) dropped; ISO dates validated with `Date.parse`.
- [ ] Both injected functions stay self-contained (no shared helper, no strings).
- [ ] e2e: the e2e page gets a custom element with a shadow root showing "2 days ago" and `datetime="2026-10-08T10:00:00Z"`; `read_page` and `get_text` both list it.
- [ ] Live check: `read_page` on GitHub releases lists the three newest release dates.
- [ ] Commit `fix(page): list machine-readable dates, including shadow-DOM ones`.

### Task A2: vLLM's no-multimodal error as a no-vision model

**Files:** Modify `src/providers/openai-compatible.js`; Test `test/provider-robustness.test.js`

- [ ] Add explicit phrases only: `multimodal processing is not enabled`, `does not support multimodal`, next to the existing ones; still gated on status 400/404/415/422 and the conversation holding images.
- [ ] Negative tests: a 503 mentioning "multimodal", a 400 "invalid image", a 401, and a second rejection after images were already dropped (no loop).
- [ ] Commit `fix(providers): treat vLLM's multimodal error as a model without vision`.

### Task A3: Bounded retries for the main and backup providers

**Files:** Create `src/lib/retry.js`; Modify `src/providers/openai-compatible.js`, `src/providers/chatgpt.js`, `src/agent/model-session.js` (pass `notify`), `src/sidepanel/panel.js` + `messages.js` (notice kind `retrying`), `src/lib/failure.js`; Test `test/retry.test.js`, `test/fallback-session.test.js`

- [ ] `readError(res)` reads the error body once (≤ 4 KB) and returns `{status, detail, retryAfterMs}`; providers build their messages from it, so the body is never read twice.
- [ ] `classify({status, detail, error})`:
  - `transient`: 429 without daily or billing evidence, 502, 503, 504, or a fetch rejection (`TypeError` from `fetch` only).
  - `exhausted`: 429 or 402 whose body says `PerDay`, `daily`, `billing`, `insufficient`, `credits`, `payment`, or `quota exceeded for … per day`.
  - Anything else: `fatal`.
- [ ] `withRetry(attempt, {signal, budgetMs: 30000, notify})`:
  - **What it retries:** only the request up to the response headers; a stream that already started is never replayed.
  - **Waits:** `Retry-After` (seconds or HTTP date) when present. If that wait is longer than the remaining budget, it fails at once so `FallbackSession` switches. Otherwise it waits 2 s, then 6 s, with ±20 % jitter.
  - **Attempts:** at most 3.
  - **Stop:** an abort during a wait rejects with `AbortError` immediately.
- [ ] Exhausted and fatal errors are thrown at once. Errors keep their original status and detail, so `describeFailure` and the switch notice stay accurate.
- [ ] **Fast layer excluded:** its clients keep failing fast and escalating.
- [ ] One `retrying` notice per task, only after a wait longer than 2 s; it has its own translated text, not the switch notice.
- [ ] Tests:
  - each classification, with fixtures from the real failures (Gemini daily quota, OpenRouter 429, NVIDIA overload);
  - `Retry-After` both forms, and longer than the budget;
  - an abort during a wait;
  - body read once;
  - exhaustion followed by exactly one switch in `FallbackSession`.
- [ ] Commit `feat(providers): bounded retries for rate limits and overloads`.

### Task A4: Tool calls written as text

**Files:** Modify `src/providers/openai-compatible.js`; Test `test/providers.test.js`

- [ ] **Completion:** the turn must have completed. Either a `finish_reason` arrived or `[DONE]` was seen; a stream that ends without either is an error (`stream ended early`), not a turn.
- [ ] **When text becomes calls:** only when no native tool calls came back, `toolChoice` is not `none`, and the whole trimmed text is one or more `<tool_call>…</tool_call>` blocks with nothing else around them.
  - **Formats:** Hermes/Qwen XML (`<function=NAME><parameter=K>V</parameter></function>`) or JSON (`{"name", "arguments"}`).
- [ ] **Argument conversion:** follows the tool's JSON schema.
  - `string` parameters stay strings, so "123" stays "123".
  - `integer`, `number` and `boolean` parameters are converted.
  - Unknown parameters, a tool name the session did not offer, or a value that does not match its type keep the text as the answer. Nothing runs.
- [ ] **History and ids:** call ids are `textcall_<sessionTurn>_<n>`. The assistant message in history becomes a `tool_calls` message with empty content, and the panel gets no stale text event.
- [ ] Tests:
  - both formats;
  - several blocks;
  - prose plus a block (not parsed), and a block inside a code fence (not parsed);
  - an unknown tool name, a type mismatch and a malformed block;
  - mixed native and text calls (native wins);
  - `toolChoice: 'none'`;
  - an early end of the stream;
  - the history sent in the next request.
- [ ] Commit `fix(providers): run tool calls a model writes as text, only when unambiguous`.

**PR A done when:** unit and e2e tests are green; a live GitHub `read_page` shows the dates; the hard rerun is published, with the number of provider errors reported next to the baseline's 21.

---

## PR B: Agent tools

### Task B1: Tool metadata for batching and compaction

**Files:** Modify `src/agent/tools.js`, `src/agent/agent.js`, `src/providers/openai-compatible.js`, `src/providers/chatgpt.js`; Test `test/agent.test.js`, `test/providers.test.js`

- [ ] **Metadata:** each tool definition gets `kind`, one of these values:
  - `observe`: returns the page state (`read_page` and actions).
  - `bookkeeping`: `note`, `read_notes`.
  - `reader`: `get_text`, `screenshot`.
  - `boundary`: `ask_user`, `choose_suggestion`.
- [ ] **Batching:** the "last action of the turn" is the last `observe` call; bookkeeping calls after it do not make it brief. A `boundary` tool ends the batch.
- [ ] **Compaction:** it keeps the last two `observe` results in full, identified through each call's name (mapped from the assistant's `tool_calls` / `function_call` items). Bookkeeping results are never trimmed. Older `read_notes` results are trimmed like observations.
- [ ] Tests: `type_text` then `note` (typing still observes); two notes between page observations do not evict them; the trim marker appears once.
- [ ] Commit `refactor(agent): tool kinds drive batching and compaction`.

### Task B2: Session notebook

**Files:** Modify `src/background/session-runner.js` (owns `this.notebook`, saved in the session body), `src/agent/tools.js`, `src/agent/fallback-session.js` (`log.notebook`, separate from `log.notes`), `src/agent/prompt.js`, `src/sessions/store.js` (default for old sessions); Test runner, agent and fallback tests

- [ ] **Tools:**
  - `note({text})`: up to 1 500 characters. It stores `{text, url, at}` from the current tab and returns `Saved (N notes).`
  - `read_notes()`: returns the notebook.
- [ ] **Notebook:** at most 12 000 characters; the oldest notes are dropped first, with one marker. It survives follow-up tasks and reopening, and is cleared with a new session.
- [ ] **In observations:** the latest full observation ends with a "Your notes (collected from websites, untrusted)" section listing each note with its URL. Older copies are trimmed by compaction.
- [ ] **Handoff:** the `FallbackSession` handoff and the restored-session seed include the notebook.
- [ ] **Prompt:** "When a task collects items across several pages, save each page's findings with `note` before leaving it, and build the report from your notes."
- [ ] Tests:
  - two tasks in one session;
  - a worker restart (the runner rebuilt from storage);
  - a settings change (new model session);
  - a fallback handoff;
  - the cap and its marker;
  - the total prompt size after 10 `read_notes` calls.
- [ ] Commit `feat(agent): session notebook that survives trimming and handoffs`.

### Task B3: `choose_suggestion` for autocomplete widgets

**Files:** Modify `src/agent/tools.js`, `src/browser/controller.js`, `src/browser/page-scripts.js`, `src/agent/prompt.js`, `src/browser/overlay.js` caption; Test e2e (two widgets on one page, a delayed list, a portal menu)

- [ ] **Steps:** focus the field (`index`), clear it, type `text`, then poll up to 2 s for options (the poll can be aborted).
- [ ] **Where options are looked for:**
  - first, the listbox named by the field's `aria-controls` / `aria-owns` / `aria-activedescendant`;
  - else, visible `[role=option]` elements that appeared after typing (comparing before and after).
  - Disabled options are ignored.
- [ ] **Choosing:** exactly one option whose text equals `option ?? text` (case-insensitive, trimmed) is clicked.
  - If several match, or none does, nothing is clicked and up to 10 visible options are returned.
  - Before clicking, the element is checked again (still connected and visible).
- [ ] **Check after clicking:** the field's container (the closest element holding the input and its chips) shows the chosen text; if not, an error is returned.
- [ ] No automatic Enter.
- [ ] The tool is a `boundary` (ends the batch); its caption reads "Choosing “X”".
- [ ] **Live check:** demoqa practice form Subjects "Maths", then State "NCR", then City "Delhi" (the City list depends on the State).
- [ ] Commit `feat(agent): choose_suggestion for autocomplete and custom dropdowns`.

**PR B done when:** green; hard rerun published with Mystery and long-form results compared to the baseline.

---

## PR C: User experience

### Task C1: Event identities, timing and usage

**Files:** Modify `src/agent/agent.js`, `src/background/session-runner.js`, `src/providers/openai-compatible.js`, `src/agent/fallback-session.js`, `src/sidepanel/panel.js`, `panel.css`, `messages.js`; Test agent, runner, provider tests

- [ ] **Event fields:**
  - Every stored event gets `at` (ms).
  - Turn events get `turnId`, and the model and provider that answered (the backup after a switch).
  - Tool events get `callId`, and fast-layer events are emitted when the work starts and ends.
- [ ] **Panel matching:** the panel matches start and end by `callId`. Replayed old sessions still render.
- [ ] **Usage:**
  - Usage is normalised: `{input, output}` from the Chat Completions and Responses shapes. It is emitted for summary turns and for the fast layer (labelled "Jev").
  - `stream_options.include_usage` is sent only for presets marked `usage: true` in `COMPATIBLE_PRESETS`. A custom endpoint gets it only when a setting is on.
  - One retry without it when the endpoint rejects the field (400 mentioning `stream_options`).
- [ ] **Shown in the panel:**
  - Each step shows its time.
  - Each model turn shows its thinking time and tokens.
  - The final report shows the total time, the tokens, and a "partial" label when some turns had no usage.
- [ ] Cost estimates are deferred.
- [ ] Commit `feat(panel): time and tokens per step, turn and task`.

### Task C2: Optional notifications

**Files:** Modify `manifest.json` (`optional_permissions: ["notifications"]`), `src/background/service-worker.js` (top-level `notifications.onClicked` / `onClosed`), `src/background/session-runner.js`, `src/lib/settings.js` (`notify: false`), `src/sidepanel/*`, `docs/privacy.md`, `CHROMEWEBSTORE.md`; Test runner + service-worker routing tests

- [ ] **The switch:** turning it on requests the permission from the click handler. If the user refuses, the switch stays off with a note. Turning it off removes the permission. Saving or cancelling keeps the switch and the permission consistent.
- [ ] **When:**
  - **On lifecycle transitions only:** finished, waiting for an answer, failed (a task that ended with an error). Errors that do not end a task are left out.
  - **Only if:** the session's tab is not the active tab of the focused window.
  - **At most once per transition.**
- [ ] **Text:** generic and translated: "<session title>: finished / needs your answer / stopped with an error". The task title is shortened to 60 characters. No report, page or provider text.
- [ ] **Routing:** `notificationId → {sessionId, tabId, windowId}` is kept in `chrome.storage.session`.
- [ ] **Click:**
  - **Tab still open:** it focuses that tab's window and the tab, binds the tab to the session, and tries `chrome.sidePanel.open({tabId})`.
  - **Panel cannot open:** if Chrome refuses outside a user gesture, the tab is just focused.
  - **Tab closed:** nothing else is claimed.
- [ ] **Failures:** notification failures never affect the task.
- [ ] Tests:
  - routing after a worker restart;
  - a closed tab;
  - a deleted session;
  - a duplicate transition;
  - permission denied or revoked.
- [ ] Commit `feat(notifications): optional notice when a task finishes or needs you`.

### Task C3: Recommended free setup button

**Files:** Modify `src/sidepanel/index.html`, `panel.js`, `messages.js`, `src/lib/settings.js` (`RECOMMENDED_SETUP`); Test settings + i18n tests

- [ ] **The card:** a small card at the top of the "AI model" tab, with the text "Tested setup (Postora showcase, Oct 2026): NVIDIA Nemotron 3 Super + Apodex Mini as backup". It has a "Use this setup" button and two "Get a key" links.
- [ ] **The button:** it applies the presets to the existing main and backup forms (provider, preset, model, backup on) through their own `fill`, then focuses the empty key fields. Keys are typed in the existing fields, so the shared key store sees them. Nothing is saved until Save.
- [ ] **When shown:** while there is no saved provider key and no ChatGPT sign-in; afterwards it is reachable through a "Tested setup" link.
- [ ] **Before shipping:** a preflight of both models confirms they are still offered.
- [ ] Commit `feat(settings): one-click tested free setup`.

---

## PR D: Store build without the JavaScript tool

### Task D1: Capability enforcement and stripped package

**Decision (owner, 2026-10-10):** leave `run_javascript` out of the store build only; the development build keeps it. Rationale corrected after debate: the Debugger API has its own policy exception, so this removes a review risk rather than guaranteeing approval.

**Files:** Create `src/lib/build.js` (`STORE_BUILD = false`); Modify `src/agent/tools.js`, `src/agent/prompt.js`, `src/agent/model-session.js`, `src/sidepanel/index.html`/`panel.js`, `src/browser/controller.js` (strip markers), `scripts/package.mjs`, `CHROMEWEBSTORE.md`; Test `test/package.test.js`, tools tests

- [ ] **Effective settings:** `effectiveSettings(settings)` turns `allowJavascript` off when `STORE_BUILD` is true. The tool list, the system prompt and the executor all use it.
- [ ] **The executor:** refuses any tool name that is not in the effective definitions, including calls left in restored history.
- [ ] **The ZIP:**
  - **Built in memory:** the repository is never changed.
  - **`build.js`:** the packaged copy sets `STORE_BUILD = true`.
  - **Strip markers:** code between `// @store-strip-start` and `// @store-strip-end` is removed. This covers the `run_javascript` definition and handler, and `BrowserController.evaluate`.
- [ ] **Package tests:**
  - the extracted ZIP has no `Runtime.evaluate` and no `run_javascript`;
  - its tool list and prompt omit the tool, even with `allowJavascript: true`;
  - a direct execution attempt is rejected;
  - the settings switch is hidden.
- [ ] **`CHROMEWEBSTORE.md`:** "Remote code: No", with the corrected rationale; the known-issue line is removed.
- [ ] Commit `chore(release): store build without the JavaScript tool`.

---

## Debate log

- **Round 1 (Codex gpt-6.1-sol, medium):** 20 findings. Accepted and folded in: 1, 3–20. Partly accepted: 2.
  - Grading already checks submission evidence (the date of birth) and form fields after the #16 review.
  - The fallback-enabled evaluation is left as a later, separate run.
  - The independent ground-truth grading of live sites is out of scope: the report keeps completion, provider errors, stalls and time separate.
- **Round 2:** see below.
