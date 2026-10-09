// Request bodies for model providers. Page text is cut to fixed lengths, which
// can split an emoji's surrogate pair; JSON.stringify then writes a lone
// "\ud83d" escape, which strict parsers (NVIDIA's, for one) reject outright.
// Every string is made well-formed first, the broken half becoming U+FFFD.

export function requestJson(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'string' ? v.toWellFormed() : v));
}
