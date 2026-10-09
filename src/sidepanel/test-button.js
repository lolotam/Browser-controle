// A "Test connection" button: neutral while the test runs, green with what came
// back, red with the error. Editing a field inside `scope` clears the result,
// since it described the values that were tested.

import { t } from './i18n.js';

export function bindTestButton({ button, result, scope, run }) {
  const show = (state, text) => {
    button.dataset.state = state;
    result.dataset.state = state;
    result.textContent = text;
  };
  ['input', 'change'].forEach((type) => scope.addEventListener(type, (e) => {
    if (e.target !== button && button.dataset.state) show('', '');
  }));
  button.addEventListener('click', async () => {
    show('', t('fast.testing'));
    try {
      show('ok', await run());
    } catch (err) {
      show('fail', `✗ ${err.message}`);
    }
  });
  return show;
}
