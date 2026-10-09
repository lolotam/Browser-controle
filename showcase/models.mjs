// Main models the showcase compares, all free tiers. Each names the provider
// preset from src/lib/settings.js and the .env.showcase variable holding its key.
// Run `npm run showcase:preflight` first: it checks every candidate with a real
// tool-capable request and reports its latency, so dead or slow models are dropped.

export const MODELS = [
  { id: 'or-nemotron-lightning', label: 'OpenRouter · Nemotron 3.5 Lightning (free)', preset: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free', env: 'OPENROUTER_API_KEY' },
  { id: 'or-laguna-xs', label: 'OpenRouter · Poolside Laguna XS 2.1 (free)', preset: 'openrouter', model: 'poolside/laguna-xs-2.1:free', env: 'OPENROUTER_API_KEY' },
  { id: 'or-apodex-mini', label: 'OpenRouter · Apodex 1.1 Mini (free)', preset: 'openrouter', model: 'apodex/apodex-1.1-mini:free', env: 'OPENROUTER_API_KEY' },
  { id: 'or-nemotron-ultra', label: 'OpenRouter · Nemotron 3 Ultra 550B (free)', preset: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', env: 'OPENROUTER_API_KEY' },
  { id: 'gemini-flash', label: 'Google Gemini · 3.6 Flash, low thinking (free tier)', preset: 'gemini', model: 'gemini-3.6-flash', effort: 'low', env: 'GEMINI_API_KEY' },
  { id: 'nvidia-nemotron-super', label: 'NVIDIA NIM · Nemotron 3 Super 120B', preset: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', env: 'NVIDIA_API_KEY' },
];
// Dropped on 2026-10-09: OpenCode Zen free models (HTTP 403, usable only inside the
// OpenCode app), Gemma 4 on OpenRouter (HTTP 429, upstream rate-limited), Inkling
// small (403, agentic harnesses only), Gemini 3.8 Flash (503, overloaded).

// Jev, the fast layer, is the same in every run so it does not skew the comparison.
export const JEV = { provider: 'vercel', baseUrl: 'https://ai-gateway.vercel.sh/v1', model: 'typesafe-ai/jev', env: 'AI_GATEWAY_API_KEY' };

export const ENV_FILE = '.env.showcase';
export const ENV_TEMPLATE = `# Keys for the showcase (npm run showcase). This file is git-ignored; keys never leave your computer
# except to their own provider. Leave a line empty to skip that provider's models.
OPENROUTER_API_KEY=
OPENCODE_API_KEY=
GEMINI_API_KEY=
NVIDIA_API_KEY=
# Vercel AI Gateway key, for Jev (the fast layer in every run)
AI_GATEWAY_API_KEY=
`;
