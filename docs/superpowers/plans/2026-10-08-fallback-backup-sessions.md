# Fallback, Backup and Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A backup provider for the main model and the fast layer with failure notices, settings backup/restore with a fixed extension ID, and parallel ChatGPT-style sessions with one tab group per session.

**Architecture:** A `FallbackSession` wraps the provider session behind the interface `runAgent` already uses and keeps a provider-neutral log; the same log restores a reopened session through a handoff message. The service worker's single `state` becomes one `SessionRunner` per session, each with its own `BrowserController` bound to a Chrome tab group. Sessions persist in `chrome.storage.local`.

**Tech Stack:** Chrome MV3 extension, plain ES modules, `node --test`, Playwright e2e.

**Specs:** `docs/superpowers/specs/2026-10-08-provider-fallback-design.md`, `docs/superpowers/specs/2026-10-08-multi-session-design.md`

## Global Constraints

- One PR (`feat/fast-layer-gateways`); every task ends with `npm test` green and a commit.
- No new dependencies. Comments explain why. Panel strings go through `t()` in both `ar` and `en`.
- A user stop (`AbortError`) never triggers a fallback.
- Notices: red `error` for the main model, amber `warning` for the fast layer; persistent per session; dismissible; at most 3 visible.
- Fast-layer backups are decision providers only: `typesafe`, `vercel`.
- Sessions act only on tabs in their own group; agents never bring a tab to the front.
- Sessions stay until deleted. New permission: `tabGroups`.
- Restoring a session uses the neutral log + handoff (replaces the spec's `providerHistory`).

---

### Task 1: Failure reasons

**Files:** Create `src/lib/failure.js`; Test `test/failure.test.js`

**Interfaces:** Produces `describeFailure(error) → { reason: string, detail: string }`.

- [ ] Test: HTTP 429 text → reason mentions usage limit; 401/403 → key rejected or no access; `TypeError('Failed to fetch')` → no connection; `HTTP 503` → provider server error; other → first 120 chars; `detail` is the full message.
- [ ] Implement by matching `HTTP (\d{3})` in the message (provider errors already embed it; ChatGPT's 429 text says "usage limit").
- [ ] `npm test`, commit `feat(fallback): plain-language failure reasons`.

### Task 2: FallbackSession

**Files:** Create `src/agent/fallback-session.js`; Test `test/fallback-session.test.js`

**Interfaces:**
- Produces `class FallbackSession({ primary, createBackup = null, labels: { primary, backup }, notify, log = emptyLog() })` with `addUserMessage(text, images)`, `addToolResult(callId, output, images)`, `next(options)`, getters `switched`, `log`.
- Produces `emptyLog()`, `handoffMessage(log, reason)`.
- Log shape: `{ task: string|null, notes: string[], steps: [{ name, args, result }], last: { text, images } | null }`.

Behaviour:
- First `addUserMessage` sets `log.task`; later ones go to `notes` (fast-layer hand-overs, answers).
- `next()` records returned `toolCalls`; `addToolResult` pairs the result's first line with its call and stores `last` (text ≤ 3,000 chars + images).
- `next()` throws a non-abort error and a backup exists and not yet switched → `notify({ level: 'error', title, reason, detail })`, `backup = createBackup()`, `backup.addUserMessage(handoffMessage(log, reason), last.images)`, return `backup.next(options)`.
- Backup throws → `notify` a both-failed error and throw `Error('Primary failed: … Backup failed: …')`.
- Abort errors rethrow untouched.

- [ ] Tests (fake sessions with scripted `next`): switch on failure with one notice and the handoff holding task, steps and last observation; abort does not switch; no backup → original error; both fail → combined error and notice; calls after the switch go to the backup.
- [ ] Implement, `npm test`, commit `feat(fallback): session wrapper that hands a task to a backup provider`.

### Task 3: Fast-layer backup ask

**Files:** Modify `src/fast/clients.js`; Test `test/gateway-decision.test.js`

**Interfaces:** Produces `askWithBackup({ primary: fastSettings, backup: fastSettings|null, notify }) → ask(request)`; `request` = `{ state, questions, signal }`.

- [ ] Tests: primary ok → backup unused; primary throws → same request answered by backup and one amber notice; after 3 primary failures the primary is no longer called; no backup → error propagates.
- [ ] Implement; `createFastLayer` keeps calling `ask({ ...config, ...request, signal })`, and the composed ask ignores the spread config and uses its own.
- [ ] `npm test`, commit.

### Task 4: Settings for fallbacks

**Files:** Modify `src/lib/settings.js`; Test `test/providers.test.js`

- [ ] `DEFAULT_SETTINGS.fallback = { enabled: false, provider: 'compatible', chatgpt: { model: '', effort: '' }, compatible: { preset: 'openrouter', baseUrl: COMPATIBLE_PRESETS.openrouter.baseUrl, apiKey: '', model: '', effort: '' } }`.
- [ ] `DEFAULT_SETTINGS.fast.fallback = { enabled: false, provider: 'typesafe', baseUrl: FAST_PRESETS.typesafe.baseUrl, apiKey: '', model: 'jev-latest', decision: true }`.
- [ ] `mergeSettings` merges both nested levels. Test: stored settings without them get the defaults; a stored partial `fast.fallback` keeps its fields.
- [ ] Commit.

### Task 5: Provider form component and backup card

**Files:** Create `src/sidepanel/provider-form.js`; Modify `src/sidepanel/index.html`, `panel.js`, `panel.css`, `messages.js`

**Interfaces:** `createProviderForm(root, { request, getPresets, t, onChange })` → `{ fill(providerSettings: { provider, chatgpt, compatible }), read(), loadModels(showErrors), rerender() }`. Fields are found by `data-field` inside `root`; the main card keeps its existing ids so the e2e selectors stay valid.

- [ ] Move model loading, picker, search and effort logic for the main card into the component (`renderPicker`, `filterModels`, `bindSearch` stay shared helpers in it).
- [ ] Add a "Backup provider" card (checkbox + the same fields) and a "Backup decision provider" block in the fast card (provider select limited to TypeSafe/Vercel, key, model picker).
- [ ] `readForm()` writes `fallback` and `fast.fallback`.
- [ ] QA screenshot of both cards; `npm test`, e2e; commit.

### Task 6: Notices

**Files:** Modify `src/background/service-worker.js` (temporary, superseded by Task 10), `src/sidepanel/*`

- [ ] Event `{ type: 'notice', id, level, title, reason, detail }` goes into the transcript; port message `dismiss-notice { id }` appends `{ type: 'notice-dismissed', id }`.
- [ ] Panel renders a stack under the header (newest first, 3 visible, `title` attribute = detail, × dismisses); red/amber tokens for both themes.
- [ ] Wire `FallbackSession` (main) and `askWithBackup` (fast) in `startRun`; backup session built from `settings.fallback`.
- [ ] E2E scenario `fallback`: the primary mock answers 429 on its second turn, the backup mock finishes, the report is correct and `.notice.error` is visible. Commit.

### Task 7: Backup / restore and fixed ID

**Files:** Create `src/lib/backup.js`, `test/backup.test.js`; Modify `manifest.json`, panel files, `docs/SETUP.md`

**Interfaces:** `exportBackup() → { format: 'browser-agent-backup', version: 1, exportedAt, settings, chatgptAuth }`; `importBackup(json)` validates the format and version, writes `settings` (through `mergeSettings`) and `chatgptAuth`.

- [ ] Tests: round trip; wrong format rejected with a clear error; missing auth allowed.
- [ ] Panel: "Back up settings" downloads `browser-agent-backup-YYYY-MM-DD.json` (Blob + `a[download]`), "Restore" reads a file; warning that the file holds keys.
- [ ] Generate an RSA-2048 key with Node `crypto`, put the base64 SPKI in `manifest.json` `key`, discard the private key, record the resulting ID in `docs/SETUP.md` with the "use Reload, not Remove" note. Commit.

### Task 8: Session store

**Files:** Create `src/sessions/store.js`, `test/session-store.test.js`

**Interfaces:** `createStoredSession(title?) → meta`, `listSessions() → meta[]` (newest first), `loadSession(id) → { meta, transcript, log, groupId }`, `saveSession(id, { transcript, log, groupId })`, `renameSession(id, title)`, `deleteSession(id)`, `titleFromTask(text)` (first 6 words), `getWindowSession(windowId)`, `setWindowSession(windowId, id)`. Keys: `sessions`, `session:<id>`, `panelSession:<windowId>`.

- [ ] Tests for each, with the in-memory `chrome.storage.local` stub. Commit.

### Task 9: Tab ownership

**Files:** Modify `src/browser/controller.js`, `src/agent/tools.js`, `manifest.json`; Test `test/tab-ownership.test.js`

**Interfaces:** `new BrowserController({ sessionId, title, color, isTakenByOther(tabId) → string|null })`; `claimTab(tabId)` groups the tab (creating and titling the group on first use) or throws `Tab N is used by session "X"`; `startOn(tab)`; `useTab` stops activating tabs.

- [ ] `open_tab` creates `active: false` inside the group; `switch_tab` claims; `list_tabs` marks `[yours]`.
- [ ] Tests with a stubbed `chrome.tabs`/`chrome.tabGroups`. Add `"tabGroups"` permission. Commit.

### Task 10: SessionRunner and routing

**Files:** Create `src/background/session-runner.js`; Modify `src/background/service-worker.js`

- [ ] `SessionRunner(id)` owns transcript, log, FallbackSession, abort, pending question, controller and its ports; `start(text)`, `stop()`, `answer(text)`, `dismissNotice(id)`, `attach(port)`; persists through the store (debounced 500 ms); restores with a fresh session + `handoffMessage(log, 'continuing an earlier session')`.
- [ ] Service worker: `runners: Map`, port name `panel:<sessionId>`, requests `sessions-list`, `session-create`, `session-rename`, `session-delete` (stops a running one first), `window-session-get/set`. `isTakenByOther` checks other running runners' groups.
- [ ] Keep-alive while any runner runs. Commit.

### Task 11: Session UI

**Files:** Modify panel files, `messages.js`

- [ ] Header: session title button (opens a list with search, rename ✎, delete 🗑, running dot), + creates a session; the panel binds to its window's session and reconnects its port on switch.
- [ ] QA screenshots AR/EN, light/dark. Commit.

### Task 12: E2E and docs

- [ ] E2E `parallel`: two sessions in one window context run tasks on two pages at once; both reports correct; each page tab is in a different group; reopening the panel lists both sessions.
- [ ] README / README.ar / SETUP updated (docs-guard). Guards (clean-code, test-guard). Push; CI green.
