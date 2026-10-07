// User settings persisted in chrome.storage.local.

export const COMPATIBLE_PRESETS = {
  xai: { label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', model: 'grok-4', thinkingStyle: 'reasoning_effort' },
  'zai-coding': { label: 'Z.ai GLM Coding Plan', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-4.6', thinkingStyle: 'glm' },
  zai: { label: 'Z.ai GLM (API)', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6', thinkingStyle: 'glm' },
  openai: { label: 'OpenAI API key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', thinkingStyle: 'reasoning_effort' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5', thinkingStyle: 'reasoning_effort' },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: 'http://localhost:11434/v1', model: '', thinkingStyle: 'reasoning_effort' },
};

export const DEFAULT_SETTINGS = {
  provider: 'chatgpt',
  chatgpt: { model: '', effort: '', clientVersion: '0.99.0' },
  compatible: { preset: 'xai', baseUrl: COMPATIBLE_PRESETS.xai.baseUrl, apiKey: '', model: COMPATIBLE_PRESETS.xai.model, effort: '' },
  fast: { enabled: false, mode: 'auto', baseUrl: 'https://api.typesafe.ai', apiKey: '', model: 'jev-latest', minProb: 0.6, riskyMax: 0.3 },
  maxSteps: 40,
  vision: true,
  allowJavascript: false,
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
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    chatgpt: { ...DEFAULT_SETTINGS.chatgpt, ...(stored.chatgpt ?? {}) },
    compatible: { ...DEFAULT_SETTINGS.compatible, ...(stored.compatible ?? {}) },
    fast: { ...DEFAULT_SETTINGS.fast, ...(stored.fast ?? {}) },
  };
}
