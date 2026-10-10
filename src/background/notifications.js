// Optional desktop notifications: one when a task finishes, needs an answer, or
// stops with an error, shown only while the user looks at something else. The
// permission is optional and asked for from the settings switch. The text is
// generic: no task, page, report or provider text leaves the side panel. A click
// brings back the session's tab; the route survives a worker restart because it
// lives in chrome.storage.session.

import { MESSAGES } from '../sidepanel/messages.js';
import { resolveLanguage } from '../sidepanel/i18n.js';

// One storage key per notification: two sessions notifying at once never overwrite
// each other's route, as a shared map read and written back could.
const routeKey = (id) => `notificationRoute:${id}`;
const TEXT = { finished: 'notify.finished', ask: 'notify.ask', failed: 'notify.failed' };

/** Whether the user has the switch on and Chrome still grants the permission. */
export async function notificationsAllowed(settings) {
  if (!settings?.notify || !chrome.notifications) return false;
  return chrome.permissions.contains({ permissions: ['notifications'] }).catch(() => false);
}

/**
 * Notifies about one task transition (`finished`, `ask` or `failed`) of a session
 * whose tab is `tabId`. Never throws: a notification must not affect the task.
 * Returns the notification id, or null when none was shown.
 */
export async function notifyTransition({ kind, sessionId, tabId, settings }) {
  try {
    if (!TEXT[kind] || !(await notificationsAllowed(settings))) return null;
    if (await userIsLookingAt(tabId)) return null;
    const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;
    const language = resolveLanguage(settings.uiLanguage, chrome.i18n?.getUILanguage?.());
    const messages = MESSAGES[language] ?? MESSAGES.en;
    const id = `postora:${crypto.randomUUID()}`;
    await saveRoute(id, { sessionId, tabId: tab?.id ?? null, windowId: tab?.windowId ?? null });
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'Postora',
      message: messages[TEXT[kind]] ?? MESSAGES.en[TEXT[kind]],
    });
    return id;
  } catch {
    return null;
  }
}

/**
 * A click: focus the session's tab and its window, tie the tab to the session and
 * try to open the side panel there. Returns what happened, for tests.
 */
export async function openFromNotification(id, { sessionExists, bindTab }) {
  const route = await takeRoute(id);
  chrome.notifications?.clear(id)?.catch?.(() => {});
  if (!route || !(await sessionExists(route.sessionId).catch(() => false))) return 'gone';
  const tab = Number.isInteger(route.tabId) ? await chrome.tabs.get(route.tabId).catch(() => null) : null;
  if (!tab) return 'tab-closed';
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await bindTab(tab.id, route.sessionId);
  try {
    // Chrome may refuse outside a user gesture; the tab is in front either way.
    await chrome.sidePanel.open({ tabId: tab.id });
    return 'opened';
  } catch {
    return 'focused';
  }
}

/** A notification dismissed without a click. */
export async function forgetNotification(id) {
  await takeRoute(id);
}

async function userIsLookingAt(tabId) {
  if (!Number.isInteger(tabId)) return false;
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (!win?.focused) return false;
  const [active] = await chrome.tabs.query({ active: true, windowId: win.id });
  return active?.id === tabId;
}

async function saveRoute(id, route) {
  await chrome.storage.session.set({ [routeKey(id)]: route });
}

async function takeRoute(id) {
  const key = routeKey(id);
  const route = (await chrome.storage.session.get(key))[key] ?? null;
  if (route) await chrome.storage.session.remove(key);
  return route;
}
