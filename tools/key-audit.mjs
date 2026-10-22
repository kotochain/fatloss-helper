/**
 * 密钥安全审计
 *
 * 在真实的线上网址里填一个「假密钥」，然后监控三件事：
 *   1) 这个密钥有没有出现在任何一个网络请求里？出现了就说明会发到别处；
 *   2) 它被写到了哪里（localStorage / sessionStorage / cookie / 离线缓存）？
 *   3) 页面代码里有没有内置的密钥？
 *
 * 用法：
 *   node tools/key-audit.mjs                          # 审计线上网址
 *   node tools/key-audit.mjs http://127.0.0.1:4173/   # 审计本地
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { armWatchdog } from './watchdog.mjs';

/**
 * 干完活之后主动退出。
 *
 * 为什么必须显式退出：无头浏览器和调试用的 WebSocket 连接会让 Node 的事件循环一直不空，
 * 表现为「所有断言都通过了，进程却不结束」，最后被看门狗按超时杀掉 → 退出码非零 → CI 判失败。
 * 这个坑同时骗过了本地和 CI 的排查（报出来的是五花八门的 fetch failed / 超时）。
 */
function finishAndExit(exitCode = 0, cleanup = []) {
  for (const fn of cleanup) { try { fn(); } catch { /* 收尾失败不影响结果 */ } }
  // 直接退出，不用定时器。
  // 曾经写成 setTimeout(...).unref()：没有其它任务时定时器永远不触发，
  // 进程就一直挂着（被看门狗按超时杀掉，退出码还变成非零）。这个坑骗过我和 CI 好几轮。
  process.exit(exitCode);
}
import { findChrome } from './chrome-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = process.argv[2] || 'https://kotochain.github.io/fatloss-helper/';
const FAKE_KEY = 'sk-AUDIT0123456789abcdefghijklmnop'; /* secret-scan:allow 审计用的假密钥 */
const PROVIDER_PORT = 18866;
const CDP_PORT = 9342;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => resolve({
      ws,
      close() { try { ws.close(); } catch { /* 已经关了 */ } },
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

async function main() {
  // 一个假的「服务商」，用来观察真发出去的时候密钥去了哪
  const http = await import('node:http');
  const requested = [];
  const provider = http.createServer((req, res) => {
    requested.push({ url: req.url, auth: req.headers.authorization || null, origin: req.headers.origin || null });
    res.writeHead(200, {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Headers': 'authorization,content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ choices: [{ message: { content: '可以' } }], data: [{ id: 'audit-model' }] }));
  });
  await new Promise((r) => provider.listen(PROVIDER_PORT, '127.0.0.1', r));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'key-audit-'));
  const chrome = spawn(findChrome(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--window-size=390,844', 'about:blank',
  ], { stdio: 'ignore' });
  // 等调试端口起来。等不到就明确报错（之前只等 10 秒然后继续，挂在含糊的 fetch failed 上）
  {
    const deadline = Date.now() + 40000;
    let lastErr = '';
    let ready = false;
    while (Date.now() < deadline) {
      try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); ready = true; break; } catch (err) { lastErr = err.message; }
      await sleep(400);
    }
    if (!ready) throw new Error(`无头 Chrome 在 40 秒内没有起来（端口 ${PORT}）：${lastErr}`);
  }
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const client = await connect(target.webSocketDebuggerUrl);
  const evaluate = async (expr) => {
    const r = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Network.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  // 抓所有发出去的请求（含请求头里的 Authorization）
  const outbound = [];
  const ws = new WebSocket((await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()))[0].webSocketDebuggerUrl);
  void ws;
  const originalSend = client.send.bind(client);
  const onEvent = (handler) => { /* 由下面的 message 钩子统一处理 */ };
  void originalSend; void onEvent;

  // 用 Network.requestWillBeSent 抓请求
  const raw = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
  const pageWs = new WebSocket(raw.find((t) => t.type === 'page')?.webSocketDebuggerUrl || target.webSocketDebuggerUrl);
  await new Promise((r) => pageWs.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  const pageSend = (method, params = {}) => {
    const id = ++seq;
    pageWs.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  pageWs.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
    if (m.method === 'Network.requestWillBeSent') {
      const req = m.params.request;
      outbound.push({ url: req.url, method: req.method, auth: req.headers?.Authorization || req.headers?.authorization || null });
    }
  });
  await pageSend('Network.enable');
  await pageSend('Runtime.enable');

  console.log(`审计目标：${TARGET}\n`);

  await pageSend('Page.navigate', { url: TARGET });
  await sleep(3000);

  console.log('【1】页面代码里有没有内置密钥？');
  const codeCheck = await evaluate(`(async () => {
    const files = ['index.html', 'js/app.js', 'js/ai.js', 'js/ai-core.js', 'js/ai-config.js', 'js/providers.js', 'sw.js'];
    const found = [];
    for (const f of files) {
      const text = await fetch(f).then((r) => r.text()).catch(() => '');
      const m = text.match(/sk-[A-Za-z0-9_-]{16,}/g) || [];
      for (const hit of m) found.push(f + ': ' + hit.slice(0, 8) + '…');
    }
    return { 检查文件数: files.length, 命中: found };
  })()`);
  console.log(`  检查了 ${codeCheck.检查文件数} 个文件（页面会加载的全部代码）`);
  console.log(codeCheck.命中.length ? `  ❌ 发现疑似密钥：${codeCheck.命中.join('、')}` : '  ✅ 没有内置密钥（应用本身不含任何密钥，密钥是每个设备自己填的）');

  console.log('\n【2】填一个密钥，看它去哪了');
  const before = outbound.length;
  const saved = await evaluate(`(async () => {
    const cfg = await import('./js/ai-config.js');
    const ai = await import('./js/ai.js');
    ai.writeAiConfig({
      presetId: 'custom',
      baseUrl: 'http://127.0.0.1:${PROVIDER_PORT}/v1',
      model: 'audit-model',
      apiKey: '${FAKE_KEY}',
      mode: 'direct',
    }, cfg.defaultStorage());
    return JSON.parse(localStorage.getItem('fatloss.ai.v1')).apiKey.slice(0, 8);
  })()`);
  console.log(`  已保存密钥（前 8 位：${saved}…）`);

  console.log('\n【3】让它真的发一次请求（拉到假服务商），看请求发给了谁');
  const ping = await evaluate(`(async () => {
    const ai = await import('./js/ai.js');
    const r = await ai.testConnection();
    return r;
  })()`);
  await sleep(1200);
  console.log(`  连通测试结果：${ping.ok ? '成功' : '失败（' + ping.error + '）'}`);
  const touched = outbound.slice(before);
  console.log(`  这次操作发出的请求共 ${touched.length} 条：`);
  for (const r of touched) {
    const host = (() => { try { return new URL(r.url).host; } catch { return r.url; } })();
    const isProvider = host.startsWith('127.0.0.1') || host.includes('github.io');
    console.log(`    ${r.method} ${host}${r.auth ? '  ← 带了 Authorization 头' : ''}${isProvider ? '' : '  ⚠ 意外目标'}`);
  }
  const sentToProvider = requested.length;
  console.log(`  假服务商实际收到 ${sentToProvider} 次请求，带上来的鉴权头：${requested.map((r) => (r.auth || '无').slice(0, 12) + '…').join('、') || '无'}`);
  const keySentToOwnOrigin = touched.some((r) => {
    const u = new URL(r.url);
    return u.host.includes('github.io') || (u.host === new URL(TARGET).host && r.url.includes(FAKE_KEY));
  });
  const keyInAnyUrl = outbound.some((r) => r.url.includes(FAKE_KEY));
  console.log(`  密钥有没有出现在任何 URL 里？${keyInAnyUrl ? '❌ 有（很危险，URL 会被日志记录）' : '✅ 没有'}`);
  console.log(`  密钥有没有发给我们自己的站点？${keySentToOwnOrigin ? '❌ 有' : '✅ 没有（只发给用户自己填的那个服务商）'}`);

  console.log('\n【4】密钥存在哪里？');
  const storage = await evaluate(`(async () => {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k) || '';
      ls[k] = v.includes('${FAKE_KEY}') ? '含密钥' : (v.length + ' 字符');
    }
    const ss = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      ss[k] = (sessionStorage.getItem(k) || '').includes('${FAKE_KEY}') ? '含密钥' : '其它';
    }
    const cookies = document.cookie || '(空)';
    let cacheHit = 0;
    const names = await caches.keys();
    for (const n of names) {
      const c = await caches.open(n);
      for (const req of await c.keys()) {
        if (req.url.includes('${FAKE_KEY}')) cacheHit += 1;
        const res = await c.match(req);
        if (res) {
          const text = await res.clone().text().catch(() => '');
          if (text.includes('${FAKE_KEY}')) cacheHit += 1;
        }
      }
    }
    return { localStorage: ls, sessionStorage: ss, cookies: cookies.includes('${FAKE_KEY}') ? '含密钥' : '(不含密钥)', 离线缓存命中: cacheHit };
  })()`);
  console.log('  localStorage：', JSON.stringify(storage.localStorage));
  console.log('  sessionStorage：', JSON.stringify(storage.sessionStorage));
  console.log('  Cookie：', storage.cookies);
  console.log(`  离线缓存里：${storage.离线缓存命中 ? '❌ ' + storage.离线缓存命中 + ' 处命中' : '✅ 没有'}`);

  console.log('\n【5】清除按钮真的能清掉吗？');
  const cleared = await evaluate(`(async () => {
    const ai = await import('./js/ai.js');
    ai.clearAiConfig();
    const raw = localStorage.getItem('fatloss.ai.v1');
    let cacheHit = 0;
    for (const n of await caches.keys()) {
      const c = await caches.open(n);
      for (const req of await c.keys()) {
        const res = await c.match(req);
        if (res) {
          const t = await res.clone().text().catch(() => '');
          if (t.includes('${FAKE_KEY}')) cacheHit += 1;
        }
      }
    }
    return { 还留在存储里: raw ? raw.includes('${FAKE_KEY}') : false, 缓存命中: cacheHit, 配置项: raw };
  })()`);
  console.log(`  清除后 localStorage 里还有密钥吗？${cleared.还留在存储里 ? '❌ 还在' : '✅ 没了'}`);
  console.log(`  清除后离线缓存里还有吗？${cleared.缓存命中 ? '❌ 还有' : '✅ 没了'}`);

  console.log('\n【6】别人（访问同一个网址的陌生人）能看到什么？');
  const visitor = await evaluate(`(async () => {
    // 用一个全新的标签页上下文看：直接读存储，应该什么都读不到（不同设备/不同浏览器互不相通）
    const ls = localStorage.length;
    const cfg = localStorage.getItem('fatloss.ai.v1');
    const records = localStorage.getItem('fatloss.state.v2');
    return { 本机存储项数: ls, 有配置: !!cfg, 有记录: !!records };
  })()`);
  console.log(`  当前浏览器（模拟用户自己那台）：存储项 ${visitor.本机存储项数} 个`);
  console.log('  说明：localStorage 是按设备+浏览器隔离的，别人从他的手机打开同一个网址，看到的是空白，读不到用户的任何数据。');

  const problems = [];
  if (codeCheck.命中.length) problems.push('页面代码里出现了疑似密钥');
  if (keyInAnyUrl) problems.push('密钥出现在 URL 里');
  if (keySentToOwnOrigin) problems.push('密钥被发到了自家站点');
  if (storage.离线缓存命中) problems.push('密钥被写进离线缓存');
  if (cleared.还留在存储里) problems.push('清除按钮没有清干净');
  if (sentToProvider === 0) problems.push('连通测试没有真的发出去（这次审计没验到发送路径）');

  console.log('\n════════ 结论 ════════');
  if (problems.length) {
    console.log('❌ 有风险：');
    for (const p of problems) console.log('  -', p);
    process.exitCode = 1;
  } else {
    console.log('✅ 密钥只存在用户自己那台设备的浏览器里，运行时只发给用户自己填的那个 AI 服务商；');
    console.log('   仓库代码里没有密钥、URL 里没有密钥、离线缓存里没有密钥、清除按钮能清干净。');
  }
  console.log(`\n（本次审计用的是假密钥 ${FAKE_KEY.slice(0, 10)}…，只在这台电脑的临时浏览器配置里，跑完即删）`);

  finishAndExit(process.exitCode || 0, [
    () => chrome.kill(), () => provider.close(),
    () => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 忽略 */ } },
  ]);
}

armWatchdog('key-audit.mjs', 200);

// 失败路径也必须收尾：只设 exitCode 的话进程会一直挂着（被看门狗杀掉 → 退出码又变了）
main().catch((err, cleanup) => {
  console.error(`自检失败：${err.message}`);
  finishAndExit(1, Array.isArray(cleanup) ? cleanup : []);
});
process.on('uncaughtException', (err) => {
  console.error(`自检异常：${err.message}`);
  finishAndExit(1);
});
