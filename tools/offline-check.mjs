/**
 * 离线可用性自检：装到手机主屏幕之后，没网也必须能打开。
 * 做法：注册 Service Worker → 断网 → 重新加载 → 确认界面仍然渲染出来。
 *
 * 用法：先 `node tools/serve.mjs 4173`，再 `node tools/offline-check.mjs`
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.selfcheck');
const CHROME = findChrome();
const PORT = 9334;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到条件成立或超时，避免「睡固定秒数」在慢机器上误判 */
async function waitFor(fn, { timeout = 15000, interval = 400, what = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) { last = err.message; }
    await sleep(interval);
  }
  throw new Error(`等待「${what}」超时，最后的状态：${JSON.stringify(last)}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const msgId = ++id;
        ws.send(JSON.stringify({ id: msgId, method, params }));
        return new Promise((res, rej) => pending.set(msgId, { res, rej }));
      },
      close: () => ws.close(),
    }));
    ws.addEventListener('error', reject);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
  });
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} 超时（${ms}ms）`)), ms)),
  ]);
}

async function evaluate(client, expression, what = '执行脚本') {
  const r = await withTimeout(
    client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    15000, what,
  );
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(outDir, 'chrome-offline')}`,
    '--window-size=390,844', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); }
  }
  if (!version) throw new Error('无头 Chrome 没起来');

  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const client = await connect(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  console.log('第 1 步：联网打开，让 Service Worker 把资源缓存下来');
  await withTimeout(client.send('Page.navigate', { url: BASE + '/' }), 15000, '联网打开页面');
  // 等页面真的落到我们要的源上（否则 localStorage 会以安全理由被拒绝）
  await waitFor(
    () => evaluate(client, `location.origin === ${JSON.stringify(new URL(BASE).origin)} ? location.href : null`, '检查当前地址'),
    { what: '页面落到预览地址', timeout: 20000 },
  );
  // 等 Service Worker 注册并激活
  await waitFor(
    () => evaluate(client, `navigator.serviceWorker.getRegistration().then((r) => (r && (r.active || r.installing || r.waiting)) ? (r.active || r.installing || r.waiting).state : null)`, '检查 SW 状态'),
    { what: 'Service Worker 激活', timeout: 20000 },
  );

  const swState = await evaluate(client, `(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return { registered: false };
    const active = reg.active || reg.installing || reg.waiting;
    if (active && active.state !== 'activated') {
      await new Promise((res) => { active.addEventListener('statechange', () => active.state === 'activated' && res()); setTimeout(res, 4000); });
    }
    const names = await caches.keys();
    const cache = await caches.open(names[0]);
    const keys = await cache.keys();
    return { registered: true, state: active?.state, cacheNames: names, cachedCount: keys.length, cached: keys.map((r) => new URL(r.url).pathname).slice(0, 20) };
  })()`);
  console.log('  Service Worker：', JSON.stringify(swState, null, 0));

  // 先写入一条记录，稍后确认离线状态下数据还在
  await evaluate(client, `(async () => {
    const mod = await import('./js/store.js');
    const st = mod.emptyState();
    st.profile = mod.demoProfile();
    localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
  })()`);
  await sleep(300);

  console.log('第 2 步：切断网络，重新打开');
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  // 断网后导航不会返回「加载完成」，所以不等导航结果，只等页面渲染出来
  client.send('Page.navigate', { url: BASE + '/' }).catch(() => {});
  await waitFor(
    () => evaluate(client, `document.querySelectorAll('#app .card').length > 0 ? document.querySelectorAll('#app .card').length : null`, '检查离线渲染'),
    { what: '断网后界面渲染出来', timeout: 20000 },
  );

  const offline = await evaluate(client, `(() => ({
    appReady: window.__appReady === true,
    title: document.title,
    cards: document.querySelectorAll('#app .card').length,
    tabs: document.querySelectorAll('.tabbar .tab').length,
    text: (document.querySelector('#app')?.textContent || '').trim().slice(0, 40),
    hasData: !!localStorage.getItem('fatloss.state.v2'),
    controller: !!navigator.serviceWorker.controller,
  }))()`);
  console.log('  断网后页面：', JSON.stringify(offline, null, 0));

  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-offline.png'), Buffer.from(shot.data, 'base64'));

  const ok = swState.registered && swState.state === 'activated' && swState.cachedCount >= 10
    && offline.appReady && offline.cards > 0 && offline.tabs === 4 && offline.hasData;
  console.log(ok
    ? `\n✅ 离线可用：缓存了 ${swState.cachedCount} 个文件，断网后仍渲染出 ${offline.cards} 个卡片，本地数据还在`
    : '\n❌ 离线不可用，看上面的数据');
  console.log(`截图：${path.join(outDir, 'shot-offline.png')}`);
  chrome.kill();
  if (!ok) process.exitCode = 1;
}

main().catch((err) => { console.error('离线自检失败：', err.message); process.exitCode = 1; });
