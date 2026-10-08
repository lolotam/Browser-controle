# Multiple sessions — design

Date: 2026-10-08 · Status: proposed

## Goal

ChatGPT-style sessions in the side panel: create, rename, switch, search and
delete sessions; history kept on the computer; several sessions running tasks
at the same time without interfering with each other.

## Today

One conversation for the whole browser, held in service-worker memory and lost
on restart. Every panel (one per window) mirrors it. One task at a time. The
agent drives one tab and brings it to the front when switching.

## Decisions (from the user)

- Sessions run tasks **in parallel**.
- A session **acts only on tabs in its own group**; it can list all tabs.
- **One panel per window** with a session list in the header.
- History is **kept until the user deletes it**.

## Data

`chrome.storage.local` (the extension already has `unlimitedStorage`):

- `sessions`: index `[{ id, title, createdAt, updatedAt, groupId }]`.
- `session:<id>`: `{ transcript, providerHistory, tabIds }`. The transcript is
  the panel's event list (no screenshots). `providerHistory` is the serialized
  `ChatgptSession.input` or `CompatibleSession.messages` with images removed,
  so a reopened session continues where it stopped.
- `panelSession:<windowId>`: which session each window shows.

Titles default to the first 6 words of the first task and can be renamed.

## Runtime

The single `state` object becomes a `SessionRunner` per open session, each with
its own model session (with the fallback wrapper from the fallback design), abort
controller, pending question and `BrowserController`. Runners are created on
demand and dropped when idle; storage stays the source of truth. A runner saves
after every event that changes the transcript (debounced 500 ms). Ports carry
`{ windowId, sessionId }`; events go only to panels showing that session.

## Tabs and groups

- The first task in a session moves the active tab into a new Chrome tab group
  titled with the session name and a color of its own. `open_tab` opens new tabs
  inside the group.
- `list_tabs` shows every tab and marks which belong to the session. Acting on a
  tab outside the group first moves it into the group (`switch_tab` does this),
  and the panel says so. A tab already in another running session's group is
  refused with a message naming that session.
- Agents never bring tabs to the front; input and screenshots go through the
  DevTools protocol, which works on background tabs. Background pages can run
  slower because Chrome throttles their timers.
- Closing a group's last tab keeps the session; the next task starts a new group.
- Needs the `tabGroups` permission (to title and color groups).

## Interface

- Header: session title (click → list with search, rename ✎, delete 🗑, the
  active and running sessions marked), a + button for a new session.
- Switching session in one window does not stop tasks running in others.
- Deleting a running session stops its task first, after a confirmation.

## Testing

- Unit: storage round-trip of a session including provider history without
  images; title from the first task; the tab-ownership rules (own tab, free tab
  moved in, another running session's tab refused).
- E2E: two sessions run tasks in parallel on two local pages, each in its own
  group, both reports correct; reopening the panel restores both sessions; a
  rename persists.

## Out of scope

Sync between computers, export/import of sessions, sharing a session.
