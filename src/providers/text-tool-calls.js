// Some models (Nemotron on NVIDIA NIM, seen in the showcase) answer with their
// tool call written as text instead of a native call:
//   <tool_call><function=history><parameter=action>back</parameter></function></tool_call>
// Read as a report, that text ended the task. These calls are run only when the
// whole answer is call blocks and every call fits a tool the session offered.

const BLOCK = /<tool_call>([\s\S]*?)<\/tool_call>/g;

/**
 * The calls in `text`, or null when it is not purely call blocks, names a tool
 * that was not offered, breaks a tool's schema, or repeats a call.
 */
export function parseTextToolCalls(text, tools) {
  const trimmed = String(text ?? '').trim();
  const blocks = [...trimmed.matchAll(BLOCK)].map((m) => m[1].trim());
  if (!blocks.length || trimmed.replace(BLOCK, '').trim()) return null; // prose or a code fence around it
  const byName = new Map(tools.map((t) => [t.name, t]));
  const seen = new Set();
  const calls = [];
  for (const body of blocks) {
    const call = parseBlock(body);
    const tool = call && byName.get(call.name);
    if (!tool) return null;
    const args = typedArgs(call.args, tool.parameters ?? {});
    if (!args) return null;
    const key = `${call.name} ${JSON.stringify(args)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    calls.push({ name: call.name, args, fromJson: call.fromJson });
  }
  return calls.map(({ name, args }) => ({ name, args }));
}

/** Hermes/Qwen XML (values are text) or JSON ({"name", "arguments"}). */
function parseBlock(body) {
  const xml = body.match(/^<function=([\w.-]+)>([\s\S]*)<\/function>$/);
  if (xml) {
    const args = {};
    const rest = xml[2].replace(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g, (_, key, value) => {
      args[key] = { text: value.replace(/^\n|\n$/g, '') };
      return '';
    });
    return rest.trim() ? null : { name: xml[1], args, fromJson: false };
  }
  try {
    const parsed = JSON.parse(body);
    const raw = parsed.arguments ?? parsed.parameters ?? {};
    const values = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (typeof parsed.name !== 'string' || !values || typeof values !== 'object' || Array.isArray(values)) return null;
    return { name: parsed.name, args: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }])), fromJson: true };
  } catch {
    return null;
  }
}

/**
 * Arguments typed by the tool's JSON schema: text stays text ("123" for a string
 * parameter stays "123"); integers, numbers and booleans are converted; unknown,
 * missing-required, enum-breaking or mistyped values reject the call.
 */
function typedArgs(raw, schema) {
  const props = schema.properties ?? {};
  const out = {};
  for (const [key, entry] of Object.entries(raw)) {
    const spec = props[key];
    if (!spec) return null;
    const value = convert(entry, spec);
    if (value === undefined) return null;
    if (spec.enum && !spec.enum.includes(value)) return null;
    out[key] = value;
  }
  for (const key of schema.required ?? []) if (!(key in out)) return null;
  return out;
}

function convert({ text, value }, spec) {
  const type = spec.type;
  if (text === undefined) {
    // JSON values must already have the right type.
    if (type === 'integer') return Number.isInteger(value) ? value : undefined;
    if (type === 'number') return typeof value === 'number' ? value : undefined;
    if (!type || typeof value === type || (type === 'array' && Array.isArray(value)) || (type === 'object' && value && typeof value === 'object')) return value;
    return undefined;
  }
  if (!type || type === 'string') return text;
  if (type === 'integer') return /^-?\d+$/.test(text.trim()) ? Number(text) : undefined;
  if (type === 'number') return text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : undefined;
  if (type === 'boolean') return text.trim() === 'true' ? true : text.trim() === 'false' ? false : undefined;
  try {
    const parsed = JSON.parse(text);
    return (type === 'array' ? Array.isArray(parsed) : parsed && typeof parsed === 'object') ? parsed : undefined;
  } catch {
    return undefined;
  }
}
