// Provider, model and reasoning-effort fields for one model slot. The main model
// and its backup use the same form; fields are found by data-field inside root.

import { t } from './i18n.js';
import { bindSearch, escapeAttr, pickModel, renderPicker } from './model-picker.js';

const TRANSLATED_EFFORTS = { '': 'effort.default', off: 'effort.off', on: 'effort.on' };
const FALLBACK_EFFORTS = { chatgpt: ['low', 'medium', 'high', 'xhigh'], reasoning_effort: ['off', 'low', 'medium', 'high'], glm: ['on', 'off'] };

const slotOf = (s) => (s.provider === 'chatgpt' ? s.chatgpt : s.compatible);

export function createProviderForm(root, { request, getPresets }) {
  const f = (name) => root.querySelector(`[data-field="${name}"]`);
  // Last filled values; also remembers the other provider's model while switching.
  let saved = null;
  let models = [];
  let latestLoad = 0;

  function fill(s) {
    saved = { provider: s.provider, chatgpt: { ...s.chatgpt }, compatible: { ...s.compatible } };
    f('preset').innerHTML = Object.entries(getPresets()).map(([id, p]) => `<option value="${id}">${escapeAttr(p.label)}</option>`).join('');
    f('provider').value = s.provider;
    f('preset').value = s.compatible.preset;
    f('baseUrl').value = s.compatible.baseUrl;
    f('apiKey').value = s.compatible.apiKey;
    f('modelInput').value = slotOf(s).model;
    models = [];
    syncSections();
    renderModels();
    renderEfforts(slotOf(s).effort);
  }

  function read() {
    const next = structuredClone(saved);
    next.provider = f('provider').value;
    Object.assign(next.compatible, compatibleFields());
    const slot = slotOf(next);
    slot.model = f('modelInput').value.trim();
    slot.effort = f('effort').value;
    return next;
  }

  const compatibleFields = () => ({ preset: f('preset').value, baseUrl: f('baseUrl').value.trim(), apiKey: f('apiKey').value.trim() });

  function syncSections() {
    const chatgpt = f('provider').value === 'chatgpt';
    f('chatgptSection').hidden = !chatgpt;
    f('compatibleSection').hidden = chatgpt;
  }

  function renderModels() {
    renderPicker(f('modelSelect'), f('modelInput'), models, f('modelSearch'));
  }

  function renderEfforts(selected) {
    const model = models.find((m) => m.id === f('modelInput').value.trim());
    const style = f('provider').value === 'chatgpt' ? 'chatgpt' : getPresets()[f('preset').value]?.thinkingStyle ?? 'reasoning_effort';
    const levels = model?.efforts?.length ? model.efforts : FALLBACK_EFFORTS[style];
    const options = ['', ...levels];
    f('effort').innerHTML = options.map((e) => `<option value="${escapeAttr(e)}">${escapeAttr(TRANSLATED_EFFORTS[e] ? t(TRANSLATED_EFFORTS[e]) : e)}${model?.defaultEffort === e ? t('effort.defaultMark') : ''}</option>`).join('');
    f('effort').value = options.includes(selected) ? selected : '';
  }

  async function loadModels(showErrors = false) {
    const draft = read();
    if (draft.provider === 'chatgpt' && !(await request('auth-status')).connected) return;
    const load = ++latestLoad;
    f('modelInfo').textContent = t('model.loading');
    try {
      const list = await request('list-models', { settings: draft });
      if (load !== latestLoad) return;
      models = list;
      if (!f('modelInput').value && models[0]) f('modelInput').value = models[0].id;
      renderModels();
      renderEfforts(f('effort').value || (models.find((m) => m.id === f('modelInput').value)?.defaultEffort ?? ''));
      f('modelInfo').textContent = '';
    } catch (err) {
      if (load === latestLoad) f('modelInfo').textContent = showErrors ? err.message : t('model.fallback');
    }
  }

  // Switching provider keeps each provider's own model instead of copying one into the other.
  f('provider').addEventListener('change', () => {
    const leaving = slotOf(saved);
    leaving.model = f('modelInput').value.trim();
    leaving.effort = f('effort').value;
    Object.assign(saved.compatible, compatibleFields());
    saved.provider = f('provider').value;
    f('modelInput').value = slotOf(saved).model;
    models = [];
    syncSections();
    renderModels();
    renderEfforts(slotOf(saved).effort);
    loadModels();
  });
  f('preset').addEventListener('change', () => {
    const preset = getPresets()[f('preset').value];
    f('baseUrl').value = preset.baseUrl;
    f('modelInput').value = preset.model;
    models = [];
    renderModels();
    renderEfforts('');
    loadModels();
  });
  f('modelSelect').addEventListener('change', () => {
    pickModel(f('modelSelect'), f('modelInput'));
    renderEfforts(models.find((m) => m.id === f('modelSelect').value)?.defaultEffort ?? '');
  });
  f('modelInput').addEventListener('input', () => renderEfforts(f('effort').value));
  f('refresh').addEventListener('click', () => loadModels(true));
  bindSearch(f('modelSearch'), f('modelSelect'), () => models, renderModels);

  return {
    fill,
    read,
    loadModels,
    model: () => f('modelInput').value.trim(),
    rerender() {
      renderModels();
      renderEfforts(f('effort').value);
    },
  };
}
