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
      // A real calendar date as written: V8 rolls 2026-02-30 over to March instead of
      // failing. The written day is checked, not the instant's UTC day, which differs
      // near midnight for offsets such as 2026-10-10T00:30:00+02:00.
      const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
      const written = new Date(Date.UTC(year, month - 1, day));
      if (!parsed || Number.isNaN(parsed.getTime()) || written.getUTCMonth() !== month - 1 || written.getUTCDate() !== day) continue;
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

/**
 * The suggestion list of an autocomplete field or custom dropdown. `mode` is
 * 'scan' (what the list offers), 'locate' (where the one exact match is, checked
 * again right before the click) or 'verify' (whether the field now shows it).
 * Only options tied to this field count: named by its aria-controls / aria-owns /
 * aria-activedescendant, or inside its own widget, so a second widget's open list
 * is never used. Text inside an open list never counts as chosen.
 */
export function suggestionAction(index, wanted, mode) {
  const list = window.__agentElements || [];
  let field = list[index];
  if (!field || !field.isConnected) field = document.querySelector(`[data-agent-idx="${index}"]`);
  if (!field) return { error: `Element [${index}] no longer exists. Call read_page to refresh the element list.` };

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const target = norm(wanted);
  const visible = (el) => {
    if (!el.isConnected || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const isOtherField = (el) => el !== field && !el.contains(field) && !el.closest('[role=listbox]') && visible(el) &&
    (el.isContentEditable || el.matches('textarea, select, [role=combobox]') ||
      (el.tagName === 'INPUT' && !/^(hidden|submit|button|reset|image|checkbox|radio)$/i.test(el.type)));

  // Ancestors (up to 6 levels) that hold no other field: the field's own widget.
  const own = [];
  for (let p = field.parentElement, depth = 0; p && p !== document.body && depth < 6; p = p.parentElement, depth += 1) {
    if ([...p.querySelectorAll('input, textarea, select, [role=combobox], [contenteditable]')].some(isOtherField)) break;
    own.push(p);
  }
  const widget = own.at(-1) ?? null; // the widest, where a chosen value shows

  const containers = [];
  const named = (el) => {
    for (const attr of ['aria-controls', 'aria-owns']) {
      for (const id of (el.getAttribute(attr) || '').split(/\s+/)) {
        const found = id && document.getElementById(id);
        if (found) containers.push(found);
      }
    }
  };
  named(field);
  const activeId = field.getAttribute('aria-activedescendant');
  const active = activeId && document.getElementById(activeId);
  if (active) containers.push(active.closest('[role=listbox]') || active.parentElement || active);
  const combo = field.closest('[role=combobox]');
  if (combo && combo !== field) {
    named(combo);
    containers.push(combo);
  }

  const optionsIn = (list) => {
    const seen = new Set();
    const found = [];
    for (const c of list) {
      let candidates = [...(c.matches('[role=option]') ? [c] : []), ...c.querySelectorAll('[role=option]')];
      if (!candidates.length) candidates = [...c.querySelectorAll('[id*="-option-"]')]; // react-select before v5 marks options only by id
      for (const o of candidates) {
        if (seen.has(o) || !visible(o) || o.matches('[aria-disabled=true], [disabled]')) continue;
        seen.add(o);
        found.push(o);
      }
    }
    return found;
  };
  // A list the field names is the only one used. Without one, the closest ancestor
  // of the field's own widget that shows options, so an unrelated list stays out.
  let options = optionsIn(containers);
  if (!containers.length) {
    for (const p of own) {
      options = optionsIn([p]);
      if (options.length) break;
    }
  }
  const label = (o) => (o.innerText || o.textContent || '').replace(/\s+/g, ' ').trim();
  const matches = options.filter((o) => norm(label(o)) === target);

  if (mode === 'scan') {
    return { tied: containers.length > 0 || own.length > 0, total: options.length, options: options.slice(0, 10).map(label), matches: matches.length };
  }
  if (mode === 'locate') {
    if (matches.length !== 1) return { error: `The list changed: ${matches.length} options now read "${wanted}". Nothing was clicked.` };
    const option = matches[0];
    option.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const r = option.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, text: label(option) };
  }
  if (mode === 'verify') {
    // A plain autocomplete shows the choice as the field's value once its list closed;
    // a chip or single-value widget shows it as text in the widget, outside any list.
    if (norm(field.value) === target && !matches.length) return { ok: true };
    const root = widget || field.parentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const host = n.parentElement;
      if (!host || host.closest('[role=listbox], [role=option], [id*="-option-"]') || !visible(host)) continue;
      text += ` ${n.nodeValue}`;
    }
    return { ok: norm(text).includes(target) };
  }
  return { error: `Unknown suggestion action ${mode}` };
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
      // A real calendar date as written: V8 rolls 2026-02-30 over to March instead of
      // failing. The written day is checked, not the instant's UTC day, which differs
      // near midnight for offsets such as 2026-10-10T00:30:00+02:00.
      const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
      const written = new Date(Date.UTC(year, month - 1, day));
      if (!parsed || Number.isNaN(parsed.getTime()) || written.getUTCMonth() !== month - 1 || written.getUTCDate() !== day) continue;
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
