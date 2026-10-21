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
import { icon, hasIcon, iconNames, badgeGlyphNames, badgeGlyph } from '../js/icons.js';
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
  // 以前这条只断言了 data-kind 和长度：把兜底字形删掉后 svg 里会拼进字面 "undefined"，
  // 长度照样够、data-kind 照样是 fallback —— 测试假绿。现在断言真的画出了兜底方块。
  assert.ok(!fallback.includes('undefined'), '不能把 undefined 拼进 DOM');
  assert.ok(fallback.includes('<rect'), '兜底要画一个方块字形');
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

test('徽章是「花边 + 渐变圆盘 + 实心字形」，而不是一个纯色圆 + 一条线', () => {
  // v27 的起因：真机上徽章只有 30px，看起来像「一个圈里画了根线」，太简约。
  // 这条测试盯着勋章的结构，改回扁平圆就会红。
  const svg = icon('badge-flame', { size: 58 });
  assert.ok(svg.includes('data-kind="badge"'), '徽章要走 badge 分支');
  assert.ok(svg.includes('width="58"') && svg.includes('height="58"'), '徽章要能放大到 58（真机上看得清）');
  assert.ok(svg.includes('<linearGradient'), '徽章必须有渐变（内圈圆盘靠它才有立体感）');
  assert.ok(svg.includes('url(#bd-flame-d)'), '圆盘要用自己的渐变（每个徽章一组 id）');
  assert.ok(svg.includes('fill="#FFFDFB"'), '字形是白色实心（线条在深色圆盘上看不清）');
  assert.ok(svg.includes('fill="url(#bd-flame-r)"'), '花边底色也要是渐变');
  // 花边：12 个二次曲线花瓣（花边画了两遍：底色一遍、描边一遍 → Q 是 12 的倍数）
  const curves = (svg.match(/Q/g) || []).length;
  assert.ok(curves >= 12 && curves % 12 === 0, `花边要由 12 段曲线组成，实际 ${curves}`);
  assert.ok(!svg.includes('stroke="currentColor"'), '徽章不该套用线性图标的描边（会把字形盖住）');
});

test('22 个徽章每个都配了字形（缺了会掉成方块）', () => {
  const glyphs = badgeGlyphNames();
  assert.equal(glyphs.length, iconNames().badge.length, '徽章数量和字形数量必须一样');
  for (const name of iconNames().badge) {
    const key = name.slice('badge-'.length);
    assert.ok(glyphs.includes(key), `${name} 没有对应字形`);
    const svg = icon(name, { size: 58 });
    assert.ok(svg.includes('data-kind="badge"'), `${name} 没走徽章分支`);
    assert.ok(svg.includes(`bd-${key}-d`), `${name} 的渐变 id 不对`);
    assert.ok(!svg.includes('data-kind="fallback"'), `${name} 不该是兜底`);
    const glyph = badgeGlyph(name);
    assert.ok(glyph.length > 60, `${name} 的字形是空的`);
    assert.ok(svg.includes(glyph.slice(0, 24)), `${name} 没把自己的字形画进去（都画成方块就白做了）`);
  }
});

test('徽章名必须带上存档参数（badgeLabel(state, x)；少传一个参数徽章墙名字全空）', () => {
  // 真的踩过：app.js 里写成 badgeLabel(x)，函数签名是 (state, badge)，
  // 徽章墙 16 个名字全部变成空字符串 —— 界面上只剩一排图，谁也猜不出是什么。
  const src = fs.readFileSync(path.join(jsDir, 'app.js'), 'utf8');
  const bad = [...src.matchAll(/badgeLabel\(\s*([^,()]+?)\s*\)/g)].map((m) => m[0]);
  assert.deepEqual(bad, [], `这些地方少传了参数：
${bad.join('\n')}`);
});

test('设置页图标要和徽章一样能放大到看得清（v27：18px 灰线太小认不出）', () => {
  for (const name of ['sprout', 'database', 'play']) {
    assert.equal(hasIcon(name), true, `设置页新图标 ${name} 不存在`);
  }
  // 渲染尺寸由 app.js 决定，这里只保证能渲染到 23 而不变形
  const svg = icon('sprout', { size: 23 });
  assert.ok(svg.includes('width="23"'));
});

test('不带 badge- 前缀的名字必须走线稿，不能被同名徽章抢走', () => {
  // 真踩过：icon() 以前把裸名字也拿去查徽章表，而线稿里有同名键（sprout / leaf / run / heart…），
  // 于是设置页「我的成长」显示成一个徽章圆盘、记录页「练的」变成一团暗红。
  for (const name of ['sprout', 'leaf', 'run', 'heart', 'flame', 'egg', 'scale', 'pot']) {
    const svg = icon(name);
    assert.ok(svg.includes('data-kind="line"'), `${name} 应当渲染成线稿（实际 ${svg.slice(0, 90)}）`);
    assert.equal(hasIcon(name), true, `${name} 应当存在`);
  }
  assert.ok(icon('badge-sprout').includes('data-kind="badge"'), '带前缀才走徽章');
  assert.equal(hasIcon('badge-sprout'), true);
  assert.equal(hasIcon('badge-does-not-exist'), false, '未知徽章名不能算存在');
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
