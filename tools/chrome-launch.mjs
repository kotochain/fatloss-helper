/**
 * 启动无头 Chrome，并保证「不会因为上一次没退干净而起不来」。
 *
 * 为什么需要这个文件：所有自检脚本都用固定的调试端口。上一次跑挂了、Chrome 没收干净时，
 * 端口仍被占着 —— 新 Chrome 静默失败，而等待循环却连上了那个僵尸端口，
 * 表现为「第一个脚本能过、后面的脚本全部失败」，且报错各不相同（fetch failed / 超时 / 莫名失败）。
 * 这个坑骗过我和 CI 好几轮，所以单独抽出来统一处理。
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import { findChrome } from './chrome-path.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端口上是不是有东西在响应（不管是谁） */
async function portAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 把占用该端口的进程杀掉（只杀监听这个端口的那个，不动别的 Chrome） */
function freePort(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: 'utf8' }).trim();
    for (const pid of out.split('\n').filter(Boolean)) {
      if (pid === String(process.pid)) continue;
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* 已经没了 */ }
    }
  } catch { /* lsof 不可用就跳过 */ }
}

/**
 * 启动 Chrome 并等到调试端口可用。
 * @returns {Promise<{chrome:import('node:child_process').ChildProcess, version:object}>}
 * @throws 起不来时抛出带原因的错（绝不让调用方拿着坏端口继续跑）
 */
export async function launchChrome({
  port,
  userDataDir,
  window = '390,844',
  timeoutMs = 40000,
  extraArgs = [],
} = {}) {
  if (!port) throw new Error('launchChrome 需要 port');
  if (!userDataDir) throw new Error('launchChrome 需要 userDataDir');

  // 1) 端口上有残留就清掉（否则新实例会静默失败）
  if (await portAlive(port)) {
    freePort(port);
    for (let i = 0; i < 20 && (await portAlive(port)); i++) await sleep(200);
    if (await portAlive(port)) throw new Error(`调试端口 ${port} 被别的进程占着，清不掉`);
  }

  // 2) 上一次的 profile 目录如果是脏的，也清掉（Chrome 有时会因此拒绝启动）
  try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* 清不掉就继续 */ }
  fs.mkdirSync(userDataDir, { recursive: true });

  // 3) 启动
  const chrome = spawn(findChrome(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    `--window-size=${window}`, '--hide-scrollbars',
    ...extraArgs,
    'about:blank',
  ], { stdio: 'ignore' });

  // 收尾：进程被信号杀掉时也要带走 Chrome，不留僵尸占端口
  const killChrome = () => { try { chrome.kill('SIGKILL'); } catch { /* 已经没了 */ } };
  process.once('exit', killChrome);
  process.once('SIGINT', () => { killChrome(); process.exit(130); });
  process.once('SIGTERM', () => { killChrome(); process.exit(143); });

  // 4) 等端口，等不到就说清原因
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return { chrome, version: await res.json(), kill: killChrome };
    } catch (err) { lastErr = err.message; }
    await sleep(300);
  }
  killChrome();
  throw new Error(`无头 Chrome 在 ${timeoutMs / 1000} 秒内没起来（端口 ${port}）：${lastErr || '端口无响应'}`);
}

export { portAlive, freePort, sleep };
