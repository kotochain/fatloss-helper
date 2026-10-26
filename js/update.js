/**
 * 版本更新相关的纯判断（v38）
 *
 * 背景（真事故）：用户手机上的应用卡在很旧的版本好几天，截图里还是老的「AI 说库里没有 → 一条都没记上」。
 * 原因：早期版本的 Service Worker 是缓存优先，连 `sw.js` 本身都被缓存 —— 手机上永远读到旧版本号，
 * 更新提醒永远弹不出来，形成死循环。v28 起已修（sw.js 不走缓存），但用户需要一条「自救」的路：
 *  1) 启动时发现新版 → 自动更新一次（记录都在本机，重载不丢）；
 *  2) 没条件自动更新时，顶部挂一条常驻横幅，直到真的更新；
 *  3) 极端卡死（旧版没有这些逻辑）→ 打开 `update.html` 一键清缓存重载。
 *
 * 这个文件只放可单测的纯函数；DOM 操作在 app.js。
 */
import { versionNumber } from './whatsnew.js';

/** 线上版本比本机新？非法/空的版本号一律当作「不知道」，不触发更新 */
export function hasNewerVersion(current, deployed) {
  if (!current || !deployed) return false;
  if (!/^v\d+$/.test(current) || !/^v\d+$/.test(deployed)) return false;
  return versionNumber(deployed) > versionNumber(current);
}

/**
 * 现在能不能安全地重载（不打扰正在填的内容）。
 * 重载不会丢已保存的记录，但会丢「正在输入/正在看的弹层」，所以这三类情况先不自动更新。
 */
export function canRefreshNow({ sheetOpen = false, hasDraft = false, typing = false } = {}) {
  return !sheetOpen && !hasDraft && !typing;
}

/** 常驻横幅文案：说清「点哪里」和「记录不会丢」 */
export function updateBannerText(latest) {
  return `有新版本 ${latest}，点这里更新（记录不会丢）`;
}

/** 自动更新只尝试一次/每个会话，避免网络/CDN 不一致时反复重载 */
export const AUTO_UPDATE_FLAG = 'fatloss.autoUpdated';
