/**
 * 新功能的真浏览器自检：「说一句就记上」+「按器械换有氧动作」
 *
 * 用法：先 node tools/serve.mjs 4173，再 node tools/quicklog-check.mjs
 * 覆盖：输入一句话 → 解析出可改的清单 → 改份量 → 换餐次 → 记入记录；
 *      有氧卡片选器械、目标、时长，以及「想做的机器没空」的替代流程。
 */

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
const PORT = 9337;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 12000, interval = 300, what = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (err) { last = err.message; }
    await sleep(interval);
  }
  throw new Error(`等待「${what}」超时，最后状态：${JSON.stringify(last)}`);
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

/**
 * 回到「记录」页的「吃的」那一半，并等到输入框真的在。
 * 记录页有分段（吃的/练的），她上次可能停在「练的」；自检脚本不能假设当前状态。
 */
async function ensureOnLogPage(evaluate) {
  // 先关掉可能开着的弹层
  await evaluate(`(() => {
    for (let i = 0; i < 6; i++) {
      const b = document.querySelector('#sheetClose');
      if (!b || b.offsetParent === null) break;
      b.click();
    }
    return true;
  })()`);
  await evaluate(`document.querySelector('.tab[data-view="log"]')?.click()`);
  await evaluate(`document.querySelector('[data-record-tab="food"]')?.click()`);
  const ok = await evaluate(`(async () => {
    for (let i = 0; i < 30; i++) {
      if (document.querySelector('#quickText')) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })()`);
  if (!ok) throw new Error('回到记录页后仍找不到说一句的输入框（#quickText）');
}

async function main() {
  await waitForServer();
  fs.mkdirSync(outDir, { recursive: true });
  // 先把调试端口清干净：上一次没退干净的 Chrome 会占着端口，
  // 新实例静默失败、等待循环却连上僵尸端口 —— 表现为「只有第一个脚本能过」。
  await freePortAndWait(PORT);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(outDir, 'chrome-quicklog')}`,
    '--window-size=390,844', '--hide-scrollbars', 'about:blank',
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
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const client = await connect(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  // 收集页面运行时的异常：界面因为某个变量名写错而整块渲染不出来时，
  // 断言可能"看起来没问题"（元素不存在就跳过），必须靠这里兜住。
  const pageErrors = [];
  client.on?.('Runtime.exceptionThrown', (p) => {
    // 连堆栈一起收：只有一句 "reading 'value'" 根本不知道在哪（排查花过很久）
    const d = p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || '';
    const lines = d.split('\n').filter((l) => l.includes('app.js') || l.includes('at ')).slice(0, 3);
    pageErrors.push([d.split('\n')[0].slice(0, 120), ...lines.map((l) => l.trim().slice(0, 90))].join(' | '));
  });
  await client.send('Page.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  const errors = [];
  const evaluate = async (expression) => {
    const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      // 报错时带上表达式的前 80 字 —— 否则只有行号，根本不知道是哪一句（排查花过很久）
      const expr = String(expression).replace(/\s+/g, ' ').slice(0, 80);
      throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n    出错的那句: ${expr}`);
    }
    return r.result.value;
  };
  const problems = [];

  // 准备：清缓存 + 写一份资料，直接进「记录」页
  await client.send('Page.navigate', { url: BASE + '/' });
  await sleep(1000);
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

  const ready = await evaluate(`window.__appReady === true`);
  if (!ready) problems.push('页面没启动（白屏）');

  // 接口请求不能被离线缓存接管（否则设置页读到的永远是旧状态）
  const apiNotCached = await evaluate(`(async () => {
    await fetch('/api/ai-status').catch(() => {});
    const names = await caches.keys();
    let hits = 0;
    for (const n of names) {
      const c = await caches.open(n);
      const keys = await c.keys();
      hits += keys.filter((r) => new URL(r.url).pathname.startsWith('/api/')).length;
    }
    return hits;
  })()`);
  console.log(apiNotCached === 0 ? '✅ 接口请求没有被离线缓存接管' : `❌ 有 ${apiNotCached} 个 /api 请求被缓存了`);
  if (apiNotCached !== 0) problems.push('/api 请求被离线缓存接管，设置页会读到旧状态');

  console.log('\n=== 〇·一、白屏与「点不动」的回归测试（用户真机上踩到过）===');
  /*
   * 守两次真机事故：
   *  1) 手机里有存档时一打开就白屏 —— load() 在模块顶层跑，却赋值给一个后面才声明的 let
   *     （Cannot access 'startupNotice' before initialization）。新用户没存档，本地测试一直没暴露。
   *  2) 欢迎页所有按钮点不动 —— render() 在欢迎页分支里 return，跳过了末尾的 bindCommon()。
   * 这两条都不会让单元测试变红（单元测试加载不了 app.js），只能靠真浏览器守。
   */
  await evaluate(`(() => {
    // 老版本存档：有记录、没有 profile（她之前用过的版本就是这种形状）
    const old = {
      version: 1,
      days: { '2026-10-10': { meals: { lunch: [{ id: 'e1', food: { id: 'rice_cooked', name: '米饭（熟）', kcal: 116, protein: 2.6, fat: 0.3, carb: 25.9 }, grams: 200 }] }, exercises: [] } },
      weights: [{ date: '2026-10-10', kg: 58 }],
      customFoods: [],
    };
    localStorage.clear();
    localStorage.setItem('fatloss.state.v2', JSON.stringify(old));
    return true;
  })()`);
  await client.send('Page.navigate', { url: BASE + '/' });
  await sleep(2000);
  const oldSave = await evaluate(`({
    启动成功: window.__appReady === true,
    有内容: (document.querySelector('#app')?.textContent || '').trim().length > 10,
    按钮数: document.querySelectorAll('#app [data-act]').length,
    记录天数: (() => { try { const s = JSON.parse(localStorage.getItem('fatloss.state.v2') || '{}'); return Object.keys(s.days || {}).length; } catch { return -1; } })(),
  })`);
  console.log(`✅ 手机里有老存档时打开：启动 ${oldSave.启动成功}｜有内容 ${oldSave.有内容}｜按钮 ${oldSave.按钮数} 个｜记录还在 ${oldSave.记录天数} 天`);
  if (!oldSave.启动成功 || !oldSave.有内容) problems.push('有存档时页面没渲染出来（白屏）—— 用户真机上发生过');
  if (oldSave.记录天数 < 1) problems.push('打开后老记录不见了');

  // 欢迎页的按钮必须真的能点（点了要开弹层）
  const clickable = await evaluate(`(async () => {
    const out = [];
    for (const act of ['recover', 'onboard']) {
      const b = [...document.querySelectorAll('#app [data-act]')].find((x) => x.dataset.act === act);
      if (!b) { out.push([act, '按钮不在']); continue; }
      b.click();
      await new Promise((r) => setTimeout(r, 500));
      out.push([act, document.querySelector('#sheetRoot')?.classList.contains('hidden') ? '点了没反应' : '弹层开了']);
      document.querySelector('#sheetClose')?.click();
      await new Promise((r) => setTimeout(r, 300));
    }
    return out;
  })()`);
  for (const [act, res] of clickable) {
    console.log(`   ${res === '弹层开了' ? '✅' : '❌'} 欢迎页按钮「${act}」→ ${res}`);
    if (res !== '弹层开了') problems.push(`欢迎页按钮「${act}」点了没反应（用户报过的「点都点不了」）`);
  }


  console.log('\n=== 一·〇、新手引导（第一次打开的人看到的）===');
  // 清空存储，模拟「第一次打开」
  await evaluate(`(async () => { localStorage.clear(); const r = await navigator.serviceWorker.getRegistrations(); await Promise.all(r.map((x) => x.unregister())); for (const n of await caches.keys()) await caches.delete(n); return true; })()`);
  await client.send('Page.navigate', { url: BASE + '/' });
  await sleep(1800);
  // 检查元素而不是文字：之前按文字找，被自己 slice 截断了，误判成「没有引导入口」
  const welcome = await evaluate(`({
    文字: document.querySelector('#app')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 46),
    有引导按钮: !!document.querySelector('[data-act="onboard"]'),
    有直接填资料: !!document.querySelector('[data-act="edit-profile"]'),
    有示例按钮: !!document.querySelector('[data-act="demo"]'),
  })`);
  console.log(`✅ 首次打开看到欢迎页：${welcome.文字}`);
  console.log(`   引导入口 ${welcome.有引导按钮}｜直接填资料 ${welcome.有直接填资料}｜示例入口 ${welcome.有示例按钮}`);
  if (!welcome.有直接填资料) problems.push('欢迎页缺少「直接填资料」（老用户重装时不该被迫重看引导）');
  if (!welcome.有引导按钮) problems.push('首次打开没有引导入口');

  await evaluate(`document.querySelector('[data-act="onboard"]')?.click()`);
  await sleep(700);
  const ob1 = await evaluate(`({ 标题: document.querySelector('#sheetTitle')?.textContent, 步骤: document.querySelector('.onboard-step')?.textContent })`);
  console.log(`✅ 第 1 步「${ob1.标题}」（${ob1.步骤}）`);
  await evaluate(`document.querySelector('#obNext')?.click()`);
  // 等表单真的出现再操作 —— 固定 sleep 偶尔不够（踩过：去设值时元素还没渲染出来）
  await evaluate(`(async () => {
    for (let i = 0; i < 30; i++) {
      if (document.querySelector('#pHeight')) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })()`);
  await sleep(200);
  const ob2 = await evaluate(`({ 有表单: !!document.querySelector('#pHeight'), 按钮: document.querySelector('#pSave')?.textContent })`);
  console.log(`✅ 第 2 步填基础数据（表单在 ${ob2.有表单}，按钮「${ob2.按钮}」）`);
  if (!ob2.有表单) problems.push('引导第 2 步没有资料表单');

  await evaluate(`(() => {
    const h = document.querySelector('#pHeight');
    if (!h) return 'no-height';
    h.value = '163';
    const w = document.querySelector('#pWeight'); if (w) w.value = '58';
    const a = document.querySelector('#pAge'); if (a) a.value = '26';
    document.querySelector('#pSave')?.click();
    return 'ok';
  })()`);
  await evaluate(`(async () => {
    for (let i = 0; i < 30; i++) {
      if (document.querySelector('[data-pick]')) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })()`);
  const ob3 = await evaluate(`({ 标题: document.querySelector('#sheetTitle')?.textContent, 选项: [...document.querySelectorAll('[data-pick]')].map((e) => e.querySelector('b').textContent.trim()) })`);
  console.log(`✅ 第 3 步「${ob3.标题}」：${ob3.选项.join(' / ')}`);
  if (!ob3.选项.includes('普通模式') || !ob3.选项.includes('AI 模式')) problems.push('引导里没有让用户选模式');
  if (ob3.选项[0] !== '普通模式') problems.push('普通模式应当排在前面（大多数人不会配 API）');

  await evaluate(`document.querySelector('[data-pick="basic"]')?.click()`);
  await evaluate(`(async () => {
    for (let i = 0; i < 30; i++) {
      if (document.querySelector('#obGo')) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })()`);
  const ob4 = await evaluate(`({ 步骤: document.querySelector('.onboard-step')?.textContent, 有去记录: !!document.querySelector('#obGo') })`);
  console.log(`✅ 第 4 步（${ob4.步骤}）引导去记第一笔：${ob4.有去记录}`);
  await evaluate(`document.querySelector('#obGo')?.click()`);
  await sleep(1200);
  const obDone = await evaluate(`({ 标签: document.querySelector('.tab.active')?.textContent.trim(), 模式: JSON.parse(localStorage.getItem('fatloss.state.v2') || '{}')?.settings?.mode, 引导完成: JSON.parse(localStorage.getItem('fatloss.state.v2') || '{}')?.settings?.onboarded })`);
  console.log(`✅ 引导结束 → 落在「${obDone.标签}」页，模式存为 ${obDone.模式}，引导标记 ${obDone.引导完成}`);
  if (obDone.模式 !== 'basic') problems.push('引导里选了普通模式，存档里却不是');
  if (obDone.引导完成 !== true) problems.push('引导完成后没有记录标记（下次打开会重复引导）');

  console.log('\n=== 一、「说一句就记上」 ===');
  await evaluate(`document.querySelector('.tab[data-view="log"]').click()`);
  await sleep(400);
  const hasBox = await evaluate(`!!document.querySelector('#quickText')`);
  console.log(hasBox ? '✅ 记录页有「说一句」输入框' : '❌ 没有输入框');
  if (!hasBox) problems.push('记录页缺少说一句输入框');

  // 输入一句话并解析（这里服务端没配 AI 密钥，会走离线解析）
  await evaluate(`(() => {
    const ta = document.querySelector('#quickText');
    ta.value = '今天中午在食堂吃了碗牛肉面，加了个蛋';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#quickParse').click();
  })()`);
  await waitFor(() => evaluate(`document.querySelectorAll('#draftHost .entry').length || null`), { what: '解析结果出现（弹层）' });
  const inSheet = await evaluate(`!document.querySelector('#sheetRoot').classList.contains('hidden')`);
  const draft = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#draftHost .entry')];
    return {
      弹层标题: document.querySelector('#sheetTitle')?.textContent || null,
      条数: rows.length,
      条目: rows.map((r) => r.querySelector('.name').textContent.trim().replace(/\\s+/g, ' ')),
      合计: document.querySelector('#draftHost .row.between b')?.textContent || null,
      有餐次选择: !!document.querySelector('#draftMeal'),
      有确认按钮: !!document.querySelector('#draftSave'),
    };
  })()`);
  console.log(inSheet ? '✅ 解析结果用弹层展示（不用往下滚去找）' : '❌ 解析结果没在弹层里');
  console.log(`   弹层标题：「${draft.弹层标题}」`);
  console.log(`✅ 解析出 ${draft.条数} 条：${draft.条目.join('、')}｜合计 ${draft.合计} kcal｜可改份量/餐次 ${draft.有餐次选择}`);
  if (draft.条数 === 0) problems.push('一句话没解析出任何条目');
  if (!draft.有确认按钮) problems.push('缺少「记上」按钮');

  console.log('\n=== 一·二、份量不确定时反问她 ===');
  // 这段必须放在「改成 800 克」之前：她一旦自己填了数字，追问就会收起来（设计如此）。
  const guess = await evaluate(`(() => {
    const block = document.querySelector('#draftHost [data-guess]');
    if (!block) return null;
    const chips = [...block.querySelectorAll('.chip')];
    return {
      条目: block.previousElementSibling?.querySelector('.name')?.textContent.trim().replace(/\\s+/g, ' ') || null,
      标注: block.querySelector('.guess-tag')?.textContent || null,
      理由: block.querySelector('.guess-why')?.textContent || null,
      档位: chips.map((c) => c.textContent.trim()),
      追问块数: document.querySelectorAll('#draftHost [data-guess]').length,
      合计: document.querySelector('#draftHost .row.between b').textContent,
      索引: block.dataset.guess,
    };
  })()`);
  if (!guess) {
    console.log('❌ 「一碗牛肉面」这种说不准的份量，界面没有反问她');
    problems.push('份量说不准时没有反问她（缺档位按钮）');
  } else {
    console.log(`✅ 反问她一句：「${guess.标注}」${guess.理由}`);
    console.log(`   档位：${guess.档位.join(' / ')}（共 ${guess.追问块数} 条在问）`);
    if (!(guess.标注 || '').includes('猜的')) problems.push('低置信度条目没有标出「这个份量我是猜的」');
    if (guess.档位.length < 2) problems.push(`份量档位只有 ${guess.档位.length} 个，等于没法选`);
    // 留一张图，方便人直接看这块长什么样（截图在 .selfcheck/，不进版本库）
    const shotGuess = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'shot-portion.png'), Buffer.from(shotGuess.data, 'base64'));
  }

  // 点最大的那一档：克数、行内热量、合计都要跟着变，问过的就别再挂着
  const beforePick = guess ? guess.合计 : await evaluate(`document.querySelector('#draftHost .row.between b').textContent`);
  const clicked = await evaluate(`(() => {
    const block = document.querySelector('#draftHost [data-guess]');
    if (!block) return null;
    const chips = [...block.querySelectorAll('.chip')];
    const target = chips[chips.length - 1];
    target.click();
    return { 档位: target.textContent.trim(), 索引: block.dataset.guess };
  })()`);
  await sleep(250);
  if (!clicked) {
    console.log('（没有可点的档位，跳过改份量检查）');
  } else {
    const picked = await evaluate(`(() => {
      const idx = ${clicked.索引};
      return {
        克数: document.querySelectorAll('#draftHost .draft-grams')[idx]?.value || null,
        行内热量: document.querySelector('#draftHost [data-kcal="' + idx + '"]')?.textContent || null,
        合计: document.querySelector('#draftHost .row.between b').textContent,
        追问还在: !!document.querySelector('#draftHost [data-guess="' + idx + '"]'),
      };
    })()`);
    const tierGrams = Number((clicked.档位.match(/(\d+)\s*克/) || [])[1]);
    console.log(`✅ 点档位「${clicked.档位}」→ 第 ${clicked.索引} 条变成 ${picked.克数} 克（${picked.行内热量}），合计 ${beforePick} → ${picked.合计} kcal`);
    if (Number(picked.克数) !== tierGrams) problems.push(`点档位没有把克数改成档位上的数（点了 ${tierGrams}，实际 ${picked.克数}）`);
    if (beforePick === picked.合计) problems.push('换档位后合计热量没有跟着变');
    if (picked.追问还在) problems.push('选完档位追问没有收起来（会一直问她同一句）');
  }

  // 改份量：把第一条改成 800 克，看合计有没有跟着变
  const before = await evaluate(`document.querySelector('#draftHost .row.between b')?.textContent`);
  const changeRes = await evaluate(`(() => {
    const inp = document.querySelector('#draftHost .draft-grams');
    if (!inp) {
      // 报出真实 DOM，方便判断是结构变了还是元素真没了
      return { ok: false, html: (document.querySelector('#draftHost')?.innerHTML || '').replace(/\s+/g, ' ').slice(0, 200) };
    }
    inp.value = '800';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  })()`);
  if (!changeRes.ok) {
    console.log('   ❌ 找不到份量输入框，弹层实际内容：', changeRes.html);
    problems.push('弹层里找不到份量输入框（.draft-grams）');
  }
  await sleep(200);
  const after = await evaluate(`document.querySelector('#draftHost .row.between b')?.textContent || '(没找到合计)'`);
  console.log(`✅ 改份量后合计从 ${before} 变成 ${after} kcal`);
  if (before === after) problems.push('改份量没有重算热量');

  // 换餐次并记入
  await evaluate(`document.querySelector('#draftMeal [data-meal="dinner"]').click()`);
  await evaluate(`document.querySelector('#draftSave').click()`);
  await sleep(500);
  const saved = await evaluate(`(() => {
    const st = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    const day = st.days[Object.keys(st.days)[0]];
    const dinner = day.meals.dinner || [];
    return {
      餐次: 'dinner',
      条数: dinner.length,
      条目: dinner.map((e) => e.food.name + ' ' + e.grams + 'g'),
      今天的总条数: Object.values(day.meals).flat().length,
    };
  })()`);
  console.log(`✅ 记入晚餐：${saved.条目.join('、')}`);
  if (saved.条数 === 0) problems.push('点「记上」之后没有写进记录');

  const shot1 = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-quicklog.png'), Buffer.from(shot1.data, 'base64'));

  // 再看「今天」页有没有正确汇总
  await evaluate(`document.querySelector('.tab[data-view="today"]').click()`);
  await sleep(400);
  const todayInfo = await evaluate(`(() => ({
    已吃: document.querySelector('.hero .sub')?.textContent || null,
    晚餐行: [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('晚餐'))?.textContent.replace(/\\s+/g, ' ').slice(0, 60) || null,
  }))()`);
  console.log(`✅ 今天页：${todayInfo.已吃}`);
  if (!todayInfo.晚餐行 || !todayInfo.晚餐行.includes('牛肉面')) problems.push('「今天」页没有显示刚记的晚餐');

  // 反过来：份量说得清清楚楚时，界面不许因为这次改动多出任何东西（不能变啰嗦）
  await evaluate(`document.querySelector('.tab[data-view="log"]').click()`);
  await sleep(400);
  await evaluate(`(() => {
    const ta = document.querySelector('#quickText');
    ta.value = '中午吃了200克米饭和两个鸡蛋';
    document.querySelector('#quickParse').click();
  })()`);
  await waitFor(() => evaluate(`document.querySelectorAll('#draftHost .entry').length || null`), { what: '第二次解析结果（都说清了的例句）' });
  const noNoise = await evaluate(`(() => ({
    条数: document.querySelectorAll('#draftHost .entry').length,
    追问块: document.querySelectorAll('#draftHost [data-guess]').length,
    猜的标记: [...document.querySelectorAll('#draftHost .entry .tag')].filter((t) => t.textContent.includes('猜的')).length,
  }))()`);
  console.log(noNoise.追问块 === 0
    ? `✅ 都说清了（200克米饭 + 两个鸡蛋）就不问：${noNoise.条数} 条，一个追问都没有`
    : `❌ 说清楚了还要问：${noNoise.追问块} 条`);
  if (noNoise.追问块 !== 0 || noNoise.猜的标记 !== 0) problems.push('份量说得清楚时不该反问她（多出了追问）');
  await evaluate(`document.querySelector('#sheetClose')?.click()`);
  await sleep(300);

  console.log('\n=== 一·五、正反馈：小植物 / 徽章 / 庆祝 ===');
  // 先看「没填称呼」时的表现：把称呼清掉（这也是新用户的默认状态）
  await evaluate(`(() => {
    const s = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    s.profile = { ...s.profile, nickname: '' };
    localStorage.setItem('fatloss.state.v2', JSON.stringify(s));
    return true;
  })()`);
  await evaluate(`location.reload()`);
  await sleep(1500);
  // 回今天页，找成长入口
  await evaluate(`document.querySelector('.tab[data-view="today"]')?.click()`);
  await sleep(400);
  const plantCard = await evaluate(`(() => {
    const el = document.querySelector('.plant-card');
    return el ? { 文案: el.textContent.replace(/\\s+/g, ' ').trim() } : null;
  })()`);
  console.log(plantCard ? `✅ 今天页有小植物入口：${plantCard.文案}` : '❌ 没有小植物入口');
  const personal = await evaluate(`(() => ({
    昵称签隐藏: document.querySelector('#nameTag')?.hidden === true,
    问候语: document.querySelector('.greet')?.textContent.replace(/\\s+/g, ' ').trim() || null,
    问候有孤逗号: /，\\s*$/.test(document.querySelector('.greet')?.textContent || ''),
  }))()`);
  console.log(`✅ 没填称呼时：昵称签隐藏 ${personal.昵称签隐藏}｜问候「${personal.问候语}」`);
  if (!personal.昵称签隐藏) problems.push('没填称呼时顶部不该显示名字');
  if (personal.问候有孤逗号) problems.push('没填称呼时问候语留了一个孤零零的逗号');
  if (!plantCard) problems.push('今天页缺少小植物入口');

  await evaluate(`document.querySelector('.plant-card').click()`);
  await sleep(700);
  const growth = await evaluate(`(() => ({
    标题: document.querySelector('#sheetTitle')?.textContent || '',
    有植物: !!document.querySelector('.plant-box'),
    徽章数: document.querySelectorAll('.badge-grid .ach').length,
    已解锁: document.querySelectorAll('.badge-grid .ach.on').length,
    有进度条: document.querySelectorAll('.badge-grid .ach-bar').length,
    说明: (() => {
      const txt = document.querySelector('.badge-grid')?.parentElement?.textContent || '';
      // 我们要的是「明确声明没有少吃类徽章」，不是「出现了少吃两个字」
      return txt.includes('没有') && txt.includes('少吃') ? '已声明不做少吃类徽章' : '缺少这句声明';
    })(),
  }))()`);
  const anyPersonal = await evaluate(`(() => {
    const txt = document.querySelector('#sheetBody')?.textContent || '';
    return { 有小繁: txt.includes('小繁'), 有专属: txt.includes('专属') };
  })()`);
  console.log(`✅ 成长弹层：「${growth.标题}」徽章 ${growth.徽章数} 个（已解锁 ${growth.已解锁}，未解锁带进度条 ${growth.有进度条} 个）`);
  console.log(`   徽章墙里是否还有个人信息：小繁 ${anyPersonal.有小繁}｜专属 ${anyPersonal.有专属}`);
  if (anyPersonal.有小繁 || anyPersonal.有专属) problems.push('徽章墙里还残留「小繁专属」这类个人信息（要给别人用）');
  console.log(`   徽章页文案：${growth.说明}`);
  if (growth.说明 !== '已声明不做少吃类徽章') problems.push('徽章页缺少「不做少吃类徽章」的说明');
  if (growth.徽章数 < 10) problems.push(`徽章只有 ${growth.徽章数} 个，太少了`);
  if (!growth.有植物) problems.push('成长弹层里没有小植物');

  // 点一个未解锁的徽章，应当提示还差多少
  const achTip = await evaluate(`(async () => {
    // 先把之前可能还挂在屏幕上的提示条清掉，免得读到旧的
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const locked = document.querySelector('.badge-grid .ach:not(.on)');
    if (!locked) return null;
    const name = locked.querySelector('.ach-name')?.textContent || '';
    locked.click();
    await new Promise((r) => setTimeout(r, 400));
    const t = [...document.querySelectorAll('.toast')].pop();
    return { 徽章: name, 提示: t ? t.textContent.trim() : null };
  })()`);
  console.log(achTip ? `✅ 点未解锁徽章「${achTip.徽章}」提示：${(achTip.提示 || '').slice(0, 44)}` : '（没有未解锁的徽章可点）');
  if (achTip && !/\d+\/\d+/.test(achTip.提示 || '')) problems.push('点未解锁徽章没有提示还差多少');

  await evaluate(`document.querySelector('#sheetClose').click()`);
  await sleep(300);

  // 记一笔，看有没有「记完的反馈」提示条
  // 注意：必须显式回到「记录」页并等输入框出现 —— 上面几步把页面切到了今天页，
  // 而记录页现在还有「吃的/练的」分段，不能假设输入框一定在（踩过：脚本自己报了空指针）
  await ensureOnLogPage(evaluate);
  await evaluate(`(() => {
    const ta = document.querySelector('#quickText');
    ta.value = '中午吃了一碗米饭';
    document.querySelector('#quickParse').click();
  })()`);
  await sleep(1200);
  await evaluate(`document.querySelector('#draftSave')?.click()`);
  await sleep(800);
  const afterSave = await evaluate(`(() => {
    const all = [...document.querySelectorAll('.toast')];
    return all.length ? all[all.length - 1].textContent.trim() : null;
  })()`);
  console.log(afterSave ? `✅ 记完一笔的反馈：${afterSave}` : '❌ 记完没有反馈提示');
  if (!afterSave) problems.push('记完一笔没有任何反馈');

  // 解锁新徽章时应当弹庆祝（带彩条）
  const celebration = await evaluate(`(() => {
    const el = document.querySelector('.celebrate');
    if (!el) return null;
    return {
      标题: el.querySelector('.celebrate-title')?.textContent || '',
      说明: el.querySelector('.celebrate-sub')?.textContent || '',
      彩条数: el.querySelectorAll('.confetti i').length,
      有按钮: !!el.querySelector('#celebrateOk'),
    };
  })()`);
  if (celebration) {
    console.log(`✅ 解锁徽章弹了庆祝：「${celebration.标题}」${celebration.说明.slice(0, 26)}…（彩条 ${celebration.彩条数} 条，可关闭 ${celebration.有按钮}）`);
    const shotCele = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'shot-celebrate.png'), Buffer.from(shotCele.data, 'base64'));
    await evaluate(`document.querySelector('#celebrateOk')?.click()`);
    await sleep(300);
  } else {
    console.log('（这一轮没有新徽章可解锁，跳过庆祝检查）');
  }

  console.log('\n=== 一·六、设置页（我的）===');
  // 先把可能还开着的弹层和庆祝动画关掉 —— 它们会挡住点击（踩过：点设置没反应）
  await evaluate(`(() => {
    document.querySelector('#celebrateOk')?.click();
    document.querySelectorAll('.celebrate').forEach((el) => el.remove());
    for (let i = 0; i < 5; i++) { const b = document.querySelector('#sheetClose'); if (!b || b.offsetParent === null) break; b.click(); }
    return true;
  })()`);
  await sleep(500);
  await evaluate(`document.querySelector('#profileBtn').click()`);
  await sleep(700);
  const settings = await evaluate(`(() => ({
    标题: document.querySelector('#sheetTitle')?.textContent || '',
    条目: [...document.querySelectorAll('.set-row .set-main b')].map((e) => e.textContent.trim()),
  }))()`);
  const modes = await evaluate(`[...document.querySelectorAll('.mode-chip')].map((e) => e.querySelector('b').textContent.trim() + (e.classList.contains('on') ? '(当前)' : ''))`);
  console.log(`✅ 设置页：「${settings.标题}」包含 ${settings.条目.join('、')}`);
  console.log(`   使用模式：${modes.join(' / ')}`);
  if (!modes.some((m) => m.includes('普通模式'))) problems.push('设置页没有「普通模式」选项');
  if (!modes.some((m) => m.includes('AI 模式'))) problems.push('设置页没有「AI 模式」选项');
  if (!modes.some((m) => m.includes('当前') && m.includes('普通'))) problems.push('默认应当是普通模式（大多数人不会配 API）');
  for (const must of ['AI 设置', '数据与备份', '你的资料', '关于']) {
    if (!settings.条目.includes(must)) problems.push(`设置页缺少「${must}」`);
  }

  // 备份页：导出/导入/快照都在
  await evaluate(`[...document.querySelectorAll('.set-row')].find((r) => r.textContent.includes('数据与备份'))?.click()`);
  await sleep(600);
  const backup = await evaluate(`(() => ({
    有导出: !!document.querySelector('#doExport'),
    有导入: !!document.querySelector('#doImport'),
    有快照按钮: !!document.querySelector('#doSnapshot'),
    存档版本显示: /v\\d+/.test(document.querySelector('#sheetBody')?.textContent || ''),
  }))()`);
  console.log(`✅ 备份页：导出 ${backup.有导出}｜导入 ${backup.有导入}｜手动快照 ${backup.有快照按钮}｜显示存档版本 ${backup.存档版本显示}`);
  if (!backup.有导出 || !backup.有导入) problems.push('备份页缺少导出或导入');

  await evaluate(`document.querySelector('#sheetClose').click()`);
  await sleep(300);

  console.log('\n=== 一·七、本地周洞察（不联网、不调 AI）===');
  // 造 6 天记录，看今天页有没有出现「你自己的规律」
  const seeded = await evaluate(`(async () => {
    const m = await import('./js/store.js');
    const f = await import('./js/foods.js');
    const raw = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    for (let i = 0; i < 6; i++) {
      const key = m.shiftDate(m.todayKey(), -i);
      const hi = i % 2 === 0;
      m.addFoodEntry(raw, key, 'breakfast', f.findFood('egg'), 100);
      m.addFoodEntry(raw, key, 'lunch', f.findFood('chicken_breast'), hi ? 250 : 40);
      m.addFoodEntry(raw, key, 'lunch', f.findFood('rice_cooked'), hi ? 150 : 500);
      m.addFoodEntry(raw, key, 'dinner', f.findFood('rice_cooked'), hi ? 120 : 450);
    }
    localStorage.setItem('fatloss.state.v2', JSON.stringify(raw));
    return Object.keys(raw.days).length;
  })()`);
  // 注意：必须用不带 ?demo 的地址重载 —— ?demo=1 每次加载都会重置示例数据，会把刚造的数据冲掉
  await client.send('Page.navigate', { url: BASE + '/' });
  await sleep(2200);
  await evaluate(`document.querySelector('.tab[data-view="today"]')?.click()`);
  await sleep(600);
  const insightCard = await evaluate(`(() => {
    const el = document.querySelector('.insight-card');
    if (!el) return null;
    return { 条数: el.querySelectorAll('.insight').length, 文案: el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 70) };
  })()`);
  console.log(insightCard
    ? `✅ 造了 ${seeded} 天记录后，今天页出现「你的规律」：${insightCard.条数} 条 · ${insightCard.文案}`
    : `❌ 造了 ${seeded} 天记录仍没有洞察卡片`);
  if (!insightCard || insightCard.条数 < 2) problems.push('数据够的时候应当出现多条洞察');

  await evaluate(`document.querySelector('[data-act="insights"]')?.click()`);
  await sleep(700);
  const allSheet = await evaluate(`(() => ({
    标题: document.querySelector('#sheetTitle')?.textContent || '',
    条数: document.querySelectorAll('#sheetBody .insight').length,
    提到不联网: (document.querySelector('#sheetBody')?.textContent || '').includes('不联网'),
  }))()`);
  console.log(`✅ 「看全部规律」弹层：「${allSheet.标题}」${allSheet.条数} 条 · 说明里写了不联网 ${allSheet.提到不联网}`);
  if (allSheet.标题 !== '你的规律') problems.push('全部规律的弹层没打开');
  await evaluate(`document.querySelector('#sheetClose')?.click()`);
  await sleep(300);

  console.log('\n=== 二、按器械换有氧动作 ===');
  await evaluate(`document.querySelector('.tab[data-view="plan"]').click()`);
  await sleep(500);
  const cardio = await evaluate(`(() => {
    const chips = [...document.querySelectorAll('#equipChips .chip')];
    const picks = [...document.querySelectorAll('.cardio-session h4')].map((h) => h.textContent.replace(/\\s+/g, ' ').trim());
    return {
      器械数: chips.length,
      默认选中: chips.filter((c) => c.classList.contains('on')).map((c) => c.textContent.trim()),
      推荐: picks.slice(0, 3),
      有替代入口: !!document.querySelector('[data-subs]'),
    };
  })()`);
  console.log(`✅ 器械选项 ${cardio.器械数} 个，默认勾选：${cardio.默认选中.join('、')}`);
  console.log(`✅ 推荐：${cardio.推荐.join(' / ')}`);
  if (!cardio.器械数) problems.push('没有器械选项');
  if (!cardio.推荐.length) problems.push('没有推荐出有氧方案');

  // 只勾椭圆机（模拟「跑步机没了，只有椭圆机」）
  await evaluate(`(() => {
    document.querySelectorAll('#equipChips .chip.on').forEach((c) => c.click());
  })()`);
  await sleep(300);
  await evaluate(`document.querySelector('#equipChips [data-eq="elliptical"]').click()`);
  await sleep(400);
  const ellipticalOnly = await evaluate(`[...document.querySelectorAll('.cardio-session h4')].map((h) => h.textContent.replace(/\\s+/g, ' ').trim()).slice(0, 2)`);
  console.log(`✅ 只勾「椭圆机」后的推荐：${ellipticalOnly.join(' / ')}`);
  if (!ellipticalOnly.some((t) => t.includes('椭圆机'))) problems.push('只勾椭圆机却没有推荐椭圆机');

  // 试着把「爬坡走」换成可用器械的动作
  const subSheet = await evaluate(`(async () => {
    // 直接调用界面上的替代入口：先找到「爬坡走」那一行
    const rows = [...document.querySelectorAll('[data-subs]')];
    const row = rows.find((r) => r.textContent.includes('爬坡')) || rows[0];
    if (!row) return { ok: false, reason: '没有替代入口' };
    row.click();
    await new Promise((r) => setTimeout(r, 300));
    const body = document.querySelector('#sheetBody')?.textContent.replace(/\\s+/g, ' ') || '';
    return {
      ok: true,
      标题: document.querySelector('#sheetTitle')?.textContent || '',
      片段: body.slice(0, 160),
      条目数: document.querySelectorAll('#sheetBody .session').length,
    };
  })()`);
  console.log(`✅ 替代弹层：「${subSheet.标题}」给出 ${subSheet.条目数} 个替代方案`);
  console.log(`   ${subSheet.片段.slice(0, 120)}…`);
  if (!subSheet.ok || !subSheet.条目数) problems.push('替代方案弹层没给出内容');

  const shot2 = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-cardio.png'), Buffer.from(shot2.data, 'base64'));

  await evaluate(`document.querySelector('#sheetClose').click()`);
  await sleep(200);

  console.log('\n=== 三、运动记录：记一次运动，统计跟着变 ===');
  // 红线：记运动前后，「今天还可以吃」必须一模一样。
  // 先把这个数字记下来，最后再对一遍 —— 这是整个功能最容易做错的地方。
  await evaluate(`document.querySelector('.tab[data-view="today"]')?.click()`);
  await sleep(500);
  const heroBefore = await evaluate(`(() => ({
    剩余: document.querySelector('.ring-center .big')?.textContent || null,
    标签: document.querySelector('.ring-center .cap')?.textContent || null,
    已吃: document.querySelector('.hero .sub')?.textContent.replace(/\\s+/g, ' ').trim() || null,
    有奖励胶囊: !!document.querySelector('.bonus-pill'),
  }))()`);
  console.log(`   记运动前：${heroBefore.标签} ${heroBefore.剩余} kcal ｜ ${heroBefore.已吃}`);

  await evaluate(`document.querySelector('.tab[data-view="log"]').click()`);
  await sleep(400);
  const seg0 = await evaluate(`(() => ({
    分段: [...document.querySelectorAll('#recordTabs .seg-btn')].map((b) => b.textContent.trim() + (b.classList.contains('on') ? '(当前)' : '')),
    有吃的输入框: !!document.querySelector('#quickText'),
    有运动面板: !!document.querySelector('[data-train-cardio]'),
  }))()`);
  console.log(`✅ 记录页分段：${seg0.分段.join(' / ')}`);
  if (seg0.分段.length !== 2) problems.push('记录页没有「吃的 / 练的」两个分段');
  if (!seg0.有吃的输入框) problems.push('记录页默认应当是「吃的」那一半（否则记饭要多点一次）');
  if (seg0.有运动面板) problems.push('「吃的」那一半不该同时显示运动面板');

  await evaluate(`document.querySelector('[data-record-tab="training"]').click()`);
  await sleep(450);
  const train = await evaluate(`(() => {
    const chips = [...document.querySelectorAll('#trainCardio .chip')];
    const on = document.querySelector('#trainCardio .chip.on');
    return {
      吃的输入框还在: !!document.querySelector('#quickText'),
      动作数: chips.length,
      默认动作: on ? on.textContent.trim() : null,
      前几个动作: chips.slice(0, 5).map((c) => c.textContent.trim()),
      估算文案: document.querySelector('#trainEstimate')?.textContent.replace(/\\s+/g, ' ').trim() || '',
      估算数字: document.querySelector('#trainEstimate b')?.textContent || null,
      算式: document.querySelector('#trainEstimate .tiny')?.textContent.replace(/\\s+/g, ' ').trim() || '',
      统计: [...document.querySelectorAll('.stats .stat')].map((s) => s.textContent.replace(/\\s+/g, ' ').trim()),
      力量: [...document.querySelectorAll('#trainStrength .chip')].map((c) => c.textContent.trim()),
      有器械: !!document.querySelector('[data-train-eq]'),
    };
  })()`);
  console.log(`✅ 「练的」面板：${train.动作数} 个动作可选（${train.前几个动作.join('、')}…），默认选中「${train.默认动作}」`);
  console.log(`   力量训练：${train.力量.join('、')}｜器械可勾选 ${train.有器械}`);
  console.log(`   统计：${train.统计.join(' · ')}`);
  console.log(`   估算：${train.估算文案.slice(0, 70)}…`);
  if (train.吃的输入框还在) problems.push('切到「练的」之后「吃的」输入框还留在页面上');
  if (!train.动作数) problems.push('「练的」一个动作都没列出来');
  if (!train.力量.length) problems.push('「练的」里没有力量训练（跟着计划练力量的人没法记）');
  if (!/^\d+$/.test(train.估算数字 || '')) problems.push(`没有显示这次的估算消耗（读到「${train.估算数字}」）`);
  if (!train.估算文案.includes('估算')) problems.push('消耗没有标明是估算');
  if (train.估算文案.includes('可以多吃') || train.估算文案.includes('奖励')) problems.push('运动面板的文案在暗示「练了可以多吃」');
  if (train.统计.length !== 3) problems.push('运动记录里缺少「今天 / 这周 / 累计」三个数字');

  // 版面：手机宽度下不许横向溢出（器械 + 动作 + 时长 + 强度全是 chips，换行写错就会撑破屏幕）
  const layout = await evaluate(`(() => {
    const de = document.documentElement;
    const cutOff = [...document.querySelectorAll('#app button, #app .btn, #app .chip, #app .card, #app input')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 0.6 || r.left < -0.6); })
      .map((el) => (el.textContent || el.tagName).trim().slice(0, 16));
    return { 视口: window.innerWidth, 文档宽: de.scrollWidth, 横向溢出: de.scrollWidth > window.innerWidth + 1, 跑出屏幕: [...new Set(cutOff)].slice(0, 5) };
  })()`);
  console.log(layout.横向溢出 || layout.跑出屏幕.length
    ? `❌ 「练的」版面：文档宽 ${layout.文档宽} / 视口 ${layout.视口}，跑出屏幕：${layout.跑出屏幕.join('、')}`
    : `✅ 「练的」版面：${layout.视口}px 宽下没有横向溢出，也没有元素跑出屏幕`);
  if (layout.横向溢出) problems.push('「练的」面板在手机宽度下横向溢出');
  if (layout.跑出屏幕.length) problems.push(`「练的」面板有 ${layout.跑出屏幕.length} 个元素跑出屏幕`);

  // 改时长：估算必须立刻跟着变（不能等点了「记上」才重算）
  const kcalBefore = Number(train.估算数字);
  await evaluate(`(() => {
    const inp = document.querySelector('#trainMinutesInput');
    inp.value = '40';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(250);
  const after40 = await evaluate(`(() => ({
    数字: document.querySelector('#trainEstimate b')?.textContent || null,
    算式: document.querySelector('#trainEstimate .tiny')?.textContent.replace(/\\s+/g, ' ').trim() || null,
  }))()`);
  console.log(`✅ 把时长改成 40 分钟：估算 ${kcalBefore} → ${after40.数字} kcal（${after40.算式.slice(0, 52)}）`);
  if (!(Number(after40.数字) > kcalBefore)) problems.push('改了时长但估算消耗没有重算');

  // 记上：确认写进存档、提示出现、统计数字跟着变
  const statsBefore = await evaluate(`[...document.querySelectorAll('.stats .stat')].map((s) => s.textContent.replace(/\\s+/g, ' ').trim())`);
  await evaluate(`document.querySelector('#trainSave').click()`);
  await sleep(700);
  const savedTrain = await evaluate(`(() => {
    const st = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    const key = Object.keys(st.days).sort().pop();
    const list = st.days[key].exercises || [];
    const t = [...document.querySelectorAll('.toast')].pop();
    return {
      条数: list.length,
      最后一条: list[list.length - 1] || null,
      提示: t ? t.textContent.trim() : null,
      统计: [...document.querySelectorAll('.stats .stat')].map((s) => s.textContent.replace(/\\s+/g, ' ').trim()),
      历史条数: document.querySelectorAll('.card .entry .name').length,
      分段还在练的: (document.querySelector('#recordTabs .seg-btn.on')?.textContent || '').includes('练的'),
    };
  })()`);
  const rec = savedTrain.最后一条 || {};
  console.log(`✅ 记上了：${rec.name} ${rec.minutes} 分钟（METs ${rec.mets}）｜提示：${savedTrain.提示}`);
  console.log(`   统计 ${statsBefore.join(' · ')} → ${savedTrain.统计.join(' · ')}`);
  if (savedTrain.条数 === 0 || rec.minutes !== 40) problems.push(`这次运动没有正确写进存档（minutes=${rec.minutes}）`);
  if (!(rec.mets > 1)) problems.push('记录里没有存下 METs（那今天页会按旧强度算错消耗）');
  if (!rec.name) problems.push('记录里没有存下动作名（历史会显示成 key）');
  if (!(savedTrain.提示 || '').includes('记上了')) problems.push('记完运动没有即时反馈');
  if (savedTrain.统计[0] === statsBefore[0]) problems.push('记完之后「今天几次」没有变');
  if (savedTrain.历史条数 === 0) problems.push('运动历史列表里没有出现刚记的这条');
  if (!savedTrain.分段还在练的) problems.push('记完之后分段跳走了（应当留在「练的」）');
  // 界面显示的估算和记录里的 METs 手算结果要对得上（差 1 以内是四舍五入）
  const handKcal = Math.round(rec.mets * 58 * 40 / 60);
  if (Math.abs(Number(after40.数字) - handKcal) > 1) {
    problems.push(`显示的估算 ${after40.数字} 和手算 ${handKcal} 对不上（METs ${rec.mets} × 58kg × 40 分钟）`);
  }

  const shotTrain = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'shot-training.png'), Buffer.from(shotTrain.data, 'base64'));

  // 回今天页：额度必须一分没变（红线），而且能看到刚记的运动
  await evaluate(`document.querySelector('.tab[data-view="today"]')?.click()`);
  await sleep(500);
  const heroAfter = await evaluate(`(() => ({
    剩余: document.querySelector('.ring-center .big')?.textContent || null,
    标签: document.querySelector('.ring-center .cap')?.textContent || null,
    已吃: document.querySelector('.hero .sub')?.textContent.replace(/\\s+/g, ' ').trim() || null,
    运动胶囊: document.querySelector('.bonus-pill')?.textContent.replace(/\\s+/g, ' ').trim() || null,
    今天运动: [...document.querySelectorAll('.hero .stat')].map((s) => s.textContent.replace(/\\s+/g, ' ').trim()).find((t) => t.includes('运动')) || null,
    运动卡片: (() => {
      const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('今天的运动'));
      return card ? card.textContent.replace(/\\s+/g, ' ').trim().slice(0, 110) : null;
    })(),
  }))()`);
  console.log(`   记运动后：${heroAfter.标签} ${heroAfter.剩余} kcal ｜ ${heroAfter.已吃}`);
  console.log(`   今天页运动：${heroAfter.今天运动}｜${(heroAfter.运动卡片 || '').slice(0, 78)}…`);
  console.log(`   运动胶囊：${heroAfter.运动胶囊 || '（没有）'}`);
  if (heroAfter.剩余 !== heroBefore.剩余 || heroAfter.标签 !== heroBefore.标签) {
    problems.push(`记运动把「${heroBefore.标签} ${heroBefore.剩余}」变成了「${heroAfter.标签} ${heroAfter.剩余}」—— 运动消耗不许加回当天可吃的额度`);
  }
  if (heroAfter.已吃 !== heroBefore.已吃) problems.push('什么都没吃，已吃热量却变了');
  // 运动胶囊本身可以有，但不许出现「奖励 / 已计入」这种「练了可以多吃」的暗示
  if (heroAfter.运动胶囊 && /奖励|已计入|可以多吃/.test(heroAfter.运动胶囊)) {
    problems.push(`首页的运动胶囊还在暗示「练了可以多吃」：${heroAfter.运动胶囊}`);
  }
  if (!(heroAfter.今天运动 || '').includes('40')) problems.push('今天页没有显示刚记的 40 分钟运动');

  // 分段要记住：重新打开还停在「练的」
  await client.send('Page.navigate', { url: BASE + '/' });
  await sleep(2000);
  await evaluate(`document.querySelector('.tab[data-view="log"]')?.click()`);
  await sleep(450);
  const remembered = await evaluate(`(() => ({
    分段: document.querySelector('#recordTabs .seg-btn.on')?.textContent.trim() || null,
    有运动面板: !!document.querySelector('[data-train-cardio]'),
    统计: [...document.querySelectorAll('.stats .stat')].map((s) => s.textContent.replace(/\\s+/g, ' ').trim()),
  }))()`);
  console.log(remembered.有运动面板
    ? `✅ 重新打开还停在「${remembered.分段}」（统计：${remembered.统计.join(' · ')}）`
    : `❌ 重新打开分段变回「${remembered.分段}」`);
  if (!remembered.有运动面板) problems.push('分段没有记住，重新打开又回到「吃的」');

  // 历史列表里删「前几天」的记录：删除按钮必须带上记录自己那一天。
  // 不带的话会拿当前选中的日期去删，找不到就静默什么都不做 —— 表现是「点了没反应」，最难查。
  await evaluate(`(async () => {
    const store = await import('./js/store.js');
    const ex = await import('./js/exercise.js');
    const st = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    ex.logTraining(st, store.shiftDate(store.todayKey(), -4), { exerciseKey: 'strength', minutes: 40 });
    ex.logTraining(st, store.shiftDate(store.todayKey(), -5), { cardioId: 'swim_steady', minutes: 25 });
    localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
    return true;
  })()`);
  await client.send('Page.navigate', { url: BASE + '/' });
  await sleep(1800);
  await evaluate(`document.querySelector('.tab[data-view="log"]')?.click()`);
  await sleep(450);
  const pastBefore = await evaluate(`(() => {
    const st = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    const days = Object.entries(st.days).filter(([, d]) => (d.exercises || []).length).map(([k, d]) => k + ':' + d.exercises.length);
    return { 天数: days.join(','), 行数: document.querySelectorAll('#app .entry').length };
  })()`);
  const pastDel = await evaluate(`(async () => {
    // 必须挑「不是今天」的那一行 —— 今天的记录就算按钮没带日期也能删掉，测不出问题
    const store = await import('./js/store.js');
    const today = store.todayKey();
    const row = [...document.querySelectorAll('#app .entry')].find((r) => {
      const d = r.querySelector('.del')?.dataset.date;
      return d && d !== today;
    });
    if (!row) return null;
    const del = row.querySelector('.del');
    const info = { 日期: del.dataset.date, 文案: row.querySelector('.name').textContent.replace(/\\s+/g, ' ').trim().slice(0, 18) };
    del.click();
    return info;
  })()`);
  await sleep(600);
  const pastAfter = await evaluate(`(() => {
    const st = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    const days = Object.entries(st.days).filter(([, d]) => (d.exercises || []).length).map(([k, d]) => k + ':' + d.exercises.length);
    return { 天数: days.join(','), 行数: document.querySelectorAll('#app .entry').length };
  })()`);
  console.log(`✅ 历史里删「${pastDel?.日期}」那条（${pastDel?.文案}）：有记录的天 ${pastBefore.天数} → ${pastAfter.天数}`);
  if (!pastDel) problems.push('历史列表的删除按钮没有带 data-date（删前几天的记录会静默失败）');
  else if (pastBefore.天数 === pastAfter.天数 && pastBefore.行数 === pastAfter.行数) {
    problems.push(`删「${pastDel.日期}」那条没有生效（点了没反应）`);
  }

  console.log('\n=== 三·二、计划页的记录入口没被改坏（两处都能记，走同一条路）===');
  const exBefore = await evaluate(`(() => {
    const st = JSON.parse(localStorage.getItem('fatloss.state.v2'));
    const key = Object.keys(st.days).sort().pop();
    return (st.days[key].exercises || []).length;
  })()`);
  await evaluate(`document.querySelector('.tab[data-view="plan"]').click()`);
  await sleep(600);
  const planEntry = await evaluate(`(() => {
    const btn = document.querySelector('[data-log-cardio]');
    return { 有按钮: !!btn, 文案: btn ? btn.textContent.trim() : null };
  })()`);
  if (!planEntry.有按钮) {
    console.log('❌ 计划页没有「今天就做这个」按钮');
    problems.push('计划页的记录入口消失了');
  } else {
    await evaluate(`document.querySelector('[data-log-cardio]').click()`);
    await sleep(700);
    const planLogged = await evaluate(`(() => {
      const st = JSON.parse(localStorage.getItem('fatloss.state.v2'));
      const key = Object.keys(st.days).sort().pop();
      const list = st.days[key].exercises || [];
      const t = [...document.querySelectorAll('.toast')].pop();
      const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('今天已经记了'));
      return {
        条数: list.length,
        最后一条: list[list.length - 1] || null,
        提示: t ? t.textContent.trim() : null,
        卡片: card ? card.textContent.replace(/\\s+/g, ' ').trim().slice(0, 90) : null,
      };
    })()`);
    console.log(`✅ 计划页「${planEntry.文案}」→ ${planLogged.提示}`);
    console.log(`   今天已经记了：${(planLogged.卡片 || '').slice(0, 80)}…`);
    if (planLogged.条数 !== exBefore + 1) problems.push('计划页的记录入口没有写进记录');
    if (!(planLogged.最后一条?.mets > 1)) problems.push('计划页记的运动没存 METs');
    if (!(planLogged.提示 || '').includes('记上了')) problems.push('计划页记完没有反馈');
  }

  // 回到「吃的」：老流程一点没变（说一句 + 搜索 + 常吃的都在）
  await evaluate(`document.querySelector('.tab[data-view="log"]').click()`);
  await sleep(400);
  await evaluate(`document.querySelector('[data-record-tab="food"]').click()`);
  await sleep(450);
  const backToFood = await evaluate(`(() => ({
    输入框: !!document.querySelector('#quickText'),
    搜索框: !!document.querySelector('#logSearch'),
    常吃的卡片: !!document.querySelector('[data-act="quick-add"]'),
  }))()`);
  console.log(backToFood.输入框 && backToFood.搜索框
    ? `✅ 切回「吃的」：说一句 ${backToFood.输入框}｜搜索食物 ${backToFood.搜索框}｜常吃的 ${backToFood.常吃的卡片}`
    : '❌ 切回「吃的」之后旧内容丢了');
  if (!backToFood.输入框 || !backToFood.搜索框) problems.push('切回「吃的」之后原有的记录功能不见了');

  if (pageErrors.length) {
    console.log('\n=== 页面运行时异常 ===');
    for (const e of [...new Set(pageErrors)]) console.log('  ❌', e);
    problems.push(`页面抛了 ${pageErrors.length} 次异常（见上）`);
  }

  console.log('\n=== 结论 ===');
  if (problems.length) {
    console.log('❌ 有问题：');
    for (const p of problems) console.log('  -', p);
    process.exitCode = 1;
  } else {
    console.log('✅ 说一句记录 + 按器械换动作 + 运动记录（含「额度不许变」的红线），三条流程都跑通');
  }
  console.log(`截图：${outDir}/shot-quicklog.png、shot-portion.png（份量反问那块）、shot-cardio.png、shot-training.png（练的那一半）`);
  void errors;
  finishAndExit(process.exitCode || 0, [() => client.close(), () => chrome.kill()]);
}

armWatchdog('quicklog-check.mjs', 200);

// 失败路径也必须收尾：只设 exitCode 的话进程会一直挂着（被看门狗杀掉 → 退出码又变了）
main().catch((err, cleanup) => {
  console.error(`自检失败：${err.message}`);
  finishAndExit(1, Array.isArray(cleanup) ? cleanup : []);
});
process.on('uncaughtException', (err) => {
  console.error(`自检异常：${err.message}`);
  finishAndExit(1);
});
