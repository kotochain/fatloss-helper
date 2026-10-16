/**
 * 离线解析的「份量置信度」测试
 *
 * 要守住的产品行为（issue #2）：她说得清楚就别打扰她；说不清楚（「一碗」「一份」、
 * 干脆没说）就必须反问一句，并且给出几个按食物类型给的档位，让她一点就选。
 * 这里同时钉住「不许悄悄改克数」—— 加置信度只是多问一句，不能顺手把估算值改掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDescription, buildPortionChoices, portionKindOf } from '../js/mealparse.js';
import { findFood } from '../js/foods.js';

/** 取一条 item，找不到就直接失败（比 `?.` 静默通过好：静默通过会让测试变成摆设） */
function item(text, keyword) {
  const it = parseDescription(text).items.find((x) => x.name.includes(keyword));
  assert.ok(it, `「${text}」里没解析出「${keyword}」`);
  return it;
}

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
  assert.equal(new Set(labels).size, labels.length, `${label}：两个按钮说法一样，她不知道选哪个 → ${labels.join('/')}`);
}

test('她说了确切克数 → 高置信度，不该再问', () => {
  const rice = item('中午吃了200克米饭', '米饭');
  assert.equal(rice.grams, 200, '说好的克数不能被改动');
  assert.equal(rice.confidence, 'high');
  assert.equal(rice.confidenceReason, null, '说得清楚就不要给理由，界面也不该多出东西');
  assert.deepEqual(rice.portionChoices, []);
});

test('有明确换算的份量词（两个鸡蛋、一罐可乐、一杯酸奶）→ 高置信度', () => {
  const egg = item('中午吃了两个鸡蛋', '鸡蛋');
  assert.equal(egg.confidence, 'high', '鸡蛋个头有标准，两个就是 100 克，不用问');
  assert.equal(egg.grams, 100);

  const cola = item('喝了一罐可乐', '可乐');
  assert.equal(cola.confidence, 'high', '一罐可乐是固定包装');

  const yogurt = item('喝了一杯无糖酸奶', '酸奶');
  assert.equal(yogurt.confidence, 'high', '库里写了「一杯 150 克」，换算明确');
});

test('「一碗米饭」→ 低置信度，档位就是食物库里那三个碗', () => {
  const rice = item('一碗米饭', '米饭');
  assert.equal(rice.confidence, 'low');
  assert.ok(rice.confidenceReason.includes('一碗'), `理由要说清是哪个说法说不准：${rice.confidenceReason}`);
  assert.equal(rice.grams, 180, '一碗米饭还是按库里的 180 克，只是多问一句');
  assert.deepEqual(gramsOf(rice.portionChoices), [130, 180, 250], '米饭的档位该跟食物库的份量表一致');
});

test('组合菜「一碗牛肉面」→ 一定反问她（这是误差最大的地方）', () => {
  const noodle = item('今天中午在食堂吃了碗牛肉面', '牛肉面');
  assert.equal(noodle.confidence, 'low');
  assert.equal(noodle.source, 'dish');
  assertChoicesSane(noodle, '牛肉面');
  assert.equal(noodle.grams, 600, '加的是「问一句」，不是把克数改小');
  assert.deepEqual(noodle.portionChoices.map((c) => c.label), ['小碗', '正常', '大碗'],
    '一碗面要按碗问，不是按「份」');
});

test('组合菜只要她说了克数，就别再问（说得清楚就不打扰）', () => {
  const noodle = item('中午吃了600克牛肉面', '牛肉面');
  assert.equal(noodle.confidence, 'high', '明说了 600 克还要问，就成了烦她');
  assert.equal(noodle.grams, 600);
  assert.deepEqual(noodle.portionChoices, []);
});

test('「一份黄焖鸡米饭」→ 低置信度，档位按份给', () => {
  const meal = item('中午吃了一份黄焖鸡米饭', '黄焖鸡');
  assert.equal(meal.confidence, 'low');
  assert.ok(meal.confidenceReason.includes('一份'));
  assertChoicesSane(meal, '黄焖鸡米饭');
  assert.equal(meal.grams, 550, '基准热量不能因为多问一句就变');
});

test('包装有大有小（半包薯片）→ 低置信度', () => {
  const chips = item('下午吃了半包薯片', '薯片');
  assert.equal(chips.confidence, 'low', '小包 50 克和大包 100 克差一倍，得问');
  assertChoicesSane(chips, '薯片');
});

test('她什么份量都没说 → 低置信度，理由要说明是按常见的一份记的', () => {
  const veg = item('中午吃了西兰花', '西兰花');
  assert.equal(veg.confidence, 'low');
  assert.ok(veg.confidenceReason.includes('没说'), `理由要说清是「没说」：${veg.confidenceReason}`);
  assertChoicesSane(veg, '西兰花');
});

test('都说得清楚时：一条低置信度都没有，界面不该多出任何东西', () => {
  const r = parseDescription('中午吃了200克米饭和两个鸡蛋');
  assert.equal(r.items.length, 2);
  for (const it of r.items) {
    assert.equal(it.confidence, 'high', `${it.name} 不该被问`);
    assert.deepEqual(it.portionChoices, [], `${it.name} 高置信度却给了档位按钮`);
    assert.equal(it.confidenceReason, null);
  }
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

test('「两碗米饭」的档位要跟着翻倍，不是还按一碗给', () => {
  const rice = item('两碗米饭', '米饭');
  assert.equal(rice.grams, 360);
  assert.deepEqual(gramsOf(rice.portionChoices), [260, 360, 500]);
});

test('「加饭」「加肉」这种加多少全看她手的，要问；「加蛋」是一颗标准大小，不问', () => {
  const rice = item('牛肉面加饭', '加米饭');
  assert.equal(rice.confidence, 'low');
  assertChoicesSane(rice, '加饭');

  const meat = item('牛肉面加肉', '加牛');
  assert.equal(meat.confidence, 'low');
  assertChoicesSane(meat, '加肉');

  const egg = item('牛肉面加蛋', '鸡蛋');
  assert.equal(egg.confidence, 'high', '一颗蛋是标准大小，不该拿这种问题烦她');
  assert.deepEqual(egg.portionChoices, []);
});

test('批量过一遍常见说法：低置信度的档位必须都能点', () => {
  const phrases = [
    '一碗米饭', '两碗米饭', '一小碗粥', '一份黄焖鸡米饭', '一份麻辣烫', '一碗牛肉面', '一碗馄饨',
    '一份炒饭', '一碗面条', '今天中午在食堂吃了碗牛肉面，加了个蛋', '下午喝了杯奶茶，还有半包薯片',
    '晚上吃了碗红烧肉配了一碗米饭，还有炒青菜', '加饭加肉', '吃了一根香蕉', '一片面包',
    '喝了瓶运动饮料', '一碗炒青菜', '一份宫保鸡丁', '一份麻婆豆腐', '一块奶油蛋糕',
  ];
  let asked = 0;
  for (const p of phrases) {
    for (const it of parseDescription(p).items) {
      assert.ok(['high', 'low'].includes(it.confidence), `${p} / ${it.name}：置信度只能是 high/low，实际 ${it.confidence}`);
      if (it.confidence === 'high') {
        assert.deepEqual(it.portionChoices, [], `${p} / ${it.name}：说得清楚就别给档位`);
        continue;
      }
      asked += 1;
      assert.ok(it.confidenceReason, `${p} / ${it.name}：低置信度要有一句人话解释`);
      assertChoicesSane(it, `${p} / ${it.name}`);
      const vals = gramsOf(it.portionChoices);
      // 「小碗 130 克」和「大碗 3 公斤」这种跨度她也没法选
      assert.ok(Math.max(...vals) / Math.min(...vals) <= 5, `${p} / ${it.name}：档位跨度太大 ${vals.join('/')}`);
    }
  }
  assert.ok(asked >= 8, `这组例句里该问的太少（只有 ${asked} 条），说明置信度判定退化了`);
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
