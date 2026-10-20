/**
 * 「照包装营养成分表记」的端到端自检
 *
 * 场景对应用户真实需求：包装上印的是「能量 349 千焦 / 蛋白 13.7 / 脂肪 0.7 / 碳水 5.3」，
 * 而食物库里的「鸡胸肉（生）」是 118 kcal —— 两者不是同一种东西（预制调理含水/淀粉）。
 *
 * 这个脚本验证四件事（全走真实界面，只看用户看得到的东西）：
 *  1) 手动照包装填：千焦自动换算成 83.4 kcal，对账通过，能存成「我的食物」并按克数记上；
 *  2) 拍照读表：用假服务商（零费用）返回读数，字段要自动填好，但她还得点保存；
 *  3) 模型看不了图时：说人话，不崩，手动填照样能用；
 *  4) 模型读回离谱数字（5000 kcal）时：本地拦下来，绝不允许存进记录。
 *
 * 用法：node tools/label-check.mjs
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { armWatchdog } from './watchdog.mjs';
import { findChrome } from './chrome-path.mjs';
import { portAlive, freePort } from './chrome-launch.mjs';

armWatchdog('label-check', 240);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.audit', 'label');
const profileDir = path.join(outDir, 'profile');
const CHROME = findChrome();
const STATIC_PORT = 4199;
const FAKE_PORT = 18883;
const CDP_PORT = 9414;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const problems = [];
const pass = (m) => console.log(`✅ ${m}`);
const fail = (m) => { console.log(`❌ ${m}`); problems.push(m); };

/* ── 假服务商：看请求里有没有图片，按场景返回 ─────────── */
let scenario = 'ok';
const LABEL_REPLY = JSON.stringify({
  name: '低脂鸡胸肉', baseGrams: 100,
  energy: { value: 349, unit: 'kJ' },
  protein: 13.7, fat: 0.7, carb: 5.3,
});

function startFakeProvider() {
  return http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'authorization,content-type',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-vl' }] }));
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* 认不出就按空处理 */ }
      const hasImage = JSON.stringify(body?.messages || []).includes('image_url');
      if (!hasImage) {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'expected image' } }));
        return;
      }
      if (scenario === 'bad-model') {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'This model does not support image input' } }));
        return;
      }
      if (scenario === 'absurd') {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ name: '离谱食物', baseGrams: 100, energy: { value: 5000, unit: 'kcal' }, protein: 10, fat: 10, carb: 10 }) } }] }));
        return;
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: LABEL_REPLY } }] }));
    });
  });
}

/* ── CDP 小工具 ─────────────────────────────────── */
async function freePortAndWait(port) {
  if (!(await portAlive(port))) return;
  freePort(port);
  for (let i = 0; i < 25 && (await portAlive(port)); i++) await sleep(200);
}
async function waitForChrome(port, t = 30000) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return r.json();
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  throw new Error('无头 Chrome 没起来');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('open', () => resolve({
      errors,
      send(method, params = {}) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((res, rej) => pending.set(i, { res, rej }));
      },
      close() { try { ws.close(); } catch { /* 已关 */ } },
    }));
    ws.addEventListener('error', reject);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
    });
  });
}
async function ev(client, expr) {
  const r = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(fn, what, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`等不到：${what}`);
}

/* 1×1 PNG：内容无所谓，假服务商不看图 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function boot(client) {
  await client.send('Page.navigate', { url: `http://127.0.0.1:${STATIC_PORT}/` });
  await waitFor(() => ev(client, `window.__appReady === true`), '页面启动');
  await sleep(400);
}

/** 预置一个「已完成引导、AI 直连已配置」的存档（不碰真实配置，只写这个测试浏览器的 localStorage） */
async function seed(client) {
  await ev(client, `(() => {
    const st = {
      version: 4, schemaVersion: 4,
      profile: { nickname: '', sex: 'female', age: 26, heightCm: 163, weightKg: 58, bodyFatPct: null, activity: 'light', pace: 'standard', goal: 'lose', targetWeightKg: 54 },
      settings: { onboarded: true, mode: 'ai', trainDays: 3, stepsKey: 'mid' },
      days: {}, customFoods: [], weights: [],
      achievements: { seen: [], lastWeeklyAt: null, milestones: [] },
    };
    localStorage.setItem('fatloss.state.v2', JSON.stringify(st));
    localStorage.setItem('fatloss.ai.v1', JSON.stringify({
      presetId: 'custom',
      baseUrl: 'http://127.0.0.1:${FAKE_PORT}/v1',
      model: 'mock-vl',
      apiKey: 'sk-label-check-fake', // secret-scan:allow 假密钥，只写进测试浏览器的 localStorage
      mode: 'direct',
      updatedAt: new Date().toISOString(),
    }));
    return true;
  })()`);
}

/** 打开「记录 → 加食物 → 照包装填」 */
async function openLabelSheet(client) {
  await ev(client, `document.querySelector('.tab[data-view="log"]').click()`);
  await sleep(500);
  await ev(client, `document.querySelector('#customFoodBtn')?.click()`);
  await waitFor(() => ev(client, `!!document.querySelector('#labelName')`), '照包装弹层出现');
  await sleep(300);
}

async function fillManual(client, { energy, unit, protein, fat, carb, name = '手填测试食物' }) {
  await ev(client, `(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('labelName', ${JSON.stringify(name)});
    set('labelBase', '100');
    set('labelEnergy', ${JSON.stringify(String(energy))});
    set('labelProtein', ${JSON.stringify(String(protein))});
    set('labelFat', ${JSON.stringify(String(fat))});
    set('labelCarb', ${JSON.stringify(String(carb))});
    return true;
  })()`);
  if (unit) {
    await ev(client, `[...document.querySelectorAll('#labelUnit [data-unit]')].find((b) => b.dataset.unit === ${JSON.stringify(unit)}).click()`);
  }
  await sleep(250);
  return ev(client, `({
    预览: (document.querySelector('#labelPreview')?.textContent || '').replace(/\\\\s+/g, ' ').trim(),
    预览类名: document.querySelector('#labelPreview')?.className,
  })`);
}

async function saveLabel(client) {
  await ev(client, `document.querySelector('#labelSave')?.click()`);
  await sleep(900);
  return ev(client, `({
    弹层还开着: !document.querySelector('#sheetRoot')?.classList.contains('hidden'),
    标题: document.querySelector('#sheetTitle')?.textContent || null,
    toast: document.querySelector('.toast')?.textContent || null,
    自定义食物: (() => { try { const s = JSON.parse(localStorage.getItem('fatloss.state.v2')||'{}'); return (s.customFoods||[]).map((f) => ({ name: f.name, kcal: f.kcal, protein: f.protein, servings: f.servings })); } catch { return []; } })(),
  })`);
}

async function main() {
  const fake = startFakeProvider();
  await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));

  fs.mkdirSync(outDir, { recursive: true });
  const fixture = path.join(outDir, 'label-fixture.png');
  fs.writeFileSync(fixture, PNG);
  // 上一次的 profile 清不掉时不能让整条自检崩掉（其他自检脚本也都是这么兜的）；
  // 清不掉的后果只是 Chrome 复用旧 profile，不影响本次结果。
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* 清不掉就继续 */ }
  await freePortAndWait(CDP_PORT);

  const staticServer = spawn(process.execPath, [path.join(root, 'tools/serve.mjs'), String(STATIC_PORT)], { stdio: 'ignore' });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore' });

  let client;
  try {
    // 等静态服务
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${STATIC_PORT}/`); if (r.ok) break; } catch { /* 继续等 */ }
      await sleep(300);
    }
    const version = await waitForChrome(CDP_PORT);
    console.log(`浏览器：${version.Browser}\n`);
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    client = await connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('DOM.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    await boot(client);
    await seed(client);
    await boot(client);
    await openLabelSheet(client);

    /* ── 一、手动照包装填（她那张图上的数字） ── */
    console.log('=== 一、手动照包装填 ===');
    const ui = await ev(client, `({
      有拍照: !!document.querySelector('#labelShot'),
      有单位切换: document.querySelectorAll('#labelUnit [data-unit]').length,
      默认单位: [...document.querySelectorAll('#labelUnit [data-unit]')].find((b) => b.classList.contains('on'))?.dataset.unit || null,
    })`);
    console.log(`   拍照按钮 ${ui.有拍照}｜单位切换 ${ui.有单位切换} 个｜默认单位 ${ui.默认单位}`);
    if (!ui.有单位切换) fail('没有千焦/千卡切换，国内包装没法直接抄');

    const filled = await fillManual(client, { energy: 349, unit: 'kJ', protein: 13.7, fat: 0.7, carb: 5.3, name: '低脂鸡胸肉' });
    console.log(`   预览：${filled.预览}`);
    if (!/83\.4\s*kcal/.test(filled.预览)) fail(`349 千焦没有换算成 83.4 kcal（预览：${filled.预览}）`);
    if (!/对得上/.test(filled.预览)) fail(`和营养素对得上时应当明确说「对得上」（预览：${filled.预览}）`);

    const saved = await saveLabel(client);
    const custom = saved.自定义食物.find((f) => f.name === '低脂鸡胸肉');
    if (!custom) fail('保存后「我的食物」里没有这条');
    else {
      const okKcal = Math.abs(custom.kcal - 83.4) < 0.2;
      if (!okKcal) fail(`保存的热量不对：${custom.kcal}（应为 83.4）`);
      else pass(`手动填：349 千焦 → 83.4 kcal，已存成「我的食物」`);
    }
    // 存完会自动打开「吃了多少」弹层，直接记 100 克
    const amountOpen = await ev(client, `!!document.querySelector('#amountInput')`);
    if (!amountOpen) fail('保存后没有接着问「吃了多少」（多一步操作）');
    else {
      await ev(client, `(() => {
        const el = document.getElementById('amountInput');
        el.value = '100';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(200);
      await ev(client, `document.querySelector('#confirmAmount')?.click()`);
      await sleep(600);
      const logged = await ev(client, `(() => {
        const s = JSON.parse(localStorage.getItem('fatloss.state.v2')||'{}');
        const day = s.days?.[Object.keys(s.days||{})[0]] || {};
        const entries = Object.values(day.meals || {}).flat();
        return { 条数: entries.length, kcal: entries[0] ? Math.round((entries[0].food.kcal * entries[0].grams) / 100) : null, 名称: entries[0]?.food?.name || null };
      })()`);
      console.log(`   记到当天：${logged.名称} → ${logged.kcal} kcal`);
      if (logged.条数 !== 1) fail(`记完之后当天应当有 1 条，实际 ${logged.条数}`);
      else if (logged.kcal !== 83) fail(`100 克应当是 83 kcal，实际 ${logged.kcal}`);
      else pass('按克数记上：100 克 = 83 kcal');
    }

    /* ── 二、拍照读表（假服务商返回她那张表） ── */
    console.log('\n=== 二、拍照读表 ===');
    await openLabelSheet(client);
    // 拦截文件选择框，再用 CDP 把真实文件塞进 input
    await ev(client, `(() => {
      const orig = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function (...a) {
        if (this.type === 'file') return;
        return orig.apply(this, a);
      };
      document.querySelector('#labelShot')?.click();
      return true;
    })()`);
    await sleep(200);
    const doc = await client.send('DOM.getDocument', { depth: -1 });
    const inputs = [];
    const walk = (n) => { if (n.nodeName === 'INPUT') inputs.push(n.nodeId); for (const c of n.children || []) walk(c); };
    walk(doc.root);
    let injected = false;
    for (const nodeId of inputs) {
      try { await client.send('DOM.setFileInputFiles', { nodeId, files: [fixture] }); injected = true; break; } catch { /* 不是文件输入 */ }
    }
    if (!injected) fail('没能把图片塞进「拍营养成分表」的输入框（拍照入口可能没接上）');
    else {
      await ev(client, `document.getElementById('labelFile').dispatchEvent(new Event('change'))`);
      await waitFor(() => ev(client, `document.getElementById('labelEnergy').value === '349'`), '读表结果填进表单');
      const filledByAi = await ev(client, `({
        名称: document.getElementById('labelName').value,
        每份: document.getElementById('labelBase').value,
        能量: document.getElementById('labelEnergy').value,
        单位: [...document.querySelectorAll('#labelUnit [data-unit]')].find((b) => b.classList.contains('on'))?.dataset.unit,
        蛋白: document.getElementById('labelProtein').value,
        hint: document.getElementById('labelShotHint')?.textContent || '',
        预览: (document.querySelector('#labelPreview')?.textContent || '').replace(/\\\\s+/g, ' ').trim(),
      })`);
      console.log(`   读出：${filledByAi.名称}｜${filledByAi.能量} ${filledByAi.单位}｜蛋白 ${filledByAi.蛋白}｜${filledByAi.hint}`);
      if (filledByAi.能量 !== '349' || filledByAi.单位 !== 'kJ') fail(`拍照读表没有正确填单位/数字：${JSON.stringify(filledByAi)}`);
      if (!/83\.4/.test(filledByAi.预览)) fail('读出来之后没有自动换算成 kcal 预览');
      const savedAi = await saveLabel(client);
      const aiCustom = savedAi.自定义食物.find((f) => f.name === '低脂鸡胸肉' && Math.abs(f.kcal - 83.4) < 0.2);
      if (aiCustom) pass('拍照 → 读表 → 纠正/保存 全链路通');
      else fail(`拍照读表后保存的内容不对：${JSON.stringify(savedAi.自定义食物)}`);
      // 关掉可能还开着的份量弹层
      await ev(client, `document.querySelector('#sheetClose')?.click()`);
      await sleep(300);
    }

    /* ── 三、模型看不了图：说人话，手动填照样能用 ── */
    console.log('\n=== 三、模型不支持看图 ===');
    scenario = 'bad-model';
    await openLabelSheet(client);
    await ev(client, `(() => {
      const orig = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function (...a) { if (this.type === 'file') return; return orig.apply(this, a); };
      document.querySelector('#labelShot')?.click();
      return true;
    })()`);
    await sleep(200);
    const doc2 = await client.send('DOM.getDocument', { depth: -1 });
    const inputs2 = [];
    const walk2 = (n) => { if (n.nodeName === 'INPUT') inputs2.push(n.nodeId); for (const c of n.children || []) walk2(c); };
    walk2(doc2.root);
    for (const nodeId of inputs2) {
      try { await client.send('DOM.setFileInputFiles', { nodeId, files: [fixture] }); break; } catch { /* 跳过 */ }
    }
    await ev(client, `document.getElementById('labelFile').dispatchEvent(new Event('change'))`);
    await sleep(1500);
    const badHint = await ev(client, `document.getElementById('labelShotHint')?.textContent || ''`);
    console.log(`   提示：${badHint}`);
    if (!/看不了图片|不支持/.test(badHint)) fail(`模型不支持看图时提示不清楚：${badHint}`);
    if (!/qwen-vl|glm-4v|gpt-4o|手动填/.test(badHint)) fail('没有告诉她换什么模型、或者可以手动填');
    scenario = 'ok';
    // 手动还能用
    await fillManual(client, { energy: 100, unit: 'kcal', protein: 5, fat: 2, carb: 10, name: '出错后手填' });
    const savedManual = await saveLabel(client);
    if (savedManual.自定义食物.some((f) => f.name === '出错后手填')) pass('读图失败后手动填照样能保存');
    else fail('读图失败后手动填没能保存');
    await ev(client, `document.querySelector('#sheetClose')?.click()`);
    await sleep(300);

    /* ── 四、模型读回离谱数字：本地必须拦下 ── */
    console.log('\n=== 四、模型读回离谱数字（5000 kcal/100g） ===');
    scenario = 'absurd';
    await openLabelSheet(client);
    await ev(client, `(() => {
      const orig = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function (...a) { if (this.type === 'file') return; return orig.apply(this, a); };
      document.querySelector('#labelShot')?.click();
      return true;
    })()`);
    await sleep(200);
    const doc3 = await client.send('DOM.getDocument', { depth: -1 });
    const inputs3 = [];
    const walk3 = (n) => { if (n.nodeName === 'INPUT') inputs3.push(n.nodeId); for (const c of n.children || []) walk3(c); };
    walk3(doc3.root);
    for (const nodeId of inputs3) {
      try { await client.send('DOM.setFileInputFiles', { nodeId, files: [fixture] }); break; } catch { /* 跳过 */ }
    }
    await ev(client, `document.getElementById('labelFile').dispatchEvent(new Event('change'))`);
    await sleep(1500);
    const absurd = await ev(client, `({
      预览类名: document.querySelector('#labelPreview')?.className,
      预览: (document.querySelector('#labelPreview')?.textContent || '').replace(/\\\\s+/g, ' ').trim(),
    })`);
    console.log(`   预览：${absurd.预览}`);
    if (absurd.预览类名 !== 'warn') fail('离谱数字没有被标成警告');
    if (!/太高|千焦/.test(absurd.预览)) fail(`没有提示「是不是千焦当千卡」（预览：${absurd.预览}）`);
    const before = await ev(client, `(JSON.parse(localStorage.getItem('fatloss.state.v2')||'{}').customFoods||[]).length`);
    await ev(client, `document.querySelector('#labelSave')?.click()`);
    await sleep(600);
    const afterSave = await ev(client, `({
      数量: (JSON.parse(localStorage.getItem('fatloss.state.v2')||'{}').customFoods||[]).length,
      toast: document.querySelector('.toast')?.textContent || '',
    })`);
    if (afterSave.数量 !== before) fail('离谱数字竟然被存进了「我的食物」');
    else if (!/太高|千焦|太/.test(afterSave.toast)) fail(`拒绝保存时提示不清楚：${afterSave.toast}`);
    else pass('离谱数字被本地拦下，没有落库');

    /* ── 五、全程异常 ── */
    console.log('\n=== 五、全程异常 ===');
    const errs = client.errors.filter((e) => !/favicon/i.test(e));
    if (errs.length) fail(`页面上有未捕获异常：${errs[0].slice(0, 160)}`);
    else pass('全程没有未捕获异常');
    await client.send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(outDir, 'label-check.png'), Buffer.from(r.data, 'base64')));
  } finally {
    try { client?.close(); } catch { /* 已关 */ }
    try { chrome.kill('SIGKILL'); } catch { /* 已退 */ }
    try { staticServer.kill('SIGKILL'); } catch { /* 已退 */ }
    try { fake.close(); } catch { /* 已关 */ }
  }

  console.log('\n════════ 结果 ════════');
  if (problems.length) {
    console.log(`❌ ${problems.length} 个问题：`);
    for (const p of problems) console.log(`   · ${p}`);
  } else {
    console.log('✅ 照包装营养成分表（含拍照读表）全流程通过');
  }
  console.log(`截图：${path.relative(root, outDir)}/label-check.png`);
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\n❌ 自检脚本自己崩了：', err.message);
  process.exit(1);
});
