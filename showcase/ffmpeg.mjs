// Playwright's own ffmpeg (VP8 only), used to film the side panel and to shrink
// videos for the report. It lives in Playwright's browser cache, whose default
// location depends on the platform unless PLAYWRIGHT_BROWSERS_PATH moves it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function browsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
}

export function findFfmpeg() {
  const base = browsersPath();
  const dir = fs.existsSync(base) && fs.readdirSync(base).find((d) => d.startsWith('ffmpeg-'));
  if (!dir) throw new Error(`Playwright's ffmpeg is not in ${base}: run "npx playwright-core install ffmpeg".`);
  const exe = fs.readdirSync(path.join(base, dir)).find((f) => f.startsWith('ffmpeg'));
  return path.join(base, dir, exe);
}
