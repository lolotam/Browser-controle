// Live check of choose_suggestion's page script on demoqa's practice form
// (react-select widgets): Subjects "Maths", then State "NCR", then City "Delhi",
// whose list depends on the State. Not part of CI: it needs the network.
//   node test/e2e/live-suggestions.mjs

import { chromium } from 'playwright-core';
import { suggestionAction } from '../../src/browser/page-scripts.js';

const browser = await chromium.launch({ channel: process.env.CHROMIUM_PATH ? undefined : 'chromium', executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
// The extension injects this function by itself; here it is installed once on the page.
const run = async (index, wanted, mode) => {
  if (!(await page.evaluate(() => typeof window.__suggest === 'function'))) await page.addScriptTag({ content: `window.__suggest = ${suggestionAction};` });
  return page.evaluate((args) => window.__suggest(...args), [index, wanted, mode]);
};

async function choose(index, id, text, option = text) {
  await page.evaluate(([i, sel]) => {
    window.__agentElements ??= [];
    window.__agentElements[i] = document.getElementById(sel);
    window.__agentElements[i].scrollIntoView({ block: 'center' });
  }, [index, id]);
  await page.click(`#${id}`, { force: true });
  await page.keyboard.insertText(text);
  let scan;
  for (const end = Date.now() + 2000; ;) {
    scan = await run(index, option, 'scan');
    if (scan.matches > 0 || Date.now() >= end) break;
    await page.waitForTimeout(150);
  }
  if (scan.matches !== 1) throw new Error(`${id}: ${JSON.stringify(scan)}`);
  const spot = await run(index, option, 'locate');
  await page.mouse.click(spot.x, spot.y);
  await page.waitForTimeout(300);
  const verified = await run(index, option, 'verify');
  console.log(`${id}: chose "${spot.text}" from [${scan.options.join(' | ')}] → shown ${verified.ok}`);
  if (!verified.ok) throw new Error(`${id} not shown`);
}

try {
  await page.goto('https://demoqa.com/automation-practice-form', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#subjectsInput', { timeout: 30000 });
  await choose(0, 'subjectsInput', 'Math', 'Maths');
  await choose(1, 'react-select-3-input', 'NC', 'NCR');
  await choose(2, 'react-select-4-input', 'Del', 'Delhi');
  // A wrong option must not be clicked: the list is shown instead.
  await page.click('#subjectsInput', { force: true });
  await page.keyboard.insertText('Phys');
  await page.waitForTimeout(500);
  const refusal = await run(0, 'Pune', 'scan');
  console.log(`refusal: ${refusal.matches} matches, options [${refusal.options.join(' | ')}]`);
  if (refusal.matches !== 0) throw new Error('unexpected match');
  console.log('LIVE PASSED');
} finally {
  await browser.close();
}
