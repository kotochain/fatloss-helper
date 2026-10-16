/**
 * 模块接口测试：防止「删了某个导出，别处还在导入」导致整页白屏。
 *
 * 这类错误 Node 测试抓不到（测试不加载 app.js），但一旦发生就是白屏，
 * 所以这里用静态对账的方式把它挡住：
 *   把 js/app.js 里的 import { a, b } from './x.js' 解析出来，
 *   再检查 x.js 是否真的导出了这些名字。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = path.join(root, 'js');

function exportedNames(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function importedFrom(src) {
  const out = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    out.push({ names, from: m[2] });
  }
  return out;
}

test('app.js 里每个具名导入都能在对应模块里找到导出', () => {
  const app = fs.readFileSync(path.join(jsDir, 'app.js'), 'utf8');
  const problems = [];
  for (const { names, from } of importedFrom(app)) {
    if (!from.startsWith('./')) continue;
    const file = path.join(jsDir, from.replace('./', ''));
    if (!fs.existsSync(file)) {
      problems.push(`app.js 导入了不存在的文件 ${from}`);
      continue;
    }
    const exported = exportedNames(file);
    for (const n of names) {
      if (!exported.has(n)) problems.push(`${from} 没有导出 ${n}（app.js 在导入它，页面会直接白屏）`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('每个 js 模块都能被 Node 正常加载（语法与顶层代码没问题）', async () => {
  const files = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 5, `js 目录下只有 ${files.length} 个文件，是不是路径错了`);
  const failed = [];
  for (const f of files) {
    if (f === 'app.js') continue; // app.js 需要浏览器环境，由 tools/browser-check.mjs 负责验证
    try {
      await import(path.join(jsDir, f));
    } catch (err) {
      failed.push(`${f}: ${err.message}`);
    }
  }
  assert.deepEqual(failed, [], failed.join('\n'));
});

test('测试文件的导入同样对账（防止改了导出名而测试悄悄跳过）', () => {
  const testsDir = path.join(root, 'tests');
  const problems = [];
  for (const f of fs.readdirSync(testsDir).filter((x) => x.endsWith('.test.mjs'))) {
    const src = fs.readFileSync(path.join(testsDir, f), 'utf8');
    for (const { names, from } of importedFrom(src)) {
      if (!from.startsWith('../js/')) continue;
      const file = path.join(root, from.replace('../', ''));
      const exported = exportedNames(file);
      for (const n of names) {
        if (!exported.has(n)) problems.push(`${f} 从 ${from} 导入了不存在的 ${n}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('反向验证：这套对账逻辑真的能发现「导出被删掉」', () => {
  // 模拟一份被删了导出的模块：store.js 里搜不到 frequentFoods 时应当判定为缺
  const storeSrc = fs.readFileSync(path.join(jsDir, 'store.js'), 'utf8');
  const brokenSrc = storeSrc.replace('export function frequentFoods', 'function frequentFoods');
  assert.ok(!exportedNamesFromSource(brokenSrc).has('frequentFoods'), '对账逻辑失效：删掉 export 后仍被认为存在');
  assert.ok(exportedNamesFromSource(storeSrc).has('frequentFoods'), 'store.js 当前没有导出 frequentFoods');
});

function exportedNamesFromSource(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}
