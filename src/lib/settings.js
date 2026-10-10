// User settings persisted in chrome.storage.local.

import { shareKeys } from './keys.js';

// Main model and backup providers (both use this list). thinkingStyle 'none' sends
// no reasoning parameter, for APIs whose models reject reasoning_effort; 'gemini'
// offers no Off, because Gemini 3 thinking cannot be turned off.
export const COMPATIBLE_PRESETS = {
  openai: { label: 'OpenAI API key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', thinkingStyle: 'reasoning_effort', usage: true },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', thinkingStyle: 'gemini', usage: true },
  xai: { label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', model: 'grok-4', thinkingStyle: 'reasoning_effort', usage: true },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', thinkingStyle: 'none', usage: true },
  // textToolCalls: its models were seen writing tool calls as text (showcase, 2026-10-10).
  nvidia: { label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3-super-120b-a12b', thinkingStyle: 'none', textToolCalls: true, usage: true },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5', thinkingStyle: 'reasoning_effort', usage: true },
  'opencode-zen': { label: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', model: 'glm-5.3', thinkingStyle: 'none' },
  'opencode-go': { label: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'glm-5.3', thinkingStyle: 'none' },
  'zai-coding': { label: 'Z.ai GLM Coding Plan', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-4.6', thinkingStyle: 'glm' },
  zai: { label: 'Z.ai GLM (API)', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6', thinkingStyle: 'glm' },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: 'http://localhost:11434/v1', model: '', thinkingStyle: 'reasoning_effort' },
};

// OpenCode serves each model family on its own endpoint (docs, Oct 2026): GPT, Grok
// and Muse on /responses, Claude, some Qwen and (on Go) MiniMax on /messages,
// Gemini on Google's path, Jev on /systemone. The agent speaks /chat/completions,
// so those families are left out of the list until those APIs are supported.
const NOT_CHAT_COMPLETIONS = {
  'opencode-zen': /^(gpt-|grok-|muse-spark|claude-|gemini-|jev-|qwen3\.(8-flash|7-|6-|5-))/,
  'opencode-go': /^(gpt-|grok-|muse-spark|claude-|qwen|minimax-)/,
};

export function chatModelsFor(presetId, models) {
  const excluded = NOT_CHAT_COMPLETIONS[presetId];
  return excluded ? models.filter((m) => !excluded.test(m.id)) : models;
}

// Fast-layer providers serve decision models (Jev).
export const FAST_PRESETS = {
  typesafe: { label: 'TypeSafe Jev', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', minProb: 0.6, decision: true },
  vercel: { label: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1', model: 'typesafe-ai/jev', minProb: 0.6, decision: true },
  // Zen serves Jev on TypeSafe's own /v1/systemone API under its base URL.
  'opencode-zen': { label: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen', model: 'jev-1.13', minProb: 0.6, decision: true },
  // OpenRouter serves Jev on /api/v1/systemone too, but leaves it out of /models,
  // so its two ids are listed here.
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', model: 'typesafe/jev-1.13', minProb: 0.6, decision: true, models: ['typesafe/jev-1.13', '~typesafe/jev-latest'] },
};

export const DEFAULT_SETTINGS = {
  provider: 'chatgpt',
  chatgpt: { model: '', effort: '' },
  compatible: { preset: 'xai', baseUrl: COMPATIBLE_PRESETS.xai.baseUrl, apiKey: '', model: COMPATIBLE_PRESETS.xai.model, effort: '' },
  fast: {
    enabled: false, mode: 'auto', provider: 'typesafe', baseUrl: 'https://api.typesafe.ai', apiKey: '', model: 'jev-latest', minProb: 0.6, riskyMax: 0.3,
    fallback: { enabled: false, provider: 'typesafe', baseUrl: 'https://api.typesafe.ai', apiKey: '', model: 'jev-latest', decision: true },
  },
  // Used when the main model's provider fails mid-task (see FallbackSession).
  fallback: {
    enabled: false,
    provider: 'compatible',
    chatgpt: { model: '', effort: '' },
    compatible: { preset: 'openrouter', baseUrl: COMPATIBLE_PRESETS.openrouter.baseUrl, apiKey: '', model: '', effort: '' },
  },
  maxSteps: 40,
  vision: true,
  allowJavascript: false,
  // The agent's cursor, captions and Stop bar drawn on the page it controls.
  showCursor: true,
  notify: false, // desktop notifications; also needs the optional permission
  uiLanguage: 'auto',
  // Off: the agent replies in the language the task is written in.
  replyLanguage: { enabled: false, language: '' },
  // One API key per provider for every slot (see shareKeys).
  keys: {},
};

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

export async function saveSettings(settings) {
  const merged = mergeSettings(settings);
  await chrome.storage.local.set({ settings: merged });
  return merged;
}

export function mergeSettings(stored = {}) {
  return shareKeys({
    ...DEFAULT_SETTINGS,
    ...stored,
    chatgpt: { ...DEFAULT_SETTINGS.chatgpt, ...(stored.chatgpt ?? {}) },
    compatible: { ...DEFAULT_SETTINGS.compatible, ...(stored.compatible ?? {}) },
    fast: {
      ...DEFAULT_SETTINGS.fast,
      ...(stored.fast ?? {}),
      fallback: { ...DEFAULT_SETTINGS.fast.fallback, ...(stored.fast?.fallback ?? {}) },
    },
    replyLanguage: { ...DEFAULT_SETTINGS.replyLanguage, ...(stored.replyLanguage ?? {}) },
    fallback: {
      ...DEFAULT_SETTINGS.fallback,
      ...(stored.fallback ?? {}),
      chatgpt: { ...DEFAULT_SETTINGS.fallback.chatgpt, ...(stored.fallback?.chatgpt ?? {}) },
      compatible: { ...DEFAULT_SETTINGS.fallback.compatible, ...(stored.fallback?.compatible ?? {}) },
    },
    keys: { ...(stored.keys ?? {}) },
  });
}
