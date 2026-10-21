/**
 * 一条命令跑完本地检查。
 *
 *   npm run check        快：单元测试 + 反向验证 + 密钥扫描 + 3 个界面自检 + 直连自检（约 4 分钟）
 *   npm run check:full   全：快的那套 + 线上流程(本地地址) + AI 失败/存档异常 + 全按钮清扫 + 排版（约 10 分钟）
 *   npm run check:live   只测线上：文件逐字节一致 + 真打开线上网址跑一遍（约 2 分钟，需要联网）
 *
 * 为什么要有这个文件：
 * 之前每次检查都要手动记「先起服务、再按顺序跑哪个、跑完关掉」，很容易漏跑或忘了关服务。
 * 这里把顺序固定下来：需要本地服务的放一起、跑完自动关；自己起服务的（清扫/韧性/排版）单独跑。
 *
 * 输出很好认：每一步一行 ✅/❌，最后一段汇总。有 ❌ 就算失败（退出码非 0）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = (process.argv[2] || 'fast').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let server = null;

function line(text = '') { console.log(text); }

/** 跑一个自检脚本，返回是否成功 */
async function run(label, script, args = [], env = {}) {
  line(`\n──────── ${label} ────────`);
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', (err) => { console.error(`启动 ${script} 失败：${err.message}`); resolve(1); });
  });
  const secs = Math.round((Date.now() - started) / 1000);
  results.push({ label, ok: code === 0, secs });
  line(code === 0 ? `✅ ${label} 通过（${secs} 秒）` : `❌ ${label} 失败（${secs} 秒，退出码 ${code}）`);
  return code === 0;
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch { /* 还没起来，继续等 */ }
    await sleep(300);
  }
  return false;
}

async function startLocalServer() {
  line('启动本地预览服务（跑完会自动关掉）…');
  server = spawn(process.execPath, [path.join(root, 'tools/serve.mjs'), '4173'], {
    cwd: root,
    stdio: 'ignore',
  });
  const ok = await waitForServer('http://127.0.0.1:4173/');
  if (!ok) {
    line('❌ 本地服务没起来（4173 端口可能被别的程序占着）。先关掉占用它的程序再试。');
    return false;
  }
  line('✅ 本地服务已就绪：http://127.0.0.1:4173/');
  return true;
}

function stopLocalServer() {
  if (!server) return;
  try { server.kill('SIGTERM'); } catch { /* 已经退了 */ }
  server = null;
}

/** 前置条件：Node 版本够（脚本用了 fetch / AbortSignal.timeout 等） */
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) return true;
  console.error(`❌ Node 版本太旧（当前 ${process.versions.node}），需要 20 或更高。`);
  return false;
}

async function main() {
  if (!checkNode()) process.exit(1);
  line(`检查范围：${mode === 'full' ? '全部' : mode === 'live' ? '只测线上' : '快速'}`);

  if (mode === 'live') {
    // 只测线上：不需要本地服务
    await run('线上文件与版本一致性', 'tools/check-live.mjs');
    await run('真打开线上网址跑一遍', 'tools/live-audit.mjs');
    return finish();
  }

  // 不依赖浏览器/服务的基础检查
  await runNpm('单元测试', 'test');
  await run('反向验证（故意改坏代码，确认测试会红）', 'tools/mutate-check.mjs');
  await run('密钥扫描', 'tools/check-secrets.mjs', ['--self-test']);

  const needServer = [
    ['一句话记录流程', 'tools/quicklog-check.mjs'],
    ['断网可用', 'tools/offline-check.mjs'],
    ['真浏览器界面检查', 'tools/browser-check.mjs'],
  ];
  if (mode === 'full') needServer.push(['完整使用流程（引导/记一笔/重开/断网/存档/导出导入）', 'tools/live-audit.mjs', ['http://127.0.0.1:4173']]);

  const up = await startLocalServer();
  if (!up) {
    // 服务起不来也要把不依赖服务的那几个跑掉
    line('⚠️  跳过需要本地服务的检查');
    for (const [label] of needServer) results.push({ label, ok: false, secs: 0, skipped: true });
  } else {
    try {
      for (const [label, script, args] of needServer) await run(label, script, args || []);
    } finally {
      stopLocalServer();
    }
  }

  // 自己起服务的（不需要 4173）
  await run('浏览器直连 AI（本地假服务商，零费用）', 'tools/direct-check.mjs');
  await run('照包装营养成分表（手动填 + 拍照读表）', 'tools/label-check.mjs');
  if (mode === 'full') {
    await run('AI 失败路径与存档异常', 'tools/resilience-check.mjs');
    await run('全界面按钮清扫（320 次点击）', 'tools/sweep-check.mjs');
    await run('小屏与系统大字号排版', 'tools/layout-check.mjs');
  }
  return finish();
}

/** 跑 npm 脚本（单元测试就是 npm test） */
function runNpm(label, npmScript) {
  return new Promise((resolve) => {
    line(`\n──────── ${label} ────────`);
    const started = Date.now();
    const child = spawn('npm', ['run', npmScript], { cwd: root, stdio: 'inherit', shell: true });
    child.on('exit', (code) => {
      const secs = Math.round((Date.now() - started) / 1000);
      results.push({ label, ok: code === 0, secs });
      line(code === 0 ? `✅ ${label} 通过（${secs} 秒）` : `❌ ${label} 失败（退出码 ${code}）`);
      resolve();
    });
    child.on('error', (err) => {
      results.push({ label, ok: false, secs: 0 });
      line(`❌ ${label} 起不来：${err.message}`);
      resolve();
    });
  });
}

function finish() {
  stopLocalServer();
  line('\n════════ 汇总 ════════');
  for (const r of results) {
    const mark = r.skipped ? '⬜' : r.ok ? '✅' : '❌';
    line(`${mark} ${r.label}${r.secs ? `（${r.secs} 秒）` : ''}`);
  }
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  if (failed.length) {
    line(`\n❌ 有 ${failed.length} 项没通过，先别看别的地方，把这几个修了。`);
  } else if (skipped.length) {
    line(`\n⚠️  跑完的部分都通过了，但跳过了 ${skipped.length} 项（本地服务没起来）。`);
  } else {
    line('\n✅ 全部通过。可以推送/发布了。');
  }
  line('（提示：想连手机一起试，见 README「怎么用起来」；想测线上，跑 npm run check:live）');
  process.exit(failed.length ? 1 : 0);
}

process.on('SIGINT', () => {
  line('\n收到中断，关掉本地服务…');
  stopLocalServer();
  process.exit(130);
});

main().catch((err) => {
  console.error('\n检查脚本自己崩了：', err.message);
  stopLocalServer();
  process.exit(1);
});
