/**
 * 真浏览器自检工具（开发用，不参与线上运行）
 *
 *  1) 用无头 Chrome 打开页面，通过 Chrome 调试协议收集：
 *     控制台报错、元素真实尺寸、是否横向溢出、弹层能否正常打开；
 *  2) 在 390×844（常见手机）和 360×640（小屏）两种尺寸下各跑一遍；
 *  3) 截图存到 .selfcheck/ 目录，方便肉眼确认。
 *
 * 用法：先 `node tools/serve.mjs 4173`，再 `node tools/browser-check.mjs`
 */

import { spawn, execSync } from 'node:child_process';
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
const PORT = 9333;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';

/**
 * 等本地服务真的能响应再开始。
 * CI 上服务是后台起的，偶尔还没监听就开始跑，会报 "fetch failed"（踩过）。
 */
async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/', { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (err) { lastErr = err.message; }
    await sleep(700);
  }
  throw new Error(`本地服务在 ${timeoutMs / 1000} 秒内没有响应（${BASE}）：${lastErr}`);
}

const SIZES = [
  { name: 'phone', width: 390, height: 844, dpr: 1 },
  { name: 'small', width: 360, height: 640, dpr: 1 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等 Chrome 的调试端口真正可用（最多 30 秒）。
 * 之前这里只读一次，失败就直接抛错 —— 遇到「上一个 Chrome 没退干净」时表现千奇百怪。
 */
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
  throw new Error(`无头 Chrome 在 ${timeoutMs / 1000} 秒内没能响应（端口 ${port}）：${lastErr}`);
}

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
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
      errors: [],
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
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        ERROR_BUCKET.push(text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        ERROR_BUCKET.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      }
    });
  });
}

let ERROR_BUCKET = [];

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

const DIAGNOSTIC = `(() => {
  const de = document.documentElement;
  const overflowing = [...document.querySelectorAll('body *')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > window.innerWidth + 0.6 || r.left < -0.6);
    })
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName, cls: el.className, text: (el.textContent || '').trim().slice(0, 18), left: Math.round(r.left), right: Math.round(r.right) };
    });
  const notVisible = [...document.querySelectorAll('.tabbar .tab')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width <= 0 || r.height <= 0; })
    .map((el) => el.textContent.trim());
  const cutOff = [...document.querySelectorAll('button, .btn, .chip, .tabbar, .card')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > window.innerWidth + 0.6 || r.left < -0.6);
    })
    .map((el) => (el.textContent || el.tagName).trim().slice(0, 20));
  const cards = [...document.querySelectorAll('.card')].map((el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
  });
  return {
    appReady: window.__appReady === true,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    docScrollWidth: de.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    horizontalOverflow: de.scrollWidth > window.innerWidth + 1,
    overflowing: overflowing.slice(0, 8),
    notVisible,
    cutOff: [...new Set(cutOff)].slice(0, 8),
    cards: cards.slice(0, 6),
    cardCount: cards.length,
    hasConsoleErrors: null,
  };
})()`;

async function main() {
  await waitForServer();
  fs.mkdirSync(outDir, { recursive: true });
  // 先把调试端口清干净：上一次没退干净的 Chrome 会占着端口，
  // 新实例静默失败、等待循环却连上僵尸端口 —— 表现为「只有第一个脚本能过」。
  await freePortAndWait(PORT);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(outDir, 'chrome-profile')}`,
    '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });

  // 等调试端口起来
  // 等 Chrome 真的能响应。等不到就明确失败 —— 不要拿着坏端口继续往下跑。
  // 注意：startPort 上的 Chrome 可能启动失败（比如 profile 目录还锁着），
  // 所以这里每一步都带重试，并且报错要带上原因。
  const version = await waitForChromeVersion(PORT);
  if (!version?.Browser) throw new Error(`无头 Chrome 没起来（端口 ${PORT} 没响应）`);
  console.log('浏览器：', version.Browser);

  const report = { base: BASE, sizes: [] };

  for (const size of SIZES) {
    ERROR_BUCKET = [];
    const target = await getJson(`http://127.0.0.1:${PORT}/json/new?about:blank`).catch(async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
      return res.json();
    });
    const client = await connect(target.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: size.width, height: size.height, deviceScaleFactor: size.dpr, mobile: true,
    });

    const entry = { size: size.name, viewport: `${size.width}x${size.height}`, steps: [] };

    // 第一步：清掉上一次跑留下的 Service Worker 和缓存，保证测到的是最新文件
    await client.send('Page.navigate', { url: BASE + '/' });
    await sleep(800);
    await evaluate(client, `(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
      localStorage.clear();
      return true;
    })()`);
    await client.send('Page.navigate', { url: BASE + '/' });
    await sleep(1500);
    await evaluate(client, `(async () => {
      // 再清一次：上一步加载时 Service Worker 可能又注册上了
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
      localStorage.clear();
      return true;
    })()`);
    await client.send('Page.navigate', { url: BASE + '/' });
    await sleep(1500);
    entry.steps.push({ at: '首次进入', ...(await evaluate(client, DIAGNOSTIC)) });
    await screenshot(client, path.join(outDir, `shot-${size.name}-1-welcome.png`));

    // 第二步：点「看一个填好的例子」→ 今天页
    await evaluate(client, `document.querySelector('[data-act="demo"]').click()`);
    await sleep(500);
    entry.steps.push({ at: '示例数据·今天页', ...(await evaluate(client, DIAGNOSTIC)) });
    await screenshot(client, path.join(outDir, `shot-${size.name}-2-today.png`));

    // 第三步：打开「加食物」弹层并搜索
    await evaluate(client, `document.querySelector('[data-act="add-food"]').click()`);
    await sleep(400);
    const sheetOpen = await evaluate(client, `!document.querySelector('#sheetRoot').classList.contains('hidden')`);
    const searchWorks = await evaluate(client, `(() => {
      const inp = document.querySelector('#foodSearch');
      inp.value = '鸡胸';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const hits = [...document.querySelectorAll('#foodResults [data-pick]')];
      // v31：组合菜（以前只在离线解析表里，搜索/AI 都看不见）现在也搜得到
      inp.value = '馄饨';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const dishHits = [...document.querySelectorAll('#foodResults [data-pick] .nm')].map((x) => x.textContent.trim());
      inp.value = '鸡胸';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        结果数: hits.length,
        排序: hits.map((h) => h.querySelector('.nm')?.textContent.trim().replace(/\s+/g, ' ') || h.textContent.trim().slice(0, 12)).slice(0, 4),
        搜馄饨: dishHits.slice(0, 3),
      };
    })()`);
    await screenshot(client, path.join(outDir, `shot-${size.name}-3-search.png`));

    // 第四步：选一条食物 → 份量弹层 → 确认加入
    await evaluate(client, `document.querySelector('#foodResults [data-pick]').click()`);
    await sleep(300);
    const amountPreview = await evaluate(client, `document.querySelector('#amountPreview').textContent.trim()`);
    await screenshot(client, path.join(outDir, `shot-${size.name}-4-amount.png`));
    await evaluate(client, `document.querySelector('#confirmAmount').click()`);
    await sleep(400);
    const afterAdd = await evaluate(client, `(() => {
      const raw = localStorage.getItem('fatloss.state.v2');
      const st = JSON.parse(raw);
      const today = Object.keys(st.days)[0];
      const meals = st.days[today].meals;
      const all = Object.values(meals).flat();
      return {
        记录条数: all.length,
        最近一条: all[all.length - 1] ? all[all.length - 1].food.name + ' ' + all[all.length - 1].grams + 'g (' + all[all.length - 1].meal + ')' : null,
        弹层已关闭: document.querySelector('#sheetRoot').classList.contains('hidden'),
      };
    })()`);

    // 第四步半（v31）：AI 认出来了、但本地库里没有的菜 —— 必须按同类均值先记上，
    // 标明「按同类估算」、能删；不能再出现「一条都记不上」的死胡同。
    // 用 CDP 拦住 chat/completions 请求，喂一份「黄焖鸡米饭 + 库里没有的菜」的假返回。
    const fakeAiBody = JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            meal: 'lunch',
            items: [
              { name: '黄焖鸡米饭', grams: 550 },
              { name: '外婆家秘制扣肉', grams: 180 },
              { name: '某网红限定轻食碗', grams: 300 },
            ],
            questions: [],
          }),
        },
      }],
    });
    await evaluate(client, `(() => {
      const raw = JSON.parse(localStorage.getItem('fatloss.state.v2'));
      raw.settings = { ...(raw.settings || {}), mode: 'ai' };
      localStorage.setItem('fatloss.state.v2', JSON.stringify(raw));
      localStorage.setItem('fatloss.ai.v1', JSON.stringify({
        presetId: 'custom', baseUrl: location.origin + '/fake-ai/v1',
        model: 'fake-model', apiKey: 'sk-fake-for-browser-check', mode: 'direct', // secret-scan:allow 假密钥（只发给本地假服务商）
        updatedAt: new Date().toISOString(),
      }));
    })()`);
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*chat/completions*', requestStage: 'Request' }] });
    client.on('Fetch.requestPaused', (p) => {
      if (p.request.url.includes('chat/completions')) {
        client.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: '*' },
            { name: 'Access-Control-Allow-Headers', value: 'authorization,content-type' },
            { name: 'Access-Control-Allow-Methods', value: 'POST,OPTIONS' },
          ],
          body: Buffer.from(fakeAiBody).toString('base64'),
        }).catch(() => { /* 请求可能已经结束 */ });
      } else {
        client.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => { /* 同上 */ });
      }
    });
    await evaluate(client, 'location.reload()');
    await sleep(1600);
    await evaluate(client, `document.querySelector('.tab[data-view="log"]').click()`);
    await sleep(400);
    await evaluate(client, `(() => {
      const ta = document.querySelector('#quickText');
      ta.value = '中午吃了黄焖鸡米饭、外婆家秘制扣肉和某网红限定轻食碗';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#quickParse').click();
    })()`);
    await sleep(1200);
    const aiFallback = await evaluate(client, `(() => {
      const rows = [...document.querySelectorAll('#draftHost .entry')];
      const est = rows.filter((r) => (r.querySelector('.tag.amber')?.textContent || '').includes('估算'));
      return {
        弹层标题: document.querySelector('#sheetTitle')?.textContent || '',
        行数: rows.length,
        估算行数: est.length,
        估算说明: est.map((r) => r.querySelector('.draft-note')?.textContent.trim().slice(0, 60) || '').slice(0, 2),
        有删除按钮: document.querySelectorAll('#draftHost .entry [data-del]').length,
        合计文本: (document.querySelector('#draftHost .row.between.small')?.textContent || '').replace(/\s+/g, ' ').trim(),
      };
    })()`);
    await screenshot(client, path.join(outDir, `shot-${size.name}-10-ai-fallback.png`));
    // 删掉一条估算条目 → 行数和合计都要跟着变（不能只是视觉上隐藏）
    await evaluate(client, `document.querySelector('#draftHost .entry [data-del]').click()`);
    await sleep(300);
    const aiFallbackAfterDel = await evaluate(client, `(() => ({
      行数: document.querySelectorAll('#draftHost .entry').length,
      合计: (document.querySelector('#draftHost .row.between.small')?.textContent || '').replace(/\s+/g, ' ').trim(),
    }))()`);
    // 存下来：估算条目也要能落库（记 0 条才是失败的）
    await evaluate(client, `document.querySelector('#draftSave')?.click()`);
    await sleep(500);
    const aiFallbackSaved = await evaluate(client, `(() => {
      const st = JSON.parse(localStorage.getItem('fatloss.state.v2'));
      const today = st.days[Object.keys(st.days).sort().pop()];
      const all = Object.values(today.meals).flat();
      return { 条数: all.length, 名字: all.map((e) => e.food.name).slice(0, 6) };
    })()`);
    await client.send('Fetch.disable').catch(() => { /* 已经关了 */ });
    await evaluate(client, `(() => {
      localStorage.removeItem('fatloss.ai.v1');
      const raw = JSON.parse(localStorage.getItem('fatloss.state.v2'));
      raw.settings = { ...(raw.settings || {}), mode: 'basic' };
      localStorage.setItem('fatloss.state.v2', JSON.stringify(raw));
    })()`);
    await evaluate(client, 'location.reload()');
    await sleep(1400);

    // 第四步半之二（v31）：整句都没认出来时不许死胡同 —— 有例句、能点、能回到「说一句」。
    await evaluate(client, `document.querySelector('.tab[data-view="log"]').click()`);
    await sleep(400);
    await evaluate(client, `(() => {
      const ta = document.querySelector('#quickText');
      ta.value = '今天吃了佛跳墙';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#quickParse').click();
    })()`);
    await sleep(900);
    const deadEnd = await evaluate(client, `(() => ({
      标题: document.querySelector('#sheetTitle')?.textContent || '',
      例句数: document.querySelectorAll('#draftHost [data-example]').length,
      有手动: Boolean(document.querySelector('#draftManual')),
      有返回: Boolean(document.querySelector('#draftAgain')),
      文案: (document.querySelector('#draftHost')?.innerText || '').replace(/\s+/g, ' ').slice(0, 80),
    }))()`);
    await screenshot(client, path.join(outDir, `shot-${size.name}-11-deadend.png`));
    await evaluate(client, `document.querySelector('#draftHost [data-example]').click()`);
    await sleep(400);
    const deadEndAfter = await evaluate(client, `(() => ({
      // 记录页有自己的大输入框：点例句应该把例句填回那个框、弹层关掉。
      // （从「今天」页的加食物弹层进来时没有 #quickText，会重新打开「说一句」并把文字填好。）
      例句填进去了: (document.querySelector('#quickText')?.value || '').slice(0, 30),
      弹层关了: document.querySelector('#sheetRoot').classList.contains('hidden'),
    }))()`);

    // 第五步：四个标签页都点一遍
    const tabs = {};
    for (const view of ['log', 'plan', 'progress', 'today']) {
      await evaluate(client, `document.querySelector('.tab[data-view="${view}"]').click()`);
      await sleep(350);
      tabs[view] = await evaluate(client, `document.querySelectorAll('#app .card').length`);
      await screenshot(client, path.join(outDir, `shot-${size.name}-tab-${view}.png`));
    }

    // 第五步一：图标系统（issue #9）—— 界面上不该再有 emoji，图标不许有兜底方块/缺尺寸
    await evaluate(client, `document.querySelector('.tab[data-view="today"]').click()`);
    await sleep(350);
    const iconAudit = await evaluate(client, `(() => {
      const EMOJI = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/u;
      const lines = (document.body.innerText || '').split('\\n').map((x) => x.trim()).filter(Boolean);
      const badLines = lines.filter((l) => EMOJI.test(l)).slice(0, 6);
      const svgs = [...document.querySelectorAll('svg.icon')];
      return {
        图标数: svgs.length,
        兜底方块: svgs.filter((s) => s.dataset.kind === 'fallback').map((s) => s.dataset.icon),
        缺尺寸: svgs.filter((s) => !s.getAttribute('width') || !s.getAttribute('height')).length,
        emoji行: badLines,
      };
    })()`);

    // 成长弹层（植物插画 + 徽章墙）
    await evaluate(client, `document.querySelector('[data-act="growth"]')?.click()`);
    await sleep(400);
    const growth = await evaluate(client, `(() => {
      const achSvgs = [...document.querySelectorAll('.ach-icon svg.icon[data-kind="badge"]')];
      return {
        标题: document.querySelector('#sheetTitle')?.textContent || '',
        植物: document.querySelectorAll('.plant-art svg.icon[data-kind="plant"]').length,
        徽章图标: achSvgs.length,
        徽章尺寸: achSvgs.length ? Math.min(...achSvgs.map((s) => Number(s.getAttribute('width')) || 0)) : 0,
        标签数: [...document.querySelectorAll('.ach-name')].filter((x) => x.textContent.trim()).length,
        空标签: [...document.querySelectorAll('.ach-name')].filter((x) => !x.textContent.trim()).length,
        未解锁: document.querySelectorAll('[data-ach]:not(.on)').length,
        锁标: document.querySelectorAll('.ach-lock').length,
        兜底: [...document.querySelectorAll('#sheetBody svg.icon[data-kind="fallback"]')].length,
      };
    })()`);
    await screenshot(client, path.join(outDir, `shot-${size.name}-6-growth.png`));
    await evaluate(client, `document.querySelector('#sheetClose')?.click()`);
    await sleep(300);

    // 设置页（一排图标）
    await evaluate(client, `document.querySelector('#profileBtn')?.click()`);
    await sleep(400);
    const settings = await evaluate(client, `(() => {
      const tiles = [...document.querySelectorAll('#sheetBody .set-ico')];
      const svgs = tiles.map((t) => t.querySelector('svg.icon')).filter(Boolean);
      return {
        图标: svgs.length,
        行数: document.querySelectorAll('#sheetBody .set-row').length,
        图标尺寸: svgs.length ? Math.min(...svgs.map((s) => Number(s.getAttribute('width')) || 0)) : 0,
        图标块最小: tiles.length ? Math.round(Math.min(...tiles.map((t) => t.getBoundingClientRect().width))) : 0,
        兜底: [...document.querySelectorAll('#sheetBody svg.icon[data-kind="fallback"]')].length,
      };
    })()`);
    await screenshot(client, path.join(outDir, `shot-${size.name}-7-settings.png`));

    // 第七步半：设置 → 关于 →「检查更新」（v29）——没新版时应明确说「已经是最新版本」，
    // 不能点了没反应（用户手动点的按钮必须给反馈）。
    await evaluate(client, `document.querySelector('#sheetBody [data-set="about"]')?.click()`);
    await sleep(400);
    await evaluate(client, `document.querySelector('#checkUpdate')?.click()`);
    await sleep(1100);
    const aboutCheck = await evaluate(client, `(() => ({
      有按钮: Boolean(document.querySelector('#checkUpdate')),
      版本行: (document.querySelector('#sheetBody')?.innerText || '').match(/界面代码：\\s*(v\\d+)/)?.[1] || '',
      提示: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()).join(' | '),
    }))()`);
    await evaluate(client, `document.querySelector('#sheetClose')?.click()`);
    await sleep(300);

    // 第八步：更新弹窗（v28）—— 造一个「用过、上次看到的是上一版」的存档，重开必须弹「更新了什么」。
    // 这是「每次更新完告诉用户改了什么」的入口：只弹一次、条目要真的渲染出来。
    await evaluate(client, `(() => {
      const raw = JSON.parse(localStorage.getItem('fatloss.state.v2'));
      raw.settings = { ...(raw.settings || {}), onboarded: true, lastSeenVersion: 'v27' };
      localStorage.setItem('fatloss.state.v2', JSON.stringify(raw));
      location.reload();
    })()`);
    await sleep(1600);
    const update = await evaluate(client, `(() => ({
      标题: document.querySelector('#sheetTitle')?.textContent || '',
      版本: document.querySelector('#sheetBody .update-ver')?.textContent.trim() || '',
      条目数: document.querySelectorAll('#sheetBody .update-list li').length,
      有按钮: Boolean(document.querySelector('#updateOk')),
    }))()`);
    await screenshot(client, path.join(outDir, `shot-${size.name}-8-update.png`));
    await evaluate(client, `document.querySelector('#updateOk')?.click()`);
    await sleep(300);

    // 第九步：刷新提醒弹窗 —— 用 CDP 拦截页面里的 sw.js 请求，返回一个「服务端版本更高」的副本，
    // 模拟「线上已经有新版」。这是 v28 之前唯一没有自动化 UI 断言的出口（真机靠人看），现在补上。
    const realSw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
    const curVer = (realSw.match(/const APP_VERSION = '([^']+)'/) || [])[1] || 'v1';
    const fakeVer = `v${Number(String(curVer).replace(/^v/, '')) + 1}`;
    const fakeSw = realSw.replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${fakeVer}';`);
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*sw.js*', requestStage: 'Request' }] });
    client.on('Fetch.requestPaused', (p) => {
      const isPageFetch = p.resourceType === 'Fetch' || p.resourceType === 'XHR';
      if (isPageFetch && p.request.url.includes('sw.js')) {
        client.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from(fakeSw).toString('base64'),
        }).catch(() => { /* 请求可能已经结束 */ });
      } else {
        client.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => { /* 同上 */ });
      }
    });
    await evaluate(client, 'location.reload()');
    await sleep(7000); // 启动 900ms + 更新检查 4s + 网络余量
    const refresh = await evaluate(client, `(() => ({
      标题: document.querySelector('#sheetTitle')?.textContent || '',
      正文: (document.querySelector('#sheetBody')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
      按钮: [...document.querySelectorAll('#sheetFoot .btn')].map((b) => b.textContent.trim()),
      假版本: ${JSON.stringify(fakeVer)},
    }))()`);
    await screenshot(client, path.join(outDir, `shot-${size.name}-9-refresh.png`));
    await evaluate(client, `document.querySelector('#reloadLater')?.click()`);
    await sleep(300);
    await client.send('Fetch.disable').catch(() => { /* 已经关了 */ });
    await evaluate(client, 'location.reload()');
    await sleep(1500);

    // 第五步半：PWA 清单能不能被浏览器正确解析（决定「添加到主屏幕」是否可用）
    const manifest = await evaluate(client, `(async () => {
      const res = await fetch('manifest.webmanifest');
      const m = await res.json();
      const sizes = [];
      for (const ic of m.icons || []) {
        const ok = await fetch(ic.src).then((r) => r.ok).catch(() => false);
        sizes.push(ic.sizes + (ok ? '✅' : '❌文件缺失'));
      }
      return { name: m.name, display: m.display, start_url: m.start_url, icons: sizes };
    })()`);

    // 第六步：资料弹层（把资料删掉后进入填写流程）
    await evaluate(client, `localStorage.clear(); location.reload();`);
    await sleep(1200);
    await evaluate(client, `document.querySelector('[data-act="edit-profile"]').click()`);
    await sleep(400);
    const profilePreview = await evaluate(client, `document.querySelector('#profilePreview').textContent.trim().slice(0, 80)`);
    await screenshot(client, path.join(outDir, `shot-${size.name}-5-profile.png`));

    entry.results = { sheetOpen, searchWorks, amountPreview, afterAdd, aiFallback, aiFallbackAfterDel, aiFallbackSaved, deadEnd, deadEndAfter, tabs, iconAudit, growth, settings, aboutCheck, update, refresh, profilePreview, manifest };
    entry.consoleErrors = ERROR_BUCKET.slice(0, 10);
    report.sizes.push(entry);
    client.close();
  }

  fs.writeFileSync(path.join(outDir, 'browser-report.json'), JSON.stringify(report, null, 2));
  clearTimeout(hardTimer);
  printReport(report);
  finishAndExit(process.exitCode || 0, [() => chrome.kill()]);
}

async function screenshot(client, file) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
}

function printReport(report) {
  let problems = 0;
  for (const s of report.sizes) {
    console.log(`\n──── ${s.size} (${s.viewport}) ────`);
    for (const step of s.steps) {
      const bad = step.horizontalOverflow || step.cutOff.length || step.notVisible.length || !step.appReady || step.cardCount === 0;
      if (bad) problems += 1;
      const why = [!step.appReady ? '模块没跑起来（白屏）' : '', step.cardCount === 0 ? '一个卡片都没渲染' : '',
        step.horizontalOverflow ? '横向溢出' : '', step.cutOff.length ? `${step.cutOff.length} 个元素跑出屏幕` : '',
        step.notVisible.length ? `${step.notVisible.length} 个标签不可见` : ''].filter(Boolean).join('、');
      console.log(`  ${bad ? `❌ ${why}` : '✅'} ${step.at}：卡片 ${step.cardCount} 个｜横向溢出 ${step.horizontalOverflow ? '有' : '无'}｜跑出屏幕的元素 ${step.cutOff.length} 个｜不可见标签 ${step.notVisible.length} 个`);
      if (step.overflowing.length) {
        for (const o of step.overflowing.slice(0, 4)) console.log(`       ↳ <${o.tag}> "${o.text}" left=${o.left} right=${o.right}（视口宽 ${step.viewport.split('x')[0]}）`);
      }
    }
    const r = s.results;
    console.log(`  弹层能打开：${r.sheetOpen ? '是' : '否'}`);
    console.log(`  搜索「鸡胸」：${r.searchWorks.结果数} 条 → ${JSON.stringify(r.searchWorks.排序)}`);
    console.log(`  份量预览：${r.amountPreview}`);
    console.log(`  加入记录后：${JSON.stringify(r.afterAdd)}`);
    console.log(`  搜「馄饨」：${JSON.stringify(r.searchWorks.搜馄饨)}`);
    console.log(`  AI 兜底：${r.aiFallback.行数} 行（估算 ${r.aiFallback.估算行数} 行）｜删除按钮 ${r.aiFallback.有删除按钮} 个｜合计 ${r.aiFallback.合计文本}`);
    console.log(`       ↳ 估算说明：${JSON.stringify(r.aiFallback.估算说明)}`);
    console.log(`       ↳ 删一条后 ${r.aiFallbackAfterDel.行数} 行｜存下 ${r.aiFallbackSaved.条数} 条：${JSON.stringify(r.aiFallbackSaved.名字)}`);
    console.log(`  没认出来时：${r.deadEnd.例句数} 个例句｜手动 ${r.deadEnd.有手动 ? '有' : '缺'}｜返回 ${r.deadEnd.有返回 ? '有' : '缺'}｜文案「${r.deadEnd.文案}」`);
    console.log(`       ↳ 点例句后：输入框「${r.deadEndAfter.例句填进去了}」｜弹层关闭 ${r.deadEndAfter.弹层关了 ? '是' : '否'}`);
    console.log(`  四个标签页卡片数：${JSON.stringify(r.tabs)}`);
    console.log(`  图标：${r.iconAudit.图标数} 个｜兜底方块 ${r.iconAudit.兜底方块.length} 个｜缺尺寸 ${r.iconAudit.缺尺寸} 个｜界面残留 emoji ${r.iconAudit.emoji行.length} 行`);
    if (r.iconAudit.emoji行.length) for (const l of r.iconAudit.emoji行) console.log(`       ↳ 还有 emoji：${l}`);
    console.log(`  成长弹层：植物插画 ${r.growth.植物} 个｜徽章图标 ${r.growth.徽章图标} 个（最小 ${r.growth.徽章尺寸}px）｜徽章名 ${r.growth.标签数} 个（空 ${r.growth.空标签} 个）｜未解锁 ${r.growth.未解锁} 个 / 锁标 ${r.growth.锁标} 个｜兜底 ${r.growth.兜底} 个`);
    if (r.growth.空标签) console.log(`       ↳ 有 ${r.growth.空标签} 个徽章没有名字（badgeLabel 少传了参数就会这样）`);
    console.log(`  设置页：图标 ${r.settings.图标} 个 / ${r.settings.行数} 行｜图标 ${r.settings.图标尺寸}px / 图标块 ${r.settings.图标块最小}px（要求 ≥22 / ≥34）｜兜底 ${r.settings.兜底} 个`);
    console.log(`  关于页检查更新：按钮 ${r.aboutCheck.有按钮 ? '有' : '缺'}｜版本行 ${r.aboutCheck.版本行 || '（空）'}｜提示「${r.aboutCheck.提示}」`);
    console.log(`  更新弹窗：标题「${r.update.标题}」｜${r.update.版本}｜条目 ${r.update.条目数} 条｜按钮 ${r.update.有按钮 ? '有' : '缺'}`);
    console.log(`  刷新弹窗：标题「${r.refresh.标题}」｜假版本 ${r.refresh.假版本}｜按钮 ${JSON.stringify(r.refresh.按钮)}`);
    console.log(`  资料页预览：${r.profilePreview}`);
    console.log(`  PWA 清单：${r.manifest.name}｜display=${r.manifest.display}｜start_url=${r.manifest.start_url}｜图标 ${r.manifest.icons.join(' ')}`);
    console.log(`  控制台报错：${s.consoleErrors.length ? s.consoleErrors.join(' | ') : '无'}`);
    const iconBad = r.manifest.icons.some((x) => x.includes('❌'));
    // 图标这轮（v27）新增三条：徽章要有名字、徽章和设置图标要真的放大到看得清
    const uiIconBad = r.iconAudit.emoji行.length > 0 || r.iconAudit.兜底方块.length > 0 || r.iconAudit.缺尺寸 > 0
      || r.growth.植物 !== 1 || r.growth.兜底 > 0 || r.growth.空标签 > 0
      || r.growth.徽章图标 > 0 && r.growth.徽章尺寸 < 48
      || r.growth.锁标 !== r.growth.未解锁
      || r.settings.图标 < 5 || r.settings.兜底 > 0
      || r.settings.图标 > 0 && (r.settings.图标尺寸 < 22 || r.settings.图标块最小 < 34)
      || r.update.标题 !== '更新了什么' || r.update.条目数 < 1 || !r.update.有按钮
      || !String(r.searchWorks.排序[0] || '').includes('熟重')
      || !r.searchWorks.搜馄饨.some((x) => x.includes('馄饨'))
      || r.aiFallback.行数 !== 3 || r.aiFallback.估算行数 !== 2 || r.aiFallback.有删除按钮 !== 3
      || !r.aiFallback.估算说明.every((x) => x.includes('食物库里没有'))
      || r.aiFallbackAfterDel.行数 !== 2 || !r.aiFallbackAfterDel.合计.includes('kcal')
      || r.aiFallbackSaved.条数 < 2
      || r.deadEnd.例句数 < 3 || !r.deadEnd.有手动 || !r.deadEnd.有返回
      || !r.deadEnd.文案.includes('一条都没记上')
      || r.deadEndAfter.例句填进去了.length < 4 || !r.deadEndAfter.弹层关了
      || !r.aboutCheck.有按钮 || !/最新版本/.test(r.aboutCheck.提示)
      || r.refresh.标题 !== '有新版本了' || !r.refresh.按钮.includes('刷新，用上新版')
      || !r.refresh.按钮.includes('先不刷新') || !r.refresh.正文.includes(r.refresh.假版本);
    if (!r.sheetOpen || !r.afterAdd.弹层已关闭 || r.searchWorks.结果数 === 0 || !r.afterAdd.最近一条
      || s.consoleErrors.length || !r.manifest.icons.length || iconBad || r.manifest.display !== 'standalone'
      || uiIconBad) problems += 1;
  }
  console.log(`\n${problems === 0 ? '✅ 浏览器自检全部通过' : `❌ 浏览器自检有 ${problems} 处问题`}`);
  console.log(`截图与报告在 ${outDir}`);
  if (problems) process.exitCode = 1;
}

armWatchdog('browser-check.mjs', 200);
// 兜底硬超时：脚本本身不能挂死（挂死会让 CI 判失败且看不出原因）。
// 到点就明确失败、带走 Chrome、立刻退出。
const HARD_TIMEOUT_MS = 150000;
const hardTimer = setTimeout(() => {
  console.error(`\n❌ 自检超过 ${HARD_TIMEOUT_MS / 1000} 秒未完成，判定失败（通常是浏览器没起来或页面卡住）`);
  try { execSync('pkill -9 -f chrome-profile || true'); } catch { /* 忽略 */ }
  process.exit(1);
}, HARD_TIMEOUT_MS);

main().catch((err) => {
  // 失败也要立刻退出并带走 Chrome：只设 exitCode 的话进程会挂着，
  // 卡到硬超时才被杀（表现为「跑了 150 秒才报错」，排查时很误导）
  clearTimeout(hardTimer);
  console.error('自检失败：', err.message);
  try { execSync('pkill -9 -f chrome-profile || true'); } catch { /* 忽略 */ }
  process.exit(1);
});
