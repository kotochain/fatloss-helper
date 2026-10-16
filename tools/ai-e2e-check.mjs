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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.selfcheck');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FAKE_AI_PORT = 18899;
const APP_PORT = 4199;
const CDP_PORT = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fakeKeyFile = path.join(root, '.selfcheck', 'fake-ai-key');
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
  fs.writeFileSync(fakeKeyFile, 'sk-e2e-fake-key-for-testing\n');

  const fakeAi = startFakeAi();
  await new Promise((r) => fakeAi.listen(FAKE_AI_PORT, '127.0.0.1', r));

  // 启动转发服务：密钥文件指向假密钥，上游指向假 AI
  const serve = spawn(process.execPath, ['tools/serve.mjs', String(APP_PORT)], {
    cwd: root,
    env: {
      ...process.env,
      AI_API_KEY: 'sk-e2e-fake-key-for-testing',
      AI_BASE_URL: `http://127.0.0.1:${FAKE_AI_PORT}`,
      AI_MODEL: 'fake-model',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serveLog = '';
  serve.stdout.on('data', (d) => { serveLog += d.toString(); });
  serve.stderr.on('data', (d) => { serveLog += d.toString(); });

  const BASE = `http://127.0.0.1:${APP_PORT}`;
  for (let i = 0; i < 40; i++) {
    try { await (await fetch(`${BASE}/api/ai-status`)).json(); break; } catch { await sleep(250); }
  }
  const status = await (await fetch(`${BASE}/api/ai-status`)).json();
  console.log('AI 状态：', JSON.stringify(status));
  const problems = [];
  if (!status.configured) problems.push('转发服务没有认出密钥，AI 状态是未配置');

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

  // 界面上应该显示「AI 已启用」
  await evaluate(`document.querySelector('.tab[data-view="log"]').click()`);
  await sleep(600);
  const tag = await evaluate(`document.querySelector('#quickResult') ? 'ok' : 'ok'`);
  void tag;
  const aiTag = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.card-title .tag')].map((t) => t.textContent.trim());
    return el;
  })()`);
  console.log('记录页标签：', JSON.stringify(aiTag));
  if (!aiTag.some((t) => t.includes('AI 已启用'))) problems.push('界面没有显示「AI 已启用」');

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
      含密钥: joined.includes('sk-e2e-fake-key-for-testing'),
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

  chrome.kill();
  serve.kill();
  fakeAi.close();
  try { fs.unlinkSync(fakeKeyFile); } catch { /* 忽略 */ }
}

main().catch((err) => { console.error('自检失败：', err.message); process.exitCode = 1; });
