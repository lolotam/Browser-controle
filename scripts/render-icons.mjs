// Renders icons/logo-source.png (the Postora logo, 500×500) to the PNG sizes
// Chrome uses for the toolbar, extensions page and store, plus the side panel's
// header logo. At 16 and 32 px the "POSTORA" lettering would only blur, so those
// show the P alone on the logo's dark tile.
//
//   CHROMIUM_PATH=/path/to/chrome node scripts/render-icons.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ICONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../icons');
const OUTPUTS = [
  { file: 'icon-16.png', size: 16, mark: true },
  { file: 'icon-32.png', size: 32, mark: true },
  { file: 'icon-48.png', size: 48 },
  { file: 'icon-128.png', size: 128, pad: 8 }, // the store asks for a little transparent margin
  { file: 'logo.png', size: 96 }, // side panel header and empty state (shown at 22 and 44 px)
];
// The P and its bubbles, as a square of the 500 px source, above the lettering.
const MARK = { x: 70, y: 28, size: 360 };

const source = `data:image/png;base64,${fs.readFileSync(path.join(ICONS, 'logo-source.png')).toString('base64')}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
});
try {
  const page = await browser.newPage();
  for (const { file, size, mark = false, pad = 0 } of OUTPUTS) {
    const png = await page.evaluate(async ({ src, size, mark, pad, MARK }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      const inner = size - pad * 2;
      if (mark) {
        ctx.beginPath();
        ctx.roundRect(0, 0, size, size, size * 0.22);
        ctx.clip();
        ctx.fillStyle = '#0d0f14';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, MARK.x, MARK.y, MARK.size, MARK.size, 0, 0, size, size);
      } else {
        ctx.drawImage(img, pad, pad, inner, inner);
      }
      return c.toDataURL('image/png');
    }, { src: source, size, mark, pad, MARK });
    fs.writeFileSync(path.join(ICONS, file), Buffer.from(png.split(',')[1], 'base64'));
  }
} finally {
  await browser.close();
}
console.log(`Rendered ${OUTPUTS.map((o) => o.file).join(', ')}`);
