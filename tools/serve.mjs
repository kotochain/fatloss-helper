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
    console.log('  按 Ctrl+C 停止。\n');
  });
}
