# Reliability, Agent Tools and UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the hard-showcase pass rate (best model 6/10 on 2026-10-10) by fixing what the showcase exposed, give the agent tools for multi-page and widget-heavy tasks, and give users a recommended setup, task-done notifications and per-step cost, then settle the last Chrome Web Store decision.

**Evidence:** `showcase-results/2026-10-09` (basic set) and `showcase-results/2026-10-10-hard` (hard set), reports at https://claude.ai/artifact/LGgPMd6kmvuqvz4zh8BRpY and https://claude.ai/artifact/Xv1qimAgjmDf2GPST9M3a6.

| Failure seen in the hard run | Runs lost | Fixed by |
|---|---|---|
| Provider 429 / 503 (Gemini daily quota, Laguna, NVIDIA overload) | 21 | Task 4 |
| `<relative-time>` dates in shadow DOM invisible (GitHub) | 6/6 GitHub runs | Task 2 |
| Model writes a tool call as text (`<tool_call><function=…>`), taken as the report | 2 | Task 1 |
| Earlier pages trimmed to 400 chars, data forgotten (multi-page Mystery) | 6/6 Mystery runs | Task 5 |
| Autocomplete widgets (demoqa Subjects, State, City) | 5/6 form runs | Task 6 |
| "multimodal processing is not enabled" not recognised as no-vision | 1 | Task 3 |

**Architecture:** Fixes stay in the layer that owns the behaviour: text tool calls and retries in the providers (`src/providers/*`, `src/lib/sse.js`), page reading in `src/browser/page-scripts.js`, new tools in `src/agent/tools.js` + `src/browser/controller.js`, UX in `src/sidepanel/*`. No new dependencies.

**Tech Stack:** Chrome MV3 extension, plain ES modules, `node --test`, Playwright e2e, showcase harness (`npm run showcase -- --set hard`).

## Global Constraints

- Four PRs, in order: **A** reliability (Tasks 1–4), **B** agent tools (Tasks 5–6), **C** user experience (Tasks 7–9), **D** store build (Task 10). Each task ends with `npm test` green and a commit; each PR also runs `npm run e2e`.
- A user Stop (`AbortError`) is never retried and never hands over to the backup.
- Panel strings go through `t()` with both `ar` and `en`; comments explain why.
- Every tool the model can call keeps its result short unless it is a page observation.
- Measure after PR A and after PR B: `npm run showcase -- --set hard --out <date>-hard-after-<pr>` with the same six models and Jev, and publish the report next to the first one.

---

## PR A: Reliability

### Task 1: Tool calls written as text become real tool calls

**Files:** Modify `src/providers/openai-compatible.js`; Test `test/providers.test.js`

**Why:** Nemotron 3 Super on NVIDIA sometimes answers with `<tool_call>\n<function=history>\n<parameter=action>\nback\n</parameter>\n</function>\n</tool_call>` in the text channel. `runAgent` sees no tool calls and ends the task with that text as the report.

- [ ] Test: a turn whose text is the Hermes/Qwen XML form (`<tool_call><function=NAME><parameter=KEY>VALUE</parameter>…</function></tool_call>`), and the JSON form (`<tool_call>{"name": …, "arguments": {…}}</tool_call>`), yields `toolCalls` with parsed args (numbers and booleans coerced through JSON.parse where valid) and an empty text; several blocks give several calls; text outside the blocks is kept.
- [ ] Test: ordinary text mentioning `<tool_call>` inside a code fence is left alone.
- [ ] Implement `parseTextToolCalls(text, toolNames)` used only when the stream produced no native tool calls; accept only names in the session's tool list; give each call an id `text_call_<n>` and record the assistant message with `tool_calls` so the provider sees a consistent history.
- [ ] `npm test`, commit `fix(providers): turn tool calls written as text into real tool calls`.

### Task 2: Shadow-DOM text and machine dates reach the agent

**Files:** Modify `src/browser/page-scripts.js` (`snapshotPage`, `pageText`, `elementAction` 'text'); Test `test/page-scripts.test.js`, e2e page in `test/e2e/run-e2e.mjs`

**Why:** GitHub renders release dates inside `<relative-time>`, whose text lives in a shadow root; `document.body.innerText` skips shadow roots, so no model ever saw a release date.

- [ ] Test (unit, with a fake DOM): `visibleText(root)` concatenates light-DOM text and the text of open shadow roots in document order.
- [ ] Test: `<time datetime>` and `<relative-time datetime>` contribute `"<shown text> (<ISO date>)"`.
- [ ] Implement one walker shared by `snapshotPage` and `pageText` (they are serialized separately, so the helper is defined inside each function or passed as a string); keep the existing character caps.
- [ ] e2e: add a `<relative-time>`-style custom element with a shadow root to the e2e page and assert the date appears in `read_page`.
- [ ] Live check: `read_page` on `https://github.com/microsoft/playwright/releases` shows three release dates.
- [ ] `npm test`, `npm run e2e`, commit `fix(page): read open shadow roots and machine-readable dates`.

### Task 3: Recognise every no-vision error

**Files:** Modify `src/providers/openai-compatible.js`; Test `test/provider-robustness.test.js`

- [ ] Test: a 400 body `"Received multimodal data but multimodal processing is not enabled"` (NVIDIA / vLLM) triggers the same retry without images as OpenRouter's 404.
- [ ] Widen the pattern to `/image input|support(?:s)? images?|vision|multimodal/i`, still gated on the conversation actually holding images (no retry loop otherwise).
- [ ] `npm test`, commit `fix(providers): treat vLLM's multimodal error as a model without vision`.

### Task 4: Retry rate limits and overloads before failing

**Files:** Create `src/lib/retry.js`; Modify `src/providers/openai-compatible.js`, `src/providers/chatgpt.js`, `src/fast/jev-client.js`, `src/fast/gateway-decision-client.js`, `src/fast/chat-judge-client.js`, `src/background/session-runner.js` (notice); Test `test/retry.test.js`

**Why:** 21 of 60 hard runs ended on a single 429/503 from free tiers. A short wait usually clears it.

- [ ] Test: `withRetry(send, {signal, attempts: 3})` retries on HTTP 429, 502, 503, 504 and network `TypeError`; waits `Retry-After` (seconds or HTTP date, capped at 30 s) or 2 s → 6 s with jitter; returns the first success; rethrows the last failure.
- [ ] Test: no retry on 400/401/403/404 or on a quota message that will not clear today (`/quota|insufficient|exceeded your current quota|billing/i` with 429 → fail at once so the backup takes over).
- [ ] Test: an abort during the wait rejects with `AbortError` immediately.
- [ ] Retry only before the response stream starts (status known, body not read); a stream that breaks mid-way is not replayed.
- [ ] Emit a quiet panel notice once per task ("Provider busy, retrying…") through the existing `notify`; no notice for a retry that succeeds within the first wait.
- [ ] `npm test`, `npm run e2e`, commit `feat(providers): retry rate limits and overloads with backoff`.

**PR A done when:** unit + e2e green; hard showcase rerun shows GitHub releases passing on at least 3 of the 4 models that were not quota-blocked, and provider errors below 10 of 60.

---

## PR B: Agent tools

### Task 5: A notes tool that survives page trimming

**Files:** Modify `src/agent/tools.js`, `src/agent/prompt.js`, `src/agent/fallback-session.js`, `src/providers/chatgpt.js` + `openai-compatible.js` (compaction); Test `test/agent.test.js`, `test/fallback-session.test.js`, `test/providers.test.js`

**Why:** Only the last 2 page observations are kept in full (`KEEP_FULL_OBSERVATIONS = 2`, older ones cut to 400 chars), so a model collecting from several pages loses page 1 by page 3.

- [ ] Tool `note`: `{text: string (≤ 1500 chars)}` → appends to the task's notebook and returns `Saved (N notes, M chars).`; tool `read_notes`: returns the whole notebook.
- [ ] The notebook (≤ 12 000 chars, oldest notes dropped first with a marker) is added to every full page observation as `Your notes so far:` so it never depends on old messages.
- [ ] Compaction never trims `note` / `read_notes` results.
- [ ] `FallbackSession` handoff and the saved session log carry the notebook, so a backup or a reopened session keeps it.
- [ ] Prompt: "When a task collects items across several pages, save what you found on each page with `note` before leaving it; build the final report from your notes."
- [ ] Tests for each point above; `npm test`, commit `feat(agent): notes that survive page trimming`.

### Task 6: Autocomplete and custom dropdown widget tool

**Files:** Modify `src/agent/tools.js`, `src/browser/controller.js`, `src/browser/page-scripts.js`, `src/agent/prompt.js`; Test `test/tool-batch.test.js`, e2e page

- [ ] Tool `choose_suggestion`: `{index, text, option?}` → click the field, clear it, type `text`, wait for suggestions (settle + up to 2 s for a visible `[role=option]`, `[role=listbox] *`, `li` inside an element whose `aria-expanded=true`, or common widget classes such as `*__option`), then click the suggestion whose text equals `option ?? text` (case-insensitive; else the first that contains it); returns the chosen text or the list of suggestions seen when none matched.
- [ ] Falls back to pressing ArrowDown + Enter when suggestions are keyboard-only.
- [ ] The live cursor captions it ("Choosing “Maths”").
- [ ] Prompt: use `choose_suggestion` for fields that show suggestions as you type (cities, subjects, tags, search boxes); `select_option` stays for native `<select>`.
- [ ] e2e: a fake autocomplete on the e2e page (input + delayed listbox) is filled through the tool.
- [ ] Live check: demoqa practice form Subjects "Maths", State "NCR", City "Delhi" all set.
- [ ] `npm test`, `npm run e2e`, commit `feat(agent): choose_suggestion for autocomplete and custom dropdowns`.

**PR B done when:** hard showcase rerun passes Mystery on at least 2 models and the practice form on at least 3.

---

## PR C: User experience

### Task 7: Recommended free setup

**Files:** Modify `src/sidepanel/index.html`, `src/sidepanel/panel.js`, `src/sidepanel/messages.js`, `src/lib/settings.js`; Test `test/i18n.test.js`, settings unit test

- [ ] A "Recommended free setup" card at the top of the AI model tab: main NVIDIA NIM `nvidia/nemotron-3-super-120b-a12b`, backup OpenRouter `apodex/apodex-1.1-mini:free`, each with a "Get a key" link (build.nvidia.com, openrouter.ai/keys) and the key field; one "Use this setup" button fills both frames and turns the backup on, without saving until Save.
- [ ] Shown while no provider key is set; hidden afterwards, with a small "Show recommended setup" link to bring it back.
- [ ] The card cites its source: "Best pass rate and speed in Postora's showcase, October 2026".
- [ ] Strings in `ar` and `en`; commit `feat(settings): recommended free setup`.

**Note:** this is a suggestion, not a hard default: both providers need the user's own key, and the ChatGPT sign-in stays available.

### Task 8: Optional notification when a task ends or asks

**Files:** Modify `manifest.json` (`optional_permissions: ["notifications"]`), `src/background/session-runner.js`, `src/sidepanel/*`, `icons/` (reuse `icon-128.png`); Test runner unit test; update `CHROMEWEBSTORE.md` and `docs/privacy.md`

- [ ] A settings switch "Notify me when a task finishes or needs me"; turning it on calls `chrome.permissions.request({permissions: ['notifications']})` from the click (user gesture), turning it off removes it.
- [ ] On `final`, `error` or `ask`: notify only when the session's tab is not the active tab of the focused window; clicking the notification focuses that tab and opens the panel.
- [ ] Text: session title + first line of the report or the question; no page content beyond that.
- [ ] Permission justification and privacy policy updated (optional, local only).
- [ ] Commit `feat(notifications): optional notice when a task ends or asks`.

### Task 9: Time and tokens per step and per task

**Files:** Modify `src/background/session-runner.js` (timestamp every stored event), `src/agent/agent.js` (usage per turn), `src/providers/openai-compatible.js` (`stream_options: {include_usage: true}` for presets known to accept it), `src/sidepanel/panel.js`, `src/sidepanel/panel.css`, `src/sidepanel/messages.js`; Test runner + provider tests

- [ ] Every stored event gets `at` (ms); the panel shows each step's duration (from its `tool-start` to `tool-end`) and each model turn's thinking time.
- [ ] Usage per turn shown as "1.2k in · 300 out"; task total under the final report with total time.
- [ ] `include_usage` requested for OpenAI, OpenRouter, NVIDIA, DeepSeek, Gemini, OpenCode; omitted for `custom` unless the first response shows usage support.
- [ ] Optional cost: for OpenRouter, read per-token prices from `/models` (already fetched for the picker) and show an estimate; other providers show tokens only.
- [ ] Commit `feat(panel): time and tokens per step and per task`.

---

## PR D: Chrome Web Store build

### Task 10: Store build without the JavaScript tool (decision needed)

**Decision:** keep `run_javascript` in the store build (answer "Yes" to remote code and justify it, risking rejection) **or** leave it out of the store build only (recommended: the store's remote-code rule covers code the model writes at run time, and the tool is off by default anyway).

**Files (if left out):** Modify `scripts/package.mjs`, `src/agent/tools.js`, `src/sidepanel/index.html`, `CHROMEWEBSTORE.md`; Test `test/package.test.js`

- [ ] `package.mjs` writes `src/lib/build.js` with `export const STORE_BUILD = true` into the ZIP (the repository copy says `false`).
- [ ] `toolDefinitions` drops `run_javascript` and the settings page hides its switch when `STORE_BUILD`.
- [ ] Test: the packaged `build.js` says `true`, the repository one `false`; the packaged tool list has no `run_javascript`.
- [ ] `CHROMEWEBSTORE.md`: "Are you using remote code? No" with the reason; remove the matching known-issue line.
- [ ] `npm run package`, commit `chore(release): store build leaves out the JavaScript tool`.

---

## Order and effort

| PR | Tasks | Effort (approx.) | Measure |
|---|---|---|---|
| A | 1–4 | 3–4 h | hard showcase rerun |
| B | 5–6 | 4–5 h | hard showcase rerun |
| C | 7–9 | 4–5 h | panel screenshots, e2e |
| D | 10 | 1 h, after the decision | `npm run package` |

## Risks

- **Text tool-call parsing** could mistake an example in a report for a call: guarded by tool-name whitelist, code-fence exclusion, and only when no native calls came back.
- **Retries** add waiting on a truly down provider: capped at 3 attempts and 30 s per wait, then the backup takes over.
- **Shadow-DOM walking** on very large pages: walk with the same character caps; skip closed roots.
- **`include_usage`** may be rejected by an unknown endpoint: only sent to known presets.
