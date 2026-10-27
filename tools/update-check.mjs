/**
 * 更新机制自检（v45 引入，v46 按正确的逻辑重写）。
 *
 * 这个应用对更新只有两条要求，两条都必须守住：
 *
 *   A) **每次打开网页都是最新版** —— 不该「先给旧版、再提示更新」。
 *      由 sw.js 的「网络优先」保证：先问服务器要最新的，拿不到才用缓存。
 *   B) **页面一直开着时，线上发了新版要主动提示** —— 用户不该靠自己刷新才发现。
 *      由 index.html 内联的那段自查保证：每分钟 / 切回前台 / 网络恢复时各查一次。
 *
 * 做法：整个项目复制到临时目录再折腾（不在真实仓库里改版本号），
 * 起服务 → 第一次打开（装 SW、缓存当前版本）→ 把副本改成 v99 模拟发版 →
 * 新开一个标签（断言「直接就是 v99」）→ 让这个标签一直开着、再改成 v100 →
 * 触发「切回前台」（断言横幅立刻出现）→ 点横幅（断言变成 v100）。
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

/** 采集这一页的「实际版本 + 有没有横幅 + 缓存名」 */
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

  // 只改沙箱副本，模拟「线上发了一版」
  const bump = (to) => {
    const swap = (file, from, target) => {
      const p = path.join(sandbox, file);
      const s = fs.readFileSync(p, 'utf8');
      const next = s.split(from).join(target);
      if (next === s) throw new Error(`沙箱里没找到要替换的内容：${file} ← ${from}`);
      fs.writeFileSync(p, next);
    };
    const prev = (fs.readFileSync(path.join(sandbox, 'js', 'version.js'), 'utf8').match(/APP_VERSION = '(v\d+)'/) || [])[1];
    swap('js/version.js', `APP_VERSION = '${prev}'`, `APP_VERSION = '${to}'`);
    swap('sw.js', `const CACHE = 'fatloss-${prev}'`, `const CACHE = 'fatloss-${to}'`);
    swap('sw.js', `const APP_VERSION = '${prev}'`, `const APP_VERSION = '${to}'`);
    swap('index.html', `var HERE = '${prev}'`, `var HERE = '${to}'`);
    return prev;
  };

  try {
    await waitFor(async () => (await fetch(BASE + '/', { signal: AbortSignal.timeout(3000) })).ok, '本地服务', 20000);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok, '调试端口', 40000);

    // ── 第 1 次打开：正常安装 Service Worker，把当前版本缓存下来 ──
    const first = await newPage();
    await first.send('Page.navigate', { url: BASE + '/' });
    await waitFor(() => evaluate(first, 'window.__appReady === true'), '第一次启动', 40000);
    await waitFor(() => evaluate(first, `navigator.serviceWorker.getRegistration().then((r) => Boolean(r && (r.active || r.installing || r.waiting)))`), 'Service Worker 注册');
    await sleep(2500);
    const before = await probe(first);
    if (before.版本 !== cur) bad(`第一次打开跑的不是当前版本：${before.版本}（应为 ${cur}）`);
    if (before.横幅) bad('第一次打开就有更新横幅（版本没变却提示，会天天误报）');
    if (!before.缓存.includes(`fatloss-${cur}`)) bad(`第一次打开后缓存里没有 fatloss-${cur}：${JSON.stringify(before.缓存)}`);
    ok(`第一次打开：版本 ${cur}、缓存 ${before.缓存.join('/')}、没有横幅`);
    await first.send('Page.close').catch(() => {});
    await sleep(400);

    // ── 规则 A：模拟发版后新开一个网页，应该**直接**是新版 ──
    const from = bump('v99');
    console.log(`\n   模拟发版：${from} → v99（只改了临时副本）\n`);

    const second = await newPage();
    await second.send('Page.navigate', { url: BASE + '/' });
    await waitFor(() => evaluate(second, 'window.__appReady === true'), '发版后新开网页', 40000);
    await sleep(600);
    const justOpened = await probe(second);
    if (justOpened.版本 === 'v99') {
      ok(`发版后新开网页：直接就是新版 v99（没有"先给旧版"这一步）`);
    } else {
      bad(`发版后新开网页拿到的是 ${justOpened.版本}，不是 v99 —— 打开时还是旧版，说明 Service Worker 的「网络优先」没生效`);
    }
    if (justOpened.横幅) {
      bad(`打开就已经是最新版，却还挂着更新横幅：「${justOpened.横幅文字}」`);
    }
    // Service Worker 本身也要跟着换到新缓存（否则下次断网会退回旧版）
    const swSwapped = await waitFor(
      () => evaluate(second, `caches.keys().then((ks) => ks.includes('fatloss-v99') ? ks : null)`),
      '新版 Service Worker 装好', 20000,
    ).catch(() => null);
    if (swSwapped) ok(`Service Worker 也换到新版缓存：${swSwapped.join('/')}`);
    else bad('新版 Service Worker 没装上（缓存里没有 fatloss-v99），断网时会退回旧版');

    // ── 规则 B：页面**一直开着**，又发了一版 → 切回前台就该提示 ──
    bump('v100');
    console.log('\n   再发一版：v99 → v100（页面保持打开，不重新加载）\n');
    // 模拟「用户切回这个标签页」：触发 visibilitychange（真实路径，不直接调内部函数）
    await evaluate(second, `(() => { document.dispatchEvent(new Event('visibilitychange')); return document.visibilityState; })()`);
    const barShown = await waitFor(
      () => evaluate(second, `(() => { const b = document.getElementById('verBar'); return b && getComputedStyle(b).display !== 'none' ? document.getElementById('verBarText').textContent.trim() : ''; })()`),
      '页面一直开着时的更新提示', 15000,
    ).catch(() => '');
    if (barShown) ok(`页面没重新加载，也主动提示了：「${barShown}」`);
    else bad('页面一直开着时发新版，没有任何提示（用户必须自己刷新才知道 —— 这正是要修的）');
    if (barShown && !/有新版本/.test(barShown)) bad(`横幅文案没说「有新版本」：${barShown}`);
    if (barShown && !/记录不会丢/.test(barShown)) bad(`横幅文案没说「记录不会丢」（用户不敢点）：${barShown}`);
    // 页面本身这时候还应该是 v99（提示归提示，不该偷偷重载把用户正在看的东西弄没）
    const stillOpen = await probe(second);
    if (stillOpen.版本 !== 'v99') bad(`页面被自动替换成 ${stillOpen.版本} 了 —— 应该先提示、由用户决定什么时候更新`);
    else ok('提示期间页面保持原样（没有偷偷重载）');

    // ── 点横幅：换成 v100，记录不丢 ──
    await evaluate(second, `localStorage.setItem('fatloss.selfcheck.marker', 'keep-me')`);
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
      if (after.版本 === 'v100') ok('点横幅之后变成 v100');
      else bad(`点横幅之后还是 ${after.版本}（应当是新版 v100）`);
      if (after.横幅) bad('更新完横幅还挂着（用户会以为没生效）');
      const kept = await evaluate(second, `localStorage.getItem('fatloss.selfcheck.marker')`).catch(() => null);
      if (kept === 'keep-me') ok('本机记录没被清掉（只清了代码缓存）');
      else bad('点更新把本机记录也清掉了 —— 绝对不能丢用户数据');
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
  console.log('✅ 打开就是最新版；页面一直开着时有新版会主动提示；点一下换成新版，记录不丢');
  process.exit(0);
}

main().catch((err) => {
  console.error(`更新机制自检自己崩了：${err.message}`);
  process.exit(1);
});
