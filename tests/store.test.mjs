/**
 * 记录本与存档测试（记饮食、记运动、记体重、趋势判断、导入导出）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, todayKey, shiftDate, getDay, addFoodEntry, removeFoodEntry,
  updateFoodEntry, addExercise, removeExercise, addWeight, addCustomFood,
  weightTrend, analyzeProgress, demoProfile, demoEntries, STATE_VERSION, frequentFoods,
  recordedDays, hasUserData, followToday, isCurrentWeightDate,
} from '../js/store.js';
import { migrate } from '../js/schema.js';
import { calcTargets, calcEntry } from '../js/calc.js';
import { findFood, kcalOnlyFood } from '../js/foods.js';
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

test('addExercise 的时长校验：0、负数、离谱值都要被拒绝', () => {
  // 不校验的话会存进「练了 0 分钟」，统计里多一条假记录（次数对了、时长却没变），很难查。
  const s = emptyState();
  assert.equal(addExercise(s, '2026-10-16', 'walk', 30)?.minutes, 30);
  assert.equal(addExercise(s, '2026-10-16', 'walk', 0), null, '0 分钟不是运动');
  assert.equal(addExercise(s, '2026-10-16', 'walk', -20), null, '负数要被拒');
  assert.equal(addExercise(s, '2026-10-16', 'walk', NaN), null);
  assert.equal(addExercise(s, '2026-10-16', 'walk', 2000), null, '一天 2000 分钟不可能');
  assert.equal(addExercise(s, '2026-10-16', '', 30), null, '没有动作名不算');
  assert.equal(getDay(s, '2026-10-16').exercises.length, 1, '只有合法的那一条被记上');
  assert.equal(addExercise(s, '2026-10-16', 'walk', 30.6)?.minutes, 31, '小数要取整');
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

test('「只填热量」记进去就是这一顿的热量，且不会变成「常吃的」快捷项', () => {
  const s = emptyState();
  const r = kcalOnlyFood({ name: '楼下的牛肉面', kcal: 650, protein: 30 });
  const e = addFoodEntry(s, '2026-10-21', 'lunch', r.food, 100);
  assert.equal(e.food.kcalOnly, true);
  assert.equal(calcEntry(e.food, e.grams).kcal, 650, '记 100 克就应当是 650 kcal（不是 650/100 克）');

  // 常吃的如果收录它，会变成一个「100 克 = 650 kcal」的怪条目，点它还得再填克数
  addFoodEntry(s, '2026-10-21', 'lunch', egg, 50);
  addFoodEntry(s, '2026-10-20', 'lunch', egg, 50);
  const freq = frequentFoods(s, 8);
  assert.ok(!freq.some((x) => x.food.kcalOnly), '只填热量的条目不该出现在常吃的里');
  assert.ok(freq.some((x) => x.food.id === 'egg'));
});


/*
 * v33：覆盖类操作（演示、导入）前必须先判断「有没有会丢的东西」。
 * 这个判断只能有一份 —— 备份页的「X 天记录」和覆盖确认都用它。
 */

test('「记过的日子」只数真有内容的：打开页面建的空日期不算', () => {
  const s = emptyState();
  const d = todayKey();
  getDay(s, d);                       // 渲染今天页会顺手建出空日期
  getDay(s, shiftDate(d, -1));        // 洞察还会往前建
  assert.deepEqual(recordedDays(s), [], '空日期不能算成「记过」');
  assert.equal(hasUserData(s), false, '没有任何东西时不该弹覆盖确认');

  addFoodEntry(s, d, 'lunch', rice, 150);
  assert.deepEqual(recordedDays(s), [d]);
  assert.equal(hasUserData(s), true);
});

test('覆盖前判断：记录、体重、自己加的食物、填好的资料都算「丢了会心疼」', () => {
  const base = emptyState();
  assert.equal(hasUserData(base), false);

  const withProfile = { ...emptyState(), profile: demoProfile() };
  assert.equal(hasUserData(withProfile), true, '只填了资料也算：演示/导入会把它换掉');

  const withWeight = emptyState();
  addWeight(withWeight, todayKey(), 57.8);
  assert.equal(hasUserData(withWeight), true, '体重趋势也是记录');

  const withCustom = emptyState();
  addCustomFood(withCustom, { name: '楼下那家馄饨', kcal: 120, protein: 6, fat: 4, carb: 16 });
  assert.equal(hasUserData(withCustom), true, '自己加的食物不该被演示覆盖');

  assert.equal(hasUserData(null), false);
  assert.equal(hasUserData({}), false);
});

test('只有备注/只有运动的日子也算记过（别把这类记录当空的）', () => {
  const s = emptyState();
  const d = todayKey();
  const day = getDay(s, d);
  day.note = '今天外食，没法称重';
  assert.deepEqual(recordedDays(s), [d]);

  const s2 = emptyState();
  addExercise(s2, d, 'walk', 30);
  assert.deepEqual(recordedDays(s2), [d]);
});


/*
 * v34：AI 估的菜存成「我的食物」时，来源/原句要留住（以后能说清这数字哪来的），
 * 同名再存只更新数字、不重复堆。
 */

test('v34：「我的食物」存来源和原句，同名再存只更新不重复', () => {
  const s = emptyState();
  const first = addCustomFood(s, {
    name: '某网红限定轻食碗', kcal: 120, protein: 8, fat: 3, carb: 15,
    source: 'ai-estimate', note: 'AI 估的营养（本地已按 4/9/4 核对）', originalText: '中午吃了某网红限定轻食碗 300 克',
  });
  assert.equal(s.customFoods.length, 1);
  assert.equal(first.source, 'ai-estimate');
  assert.ok(first.originalText.includes('轻食碗'), '原句要留着，方便日后核对');
  assert.ok(first.createdAt);

  // 同名（多了空格）再存：更新数字，不新增
  const second = addCustomFood(s, {
    name: ' 某网红限定轻食碗 ', kcal: 150, protein: 10, fat: 4, carb: 18, source: 'ai-estimate',
  });
  assert.equal(s.customFoods.length, 1, '同名不该堆出第二条（匹配永远只取第一条，后面改了也没用）');
  assert.equal(second.id, first.id);
  assert.equal(second.kcal, 150);
  assert.ok(second.updatedAt);

  // 手动加的不带 source 时按 manual 记
  const manual = addCustomFood(s, { name: '某牌蛋白棒', kcal: 380, protein: 30, fat: 12, carb: 35, baseGrams: 40 });
  assert.equal(manual.source, 'manual');
});

test('页面开着跨过 0 点：「今天」要跟着换，但正在看历史时不能乱跳（v49）', () => {
  // 最常见：本来就在看今天 → 换到新的今天
  assert.deepEqual(
    followToday({ viewing: '2026-10-30', lastToday: '2026-10-30', today: '2026-10-31' }),
    { dateKey: '2026-10-31', followed: true },
  );
  // 用户自己翻到 28 号在补记 → 不许把他的视线拽走，否则那一笔会记到今天
  assert.deepEqual(
    followToday({ viewing: '2026-10-28', lastToday: '2026-10-30', today: '2026-10-31' }),
    { dateKey: '2026-10-28', followed: false },
  );
  // 没跨天：什么都不做
  assert.deepEqual(
    followToday({ viewing: '2026-10-30', lastToday: '2026-10-30', today: '2026-10-30' }),
    { dateKey: '2026-10-30', followed: false },
  );
  // 参数不全时不要抛错（启动早期可能还没算好）
  assert.deepEqual(followToday({}), { dateKey: undefined, followed: false });
});

test('改已记食物：改了餐次就真的搬到那一餐（v51）', () => {
  const s = emptyState();
  const e = addFoodEntry(s, '2026-10-16', 'lunch', rice, 150);
  const updated = updateFoodEntry(s, '2026-10-16', e.id, { grams: 120, meal: 'dinner' });

  assert.equal(updated.id, e.id);
  assert.equal(updated.grams, 120);
  assert.equal(updated.meal, 'dinner');
  // 关键：不能只改 meal 字段、条目还留在午餐数组里（界面按数组分组，用户会看到「没搬过去」）
  assert.equal(getDay(s, '2026-10-16').meals.lunch.length, 0);
  assert.equal(getDay(s, '2026-10-16').meals.dinner.length, 1);
  assert.equal(getDay(s, '2026-10-16').meals.dinner[0].id, e.id);

  // 只改份量、不改餐次：留在原地
  updateFoodEntry(s, '2026-10-16', e.id, { grams: 80 });
  assert.equal(getDay(s, '2026-10-16').meals.dinner[0].grams, 80);

  // 找不到的记录不许「假装改成功」
  assert.equal(updateFoodEntry(s, '2026-10-16', 'not_exist', { grams: 100 }), null);
  // 份量非法时 store 要拦住，不能写进一个 NaN
  assert.throws(() => updateFoodEntry(s, '2026-10-16', e.id, { grams: 0 }), /份量/);
});


test('补记历史体重不更新当前体重（否则今天的目标会被旧数据改掉，v51）', () => {
  assert.equal(isCurrentWeightDate('2026-10-31', '2026-10-31'), true);
  assert.equal(isCurrentWeightDate('2026-10-24', '2026-10-31'), false, '补记上周的体重不能改当前目标');
  assert.equal(isCurrentWeightDate('2026-11-01', '2026-10-31'), false, '翻到明天记体重也不算今天');
});
