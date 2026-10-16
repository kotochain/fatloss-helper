/**
 * AI 链路端到端自检（不需要真的 AI 密钥）
 *
 * 做法：起一个「假的上游 AI」，让它按真实格式返回解析结果，
 * 然后启动转发服务指向它，再用无头浏览器走一遍界面。
 * 这样能验证「手机 → 本机转发 → 上游 → 界面确认 → 记入记录」整条链路，
 * 而不需要花任何 API 费用。
 *
 * 用法：node tools/ai-e2e-check.mjs
 */

import http from 'node:http';
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
import { portAlive, freePort } from './chrome-launch.mjs';

/** 清掉占用调试端口的残留进程，并等端口真的空出来 */
async function freePortAndWait(port) {
  if (!(await portAlive(port))) return;
  freePort(port);
  for (let i = 0; i < 25 && (await portAlive(port)); i++) await sleep(200);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.selfcheck');
const CHROME = findChrome();
const FAKE_AI_PORT = 18899;
const APP_PORT = 4199;
const CDP_PORT = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fatloss-e2e-cfg-'));
let upstreamRequests = 0;

/** 假上游：按 OpenAI 兼容格式返回，内容针对输入做区分 */
function startFakeAi() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      upstreamRequests += 1;
      const body = JSON.parse(raw || '{}');
      const userText = body.messages?.find((m) => m.role === 'user')?.content || '';
      const auth = req.headers.authorization || '';
      // 故意暴露成返回值的一部分，用于断言「密钥没有漏到手机端」
      const content = userText.includes('麻辣烫')
        ? { meal: 'lunch', items: [{ name: '麻辣烫', grams: 500 }, { name: '芝麻酱', grams: 15 }], questions: ['汤喝了吗？'] }
        : { meal: 'lunch', items: [{ name: '牛肉面', grams: 600 }, { name: '鸡蛋', grams: 50 }], questions: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) } }],
        echo: { authSeen: auth.slice(0, 7) },
      }));
    });
  });
}

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
  fs.mkdirSync(outDir, { recursive: true });

  const fakeAi = startFakeAi();
  await new Promise((r) => fakeAi.listen(FAKE_AI_PORT, '127.0.0.1', r));

  // 启动转发服务：不预置任何密钥，配置全部由「界面设置」流程写入（这才是真实用法）
  const serve = spawn(process.execPath, ['tools/serve.mjs', String(APP_PORT)], {
    cwd: root,
    env: {
      ...process.env,
      FATLOSS_CONFIG_DIR: cfgDir,
      AI_API_KEY: '',
      DEEPSEEK_API_KEY: '',
      AI_BASE_URL: '',
      AI_MODEL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serveLog = '';
  serve.stdout.on('data', (d) => { serveLog += d.toString(); });
  serve.stderr.on('data', (d) => { serveLog += d.toString(); });

  const BASE = `http://127.0.0.1:${APP_PORT}`;
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
  const status = await (await fetch(`${BASE}/api/ai-status`)).json();
  console.log('初始 AI 状态：', JSON.stringify(status));
  const problems = [];
  if (status.configured) problems.push('一开始就是已配置状态，说明没隔离干净（应当由界面设置写入）');

  // 先把调试端口清干净：上一次没退干净的 Chrome 会占着端口，
  // 新实例静默失败、等待循环却连上僵尸端口 —— 表现为「只有第一个脚本能过」。
  await freePortAndWait(PORT);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(outDir, 'chrome-ai-e2e')}`,
    '--window-size=390,844', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; } catch { await sleep(250); }
  }
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const client = await connect(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const evaluate = async (expr) => {
    const r = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await client.send('Page.navigate', { url: BASE + '/' });
  await sleep(1200);
  await evaluate(`(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    const names = await caches.keys();
    await Promise.all(names.map((n) => caches.delete(n)));
    localStorage.clear();
    const store = await import('./js/store.js');
    const st = store.emptyState();
    st.profile = store.demoProfile();
    localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
    return true;
  })()`);
  await client.send('Page.navigate', { url: BASE + '/' });
  await sleep(1500);

  // 界面上应该显示「AI 设置」
  await evaluate(`document.querySelector('.tab[data-view="log"]').click()`);
  await sleep(600);

  console.log('\n=== 一、在界面上配置 AI（模拟用户自己填） ===');
  const beforeTag = await evaluate(`document.querySelector('#aiSettingsBtn')?.textContent.trim()`);
  console.log('设置前按钮文案：', beforeTag);
  await evaluate(`document.querySelector('#aiSettingsBtn').click()`);
  await sleep(1200);
  const sheet = await evaluate(`(() => ({
    标题: document.querySelector('#sheetTitle')?.textContent || '',
    预设数: document.querySelectorAll('#presetChips .chip').length,
    有地址框: !!document.querySelector('#aiBaseUrl'),
    有模型框: !!document.querySelector('#aiModel'),
    有密钥框: !!document.querySelector('#aiKey'),
  }))()`);
  console.log('设置弹层：', JSON.stringify(sheet));
  // 设置弹层本身就是交付物的一部分，先截一张（在填写之前，展示预设列表）
  const shotSheet = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-ai-settings.png'), Buffer.from(shotSheet.data, 'base64'));
  if (!sheet.有地址框 || !sheet.有模型框 || !sheet.有密钥框) problems.push('设置弹层缺少输入框');
  if (sheet.预设数 < 5) problems.push(`服务商预设只有 ${sheet.预设数} 个`);

  // 选「自定义」，填成本机假上游（模拟用户填自己的网关/端口）
  await evaluate(`document.querySelector('#presetChips [data-preset="custom"]').click()`);
  await sleep(200);
  await evaluate(`(() => {
    document.querySelector('#aiBaseUrl').value = 'http://127.0.0.1:${FAKE_AI_PORT}/v1';
    document.querySelector('#aiModel').value = 'fake-model';
    document.querySelector('#aiKey').value = 'sk-e2e-fake-key-for-testing' /* secret-scan:allow 假密钥 */;
    document.querySelector('#aiSave').click();
  })()`);
  await sleep(3000);
  const saveMsg = await evaluate(`document.querySelector('#aiSettingsMsg')?.textContent.replace(/\s+/g, ' ').trim() || ''`);
  console.log('保存并测试的结果：', saveMsg);
  if (!saveMsg.includes('保存成功')) problems.push(`保存失败：${saveMsg}`);
  if (!saveMsg.includes('连通正常')) problems.push(`连通测试没过：${saveMsg}`);

  // 配置文件的权限与位置
  const cfgInfo = await evaluate(`fetch('/api/ai-config').then((r) => r.json()).then((d) => ({
    已配置: d.configured, 来源: d.source, 模型: d.model,
    掩码: d.saved?.keyMasked || null, 文件: d.configFile,
    含完整密钥: JSON.stringify(d).includes('sk-e2e-fake-key-for-testing' /* secret-scan:allow 假密钥 */),
  }))`);
  console.log('配置状态：', JSON.stringify(cfgInfo));
  if (cfgInfo.含完整密钥) problems.push('状态接口把完整密钥回传给了手机');
  if (!cfgInfo.掩码?.includes('*')) problems.push('没有返回掩码');

  const shotSaved = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-ai-settings-saved.png'), Buffer.from(shotSaved.data, 'base64'));
  await evaluate(`document.querySelector('#sheetClose').click()`);
  await sleep(400);
  console.log('\n=== 二、用配好的 AI 解析一句话 ===');
  const tag = await evaluate(`document.querySelector('#quickResult') ? 'ok' : 'ok'`);
  void tag;
  const aiTag = await evaluate(`document.querySelector('#aiSettingsBtn')?.textContent.replace(/\\s+/g, ' ').trim() || null`);
  console.log('记录页按钮：', JSON.stringify(aiTag));
  if (!aiTag || !aiTag.includes('AI 已启用')) problems.push(`配好之后界面按钮没有变成「AI 已启用」，实际是：${aiTag}`);

  // 走一遍 AI 解析
  await evaluate(`(() => {
    const ta = document.querySelector('#quickText');
    ta.value = '今天中午吃了麻辣烫';
    document.querySelector('#quickParse').click();
  })()`);
  await sleep(2500);
  const draft = await evaluate(`(() => ({
    条目: [...document.querySelectorAll('#quickResult .entry .name')].map((n) => n.textContent.trim().replace(/\\s+/g, ' ')),
    合计: document.querySelector('#quickResult .row.between b')?.textContent || null,
    追问: [...document.querySelectorAll('#quickResult .warn')].map((w) => w.textContent.trim().slice(0, 40)),
  }))()`);
  console.log('AI 解析结果：', JSON.stringify(draft, null, 0));
  if (!draft.条目.some((n) => n.includes('麻辣烫'))) problems.push('AI 解析结果没有出现在界面上');
  if (upstreamRequests === 0) problems.push('上游一次都没被调用，说明没有真的走 AI');
  else console.log(`✅ 转发服务确实调用了上游（第 ${upstreamRequests} 次）`);

  // 密钥不能出现在手机能看到的任何响应里
  const leaked = await evaluate(`(async () => {
    const texts = [];
    for (const url of ['/api/ai-status', '/js/ai.js', '/js/app.js']) {
      texts.push(await fetch(url).then((r) => r.text()));
    }
    const joined = texts.join('\\n');
    return {
      含密钥: joined.includes('sk-e2e-fake-key-for-testing' /* secret-scan:allow 假密钥 */),
      含sk前缀: /sk-[A-Za-z0-9_-]{10,}/.test(joined),
    };
  })()`);
  console.log('密钥泄露检查：', JSON.stringify(leaked));
  if (leaked.含密钥) problems.push('密钥出现在手机端拿到的响应里');

  // 记入记录
  await evaluate(`document.querySelector('#draftSave').click()`);
  await sleep(600);
  const saved = await evaluate(`(() => {
    const st = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    const day = st.days[Object.keys(st.days)[0]];
    return Object.values(day.meals).flat().map((e) => e.food.name + ' ' + e.grams + 'g');
  })()`);
  console.log('记入记录：', JSON.stringify(saved));
  if (!saved.length) problems.push('AI 解析的结果没有写进记录');

  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-ai-e2e.png'), Buffer.from(shot.data, 'base64'));

  console.log(`\n转发服务日志：\n${serveLog.split('\n').filter((l) => l.includes('AI') || l.includes('解析')).join('\n')}`);
  console.log(problems.length ? `\n❌ ${problems.length} 个问题：\n  - ${problems.join('\n  - ')}` : '\n✅ AI 链路端到端通过（密钥未外泄，解析结果可确认、可记入）');
  if (problems.length) process.exitCode = 1;

  finishAndExit(process.exitCode || 0, [
    () => client.close(), () => chrome.kill(), () => serve.kill(), () => fakeAi.close(),
    () => { try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* 忽略 */ } },
  ]);
}

armWatchdog('ai-e2e-check.mjs', 260);

// 失败路径也必须收尾：只设 exitCode 的话进程会一直挂着（被看门狗杀掉 → 退出码又变了）
main().catch((err, cleanup) => {
  console.error(`自检失败：${err.message}`);
  finishAndExit(1, Array.isArray(cleanup) ? cleanup : []);
});
process.on('uncaughtException', (err) => {
  console.error(`自检异常：${err.message}`);
  finishAndExit(1);
});
