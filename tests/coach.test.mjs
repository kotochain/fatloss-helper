/**
 * AI 教练的测试：**数字必须全部来自本地**。
 *
 * 这个功能最容易出的事故是「模型自己算/编数字」——用户说「今天还能吃 520 kcal」，
 * 结果界面写着 480，信任就没了。所以这里重点盯三件事：
 *  1) 给 AI 的事实清单里的数字，跟 calcTargets / 当天记录一致；
 *  2) 建议的份量和热量不能超出剩余额度；
 *  3) AI 回的话里只要出现清单外的数字，或暗示「运动了可以多吃」，就必须被打回本地版。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { calcTargets } from '../js/calc.js';
import { findFood } from '../js/foods.js';
import { shiftDate } from '../js/store.js';
import {
  buildCoachBrief, localCoachAdvice, suggestFoods, recentStats,
  coachSystemPrompt, coachUserMessage, checkCoachText, allowedNumbers, COACH_FOOD_IDS,
} from '../js/coach.js';

const TODAY = '2026-10-20';
const TARGETS = calcTargets({
  sex: 'female', age: 26, heightCm: 163, weightKg: 58,
  activity: 'light', pace: 'standard', goal: 'lose', targetWeightKg: 54,
});

/** 造一份只有需要的天数/条目的存档 */
function makeState(daySpecs) {
  const days = {};
  for (const spec of daySpecs) {
    const key = shiftDate(TODAY, -spec.offset);
    const entries = (spec.entries || []).map((e, i) => ({
      id: `e${spec.offset}-${i}`,
      meal: 'lunch',
      food: findFood(e.foodId),
      grams: e.grams,
    }));
    days[key] = { meals: { breakfast: [], lunch: entries, dinner: [], snack: [] }, exercises: [], note: '' };
  }
  return { profile: {}, days };
}

const totalsOf = (kcal, protein, fat = 30, carb = 100) => ({ kcal, protein, fat, carb });

test('事实清单里的数字跟当天记录、目标一致', () => {
  const totals = totalsOf(900, 60);
  const brief = buildCoachBrief({ state: makeState([]), targets: TARGETS, totals, today: TODAY });

  assert.equal(brief.eatenKcal, 900);
  assert.equal(brief.targetKcal, TARGETS.targetCalories);
  assert.equal(brief.remainingKcal, Math.round(TARGETS.targetCalories - 900));
  assert.equal(brief.protein.target, Math.round(TARGETS.proteinG));
  assert.equal(brief.protein.eaten, 60);
  assert.equal(brief.protein.gap, Math.max(0, Math.round(TARGETS.proteinG - 60)));
});

test('建议的搭配不超额度、也不把蛋白补过头', () => {
  const totals = totalsOf(800, 45);
  const brief = buildCoachBrief({ state: makeState([]), targets: TARGETS, totals, today: TODAY });
  assert.ok(brief.suggestions.length >= 1, '蛋白缺口大时应当给出具体搭配');

  const kcal = brief.suggestions.reduce((a, x) => a + x.kcal, 0);
  const protein = brief.suggestions.reduce((a, x) => a + x.protein, 0);
  assert.ok(kcal <= brief.remainingKcal + 1, `建议热量 ${kcal} 超过了剩余额度 ${brief.remainingKcal}`);
  assert.ok(protein <= brief.protein.gap + 5, `建议蛋白 ${protein} 超过缺口 ${brief.protein.gap} 太多`);
  for (const s of brief.suggestions) {
    assert.ok(s.grams >= 50 && s.grams <= 300, `${s.name} 的份量 ${s.grams} 克不现实`);
    assert.ok(s.kcal > 0 && s.protein > 0, `${s.name} 的热量/蛋白没算出来`);
  }
  assert.deepEqual(brief.suggestionTotal, {
    kcal: Math.round(kcal),
    protein: Math.round(protein * 10) / 10,
  });
});

test('教练建议里的肉/鱼必须是熟重条目（和记录默认口径一致）', () => {
  // 建议说「生鸡胸肉 80 克」，用户去搜索/记录默认是熟重，同一份能差 25%+。
  const raw = COACH_FOOD_IDS.filter((id) => findFood(id)?.form === 'raw');
  assert.deepEqual(raw, [], `教练的食物清单里混进了生重条目：${raw.join('、')}`);
  for (const gap of [10, 30, 60]) {
    const list = suggestFoods({ remainingKcal: 800, proteinGap: gap });
    const bad = list.filter((s) => findFood(s.id || s.foodId)?.form === 'raw');
    assert.deepEqual(bad.map((x) => x.name), [], `建议里出现生重条目：${bad.map((x) => x.name).join('、')}`);
  }
});

test('额度已经吃超时不建议再吃（不能一边超一边劝加餐）', () => {
  const brief = buildCoachBrief({
    state: makeState([]),
    targets: TARGETS,
    totals: totalsOf(TARGETS.targetCalories + 200, 50),
    today: TODAY,
  });
  assert.equal(brief.suggestions.length, 0);
  const text = localCoachAdvice(brief).lines.join('');
  assert.ok(text.includes('超出'), `应当说清已超出：${text}`);
  assert.ok(!/再加一份|来一份|补法/.test(text), '已经超了还在劝加餐');
  // 只查上面那几个词不太够：删掉「吃超了」这个分支后，会退回去劝「优先吃蛋白质」，
  // 上面两条照样过（文本仍是「超出」，也没出现「再加一份」）。这里断言真的在劝用户别再补。
  assert.ok(text.includes('别再补'), `吃超了要说「别再补了」，实际：${text}`);
  assert.ok(!/优先吃/.test(text), `吃超了不该再推荐吃什么，实际：${text}`);
});

test('蛋白已经够了就不硬塞蛋白食物', () => {
  const brief = buildCoachBrief({
    state: makeState([]),
    targets: TARGETS,
    totals: totalsOf(700, TARGETS.proteinG + 10),
    today: TODAY,
  });
  assert.equal(brief.protein.gap, 0);
  assert.deepEqual(brief.suggestions, []);
});

test('7 天概况只数真的记过的日子，而且绝不往存档里写空日子', () => {
  const state = makeState([
    { offset: 0, entries: [{ foodId: 'rice_cooked', grams: 400 }] }, // 464 kcal
    { offset: 1, entries: [{ foodId: 'rice_cooked', grams: 400 }] },
    { offset: 2, entries: [{ foodId: 'rice_cooked', grams: 100 }] }, // 116 kcal —— 不算「记了」
    { offset: 4, entries: [] },
  ]);
  const before = Object.keys(state.days).sort();
  const stats = recentStats(state, TODAY, { days: 7, targetKcal: TARGETS.targetCalories });
  assert.equal(stats.days, 7);
  assert.equal(stats.logged, 2, `只有 2 天像样记录，实际算了 ${stats.logged} 天`);
  assert.equal(stats.avgKcal, 464);
  assert.deepEqual(Object.keys(state.days).sort(), before, '看数据不能顺手建空日子');
});

test('本地版建议：说人话、给具体份量、不评判', () => {
  const brief = buildCoachBrief({ state: makeState([]), targets: TARGETS, totals: totalsOf(900, 60), today: TODAY });
  const advice = localCoachAdvice(brief);
  const text = advice.lines.join('\n');
  assert.ok(advice.headline.length > 0);
  assert.ok(text.includes(String(brief.remainingKcal)), '没告诉用户还能吃多少');
  assert.ok(text.includes(String(brief.protein.gap)), '没告诉用户蛋白还差多少');
  for (const s of brief.suggestions) assert.ok(text.includes(s.name), `建议里没提到 ${s.name}`);
  assert.ok(!/自律|管住嘴|吃太多|奖励|吃回/.test(text), `出现了说教/奖励话术：${text}`);
});

test('提示词把三条硬约束写死了（只准用给定数字 / 不评判 / 运动不能吃回）', () => {
  const p = coachSystemPrompt();
  assert.ok(p.includes('只能使用'), '没写「只能用给出的数字」');
  assert.ok(p.includes('不许自己加减乘除') || p.includes('不许编'), '没写「不许自己算」');
  assert.ok(p.includes('不评判'), '没写「不评判」');
  assert.ok(p.includes('吃回'), '没写「不许暗示运动可以吃回」');
  const u = coachUserMessage(briefFixture());
  assert.ok(u.includes('还能吃'), '给 AI 的输入里没有剩余额度');
  assert.ok(u.includes('还差'), '给 AI 的输入里没有蛋白缺口');
});

function briefFixture() {
  return buildCoachBrief({ state: makeState([]), targets: TARGETS, totals: totalsOf(900, 60), today: TODAY });
}

test('AI 的话只许用清单里的数字（编数字就退回本地版）', () => {
  const brief = briefFixture();
  const s = brief.suggestions[0];

  const good = `今天还能吃 ${brief.remainingKcal} kcal，蛋白质还差 ${brief.protein.gap} 克。可以来 ${s.name} ${s.grams} 克，蛋白 ${s.protein} 克，剩下的额度留给蔬菜。`;
  assert.equal(checkCoachText(good, brief).ok, true, '照清单说反而被判不合格');

  const fabricated = '今天还能吃 999 kcal，蛋白质还差 12 克，随便吃。';
  const bad = checkCoachText(fabricated, brief);
  assert.equal(bad.ok, false);
  assert.ok(bad.reason.includes('999'), `没指出编造的数字：${bad.reason}`);
});

test('暗示「运动了可以多吃」的话一律不要', () => {
  const brief = briefFixture();
  for (const text of [
    '今天练得不错，运动完可以多吃一块蛋糕，不用有负担。',
    '你跑步消耗了不少，奖励自己一杯奶茶吧，热量能补回来。',
    '锻炼之后吃回来的那部分不算，放心加餐。',
  ]) {
    const r = checkCoachText(text, brief);
    assert.equal(r.ok, false, `这种话应当被拦下：${text}`);
    assert.ok(r.reason.includes('运动') || r.reason.includes('吃回'), r.reason);
  }
});

test('清单里的数字都在白名单里（含天数），太短的回答直接不用', () => {
  const brief = briefFixture();
  const allowed = allowedNumbers(brief);
  for (const n of [brief.remainingKcal, brief.targetKcal, brief.protein.gap, brief.protein.target, brief.stats.days]) {
    assert.ok(allowed.has(String(n)), `${n} 没进白名单`);
  }
  assert.equal(checkCoachText('好。', brief).ok, false);
});

test('推荐的补蛋白食物都在食物库里（改名/删条目会让建议变成空话）', () => {
  const missing = COACH_FOOD_IDS.filter((id) => !findFood(id));
  assert.deepEqual(missing, [], `这些 id 在食物库里不存在：${missing.join('、')}`);
});

test('suggestFoods 自己也要守住边界：缺口太小/额度太少就不硬凑', () => {
  assert.deepEqual(suggestFoods({ remainingKcal: 1000, proteinGap: 2 }), []);
  assert.deepEqual(suggestFoods({ remainingKcal: 40, proteinGap: 40 }), []);
  const one = suggestFoods({ remainingKcal: 120, proteinGap: 30 });
  assert.ok(one.length >= 1);
  assert.ok(one.reduce((a, x) => a + x.kcal, 0) <= 121);
});
