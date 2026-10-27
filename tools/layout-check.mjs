/**
 * 排版自检（小屏 · 横屏 · 系统大字号）—— 专门找「排版在真手机上会坏」的问题
 *
 * 为什么要有这个文件：之前所有自检都只跑过一个 390×844。
 * 320 宽的小屏、横屏、以及 Android 把系统字体调到 130%~150% 的情况从来没测过 ——
 * 这三类恰恰最容易出现「文字被切 / 按钮点不到 / 底部内容被导航栏盖住」。
 *
 * 用法（不需要先手动起服务，脚本会自己起 4313 的静态服务）：
 *   node tools/layout-check.mjs
 *
 * 端口分配：CDP 9413、静态服务 4313、Chrome profile 目录 .audit/profiles/layout。
 * 产物：.audit/layout-report.md、.audit/layout-report.json、.audit/layout-shots/*.png
 *
 * 诚实边界（报告里也会再写一遍）：
 *  - 这是无头 Chrome 的视口模拟（Emulation.setDeviceMetricsOverride + mobile:true + dpr 2），
 *    **不是真机**。真实手机的字体渲染、状态栏、手势区、输入法弹出都不在模拟范围内。
 *  - 系统大字号用 text-size-adjust 做近似模拟，不等于 Android 真实的「字体大小」设置。
 *  - env(safe-area-inset-*) 在本版 Chrome 无法用 CDP 模拟（Emulation.setSafeAreaInsets 不存在），
 *    所以安全区只做 CSS 静态检查 + 推断，不谎称实测。
 *
 * 退出码：出现「事故级 / 严重」问题（含反向验证失败）→ 非 0；只有一般/建议 → 0。
 *
 * 脚本可重复跑。必须显式 process.exit()，否则 WebSocket / 浏览器会让进程挂住（踩过很多次）。
 */

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { armWatchdog } from './watchdog.mjs';
import { launchChrome, freePort } from './chrome-launch.mjs';
import { appVersion } from './app-version.mjs';

/* ── 常量 ─────────────────────────────────── */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.audit');
const SHOTS = path.join(OUT, 'layout-shots');
const PROFILE = path.join(OUT, 'profiles', 'layout');
const CDP_PORT = 9413;
const SERVE_PORT = 4313;
const BASE = process.env.BASE_URL || `http://127.0.0.1:${SERVE_PORT}`;

// 开发用：只跑某个尺寸 / 某几种 pass，方便调试（不传就是完整跑）。
const ONLY_SIZE = process.env.LAYOUT_ONLY_SIZE || '';
const ONLY_PASSES = process.env.LAYOUT_ONLY_PASSES || ''; // 例：normal 或 normal,font130
const NO_SHOTS = process.env.LAYOUT_NO_SHOTS === '1';
// 截图清晰度：1 = 按 CSS 像素存（体积小，够看布局）；2 = 按设备像素存（更清晰但大 4 倍）
const SHOT_DPR = Number(process.env.LAYOUT_SHOT_DPR || 1);
const DEV_MODE = Boolean(ONLY_SIZE || ONLY_PASSES);

const HARD_TIMEOUT_MS = 450_000; // 7.5 分钟硬超时（任务要求单次 8 分钟内）
const TOL = 1;                    // 1px 容差（亚像素 / 四舍五入）

const SIZES = [
  { label: '320x568', w: 320, h: 568, note: '小屏手机（iPhone SE 一代尺寸）' },
  { label: '360x640', w: 360, h: 640, note: '安卓常见小屏' },
  { label: '390x844', w: 390, h: 844, note: '之前唯一测过的尺寸' },
  { label: '412x915', w: 412, h: 915, note: '安卓大屏' },
  { label: '844x390', w: 844, h: 390, note: '横屏', landscape: true },
];

/**
 * 界面清单（报告和表格都按这个顺序）。
 * 每一项都必须能在界面上真的点开 —— 不伪造、不直接调内部函数。
 */
const INTERFACE_ORDER = [
  ['welcome', '欢迎页'],
  ['sheet-recover', '弹层·找回记录（恢复）'],
  ['onboard-1', '引导 1/4·先说三件事'],
  ['onboard-2', '引导 2/4·填资料'],
  ['onboard-3', '引导 3/4·用 AI 帮你记'],
  ['onboard-4', '引导 4/4·最后一步'],
  ['tab-today', '标签·今天'],
  ['tab-log-food', '标签·记录（吃的）'],
  ['tab-log-training', '标签·记录（练的）'],
  ['tab-plan', '标签·计划'],
  ['tab-progress', '标签·我的'],
  ['sheet-food-search', '弹层·加食物搜索'],
  ['sheet-food-amount', '弹层·份量'],
  ['sheet-quick-draft', '弹层·说一句（没配 AI）'],
  ['sheet-add-exercise', '弹层·加运动'],
  ['sheet-weight', '弹层·记体重'],
  ['sheet-growth', '弹层·我的成长'],
  ['sheet-insights', '弹层·你的规律（经验总结）'],
  ['sheet-custom-food', '弹层·照包装营养成分表'],
  ['sheet-plan-sub', '弹层·替代动作'],
  ['sheet-calendar', '弹层·日历'],
  ['sheet-settings', '弹层·设置'],
  ['sheet-profile', '弹层·我的资料'],
  ['sheet-ai-settings', '弹层·AI 设置'],
  ['sheet-backup', '弹层·数据与备份'],
  ['sheet-wipe', '弹层·从头开始（清除）'],
  ['sheet-about', '弹层·关于'],
  ['sheet-guide-review', '弹层·重看新手引导'],
];
const INTERFACE_LABEL = new Map(INTERFACE_ORDER);

/* ── 小工具 ───────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 干完活主动退出（不显式退出的话，WebSocket + 浏览器会让 Node 事件循环一直不空，
 * 表现是「断言都跑完了，进程却挂着」，最后被看门狗按超时杀掉 —— 这个坑踩过很多次）。
 */
function finishAndExit(exitCode = 0, cleanup = []) {
  for (const fn of cleanup) { try { fn(); } catch { /* 收尾失败不影响结果 */ } }
  process.exit(exitCode);
}

const round1 = (n) => Math.round(n * 10) / 10;
const normText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const mdEscape = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function countLevels(issues) {
  const c = { 事故级: 0, 严重: 0, 一般: 0, 建议: 0 };
  for (const i of issues) c[i.level] = (c[i.level] || 0) + 1;
  return c;
}
const LEVEL_ORDER = { 事故级: 0, 严重: 1, 一般: 2, 建议: 3 };
function sortIssues(list) {
  return [...list].sort((a, b) => (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) || 0);
}

/* ── 静态检查：字号单位 / 安全区 / viewport ── */

function analyzeCss() {
  const cssFile = path.join(ROOT, 'css', 'style.css');
  const htmlFile = path.join(ROOT, 'index.html');
  const css = fs.readFileSync(cssFile, 'utf8');
  const lines = css.split('\n');

  const fontDecls = [...css.matchAll(/font-size\s*:\s*([^;}\n]+)/g)].map((m) => m[1].trim());
  const pxCount = fontDecls.filter((v) => /\dpx\b/.test(v) || /\d\.\d+px\b/.test(v)).length;
  const remCount = fontDecls.filter((v) => /\d(?:\.\d+)?rem\b/.test(v)).length;
  const emCount = fontDecls.filter((v) => /\d(?:\.\d+)?em\b/.test(v) && !/rem/.test(v)).length;
  const percentCount = fontDecls.filter((v) => /%/.test(v)).length;

  const safeHits = [];
  lines.forEach((line, i) => {
    if (line.includes('env(') && line.includes('safe-area-inset')) {
      safeHits.push({ line: i + 1, text: line.trim() });
    }
  });
  const insetNames = [...new Set([...css.matchAll(/env\(\s*(safe-area-inset-[a-z]+)\s*\)/g)].map((m) => m[1]))];

  const html = fs.readFileSync(htmlFile, 'utf8');
  const viewportFit = /viewport-fit=cover/.test(html);
  const viewportMeta = (html.match(/<meta name="viewport" content="([^"]+)"/) || [])[1] || '';

  const bodyRule = /body\s*\{[^}]*\}/.exec(css)?.[0] || '';
  const bodyPadBottom = (/body\s*\{[^}]*padding-bottom:\s*([^;}]+)/.exec(css) || [])[1] || null;
  const tabbarRule = /\.tabbar\s*\{[^}]*\}/.exec(css)?.[0] || '';
  const tabbarPadBottom = (/\.tabbar\s*\{[^}]*padding-bottom:\s*([^;}]+)/.exec(css) || [])[1] || null;
  const sheetFootRule = /\.sheet-foot\s*\{[^}]*\}/.exec(css)?.[0] || '';
  const sheetFootPad = (/\.sheet-foot\s*\{[^}]*padding:\s*([^;}]+)/.exec(css) || [])[1] || null;

  // 写死的 px 尺寸（大字号时不会跟着放大，是模拟要抓的重点）—— 从 CSS 里点名几个关键的
  // 注意 (?<!-)width：别把 svg 的 stroke-width 当成 width（踩过）
  const widthOf = (selector) => {
    const rule = new RegExp(selector + '\\s*\\{[^}]*\\}').exec(css)?.[0] || '';
    return ((/(?<!-)width:\s*([^;}]+)/.exec(rule) || [])[1] || '?').trim();
  };
  // 行号动态找，别写死 —— 这个文件在审计期间可能被其他人改动，写死行号会过期
  const lineOf = (needle) => {
    const i = lines.findIndex((l) => l.includes(needle));
    return i >= 0 ? i + 1 : '?';
  };
  const fixedPx = [
    { what: '圆环 .ring-wrap', value: widthOf('\\.ring-wrap'), line: lineOf('.ring-wrap {') },
    { what: '营养素标签 .macro-row .mlabel', value: widthOf('\\.macro-row \\.mlabel'), line: lineOf('.macro-row .mlabel {') },
    { what: '营养素数值 .macro-row .mval', value: widthOf('\\.macro-row \\.mval'), line: lineOf('.macro-row .mval {') },
    { what: '底栏图标 .tab .ic', value: widthOf('\\.tab \\.ic'), line: lineOf('.tab .ic {') },
    { what: '页面底部留白 body padding-bottom', value: bodyPadBottom || '?', line: lineOf('padding-bottom: 72px') },
  ];

  return {
    cssFile: path.relative(ROOT, cssFile),
    fontDecls: fontDecls.length,
    pxCount, remCount, emCount, percentCount,
    safeHits, insetNames, viewportFit, viewportMeta,
    bodyPadBottom, tabbarPadBottom, sheetFootPad,
    fixedPx,
    hasTopInset: insetNames.some((n) => n.includes('top')),
    hasBottomInset: insetNames.some((n) => n.includes('bottom')),
    hasSideInset: insetNames.some((n) => n.includes('left') || n.includes('right')),
  };
}

/* ── 页面内测量脚本 ──────────────────────────
 * 一次性把「这个界面当前这一屏」的排版证据收集回来。
 * 这是唯一的真相来源：Node 端只负责下判断，不猜测 DOM。
 */
const PROBE_EXPR = String.raw`(() => {
  const de = document.documentElement;
  // 注意：不能用 window.innerWidth 当视口宽 —— 在 Chrome 手机模拟里，一旦页面内容
  // 比屏幕宽，innerWidth 会跟着内容一起变宽（实测：注入 1200px 元素后 innerWidth 从 390 变成 1200），
  // 用它判断「元素是否跑出屏幕」会永远判不出来。documentElement.clientWidth 才是稳定视口宽。
  const vw = de.clientWidth;
  const vh = de.clientHeight;
  const round1 = (n) => Math.round(n * 10) / 10;
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const root = document.querySelector('#sheetRoot');
  const sheetOpen = !!(root && !root.classList.contains('hidden'));
  const ignored = (el) => {
    if (!el.closest) return false;
    return !!(el.closest('.celebrate') || el.closest('.toast') || el.closest('#bootFail'));
  };
  const inScope = (el) => !sheetOpen || !!(el.closest && el.closest('#sheetRoot'));
  const visible = (el) => {
    if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const label = (el) => {
    const cls = typeof el.className === 'string' ? norm(el.className).split(' ').filter(Boolean).slice(0, 3).join('.') : '';
    const id = el.id ? '#' + el.id : '';
    const txt = norm(el.getAttribute('aria-label') || el.textContent).slice(0, 26);
    return el.tagName.toLowerCase() + id + (cls ? '.' + cls : '') + (txt ? ' "' + txt + '"' : '');
  };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: round1(r.top), bottom: round1(r.bottom), left: round1(r.left), right: round1(r.right), w: round1(r.width), h: round1(r.height) }; };

  const startScrollY = window.scrollY;
  window.scrollTo(0, 0);

  // ── 1) 横向溢出 ──
  const rightOutMap = new Map();
  let rightOutTotal = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (ignored(el) || !inScope(el) || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) {
      rightOutTotal += 1;
      const k = label(el) + '|' + Math.round(r.left) + '|' + Math.round(r.right);
      const prev = rightOutMap.get(k);
      if (prev) prev.count += 1;
      else if (rightOutMap.size < 20) rightOutMap.set(k, { what: label(el), left: round1(r.left), right: round1(r.right), w: round1(r.width), top: round1(r.top), count: 1 });
    }
  }

  // ── 2) 可点元素的触摸目标高度 ──
  const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [data-act], [data-pick], [data-set], [data-mode], [data-record-tab], [data-train-eq], [data-train-cardio], [data-train-strength], [data-train-min], [data-train-intensity], [data-subs], [data-subs-log], [data-ach], [data-recover], [data-wipe], [data-sex], [data-goal], [data-pace], [data-act-key], [data-grams], [data-ex], [data-date], [data-eq], [data-min], [data-log-cardio], .chip, .set-row, .search-hit, .tab, .add-line';
  const smallMap = new Map();
  let smallTotal = 0;
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (ignored(el) || !inScope(el) || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height >= 40 - 0.5) continue;
    smallTotal += 1;
    let cat = 'control';
    if (el.matches('a[href]')) cat = 'inline-link';
    else if (el.matches('summary')) cat = 'summary';
    else if (el.matches('.chip, [data-grams], [data-min], [data-train-min], [data-eq], [data-ex]')) cat = 'chip';
    else if (el.matches('.icon-btn, .avatar, .del, #sheetClose')) cat = 'icon-button';
    else if (el.matches('.tab, .btn:not(.ghost), .big-log, .seg-btn, .mode-chip, .add-line, [data-pick]')) cat = 'primary-control';
    const k = label(el) + '|' + Math.round(r.height);
    const prev = smallMap.get(k);
    if (prev) prev.count += 1;
    else if (smallMap.size < 24) smallMap.set(k, { what: label(el), h: round1(r.height), w: round1(r.width), cat, count: 1 });
  }

  // ── 3) 文字溢出容器（含按钮文字被裁）──
  // 只看「自己直接带文字」的元素：内容是子元素的溢出交给子元素自己报，避免重复刷屏。
  const clipped = [];
  const ellipsized = [];
  let clippedTotal = 0;
  for (const el of document.querySelectorAll('#app *, .topbar *, .tabbar *, #sheetRoot *')) {
    if (ignored(el) || !inScope(el) || !visible(el)) continue;
    const hasOwnText = Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && norm(n.textContent));
    if (!hasOwnText) continue;
    const cs = getComputedStyle(el);
    const overX = el.scrollWidth - el.clientWidth;
    const overY = el.scrollHeight - el.clientHeight;
    const clippedY = overY > 2 && (cs.overflowY === 'hidden' || cs.overflowY === 'auto' || cs.overflowY === 'scroll');
    if (overX <= 2 && !clippedY) continue;
    clippedTotal += 1;
    const item = {
      what: label(el),
      overX: Math.round(overX), overY: Math.round(overY),
      cw: Math.round(el.clientWidth), sw: Math.round(el.scrollWidth),
      textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace,
    };
    if (cs.textOverflow === 'ellipsis') { if (ellipsized.length < 8) ellipsized.push(item); }
    else if (clipped.length < 12) clipped.push(item);
  }

  // ── 4) 顶部：日期是否被挤成多行、顶栏是否压住首屏内容 ──
  const tb = document.querySelector('.topbar');
  const dt = document.getElementById('dateText');
  const nameTag = document.getElementById('nameTag');
  const dateCs = dt ? getComputedStyle(dt) : null;
  // #dateText 在 <button> 里，Chrome 的 UA 样式给按钮 line-height:normal，
  // 所以 computed lineHeight 可能是 "normal" → 用 fontSize×1.375 估一行的高度。
  const dateLhRaw = dateCs ? parseFloat(dateCs.lineHeight) : NaN;
  const dateFontSize = dateCs ? parseFloat(dateCs.fontSize) : 0;
  const dateLineH = Number.isFinite(dateLhRaw) ? dateLhRaw : dateFontSize * 1.375;
  const dateRectH = dt ? dt.getBoundingClientRect().height : 0;
  const topbar = tb ? {
    h: round1(tb.getBoundingClientRect().height),
    dateLines: dateLineH > 0 && dateRectH > 0 ? Math.max(1, Math.round(dateRectH / dateLineH)) : 0,
    dateH: round1(dateRectH),
    dateLineH: round1(dateLineH),
    dateFontSize: round1(dateFontSize),
    dateText: dt ? norm(dt.textContent) : '',
    nameTagW: nameTag && !nameTag.hidden ? round1(nameTag.getBoundingClientRect().width) : 0,
    nameTagText: nameTag && !nameTag.hidden ? norm(nameTag.textContent) : '',
    bottom: round1(tb.getBoundingClientRect().bottom),
  } : null;
  const firstAppChild = document.querySelector('#app > *');
  const pageTop = {
    topbarBottom: topbar ? topbar.bottom : 0,
    firstTop: firstAppChild ? round1(firstAppChild.getBoundingClientRect().top) : null,
  };

  // ── 5) 底栏是否遮住最后一条内容（仅「页面」有意义；弹层打开时跳过）──
  const bar = document.querySelector('.tabbar');
  const barRect = bar ? bar.getBoundingClientRect() : null;
  let bottomBar = { skipped: sheetOpen };
  if (!sheetOpen) {
    const docH = de.scrollHeight;
    const bodyCs = getComputedStyle(document.body);
    window.scrollTo(0, docH);
    const appEl = document.querySelector('#app');
    let lastEl = null;
    if (appEl) {
      const all = appEl.querySelectorAll('*');
      for (let i = all.length - 1; i >= 0; i--) {
        const el = all[i];
        if (!visible(el)) continue;
        if (!norm(el.textContent)) continue;
        lastEl = el;
        break;
      }
    }
    const lastRect = lastEl ? lastEl.getBoundingClientRect() : null;
    const barTop = barRect ? round1(barRect.top) : vh;
    const barVisible = !!(barRect && barRect.width > 0 && barRect.height > 0);
    bottomBar = {
      skipped: false,
      barVisible,
      barTop,
      barHeight: barRect ? round1(barRect.height) : 0,
      bodyPadBottom: round1(parseFloat(bodyCs.paddingBottom) || 0),
      tabbarPadBottom: bar ? round1(parseFloat(getComputedStyle(bar).paddingBottom) || 0) : 0,
      scrollable: docH > vh + 1,
      lastWhat: lastEl ? label(lastEl) : null,
      lastBottom: lastRect ? round1(lastRect.bottom) : null,
      covered: !!(lastRect && barVisible && lastRect.bottom > barTop + 1),
      overlap: lastRect && barVisible ? round1(Math.max(0, lastRect.bottom - barTop)) : 0,
    };
    window.scrollTo(0, startScrollY);
  }

  // ── 6) 弹层：本体在不在视口内、关闭按钮点不点得到、内容能不能滚到底 ──
  let sheet = null;
  const hitTest = (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.max(1, Math.min(vw - 1, r.left + r.width / 2));
    const y = Math.max(1, Math.min(vh - 1, r.top + r.height / 2));
    const top = document.elementFromPoint(x, y);
    return !!(top && (top === el || el.contains(top)));
  };
  if (sheetOpen) {
    const sheetEl = root.querySelector('.sheet');
    const sr = sheetEl.getBoundingClientRect();
    const close = document.getElementById('sheetClose');
    const cr = close.getBoundingClientRect();
    const body = document.getElementById('sheetBody');
    const foot = document.getElementById('sheetFoot');
    const bodyNeedsScroll = body.scrollHeight > body.clientHeight + 2;
    let bodyCanScroll = null;
    let bodyScrolledTo = null;
    let lastBody = null;
    const bodyRect = body.getBoundingClientRect();
    const bodyRectBottom = round1(bodyRect.bottom);
    let lastBottom = null;
    if (bodyNeedsScroll) {
      body.scrollTop = body.scrollHeight;
      bodyScrolledTo = Math.round(body.scrollTop);
      bodyCanScroll = body.scrollTop >= body.scrollHeight - body.clientHeight - 2;
      const vis = [];
      for (const el of body.querySelectorAll('*')) if (visible(el)) vis.push(el);
      for (let i = vis.length - 1; i >= 0; i--) { if (norm(vis[i].textContent)) { lastBody = vis[i]; break; } }
      lastBottom = lastBody ? round1(lastBody.getBoundingClientRect().bottom) : null;
      body.scrollTop = 0;
    } else {
      const vis = [];
      for (const el of body.querySelectorAll('*')) if (visible(el)) vis.push(el);
      for (let i = vis.length - 1; i >= 0; i--) { if (norm(vis[i].textContent)) { lastBody = vis[i]; break; } }
      lastBottom = lastBody ? round1(lastBody.getBoundingClientRect().bottom) : null;
    }
    const footBtns = [];
    if (foot) {
      for (const b of foot.querySelectorAll('button')) {
        if (!visible(b)) continue;
        const br = b.getBoundingClientRect();
        footBtns.push({
          what: label(b),
          h: round1(br.height),
          inView: br.top >= -1 && br.bottom <= vh + 1 && br.left >= -1 && br.right <= vw + 1,
          hittable: hitTest(b),
        });
      }
    }
    sheet = {
      open: true,
      title: norm(document.getElementById('sheetTitle') ? document.getElementById('sheetTitle').textContent : ''),
      rect: rect(sheetEl),
      inView: sr.top >= -1 && sr.bottom <= vh + 1 && sr.left >= -1 && sr.right <= vw + 1,
      close: { h: round1(cr.height), w: round1(cr.width), inView: cr.top >= -1 && cr.bottom <= vh + 1 && cr.left >= -1 && cr.right <= vw + 1, hittable: hitTest(close) },
      body: {
        needsScroll: bodyNeedsScroll,
        canScroll: bodyCanScroll,
        scrolledTo: bodyScrolledTo,
        clientH: Math.round(body.clientHeight),
        scrollH: Math.round(body.scrollHeight),
        clientW: Math.round(body.clientWidth),
        scrollW: Math.round(body.scrollWidth),
        hScroll: body.scrollWidth > body.clientWidth + 1,
        lastBottom,
        lastWhat: lastBody ? label(lastBody) : null,
        rectBottom: bodyRectBottom,
        clippedAtBottom: lastBottom != null && lastBottom > bodyRectBottom + 2,
      },
      footBtns,
    };
  }

  return {
    probeVersion: 1,
    at: Date.now(),
    vw, vh,
    dpr: window.devicePixelRatio,
    appReady: window.__appReady === true,
    appChildren: document.querySelectorAll('#app > *').length,
    docW: de.scrollWidth,
    clientW: de.clientWidth,
    docH: de.scrollHeight,
    clientH: de.clientHeight,
    scrollY: Math.round(startScrollY),
    sheetOpen,
    rightOut: Array.from(rightOutMap.values()),
    rightOutTotal,
    small: Array.from(smallMap.values()),
    smallTotal,
    clipped,
    clippedTotal,
    ellipsized,
    topbar,
    pageTop,
    bottomBar,
    sheet,
    fontSizeSample: (() => {
      const el = document.querySelector('#app .card-title, #sheetTitle, .sheet-title, .tab');
      return el ? parseFloat(getComputedStyle(el).fontSize) : null;
    })(),
  };
})()`;

/* ── CDP 连接 ─────────────────────────────── */

let client = null;
let ERRORS = []; // 当前 pass 的页面运行时报错

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const handlers = new Map();
    ws.addEventListener('open', () => resolve({
      ws,
      on(method, handler) { handlers.set(method, handler); },
      send(method, params = {}) {
        const msgId = ++id;
        ws.send(JSON.stringify({ id: msgId, method, params }));
        return new Promise((res, rej) => pending.set(msgId, { res, rej }));
      },
      close() { try { ws.close(); } catch { /* 已经关了 */ } },
    }));
    ws.addEventListener('error', reject);
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method && handlers.has(msg.method)) {
        handlers.get(msg.method)(msg.params);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        const text = d?.exception?.description || d?.text || '';
        ERRORS.push(String(text).split('\n')[0].slice(0, 180));
      }
    });
  });
}

async function evaluate(expression) {
  if (!client) throw new Error('CDP 还没连上');
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面内脚本报错';
    const expr = String(expression).replace(/\s+/g, ' ').slice(0, 100);
    throw new Error(`${desc}\n    出错的那句: ${expr}`);
  }
  return r.result.value;
}

async function waitForNode(expression, what, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const ok = await evaluate(expression);
      if (ok) return true;
    } catch (err) {
      lastErr = err.message; // 页面跳转时执行上下文会被销毁，属正常，继续等
    }
    await sleep(60);
  }
  throw new Error(`等待「${what}」超时（${timeout / 1000}s）${lastErr ? `：${lastErr}` : ''}`);
}

const SHEET_OPEN = `(() => { const r = document.querySelector('#sheetRoot'); return !!r && !r.classList.contains('hidden'); })()`;

async function waitSheetTitle(includes, timeout = 10000) {
  await waitForNode(`(() => {
    const r = document.querySelector('#sheetRoot');
    if (!r || r.classList.contains('hidden')) return false;
    const t = document.querySelector('#sheetTitle');
    return !!t && t.textContent.indexOf(${JSON.stringify(includes)}) >= 0;
  })()`, `弹层标题包含「${includes}」`, timeout);
}

async function waitSheetEl(selector, timeout = 10000) {
  await waitForNode(`(() => {
    const r = document.querySelector('#sheetRoot');
    if (!r || r.classList.contains('hidden')) return false;
    return !!document.querySelector(${JSON.stringify(selector)});
  })()`, `弹层里出现 ${selector}`, timeout);
}

async function click(sel) {
  const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  if (!ok) throw new Error(`找不到可点元素：${sel}`);
}

async function clickExpr(expr, desc) {
  const ok = await evaluate(expr);
  if (ok === false) throw new Error(`点击目标不存在：${desc}`);
  return ok;
}

async function closeSheetNow() {
  for (let i = 0; i < 4; i++) {
    const open = await evaluate(SHEET_OPEN);
    if (!open) return;
    await evaluate(`(() => { const b = document.querySelector('#sheetClose'); if (b) b.click(); return true; })()`);
    await sleep(60);
  }
  const stillOpen = await evaluate(SHEET_OPEN);
  if (stillOpen) throw new Error('弹层关不掉（点了 #sheetClose 也没关）');
}

/* ── 页面状态准备 ─────────────────────────── */

async function navigate() {
  const beforeOrigin = await evaluate('performance.timeOrigin').catch(() => 0);
  await client.send('Page.navigate', { url: BASE + '/' });
  // 必须等「新文档」而不是旧页面：单纯等 __appReady 会在旧页面上立刻满足（曾经的坑）
  await waitForNode(`performance.timeOrigin !== ${beforeOrigin} && window.__appReady === true`, '页面启动', 20000);
}

async function disableMotion() {
  await evaluate(`(() => {
    let s = document.getElementById('audit-nomotion');
    if (!s) { s = document.createElement('style'); s.id = 'audit-nomotion'; s.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'; document.head.appendChild(s); }
    return true;
  })()`);
}

async function applyFontScale(scale) {
  const pct = Math.round(scale * 100);
  const sampleExpr = `(() => { const el = document.querySelector('#app .card-title, #sheetTitle, .tab'); return el ? parseFloat(getComputedStyle(el).fontSize) : null; })()`;
  const before = await evaluate(sampleExpr);
  // 方法一：根字号（rem 路径）。项目如果全用 px，这一步应当完全没效果 —— 这个证据要写进报告。
  await evaluate(`document.documentElement.style.fontSize = '${pct}%'`);
  await sleep(80);
  const afterRoot = await evaluate(sampleExpr);
  // 方法二：text-size-adjust（近似 Android 的系统字体缩放，只放大文字、不放大固定 px 盒子）
  await evaluate(`(() => {
    let s = document.getElementById('audit-font-scale');
    if (!s) { s = document.createElement('style'); s.id = 'audit-font-scale'; document.head.appendChild(s); }
    s.textContent = 'html { -webkit-text-size-adjust: ${pct}% !important; text-size-adjust: ${pct}% !important; }';
    return true;
  })()`);
  await sleep(150);
  let after = await evaluate(sampleExpr);
  let method = 'text-size-adjust';
  if (!(after > before * 1.05)) {
    // 兜底：逐元素把计算后的字号乘上去（近似系统字体缩放）
    await evaluate(`(() => {
      window.__auditFontScaled = true;
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none') continue;
        const fs = parseFloat(cs.fontSize);
        if (!fs) continue;
        el.style.setProperty('font-size', (fs * ${scale}).toFixed(2) + 'px', 'important');
      }
      return true;
    })()`);
    await sleep(120);
    after = await evaluate(sampleExpr);
    method = 'inline-font-size';
  }
  return { scale, pct, method, before, afterRoot, after, effective: after != null && before != null && after > before * 1.05 };
}

async function preparePage(scale) {
  await navigate();
  await disableMotion();
  if (scale) return applyFontScale(scale);
  return null;
}

const SEED_STATE = `(async () => {
  const store = await import('./js/store.js');
  const calc = await import('./js/calc.js');
  const st = store.emptyState();
  st.profile = store.demoProfile();
  // lastSeenVersion：自检造的存档要算「已经看过当前版本」，否则启动会弹更新说明盖住要点的弹层
  st.settings = { trainDays: 3, stepsKey: 'mid', mode: 'basic', onboarded: true, recordTab: 'food', lastSeenVersion: ${JSON.stringify(appVersion())} };
  const t = calc.calcTargets(st.profile);
  for (let i = 0; i < 6; i++) {
    const key = store.shiftDate(store.todayKey(), -i);
    store.demoEntries(st, key, t);
  }
  store.addWeight(st, store.shiftDate(store.todayKey(), -6), 59.2);
  store.addWeight(st, store.shiftDate(store.todayKey(), -1), 58.4);
  store.addWeight(st, store.todayKey(), 58);
  localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
  return true;
})()`;

async function goView(view) {
  await closeSheetNow();
  await click(`.tab[data-view="${view}"]`);
  await waitForNode(`document.querySelector('#app > *') !== null`, `切到 ${view} 页`);
}

async function goLogFood() {
  await closeSheetNow();
  await click('.tab[data-view="log"]');
  await waitForNode(`document.querySelector('#recordTabs') !== null`, '记录页');
  const tab = await evaluate(`document.querySelector('#recordTabs .seg-btn.on') ? document.querySelector('#recordTabs .seg-btn.on').dataset.recordTab : ''`);
  if (tab === 'training') await click('[data-record-tab="food"]');
  await waitForNode(`document.querySelector('#quickText') !== null`, '记录页·吃的');
}

/* ── 判断：把测量结果翻译成「问题」 ────────── */

function judge(probe, step) {
  const issues = [];
  // subject 用来把「同一个根因」的问题归到一组（例如日历弹层 / 顶栏长文案），
  // 报告第 0 节按 subject+type 去重，避免「日历坏了」在 4 个尺寸 × 3 种字号里重复 24 条。
  const add = (level, type, detail, subject = '') => issues.push({ level, type, detail, subject });
  const pageSubject = step.passId === 'longtext' ? '长文案组合（长日期 / 8 字昵称 / 大字号）' : '';
  const sheetSubject = step.id === 'sheet-calendar' ? '日历弹层' : '弹层';
  if (!probe) { add('事故级', '探测失败', '页面没有返回测量结果'); return issues; }
  if (!probe.appReady) add('事故级', '页面没启动（白屏）', 'window.__appReady !== true');
  if (step.kind === 'page' && probe.appChildren === 0) add('事故级', '页面内容为空', '#app 下没有任何元素');

  // 1) 横向溢出（文档级）
  if (probe.docW > probe.clientW + TOL) {
    add('事故级', '横向溢出', `文档可滚动宽 ${probe.docW}px > 视口宽 ${probe.clientW}px（多出 ${probe.docW - probe.clientW}px）`, pageSubject);
  }
  // 2) 元素右边界超出视口
  if (probe.rightOut.length) {
    const list = probe.rightOut.slice(0, 6).map((o) => `${o.what} right=${o.right}px${o.count > 1 ? `（${o.count} 处）` : ''}`).join('；');
    const level = probe.docW > probe.clientW + TOL ? '严重' : '事故级';
    add(level, '元素超出视口右边界', `${probe.rightOutTotal} 处：${list}`, step.kind === 'sheet' ? sheetSubject : pageSubject);
  }
  // 3) 触摸目标（弹层的关闭按钮单独在弹层那一节判，避免同一个按钮报两遍）
  const small = (probe.small || []).filter((s) => !(step.kind === 'sheet' && s.what.indexOf('#sheetClose') >= 0));
  const isSev = (s) => s.h < 32 && s.cat === 'primary-control';
  const sev = small.filter(isSev);
  const minor = small.filter((s) => !isSev(s) && s.cat !== 'inline-link');
  const inlineLinks = small.filter((s) => s.cat === 'inline-link');
  if (sev.length) add('严重', '触摸目标过小（主要操作）', `${probe.smallTotal} 个可点元素里，${sev.length} 个主要操作 <32px：${sev.slice(0, 6).map((s) => `${s.what} 高 ${s.h}px`).join('；')}`);
  if (minor.length) add('一般', '触摸目标偏小（<40px）', `共 ${probe.smallTotal} 个可点元素偏小：${minor.slice(0, 6).map((s) => `${s.what} 高 ${s.h}px`).join('；')}`);
  if (inlineLinks.length) add('建议', '行内小链接（可能是设计如此）', inlineLinks.slice(0, 4).map((s) => `${s.what} 高 ${s.h}px`).join('；'));

  // 4) 底栏遮挡最后一条内容（仅页面）
  if (step.kind === 'page' && probe.bottomBar && !probe.bottomBar.skipped) {
    const bb = probe.bottomBar;
    if (!bb.barVisible) add('严重', '底部标签栏不可见', '.tabbar 宽度或高度为 0');
    else if (bb.covered) add('事故级', '底栏遮住最后一条内容', `滚到页面最底后，「${bb.lastWhat}」底部 ${bb.lastBottom}px 仍低于底栏顶 ${bb.barTop}px（被遮约 ${bb.overlap}px）`);
  }
  // 5) 顶部：日期被挤多行 / 首屏内容被顶栏压住
  if (probe.topbar) {
    if (probe.topbar.dateLines >= 2) add('一般', '顶部日期被挤成多行', `#dateText「${probe.topbar.dateText}」占 ${probe.topbar.dateLines} 行，顶栏高 ${probe.topbar.h}px`, '顶栏（长日期 + 长昵称）');
    if (probe.topbar.h > probe.vh * 0.22) add('严重', '顶栏占掉太多屏幕', `顶栏高 ${probe.topbar.h}px，视口高 ${probe.vh}px`, '顶栏（长日期 + 长昵称）');
  }
  if (step.kind === 'page' && probe.pageTop && probe.pageTop.firstTop !== null && probe.pageTop.firstTop < probe.pageTop.topbarBottom - TOL) {
    add('一般', '首屏内容被顶栏压住', `#app 首个元素 top=${probe.pageTop.firstTop}px < 顶栏底 ${probe.pageTop.topbarBottom}px`);
  }
  // 6) 文字溢出容器 / 按钮文字被裁
  // 轻微超出（≤8px，多半是图标/单个字符）和明显被裁分开报，避免把“emoji 超 4px”说成严重事故
  const clippedSevere = probe.clipped.filter((c) => c.overX > 8 || c.overY > 8);
  const clippedMinor = probe.clipped.filter((c) => c.overX <= 8 && c.overY <= 8);
  if (clippedSevere.length) {
    add('严重', '文字溢出容器/按钮文字被裁', `${probe.clippedTotal} 处：${clippedSevere.slice(0, 6).map((c) => `${c.what} 内容宽 ${c.sw}px > 容器 ${c.cw}px（超 ${c.overX}px）`).join('；')}`);
  }
  if (clippedMinor.length) {
    add('一般', '内容轻微超出固定小盒子（多半是图标）', clippedMinor.slice(0, 6).map((c) => `${c.what} 超 ${Math.max(c.overX, c.overY)}px（容器 ${c.cw}px）`).join('；'));
  }
  if (probe.ellipsized.length) add('建议', '按设计省略号截断（不是 bug）', probe.ellipsized.slice(0, 4).map((c) => `${c.what}（${c.cw}px）`).join('；'));

  // 7) 弹层
  if (step.kind === 'sheet') {
    const sh = probe.sheet;
    if (!sh || !sh.open) {
      add('事故级', '弹层没打开', '未能验证该弹层的排版');
    } else {
      if (!sh.inView) add('事故级', '弹层超出视口', `rect top=${sh.rect.top} bottom=${sh.rect.bottom} left=${sh.rect.left} right=${sh.rect.right}（视口 ${probe.vw}×${probe.vh}）`);
      if (!sh.close.inView || !sh.close.hittable) {
        add('事故级', '关闭按钮点不到', `关闭按钮高 ${sh.close.h}px，在视口内=${sh.close.inView}，elementFromPoint 能点到=${sh.close.hittable}`);
      } else if (sh.close.h < 40) {
        add('一般', '关闭按钮触摸目标偏小', `#sheetClose 高 ${sh.close.h}px（建议 ≥40px）`);
      }
      if (sh.body.needsScroll && !sh.body.canScroll) {
        add('严重', '弹层内容滚不动', `内容高 ${sh.body.scrollH}px > 可见 ${sh.body.clientH}px，但滚不到底（scrolledTo=${sh.body.scrolledTo}）`);
      }
      if (sh.body.needsScroll && sh.body.clippedAtBottom) {
        add('严重', '弹层内容被裁在底部', `滚到底后最后一行底部 ${sh.body.lastBottom}px 仍超出内容区底部 ${sh.body.rectBottom}px`);
      }
      if (sh.body.hScroll) {
        add('事故级', '弹层内容横向溢出（右侧被裁/要横着滑才看得全）', `内容宽 ${sh.body.scrollW}px > 可见宽 ${sh.body.clientW}px（多出 ${sh.body.scrollW - sh.body.clientW}px）`, sheetSubject);
      }
      const badFoot = sh.footBtns.filter((b) => !b.inView || !b.hittable);
      if (badFoot.length) add('事故级', '弹层底部按钮点不到', badFoot.map((b) => `${b.what}：在视口内=${b.inView}，能点到=${b.hittable}`).join('；'));
      const smallFoot = sh.footBtns.filter((b) => b.h < 40);
      if (smallFoot.length) add('一般', '弹层底部按钮触摸目标偏小', smallFoot.map((b) => `${b.what} 高 ${b.h}px`).join('；'));
    }
  }
  return sortIssues(issues);
}

/* ── 截图 / 单个界面检查 ───────────────────── */

let CUR = null; // 当前 pass 的上下文：{ size, passId, passLabel, scale, captureAll }

function shotName(id, suffix = '') {
  const base = `${CUR.size.label}__${CUR.passId}__${id}${suffix ? '__' + suffix : ''}`;
  return path.join(SHOTS, `${base}.png`);
}

// 大字号模式下固定留几张截图，方便人眼确认「文字有没有挤在一起」（断言抓不到这类主观问题）
const FONT_WATCH = new Set([
  'welcome', 'tab-today', 'tab-log-food', 'tab-log-training', 'tab-plan', 'tab-progress',
  'sheet-calendar', 'sheet-settings', 'sheet-quick-draft', 'sheet-growth',
]);

function metricsFor(dpr) {
  const size = (CUR && CUR.size) || SIZES[0];
  return {
    width: size.w,
    height: size.h,
    deviceScaleFactor: dpr,
    mobile: true,
    screenOrientation: size.landscape
      ? { type: 'landscapePrimary', angle: 90 }
      : { type: 'portraitPrimary', angle: 0 },
  };
}

async function screenshot(file) {
  // 截图存成 1x CSS 像素：排版问题看的是位置/裁切，不需要 2x 大图（几百张 2x PNG 会占几十 MB）。
  // 注意：测量始终在 dpr=2 下做的；这里只是截图瞬间把 dpr 临时降成 1，拍完恢复。
  const plain = !CUR || SHOT_DPR === 2;
  let shot;
  if (plain) {
    const info = await evaluate(`({ y: window.scrollY, w: document.documentElement.clientWidth, h: document.documentElement.clientHeight })`);
    shot = await client.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
      clip: { x: 0, y: info.y, width: info.w, height: info.h, scale: 1 },
    });
  } else {
    await client.send('Emulation.setDeviceMetricsOverride', metricsFor(SHOT_DPR));
    await sleep(25);
    try {
      const info = await evaluate(`({ y: window.scrollY, w: document.documentElement.clientWidth, h: document.documentElement.clientHeight })`);
      shot = await client.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false,
        clip: { x: 0, y: info.y, width: info.w, height: info.h, scale: 1 },
      });
    } finally {
      await client.send('Emulation.setDeviceMetricsOverride', metricsFor(2));
      await sleep(25);
    }
  }
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return file;
}

async function runStep(id, label, kind, prep) {
  const step = { id, label, kind };
  try {
    if (prep) await prep();
    // 清掉前一步可能留下的临时提示条 / 庆祝动画：它们不在本次断言范围内，
    // 但会盖在截图和顶栏上（例如「我的」页的记体重按钮会顺带弹一句校验提示）。
    await evaluate(`(() => {
      document.querySelectorAll('.toast').forEach((t) => t.remove());
      document.querySelectorAll('.celebrate').forEach((t) => t.remove());
      return true;
    })()`);
    const probe = await evaluate(PROBE_EXPR);
    const issues = judge(probe, step);
    const needShot = CUR.captureAll
      || issues.some((i) => i.level === '事故级' || i.level === '严重')
      || issues.some((i) => /文字|溢出|换行|顶栏|超出固定/.test(i.type))
      || (CUR.passId.indexOf('font') === 0 && FONT_WATCH.has(id));
    let shot = null;
    if (needShot && !NO_SHOTS) shot = await screenshot(shotName(id));
    let shotBottom = null;
    if (issues.some((i) => i.type === '底栏遮住最后一条内容') && !NO_SHOTS) {
      await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
      shotBottom = await screenshot(shotName(id, 'bottom'));
      await evaluate(`window.scrollTo(0, 0)`);
    }
    const res = { size: CUR.size.label, passId: CUR.passId, passLabel: CUR.passLabel, id, label, kind, probe, issues, shot, shotBottom };
    CUR.results.push(res);
    return res;
  } catch (err) {
    console.error(`   ⚠️  [${CUR.size.label} ${CUR.passId}] ${id} 探测失败：${String(err.message || err).split('\n')[0]}`);
    let shot = null;
    try { if (!NO_SHOTS) shot = await screenshot(shotName(id, 'error')); } catch { /* 截不到图也不影响判定 */ }
    try { await closeSheetNow(); } catch { /* 关不掉就交给下一步的导航 */ }
    const res = {
      size: CUR.size.label, passId: CUR.passId, passLabel: CUR.passLabel, id, label, kind,
      probe: null,
      issues: [{ level: '事故级', type: '界面无法进入/探测失败', detail: String(err.message || err) }],
      shot, shotBottom: null,
    };
    CUR.results.push(res);
    return res;
  }
}

/* ── 一个 pass：同一套界面在一种字号下跑一遍 ── */

async function runPass(size, { passId, passLabel, scale, captureAll }) {
  CUR = { size, passId, passLabel, scale, captureAll: Boolean(captureAll) && !NO_SHOTS, results: [] };
  ERRORS = [];
  const t0 = Date.now();
  console.log(`\n── ${size.label} · ${passLabel} ──`);

  await evaluate(`(() => { try { localStorage.clear(); } catch (e) { /* 隐私模式也继续 */ } return true; })()`);
  const font = await preparePage(scale);

  // ── 欢迎页 + 找回记录（无资料状态）──
  await runStep('welcome', '欢迎页', 'page');
  await runStep('sheet-recover', '弹层·找回记录（恢复）', 'sheet', () => openSheetByClick(`(() => { const b = document.querySelector('[data-act="recover"]'); if (!b) return false; b.click(); return true; })()`, '找回记录'));
  await closeSheetNow();

  // ── 新手引导 4 步 ──
  await runStep('onboard-1', '引导 1/4·先说三件事', 'sheet', () => openSheetByClick(`(() => { const b = document.querySelector('[data-act="onboard"]'); if (!b) return false; b.click(); return true; })()`, '先说三件事'));
  await runStep('onboard-2', '引导 2/4·填资料', 'sheet', async () => { await click('#obNext'); await waitSheetEl('#pHeight'); });
  await runStep('onboard-3', '引导 3/4·用 AI 帮你记', 'sheet', async () => { await click('#pSave'); await waitSheetEl('#obSkip'); });
  await runStep('onboard-4', '引导 4/4·最后一步', 'sheet', async () => { await click('#obSkip'); await waitSheetEl('#obGo'); });
  await clickExpr(`(() => { const b = document.querySelector('#obLater'); if (!b) return false; b.click(); return true; })()`, '我先随便看看');
  await waitForNode(`document.querySelector('.big-log') !== null`, '引导结束回到今天页', 12000);

  // ── 造一份有 6 天记录的示例档（保证「经验总结」「成长」「我的」都有内容可排）──
  await evaluate(SEED_STATE);
  await preparePage(scale);

  // ── 四个标签页（记录页有吃的/练的两个分段）──
  await runStep('tab-today', '标签·今天', 'page');
  await runStep('tab-log-food', '标签·记录（吃的）', 'page', () => goLogFood());
  await runStep('tab-log-training', '标签·记录（练的）', 'page', async () => {
    await click('[data-record-tab="training"]');
    await waitForNode(`document.querySelector('#trainCardio') || document.querySelector('#trainStrength')`, '记录页·练的面板');
  });
  await runStep('tab-plan', '标签·计划', 'page', () => goView('plan'));
  await runStep('tab-progress', '标签·我的', 'page', () => goView('progress'));

  // ── 弹层 1：加食物搜索 → 份量 ──
  await runStep('sheet-food-search', '弹层·加食物搜索', 'sheet', async () => {
    await goView('today');
    await click('[data-act="add-food"]');
    await waitSheetEl('#foodSearch');
    await evaluate(`(() => { const i = document.querySelector('#foodSearch'); i.value = '鸡胸'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await waitForNode(`document.querySelector('#foodResults [data-pick]') !== null`, '搜索结果');
  });
  await runStep('sheet-food-amount', '弹层·份量', 'sheet', async () => {
    await click('#foodResults [data-pick]');
    await waitSheetEl('#amountInput');
  });
  await closeSheetNow();

  // ── 弹层 2：「说一句」没配 AI 的说明（本地自检没有密钥，只能走这条）──
  await runStep('sheet-quick-draft', '弹层·说一句（没配 AI）', 'sheet', async () => {
    await goLogFood();
    const ok = await evaluate(`(() => {
      const ta = document.querySelector('#quickText');
      if (!ta) return false;
      ta.value = '今天中午在食堂吃了碗牛肉面，加了个蛋';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#quickParse').click();
      return true;
    })()`);
    if (!ok) throw new Error('记录页没有 #quickText');
    await waitForNode(`(() => { const r = document.querySelector('#sheetRoot'); if (!r || r.classList.contains('hidden')) return false; return !!document.querySelector('#draftHost .warn'); })()`, '没配 AI 的说明弹层', 15000);
  });
  await closeSheetNow();

  // ── 弹层 3：加运动 ──
  await runStep('sheet-add-exercise', '弹层·加运动', 'sheet', async () => {
    await goView('today');
    await click('[data-act="add-exercise"]');
    await waitSheetEl('#exChips');
  });
  await closeSheetNow();

  // ── 弹层 4：我的成长 ──
  await runStep('sheet-growth', '弹层·我的成长', 'sheet', async () => {
    await goView('today');
    await click('.plant-card');
    await waitSheetTitle('我的成长');
  });
  await closeSheetNow();

  // ── 弹层 5：你的规律（经验总结）──
  await runStep('sheet-insights', '弹层·你的规律（经验总结）', 'sheet', async () => {
    await goView('today');
    await clickExpr(`(() => { const b = document.querySelector('[data-act="insights"]'); if (!b) return false; b.click(); return true; })()`, '今天页「看全部规律」');
    await waitSheetTitle('你的规律');
  });
  await closeSheetNow();

  // ── 弹层 6：照包装营养成分表（旧版是「新增自定义食物」，元素从 #cfName 换成 #labelName）──
  await runStep('sheet-custom-food', '弹层·照包装营养成分表', 'sheet', async () => {
    await goLogFood();
    await click('#customFoodBtn');
    await waitSheetEl('#labelName');
  });
  await closeSheetNow();

  // ── 弹层 7：替代动作（计划页折叠区里）──
  await runStep('sheet-plan-sub', '弹层·替代动作', 'sheet', async () => {
    await goView('plan');
    const ok = await evaluate(`(() => {
      const d = Array.prototype.find.call(document.querySelectorAll('#app details'), (x) => x.textContent.indexOf('替代方案') >= 0);
      if (!d) return false;
      d.open = true;
      const row = d.querySelector('[data-subs]');
      if (!row) return false;
      row.click();
      return true;
    })()`);
    if (ok === false) throw new Error('计划页没有替代方案入口');
    await waitForNode(`(() => { const r = document.querySelector('#sheetRoot'); if (!r || r.classList.contains('hidden')) return false; const t = document.querySelector('#sheetTitle'); return !!t && t.textContent.indexOf('做不了') >= 0; })()`, '替代动作弹层');
  });
  await closeSheetNow();

  // ── 弹层 8：记体重 ──
  await runStep('sheet-weight', '弹层·记体重', 'sheet', async () => {
    await goView('progress');
    await click('[data-act="log-weight"]');
    await waitSheetEl('#wInput');
  });
  await closeSheetNow();

  // ── 弹层 9：日历 ──
  await runStep('sheet-calendar', '弹层·日历', 'sheet', async () => {
    await click('#dateLabel');
    await waitForNode(`(() => { const r = document.querySelector('#sheetRoot'); if (!r || r.classList.contains('hidden')) return false; const t = document.querySelector('#sheetTitle'); return !!t && t.textContent.indexOf('年') >= 0; })()`, '日历弹层');
  });
  await closeSheetNow();

  // ── 弹层 10：设置 + 它下面的 6 个子页 ──
  await runStep('sheet-settings', '弹层·设置', 'sheet', async () => {
    await click('#profileBtn');
    await waitSheetTitle('设置');
  });
  await runStep('sheet-profile', '弹层·我的资料', 'sheet', () => openFromSettings('[data-set="profile"]', '我的资料'));
  await runStep('sheet-ai-settings', '弹层·AI 设置', 'sheet', () => openFromSettings('[data-set="ai"]', 'AI 设置'));
  await runStep('sheet-backup', '弹层·数据与备份', 'sheet', () => openFromSettings('[data-set="backup"]', '数据与备份'));
  await runStep('sheet-wipe', '弹层·从头开始（清除）', 'sheet', () => openFromSettings('[data-set="wipe"]', '从头开始'));
  await runStep('sheet-about', '弹层·关于', 'sheet', () => openFromSettings('[data-set="about"]', '关于'));
  await runStep('sheet-guide-review', '弹层·重看新手引导', 'sheet', async () => {
    await openFromSettings('[data-set="guide"]', '先说三件事', 15000);
  });
  await closeSheetNow();

  const durationMs = Date.now() - t0;
  const issueCount = CUR.results.reduce((a, r) => a + r.issues.length, 0);
  console.log(`   完成 ${CUR.results.length} 个界面，${issueCount} 条问题，用时 ${(durationMs / 1000).toFixed(1)}s${font ? `；字号放大方式=${font.method}（${font.before}px → ${font.after}px）` : ''}`);
  if (ERRORS.length) console.log(`   页面运行时报错 ${ERRORS.length} 条：${ERRORS.slice(0, 3).join(' | ')}`);

  return { passId, passLabel, results: CUR.results, font, durationMs, consoleErrors: [...ERRORS] };
}

async function openSheetByClick(expr, titleIncludes, timeout = 10000) {
  await clickExpr(expr, titleIncludes);
  await waitSheetTitle(titleIncludes, timeout);
}

async function openFromSettings(selectSel, titleIncludes, timeout = 10000) {
  // 设置弹层在子页打开后会被替换，所以每次都先关掉、再从头打开设置
  await closeSheetNow();
  await click('#profileBtn');
  await waitSheetTitle('设置');
  await click(selectSel);
  await waitSheetTitle(titleIncludes, timeout);
}

/* ── 长昵称（资料表单允许 8 个字，是真实可输入的边界）── */

async function runLongText(size) {
  CUR = { size, passId: 'longtext', passLabel: '长文案组合（长日期 / 8 字昵称 / 大字号）', scale: null, captureAll: !NO_SHOTS, results: [] };
  ERRORS = [];
  console.log(`\n── ${size.label} · ${CUR.passLabel} ──`);
  const setNickname = (nick) => evaluate(`(() => {
    try {
      const st = JSON.parse(localStorage.getItem('fatloss.state.v2') || '{}');
      st.profile = Object.assign({}, st.profile, { nickname: ${JSON.stringify(nick)} });
      localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
    } catch (e) { /* 读不出来就按欢迎页测，报告里会体现 */ }
    return true;
  })()`);
  const goPastDate = async () => {
    await goView('today');
    // 顶栏日期在“今天”时只显示「今天」两个字；要测长文案得退到别的日子（显示成「10月17日 周六」）
    for (let i = 0; i < 3; i++) { await click('#prevDay'); await sleep(120); }
  };

  const hasProfile = await evaluate(`(() => { try { const st = JSON.parse(localStorage.getItem('fatloss.state.v2') || '{}'); return !!st.profile; } catch (e) { return false; } })()`);
  if (!hasProfile) {
    await evaluate(SEED_STATE);
    await preparePage(null);
  }

  // 一、常用昵称（2 字）+ 长日期 + 正常字号：日常看历史日期的样子
  await setNickname('小繁');
  await preparePage(null);
  await goPastDate();
  await runStep('longdate-normal', '今天页（非今天日期 + 常用昵称，正常字号）', 'page');

  // 二、最长昵称（资料表单上限 8 字）+ 长日期，正常字号
  await setNickname('一二三四五六七八');
  await preparePage(null);
  await goPastDate();
  await runStep('longtext-normal', '今天页（8 字昵称 + 长日期，正常字号）', 'page');
  // 三、最长昵称 + 长日期 + 130% / 150% 字号：最坏组合
  try {
    await applyFontScale(1.3);
    await runStep('longtext-font130', '今天页（8 字昵称 + 长日期 + 大字号 130%，模拟）', 'page');
  } catch (err) {
    console.error(`   长昵称+130% 组合探测失败：${String(err.message || err).split('\n')[0]}`);
  }
  try {
    await applyFontScale(1.5);
    await runStep('longtext-font150', '今天页（8 字昵称 + 长日期 + 大字号 150%，模拟）', 'page');
  } catch (err) {
    console.error(`   长昵称+150% 组合探测失败：${String(err.message || err).split('\n')[0]}`);
  }
  console.log(`   长文案组合：${CUR.results.length} 个界面检查，${CUR.results.reduce((a, r) => a + r.issues.length, 0)} 条问题`);
  return { passId: 'longtext', passLabel: CUR.passLabel, results: CUR.results };
}

/* ── 反向验证：证明断言真的能抓住问题 ────────
 * 这一步是自检的「自检」。注入一个必然违规的元素 → 断言必须报红；
 * 移除后必须恢复全绿。任何一条没抓住，说明断言是摆设，必须重写。
 */
async function reverseValidate() {
  await closeSheetNow();
  await goView('today');
  const cases = [];

  // 1) 横向溢出：注入 1200px 宽的元素
  await evaluate(`(() => {
    const d = document.createElement('div');
    d.id = 'audit-wide';
    d.style.cssText = 'position:absolute;left:0;top:90px;width:1200px;height:18px;background:#f00;z-index:9999';
    document.body.appendChild(d);
    return true;
  })()`);
  let p = await evaluate(PROBE_EXPR);
  cases.push({
    name: '注入 width:1200px 的元素',
    expect: '「横向溢出」断言报红',
    caught: p.docW > p.clientW + TOL && p.rightOut.some((o) => o.what.indexOf('audit-wide') >= 0),
    measured: `文档宽 ${p.docW}px / 视口 ${p.clientW}px，超界元素 ${p.rightOut.length} 个`,
  });
  await evaluate(`document.getElementById('audit-wide')?.remove()`);

  // 2) 触摸目标：注入 20px 高的按钮
  await evaluate(`(() => {
    const b = document.createElement('button');
    b.id = 'audit-small';
    b.textContent = '反验证按钮';
    b.style.cssText = 'position:fixed;left:8px;top:200px;height:20px;width:90px;z-index:9999';
    document.body.appendChild(b);
    return true;
  })()`);
  p = await evaluate(PROBE_EXPR);
  cases.push({
    name: '注入 height:20px 的按钮',
    expect: '「触摸目标」断言报红',
    caught: p.small.some((s) => s.what.indexOf('audit-small') >= 0),
    measured: `small 列表 ${p.small.length} 项（共 ${p.smallTotal} 个偏小元素）`,
  });
  await evaluate(`document.getElementById('audit-small')?.remove()`);

  // 3) 文字溢出：注入固定 60px 宽、不换行的长文字（放进 #app，和真实内容同一层级）
  //    用「总数 +1」判断，而不是「前 12 条里有没有它」：页面若已有别的溢出项，
  //    列表会被截断，按 id 找会误判成「断言抓不住」（这个坑真踩过）。
  const clipBefore = (await evaluate(PROBE_EXPR)).clippedTotal;
  await evaluate(`(() => {
    const host = document.querySelector('#app') || document.body;
    const d = document.createElement('div');
    d.id = 'audit-clip';
    d.textContent = '这是一段很长很长很长很长不允许换行的文字';
    d.style.cssText = 'position:relative;width:60px;overflow:hidden;white-space:nowrap;font-size:14px;background:#eee;';
    host.appendChild(d);
    return true;
  })()`);
  p = await evaluate(PROBE_EXPR);
  cases.push({
    name: '注入 60px 宽不换行的长文字',
    expect: '「文字溢出容器」断言报红',
    caught: p.clippedTotal > clipBefore,
    measured: `clipped 总数 ${clipBefore} → ${p.clippedTotal}`,
  });
  await evaluate(`document.getElementById('audit-clip')?.remove()`);

  // 4) 底栏遮挡：把底栏临时撑高到 260px（body 留白 88px，这么高必遮住内容）
  await evaluate(`(() => {
    const s = document.createElement('style');
    s.id = 'audit-bartall';
    s.textContent = '.tabbar { height: 260px !important; }';
    document.head.appendChild(s);
    return true;
  })()`);
  p = await evaluate(PROBE_EXPR);
  cases.push({
    name: '把底栏临时撑到 260px 高',
    expect: '「底栏遮住最后一条内容」断言报红',
    caught: Boolean(p.bottomBar && p.bottomBar.covered),
    measured: p.bottomBar ? `最后内容 bottom=${p.bottomBar.lastBottom}px，底栏顶 ${p.bottomBar.barTop}px，被遮 ${p.bottomBar.overlap}px` : '没有底栏数据',
  });
  await evaluate(`document.getElementById('audit-bartall')?.remove()`);

  // 5) 关闭按钮点不到：把弹层关闭按钮盖住
  await click('#profileBtn');
  await waitSheetTitle('设置');
  await evaluate(`(() => {
    const b = document.getElementById('sheetClose');
    const r = b.getBoundingClientRect();
    const d = document.createElement('div');
    d.id = 'audit-closecover';
    d.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;background:#000;z-index:99999';
    document.body.appendChild(d);
    return true;
  })()`);
  p = await evaluate(PROBE_EXPR);
  cases.push({
    name: '用黑色方块盖住弹层关闭按钮',
    expect: '「关闭按钮点不到」断言报红',
    caught: Boolean(p.sheet && p.sheet.close && p.sheet.close.hittable === false),
    measured: p.sheet ? `关闭按钮 hittable=${p.sheet.close.hittable}` : '没有弹层数据',
  });
  await evaluate(`document.getElementById('audit-closecover')?.remove()`);
  p = await evaluate(PROBE_EXPR);
  cases.push({
    name: '移除遮挡后重新检查关闭按钮',
    expect: '恢复为「点得到」',
    caught: Boolean(p.sheet && p.sheet.close && p.sheet.close.hittable === true),
    measured: p.sheet ? `关闭按钮 hittable=${p.sheet.close.hittable}` : '没有弹层数据',
  });
  await closeSheetNow();

  // 6) 注入全部移除后必须恢复全绿（防止反向验证本身污染后续结果）
  p = await evaluate(PROBE_EXPR);
  const leftAudit = p.small.some((s) => s.what.indexOf('audit-') >= 0)
    || p.rightOut.some((o) => o.what.indexOf('audit-') >= 0)
    || p.clipped.some((c) => c.what.indexOf('audit-') >= 0);
  cases.push({
    name: '全部注入移除后',
    expect: '版面恢复全绿、无残留',
    caught: !leftAudit && p.docW <= p.clientW + TOL,
    measured: `文档宽 ${p.docW}px / 视口 ${p.clientW}px，残留注入元素=${leftAudit}`,
  });

  const failed = cases.filter((c) => !c.caught);
  console.log(`   反向验证：${cases.length - failed.length}/${cases.length} 通过${failed.length ? ` ❌ 失败：${failed.map((f) => f.name).join('、')}` : ''}`);
  return { cases, failed: failed.map((f) => f.name), ok: failed.length === 0 };
}

/* ── 报告 ─────────────────────────────────── */

const LEVEL_BADGE = { 事故级: '事故级', 严重: '严重', 一般: '一般', 建议: '建议' };

function cellText(issues) {
  if (!issues.length) return '✅';
  const c = countLevels(issues);
  return ['事故级', '严重', '一般', '建议'].filter((l) => c[l]).map((l) => `${LEVEL_BADGE[l]}×${c[l]}`).join(' ');
}

function issueLine(issue, res, { simulated = false, isNew = false } = {}) {
  const shot = res.shot ? `（截图：\`layout-shots/${path.basename(res.shot)}\`）` : '';
  const bottom = res.shotBottom ? `（滚动到底截图：\`layout-shots/${path.basename(res.shotBottom)}\`）` : '';
  const marks = [simulated ? '【模拟大字号】' : '', isNew ? '【放大后新增】' : ''].filter(Boolean).join('');
  return `- **${issue.level}**${marks}｜${issue.type}：${issue.detail}${shot}${bottom}`;
}

function buildReport({ sizes, passes, longtexts, reverse, css, fontInfo, meta }) {
  const md = [];
  const allResults = passes.flatMap((p) => p.results);
  const normal = allResults.filter((r) => r.passId === 'normal');
  const font130 = allResults.filter((r) => r.passId === 'font130');
  const font150 = allResults.filter((r) => r.passId === 'font150');
  const lt = longtexts.flatMap((p) => p.results);
  const allIssues = [...allResults, ...lt].flatMap((r) => r.issues);
  const total = countLevels(allIssues);
  const fatal = total['事故级'] + total['严重'];
  const reverseFailed = Boolean(reverse && !reverse.ok);

  md.push('# 排版自检报告（小屏 · 横屏 · 系统大字号）');
  md.push('');
  md.push(`- 生成时间：${meta.generatedAt}`);
  md.push(`- 浏览器：${meta.chromeVersion}（无头模式；视口用 CDP Emulation.setDeviceMetricsOverride，mobile:true，deviceScaleFactor:2）`);
  md.push(`- 测试对象：运行开始时拍的**文件快照**（${meta.snapshotFiles} 个文件，sha256 短 hash \`${meta.snapshotHash}\`），用脚本内置静态服务在 ${meta.base} 提供。`);
  md.push('  这样即使测试期间别人还在改 js/css，同一轮跑出来的数字也不会混两个版本。');
  md.push(`- 产物：\`.audit/layout-shots/\`（截图）、\`.audit/layout-report.json\`（原始测量数据）`);
  md.push(`- 结论：共检查 **${allResults.length + lt.length} 个「尺寸 × 界面 × 字号」组合**；`);
  md.push(`  发现 **事故级 ${total['事故级']} · 严重 ${total['严重']} · 一般 ${total['一般']} · 建议 ${total['建议']}**，退出码 **${fatal || reverseFailed ? 1 : 0}**。`);
  md.push('');

  // 0. 最该先修
  md.push('## 0. 最该先修的（事故级 / 严重，按问题去重）');
  md.push('');
  const severeAll = [...allResults, ...lt]
    .flatMap((r) => r.issues.filter((i) => i.level === '事故级' || i.level === '严重').map((i) => ({ r, i })));
  if (!severeAll.length) {
    md.push('本轮没有事故级/严重问题。下面的一般/建议项按优先级排。');
    md.push('');
  } else {
    const subjectOf = (i) => i.subject || '';
    const groups = new Map();
    for (const x of severeAll) {
      const subject = subjectOf(x.i);
      const key = `${x.i.level}||${x.i.type}||${subject}`;
      const g = groups.get(key) || { type: x.i.type, subject, level: x.i.level, count: 0, first: x, sizes: new Set(), passes: new Set() };
      g.count += 1;
      g.sizes.add(x.r.size.replace('x', '×'));
      g.passes.add(x.r.passId === 'normal' ? '正常字号' : x.r.passId === 'font130' ? '130%' : x.r.passId === 'font150' ? '150%' : '长文案');
      groups.set(key, g);
    }
    let gi = 0;
    for (const g of [...groups.values()].sort((a, b) => (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) || b.count - a.count)) {
      gi += 1;
      md.push(`### ${gi}. ${g.level}｜${g.subject ? g.subject + '：' : ''}${g.type}`);
      md.push('');
      md.push(`- 出现 **${g.count} 次**：尺寸 ${[...g.sizes].join(' / ')}；字号 ${[...g.passes].join(' / ')}`);
      md.push(`- 实际数值（第一次出现）：${g.first.i.detail}`);
      md.push(`- 截图：\`layout-shots/${path.basename(g.first.r.shot || '')}\`（${g.first.r.size.replace('x', '×')} · ${g.first.r.passLabel}）`);
      const others = severeAll.filter((x) => x.i.type === g.type && subjectOf(x.i) === g.subject && !(x.r === g.first.r && x.i === g.first.i));
      if (others.length) {
        md.push(`- 还出现在：${others.slice(0, 12).map((x) => `${x.r.size.replace('x', '×')}·${x.r.passLabel}·${x.r.label}`).join('；')}${others.length > 12 ? ` 等 ${others.length} 处` : ''}`);
      }
      md.push('');
    }
  }
  if (reverseFailed) {
    md.push(`> ⚠️ **反向验证失败**（${reverse.failed.join('、')}）：断言抓不住已知问题，本报告的「全部通过」不可信。`);
    md.push('');
  }
  // 一般/建议里最值得看的（按类型聚一下，避免几十条同名问题淹没重点）
  const minorAll = [...allResults, ...lt].flatMap((r) => r.issues.filter((i) => i.level === '一般' || i.level === '建议').map((i) => ({ r, i })));
  if (minorAll.length) {
    const group = new Map();
    for (const x of minorAll) {
      const key = `${x.i.level}｜${x.i.type}`;
      const g = group.get(key) || { count: 0, example: null, levels: new Set() };
      g.count += 1;
      g.levels.add(x.r.size);
      if (!g.example) g.example = x;
      group.set(key, g);
    }
    md.push('### 一般 / 建议里值得看一眼的（按类型汇总）');
    md.push('');
    md.push('| 级别 | 类型 | 次数 | 涉及的尺寸 | 例子（第一次出现） |');
    md.push('| --- | --- | --- | --- | --- |');
    for (const [key, g] of [...group.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12)) {
      const [level, type] = key.split('｜');
      const ex = g.example;
      md.push(`| ${level} | ${mdEscape(type)} | ${g.count} | ${[...g.levels].join(' / ')} | ${mdEscape(ex.r.label)}：${mdEscape(ex.i.detail).slice(0, 90)} |`);
    }
    md.push('');
  }

  // 1. 断言规则
  md.push('## 1. 测什么、怎么判');
  md.push('');
  md.push('每个「尺寸 × 界面」都跑下面 7 类断言（阈值写在括号里，判断都在页面里用真实 `getBoundingClientRect` / `scrollWidth` 量）：');
  md.push('');
  md.push('| # | 断言 | 判定 |');
  md.push('| --- | --- | --- |');
  md.push('| 1 | 无横向溢出 | `documentElement.scrollWidth <= clientWidth + 1` |');
  md.push('| 2 | 没有可见元素右边界超出视口 | 可见元素 `rect.right > clientWidth + 1` 或 `rect.left < -1` 逐个报出（视口宽以 `documentElement.clientWidth` 为准） |');
  md.push('| 3 | 可点元素触摸目标高度 | `>= 40px`；`<32px` 的主要操作算严重；行内链接单独归类 |');
  md.push('| 4 | 底栏不遮挡最后一条内容 | 页面滚到最底后，`#app` 内最后一个有文字的元素的 bottom 必须高于 `.tabbar` 的 top |');
  md.push('| 5 | 弹层可滚动 / 关闭按钮可点 | 内容超出时能滚到底且最后一行不被裁；`#sheetClose` 必须在视口内且 `elementFromPoint` 命中；底部按钮同理 |');
  md.push('| 6 | 安全区适配 | 只做 CSS 静态检查（本版 Chrome 无法模拟 safe-area，见第 2 节） |');
  md.push('| 7 | 长文案不截断/不溢出 | 自己带文字的元素若 `scrollWidth > clientWidth` 且没有省略号样式 → 报；有省略号的单独列为「按设计」 |');
  md.push('');
  md.push('尺寸：' + sizes.map((s) => `**${s.label.replace('x', '×')}**${s.landscape ? '（横屏）' : ''}`).join('、') + '，全部 `deviceScaleFactor:2, mobile:true`。');
  md.push('');
  md.push('> 测试时在页面里注入了 `animation:none; transition:none`，只为了让入场动画不影响测量（动画只改透明度/位移，不影响最终布局）。');
  md.push('>');
  md.push('> 判断视口宽用的是 `documentElement.clientWidth`，不是 `window.innerWidth`：Chrome 的手机模拟在页面内容比屏幕宽时会把 `innerWidth` 一起变大（实测从 390 变成 1200），用它判断「有没有横向溢出」会永远判不出来。这个坑是反向验证（第 6 节）抓出来的。');
  md.push('>');
  md.push('> 测试时禁用了 Service Worker。原因：这个项目用「先缓存再后台更新」，如果测试期间有人改文件，同一轮里不同界面会读到不同版本；禁用后每个界面都从快照服务拿同一份文件。这只影响资源加载方式，不影响排版。');
  md.push('');

  // 2. CSS 字号 / 安全区
  md.push('## 2. 字号单位与安全区（静态检查，实测数据见后面的表）');
  md.push('');
  md.push(`- \`css/style.css\` 里 \`font-size\` 声明 **${css.fontDecls} 条**：px **${css.pxCount}** 条、rem **${css.remCount}** 条、em **${css.emCount}** 条、百分比 **${css.percentCount}** 条。`);
  md.push(`- **结论：项目所有字号都用 px，没有 rem/em。** 所以 Android 系统字体缩放会作用在文字上（浏览器做文本缩放），但**写死的 px 盒子不会跟着放大**；这就是第 5 节大字号模拟的重点。`);
  md.push(`- 关键写死尺寸：${css.fixedPx.map((f) => `${f.what} = ${f.value}（第 ${f.line} 行）`).join('；')}。`);
  md.push(`- 底部留白：\`body { padding-bottom: ${css.bodyPadBottom} }\`（**固定 px，不随字号/安全区变化**）。`);
  md.push(`- \`env(safe-area-inset-*)\` 用法（共 ${css.safeHits.length} 处）：`);
  for (const h of css.safeHits) md.push(`  - 第 ${h.line} 行：\`${h.text}\``);
  md.push(`- 已适配的方位：${[css.hasTopInset ? '顶部' : '', css.hasBottomInset ? '底部' : '', css.hasSideInset ? '左右' : ''].filter(Boolean).join('、') || '无'}。`);
  md.push(`- \`index.html\` 的 viewport：\`${css.viewportMeta}\`（viewport-fit=cover：${css.viewportFit ? '已设置' : '**没设置**'}）；全屏时 \`env()\` 才会给出非 0 值。`);
  md.push(`- **建议（不是已发生的事故）**：`);
  md.push('  1. `.topbar` 没有 `padding-top: env(safe-area-inset-top)`：独立全屏（PWA standalone / 刘海屏）时日期栏可能贴到状态栏下面；');
  md.push('  2. `body` 的 `padding-bottom: 72px` 是固定值，而 `.tabbar` 自己有 `env(safe-area-inset-bottom)`。底栏实测 61~68px（字号越大越高），余量只剩 11~4px（见下）—— 一旦系统底部手势区 inset 超过这个余量，最后一条内容会被底栏压住。建议改成 `calc(72px + env(safe-area-inset-bottom))` 或由 JS 量底栏高度；');
  md.push('  3. 横屏时没有 `env(safe-area-inset-left/right)`：带刘海/挖孔的手机横屏全屏时，左右可能被切。');
  // 实测：底栏高度 vs body 固定留白（这个数字是量出来的，不是猜的）
  const barStat = ['normal', 'font130', 'font150'].map((passId) => {
    const r = allResults.find((x) => x.passId === passId && x.id === 'tab-today');
    const bb = r && r.probe ? r.probe.bottomBar : null;
    return bb && !bb.skipped ? { passId, barH: bb.barHeight, pad: bb.bodyPadBottom, reserve: round1(bb.bodyPadBottom - bb.barHeight) } : null;
  }).filter(Boolean);
  if (barStat.length) {
    md.push(`- **实测底栏高度 vs 固定留白**：${barStat.map((b) => `${b.passId === 'normal' ? '正常字号' : b.passId === 'font130' ? '130%' : '150%'} 底栏 ${b.barH}px / body 留白 ${b.pad}px / 余量 ${b.reserve}px`).join('；')}。`);
    const worst = barStat[barStat.length - 1];
    md.push(`  → 字号越大余量越小；模拟到 150% 时只剩 **${worst.reserve}px**。全面屏底部手势区 inset 常见 16~34px（这是**推断**，本机没实测），一旦插进来，最后一条内容就会被底栏盖住。`);
  }
  md.push('  > 这些是**静态推断**：本版无头 Chrome 不支持 `Emulation.setSafeAreaInsets`，没能在本机实测，所以不算「实测问题」。');
  md.push('');

  // 3. 汇总
  md.push('## 3. 汇总（所有 pass）');
  md.push('');
  md.push('| 尺寸 | 正常字号 | 大字号 130%（模拟） | 大字号 150%（模拟） | 长文案组合 |');
  md.push('| --- | --- | --- | --- | --- |');
  const sizeRow = (size, arr) => {
    const issues = arr.flatMap((r) => r.issues);
    const c = countLevels(issues);
    return ['事故级', '严重', '一般', '建议'].filter((l) => c[l]).map((l) => `${l}×${c[l]}`).join(' ') || '✅';
  };
  for (const s of sizes) {
    const filt = (arr) => arr.filter((r) => r.size === s.label);
    md.push(`| ${s.label.replace('x', '×')}${s.landscape ? '（横屏）' : ''} | ${sizeRow(s, filt(normal))} | ${sizeRow(s, filt(font130))} | ${sizeRow(s, filt(font150))} | ${sizeRow(s, filt(lt))} |`);
  }
  md.push('');

  // 4. 逐尺寸明细
  md.push('## 4. 逐尺寸结果');
  md.push('');
  md.push('表格里 ✅ = 该界面在该字号下 7 类断言全过。');
  md.push('');
  for (const s of sizes) {
    md.push(`### ${s.label.replace('x', '×')}${s.landscape ? '（横屏，视口 844×390）' : ''}`);
    md.push('');
    md.push(`> ${s.note}`);
    md.push('');
    md.push('| 界面 | 正常字号 | 130% | 150% |');
    md.push('| --- | --- | --- | --- |');
    const find = (pass, id) => allResults.find((r) => r.size === s.label && r.passId === pass && r.id === id);
    for (const [id, label] of INTERFACE_ORDER) {
      const cells = ['normal', 'font130', 'font150'].map((p) => {
        const r = find(p, id);
        return r ? cellText(r.issues) : '—';
      });
      md.push(`| ${label} | ${cells.join(' | ')} |`);
    }
    md.push('');
    // 明细
    for (const pass of ['normal', 'font130', 'font150']) {
      const bad = allResults.filter((r) => r.size === s.label && r.passId === pass && r.issues.length);
      if (!bad.length) continue;
      const pl = pass === 'normal' ? '正常字号' : pass === 'font130' ? '系统大字号 130%（模拟）' : '系统大字号 150%（模拟）';
      md.push(`#### ${s.label.replace('x', '×')} · ${pl} · 问题明细`);
      md.push('');
      for (const r of bad) {
        // 大字号 pass 只逐条列出「放大后新增」的问题；与正常字号相同的（例如本来就偏小的按钮）
        // 只报个数量，避免同一句话在 5 个尺寸 × 3 种字号里重复几百行。
        const baseTypes = new Set(allResults.filter((b) => b.size === s.label && b.passId === 'normal' && b.id === r.id).flatMap((b) => b.issues.map((i) => i.type)));
        const fresh = r.issues.filter((i) => pass === 'normal' || !baseTypes.has(i.type));
        const carried = r.issues.length - fresh.length;
        if (!fresh.length && !carried) continue;
        md.push(`**${r.label}**（\`${r.id}\`）`);
        for (const i of fresh) md.push(issueLine(i, r, { simulated: pass !== 'normal', isNew: pass !== 'normal' }));
        if (carried) md.push(`- （另有 ${carried} 条与正常字号相同、本次没有变差的问题，明细见正常字号那一节）`);
        md.push('');
      }
    }
    // 长文案组合（长日期 / 8 字昵称 / 大字号）
    const lts = lt.filter((r) => r.size === s.label);
    if (lts.length) {
      md.push(`#### ${s.label.replace('x', '×')} · 长文案组合（长日期 / 8 字昵称 / 大字号）`);
      md.push('');
      for (const r of lts) {
        md.push(`**${r.label}**`);
        if (!r.issues.length) md.push('- ✅ 顶栏、日期、问候语都放得下');
        else for (const i of r.issues) md.push(issueLine(i, r, { simulated: r.id.indexOf('font') >= 0 }));
        md.push('');
      }
    }
  }

  // 5. 大字号单独结论
  md.push('## 5. 系统大字号（模拟）单独结论');
  md.push('');
  md.push('**这是模拟，不等于真机。** 做法：');
  md.push('');
  md.push('1. 先设 `documentElement.style.fontSize = 130%` —— 实测对字号**完全没影响**（印证第 2 节：全是 px，没有 rem 可放大）；');
  md.push('2. 再注入 `html { -webkit-text-size-adjust: 130% / 150%; text-size-adjust: ... }` —— 本项目在无头 Chrome 里字号真的变大（下表有实测 px 值），用来近似 Android 的「字体大小」设置；');
  md.push('3. 万一某台机器上第 2 步无效，脚本会退回「逐元素把 font-size 乘系数」的兜底。');
  md.push('');
  md.push('模拟的局限：只放大文字，不放大固定 px 的盒子/图标；也不模拟 Android 真实字体缩放对浏览器控件、行高算法的差异。**真机上可能更好也可能更差。**');
  md.push('');
  md.push('| 尺寸 | 实测字号样本（前 → 后，生效方式） | 130% 新增问题类型数 | 150% 新增问题类型数 |');
  md.push('| --- | --- | --- | --- | --- |');
  const newIssuesFor = (passId) => {
    const out = [];
    for (const r of allResults.filter((x) => x.passId === passId)) {
      const base = allResults.filter((b) => b.size === r.size && b.passId === 'normal' && b.id === r.id);
      const baseTypes = new Set(base.flatMap((b) => b.issues.map((i) => i.type)));
      for (const i of r.issues) if (!baseTypes.has(i.type)) out.push({ r, i });
    }
    return out;
  };
  for (const s of sizes) {
    const info130 = fontInfo[`${s.label}|font130`];
    const info150 = fontInfo[`${s.label}|font150`];
    const n130 = newIssuesFor('font130').filter((x) => x.r.size === s.label).length;
    const n150 = newIssuesFor('font150').filter((x) => x.r.size === s.label).length;
    const fmt = (info) => info ? `${info.before}px → ${info.after}px（${info.method}）` : '—';
    md.push(`| ${s.label.replace('x', '×')} | ${fmt(info130)} / ${fmt(info150)} | ${n130} | ${n150} |`);
  }
  md.push('');
  for (const [passId, label] of [['font130', '大字号 130%'], ['font150', '大字号 150%']]) {
    const news = newIssuesFor(passId);
    md.push(`### ${label}：放大后新增的问题（相对正常字号）`);
    md.push('');
    if (!news.length) {
      md.push('没有新增问题：放大字号后版面仍然稳定。');
    } else {
      const typeCount = new Map();
      for (const x of news) typeCount.set(x.i.type, (typeCount.get(x.i.type) || 0) + 1);
      md.push('问题类型分布：' + [...typeCount.entries()].map(([t, n]) => `${t} ×${n}`).join('、'));
      md.push('');
      for (const x of news.slice(0, 60)) {
        md.push(`- ${x.r.size.replace('x', '×')} · ${x.r.label}｜**${x.i.level}** ${x.i.type}：${x.i.detail}${x.r.shot ? `（截图：\`layout-shots/${path.basename(x.r.shot)}\`）` : ''}`);
      }
      if (news.length > 60) md.push(`- ……其余 ${news.length - 60} 条见逐尺寸明细`);
    }
    md.push('');
  }

  // 6. 反向验证
  md.push('## 6. 反向验证：证明这些断言真的抓得住问题');
  md.push('');
  md.push('做法：在真实页面里注入一个必然违规的元素，跑同一套测量，确认对应断言**报红**；移除后确认恢复全绿。任一条没抓住 = 断言是摆设。');
  md.push('');
  md.push('| 注入的东西 | 期望 | 结果 | 实测 |');
  md.push('| --- | --- | --- | --- |');
  for (const c of (reverse ? reverse.cases : [])) {
    md.push(`| ${mdEscape(c.name)} | ${mdEscape(c.expect)} | ${c.caught ? '✅ 抓住了' : '❌ 没抓住'} | ${mdEscape(c.measured)} |`);
  }
  md.push('');
  md.push(!reverse ? '（本次没有执行反向验证：开发子集模式下只跑了部分 pass。）' : reverse.ok ? '**反向验证全部通过。**' : '**反向验证未通过，本报告的断言不可信，必须重写。**');
  md.push('');

  // 7. 局限
  md.push('## 7. 测了什么 / 没测什么（诚实边界）');
  md.push('');
  md.push('| 项目 | 状态 | 说明 |');
  md.push('| --- | --- | --- |');
  md.push(`| 5 种尺寸的静态排版 | ✅ 实测（浏览器模拟视口） | 320×568 / 360×640 / 390×844 / 412×915 / 844×390，dpr=2、mobile=true |`);
  md.push(`| 4 个标签页 + ${INTERFACE_ORDER.filter(([id]) => id.startsWith('sheet')).length} 个弹层 + 欢迎/引导 | ✅ 实测（浏览器） | 全部通过界面真实点击打开；弹层内滚动、关闭按钮命中都量了 |`);
  md.push('| 系统大字号 130% / 150% | ⚠️ 模拟 | `text-size-adjust` 近似，**不等于真机**（详见第 5 节） |');
  md.push('| `env(safe-area-inset-*)` 适配 | ⚠️ 只做了静态检查 | 本版 Chrome 没有 `Emulation.setSafeAreaInsets`，无法实测；结论是推断，已在第 2 节标注 |');
  md.push('| 测试时的 Service Worker | ⚙️ 已禁用（测试夹具） | 为了避免「先缓存再更新」让一轮测量混版本；不影响排版 |');
  md.push('| 真机（Android / iOS） | ❌ 没测 | 需要真机装 PWA 后人工过一遍 |');
  md.push('| 输入法弹出后的视口变化 | ❌ 没测 | 键盘顶起后的高度变化可能让弹层底部按钮被挡 |');
  md.push('| 浏览器地址栏收起/展开、分屏、折叠屏 | ❌ 没测 | 视口高度会变，`88vh` 的弹层可能表现不同 |');
  md.push('| 文字换行 / 挤压造成的「变丑」（不是裁切） | ⚠️ 只能靠截图人眼 | 例如 150% 时营养素数值「109/104 g」会换行、行高变高；自动断言只抓「溢出/裁切/重叠」，抓不到这种主观问题，需要看 `.audit/layout-shots/` 里的截图 |');
  md.push('');

  // 8. 附录
  md.push('## 8. 附录：界面清单与截图');
  md.push('');
  md.push('全部界面（每个尺寸 × 每个字号都跑一遍）：');
  md.push('');
  for (const [id, label] of INTERFACE_ORDER) md.push(`- \`${id}\`：${label}`);
  md.push('');
  md.push(`截图命名规则：\`{尺寸}__{pass}__{界面id}.png\`，例如 \`320x568__normal__tab-today.png\`；pass 取值 \`normal\` / \`font130\` / \`font150\` / \`longtext\`；问题截图带 \`__bottom\`（滚动到底）或 \`__error\`（探测失败）。`);
  md.push('');
  md.push(`截图数量：${fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png')).length : 0} 张，都在 \`.audit/layout-shots/\`。`);
  md.push('');
  md.push('---');
  md.push(`_由 tools/layout-check.mjs 生成；原始测量数据见 .audit/layout-report.json_`);
  return md.join('\n');
}

/* ── 静态服务：给页面拍一份「文件快照」再服务 ──
 *
 * 为什么不像别的自检那样直接 `node tools/serve.mjs` 指向项目目录：
 * 这个项目在本审计运行期间，其他人可能正在改 js/ css/。直接服务项目目录时，
 * 同一轮里「先打开的界面读到旧 CSS、后打开的读到新 CSS」——测出来的数字会混两个版本。
 * 所以运行开始时先把 index.html / js / css / icons 复制到临时目录，服务这份快照：
 * 一轮测量一定是同一个版本，报告里会写明快照 hash。
 */

function snapshotProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fatloss-layout-'));
  for (const rel of ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons']) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(dir, rel), { recursive: true });
  }
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else files.push(p);
    }
  })(dir);
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.relative(dir, f));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return { dir, hash: h.digest('hex').slice(0, 16), files: files.length };
}

const SERVE_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function startSnapshotServer(dir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    // 界面启动时会问一次 AI 状态。快照服务没有后端，直接答「没配」，避免 404 噪音
    if (pathname === '/api/ai-status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ configured: false, model: null, from: null, source: null }));
    }
    if (pathname === '/') pathname = '/index.html';
    const target = path.join(dir, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(dir)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(target, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': SERVE_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store, must-revalidate',
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SERVE_PORT, '127.0.0.1', () => resolve(server));
  });
}

function servePortBusy() {
  // 用 lsof 判断端口有没有监听进程。不能用 chrome-launch 的 portAlive：
  // 它探的是 Chrome 的 /json/version，静态服务会回 404，探测结果永远是「端口空着」（踩过：
  // 旧 serve.mjs 还占着 4313 时，脚本以为端口空着，结果连到的是旧目录）。
  try {
    const out = execSync(`lsof -nP -iTCP:${SERVE_PORT} -sTCP:LISTEN -t || true`, { encoding: 'utf8' }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

async function startSnapshot() {
  const snap = snapshotProject();
  // 4313 是分配给本审计的端口：先关掉占着它的旧静态服务，避免测到旧目录
  if (servePortBusy()) {
    freePort(SERVE_PORT);
    for (let i = 0; i < 25 && servePortBusy(); i++) await sleep(200);
  }
  const server = await startSnapshotServer(snap.dir);
  return { ...snap, server };
}

/* ── 主流程 ───────────────────────────────── */

async function main() {
  // 每次重跑先清空，避免旧截图混进来；清不掉（权限/沙箱）不能把整条检查带崩
  try { fs.rmSync(SHOTS, { recursive: true, force: true }); } catch { /* 清不掉就继续 */ }
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });

  const snapshot = await startSnapshot();
  const { chrome, version } = await launchChrome({
    port: CDP_PORT,
    userDataDir: PROFILE,
    window: '390,844',
    extraArgs: ['--hide-scrollbars'],
  });

  // Chrome 的临时 profile 有几十 MB，跑完（或失败）就删掉，别留在项目里。
  const cleanupRuntime = async () => {
    try { chrome.kill(); } catch { /* 已退出 */ }
    try { snapshot.server.close(); } catch { /* 已关闭 */ }
    await sleep(400);
    try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 删不掉就算了 */ }
    try { fs.rmSync(snapshot.dir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* 删不掉就算了 */ }
  };
  let exitCode = 0;
  try {
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await connect(target.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    // 测试里禁用 Service Worker：快照服务本身已经保证同一版本，
    // 关掉离线缓存可以避免「浏览器后台更新缓存」给测量引入额外变量。
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        try {
          Object.defineProperty(ServiceWorkerContainer.prototype, 'register', {
            value: () => Promise.reject(new Error('layout-check: Service Worker 在自检中关闭')),
            configurable: true,
          });
        } catch (e) { /* 不支持就随它去 */ }
      })();`,
    });

    await preparePage(null);

    const allPasses = [];
    const longtexts = [];
    const fontInfo = {};
    let reverse = null;
    const t0 = Date.now();

    for (const size of SIZES) {
      if (ONLY_SIZE && ONLY_SIZE !== size.label) continue;
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: size.w,
        height: size.h,
        deviceScaleFactor: 2,
        mobile: true,
        screenOrientation: size.landscape
          ? { type: 'landscapePrimary', angle: 90 }
          : { type: 'portraitPrimary', angle: 0 },
      });
      await sleep(150);

      const passesWanted = ONLY_PASSES
        ? ONLY_PASSES.split(',').map((s) => s.trim()).filter(Boolean)
        : ['normal', 'font130', 'font150'];

      if (passesWanted.includes('normal')) {
        const p = await runPass(size, { passId: 'normal', passLabel: '正常字号', scale: null, captureAll: true });
        allPasses.push(p);
        // 反向验证只在 390×844 正常字号这一轮做一次
        if (size.label === '390x844') reverse = await reverseValidate();
      }
      for (const [passId, label, scale] of [
        ['font130', '系统大字号 130%（模拟）', 1.3],
        ['font150', '系统大字号 150%（模拟）', 1.5],
      ]) {
        if (!passesWanted.includes(passId)) continue;
        const p = await runPass(size, { passId, passLabel: label, scale, captureAll: false });
        allPasses.push(p);
        fontInfo[`${size.label}|${passId}`] = p.font;
      }
      if (passesWanted.includes('longtext') || !ONLY_PASSES) {
        longtexts.push(await runLongText(size));
      }
    }

    // 写报告
    const css = analyzeCss();
    const report = buildReport({
      sizes: SIZES.filter((s) => !ONLY_SIZE || s.label === ONLY_SIZE),
      passes: allPasses,
      longtexts,
      reverse,
      css,
      fontInfo,
      meta: {
        generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' (本地时间)',
        chromeVersion: version?.Browser || '未知',
        base: BASE,
        snapshotHash: snapshot.hash,
        snapshotFiles: snapshot.files,
      },
    });
    const reportName = DEV_MODE ? 'layout-report-dev.md' : 'layout-report.md';
    fs.writeFileSync(path.join(OUT, reportName), report);
    fs.writeFileSync(path.join(OUT, 'layout-report.json'), JSON.stringify({
      meta: { generatedAt: new Date().toISOString(), chrome: version?.Browser, base: BASE, snapshotHash: snapshot.hash, snapshotFiles: snapshot.files },
      css,
      fontInfo,
      reverse,
      passes: allPasses,
      longtexts,
    }, null, 2));

    // 控制台摘要
    const allResults = allPasses.flatMap((p) => p.results);
    const allIssues = [...allResults, ...longtexts.flatMap((p) => p.results)].flatMap((r) => r.issues);
    const total = countLevels(allIssues);
    console.log('\n════════ 排版自检结果 ════════');
    console.log(`检查组合：${allResults.length + longtexts.flatMap((p) => p.results).length} 个（尺寸 × 界面 × 字号）｜用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    for (const s of SIZES.filter((x) => !ONLY_SIZE || x.label === ONLY_SIZE)) {
      const line = (passId) => {
        const issues = allResults.filter((r) => r.size === s.label && r.passId === passId).flatMap((r) => r.issues);
        const c = countLevels(issues);
        return ['事故级', '严重', '一般', '建议'].filter((l) => c[l]).map((l) => `${l}${c[l]}`).join('/') || '✅';
      };
      const ltIssues = longtexts.flatMap((p) => p.results).filter((r) => r.size === s.label).flatMap((r) => r.issues);
      console.log(`  ${s.label}：正常 ${line('normal')}｜130% ${line('font130')}｜150% ${line('font150')}｜长文案 ${ltIssues.length ? ltIssues.length + ' 条' : '✅'}`);
    }
    console.log(`合计：事故级 ${total['事故级']} · 严重 ${total['严重']} · 一般 ${total['一般']} · 建议 ${total['建议']}`);
    if (reverse) console.log(`反向验证：${reverse.cases.length - reverse.failed.length}/${reverse.cases.length} 通过${reverse.ok ? '' : `（失败：${reverse.failed.join('、')}）`}`);
    else console.log('反向验证：未执行（开发子集模式）');
    const severe = [...allResults, ...longtexts.flatMap((p) => p.results)]
      .flatMap((r) => r.issues.filter((i) => i.level === '事故级' || i.level === '严重').map((i) => ({ r, i })))
      .slice(0, 10);
    if (severe.length) {
      console.log('\n最严重的问题：');
      for (const { r, i } of severe) console.log(`  [${i.level}] ${r.size} · ${r.passLabel} · ${r.label}：${i.type} —— ${i.detail}`);
    }
    if (reverse && !reverse.ok) {
      total['事故级'] += 1;
      console.log('\n❌ 反向验证失败：断言抓不住已知问题，报告不可信。');
    }
    console.log(`\n报告：${path.relative(ROOT, path.join(OUT, reportName))}`);
    console.log(`截图：${path.relative(ROOT, SHOTS)}`);

    exitCode = ((total['事故级'] + total['严重']) > 0 || (reverse && !reverse.ok)) ? 1 : 0;
    console.log(`退出码：${exitCode}${exitCode ? '（有事故级/严重问题）' : '（只有一般/建议）'}`);
    await cleanupRuntime();
    finishAndExit(exitCode);
  } catch (err) {
    clearTimeout(hardTimer);
    console.error('\n排版自检失败：', err.message);
    try { await screenshot(path.join(SHOTS, 'ERROR.png')); } catch { /* 截不到就算了 */ }
    await cleanupRuntime();
    finishAndExit(1);
  }
}

/* ── 超时保险 ─────────────────────────────── */

armWatchdog('layout-check', 470);
const hardTimer = setTimeout(() => {
  console.error(`\n❌ 排版自检超过 ${HARD_TIMEOUT_MS / 1000} 秒未完成，判定失败（8 分钟硬超时）`);
  try { execSync('pkill -9 -f ".audit/profiles/layout" || true'); } catch { /* 忽略 */ }
  process.exit(1);
}, HARD_TIMEOUT_MS);

main().catch((err) => {
  clearTimeout(hardTimer);
  console.error('排版自检启动失败：', err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : err);
  process.exit(1);
});
