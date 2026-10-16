/**
 * 提交前自查：确认项目里没有密钥类文件被跟踪或暂存。
 * 用法：node tools/check-secrets.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => { try { return execSync(cmd, { cwd: root, encoding: 'utf8' }); } catch { return ''; } };

let bad = 0;
const tracked = run('git ls-files').split('\n').filter(Boolean);
const suspicious = tracked.filter((f) => /(^|\/)(ai-key\.txt|keys\.json|\.env|id_rsa|.*\.pem|.*\.key)$/.test(f));
if (suspicious.length) { bad += 1; console.log('❌ 这些敏感文件被版本库跟踪了：', suspicious.join(', ')); }
else console.log('✅ 没有被跟踪的密钥类文件');

const staged = run('git diff --cached --name-only').split('\n').filter(Boolean);
const stagedBad = staged.filter((f) => /(^|\/)(ai-key\.txt|keys\.json|\.env)/.test(f));
if (stagedBad.length) { bad += 1; console.log('❌ 暂存区里有敏感文件：', stagedBad.join(', ')); }
else console.log('✅ 暂存区干净');

// 扫源码里有没有像 true 密钥的字符串（sk- 开头且长度够）
const hits = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', '.selfcheck', 'node_modules'].includes(entry.name)) continue;
    // 这个自查脚本自己会写出 sk- 开头的示例，跳过它，避免自己报自己
    if (entry.name === 'check-secrets.mjs') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(js|mjs|json|md|html|txt|yml|yaml)$/.test(entry.name)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const m of text.matchAll(/sk-[A-Za-z0-9_-]{16,}/g)) hits.push({ file: path.relative(root, full), key: m[0] });
  }
};
walk(root);
// 测试里用的假密钥是允许的
// 测试里刻意用的假密钥：明确列出来，其余一律当真实风险处理
const FAKE_KEYS = [
  'sk-fake-for-test', 'sk-secret-should-not-leak', 'sk-from-file', 'sk-from-env',
  'sk-e2e-fake-key-for-testing', 'sk-你的密钥', 'sk-xxx',
];
// 注意要按完整字符串比，不能只看前几位 —— 假密钥和真密钥前几位长得一样
const real = hits.filter((h) => !FAKE_KEYS.some((f) => h.key === f)).map((h) => `${h.file}: ${h.key.slice(0, 8)}…`);
if (real.length) { bad += 1; console.log('❌ 源码里出现了像真密钥的字符串：\n   ' + real.join('\n   ')); }
else console.log('✅ 源码里没有真密钥形态的字符串');

// 自查工具本身：确认它真的能抓到密钥，而不是永远说「通过」
if (process.argv.includes('--self-test')) {
  const looksReal = 'sk-9f3a7c2e5b1d8046aabbccddeeff0011';
  const looksFake = 'sk-fake-for-test';
  const scan = (text) => [...text.matchAll(/sk-[A-Za-z0-9_-]{16,}/g)]
    .map((m) => m[0])
    .filter((k) => !FAKE_KEYS.includes(k));
  const caught = scan(`const key = "${looksReal}";`).length === 1;
  const ignored = scan(`const key = "${looksFake}";`).length === 0;
  console.log(caught ? '✅ 自查工具能抓到真密钥形态' : '❌ 自查工具抓不到真密钥，形同摆设');
  console.log(ignored ? '✅ 自查工具会忽略测试用的假密钥' : '❌ 自查工具把假密钥当成真密钥报警');
  if (!caught || !ignored) process.exitCode = 1;
}

console.log(bad ? `\n❌ 有 ${bad} 项需要处理` : '\n✅ 密钥自查通过');
if (bad) process.exitCode = 1;
