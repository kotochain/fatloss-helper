/**
 * 找到系统里的 Chrome。
 * 本机开发和 GitHub Actions（Ubuntu）用到的路径不一样，所以统一在这里找。
 * 也可以用环境变量 CHROME_PATH 指定。
 */
import fs from 'node:fs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

export function findChrome() {
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* 继续找 */ }
  }
  throw new Error(
    '没找到 Chrome。本机自检需要装 Chrome；也可以用环境变量指定：CHROME_PATH=/path/to/chrome node tools/xxx-check.mjs',
  );
}
