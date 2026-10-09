// Settings, API keys and the ChatGPT sign-in as one JSON document. Chrome deletes
// an extension's storage when it is removed, so this document is what survives a
// remove-and-reinstall: as a file the user keeps, or in their Google Drive
// (drive-backup.js).

import { mergeSettings } from './settings.js';

const FORMAT = 'browser-agent-backup';
const VERSION = 1;

export async function exportBackup() {
  const { settings, chatgptAuth } = await chrome.storage.local.get(['settings', 'chatgptAuth']);
  return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), settings: mergeSettings(settings), chatgptAuth: chatgptAuth ?? null };
}

/** Restores a file from exportBackup; returns the restored settings. */
export async function importBackup(data) {
  if (data?.format !== FORMAT) throw new Error('This file is not a Postora Browser Agent backup.');
  if (!(data.version <= VERSION)) throw new Error(`This backup was made by a newer version of Postora Browser Agent (format ${data.version}).`);
  const values = { settings: mergeSettings(data.settings ?? {}) };
  if (data.chatgptAuth) values.chatgptAuth = data.chatgptAuth;
  await chrome.storage.local.set(values);
  return values.settings;
}
