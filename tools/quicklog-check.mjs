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
import { findChrome } from './chrome-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.selfcheck');
const CHROME = findChrome();
const PORT = 9337;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
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
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(outDir, 'chrome-quicklog')}`,
    '--window-size=390,844', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });

  for (let i = 0; i < 40; i++) {
    try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); }
  }
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const client = await connect(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  const errors = [];
  const evaluate = async (expression) => {
    const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
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

  // 改份量：把第一条改成 800 克，看合计有没有跟着变
  const before = await evaluate(`document.querySelector('#draftHost .row.between b').textContent`);
  await evaluate(`(() => {
    const inp = document.querySelector('#draftHost .draft-grams');
    inp.value = '800';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  const after = await evaluate(`document.querySelector('#draftHost .row.between b').textContent`);
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

  console.log('\n=== 一·五、正反馈：小植物 / 徽章 / 庆祝 ===');
  // 回今天页，找成长入口
  await evaluate(`document.querySelector('.tab[data-view="today"]').click()`);
  await sleep(400);
  const plantCard = await evaluate(`(() => {
    const el = document.querySelector('.plant-card');
    return el ? { 文案: el.textContent.replace(/\\s+/g, ' ').trim() } : null;
  })()`);
  console.log(plantCard ? `✅ 今天页有小植物入口：${plantCard.文案}` : '❌ 没有小植物入口');
  const personal = await evaluate(`(() => ({
    顶部昵称签: document.querySelector('#nameTag')?.textContent.trim() || null,
    问候语: document.querySelector('.greet')?.textContent.replace(/\\s+/g, ' ').trim() || null,
  }))()`);
  console.log(`✅ 个性化：顶部签「${personal.顶部昵称签}」｜问候「${personal.问候语}」`);
  if (!personal.顶部昵称签) problems.push('顶部没有显示她的昵称');
  if (!personal.问候语 || !personal.问候语.includes('小繁')) problems.push('问候语里没有她的名字');
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
  const specialBadges = await evaluate(`[...document.querySelectorAll('.badge-grid .ach.special .ach-name')].map((e) => e.textContent.trim())`);
  console.log(`✅ 成长弹层：「${growth.标题}」徽章 ${growth.徽章数} 个（已解锁 ${growth.已解锁}，未解锁带进度条 ${growth.有进度条} 个）`);
  console.log(`   专属徽章：${specialBadges.join('、') || '（没找到）'}`);
  if (!specialBadges.length) problems.push('徽章墙里没有专属徽章');
  if (specialBadges.some((t) => !t.includes('小繁'))) problems.push(`专属徽章没有带上她的昵称：${specialBadges.join('、')}`);
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
  await evaluate(`document.querySelector('#profileBtn').click()`);
  await sleep(700);
  const settings = await evaluate(`(() => ({
    标题: document.querySelector('#sheetTitle')?.textContent || '',
    条目: [...document.querySelectorAll('.set-row .set-main b')].map((e) => e.textContent.trim()),
  }))()`);
  console.log(`✅ 设置页：「${settings.标题}」包含 ${settings.条目.join('、')}`);
  for (const must of ['AI 高级版', '数据与备份', '她的资料', '关于']) {
    if (!settings.条目.includes(must)) problems.push(`设置页缺少「${must}」`);
  }

  // 备份页：导出/导入/快照都在
  await evaluate(`[...document.querySelectorAll('.set-row')].find((r) => r.textContent.includes('数据与备份'))?.click()`);
  await sleep(600);
  const backup = await evaluate(`(() => ({
    有导出: !!document.querySelector('#doExport'),
    有导入: !!document.querySelector('#doImport'),
    有快照按钮: !!document.querySelector('#doSnapshot'),
    存档版本显示: (document.querySelector('#sheetBody')?.textContent || '').includes('v3'),
  }))()`);
  console.log(`✅ 备份页：导出 ${backup.有导出}｜导入 ${backup.有导入}｜手动快照 ${backup.有快照按钮}｜显示存档版本 ${backup.存档版本显示}`);
  if (!backup.有导出 || !backup.有导入) problems.push('备份页缺少导出或导入');

  await evaluate(`document.querySelector('#sheetClose').click()`);
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

  console.log('\n=== 结论 ===');
  if (problems.length) {
    console.log('❌ 有问题：');
    for (const p of problems) console.log('  -', p);
    process.exitCode = 1;
  } else {
    console.log('✅ 说一句记录 + 按器械换动作，两条流程都跑通');
  }
  console.log(`截图：${outDir}/shot-quicklog.png、shot-cardio.png`);
  void errors;
  chrome.kill();
}

armWatchdog('quicklog-check.mjs', 200);

main().catch((err) => { console.error('自检失败：', err.message); process.exitCode = 1; });
