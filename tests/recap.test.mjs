/**
 * 「最近 30 天回顾」的规则测试（v38，issue #14 C）。
 *
 * 这张回顾的意义是「看长一点的变化」，所以规则要同时满足：
 *  - 数字来自真实记录，窗口边界不能错（31 天前的不算、今天要算）；
 *  - 数据不够就直说，不编；只是陈述事实，不评判、不施压；
 *  - 体重只报趋势并注明「单次波动不用当真」；
 *  - 只读存档，绝不修改。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, addFoodEntry, addWeight, shiftDate } from '../js/store.js';
import { findFood } from '../js/foods.js';
import { buildRecap, recapLines } from '../js/recap.js';

const TODAY = '2026-10-26';
const TARGETS = { proteinG: 70, targetCalories: 1500 };

const rice = findFood('rice_cooked');
const chicken = findFood('chicken_breast_cooked');

/** 造一个「记了 n 天、其中 some 天蛋白达标」的状态 */
function makeState({ days = 10, proteinDays = 5 } = {}) {
  const s = emptyState();
  for (let i = 0; i < days; i++) {
    const key = shiftDate(TODAY, -i);
    addFoodEntry(s, key, 'lunch', rice, 150);
    // 蛋白达标那天加 250 克熟鸡胸（约 78 克蛋白 > 70）
    if (i < proteinDays) addFoodEntry(s, key, 'dinner', chicken, 250);
  }
  return s;
}

test('v38：记录不足 3 天时直说「先记几天」，不编数字', () => {
  const r = buildRecap({ state: emptyState(), targets: TARGETS, today: TODAY });
  assert.equal(r.enough, false);
  assert.equal(r.loggedDays, 0);
  const lines = recapLines(r);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /先记上几天/);
});

test('v38：30 天窗口统计正确（记录天数 / 蛋白达标 / 最长连续）', () => {
  const s = makeState({ days: 10, proteinDays: 5 });
  const r = buildRecap({ state: s, targets: TARGETS, today: TODAY });
  assert.equal(r.days, 30);
  assert.equal(r.from, shiftDate(TODAY, -29));
  assert.equal(r.loggedDays, 10);
  assert.equal(r.totalEntries, 15);
  assert.equal(r.proteinHitDays, 5);
  assert.equal(r.longestStreak, 10);
  assert.equal(r.enough, true);
});

test('v38：窗口边界 —— 30 天前的不算，今天要算', () => {
  const s = emptyState();
  addFoodEntry(s, TODAY, 'lunch', rice, 150);
  addFoodEntry(s, shiftDate(TODAY, -29), 'lunch', rice, 150);
  addFoodEntry(s, shiftDate(TODAY, -30), 'lunch', rice, 150); // 刚好在窗口外
  const r = buildRecap({ state: s, targets: TARGETS, today: TODAY });
  assert.equal(r.loggedDays, 2);
  assert.deepEqual(Object.keys(s.days).sort(), [shiftDate(TODAY, -30), shiftDate(TODAY, -29), TODAY].sort(), '只读，不能删/改记录');
});

test('v38：体重只报趋势，并注明单次波动不用当真', () => {
  const s = makeState({ days: 10, proteinDays: 3 });
  addWeight(s, shiftDate(TODAY, -20), 58.4);
  addWeight(s, TODAY, 57.6);
  const r = buildRecap({ state: s, targets: TARGETS, today: TODAY });
  assert.equal(r.weight.measuredDays, 2);
  assert.equal(r.weight.deltaKg, -0.8);
  const lines = recapLines(r);
  assert.ok(lines.some((l) => l.includes('体重从 58.4 kg 到 57.6 kg')), lines.join(' / '));
  assert.ok(lines.some((l) => l.includes('单次波动不用当真')));
});

test('v38：最常吃的东西按次数排序，最多三个', () => {
  const s = makeState({ days: 6, proteinDays: 2 });
  const r = buildRecap({ state: s, targets: TARGETS, today: TODAY });
  assert.ok(r.topFoods.length >= 2 && r.topFoods.length <= 3);
  assert.ok(r.topFoods[0].times >= r.topFoods[1].times);
  assert.ok(r.topFoods[0].name.length > 0);
});

test('v38：回顾只说事实，不评判、不施压；最多三句', () => {
  const s = makeState({ days: 12, proteinDays: 4 });
  addWeight(s, shiftDate(TODAY, -10), 58);
  addWeight(s, TODAY, 57.7);
  const lines = recapLines(buildRecap({ state: s, targets: TARGETS, today: TODAY }));
  assert.ok(lines.length <= 3, `最多三句，实际 ${lines.length}`);
  for (const l of lines) {
    assert.ok(!/应该|必须|失败|吃多了|超标|自律|加油/.test(l), `不许评判/施压：${l}`);
    assert.ok(l.length >= 8);
  }
});

test('v38：回顾不修改存档（只读）', () => {
  const s = makeState({ days: 8, proteinDays: 3 });
  const snapshot = JSON.stringify(s);
  buildRecap({ state: s, targets: TARGETS, today: TODAY });
  recapLines(buildRecap({ state: s, targets: TARGETS, today: TODAY }));
  assert.equal(JSON.stringify(s), snapshot);
});

test('v38：同样的状态和日期，结果完全一致（无随机/时间依赖）', () => {
  const s = makeState({ days: 9, proteinDays: 4 });
  assert.deepEqual(
    buildRecap({ state: s, targets: TARGETS, today: TODAY }),
    buildRecap({ state: s, targets: TARGETS, today: TODAY }),
  );
});
