// Renders icons/logo.svg (and logo-small.svg for 16px, where the spark would
// blur) to the PNG sizes Chrome uses for the toolbar, extensions page and store.
//
//   CHROMIUM_PATH=/path/to/chrome node scripts/render-icons.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ICONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../icons');
const SIZES = [16, 32, 48, 128];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage();
  for (const size of SIZES) {
    const svg = fs.readFileSync(path.join(ICONS, size <= 16 ? 'logo-small.svg' : 'logo.svg'), 'utf8');
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.locator('svg').screenshot({ path: path.join(ICONS, `icon-${size}.png`), omitBackground: true });
  }
} finally {
  await browser.close();
}
console.log(`Rendered ${SIZES.map((s) => `icon-${s}.png`).join(', ')}`);
