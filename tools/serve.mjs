/**
 * 本地预览服务器（只在本机跑，不上传任何东西）
 *
 *   node tools/serve.mjs            # 默认 4173 端口
 *   node tools/serve.mjs 8080
 *
 * 启动后会打印两个地址：
 *   本机地址  —— 在这台电脑的浏览器里打开
 *   手机地址  —— 手机连同一个 Wi-Fi 时打开这个（手机浏览器里再「添加到主屏幕」）
 *
 * 只在开发/试用时用。平时手机上用不需要开着这个服务：
 * 装到主屏幕之后由浏览器缓存离线运行。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  aiConfig, callUpstream, callCoach, readApiKey, aiConfigStatus, saveConfigFromInput,
  clearSavedConfig, testConnection,
} from './ai-proxy.mjs';
import { PRESETS } from '../js/providers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);

    // AI 是否已配置（只回状态与掩码，绝不回密钥本身）
    if (pathname === '/api/ai-status') {
      const st = aiConfigStatus(root);
      return send(res, 200, JSON.stringify({
        configured: st.configured, model: st.model, from: st.from, source: st.source,
      }), TYPES['.json']);
    }

    // 设置页需要的全部信息：当前状态 + 服务商预设（预设里没有密钥，只有公开的接口地址）
    if (pathname === '/api/ai-config' && req.method === 'GET') {
      const st = aiConfigStatus(root);
      return send(res, 200, JSON.stringify({
        ...st,
        presets: PRESETS.map((p) => ({
          id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model,
          note: p.note, keyUrl: p.keyUrl, recommended: Boolean(p.recommended),
          allowEmptyKey: Boolean(p.allowEmptyKey),
        })),
      }), TYPES['.json']);
    }

    // 保存设置（先校验格式，再由 app.js 决定要不要先测连通）
    if (pathname === '/api/ai-config' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* 下面统一报错 */ }
        const out = saveConfigFromInput(body, root);
        if (!out.ok) {
          return send(res, 400, JSON.stringify({ error: out.problems.join('；'), problems: out.problems }), TYPES['.json']);
        }
        console.log(`[AI] 设置已保存：${out.config.baseUrl} · ${out.config.model} · 密钥 ${out.masked}（文件权限 ${out.mode}）`);
        // 注意：返回里只有掩码，绝不回传密钥
        return send(res, 200, JSON.stringify({
          ok: true, file: out.file, mode: out.mode, saved: { ...out.config, apiKey: undefined, keyMasked: out.masked },
        }), TYPES['.json']);
      });
      return;
    }

    // 清空设置
    if (pathname === '/api/ai-config' && req.method === 'DELETE') {
      const removed = clearSavedConfig();
      const st = aiConfigStatus(root);
      return send(res, 200, JSON.stringify({
        ok: true, removed, configured: st.configured, from: st.from,
      }), TYPES['.json']);
    }

    // 连通性测试
    if (req.method === 'POST' && pathname === '/api/ai-config/test') {
      testConnection().then((r) => {
        console.log(`[AI] 连通测试：${r.ok ? '成功' : `失败 —— ${r.error}`}`);
        send(res, r.ok ? 200 : 400, JSON.stringify(r), TYPES['.json']);
      }).catch((err) => {
        send(res, 500, JSON.stringify({ ok: false, error: err.message }), TYPES['.json']);
      });
      return;
    }

    // AI 教练：数字在手机本地算好，这里只把事实清单递上去、把一段人话递回来
    if (req.method === 'POST' && pathname === '/api/coach') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
      req.on('end', async () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* 下面统一报错 */ }
        const brief = body.brief;
        if (!brief || typeof brief !== 'object') {
          return send(res, 400, JSON.stringify({ error: '没有收到教练需要的数据' }), TYPES['.json']);
        }
        const cfg = aiConfig(root);
        if (!cfg.configured || !cfg.key) {
          return send(res, 503, JSON.stringify({
            error: '这台电脑上还没配置 AI 密钥。在「我的 → 设置 → AI 设置」填一下就行。',
          }), TYPES['.json']);
        }
        try {
          const r = await callCoach({ brief, config: cfg });
          return send(res, 200, JSON.stringify(r), TYPES['.json']);
        } catch (err) {
          console.error('[AI] 教练失败：', err.message);
          return send(res, 502, JSON.stringify({ error: err.message }), TYPES['.json']);
        }
      });
      return;
    }

    // 饮食描述解析：密钥留在这台电脑上，手机只知道这个本地地址
    if (req.method === 'POST' && pathname === '/api/parse-meal') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
      req.on('end', async () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* 下面统一报错 */ }
        const text = typeof body.text === 'string' ? body.text.trim().slice(0, 500) : '';
        if (!text) return send(res, 400, JSON.stringify({ error: '没有收到要解析的内容' }), TYPES['.json']);

        // 注意：这里必须用 aiConfig（它包含「手机上保存的配置」），
        // 不能用 readApiKey（那只认环境变量和密钥文件）—— 否则会出现
        // 「设置页显示保存成功、解析却还说没配密钥」这种自相矛盾的情况。
        const cfg = aiConfig(root);
        if (!cfg.configured || !cfg.key) {
          return send(res, 503, JSON.stringify({
            error: '这台电脑上还没配置 AI 密钥。在「记录」页右上角点「AI 设置」填一下就行。',
          }), TYPES['.json']);
        }
        try {
          const result = await callUpstream({ text, meal: body.meal || null, hour: body.hour, config: cfg });
          console.log(`[AI] 「${text.slice(0, 30)}」→ ${result.items.length} 条${result.questions.length ? `，追问 ${result.questions.length} 个` : ''}`);
          return send(res, 200, JSON.stringify(result), TYPES['.json']);
        } catch (err) {
          console.error('[AI] 解析失败：', err.message);
          return send(res, 502, JSON.stringify({ error: err.message }), TYPES['.json']);
        }
      });
      return;
    }

    // 浏览器自检脚本把结果 POST 回来，方便在命令行里看（只在本地有效）
    if (req.method === 'POST' && pathname === '/__save') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const dir = path.join(root, '.selfcheck');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'result.json'), raw);
          console.log('\n=== 浏览器自检结果 ===');
          console.log(JSON.parse(raw).log?.join('\n') ?? raw);
          console.log('======================\n');
          send(res, 200, '{"ok":true}', TYPES['.json']);
        } catch (err) {
          send(res, 500, String(err));
        }
      });
      return;
    }

    if (pathname === '/') pathname = '/index.html';
    const target = path.join(root, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(root)) return send(res, 403, '不允许访问这个路径');

    fs.readFile(target, (err, data) => {
      if (err) return send(res, 404, `找不到 ${pathname}`);
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        // 开发服务器一律不缓存：否则改了文件手机/浏览器还在跑旧版本，很难查
        'Cache-Control': 'no-store, must-revalidate',
      });
      res.end(data);
    });
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    console.log('\n减脂小助手 —— 本地预览已启动\n');
    console.log(`  本机打开：  http://127.0.0.1:${port}/`);
    for (const ip of lanAddresses()) {
      console.log(`  手机打开：  http://${ip}:${port}/   （手机需连同一个 Wi-Fi）`);
    }
    console.log('\n  手机上第一次打开后：浏览器菜单 →「添加到主屏幕」，之后就像 App 一样用。');
    const st = aiConfigStatus(root);
    if (st.configured) {
      console.log(`\n  AI 解析：已启用（${st.from}｜模型 ${st.model}）`);
      console.log('  她说「今天食堂吃了碗面」，由这台电脑代问 AI，密钥不会发到手机上。');
    } else {
      console.log('\n  AI 解析：未配置 —— 现在用离线规则解析（常见说法能认）。');
      console.log('  两种配置方式，任选：');
      console.log('   ① 手机上进「记录」页 → 右上角「AI 设置」，选服务商、贴密钥即可（推荐，密钥不进手机）');
      console.log('   ② 命令行：echo "你的密钥" > ~/.dsh/fatloss-ai-key && chmod 600 ~/.dsh/fatloss-ai-key');
    }
    if (st.configFile) console.log(`  配置文件：${st.configFile}（权限 600，只有本人可读，不在项目目录里）`);
    console.log('\n  按 Ctrl+C 停止。\n');
  });
}
