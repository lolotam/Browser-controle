// Main models the showcase compares, all free tiers. Each names the provider
// preset from src/lib/settings.js and the .env.showcase variable holding its key.
// Run `npm run showcase:preflight` first: it checks every candidate with a real
// tool-capable request and reports its latency, so dead or slow models are dropped.

export const MODELS = [
  { id: 'or-nemotron-lightning', label: 'OpenRouter · Nemotron 3.5 Lightning (free)', preset: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free', env: 'OPENROUTER_API_KEY' },
  { id: 'or-gemma4-31b', label: 'OpenRouter · Gemma 4 31B (free)', preset: 'openrouter', model: 'google/gemma-4-31b-it:free', env: 'OPENROUTER_API_KEY' },
  { id: 'zen-mimo-flash', label: 'OpenCode Zen · MiMo v2.6 Flash (free)', preset: 'opencode-zen', model: 'mimo-v2.6-flash-free', env: 'OPENCODE_API_KEY' },
  { id: 'zen-ling-flash', label: 'OpenCode Zen · Ling 3.1 Flash (free)', preset: 'opencode-zen', model: 'ling-3.1-flash-free', env: 'OPENCODE_API_KEY' },
  { id: 'gemini-flash', label: 'Google Gemini · 3.8 Flash (free tier)', preset: 'gemini', model: 'gemini-3.8-flash', env: 'GEMINI_API_KEY' },
  { id: 'nvidia-nemotron-super', label: 'NVIDIA NIM · Nemotron 3 Super 120B', preset: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', env: 'NVIDIA_API_KEY' },
];

// Jev, the fast layer, is the same in every run so it does not skew the comparison.
export const JEV = { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api', model: 'typesafe/jev-1.13', env: 'OPENROUTER_API_KEY' };

export const ENV_FILE = '.env.showcase';
export const ENV_TEMPLATE = `# Keys for the showcase (npm run showcase). This file is git-ignored; keys never leave your computer
# except to their own provider. Leave a line empty to skip that provider's models.
OPENROUTER_API_KEY=
OPENCODE_API_KEY=
GEMINI_API_KEY=
NVIDIA_API_KEY=
`;
