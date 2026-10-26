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
const FAKE_PORT = 18877;
const STATIC_PORT = 4198;
const CDP_PORT = 9339;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hits = { models: 0, chat: 0, coach: 0, authSeen: [] };

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
        // 教练请求的识别跟着提示词走：v28 把第三人称改成了第二人称指令（见 js/coach.js#coachUserMessage）
        const isCoach = userText.includes('请根据上面的情况');
        // 教练：第一次照清单里的数字说（应当通过校验），第二次故意编一个数字（应当退回本地版）。
        // 两个数字都从「给 AI 的事实清单」里现取，确保第一次是真的合格，不是碰巧。
        if (isCoach) {
          hits.coach += 1;
          const remain = (userText.match(/还能吃 (-?\d+) kcal/) || [])[1] || '0';
          const gap = (userText.match(/还差 (\d+) 克/) || [])[1] || '0';
          const coachText = hits.coach === 1
            ? `今天还能吃 ${remain} kcal，蛋白质还差 ${gap} 克。先把蛋白补上，主食和蔬菜按剩下的额度配，晚上别空着肚子。`
            : '今天还能吃 999 kcal，蛋白质还差 12 克，随便吃。';
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { content: coachText } }] }));
        }
        // v34：这一句故意让假上游按「新格式」回营养估算（本地库里没有的菜）
        const isEstimateCase = userText.includes('某网红限定轻食碗');
        const estimateGrams = userText.includes('200') ? 200 : 300;
        const per100 = { kcal: 140, protein: 7.3, fat: 4, carb: 17.3 };
        const at = (v) => Math.round((v * estimateGrams) / 100 * 10) / 10;
        const content = isPing
          ? '可以'
          : isEstimateCase
            ? JSON.stringify({
              meal: 'lunch',
              items: [{
                name: '某网红限定轻食碗',
                grams: estimateGrams,
                kcal: at(per100.kcal), protein: at(per100.protein), fat: at(per100.fat), carb: at(per100.carb),
              }],
              questions: [],
            })
            : JSON.stringify({
              meal: 'dinner',
              // 故意用离线解析认不出来的说法：如果 AI 的结果被丢掉、退回离线解析，
              // 这三条一条都记不上（以前就是这样，界面还显示「AI 识别」，骗过了所有自检）。
              // v34 起这三条不带营养（老格式）→ 必须继续按同类均值兜底，不能一条都记不上。
              items: [{ name: '炒河粉', grams: 200 }, { name: '小肉丸', grams: 60 }, { name: '骨肉相连', grams: 80 }],
              questions: ['炒河粉的碗大概多大？'],
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
      } else if (msg.method && handlers.has(msg.method)) {
        handlers.get(msg.method)(msg.params);
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
  // 先把调试端口清干净：上一次没退干净的 Chrome 会占着端口，
  // 新实例静默失败、等待循环却连上僵尸端口 —— 表现为「只有第一个脚本能过」。
  await freePortAndWait(CDP_PORT);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(outDir, 'chrome-direct')}`,
    '--window-size=390,844', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });
  // 等调试端口起来。等不到就明确报错（之前只等 10 秒然后继续，挂在含糊的 fetch failed 上）
  {
    const deadline = Date.now() + 40000;
    let lastErr = '';
    let ready = false;
    while (Date.now() < deadline) {
      try { await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); ready = true; break; } catch (err) { lastErr = err.message; }
      await sleep(400);
    }
    if (!ready) throw new Error(`无头 Chrome 在 40 秒内没有起来（端口 ${CDP_PORT}）：${lastErr}`);
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
  // 入口走真实路径：顶栏头像 → 设置 → AI 设置（记录页原来那个按钮已换成「模式胶囊」，两件事分开了）
  await evaluate(`document.querySelector('#profileBtn').click()`);
  await sleep(500);
  await evaluate(`document.querySelector('[data-set="ai"]').click()`);
  await sleep(900);
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

  console.log('\n=== 二·二、留空密钥 = 沿用已保存的那把（用户遇到的「密钥没填」） ===');
  // 输入框上写着「已保存：sk-***（留空则不改）」，那就必须真的不改。
  // 以前这里只认「没传 apiKey」，而界面拿到的是空字符串，于是留空保存会报「密钥没填」。
  const beforeBlankChats = hits.chat;
  await evaluate(`(() => {
    document.querySelector('#aiKey').value = '';
    document.querySelector('#aiSave').click();
  })()`);
  await sleep(3200);
  // 截图要拍到密钥框（「已保存…（留空则不改）」）和下面那条成功提示，先滚过去
  await evaluate(`document.querySelector('#aiKey')?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  const shotBlank = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-ai-blank.png'), Buffer.from(shotBlank.data, 'base64'));
  const blankSave = await evaluate(`(() => ({
    提示: document.querySelector('#aiSettingsMsg')?.textContent.replace(/\\s+/g, ' ').trim() || '',
    占位: document.querySelector('#aiKey')?.placeholder || '',
    还存着密钥: (localStorage.getItem('fatloss.ai.v1') || '').includes('sk-direct-mode-fake' /* secret-scan:allow 自检用的假密钥 */),
  }))()`);
  console.log(`   留空再保存 → 「${blankSave.提示}」`);
  console.log(`   占位提示：「${blankSave.占位}」｜密钥还在：${blankSave.还存着密钥}`);
  if (/密钥没填/.test(blankSave.提示)) problems.push('留空密钥保存被拒 —— 输入框写着「留空则不改」，就得真的不改');
  if (!/连通正常|保存成功/.test(blankSave.提示)) problems.push(`留空保存没成功：${blankSave.提示}`);
  if (!blankSave.还存着密钥) problems.push('留空保存把已保存的密钥清掉了');
  if (!blankSave.占位.includes('已保存')) problems.push(`密钥框的占位提示没说已保存：${blankSave.占位}`);
  if (hits.chat <= beforeBlankChats) problems.push('留空保存没有真的用已保存的密钥发一次连通测试');

  await evaluate(`document.querySelector('#sheetClose').click()`);
  await sleep(300);

  console.log('\n=== 三、直连解析一句话（中转服务不存在，只能靠直连） ===');
  // 上一段停在「我的 → AI 设置」弹层里，先收起来回到记录页
  await evaluate(`document.querySelector('#sheetClose')?.click()`);
  await sleep(300);
  await evaluate(`document.querySelector('.tab[data-view="log"]').click()`);
  await sleep(500);
  await evaluate(`(() => {
    const ta = document.querySelector('#quickText');
    ta.value = '中午吃了半碗炒河粉加了三个小肉丸两串骨肉相连';
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
  // v31 起界面文案是「这次是：AI 认出来的」（原文案「AI 识别」）
  if (!parsed.方式.includes('AI 认出来的')) problems.push(`没有走 AI 直连，实际：${parsed.方式}`);
  /**
   * 关键断言：AI 说的三条必须**真的被记上**。
   *
   * 这条守的是一个隐藏很久的 bug：AI 只返回 {name, grams}（提示词禁止它给热量），
   * 而旧代码要求 matchedFoodId 或 kcal 才算数 —— 于是 AI 的结果全被丢掉，
   * 悄悄退回离线解析。离线解析恰好认得「牛肉面」，所以以前的自检全绿，看不出问题。
   * 换成离线解析认不出的说法（炒河粉/小肉丸/骨肉相连），才能证明结果真的来自 AI。
   */
  if (parsed.条目.length < 3) problems.push(`AI 认出 3 条但只记上 ${parsed.条目.length} 条 —— AI 的结果可能又被丢掉了`);
  const kcalNum = Number(String(parsed.合计 || '').replace(/[^0-9.]/g, ''));
  if (!(kcalNum > 500)) problems.push(`这三样算下来应当 600~800 kcal，实际「${parsed.合计}」`);

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

  console.log('\n=== 三·三、AI 直接估营养（本地库里没有的菜）+ 存成「我的食物」 ===');
  // v34 的核心：AI 不再只当查表员。这一条走真实界面：
  // 假上游按新格式回「某网红限定轻食碗 300g + 营养估算」→ 本地校验 → 存成「我的食物」→ 下次命中。
  await evaluate(`document.querySelector('.tab[data-view="log"]').click()`);
  await sleep(400);
  await evaluate(`(() => {
    const ta = document.querySelector('#quickText');
    ta.value = '中午吃了某网红限定轻食碗 300 克';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#quickParse').click();
  })()`);
  await sleep(2500);
  const estimateUi = await evaluate(`(() => {
    const row = document.querySelector('#draftHost .draft-entry');
    return {
      行数: document.querySelectorAll('#draftHost .draft-entry').length,
      标签: row?.querySelector('.tag.amber')?.textContent.trim() || '',
      热量: row?.querySelector('[data-kcal]')?.textContent || '',
      说明: row?.querySelector('.draft-note')?.textContent.replace(/\\s+/g, ' ').trim() || '',
      顶部提示: [...document.querySelectorAll('#draftHost .warn')].map((w) => w.textContent.replace(/\\s+/g, ' ').trim()).join(' ｜ ').slice(0, 200),
    };
  })()`);
  console.log(`   AI 估营养 → ${estimateUi.行数} 行｜标签「${estimateUi.标签}」｜${estimateUi.热量}｜说明「${estimateUi.说明}」`);
  console.log(`   顶部提示：${estimateUi.顶部提示}`);
  if (estimateUi.行数 !== 1) problems.push(`AI 估营养这条应当 1 行，实际 ${estimateUi.行数} 行`);
  if (estimateUi.标签 !== 'AI 估的') problems.push(`库里没有的菜要标「AI 估的」，实际「${estimateUi.标签}」`);
  if (!/420/.test(estimateUi.热量)) problems.push(`应当显示 AI 估的 420 kcal，实际「${estimateUi.热量}」`);
  if (!estimateUi.说明.includes('AI 估的')) problems.push(`说明里要写清是 AI 估的：${estimateUi.说明}`);
  if (!estimateUi.顶部提示.includes('AI 估的')) problems.push('顶部提示没有说明哪几样是 AI 估的');

  await evaluate(`document.querySelector('#draftSave').click()`);
  await sleep(700);
  const savedEstimate = await evaluate(`(() => {
    const st = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    const cf = (st.customFoods || []).find((f) => f.name.includes('轻食碗'));
    const entry = Object.values(st.days[Object.keys(st.days)[0]].meals).flat().find((e) => e.food.name.includes('轻食碗'));
    return {
      存进我的食物: Boolean(cf),
      来源: cf?.source || null,
      每百克: cf ? Math.round(cf.kcal) : null,
      原句: cf?.originalText || '',
      记录热量: entry ? Math.round((entry.food.kcal / 100) * entry.grams) : null,
      反馈: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '),
    };
  })()`);
  console.log('   保存后 →', JSON.stringify(savedEstimate));
  if (!savedEstimate.存进我的食物) problems.push('AI 估的条目保存后没有存进「我的食物」（下次还得再问 AI）');
  if (savedEstimate.来源 !== 'ai-estimate') problems.push(`「我的食物」没记录来源，实际 ${savedEstimate.来源}`);
  if (!(Math.abs((savedEstimate.每百克 || 0) - 140) <= 1)) problems.push(`每 100 克应当是 140 kcal 左右，实际 ${savedEstimate.每百克}`);
  if (!savedEstimate.原句.includes('轻食碗')) problems.push(`没有留住原始句子：${savedEstimate.原句}`);
  if (!savedEstimate.反馈.includes('我的食物')) problems.push('保存反馈没有告诉用户「已存进我的食物」');

  // 再说一次同样的菜：必须命中「我的食物」，数字用自己存的，并说明是按之前存的算的；
  // 而且这次**不许再发 AI 请求**（v34：只涉及之前存过的菜，本地就能说清）
  const chatsBeforeCached = hits.chat;
  await evaluate(`(() => {
    const ta = document.querySelector('#quickText');
    ta.value = '下午又吃了某网红限定轻食碗 200 克';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#quickParse').click();
  })()`);
  await sleep(2200);
  const cached = await evaluate(`(() => {
    const row = document.querySelector('#draftHost .draft-entry');
    const st = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    return {
      标签: row?.querySelector('.tag.amber')?.textContent.trim() || '',
      热量: row?.querySelector('[data-kcal]')?.textContent || '',
      说明: row?.querySelector('.draft-note')?.textContent.replace(/\\s+/g, ' ').trim() || '',
      来源: document.querySelector('#draftHost .warn')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) || '',
      我的食物条数: (st.customFoods || []).length,
    };
  })()`);
  console.log(`   再说一次 → 标签「${cached.标签}」｜${cached.热量}｜说明「${cached.说明}」｜我的食物 ${cached.我的食物条数} 条`);
  if (!(Math.abs(Number((cached.热量 || '').replace(/[^0-9.]/g, '')) - 280) <= 2)) problems.push(`命中「我的食物」后应当 140×2=280 kcal，实际「${cached.热量}」`);
  if (!cached.说明.includes('你之前存的')) problems.push(`命中自己存的食物时要说明，实际「${cached.说明}」`);
  if (!cached.来源.includes('之前存过的食物')) problems.push(`来源要写清「用的是你之前存过的食物」，实际「${cached.来源}」`);
  if (cached.我的食物条数 !== 1) problems.push(`同名不该重复存，实际 ${cached.我的食物条数} 条`);
  const cachedChats = hits.chat - chatsBeforeCached;
  console.log(`   这次新增 AI 请求：${cachedChats} 次`);
  if (cachedChats !== 0) problems.push(`只涉及之前存过的菜，却又发了 ${cachedChats} 次 AI 请求（说好的省请求呢）`);
  await evaluate(`document.querySelector('#draftCancel')?.click(); true`);
  await sleep(300);

  console.log('\n=== 三·二、切到普通模式后，真的不再发请求（「不花钱」得由代码兑现）===');
  // 这条守的是真事故级问题：模式以前只改文案，配过密钥后切到普通模式照样调 AI。
  const beforeChats = hits.chat;
  const modeStateBefore = await evaluate(`window.__appState || null`);
  if (!modeStateBefore || modeStateBefore.mode !== 'ai') problems.push(`配好密钥后应当自动进 AI 模式，实际 ${JSON.stringify(modeStateBefore)}`);

  await evaluate(`document.querySelector('#usageModeBtn')?.click()`);
  await sleep(350);
  await evaluate(`document.querySelector('#usageModeChips [data-usage-mode="basic"]')?.click()`);
  await sleep(500);
  const afterSwitch = await evaluate(`window.__appState || null`);
  console.log(`   切到普通模式 → mode=${afterSwitch?.mode}｜aiConfigured=${afterSwitch?.aiConfigured}`);
  if (afterSwitch?.mode !== 'basic') problems.push('点了「普通模式」但状态没变');

  // 再解析一句（离线认识的说法），应当完全不发请求
  await evaluate(`(() => {
    const ta = document.querySelector('#quickText');
    ta.value = '中午吃了碗牛肉面';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#quickParse').click();
  })()`);
  await sleep(2500);
  const basicParse = await evaluate(`(() => ({
    方式: document.querySelector('#draftHost .warn')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 24) || '',
    条数: document.querySelectorAll('#draftHost .entry').length,
  }))()`);
  const chatsInBasic = hits.chat - beforeChats;
  console.log(`   普通模式解析：${basicParse.条数} 条｜来源「${basicParse.方式}」｜新增请求 ${chatsInBasic} 次`);
  if (chatsInBasic !== 0) problems.push(`普通模式下还发了 ${chatsInBasic} 次请求（说好的不联网不花钱呢）`);
  if (!basicParse.条数) problems.push('普通模式下离线解析也没认出来（切模式不能把功能弄坏）');
  if (/AI 认出来的/.test(basicParse.方式)) problems.push('普通模式下结果来源还被标成 AI 认出来的');

  // v35（issue #13）：认出一部分、还有没认出来的字 —— 要提示，不能一声不响让用户以为整句都记上了
  await evaluate(`(() => {
    const ta = document.querySelector('#quickText');
    ta.value = '中午吃了红烧肉和一份佛跳墙';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#quickParse').click();
  })()`);
  await sleep(1200);
  const partial = await evaluate(`(() => ({
    条数: document.querySelectorAll('#draftHost .entry').length,
    提示: [...document.querySelectorAll('#draftHost .warn')].map((w) => w.textContent.replace(/\\s+/g, ' ').trim()).join(' | '),
  }))()`);
  console.log(`   部分漏识别 → ${partial.条数} 条｜提示「${partial.提示.slice(0, 70)}」`);
  if (partial.条数 < 1) problems.push('只认出一部分时，认出的那条也应该能记上');
  if (!partial.提示.includes('佛跳墙')) problems.push('没认出来的「佛跳墙」没有被提示出来（会以为整句都记上了）');
  await evaluate(`document.querySelector('#draftCancel')?.click(); document.querySelector('#sheetClose')?.click(); true`);
  await sleep(300);

  // 切回 AI 模式，后面的教练用例还要用
  await evaluate(`document.querySelector('#usageModeBtn')?.click()`);
  await sleep(350);
  await evaluate(`document.querySelector('#usageModeChips [data-usage-mode="ai"]')?.click()`);
  await sleep(450);
  const backToAi = await evaluate(`window.__appState?.mode || null`);
  if (backToAi !== 'ai') problems.push('切不回 AI 模式');

  console.log('\n=== 四、教练：AI 只组织语言，数字本地算 ===');
  await evaluate(`document.querySelector('.tab[data-view="today"]')?.click()`);
  await sleep(400);
  // 刚才记了一笔会弹「第一次记录」的庆祝层，先关掉，不然截图和点击都被它挡着
  await evaluate(`document.querySelector('#celebrateOk')?.click()`);
  await sleep(300);
  await evaluate(`document.querySelector('[data-act="coach"]')?.click()`);
  await sleep(400);
  const coachLocal = await evaluate(`(() => ({
    标题: document.querySelector('#sheetTitle')?.textContent || '',
    正文: document.querySelector('#sheetBody')?.textContent.replace(/\\s+/g, ' ').trim() || '',
    有AI按钮: !!document.querySelector('[data-coach="ai"]'),
  }))()`);
  console.log(`本地版 → 「${coachLocal.标题}」｜${coachLocal.正文.slice(0, 90)}…`);
  if (!coachLocal.标题.includes('教练')) problems.push('教练弹层没打开');
  if (!coachLocal.有AI按钮) problems.push('配了 AI 却没有「让 AI 说细一点」的按钮');

  await evaluate(`document.querySelector('[data-coach="ai"]')?.click()`);
  await sleep(1500);
  const coachAi = await evaluate(`(() => {
    const body = document.querySelector('#sheetBody')?.textContent.replace(/\\s+/g, ' ').trim() || '';
    return { 正文: body, 用AI版: body.includes('教练说的'), 没接上: body.includes('没接上') };
  })()`);
  console.log(`AI 版 → ${coachAi.正文.slice(0, 100)}…`);
  if (hits.coach < 1) problems.push('点了「让 AI 说细一点」却没有真的发请求');
  if (coachAi.没接上) problems.push(`AI 教练这条链路没通：${coachAi.正文.slice(0, 80)}`);
  if (!coachAi.用AI版) problems.push('AI 教练的结果没有显示出来');

  const shotCoachAi = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-coach-ai.png'), Buffer.from(shotCoachAi.data, 'base64'));

  // 第二次：模型编了一个清单外的数字（999），必须整段退回本地版，不能给用户看
  await evaluate(`document.querySelector('[data-coach="ai"]')?.click()`);
  await sleep(1500);
  const coachBad = await evaluate(`(() => {
    const body = document.querySelector('#sheetBody')?.textContent.replace(/\\s+/g, ' ').trim() || '';
    return {
      正文: body,
      有数字校验提示: body.includes('数字对不上'),
      提示点出999: body.includes('999'),
      显示本地版: body.includes('按你今天的记录算的'),
      显示了编的话: body.includes('随便吃'),
    };
  })()`);
  console.log(`编数字那次 → ${coachBad.正文.slice(0, 90)}…`);
  if (hits.coach < 2) problems.push('第二次「让 AI 说」没有发请求');
  if (!coachBad.有数字校验提示) problems.push('AI 编了清单外的数字，界面没有提示已换成本地版');
  if (!coachBad.显示本地版) problems.push('AI 编数字后没有退回本地建议');
  if (coachBad.显示了编的话) problems.push('AI 编的那段话被显示出来了（数字校验没生效）');
  if (!coachBad.提示点出999) problems.push('退回本地版时没说清是哪个数字对不上');
  await evaluate(`document.querySelector('#sheetClose')?.click()`);
  await sleep(300);

  console.log('\n=== 四·二、今天页「顺手做两件事」（v36，issue #14 A） ===');
  await evaluate(`document.querySelector('.tab[data-view="today"]')?.click()`);
  await sleep(600);
  const stepsUi = await evaluate(`(() => {
    const card = document.querySelector('#app .card.steps');
    const rows = [...document.querySelectorAll('#app .card.steps .step')];
    return {
      有卡片: !!card,
      标题: card?.querySelector('.card-title')?.textContent.replace(/\\s+/g, ' ').trim() || '',
      条数: rows.length,
      标题们: rows.map((r) => r.querySelector('b')?.textContent.trim() || ''),
      有按钮: rows.filter((r) => r.querySelector('[data-act]')).length,
      文案: rows.map((r) => r.textContent.replace(/\\s+/g, ' ').trim()).join(' | '),
    };
  })()`);
  console.log('今天页两件事 →', JSON.stringify(stepsUi));
  const shotSteps = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-today-steps.png'), Buffer.from(shotSteps.data, 'base64'));
  if (!stepsUi.有卡片) problems.push('今天页没有「顺手做两件事」卡片（这轮的功能没出现）');
  if (!(stepsUi.条数 >= 1 && stepsUi.条数 <= 2)) problems.push(`两件事卡片应当是 1~2 条，实际 ${stepsUi.条数} 条`);
  if (!stepsUi.标题.includes('顺手做')) problems.push(`卡片标题不对：${stepsUi.标题}`);
  if (/应该|必须|失败|差劲/.test(stepsUi.文案)) problems.push('两件事的文案在指责/施压');
  const act = await evaluate(`(() => {
    const btn = document.querySelector('#app .card.steps .step [data-act]');
    if (!btn) return { 有按钮: false, act: null };
    const a = btn.dataset.act;
    btn.click();
    return { 有按钮: true, act: a };
  })()`);
  await sleep(700);
  const acted = await evaluate(`(() => ({
    说一句入口: !!document.querySelector('#quickText'),
    弹层开着: !document.querySelector('#sheetRoot').classList.contains('hidden'),
    输入框字数: (document.querySelector('#quickText')?.value || '').length,
  }))()`);
  console.log(`   点第一条（${act.act}）→`, JSON.stringify(acted));
  if (act.有按钮 && !acted.说一句入口 && !acted.弹层开着) problems.push(`点了「${act.act}」没有任何反应`);
  await evaluate(`document.querySelector('#sheetClose')?.click(); document.querySelector('.tab[data-view="today"]')?.click(); true`);
  await sleep(300);

  console.log('\n=== 四·三、最近 30 天回顾（v38，issue #14 C） ===');
  // 先补几天历史（含体重），否则回顾只有「先记几天」；然后重开页面，走真实入口
  await evaluate(`(async () => {
    const store = await import('./js/store.js');
    const foods = await import('./js/foods.js');
    const s = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    for (let i = 1; i <= 6; i++) {
      const key = store.shiftDate(store.todayKey(), -i);
      store.addFoodEntry(s, key, 'lunch', foods.findFood('rice_cooked'), 150);
      store.addFoodEntry(s, key, 'dinner', foods.findFood('chicken_breast_cooked'), 200);
    }
    store.addWeight(s, store.shiftDate(store.todayKey(), -20), 58.4);
    store.addWeight(s, store.todayKey(), 57.8);
    localStorage.setItem('fatloss.state.v2', JSON.stringify(s));
    return true;
  })()`);
  await evaluate(`location.reload()`);
  await sleep(2200);
  await evaluate(`document.querySelector('[data-act="growth"]')?.click()`);
  await sleep(500);
  const growthHasRecap = await evaluate(`!!document.querySelector('#openRecap')`);
  if (!growthHasRecap) problems.push('成长弹层里没有「看最近 30 天的回顾」入口');
  await evaluate(`document.querySelector('#openRecap')?.click()`);
  await sleep(500);
  const recapUi = await evaluate(`(() => {
    const body = document.querySelector('#sheetBody');
    const tiles = [...body.querySelectorAll('.recap-tile b')].map((b) => b.textContent.trim());
    return {
      标题: document.querySelector('#sheetTitle')?.textContent.trim() || '',
      统计: tiles,
      格子数: body.querySelectorAll('.recap-dots span').length,
      亮着的: body.querySelectorAll('.recap-dots span.on').length,
      说明: [...body.querySelectorAll('.warn.info div')].map((d) => d.textContent.replace(/\\s+/g, ' ').trim()).join(' ｜ '),
      常吃的: body.querySelectorAll('.set-note').length,
    };
  })()`);
  console.log('回顾弹层 →', JSON.stringify(recapUi));
  const shotRecap = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-recap.png'), Buffer.from(shotRecap.data, 'base64'));
  if (!recapUi.标题.includes('回顾')) problems.push(`回顾弹层标题不对：${recapUi.标题}`);
  if (recapUi.统计.length !== 4) problems.push(`回顾的统计块应当 4 个，实际 ${recapUi.统计.length} 个`);
  if (!(Number((recapUi.统计[0] || '0').replace(/[^0-9]/g, '')) >= 7)) problems.push(`回顾里的记录天数不对：${recapUi.统计[0]}`);
  if (recapUi.格子数 !== 30) problems.push(`30 天点亮条应当是 30 格，实际 ${recapUi.格子数} 格`);
  if (!(recapUi.亮着的 >= 7)) problems.push(`点亮条至少该亮 7 天，实际 ${recapUi.亮着的} 天`);
  if (!/这 30 天里.*记了/.test(recapUi.说明)) problems.push('回顾没有说清这段时间记了几天');
  if (/应该|必须|失败|吃多了|自律|加油/.test(recapUi.说明)) problems.push('回顾文案在评判/施压');
  await evaluate(`document.querySelector('#sheetClose')?.click(); document.querySelector('.tab[data-view="today"]')?.click(); true`);
  await sleep(300);

  console.log('\n=== 五、日历与日期选择 ===');
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

  console.log('\n=== 六、覆盖类操作不能悄悄丢记录（v33） ===');
  // 造一份「有记录」的存档：演示/导入都会整包替换，覆盖前必须先问、先留快照
  const seeded = await evaluate(`(async () => {
    const store = await import('./js/store.js');
    const s = JSON.parse(localStorage.getItem('fatloss.state.v2') || 'null') || store.emptyState();
    store.addFoodEntry(s, store.todayKey(), 'lunch',
      { id: 'qa-rice', name: 'QA测试米饭', kcal: 130, protein: 2.5, fat: 0.3, carb: 28 }, 150);
    localStorage.setItem('fatloss.state.v2', JSON.stringify(s));
    localStorage.removeItem('fatloss.backup');
    return JSON.parse(localStorage.getItem('fatloss.state.v2')).days[store.todayKey()].meals.lunch.length;
  })()`);
  console.log('造好一份带记录的存档，午餐条数：', seeded);

  await client.send('Page.navigate', { url: BASE + '/?demo=1' });
  await sleep(1600);
  const guard = await evaluate(`(() => ({
    弹出确认: !document.querySelector('#sheetRoot').classList.contains('hidden'),
    标题: document.querySelector('#sheetTitle')?.textContent || '',
    记录还在: (localStorage.getItem('fatloss.state.v2') || '').includes('QA测试米饭'),
    有按钮: [...document.querySelectorAll('#sheetFoot button')].map((b) => b.id),
  }))()`);
  console.log('?demo=1 有记录时 →', JSON.stringify(guard));
  if (!guard.弹出确认) problems.push('有记录时打开 ?demo=1 没有先确认，记录会被直接覆盖');
  if (!guard.标题.includes('覆盖')) problems.push(`演示确认的标题没说清会覆盖：${guard.标题}`);
  if (!guard.记录还在) problems.push('演示确认之前记录就已经被覆盖了');
  if (!guard.有按钮.includes('demoGo')) problems.push('演示确认缺少「留快照并看演示」按钮');

  // 取消后不能有任何改动
  await evaluate(`document.querySelector('#demoCancel')?.click()`);
  await sleep(500);
  const cancelled = await evaluate(`(() => ({
    面板关掉了: document.querySelector('#sheetRoot').classList.contains('hidden'),
    记录还在: (localStorage.getItem('fatloss.state.v2') || '').includes('QA测试米饭'),
  }))()`);
  console.log('点取消 →', JSON.stringify(cancelled));
  if (!cancelled.面板关掉了) problems.push('演示确认点取消后面板没关');
  if (!cancelled.记录还在) problems.push('演示确认点取消后记录却变了');

  // 确认之后：先留快照，再换演示数据
  await client.send('Page.navigate', { url: BASE + '/?demo=1' });
  await sleep(1600);
  await evaluate(`document.querySelector('#demoGo')?.click()`);
  await sleep(900);
  const demoApplied = await evaluate(`(() => {
    const raw = localStorage.getItem('fatloss.state.v2') || '';
    const backupRaw = localStorage.getItem('fatloss.backup') || '{}';
    let note = '';
    try { note = JSON.parse(backupRaw).note || ''; } catch {}
    return {
      换成了演示: !raw.includes('QA测试米饭'),
      快照有原记录: backupRaw.includes('QA测试米饭'),
      快照说明: note,
    };
  })()`);
  console.log('确认看演示 →', JSON.stringify(demoApplied));
  if (!demoApplied.换成了演示) problems.push('确认之后没有进入演示数据');
  if (!demoApplied.快照有原记录) problems.push('看演示覆盖了记录，却没有留下快照（找不回来）');
  if (!/演示/.test(demoApplied.快照说明)) problems.push(`快照说明没写清来源：${demoApplied.快照说明}`);

  console.log('\n=== 六·二、两个窗口同时开：不能互相盖掉 ===');
  const sync = await evaluate(`(async () => {
    const store = await import('./js/store.js');
    const s = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    store.addFoodEntry(s, store.todayKey(), 'dinner',
      { id: 'qa-leg', name: '另一个窗口的鸡腿', kcal: 190, protein: 20, fat: 11, carb: 0 }, 100);
    const json = JSON.stringify(s);
    localStorage.setItem('fatloss.state.v2', json);
    const before = document.querySelector('#app').textContent.includes('另一个窗口的鸡腿');
    window.dispatchEvent(new StorageEvent('storage', { key: 'fatloss.state.v2', newValue: json }));
    await new Promise((r) => setTimeout(r, 700));
    return {
      同步前页面有没有: before,
      同步后页面有没有: document.querySelector('#app').textContent.includes('另一个窗口的鸡腿'),
    };
  })()`);
  console.log('另一个窗口写入（空闲时）→', JSON.stringify(sync));
  if (sync.同步后页面有没有 !== true) problems.push('别的窗口改记录后，本页没有同步（下次保存会把它盖掉）');

  const conflict = await evaluate(`(async () => {
    const store = await import('./js/store.js');
    const s = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    store.addFoodEntry(s, store.todayKey(), 'snack',
      { id: 'qa-other', name: '另一个窗口的新记录', kcal: 88, protein: 1, fat: 1, carb: 18 }, 100);
    const otherRaw = JSON.stringify(s);
    // 直接写存储、不派发事件：模拟「事件没送到」的窗口 —— 本页内存里还是旧的
    localStorage.setItem('fatloss.state.v2', otherRaw);
    document.querySelector('[data-view="progress"]').click();
    await new Promise((r) => setTimeout(r, 600));
    const btn = document.querySelector('[data-act="log-weight"]');
    const hasBtn = !!btn;
    btn?.click();
    await new Promise((r) => setTimeout(r, 500));
    const input = document.querySelector('#wInput');
    const sheetOpen = !document.querySelector('#sheetRoot').classList.contains('hidden');
    if (input) {
      input.value = '60.1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const inputNow = document.querySelector('#wInput')?.value;
    document.querySelector('#wSave')?.click();
    await new Promise((r) => setTimeout(r, 900));
    const rawAfter = localStorage.getItem('fatloss.state.v2') || '';
    const toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ');
    return {
      按到按钮: hasBtn,
      面板开着: sheetOpen,
      输入框值: inputNow,
      存储里还有对方记录: rawAfter.includes('另一个窗口的新记录'),
      我们的体重没写进去: !rawAfter.includes('60.1'),
      提示: toasts.slice(0, 140),
    };
  })()`);
  console.log('另一个窗口写过、本页再保存 →', JSON.stringify(conflict));
  if (!conflict.存储里还有对方记录) problems.push('别的窗口写过记录后，本页保存把它整个盖掉了');
  if (!conflict.我们的体重没写进去) problems.push('本页用旧数据保存成功 —— 应该让路而不是覆盖');
  if (!/没记上/.test(conflict.提示)) problems.push('保存被另一个窗口的数据挡住时，没有说清「这一笔没记上」');

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
  finishAndExit(process.exitCode || 0, [() => client.close(), () => chrome.kill(), () => fake.close(), () => staticServer.close()]);
}

armWatchdog('direct-check.mjs', 400);

// 失败路径也必须收尾：只设 exitCode 的话进程会一直挂着（被看门狗杀掉 → 退出码又变了）
main().catch((err, cleanup) => {
  console.error(`自检失败：${err.message}`);
  finishAndExit(1, Array.isArray(cleanup) ? cleanup : []);
});
process.on('uncaughtException', (err) => {
  console.error(`自检异常：${err.message}`);
  finishAndExit(1);
});
