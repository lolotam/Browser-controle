// Model dropdown shared by every model field in the panel: one <select> holding
// the provider's list (with a search box for long lists) and an id input that
// only shows for "Other model" or while no list is available.

import { t } from './i18n.js';

export const CUSTOM_MODEL = '__custom__';
const SEARCH_FROM = 12; // lists longer than this get a search box

export function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** The id input is the saved value, so the model is never shown twice. */
export function renderPicker(select, input, list, search) {
  const current = input.value.trim();
  search.hidden = list.length <= SEARCH_FROM;
  const shown = filterModels(list, search.value, current);
  const option = (m) => `<option value="${escapeAttr(m.id)}">${escapeAttr(m.name ?? m.id)}</option>`;
  const hidden = shown.filter((m) => m.hidden);
  const count = shown.length === list.length ? list.length : `${shown.length} / ${list.length}`;
  select.innerHTML = `<option value="" disabled>${escapeAttr(list.length ? t('model.pickCount', { n: count }) : t('model.pick'))}</option>`
    + shown.filter((m) => !m.hidden).map(option).join('')
    + (hidden.length ? `<optgroup label="${escapeAttr(t('model.hiddenGroup'))}">${hidden.map(option).join('')}</optgroup>` : '')
    + `<option value="${CUSTOM_MODEL}">${escapeAttr(t('model.other'))}</option>`;
  const known = list.some((m) => m.id === current);
  select.value = known ? current : (current || !list.length ? CUSTOM_MODEL : '');
  input.hidden = select.value !== CUSTOM_MODEL;
}

// The selected model stays listed while searching, so filtering never changes the choice.
export function filterModels(list, query, current) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((m) => m.id === current || words.every((w) => `${m.id} ${m.name ?? ''}`.toLowerCase().includes(w)));
}

/** Enter in a search box picks the first model that matches the query. */
export function bindSearch(search, select, getList, render) {
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const [first] = filterModels(getList(), search.value, null);
    if (!first) return;
    select.value = first.id;
    select.dispatchEvent(new Event('change'));
  });
}

export function pickModel(select, input) {
  const custom = select.value === CUSTOM_MODEL;
  if (!custom) input.value = select.value;
  input.hidden = !custom;
  if (custom) input.focus();
}
