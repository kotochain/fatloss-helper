/**
 * 本地周洞察测试
 *
 * 这个模块最容易犯的错不是算错，而是**用太少的数据编出「规律」**，
 * 或者把事实说成指责。所以测试重点在这两条上。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, addFoodEntry, addExercise, addWeight, demoProfile, todayKey, shiftDate,
} from '../js/store.js';
import { findFood } from '../js/foods.js';
import { calcTargets } from '../js/calc.js';
import { insights, insightHint } from '../js/insights.js';

const target = calcTargets(demoProfile());

/**
 * 记一天「像样的三餐」。
 * 说明：洞察只把 ≥400 kcal 的日子当成「记录过的一天」（避免只记一颗鸡蛋就算一天），
 * 所以测试里也必须记够量，否则测的是「我没记够」，不是程序行为。
 */
function logFullDay(state, key, { riceG = 300, chickenG = 100 } = {}) {
  addFoodEntry(state, key, 'breakfast', findFood('egg'), 100);
  // 只在真的给了克数时才记（0 克会被 store 拒绝 —— 那是「没吃」，不是「吃了 0 克」）
  if (chickenG > 0) addFoodEntry(state, key, 'lunch', findFood('chicken_breast'), chickenG);
  addFoodEntry(state, key, 'lunch', findFood('rice_cooked'), riceG);
  addFoodEntry(state, key, 'dinner', findFood('rice_cooked'), riceG);
}

/** 造一天：protein 高 = 鸡胸多主食少；否则反之 */
function buildDays(state, count, { highProtein }) {
  for (let i = 0; i < count; i++) {
    const key = shiftDate(todayKey(), -i);
    addFoodEntry(state, key, 'breakfast', findFood('egg'), 100);
    addFoodEntry(state, key, 'breakfast', findFood('milk_whole'), 250);
    addFoodEntry(state, key, 'lunch', findFood('chicken_breast'), highProtein ? 250 : 40);
    addFoodEntry(state, key, 'lunch', findFood('rice_cooked'), highProtein ? 150 : 400);
    addFoodEntry(state, key, 'dinner', findFood('chicken_breast'), highProtein ? 150 : 30);
    addFoodEntry(state, key, 'dinner', findFood('rice_cooked'), highProtein ? 120 : 450);
  }
}

function base() {
  const s = emptyState();
  s.profile = demoProfile();
  return s;
}

test('记录太少时一条洞察都不给 —— 宁可不说，也不要用 1 天数据编规律', () => {
  const s = base();
  assert.deepEqual(insights(s), [], '空存档不该有洞察');
  assert.equal(insights(s, { proteinG: target.proteinG }).length, 0);

  // 记 3 天：仍然不够
  for (let i = 0; i < 3; i++) logFullDay(s, shiftDate(todayKey(), -i));
  assert.deepEqual(insights(s, { proteinG: target.proteinG }), [], '3 天还不够，不该给结论');
});

test('没有运动的日子里，不许编出「运动日 vs 不运动日」的对比', () => {
  // compare() 要求两组样本都 ≥2。删掉这个判断后，0 个运动日会被算成均值 0，
  // 于是编出「运动日平均 0 kcal、不运动日平均 604 kcal」这种荒唐结论 —— 数据不够就是不能说话。
  const s = base();
  for (let i = 0; i < 5; i++) logFullDay(s, shiftDate(todayKey(), -i));
  const out = insights(s, { proteinG: target.proteinG });
  assert.ok(!out.some((x) => x.icon === 'run' || x.title.includes('运动日')),
    `一个运动日都没有，不该出现运动洞察：${JSON.stringify(out)}`);
});

test('算洞察不能往存档里写东西 —— 光打开页面不该把「空日子」记成有记录', () => {
  // 真出过的错：看数据的函数用了 getDay()（没有就新建），于是打开一次今天页，
  // 最近 14 天全被写进存档，「数据与备份」显示「14 天的记录」（其实只记了 1 天），
  // 导出的备份文件里也塞进 13 个空日子。看数据必须是只读的。
  const s = base();
  logFullDay(s, todayKey());
  const before = JSON.stringify(s.days);
  insights(s, { proteinG: target.proteinG, targetCalories: target.targetCalories, days: 14 });
  insightHint(s);
  assert.equal(JSON.stringify(s.days), before, '算洞察前后，days 必须一模一样');
  assert.deepEqual(Object.keys(s.days), [todayKey()], '不能凭空多出别的日期');
});

test('数据不够时给的是「再记几天」，不是假结论', () => {
  const s = base();
  const h = insightHint(s);
  assert.ok(h, '不够时要给提示');
  assert.equal(h.need, 4);
  assert.ok(h.text.includes('4 天'), h.text);
  assert.ok(!/你(容易|总是|经常)/.test(h.text), '不能在没有数据时下结论');

  for (let i = 0; i < 4; i++) logFullDay(s, shiftDate(todayKey(), -i));
  assert.equal(insightHint(s), null, '够 4 天之后就不该再显示「再记几天」');
  assert.ok(insights(s, { proteinG: target.proteinG }).length > 0, '这时候应当有洞察了');
});

test('「蛋白吃够的日子热量更低」这条要靠真实对比得出，不能拍脑袋', () => {
  const s = base();
  buildDays(s, 4, { highProtein: true });   // 高蛋白低热量
  buildDays2(s, 4);                          // 低蛋白高热量（从第 4 天往前）
  const list = insights(s, { proteinG: target.proteinG });
  const hit = list.find((x) => x.kind === 'protein');
  assert.ok(hit, `应当给出蛋白相关的洞察，实际只有：${list.map((x) => x.title).join('、')}`);
  assert.ok(hit.detail.includes('kcal'), '要给出具体数字，不能只说结论');
  assert.ok(hit.days >= 4, '要标明结论基于几天数据');
});

/** 在第 4~7 天补上「低蛋白高热量」的日子 */
function buildDays2(state, count) {
  for (let i = 4; i < 4 + count; i++) {
    const key = shiftDate(todayKey(), -i);
    addFoodEntry(state, key, 'breakfast', findFood('egg'), 100);
    addFoodEntry(state, key, 'lunch', findFood('chicken_breast'), 40);
    addFoodEntry(state, key, 'lunch', findFood('rice_cooked'), 500);
    addFoodEntry(state, key, 'dinner', findFood('rice_cooked'), 500);
    addFoodEntry(state, key, 'dinner', findFood('oil'), 15);
  }
}

test('两组样本都不够时，不给对比结论', () => {
  const s = base();
  // 只有 1 天高蛋白、3 天低蛋白：高蛋白那组样本不足
  buildDays(s, 1, { highProtein: true });
  for (let i = 1; i < 4; i++) {
    const key = shiftDate(todayKey(), -i);
    addFoodEntry(s, key, 'lunch', findFood('rice_cooked'), 500);
    addFoodEntry(s, key, 'dinner', findFood('rice_cooked'), 500);
  }
  const list = insights(s, { proteinG: target.proteinG });
  assert.equal(list.find((x) => x.kind === 'protein'), undefined, '一边只有 1 天就不该下结论');
});

test('体重趋势：不足两周的变化要说明「看趋势别看单次」', () => {
  const s = base();
  for (let i = 0; i < 5; i++) logFullDay(s, shiftDate(todayKey(), -i));
  addWeight(s, shiftDate(todayKey(), -4), 58);
  addWeight(s, todayKey(), 58.1);
  const w = insights(s, { proteinG: target.proteinG }).find((x) => x.kind === 'weight');
  assert.ok(w, '称了两次就该有体重洞察');
  assert.ok(w.detail.includes('波动') || w.detail.includes('趋势'), `要解释波动：${w.detail}`);
});

test('体重往下走时给的是鼓励，往上走时不指责', () => {
  const s = base();
  for (let i = 0; i < 8; i++) logFullDay(s, shiftDate(todayKey(), -i));
  addWeight(s, shiftDate(todayKey(), -14), 59.5);
  addWeight(s, todayKey(), 58.4);
  const w = insights(s, { proteinG: target.proteinG }).find((x) => x.kind === 'weight');
  assert.ok(w.detail.includes('健康') || w.detail.includes('快'), w.detail);
  assert.ok(!/失败|反弹|注意点/.test(w.detail), `不该有责备语气：${w.detail}`);

  const s2 = base();
  for (let i = 0; i < 8; i++) logFullDay(s2, shiftDate(todayKey(), -i));
  addWeight(s2, shiftDate(todayKey(), -14), 58);
  addWeight(s2, todayKey(), 59.2);
  const up = insights(s2, { proteinG: target.proteinG }).find((x) => x.kind === 'weight');
  assert.ok(up, '涨了也要给洞察（不能装作没看见）');
  assert.ok(/含水量|生理期|咸/.test(up.detail), `涨了要解释原因，而不是指责：${up.detail}`);
  assert.ok(!/吃太多|管住|超标/.test(up.detail), `不许出现责备词：${up.detail}`);
});

test('洞察文案里不许出现评判和施压的词', () => {
  const s = base();
  buildDays(s, 4, { highProtein: true });
  buildDays2(s, 4);
  addWeight(s, shiftDate(todayKey(), -10), 59);
  addWeight(s, todayKey(), 58.3);
  for (let i = 0; i < 6; i++) addExercise(s, shiftDate(todayKey(), -i), 'walk', 30);
  const list = insights(s, { proteinG: target.proteinG });
  assert.ok(list.length >= 2, `应当有多条洞察，实际 ${list.length}`);
  const banned = /失败|惩罚|扣分|退步|懒惰|自律一点|管住嘴|你怎么|必须|不许/;
  for (const x of list) {
    assert.ok(!banned.test(x.title), `标题里有评判词：${x.title}`);
    assert.ok(!banned.test(x.detail), `说明里有评判词：${x.detail}`);
  }
});

test('「运动的多吃一些」和「没多吃」是两种说法，不能一律说成没控制住', () => {
  const s = base();
  buildDays(s, 4, { highProtein: true });
  buildDays2(s, 4);
  // 运动日另外多吃一份，造出「运动日吃得更多」
  for (let i = 0; i < 4; i++) {
    addExercise(s, shiftDate(todayKey(), -i), 'walk', 40);
    addFoodEntry(s, shiftDate(todayKey(), -i), 'snack', findFood('banana'), 200);
  }
  const ex = insights(s, { proteinG: target.proteinG }).find((x) => x.title.includes('运动日'));
  if (ex) {
    assert.ok(ex.detail.includes('kcal'), '要给数字');
    assert.ok(!/不该吃|克制|控制不住/.test(ex.detail), `运动后饿是正常的，不该被说成问题：${ex.detail}`);
  }
});

test('洞察里的数字来自她自己的记录，与手算一致', () => {
  const s = base();
  for (let i = 0; i < 5; i++) logFullDay(s, shiftDate(todayKey(), -i), { riceG: 300, chickenG: 0 });
  // 注意：addFoodEntry 会按当日热量目标折算份量，所以实际记进去的克数不等于输入值。
  // 期望值必须从**真实记录**里算，不能按输入算 —— 否则测的是我的假设，不是程序的行为。
  const rice = findFood('rice_cooked');
  const gramsPerDay = Object.values(s.days[todayKey()].meals).flat()
    .filter((e) => e.food.id === 'rice_cooked')
    .reduce((a, e) => a + e.grams, 0);
  const expectPerDay = Math.round((rice.kcal * gramsPerDay) / 100);

  const list = insights(s, { proteinG: 200 }); // 目标调到 200，蛋白类洞察不会触发
  const top = list.find((x) => x.kind === 'calories');
  assert.ok(top, `应当给出热量大头，实际：${list.map((x) => x.title).join('、')}`);
  assert.ok(top.detail.includes(String(expectPerDay)), `实际每天 ${gramsPerDay} 克 = ${expectPerDay} kcal，文案里应当是这个数：${top.detail}`);
});
