// Each browser tab shows its own session in the side panel. A tab belongs to the
// session whose tab group holds it, else to the session last shown on it; a tab
// with neither gets a fresh blank session. Bindings live in chrome.storage.session,
// so they end with the browser, like the tabs they name.

const KEY = 'tabSessions';

// The panel can ask for a tab while a tab switch or a delete changes bindings;
// operations run one at a time so a tab never gets two blank sessions.
let queue = Promise.resolve();
function serial(operation) {
  const run = queue.then(operation);
  queue = run.catch(() => {});
  return run;
}

async function readBindings() {
  const { [KEY]: bindings = {} } = await chrome.storage.session.get(KEY);
  return bindings;
}

async function updateBindings(change) {
  await chrome.storage.session.set({ [KEY]: change(await readBindings()) });
}

/**
 * `ownerOf(tab)` names the session whose group holds the tab, `exists(id)` tells
 * whether a session is still saved, `createBlank(excluded)` returns a blank session
 * id that is not one of `excluded` (sessions bound to other tabs).
 */
export function sessionForTab(tab, { ownerOf, exists, createBlank }) {
  return serial(async () => {
    const owner = await ownerOf(tab);
    if (owner) return owner;
    const bindings = await readBindings();
    const bound = bindings[tab.id];
    if (bound && (await exists(bound))) return bound;
    const id = await createBlank(new Set(Object.values(bindings)));
    await updateBindings((b) => ({ ...b, [tab.id]: id }));
    return id;
  });
}

/** The user picked this session (from the list, or a new one) while looking at the tab. */
export function bindTab(tabId, sessionId) {
  return serial(() => updateBindings((b) => ({ ...b, [tabId]: sessionId })));
}

export function unbindTab(tabId) {
  return serial(() => updateBindings(({ [tabId]: _closed, ...rest }) => rest));
}

export function unbindSession(sessionId) {
  return serial(() => updateBindings((b) => Object.fromEntries(Object.entries(b).filter(([, id]) => id !== sessionId))));
}
