/**
 * 份量换算与档位测试
 *
 * v43（issue #24）：离线「猜整句话」的解析器删掉后，这个文件只剩两件事：
 *  1) 「一碗」「两个」「半斤」这类说法怎么换算成克数（AI 只给说法、不给数字时全靠它）；
 *  2) 「份量是猜的」时候给用户的档位按钮必须真的能点（最小 < 当前 < 最大）。
 * 另外保留 AI 条目整理的几条：AI 报的菜名要能对上本地库、只给说法或什么都不给也不能丢。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { findPortion, gramsForPortion, buildPortionChoices, portionKindOf, normalizeAiItems } from '../js/mealparse.js';
import { findFood, matchFoodByName } from '../js/foods.js';

const gramsOf = (choices) => choices.map((c) => c.grams);

/** 档位必须真的能点：从小到大、跨过当前记的克数、说法不重复 */
function assertChoicesSane(it, label) {
  const cs = it.portionChoices;
  assert.ok(Array.isArray(cs), `${label}：低置信度必须给档位`);
  assert.ok(cs.length >= 2, `${label}：档位少于 2 个等于没法选`);
  const vals = gramsOf(cs);
  assert.ok(Math.min(...vals) < it.grams && it.grams < Math.max(...vals),
    `${label}：档位没跨过当前值 ${it.grams} → ${vals.join('/')}`);
  for (let i = 1; i < vals.length; i++) assert.ok(vals[i] > vals[i - 1], `${label}：档位没从小到大 ${vals.join('/')}`);
  assert.ok(vals.every((v) => v >= 5), `${label}：档位小到没有意义 ${vals.join('/')}`);
  const labels = cs.map((c) => c.label);
  assert.equal(new Set(labels).size, labels.length, `${label}：两个按钮说法一样，用户不知道选哪个 → ${labels.join('/')}`);
}

test('份量说法要能换算成克数：一碗 / 两个 / 半斤 / 一两 / 毫升 / 克数', () => {
  assert.equal(findPortion('一碗').grams, 350, '通用一碗按 350 克兜底（具体食物会覆盖它）');
  assert.equal(findPortion('一碗').portionWord, '一碗');

  const two = findPortion('两个');
  assert.equal(two.counting, true, '「两个」是个数，不是重量');
  assert.equal(two.count, 2);
  assert.equal(two.portionWord, '一个');

  assert.equal(findPortion('半斤').grams, 250, '一斤 500 克，半斤 250');
  assert.equal(findPortion('一两').grams, 50, '一两 50 克');
  assert.equal(findPortion('300毫升').grams, 300);
  assert.equal(findPortion('200克').grams, 200, '用户说了确切克数就照用');
  assert.equal(findPortion('一罐').portionWord, '一罐', '罐装饮料按包装算，克数交给具体食物');

  assert.equal(findPortion('随便吃了点'), null, '没有份量说法时要老实返回空，不能编一个');
});

test('换算克数要按食物自己的份量表，不是统一 350 克', () => {
  const byWord = (id, text) => gramsForPortion(findFood(id), findPortion(text));
  assert.equal(byWord('rice_cooked', '一碗'), 180, '米饭一碗是 180 克');
  assert.equal(byWord('congee', '一碗'), 250, '白粥一碗是 250 克（比米饭稀）');
  assert.equal(byWord('milk_whole', '一杯'), 250, '牛奶一杯 250 克');
  assert.equal(byWord('egg', '两个'), 100, '两个鸡蛋 100 克（一个 50 克，不是通用 100 克）');
  assert.equal(byWord('banana', '一根'), 120, '一根香蕉 120 克');
});

test('组合菜「一碗」= 一份，不是通用碗重 350 克', () => {
  const wonton = matchFoodByName('馄饨').food;
  assert.equal(gramsForPortion(wonton, findPortion('一碗')), 300, '一碗馄饨按它自己的 300 克一份算');
});

test('档位按食物类型给，不是所有食物统一乘一个系数', () => {
  // 米饭：直接沿用库里的碗（130/180/250）
  assert.deepEqual(gramsOf(buildPortionChoices(findFood('rice_cooked'), 180)), [130, 180, 250]);
  // 奶：按杯（库里有「一杯 250」，上下各补一档）
  assert.deepEqual(gramsOf(buildPortionChoices(findFood('milk_whole'), 250)), [200, 250, 350]);
  // 一份肉：按份，量级跟米饭完全不同
  const meat = gramsOf(buildPortionChoices(findFood('beef_lean'), 100));
  assert.deepEqual(meat, [60, 100, 120]);
  // 一勺油这种几克的调料不值得问
  assert.deepEqual(buildPortionChoices(findFood('oil'), 10), []);
  // 类型判定本身也要对
  assert.equal(portionKindOf(findFood('rice_cooked')), 'bowl');
  assert.equal(portionKindOf(findFood('milk_whole')), 'cup');
  assert.equal(portionKindOf(findFood('beef_lean')), 'plate');
  assert.equal(portionKindOf({ id: 'beef_noodle', category: 'dish' }), 'bowl');
});

test('档位函数的边界：没有食物数据、份量不合理时不能崩', () => {
  // 认不出食物时也得给档位（界面只依赖这个函数）
  assertChoicesSane({ grams: 100, portionChoices: buildPortionChoices(null, 100) }, '无食物数据');
  // 0 / 负 / 非数字：宁可不问，也不要给一堆没意义的按钮
  for (const bad of [0, -5, NaN, null, undefined, '']) {
    assert.deepEqual(buildPortionChoices(null, bad), [], `默认值 ${String(bad)} 不该生成档位`);
  }
  // 极小值（比一勺油还小）不值得问
  assert.deepEqual(buildPortionChoices(findFood('sugar'), 5), []);
  // 极大值也要跨过默认值，否则点了没变化
  const big = buildPortionChoices(findFood('rice_cooked'), 3000);
  assertChoicesSane({ grams: 3000, portionChoices: big }, '3000 克');
});

test('AI 说组合菜的名字也要能对上本地库', () => {
  const r = normalizeAiItems({
    items: [
      { name: '黄焖鸡米饭', grams: 550 },
      { name: '馄饨', grams: 300 },
      { name: '盖饭', grams: 500 },
      { name: '烧烤', grams: 400 },
    ],
  });
  assert.deepEqual(r.items.map((x) => x.foodId), ['huangmenji', 'wonton_meal', 'set_rice', 'bbq_meal']);
  assert.equal(r.items[0].kcal, 780, '黄焖鸡米饭 550 克 = 780 kcal');
});

test('AI 只给「一碗」这种说法、或者干脆没给份量，也不能丢', () => {
  const r = normalizeAiItems({
    items: [
      { name: '馄饨', portion: '一碗' },
      { name: '酸菜鱼', portion: '一碗' },
      { name: '寿司' },
    ],
  });
  assert.deepEqual(r.items.map((x) => x.grams), [300, 500, 25], '一碗馄饨=一份 300，一碗酸菜鱼=500，寿司默认一贯 25');
});

test('AI 说「两个鸡蛋」这种个数说法，要按食物自己的单个重量换算', () => {
  // 回归：以前「一个」被当成通用 100 克，两个鸡蛋算成 200 克（实际 100 克，误差一倍）
  const r = normalizeAiItems({ items: [{ name: '鸡蛋', portion: '两个' }] });
  assert.equal(r.items[0].grams, 100, '两个鸡蛋 100 克（一个 50 克）');

  const rice = normalizeAiItems({ items: [{ name: '米饭', portion: '两碗' }] });
  assert.equal(rice.items[0].grams, 360, '两碗米饭 360 克（一碗 180）');
});
