/**
 * 食物数据库与搜索测试
 *
 * 重点不是「有多少条」，而是：
 *  1) 每条数据自己说得通（热量和碳蛋脂折算对得上）；
 *  2) 自检函数真的能抓到错误数据（反向验证）；
 *  3) 中文搜索和「一碗/两个」这类写法能正确解析。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOODS, FOOD_CATEGORIES, checkFoodData, findFood, parseAmount, ALIASES, kcalOnlyFood, matchFoodByName, CATALOG_FOODS, genericEstimateFor } from '../js/foods.js';
import { calcEntry } from '../js/calc.js';
import { searchFoods, normalize } from '../js/foodlog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

test('食物数据自检通过（0 条问题）', () => {
  const problems = checkFoodData();
  assert.deepEqual(problems, [], `数据有问题：\n${problems.join('\n')}`);
});

test('食物条数与分类覆盖', () => {
  assert.ok(FOODS.length >= 100, `只有 ${FOODS.length} 条，太少了`);
  const used = new Set(FOODS.map((f) => f.category));
  for (const c of FOOD_CATEGORIES) {
    assert.ok(used.has(c.key), `分类「${c.label}」里一条食物都没有`);
  }
});

test('每条都有 id、名称、克数份量', () => {
  for (const f of FOODS) {
    assert.ok(f.id && f.name, `缺 id 或名称：${JSON.stringify(f)}`);
    assert.ok(f.servings.length > 0, `${f.name} 没有份量`);
    assert.ok(f.servings[0][1] > 0, `${f.name} 的份量克数不合理`);
  }
});

test('反向验证：把一条数据改坏，自检必须报错', () => {
  // 米饭每 100 克 116 kcal，却写成 800 kcal —— 折算差 6 倍，必须被抓出来
  const broken = FOODS.map((f) => (f.id === 'rice_cooked' ? { ...f, kcal: 800 } : f));
  const problems = checkFoodData(broken);
  assert.ok(problems.some((p) => p.includes('米饭（熟）')), `没抓到改坏的数据：${problems.join(' | ')}`);

  // 再试两种坏法：分类不存在、份量为 0
  const badCategory = FOODS.map((f) => (f.id === 'egg' ? { ...f, category: '不存在的分类' } : f));
  assert.ok(checkFoodData(badCategory).some((p) => p.includes('分类')));
  const badServing = FOODS.map((f) => (f.id === 'egg' ? { ...f, servings: [['一个', 0]] } : f));
  assert.ok(checkFoodData(badServing).some((p) => p.includes('份量')));
});

test('反向验证：源文件里真的存在这些数据条目（不是测试里另造一份）', () => {
  const src = fs.readFileSync(path.join(root, 'js', 'foods.js'), 'utf8');
  // 只数 FOODS 数组里那段：文件里还有 GENERIC_ESTIMATES（同类均值兜底）等带 id 的对象，
  // 数整份文件会把它们算进来（v31 就因此误报过一次）。
  const start = src.indexOf('export const FOODS = [');
  const end = src.indexOf('\n];', start);
  assert.ok(start > 0 && end > start, 'foods.js 里找不到 FOODS 数组');
  const inFile = (src.slice(start, end).match(/\{ id: '/g) || []).length;
  assert.equal(inFile, FOODS.length, `源文件里 ${inFile} 条，导入后有 ${FOODS.length} 条`);
  assert.ok(src.includes("id: 'rice_cooked'"));
});

test('生熟默认口径：普通叫法按熟重，说「生」才按生重', () => {
  // v30：肉/鱼/虾拆成「熟重」和「生重」两条。默认熟重 —— 普通人称/估的都是做熟后的重量。
  assert.equal(findFood('chicken_breast_cooked').kcal, 157);
  assert.equal(findFood('chicken_breast').kcal, 118, '生重那条保持原值');
  for (const [q, id] of [
    ['鸡胸肉', 'chicken_breast_cooked'], ['鸡胸', 'chicken_breast_cooked'],
    ['水煮鸡胸', 'chicken_breast_cooked'], ['煎鸡胸', 'chicken_breast_cooked'],
    ['牛肉', 'beef_lean_cooked'], ['猪瘦肉', 'pork_lean_cooked'],
    ['虾', 'shrimp_cooked'], ['三文鱼', 'salmon_cooked'],
  ]) {
    assert.equal(matchFoodByName(q)?.food.id, id, `「${q}」应当匹配熟重那条`);
  }
  for (const [q, id] of [
    ['生鸡胸肉', 'chicken_breast'], ['生鸡胸', 'chicken_breast'],
    ['生牛肉', 'beef_lean'], ['生虾', 'shrimp'], ['生三文鱼', 'salmon'],
  ]) {
    assert.equal(matchFoodByName(q)?.food.id, id, `「${q}」应当匹配生重那条`);
  }
});

test('搜索：鸡胸同时能找到生/熟两条，熟的排前面（默认选项）', () => {
  const ids = searchFoods('鸡胸').map((f) => f.id);
  assert.ok(ids.includes('chicken_breast_cooked'), '要有熟重那条');
  assert.ok(ids.includes('chicken_breast'), '也要有生重那条');
  assert.ok(ids.indexOf('chicken_breast_cooked') < ids.indexOf('chicken_breast'), '熟重应当排在前面');
});

test('每条数据的 id 唯一', () => {
  const ids = FOODS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, '有重复 id');
});

test('搜索：中文关键词能搜到', () => {
  assert.ok(searchFoods('鸡胸').some((f) => f.id === 'chicken_breast'));
  assert.ok(searchFoods('米饭').some((f) => f.id === 'rice_cooked'));
  assert.ok(searchFoods('鸡蛋').some((f) => f.id === 'egg'));
  assert.ok(searchFoods('西兰花').some((f) => f.id === 'broccoli'));
});

test('搜索：俗称也能搜到', () => {
  assert.ok(searchFoods('奶茶').some((f) => f.id === 'bubble_tea'));
  assert.ok(searchFoods('鸡胸').some((f) => f.id === 'chicken_breast'));
  assert.ok(searchFoods('地瓜').some((f) => f.id === 'sweet_potato'), '「地瓜」应该能搜到红薯');
  assert.ok(searchFoods('美式').some((f) => f.id === 'black_coffee'), '「美式」应该能搜到黑咖啡');
  assert.ok(searchFoods('酸奶').some((f) => f.id.startsWith('yogurt')));
});

test('搜索：大小写、空格、标点不影响结果', () => {
  assert.deepEqual(
    searchFoods(' 鸡胸 ').map((f) => f.id),
    searchFoods('鸡胸').map((f) => f.id),
  );
  assert.equal(normalize('（ 米饭 ）'), '米饭');
});

test('搜索：完全无关的词不会乱给结果', () => {
  const list = searchFoods('螺丝刀钻头');
  assert.equal(list.length, 0, `不该给出结果，却返回了：${list.map((f) => f.name).join('、')}`);
});

test('搜索：空关键词给出默认列表，且不报错', () => {
  assert.ok(searchFoods('').length > 0);
  assert.ok(searchFoods(null).length > 0);
});

test('搜索：自定义食物优先出现在结果里', () => {
  const custom = [{
    id: 'c_test', name: '用户自己的蛋白粉', category: 'custom',
    kcal: 380, protein: 80, fat: 5, carb: 6, servings: [['一勺', 30]],
  }];
  const list = searchFoods('蛋白粉', custom);
  assert.equal(list[0].id, 'c_test');
});

test('份量解析：「150克」「2个」「一小碗」「半斤」', () => {
  const rice = findFood('rice_cooked');
  const egg = findFood('egg');
  assert.equal(parseAmount('150克', rice), 150);
  assert.equal(parseAmount('150g', rice), 150);
  assert.equal(parseAmount('2个', egg), 100);
  assert.equal(parseAmount('一小碗', rice), 130);
  assert.equal(parseAmount('半斤', rice), 250);
  assert.equal(parseAmount('一两', rice), 50);
  assert.equal(parseAmount('200毫升', findFood('milk_whole')), 200);
  assert.equal(parseAmount('120', rice), 120);
});

test('份量解析：「一碗」不能被表里排在前面的「一小碗」抢走', () => {
  const rice = findFood('rice_cooked'); // 表：小碗 130 / 碗 180 / 大碗 250
  assert.equal(parseAmount('一碗', rice), 180);
  assert.equal(parseAmount('一碗饭', rice), 180);
  assert.equal(parseAmount('半碗', rice), 90);
  assert.equal(parseAmount('一大碗', rice), 250);
  assert.equal(parseAmount('两碗', rice), 360);
  // 「小碗」仍然要精确命中
  assert.equal(parseAmount('一小碗', rice), 130);
});

test('份量解析：看不懂的输入返回 null，而不是猜一个数', () => {
  assert.equal(parseAmount('随便吃了点', findFood('egg')), null);
  assert.equal(parseAmount('', findFood('egg')), null);
  assert.equal(parseAmount(null, findFood('egg')), null);
  assert.equal(parseAmount('0克', findFood('egg')), null);
  assert.equal(parseAmount('-50克', findFood('egg')), null);
});

test('找不到的食物返回 null', () => {
  assert.equal(findFood('不存在的食物'), null);
  assert.equal(findFood('rice_cooked').name, '米饭（熟）');
});

test('别名表指向的 id 都必须真实存在', () => {
  for (const key of Object.keys(ALIASES)) {
    assert.ok(findFood(key), `别名表里的 ${key} 在食物库里不存在`);
  }
});

test('只填热量：正常输入、名称兜底，以及「100 克」这个内部表示', () => {
  const r = kcalOnlyFood({ name: '楼下的牛肉面', kcal: '650', protein: '30' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.food.name, '楼下的牛肉面');
  assert.equal(r.food.kcal, 650);
  assert.equal(r.food.kcalOnly, true, '必须打标记，界面上才不显示「100 克」');
  // 克数固定 100：每 100 克就是这一顿，汇总时算出来正好 650
  const f = calcEntry(r.food, 100);
  assert.equal(f.kcal, 650);
  assert.equal(f.protein, 30);

  // 不写名字也要能用（用户经常懒得写）
  assert.equal(kcalOnlyFood({ kcal: 500 }).food.name, '只记了热量');
  // 蛋白不填按 0，不能变成 NaN 把全天合计弄坏
  const noP = kcalOnlyFood({ kcal: 500, protein: '' });
  assert.equal(noP.food.protein, 0);
  assert.ok(Number.isFinite(calcEntry(noP.food, 100).kcal));
});

test('只填热量：离谱数字要挡住，不能悄悄记进去', () => {
  for (const bad of [0, -5, '', null, undefined, 'abc', NaN]) {
    assert.equal(kcalOnlyFood({ kcal: bad }).ok, false, `热量 ${String(bad)} 不该通过`);
  }
  assert.equal(kcalOnlyFood({ kcal: 5001 }).ok, false, '一次超过 5000 kcal 要让人确认');
  assert.equal(kcalOnlyFood({ kcal: 600, protein: -1 }).ok, false, '蛋白不能是负数');
  assert.equal(kcalOnlyFood({ kcal: 600, protein: 301 }).ok, false, '蛋白 300 克以上不合理');
  // 蛋白自己就有 4 kcal/克：说 20 克蛋白却只有 50 kcal，是填错了
  assert.equal(kcalOnlyFood({ kcal: 50, protein: 20 }).ok, false, '蛋白热量超过总热量要拦住');
  // 边界值应当通过
  assert.equal(kcalOnlyFood({ kcal: 5000 }).ok, true);
  assert.equal(kcalOnlyFood({ kcal: 50, protein: 12 }).ok, true, '50 kcal / 12 克蛋白（48 kcal）是合理的边缘');
});

test('v31 补的常见菜真的在库里，而且 4/9/4 对得上', () => {
  // 起因：AI 听懂了「黄焖鸡米饭」「馄饨」「酸菜鱼」，本地库里没有 → 一条都记不上。
  for (const [name, kcal] of [
    ['酸菜鱼', 110], ['肉夹馍', 290], ['小笼包', 230], ['烤冷面', 210],
    ['皮蛋瘦肉粥', 60], ['薯条', 312], ['混合坚果', 600],
  ]) {
    const f = FOODS.find((x) => x.name === name);
    assert.ok(f, `食物库里没有「${name}」`);
    assert.equal(f.kcal, kcal, `${name} 热量应为 ${kcal}`);
    assert.ok(f.servings.length > 0, `${name} 没给份量`);
  }
  assert.ok(FOODS.length >= 160, `食物条数 ${FOODS.length}，低于预期`);
});

test('组合菜（一整顿）也能被名字匹配到，不再只认食材表', () => {
  // 以前这些只在 mealparse 的组合菜表里：AI 说出名字 → matchFoodByName 找不到 → 记不上
  for (const [q, id] of [
    ['黄焖鸡米饭', 'huangmenji'], ['馄饨', 'wonton_meal'], ['烧烤', 'bbq_meal'],
    ['盖饭', 'set_rice'], ['三明治', 'sandwich'], ['食堂打饭', 'canteen_rice'],
  ]) {
    assert.equal(matchFoodByName(q)?.food.id, id, `「${q}」应当匹配到组合菜 ${id}`);
  }
  // 组合菜要算进「可匹配目录」，不然刚修好的又白修
  assert.ok(CATALOG_FOODS.some((f) => f.id === 'huangmenji'));
  assert.ok(CATALOG_FOODS.some((f) => f.id === 'chicken_breast_cooked'), '食材也要在');
});

test('常见菜的口语别名：番茄炒蛋、宫爆鸡丁、泡面这些说法也要认', () => {
  assert.equal(matchFoodByName('番茄炒蛋')?.food.id, 'tomato_egg');
  assert.equal(matchFoodByName('西红柿炒蛋')?.food.id, 'tomato_egg');
  assert.equal(matchFoodByName('宫爆鸡丁')?.food.id, 'gongbao');
  assert.equal(matchFoodByName('薯条')?.food.id, 'fries', '薯条不能被认成薯片（热量差一倍）');
  assert.equal(matchFoodByName('杏仁')?.food.id, 'almond');
  assert.equal(matchFoodByName('坚果')?.food.id, 'mixed_nuts');
  assert.equal(matchFoodByName('豆浆')?.food.id, 'soy_milk');
  assert.equal(matchFoodByName('糖')?.food.id, 'sugar');
});

test('搜食物也能搜到组合菜（以前「馄饨」搜不出来）', () => {
  assert.ok(searchFoods('馄饨').some((f) => f.id === 'wonton_meal'));
  assert.ok(searchFoods('黄焖鸡').some((f) => f.id === 'huangmenji'));
  assert.ok(searchFoods('酸菜鱼').some((f) => f.id === 'suancaiyu'));
});

test('库里真没有的名字：按同类均值兜底，类别不能归错', () => {
  assert.equal(genericEstimateFor('外婆家秘制扣肉').id, 'generic_meat');
  assert.equal(genericEstimateFor('提拉米苏').id, 'generic_dessert');
  assert.equal(genericEstimateFor('椰子水').id, 'generic_drink');
  assert.equal(genericEstimateFor('混合坚果').id, 'generic_snack');
  assert.equal(genericEstimateFor('皮蛋瘦肉粥').id, 'generic_staple', '粥是主食，不能被「肉」抢走');
  assert.equal(genericEstimateFor('完全不认识的啥').id, 'generic_dish');
  // 数值本身要过 4/9/4 折算自检
  for (const g of ['generic_meat', 'generic_staple', 'generic_dessert', 'generic_drink']) {
    const f = genericEstimateFor({ generic_meat: '肉', generic_staple: '饭', generic_dessert: '蛋糕', generic_drink: '茶' }[g]);
    assert.equal(f.id, g);
    const drift = Math.abs((f.protein * 4 + f.fat * 9 + f.carb * 4) - f.kcal) / f.kcal;
    assert.ok(drift < 0.1, `${g} 的 4/9/4 折算差 ${Math.round(drift * 100)}%`);
  }
});
