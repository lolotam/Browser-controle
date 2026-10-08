// Tool definitions offered to the model and their implementation against the
// BrowserController. Every tool returns { output, images? } where output is the
// text observation the model sees next.

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });

const DEFINITIONS = [
  { name: 'read_page', description: 'Get the current page URL, title, scroll position, the numbered list of interactive elements and the visible text. Call this before interacting with a page you have not seen yet.', parameters: obj({}) },
  { name: 'navigate', description: 'Open a URL in the current tab.', parameters: obj({ url: str('Absolute URL, e.g. https://example.com') }, ['url']) },
  { name: 'web_search', description: 'Search the web with Google in the current tab and return the results page.', parameters: obj({ query: str('Search query') }, ['query']) },
  { name: 'click', description: 'Click an element by its [index] from the latest read_page result.', parameters: obj({ index: int('Element index'), double: { type: 'boolean', description: 'Double-click instead of single click' } }, ['index']) },
  { name: 'click_at', description: 'Click at viewport coordinates (CSS pixels) taken from the latest screenshot. Use only when the element has no index.', parameters: obj({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']) },
  { name: 'type_text', description: 'Focus an input/textarea/editable element by index and type text into it.', parameters: obj({ index: int('Element index'), text: str('Text to type'), clear: { type: 'boolean', description: 'Replace existing content (default true)' }, submit: { type: 'boolean', description: 'Press Enter afterwards' } }, ['index', 'text']) },
  { name: 'press_key', description: 'Press a key or chord on the focused element, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+A".', parameters: obj({ key: str('Key or chord') }, ['key']) },
  { name: 'select_option', description: 'Choose an option of a <select> element by its visible text or value.', parameters: obj({ index: int('Element index of the <select>'), option: str('Option text or value') }, ['index', 'option']) },
  { name: 'hover', description: 'Move the mouse over an element (opens hover menus).', parameters: obj({ index: int('Element index') }, ['index']) },
  { name: 'scroll', description: 'Scroll the page (or the scrollable area under an element) up or down by about one screen.', parameters: obj({ direction: { type: 'string', enum: ['up', 'down'] }, index: int('Optional element index to scroll inside'), screens: { type: 'number', description: 'How many screens (default 1)' } }, ['direction']) },
  { name: 'get_text', description: 'Read more of the page text, for collecting information from long pages.', parameters: obj({ start: int('Character offset (default 0)'), length: int('Characters to read (default 6000, max 15000)') }) },
  { name: 'screenshot', description: 'Take a screenshot of the visible viewport to see layout, images, canvases or anything the element list does not capture.', parameters: obj({}), vision: true },
  { name: 'history', description: 'Go back, forward, or reload the current tab.', parameters: obj({ action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, ['action']) },
  { name: 'wait', description: 'Wait for the page to update (e.g. after starting a slow operation).', parameters: obj({ seconds: { type: 'number', description: '1-15' } }, ['seconds']) },
  { name: 'list_tabs', description: 'List all open tabs with their ids. Tabs marked [yours] are in your session\'s tab group.', parameters: obj({}) },
  { name: 'switch_tab', description: 'Control another tab. A tab outside your group joins it; a tab another running session uses is refused.', parameters: obj({ tab_id: int('Tab id from list_tabs') }, ['tab_id']) },
  { name: 'open_tab', description: 'Open a URL in a new background tab in your group and control it.', parameters: obj({ url: str('Absolute URL') }, ['url']) },
  { name: 'close_tab', description: 'Close one of your tabs by id.', parameters: obj({ tab_id: int('Tab id') }, ['tab_id']) },
  { name: 'run_javascript', description: 'Evaluate a JavaScript expression in the page and return its JSON-serialisable value. Use for precise data extraction.', parameters: obj({ expression: str('JavaScript expression; may be an async IIFE') }, ['expression']), javascript: true },
  { name: 'ask_user', description: 'Ask the user a question and wait for the answer. Required before purchases, payments, sending messages/emails/posts, deleting data, or entering credentials; also use when the task is ambiguous or you hit a login/CAPTCHA you cannot pass.', parameters: obj({ question: str('Question for the user') }, ['question']) },
  { name: 'done', description: 'Finish the task and give the user the final report in Markdown, in the user\'s language.', parameters: obj({ report: str('Final report: what was done and every piece of information collected, with source links'), success: { type: 'boolean', description: 'Whether the task was fully completed' } }, ['report', 'success']) },
];

export function toolDefinitions({ vision, allowJavascript }) {
  return DEFINITIONS
    .filter((t) => (vision || !t.vision) && (allowJavascript || !t.javascript))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
}

/** Formats a page snapshot as the text observation the model reads. */
export function formatSnapshot(snap) {
  const { y, viewport, height } = snap.scroll;
  const pct = height > viewport ? Math.round((y / (height - viewport)) * 100) : 100;
  return [
    `URL: ${snap.url}`,
    `Title: ${snap.title}`,
    `Scroll: ${y}px of ${height}px (${pct}% down, viewport ${viewport}px)`,
    `Interactive elements${snap.offscreen ? ` (${snap.offscreen} more further down/offscreen — scroll to reveal)` : ''}:`,
    snap.elements.length ? snap.elements.join('\n') : '(none)',
    '',
    'Visible text (truncated; use get_text for more):',
    snap.text || '(empty)',
  ].join('\n');
}

export function createToolExecutor(browser, { askUser }) {
  const observe = async (prefix) => {
    try {
      return `${prefix}\n\n${formatSnapshot(await browser.snapshot())}`;
    } catch (err) {
      const tab = await browser.currentTab();
      return `${prefix}\nNow at ${tab.url} — page content unavailable: ${err.message}`;
    }
  };

  const handlers = {
    read_page: async () => observe('Page state:'),
    navigate: async ({ url }) => {
      await browser.navigate(normalizeUrl(url));
      return observe(`Navigated to ${url}.`);
    },
    web_search: async ({ query }) => {
      await browser.navigate(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
      return observe(`Searched for "${query}".`);
    },
    click: async ({ index, double }) => {
      const { x, y, tag } = await browser.element(index, 'locate');
      await browser.clickAt(x, y, { clickCount: double ? 2 : 1 });
      return observe(`Clicked [${index}] <${tag}>.`);
    },
    click_at: async ({ x, y }) => {
      await browser.clickAt(x, y);
      return observe(`Clicked at (${x}, ${y}).`);
    },
    type_text: async ({ index, text, clear = true, submit = false }) => {
      const { x, y } = await browser.element(index, 'locate');
      await browser.clickAt(x, y);
      if (clear) await browser.element(index, 'select-all');
      await browser.insertText(text);
      if (submit) await browser.pressKey('Enter');
      return observe(`Typed into [${index}]${submit ? ' and pressed Enter' : ''}.`);
    },
    press_key: async ({ key }) => {
      await browser.pressKey(key);
      return observe(`Pressed ${key}.`);
    },
    select_option: async ({ index, option }) => {
      const { selected } = await browser.element(index, 'select-option', option);
      return observe(`Selected "${selected}" in [${index}].`);
    },
    hover: async ({ index }) => {
      const { x, y } = await browser.element(index, 'locate');
      await browser.hoverAt(x, y);
      return observe(`Hovering [${index}].`);
    },
    scroll: async ({ direction, index, screens = 1 }) => {
      const at = Number.isInteger(index) ? await browser.element(index, 'locate') : null;
      const sign = direction === 'up' ? -1 : 1;
      await browser.scroll(sign * Math.min(Math.max(screens, 0.2), 10), at);
      return observe(`Scrolled ${direction}.`);
    },
    get_text: async ({ start = 0, length = 6000 }) => {
      const res = await browser.text(Math.max(0, start), Math.min(Math.max(length, 500), 15000));
      const end = res.start + res.text.length;
      return `Page text characters ${res.start}-${end} of ${res.total}${end < res.total ? ' (more available)' : ''}:\n${res.text}`;
    },
    screenshot: async () => {
      const shot = await browser.screenshot();
      return { output: `Screenshot of the viewport attached (${shot.width}x${shot.height} CSS px; use these coordinates with click_at).`, images: [shot.dataUrl] };
    },
    history: async ({ action }) => {
      await browser.history(action);
      return observe(`Did ${action}.`);
    },
    wait: async ({ seconds }) => {
      await new Promise((r) => setTimeout(r, Math.min(Math.max(seconds, 0.5), 15) * 1000));
      return observe(`Waited ${seconds}s.`);
    },
    list_tabs: async () => {
      const tabs = await chrome.tabs.query({});
      const current = (await browser.currentTab()).id;
      return tabs.map((t) => `${t.id === current ? '* ' : '  '}tab_id=${t.id} ${browser.ownsTab(t) ? '[yours] ' : ''}${t.active ? '(active) ' : ''}${t.title} — ${t.url}`).join('\n');
    },
    switch_tab: async ({ tab_id }) => {
      await browser.useTab(tab_id);
      return observe(`Switched to tab ${tab_id}.`);
    },
    open_tab: async ({ url }) => {
      const tab = await browser.openTab(normalizeUrl(url));
      await browser.waitForLoad({ expectNavigation: true });
      return observe(`Opened new tab ${tab.id}.`);
    },
    close_tab: async ({ tab_id }) => {
      const owner = browser.isTakenByOther(await chrome.tabs.get(tab_id));
      if (owner) throw new Error(`Tab ${tab_id} belongs to session "${owner}".`);
      await chrome.tabs.remove(tab_id);
      return `Closed tab ${tab_id}.`;
    },
    run_javascript: async ({ expression }) => {
      const value = await browser.evaluate(expression);
      const json = JSON.stringify(value, null, 1) ?? 'undefined';
      return json.length > 15000 ? `${json.slice(0, 15000)}… (truncated)` : json;
    },
    ask_user: async ({ question }) => `User answered: ${await askUser(question)}`,
  };

  return async function execute(name, args) {
    const handler = handlers[name];
    if (!handler) return { output: `Unknown tool "${name}".`, isError: true };
    try {
      const result = await handler(args ?? {});
      return typeof result === 'string' ? { output: result } : result;
    } catch (err) {
      return { output: `Error: ${err.message}`, isError: true };
    }
  };
}

export function normalizeUrl(url) {
  const trimmed = String(url).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
