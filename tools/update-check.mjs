/**
 * 更新提示自检（v45，真事故回归）。
 *
 * 要守住的一件事：**打开网页是旧版时，用户必须立刻看到「有新版本」的提示**，
 * 而不是「看到旧界面 → 没有任何提示 → 自己手动刷新才好」。
 *
 * 为什么以前会没提示：
 *  1) Service Worker 是「先用缓存 + 后台更新」，所以打开时页面本来就是旧版（PWA 常态）；
 *  2) 线上 sw.js 带 `cache-control: max-age=600`，前面还有 CDN。
 *     app.js 里的 `cache: 'no-store'` 只绕浏览器缓存、**绕不过 CDN** ——
 *     读回来的是旧版本号，一比「已是最新」，提示永远不出现。
 *
 * 现在 index.html 里有一段内联脚本：页面一解析就 fetch(`sw.js?ts=…`) 拿线上版本，
 * 和页面自己的版本比，不一样就把顶部横幅亮出来；点横幅清代码缓存 + 重载（不碰 localStorage）。
 *
 * 做法：整个项目复制到临时目录再折腾（不在真实仓库里改版本号）——
 * 起服务 → 让浏览器缓存当前版本 → 把副本的版本号改成 v99 模拟发版 →
 * 同一个浏览器新开页面 → 断言横幅立刻出现、点完真的换成新版。
 *
 * 用法：node tools/update-check.mjs（自己起服务，不需要先跑 serve）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome-path.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4189;
const CDP = 9445;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const problems = [];
const ok = (msg) => console.log(`✅ ${msg}`);
const bad = (msg) => { problems.push(msg); console.log(`❌ ${msg}`); };

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

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function waitFor(fn, what, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (err) { last = err.message; }
    await sleep(300);
  }
  throw new Error(`等待「${what}」超时：${JSON.stringify(last)}`);
}

/** 采集这一页的「实际版本 + 有没有横幅」 */
function probe(client) {
  return evaluate(client, `(async () => {
    const { APP_VERSION } = await import('./js/version.js');
    const bar = document.getElementById('verBar');
    return {
      版本: APP_VERSION,
      横幅: bar ? getComputedStyle(bar).display !== 'none' : false,
      横幅文字: document.getElementById('verBarText')?.textContent.trim() || '',
      缓存: await caches.keys(),
    };
  })()`);
}

async function newPage() {
  const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  const client = await connect(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  return client;
}

async function main() {
  // 复制到临时目录再折腾：真实仓库一个字节都不改
  // realpathSync 不能省：macOS 上 /var 是 /private/var 的符号链接。
  // 传绝对路径给 serve.mjs 时，它自己的 isMain 判断（path.resolve(argv[1]) === fileURLToPath）
  // 会失败 → 进程立刻以 0 退出、什么都不打印，看起来像「服务起不来」。
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fatloss-update-')));
  // package.json 不能漏：里面有 "type": "module"，少了它沙箱里的 .mjs 会被当成 CommonJS
  for (const entry of ['index.html', 'sw.js', 'manifest.webmanifest', 'package.json', 'js', 'css', 'icons', 'tools']) {
    fs.cpSync(path.join(ROOT, entry), path.join(sandbox, entry), { recursive: true });
  }
  const cur = (fs.readFileSync(path.join(sandbox, 'js', 'version.js'), 'utf8').match(/APP_VERSION = '(v\d+)'/) || [])[1];
  if (!cur) throw new Error('沙箱里读不到当前版本号');

  const server = spawn(process.execPath, [path.join(sandbox, 'tools', 'serve.mjs'), String(PORT)], { cwd: sandbox, stdio: 'ignore' });
  server.on('exit', (code) => { if (code && code !== 0) console.error(`本地服务退出，退出码 ${code}`); });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fatloss-update-profile-'));
  const chrome = spawn(findChrome(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    '--window-size=390,844', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitFor(async () => (await fetch(BASE + '/', { signal: AbortSignal.timeout(3000) })).ok, '本地服务', 20000);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok, '调试端口', 40000);

    // 第 1 次打开：让 Service Worker 把当前版本缓存下来
    const first = await newPage();
    await first.send('Page.navigate', { url: BASE + '/' });
    await waitFor(() => evaluate(first, 'window.__appReady === true'), '第一次启动', 40000);
    await waitFor(() => evaluate(first, `navigator.serviceWorker.getRegistration().then((r) => Boolean(r && (r.active || r.installing || r.waiting)))`), 'Service Worker 注册');
    await sleep(2500);
    const before = await probe(first);
    if (before.版本 !== cur) bad(`第一次打开跑的不是当前版本：${before.版本}（应为 ${cur}）`);
    if (before.横幅) bad('第一次打开就有更新横幅（版本没变却提示，会天天误报）');
    ok(`第一次打开：缓存 ${cur}，没有横幅`);
    await first.send('Page.close').catch(() => {});
    await sleep(400);

    // 模拟「线上发了新版」：只改沙箱里的版本号
    const bump = (file, from, to) => {
      const p = path.join(sandbox, file);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(from, to));
    };
    bump('sw.js', `const CACHE = 'fatloss-${cur}'`, "const CACHE = 'fatloss-v99'");
    bump('sw.js', `const APP_VERSION = '${cur}'`, "const APP_VERSION = 'v99'");
    bump('js/version.js', `APP_VERSION = '${cur}'`, "APP_VERSION = 'v99'");
    bump('index.html', `var HERE = '${cur}'`, "var HERE = 'v99'");
    console.log(`\n   模拟发版：${cur} → v99（只改了临时副本）\n`);

    // 第 2 次打开：同一个浏览器、不清缓存 —— 就是用户「新开一个网页」
    const second = await newPage();
    await second.send('Page.navigate', { url: BASE + '/' });
    await waitFor(() => evaluate(second, 'window.__appReady === true'), '第二次启动', 40000);
    const justOpened = await probe(second);
    if (justOpened.版本 !== cur) bad(`第二次打开本应是缓存的旧版 ${cur}，实际 ${justOpened.版本}（这个自检就失去意义了）`);
    if (!justOpened.横幅) bad('打开旧版却没有更新横幅（用户看到旧界面、什么提示都没有 —— v45 修的就是这个）');
    else ok(`打开旧版（${cur}）时横幅立刻出现：「${justOpened.横幅文字}」`);
    if (!/有新版本/.test(justOpened.横幅文字)) bad(`横幅文案没说「有新版本」：${justOpened.横幅文字}`);
    if (!/记录不会丢/.test(justOpened.横幅文字)) bad(`横幅文案没说「记录不会丢」（用户不敢点）：${justOpened.横幅文字}`);

    // 点横幅：应该清掉旧缓存并重载成新版
    await evaluate(second, `document.getElementById('verBar').click()`).catch(() => {});
    await sleep(2200);
    let after = null;
    try {
      await waitFor(() => evaluate(second, 'window.__appReady === true'), '点击后重新启动', 30000);
      after = await probe(second);
    } catch (err) {
      bad(`点横幅之后页面没起来：${err.message}`);
    }
    if (after) {
      if (after.版本 === 'v99') ok('点横幅之后变成新版 v99');
      else bad(`点横幅之后还是 ${after.版本}（应当是新版 v99）`);
      if (after.横幅) bad('更新完横幅还挂着（用户会以为没生效）');
    }
  } finally {
    try { chrome.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { server.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log('\n════════ 结论 ════════');
  if (problems.length) {
    for (const p of problems) console.log(`❌ ${p}`);
    process.exit(1);
  }
  console.log('✅ 旧版打开会立刻提示更新，点一下就换成新版，记录不受影响');
  process.exit(0);
}

main().catch((err) => {
  console.error(`更新提示自检自己崩了：${err.message}`);
  process.exit(1);
});
