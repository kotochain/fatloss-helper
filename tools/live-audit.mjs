/**
 * 线上真实部署审计（之前从来没有过）
 *
 * 为什么需要：`check-live.mjs` 只是 fetch 文本 + grep 字符串，等于「文件传上去了」。
 * 但用户手机上发生的事故（白屏、按钮点不动、拿不到新版）全都是**跑起来以后**才发生的。
 * 所以这个脚本打开 **真正的线上网址**，用干净的浏览器资料夹，像新用户一样点完整个流程。
 *
 * 和本地自检的区别：
 *  - 本地自检测的是「我电脑上的文件」；这个测的是「她从 GitHub Pages 拿到的文件 + 真正的
 *    Service Worker + 真正的 GitHub Pages 响应头」。
 *  - 会真的断网重载，验证「装到主屏幕之后离线能用」这句承诺在线上成立。
 *  - 会用老存档、损坏存档、未来版本存档去撞真实的线上页面，验证不会白屏、不会丢数据。
 *
 * 用法：node tools/live-audit.mjs [网址]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { armWatchdog } from './watchdog.mjs';
import { findChrome } from './chrome-path.mjs';
import { portAlive, freePort } from './chrome-launch.mjs';

const BASE = (process.argv[2] || 'https://kotochain.github.io/fatloss-helper').replace(/\/$/, '');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.audit', 'live');
const profileDir = path.join(outDir, 'chrome-profile');
const CDP_PORT = 9420;
const CHROME = findChrome();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const problems = [];
const warnings = [];
const untested = [];

function pass(msg) { console.log(`✅ ${msg}`); }
function fail(msg) { console.log(`❌ ${msg}`); problems.push(msg); }
function warn(msg) { console.log(`⚠️  ${msg}`); warnings.push(msg); }
function skip(msg) { console.log(`⬜ ${msg}`); untested.push(msg); }

async function freePortAndWait(port) {
  if (!(await portAlive(port))) return;
  freePort(port);
  for (let i = 0; i < 25 && (await portAlive(port)); i++) await sleep(200);
}

async function waitForLive(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/index.html', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) { lastErr = err.message; }
    await sleep(700);
  }
  throw new Error(`线上网址在 ${timeoutMs / 1000} 秒内没响应（${BASE}）：${lastErr}`);
}

async function waitForChromeVersion(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
      lastErr = `HTTP ${res.status}`;
    } catch (err) { lastErr = err.message; }
    await sleep(400);
  }
  throw new Error(`无头 Chrome 没能响应（端口 ${port}）：${lastErr}`);
}

let ERRORS = [];
let CONSOLE_WARNS = [];

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const handlers = new Map();
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const msgId = ++id;
        ws.send(JSON.stringify({ id: msgId, method, params }));
        return new Promise((res, rej) => pending.set(msgId, { res, rej }));
      },
      on(method, handler) { handlers.set(method, handler); },
      close() { try { ws.close(); } catch { /* 已关 */ } },
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
        handlers.get(msg.method)(msg.params);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        ERRORS.push(d.exception?.description || d.text || '(未知异常)');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        // 线上没有 /api 服务，应用探测 AI 状态时的 404 是预期噪音，不算页面错误
        if (/\/api\//.test(text) || /Failed to load resource.*404/.test(text)) return;
        ERRORS.push(text);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'warning') {
        CONSOLE_WARNS.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
  });
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function waitFor(fn, { what = '条件', timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`等不到「${what}」（${timeoutMs / 1000} 秒超时）`);
}

async function shot(client, name) {
  fs.mkdirSync(outDir, { recursive: true });
  const r = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, 'base64'));
}

async function boot(client, { expectReady = true } = {}) {
  await client.send('Page.navigate', { url: BASE + '/' });
  if (!expectReady) { await sleep(2500); return; }
  // 等「真的启动」或「兜底块真的可见」。
  // 以前写的是 #bootFail:not(.hidden)：但兜底块用的是 hidden **属性**，不是 class，
  // 选择器会永远命中 —— 线上网络慢时脚本在模块加载完成前就继续，读到空的 #app，
  // 误判「欢迎页没有入口」。这个假红真踩到过一次。
  await waitFor(() => evaluate(client, `(() => {
    if (window.__appReady === true) return true;
    const box = document.querySelector('#bootFail');
    return !!box && !box.hidden && box.getBoundingClientRect().height > 0;
  })()`), { what: '页面启动（或启动失败兜底出现）' });
  await sleep(400);
}

async function main() {
  console.log(`线上部署审计：${BASE}\n`);
  await waitForLive();
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  await freePortAndWait(CDP_PORT);

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate', '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore' });

  let client;
  try {
    const version = await waitForChromeVersion(CDP_PORT);
    console.log(`浏览器：${version.Browser}\n`);

    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('没有找到可用的页面目标');
    client = await connect(page.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Network.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    console.log('=== 一、新用户从零走完整个流程（真线上） ===');
    ERRORS = [];
    await boot(client);
    const welcome = await evaluate(client, `({
      文字: (document.querySelector('#app')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50),
      引导: !!document.querySelector('[data-act="onboard"]'),
      填资料: !!document.querySelector('[data-act="edit-profile"]'),
      示例: !!document.querySelector('[data-act="demo"]'),
      服务工作者: !!navigator.serviceWorker,
      已受控: !!navigator.serviceWorker.controller,
    })`);
    console.log(`   欢迎页：${welcome.文字}`);
    if (!welcome.引导 || !welcome.填资料) fail(`线上欢迎页缺少入口（引导 ${welcome.引导}／填资料 ${welcome.填资料}）`);
    if (!welcome.服务工作者) fail('线上不是安全上下文或浏览器不支持 Service Worker（离线功能会失效）');
    if (!welcome.已受控) warn('首次打开时页面还没被 Service Worker 接管（正常，第二次打开才有；已继续验证离线）');
    await shot(client, '01-welcome.png');

    // 引导：和真用户一样点
    await evaluate(client, `document.querySelector('[data-act="onboard"]').click()`);
    await sleep(600);
    await evaluate(client, `document.querySelector('#obNext').click()`);
    await waitFor(() => evaluate(client, `!!document.querySelector('#pHeight')`), { what: '填资料表单' });
    await evaluate(client, `(() => {
      const h = document.querySelector('#pHeight'); if (h) { h.value = '163'; h.dispatchEvent(new Event('input',{bubbles:true})); }
      const w = document.querySelector('#pWeight'); if (w) { w.value = '58'; w.dispatchEvent(new Event('input',{bubbles:true})); }
      const a = document.querySelector('#pAge'); if (a) { a.value = '26'; a.dispatchEvent(new Event('input',{bubbles:true})); }
      document.querySelector('#pSave').click();
    })()`);
    await waitFor(() => evaluate(client, `!!document.querySelector('[data-pick]')`), { what: '模式选择' });
    const modes = await evaluate(client, `[...document.querySelectorAll('[data-pick]')].map((e) => e.textContent.trim())`);
    console.log(`   模式选项：${modes.join(' / ')}`);
    if (!modes.some((m) => m.includes('普通模式'))) fail('线上引导里没有普通模式可选');
    await evaluate(client, `document.querySelector('[data-pick="basic"]').click()`);
    await waitFor(() => evaluate(client, `!!document.querySelector('#obGo')`), { what: '引导最后一步' });
    await evaluate(client, `document.querySelector('#obGo').click()`);
    await sleep(1200);
    const ob = await evaluate(client, `(async () => {
      const s = JSON.parse(localStorage.getItem('fatloss.state.v2')||'{}');
      let 目标 = null;
      try { 目标 = (await import('./js/calc.js')).calcTargets(s.profile).targetCalories; } catch (e) { 目标 = '算不出来：' + e.message; }
      return {
        标签: document.querySelector('.tab.active')?.textContent.trim(),
        模式: s.settings?.mode,
        完成: s.settings?.onboarded,
        身高: s.profile?.heightCm, 体重: s.profile?.weightKg, 年龄: s.profile?.age,
        目标,
      };
    })()`);
    console.log(`   引导完成 → 落在「${ob.标签}」，模式 ${ob.模式}，资料 ${ob.身高}cm/${ob.体重}kg/${ob.年龄}岁，目标热量 ${ob.目标} kcal`);
    if (ob.完成 !== true) fail('线上引导走完没有落标记（下次打开会重复引导）');
    if (ob.身高 !== 163 || ob.体重 !== 58 || ob.年龄 !== 26) fail(`线上资料没存对：${ob.身高}cm/${ob.体重}kg/${ob.年龄}岁`);
    // 163cm/58kg/26 岁、轻度活动 → 约 1479 kcal（这是算出来的，不是抄的）
    if (typeof ob.目标 !== 'number' || Math.abs(ob.目标 - 1479) > 60) fail(`线上算出的目标热量不对：${ob.目标} kcal（预期约 1479）`);
    await shot(client, '02-onboarded.png');

    // 记一笔
    await evaluate(client, `document.querySelector('.tab[data-view="log"]').click()`);
    await sleep(400);
    await evaluate(client, `(() => {
      const ta = document.querySelector('#quickText'); if (!ta) return false;
      ta.value = '中午吃了一碗牛肉面，加了个蛋';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#quickParse').click();
      return true;
    })()`);
    await waitFor(() => evaluate(client, `document.querySelectorAll('#draftHost .entry').length ? true : (document.querySelector('#draftHost')?.textContent || '').includes('认出了') ? true : null`), { what: '解析结果' });
    const draft = await evaluate(client, `({
      条数: document.querySelectorAll('#draftHost .entry').length,
      合计: document.querySelector('#draftHost .row.between b')?.textContent || null,
      有记上: !!document.querySelector('#draftSave'),
    })`);
    console.log(`   解析：${draft.条数} 条，合计 ${draft.合计}，有记上按钮 ${draft.有记上}`);
    if (!draft.条数) fail('线上「说一句」解析不出任何条目');
    if (draft.条数 && !draft.有记上) fail('线上解析出条目却没有「记上」按钮');
    if (!draft.条数 && draft.有记上) fail('线上 0 条却允许记上（会留下 0 卡的假记录）');
    if (draft.有记上) {
      await evaluate(client, `document.querySelector('#draftSave').click()`);
      await sleep(600);
      const saved = await evaluate(client, `(() => { const s = JSON.parse(localStorage.getItem('fatloss.state.v2')||'{}'); const d = s.days?.[Object.keys(s.days||{})[0]]; return { 条数: d ? Object.values(d.meals||{}).flat().length : 0, kcal: d ? Object.values(d.meals||{}).flat().reduce((a,e)=>a + (e.food?.kcal||0) * (e.grams||0) / 100, 0) : 0 }; })()`);
      console.log(`   记上后：${saved.条数} 条，约 ${Math.round(saved.kcal)} kcal`);
      if (!saved.条数) fail('线上点了「记上」但存档里没有记录');
      if (saved.条数 && saved.kcal <= 0) fail('线上记上的条目热量为 0');
    }
    await shot(client, '03-logged.png');

    // 重开一次：真用户每天都会做的事
    ERRORS = [];
    await boot(client);
    const reopened = await evaluate(client, `({
      有记录: (() => { try { const s = JSON.parse(localStorage.getItem('fatloss.state.v2')||'{}'); return Object.values(s.days?.[Object.keys(s.days||{})[0]]?.meals||{}).flat().length; } catch { return -1; } })(),
      标签: document.querySelector('.tab.active')?.textContent.trim(),
      首页数字: (document.querySelector('#app')?.textContent || '').replace(/\\s+/g,' ').match(/\\d{3,4}/)?.[0] || null,
    })`);
    console.log(`   重开：落在「${reopened.标签}」，记录 ${reopened.有记录} 条还在，首页数字 ${reopened.首页数字}`);
    if (reopened.有记录 < 1) fail('重开之后记录不见了');
    if (ERRORS.length) fail(`重开时页面报错：${ERRORS.slice(0, 2).join(' | ')}`);
    await shot(client, '04-reopened.png');

    console.log('\n=== 二、线上 Service Worker 与离线承诺 ===');
    const swState = await evaluate(client, `(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      const names = await caches.keys();
      let cached = null;
      for (const n of names) {
        const c = await caches.open(n);
        const keys = await c.keys();
        cached = { 缓存名: n, 条目: keys.length, 有index: keys.some((r) => new URL(r.url).pathname.endsWith('/index.html') || new URL(r.url).pathname.endsWith('/')), 有app: keys.some((r) => r.url.endsWith('/js/app.js')) };
      }
      return { 注册数: regs.length, 受控: !!navigator.serviceWorker.controller, 缓存: cached, 缓存清单: names };
    })()`);
    console.log(`   注册 ${swState.注册数} 个｜当前页面受控 ${swState.受控}｜缓存 ${JSON.stringify(swState.缓存)}`);
    if (!swState.注册数) fail('线上没有注册 Service Worker（离线打不开）');
    if (swState.缓存 && !swState.缓存.有app) fail('线上 Service Worker 缓存里没有 js/app.js（离线会白屏）');

    // 缓存里的 app.js 必须和线上最新一致，否则她会一直跑旧代码
    const cacheFreshness = await evaluate(client, `(async () => {
      const names = await caches.keys();
      for (const n of names) {
        const c = await caches.open(n);
        const hit = await c.match('./js/app.js');
        if (!hit) continue;
        const cached = await hit.text();
        const live = await (await fetch('./js/app.js', { cache: 'no-store' })).text();
        return { 一致: cached === live, 缓存长度: cached.length, 线上长度: live.length, 缓存名: n };
      }
      return null;
    })()`);
    if (!cacheFreshness) skip('缓存里找不到 js/app.js，没法比对缓存新旧');
    else if (!cacheFreshness.一致) warn(`缓存里的 app.js 与线上不一致（缓存 ${cacheFreshness.缓存长度} 字节／线上 ${cacheFreshness.线上长度} 字节）—— 首次升级后第二次打开才会换新，属预期，但需确认能自愈`);
    else pass('缓存里的 js/app.js 与线上最新一致');

    // 真断网重载
    await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    ERRORS = [];
    let offlineOk = false;
    let offlineInfo = null;
    try {
      await client.send('Page.navigate', { url: BASE + '/' });
      await waitFor(() => evaluate(client, `window.__appReady === true`), { what: '断网后页面启动', timeoutMs: 15000 });
      offlineOk = true;
      offlineInfo = await evaluate(client, `({
        记录: (() => { try { const s = JSON.parse(localStorage.getItem('fatloss.state.v2')||'{}'); return Object.values(s.days?.[Object.keys(s.days||{})[0]]?.meals||{}).flat().length; } catch { return -1; } })(),
        文字长度: (document.querySelector('#app')?.textContent || '').trim().length,
      })`);
      console.log(`   断网重载：启动成功，界面有 ${offlineInfo.文字长度} 字，记录 ${offlineInfo.记录} 条`);
      if (offlineInfo.记录 < 1) fail('断网后记录读不出来');
      await shot(client, '05-offline.png');
    } catch (err) {
      console.log(`   断网重载失败：${err.message}`);
      await shot(client, '05-offline-failed.png');
    }
    if (!offlineOk) fail('线上版本断网重载打不开（「装到主屏幕离线用」这句承诺不成立）');
    await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    console.log('\n=== 三、线上版本遇到各种存档（真部署上撞） ===');
    /*
     * 期望值是按「设计意图」写的，不是按「现在跑出什么」写的：
     *  - 老存档：能打开、记录还在（回到欢迎页补资料是可以接受的，但不能丢记录）
     *  - 坏 JSON / 未来版本：能打开、有明确提示、原始内容被留存一份（不再静默覆盖）
     */
    const cases = [
      {
        name: '老存档（v1 形状：有记录、没资料）',
        seed: JSON.stringify({ version: 1, days: { '2026-10-10': { meals: { lunch: [{ id: 'e1', food: { id: 'rice_cooked', name: '米饭（熟）', kcal: 116, protein: 2.6, fat: 0.3, carb: 25.9 }, grams: 200 }] }, exercises: [] } }, weights: [{ date: '2026-10-10', kg: 58 }], customFoods: [] }),
        expect: (r) => r.启动 && r.可操作 && r.记录天数 >= 1,
        detail: '必须能打开、记录不能丢',
      },
      {
        name: '资料残缺（缺体重字段）',
        seed: JSON.stringify({ schemaVersion: 4, profile: { sex: 'female', heightCm: 163, age: 26 }, settings: { onboarded: true, mode: 'basic' }, days: { '2026-10-10': { meals: { lunch: [{ id: 'e1', food: { id: 'rice_cooked', name: '米饭', kcal: 116 }, grams: 200 }] } } } }),
        expect: (r) => r.启动 && r.不崩溃 && r.可操作 && r.记录天数 >= 1,
        detail: '不能让今天页崩，应提示补资料且记录还在',
      },
      {
        name: '存档是坏的 JSON',
        seed: '{oops',
        expect: (r) => r.启动 && r.可操作 && r.有提示,
        detail: '应打开并明确提示，不能白屏',
      },
      {
        name: '存档来自更新版本（schemaVersion 999）',
        seed: JSON.stringify({ schemaVersion: 999, days: { '2026-10-10': { meals: { lunch: [{ id: 'e3', food: { id: 'rice_cooked', name: '米饭', kcal: 116 }, grams: 200 }] } } }, profile: { sex: 'female', heightCm: 163, weightKg: 58, age: 26 } }),
        expect: (r) => r.启动 && r.可操作 && r.有提示 && !r.被覆盖,
        detail: '应拒绝读取、明确提示，且不能覆盖原存档',
      },
    ];
    for (const c of cases) {
      await evaluate(client, `(() => { localStorage.clear(); localStorage.setItem('fatloss.state.v2', ${JSON.stringify(c.seed)}); return true; })()`);
      ERRORS = [];
      await boot(client, { expectReady: false });
      // 启动提示是 600ms 后才弹的（见 app.js 末尾），等它出来再判
      await sleep(1000);
      // 浮层只活 6 秒，重新打开一次并盯着它出现
      const r = await evaluate(client, `(() => {
        const rawAfter = localStorage.getItem('fatloss.state.v2') || '';
        const dayKeys = (() => { try { const s = JSON.parse(rawAfter || '{}'); return Object.keys(s.days || {}); } catch { return []; } })();
        const firstDay = (() => { try { const s = JSON.parse(rawAfter || '{}'); const k = Object.keys(s.days || {})[0]; return k ? s.days[k] : null; } catch { return null; } })();
        const 条数 = firstDay ? Object.values(firstDay.meals || firstDay).flat().filter((e) => e && e.food).length : 0;
        // renderCrash 是写进 #app 的，页面里没有 #crashRoot 这个元素（旧选择器永远为假）
        const 崩溃页 = /这一页出了点问题/.test(document.querySelector('#app')?.textContent || '');
        return {
          启动: window.__appReady === true,
          崩溃页,
          不崩溃: !崩溃页,
          可操作: document.querySelectorAll('#app button, #app [data-act]').length > 0,
          提示文字: document.querySelector('.celebrate-title')?.textContent || null,
          欢迎页有提示条: !!(document.querySelector('#app .card')?.textContent || '').includes('没读出来'),
          引导标记: (() => { try { return JSON.parse(rawAfter || '{}').settings?.onboarded; } catch { return null; } })(),
          记录天数: dayKeys.length,
          条数,
          被覆盖: rawAfter !== ${JSON.stringify(c.seed)},
          留存原样: !!localStorage.getItem('fatloss.state.unreadable'),
        };
      })()`);
      r.有提示 = !!r.提示文字 || r.欢迎页有提示条;
      const ok = c.expect(r);
      console.log(`${ok ? '✅' : '❌'} ${c.name}：启动 ${r.启动}｜崩溃页 ${r.崩溃页}｜入口 ${r.可操作}｜记录 ${r.记录天数} 天/${r.条数} 条｜提示「${r.提示文字 || (r.欢迎页有提示条 ? '欢迎页提示条' : '')}」｜留存 ${r.留存原样}｜${c.detail}`);
      if (!ok) {
        fail(`线上遇到「${c.name}」表现不对（${c.detail}）｜实际 ${JSON.stringify(r)}`);
        await shot(client, `06-state-${c.name.replace(/[^\w\u4e00-\u9fa5]/g, '_')}.png`);
      }
      // 坏 JSON / 未来版本：原始内容必须留一份，否则她点一次「看例子」就真没了
      if ((c.name.includes('坏的') || c.name.includes('更新版本')) && !r.留存原样) {
        fail(`「${c.name}」没有把原始内容留存一份 —— 点「看一个填好的例子」就会永久覆盖`);
      }
      if (ERRORS.length) fail(`「${c.name}」触发了页面报错：${ERRORS[0].slice(0, 140)}`);
    }

    console.log('\n=== 四、数据安全：导出 → 导入 往返（这是唯一的跨设备/救援通道） ===');
    await evaluate(client, `(() => { localStorage.clear(); return true; })()`);
    await boot(client);
    // 先造一份有内容的存档：示例数据 + 一笔吃的
    await evaluate(client, `document.querySelector('[data-act="demo"]')?.click()`);
    await sleep(1200);
    const measureState = `(() => { const s = JSON.parse(localStorage.getItem('fatloss.state.v2')||'{}'); const days = Object.entries(s.days||{}); const 有内容的天 = days.filter(([, d]) => Object.values(d.meals||{}).flat().some((e) => e && e.food) || (d.exercises||[]).length || String(d.note||'').trim()).length; const 条数 = days.reduce((a,[,d]) => a + Object.values(d.meals||{}).flat().filter((e) => e && e.food).length, 0); return { 天数: days.length, 有内容的天, 条数, 体重记录: (s.weights||[]).length }; })()`;
    const beforeExport = await evaluate(client, measureState);
    console.log(`   导出前：${beforeExport.有内容的天} 天有内容（存档里共 ${beforeExport.天数} 个日期）/ ${beforeExport.条数} 条 / 体重 ${beforeExport.体重记录} 条`);
    if (beforeExport.有内容的天 !== 1) fail(`示例数据应当只有 1 天有内容，实际 ${beforeExport.有内容的天} 天`);
    if (beforeExport.天数 > 2) fail(`只看了一眼页面，存档里就多出 ${beforeExport.天数} 个日期（空日子被写进存档）`);
    fs.mkdirSync(path.join(outDir, 'downloads'), { recursive: true });
    // 下载目录用浏览器级命令设置（Page.setDownloadBehavior 在新版 Chrome 已经不生效了，
    // 表现是文件落到系统「下载」里，检查却报「没生成文件」——被这个假红骗过一次）
    const dlDir = path.join(outDir, 'downloads');
    try {
      await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });
    } catch {
      await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    }
    await evaluate(client, `document.querySelector('.tab[data-view="progress"]')?.click()`);
    await sleep(500);
    const exportUi = await evaluate(client, `({ 有导出按钮: !!document.querySelector('[data-act="export"]'), 标签: document.querySelector('.tab.active')?.textContent.trim() })`);
    if (!exportUi.有导出按钮) fail(`「${exportUi.标签}」页找不到导出按钮`);
    await evaluate(client, `document.querySelector('[data-act="export"]')?.click()`);
    await sleep(400);
    const exportToast = await evaluate(client, `document.querySelector('.toast')?.textContent || null`);
    console.log(`   点导出 → 提示「${exportToast}」`);
    let exported = null;
    for (let i = 0; i < 40; i++) {
      const files = fs.readdirSync(path.join(outDir, 'downloads')).filter((f) => f.endsWith('.json'));
      if (files.length) { exported = path.join(outDir, 'downloads', files[0]); break; }
      await sleep(250);
    }
    if (!exported) {
      fail('线上点「导出」没有生成文件（换设备时就没有任何办法带走记录）');
    } else {
      const text = fs.readFileSync(exported, 'utf8');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* 下面判 */ }
      const okShape = parsed && parsed.days && Object.keys(parsed.days).length >= 1 && parsed.profile;
      console.log(`   导出文件：${path.basename(exported)}，${text.length} 字节，结构 ${okShape ? '正常' : '不对'}`);
      if (!okShape) fail('线上导出的文件结构不对（不是能再导入的存档）');
      // 把导出的文件原样导回去，记录数必须一致
      await evaluate(client, `(() => {
        window.confirm = () => true;
        // 导入用的是「临时建一个 input type=file 再点它」，无头浏览器里会卡在文件选择框。
        // 这里把文件输入拦住并挂到页面上，等一下用 CDP 把真实文件塞进去 —— 走的还是应用自己的代码。
        const origCreate = document.createElement.bind(document);
        document.createElement = function (tag, ...rest) {
          const el = origCreate(tag, ...rest);
          if (String(tag).toLowerCase() === 'input') {
            window.__fileInput = el;
            document.body.appendChild(el);
          }
          return el;
        };
        const origClick = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function (...args) {
          if (this.type === 'file') return;   // 别真弹选择框
          return origClick.apply(this, args);
        };
        return true;
      })()`);
      await evaluate(client, `document.querySelector('.tab[data-view="progress"]')?.click()`);
      await sleep(400);
      await evaluate(client, `document.querySelector('[data-act="import"]')?.click()`);
      await sleep(400);
      const inputOk = await evaluate(client, `!!window.__fileInput`);
      if (!inputOk) {
        fail('线上点「导入存档」没有创建文件选择框（导入功能可能已经坏了）');
      } else {
        // 用 CDP 把文件塞进 input（比伪造 FileList 更接近真实流程）
        let injected = false;
        try {
          const doc = await client.send('DOM.getDocument', { depth: -1 });
          const nodeIds = [];
          const walk = (n) => {
            if (n.nodeName === 'INPUT') nodeIds.push(n.nodeId);
            for (const c of n.children || []) walk(c);
          };
          walk(doc.root);
          for (const nodeId of nodeIds) {
            try {
              await client.send('DOM.setFileInputFiles', { nodeId, files: [exported] });
              injected = true;
              break;
            } catch { /* 不是文件输入就跳过 */ }
          }
        } catch (err) {
          console.log(`   塞文件进导入框失败：${err.message}`);
        }
        if (!injected) {
          skip('导出文件拿到了，但没能把文件塞回导入框（导入流程未验证）');
        } else {
          await evaluate(client, `window.__fileInput.dispatchEvent(new Event('change'))`);
          await sleep(1200);
          const afterImport = await evaluate(client, measureState);
          const same = afterImport.有内容的天 === beforeExport.有内容的天 && afterImport.条数 === beforeExport.条数 && afterImport.体重记录 === beforeExport.体重记录;
          console.log(`   导入回来：${afterImport.有内容的天} 天有内容 / ${afterImport.条数} 条 / 体重 ${afterImport.体重记录} 条 → ${same ? '与原记录一致' : '不一致'}`);
          if (!same) fail(`导出再导入后记录变了：导出前 ${JSON.stringify(beforeExport)}，导入后 ${JSON.stringify(afterImport)}`);
          else pass('导出 → 导入往返，记录一条没少');
        }
      }
    }

    // 「数据与备份」里的「X 天的记录」必须是真数（曾经会把空日子也算进去）
    await evaluate(client, `document.querySelector('#profileBtn')?.click()`);
    await sleep(600);
    await evaluate(client, `document.querySelector('[data-set="backup"]')?.click()`);
    await sleep(600);
    const backupInfo = await evaluate(client, `({
      标题: document.querySelector('#sheetTitle')?.textContent || null,
      文字: (document.querySelector('#sheetRoot')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
    })`);
    await evaluate(client, `document.querySelector('#sheetClose')?.click()`);
    await sleep(300);
    const claimed = (backupInfo.文字.match(/(\d+)\s*天的记录/) || [])[1];
    if (claimed === undefined) console.log(`   （备份弹层没读到数字：标题「${backupInfo.标题}」文字「${backupInfo.文字.slice(0, 90)}」）`);
    console.log(`   「数据与备份」写着：${claimed ?? '(没读到)'} 天的记录（实际 ${beforeExport.有内容的天} 天有内容）`);
    if (claimed !== undefined && Number(claimed) !== beforeExport.有内容的天) {
      fail(`「数据与备份」写「${claimed} 天的记录」，但实际只有 ${beforeExport.有内容的天} 天有内容`);
    }

    console.log('\n=== 五、装到桌面（manifest / 图标 / 主题色） ===');
    const manifest = await evaluate(client, `(async () => {
      const m = await (await fetch('./manifest.webmanifest', { cache: 'no-store' })).json();
      const icons = [];
      for (const ic of m.icons || []) {
        const res = await fetch('./' + ic.src, { cache: 'no-store' });
        icons.push({ src: ic.src, status: res.status });
      }
      // 取图标中心的颜色，确认不是第一版留下的绿色
      const probe = async (src) => {
        const img = new Image();
        img.src = './' + src;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        // 取左上角内部（背景色块）而不是中心（那里是白字/白环）
        const d = ctx.getImageData(Math.round(img.width * 0.08), Math.round(img.height * 0.5), 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      return {
        主题色: m.theme_color, 背景色: m.background_color, 图标: icons,
        图标颜色: await probe('icons/icon-192.png'),
        页面主题色: document.querySelector('meta[name="theme-color"]')?.content || null,
        start_url状态: (await fetch('./' + (m.start_url || 'index.html'), { cache: 'no-store' })).status,
        可安装: !!document.querySelector('link[rel="manifest"]'),
      };
    })()`);
    const rgb = manifest.图标颜色 || [0, 0, 0];
    const looksGreen = rgb[1] > rgb[0] + 20 && rgb[1] > rgb[2] + 20;
    console.log(`   manifest：主题色 ${manifest.主题色}｜背景色 ${manifest.背景色}｜页面 theme-color ${manifest.页面主题色}`);
    console.log(`   图标：${manifest.图标.map((i) => `${i.src} HTTP ${i.status}`).join('，')}`);
    console.log(`   桌面图标底色 rgb(${rgb.join(',')})${looksGreen ? '（偏绿）' : ''}｜start_url HTTP ${manifest.start_url状态}`);
    if (manifest.图标.some((i) => i.status !== 200)) fail('manifest 里有图标取不到（装到桌面会没有图标）');
    if (manifest.start_url状态 !== 200) fail('manifest 的 start_url 打不开（从桌面启动会 404）');
    if (!manifest.可安装) fail('页面没有引用 manifest');
    if (looksGreen) fail(`桌面图标还是绿色 rgb(${rgb.join(',')}) —— 界面是温暖米粉配色，图标没跟上`);
    if (manifest.页面主题色 !== manifest.主题色) fail(`页面 theme-color(${manifest.页面主题色}) 与 manifest(${manifest.主题色}) 不一致`);

    console.log('\n=== 六、启动失败兜底（模块加载不起来时，她还能看到什么） ===');
    /*
     * 这条守的是最坏情况：js/app.js 没下载下来 / 语法炸了 / 被拦截。
     * index.html 里那段内联脚本会负责显示 #bootFail —— 但前提是这个元素真的存在。
     * 之前 index.html 里根本没有它：所有兜底静默失效，页面就是纯白，正是用户报过的「白屏」。
     */
    await client.send('Network.setBypassServiceWorker', { bypass: true });
    await client.send('Network.setBlockedURLs', { urls: ['*/js/app.js*', '*js/app.js*'] });
    ERRORS = [];
    await client.send('Page.navigate', { url: BASE + '/?bootfail=' + Date.now() });
    await sleep(6000); // 内联脚本 4 秒后兜底显示
    const bootFail = await evaluate(client, `(() => {
      const box = document.querySelector('#bootFail');
      const r = box?.getBoundingClientRect();
      return {
        元素存在: !!box,
        可见: !!box && !box.hidden && r.width > 0,
        文字: (box?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
        有刷新按钮: !!document.querySelector('#bootFail button'),
        页面空白: (document.body?.innerText || '').trim().length < 5,
      };
    })()`);
    console.log(`   屏蔽 js/app.js 后：#bootFail 存在 ${bootFail.元素存在}｜可见 ${bootFail.可见}｜「${bootFail.文字}」｜刷新按钮 ${bootFail.有刷新按钮}｜整页空白 ${bootFail.页面空白}`);
    if (!bootFail.元素存在) fail('index.html 里没有 #bootFail 元素 —— 启动失败时页面就是纯白，没有任何提示');
    else if (!bootFail.可见 || !bootFail.有刷新按钮) fail('启动失败兜底没有显示出来（她只会看到白屏）');
    await shot(client, '07-bootfail.png');
    await client.send('Network.setBlockedURLs', { urls: [] });
    await client.send('Network.setBypassServiceWorker', { bypass: false });
    await boot(client);
    const recovered = await evaluate(client, `window.__appReady === true && (document.querySelector('#app')?.textContent || '').trim().length > 10`);
    console.log(`   解除屏蔽后重新打开：${recovered ? '正常启动' : '仍然打不开'}`);
    if (!recovered) fail('启动失败兜底出现后，正常加载也无法恢复');

    console.log('\n=== 七、全程控制台 ===');
    if (ERRORS.length) {
      const uniq = [...new Set(ERRORS)];
      fail(`运行期间有 ${uniq.length} 类未捕获错误：`);
      for (const e of uniq.slice(0, 8)) console.log(`   · ${String(e).replace(/\n/g, ' ').slice(0, 160)}`);
    } else {
      pass('全程没有未捕获异常');
    }
    if (CONSOLE_WARNS.length) warn(`控制台有 ${CONSOLE_WARNS.length} 条警告：${CONSOLE_WARNS[0].slice(0, 100)}`);
  } finally {
    try { client?.close(); } catch { /* 已关 */ }
    try { chrome.kill('SIGKILL'); } catch { /* 已退 */ }
  }

  console.log('\n=== 汇总 ===');
  if (warnings.length) { console.log(`提醒 ${warnings.length} 条：`); for (const w of warnings) console.log(`   ⚠️  ${w}`); }
  if (untested.length) { console.log(`没测到 ${untested.length} 条：`); for (const u of untested) console.log(`   ⬜ ${u}`); }
  if (problems.length) {
    console.log(`\n❌ 发现 ${problems.length} 个问题：`);
    for (const p of problems) console.log(`   · ${p}`);
    console.log(`\n截图在 ${path.relative(root, outDir)}/`);
  } else {
    console.log('\n✅ 线上真实部署：整个使用流程走通，没有发现阻断性问题');
  }
  finishAndExit(problems.length ? 1 : 0);
}

function finishAndExit(code) {
  // 显式退出：无头浏览器和 WebSocket 会让事件循环不空，不退出会被看门狗杀掉、退出码还变成非零
  process.exit(code);
}

armWatchdog('线上部署审计', 6 * 60);
main().catch((err) => {
  console.error('\n❌ 审计脚本自己崩了：', err.message);
  finishAndExit(1);
});
