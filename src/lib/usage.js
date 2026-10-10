// Token usage in one shape, whatever the provider reports: Chat Completions
// (prompt_tokens / completion_tokens), the Responses API and Jev
// (input_tokens / output_tokens). Null when nothing usable was reported.

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens;
  const output = usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens;
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return { input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0 };
}
