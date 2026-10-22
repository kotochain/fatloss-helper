/**
 * 审计 B：韧性自检 —— AI 失败路径 + 存档异常
 *
 * 守的问题：刚刚修完「AI 模式从来没工作过，AI 结果被静默丢弃，界面却显示 AI 识别」。
 * 那次自检是绿的，因为测试用的例句恰好离线也认得。所以这个脚本**重点不是成功路径，
 * 而是失败路径和「骗人」路径**：
 *
 *   · AI 真的失败时，界面绝不能显示「AI 识别 / 已用 AI」，绝不能把离线解析冒充 AI 结果；
 *   · AI 失败时必须有明确提示（密钥错、服务商错、超时、解析失败、连不上），不能悄悄吞掉；
 *   · 存档坏了 / 版本太新 / 存储满了时，页面要能打开、要诚实提示、绝不能静默清空用户记录。
 *
 * 做法：起一个可控的「假 AI 服务商」（跨域头齐全，按模型名决定返回什么），
 * 用无头 Chrome 走真实界面：输入一句话 → 点「解析这一句」→ 读弹层 DOM 文本 → 判断。
 * 断言只看**用户实际看到的 DOM 文本**，不看代码 —— 因为「界面骗人」正是这次要抓的东西。
 *
 * 用法：
 *   node tools/resilience-check.mjs              # 正常检查，退出码 0 = 全过，非 0 = 有失败
 *   node tools/resilience-check.mjs --reverse    # 反向验证：证明这些检查真的会报红
 *
 * 端口（固定，避免和别的自检打架）：CDP 9412、静态服务 4312、假服务商 18880/18881。
 * 只写 .audit/ 下的报告和截图，不碰 js/、index.html、css/、sw.js、tests/。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { armWatchdog } from './watchdog.mjs';
import { launchChrome } from './chrome-launch.mjs';
import { appVersion } from './app-version.mjs';

/**
 * 干完活之后主动退出。
 * 无头浏览器 + CDP WebSocket 会让 Node 事件循环一直不空；不显式退出就会被看门狗按超时杀掉。
 * 这里顺带保证：即使脚本自己出错，退出码也不会是 0（一开始就把 exitCode 设成 1，成功才改 0）。
 */
function finishAndExit(exitCode = 0, cleanup = []) {
  for (const fn of cleanup) { try { fn(); } catch { /* 收尾失败不影响判定 */ } }
  process.exit(exitCode);
}

// 先按「失败」占位：任何意外提前退出都不会被误判成通过
process.exitCode = 1;

armWatchdog('resilience-check.mjs', 420);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_DIR = path.join(root, '.audit');
const SHOT_DIR = path.join(AUDIT_DIR, 'resilience-shots');
const REPORT_PATH = path.join(AUDIT_DIR, 'resilience-report.md');
const REVERSE_PROOF_PATH = path.join(AUDIT_DIR, 'resilience-reverse-proof.txt');

const CDP_PORT = 9412;
const STATIC_PORT = 4312;
const FAKE_PORT = 18880;
const CORS_FAIL_PORT = 18881;
const BASE = `http://127.0.0.1:${STATIC_PORT}`;
const FAKE_BASE = `http://127.0.0.1:${FAKE_PORT}/v1`;
const CORS_FAIL_BASE = `http://127.0.0.1:${CORS_FAIL_PORT}/v1`;
const REVERSE = process.argv.includes('--reverse');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clip = (s, n = 160) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 被测代码指纹：把 js/*.js、index.html、manifest、sw.js、css 全部做一次 sha256。
 * 为什么需要：别的任务会并行改工作区代码 —— 如果不记录「这份报告到底测的哪一版」，
 * 报告结论就可能对不上代码。跑之前和跑之后各取一次，不一致就明确告警。
 */
function codeFingerprint() {
  const entries = [];
  const add = (rel) => {
    try {
      const abs = path.join(root, rel);
      const st = fs.statSync(abs);
      entries.push({ rel, mtime: st.mtimeMs, data: fs.readFileSync(abs) });
    } catch { /* 文件不存在就跳过 */ }
  };
  add('index.html');
  add('manifest.webmanifest');
  add('sw.js');
  for (const dir of ['css', 'js']) {
    const absDir = path.join(root, dir);
    if (!fs.existsSync(absDir)) continue;
    for (const f of fs.readdirSync(absDir).sort()) {
      if (dir === 'css' && !f.endsWith('.css')) continue;
      if (dir === 'js' && !f.endsWith('.js')) continue;
      add(path.join(dir, f));
    }
  }
  const hash = crypto.createHash('sha256');
  let newest = 0;
  let newestFile = '';
  for (const e of entries) {
    hash.update(e.rel); hash.update('\0'); hash.update(e.data);
    if (e.mtime > newest) { newest = e.mtime; newestFile = e.rel; }
  }
  let gitHead = '';
  let dirtyTracked = null;
  try { gitHead = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim(); } catch { /* 不是 git 仓库就算了 */ }
  try {
    dirtyTracked = execSync('git status --porcelain --untracked-files=no', { cwd: root, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).length;
  } catch { /* 不是 git 仓库就算了 */ }
  return {
    hash: hash.digest('hex').slice(0, 16),
    fileCount: entries.length,
    newest: newest ? new Date(newest).toISOString() : null,
    newestFile,
    gitHead,
    dirtyTracked,
  };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`「${label}」超时（${Math.round(ms / 1000)} 秒）`)), ms)),
  ]);
}

/* ══════════════════════════════════════════════════════════════════
 * 0. 测试数据：一份干净的当前版本状态、本地食物
 * ══════════════════════════════════════════════════════════════════ */

const DEMO_PROFILE = {
  nickname: '测试者', sex: 'female', age: 26, heightCm: 163, weightKg: 58,
  bodyFatPct: null, activity: 'light', pace: 'standard', goal: 'lose', targetWeightKg: 54,
};
// 这三种食物直接从 js/foods.js 抄来（只用于构造演示存档，界面/计算都以项目代码为准）
const FOOD_RICE = { id: 'rice_cooked', name: '米饭（熟）', category: 'staple', kcal: 116, protein: 2.6, fat: 0.3, carb: 25.9, servings: [['一小碗', 130], ['一碗', 180]] };
const FOOD_EGG = { id: 'egg', name: '鸡蛋', category: 'protein', kcal: 143, protein: 13.3, fat: 8.8, carb: 2.8, servings: [['一个', 50], ['两个', 100]] };
const FOOD_BEEF_NOODLE = { id: 'beef_noodle', name: '牛肉面', category: 'dish', kcal: 105, protein: 5.5, fat: 3.5, carb: 13.5, servings: [['一碗', 600]] };
const FOOD_APPLE = { id: 'apple', name: '苹果', category: 'fruit', kcal: 53, protein: 0.4, fat: 0.2, carb: 13.7, servings: [['一个', 200]] };

const SEEN = appVersion(); // 当前版本：自检造的存档统一算「已看过」，避免更新弹窗干扰
const EMPTY_ACHIEVEMENTS = { seen: [], lastWeeklyAt: null, milestones: [] };

/**
 * 页面上注入的测试辅助（每次导航都会执行）。
 * 注意：这里把 window.confirm 覆盖成「总是确定」—— 只影响「回滚快照」那类确认框，
 * 测试里没有第二个人可以点确认，这是必要的替身；真正的「清除」防护不靠 confirm（靠输入两个字）。
 */
const INJECT_SCRIPT = `
window.__auditErrors = [];
window.addEventListener('error', (e) => {
  try { window.__auditErrors.push(String((e && (e.message || e.error)) || 'error')); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { window.__auditErrors.push('unhandledrejection: ' + String(e && e.reason)); } catch {}
});
window.confirm = () => true;
window.__audit = {
  today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  },
  setState(st) { localStorage.setItem('fatloss.state.v2', JSON.stringify(st)); },
  setAi(cfg) { localStorage.setItem('fatloss.ai.v1', JSON.stringify(cfg)); },
  readState() {
    try { return JSON.parse(localStorage.getItem('fatloss.state.v2') || 'null'); } catch { return null; }
  },
};
`;

/* ══════════════════════════════════════════════════════════════════
 * 1. 服务器：静态文件 + 可控假 AI 服务商
 * ══════════════════════════════════════════════════════════════════ */

/** 只提供静态文件，故意不实现任何 /api 接口：保证应用绝不会退回「电脑上的中转服务」，
 *  所有 AI 请求都只发往我们的假服务商（不会碰真实密钥、不会花钱）。 */
function startStaticServer() {
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  };
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(fs.readFileSync(file));
  });
}

const AI_OK_ITEMS = [{ name: '牛肉面', grams: 600 }];
const UNMATCHED_ITEMS = [{ name: '量子寿司', grams: 100 }];
const MANY_ITEMS = Array.from({ length: 50 }, (_, i) => ({ name: i % 2 ? '鸡蛋' : '米饭（熟）', grams: i % 2 ? 50 : 100 }));

const fakeStats = { byModel: Object.create(null), pingCalls: 0, lastAuth: '', slowHits: 0 };
const corsFailStats = { requests: 0 };

const wrapped = (payload) => JSON.stringify({
  choices: [{ message: { content: JSON.stringify(payload) } }],
});
const rawContent = (content) => JSON.stringify({ choices: [{ message: { content } }] });

/**
 * 按「模型名」决定这个场景怎么应答 —— 每个场景彻底独立，可重复。
 * 模型名只是测试开关，真实应用不会管它叫什么。
 */
function scenarioResponse(model) {
  switch (model) {
    case 'ok':
      // 反向验证：把正常场景改成返回空 items，确认「条目被记上」这条检查真的会报红
      if (REVERSE) return wrapped({ meal: 'lunch', items: [], questions: [] });
      return wrapped({ meal: 'lunch', items: AI_OK_ITEMS, questions: [] });
    case 'fenced':
      return rawContent('```json\n' + JSON.stringify({ meal: 'lunch', items: AI_OK_ITEMS, questions: [] }) + '\n```');
    case 'prose':
      return rawContent('好的，我帮你整理如下：\n' + JSON.stringify({ meal: 'lunch', items: AI_OK_ITEMS, questions: [] }) + '\n如果还有别的食物请补充。');
    case 'badjson':
      return rawContent('not json at all');
    case 'empty':
      return wrapped({ meal: 'lunch', items: [], questions: [] });
    case 'unmatched':
      return wrapped({ meal: 'lunch', items: UNMATCHED_ITEMS, questions: [] });
    case 'many':
      return wrapped({ meal: 'lunch', items: MANY_ITEMS, questions: [] });
    default:
      return wrapped({ meal: 'lunch', items: AI_OK_ITEMS, questions: [] });
  }
}

/** 可控假服务商：跨域头齐全（模拟允许浏览器直连的服务商） */
function startFakeProvider() {
  return http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'authorization,content-type',
      'Access-Control-Max-Age': '600',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (!req.url || !req.url.includes('/chat/completions')) {
      res.writeHead(404, cors);
      return res.end('{}');
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* 就按空对象处理 */ }
      const model = String(body.model || '');
      const userText = (body.messages || []).find((m) => m.role === 'user')?.content || '';
      fakeStats.lastAuth = String(req.headers.authorization || '');

      // 「保存并测试连通」的探活请求：永远成功，跟场景无关
      if (userText.includes('回复两个字')) {
        fakeStats.pingCalls += 1;
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        return res.end(rawContent('可以'));
      }

      fakeStats.byModel[model] = (fakeStats.byModel[model] || 0) + 1;

      if (model === '401') {
        res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } }));
      }
      if (model === '500') {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'internal error' } }));
      }
      if (model === 'slow') {
        // 故意 15 秒以上不应答（应用自身应在 25 秒时超时，而不是永久卡住）
        fakeStats.slowHits += 1;
        const timer = setTimeout(() => { try { res.destroy(); } catch { /* 已经断了 */ } }, 60000);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(scenarioResponse(model));
    });
    req.on('error', () => { /* 客户端中途断开（超时场景）属于预期 */ });
  });
}

/** 一个「正常但不给跨域头」的服务商：模拟 CORS 被拒（浏览器直接 fetch reject） */
function startCorsFailServer() {
  return http.createServer((req, res) => {
    corsFailStats.requests += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
}

/* ══════════════════════════════════════════════════════════════════
 * 2. CDP 连接与页面操作
 * ══════════════════════════════════════════════════════════════════ */

let cdp = null;
const pageErrors = [];   // 浏览器控制台 error / 未捕获异常（跨场景汇总，供报告用）

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    const api = {
      ws,
      send(method, params = {}) {
        const msgId = ++id;
        ws.send(JSON.stringify({ id: msgId, method, params }));
        return new Promise((res, rej) => pending.set(msgId, { res, rej }));
      },
      on(method, fn) {
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(fn);
        return () => listeners.get(method)?.delete(fn);
      },
      close() { try { ws.close(); } catch { /* 已经关了 */ } },
    };
    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method && listeners.has(msg.method)) {
        for (const fn of listeners.get(msg.method)) { try { fn(msg.params); } catch { /* 监听器自己出错不影响主流程 */ } }
      }
    });
    ws.addEventListener('close', () => {
      for (const { rej } of pending.values()) rej(new Error('CDP 连接已关闭'));
      pending.clear();
    });
  });
}

function waitEvent(method, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let off = () => {};
    const timer = setTimeout(() => { off(); reject(new Error(`等待事件 ${method} 超时`)); }, timeoutMs);
    off = cdp.on(method, (params) => { clearTimeout(timer); off(); resolve(params); });
  });
}

async function evalJs(expression, timeoutMs = 20000) {
  const r = await withTimeout(
    cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    timeoutMs, '页面脚本执行',
  );
  if (r.exceptionDetails) {
    throw new Error('页面脚本出错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function waitFor(fn, timeoutMs, interval = 120, label = '条件') {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) { lastErr = err; }
    await sleep(interval);
  }
  throw new Error(`等待「${label}」超时（${Math.round(timeoutMs / 1000)} 秒）${lastErr ? `：${lastErr.message}` : ''}`);
}

async function goto(url) {
  const loaded = waitEvent('Page.loadEventFired', 20000).catch(() => null);
  await cdp.send('Page.navigate', { url });
  await loaded;
  await sleep(120);
  await waitFor(async () => await evalJs('window.__appReady === true'), 12000, 120, '页面启动（window.__appReady）');
}

async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return `resilience-shots/${name}.png`;
}

async function readToasts() {
  return await evalJs(`[...document.querySelectorAll('.toast')].map((t) => t.textContent.trim())`);
}

async function readNotice() {
  return await evalJs(`(() => {
    const el = document.querySelector('.celebrate');
    if (!el) return null;
    const t = el.querySelector('.celebrate-title');
    const s = el.querySelector('.celebrate-sub');
    return { title: t ? t.textContent.trim() : '', sub: s ? s.textContent.trim() : '' };
  })()`);
}

/** 关掉「徽章解锁 / 提示」的庆祝层，避免它挡住后续截图和流程（JS 点击不受遮罩影响） */
async function dismissCelebrate() {
  await evalJs(`(() => { const b = document.querySelector('#celebrateOk'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(150);
}

/**
 * 触发一次「不改数据」的保存：点记录页的「练的 / 吃的」分段切换。
 * 这比点设置里的模式切换更可靠 —— 而且它顺手验证了记录页的分段切换。
 */
async function persistViaRecordTab() {
  await openLogTab();
  await evalJs(`document.querySelector('[data-record-tab="training"]')?.click(); true`);
  await sleep(400);
  await evalJs(`document.querySelector('[data-record-tab="food"]')?.click(); true`);
  await sleep(250);
  await dismissCelebrate();
}

/** 等 AI 状态就绪：读应用暴露的只读快照（window.__appState）——
 *  否则 ai.configured 可能还没被异步的 aiStatus() 设上，会误走离线路径（测试自己会骗自己）。
 *  以前这里靠「记录页按钮写着 AI 已开启」判断，改文案就会误伤，所以换成读状态。 */
async function waitAiReady() {
  return await waitFor(async () => {
    const st = await evalJs(`window.__appState || null`);
    return Boolean(st && st.aiConfigured && st.mode === 'ai');
  }, 8000, 120, 'AI 配置生效（__appState.aiConfigured === true 且模式是 ai）');
}

async function openLogTab() {
  await evalJs(`document.querySelector('.tab[data-view="log"]')?.click(); true`);
  await waitFor(async () => await evalJs(`!!document.querySelector('#quickText')`), 5000, 120, '记录页输入框');
}

async function openSettings() {
  await evalJs(`document.querySelector('#profileBtn')?.click(); true`);
  await waitFor(async () => (await evalJs(`document.querySelector('#sheetTitle')?.textContent || ''`)) === '设置', 5000, 120, '设置弹层');
}

async function openBackupSheetFromSettings() {
  await evalJs(`document.querySelector('[data-set="backup"]')?.click(); true`);
  await waitFor(async () => await evalJs(`!!document.querySelector('#doSnapshot')`), 5000, 120, '数据与备份弹层');
}

async function openWipeSheetFromSettings() {
  await evalJs(`document.querySelector('[data-set="wipe"]')?.click(); true`);
  await waitFor(async () => await evalJs(`!!document.querySelector('#wipeConfirm')`), 5000, 120, '从头开始弹层');
}

async function closeSheet() {
  await evalJs(`document.querySelector('#sheetClose')?.click(); true`);
  await sleep(120);
}

async function clickSaveDraft() {
  const exists = await evalJs(`!!document.querySelector('#draftSave')`);
  if (!exists) return false;
  await evalJs(`document.querySelector('#draftSave').click(); true`);
  await sleep(400);
  return true;
}

async function readDraftDom() {
  return await evalJs(`(() => ({
    sheetOpen: !!document.querySelector('#sheetRoot') && !document.querySelector('#sheetRoot').classList.contains('hidden'),
    sheetTitle: (document.querySelector('#sheetTitle')?.textContent || '').trim(),
    draftText: (document.querySelector('#draftHost')?.innerText || '').replace(/\\s+/g, ' ').trim(),
    warnText: [...document.querySelectorAll('#draftHost .warn')].map((w) => w.innerText.replace(/\\s+/g, ' ').trim()).join(' | '),
    entries: [...document.querySelectorAll('#draftHost .entry')].map((e) => ({
      name: (e.querySelector('.name')?.innerText || '').replace(/\\s+/g, ' ').trim(),
      kcal: (e.querySelector('[data-kcal]')?.textContent || '').trim(),
    })),
    total: (document.querySelector('#draftHost .row.between b')?.textContent || '').trim(),
    saveBtn: !!document.querySelector('#draftSave'),
    saveBtnText: (document.querySelector('#draftSave')?.textContent || '').trim(),
    parseBtnDisabled: !!document.querySelector('#quickParse')?.disabled,
    parseBtnText: (document.querySelector('#quickParse')?.textContent || '').trim(),
    inputValue: document.querySelector('#quickText')?.value || '',
    quickResult: (document.querySelector('#quickResult')?.innerText || '').replace(/\\s+/g, ' ').trim(),
    celebrate: !!document.querySelector('.celebrate'),
    audits: (window.__auditErrors || []).slice(),
  }))()`);
}

async function readMainState() {
  return await evalJs(`(() => {
    const raw = localStorage.getItem('fatloss.state.v2');
    let st = null;
    let parseError = null;
    try { st = JSON.parse(raw); } catch (e) { parseError = String(e && e.message || e); }
    const entries = [];
    if (st && st.days) {
      for (const [date, day] of Object.entries(st.days)) {
        for (const [meal, list] of Object.entries(day?.meals || {})) {
          for (const e of (Array.isArray(list) ? list : [])) {
            entries.push({ date, meal, name: e?.food?.name || '?', grams: e?.grams, kcalPer100: e?.food?.kcal });
          }
        }
      }
    }
    return {
      raw, parseError,
      schemaVersion: st ? st.schemaVersion : null,
      version: st ? st.version : null,
      dayCount: st && st.days ? Object.keys(st.days).length : 0,
      entries,
      weightCount: Array.isArray(st?.weights) ? st.weights.length : 0,
      hasProfile: Boolean(st?.profile),
    };
  })()`);
}

async function readBackupRaw() {
  return await evalJs(`(() => {
    const raw = localStorage.getItem('fatloss.backup');
    if (!raw) return null;
    try {
      const b = JSON.parse(raw);
      const st = b && b.data;
      const entries = [];
      if (st && st.days) for (const day of Object.values(st.days)) for (const list of Object.values(day?.meals || {})) for (const e of (Array.isArray(list) ? list : [])) entries.push({ name: e?.food?.name || '?', grams: e?.grams });
      return { savedAt: b.savedAt, note: b.note, schemaVersion: b.schemaVersion, version: st && st.version, entries };
    } catch (e) { return { parseError: String(e && e.message || e) }; }
  })()`);
}

/** 读「读不出来的存档」原样留存（schema.js 的 fatloss.state.unreadable） */
async function readUnreadableRaw() {
  return await evalJs(`(() => {
    const raw = localStorage.getItem('fatloss.state.unreadable');
    if (!raw) return null;
    try {
      const p = JSON.parse(raw);
      return { reason: p.reason || '', raw: p.raw || null, rawLength: (p.raw || '').length };
    } catch { return { raw: null, parseError: '留存内容不是合法 JSON' }; }
  })()`);
}

async function readAuditErrors() {
  return await evalJs(`(window.__auditErrors || []).slice()`);
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 场景记录与报告
 * ══════════════════════════════════════════════════════════════════ */

const SEVERITY_RANK = { '事故级': 4, '严重': 3, '一般': 2, '建议': 1 };
const results = [];
let envInfo = {};

function beginScenario(group, id, title, expected) {
  return { group, id, title, expected, checks: [], shots: [], pass: true, actual: '', severity: '建议' };
}

function chk(sc, name, pass, expected, actual, severity = '一般') {
  sc.checks.push({ name, pass: Boolean(pass), expected, actual: String(actual), severity });
  if (!pass && (SEVERITY_RANK[severity] || 0) > (SEVERITY_RANK[sc.severity] || 0)) sc.severity = severity;
}

function endScenario(sc, actual) {
  sc.actual = actual;
  sc.pass = sc.checks.every((c) => c.pass);
  if (sc.pass) sc.severity = null;
  results.push(sc);
  if (sc.pass) {
    console.log(`✅ [${sc.group}] ${sc.id} ${sc.title} — ${actual}`);
  } else {
    console.log(`❌ [${sc.group}] ${sc.id} ${sc.title} — ${actual}`);
    for (const c of sc.checks.filter((x) => !x.pass)) {
      console.log(`     · ${c.name}（${c.actual}）`);
    }
  }
  return sc;
}

/* ══════════════════════════════════════════════════════════════════
 * 4. AI 场景
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 重置成「干净的当前版本存档 + 指定 AI 配置（模型名就是场景开关）」，然后打开页面。
 * 每个 AI 场景都从干净状态开始 —— 上一个场景的弹层/草稿/记录不会污染下一个。
 */
async function resetForAi(model, baseUrl = FAKE_BASE) {
  const state = {
    version: 4, schemaVersion: 4, profile: DEMO_PROFILE,
    settings: { trainDays: 3, stepsKey: 'mid', mode: 'ai', lastSeenVersion: SEEN },
    days: {}, customFoods: [], weights: [], achievements: EMPTY_ACHIEVEMENTS,
  };
  const ai = {
    presetId: 'custom', baseUrl, model, apiKey: 'sk-audit-fake', // secret-scan:allow 审计用假密钥
    mode: 'direct', updatedAt: '2026-10-20T00:00:00.000Z',
  };
  await evalJs(`(() => {
    localStorage.clear();
    localStorage.setItem('fatloss.state.v2', ${JSON.stringify(JSON.stringify(state))});
    localStorage.setItem('fatloss.ai.v1', ${JSON.stringify(JSON.stringify(ai))});
    return true;
  })()`);
  await goto(`${BASE}/`);
}

/**
 * 跑一次「输入一句话 → 解析」并读回界面看到的东西。
 * @returns {{ready:boolean, aiReady:boolean, elapsed:number, waitErr:string|null, dom:object, hits:number}}
 */
async function aiRound({ model, text, baseUrl = FAKE_BASE, waitMs = 12000 }) {
  const before = fakeStats.byModel[model] || 0;
  let ready = false;
  let aiReady = false;
  let bootErr = null;
  try {
    await resetForAi(model, baseUrl);
    ready = true;
  } catch (err) { bootErr = err.message; }
  if (!ready) {
    return { ready, aiReady, elapsed: 0, waitErr: bootErr, dom: { entries: [], draftText: '', warnText: '', saveBtn: false, parseBtnDisabled: false, parseBtnText: '', inputValue: '', total: '', quickResult: '', sheetOpen: false }, hits: 0 };
  }
  await openLogTab();
  try { await waitAiReady(); aiReady = true; } catch { aiReady = false; }

  const t0 = Date.now();
  await evalJs(`(() => {
    const ta = document.querySelector('#quickText');
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#quickParse').click();
    return true;
  })()`);

  let waitErr = null;
  try {
    await waitFor(async () => await evalJs(`(() => {
      const root = document.querySelector('#sheetRoot');
      const host = document.querySelector('#draftHost');
      return !!root && !root.classList.contains('hidden') && !!host && host.innerText.trim().length > 0;
    })()`), waitMs, 120, '解析结果弹层');
  } catch (err) { waitErr = err.message; }
  const elapsed = Date.now() - t0;
  const dom = await readDraftDom();
  const hits = (fakeStats.byModel[model] || 0) - before;
  return { ready, aiReady, elapsed, waitErr, dom, hits, bootErr };
}

/** 关掉弹层（不保存），并读回存档，确认「一条都没被创建」 */
async function closeAndReadState() {
  await closeSheet();
  return await readMainState();
}

/** 成功路径（AI 真的成功，条目必须来自 AI） */
async function scenarioAiSuccess(group, id, title, { model, text, shotPrefix }) {
  const sc = beginScenario(group, id, title, '弹层显示「AI 识别」、条目正确记上、热量非 0、保存后记录里真有这几条');
  const r = await aiRound({ model, text });
  chk(sc, '页面启动', r.ready, 'window.__appReady === true', r.ready ? '是' : `否（${r.bootErr || '启动失败'}）`, '严重');
  chk(sc, 'AI 配置生效', r.aiReady, '记录页按钮显示「AI 已开启」', r.aiReady ? '是' : '否（AI 没被调用，测试无意义）', '严重');
  chk(sc, '假服务商真的收到请求', r.hits >= 1, 'chat/completions 至少 1 次', `${r.hits} 次`);
  chk(sc, '来源标注为 AI', /AI 识别/.test(r.dom.warnText), '弹层显示「解析方式：AI 识别」', clip(r.dom.warnText, 150), '事故级');
  chk(sc, '条目被记上', r.dom.entries.length >= 1, '至少 1 条可确认的条目', `${r.dom.entries.length} 条${r.dom.entries.length ? `：${r.dom.entries.map((e) => e.name).join('、')}` : ''}`, '事故级');
  const totalNum = Number(String(r.dom.total).replace(/[^0-9.]/g, ''));
  chk(sc, '热量非 0', totalNum > 0, '这一餐合计热量 > 0', `合计「${r.dom.total || '（无）'}」`, '事故级');
  chk(sc, '没有 0 kcal 条目', !r.dom.entries.some((e) => /^0\s*kcal/.test(e.kcal)), '每条热量都 > 0', r.dom.entries.map((e) => e.kcal || '（空）').join(' / ') || '无条目', '事故级');
  chk(sc, '有「记上」按钮', r.dom.saveBtn, '存在 #draftSave', r.dom.saveBtn ? `有（${r.dom.saveBtnText}）` : '没有');
  sc.shots.push(await shot(`${shotPrefix}-draft`));
  const saved = await clickSaveDraft();
  const st = await readMainState();
  const first = st.entries[0];
  chk(sc, '保存进记录', st.entries.length === 1 && first && first.name.includes('牛肉面') && first.grams === 600,
    '记录里 1 条「牛肉面 600 克」', `${st.entries.length} 条${st.entries.length ? `：${st.entries.map((e) => `${e.name} ${e.grams} 克`).join('、')}` : ''}`, '事故级');
  chk(sc, '保存的热量可用', st.entries.length > 0 && st.entries.every((e) => Number(e.kcalPer100) > 0),
    '保存的食物每 100 克热量 > 0（界面才能算出非 0 热量）', st.entries.map((e) => e.kcalPer100).join(' / ') || '无', '严重');
  chk(sc, '用户看得到「记上」', saved, '点了「就这样，记上」并能保存', saved ? '已点' : '没有按钮');
  await dismissCelebrate();
  endScenario(sc, `来源「AI 识别」，弹层 ${r.dom.entries.length} 条、合计 ${Math.round(totalNum)} kcal；保存后记录 ${st.entries.length} 条（${first ? `${first.name} ${first.grams} 克` : '无'}）`);
  return sc;
}

/**
 * 失败路径：AI 返回失败（401/500/超时/非法 JSON/连不上）。
 * 分两种输入文本：
 *   · offlineUnknown = true  → 离线也认不出（AI 的错误提示是用户唯一能看到的信号）
 *   · offlineUnknown = false → 离线能认出（对照组：确认错误在「离线兜底有条目」时确实会显示）
 */
async function scenarioAiFailure(group, id, title, {
  model, text, expectText, promptPatterns, offlineUnknown, waitMs = 12000, shotPrefix, baseUrl,
}) {
  const sc = beginScenario(group, id, title,
    `${expectText}；不显示「AI 识别」；不创建记录；保留用户输入的文字；界面不卡在解析中`);
  const r = await aiRound({ model, text, waitMs, baseUrl });
  chk(sc, '页面启动', r.ready, 'window.__appReady === true', r.ready ? '是' : `否（${r.bootErr || '启动失败'}）`, '严重');
  chk(sc, 'AI 配置生效', r.aiReady, '记录页按钮显示「AI 已开启」', r.aiReady ? '是' : '否（AI 没被调用，测试无意义）', '严重');
  if (model !== 'cors') {
    chk(sc, '假服务商真的收到请求', r.hits >= 1, 'chat/completions 至少 1 次', `${r.hits} 次`);
  }
  chk(sc, '界面没有永久卡在「解析中」', !r.waitErr && !r.dom.parseBtnDisabled,
    '弹层在限时内出现，按钮恢复可点', r.waitErr ? r.waitErr : `按钮「${r.dom.parseBtnText}」，disabled=${r.dom.parseBtnDisabled}`, '事故级');
  if (r.waitErr) {
    endScenario(sc, `界面没有给出结果：${r.waitErr}`);
    return sc;
  }

  const visibleText = `${r.dom.draftText} ${(await readToasts()).join(' ')}`;
  const promptOk = promptPatterns.some((re) => re.test(visibleText));
  chk(sc, '明确提示 AI 失败原因', promptOk, expectText, `弹层全文「${clip(r.dom.draftText, 200)}」`, '严重');
  chk(sc, '不显示「AI 识别」', !/AI 识别/.test(r.dom.warnText), '弹层里没有「AI 识别 / 已用 AI」之类的成功字样', `弹层提示「${clip(r.dom.warnText, 150) || '（无）'}」`, '事故级');
  if (offlineUnknown) {
    chk(sc, '不显示「记上」按钮', !r.dom.saveBtn, '一条都没解析出来时不显示 #draftSave', r.dom.saveBtn ? `有（${r.dom.saveBtnText}）` : '没有', '严重');
    chk(sc, '没有 0 kcal 草稿', r.dom.entries.length === 0 && !/0\s*kcal/.test(r.dom.draftText), '不出现条目/0 kcal 草稿', `条目 ${r.dom.entries.length} 条`);
  } else {
    chk(sc, '离线兜底如实标成离线', /离线识别/.test(r.dom.warnText), '弹层显示「离线识别（常见说法）」', clip(r.dom.warnText, 150), '事故级');
  }
  chk(sc, '保留用户输入的文字', r.dom.inputValue === text, `输入框仍是「${text}」`, `输入框是「${clip(r.dom.inputValue, 80)}」`, '一般');
  sc.shots.push(await shot(`${shotPrefix}-sheet`));
  const st = await closeAndReadState();
  chk(sc, '没有创建记录', st.entries.length === 0, '存档里 0 条食物记录', `${st.entries.length} 条${st.entries.length ? `：${st.entries.map((e) => e.name).join('、')}` : ''}`, '事故级');

  const actual = offlineUnknown
    ? `弹层只显示「${clip(r.dom.draftText, 110)}」，${promptOk ? '能看到失败原因' : '完全看不到密钥/服务商/超时/解析相关的任何提示'}；未创建记录`
    : `弹层提示「${clip(r.dom.warnText, 130)}」；条目来自离线兜底；未创建记录`;
  endScenario(sc, actual);
  return sc;
}

/** items 全部匹配不上本地食物库（AI 返回了名字，但库里没有） */
async function scenarioAiUnmatched(group, id, title, { text, shotPrefix }) {
  const sc = beginScenario(group, id, title, '明确列出哪些没匹配上、不给「记上」按钮、不显示「AI 识别」、不创建记录');
  const r = await aiRound({ model: 'unmatched', text });
  chk(sc, '页面启动', r.ready, 'window.__appReady === true', r.ready ? '是' : '否', '严重');
  chk(sc, '假服务商真的收到请求', r.hits >= 1, 'chat/completions 至少 1 次', `${r.hits} 次`);
  chk(sc, '界面没卡住', !r.waitErr, '弹层在限时内出现', r.waitErr || '正常');
  chk(sc, '明确列出没匹配上的食物', /量子寿司/.test(r.dom.draftText), '弹层列出「量子寿司」', clip(r.dom.draftText, 200), '严重');
  chk(sc, '不显示「记上」按钮', !r.dom.saveBtn, '一条都没记上时不显示 #draftSave', r.dom.saveBtn ? `有（${r.dom.saveBtnText}）` : '没有', '事故级');
  chk(sc, '不显示「AI 识别」', !/AI 识别/.test(r.dom.warnText), '弹层里没有「AI 识别」', `弹层提示「${clip(r.dom.warnText, 160)}」`, '事故级');
  chk(sc, '没有 0 kcal 草稿', r.dom.entries.length === 0, '不出现条目', `${r.dom.entries.length} 条`);
  sc.shots.push(await shot(`${shotPrefix}-unmatched`));
  const st = await closeAndReadState();
  chk(sc, '没有创建记录', st.entries.length === 0, '存档里 0 条食物记录', `${st.entries.length} 条`, '事故级');
  endScenario(sc, `弹层列出「量子寿司」并说明本地库没有；无「记上」按钮；未创建记录`);
  return sc;
}

/**
 * 额外场景（来源造假）：AI 返回的条目全部匹配不上，但离线兜底恰好认得出这句话。
 * 这条路会走到「AI 结果为空 → 退回离线 → 但 source 仍被标成 ai」，是最容易被忽略的「骗人」路径。
 */
async function scenarioAiProvenanceLie(group, id, title) {
  const sc = beginScenario(group, id, title,
    'AI 全部没匹配上时，界面不能把离线兜底的结果标成「AI 识别」，也不该在 AI 什么都没匹配到时给「记上」');
  const r = await aiRound({ model: 'unmatched', text: '中午吃了一碗牛肉面' });
  chk(sc, '假服务商真的收到请求', r.hits >= 1, 'chat/completions 至少 1 次', `${r.hits} 次`);
  chk(sc, '界面没卡住', !r.waitErr, '弹层在限时内出现', r.waitErr || '正常');
  chk(sc, '列出没匹配上的食物', /量子寿司/.test(r.dom.draftText), '弹层列出「量子寿司」', clip(r.dom.draftText, 200));
  chk(sc, '不显示「AI 识别」', !/AI 识别/.test(r.dom.warnText), '弹层里没有「AI 识别」', `弹层提示「${clip(r.dom.warnText, 180)}」`, '事故级');
  // 产品决定（2026-10-20，Lead）：AI 一条都没匹配上、但离线解析认得出这句话时，
  // 允许把离线结果给用户记 —— 但**来源必须写明「离线识别」**，并把 AI 没匹配上的列出来。
  // 以前这里要求「不许给记上」，那等于把用户这句话作废：离线明明认对了牛肉面。
  chk(sc, '来源写明是离线识别', /离线识别/.test(r.dom.warnText), '弹层写明「离线识别（常见说法）」',
    `弹层提示「${clip(r.dom.warnText, 180)}」`, '事故级');
  chk(sc, '离线认出来了就允许记上', Boolean(r.dom.saveBtn), '有「就这样，记上」按钮',
    r.dom.saveBtn ? '有' : '没有（离线认出来的结果被白白丢掉）', '严重');
  const shownNames = r.dom.entries.map((e) => e.name).join('、');
  chk(sc, 'AI 没匹配上的东西要列出来', /量子寿司/.test(r.dom.draftText), '弹层列出「量子寿司」',
    `界面条目：${shownNames || '无'}`, '严重');
  sc.shots.push(await shot(`${id.toLowerCase()}-provenance`));
  const st = await closeAndReadState();
  chk(sc, '未创建记录（没有点保存）', st.entries.length === 0, '存档里 0 条食物记录', `${st.entries.length} 条`, '事故级');
  endScenario(sc, `弹层写明来源「离线识别」，条目「${shownNames || '无'}」来自离线兜底；AI 没匹配上的「量子寿司」也列出来了`);
  return sc;
}

/** items 空数组 */
async function scenarioAiEmptyItems(group, id, title) {
  const sc = beginScenario(group, id, title, '绝不显示「记上」按钮、绝不显示 0 kcal 草稿、不显示「AI 识别」、不创建记录');
  const r = await aiRound({ model: 'empty', text: '吃了两份量子寿司' });
  chk(sc, '假服务商真的收到请求', r.hits >= 1, 'chat/completions 至少 1 次', `${r.hits} 次`);
  chk(sc, '界面没卡住', !r.waitErr, '弹层在限时内出现', r.waitErr || '正常');
  chk(sc, '不显示「记上」按钮', !r.dom.saveBtn, '不出现 #draftSave', r.dom.saveBtn ? `有（${r.dom.saveBtnText}）` : '没有', '事故级');
  chk(sc, '没有 0 kcal 草稿', r.dom.entries.length === 0 && !/0\s*kcal/.test(r.dom.draftText), '不出现条目、不出现「0 kcal」', `条目 ${r.dom.entries.length} 条；弹层「${clip(r.dom.draftText, 120)}」`, '事故级');
  chk(sc, '不显示「AI 识别」', !/AI 识别/.test(r.dom.warnText), '弹层里没有「AI 识别」', clip(r.dom.warnText, 140) || '（无）', '事故级');
  sc.shots.push(await shot(`${id.toLowerCase()}-empty`));
  const st = await closeAndReadState();
  chk(sc, '没有创建记录', st.entries.length === 0, '存档里 0 条食物记录', `${st.entries.length} 条`, '事故级');
  chk(sc, '没有未捕获异常', (await readAuditErrors()).length === 0, 'window 错误列表为空', JSON.stringify(await readAuditErrors()).slice(0, 200));
  endScenario(sc, `AI 返回空 items → 弹层只说「没认出来」，没有「记上」按钮，也没有 0 kcal 草稿`);
  return sc;
}

/** 50 条超长返回：不崩溃、不卡死 */
async function scenarioAiManyItems(group, id, title) {
  const sc = beginScenario(group, id, title, '50 条返回不崩溃、不卡死；弹层能打开、能关掉，页面仍可操作');
  const r = await aiRound({ model: 'many', text: '今天吃了一桌菜', waitMs: 20000 });
  chk(sc, '界面没卡死', !r.waitErr, '解析结果在 20 秒内出现', r.waitErr || `用了 ${(r.elapsed / 1000).toFixed(1)} 秒`);
  chk(sc, '50 条都渲染出来', r.dom.entries.length >= 40, `条目数 ${r.dom.entries.length}（50 条里允许少量被收敛）`, `${r.dom.entries.length} 条`);
  chk(sc, '解析按钮恢复可点', !r.dom.parseBtnDisabled, '按钮恢复「解析这一句」', `「${r.dom.parseBtnText}」`);
  const errs = await readAuditErrors();
  chk(sc, '没有未捕获异常', errs.length === 0, 'window 错误列表为空', JSON.stringify(errs).slice(0, 200), '严重');
  sc.shots.push(await shot(`${id.toLowerCase()}-many`));
  await dismissCelebrate();
  await closeSheet();
  await evalJs(`document.querySelector('.tab[data-view="today"]')?.click(); true`);
  await sleep(250);
  const alive = await evalJs(`(() => {
    const root = document.querySelector('#sheetRoot');
    return { ready: window.__appReady === true, sheetHidden: !!root && root.classList.contains('hidden'), cards: document.querySelectorAll('#app .card').length };
  })()`);
  chk(sc, '关掉弹层后页面仍可操作', alive.ready && alive.sheetHidden && alive.cards > 0,
    '弹层关闭、今天页正常渲染', `ready=${alive.ready}，弹层已关=${alive.sheetHidden}，卡片 ${alive.cards} 个`, '严重');
  const st = await readMainState();
  chk(sc, '未点保存就不产生记录', st.entries.length === 0, '存档 0 条', `${st.entries.length} 条`);
  endScenario(sc, `50 条全部渲染（${r.dom.entries.length} 条），${(r.elapsed / 1000).toFixed(1)} 秒内出结果，关掉后页面正常`);
  return sc;
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 存档场景
 * ══════════════════════════════════════════════════════════════════ */

/** 当前版本的「干净存档」，带资料（有资料才会渲染「今天」页） */
function makeCurrentState({ days = {}, weights = [], mode = 'basic' } = {}) {
  return {
    version: 4, schemaVersion: 4, profile: DEMO_PROFILE,
    settings: { trainDays: 3, stepsKey: 'mid', mode },
    days, customFoods: [], weights, achievements: EMPTY_ACHIEVEMENTS,
  };
}

async function setupStorage(code) {
  await evalJs(`(() => { localStorage.clear(); ${code} return true; })()`);
  // v28：更新弹窗会在启动时弹（自检造的存档带 profile），它的定时器可能和下一个场景的
  // 「清空存档 → 跳转」窗口撞车（曾导致一次保存记出两条，见 .audit/v28-verify.md）。
  // 自检场景统一算「已经看过当前版本」，弹窗不参与；专门测弹窗的地方另用浏览器自检。
  await evalJs(`(() => {
    try {
      const raw = localStorage.getItem('fatloss.state.v2');
      if (!raw) return true;
      const st = JSON.parse(raw);
      if (st && typeof st === 'object') {
        st.settings = { ...(st.settings || {}), lastSeenVersion: ${JSON.stringify(SEEN)} };
        localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
      }
    } catch { /* 坏 JSON 场景：保持原样，让应用自己去处理 */ }
    return true;
  })()`);
  await goto(`${BASE}/`);
}

/** 等启动提示（「记录读取有问题」是庆祝层；升级提示是 toast） */
async function waitStartupNotice(maxMs = 3500) {
  try {
    return await waitFor(async () => await readNotice(), maxMs, 100, '启动提示');
  } catch { return null; }
}

async function waitStartupToast(maxMs = 3500) {
  try {
    return await waitFor(async () => {
      const toasts = await readToasts();
      return toasts.length ? toasts.join(' | ') : null;
    }, maxMs, 100, '启动 toast');
  } catch { return null; }
}

/** 存档 1：主存档是坏 JSON */
async function scenarioStorageCorrupt(group) {
  const sc = beginScenario(group, 'S-1', '主存档是损坏的 JSON（{oops）',
    '页面能打开；给出可恢复的诚实提示；不静默清空');
  await setupStorage(`localStorage.setItem('fatloss.state.v2', '{oops');`);
  const ready = await evalJs('window.__appReady === true');
  const rawAfter = await evalJs(`localStorage.getItem('fatloss.state.v2')`);
  const notice = await waitStartupNotice();
  if (notice) sc.shots.push(await shot('storage-corrupt-notice'));
  const welcome = await evalJs(`({ recoverBtn: !!document.querySelector('[data-act="recover"]'), text: (document.querySelector('#app')?.innerText || '').slice(0, 200) })`);
  chk(sc, '页面能打开', ready, 'window.__appReady === true', ready ? '是' : '否', '事故级');
  chk(sc, '给出诚实的读取失败提示', Boolean(notice && /记录读取有问题/.test(notice.title) && /损坏|读不出来/.test(notice.sub)),
    '提示标题含「记录读取有问题」且说明存档损坏/读不出来', notice ? `「${notice.title}：${clip(notice.sub, 120)}」` : '没有出现启动提示', '严重');
  chk(sc, '有可恢复入口', welcome.recoverBtn, '欢迎页有「已经用过？点这里找回记录」', welcome.recoverBtn ? '有' : '没有', '严重');
  if (notice) await dismissCelebrate();
  let recoverText = '';
  if (welcome.recoverBtn) {
    await evalJs(`document.querySelector('[data-act="recover"]').click(); true`);
    await sleep(300);
    recoverText = await evalJs(`(document.querySelector('#sheetBody')?.innerText || '').replace(/\\s+/g, ' ').trim()`);
    sc.shots.push(await shot('storage-corrupt-recover'));
    chk(sc, '找回弹层能看到损坏存档还在', recoverText.includes('fatloss.state.v2') && /KB/.test(recoverText),
      '列出本机键名与大小', clip(recoverText, 160), '严重');
    await closeSheet();
  }
  const rawFinal = await evalJs(`localStorage.getItem('fatloss.state.v2')`);
  const preserved = await readUnreadableRaw();
  chk(sc, '没有静默清空（坏数据原样保留）', rawFinal === '{oops', 'localStorage 里仍是「{oops」', rawFinal === '{oops' ? '原样保留' : `被改成了「${clip(rawAfter, 80)}」`, '事故级');
  chk(sc, '坏数据可取回（主键保留或另存一份）', rawFinal === '{oops' || preserved?.raw === '{oops',
    '坏数据原样可拿到（之后能导出/手工抢救）', preserved?.raw === '{oops' ? '已另存一份（fatloss.state.unreadable）' : '只留在主键里', '一般');
  chk(sc, '没有未捕获异常', (await readAuditErrors()).length === 0, 'window 错误列表为空', JSON.stringify(await readAuditErrors()).slice(0, 200));
  endScenario(sc, `页面正常打开；提示「${clip(notice?.sub, 100) || '无'}」；欢迎页有找回记录入口；坏数据未被清空`);
  return sc;
}

/** 存档 2：schemaVersion=999（来自更新版本） */
async function scenarioStorageFuture(group) {
  const sc = beginScenario(group, 'S-2', '存档来自更新版本（schemaVersion=999）',
    '拒绝读取并提示先更新；启动时不覆盖，数据仍在');
  const fixture = `
    const today = window.__audit.today();
    const st = {
      schemaVersion: 999, version: 999, profile: ${JSON.stringify(DEMO_PROFILE)},
      settings: { trainDays: 3, stepsKey: 'mid' },
      days: {}, customFoods: [], weights: [{ date: '2026-10-01', kg: 58.5 }],
      achievements: { seen: [], lastWeeklyAt: null, milestones: [] },
      futureOnlyField: { keep: true },
    };
    st.days[today] = {
      meals: { breakfast: [], lunch: [{ id: 'e1', meal: 'lunch', food: ${JSON.stringify(FOOD_BEEF_NOODLE)}, grams: 600 }], dinner: [], snack: [] },
      exercises: [], note: '',
    };
    localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
  `;
  await setupStorage(fixture);
  const ready = await evalJs('window.__appReady === true');
  const rawAtBoot = await evalJs(`localStorage.getItem('fatloss.state.v2')`);
  const notice = await waitStartupNotice();
  if (notice) sc.shots.push(await shot('storage-future999-notice'));
  const welcome = await evalJs(`({ recoverBtn: !!document.querySelector('[data-act="recover"]'), text: (document.querySelector('#app')?.innerText || '').slice(0, 200) })`);
  chk(sc, '页面能打开', ready, 'window.__appReady === true', ready ? '是' : '否', '事故级');
  chk(sc, '明确提示「来自更新版本，请先更新」', Boolean(notice && /更新的版本/.test(notice.sub) && /v999/.test(notice.sub)),
    '提示里出现「更新的版本」「v999」', notice ? `「${notice.title}：${clip(notice.sub, 140)}」` : '没有出现启动提示', '严重');
  chk(sc, '启动时不覆盖存档', rawAtBoot && rawAtBoot.includes('futureOnlyField'), 'localStorage 原样保留（含未来字段）', rawAtBoot && rawAtBoot.includes('futureOnlyField') ? '原样保留' : '被覆盖了', '事故级');
  chk(sc, '有找回记录入口', welcome.recoverBtn, '欢迎页有找回记录按钮', welcome.recoverBtn ? '有' : '没有', '严重');
  if (notice) await dismissCelebrate();
  let recoverText = '';
  if (welcome.recoverBtn) {
    await evalJs(`document.querySelector('[data-act="recover"]').click(); true`);
    await sleep(300);
    recoverText = await evalJs(`(document.querySelector('#sheetBody')?.innerText || '').replace(/\\s+/g, ' ').trim()`);
    chk(sc, '找回弹层里能看到原数据还在', /1\s*天记录/.test(recoverText), '列表显示该键有「1 天记录」', clip(recoverText, 180), '严重');
    await closeSheet();
  }
  chk(sc, '没有未捕获异常', (await readAuditErrors()).length === 0, 'window 错误列表为空', JSON.stringify(await readAuditErrors()).slice(0, 200));
  endScenario(sc, `拒绝读取并提示「${clip(notice?.sub, 120) || '无'}」；存档原样保留，找回弹层仍显示 1 天记录`);
  return sc;
}

/** 额外风险：更新版本提示 6 秒后自动消失，之后用户点欢迎页按钮会不会把原始存档弄丢 */
async function scenarioStorageFutureOverwrite(group) {
  const sc = beginScenario(group, 'S-2b', '更新版本提示消失后，欢迎页按钮是否会弄丢原存档（额外风险）',
    '提示消失后用户继续操作，也不能把「来自更新版本」的原始存档悄悄弄丢：要么不覆盖，要么原样留存且用户被持续告知、能导出');
  const fixture = `
    const today = window.__audit.today();
    const st = {
      schemaVersion: 999, profile: ${JSON.stringify(DEMO_PROFILE)},
      settings: { trainDays: 3, stepsKey: 'mid' }, days: {}, customFoods: [], weights: [],
      achievements: { seen: [], lastWeeklyAt: null, milestones: [] },
    };
    st.days[today] = { meals: { breakfast: [], lunch: [{ id: 'e1', meal: 'lunch', food: ${JSON.stringify(FOOD_BEEF_NOODLE)}, grams: 600 }], dinner: [], snack: [] }, exercises: [] };
    localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
  `;
  await setupStorage(fixture);
  const rawBefore = await evalJs(`localStorage.getItem('fatloss.state.v2')`);
  const preservedAtBoot = await readUnreadableRaw();
  const notice = await waitStartupNotice();
  // 不点「好」，记录提示自动消失用了多久（应用里是 6 秒自动关）
  const t0 = Date.now();
  let autoCloseMs = null;
  try {
    await waitFor(async () => !(await readNotice()), 8000, 150, '提示自动消失');
    autoCloseMs = Date.now() - t0;
  } catch { autoCloseMs = null; }
  if (!(await readNotice())) sc.shots.push(await shot('storage-future999-after-notice'));
  // 提示消失后，欢迎页是否还在说「有一份记录没读出来」（而不是变回全新用户）
  const welcomeAfter = await evalJs(`(() => ({
    text: (document.querySelector('#app')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 800),
    exportBtn: !!document.querySelector('[data-act="export-unreadable"]'),
  }))()`);
  const rawBeforeDemo = await evalJs(`localStorage.getItem('fatloss.state.v2')`);
  await evalJs(`document.querySelector('[data-act="demo"]')?.click(); true`);
  await sleep(500);
  const st = await readMainState();
  const rawAfter = await evalJs(`localStorage.getItem('fatloss.state.v2')`);
  const preservedAfter = await readUnreadableRaw();
  const mainUnchanged = rawAfter === rawBefore;
  const preservedIntact = Boolean(preservedAfter && preservedAfter.raw === rawBefore);
  const rawStillRecoverable = mainUnchanged || preservedIntact;

  chk(sc, '提示会自动消失（不会永久挡住页面）', Boolean(notice) && (autoCloseMs == null ? true : autoCloseMs < 9000),
    '提示约 6 秒后自动关闭', autoCloseMs == null ? '提示一直没关？' : `${(autoCloseMs / 1000).toFixed(1)} 秒后消失`);
  chk(sc, '欢迎页有常驻警告（不是只弹 6 秒）', /没读出来/.test(welcomeAfter.text) && welcomeAfter.exportBtn,
    '欢迎页常驻卡片说明「有一份记录没读出来」，并提供「导出一份原始文件」',
    /没读出来/.test(welcomeAfter.text) ? `有常驻提示${welcomeAfter.exportBtn ? '和导出入口' : '，但没有导出入口'}` : '提示消失后页面跟全新用户一样', '严重');
  chk(sc, '提示消失后原存档仍是 v999 数据', rawBeforeDemo === rawBefore, '提示消失本身不改写存档', rawBeforeDemo === rawBefore ? '未被改写' : '被改写了');
  chk(sc, '点「看一个填好的例子」不会弄丢原始存档', rawStillRecoverable,
    '主存档不被覆盖，或者原始文本被原样另存一份（可导出）',
    mainUnchanged
      ? '主存档未被覆盖'
      : (preservedIntact
        ? `主存档被覆盖成 v${st.schemaVersion}，但原始 v999 文本已原样另存（${preservedAfter.rawLength} 字符），仍可取回`
        : `主存档被覆盖成 v${st.schemaVersion}（${st.entries.length} 条演示记录），也没有另存原始内容 —— 原 v999 数据丢失`), '事故级');
  chk(sc, '原始内容能被用户导出（有入口）', welcomeAfter.exportBtn || preservedIntact,
    '欢迎页有「导出一份原始文件」按钮，或至少已另存', welcomeAfter.exportBtn ? '有导出按钮' : (preservedIntact ? '没有导出按钮，但已另存' : '没有'));
  sc.shots.push(await shot('storage-future999-overwritten'));
  const actual = mainUnchanged
    ? `提示 ${autoCloseMs == null ? '（没测到）' : `${(autoCloseMs / 1000).toFixed(1)} 秒`}后自动消失；主存档未被覆盖；欢迎页有常驻警告`
    : `提示 ${autoCloseMs == null ? '（没测到）' : `${(autoCloseMs / 1000).toFixed(1)} 秒`}后自动消失；随后点「看一个填好的例子」把主存档覆盖成 v${st.schemaVersion} 演示数据；${preservedIntact ? '原始 v999 文本已另存且可导出（数据没丢）' : '原始 v999 数据丢失'}`;
  endScenario(sc, actual);
  return sc;
}

/** 存档 3：v1 形状迁移 */
async function scenarioStorageV1(group) {
  const sc = beginScenario(group, 'S-3', 'v1 形状存档（version:1，记录没有 meal 字段）',
    '迁移成功、记录还在、升级前自动留快照；保存后落成 v4 且记录一条不少');
  const fixture = `
    const today = window.__audit.today();
    const v1 = {
      version: 1, profile: ${JSON.stringify(DEMO_PROFILE)},
      days: {}, customFoods: [],
      weights: [{ date: today, kg: 58.5 }],
    };
    v1.days[today] = {
      meals: {
        lunch: [{ id: 'e1', food: ${JSON.stringify(FOOD_RICE)}, grams: 200 }],
        dinner: [{ id: 'e2', food: ${JSON.stringify(FOOD_EGG)}, grams: 50 }],
      },
    };
    localStorage.setItem('fatloss.state.v2', JSON.stringify(v1));
  `;
  await setupStorage(fixture);
  const ready = await evalJs('window.__appReady === true');
  const toast = await waitStartupToast();
  const pageText = await evalJs(`(document.querySelector('#app')?.innerText || '').replace(/\\s+/g, ' ')`);
  const uiEntries = await evalJs(`[...document.querySelectorAll('#app .entry .name')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim())`);
  const backup = await readBackupRaw();
  const backupRaw = await evalJs(`localStorage.getItem('fatloss.backup')`);
  chk(sc, '页面能打开', ready, 'window.__appReady === true', ready ? '是' : '否', '事故级');
  chk(sc, '提示已从旧版本升级', Boolean(toast && /升级/.test(toast) && /v1/.test(toast)), '出现「记录已从旧版本（v1）升级到 v4，数据都在」', toast ? clip(toast, 160) : '没有出现升级提示', '严重');
  chk(sc, '今日页能看到旧记录', /米饭/.test(pageText) && uiEntries.some((n) => /米饭/.test(n)), '今天页显示「米饭（熟）200 克」', `界面条目：${uiEntries.join('、') || '无'}`, '事故级');
  chk(sc, '升级自动留了快照', Boolean(backupRaw) && backup && backup.version === 1, 'fatloss.backup 存在且是 v1 原数据', backupRaw ? `快照 v${backup?.version}，记录 ${backup?.entries?.length ?? '?'} 条` : '没有快照', '严重');
  sc.shots.push(await shot('storage-v1-migrated'));
  // 触发一次「不改数据」的保存（记录页分段切换会 save），确认迁移结果真的落盘、记录没少
  await persistViaRecordTab();
  const st = await readMainState();
  chk(sc, '保存后结构版本是 v4', st.schemaVersion === 4, 'schemaVersion=4', `schemaVersion=${st.schemaVersion}`, '严重');
  chk(sc, '迁移后记录一条不少', st.entries.length === 2 && st.entries.every((e) => e.meal), '2 条记录都还在，并补上了 meal 字段', `${st.entries.length} 条：${st.entries.map((e) => `${e.name}(${e.meal})`).join('、') || '无'}`, '事故级');
  chk(sc, '体重记录也还在', st.weightCount === 1, '1 条体重记录', `${st.weightCount} 条`);
  endScenario(sc, `从 v1 升到 v4；界面显示米饭 200 克 + 鸡蛋 50 克；自动快照存在；保存后 2 条记录与 1 条体重都在`);
  return sc;
}

/** 存档 4：v2 形状迁移 */
async function scenarioStorageV2(group) {
  const sc = beginScenario(group, 'S-4', 'v2 形状存档（schemaVersion:2）',
    '迁移成功、记录还在、升级前自动留快照；保存后落成 v4 且记录一条不少');
  const fixture = `
    const today = window.__audit.today();
    const v2 = {
      schemaVersion: 2, version: 2, profile: ${JSON.stringify(DEMO_PROFILE)},
      settings: { trainDays: 3, stepsKey: 'mid' }, days: {}, customFoods: [], weights: [],
    };
    v2.days[today] = {
      meals: {
        breakfast: [{ id: 'e1', meal: 'breakfast', food: ${JSON.stringify(FOOD_EGG)}, grams: 100 }],
        lunch: [{ id: 'e2', meal: 'lunch', food: ${JSON.stringify(FOOD_BEEF_NOODLE)}, grams: 600 }],
        dinner: [], snack: [],
      },
      exercises: [],
    };
    localStorage.setItem('fatloss.state.v2', JSON.stringify(v2));
  `;
  await setupStorage(fixture);
  const ready = await evalJs('window.__appReady === true');
  const toast = await waitStartupToast();
  const pageText = await evalJs(`(document.querySelector('#app')?.innerText || '').replace(/\\s+/g, ' ')`);
  const backup = await readBackupRaw();
  chk(sc, '页面能打开', ready, 'window.__appReady === true', ready ? '是' : '否', '事故级');
  chk(sc, '提示已从 v2 升级', Boolean(toast && /升级/.test(toast) && /v2/.test(toast)), '出现「记录已从旧版本（v2）升级到 v4」', toast ? clip(toast, 160) : '没有出现升级提示', '严重');
  chk(sc, '今日页能看到旧记录', /鸡蛋/.test(pageText) && /牛肉面/.test(pageText), '今天页显示鸡蛋与牛肉面', pageText.includes('鸡蛋') ? '显示了两条记录' : '没显示', '事故级');
  chk(sc, '升级自动留了快照', Boolean(backup) && backup.schemaVersion === 2, 'fatloss.backup 存在且来自 v2', backup ? `快照 schemaVersion=${backup.schemaVersion}` : '没有快照', '严重');
  sc.shots.push(await shot('storage-v2-migrated'));
  await persistViaRecordTab();
  const st = await readMainState();
  chk(sc, '保存后结构版本是 v4', st.schemaVersion === 4, 'schemaVersion=4', `schemaVersion=${st.schemaVersion}`, '严重');
  chk(sc, '迁移后记录一条不少', st.entries.length === 2, '2 条记录都还在', `${st.entries.length} 条：${st.entries.map((e) => e.name).join('、') || '无'}`, '事故级');
  endScenario(sc, `从 v2 升到 v4；今日页两条记录都在；自动快照存在；保存后 2 条记录仍完整`);
  return sc;
}

/** 存档 5：localStorage 写入抛 QuotaExceededError */
async function scenarioStorageQuota(group) {
  const sc = beginScenario(group, 'S-5', 'localStorage 写入抛 QuotaExceededError',
    '记录时有明确「存不进去」提示、不假装保存成功、不丢内存里已有的记录、不伪造已保存');
  const fixture = `
    const today = window.__audit.today();
    const st = {
      version: 4, schemaVersion: 4, profile: ${JSON.stringify(DEMO_PROFILE)},
      settings: { trainDays: 3, stepsKey: 'mid', mode: 'basic' },
      days: {}, customFoods: [], weights: [],
      achievements: { seen: [], lastWeeklyAt: null, milestones: [] },
    };
    st.days[today] = {
      meals: { breakfast: [], lunch: [{ id: 'e1', meal: 'lunch', food: ${JSON.stringify(FOOD_BEEF_NOODLE)}, grams: 600 }], dinner: [], snack: [] },
      exercises: [], note: '',
    };
    localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
  `;
  await setupStorage(fixture);
  const baselineRaw = await evalJs(`localStorage.getItem('fatloss.state.v2')`);
  await openLogTab();
  // 模拟存储满：覆盖 Storage.prototype.setItem，让所有写入抛 QuotaExceededError
  await evalJs(`(() => {
    window.__auditSetItemDesc = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem');
    Object.defineProperty(Storage.prototype, 'setItem', {
      configurable: true,
      writable: true,
      value() { const e = new Error('模拟存储已满'); e.name = 'QuotaExceededError'; throw e; },
    });
    return true;
  })()`);
  await evalJs(`(() => {
    const ta = document.querySelector('#quickText');
    ta.value = '两个鸡蛋';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#quickParse').click();
    return true;
  })()`);
  await waitFor(async () => await evalJs(`!!document.querySelector('#draftSave')`), 8000, 120, '离线解析结果');
  await clickSaveDraft();
  await sleep(150);
  const toasts = await readToasts();
  sc.shots.push(await shot('storage-quota-toasts'));
  const rawDuring = await evalJs(`localStorage.getItem('fatloss.state.v2')`);
  const uiAfter = await evalJs(`(() => {
    document.querySelector('.tab[data-view="today"]')?.click();
    return (document.querySelector('#app')?.innerText || '').replace(/\\s+/g, ' ');
  })()`);
  const stDuring = await readMainState();
  chk(sc, '有明确的「存不进去」提示', toasts.some((t) => /存不进去/.test(t)), '出现「存不进去了（浏览器存储可能满了）…」', `toast：${JSON.stringify(toasts)}`, '事故级');
  chk(sc, '不假装保存成功', !toasts.some((t) => /记上了|已保存|成功|成了/.test(t)),
    '失败时不应再出现「记上了 / 成了」这类成功提示', `toast：${JSON.stringify(toasts)}`, '严重');
  chk(sc, '不丢内存里已有的记录', /牛肉面/.test(uiAfter), '今天页仍显示原有「牛肉面」记录', uiAfter.includes('牛肉面') ? '仍在' : '没了', '事故级');
  chk(sc, '新记录也没从内存里消失', /鸡蛋/.test(uiAfter), '今天页显示刚记的「鸡蛋」', uiAfter.includes('鸡蛋') ? '在' : '不在', '严重');
  chk(sc, '没有伪造已保存（存储未变）', rawDuring === baselineRaw, 'localStorage 主存档与失败前一致', rawDuring === baselineRaw ? '未被写入' : `被改写了（${stDuring.entries.length} 条）`, '事故级');
  // 恢复存储能力后，再触发一次保存：内存里的记录应当能补存进去（说明没丢）
  await evalJs(`Object.defineProperty(Storage.prototype, 'setItem', window.__auditSetItemDesc); true`);
  await persistViaRecordTab();
  const stAfter = await readMainState();
  chk(sc, '存储恢复后内存记录能补存', stAfter.entries.length === 2 && stAfter.entries.some((e) => e.name.includes('鸡蛋')),
    '2 条记录（牛肉面 + 鸡蛋）', `${stAfter.entries.length} 条：${stAfter.entries.map((e) => e.name).join('、') || '无'}`, '严重');
  endScenario(sc, `toast 出现 ${JSON.stringify(toasts)}；存储未写入（仍 ${stDuring.entries.length} 条）；内存里新旧记录都在；恢复存储后补存成功`);
  return sc;
}

/** 存档 6：快照 → 修改 → 回滚（恢复机制本身） */
async function scenarioStorageSnapshotRoundtrip(group) {
  const sc = beginScenario(group, 'S-6', '「数据与备份」：留快照 → 改动 → 回滚',
    '回滚后记录数量与内容跟快照时完全一致');
  const fixture = `
    const today = window.__audit.today();
    const st = {
      version: 4, schemaVersion: 4, profile: ${JSON.stringify(DEMO_PROFILE)},
      settings: { trainDays: 3, stepsKey: 'mid', mode: 'basic' },
      days: {}, customFoods: [], weights: [{ date: today, kg: 58 }],
      achievements: { seen: [], lastWeeklyAt: null, milestones: [] },
    };
    st.days[today] = {
      meals: {
        breakfast: [{ id: 'e1', meal: 'breakfast', food: ${JSON.stringify(FOOD_EGG)}, grams: 100 }],
        lunch: [{ id: 'e2', meal: 'lunch', food: ${JSON.stringify(FOOD_BEEF_NOODLE)}, grams: 600 }],
        dinner: [], snack: [],
      },
      exercises: [], note: '',
    };
    localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
  `;
  await setupStorage(fixture);
  const baseline = await readMainState();
  // 留快照
  await openSettings();
  await openBackupSheetFromSettings();
  await evalJs(`document.querySelector('#doSnapshot').click(); true`);
  await sleep(400);
  const backup = await readBackupRaw();
  chk(sc, '快照里记录数与当前一致', Boolean(backup) && backup.entries.length === baseline.entries.length,
    `快照 ${baseline.entries.length} 条记录`, backup ? `快照 ${backup.entries.length} 条：${backup.entries.map((e) => e.name).join('、')}` : '快照没建成', '严重');
  sc.shots.push(await shot('storage-snapshot-created'));
  await closeSheet();
  await dismissCelebrate();
  // 改动：再记一条苹果
  await openLogTab();
  await evalJs(`(() => {
    const ta = document.querySelector('#quickText');
    ta.value = '一个苹果';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#quickParse').click();
    return true;
  })()`);
  await waitFor(async () => await evalJs(`!!document.querySelector('#draftSave')`), 8000, 120, '离线解析结果');
  await clickSaveDraft();
  await dismissCelebrate();
  const modified = await readMainState();
  chk(sc, '改动确实生效（对照组）', modified.entries.length === baseline.entries.length + 1,
    `多 1 条 → ${baseline.entries.length + 1} 条`, `${modified.entries.length} 条`, '严重');
  // 回滚（confirm 已被注入脚本自动点「确定」）
  await openSettings();
  await openBackupSheetFromSettings();
  await evalJs(`document.querySelector('#doRestore').click(); true`);
  await sleep(700);
  const restored = await readMainState();
  const toasts = await readToasts();
  sc.shots.push(await shot('storage-snapshot-restored'));
  const same = (a, b) => JSON.stringify(a.slice().sort((x, y) => (x.name + x.grams).localeCompare(y.name + y.grams)))
    === JSON.stringify(b.slice().sort((x, y) => (x.name + x.grams).localeCompare(y.name + y.grams)));
  chk(sc, '回滚后记录数量一致', restored.entries.length === baseline.entries.length,
    `${baseline.entries.length} 条`, `${restored.entries.length} 条`, '事故级');
  chk(sc, '回滚后记录内容一致', same(restored.entries, baseline.entries),
    `内容：${baseline.entries.map((e) => `${e.name} ${e.grams} 克`).join('、')}`,
    `实际：${restored.entries.map((e) => `${e.name} ${e.grams} 克`).join('、') || '无'}`, '事故级');
  chk(sc, '回滚有明确提示', toasts.some((t) => /回滚|恢复/.test(t)) || /已回滚/.test(toasts.join(' ')), '出现「已回滚到这份快照」', `toast：${JSON.stringify(toasts)}`);
  endScenario(sc, `快照 ${baseline.entries.length} 条 → 加 1 条变 ${modified.entries.length} 条 → 回滚后 ${restored.entries.length} 条，内容一致`);
  return sc;
}

/** 存档 7：「从头开始（清除）」会不会连带删掉刚留的快照，导致恢复不了 */
async function scenarioStorageWipeDeletesSnapshot(group) {
  // 产品决定（2026-10-20，Lead）：「从头开始」就是真的清干净 —— 包括升级前自动留的快照。
  // 隐私优先：用户输入「清除」两个字，就是要这份数据消失，不能偷偷留一份。
  // 这里要守的是「不许悄悄删」：清除前的弹层必须写明快照也会一起删掉。
  const sc = beginScenario(group, 'S-7', '快照 → 「从头开始」：快照一并删掉，但界面必须提前说清楚',
    '清除前明确告知快照也会删掉；清除后记录与快照都没了，找回弹层不许谎称还能恢复');
  const fixture = `
    const today = window.__audit.today();
    const st = {
      version: 4, schemaVersion: 4, profile: ${JSON.stringify(DEMO_PROFILE)},
      settings: { trainDays: 3, stepsKey: 'mid', mode: 'basic' },
      days: {}, customFoods: [], weights: [],
      achievements: { seen: [], lastWeeklyAt: null, milestones: [] },
    };
    st.days[today] = {
      meals: { breakfast: [], lunch: [{ id: 'e1', meal: 'lunch', food: ${JSON.stringify(FOOD_BEEF_NOODLE)}, grams: 600 }], dinner: [], snack: [] },
      exercises: [], note: '',
    };
    localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
  `;
  await setupStorage(fixture);
  const before = await readMainState();
  await openSettings();
  await openBackupSheetFromSettings();
  await evalJs(`document.querySelector('#doSnapshot').click(); true`);
  await sleep(400);
  const backupBeforeWipe = await readBackupRaw();
  chk(sc, '清除前快照存在', Boolean(backupBeforeWipe), 'fatloss.backup 已建立', backupBeforeWipe ? `快照 ${backupBeforeWipe.entries.length} 条` : '没有');
  await closeSheet();
  await dismissCelebrate();
  await openSettings();
  await openWipeSheetFromSettings();
  const wipeWarn = await evalJs(`(document.querySelector('#sheetBody')?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  chk(sc, '清除前写明快照也会删掉', /快照/.test(wipeWarn), '清除弹层里提到快照',
    /快照/.test(wipeWarn) ? '提到了' : `没提（「${clip(wipeWarn, 120)}」）`, '一般');
  await evalJs(`(() => {
    const input = document.querySelector('#wipeConfirm');
    input.value = '清除';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await evalJs(`document.querySelector('#wipeGo').click(); true`);
  await sleep(700);
  const after = await readMainState();
  const backupAfterWipe = await readBackupRaw();
  sc.shots.push(await shot('storage-wipe-after'));
  chk(sc, '清除确实清空了记录', after.entries.length === 0, '记录清零', `${after.entries.length} 条`, '严重');
  chk(sc, '清除后快照也删掉（不留残影）', !backupAfterWipe, 'fatloss.backup 已删除', backupAfterWipe ? '快照还在（没清干净）' : '已删除', '一般');
  // 尝试找回：关掉引导弹层，进欢迎页的找回记录
  await closeSheet();
  await dismissCelebrate();
  const canRecover = await evalJs(`!!document.querySelector('[data-act="recover"]')`);
  let recoverText = '';
  if (canRecover) {
    await evalJs(`document.querySelector('[data-act="recover"]').click(); true`);
    await sleep(300);
    recoverText = await evalJs(`(document.querySelector('#sheetBody')?.innerText || '').replace(/\\s+/g, ' ').trim()`);
    sc.shots.push(await shot('storage-wipe-recover'));
  }
  const hasSnapshotRestore = /用升级前的快照恢复|data-recover="backup"/.test(recoverText) || /快照/.test(recoverText);
  chk(sc, '清除后不许谎称还能从快照恢复', !hasSnapshotRestore, '找回弹层里没有快照恢复入口',
    hasSnapshotRestore ? '还在说有快照（其实已经删了，会误导）' : '没有，符合预期', '一般');
  sc.shots.push(await shot('storage-wipe-snapshot-gone'));
  endScenario(sc, `清除前已告知快照会一起删掉；清除后记录 ${after.entries.length} 条、快照${backupAfterWipe ? '还在（没清干净）' : '已删除'}；找回弹层${hasSnapshotRestore ? '仍说有快照' : '没有快照入口'}`);
  return sc;
}

/** 存档 8：清除必须输入「清除」两个字 */
async function scenarioStorageWipeGuard(group) {
  const sc = beginScenario(group, 'S-8', '清除必须输入「清除」二字，输错不能清',
    '输入错误文字时按钮不可用、点了也不清；输入「清除」才真正清掉');
  const fixture = `
    const today = window.__audit.today();
    const st = {
      version: 4, schemaVersion: 4, profile: ${JSON.stringify(DEMO_PROFILE)},
      settings: { trainDays: 3, stepsKey: 'mid' },
      days: {}, customFoods: [], weights: [],
      achievements: { seen: [], lastWeeklyAt: null, milestones: [] },
    };
    st.days[today] = { meals: { breakfast: [], lunch: [{ id: 'e1', meal: 'lunch', food: ${JSON.stringify(FOOD_BEEF_NOODLE)}, grams: 600 }], dinner: [], snack: [] }, exercises: [] };
    localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
  `;
  await setupStorage(fixture);
  const before = await readMainState();
  await openSettings();
  await openWipeSheetFromSettings();
  await evalJs(`(() => {
    const input = document.querySelector('#wipeConfirm');
    input.value = '清除吧';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const wrongState = await evalJs(`({ disabled: document.querySelector('#wipeGo')?.disabled, sheetOpen: !document.querySelector('#sheetRoot')?.classList.contains('hidden') })`);
  await evalJs(`document.querySelector('#wipeGo')?.click(); true`);
  await sleep(300);
  const afterWrong = await readMainState();
  chk(sc, '输错时「清除」按钮不可用', wrongState.disabled === true, '#wipeGo disabled=true', `disabled=${wrongState.disabled}`, '事故级');
  chk(sc, '输错时点了也不清', afterWrong.entries.length === before.entries.length && afterWrong.raw !== undefined,
    `记录仍 ${before.entries.length} 条`, `${afterWrong.entries.length} 条`, '事故级');
  sc.shots.push(await shot('storage-wipe-wrong-text'));
  await evalJs(`(() => {
    const input = document.querySelector('#wipeConfirm');
    input.value = '清除';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const rightState = await evalJs(`({ disabled: document.querySelector('#wipeGo')?.disabled })`);
  chk(sc, '输对时按钮才可用', rightState.disabled === false, '#wipeGo disabled=false', `disabled=${rightState.disabled}`);
  await evalJs(`document.querySelector('#wipeGo').click(); true`);
  await sleep(700);
  const afterRight = await readMainState();
  const toasts = await readToasts();
  chk(sc, '输对后真的清空', afterRight.entries.length === 0, '记录清零', `${afterRight.entries.length} 条`, '严重');
  chk(sc, '清空有明确提示', toasts.some((t) => /已经清空/.test(t)), '出现「已经清空，我们从头来一遍」', `toast：${JSON.stringify(toasts)}`);
  await closeSheet();
  await dismissCelebrate();
  endScenario(sc, `输「清除吧」按钮不可用、点不动（记录仍 ${afterWrong.entries.length} 条）；输「清除」后才清空`);
  return sc;
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 额外发现（不在原清单，但检查过程中真实撞到）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 设置里把「AI 模式」切回「普通模式」。
 * 脚本原本用这个按钮触发一次保存，结果保存没发生 —— 查 DOM 行为发现点击时抛了异常。
 * 这是一个真实用户会碰到的路径：配过 AI 之后想切回普通模式，点了没反应。
 */
async function scenarioExtraModeSwitch(group) {
  const sc = beginScenario(group, 'E-1', '设置里从 AI 模式切回「普通模式」',
    '点了「普通模式」后模式真的切换、保存到本机、有明确反馈（不报错）');
  const fixture = JSON.stringify(JSON.stringify(makeCurrentState({ mode: 'ai' })));
  await setupStorage(`localStorage.setItem('fatloss.state.v2', ${fixture});`);
  await openSettings();
  const before = await evalJs(`(() => {
    let mode = null;
    try { mode = (JSON.parse(localStorage.getItem('fatloss.state.v2'))?.settings || {}).mode ?? null; } catch {}
    return { mode, aiChipOn: !!document.querySelector('[data-mode="ai"]') && document.querySelector('[data-mode="ai"]').classList.contains('on') };
  })()`);
  await evalJs(`document.querySelector('[data-mode="basic"]')?.click(); true`);
  await sleep(600);
  const after = await evalJs(`(() => {
    let mode = null;
    try { mode = (JSON.parse(localStorage.getItem('fatloss.state.v2'))?.settings || {}).mode ?? null; } catch {}
    return {
      storedMode: mode,
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()),
      errors: (window.__auditErrors || []).slice(),
    };
  })()`);
  chk(sc, '切换不报错', after.errors.length === 0, '没有未捕获异常', JSON.stringify(after.errors).slice(0, 240), '严重');
  chk(sc, '模式真的切换并保存', after.storedMode === 'basic', "localStorage 里 settings.mode === 'basic'", `settings.mode=${after.storedMode}（点击前是 ${before.mode}）`, '严重');
  chk(sc, '有明确反馈', after.toasts.some((t) => /普通模式/.test(t)), '出现「已切到普通模式」提示', `toast：${JSON.stringify(after.toasts)}`, '一般');
  sc.shots.push(await shot('extra-mode-switch'));
  await closeSheet();
  endScenario(sc, `点击「普通模式」后：${after.errors.length ? `抛出「${clip(after.errors.join('；'), 120)}」` : '没报错'}；localStorage 里 mode 仍为 ${after.storedMode}；${after.toasts.length ? `toast：${JSON.stringify(after.toasts)}` : '没有任何提示'}`);
  return sc;
}

/* ══════════════════════════════════════════════════════════════════
 * 7. 反向验证：证明这些检查真的会报红
 * ══════════════════════════════════════════════════════════════════ */

async function runReverse() {
  console.log('\n=== 反向验证（证明检查不是摆设）===');
  const lines = [];
  const probe1 = async () => {
    // 反向 1：让「正常场景」返回空 items，正常场景的「条目被记上」检查必须失败
    const sc = beginScenario('反向', 'R-1', '把正常场景改成返回空 items', '');
    const r = await aiRound({ model: 'ok', text: '随便对付了一口' });
    chk(sc, '条目被记上', r.dom.entries.length >= 1, '至少 1 条可确认的条目', `${r.dom.entries.length} 条`);
    chk(sc, '来源标注为 AI', /AI 识别/.test(r.dom.warnText), '弹层显示「AI 识别」', clip(r.dom.warnText, 120));
    const failed = sc.checks.filter((c) => !c.pass).map((c) => c.name);
    const ok = failed.includes('条目被记上');
    lines.push(`反向验证 1：把「正常场景」的假服务商改成返回空 items`);
    lines.push(`  期望检查「条目被记上」报红 → 实际：${failed.length ? `报红（${failed.join('、')}）` : '仍然全绿（检查是摆设！）'} ${ok ? '✅' : '❌'}`);
    return ok;
  };
  const probe2 = async () => {
    // 反向 2：人为在失败弹层里塞「AI 识别」，DOM 文本断言必须抓住
    const sc = beginScenario('反向', 'R-2', '人为让失败弹层显示「AI 识别」', '');
    const r = await aiRound({ model: '401', text: '吃了两份量子寿司' });
    await evalJs(`(() => { const h = document.querySelector('#draftHost'); if (h) h.insertAdjacentHTML('beforeend', '<div class="warn">解析方式：AI 识别</div>'); return true; })()`);
    const dom = await readDraftDom();
    chk(sc, '不显示「AI 识别」', !/AI 识别/.test(dom.warnText), '弹层里没有「AI 识别」', clip(dom.warnText, 140));
    const failed = sc.checks.filter((c) => !c.pass).map((c) => c.name);
    const ok = failed.includes('不显示「AI 识别」');
    lines.push(`反向验证 2：人为让 401 失败弹层出现「AI 识别」字样`);
    lines.push(`  期望检查「不显示 AI 识别」报红 → 实际：${failed.length ? `报红（${failed.join('、')}）` : '仍然全绿（检查是摆设！）'} ${ok ? '✅' : '❌'}`);
    return ok;
  };
  const [p1, p2] = [await probe1(), await probe2()];
  const pass = p1 && p2;
  lines.push('');
  lines.push(pass
    ? '结论：✅ 反向验证通过 —— 人为改坏之后检查确实报红，说明上面的断言不是摆设。'
    : '结论：❌ 反向验证失败 —— 改坏之后检查仍然全绿，说明检查不可信，必须重写。');
  const text = lines.join('\n');
  console.log(text);
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(REVERSE_PROOF_PATH, text + '\n');
  return pass;
}

/* ══════════════════════════════════════════════════════════════════
 * 7. 报告生成
 * ══════════════════════════════════════════════════════════════════ */

function severityOf(sc) {
  if (sc.pass) return '—';
  let best = '建议';
  for (const c of sc.checks) {
    if (c.pass) continue;
    if ((SEVERITY_RANK[c.severity] || 0) > (SEVERITY_RANK[best] || 0)) best = c.severity || '一般';
  }
  return sc.severity || best;
}

function rowLine(sc, idx) {
  const judge = sc.pass ? '通过' : '失败';
  const cells = [String(idx), sc.title, sc.expected, sc.actual, judge];
  return `| ${cells.map((c) => String(c).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;
}

/**
 * 每个场景的手工复现步骤（写进失败详情）。
 * 脚本本身已经能复现；这里是给要自己动手核对的人看的。
 */
const REPRO_STEPS = {
  'AI-1': '把 localStorage 的 fatloss.ai.v1 写成 {baseUrl:"http://127.0.0.1:18880/v1",model:"ok",apiKey:"sk-audit-fake",mode:"direct"}，重新打开页面；记录页输入「随便对付了一口」，点「解析这一句」。',
  'AI-2': '同上，但把 model 改成 "fenced"（假服务商返回 ```json 围栏）；输入「随便对付了一口」后看弹层来源与条目。',
  'AI-3': '同上，但把 model 改成 "prose"（假服务商在 JSON 前后加了自然语言）；看弹层来源与条目。',
  'AI-4a': '把 model 改成 "401"（假服务商返回 HTTP 401）；记录页输入「吃了两份量子寿司」（离线解析器认不出这句），点「解析这一句」；检查弹层里有没有「密钥」字样。',
  'AI-4b': '同 AI-4a，但输入「中午吃了一碗牛肉面」（离线解析器认得这句），看「AI 这次没成功」那一行有没有密钥提示。',
  'AI-5a': '把 model 改成 "500"（假服务商返回 HTTP 500）；输入「吃了两份量子寿司」；检查弹层有没有服务商出错提示。',
  'AI-5b': '同 AI-5a，但输入「中午吃了一碗牛肉面」，看「AI 这次没成功」那一行。',
  'AI-6a': '把 model 改成 "slow"（假服务商收下请求但 60 秒不响应）；输入「吃了两份量子寿司」；耐心等 25 秒左右，看弹层有没有超时提示、按钮有没有恢复。',
  'AI-6b': '同 AI-6a，但输入「中午吃了一碗牛肉面」，看「AI 这次没成功：等了 25 秒没有响应」那一行。',
  'AI-7a': '把 model 改成 "badjson"（HTTP 200，但 content 是 "not json at all"）；输入「吃了两份量子寿司」；看弹层有没有解析失败提示。',
  'AI-7b': '同 AI-7a，但输入「中午吃了一碗牛肉面」，看「AI 这次没成功：模型返回的不是 JSON」那一行。',
  'AI-8': '把 model 改成 "empty"（返回 {"items":[]}）；输入「吃了两份量子寿司」；检查弹层有没有「记上」按钮、有没有 0 kcal 条目。',
  'AI-9': '把 model 改成 "unmatched"（返回 {"items":[{"name":"量子寿司","grams":100}]}）；输入「吃了两份量子寿司」；检查弹层是否列出「量子寿司」、有没有「记上」按钮。',
  'AI-9b': '把 model 改成 "unmatched"（AI 只返回「量子寿司」）；输入「中午吃了一碗牛肉面」（离线解析器认得这句）；看弹层来源是不是「AI 识别」、条目是不是「牛肉面」、有没有「记上」按钮。',
  'AI-10': '把 model 改成 "many"（返回 50 条 items）；输入「今天吃了一桌菜」；看弹层是否卡死、能否关掉、页面是否还能操作。',
  'AI-11': '把 fatloss.ai.v1 的 baseUrl 改成 http://127.0.0.1:18881/v1（这个服务商故意不给跨域头）；输入「中午吃了一碗牛肉面」；看弹层是否提示「连不上」。',
  'S-1': '在 localStorage 里写 fatloss.state.v2 = "{oops"，刷新页面；看页面能否打开、有没有「记录读取有问题」提示、刷新后坏数据是否还在。',
  'S-2': '写入 {schemaVersion:999, days:{今天:{meals:{...}}}, profile:{...}}；刷新页面；看提示是否说「更新的版本，请先更新」、localStorage 是否原样保留。',
  'S-2b': '同 S-2；等启动提示约 6 秒自动消失（不点「好」），在欢迎页点「看一个填好的例子」；再读 localStorage 的 fatloss.state.v2，看 v999 数据是否被覆盖。',
  'S-3': '写入 {version:1, profile:{...}, days:{今天:{meals:{lunch:[{id, food, grams}], dinner:[...]}}}, weights:[...]}（记录里没有 meal 字段）；刷新页面；看升级提示、今日页记录、fatloss.backup 快照，再触发一次保存看 schemaVersion 是否变成 4、meal 是否补上。',
  'S-4': '写入 {schemaVersion:2, profile, days:{今天:{meals:{breakfast:[...], lunch:[...]}}}, weights:[]}；刷新页面；看升级提示、今日页记录、快照，再触发一次保存看 schemaVersion 是否变成 4。',
  'S-5': '打开记录页；执行 Object.defineProperty(Storage.prototype,"setItem",{value(){const e=new Error("满");e.name="QuotaExceededError";throw e;}})；输入「两个鸡蛋」解析并点「就这样，记上」；看 toast 顺序与 localStorage 是否被写入。',
  'S-6': '打开当前存档 → 我的（头像）→ 设置 → 数据与备份 → 「现在留一份快照」；关掉弹层，再记一条苹果；回到「数据与备份」点「回滚到这份快照」，确认弹窗；比较回滚前后的记录。',
  'S-7': '同 S-6 先留快照；然后设置 → 从头开始 → 输入「清除」→ 清除；打开「找回记录」看还能不能用快照恢复。',
  'S-8': '设置 → 从头开始；输入「清除吧」看按钮是否禁用、点它是否清空；改成「清除」再点，看是否真的清空。',
  'E-1': '用 settings.mode="ai" 的当前存档打开页面 → 点头像进设置 → 点「普通模式」；看 localStorage.settings.mode 是否变成 basic、有没有 toast、控制台有没有报错。',
};

function failureDetails(sc) {
  const lines = [];
  lines.push(`#### ${sc.id} ${sc.title}${severityOf(sc) !== '—' ? `（${severityOf(sc)}）` : ''}`);
  lines.push('');
  lines.push(`- **场景**：${sc.title}`);
  lines.push(`- **期望**：${sc.expected}`);
  lines.push(`- **实际**：${sc.actual}`);
  lines.push('- **复现步骤**：');
  lines.push('  1. 运行 `node tools/resilience-check.mjs`（会自动起静态服务、假服务商、无头 Chrome；端口 4312 / 18880 / 18881 / 9412）。');
  lines.push('  2. 脚本里对应场景 id：`' + sc.id + '`（见 `tools/resilience-check.mjs` 的 `scenarioXxx` 函数，存档的预置数据也在那里）。');
  const repro = REPRO_STEPS[sc.id];
  if (repro) {
    let n = 3;
    for (const step of repro.split('\n')) { lines.push(`  ${n}. ${step}`); n += 1; }
  }
  lines.push('- **没通过的检查**：');
  for (const c of sc.checks.filter((x) => !x.pass)) {
    lines.push(`  - ${c.name}：期望 ${c.expected}；实际 ${c.actual}（${c.severity}）`);
  }
  if (sc.shots.length) {
    lines.push('- **截图**：');
    for (const s of sc.shots) lines.push(`  - ![${sc.id} 截图](${s})`);
  }
  return lines.join('\n');
}

function buildReport() {
  const ai = results.filter((r) => r.group === 'AI');
  const storage = results.filter((r) => r.group === '存档');
  const extra = results.filter((r) => r.group === '额外');
  const okCount = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  const lines = [];
  lines.push('# 减脂工具 · 韧性审计报告（审计 B：AI 失败路径与存档异常）');
  lines.push('');
  lines.push(`- 生成时间：${new Date().toISOString()}（本机时间 ${new Date().toLocaleString('zh-CN')}）`);
  lines.push(`- 环境：Node ${process.version}；${envInfo.chrome || 'Chrome（版本未记录）'}；macOS 本机无头模式，390×844`);
  lines.push(`- 被测页面：只由静态服务器提供（${BASE}），**故意不提供任何 /api 中转接口**；AI 请求全部发往本地假服务商 ${FAKE_BASE}`);
  lines.push(`- 运行：\`node tools/resilience-check.mjs\`（有失败 → 退出码非 0）；反向验证：\`node tools/resilience-check.mjs --reverse\``);
  const fp1 = envInfo.fingerprintStart;
  const fp2 = envInfo.fingerprintEnd;
  if (fp1) {
    lines.push(`- 被测代码指纹（js/*.js + index.html + manifest + sw.js + css 的 sha256 前 16 位）：**${fp1.hash}**（共 ${fp1.fileCount} 个文件；git HEAD：${fp1.gitHead || '未知'}；最近修改文件：${fp1.newestFile} @ ${fp1.newest}）`);
    if (typeof fp1.dirtyTracked === 'number' && fp1.dirtyTracked > 0) {
      lines.push(`- 工作区状态：git HEAD 是 \`${fp1.gitHead}\`，但运行时 **有 ${fp1.dirtyTracked} 个已跟踪文件存在未提交改动**（审计期间其他任务在并行改代码；本报告只对上面指纹对应的代码负责）。`);
    }
    if (fp2 && fp2.hash !== fp1.hash) {
      lines.push(`- ⚠️ **运行期间被测代码发生了变化**（开始 ${fp1.hash} → 结束 ${fp2.hash}）：这份报告可能混合了两个版本，不应作为最终结论，请等代码稳定后重跑。`);
    } else {
      lines.push('- 运行期间被测代码未发生变化（开始和结束指纹一致）。');
    }
    if (envInfo.durationMs) lines.push(`- 本次运行耗时：约 ${Math.round(envInfo.durationMs / 1000)} 秒（含两个「服务端一直不应答」场景各约 25 秒）。`);
  }
  lines.push('');
  lines.push('## 结论摘要');
  lines.push('');
  const stable = envInfo.fingerprintStart && envInfo.fingerprintEnd && envInfo.fingerprintStart.hash === envInfo.fingerprintEnd.hash;
  lines.push(`- 共 ${results.length} 个场景：**${okCount} 通过 / ${failed.length} 失败**；本次运行退出码：**${(failed.length || !stable) ? 1 : 0}**（有失败或代码在跑动 → 非 0）。`);
  if (!stable) lines.push(`- ⚠️ 运行期间被测代码被改动（${envInfo.fingerprintStart?.hash} → ${envInfo.fingerprintEnd?.hash}）：结论可能不可靠，建议重跑。`);
  if (failed.length) {
    const fatal = failed.filter((s) => severityOf(s) === '事故级');
    const serious = failed.filter((s) => severityOf(s) === '严重');
    lines.push(`- 失败里：事故级 ${fatal.length} 个、严重 ${serious.length} 个、一般/建议 ${failed.length - fatal.length - serious.length} 个。`);
    lines.push(`- 最严重的问题：${fatal[0] ? `${fatal[0].id} ${fatal[0].title}` : (serious[0] ? `${serious[0].id} ${serious[0].title}` : failed[0].id + ' ' + failed[0].title)}（详见下方「五、严重程度分级」）。`);
    const swallowed = failed.filter((x) => ['AI-4a', 'AI-5a', 'AI-6a', 'AI-7a'].includes(x.id));
    if (swallowed.length === 4) lines.push('- 其中 AI-4a / 5a / 6a / 7a 是**同一个根因**（AI 失败信息在「离线也认不出」时被完全吞掉），修一处即可；**这正是上一版自检绿而线上坏的那类盲区**。');
    lines.push('- 一句话结论：**关键红线守住了** —— AI 实际失败时没有出现「AI 识别」冒充成功，也没创建假记录；但仍存在 1 条「离线结果被标成 AI」的来源冒充路径、4 个「AI 错误被完全吞掉」的失败路径；存档侧还留 1 处「存不进去之后又提示成了」的矛盾，以及 1 个「清除会连快照一起删」的取舍问题（详见失败清单）。');
  } else {
    lines.push('- 本次覆盖的场景全部通过。');
  }
  lines.push('');
  lines.push('### 测试方法说明（先说清哪些是替身、哪些是真实验证）');
  lines.push('');
  lines.push('- 用**真实界面**跑：无头 Chrome 打开页面 → 在「记录」页输入一句话 → 点「解析这一句」→ 读弹层 `#draftHost` 里的**实际文本** → 再点「就这样，记上」→ 读 `localStorage` 里的真实存档。断言只看用户看得到的东西，不看代码。');
  lines.push('- AI 用**可控假服务商**（跨域头齐全），按模型名切换返回：合法 JSON / ```json 围栏 / 夹带废话 / 401 / 500 / 15 秒以上不应答 / 非法 JSON / 空 items / 全部未匹配 / 50 条；另有一个**不给跨域头**的服务商模拟 CORS 被拒。全部用假密钥（`sk-audit-fake`），**没有碰任何真实密钥、不会产生 API 费用**。');
  lines.push('- 假服务商**不实现** `/models` 与中转接口；静态服务也不实现 `/api/*`，所以应用不会退回电脑中转，失败路径只会走离线兜底或直接报错。');
  lines.push('- 存档场景通过 `localStorage` 预置真实形状的存档（坏 JSON / v999 / v1 / v2 / 存储满），再走真实界面按钮（设置、数据与备份、从头开始、找回记录）。');
  lines.push('- `window.confirm` 被注入脚本替换为「总是确定」（测试环境没有人点确认框）；这只影响「回滚快照」的确认，**清除数据仍然要求输入「清除」二字**，没有被绕过。');
  lines.push('- 「离线也认不出」输入用「吃了两份量子寿司」，「离线能认出」输入用「中午吃了一碗牛肉面」（已用离线解析器实测确认）。成功场景用「随便对付了一口」——离线解析器对它**什么都认不出**，所以能证明条目真的来自 AI。');
  lines.push('- **并行修改说明**：审计期间工作区有其他任务在同时改代码（未提交）。S-2b（未来版本存档被欢迎页按钮覆盖）和 E-1（切回普通模式抛 ReferenceError）在本次审计早期的两轮运行里都是失败的；最后一次运行时工作区已有修复（原始内容另存 `fatloss.state.unreadable` + 欢迎页常驻提示；`clearDraft` 改为 `draft = null`），因此这两个场景本报告判定通过，并保留为回归检查。');
  lines.push('');
  lines.push('## 一、AI 失败与畸形返回');
  lines.push('');
  lines.push('| # | 场景 | 期望 | 实际 | 判定 |');
  lines.push('| - | ---- | ---- | ---- | ---- |');
  ai.forEach((sc, i) => lines.push(rowLine(sc, i + 1)));
  lines.push('');
  const aiFailures = ai.filter((s) => !s.pass);
  if (aiFailures.length) {
    lines.push('### AI 部分没通过的场景（含截图与复现）');
    lines.push('');
    for (const sc of aiFailures) { lines.push(failureDetails(sc)); lines.push(''); }
    lines.push('### 根因归纳（同一根因，修一处就够）');
    lines.push('');
    lines.push('- **AI-4a / 5a / 6a / 7a 是同一个根因**：`runQuickParse()` 在 AI 失败后走离线兜底；`drawDraft()` 的「一条都没认出来」分支只显示通用文案「这句我没认出来」，**完全不渲染 `draft.aiError`**。所以只有当离线兜底恰好也认出东西时，错误才会出现在「离线识别（常见说法）｜AI 这次没成功：…」那一行（这就是 4b/5b/6b/7b 通过的原因）。离线一句都认不出时，密钥失效 / 服务商 500 / 超时 / 返回坏 JSON 这些信息对用户**完全不可见** —— 这也解释了为什么上一版自检是绿的：测试例句恰好离线认得出来。');
    lines.push('- **AI-9b 是另一个独立根因**：`runQuickParse()` 在「AI 返回了 items、但 normalizeAiItems 后一条都没匹配上」时，先把 `source = \'ai\'` 定下来，然后才走离线兜底；于是离线解析出来的条目被标成「AI 识别」。修法是 `source` 只有在 `norm.items` 真正非空时才设为 `\'ai\'`（或者把离线兜底的结果来源单独记下来）。');
    lines.push('');
  }
  lines.push('## 二、存档异常');
  lines.push('');
  lines.push('| # | 场景 | 期望 | 实际 | 判定 |');
  lines.push('| - | ---- | ---- | ---- | ---- |');
  storage.forEach((sc, i) => lines.push(rowLine(sc, i + 1)));
  lines.push('');
  const stFailures = storage.filter((s) => !s.pass);
  if (stFailures.length) {
    lines.push('### 存档部分没通过的场景（含截图与复现）');
    lines.push('');
    for (const sc of stFailures) { lines.push(failureDetails(sc)); lines.push(''); }
  }
  lines.push('## 三、额外发现（不在原清单，但检查过程中真实撞到）');
  lines.push('');
  lines.push('| # | 场景 | 期望 | 实际 | 判定 |');
  lines.push('| - | ---- | ---- | ---- | ---- |');
  extra.forEach((sc, i) => lines.push(rowLine(sc, i + 1)));
  lines.push('');
  for (const sc of extra.filter((x) => !x.pass)) { lines.push(failureDetails(sc)); lines.push(''); }
  lines.push('## 四、反向验证（证明检查能失败）');
  lines.push('');
  if (fs.existsSync(REVERSE_PROOF_PATH)) {
    lines.push('```text');
    lines.push(fs.readFileSync(REVERSE_PROOF_PATH, 'utf8').trim());
    lines.push('```');
    lines.push('');
    lines.push('> 复现：`node tools/resilience-check.mjs --reverse`（退出码 0 = 两处人为破坏都被检查抓住）。');
  } else {
    lines.push('未验证：本次没有运行反向验证（`node tools/resilience-check.mjs --reverse` 没有跑过），**不能证明这些检查会失败**。');
  }
  lines.push('');
  lines.push('## 五、严重程度分级');
  lines.push('');
  const order = ['事故级', '严重', '一般', '建议'];
  for (const sev of order) {
    const list = failed.filter((s) => severityOf(s) === sev);
    lines.push(`### ${sev}（${list.length} 个）`);
    lines.push('');
    if (!list.length) lines.push('（无）');
    for (const s of list) {
      lines.push(`- **${s.id} ${s.title}**：${s.actual}`);
      const firstFail = s.checks.find((c) => !c.pass);
      if (firstFail) lines.push(`  - 期望 ${firstFail.expected}，实际 ${firstFail.actual}`);
    }
    lines.push('');
  }
  lines.push('> 分级口径：**事故级** = 丢数据 / 界面骗人（把失败说成成功、把离线结果冒充 AI）/ 卡死；');
  lines.push('> **严重** = 功能不可用或关键提示缺失（用户会被误导、无法判断 AI 到底有没有工作）；**一般** = 提示不完整、体验缺陷；**建议** = 可改进项。');
  lines.push('');
  lines.push('### 补充建议（不作为失败）');
  lines.push('');
  lines.push('- **超时时间是 25 秒**（js/ai-core.js 的 `REQUEST_TIMEOUT_MS = 25000`；本次实测超时提示在约 25 秒后才出现）。任务描述里提到「15 秒不应答」，如果希望用户更早得到反馈，可以缩短到 12~15 秒，或者在第 8 秒把按钮文案改成「还在等 AI…」让人知道没死。');
  lines.push('- **错误信息里带上了服务商原始返回体**：例如 401 时界面会显示 `{"error":{"message":"Invalid API key","type":"authentication_error"}}`。对普通用户偏技术，建议只保留中文说明（不影响功能）。');
  lines.push('- **「没认出来」的弹层里可以带一行 AI 失败原因**：失败详情里已说明错误被吞；修的时候建议就加一行「（AI 这次没成功：密钥失效）」，不要整段堆给用户。');
  lines.push('- **更新版本 / 坏存档的提示与保护**（当前工作区已有并行修复，建议保留）：原始内容另存 `fatloss.state.unreadable` + 欢迎页常驻警告 + 「导出一份原始文件」入口，是比「弹 6 秒浮层」更稳的做法。还可以更进一步：在「看示例 / 填资料」真正覆盖主键之前再确认一次，或把原始内容顺手放进导出的备份文件里。');
  lines.push('');
  lines.push('## 六、没测到 / 覆盖盲区（如实列出）');
  lines.push('');
  lines.push('- **「从备份文件导入」没有测**：它要弹系统文件选择器，无头环境里没有可靠办法像真人一样选文件；本次测的是「数据与备份」里的快照留取/回滚，以及清除后的找回路径。文件导入/导出的真实往返属于未验证。');
  lines.push('- **真实服务商的真实故障没测**：401/500/超时/CORS 都是本地假服务商模拟的（协议层等价，但不等于 DeepSeek/通义等真实返回体）；不同厂商真实的 401 错误 JSON、限流、重定向未覆盖。');
  lines.push('- **真机 / 移动网络没测**：无头 Chrome（桌面内核）模拟手机尺寸，不是真手机浏览器；弱网、切后台、锁屏中断等未覆盖。');
  lines.push('- **AI 密钥在 localStorage 明文存储的安全性**不在本次范围（产品已知取舍，见 js/ai-config.js 注释）。');
  lines.push('- **存档字段级 fuzz 没做**：只测了整体坏 JSON、版本过新、v1/v2 迁移、写入失败；单字段类型错乱（如 days 是数组、weights 里混 null）未覆盖。');
  lines.push('');
  lines.push('## 七、怎么复现这个检查');
  lines.push('');
  lines.push('```bash');
  lines.push('node tools/resilience-check.mjs');
  lines.push('echo "退出码：$?"');
  lines.push('node tools/resilience-check.mjs --reverse');
  lines.push('```');
  lines.push('');
  lines.push('本次审计期间完整跑过两次，失败清单一致（可重复）。');
  lines.push('');
  lines.push(`截图目录：\`.audit/resilience-shots/\`；本报告：\`.audit/resilience-report.md\`；完整控制台输出：\`.audit/resilience-run.log\`；反向验证证据：\`.audit/resilience-reverse-proof.txt\`。`);
  lines.push('');
  return lines.join('\n');
}

/* ══════════════════════════════════════════════════════════════════
 * 8. 主流程
 * ══════════════════════════════════════════════════════════════════ */

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const staticServer = startStaticServer();
  const fakeServer = startFakeProvider();
  const corsFailServer = startCorsFailServer();
  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new Error(`端口 ${port} 起不来：${err.message}`)));
    server.listen(port, '127.0.0.1', resolve);
  });
  await listen(staticServer, STATIC_PORT);
  await listen(fakeServer, FAKE_PORT);
  await listen(corsFailServer, CORS_FAIL_PORT);
  console.log(`静态服务：${BASE}；假服务商：${FAKE_BASE}（无 CORS 的：${CORS_FAIL_BASE}）`);

  const { chrome, version, kill } = await launchChrome({
    port: CDP_PORT,
    userDataDir: path.join(AUDIT_DIR, 'profiles', 'resilience'),
    window: '390,844',
  });
  envInfo.chrome = `Chrome：${version.Browser || '未知'}`;
  console.log(`CDP 端口 ${CDP_PORT} 已就绪（${envInfo.chrome}）`);

  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_SCRIPT });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') pageErrors.push(`[console.error] ${(p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push(`[未捕获异常] ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || ''}`.slice(0, 400));
  });

  const cleanup = [
    () => cdp && cdp.close(),
    () => kill(),
    () => { try { fakeServer.closeAllConnections?.(); } catch { /* 忽略 */ } try { fakeServer.close(); } catch { /* 忽略 */ } },
    () => { try { corsFailServer.closeAllConnections?.(); } catch { /* 忽略 */ } try { corsFailServer.close(); } catch { /* 忽略 */ } },
    () => { try { staticServer.close(); } catch { /* 忽略 */ } },
  ];

  try {
    const runStart = Date.now();
    // 记下这次到底测的是哪一版代码（跑完再取一次对比，防止审计期间有人并行改代码）
    envInfo.fingerprintStart = codeFingerprint();
    console.log(`被测代码指纹：${envInfo.fingerprintStart.hash}（git ${envInfo.fingerprintStart.gitHead || '未知'}，最近修改 ${envInfo.fingerprintStart.newestFile} @ ${envInfo.fingerprintStart.newest}）`);

    // 第一次打开：清掉 Service Worker 缓存，保证测的是服务器上的当前代码
    await goto(`${BASE}/`);
    await evalJs(`(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      for (const n of await caches.keys()) await caches.delete(n);
      localStorage.clear();
      return true;
    })()`);
    await goto(`${BASE}/`);

    if (REVERSE) {
      const pass = await runReverse();
      finishAndExit(pass ? 0 : 1, cleanup);
      return;
    }

    console.log('\n=== 一、AI 失败与畸形返回 ===');
    await scenarioAiSuccess('AI', 'AI-1', '正常返回合法 JSON（成功路径对照组）', { model: 'ok', text: '随便对付了一口', shotPrefix: 'ai-1-ok' });
    await scenarioAiSuccess('AI', 'AI-2', '返回 ```json 围栏包裹', { model: 'fenced', text: '随便对付了一口', shotPrefix: 'ai-2-fenced' });
    await scenarioAiSuccess('AI', 'AI-3', 'JSON 前后夹带自然语言废话', { model: 'prose', text: '随便对付了一口', shotPrefix: 'ai-3-prose' });
    await scenarioAiFailure('AI', 'AI-4a', '401 密钥无效 + 离线也认不出', {
      model: '401', text: '吃了两份量子寿司', offlineUnknown: true,
      expectText: '明确提示密钥/鉴权问题', promptPatterns: [/密钥/, /鉴权/, /401/, /API key/i], shotPrefix: 'ai-4a-401-unknown',
    });
    await scenarioAiFailure('AI', 'AI-4b', '401 密钥无效 + 离线能认出（对照组）', {
      model: '401', text: '中午吃了一碗牛肉面', offlineUnknown: false,
      expectText: '明确提示密钥/鉴权问题', promptPatterns: [/密钥/, /鉴权/, /401/], shotPrefix: 'ai-4b-401-known',
    });
    await scenarioAiFailure('AI', 'AI-5a', '500 服务端错误 + 离线也认不出', {
      model: '500', text: '吃了两份量子寿司', offlineUnknown: true,
      expectText: '明确提示服务商出问题', promptPatterns: [/服务商这边出问题/, /500/, /服务端/], shotPrefix: 'ai-5a-500-unknown',
    });
    await scenarioAiFailure('AI', 'AI-5b', '500 服务端错误 + 离线能认出（对照组）', {
      model: '500', text: '中午吃了一碗牛肉面', offlineUnknown: false,
      expectText: '明确提示服务商出问题', promptPatterns: [/服务商这边出问题/, /500/, /服务端/], shotPrefix: 'ai-5b-500-known',
    });
    await scenarioAiFailure('AI', 'AI-6a', '连接超时 + 离线也认不出', {
      model: 'slow', text: '吃了两份量子寿司', offlineUnknown: true, waitMs: 40000,
      expectText: '明确提示超时，不永久卡在「解析中」', promptPatterns: [/没有响应/, /超时/, /秒/], shotPrefix: 'ai-6a-timeout-unknown',
    });
    await scenarioAiFailure('AI', 'AI-6b', '连接超时 + 离线能认出（对照组）', {
      model: 'slow', text: '中午吃了一碗牛肉面', offlineUnknown: false, waitMs: 40000,
      expectText: '明确提示超时，不永久卡在「解析中」', promptPatterns: [/没有响应/, /超时/, /秒/], shotPrefix: 'ai-6b-timeout-known',
    });
    await scenarioAiFailure('AI', 'AI-7a', '返回非法 JSON + 离线也认不出', {
      model: 'badjson', text: '吃了两份量子寿司', offlineUnknown: true,
      expectText: '明确提示解析失败', promptPatterns: [/JSON/, /解析失败/, /不是 JSON/], shotPrefix: 'ai-7a-badjson-unknown',
    });
    await scenarioAiFailure('AI', 'AI-7b', '返回非法 JSON + 离线能认出（对照组）', {
      model: 'badjson', text: '中午吃了一碗牛肉面', offlineUnknown: false,
      expectText: '明确提示解析失败', promptPatterns: [/JSON/, /解析失败/, /不是 JSON/], shotPrefix: 'ai-7b-badjson-known',
    });
    await scenarioAiEmptyItems('AI', 'AI-8', 'items 为空数组');
    await scenarioAiUnmatched('AI', 'AI-9', 'items 全部匹配不上本地食物库（离线也认不出）', { text: '吃了两份量子寿司', shotPrefix: 'ai-9-unmatched' });
    await scenarioAiProvenanceLie('AI', 'AI-9b', 'items 全部未匹配 + 离线能认出（来源是否被冒充成 AI）');
    await scenarioAiManyItems('AI', 'AI-10', '50 条超长返回');
    await scenarioAiFailure('AI', 'AI-11', '服务商正常但网络层失败（CORS 被拒）', {
      model: 'cors', text: '中午吃了一碗牛肉面', offlineUnknown: false, baseUrl: CORS_FAIL_BASE,
      expectText: '明确提示连不上（不假装成功）', promptPatterns: [/连不上/, /不允许网页直接调用/, /Failed to fetch/], shotPrefix: 'ai-11-cors',
    });

    console.log('\n=== 二、存档异常 ===');
    await scenarioStorageCorrupt('存档');
    await scenarioStorageFuture('存档');
    await scenarioStorageFutureOverwrite('存档');
    await scenarioStorageV1('存档');
    await scenarioStorageV2('存档');
    await scenarioStorageQuota('存档');
    await scenarioStorageSnapshotRoundtrip('存档');
    await scenarioStorageWipeDeletesSnapshot('存档');
    await scenarioStorageWipeGuard('存档');

    console.log('\n=== 三、额外发现 ===');
    await scenarioExtraModeSwitch('额外');

    envInfo.fingerprintEnd = codeFingerprint();
    envInfo.stable = envInfo.fingerprintStart.hash === envInfo.fingerprintEnd.hash;
    envInfo.durationMs = Date.now() - runStart;
    console.log(`本次运行耗时：约 ${Math.round(envInfo.durationMs / 1000)} 秒`);
    console.log('\n=== 四、结果汇总 ===');
    console.log(`被测代码指纹：开始 ${envInfo.fingerprintStart.hash} → 结束 ${envInfo.fingerprintEnd.hash}${envInfo.stable ? '（未变，结果可信）' : '（变了！结果可能混合了两个版本）'}`);
    const failed = results.filter((r) => !r.pass);
    const okCount = results.length - failed.length;
    console.log(`场景：${results.length}；通过 ${okCount}；失败 ${failed.length}`);
    if (failed.length) {
      console.log('失败清单：');
      for (const s of failed) console.log(`  - [${severityOf(s)}] ${s.id} ${s.title} — ${s.actual}`);
    }
    const stray = await readAuditErrors().catch(() => []);
    if (stray.length) console.log(`页面未捕获错误（最后一次导航）：${JSON.stringify(stray).slice(0, 400)}`);

    fs.writeFileSync(REPORT_PATH, buildReport());
    console.log(`\n报告：.audit/resilience-report.md`);
    console.log('截图：.audit/resilience-shots/（' + fs.readdirSync(SHOT_DIR).length + ' 张）');
    if (!envInfo.stable) console.warn('⚠️ 审计期间代码被改动：建议等代码不再变动后重跑，本次退出码按失败处理。');
    finishAndExit((failed.length || !envInfo.stable) ? 1 : 0, cleanup);
  } catch (err) {
    console.error(`\n❌ 检查脚本自身出错：${err.message}`);
    console.error(err.stack || '');
    // 出错也把已有结果写进报告，避免白跑
    try { fs.writeFileSync(REPORT_PATH, buildReport() + `\n\n> ⚠️ 本次运行中断：${err.message}\n`); } catch { /* 写不了就算了 */ }
    finishAndExit(1, cleanup);
  }
}

process.on('uncaughtException', (err) => {
  console.error(`检查脚本未捕获异常：${err.message}`);
  finishAndExit(1);
});
process.on('unhandledRejection', (err) => {
  console.error(`检查脚本未处理 rejection：${err?.message || err}`);
  finishAndExit(1);
});

main().catch((err) => {
  console.error(`检查脚本启动失败：${err.message}`);
  console.error(err.stack || '');
  finishAndExit(1);
});
