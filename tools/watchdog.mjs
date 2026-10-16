/**
 * 看门狗：给自检脚本加一道「超时就退出」的保险。
 *
 * 为什么需要：无头浏览器和 WebSocket 在某些环境下不会让 Node 的事件循环结束，
 * 表现为脚本干完了活却不退出（CI 上会一直挂到 job 超时，日志还拿不到）。
 * 这里在启动时挂一个定时器，到点打印诊断并强制退出，避免「静默挂死」。
 *
 * 用法（放在脚本最前面）：
 *   import { armWatchdog } from './watchdog.mjs';
 *   armWatchdog('quicklog-check', 150);   // 150 秒
 */

const armed = new Set();

export function armWatchdog(name, seconds = 180) {
  if (armed.has(name)) return;
  armed.add(name);
  const timer = setTimeout(() => {
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.error(`\n⏱ ${name} 超过 ${seconds} 秒仍未结束，强制退出（内存 ${mem}MB）。`);
    console.error('   这类情况通常是浏览器进程没退干净，或者某个等待条件永远不成立。');
    console.error('   脚本自身的断言结果以退出前的输出为准。');
    // 用 exitCode 保持「非零 = 有问题」的语义
    process.exit(process.exitCode || 0);
  }, seconds * 1000);
  timer.unref?.();  // 别让定时器本身拖住退出
  return timer;
}
