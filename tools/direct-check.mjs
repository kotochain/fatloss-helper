/**
 * 浏览器「直连」AI 的端到端自检
 *
 * 场景对应真实用法：密钥存在手机里，手机直接调服务商，完全不需要电脑上的中转服务。
 * 为了不花 API 费用，这里起一个「假服务商」：
 *   - 带正确的跨域头（Access-Control-Allow-Origin 等），模拟 DeepSeek 那种允许直连的服务；
 *   - 提供 /models（模型列表）和 /chat/completions（解析）。
 * 然后完全不启动 tools/serve.mjs，只用一个静态文件服务，验证手机端能独立工作。
 *
 * 用法：node tools/direct-check.mjs
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.selfcheck');
const CHROME = findChrome();
const FAKE_PORT = 18877;
const STATIC_PORT = 4198;
const CDP_PORT = 9339;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hits = { models: 0, chat: 0, authSeen: [] };

/** 假服务商：跨域头齐全，模拟允许浏览器直连的厂商 */
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
    if (req.headers.authorization) hits.authSeen.push(req.headers.authorization.slice(0, 10));

    if (req.url.startsWith('/v1/models')) {
      hits.models += 1;
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'mock-chat-v3', object: 'model' },
          { id: 'mock-reasoner-v2', object: 'model' },
          { id: 'mock-embedding-1', object: 'model' },
          { id: 'mock-chat-v2-legacy', object: 'model' },
        ],
      }));
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      hits.chat += 1;
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        const userText = body.messages?.find((m) => m.role === 'user')?.content || '';
        const isPing = userText.includes('回复两个字');
        const content = isPing
          ? '可以'
          : JSON.stringify({
            meal: 'dinner',
            items: [{ name: '牛肉面', grams: 550 }, { name: '卤蛋', grams: 50 }],
            questions: ['面是大碗还是普通碗？'],
          });
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
      return;
    }
    res.writeHead(404, cors);
    res.end('{}');
  });
}

/** 只提供静态文件，故意不实现任何 /api 接口 —— 模拟「没有中转服务」的环境 */
function startStaticServer() {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
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

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const fake = startFakeProvider();
  const staticServer = startStaticServer();
  await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));
  await new Promise((r) => staticServer.listen(STATIC_PORT, '127.0.0.1', r));

  const BASE = `http://127.0.0.1:${STATIC_PORT}`;
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(outDir, 'chrome-direct')}`,
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
  const problems = [];

  await client.send('Page.navigate', { url: BASE + '/' });
  await sleep(1200);
  await evaluate(`(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    for (const n of await caches.keys()) await caches.delete(n);
    localStorage.clear();
    const store = await import('./js/store.js');
    const st = store.emptyState();
    st.profile = store.demoProfile();
    localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
    return true;
  })()`);
  await client.send('Page.navigate', { url: BASE + '/' });
  await sleep(1500);

  const ready = await evaluate(`window.__appReady === true`);
  if (!ready) problems.push('页面没启动');
  console.log('静态托管（没有任何后端接口）下页面能打开：', ready);

  console.log('\n=== 一、确认环境里没有中转服务 ===');
  const noRelay = await evaluate(`(async () => {
    const r = await fetch('/api/ai-status').then((x) => x.status).catch(() => 'fail');
    return r;
  })()`);
  console.log('请求 /api/ai-status 的结果：', noRelay, noRelay === 404 ? '（预期：没有中转服务）' : '');

  console.log('\n=== 二、在设置里选「自定义」直连假服务商 ===');
  await evaluate(`document.querySelector('.tab[data-view="log"]').click()`);
  await sleep(400);
  await evaluate(`document.querySelector('#aiSettingsBtn').click()`);
  await sleep(800);
  await evaluate(`document.querySelector('#presetChips [data-preset="custom"]').click()`);
  await sleep(200);
  await evaluate(`(() => {
    document.querySelector('#aiBaseUrl').value = 'http://127.0.0.1:${FAKE_PORT}/v1';
    document.querySelector('#aiKey').value = 'sk-direct-mode-fake' /* secret-scan:allow 假密钥 */;
    document.querySelector('#aiFetchModels').click();
  })()`);
  await sleep(2500);
  const modelsResult = await evaluate(`(() => ({
    下拉选项: [...document.querySelectorAll('#aiModelList option')].map((o) => o.value),
    输入框值: document.querySelector('#aiModel').value,
    快捷按钮: [...document.querySelectorAll('#modelPick [data-model]')].map((b) => b.textContent.trim()),
    提示: document.querySelector('#aiSettingsMsg')?.textContent.replace(/\\s+/g, ' ').slice(0, 80) || '',
  }))()`);
  console.log('获取模型列表 →', JSON.stringify(modelsResult));
  if (hits.models === 0) problems.push('没有真的去请求模型列表接口');
  if (modelsResult.下拉选项.length < 3) problems.push(`模型列表只拿到 ${modelsResult.下拉选项.length} 个`);
  if (modelsResult.输入框值 !== 'mock-chat-v3') problems.push(`没有自动选中第一个模型，实际是 ${modelsResult.输入框值}`);
  // 旧模型名不该被默认选中
  if (modelsResult.下拉选项.includes('mock-chat-v2-legacy') && modelsResult.输入框值 === 'mock-chat-v2-legacy') {
    problems.push('默认选中了过时的模型');
  }

  await evaluate(`document.querySelector('#aiSave').click()`);
  await sleep(3500);
  const saveMsg = await evaluate(`document.querySelector('#aiSettingsMsg')?.textContent.replace(/\\s+/g, ' ').trim() || ''`);
  console.log('保存并测试 →', saveMsg);
  if (!saveMsg.includes('保存成功')) problems.push(`保存失败：${saveMsg}`);
  if (!saveMsg.includes('连通正常')) problems.push(`连通测试没过：${saveMsg}`);
  if (hits.chat === 0) problems.push('连通测试没有真的发出请求');

  // 密钥应当在手机本地
  const stored = await evaluate(`(() => {
    const raw = localStorage.getItem('fatloss.ai.v1');
    const fake = 'sk-direct-mode-fake'; // secret-scan:allow 自检用的假密钥
    return { 已保存: !!raw, 模式: raw ? JSON.parse(raw).mode : null, 含密钥: raw ? raw.includes(fake) : false };
  })()`);
  console.log('本机保存的配置：', JSON.stringify(stored));
  if (!stored.已保存) problems.push('配置没有保存到本机');
  if (stored.模式 !== 'direct') problems.push(`模式不是直连，实际 ${stored.模式}`);

  await evaluate(`document.querySelector('#sheetClose').click()`);
  await sleep(300);

  console.log('\n=== 三、直连解析一句话（中转服务不存在，只能靠直连） ===');
  await evaluate(`(() => {
    const ta = document.querySelector('#quickText');
    ta.value = '晚上吃了碗牛肉面加卤蛋';
    document.querySelector('#quickParse').click();
  })()`);
  await sleep(3000);
  const parsed = await evaluate(`(() => ({
    方式: document.querySelector('#draftHost .warn')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) || '',
    条目: [...document.querySelectorAll('#draftHost .entry .name')].map((n) => n.textContent.trim().replace(/\\s+/g, ' ')),
    合计: document.querySelector('#draftHost .row.between b')?.textContent || null,
  }))()`);
  console.log('解析结果 →', JSON.stringify(parsed));
  const shotDraft = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-draft-sheet.png'), Buffer.from(shotDraft.data, 'base64'));
  if (!parsed.方式.includes('AI 识别')) problems.push(`没有走 AI 直连，实际：${parsed.方式}`);
  if (parsed.条目.length < 2) problems.push('解析结果不完整');

  await evaluate(`document.querySelector('#draftSave').click()`);
  await sleep(500);
  const saved = await evaluate(`(() => {
    const st = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    const day = st.days[Object.keys(st.days)[0]];
    return Object.values(day.meals).flat().map((e) => e.food.name + ' ' + e.grams + 'g');
  })()`);
  console.log('记入记录 →', JSON.stringify(saved));
  if (!saved.length) problems.push('没有写进记录');

  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-direct-ai.png'), Buffer.from(shot.data, 'base64'));

  console.log('\n=== 四、日历与日期选择 ===');
  await evaluate(`document.querySelector('#dateLabel').click()`);
  await sleep(600);
  const cal = await evaluate(`(() => {
    const cells = [...document.querySelectorAll('.cal-cell:not(.empty)')];
    return {
      格子数: cells.length,
      有记录的格: cells.filter((c) => c.classList.contains('has-data')).length,
      选中的: document.querySelector('.cal-cell.selected')?.textContent.trim() || null,
      今天的: !!document.querySelector('.cal-cell.today'),
      连续天数显示: document.querySelector('.warn.info')?.textContent.replace(/\\s+/g, ' ').trim() || '',
    };
  })()`);
  console.log('日历 →', JSON.stringify(cal));
  // 日历弹层本身就是这次的交付物，先截一张（在点走之前）
  const shotCal = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-calendar.png'), Buffer.from(shotCal.data, 'base64'));
  if (cal.格子数 < 28) problems.push(`日历格子只有 ${cal.格子数} 个`);
  if (!cal.今天的) problems.push('日历没有标出今天');
  if (cal.有记录的格 === 0) problems.push('日历没有标出「有记录」的日期');

  // 点日历里的另一天，日期应当切过去
  const switched = await evaluate(`(async () => {
    const cells = [...document.querySelectorAll('.cal-cell:not(.empty)')];
    const other = cells.find((c) => !c.classList.contains('selected'));
    const want = other.dataset.date;
    other.click();
    await new Promise((r) => setTimeout(r, 400));
    return { 点击的日期: want, 顶部显示的日期: document.querySelector('#dateLabel')?.textContent || null };
  })()`);
  console.log('点日历切日期 →', JSON.stringify(switched));
  if (!switched.顶部显示的日期) problems.push('点日历没有切换日期');

  console.log('\n=== 结论 ===');
  console.log(`假服务商收到的请求：模型列表 ${hits.models} 次、对话 ${hits.chat} 次`);
  console.log(`带上的鉴权头：${[...new Set(hits.authSeen)].join(', ') || '（无）'}`);
  if (problems.length) {
    console.log('❌ 有问题：');
    for (const p of problems) console.log('  -', p);
    process.exitCode = 1;
  } else {
    console.log('✅ 浏览器直连可用：没有后端、没有电脑中转，手机上就能调 AI、拉模型列表、解析并记录');
  }
  console.log(`截图：${outDir}/shot-direct-ai.png、shot-calendar.png`);
  chrome.kill();
  fake.close();
  staticServer.close();
}

main().catch((err) => { console.error('自检失败：', err.message); process.exitCode = 1; });
