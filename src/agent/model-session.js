// Builds the model side of a session from settings: the main provider wrapped
// in FallbackSession (with the configured backup) and the fast layer's ask.

import { FallbackSession, emptyLog, handoffMessage } from './fallback-session.js';
import { buildSystemPrompt } from './prompt.js';
import { toolDefinitions } from './tools.js';
import { askWithBackup, fastClientFor } from '../fast/clients.js';
import { COMPATIBLE_PRESETS } from '../lib/settings.js';
import { ChatgptSession } from '../providers/chatgpt.js';
import { CompatibleSession } from '../providers/openai-compatible.js';

/** A provider session for one model slot: the main one or settings.fallback. */
function createProviderSession(slot, settings) {
  const tools = toolDefinitions(settings);
  const systemPrompt = buildSystemPrompt(settings);
  if (slot.provider === 'chatgpt') {
    if (!slot.chatgpt.model) throw new Error('Choose a ChatGPT model in settings first.');
    return new ChatgptSession({ ...slot.chatgpt, systemPrompt, tools });
  }
  const c = slot.compatible;
  if (!c.model) throw new Error('Choose a model in settings first.');
  const preset = COMPATIBLE_PRESETS[c.preset] ?? COMPATIBLE_PRESETS.custom;
  return new CompatibleSession({ ...c, thinkingStyle: preset.thinkingStyle, systemPrompt, tools });
}

function slotLabel(slot) {
  if (slot.provider === 'chatgpt') return `ChatGPT · ${slot.chatgpt.model}`;
  return `${COMPATIBLE_PRESETS[slot.compatible.preset]?.label ?? 'API'} · ${slot.compatible.model}`;
}

/**
 * A fresh FallbackSession. With `seed`, the conversation so far (a neutral log)
 * reaches the new primary as a handoff message: after a task the backup
 * finished, after a settings change, or when a saved session is reopened.
 */
export function createModelSession(settings, { notify, seed = null }) {
  const primary = createProviderSession(settings, settings);
  if (seed?.log?.task) primary.addUserMessage(handoffMessage(seed.log, seed.reason));
  const backupEnabled = settings.fallback.enabled;
  return new FallbackSession({
    primary,
    createBackup: backupEnabled ? () => createProviderSession(settings.fallback, settings) : null,
    labels: { primary: slotLabel(settings), backup: backupEnabled ? slotLabel(settings.fallback) : '' },
    notify,
    log: seed?.log ?? emptyLog(),
  });
}

/** Settings that require a new model session when they change. */
export function modelSessionKey(settings) {
  return JSON.stringify([settings.provider, settings.chatgpt, settings.compatible, settings.fallback, settings.vision, settings.allowJavascript]);
}

export function createFastAsk(fast, notify) {
  return fast.fallback.enabled && fast.fallback.apiKey
    ? askWithBackup({ primary: fast, backup: fast.fallback, notify })
    : fastClientFor(fast);
}
