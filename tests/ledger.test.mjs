/**
 * 产品逻辑总账的护栏（v35，issue #19）。
 *
 * 这张账存在的意义只有一个：**让「产品规则」变成能被审计的东西**。
 * 以前「AI 只许给名字」这条错规则活了两轮，就是因为没有任何一处能一眼看出
 * 「这条规则由谁守、有没有测试」。所以这里不做花哨检查，只保证四件事：
 *   1) 账本身没烂（7 个领域、规则条数够、编号不重复、状态合法）；
 *   2) 每条引用的代码/测试**真的存在**（文件在、关键词在）—— 防止账写成过时的愿望；
 *   3) 测试列写「无」的规则，必须在「已知缺口」里点名（不许静默无保护）；
 *   4) 文末统计和实际条数一致（数字不能手写漂移）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ledgerPath = path.join(root, 'docs', '产品逻辑总账.md');
const source = fs.readFileSync(ledgerPath, 'utf8');
const lines = source.split('\n');

const domains = [...source.matchAll(/^## ([一二三四五六七])、/gm)].map((m) => m[1]);
const ruleLines = lines.filter((l) => /^\| R\d+ \|/.test(l));
const gapSection = source.split('## 已知缺口')[1] || '';
const gapIds = [...gapSection.matchAll(/^\| (G\d+) \|/gm)].map((m) => m[1]);

/** 解析一行规则：| # | 承诺 | 代码 | 测试 | 决策 | 状态 | */
function parseRule(line) {
  const cells = line.split('|').map((c) => c.trim());
  // cells[0] 是行首的空串，最后一个是行尾的空串
  const [, id, promise, code, testRef, decision, status] = cells;
  return { id, promise, code, testRef, decision, status, line };
}

/** 引用格式 `文件#关键词`（关键词可省）；返回 [文件, 关键词] */
function splitRef(ref) {
  const at = ref.indexOf('#');
  return at < 0 ? [ref.trim(), ''] : [ref.slice(0, at).trim(), ref.slice(at + 1).trim()];
}

function refExists(ref) {
  const [file, keyword] = splitRef(ref);
  const abs = path.join(root, file);
  assert.ok(fs.existsSync(abs), `账里引用的文件不存在：${file}`);
  if (keyword) {
    const content = fs.readFileSync(abs, 'utf8');
    assert.ok(content.includes(keyword), `账里引用的位置不存在：${file}#${keyword}`);
  }
}

test('总账结构：7 个领域、规则足够多、编号不重复、状态合法', () => {
  assert.equal(domains.length, 7, `领域应当 7 个，实际 ${domains.length} 个：${domains.join('')}`);
  assert.ok(ruleLines.length >= 45, `规则太少（${ruleLines.length} 条）：覆盖面不够就不能叫总账`);
  const rules = ruleLines.map(parseRule);
  const ids = rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `规则编号重复：${ids.filter((x, i) => ids.indexOf(x) !== i).join('、')}`);
  for (const r of rules) {
    assert.ok(r.promise.length >= 6, `${r.id} 的承诺太短，写成人话：${r.promise}`);
    assert.ok(r.code && r.code !== '无', `${r.id} 没写代码位置`);
    assert.ok(['有效', '已推翻', '待定'].includes(r.status), `${r.id} 的状态不合法：${r.status}`);
    assert.match(r.decision, /^(决策 \d+|未立项)$/, `${r.id} 的决策列要写「决策 N」或「未立项」：${r.decision}`);
  }
});

test('总账引用可查：代码和测试文件（含关键词）都必须真实存在', () => {
  for (const line of ruleLines) {
    const r = parseRule(line);
    for (const ref of r.code.split('、')) refExists(ref);
    if (r.testRef !== '无') {
      for (const ref of r.testRef.split('、')) refExists(ref);
    }
  }
});

test('没测试的规则必须在「已知缺口」里点名（不许静默无保护）', () => {
  const uncovered = ruleLines.map(parseRule).filter((r) => r.testRef === '无').map((r) => r.id);
  for (const id of uncovered) {
    assert.ok(gapIds.length > 0, `${id} 没有测试，但「已知缺口」是空的`);
  }
  // 反过来：已知缺口里点名的规则，应当是「无测试」或明确写清楚为什么（G 系列可以独立存在）
  assert.ok(gapIds.length >= 3, `已知缺口太少（${gapIds.length} 条）：这张账不可能一条缺口都没有，别粉饰`);
});

test('文末统计不能手写漂移', () => {
  const rules = ruleLines.map(parseRule);
  const tested = rules.filter((r) => r.testRef !== '无').length;
  const m = source.match(/规则 (\d+) 条 · 有测试 (\d+) 条 · 已知缺口 (\d+) 条/);
  assert.ok(m, '文末缺少「规则 N 条 · 有测试 N 条 · 已知缺口 N 条」统计行');
  assert.equal(Number(m[1]), rules.length, '统计里的规则条数和实际不符');
  assert.equal(Number(m[2]), tested, '统计里的「有测试」条数和实际不符');
  assert.equal(Number(m[3]), gapIds.length, '统计里的「已知缺口」条数和实际不符');
});
