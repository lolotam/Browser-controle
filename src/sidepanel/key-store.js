// The settings panel's API keys, one per provider (see lib/keys.js). Every key
// field edits its provider's key, the other fields showing that provider follow
// as the user types, and a field switched to another provider shows that one's key.

import { keyGroup } from '../lib/keys.js';

export function createKeyStore() {
  let values = {};
  const fields = []; // { input, provider: () => provider id }

  function set(provider, value, source) {
    const group = keyGroup(provider);
    if (!group) return;
    if (value) values[group] = value;
    else delete values[group];
    for (const field of fields) {
      if (field.input !== source && keyGroup(field.provider()) === group) field.input.value = value;
    }
  }

  return {
    load(keys = {}) {
      values = { ...keys };
    },
    snapshot: () => ({ ...values }),
    register(input, provider) {
      fields.push({ input, provider });
      input.addEventListener('input', () => set(provider(), input.value.trim(), input));
    },
    /** Shows the provider's key; a provider whose key is not shared shows `own`. */
    show(input, provider, own = '') {
      const group = keyGroup(provider);
      input.value = group ? values[group] ?? '' : own;
    },
  };
}
