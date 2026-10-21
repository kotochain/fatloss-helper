#!/usr/bin/env node
/**
 * 拍照读表：用**真模型**跑一遍（需要真实密钥，不在 CI 里跑）
 *
 * 为什么单独有这个脚本：
 *   label-check 用的是假服务商，它只能证明「图片塞进去了、表单填上了」，
 *   证明不了「真模型看得懂中国包装、返回的形状我们接得住」。
 *   后者只有拿真密钥打过一次才知道。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx node tools/label-live.mjs
 *   可选：AI_LABEL_BASE_URL / AI_LABEL_MODEL 换别家的看图模型
 *
 * 产物：.selfcheck/label-live-*.jpg（造出来的「照片」，可以直接看）+ 控制台一张对照表
 *
 * 造图说明：没有真包装照片，就用浏览器渲染一张标准 GB 28050 样式的表，
 * 再模拟手机拍的样子（放桌上、斜着、轻微失焦、JPEG 压过）。数字是我定的，所以对错判得准。
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './chrome-launch.mjs';
import { requestLabelParse } from '../js/ai-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.selfcheck');

const KEY = process.env.DEEPSEEK_API_KEY || process.env.AI_LABEL_KEY || '';
const BASE_URL = process.env.AI_LABEL_BASE_URL || 'https://api.deepseek.com/v1';
const MODEL = process.env.AI_LABEL_MODEL || 'deepseek-flash';

if (!KEY) {
  console.log('跳过：没有密钥。用法 DEEPSEEK_API_KEY=sk-xxx node tools/label-live.mjs');
  process.exit(0);
}

/* ── 造「照片」 ───────────────────────────── */

const FONT = '"Hiragino Sans GB", "PingFang SC", sans-serif';

/** 标准营养成分表：项目 / 每份数值 / NRV% */
function labelTable({ head, rows }) {
  return `
    <div class="tbl">
      <div class="tbl-title">营养成分表</div>
      <table>
        <thead><tr><th>项目</th><th>${head}</th><th>NRV%</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2] || ''}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/** 包装背面：品名 + 配料 + 表 + 净含量，斜放在深色桌面上 */
function packageHtml({ name, sub, table, netWeight, rotate = 1.9, blur = 0.4, zoom = 1 }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; height: 100%; }
    body {
      width: 1100px; height: 1460px; overflow: hidden;
      background:
        radial-gradient(120% 80% at 20% 0%, #4a433c 0%, #2c2622 45%, #1b1714 100%),
        repeating-linear-gradient(94deg, rgba(255,255,255,.012) 0 3px, rgba(0,0,0,.012) 3px 7px);
      font-family: ${FONT};
      display: flex; align-items: center; justify-content: center;
    }
    .pack {
      width: 800px; padding: 46px 54px 40px; box-sizing: border-box;
      background: linear-gradient(168deg, #fffdf8 0%, #f7f3ea 62%, #efe8da 100%);
      border-radius: 10px;
      transform: rotate(${rotate}deg);
      zoom: ${zoom};
      box-shadow: 0 34px 70px rgba(0,0,0,.55), 0 2px 0 rgba(255,255,255,.5) inset;
      filter: blur(${blur}px) brightness(.965) contrast(.96) saturate(.94);
    }
    .brand { font-size: 17px; letter-spacing: .34em; color: #6b6257; margin-bottom: 6px; }
    .name { font-size: 33px; font-weight: 800; color: #1d1b19; letter-spacing: .04em; }
    .sub { font-size: 15px; color: #6f675c; margin-top: 7px; letter-spacing: .06em; }
    .rule { height: 2px; background: #2b2724; margin: 22px 0 14px; opacity: .82; }
    .tbl-title { font-size: 24px; font-weight: 800; color: #16130f; margin: 6px 0 10px; letter-spacing: .12em; }
    table { width: 100%; border-collapse: collapse; font-size: 19px; color: #1a1714; }
    th, td { padding: 9px 8px; text-align: left; }
    th { font-weight: 700; font-size: 18px; border-bottom: 2px solid #23201c; }
    td:nth-child(2), th:nth-child(2) { text-align: right; font-variant-numeric: tabular-nums; }
    td:nth-child(3), th:nth-child(3) { text-align: right; width: 92px; }
    tbody tr { border-bottom: 1px solid rgba(35,32,28,.22); }
    .ing { font-size: 13.5px; line-height: 1.75; color: #5a5349; margin-top: 18px; }
    .brandline { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 16px; }
    .net { font-size: 16px; color: #2a2622; font-weight: 700; letter-spacing: .06em; }
    .barcode { display: flex; gap: 2px; height: 34px; align-items: flex-end; }
    .barcode i { display: block; width: 3px; background: #1b1815; }
  </style></head><body>
    <div class="pack">
      <div class="brand">山野良品</div>
      <div class="name">${name}</div>
      <div class="sub">${sub}</div>
      <div class="rule"></div>
      ${table}
      <div class="ing">配料：${name.includes('面包') ? '小麦粉、全麦粉、水、白砂糖、植物油、酵母、食用盐' : name.includes('鸡胸') ? '鸡胸肉、水、食用盐、香辛料、三聚磷酸钠' : '鸡蛋清、乳清蛋白粉、可可粉、食用盐'}。</div>
      <div class="brandline">
        <div class="net">净含量：${netWeight}</div>
        <div class="barcode">${Array.from({ length: 26 }, (_, i) => `<i style="height:${18 + ((i * 7) % 16)}px"></i>`).join('')}</div>
      </div>
    </div>
  </body></html>`;
}

/** 包装正面：有品名有卖点，就是没有营养成分表 —— 用来验「不该硬编数字」 */
function frontHtml(name) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; }
    body { width: 1100px; height: 1460px; background: radial-gradient(120% 80% at 25% 0%, #4a433c, #1b1714);
      font-family: ${FONT}; display: flex; align-items: center; justify-content: center; }
    .pack { width: 800px; height: 1080px; border-radius: 10px; transform: rotate(-2.2deg);
      background: linear-gradient(160deg, #f6e7c8, #e2c99b 70%, #cfb589);
      box-shadow: 0 34px 70px rgba(0,0,0,.55);
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 26px;
      filter: blur(.4px) brightness(.96); }
    .logo { font-size: 20px; letter-spacing: .5em; color: #6b5430; }
    .n { font-size: 62px; font-weight: 900; color: #241c0d; letter-spacing: .1em; }
    .s { font-size: 22px; color: #4c3c1e; letter-spacing: .3em; }
    .badge { margin-top: 40px; font-size: 19px; color: #7a6338; letter-spacing: .2em; }
  </style></head><body>
    <div class="pack">
      <div class="logo">山野良品</div>
      <div class="n">${name}</div>
      <div class="s">0 添 加 蔗 糖</div>
      <div class="badge">净含量 100 克</div>
    </div>
  </body></html>`;
}

/* ── 用例（数字我定的，所以能判对错）──────────────── */

const CASES = [
  {
    id: 'per-100g',
    label: '每 100 克的表（最常见的中国包装）',
    html: packageHtml({
      name: '全麦吐司面包',
      sub: '0 蔗糖 · 高膳食纤维',
      netWeight: '400 克（8 片）',
      table: labelTable({
        head: '每 100 克',
        rows: [
          ['能量', '1078 千焦', '13%'],
          ['蛋白质', '9.2 克', '15%'],
          ['脂肪', '3.6 克', '6%'],
          ['碳水化合物', '46.5 克', '16%'],
          ['钠', '280 毫克', '14%'],
        ],
      }),
    }),
    // 每 100 克的表，baseGrams 就是 100（= 按 100 克计），不是 null
    want: { name: '全麦吐司面包', baseGrams: 100, energyValue: 1078, energyUnit: 'kJ', protein: 9.2, fat: 3.6, carb: 46.5 },
  },
  {
    id: 'per-serving',
    label: '「每份」的表（进口/蛋白棒常见）',
    html: packageHtml({
      name: '乳清蛋白棒',
      sub: '可可味 · 每份 45 克',
      netWeight: '45 克',
      rotate: -2.4,
      table: labelTable({
        head: '每份（45 克）',
        rows: [
          ['能量', '190 千卡', '9%'],
          ['蛋白质', '12.0 克', '20%'],
          ['脂肪', '7.0 克', '12%'],
          ['碳水化合物', '19.0 克', '6%'],
          ['钠', '95 毫克', '5%'],
        ],
      }),
    }),
    want: { name: '乳清蛋白棒', baseGrams: 45, energyValue: 190, energyUnit: 'kcal', protein: 12, fat: 7, carb: 19 },
  },
  {
    id: 'blurry',
    label: '拍糊了（字很小、有点失焦）——看不清就该说看不清，不能编',
    tolerant: true, // 允许返回 null（看不清），但填了数字就必须是对的
    html: packageHtml({
      name: '全麦吐司面包',
      sub: '0 蔗糖 · 高膳食纤维',
      netWeight: '400 克（8 片）',
      rotate: 4.6,
      blur: 1.15,
      zoom: 0.5,
      table: labelTable({
        head: '每 100 克',
        rows: [
          ['能量', '1078 千焦', '13%'],
          ['蛋白质', '9.2 克', '15%'],
          ['脂肪', '3.6 克', '6%'],
          ['碳水化合物', '46.5 克', '16%'],
          ['钠', '280 毫克', '14%'],
        ],
      }),
    }),
    want: { name: '全麦吐司面包', baseGrams: 100, energyValue: 1078, energyUnit: 'kJ', protein: 9.2, fat: 3.6, carb: 46.5 },
  },
  {
    id: 'very-blurry',
    label: '几乎拍废了（更小更糊）——这是边界探针，读不出就该留空',
    tolerant: true,
    html: packageHtml({
      name: '全麦吐司面包',
      sub: '0 蔗糖 · 高膳食纤维',
      netWeight: '400 克（8 片）',
      rotate: 6.2,
      blur: 1.9,
      zoom: 0.38,
      table: labelTable({
        head: '每 100 克',
        rows: [
          ['能量', '1078 千焦', '13%'],
          ['蛋白质', '9.2 克', '15%'],
          ['脂肪', '3.6 克', '6%'],
          ['碳水化合物', '46.5 克', '16%'],
          ['钠', '280 毫克', '14%'],
        ],
      }),
    }),
    want: { name: '全麦吐司面包', baseGrams: 100, energyValue: 1078, energyUnit: 'kJ', protein: 9.2, fat: 3.6, carb: 46.5 },
  },
  {
    id: 'no-label',
    label: '包装正面（没有表，必须报「没有找到」）',
    html: frontHtml('全麦吐司面包'),
    want: null,
  },
];

/* ── Chrome & 截图 ────────────────────────── */

async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  return {
    send: (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    }),
    close: () => { try { ws.close(); } catch { /* 已关 */ } },
  };
}

/** 渲染成 PNG，再模拟手机压缩成 JPEG */
async function shoot(client, html, id) {
  const url = `data:text/html;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
  await client.send('Page.navigate', { url });
  await sleep(700);
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  const png = path.join(outDir, `label-live-${id}.png`);
  const jpg = path.join(outDir, `label-live-${id}.jpg`);
  fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
  // 手机拍完先压一次（她相册里的照片本来就有压缩），再交给应用
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '58', png, '--out', jpg], { stdio: 'ignore' });
  fs.rmSync(png, { force: true });
  const buf = fs.readFileSync(jpg);
  return { jpg, dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, bytes: buf.length };
}

/* ── 主流程 ──────────────────────────────── */

const problems = [];
const port = 9421; // 专用调试端口，launchChrome 会先清掉残留的

function fmt(v) { return v === null || v === undefined ? '—' : String(v); }
function closeTo(got, want, tol = 0.06) {
  if (want === null || want === undefined) return got === null || got === undefined;
  if (typeof want === 'number') return typeof got === 'number' && Math.abs(got - want) <= Math.max(tol, want * 0.005);
  return String(got || '').trim() === String(want).trim();
}

fs.mkdirSync(outDir, { recursive: true });
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fatloss-label-live-'));
const browser = await launchChrome({ port, userDataDir: profileDir, window: '1100,1460' });

try {
  const client = await connect(port);
  await client.send('Page.enable');
  // 2 倍像素密度：手机上「视网膜屏」拍出来的字就是这个清晰度
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1100, height: 1460, deviceScaleFactor: 2, mobile: false,
  });

  console.log(`模型：${MODEL} @ ${BASE_URL}`);
  console.log(`出图：.selfcheck/label-live-*.jpg\n`);

  for (const c of CASES) {
    const shot = await shoot(client, c.html, c.id);
    console.log(`── ${c.id}｜${c.label}`);
    console.log(`   照片 ${Math.round(shot.bytes / 1024)} KB`);

    const t0 = Date.now();
    let got = null;
    let err = null;
    try {
      got = await requestLabelParse({
        imageDataUrl: shot.dataUrl,
        config: { baseUrl: BASE_URL, model: MODEL, apiKey: KEY },
      });
    } catch (e) {
      err = e.message;
    }
    const cost = ((Date.now() - t0) / 1000).toFixed(1);

    if (!c.want) {
      // 没有表的那张：必须明确报错，不能编数字
      if (err && /没有找到营养成分表/.test(err)) {
        console.log(`   ✅ ${cost}s 正确地报「没有找到营养成分表」\n`);
      } else if (got) {
        problems.push(`${c.id}：包装正面没有表，模型却读出了数字 ${JSON.stringify(got)}`);
        console.log(`   ❌ 编数字了：${JSON.stringify(got)}\n`);
      } else {
        problems.push(`${c.id}：报错信息不对 —— ${err}`);
        console.log(`   ❌ 报错不对：${err}\n`);
      }
      continue;
    }

    if (err) {
      problems.push(`${c.id}：请求失败 —— ${err}`);
      console.log(`   ❌ ${cost}s 失败：${err}\n`);
      continue;
    }

    const rows = [
      ['品名', got.name, c.want.name],
      ['baseGrams', got.baseGrams, c.want.baseGrams],
      ['能量值', got.energy?.value, c.want.energyValue],
      ['能量单位', got.energy?.unit, c.want.energyUnit],
      ['蛋白质', got.protein, c.want.protein],
      ['脂肪', got.fat, c.want.fat],
      ['碳水', got.carb, c.want.carb],
    ];
    let allOk = true;
    let sawNull = 0;
    for (const [k, g, w] of rows) {
      const blank = g === null || g === undefined || g === '';
      let ok;
      if (k === '品名') {
        ok = blank || String(g).includes('面包') || String(g).includes('蛋白棒');
      } else if (c.tolerant && blank) {
        ok = true; // 看不清就留空 —— 这是我们要的行为，不是错
        sawNull += 1;
      } else {
        ok = closeTo(g, w);
      }
      if (!ok) allOk = false;
      console.log(`   ${ok ? (blank && c.tolerant ? '○' : '✅') : '❌'} ${k.padEnd(10, ' ')} 读到 ${fmt(g).padEnd(12, ' ')} 应为 ${fmt(w)}`);
    }
    if (c.tolerant) console.log(`   （${sawNull} 个字段选择留空 = 承认看不清）`);
    if (!allOk) problems.push(`${c.id}：有字段读错（见上）`);
    console.log(`   ${allOk ? '✅' : '❌'} ${cost}s 返回\n`);
  }
  client.close();
} finally {
  browser.kill();
  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* 清不掉就留着 */ }
}

if (problems.length) {
  console.log(`结论：${problems.length} 处不合格`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('结论：真模型三张照片全部读对（含「没表就说没表」）。');
