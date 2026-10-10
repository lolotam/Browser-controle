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

  // Machine-readable dates (<time>, GitHub's <relative-time>, any [datetime]). Their
  // shown text ("2 days ago") can live in a shadow root that innerText skips, so
  // each is listed with the nearest heading or link that says what it dates.
  const pageDates = () => {
    const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z| ?UTC|[+-]\d{2}:?\d{2})?)?$/;
    const squash = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const lines = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[datetime]')) {
      if (lines.length >= 40) break;
      const iso = (el.getAttribute('datetime') || '').trim();
      const parsed = ISO.test(iso) ? new Date(iso.replace(' ', 'T').replace(/ ?UTC$/, 'Z')) : null; // GitHub also writes '2026-09-04 22:12:00 UTC'
      // A real calendar date: V8 rolls 2026-02-30 over to March instead of failing.
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== new Date(`${iso.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10)) continue;
      const shown = squash(el.innerText || (el.shadowRoot && el.shadowRoot.textContent), 40);
      // The heading just above a date names what it dates (a release, a post); headings
      // after it belong to the body. Only what is on screen: a hidden menu's heading names nothing.
      const near = (selector, levels) => {
        for (let a = el.parentElement, i = 0; a && i < levels; a = a.parentElement, i += 1) {
          let closest = '';
          for (const named of a.querySelectorAll(selector)) {
            if (named === el || named.contains(el) || !(named.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
            if (!named.getClientRects().length || getComputedStyle(named).visibility === 'hidden') continue;
            closest = squash(named.innerText, 80) || closest;
          }
          if (closest) return closest;
        }
        return '';
      };
      const label = near('h1, h2, h3, h4', 8) || near('a[href]', 4);
      const line = `${label || '(no label)'} · ${shown || '—'} — ${iso}`;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
    return lines;
  };
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
    dates: pageDates(),
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
    // Tokens may carry section-/billing/shipping prefixes, e.g. "section-pay billing cc-number".
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      tag: el.tagName.toLowerCase(),
      label,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      secret: el.type === 'password' || autocomplete.some((token) => /^(cc-|one-time-code$|current-password$|new-password$)/.test(token)),
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

/** Returns a slice of the page's visible text for reading long pages, and the page's dates. */
export function pageText(start, length) {
  // Machine-readable dates (<time>, GitHub's <relative-time>, any [datetime]). Their
  // shown text ("2 days ago") can live in a shadow root that innerText skips, so
  // each is listed with the nearest heading or link that says what it dates.
  const pageDates = () => {
    const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z| ?UTC|[+-]\d{2}:?\d{2})?)?$/;
    const squash = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const lines = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[datetime]')) {
      if (lines.length >= 40) break;
      const iso = (el.getAttribute('datetime') || '').trim();
      const parsed = ISO.test(iso) ? new Date(iso.replace(' ', 'T').replace(/ ?UTC$/, 'Z')) : null; // GitHub also writes '2026-09-04 22:12:00 UTC'
      // A real calendar date: V8 rolls 2026-02-30 over to March instead of failing.
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== new Date(`${iso.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10)) continue;
      const shown = squash(el.innerText || (el.shadowRoot && el.shadowRoot.textContent), 40);
      // The heading just above a date names what it dates (a release, a post); headings
      // after it belong to the body. Only what is on screen: a hidden menu's heading names nothing.
      const near = (selector, levels) => {
        for (let a = el.parentElement, i = 0; a && i < levels; a = a.parentElement, i += 1) {
          let closest = '';
          for (const named of a.querySelectorAll(selector)) {
            if (named === el || named.contains(el) || !(named.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
            if (!named.getClientRects().length || getComputedStyle(named).visibility === 'hidden') continue;
            closest = squash(named.innerText, 80) || closest;
          }
          if (closest) return closest;
        }
        return '';
      };
      const label = near('h1, h2, h3, h4', 8) || near('a[href]', 4);
      const line = `${label || '(no label)'} · ${shown || '—'} — ${iso}`;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
    return lines;
  };
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n');
  return { total: text.length, start, text: text.slice(start, start + length), dates: pageDates() };
}

/**
 * Resolves once the page's content has not changed for `quietMs`, or after `maxMs`
 * at most. Until the first change it waits `firstQuietMs`, long enough for a click
 * that starts a request (search, autocomplete) to show its result. Attribute
 * changes (animations, hover styles) do not count, so busy pages end at the cap.
 */
export function domSettled(quietMs, maxMs, firstQuietMs = quietMs) {
  return new Promise((resolve) => {
    let timer = setTimeout(done, firstQuietMs);
    const cap = setTimeout(done, maxMs);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    function done() {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve(true);
    }
  });
}

/** Identifies the current document: a new one (reload, form post) gets a new value even at the same URL. */
export function documentIdOf() {
  return String(performance.timeOrigin);
}

export function pageReadyState() {
  return { readyState: document.readyState, url: location.href };
}

export function devicePixelRatioOf() {
  return window.devicePixelRatio || 1;
}
