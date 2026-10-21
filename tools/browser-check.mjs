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
      return {
        结果数: hits.length,
        排序: hits.map((h) => h.querySelector('.nm')?.textContent.trim().replace(/\s+/g, ' ') || h.textContent.trim().slice(0, 12)).slice(0, 4),
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
    await evaluate(client, `document.querySelector('#sheetClose')?.click()`);
    await sleep(300);

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

    entry.results = { sheetOpen, searchWorks, amountPreview, afterAdd, tabs, iconAudit, growth, settings, profilePreview, manifest };
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
    console.log(`  四个标签页卡片数：${JSON.stringify(r.tabs)}`);
    console.log(`  图标：${r.iconAudit.图标数} 个｜兜底方块 ${r.iconAudit.兜底方块.length} 个｜缺尺寸 ${r.iconAudit.缺尺寸} 个｜界面残留 emoji ${r.iconAudit.emoji行.length} 行`);
    if (r.iconAudit.emoji行.length) for (const l of r.iconAudit.emoji行) console.log(`       ↳ 还有 emoji：${l}`);
    console.log(`  成长弹层：植物插画 ${r.growth.植物} 个｜徽章图标 ${r.growth.徽章图标} 个（最小 ${r.growth.徽章尺寸}px）｜徽章名 ${r.growth.标签数} 个（空 ${r.growth.空标签} 个）｜未解锁 ${r.growth.未解锁} 个 / 锁标 ${r.growth.锁标} 个｜兜底 ${r.growth.兜底} 个`);
    if (r.growth.空标签) console.log(`       ↳ 有 ${r.growth.空标签} 个徽章没有名字（badgeLabel 少传了参数就会这样）`);
    console.log(`  设置页：图标 ${r.settings.图标} 个 / ${r.settings.行数} 行｜图标 ${r.settings.图标尺寸}px / 图标块 ${r.settings.图标块最小}px（要求 ≥22 / ≥34）｜兜底 ${r.settings.兜底} 个`);
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
      || r.settings.图标 > 0 && (r.settings.图标尺寸 < 22 || r.settings.图标块最小 < 34);
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
