/**
 * 图标系统的护栏（issue #9）。
 *
 * 目标是三件事，缺一不可：
 *  1) 图标函数永远返回能塞进 DOM 的 SVG（未知名字也不能是 undefined）；
 *  2) 代码里引用的每个图标名都真的存在（写错名字不会静默变成方块）；
 *  3) 源码里不再出现 emoji —— 否则过两周又会有人顺手打一个进去。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { icon, hasIcon, iconNames } from '../js/icons.js';
import { ACHIEVEMENTS, PLANT_STAGES, MILESTONES, weeklyHighlight } from '../js/achievements.js';
import { EQUIPMENT } from '../js/cardio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = path.join(root, 'js');

test('图标函数：默认装饰性、可指定尺寸、未知名字有兜底', () => {
  const svg = icon('bowl');
  assert.ok(svg.startsWith('<svg'), svg.slice(0, 40));
  assert.ok(svg.includes('viewBox="0 0 24 24"'), '必须是 24 网格（缩放才清晰）');
  assert.ok(svg.includes('width="18"') && svg.includes('height="18"'), '默认 18');
  assert.ok(svg.includes('aria-hidden="true"'), '装饰性图标不该被读屏念出来');
  assert.ok(!svg.includes('undefined'), '不能把 undefined 拼进 DOM');
  // 真出过：描边只写在注释里、没放到根 svg 上，结果所有线性图标都是透明的，
  // 页面上只剩布局占位（设置行前面空一块）。这条断言就是防它回来。
  assert.ok(svg.includes('stroke="currentColor"'), '线性图标必须在根上带描边，否则整片透明');
  assert.ok(/stroke-width="1\.6"/.test(svg), '统一 1.6 描边');

  const big = icon('run', { size: 40, cls: 'foo' });
  assert.ok(big.includes('width="40"'));
  assert.ok(big.includes('class="icon foo"'));

  // 未知名字：给一个方块，而不是空串 / undefined
  const fallback = icon('this-icon-does-not-exist');
  assert.ok(fallback.includes('data-kind="fallback"'), '未知名字要能一眼看出来是兜底');
  assert.ok(fallback.length > icon('bowl').length / 2);
  assert.equal(hasIcon('this-icon-does-not-exist'), false);
});

test('有含义的图标可以带标签；标签里的特殊字符要转义', () => {
  const svg = icon('egg', { label: '蛋白 "<达标>"' });
  assert.ok(svg.includes('role="img"'));
  assert.ok(svg.includes('aria-label="蛋白 &quot;&lt;达标&gt;&quot;"'), svg);
  assert.ok(!svg.includes('aria-hidden'), '有标签时不该再标成装饰性');
});

test('图标名分三类，且数量说得过去', () => {
  const names = iconNames();
  assert.ok(names.line.length >= 50, `线性图标只有 ${names.line.length} 个，是不是漏了`);
  assert.equal(names.plant.length, 6, '植物 6 个阶段');
  assert.ok(names.badge.length >= 20, `徽章 ${names.badge.length} 个`);
  for (const n of [...names.line, ...names.badge, ...names.plant]) {
    assert.equal(hasIcon(n), true, `${n} 应当存在`);
    assert.ok(!/\p{Emoji}/u.test(n), `${n} 不该是 emoji 本身`);
  }
  // 命名规则：徽章必须带 badge- 前缀（数据里一眼能区分「线条图标」和「勋章」）
  for (const n of names.badge) assert.ok(n.startsWith('badge-'), n);
});

test('数据里引用的图标全都存在（写错名字不会静默变方块）', () => {
  const missing = [];
  for (const a of ACHIEVEMENTS) if (!hasIcon(a.icon)) missing.push(`徽章 ${a.id}: ${a.icon}`);
  for (const s of PLANT_STAGES) if (!hasIcon(s.icon)) missing.push(`植物阶段 ${s.name}: ${s.icon}`);
  for (const m of MILESTONES) if (!hasIcon(m.icon)) missing.push(`里程碑 ${m.text}: ${m.icon}`);
  for (const [key, eq] of Object.entries(EQUIPMENT)) if (!hasIcon(eq.icon)) missing.push(`器械 ${key}: ${eq.icon}`);
  assert.deepEqual(missing, [], missing.join('\n'));

  // 后面顺手加的反馈文案也不能漏
  for (const review of [{ loggedDays: 7 }, { loggedDays: 5, proteinHitDays: 5 }, { loggedDays: 5, proteinHitDays: 1, exerciseDays: 4 }, { loggedDays: 2 }]) {
    const hl = weeklyHighlight(review);
    assert.ok(hasIcon(hl.icon), `周报高光用了不存在的图标 ${hl.icon}`);
  }
});

test('insights 与 app.js 里写的图标名也都要存在', () => {
  const files = ['app.js', 'insights.js'];
  const missing = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
    // icon('name') 与 icon: 'name' 两种写法
    for (const m of src.matchAll(/icon\(\s*['"]([a-z0-9-]+)['"]/g)) {
      if (!hasIcon(m[1])) missing.push(`${f}: icon('${m[1]}')`);
    }
    for (const m of src.matchAll(/icon:\s*['"]([a-z0-9-]+)['"]/g)) {
      if (!hasIcon(m[1])) missing.push(`${f}: icon: '${m[1]}'`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

test('源码里不再有 emoji（含注释），index.html 也算', () => {
  // 只查真正的 emoji 区段：杂项符号 / 装饰符号 / 补充符号 / 变体选择符。
  // 不查箭头、×、› 这类排版字符 —— 它们是文字，不是图标。
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
  const files = [
    ...fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')).map((f) => path.join(jsDir, f)),
    path.join(root, 'index.html'),
  ];
  const hits = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (EMOJI.test(line)) hits.push(`${path.relative(root, file)}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(hits, [], `这些地方还有 emoji，请换成 icon()：\n${hits.join('\n')}`);
});
