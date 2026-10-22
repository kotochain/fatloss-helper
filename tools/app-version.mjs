/**
 * 读当前应用版本号（给自检脚本用）。
 *
 * 为什么要有这个文件：很多自检脚本会往 localStorage 里造一份「已经用过」的存档，
 * 而 v28 起「已经用过 + 版本变了」会在启动时弹更新说明 —— 造出来的存档如果不带
 * `settings.lastSeenVersion`，弹窗就会盖住脚本要点的界面（已经因此红过一次）。
 * 统一从 js/version.js 读，脚本里不用写死版本号（否则每次发版都要改一堆脚本）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {string} 例如 'v28'（读不到就返回空串） */
export function appVersion() {
  try {
    const src = fs.readFileSync(path.join(root, 'js', 'version.js'), 'utf8');
    return (src.match(/APP_VERSION = '([^']+)'/) || [])[1] || '';
  } catch {
    return '';
  }
}
