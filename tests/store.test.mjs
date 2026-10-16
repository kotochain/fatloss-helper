/**
 * 记录本与存档测试（记饮食、记运动、记体重、趋势判断、导入导出）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, todayKey, shiftDate, getDay, addFoodEntry, removeFoodEntry,
  updateFoodEntry, addExercise, removeExercise, addWeight, addCustomFood,
  weightTrend, analyzeProgress, demoProfile, demoEntries, STATE_VERSION,
} from '../js/store.js';
import { migrate } from '../js/schema.js';
import { calcTargets, calcEntry } from '../js/calc.js';
import { findFood } from '../js/foods.js';
import { calculateTotals, groupByMeal, mealTotals, entryWarnings } from '../js/foodlog.js';

const rice = findFood('rice_cooked');
const egg = findFood('egg');

test('空状态结构完整', () => {
  const s = emptyState();
  assert.equal(s.version, STATE_VERSION);
  assert.equal(s.schemaVersion, STATE_VERSION, '两个版本号字段必须一致');
  assert.equal(s.profile, null);
  assert.deepEqual(s.days, {});
  assert.deepEqual(s.customFoods, []);
  assert.deepEqual(s.weights, []);
});

test('日期用本地时间，不能用 UTC（晚上 11 点不能串到第二天）', () => {
  const late = new Date(2026, 9, 16, 23, 30); // 2026-10-16 23:30 本地时间
  assert.equal(todayKey(late), '2026-10-16');
  const early = new Date(2026, 9, 17, 0, 10);
  assert.equal(todayKey(early), '2026-10-17');
  // 跨月、跨年、闰年
  assert.equal(shiftDate('2026-10-31', 1), '2026-11-01');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDate('2028-02-28', 1), '2028-02-29');
  assert.equal(shiftDate('2027-03-01', -1), '2027-02-28');
});

test('记一条食物：算出来的热量正确，且能被汇总', () => {
  const s = emptyState();
  addFoodEntry(s, '2026-10-16', 'lunch', rice, 200);
  const day = getDay(s, '2026-10-16');
  assert.equal(day.meals.lunch.length, 1);
  const totals = calculateTotals(Object.values(day.meals).flat());
  assert.equal(totals.kcal, 232);
  assert.equal(totals.carb, 51.8);
});

test('记录里必须写明是哪一餐（否则按餐汇总全为 0）', () => {
  const s = emptyState();
  const e = addFoodEntry(s, '2026-10-16', 'dinner', rice, 100);
  assert.equal(e.meal, 'dinner');
  assert.equal(groupByMeal([e]).find((g) => g.key === 'dinner').totals.kcal, 116);
  assert.equal(mealTotals([e], 'dinner').count, 1);
  assert.equal(mealTotals([e], 'breakfast').count, 0);
});

test('老存档里缺 meal 字段的记录能被补上', () => {
  // 模拟 v1 存档：记录里只有 id / food / grams
  const legacy = migrate({ days: { '2026-10-16': { meals: { lunch: [{ id: 'e1', food: rice, grams: 100 }] } } } });
  const day = getDay(legacy, '2026-10-16');
  assert.equal(day.meals.lunch[0].meal, 'lunch');
  assert.equal(calculateTotals(Object.values(day.meals).flat()).kcal, 116);
});

test('跨天互不影响', () => {
  const s = emptyState();
  addFoodEntry(s, '2026-10-16', 'lunch', rice, 100);
  addFoodEntry(s, '2026-10-17', 'lunch', rice, 300);
  assert.equal(calculateTotals(getDay(s, '2026-10-16').meals.lunch).kcal, 116);
  assert.equal(calculateTotals(getDay(s, '2026-10-17').meals.lunch).kcal, 348);
});

test('份量非法时报错，不会写进一条脏记录', () => {
  const s = emptyState();
  assert.throws(() => addFoodEntry(s, '2026-10-16', 'lunch', rice, 0), /份量/);
  assert.throws(() => addFoodEntry(s, '2026-10-16', 'lunch', rice, -100), /份量/);
  assert.throws(() => addFoodEntry(s, '2026-10-16', 'lunch', rice, '200'), /份量/);
  assert.throws(() => addFoodEntry(s, '2026-10-16', '夜宵', rice, 100), /没有这一餐/);
  assert.equal(getDay(s, '2026-10-16').meals.lunch.length, 0);
});

test('记录里存的是食物数据的副本，之后改食物库不会篡改历史', () => {
  const s = emptyState();
  const entry = addFoodEntry(s, '2026-10-16', 'lunch', rice, 100);
  entry.food.kcal = 999;
  assert.equal(rice.kcal, 116, '原食物数据被改了');
  // 但也确认这条记录确实是独立副本
  const copy = addFoodEntry(s, '2026-10-16', 'lunch', rice, 100);
  assert.notEqual(copy.food, rice);
  assert.equal(copy.food.kcal, 116);
});

test('删除记录：删得掉、删不存在的返回 false', () => {
  const s = emptyState();
  const e = addFoodEntry(s, '2026-10-16', 'lunch', rice, 100);
  assert.equal(removeFoodEntry(s, '2026-10-16', e.id), true);
  assert.equal(getDay(s, '2026-10-16').meals.lunch.length, 0);
  assert.equal(removeFoodEntry(s, '2026-10-16', 'e_不存在'), false);
});

test('改记录份量：热量跟着变', () => {
  const s = emptyState();
  const e = addFoodEntry(s, '2026-10-16', 'lunch', rice, 100);
  updateFoodEntry(s, '2026-10-16', e.id, { grams: 250 });
  assert.equal(calculateTotals(getDay(s, '2026-10-16').meals.lunch).kcal, 290);
});

test('按餐分组：空餐也要出现，顺序固定', () => {
  const s = emptyState();
  addFoodEntry(s, '2026-10-16', 'breakfast', rice, 100);
  addFoodEntry(s, '2026-10-16', 'dinner', egg, 50);
  const groups = groupByMeal(Object.values(getDay(s, '2026-10-16').meals).flat());
  assert.deepEqual(groups.map((g) => g.key), ['breakfast', 'lunch', 'dinner', 'snack']);
  assert.equal(groups.find((g) => g.key === 'lunch').entries.length, 0);
  // 米饭 100g = 116 kcal 在早餐，鸡蛋 50g = 71.5 kcal 在晚餐
  assert.equal(groups.find((g) => g.key === 'breakfast').totals.kcal, 116);
  assert.equal(groups.find((g) => g.key === 'dinner').totals.kcal, 71.5);
});

test('单餐汇总', () => {
  const s = emptyState();
  addFoodEntry(s, '2026-10-16', 'lunch', rice, 200);
  addFoodEntry(s, '2026-10-16', 'lunch', egg, 100);
  const t = mealTotals(getDay(s, '2026-10-16').meals.lunch, 'lunch');
  assert.equal(t.count, 2);
  assert.equal(t.kcal, 232 + 143);
});

test('异常份量会给出提醒（防止把克写成斤）', () => {
  assert.equal(entryWarnings({ food: rice, grams: 200 }).length, 0);
  assert.ok(entryWarnings({ food: rice, grams: 1200 }).length > 0);
});

test('记运动与删除', () => {
  const s = emptyState();
  const x = addExercise(s, '2026-10-16', 'walk', 40);
  assert.equal(getDay(s, '2026-10-16').exercises.length, 1);
  assert.equal(removeExercise(s, '2026-10-16', x.id), true);
  assert.equal(getDay(s, '2026-10-16').exercises.length, 0);
});

test('记体重：同一天重复记会覆盖，不会堆一堆', () => {
  const s = emptyState();
  addWeight(s, '2026-10-16', 58.2);
  addWeight(s, '2026-10-16', 57.8);
  assert.equal(s.weights.length, 1);
  assert.equal(s.weights[0].kg, 57.8);
  addWeight(s, '2026-10-14', 58.6);
  assert.deepEqual(s.weights.map((w) => w.date), ['2026-10-14', '2026-10-16'], '应当按日期排序');
  assert.throws(() => addWeight(s, '2026-10-16', 0), /体重/);
});

test('体重趋势：记录不足时不给结论，只说明原因', () => {
  const s = emptyState();
  assert.equal(analyzeProgress(s).ok, false);
  addWeight(s, '2026-10-16', 58);
  assert.equal(analyzeProgress(s).ok, false);
  // 间隔 3 天：仍然不给结论
  addWeight(s, '2026-10-13', 58.6);
  const r = analyzeProgress(s);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('7 天'));
});

test('体重趋势：两周掉 0.8 公斤 → 判定为健康节奏', () => {
  const s = emptyState();
  addWeight(s, '2026-10-01', 60);
  addWeight(s, '2026-10-15', 59.2);
  const r = analyzeProgress(s);
  assert.equal(r.ok, true);
  assert.equal(r.days, 14);
  assert.equal(r.deltaKg, -0.8);
  assert.equal(r.perWeek, -0.4);
  assert.ok(r.verdict.includes('保持'));
});

test('体重趋势：掉得太快会提醒加餐', () => {
  const s = emptyState();
  addWeight(s, '2026-10-01', 60);
  addWeight(s, '2026-10-15', 56);
  const r = analyzeProgress(s);
  assert.ok(r.perWeek < -1);
  assert.ok(r.verdict.includes('偏快'));
});

test('体重趋势：没变化时提示先查漏记', () => {
  const s = emptyState();
  addWeight(s, '2026-10-01', 60);
  addWeight(s, '2026-10-15', 60);
  assert.ok(analyzeProgress(s).verdict.includes('没动'));
});

test('自定义食物：保存后能被搜索到', () => {
  const s = emptyState();
  const f = addCustomFood(s, { name: '某牌蛋白棒', kcal: 380, protein: 30, fat: 12, carb: 35, baseGrams: 40 });
  assert.equal(s.customFoods.length, 1);
  assert.equal(f.servings[0][1], 40, '没填份量时应当用「一份=baseGrams」');
  assert.equal(f.category, 'custom');
});

test('存档迁移：旧版本数据缺字段也能打开（迁移细节见 tests/schema.test.mjs）', () => {
  const old = { profile: demoProfile(), days: { '2026-10-16': { meals: { lunch: [{ id: 'e1', food: rice, grams: 100 }] } } } };
  const m = migrate(old);
  assert.equal(m.schemaVersion, STATE_VERSION);
  assert.deepEqual(m.customFoods, []);
  assert.deepEqual(m.weights, []);
  assert.equal(m.settings.trainDays, 3);
  const day = getDay(m, '2026-10-16');
  for (const k of ['breakfast', 'lunch', 'dinner', 'snack']) assert.ok(Array.isArray(day.meals[k]));
  assert.equal(day.meals.lunch[0].meal, 'lunch', '老记录要补上「哪一餐」');
});

test('存档迁移：乱七八糟的输入要报错，而不是「尽力解析」出空数据把人家的记录抹掉', () => {
  for (const junk of [null, '字符串', { days: '不是对象' }, 42, []]) {
    assert.throws(() => migrate(junk), /存档|格式|不是本工具/, `${JSON.stringify(junk)} 应当报错`);
  }
});

test('存档能被 JSON 完整还原（导出/导入不会丢东西）', () => {
  const s = emptyState();
  s.profile = demoProfile();
  const t = calcTargets(s.profile);
  demoEntries(s, '2026-10-16', t);
  addWeight(s, '2026-10-15', 58.4);
  addCustomFood(s, { name: '自制酸奶', kcal: 60, protein: 3.5, fat: 3, carb: 4.5, baseGrams: 150 });

  const restored = migrate(JSON.parse(JSON.stringify(s)));
  assert.equal(restored.profile.weightKg, s.profile.weightKg);
  assert.equal(restored.weights.length, 1);
  assert.equal(restored.customFoods.length, 1);
  const beforeKcal = calculateTotals(Object.values(s.days['2026-10-16'].meals).flat()).kcal;
  const afterKcal = calculateTotals(Object.values(restored.days['2026-10-16'].meals).flat()).kcal;
  assert.equal(afterKcal, beforeKcal);
});

test('示例数据：能一键生成一整天的记录', () => {
  const s = emptyState();
  s.profile = demoProfile();
  const t = calcTargets(s.profile);
  demoEntries(s, '2026-10-16', t);
  const all = Object.values(getDay(s, '2026-10-16').meals).flat();
  assert.ok(all.length >= 10, `示例只有 ${all.length} 条`);
  const kcal = calculateTotals(all).kcal;
  assert.ok(Math.abs(kcal - t.targetCalories) / t.targetCalories < 0.15, `示例合计 ${kcal}，目标 ${t.targetCalories}`);
  assert.equal(getDay(s, '2026-10-16').exercises.length, 1);
});

test('记录条的 id 不重复', () => {
  const s = emptyState();
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const e = addFoodEntry(s, '2026-10-16', 'snack', egg, 50);
    assert.ok(!ids.has(e.id), `id 重复：${e.id}`);
    ids.add(e.id);
  }
});

void calcEntry;
