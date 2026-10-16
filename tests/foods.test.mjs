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
import { FOODS, FOOD_CATEGORIES, checkFoodData, findFood, parseAmount, ALIASES } from '../js/foods.js';
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
  const inFile = (src.match(/\{ id: '/g) || []).length;
  assert.equal(inFile, FOODS.length, `源文件里 ${inFile} 条，导入后有 ${FOODS.length} 条`);
  assert.ok(src.includes("id: 'rice_cooked'"));
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
    id: 'c_test', name: '她自己的蛋白粉', category: 'custom',
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
