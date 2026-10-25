/**
 * 离线解析的「份量置信度」测试
 *
 * 要守住的产品行为（issue #2）：用户说得清楚就别打扰用户；说不清楚（「一碗」「一份」、
 * 干脆没说）就必须反问一句，并且给出几个按食物类型给的档位，让用户一点就选。
 * 这里同时钉住「不许悄悄改克数」—— 加置信度只是多问一句，不能顺手把估算值改掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDescription, buildPortionChoices, portionKindOf, normalizeAiItems } from '../js/mealparse.js';
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
  assert.equal(new Set(labels).size, labels.length, `${label}：两个按钮说法一样，用户不知道选哪个 → ${labels.join('/')}`);
}

test('用户说了确切克数 → 高置信度，不该再问', () => {
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

test('组合菜「一碗牛肉面」→ 一定反问用户（这是误差最大的地方）', () => {
  const noodle = item('今天中午在食堂吃了碗牛肉面', '牛肉面');
  assert.equal(noodle.confidence, 'low');
  assert.equal(noodle.source, 'dish');
  assertChoicesSane(noodle, '牛肉面');
  assert.equal(noodle.grams, 600, '加的是「问一句」，不是把克数改小');
  assert.deepEqual(noodle.portionChoices.map((c) => c.label), ['小碗', '正常', '大碗'],
    '一碗面要按碗问，不是按「份」');
});

test('组合菜只要用户说了克数，就别再问（说得清楚就不打扰）', () => {
  const noodle = item('中午吃了600克牛肉面', '牛肉面');
  assert.equal(noodle.confidence, 'high', '明说了 600 克还要问，就成了烦用户');
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

test('用户什么份量都没说 → 低置信度，理由要说明是按常见的一份记的', () => {
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

test('「加饭」「加肉」这种加多少全看用户手的，要问；「加蛋」是一颗标准大小，不问', () => {
  const rice = item('牛肉面加饭', '加米饭');
  assert.equal(rice.confidence, 'low');
  assertChoicesSane(rice, '加饭');

  const meat = item('牛肉面加肉', '加瘦'); // 加肉默认按「瘦牛肉（熟重）」算
  assert.equal(meat.confidence, 'low');
  assertChoicesSane(meat, '加肉');

  const egg = item('牛肉面加蛋', '鸡蛋');
  assert.equal(egg.confidence, 'high', '一颗蛋是标准大小，不该拿这种问题烦用户');
  assert.deepEqual(egg.portionChoices, []);
});

test('生熟口径：说「生鸡胸肉」按生重，其余默认熟重（离线解析也一样）', () => {
  const cooked = item('中午吃了150克鸡胸肉', '鸡胸肉');
  assert.equal(cooked.foodId, 'chicken_breast_cooked', '默认应当是熟重那条');
  assert.equal(cooked.grams, 150);
  assert.equal(cooked.kcal, 236, '150 克 × 157/100');

  const raw = item('中午吃了150克生鸡胸肉', '生鸡胸肉');
  assert.equal(raw.foodId, 'chicken_breast', '带「生」要落到生重那条');
  assert.equal(raw.kcal, 177, '150 克 × 118/100');

  const boiled = item('水煮鸡胸100克', '鸡胸');
  assert.equal(boiled.foodId, 'chicken_breast_cooked');
  assert.equal(boiled.kcal, 157, '熟重数据已经包含做法，不能再按「水煮」乘油量');
});

test('口语里不带「一」的份量词也要认（喝了瓶 → 就是「瓶」）', () => {
  // 用户说「喝了瓶运动饮料」时，「瓶」是有固定规格的 —— 不该退化成「你没说多少」再问一遍。
  // 以前有人把「裸量词」这条逻辑删掉，其它断言全过（因为都落在别的字段上），实测才发现漏了。
  const drink = item('喝了瓶运动饮料', '运动饮料');
  assert.equal(drink.confidence, 'high', '「瓶」有固定规格，不该再问用户');
  assert.equal(drink.grams, 500);
  assert.equal(drink.confidenceReason, null);

  // 「食堂吃了碗牛肉面」：碗确实说不准，但理由必须落在「碗」上，而不是「没说量」。
  const noodle = item('食堂吃了碗牛肉面', '牛肉面');
  assert.equal(noodle.confidence, 'low');
  assert.ok(noodle.confidenceReason.includes('碗'), `理由要落在「碗」上：${noodle.confidenceReason}`);
  assert.ok(!/你没说/.test(noodle.confidenceReason), `用户明明说了「碗」：${noodle.confidenceReason}`);
});

test('组合菜不能抢走「一杯奶茶」这种明显给饮料的份量（issue #3）', () => {
  // 「吃完火锅又喝了杯奶茶」里，火锅和奶茶都可能去抢「杯」。
  // 以前组合菜会把「杯」抢走：火锅的理由变成「『杯』没有固定规格」、追问也变成问锅底。
  const r = parseDescription('吃完火锅又喝了杯奶茶');
  const firepot = r.items.find((i) => i.name.includes('火锅'));
  const tea = r.items.find((i) => i.name.includes('奶茶'));
  assert.ok(firepot && tea, '火锅和奶茶都要在');
  assert.ok(!firepot.confidenceReason.includes('杯'), `火锅的理由不该是「杯」：${firepot.confidenceReason}`);
  assert.ok(firepot.question.includes('多大'), `火锅该问份量大小，实际问的是：${firepot.question}`);
  assert.ok(tea.confidenceReason.includes('杯'), `奶茶才该拿「杯」，实际：${tea.confidenceReason}`);
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
      // 「小碗 130 克」和「大碗 3 公斤」这种跨度用户也没法选
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

test('组合菜不会抢走后面食材的份量（issue #3）', () => {
  // 「红烧肉配了一碗米饭」：一碗是米饭的，红烧肉按自己的一份算。
  // 以前红烧肉会把「一碗」抢走（350 克红烧肉 1330 kcal），米饭只剩「小碗 130 克」。
  const r = parseDescription('晚饭红烧肉配了一碗米饭，还有炒青菜');
  const rice = r.items.find((i) => i.name.includes('米饭'));
  const pork = r.items.find((i) => i.name.includes('红烧肉'));
  assert.ok(rice && pork, '米饭和红烧肉都要在');
  assert.equal(rice.grams, 180, `一碗米饭应当是 180 克，实际 ${rice.grams}`);
  assert.equal(pork.grams, 150, `红烧肉该按库里的一份 150 克算，实际 ${pork.grams} 克`);
});

test('组合菜「一碗」= 一份，不是通用碗重 350 克', () => {
  // 同一个意思的两种说法不能差出 200 kcal：以前「吃了碗牛肉面」=600 克、「一碗牛肉面」=350 克
  const a = item('中午吃了一碗牛肉面', '牛肉面');
  const b = item('中午吃了碗牛肉面', '牛肉面');
  assert.equal(a.grams, b.grams, `两种说法必须一致：${a.grams} 克 vs ${b.grams} 克`);
  assert.ok(a.grams >= 500, `一碗牛肉面至少 500 克，实际 ${a.grams}`);
});

test('v31：食物别名进了离线词典（以前只有搜索和 AI 能用，离线看不见）', () => {
  // 这些说法以前离线整句认不出来：AI 没开 / AI 没接上时，用户只能重说
  const cases = [
    ['一杯酸奶', '无糖酸奶', 150],
    ['半斤牛奶', '全脂牛奶', 250],
    ['一块蛋糕', '奶油蛋糕', 100],
    ['两碗粥', '白粥', 500],
    ['一根香蕉', '香蕉', 120],
    ['一小把杏仁', '巴旦木/杏仁', 25],
    ['吃了一颗糖', '白砂糖', 8],
    ['两片吐司', '白吐司', 70],
  ];
  for (const [text, name, grams] of cases) {
    const r = parseDescription(text);
    const it = r.items.find((x) => x.name === name);
    assert.ok(it, `「${text}」里没解析出「${name}」，实际：${r.items.map((x) => x.name).join('/')}`);
    assert.equal(it.grams, grams, `「${text}」的克数不对`);
  }
});

test('v31：一句话里几样东西都要记上（不能再只记第一样）', () => {
  const r = parseDescription('早上喝了杯豆浆，吃了个鸡蛋灌饼');
  assert.deepEqual(r.items.map((x) => x.name), ['无糖豆浆', '鸡蛋灌饼']);
  assert.equal(r.items[0].grams, 300);
  assert.equal(r.items[1].grams, 200);

  const r2 = parseDescription('喝了杯橙汁，吃了块鸡排');
  assert.equal(r2.items.length, 2);
});

test('v31：单字词只在水词是「买的东西」时才算食物（晚饭≠一碗饭）', () => {
  // 「晚饭吃了一碗米饭」以前会记出两条米饭（晚饭的「饭」+ 米饭），热量凭空多一倍
  const r = parseDescription('晚饭吃了一碗米饭，一份宫保鸡丁，一杯酸奶');
  const rice = r.items.filter((x) => x.name === '米饭（熟）');
  assert.equal(rice.length, 1, `米饭被记了 ${rice.length} 次：${r.items.map((x) => x.name)}`);
  assert.equal(rice[0].grams, 180);
});

test('v31：食堂打饭 + 三样具体菜时，不能一顿算成两顿', () => {
  const r = parseDescription('食堂打了三个菜：土豆丝、青椒肉丝、炒青菜');
  assert.ok(!r.items.some((x) => x.name.includes('食堂打饭')), '有具体菜时不该再用泛称套餐兜底');
  for (const name of ['炒土豆丝', '青椒肉丝', '炒青菜（家常油量）']) {
    assert.ok(r.items.some((x) => x.name === name), `少了「${name}」：${r.items.map((x) => x.name)}`);
  }
});

test('v31：AI 说组合菜的名字也要能对上本地库', () => {
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

test('v31：AI 只给「一碗」这种说法、或者干脆没给份量，也不能丢', () => {
  const r = normalizeAiItems({
    items: [
      { name: '馄饨', portion: '一碗' },
      { name: '酸菜鱼', portion: '一碗' },
      { name: '寿司' },
    ],
  });
  assert.deepEqual(r.items.map((x) => x.grams), [300, 500, 25], '一碗馄饨=一份 300，一碗酸菜鱼=500，寿司默认一贯 25');
});
