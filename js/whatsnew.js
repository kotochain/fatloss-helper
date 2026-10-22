/**
 * 「更新了哪些东西 / 该不该提醒刷新」的纯逻辑。
 *
 * 为什么拆出来：这两件事都有边界（没记录过版本、版本号认不出、服务端比本地还旧），
 * 塞在界面里只能靠手点验证；拆成纯函数后可以用单元测试一条条钉住。
 * 这个文件不碰 DOM、不碰 localStorage。
 */

import { APP_VERSION, CHANGELOG } from './version.js';

/** 把 'v28' / '28' 变成数字 28；认不出来返回 NaN */
export function versionNumber(v) {
  const m = String(v ?? '').trim().match(/^v?(\d+)$/i);
  return m ? Number(m[1]) : NaN;
}

/**
 * a 是不是比 b 新。
 * 任一个认不出来就返回 false —— 宁可漏提醒一次，也不要拿乱七八糟的字符串去吓人。
 */
export function isNewerVersion(a, b) {
  const x = versionNumber(a);
  const y = versionNumber(b);
  return Number.isFinite(x) && Number.isFinite(y) && x > y;
}

/**
 * 「上次看到的是哪个版本」→ 之后的所有更新（新的在前）。
 *
 * - 没记录过（第一次升级到带这个功能的版本）：只给最新一版，不翻旧账；
 * - 记录过：把它之后每一版都给出来；
 * - 记录值认不出（比如以后改了版本号规则）：也只给最新一版 —— 宁可少给，不要给错。
 */
export function updatesAfter(lastSeen, changelog = CHANGELOG) {
  if (!Array.isArray(changelog) || !changelog.length) return [];
  if (!lastSeen) return changelog.slice(0, 1);
  const idx = changelog.findIndex((e) => e?.version === lastSeen);
  if (idx < 0) return changelog.slice(0, 1);
  return changelog.slice(0, idx);
}

/** 界面上「该不该弹更新说明」：有更新才弹 */
export function pendingUpdates(state, changelog = CHANGELOG) {
  const lastSeen = state?.settings?.lastSeenVersion || '';
  return updatesAfter(lastSeen, changelog);
}

/** 当前这一份代码的版本（给界面显示用，不用再去 fetch sw.js） */
export function currentVersion() {
  return APP_VERSION;
}
