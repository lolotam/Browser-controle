// Functions injected into web pages with chrome.scripting.executeScript.
// Each one is serialized on its own, so it must not reference anything outside
// its own body (no imports, no shared helpers).

/**
 * Indexes the interactive elements near the viewport and returns a compact,
 * model-readable description of the page.
 */
export function snapshotPage(maxElements, maxTextChars) {
  const INTERACTIVE = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
    '[role="menuitem"]', '[role="option"]', '[role="switch"]', '[role="combobox"]',
    '[role="textbox"]', '[role="searchbox"]', '[role="slider"]', '[contenteditable=""]',
    '[contenteditable="true"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const collect = (root, out) => {
    root.querySelectorAll(INTERACTIVE).forEach((el) => out.push(el));
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) collect(el.shadowRoot, out);
    });
    return out;
  };

  const isVisible = (el, rect) => {
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  };

  const clean = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const type = el.getAttribute('type');
    let head = tag;
    if (type && tag === 'input') head += `[type=${type}]`;
    if (role) head += `[role=${role}]`;
    const label = clean(
      el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('alt') ||
      (el.querySelector && el.querySelector('img[alt]')?.getAttribute('alt')),
      80,
    );
    const parts = [head];
    if (label) parts.push(JSON.stringify(label));
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) parts.push(`placeholder=${JSON.stringify(clean(placeholder, 50))}`);
    if (el.name) parts.push(`name=${el.name}`);
    if ('value' in el && typeof el.value === 'string' && el.value && type !== 'password') {
      parts.push(`value=${JSON.stringify(clean(el.value, 60))}`);
    }
    if (type === 'checkbox' || type === 'radio') parts.push(el.checked ? 'checked' : 'unchecked');
    if (tag === 'select') {
      const options = [...el.options].slice(0, 12).map((o) => clean(o.text, 30));
      parts.push(`options=${JSON.stringify(options)}`);
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) parts.push(`href=${clean(href, 80)}`);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    if (el.getAttribute('aria-expanded')) parts.push(`expanded=${el.getAttribute('aria-expanded')}`);
    return parts.join(' ');
  };

  document.querySelectorAll('[data-agent-idx]').forEach((el) => el.removeAttribute('data-agent-idx'));
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const seen = new Set();
  const elements = [];
  let offscreen = 0;

  for (const el of collect(document, [])) {
    if (seen.has(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) continue;
    const near = rect.bottom > -vh * 0.25 && rect.top < vh * 1.5 && rect.right > 0 && rect.left < vw;
    if (!near || elements.length >= maxElements) {
      offscreen += 1;
      continue;
    }
    // Skip wrappers whose only purpose is to contain an already-indexed control.
    const owner = el.parentElement && el.parentElement.closest('a[href],button');
    if (owner && elements.includes(owner)) continue;
    elements.push(el);
  }

  window.__agentElements = elements;
  const lines = elements.map((el, i) => {
    el.setAttribute('data-agent-idx', String(i));
    const rect = el.getBoundingClientRect();
    const where = rect.top >= 0 && rect.bottom <= vh ? '' : ' (below fold)';
    return `[${i}] ${describe(el)}${where}`;
  });

  const text = clean(document.body ? document.body.innerText : '', maxTextChars * 2)
    .slice(0, maxTextChars);
  const scrollHeight = document.documentElement.scrollHeight;
  return {
    url: location.href,
    title: document.title,
    scroll: { y: Math.round(window.scrollY), viewport: vh, height: scrollHeight },
    elements: lines,
    offscreen,
    text,
  };
}

/**
 * Runs one action against an element indexed by the latest snapshot. `quiet`
 * skips the outline flash when the on-page overlay draws its own highlight.
 */
export function elementAction(index, action, value, quiet) {
  const list = window.__agentElements || [];
  let el = list[index];
  if (!el || !el.isConnected) el = document.querySelector(`[data-agent-idx="${index}"]`);
  if (!el) return { error: `Element [${index}] no longer exists. Call read_page to refresh the element list.` };

  const flash = () => {
    if (quiet) return;
    const prev = el.style.outline;
    el.style.outline = '3px solid #7c3aed';
    setTimeout(() => { el.style.outline = prev; }, 700);
  };

  if (action === 'locate') {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    flash();
    const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const autocomplete = el.getAttribute('autocomplete') || '';
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      tag: el.tagName.toLowerCase(),
      label,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      secret: el.type === 'password' || /^(cc-|one-time-code|current-password|new-password)/.test(autocomplete),
    };
  }
  if (action === 'select-all') {
    el.focus();
    if (typeof el.select === 'function') el.select();
    else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return { ok: true };
  }
  if (action === 'select-option') {
    if (el.tagName !== 'SELECT') return { error: `Element [${index}] is not a <select>; click it and pick the option instead.` };
    const wanted = String(value).trim().toLowerCase();
    const option = [...el.options].find((o) => o.value.toLowerCase() === wanted || o.text.trim().toLowerCase() === wanted)
      || [...el.options].find((o) => o.text.trim().toLowerCase().includes(wanted));
    if (!option) return { error: `No option matching "${value}". Options: ${[...el.options].map((o) => o.text.trim()).join(' | ')}` };
    el.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    flash();
    return { ok: true, selected: option.text.trim() };
  }
  if (action === 'text') {
    return { text: (el.innerText || el.value || '').slice(0, value || 4000) };
  }
  return { error: `Unknown element action ${action}` };
}

/** Returns a slice of the page's visible text for reading long pages. */
export function pageText(start, length) {
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n');
  return { total: text.length, start, text: text.slice(start, start + length) };
}

export function pageReadyState() {
  return { readyState: document.readyState, url: location.href };
}

export function devicePixelRatioOf() {
  return window.devicePixelRatio || 1;
}
