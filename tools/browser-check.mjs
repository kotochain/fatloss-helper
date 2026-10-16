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

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.selfcheck');
const CHROME = findChrome();
const PORT = 9333;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';

const SIZES = [
  { name: 'phone', width: 390, height: 844, dpr: 1 },
  { name: 'small', width: 360, height: 640, dpr: 1 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
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
  fs.mkdirSync(outDir, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(outDir, 'chrome-profile')}`,
    '--hide-scrollbars', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // 等调试端口起来
  let version = null;
  for (let i = 0; i < 40; i++) {
    try { version = await getJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); }
  }
  if (!version) throw new Error('无头 Chrome 没起来（调试端口没响应）');
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

    entry.results = { sheetOpen, searchWorks, amountPreview, afterAdd, tabs, profilePreview, manifest };
    entry.consoleErrors = ERROR_BUCKET.slice(0, 10);
    report.sizes.push(entry);
    client.close();
  }

  fs.writeFileSync(path.join(outDir, 'browser-report.json'), JSON.stringify(report, null, 2));
  printReport(report);
  chrome.kill();
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
    console.log(`  资料页预览：${r.profilePreview}`);
    console.log(`  PWA 清单：${r.manifest.name}｜display=${r.manifest.display}｜start_url=${r.manifest.start_url}｜图标 ${r.manifest.icons.join(' ')}`);
    console.log(`  控制台报错：${s.consoleErrors.length ? s.consoleErrors.join(' | ') : '无'}`);
    const iconBad = r.manifest.icons.some((x) => x.includes('❌'));
    if (!r.sheetOpen || !r.afterAdd.弹层已关闭 || r.searchWorks.结果数 === 0 || !r.afterAdd.最近一条
      || s.consoleErrors.length || !r.manifest.icons.length || iconBad || r.manifest.display !== 'standalone') problems += 1;
  }
  console.log(`\n${problems === 0 ? '✅ 浏览器自检全部通过' : `❌ 浏览器自检有 ${problems} 处问题`}`);
  console.log(`截图与报告在 ${outDir}`);
  if (problems) process.exitCode = 1;
}

main().catch((err) => {
  console.error('自检失败：', err.message);
  process.exitCode = 1;
});
