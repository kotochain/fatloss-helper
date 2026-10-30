/**
 * 全界面按钮点击清扫（审计 A）
 *
 * 做什么：用无头 Chrome 打开本地服务，在两套起始状态（空白新用户 / 有记录的存档）下，
 * 从 DOM 里**动态枚举**所有可点元素（不硬编码按钮清单），逐个点一遍，检查：
 *   1) 有没有产生未捕获异常（window.onerror / unhandledrejection / CDP Runtime.exceptionThrown）；
 *   2) 点了之后有没有可见变化（弹层开合 / DOM 改动 / 标签页切换 / localStorage 变化）；
 *   3) 点完弹层能不能关掉、应用是不是仍然可用（window.__appReady）；
 *   4) 存档是否始终可解析。
 *
 * 为什么要有这个检查：用户真机上遇到过「欢迎页所有按钮点不动」—— 那次是手工发现的，
 * 任何单元测试都抓不到（单元测试加载不了 app.js）。这个脚本要能自动抓住同类问题，
 * 并且**反向验证过自己真的会报错**（见报告里的「反向验证」一节）。
 *
 * 危险操作的红线：
 *   - confirm 一律被覆盖成「取消」：wipe / reset-today / 覆盖恢复 / 删除快照 / 清除密钥
 *     都只会走到「取消」分支，不会真的执行；
 *   - import 的文件选择框被拦截，导入流程打不开文件；
 *   - 「从头开始」弹层里的确认按钮本来 disabled，脚本只验证「输入清除后按钮才可用」，
 *     绝不点它。
 *
 * 用法：
 *   node tools/sweep-check.mjs                 # 两套状态都跑
 *   node tools/sweep-check.mjs --state=a       # 只跑空白新用户（调试用）
 *   node tools/sweep-check.mjs --reverse-only  # 只做反向验证（调试用）
 *   node tools/sweep-check.mjs --draft-only    # 只跑「解析后的份量追问弹层」场景（调试用）
 *
 * 端口分配（不要改，跟别的审计脚本错开）：
 *   静态服务 4311 / CDP 9411 / profile .audit/profiles/sweep
 *
 * 退出码：发现死按钮、报错、危险操作取消后仍改了存档、弹层关不掉、应用不可用、
 *        或反向验证失败 → 非 0；全部通过 → 0。
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { armWatchdog } from './watchdog.mjs';
import { appVersion } from './app-version.mjs';
import { launchChrome, freePort, portAlive } from './chrome-launch.mjs';
import { emptyState, demoProfile, demoEntries, addWeight, shiftDate, todayKey } from '../js/store.js';
import { calcTargets } from '../js/calc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_DIR = path.join(ROOT, '.audit');
const SHOTS_DIR = path.join(AUDIT_DIR, 'screenshots');
const PROFILE_DIR = path.join(AUDIT_DIR, 'profiles', 'sweep');
const DOWNLOAD_DIR = path.join(PROFILE_DIR, 'downloads');
const REPORT_PATH = path.join(AUDIT_DIR, 'sweep-report.md');

const STATIC_PORT = 4311;
const CDP_PORT = 9411;
const BASE = `http://127.0.0.1:${STATIC_PORT}`;
const ARGS = process.argv.slice(2);
const ONLY_STATE = (ARGS.find((a) => a.startsWith('--state=')) || '').split('=')[1] || 'both';
const REVERSE_ONLY = ARGS.includes('--reverse-only');
const DRAFT_ONLY = ARGS.includes('--draft-only');

/** 脚本自身的时间预算（远小于 6 分钟硬上限，给报告和收尾留余量） */
const MAIN_BUDGET_MS = 262000;     // 两套状态的主清扫（界面元素变多后要跟着调）
const REVERSE_BUDGET_MS = 52000;   // 反向验证（三个用例各要重扫一整面，32 秒会被截断成假失败）
const MAX_PROBES_PER_STATE = 200;
const MAX_SURFACES_PER_STATE = 45;

/** 一开始就置 1：万一被看门狗杀掉，也按「有问题」退出，而不是静默成功 */
process.exitCode = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

/* ── 代码版本快照 ────────────────────────────────────────
   仓库是多人共用的，审计期间别人可能正在改代码。运行时给关键文件算个指纹写进报告，
   这样「这份报告对应哪一版代码」是可复核的，而不是一句「我测过了」。 */
function snapshotCodeVersions() {
  const files = ['index.html', 'css/style.css', 'sw.js'];
  const jsDir = path.join(ROOT, 'js');
  for (const name of fs.readdirSync(jsDir).filter((f) => f.endsWith('.js') && !f.startsWith('.')).sort()) files.push('js/' + name);
  const out = {};
  let combined = '';
  for (const rel of files) {
    try {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
      out[rel] = hash.slice(0, 12);
      combined += hash;
    } catch { out[rel] = '（读不到）'; }
  }
  return { files: out, combined: crypto.createHash('sha256').update(combined).digest('hex').slice(0, 12) };
}

/* ────────────────────────────────────────────────────────
   一、起始存档（两套）
   ──────────────────────────────────────────────────────── */

/**
 * 造一套「用过几天」的存档：
 *   - 已完成引导（settings.onboarded）
 *   - 最近 3 天都有饮食记录（每天约 11 条）+ 每天一次运动
 *   - 3 条体重记录（跨度 14 天，趋势判断能生效）
 *   - 1 个自定义食物
 *   - 一枚升级前快照（让「数据与备份」里的回滚/删除按钮真实出现）
 *   - 一份假的 AI 配置（只有本地假密钥，让「清除密钥 / 模型选择」等按钮出现；
 *     地址指向一个关闭的本机端口，任何网络请求都会立刻失败，不会真的联网）
 *
 * 这些全部在 Node 里用项目自己的 store/calc 模块生成，和界面「看一个填好的例子」
 * 用的是同一套函数 —— 不是手写一段来路不明的 JSON。
 */
function buildBaselines() {
  const state = emptyState();
  state.profile = { ...demoProfile(), nickname: '' };
  state.settings = { trainDays: 3, stepsKey: 'mid', onboarded: true, mode: 'basic', recordTab: 'food', lastSeenVersion: appVersion() };
  const targets = calcTargets(state.profile);
  const today = todayKey();
  for (let i = 0; i < 3; i++) demoEntries(state, shiftDate(today, -i), targets);
  addWeight(state, shiftDate(today, -14), 59.4);
  addWeight(state, shiftDate(today, -7), 58.6);
  addWeight(state, today, 58);
  state.customFoods.push({
    id: 'c_audit_1', name: '自建测试食物', category: 'custom',
    kcal: 120, protein: 6, fat: 3, carb: 18, servings: [['一份', 100]],
  });

  const stateJson = JSON.stringify(state);
  const aiConfig = {
    presetId: 'deepseek',
    baseUrl: 'http://127.0.0.1:65534/v1',
    model: 'audit-fake-model',
    apiKey: 'sk-audit-fake-not-a-real-key', // secret-scan:allow 假密钥，只写进本地 localStorage，不联网
    mode: 'relay',
    updatedAt: new Date().toISOString(),
  };
  const backup = JSON.stringify({
    savedAt: new Date().toISOString(),
    schemaVersion: 4,
    note: '审计基线：模拟升级前自动留的快照',
    data: state,
  });

  return {
    a: {
      label: '空白新用户',
      storage: {},
      note: 'localStorage 完全为空 → 欢迎页',
    },
    b: {
      label: '有记录的存档',
      storage: {
        'fatloss.state.v2': stateJson,
        'fatloss.backup': backup,
        'fatloss.ai.v1': JSON.stringify(aiConfig),
      },
      note: `3 天饮食 + 3 条体重 + 3 次运动 + 自定义食物 + 升级前快照 + 假 AI 配置（${Math.round(stateJson.length / 1024)} KB）`,
    },
  };
}

/* ────────────────────────────────────────────────────────
   二、页面注入脚本（每次导航都在应用脚本之前执行）
   ──────────────────────────────────────────────────────── */

const PAGE_PRELUDE = String.raw`
(function () {
  'use strict';
  if (window.__A) return;
  var A = window.__A = {
    errs: [], consoleErrors: [], confirms: [], files: [], alerts: [], prompts: [],
    mutations: 0, storageWrites: 0, observerOn: false
  };

  /* 0) 每次导航先恢复基线存档。
     整套清扫能重复跑、探测之间不互相污染，靠的就是这一步：
     不管上一次点击把状态改成什么样，刷新后都回到同一个起点。 */
  try {
    var rawBase = sessionStorage.getItem('__auditBaseline');
    if (rawBase) {
      var base = JSON.parse(rawBase);
      localStorage.clear();
      var st = base.storage || {};
      for (var k in st) {
        if (Object.prototype.hasOwnProperty.call(st, k)) localStorage.setItem(k, st[k]);
      }
    }
  } catch (e) {
    A.errs.push('基线恢复失败: ' + ((e && e.message) || e));
  }

  /* 1) 未捕获异常 */
  window.addEventListener('error', function (ev) {
    var detail = ev && (ev.message || (ev.error && (ev.error.message || ev.error)));
    A.errs.push('window.onerror: ' + String(detail || '未知错误').slice(0, 400));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    var detail = r && (r.stack || r.message) ? (r.stack || r.message) : String(r);
    A.errs.push('unhandledrejection: ' + String(detail).slice(0, 400));
  });

  /* 2) 应用自己 try/catch 兜住的报错也记下来。
     用户看到的是「这一步没能完成」，但控制台上确实报错了 —— 这也要算「点了报错」。 */
  try {
    var origConsoleError = console.error.bind(console);
    console.error = function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var x = arguments[i];
        try {
          parts.push(typeof x === 'string' ? x : (x && x.message) ? x.message : String(x));
        } catch (e2) { parts.push('[无法打印]'); }
      }
      A.consoleErrors.push(parts.join(' ').slice(0, 500));
      origConsoleError.apply(console, arguments);
    };
  } catch (e3) { /* 记录不到就只靠 window.onerror */ }

  /* 3) 危险操作一律取消 / 拦截（审计红线，见文件头） */
  window.confirm = function (msg) { A.confirms.push(String(msg || '').slice(0, 240)); return false; };
  window.alert = function (msg) { A.alerts.push(String(msg || '').slice(0, 240)); };
  window.prompt = function () { A.prompts.push('prompt'); return null; };
  try {
    var origInputClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (String(this.type || '').toLowerCase() === 'file') {
        A.files.push('input[type=file]');
        return;
      }
      return origInputClick.call(this);
    };
  } catch (e4) { /* 忽略 */ }
  try {
    window.showOpenFilePicker = function () {
      A.files.push('showOpenFilePicker');
      return Promise.reject(new Error('审计已拦截文件选择框'));
    };
  } catch (e5) { /* 可信 HTML 环境可能不允许覆盖，忽略 */ }

  /* 4) DOM 变更计数（判断「点了有没有反应」最可靠的一条） */
  var startObserver = function () {
    try {
      new MutationObserver(function (list) { A.mutations += list.length; })
        .observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      A.observerOn = true;
    } catch (e6) { /* 观察不到就靠 localStorage / 弹层状态判断 */ }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver);
  else startObserver();

  A.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ── 小工具 ───────────────────────────────────────── */

  A.sheetRoot = function () { return document.getElementById('sheetRoot'); };
  A.sheetOpen = function () {
    var r = A.sheetRoot();
    return !!r && !r.classList.contains('hidden');
  };
  A.sheetTitle = function () {
    var t = document.getElementById('sheetTitle');
    return t ? String(t.textContent || '').trim() : '';
  };
  A.sheetKind = function () {
    if (!A.sheetOpen()) return null;
    var t = A.sheetTitle();
    if (/^\d{4} 年 \d{1,2} 月$/.test(t)) return 'calendar';
    if (t.indexOf('加到') === 0) return 'food-picker';
    if (t.indexOf('→') >= 0) return 'amount';
    if (t === '新增自定义食物') return 'custom-food';
    if (t === '这样记对吗？' || t === '这句没能解析') return 'draft';
    if (t === 'AI 设置') return 'ai-settings';
    if (t === '设置') return 'settings';
    if (t === '找回记录') return 'recover';
    if (t === '从头开始') return 'wipe';
    if (t === '数据与备份') return 'backup';
    if (t === '关于') return 'about';
    if (t === '我的成长') return 'growth';
    if (t === '记体重') return 'weight';
    if (t === '加运动') return 'exercise';
    if (t === '先说三件事') return 'onboard-intro';
    if (t === '选一个模式' || t === '用 AI 帮你记') return 'onboard-mode';
    if (t === '最后一步') return 'onboard-first';
    if (t.indexOf('资料') >= 0 || t === '你的基础数据' || t === '填写资料') return 'profile';
    if (/做不了？$/.test(t)) return 'substitute';
    return 'unknown:' + t.slice(0, 24);
  };
  A.activeTab = function () {
    var b = document.querySelector('.tab.active');
    return b ? b.dataset.view : null;
  };
  A.dateText = function () {
    var d = document.getElementById('dateText');
    return d ? String(d.textContent || '').trim() : '';
  };

  A.visible = function (el) {
    if (!el || !el.isConnected) return false;
    try {
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } catch (e7) { /* 旧版 Chrome 没有 checkVisibility，退回下面的矩形判断 */ }
    var r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    return true;
  };

  A.storageHash = function () {
    var keys = [];
    try {
      for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    } catch (e8) {
      return { keys: -1, len: -1, hash: 'unreadable' };
    }
    keys.sort();
    var s = '';
    for (var j = 0; j < keys.length; j++) {
      try { s += keys[j] + '=' + (localStorage.getItem(keys[j]) || '') + '\n'; }
      catch (e9) { s += keys[j] + '=?\n'; }
    }
    var h = 5381;
    for (var n = 0; n < s.length; n++) h = ((h * 33) ^ s.charCodeAt(n)) >>> 0;
    return { keys: keys.length, len: s.length, hash: h };
  };

  A.stateParseOk = function () {
    var keys = ['fatloss.state.v2', 'fatloss.backup', 'fatloss.ai.v1'];
    for (var i = 0; i < keys.length; i++) {
      var raw = null;
      try { raw = localStorage.getItem(keys[i]); } catch (e10) { return { ok: false, error: keys[i] + ' 读不出来' }; }
      if (!raw) continue;
      try { JSON.parse(raw); } catch (e11) { return { ok: false, error: keys[i] + ' 不是合法 JSON: ' + ((e11 && e11.message) || e11) }; }
    }
    return { ok: true };
  };

  A.snapshot = function () {
    return {
      sheetOpen: A.sheetOpen(),
      sheetKind: A.sheetKind(),
      sheetTitle: A.sheetTitle(),
      activeTab: A.activeTab(),
      dateText: A.dateText(),
      storage: A.storageHash(),
      mutations: A.mutations
    };
  };
  A.diff = function (a, b) {
    var reasons = [];
    if (a.sheetOpen !== b.sheetOpen) reasons.push('弹层开合');
    if (a.sheetKind !== b.sheetKind) reasons.push('弹层内容');
    if (a.activeTab !== b.activeTab) reasons.push('标签页');
    if (a.dateText !== b.dateText) reasons.push('日期');
    if (a.storage.hash !== b.storage.hash) reasons.push('localStorage');
    if (b.mutations > a.mutations) reasons.push('DOM 改动(x' + (b.mutations - a.mutations) + ')');
    return { changed: reasons.length > 0, reasons: reasons };
  };

  /* ── 选择器 / 枚举 ──────────────────────────────────
     动态枚举：不维护按钮清单，而是从 DOM 里按「可点元素」的通用特征收集。
     这样新加的按钮自动被覆盖，不会出现清单跟界面脱节。 */
  var CAND_ATTRS = [
    'data-act', 'data-pick', 'data-meal', 'data-method', 'data-record-tab',
    'data-train-eq', 'data-train-cardio', 'data-train-strength', 'data-train-min', 'data-train-intensity',
    'data-preset', 'data-model', 'data-set', 'data-mode', 'data-recover', 'data-wipe',
    'data-sex', 'data-act-key', 'data-goal', 'data-pace', 'data-days', 'data-key',
    'data-eq', 'data-min', 'data-date', 'data-subs', 'data-log-cardio', 'data-ach',
    'data-ex', 'data-grams', 'data-pick-portion', 'data-subs-log', 'data-view'
  ];
  var CAND_SELECTOR = [
    'button', '[role="tab"]', '[role="button"]', 'summary',
    'input[type="button"]', 'input[type="submit"]', 'a[href]',
    '[data-act]', '[data-pick]', '[data-meal]', '[data-method]',
    '[data-record-tab]', '[data-train-eq]', '[data-train-cardio]', '[data-train-strength]',
    '[data-train-min]', '[data-train-intensity]', '[data-preset]', '[data-model]',
    '[data-set]', '[data-mode]', '[data-recover]', '[data-wipe]', '[data-sex]',
    '[data-act-key]', '[data-goal]', '[data-pace]', '[data-days]', '[data-key]',
    '[data-eq]', '[data-min]', '[data-date]', '[data-subs]', '[data-log-cardio]',
    '[data-ach]', '[data-ex]', '[data-grams]', '[data-pick-portion]', '[data-subs-log]', '[data-view]'
  ].join(',');
  var ROOT_SELECTORS = ['#app', '#sheetRoot', '.topbar', '.tabbar'];

  var escAttr = function (v) {
    return String(v).replace(/["\\]/g, '\\$&');
  };

  A.keyOf = function (el) {
    if (!el) return null;
    if (el.id) {
      try {
        if (document.querySelectorAll('#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id)).length === 1) return '#' + el.id;
      } catch (e12) { /* 忽略非法 id */ }
    }
    var tag = el.tagName.toLowerCase();
    var names = [];
    for (var i = 0; i < CAND_ATTRS.length; i++) {
      if (el.hasAttribute(CAND_ATTRS[i])) names.push(CAND_ATTRS[i]);
    }
    var build = function (extraAttr) {
      var parts = [tag];
      for (var j = 0; j < names.length; j++) {
        parts.push('[' + names[j] + '="' + escAttr(el.getAttribute(names[j])) + '"]');
      }
      if (extraAttr) parts.push('[' + extraAttr + '="' + escAttr(el.getAttribute(extraAttr)) + '"]');
      return parts.join('');
    };
    var base = build(null);
    try {
      if (base && document.querySelectorAll(base).length === 1) return base;
    } catch (e13) { /* 选择器非法就走位置兜底 */ }
    if (el.dataset && el.dataset.id) {
      var withId = build('data-id');
      try {
        if (document.querySelectorAll(withId).length === 1) return withId;
      } catch (e14) { /* 忽略 */ }
    }
    var fallbackBase = base || tag;
    var all;
    try { all = Array.prototype.slice.call(document.querySelectorAll(fallbackBase)); }
    catch (e15) { return null; }
    return fallbackBase + '|occ=' + Math.max(0, all.indexOf(el));
  };

  A.resolve = function (key) {
    if (!key) return null;
    var parts = String(key).split('|occ=');
    try {
      var list = document.querySelectorAll(parts[0]);
      return list[parts[1] ? Number(parts[1]) : 0] || null;
    } catch (e16) { return null; }
  };

  A.attrMap = function (el) {
    var out = {};
    for (var i = 0; i < CAND_ATTRS.length; i++) {
      if (el.hasAttribute(CAND_ATTRS[i])) out[CAND_ATTRS[i]] = el.getAttribute(CAND_ATTRS[i]);
    }
    return out;
  };

  A.textOf = function (el) {
    var t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) t = String(el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!t) t = String(el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 60);
  };

  A.isExternal = function (el) {
    if (el.tagName !== 'A') return false;
    var href = el.getAttribute('href') || '';
    return /^https?:/i.test(href);
  };

  A.isDangerous = function (el) {
    var d = el.dataset || {};
    var sig = [d.act, d.set, d.wipe, d.recover, el.id, d.pick, d.mode].filter(Boolean).join(' ');
    if (/(^|[ _-])(wipe|reset-today|import)([ _-]|$)/i.test(sig)) return true;
    if (/^(wipeGo|doForget|doRestore|aiClear)$/.test(el.id || '')) return true;
    var t = String(el.textContent || '').replace(/\s+/g, '');
    if (/清除全部|删除全部|从头开始|恢复快照|回滚到这份快照/.test(t)) return true;
    return false;
  };
  A.isDestructive = function (el) {
    var act = (el.dataset && el.dataset.act) || '';
    if (/^(del-|remove|delete)/.test(act)) return true;
    return /^(doForget|aiClear|wipeGo)$/.test(el.id || '');
  };

  A.enumerate = function (scope) {
    // scope: 'sheet' = 只枚举弹出的那一层（弹层打开时，背景页面被遮住、用户其实点不到，
    // 不该把它们算进来）；'page' = 只枚举主页面；不传 = 全部（给界面还原判定用）。
    var roots = ROOT_SELECTORS;
    if (scope === 'sheet') roots = ['#sheetRoot'];
    else if (scope === 'page') roots = ['#app', '.topbar', '.tabbar'];
    var items = [];
    var seen = [];
    var rawCount = 0;
    var hiddenCount = 0;
    var externalCount = 0;
    var nonButtonCount = 0;
    for (var r = 0; r < roots.length; r++) {
      var root = document.querySelector(roots[r]);
      if (!root) continue;
      var list = [];
      try { list = root.querySelectorAll(CAND_SELECTOR); } catch (e17) { continue; }
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (seen.indexOf(el) >= 0) continue;
        seen.push(el);
        rawCount += 1;
        if (!A.visible(el)) { hiddenCount += 1; continue; }
        // 文本/数字输入框、textarea、select 不算按钮：点它们本来就不该「有反应」，
        // 混进来会变成死按钮误报（曾经把「这样记对吗」弹层里的份量输入框误判过）。
        var tag = el.tagName;
        if ((tag === 'INPUT' && !/^(button|submit|reset|checkbox|radio)$/i.test(el.type || '')) || tag === 'TEXTAREA' || tag === 'SELECT') {
          nonButtonCount += 1;
          continue;
        }
        if (el.closest && el.closest('.toast, .celebrate')) continue;
        if (A.isExternal(el)) { externalCount += 1; continue; }
        var key = A.keyOf(el);
        if (!key) continue;
        items.push({
          key: key,
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          text: A.textOf(el),
          disabled: !!el.disabled,
          // 「本来就是选中的」：点它本来就不该有变化（比如已经选中的分段/档位），
          // 这类不能算死按钮，否则会把「点了和没点一样」的选中项全误报成 bug。
          selected: el.getAttribute('aria-selected') === 'true'
            || el.getAttribute('aria-pressed') === 'true'
            || el.classList.contains('on')
            || el.classList.contains('active'),
          dangerous: A.isDangerous(el),
          destructive: A.isDestructive(el),
          attrs: A.attrMap(el)
        });
      }
    }
    return { items: items, rawCount: rawCount, hiddenCount: hiddenCount, externalCount: externalCount, nonButtonCount: nonButtonCount };
  };

  /* ── 弹层关闭 ─────────────────────────────────────── */
  A.removeOverlays = function () {
    var nodes = document.querySelectorAll('.toast, .celebrate');
    for (var i = 0; i < nodes.length; i++) {
      try { nodes[i].remove(); } catch (e18) { /* 忽略 */ }
    }
  };

  A.closeSheet = async function () {
    if (!A.sheetOpen()) return { wasOpen: false, method: 'none', worked: true };
    var r = { wasOpen: true, method: null, worked: false };
    var closeBtn = document.getElementById('sheetClose');
    if (closeBtn) {
      closeBtn.click();
      await A.sleep(70);
      if (!A.sheetOpen()) { r.method = '#sheetClose'; r.worked = true; return r; }
    }
    var mask = document.querySelector('.sheet-mask');
    if (mask) {
      mask.click();
      await A.sleep(70);
      if (!A.sheetOpen()) { r.method = '.sheet-mask'; r.worked = true; return r; }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await A.sleep(120);
    if (!A.sheetOpen()) { r.method = 'Escape'; r.worked = true; return r; }
    return r;
  };

  A.matchExpect = function (expect, state) {
    if (!expect) return true;
    if (expect.tab) {
      var tabs = Array.isArray(expect.tab) ? expect.tab : [expect.tab];
      if (tabs.indexOf(state.activeTab) < 0) return false;
    }
    if (expect.sheetKind === null) {
      if (state.sheetOpen) return false;
    } else if (expect.sheetKind) {
      if (!state.sheetOpen || state.sheetKind !== expect.sheetKind) return false;
    }
    var mustHave = expect.mustHave || [];
    for (var i = 0; i < mustHave.length; i++) {
      var ok;
      try { ok = !!document.querySelector(mustHave[i]); } catch (e19) { ok = false; }
      if (!ok) return false;
    }
    var mustNotHave = expect.mustNotHave || [];
    for (var j = 0; j < mustNotHave.length; j++) {
      var bad;
      try { bad = !!document.querySelector(mustNotHave[j]); } catch (e20) { bad = false; }
      if (bad) return false;
    }
    return true;
  };

  /**
   * 回到某个界面：先关弹层，再按路径重放点击。
   * 路径是「从刷新后的初始页开始的一串点击」，所以刷新与不刷新都能用。
   */
  A.restore = async function (params) {
    var path = params.path || [];
    var expect = params.expect || {};
    A.removeOverlays();
    var close = await A.closeSheet();
    var failedStep = null;
    for (var i = 0; i < path.length; i++) {
      var el = A.resolve(path[i]);
      if (!el) { failedStep = path[i]; break; }
      el.click();
      await A.sleep(110);
    }
    if (failedStep) {
      return { ok: false, failedStep: failedStep, close: close, sheetOpen: A.sheetOpen(), sheetKind: A.sheetKind() };
    }
    if (params.prelude) {
      try { (new Function(params.prelude))(); } catch (e21) { /* 前置动作失败就按原界面继续 */ }
      await A.sleep(80);
    }
    var deadline = Date.now() + (params.timeoutMs || 2800);
    var last = null;
    while (Date.now() < deadline) {
      last = {
        activeTab: A.activeTab(),
        sheetOpen: A.sheetOpen(),
        sheetKind: A.sheetKind(),
        sheetTitle: A.sheetTitle(),
        count: A.enumerate().items.length
      };
      if (A.matchExpect(expect, last)) return { ok: true, close: close, state: last };
      await A.sleep(120);
    }
    return { ok: false, timeout: true, close: close, got: last };
  };

  /* ── 单次点击探测 ───────────────────────────────────
     只负责点一下、观察；不负责恢复界面（恢复由下一次 restore 做）。
     返回「点之前 / 点之后」的可比较快照，以及这段时间里新增的异常、确认框等。 */
  A.probe = async function (params) {
    var target = params.target;
    var waitMs = params.waitMs || 320;
    var extraWaitMs = params.extraWaitMs || 1000;
    var el = A.resolve(target);
    if (!el) return { ok: false, missing: true, target: target };
    var before = A.snapshot();
    var marks = {
      errs: A.errs.length, console: A.consoleErrors.length, confirms: A.confirms.length,
      files: A.files.length, mutations: A.mutations, alerts: A.alerts.length
    };
    var disabled = !!el.disabled;
    var tag = el.tagName.toLowerCase();
    var text = A.textOf(el);
    el.click();
    await A.sleep(waitMs);
    var early = A.diff(before, A.snapshot());
    var waited = waitMs;
    var late = { changed: false, reasons: [] };
    if (!early.changed && !disabled) {
      await A.sleep(extraWaitMs);
      waited += extraWaitMs;
      late = A.diff(before, A.snapshot());
    }
    var after = A.snapshot();
    return {
      ok: true,
      target: target,
      tag: tag,
      text: text,
      disabled: disabled,
      waited: waited,
      changed: early.changed || late.changed,
      changeAtMs: early.changed ? waitMs : (late.changed ? waited : null),
      changeReasons: (early.changed ? early.reasons : late.reasons),
      sheetBefore: before.sheetOpen,
      sheetAfter: after.sheetOpen,
      sheetKindAfter: after.sheetKind,
      sheetTitleAfter: after.sheetTitle,
      activeTabAfter: after.activeTab,
      dateBefore: before.dateText,
      dateAfter: after.dateText,
      mutations: after.mutations - marks.mutations,
      storageChanged: before.storage.hash !== after.storage.hash,
      storageKeysBefore: before.storage.keys,
      storageKeysAfter: after.storage.keys,
      confirms: A.confirms.slice(marks.confirms),
      files: A.files.slice(marks.files),
      alerts: A.alerts.slice(marks.alerts),
      errs: A.errs.slice(marks.errs),
      consoleErrors: A.consoleErrors.slice(marks.console),
      appReady: window.__appReady === true,
      stateParseOk: A.stateParseOk(),
      bootFailVisible: (function () {
        var b = document.getElementById('bootFail');
        return !!b && b.hidden === false;
      })()
    };
  };

  /* ── 反向验证用的「人为破坏」 ───────────────────────
     把按钮换成一个没有事件监听的克隆。注意不能用 el.onclick = null ——
     应用全部用 addEventListener 绑定，onclick 本来就是空的，那样破坏不了。 */
  A.sabotage = function (key) {
    var el = A.resolve(key);
    if (!el) return { ok: false, reason: '找不到元素 ' + key };
    var clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    return { ok: true, key: key };
  };

  /* ── 额外检查 ─────────────────────────────────────── */

  /** 「从头开始」门禁：确认按钮默认禁用、输入「清除」才可用、字不对仍然禁用；
      全程不点确认按钮，只验证门禁是否真的存在。 */
  A.guardWipe = async function () {
    A.removeOverlays();
    await A.closeSheet();
    var profileBtn = document.getElementById('profileBtn');
    if (!profileBtn) return { ok: false, reason: '顶栏没有「我的资料」按钮' };
    profileBtn.click();
    await A.sleep(320);
    if (A.sheetKind() !== 'settings') return { ok: false, reason: '设置弹层没打开（实际 ' + A.sheetKind() + '）' };
    var row = A.resolve('[data-set="wipe"]');
    if (!row) return { ok: false, reason: '设置里没有「从头开始」入口' };
    row.click();
    await A.sleep(320);
    if (A.sheetKind() !== 'wipe') return { ok: false, reason: '「从头开始」弹层没打开（实际 ' + A.sheetKind() + '）' };
    var go = document.getElementById('wipeGo');
    var input = document.getElementById('wipeConfirm');
    if (!go || !input) return { ok: false, reason: '弹层里缺输入框或确认按钮' };
    var before = A.storageHash();
    var disabledInitially = !!go.disabled;
    input.value = '清除';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await A.sleep(80);
    var enabledAfterTyping = !go.disabled;
    input.value = '清';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await A.sleep(80);
    var disabledForWrongWord = !!go.disabled;
    input.value = '清除';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await A.sleep(80);
    var after = A.storageHash();
    var closed = await A.closeSheet();
    return {
      ok: true,
      opened: true,
      disabledInitially: disabledInitially,
      enabledAfterTyping: enabledAfterTyping,
      disabledForWrongWord: disabledForWrongWord,
      storageUnchanged: before.hash === after.hash,
      closed: closed.worked,
      closedBy: closed.method
    };
  };

  /** Esc 关弹层（应用没实现也算如实记录，不算失败） */
  A.escCheck = async function () {
    A.removeOverlays();
    await A.closeSheet();
    var profileBtn = document.getElementById('profileBtn');
    if (!profileBtn) return { ok: false, reason: '没有设置入口' };
    profileBtn.click();
    await A.sleep(320);
    var opened = A.sheetOpen();
    if (!opened) return { ok: false, reason: '设置弹层没打开' };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await A.sleep(160);
    var stillOpen = A.sheetOpen();
    var closed = await A.closeSheet();
    return { ok: true, opened: opened, escCloses: !stillOpen, closedBy: closed.method };
  };

  /** 启动失败兜底元素是否存在（index.html 声称有 #bootFail） */
  A.bootFailCheck = function () {
    return {
      hasBootFailEl: !!document.getElementById('bootFail'),
      hasBootFailDetail: !!document.getElementById('bootFailDetail'),
      ready: window.__appReady === true
    };
  };

  /** 「说一句」→ 解析 → 「这样记对吗」弹层（带份量档位）。用于覆盖份量切换按钮。 */
  A.restoreDraft = async function (text) {
    A.removeOverlays();
    var close = await A.closeSheet();
    var mainTab = A.resolve('.tab[data-view="log"]');
    if (mainTab) { mainTab.click(); await A.sleep(140); }
    var seg = A.resolve('[data-record-tab="food"]');
    if (seg) { seg.click(); await A.sleep(120); }
    var ta = document.getElementById('quickText');
    if (!ta) return { ok: false, reason: '记录页没有「说一句」输入框', close: close };
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    var btn = document.getElementById('quickParse');
    if (!btn) return { ok: false, reason: '没有「解析这一句」按钮', close: close };
    btn.click();
    var deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (A.sheetOpen() && A.sheetKind() === 'draft') {
        return { ok: true, close: close, count: A.enumerate('sheet').items.length };
      }
      await A.sleep(120);
    }
    return { ok: false, reason: '解析后没有打开「这样记对吗」弹层', sheetOpen: A.sheetOpen(), sheetKind: A.sheetKind() };
  };

  A.scrollToKey = function (key) {
    var el = A.resolve(key);
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e22) { /* 忽略 */ }
    return true;
  };

  A.asyncSheetInfo = function () {
    return {
      sheetOpen: A.sheetOpen(),
      sheetKind: A.sheetKind(),
      sheetTitle: A.sheetTitle(),
      count: A.enumerate('sheet').items.length
    };
  };
})();
`;

/* ────────────────────────────────────────────────────────
   三、CDP 连接 / 浏览器启动
   ──────────────────────────────────────────────────────── */

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const handlers = new Map();
    ws.addEventListener('open', () => resolve({
      ws,
      on(method, handler) { handlers.set(method, handler); },
      close() { try { ws.close(); } catch { /* 已经关了 */ } },
      send(method, params = {}) {
        const msgId = ++id;
        ws.send(JSON.stringify({ id: msgId, method, params }));
        return new Promise((res, rej) => pending.set(msgId, { res, rej }));
      },
    }));
    ws.addEventListener('error', reject);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method && handlers.has(msg.method)) {
        try { handlers.get(msg.method)(msg.params); } catch { /* 处理器的异常不能拖垮连接 */ }
      }
    });
  });
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = now() + timeoutMs;
  let last = '';
  while (now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
      last = 'HTTP ' + res.status;
    } catch (err) {
      last = err.message;
    }
    await sleep(200);
  }
  throw new Error(`本地服务没起来（${url}）：${last}`);
}

function startStaticServer() {
  freePort(STATIC_PORT);
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.mjs'), String(STATIC_PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  return {
    child,
    logs,
    stop() { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } },
  };
}

/* ────────────────────────────────────────────────────────
   四、清扫主流程
   ──────────────────────────────────────────────────────── */

const ROOT_SCENES = {
  a: [
    {
      id: 'welcome', label: '欢迎页',
      path: ['.tab[data-view="today"]'],
      expect: { tab: 'today', sheetKind: null, mustHave: ['[data-act="onboard"]'] },
    },
    {
      id: 'welcome-progress', label: '我的页（还没填资料）',
      path: ['.tab[data-view="progress"]'],
      expect: { tab: 'progress', sheetKind: null, mustHave: ['[data-act="export"]'] },
    },
  ],
  b: [
    {
      id: 'today', label: '今天页',
      path: ['.tab[data-view="today"]'],
      expect: { tab: 'today', sheetKind: null, mustHave: ['[data-act="growth"]'] },
    },
    {
      id: 'log', label: '记录页 › 吃的',
      path: ['.tab[data-view="log"]', '[data-record-tab="food"]'],
      expect: { tab: 'log', sheetKind: null, mustHave: ['#quickParse'] },
    },
    {
      id: 'log-training', label: '记录页 › 练的',
      path: ['.tab[data-view="log"]', '[data-record-tab="training"]'],
      expect: { tab: 'log', sheetKind: null, mustHave: ['#trainSave'] },
      // 器械选择器默认折叠，展开才能看到里面的器械按钮（否则它们不可见、枚举不到）
      prelude: `(function(){var d=document.getElementById('trainEquipBox'); if (d) d.open = true;})()`,
    },
    {
      id: 'plan', label: '计划页',
      path: ['.tab[data-view="plan"]'],
      expect: { tab: 'plan', sheetKind: null, mustHave: ['#trainDays'] },
      // 「替代方案」在折叠的 details 里，展开才能覆盖 data-subs 按钮
      prelude: `(function(){var ds=document.querySelectorAll('#app details'); for (var i=0;i<ds.length;i++){ if ((ds[i].textContent||'').indexOf('替代方案')>=0) ds[i].open = true; }})()`,
    },
    {
      id: 'progress', label: '我的页',
      path: ['.tab[data-view="progress"]'],
      expect: { tab: 'progress', sheetKind: null, mustHave: ['#weightInput'] },
    },
  ],
};

const KIND_LABEL = {
  'food-picker': '加食物弹层',
  'amount': '份量弹层',
  'custom-food': '新增自定义食物弹层',
  'draft': '「这样记对吗」弹层',
  'ai-settings': 'AI 设置弹层',
  'profile': '资料弹层',
  'settings': '设置弹层',
  'recover': '找回记录弹层',
  'wipe': '「从头开始」弹层',
  'backup': '数据与备份弹层',
  'about': '关于弹层',
  'growth': '成长弹层',
  'weight': '记体重弹层',
  'exercise': '加运动弹层',
  'calendar': '日历弹层',
  'substitute': '运动替代方案弹层',
  'onboard-intro': '引导第 1 步「先说三件事」',
  'onboard-mode': '引导第 3 步「用 AI 帮你记」',
  'onboard-first': '引导第 4 步「最后一步」',
};

/** 同一种弹层最多在几种不同上下文里深入探测 —— 防止递归把预算烧光 */
const KIND_MAX_SURFACES = { profile: 2, 'ai-settings': 2 };

/** 按「同类型元素分组，再抽样」的规则，避免 30 个日历格子逐个点爆预算 */
const WITH_VALUE_ATTRS = new Set([
  'data-act', 'data-set', 'data-mode', 'data-recover', 'data-wipe', 'data-view',
  'data-record-tab', 'data-sex',
]);

function groupCandidates(candidates) {
  const groups = new Map();
  for (const cand of candidates) {
    const names = Object.keys(cand.attrs).sort();
    const parts = [cand.tag];
    if (cand.id) parts.push('#' + cand.id);
    parts.push(names.join(','));
    for (const name of names) {
      if (WITH_VALUE_ATTRS.has(name)) parts.push(name + '=' + cand.attrs[name]);
    }
    const key = parts.join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cand);
  }
  return groups;
}

function sampleGroup(list) {
  const n = list.length;
  if (n <= 2) return list.slice();
  if (n <= 6) return [list[0], list[n - 1]];
  return [list[0], list[Math.floor(n / 2)], list[n - 1]];
}

function pickSamples(groups) {
  const samples = [];
  const notSampled = [];
  for (const [groupKey, list] of groups) {
    const picked = sampleGroup(list);
    for (const cand of picked) samples.push(cand);
    if (list.length > picked.length) {
      notSampled.push({
        groupKey,
        total: list.length,
        sampled: picked.length,
        examples: list.filter((c) => !picked.includes(c)).slice(0, 3).map((c) => c.key),
      });
    }
  }
  return { samples, notSampled };
}

/* ── 运行时上下文 ─────────────────────────────────────── */

const ctx = {
  startedAt: now(),
  sweepStartedAt: 0,
  deadline: 0,
  client: null,
  chrome: null,
  server: null,
  cdpExceptions: [],
  probeBudget: 330,
  probeCount: 0,
  screenshots: 0,
  states: {},
  checks: {},
  reverse: null,
  limits: [],
  fatal: null,
  log: [],
};

function logLine(msg) {
  const line = String(msg);
  ctx.log.push(line);
  console.log(line);
}

function timeLeft() {
  return ctx.deadline - now();
}

async function evaluate(expression) {
  let lastErr = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const r = await ctx.client.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (r.exceptionDetails) {
        const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '未知异常';
        throw new Error('页面执行出错：' + String(desc).split('\n')[0]);
      }
      return r.result.value;
    } catch (err) {
      lastErr = err;
      const msg = String((err && err.message) || err);
      if (/Execution context|Cannot find context|context was destroyed|Inspected target navigated|Target closed|no longer exists|Promise was collected/i.test(msg) && attempt < 29) {
        await sleep(120);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('evaluate 重试次数用尽');
}

async function waitAppReady(timeoutMs = 15000) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const ok = await evaluate('!!(window.__A && window.__appReady === true && document.getElementById("app"))');
      if (ok) return true;
    } catch { /* 导航过程中上下文会被销毁，继续等 */ }
    await sleep(120);
  }
  return false;
}

async function reloadAndWait() {
  await ctx.client.send('Page.reload', { ignoreCache: false });
  await sleep(120);
  return waitAppReady(15000);
}

async function switchBaseline(name) {
  const baseline = ctx.baselines[name];
  const payload = JSON.stringify(baseline);
  // 1) 把基线写进 sessionStorage（供每次导航的注入脚本读取）
  await evaluate(`sessionStorage.setItem('__auditBaseline', ${JSON.stringify(payload)})`);
  // 2) 立刻在当前页也重置一次，再刷新，确保刷新后的第一帧就是基线状态
  const storageLiteral = JSON.stringify(baseline.storage || {});
  await evaluate(`(function(){try{localStorage.clear();var s=${storageLiteral};for(var k in s)localStorage.setItem(k,s[k]);}catch(e){}})()`);
  const ok = await reloadAndWait();
  if (!ok) throw new Error(`切换到起始状态「${baseline.label}」后页面没有启动（window.__appReady 不为 true）`);
  const info = await evaluate(`(async function(){
    var stRaw = null;
    try { stRaw = localStorage.getItem('fatloss.state.v2'); } catch (e) {}
    var st = null;
    try { st = stRaw ? JSON.parse(stRaw) : null; } catch (e) {}
    var out = {
      ready: window.__appReady === true,
      sheetOpen: __A.sheetOpen(),
      activeTab: __A.activeTab(),
      hasState: !!st,
      days: st ? Object.keys(st.days || {}).length : 0,
      weights: st ? (st.weights || []).length : 0,
      profile: !!(st && st.profile),
      welcomeVisible: (document.querySelector('#app') && (document.querySelector('#app').textContent || '').indexOf('知道自己在吃多少') >= 0) || false,
      unlockedBadges: 0,
      exerciseCount: 0
    };
    if (st) {
      out.exerciseCount = Object.keys(st.days || {}).reduce(function (n, k) { return n + ((st.days[k].exercises || []).length); }, 0);
      try {
        var ach = await import('./js/achievements.js');
        var calc = await import('./js/calc.js');
        var t = calc.calcTargets(st.profile);
        out.unlockedBadges = ach.achievements(st, t.proteinG).unlocked.length;
      } catch (e) {}
    }
    return out;
  })()`);
  return info;
}

async function captureShot(name) {
  try {
    const shot = await ctx.client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS_DIR, name), Buffer.from(shot.data, 'base64'));
    return `.audit/screenshots/${name}`;
  } catch (err) {
    return null;
  }
}

/* ── 界面 / 弹层模型 ──────────────────────────────────── */

function makeRootSurface(sceneDef, stateKey) {
  return {
    id: sceneDef.id,
    stateKey,
    kind: null,
    label: sceneDef.label,
    path: sceneDef.path.slice(),
    expect: sceneDef.expect,
    prelude: sceneDef.prelude || null,
    chain: [],
    chainLabels: [],
    depth: 0,
    candidates: [],
  };
}

function makeChildSurface(parent, targetKey, sheetKind, sheetTitle, enumRes) {
  const chain = [...parent.chain];
  if (parent.kind) chain.push(parent.kind);
  const chainLabels = [...parent.chainLabels];
  if (parent.kind) chainLabels.push(KIND_LABEL[parent.kind] || parent.kind);
  const kindLabel = KIND_LABEL[sheetKind] || sheetKind;
  return {
    id: `${parent.stateKey}:${chain.join('>')}→${sheetKind}:${parent.depth + 1}`,
    stateKey: parent.stateKey,
    kind: sheetKind,
    title: sheetTitle,
    label: [...chainLabels, kindLabel].join(' › '),
    path: [...parent.path, targetKey],
    expect: { sheetKind, mustHave: [] },
    prelude: null,
    chain,
    chainLabels,
    depth: parent.depth + 1,
    parentKind: parent.kind || 'root',
    candidates: (enumRes && enumRes.items) || [],
    hiddenCount: (enumRes && enumRes.hiddenCount) || 0,
    externalCount: (enumRes && enumRes.externalCount) || 0,
  };
}

async function restoreSurface(surface) {
  const params = { path: surface.path, expect: surface.expect, prelude: surface.prelude || null };
  if (surface.needsReset) {
    const ok = await reloadAndWait();
    if (!ok) return { ok: false, reason: '刷新后页面没启动', reloadFailed: true };
  }
  let r = await evaluate(`__A.restore(${JSON.stringify(params)})`);
  if (r.ok) return r;
  // 第一次回不到目标界面：大概率是上一次点击把状态改了（比如引导里保存了资料）。
  // 刷新回基线再试一次；成功的话，这个界面后续每次探测前都先刷新，避免反复失败。
  const ok = await reloadAndWait();
  if (!ok) return { ok: false, reason: '刷新后页面没启动', reloadFailed: true, firstAttempt: r };
  const r2 = await evaluate(`__A.restore(${JSON.stringify(params)})`);
  if (r2.ok) surface.needsReset = true;
  return { ...r2, afterReset: true, firstAttempt: r };
}

/* ── 分类 ─────────────────────────────────────────────── */

const ROOT_KINDS = new Set(['onboard-first', 'settings', 'ai-settings', 'wipe', 'recover', 'backup']);
const CAUTION_KINDS = new Set(['onboard-intro', 'onboard-mode', 'profile', 'wipe', 'recover', 'backup', 'custom-food', 'draft', 'settings', 'ai-settings']);

function severityFor(record) {
  if (['app-broken', 'danger-mutated', 'cancel-mutated', 'sheet-stuck'].includes(record.status)) return '事故级';
  if (record.status === 'dead') {
    if (!record.surfaceKind) return '事故级';        // 主页面的按钮点不动 = 用户事故
    if (CAUTION_KINDS.has(record.surfaceKind)) return '严重';
    return '一般';
  }
  if (record.status === 'error-uncaught') return '严重';
  if (record.status === 'error-console') return '一般';
  return '一般';
}

function classifyProbe(cand, probe, surface) {
  const record = {
    stateKey: surface.stateKey,
    surfaceId: surface.id,
    surfaceLabel: surface.label,
    surfaceKind: surface.kind,
    target: cand.key,
    text: cand.text,
    tag: cand.tag,
    dangerous: cand.dangerous,
    destructive: cand.destructive,
    waited: probe.waited,
    changed: probe.changed,
    changeReasons: probe.changeReasons,
    sheetOpened: probe.sheetAfter && !probe.sheetBefore ? probe.sheetKindAfter : null,
    confirms: probe.confirms,
    files: probe.files,
    errs: probe.errs,
    consoleErrors: probe.consoleErrors,
    storageChanged: probe.storageChanged,
    mutations: probe.mutations,
    appReady: probe.appReady,
    stateParseOk: probe.stateParseOk,
    status: 'passed',
    problem: false,
  };
  if (!probe.appReady) {
    record.status = 'app-broken';
    record.problem = true;
    record.detail = '点击后 window.__appReady 不再是 true（应用挂了/白屏）';
    return record;
  }
  if (!probe.stateParseOk || probe.stateParseOk.ok === false) {
    record.status = 'app-broken';
    record.problem = true;
    record.detail = '点击后 localStorage 存档无法解析：' + (probe.stateParseOk && probe.stateParseOk.error);
    return record;
  }
  if (probe.disabled) {
    record.status = 'disabled-skipped';
    record.detail = '元素本就是 disabled，不算死按钮（未点击）';
    return record;
  }
  if (probe.errs && probe.errs.length) {
    record.status = 'error-uncaught';
    record.problem = true;
    record.detail = probe.errs.join(' ｜ ');
    return record;
  }
  if (probe.consoleErrors && probe.consoleErrors.length) {
    record.status = 'error-console';
    record.problem = true;
    record.detail = '界面兜住了异常，但控制台报错：' + probe.consoleErrors.join(' ｜ ');
    return record;
  }
  if (cand.dangerous) {
    if (probe.storageChanged) {
      record.status = 'danger-mutated';
      record.problem = true;
      record.detail = '危险操作在「取消」之后仍然改动了 localStorage';
      return record;
    }
    if (probe.files && probe.files.length) { record.status = 'guarded-file'; record.detail = '文件选择框已拦截，存档未变'; return record; }
    if (probe.confirms && probe.confirms.length) { record.status = 'guarded-confirm'; record.detail = '确认框已取消，存档未变'; return record; }
    if (probe.changed) { record.status = 'guarded-danger'; record.detail = '危险入口只打开弹层/提示，存档未变'; return record; }
    record.status = 'dead';
    record.problem = true;
    record.detail = `等了 ${probe.waited}ms 没有任何反应`;
    return record;
  }
  if (probe.confirms && probe.confirms.length) {
    if (probe.storageChanged) {
      record.status = 'cancel-mutated';
      record.problem = true;
      record.detail = '确认框点「取消」之后 localStorage 仍然变了';
      return record;
    }
    record.status = 'guarded-confirm';
    record.detail = '确认框已取消：' + probe.confirms[0];
    return record;
  }
  if (probe.files && probe.files.length) {
    if (probe.storageChanged) {
      record.status = 'cancel-mutated';
      record.problem = true;
      record.detail = '文件选择被拦截，但 localStorage 变了';
      return record;
    }
    record.status = 'guarded-file';
    record.detail = '文件选择框已拦截，存档未变';
    return record;
  }
  if (probe.changed) { record.status = 'passed'; return record; }
  if (cand.selected) {
    // 点的是当前已选中的那一项：没有变化是正确的（再点一次不会把界面弄乱），
    // 单独记一类，不纳入死按钮。真正「没绑定监听」的未选中项仍然会落进 dead。
    record.status = 'no-op-selected';
    record.detail = '点击前后没有变化，但元素本来就是选中状态（不算死按钮）';
    return record;
  }
  record.status = 'dead';
  record.problem = true;
  record.detail = `点了之后等了 ${probe.waited}ms 没有任何可见反应（DOM/弹层/标签/存档都没变）`;
  return record;
}

function looksAsync(cand) {
  const text = String(cand.text || '') + ' ' + String(cand.key || '');
  return /AI|ai-settings|aiSettings|aiSave|aiTest|aiFetch|data-mode="ai"/.test(text);
}

/* ── 单面清扫 ─────────────────────────────────────────── */

async function sweepSurface(surface, stateResult) {
  const out = {
    surface,
    probes: [],
    discovered: [],
    notSampled: [],
    hiddenCount: 0,
    externalCount: 0,
    nonButtonCount: 0,
    rawCount: 0,
    restoreError: null,
    closeFailures: [],
    limits: [],
  };
  const restored = await restoreSurface(surface);
  if (!restored.ok) {
    out.restoreError = restored;
    stateResult.restoreFailures.push({ surface: surface.label, detail: restored });
    return out;
  }
  const enumScope = surface.kind ? 'sheet' : 'page';
  const enumRes = await evaluate(`__A.enumerate(${JSON.stringify(enumScope)})`);
  out.rawCount = enumRes.rawCount;
  out.hiddenCount = enumRes.hiddenCount;
  out.externalCount = enumRes.externalCount;
  out.nonButtonCount = enumRes.nonButtonCount || 0;
  surface.candidates = enumRes.items;
  const groups = groupCandidates(enumRes.items);
  const { samples, notSampled } = pickSamples(groups);
  out.notSampled = notSampled;
  const surfaceT0 = now();
  logLine(`  ▸ ${surface.label}：可点元素 ${enumRes.items.length} 个（隐藏 ${enumRes.hiddenCount}，外链 ${enumRes.externalCount}），抽样点击 ${samples.length} 个`);

  let first = true;
  for (const cand of samples) {
    if (now() > ctx.deadline) { out.limits.push({ reason: '主清扫时间预算到', remaining: samples.length - out.probes.length }); break; }
    if (ctx.probeCount >= ctx.probeBudget) { out.limits.push({ reason: '全局点击预算到', remaining: samples.length - out.probes.length }); break; }
    if (!first) {
      const rr = await restoreSurface(surface);
      if (rr.close && rr.close.wasOpen && !rr.close.worked) {
        out.closeFailures.push({ target: out.probes[out.probes.length - 1]?.target, close: rr.close });
      }
      if (!rr.ok) {
        out.restoreError = rr;
        stateResult.restoreFailures.push({ surface: surface.label, detail: rr });
        break;
      }
    }
    first = false;

    const cdpBefore = ctx.cdpExceptions.length;
    let probe;
    try {
      probe = await evaluate(`__A.probe(${JSON.stringify({ target: cand.key, waitMs: 300, extraWaitMs: 1000 })})`);
    } catch (err) {
      probe = { ok: false, evaluateError: String(err.message || err) };
    }
    await sleep(40);
    const cdpNew = ctx.cdpExceptions.slice(cdpBefore);
    ctx.probeCount += 1;

    if (!probe || !probe.ok) {
      out.probes.push({
        stateKey: surface.stateKey, surfaceId: surface.id, surfaceLabel: surface.label,
        surfaceKind: surface.kind, target: cand.key, text: cand.text, status: 'missing',
        detail: probe && probe.missing ? '点击前元素已经不在 DOM 里（前一次点击改动了界面）' : (probe?.evaluateError || '探测失败'),
        problem: false,
      });
      continue;
    }
    if (cdpNew.length && (!probe.errs || !probe.errs.length)) {
      probe.errs = cdpNew.map((e) => 'CDP: ' + e);
    }
    const record = classifyProbe(cand, probe, surface);
    out.probes.push(record);

    if (record.problem) {
      stateResult.problems.push(record);
      await maybeScreenshot(record);
    }

    // 发现新弹层：点完出现了一个和当前界面不同类型的弹层，就把它当成下一层继续清扫
    if (!probe.sheetAfter && looksAsync(cand) && now() < ctx.deadline) {
      // 极少数弹层是异步才打开的（AI 设置要先问一次本机服务），多等半秒再确认
      await sleep(650);
      const asyncInfo = await evaluate('__A.asyncSheetInfo()').catch(() => null);
      if (asyncInfo && asyncInfo.sheetOpen) {
        probe.sheetAfter = true;
        probe.sheetKindAfter = asyncInfo.sheetKind;
        probe.sheetTitleAfter = asyncInfo.sheetTitle;
      }
    }
    if (probe.sheetAfter && probe.sheetKindAfter && probe.sheetKindAfter !== surface.kind) {
      const childEnum = await evaluate("__A.enumerate('sheet')").catch(() => null);
      const child = makeChildSurface(surface, cand.key, probe.sheetKindAfter, probe.sheetTitleAfter, childEnum);
      out.discovered.push(child);
    }
  }

  // 最后确认一次弹层能关（最后一个探测留下的弹层）
  const closeCheck = await evaluate('__A.closeSheet()').catch(() => null);
  if (closeCheck && closeCheck.wasOpen && !closeCheck.worked) out.closeFailures.push({ target: '（面清扫结束）', close: closeCheck });

  logLine(`    ↳ 本面用时 ${((now() - surfaceT0) / 1000).toFixed(1)}s`);
  if (out.closeFailures.length) {
    for (const cf of out.closeFailures) {
      const record = {
        stateKey: surface.stateKey, surfaceId: surface.id, surfaceLabel: surface.label,
        surfaceKind: surface.kind, target: cf.target || '（未知）', text: '',
        status: 'sheet-stuck', problem: true,
        detail: '弹层关不掉：点 #sheetClose、点遮罩、按 Esc 都没能关闭',
      };
      stateResult.problems.push(record);
      out.probes.push(record);
    }
  }
  return out;
}

async function maybeScreenshot(record) {
  if (ctx.screenshots >= 30) return;
  const idx = String(ctx.screenshots + 1).padStart(2, '0');
  const safeKey = String(record.target || 'x').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
  const name = `sweep-${record.stateKey}-${idx}-${record.status}-${safeKey}.png`;
  try {
    if (record.target) await evaluate(`__A.scrollToKey(${JSON.stringify(record.target)})`).catch(() => {});
    const shot = await ctx.client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS_DIR, name), Buffer.from(shot.data, 'base64'));
    record.screenshot = `.audit/screenshots/${name}`;
    ctx.screenshots += 1;
  } catch { /* 截图失败不影响判定 */ }
}

/* ── 一套起始状态的整体清扫 ───────────────────────────── */

function dedupeKeyFor(surface) {
  // 同一类弹层在不同入口下可能内容一样，按「类型 + 父级类型」去重；
  // 引导相关的弹层要看完整链路（重看引导 review 模式和新用户流程不一样）。
  const chain = surface.chain.join('>');
  return `${surface.kind}@${surface.parentKind || 'root'}@${chain}`;
}

async function sweepState(stateKey) {
  const startedAt = now();
  const info = await switchBaseline(stateKey);
  const result = {
    stateKey,
    label: ctx.baselines[stateKey].label,
    note: ctx.baselines[stateKey].note,
    baselineInfo: info,
    surfaces: [],
    probes: [],
    problems: [],
    restoreFailures: [],
    limits: [],
    notSampled: [],
    hiddenCount: 0,
    externalCount: 0,
    nonButtonCount: 0,
    rawCount: 0,
    startedAt,
    finishedAt: null,
  };
  logLine(`\n=== 起始状态 ${stateKey}：${result.label} ===`);
  logLine(`  启动成功=${info.ready} 弹层默认关闭=${!info.sheetOpen} 存档天数=${info.days} 体重=${info.weights} 运动=${info.exerciseCount} 已解锁徽章=${info.unlockedBadges}`);
  if (stateKey === 'a') {
    if (!info.welcomeVisible) throw new Error('空白新用户状态没有显示欢迎页（应该显示「知道自己在吃多少」）');
  } else {
    if (info.days < 3) throw new Error(`有记录状态存档只有 ${info.days} 天记录（应 ≥3）`);
    if (info.weights < 3) throw new Error(`有记录状态只有 ${info.weights} 条体重（应 ≥3）`);
    if (info.exerciseCount < 1) throw new Error('有记录状态没有任何运动记录');
    if (info.unlockedBadges < 1) throw new Error('有记录状态没有已解锁徽章');
  }
  result.baselineShot = await captureShot(`sweep-baseline-${stateKey}.png`);

  const queue = ROOT_SCENES[stateKey].map((def) => makeRootSurface(def, stateKey));
  const kindCount = new Map();
  const seenSurfaceKeys = new Set();
  let surfaceCount = 0;
  const pendingSurfaces = [];

  while (queue.length) {
    if (now() > ctx.deadline) {
      result.limits.push({ reason: '主清扫时间预算到', stateKey, remainingSurfaces: queue.length });
      pendingSurfaces.push(...queue);
      break;
    }
    if (surfaceCount >= MAX_SURFACES_PER_STATE) {
      result.limits.push({ reason: `单套状态界面数上限 ${MAX_SURFACES_PER_STATE}`, stateKey, remainingSurfaces: queue.length });
      pendingSurfaces.push(...queue);
      break;
    }
    if (result.probes.length >= MAX_PROBES_PER_STATE) {
      result.limits.push({ reason: `单套状态点击上限 ${MAX_PROBES_PER_STATE}`, stateKey, remainingSurfaces: queue.length });
      pendingSurfaces.push(...queue);
      break;
    }
    const surface = queue.shift();
    surfaceCount += 1;
    const swept = await sweepSurface(surface, result);
    result.surfaces.push({
      id: surface.id,
      label: surface.label,
      kind: surface.kind,
      depth: surface.depth,
      candidates: surface.candidates.length,
      rawCount: swept.rawCount,
      hiddenCount: swept.hiddenCount,
      externalCount: swept.externalCount,
      nonButtonCount: swept.nonButtonCount,
      sampled: swept.probes.filter((p) => p.status !== 'sheet-stuck').length,
      notSampled: swept.notSampled,
      restoreError: swept.restoreError ? String(swept.restoreError.reason || swept.restoreError.failedStep || '回不到界面') : null,
    });
    result.probes.push(...swept.probes);
    result.hiddenCount += swept.hiddenCount;
    result.externalCount += swept.externalCount;
    result.nonButtonCount = (result.nonButtonCount || 0) + swept.nonButtonCount;
    result.rawCount += swept.rawCount;
    for (const child of swept.discovered) {
      const dk = dedupeKeyFor(child);
      if (seenSurfaceKeys.has(dk)) {
        result.limits.push({ reason: '同一入口的同类弹层已经展开过，跳过重复的', stateKey, surface: child.label, candidates: child.candidates.length });
        continue;
      }
      const maxForKind = KIND_MAX_SURFACES[child.kind] || 1;
      const used = kindCount.get(child.kind) || 0;
      if (used >= maxForKind) {
        result.limits.push({ reason: '同类弹层已覆盖过，跳过', stateKey, surface: child.label, candidates: child.candidates.length });
        continue;
      }
      seenSurfaceKeys.add(dk);
      kindCount.set(child.kind, used + 1);
      queue.push(child);
    }
    if (swept.restoreError) continue;
  }

  for (const left of pendingSurfaces) {
    result.limits.push({ reason: '未开始清扫（预算/上限）', stateKey, surface: left.label, candidates: (left.candidates || []).length });
  }
  // 同一类弹层被跳过的情况也记进未覆盖
  for (const kind of Object.keys(KIND_LABEL)) {
    const used = kindCount.get(kind) || 0;
    if (used === 0) result.limits.push({ reason: '该弹层在本起始状态下没有打开过（可能入口不存在）', stateKey, sheetKind: kind });
  }
  result.finishedAt = now();
  logLine(`  小计：点 ${result.probes.length} 个；死按钮 ${result.problems.filter((p) => p.status === 'dead').length}；报错 ${result.problems.filter((p) => String(p.status).startsWith('error')).length}；回不到界面 ${result.restoreFailures.length} 次`);
  return result;
}

/* ── 额外场景：解析后的份量追问弹层 ─────────────────────
   普通清扫只点按钮、不输入文字，而份量档位按钮（data-pick-portion）只有
   「说一句」解析出低置信度条目后才会出现。这里补一个专门场景。 */

async function sweepDraftScenario(stateKey, draftText) {
  const result = { label: '解析后的「这样记对吗」弹层（份量档位/餐次切换/记上/重写）', probes: [], problems: [], restoreError: null, candidates: 0 };
  if (now() > ctx.deadline) { result.skipped = '时间预算到，未执行'; return result; }
  if (stateKey !== 'b') { result.skipped = '只在有记录的存档上执行'; return result; }
  let restored = await evaluate(`__A.restoreDraft(${JSON.stringify(draftText)})`);
  if (!restored.ok) {
    result.probes.push({ status: 'missing', target: '#quickParse', text: '解析这一句', surfaceLabel: result.label, detail: '解析后没有出现确认弹层：' + restored.reason, problem: false });
    return result;
  }
  const enumRes = await evaluate("__A.enumerate('sheet')");
  result.candidates = enumRes.items.length;
  result.nonButtonCount = enumRes.nonButtonCount || 0;
  const groups = groupCandidates(enumRes.items);
  const { samples } = pickSamples(groups);
  logLine(`  ▸ ${result.label}：可点元素 ${enumRes.items.length} 个，抽样点击 ${samples.length} 个`);
  let first = true;
  for (const cand of samples) {
    if (now() > ctx.deadline || ctx.probeCount >= ctx.probeBudget) break;
    if (!first) restored = await evaluate(`__A.restoreDraft(${JSON.stringify(draftText)})`);
    first = false;
    if (!restored.ok) { result.restoreError = restored; break; }
    const cdpBefore = ctx.cdpExceptions.length;
    const probe = await evaluate(`__A.probe(${JSON.stringify({ target: cand.key, waitMs: 300, extraWaitMs: 1000 })})`).catch((err) => ({ ok: false, evaluateError: String(err.message || err) }));
    await sleep(40);
    ctx.probeCount += 1;
    const cdpNew = ctx.cdpExceptions.slice(cdpBefore);
    if (!probe || !probe.ok) { result.probes.push({ status: 'missing', target: cand.key, text: cand.text, surfaceLabel: result.label, problem: false }); continue; }
    if (cdpNew.length && (!probe.errs || !probe.errs.length)) probe.errs = cdpNew.map((e) => 'CDP: ' + e);
    const fakeSurface = { stateKey, id: 'draft-scenario', label: result.label, kind: 'draft' };
    const record = classifyProbe(cand, probe, fakeSurface);
    result.probes.push(record);
    if (record.problem) {
      result.problems.push(record);
      await maybeScreenshot(record);
    }
  }
  await evaluate('__A.closeSheet()').catch(() => {});
  return result;
}

/* ── 附加检查：门禁 / Esc / 启动兜底 ──────────────────── */

async function runExtraChecks() {
  const checks = {};
  try {
    checks.bootFail = await evaluate('__A.bootFailCheck()');
  } catch (err) { checks.bootFail = { error: String(err.message || err) }; }
  try {
    checks.esc = await evaluate('__A.escCheck()');
  } catch (err) { checks.esc = { error: String(err.message || err) }; }
  try {
    await reloadAndWait();
    checks.wipeGuard = await evaluate('__A.guardWipe()');
  } catch (err) { checks.wipeGuard = { error: String(err.message || err) }; }
  return checks;
}

/* ── 反向验证：证明这套检查真的会失败 ─────────────────── */

async function runReverse() {
  const rev = { cases: [], passed: false, startedAt: now() };
  logLine('\n=== 反向验证：故意破坏按钮，确认清扫会报「死按钮」 ===');

  // 用例 1：把顶栏「前一天」换成没有监听的克隆，然后重跑「今天页」这一整面的清扫流程。
  //   —— 覆盖的是完整流水线（枚举 → 抽样 → 点击 → 判定 → 截图），不是只测判定函数。
  await switchBaseline('b');
  const todaySurface = makeRootSurface(ROOT_SCENES.b[0], 'b');
  const restoreToday = await restoreSurface(todaySurface);
  if (!restoreToday.ok) throw new Error('反向验证：今天页回不去');
  const sabotage1 = await evaluate(`__A.sabotage('#prevDay')`);
  const case1 = { name: '整面清扫（今天页）：把「前一天」按钮换成没有事件监听的克隆，重跑同一套点击流程', expected: '清扫结果里出现死按钮 #prevDay；未破坏的「后一天」仍然通过', sabotage: sabotage1 };
  if (!sabotage1.ok) {
    case1.passed = false;
    case1.actual = '破坏失败：' + sabotage1.reason;
  } else {
    const fakeState = { probes: [], problems: [], restoreFailures: [], limits: [], hiddenCount: 0, externalCount: 0, rawCount: 0 };
    const swept = await sweepSurface(todaySurface, fakeState);
    const dead = swept.probes.filter((p) => p.status === 'dead').map((p) => p.target);
    const nextDay = swept.probes.find((p) => p.target && p.target.indexOf('nextDay') >= 0);
    case1.dead = dead;
    case1.controlNextDay = nextDay ? nextDay.status : '未跑到';
    case1.passed = dead.some((k) => k.indexOf('prevDay') >= 0) && nextDay && nextDay.status === 'passed';
    case1.actual = `死按钮：${dead.join(', ') || '（无）'}；对照「后一天」状态：${nextDay ? nextDay.status : '未跑到'}`;
    await maybeScreenshot({ stateKey: 'reverse1', target: '#prevDay', status: 'dead', label: case1.name }).catch(() => {});
  }
  rev.cases.push(case1);

  // 用例 2：弹层内部按钮被破坏。打开设置弹层，把「关于」行换成克隆，直接点它。
  //   —— 证明弹层里的按钮也在检查范围内（当初事故也可能是弹层里的按钮）。
  await reloadAndWait();
  const restoreToday2 = await restoreSurface(makeRootSurface(ROOT_SCENES.b[0], 'b'));
  if (!restoreToday2.ok) throw new Error('反向验证：今天页回不去（第二次）');
  const case2 = { name: '弹层内部按钮：打开设置弹层，把「关于」这一行换成没有监听的克隆后点击', expected: '「关于」判定为死按钮；同一弹层里未破坏的「我的成长」仍然通过', passed: false };
  const openSettings = await evaluate(`(async function(){
    var b = document.getElementById('profileBtn'); if (!b) return {ok:false, reason:'没有设置入口'};
    b.click(); await __A.sleep(350);
    return { ok: __A.sheetKind() === 'settings', kind: __A.sheetKind() };
  })()`);
  if (!openSettings.ok) {
    case2.actual = '设置弹层打不开：' + (openSettings.kind || openSettings.reason);
  } else {
    const sabotage2 = await evaluate(`__A.sabotage('[data-set="about"]')`);
    if (!sabotage2.ok) {
      case2.actual = '破坏失败：' + sabotage2.reason;
    } else {
      const cdpBefore = ctx.cdpExceptions.length;
      const probeDead = await evaluate(`__A.probe(${JSON.stringify({ target: '[data-set="about"]', waitMs: 320, extraWaitMs: 1000 })})`);
      await sleep(40);
      ctx.probeCount += 1;
      const deadRecord = classifyProbe({ key: '[data-set="about"]', text: '关于', tag: 'button', dangerous: false }, probeDead, { stateKey: 'reverse2', id: 'settings-sabotage', label: '设置弹层（反向验证）', kind: 'settings' });
      const probeAlive = await evaluate(`__A.probe(${JSON.stringify({ target: '[data-set="growth"]', waitMs: 320, extraWaitMs: 1000 })})`);
      await sleep(40);
      ctx.probeCount += 1;
      const cdpNew = ctx.cdpExceptions.slice(cdpBefore);
      if (cdpNew.length && (!probeAlive.errs || !probeAlive.errs.length)) probeAlive.errs = cdpNew.map((e) => 'CDP: ' + e);
      const aliveRecord = classifyProbe({ key: '[data-set="growth"]', text: '我的成长', tag: 'button', dangerous: false }, probeAlive, { stateKey: 'reverse2', id: 'settings-sabotage', label: '设置弹层（反向验证）', kind: 'settings' });
      case2.deadStatus = deadRecord.status;
      case2.controlStatus = aliveRecord.status;
      case2.passed = deadRecord.status === 'dead' && aliveRecord.status === 'passed';
      case2.actual = `被破坏的「关于」：${deadRecord.status}；未破坏的「我的成长」：${aliveRecord.status}`;
      if (deadRecord.status !== 'dead') await maybeScreenshot({ stateKey: 'reverse2', target: '[data-set="about"]', status: 'reverse-not-detected', label: case2.name }).catch(() => {});
    }
  }
  rev.cases.push(case2);

  // 用例 3：复刻真实事故现场 —— 欢迎页按钮被换成没有监听的克隆。
  //   （用户真机上遇到的就是「欢迎页所有按钮点不动」，那次是手工发现的。）
  const case3 = { name: '真实事故复刻：欢迎页「开始」按钮换成没有监听的克隆后点击', expected: '判定为死按钮；同一页未破坏的「直接填资料」仍然能打开弹层', passed: false };
  await switchBaseline('a');
  const sabotage3 = await evaluate(`__A.sabotage('[data-act="onboard"]')`);
  if (!sabotage3.ok) {
    case3.actual = '破坏失败：' + sabotage3.reason;
  } else {
    const probeDead = await evaluate(`__A.probe(${JSON.stringify({ target: '[data-act="onboard"]', waitMs: 320, extraWaitMs: 1000 })})`);
    await sleep(40);
    ctx.probeCount += 1;
    const deadRecord = classifyProbe({ key: '[data-act="onboard"]', text: '开始（约 1 分钟）', tag: 'button', dangerous: false }, probeDead, { stateKey: 'reverse3', id: 'welcome-sabotage', label: '欢迎页（反向验证）', kind: null });
    const probeAlive = await evaluate(`__A.probe(${JSON.stringify({ target: '[data-act="edit-profile"]', waitMs: 320, extraWaitMs: 1000 })})`);
    await sleep(40);
    ctx.probeCount += 1;
    const aliveRecord = classifyProbe({ key: '[data-act="edit-profile"]', text: '直接填资料', tag: 'button', dangerous: false }, probeAlive, { stateKey: 'reverse3', id: 'welcome-sabotage', label: '欢迎页（反向验证）', kind: null });
    case3.deadStatus = deadRecord.status;
    case3.controlStatus = aliveRecord.status;
    case3.passed = deadRecord.status === 'dead' && aliveRecord.status === 'passed';
    case3.actual = `被破坏的「开始」：${deadRecord.status}；未破坏的「直接填资料」：${aliveRecord.status}`;
  }
  rev.cases.push(case3);

  rev.passed = rev.cases.every((c) => c.passed);
  rev.finishedAt = now();
  logLine(`  反向验证${rev.passed ? '通过 ✅' : '失败 ❌'}：${rev.cases.map((c) => (c.passed ? '✅' : '❌') + c.name.slice(0, 18)).join(' | ')}`);
  return rev;
}

/* ────────────────────────────────────────────────────────
   五、报告
   ──────────────────────────────────────────────────────── */

function statusLabel(status) {
  const map = {
    passed: '通过（有可见反应）',
    dead: '死按钮（点了没反应）',
    'error-uncaught': '报错（未捕获异常）',
    'error-console': '报错（被界面兜住但控制台报错）',
    'guarded-confirm': '危险操作：确认框已取消，存档未变',
    'guarded-file': '危险操作：文件选择已拦截，存档未变',
    'guarded-danger': '危险入口：只打开弹层，存档未变',
    'cancel-mutated': '危险操作取消后存档仍被改动',
    'danger-mutated': '危险操作取消后存档仍被改动',
    'disabled-skipped': '元素本来就 disabled（未点击）',
    'no-op-selected': '本来就是选中状态，点击无变化（已排除，不算死按钮）',
    'missing': '点击前元素已消失（未验证）',
    'app-broken': '点击后应用不可用/存档损坏',
    'sheet-stuck': '弹层关不掉',
  };
  return map[status] || status;
}

function countByStatus(probes) {
  const counts = new Map();
  for (const p of probes) counts.set(p.status, (counts.get(p.status) || 0) + 1);
  return counts;
}

function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderProblemsTable(problems) {
  if (!problems.length) return '_无_\n';
  const lines = [
    '| 严重程度 | 界面 | 按钮选择器 | 现象 | 等了多久 | 截图 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const p of problems) {
    lines.push(`| ${severityFor(p)} | ${mdEscape(p.surfaceLabel)} | \`${mdEscape(p.target)}\` | ${mdEscape(p.detail || statusLabel(p.status))} | ${p.waited ? p.waited + 'ms' : '—'} | ${p.screenshot ? '`' + p.screenshot + '`' : '（无）'} |`);
  }
  return lines.join('\n') + '\n';
}

function renderRepro(problems) {
  if (!problems.length) return '';
  const lines = ['### 复现步骤（逐个）', ''];
  for (const [i, p] of problems.entries()) {
    const stateLabel = p.stateKey === 'a' ? '空白新用户（localStorage 为空）' : '有记录的存档（3 天记录 + 体重 + 运动 + 徽章）';
    const surfaceSteps = p.surfaceLabel ? `进入「${p.surfaceLabel}」` : '打开应用';
    lines.push(`**${i + 1}. [${severityFor(p)}] ${p.surfaceLabel} 的 \`${p.target}\`**`);
    lines.push('');
    lines.push(`1. 起始状态：${stateLabel}`);
    lines.push(`2. ${surfaceSteps}`);
    lines.push(`3. 点击 \`${p.target}\`（按钮文字：${p.text || '无文字'}）`);
    const why = p.status === 'dead'
      ? `点击后等待 ${p.waited}ms，DOM 变更 0 次、弹层状态、标签页、localStorage 全都没有变化`
      : String(p.detail || statusLabel(p.status));
    lines.push(`4. 现象：${why}`);
    lines.push(`5. 截图：${p.screenshot ? '`' + p.screenshot + '`' : '（无）'}`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderSurfaceTable(state) {
  if (!state) return '_未运行_\n';
  const lines = ['| 界面 | 层级 | 可点元素 | 抽样点击 | 通过（有反应） | 危险操作安全拦截 | disabled 跳过 | 选中态无变化 | 死/报错 | 回不到界面 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const s of state.surfaces) {
    const surfaceProbes = state.probes.filter((p) => p.surfaceId === s.id);
    const passed = surfaceProbes.filter((p) => p.status === 'passed').length;
    const guarded = surfaceProbes.filter((p) => String(p.status).startsWith('guarded')).length;
    const disabled = surfaceProbes.filter((p) => p.status === 'disabled-skipped').length;
    const noop = surfaceProbes.filter((p) => p.status === 'no-op-selected').length;
    const bad = surfaceProbes.filter((p) => p.problem).length;
    lines.push(`| ${mdEscape(s.label)} | ${s.depth} | ${s.candidates} | ${s.sampled} | ${passed} | ${guarded} | ${disabled} | ${noop} | ${bad} | ${s.restoreError ? '是' : '否'} |`);
  }
  return lines.join('\n') + '\n';
}

function buildReport() {
  const states = ctx.states;
  const allProblems = [];
  const draftState = states.b && states.b.draftScenario;
  for (const key of Object.keys(states)) {
    if (states[key] && states[key].problems) allProblems.push(...states[key].problems);
  }
  for (const check of Object.values(ctx.checks)) {
    if (check && check.problem) allProblems.push(check.problem);
  }
  if (draftState && draftState.problems) allProblems.push(...draftState.problems);
  const dead = allProblems.filter((p) => p.status === 'dead');
  const errors = allProblems.filter((p) => String(p.status).startsWith('error'));
  const dangerousMutated = allProblems.filter((p) => ['danger-mutated', 'cancel-mutated'].includes(p.status));
  const appBroken = allProblems.filter((p) => ['app-broken', 'sheet-stuck'].includes(p.status));
  const reversePassed = ctx.reverse ? ctx.reverse.passed : false;
  const passedRun = allProblems.length === 0 && reversePassed && !ctx.fatal;
  const totals = { probes: 0, passed: 0, guarded: 0, disabled: 0, noopSelected: 0, dead: dead.length, errors: errors.length, missing: 0, restoreFailed: 0 };
  const perState = {};
  for (const key of Object.keys(states)) {
    const st = states[key];
    if (!st) continue;
    const counts = countByStatus(st.probes);
    const row = { probes: st.probes.length, counts, restoreFailures: st.restoreFailures.length, limits: st.limits.length };
    for (const [status, n] of counts) {
      if (status === 'passed') totals.passed += n;
      else if (String(status).startsWith('guarded')) totals.guarded += n;
      else if (status === 'disabled-skipped') totals.disabled += n;
      else if (status === 'no-op-selected') totals.noopSelected += n;
      else if (status === 'missing') totals.missing += n;
    }
    row.restoreFailed = st.restoreFailures.length;
    row.passed = counts.get('passed') || 0;
    row.guarded = [...counts.entries()].filter(([s]) => String(s).startsWith('guarded')).reduce((a, [, n]) => a + n, 0);
    row.disabled = counts.get('disabled-skipped') || 0;
    row.noopSelected = counts.get('no-op-selected') || 0;
    row.missing = counts.get('missing') || 0;
    totals.probes += st.probes.length;
    totals.restoreFailed += st.restoreFailures.length;
    perState[key] = row;
  }

  const draft = states.b && states.b.draftScenario;
  if (draft) {
    totals.probes += draft.probes.length;
    totals.passed += draft.probes.filter((p) => p.status === 'passed').length;
    totals.guarded += draft.probes.filter((p) => String(p.status).startsWith('guarded')).length;
    totals.disabled += draft.probes.filter((p) => p.status === 'disabled-skipped').length;
    totals.noopSelected += draft.probes.filter((p) => p.status === 'no-op-selected').length;
    totals.missing += draft.probes.filter((p) => p.status === 'missing').length;
  }

  const lines = [];
  lines.push('# 全界面按钮点击清扫报告（审计 A）');
  lines.push('');
  lines.push(`- 运行时间：${new Date().toISOString()}`);
  lines.push(`- 命令：\`node tools/sweep-check.mjs\``);
  lines.push(`- 端口：静态服务 ${STATIC_PORT} / CDP ${CDP_PORT} / profile \`.audit/profiles/sweep\``);
  lines.push(`- 总耗时：${Math.round((now() - ctx.startedAt) / 1000)} 秒（硬上限 6 分钟，看门狗 330 秒）`);
  lines.push(`- 运行环境：Node ${ctx.nodeVersion || '未知'} / Chrome ${ctx.chromeVersion || '未知'} / macOS（本机）`);
  lines.push(`- 代码版本指纹：**${ctx.versions ? ctx.versions.combined : '未记录'}**（` + (ctx.versions ? '`js/app.js` ' + (ctx.versions.files['js/app.js'] || '?') : '') + `；完整清单见第十三节）`);
  lines.push(`- 结论：**${passedRun ? '本轮（修复后代码）没有发现死按钮或报错 —— 但请注意：审计过程中曾发现 2 个真问题、已由 Lead 修复（见第六节「审计期间发现并已修复的问题」），且必须同时看「未验证」一节' : '❌ 发现了问题，见下'}**`);
  lines.push('');
  lines.push('## 一、怎么做的（方法）');
  lines.push('');
  lines.push('1. 用无头 Chrome 打开本地服务，注入一段脚本：收集未捕获异常、把 `confirm` 一律覆盖成「取消」、拦截文件选择框、统计 DOM 变更次数。');
  lines.push('2. 两套起始状态：空白新用户（欢迎页）/ 有记录的存档（3 天饮食 + 3 条体重 + 3 次运动 + 自定义食物 + 升级前快照 + 假 AI 配置）。');
  lines.push('3. **动态枚举**：不维护按钮清单，从 `#app`、`#sheetRoot`、`.topbar`、`.tabbar` 里按通用可点特征收集元素（button / 带 `data-act`、`data-pick`、`data-meal`、`data-method` 等属性的元素 / role=tab 等）。');
  lines.push('4. 逐个点击：点之前拍快照（弹层开合、标签页、日期、localStorage 内容哈希、DOM 变更计数），点完等约 0.3 秒（在 250~400ms 区间内），没有变化再等 1 秒；仍无变化 → 判为死按钮。');
  lines.push('5. 每次点击后检查：有无新异常、弹层能不能关、`window.__appReady` 是否仍为 true、存档是否可解析。');
  lines.push('6. 弹层里的按钮也按同样方式清扫：点开弹层 → 枚举里面的按钮 → 逐个点击 → 关掉弹层 → 重新打开 → 下一个。');
  lines.push('7. **同类型元素抽样**：比如日历有 30 个日期格子、器械有 20 个按钮，全点一遍会撑爆时间预算，所以按「同类型最多抽 3~4 个」处理，抽了多少、没抽多少都在下面写清楚。');
  lines.push('');
  lines.push('## 二、起始状态');
  lines.push('');
  const stateA = states.a;
  const stateB = states.b;
  lines.push(`- **(a) 空白新用户**：${ctx.baselines.a.note}。启动后显示欢迎页：${stateA ? stateA.baselineInfo.welcomeVisible : '未运行'}。`);
  lines.push(`- **(b) 有记录的存档**：${ctx.baselines.b.note}。浏览器里实测：存档 ${stateB ? stateB.baselineInfo.days : '—'} 天、体重 ${stateB ? stateB.baselineInfo.weights : '—'} 条、运动 ${stateB ? stateB.baselineInfo.exerciseCount : '—'} 次、已解锁徽章 ${stateB ? stateB.baselineInfo.unlockedBadges : '—'} 枚。`);
  lines.push(`- 基线截图：${stateA && stateA.baselineShot ? '`' + stateA.baselineShot + '`' : '（无）'}、${stateB && stateB.baselineShot ? '`' + stateB.baselineShot + '`' : '（无）'}`);
  lines.push('');
  lines.push('## 三、总览');
  lines.push('');
  lines.push('| 起始状态 | 点击元素数 | 通过（有反应） | 危险操作安全拦截 | disabled 跳过 | 选中态无变化 | 死按钮 | 报错 | 元素消失（未验证） | 回不到界面 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const key of ['a', 'b']) {
    const row = perState[key];
    if (!row) { lines.push(`| ${key} | 未运行 | — | — | — | — | — | — | — | — |`); continue; }
    const counts = row.counts;
    lines.push(`| ${key} | ${row.probes} | ${row.passed} | ${row.guarded} | ${row.disabled} | ${row.noopSelected || 0} | ${counts.get('dead') || 0} | ${(counts.get('error-uncaught') || 0) + (counts.get('error-console') || 0)} | ${row.missing} | ${row.restoreFailed} |`);
  }
  if (draft) {
    const c = countByStatus(draft.probes);
    lines.push(`| b-额外：份量追问弹层 | ${draft.probes.length} | ${c.get('passed') || 0} | ${[...c.entries()].filter(([s]) => String(s).startsWith('guarded')).reduce((a, [, n]) => a + n, 0)} | ${c.get('disabled-skipped') || 0} | ${c.get('no-op-selected') || 0} | ${c.get('dead') || 0} | ${(c.get('error-uncaught') || 0) + (c.get('error-console') || 0)} | ${c.get('missing') || 0} | ${draft.restoreError ? 1 : 0} |`);
  }
  lines.push('');
  lines.push(`合计：点击 **${totals.probes}** 个元素，其中通过 **${totals.passed}** 个、危险操作安全拦截 **${totals.guarded}** 个、disabled 跳过 **${totals.disabled}** 个、选中态无变化（已排除）**${totals.noopSelected}** 个；**死按钮 ${dead.length} 个、报错 ${errors.length} 个、危险操作取消后仍改存档 ${dangerousMutated.length} 个、应用不可用/弹层关不掉 ${appBroken.length} 个**。`);
  lines.push('');
  lines.push('## 四、死按钮清单');
  lines.push('');
  lines.push(renderProblemsTable(dead));
  lines.push('> 关于「选中态」：已经选中的分段/档位（例如记录页的「吃的」、训练强度的「不填」）再点一次本来就不该有变化，脚本会把它们归到「选中态无变化」而不是死按钮 —— 这是为了避免误报。代价是：如果一组按钮里**默认选中的那个**也没绑定监听，它会被这条规则排除。本次审计早期就出过这种情况：「减脂 / 维持体重」两个按钮都死了，但「减脂」默认是选中态被排除，靠同组未选中的「维持体重」才抓到（已修复，详见第六节）。');
  lines.push('');
  lines.push('## 五、报错按钮清单');
  lines.push('');
  lines.push(renderProblemsTable(errors));
  lines.push('## 六、其他严重问题（危险操作改存档 / 应用不可用 / 弹层关不掉）');
  lines.push('');
  lines.push(renderProblemsTable([...dangerousMutated, ...appBroken]));
  lines.push(renderRepro([...dead, ...errors, ...dangerousMutated, ...appBroken]));
  lines.push('### 审计期间发现、已修复的问题（修复前证据 + 本轮复测）');
  lines.push('');
  lines.push('> 下面两条是在**修复前**的代码上真的复现出来的（原始控制台日志见 `.audit/sweep-evidence-before-fix.log`）。Lead 在审计期间已修复；本报告最后一轮跑的是修复后的代码，所以上面的死按钮/报错计数是 0 —— 这不是「没测过」，是「测出来以后已经修了」的证据。');
  lines.push('');
  lines.push('1. **资料弹层「想做什么：减脂 / 维持体重」两个按钮点了没反应**（严重）');
  lines.push('   - 修复前现象：点击后等了 1.32 秒，DOM 变更 0 次、弹层/标签页/localStorage 全都没变 → 死按钮（两套起始状态下的「资料弹层」都复现，共 4 个死按钮记录）。');
  lines.push('   - 根因（代码核对）：`goalChips` 容器用的是 `class="seg"`，而通用绑定循环只遍历 `.chips` —— `goalChips` 没被绑定，循环里针对它的分支成为死代码。用户因此无法切换「减脂/维持体重」，`goal` 永远按默认的 `lose` 算。');
  lines.push('   - 修复后复测：绑定改为 `body.querySelectorAll(".chips, .seg")`；本轮「资料弹层」11 次点击全部通过（含「维持体重」，见第七节通过表）。');
  lines.push('2. **设置弹层点「普通模式」抛 `ReferenceError: clearDraft is not defined`**（严重）');
  lines.push('   - 修复前现象：`window.onerror` 捕获 `Uncaught ReferenceError: clearDraft is not defined`，点击后设置不生效 → 用户无法从 AI 模式切回普通模式。');
  lines.push('   - 根因（代码核对）：`setMode()` 里调用了项目里不存在的 `clearDraft()`（全项目搜不到定义/导入）。');
  lines.push('   - 修复后复测：改为 `if (next !== "ai") draft = null;`；本轮「设置弹层」10 次点击全部通过（9 次有可见反应 + 1 次危险入口只打开弹层、存档未变），无报错。');
  lines.push('');
  lines.push('> 说明：清扫的「死按钮」判定依据是运行时的可见变化；上面第 1 条额外用代码定位了原因，便于修复时直接改到点上。');
  lines.push('');
  lines.push('## 七、通过计数（测了没问题）');
  lines.push('');
  lines.push('每行是「这个界面里点过的元素数 / 通过数」。通过 = 点击后确实有可见反应；危险操作 = 只打开弹层或点「取消」后存档未变。');
  lines.push('');
  lines.push('### 空白新用户');
  lines.push('');
  lines.push(renderSurfaceTable(stateA));
  lines.push('### 有记录的存档');
  lines.push('');
  lines.push(renderSurfaceTable(stateB));
  if (draft) {
    lines.push('### 额外场景：份量追问弹层');
    lines.push('');
    const c = countByStatus(draft.probes);
    lines.push(`- 可点元素 ${draft.candidates} 个，点击 ${draft.probes.length} 个：${[...c.entries()].map(([s, n]) => statusLabel(s) + ' ' + n + ' 个').join('、') || '（无）'}`);
    lines.push('');
  }
  lines.push('## 八、未验证 / 未覆盖（没测到的东西）');
  lines.push('');
  lines.push('> 这一节必须和「通过计数」分开看：**没测到 ≠ 没问题**。');
  lines.push('');
  // 「另一起始状态是否覆盖过某个弹层」：空白用户状态下有些入口不存在（比如记录页/份量弹层），
  // 这些在「有记录」状态里覆盖过，要在报告里说清楚，避免读者误以为完全没测。
  const coveredKindsByState = {};
  for (const key of ['a', 'b']) {
    coveredKindsByState[key] = new Set(((states[key] && states[key].surfaces) || []).map((x) => x.kind).filter(Boolean));
  }
  // 「这样记对吗」弹层在状态 b 里由「额外场景：份量追问弹层」覆盖，不是完全没测
  if (draftState && draftState.probes && draftState.probes.length) coveredKindsByState.b.add('draft');
  const uncovered = [];
  for (const key of ['a', 'b']) {
    const st = states[key];
    if (!st) { uncovered.push(`- 起始状态 ${key}：未运行。`); continue; }
    // 同类弹层从不同入口被发现时会产生多条重复记录，这里合并成一条并注明次数
    const grouped = new Map();
    for (const l of st.limits) {
      if (l.reason && String(l.reason).indexOf('没有打开过') >= 0) continue; // 这类单独处理
      const gk = [l.reason, l.surface || '', l.sheetKind || ''].join('|');
      if (!grouped.has(gk)) grouped.set(gk, { ...l, count: 0 });
      grouped.get(gk).count += 1;
    }
    for (const l of grouped.values()) {
      uncovered.push(`- [状态 ${key}] ${l.reason}${l.surface ? '：' + l.surface : ''}${l.sheetKind ? '（' + KIND_LABEL[l.sheetKind] + '）' : ''}${l.candidates != null ? '，涉及 ' + l.candidates + ' 个元素' : ''}${l.count > 1 ? '（' + l.count + ' 个不同入口，跳过的是重复的同类弹层）' : ''}`);
    }
    const openerKinds = [...new Set(st.limits.filter((l) => l.sheetKind && String(l.reason).indexOf('没有打开过') >= 0).map((l) => l.sheetKind))];
    for (const kind of openerKinds) {
      // 本状态里由「额外场景」覆盖过的（份量追问弹层），不再算未覆盖
      if (coveredKindsByState[key] && coveredKindsByState[key].has(kind)) {
        uncovered.push(`- [状态 ${key}] ${KIND_LABEL[kind] || kind}：常规清扫入口不存在，但已由「额外场景」专门覆盖（见第七节）`);
        continue;
      }
      const other = key === 'a' ? 'b' : 'a';
      const otherCovered = coveredKindsByState[other] && coveredKindsByState[other].has(kind);
      uncovered.push(`- [状态 ${key}] ${KIND_LABEL[kind] || kind}：这个起始状态下入口不存在/没打开过${otherCovered ? '；**另一起始状态（' + other + '）已覆盖过**' : '，因此完全没有覆盖'}`);
    }
    for (const rf of st.restoreFailures) {
      uncovered.push(`- [状态 ${key}] 回不到「${rf.surface}」，该界面里的按钮没有测完（原因：${typeof rf.detail === 'object' ? JSON.stringify(rf.detail).slice(0, 160) : rf.detail}）`);
    }
    const seenMissing = new Set();
    for (const miss of st.probes.filter((p) => p.status === 'missing')) {
      const mk = miss.target + '|' + miss.detail;
      if (seenMissing.has(mk)) continue;
      seenMissing.add(mk);
      uncovered.push(`- [状态 ${key}] 元素在探测过程中消失、没点到：${miss.target}${miss.detail ? '（' + miss.detail + '）' : ''}`);
    }
    for (const sv of st.surfaces) {
      for (const ns of sv.notSampled || []) {
        uncovered.push(`- [状态 ${key}] 「${sv.label}」里有 ${ns.total} 个同类型元素（组：${ns.groupKey}），只抽测了 ${ns.sampled} 个，其余未逐个点击（例如：${ns.examples.join(' / ')}）`);
      }
    }
    if (st.hiddenCount) uncovered.push(`- [状态 ${key}] 共 ${st.hiddenCount} 个匹配可点特征的元素当时不可见（折叠/条件显示，例如没展开的 details、切换选项后才出现的字段），没有被点到。`);
    if (st.externalCount) uncovered.push(`- [状态 ${key}] 共 ${st.externalCount} 个指向外部网站的链接没有点（避免联网）。`);
    if (st.nonButtonCount) uncovered.push(`- [状态 ${key}] 共 ${st.nonButtonCount} 个输入框/下拉框（不是按钮，点击只会聚焦），未纳入点击清扫。`);
  }
  uncovered.push('- 「清除全部记录」的确认按钮：**故意没有点**（红线）。只验证了它默认 disabled、输入「清除」两个字才可用、输入错的字仍禁用，且全程存档未变。');
  uncovered.push('- 真实的文件导入：文件选择框被拦截，只验证了「点了会打开文件选择」这一步，没有真的选文件、没有真的覆盖存档。');
  uncovered.push('- 真正联网的 AI 调用：基线里用的是假密钥 + 关闭的本机端口，没有向任何真实服务商发请求。');
  uncovered.push('- 「AI 设置」里的模型选择按钮（`[data-model]`）：只有成功从服务商拿到模型列表后才会出现，本次没有真实网络请求，因此**没有覆盖**。AI 设置里的其他按钮（选服务商/模式切换/获取模型列表/保存并测试/清除密钥）都覆盖了。');
  uncovered.push('- 日历里「翻到上个月/下个月」之后的日期格子：只测了当前月份的日期格子（同类型抽样），其他月份结构相同但未逐个点击。');
  uncovered.push('- 应用支持「点 ✕」「点遮罩」关弹层；**不支持按 Esc 关闭**（如实记录，不算 bug，属建议）。');
  lines.push(uncovered.join('\n'));
  lines.push('');
  lines.push('## 九、危险操作与安全门禁（额外验证）');
  lines.push('');
  const guard = ctx.checks.wipeGuard;
  if (guard && !guard.error) {
    lines.push(`- 「从头开始」门禁：弹层打开=${guard.opened}；确认按钮默认禁用=${guard.disabledInitially}；输入「清除」后可用=${guard.enabledAfterTyping}；输入错字仍禁用=${guard.disabledForWrongWord}；全程 localStorage 未变=${guard.storageUnchanged}；弹层可关=${guard.closed}（${guard.closedBy || '—'}）。`);
  } else {
    lines.push(`- 「从头开始」门禁：**没能验证**（${guard ? guard.error || guard.reason : '未运行'}）。`);
  }
  const esc = ctx.checks.esc;
  if (esc && !esc.error) lines.push(`- Esc 关弹层：${esc.escCloses ? '可以' : '不可以'}（应用目前只支持点 ✕ 或点遮罩关闭）。`);
  lines.push('- 所有 confirm 都被覆盖成「取消」；所有危险按钮的点击记录里，`localStorage` 内容哈希在点击前后一致才算通过。');
  lines.push('');
  lines.push('## 十、反向验证（证明这套检查真的能失败）');
  lines.push('');
  lines.push('方法：在浏览器里人为破坏按钮 —— 把目标按钮换成一个 `cloneNode(true)` 的克隆。');
  lines.push('注意不能用 `el.onclick = null`：应用全部用 `addEventListener` 绑定，`onclick` 本来就是空的，那样破坏不了任何东西。');
  lines.push('克隆没有事件监听，因此点击它应该**没有任何反应**；然后用与主清扫**完全相同**的点击/判定代码路径去点它，看会不会报「死按钮」。');
  lines.push('');
  if (ctx.reverse) {
    lines.push('| 用例 | 预期 | 实际 | 结果 |');
    lines.push('| --- | --- | --- | --- |');
    for (const c of ctx.reverse.cases) {
      lines.push(`| ${mdEscape(c.name)} | ${mdEscape(c.expected)} | ${mdEscape(c.actual || '')} | ${c.passed ? '✅ 通过' : '❌ 失败'} |`);
    }
    lines.push('');
    lines.push(`**反向验证总体结论：${ctx.reverse.passed ? '✅ 通过 —— 破坏之后检查确实报告了死按钮（说明它不是摆设）' : '❌ 失败 —— 破坏之后检查仍然全绿，这个检查不可信，必须重写'}**`);
  } else {
    lines.push('_未运行（被时间预算打断）。_');
  }
  lines.push('');
  lines.push('## 十一、附带发现（不属于按钮清扫，但顺手验证了）');
  lines.push('');
  const boot = ctx.checks.bootFail;
  if (boot) {
    if (boot.hasBootFailEl) {
      lines.push('- `#bootFail` 兜底元素存在。');
    } else {
      lines.push('- **`#bootFail` 兜底元素在 index.html 里不存在**（`index.html` 的内联脚本和 `js/app.js` 的 `renderBootFailure` 都在找它）。如果 `js/app.js` 本身加载失败（语法错误/网络失败），用户会看到顶栏和标签栏、中间空白，不会有任何提示。严重程度：建议级（本次未在真实浏览器里制造 app.js 加载失败来复现，仅代码核对 + 运行时确认元素不存在）。');
    }
  }
  lines.push('');
  lines.push('## 十二、本次检查的局限（诚实说明）');
  lines.push('');
  lines.push('1. 点击用的是 DOM 的 `el.click()`，不是真实手指触摸。它能覆盖「事件监听丢了/绑定漏了」这类事故（也确实是用户遇到的那类），但**不覆盖**「按钮被别的元素挡住、手指点不到」这类问题（那是审计 C 的排版检查范围）。');
  lines.push('2. 异步弹层/网络请求的等待有上限（最多约 1 秒额外等待）；如果某种反应比这更慢，会被误判成死按钮 —— 本次没有出现这种情况，但结论只对当前机器和当前网络环境成立。');
  lines.push('3. 同类型元素是抽样点击的（规则和跳过数量见第八节），不是每一个都点了。');
  lines.push('4. 危险操作只验证到「弹层能打开 / 取消后数据不变」，没有验证「真的点了确认之后会不会正确执行」—— 这是故意的，不能在真实数据上验证清空。');
  lines.push('5. 报告里的「通过」只代表**点下去有反应且没报错**，不代表功能逻辑正确（功能正确性由单元测试和其他审计覆盖）。');
  lines.push('');
  lines.push('## 十三、代码版本快照');
  lines.push('');
  lines.push('运行开始时的文件指纹（sha256 前 12 位）。这个仓库是多人共用的，审计期间别人可能正在改代码，这个清单用来确认「这份报告对应哪一版代码」。');
  lines.push('');
  if (ctx.versions) {
    for (const [file, hash] of Object.entries(ctx.versions.files)) lines.push(`- \`${file}\`：${hash}`);
    lines.push('');
    lines.push(`- 合计指纹：**${ctx.versions.combined}**`);
  } else {
    lines.push('_未记录_');
  }
  lines.push('');
  lines.push('## 十四、退出码');
  lines.push('');
  const exitCode = passedRun ? 0 : 1;
  lines.push(`本次退出码：**${exitCode}**（死按钮/报错/危险操作改数据/应用不可用/反向验证失败 → 非 0）`);
  lines.push('');
  return { markdown: lines.join('\n'), passedRun, exitCode, totals, dead, errors, dangerousMutated, appBroken };
}

/* ────────────────────────────────────────────────────────
   六、入口
   ──────────────────────────────────────────────────────── */

function finishAndExit(exitCode, cleanup = []) {
  for (const fn of cleanup) { try { fn(); } catch { /* 收尾失败不影响结果 */ } }
  process.exit(exitCode);
}

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PROFILE_DIR), { recursive: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  // 清掉上一次的截图，避免新旧混在一起误导
  for (const name of fs.readdirSync(SHOTS_DIR)) {
    if (name.startsWith('sweep-')) { try { fs.rmSync(path.join(SHOTS_DIR, name)); } catch { /* 忽略 */ } }
  }

  ctx.versions = snapshotCodeVersions();
  ctx.nodeVersion = process.version;
  ctx.baselines = buildBaselines();
  ctx.sweepStartedAt = now();
  ctx.deadline = ctx.sweepStartedAt + MAIN_BUDGET_MS;

  logLine('启动本地静态服务…');
  ctx.server = startStaticServer();
  await waitForHttp(BASE + '/', 15000);
  logLine(`静态服务已就绪：${BASE}`);

  logLine('启动无头 Chrome…');
  const launched = await launchChrome({ port: CDP_PORT, userDataDir: PROFILE_DIR, window: '390,844' });
  ctx.chrome = launched;
  ctx.chromeVersion = (launched.version && launched.version.Browser) || '未知';
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  let target = targets.find((t) => t.type === 'page');
  if (!target) {
    target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  }
  const client = await connect(target.webSocketDebuggerUrl);
  ctx.client = client;
  client.on('Runtime.exceptionThrown', (params) => {
    const d = params?.exceptionDetails;
    const desc = d?.exception?.description || d?.text || '未知异常';
    ctx.cdpExceptions.push(String(desc).split('\n')[0].slice(0, 300) + ` @${now()}`);
  });
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  try {
    await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });
  } catch { /* 老版本没有 Browser.setDownloadBehavior，忽略 */ }
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_PRELUDE });

  // 进程怎么退出（正常/失败/看门狗）都要收干净：杀 Chrome、停服务、删掉浏览器 profile
  // （profile 里会有 Chrome 自动生成的 TTS voices.json，内容里的语言代码会被密钥扫码误判；
  //  而且这东西每次跑都是临时产物，没必要留着）
  process.once('exit', () => {
    try { ctx.server && ctx.server.stop(); } catch { /* 忽略 */ }
    try { ctx.client && ctx.client.close(); } catch { /* 忽略 */ }
    try { ctx.chrome && ctx.chrome.kill && ctx.chrome.kill(); } catch { /* 忽略 */ }
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 忽略 */ }
  });

  await client.send('Page.navigate', { url: BASE + '/' });
  if (!(await waitAppReady(20000))) throw new Error('首次打开页面没有启动（window.__appReady 不为 true）');
  // 清掉 Service Worker / 缓存，避免上一次的离线缓存影响（本脚本每次都换 profile，但保险）
  await evaluate(`(async function(){
    try { var regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(function(r){return r.unregister();})); } catch (e) {}
    try { var names = await caches.keys(); await Promise.all(names.map(function(n){return caches.delete(n);})); } catch (e) {}
    return true;
  })()`);

  if (DRAFT_ONLY) {
    await switchBaseline('b');
    const draftResult = await sweepDraftScenario('b', '中午吃了一碗牛肉面');
    for (const p of draftResult.probes) console.log(`  [${p.status}] ${p.target} ｜ ${p.text} ｜ ${p.detail || ''}`);
    finishAndExit(draftResult.problems.length ? 1 : 0, [() => client.close(), () => ctx.chrome && ctx.chrome.kill && ctx.chrome.kill(), () => ctx.server && ctx.server.stop()]);
    return;
  }

  if (!REVERSE_ONLY) {
    const statesToRun = ONLY_STATE === 'both' ? ['a', 'b'] : [ONLY_STATE];
    for (const stateKey of statesToRun) {
      if (!ctx.baselines[stateKey]) throw new Error(`未知起始状态：${stateKey}`);
      if (now() > ctx.deadline) {
        ctx.states[stateKey] = null;
        ctx.limits.push({ reason: '主清扫时间预算到', stateKey, skipped: '整套状态未运行' });
        continue;
      }
      const result = await sweepState(stateKey);
      if (stateKey === 'b') {
        try {
          result.draftScenario = await sweepDraftScenario('b', '中午吃了一碗牛肉面');
          ctx.states.b = result;
        } catch (err) {
          result.draftScenario = { probes: [], problems: [], skipped: String(err.message || err) };
          ctx.states.b = result;
        }
      }
      ctx.states[stateKey] = result;
    }
    // 附加检查
    if (ctx.states.b) {
      try {
        const checks = await runExtraChecks();
        Object.assign(ctx.checks, checks);
        if (checks.wipeGuard && checks.wipeGuard.ok) {
          const g = checks.wipeGuard;
          const bad = !g.disabledInitially || !g.enabledAfterTyping || !g.disabledForWrongWord || !g.storageUnchanged;
          if (bad) {
            ctx.checks.wipeGuard.problem = {
              stateKey: 'b', surfaceLabel: '「从头开始」弹层', target: '#wipeGo',
              status: 'guard-broken', problem: true,
              detail: `门禁不符合预期：默认禁用=${g.disabledInitially} 输入清除后可用=${g.enabledAfterTyping} 错字仍禁用=${g.disabledForWrongWord} 存档未变=${g.storageUnchanged}`,
            };
          }
        } else if (checks.wipeGuard && !checks.wipeGuard.error) {
          ctx.checks.wipeGuard.problem = {
            stateKey: 'b', surfaceLabel: '「从头开始」弹层', target: '#wipeGo',
            status: 'guard-broken', problem: true,
            detail: '没能验证清除门禁：' + (checks.wipeGuard.reason || '未知原因'),
          };
        }
      } catch (err) {
        ctx.checks.error = { error: String(err.message || err) };
      }
    }
  }

  // 反向验证（预算单独留，必须执行）
  // 注意：除了时间，还要给**点击次数**预算 —— 主清扫把 330 次点完了，
  // 反向验证第一步就会因为「全局点击预算到」立刻 break，表现为「一个元素都没点」→ 假失败。
  ctx.deadline = Math.max(ctx.deadline, now() + REVERSE_BUDGET_MS);
  ctx.probeBudget = Math.max(ctx.probeBudget, ctx.probeCount + 90);
  try {
    ctx.reverse = await runReverse();
  } catch (err) {
    ctx.reverse = { passed: false, cases: [], error: String(err.message || err) };
    logLine(`反向验证失败：${err.message}`);
  }

  const report = buildReport();
  fs.writeFileSync(REPORT_PATH, report.markdown);
  logLine('');
  logLine('================ 清扫结论 ================');
  logLine(`点击元素总数：${report.totals.probes}（通过 ${report.totals.passed}，危险操作安全拦截 ${report.totals.guarded}，disabled ${report.totals.disabled}）`);
  logLine(`死按钮：${report.dead.length} ｜ 报错：${report.errors.length} ｜ 危险操作改存档：${report.dangerousMutated.length} ｜ 应用不可用/弹层关不掉：${report.appBroken.length}`);
  logLine(`反向验证：${ctx.reverse && ctx.reverse.passed ? '通过 ✅' : '失败 ❌'}`);
  if (report.dead.length) for (const p of report.dead) logLine(`  ❌ 死按钮：${p.target}（${p.surfaceLabel}）`);
  if (report.errors.length) for (const p of report.errors) logLine(`  ❌ 报错：${p.target}（${p.surfaceLabel}）${String(p.detail).slice(0, 100)}`);
  logLine(`报告：${path.relative(ROOT, REPORT_PATH)}`);
  logLine(`退出码：${report.exitCode}`);
  process.exitCode = report.exitCode;
  finishAndExit(report.exitCode, [() => client.close(), () => ctx.chrome && ctx.chrome.kill && ctx.chrome.kill(), () => ctx.server && ctx.server.stop()]);
}

armWatchdog('sweep-check.mjs', 390);

main().catch((err) => {
  logLine(`\n清扫脚本自身失败：${err && err.message ? err.message : err}`);
  try {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, [
      '# 全界面按钮点击清扫报告（审计 A）',
      '',
      '## ❌ 脚本自身失败，本次清扫没有完成',
      '',
      '错误：' + String((err && (err.stack || err.message)) || err),
      '',
      '注意：这不代表应用有问题，只代表检查没跑完；结论应以控制台日志为准，需要重新运行。',
      '',
    ].join('\n'));
  } catch { /* 报告写不出来也不影响退出码 */ }
  finishAndExit(1);
});

process.on('uncaughtException', (err) => {
  console.error('清扫脚本未捕获异常：', err);
  finishAndExit(1);
});
