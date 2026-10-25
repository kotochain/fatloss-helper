/**
 * 「今天顺手做两件事」的规则测试（v36，issue #14 A）。
 *
 * 这张卡的意义是给「每天为什么打开」一个具体理由，所以规则要同时满足：
 *  - 说到的数字必须来自当天记录（不猜、不编）；
 *  - 最多两条，凑不出来就不显示；
 *  - 和「接住」卡不重复；今天还没记时由接住卡负责；
 *  - 不指责、不施压：文案里不许出现「应该 / 必须 / 失败 / 差劲」这类词。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, addWeight, todayKey, shiftDate } from '../js/store.js';
import { nextSteps, nextStepsTitle } from '../js/nextsteps.js';

const TODAY = '2026-10-25';
const TARGETS = { targetCalories: 1500, proteinG: 70, fatG: 40, carbG: 160 };
const at = (hour) => new Date(2026, 9, 25, hour, 30);

/** 有记录的状态：今天早餐记了一笔（有记录才谈得上「顺手做点什么」） */
function stateWithFood() {
  const s = emptyState();
  s.days[TODAY] = {
    meals: {
      breakfast: [{ id: 'e1', meal: 'breakfast', food: { name: '米饭', kcal: 116, protein: 2.6, fat: 0.3, carb: 25.9 }, grams: 150 }],
      lunch: [], dinner: [], snack: [],
    },
    exercises: [], note: '',
  };
  return s;
}

function steps({ state = stateWithFood(), totals = { kcal: 400, protein: 20, fat: 8, carb: 70 }, now = at(12), targets = TARGETS } = {}) {
  return nextSteps({ state, totals, targets, today: TODAY, now });
}

test('v36：今天一笔都没记时不出这张卡（交给「接住」卡，不重复说）', () => {
  const s = emptyState();
  assert.deepEqual(nextSteps({ state: s, totals: { kcal: 0, protein: 0, fat: 0, carb: 0 }, targets: TARGETS, today: TODAY, now: at(9) }), []);
});

test('v36：蛋白缺口大时给具体到克数的建议，并且能一键填好一句话', () => {
  const list = steps({ totals: { kcal: 400, protein: 20, fat: 8, carb: 70 } });
  const protein = list.find((s) => s.key === 'protein');
  assert.ok(protein, '缺口 50 克蛋白质时必须给这一步');
  assert.match(protein.text, /还差约 50 克/);
  assert.match(protein.text, /1100 kcal/);
  assert.ok(protein.text.includes('克（蛋白'), `要给具体食物和克数：${protein.text}`);
  assert.equal(protein.action, 'quick-fill');
  assert.ok(protein.payload.text.includes('克'), '点一下要能把一句话填好');
  assert.ok(list.length <= 2, '最多两条');
});

test('v36：蛋白够了、额度也合适时，给的是「安排得不错」，不再催蛋白', () => {
  const list = steps({ totals: { kcal: 1250, protein: 72, fat: 40, carb: 140 } });
  const keys = list.map((s) => s.key);
  assert.ok(!keys.includes('protein'), '蛋白已经够了就不该再提补蛋白');
  assert.ok(keys.includes('ok'));
  assert.match(list.find((s) => s.key === 'ok').text, /还剩 250 kcal/);
});

test('v36：额度超了不催吃，也不指责，只说明天怎么调整', () => {
  const list = steps({ totals: { kcal: 1700, protein: 30, fat: 70, carb: 180 } });
  const full = list.find((s) => s.key === 'full');
  assert.ok(full, '超额度时要有说明');
  assert.match(full.text, /明天/);
  assert.equal(full.action, undefined, '超了就别再给「再吃一笔」的按钮');
  assert.ok(!/应该|必须|失败|吃多了/.test(full.text), `不许指责：${full.text}`);
});

test('v36：傍晚且晚饭没记时才提醒；白天不提醒晚饭', () => {
  const evening = steps({ now: at(19) });
  assert.ok(evening.some((s) => s.key === 'dinner'), '19 点、晚饭空着，应当提醒');
  const morning = steps({ now: at(9) });
  assert.ok(!morning.some((s) => s.key === 'dinner'), '早上提晚饭很莫名其妙');
});

test('v36：超过 7 天没称才提醒称重；刚称过绝不催；早上把称重放第一条', () => {
  const stale = stateWithFood();
  addWeight(stale, shiftDate(TODAY, -10), 58);
  const morning = nextSteps({ state: stale, totals: { kcal: 300, protein: 15, fat: 6, carb: 50 }, targets: TARGETS, today: TODAY, now: at(8) });
  assert.equal(morning[0].key, 'weigh', '早上最适合称重，应当放第一条');

  const fresh = stateWithFood();
  addWeight(fresh, TODAY, 58);
  const list = nextSteps({ state: fresh, totals: { kcal: 300, protein: 15, fat: 6, carb: 50 }, targets: TARGETS, today: TODAY, now: at(8) });
  assert.ok(!list.some((s) => s.key === 'weigh'), '今天称过了就别催');
});

test('v36：最多两条；每条都要有人话标题和说明；标题按条数变化', () => {
  const stale = stateWithFood();
  addWeight(stale, shiftDate(TODAY, -20), 58);
  const list = nextSteps({ state: stale, totals: { kcal: 400, protein: 20, fat: 8, carb: 70 }, targets: TARGETS, today: TODAY, now: at(19) });
  assert.ok(list.length >= 2, '晚上有晚饭 + 蛋白缺口 + 称重到期，至少能凑两条');
  assert.ok(list.length <= 2, '最多只能两条，多了就是骚扰');
  for (const s of list) {
    assert.ok(s.title.length >= 4, `标题太短：${s.title}`);
    assert.ok(s.text.length >= 8, `说明太短：${s.text}`);
    assert.ok(!/应该|必须|失败|差劲|不合格/.test(`${s.title}${s.text}`), `文案不许指责：${s.title} / ${s.text}`);
  }
  assert.equal(nextStepsTitle(1), '今天可以顺手做一件事');
  assert.equal(nextStepsTitle(2), '今天可以顺手做两件事');
  assert.equal(nextStepsTitle(0), '');
});

test('v36：同样输入给同样结果（本地算，无随机、无时间戳依赖）', () => {
  const a = steps({ now: at(12) });
  const b = steps({ now: at(12) });
  assert.deepEqual(a, b);
});
