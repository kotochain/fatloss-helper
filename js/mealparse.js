/**
 * 把「今天在食堂吃了碗牛肉面」这类大白话，拆成可确认的食物条目。
 *
 * 这里做两件事：
 *  1) 离线解析（parseDescription）：靠关键词匹配 + 份量推断，把她说的东西拆成几项。
 *     解析不了的会标成「需要确认」，界面负责反问她。
 *  2) 整理 AI 返回的结果（normalizeAiItems）：AI 负责听懂，但热量一律由本地数据算，
 *     不让模型自己编数字 —— 那样就没法核对，也没法离线复算。
 *
 * 统一的中间结果叫「条目（item）」：
 *   { name, grams, kcal, protein, fat, carb, confidence, needsConfirm, question, source }
 */

import { FOODS, findFood, parseAmount } from './foods.js';

/** 单份默认克数：她没说份量时按「正常一份」估，而不是统一 100 克 */
export const FOOD_DEFAULT_GRAMS = {
  egg: 50, duck_egg: 70, apple: 200, banana: 120, orange: 180, pear: 200, peach: 150,
  kiwi: 100, mango: 200, watermelon: 300, strawberry: 150, blueberry: 100, grape: 150,
  bun: 100, baozi_pork: 100, bread_white: 35, bread_whole: 40, dumpling_pork: 200,
  milk_whole: 250, milk_skim: 250, yogurt_plain: 150, yogurt_sweet: 150, greek_yogurt: 150,
  soy_milk: 300, latte: 350, black_coffee: 250, cola: 330, beer: 330, juice_orange: 250,
  bubble_tea: 500, sports_drink: 500, chips: 50, cookie: 24, chocolate: 40, icecream: 60,
  cake_cream: 100, protein_bar: 40, cheese_slice: 20, avocado: 75, peanut: 25, walnut: 20,
  almond: 25, cashew: 25, peanut_butter: 15, sesame_paste: 15, sugar: 8, oil: 10,
  tomato: 150, cucumber: 200, carrot: 120, corn: 200, sweet_potato: 150, potato: 150,
  broccoli: 150, spinach: 150, bokchoy: 150, cabbage: 150, chinese_cabbage: 200,
  eggplant: 150, bell_pepper: 100, mushroom: 100, enoki: 100, seaweed: 100, winter_melon: 200,
  bitter_melon: 150, lettuce: 100, edamame: 100, dried_tofu: 50, tofu_firm: 100, tofu_silken: 100,
  chicken_breast: 150, chicken_thigh: 100, chicken_wing: 50, pork_lean: 100, beef_lean: 100,
  shrimp: 100, salmon: 120, white_fish: 150, tuna_can: 120, oats: 40, milk: 250,
};

/** 组合菜按「个」计时每个多少克（包子 100、饺子 20 之类） */
const DISH_PER_UNIT = { baozi_pork: 100, dumpling_meal: 20, burger_meal: 250 };

/** 常见份量的克数：写「一碗」时按这个算，界面会让用户确认/改 */
export const PORTIONS = {
  '一小碗': 200, '一碗': 350, '大碗': 500, '超大碗': 650,
  '一份': 200, '一盘': 250, '一盒': 250, '一袋': 100, '一包': 80,
  '一杯': 300, '一瓶': 500, '一罐': 330,
  '一个': 100, '一块': 100, '一串': 80, '一勺': 15, '一筷子': 20,
};

/** 份量疑问的选项，界面直接拿它渲染按钮 */
export const PORTION_CHOICES = [
  { label: '小碗（约 200 克）', value: '一小碗', grams: 200 },
  { label: '普通碗（约 350 克）', value: '一碗', grams: 350 },
  { label: '大碗（约 500 克）', value: '大碗', grams: 500 },
  { label: '超大碗（约 650 克）', value: '超大碗', grams: 650 },
];

/**
 * 组合菜品：她说的是一整份菜（不是单一食材）时用这些。
 * 数值是「一份 = baseGrams 克」的参考值（家常做法估算，误差较大，靠界面确认）。
 */
export const DISHES = [
  // 面食类
  { id: 'beef_noodle', name: '牛肉面', baseGrams: 600, kcal: 630, protein: 33, fat: 16, carb: 81, aliases: ['牛肉面', '牛腩面', '拉面', '兰州拉面'], ask: '有没有加蛋或加肉？' },
  { id: 'pork_noodle', name: '猪肉/大肉面', baseGrams: 600, kcal: 700, protein: 28, fat: 28, carb: 80, aliases: ['大肉面', '排骨面', '猪肝面', '肉丝面'] },
  { id: 'noodle_soup_plain', name: '面条 / 汤面', baseGrams: 500, kcal: 420, protein: 15, fat: 10, carb: 68, aliases: ['清汤面', '阳春面', '素面', '光面', '面条', '汤面', '面'], ask: '是素面还是有浇头（牛肉/大肉/鸡蛋）？' },
  { id: 'noodle_fried', name: '炒面 / 拌面', baseGrams: 400, kcal: 620, protein: 18, fat: 24, carb: 82, aliases: ['炒面', '拌面', '热干面', '油泼面', '炸酱面'] },
  { id: 'rice_noodle_soup', name: '米粉 / 米线 / 螺蛳粉', baseGrams: 600, kcal: 550, protein: 18, fat: 18, carb: 78, aliases: ['米粉', '米线', '螺蛳粉', '桂林米粉', '过桥米线', '酸辣粉'] },
  { id: 'instant_noodle', name: '方便面（含调料）', baseGrams: 500, kcal: 480, protein: 10, fat: 20, carb: 65, aliases: ['方便面', '泡面', '桶面', '泡面加蛋'] },
  // 饭类
  { id: 'set_rice', name: '盖饭 / 快餐套餐', baseGrams: 500, kcal: 700, protein: 28, fat: 24, carb: 90, aliases: ['盖饭', '盖浇饭', '快餐', '套餐', '便当', '盒饭', '煲仔饭'], generic: true, ask: '主菜是什么？米饭吃完了吗？' },
  { id: 'huangmenji', name: '黄焖鸡米饭', baseGrams: 550, kcal: 780, protein: 35, fat: 30, carb: 92, aliases: ['黄焖鸡', '黄焖鸡米饭'] },
  { id: 'fried_rice_dish', name: '炒饭', baseGrams: 350, kcal: 570, protein: 15, fat: 19, carb: 81, aliases: ['炒饭', '蛋炒饭', '扬州炒饭'] },
  { id: 'canteen_rice', name: '食堂打饭（两菜一饭）', baseGrams: 550, kcal: 650, protein: 25, fat: 22, carb: 85, aliases: ['食堂打饭', '打饭', '两个菜', '三菜一汤', '一份饭', '食堂'], generic: true, ask: '打了几个菜？有肉吗？' },
  // 其他常见
  { id: 'dumpling_meal', name: '饺子（一顿）', baseGrams: 300, kcal: 660, protein: 27, fat: 24, carb: 84, aliases: ['饺子', '水饺', '锅贴'] },
  { id: 'wonton_meal', name: '馄饨 / 云吞（一碗）', baseGrams: 300, kcal: 330, protein: 15, fat: 11, carb: 42, aliases: ['馄饨', '云吞', '抄手'] },
  { id: 'malatang_meal', name: '麻辣烫 / 冒菜（不喝汤）', baseGrams: 500, kcal: 650, protein: 30, fat: 38, carb: 45, aliases: ['麻辣烫', '冒菜', '串串'], ask: '有加芝麻酱或辣油吗？主食加了粉丝还是方便面？' },
  { id: 'hotpot_meal', name: '火锅（一顿）', baseGrams: 600, kcal: 900, protein: 45, fat: 60, carb: 40, aliases: ['火锅', '涮锅', '涮羊肉'], ask: '锅底是清汤还是红油？蘸料用麻酱还是油碟？' },
  { id: 'bbq_meal', name: '烧烤（一顿）', baseGrams: 400, kcal: 850, protein: 40, fat: 60, carb: 30, aliases: ['烧烤', '烤串', '烤肉'], ask: '喝酒了吗？主食吃了吗？' },
  { id: 'burger_meal', name: '汉堡套餐', baseGrams: 500, kcal: 900, protein: 30, fat: 40, carb: 105, aliases: ['汉堡', '麦当劳', '肯德基', '炸鸡', '薯条'] },
  { id: 'sandwich', name: '三明治 / 轻食沙拉碗', baseGrams: 300, kcal: 380, protein: 22, fat: 14, carb: 42, aliases: ['三明治', '轻食', '沙拉碗', '沙拉', '帕尼尼'], ask: '酱料放了吗？（沙拉酱热量很高）' },
  { id: 'porridge_meal', name: '粥+小菜/包子早餐', baseGrams: 400, kcal: 350, protein: 13, fat: 8, carb: 58, aliases: ['早餐', '粥', '包子', '豆浆油条', '煎饼'] },
  { id: 'yogurt_meal', name: '酸奶+水果', baseGrams: 300, kcal: 250, protein: 10, fat: 6, carb: 38, aliases: ['酸奶水果', '水果捞'] },
];

/** 常见配料/加料：识别出来就往上加 */
const EXTRA_INGREDIENTS = [
  { key: 'egg', aliases: ['加蛋', '加个蛋', '卤蛋', '鸡蛋', '煎蛋', '荷包蛋', '蛋'], foodId: 'egg', defaultGrams: 50 },
  { key: 'beef_extra', aliases: ['加肉', '加牛肉', '加份肉', '肉多'], foodId: 'beef_lean', defaultGrams: 60 },
  { key: 'pork_extra', aliases: ['加猪排', '加大排', '加排骨'], foodId: 'pork_lean', defaultGrams: 80 },
  { key: 'tofu_extra', aliases: ['加豆腐', '豆腐'], foodId: 'tofu_firm', defaultGrams: 100 },
  { key: 'veg_extra', aliases: ['加青菜', '青菜', '加菜', '蔬菜', '小白菜', '生菜'], foodId: 'bokchoy', defaultGrams: 150 },
  { key: 'rice_extra', aliases: ['加饭', '加米饭', '多饭'], foodId: 'rice_cooked', defaultGrams: 150 },
  { key: 'noodle_extra', aliases: ['加面'], foodId: 'noodle_cooked', defaultGrams: 150 },
  { key: 'chili_oil', aliases: ['辣油', '红油', '辣椒油'], foodId: 'oil', defaultGrams: 10, warn: '辣油其实是纯油，一勺约 10 克 = 90 kcal' },
  { key: 'sesame', aliases: ['麻酱', '芝麻酱'], foodId: 'sesame_paste', defaultGrams: 15 },
  { key: 'mayo', aliases: ['沙拉酱', '蛋黄酱', '千岛酱'], foodId: 'salad_dressing', defaultGrams: 15 },
  { key: 'cheese', aliases: ['芝士', '奶酪', '起司'], foodId: 'cheese_slice', defaultGrams: 20 },
  { key: 'milk_tea', aliases: ['奶茶', '饮料', '可乐', '汽水', '果汁'], foodId: 'bubble_tea', defaultGrams: 500, warn: '含糖饮料是减脂期最容易忽略的热量来源' },
  { key: 'beer_extra', aliases: ['啤酒', '喝酒', '一瓶酒'], foodId: 'beer', defaultGrams: 330 },
  { key: 'sugar', aliases: ['加糖', '多糖', '全糖'], foodId: 'sugar', defaultGrams: 10 },
];

/** 做法关键词：影响用油量，用来给「需要确认」的条目调整估算 */
const COOKING_STYLE = [
  { key: 'fried', aliases: ['炸', '油炸', '酥'], oilFactor: 1.8, note: '油炸做法，热量比清炒高很多' },
  { key: 'stirfried', aliases: ['炒', '干煸', '爆炒'], oilFactor: 1.25, note: '炒菜用油按家常量估的' },
  { key: 'braised', aliases: ['红烧', '烧', '焖', '卤'], oilFactor: 1.3, note: '红烧/卤味通常含糖和油' },
  { key: 'steamed', aliases: ['蒸', '煮', '清蒸', '水煮', '汆'], oilFactor: 0.8, note: '蒸煮做法用油少' },
  { key: 'grilled', aliases: ['烤', '煎', '空气炸'], oilFactor: 1.1, note: '煎烤用油中等' },
  { key: 'soup', aliases: ['汤', '汤面', '砂锅'], oilFactor: 1.0, note: '汤类注意别喝油汤' },
];

const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const CN_GRAMS = { 半: 0.5 };
const MEAL_KEYWORDS = [
  { key: 'breakfast', words: ['早饭', '早餐', '早上'] },
  { key: 'lunch', words: ['午饭', '午餐', '中午'] },
  { key: 'dinner', words: ['晚饭', '晚餐', '晚上'] },
  { key: 'snack', words: ['加餐', '下午茶', '夜宵', '零食'] },
];

function mealFromText(text, fallback = null) {
  for (const m of MEAL_KEYWORDS) {
    if (m.words.some((w) => text.includes(w))) return m.key;
  }
  return fallback;
}

/** 全部可搜索的名字：食材 + 组合菜（长的优先，避免「面」抢走「牛肉面」） */
export function buildDictionary() {
  const dict = [];
  for (const d of DISHES) {
    for (const a of d.aliases) {
      // 泛称组合词（「包子早餐」这种）不进字典：否则「两个包子」会被它整段抢走，
      // 份量和热量都会跟着错。它们只在没有更具体匹配时才作为兜底。
      if (a.length > 3 && /早餐|套餐|一顿|打饭/.test(a)) continue;
      dict.push({ text: a, kind: 'dish', ref: d });
    }
    if (!d.aliases.includes(d.name)) dict.push({ text: d.name, kind: 'dish', ref: d });
  }
  for (const f of FOODS) {
    dict.push({ text: f.name.replace(/[（(].*?[)）]/g, ''), kind: 'food', ref: f });
    if (f.name.length > 2) dict.push({ text: f.name, kind: 'food', ref: f });
  }
  for (const e of EXTRA_INGREDIENTS) {
    for (const a of e.aliases) dict.push({ text: a, kind: 'extra', ref: e });
  }
  // 长的先匹配
  dict.sort((a, b) => b.text.length - a.text.length);
  return dict;
}

const DICTIONARY = buildDictionary();

/**
 * 在文本里找关键词。按「长词优先 + 不重叠」贪心匹配，
 * 所以「牛肉面」不会被拆成「食堂」+「面」这种莫名其妙的组合。
 */
function findHits(text) {
  const taken = new Array(text.length).fill(false);
  const hits = [];
  for (const entry of DICTIONARY) {
    if (!entry.text || entry.text.length < 2) continue;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(entry.text, from);
      if (idx < 0) break;
      const free = taken.slice(idx, idx + entry.text.length).every((x) => !x);
      if (free) {
        for (let i = idx; i < idx + entry.text.length; i++) taken[i] = true;
        hits.push({ ...entry, index: idx });
      }
      from = idx + entry.text.length;
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * 找一段文字里的份量说法（支持中文数字：一碗 / 两个 / 半斤 / 一两 / 200毫升）。
 * @returns {{grams:number, text:string, portionWord?:string, counting?:boolean, count?:number}|null}
 */
export function findPortion(text) {
  const numMatch = String(text || '').match(
    /([0-9]+(?:\.[0-9]+)?|[一二两三四五六七八九十半])\s*(超大碗|小碗|大碗|碗|份|盘|盒|袋|包|杯|瓶|罐|个|块|串|勺|筷子|克|g|毫升|ml|斤|两)/i,
  );
  if (!numMatch) return null;
  const numText = numMatch[1];
  const unit = numMatch[2];
  const full = numMatch[0];
  const qty = /^[0-9.]+$/.test(numText) ? Number(numText) : (CN_NUM[numText] ?? CN_GRAMS[numText] ?? 1);
  if (!(qty > 0)) return null;

  if (/斤/.test(unit)) return { grams: Math.round(qty * 500), text: full, counting: false };
  if (unit === '两') return { grams: Math.round(qty * 50), text: full, counting: false };
  if (/毫升|ml/i.test(unit)) return { grams: Math.round(qty), text: full, counting: false };
  if (/克|g/i.test(unit)) return { grams: Math.round(qty), text: full, counting: false };
  // 「一个」「两个」是个数；换算要按具体食物的标准份量，这里先记下来
  if (unit === '个' || unit === '块' || unit === '串') {
    const perUnit = PORTIONS[`一${unit}`] || 100;
    return { grams: Math.round(qty * perUnit), text: full, portionWord: `一${unit}`, counting: true, count: qty, perUnit };
  }
  // 碗类：区分大小
  const bowlKey = unit === '小碗' ? '一小碗' : unit === '碗' ? '一碗' : unit === '大碗' ? '大碗' : unit === '超大碗' ? '超大碗' : null;
  if (bowlKey) {
    // 「两碗」这种要说清是几碗，换算时按食物的份量表乘个数
    return { grams: Math.round(qty * PORTIONS[bowlKey]), text: full, portionWord: bowlKey, counting: false, count: qty, unitKey: bowlKey };
  }
  if (['包', '袋', '盒', '杯', '瓶', '罐', '份', '盘'].includes(unit)) {
    // 这些要按具体食物的包装来算（半包薯片 45 克 ≠ 半杯奶茶 250 克），
    // 这里只带出「几份」和单位，克数交给 gramsForPortion 按食物换算
    return { grams: null, text: full, portionWord: `一${unit}`, counting: false, count: qty, unitKey: `一${unit}` };
  }
  if (PORTIONS[`一${unit}`]) return { grams: Math.round(qty * PORTIONS[`一${unit}`]), text: full, portionWord: `一${unit}`, counting: false };
  if (PORTIONS[unit]) return { grams: Math.round(qty * PORTIONS[unit]), text: full, portionWord: unit, counting: false };
  return null;
}

/** 所有份量说法的位置 */
export function findAllPortions(text) {
  const re = /([0-9]+(?:\.[0-9]+)?|[一二两三四五六七八九十半])\s*(超大碗|小碗|大碗|碗|份|盘|盒|袋|包|杯|瓶|罐|个|块|串|勺|筷子|克|g|毫升|ml|斤|两)/gi;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const one = findPortion(m[0]);
    if (one) out.push({ ...one, index: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * 把每个食物配上「离它最近的那次份量说法」。
 *
 * 两个必须守住的规则（否则份量会离谱）：
 *  1) 不能拿整句话里唯一的份量去套所有食物
 *     （「一杯奶茶和半包薯片」里 325 克是奶茶的，不能套给薯片）；
 *  2) 匹配要有距离窗口，且「一碗」「一份」里的「一」不算个数
 *     （「一碗白粥和两个鸡蛋」不能变成白粥 1300 克）。
 */
const PAIR_WINDOW = 8;

export function pairPortions(text, foodHits) {
  const portions = findAllPortions(text);
  const used = new Set();
  const pairs = [];
  for (const hit of foodHits) {
    // 在窗口内找最近的份量。必须「按距离取最近」而不是「先看后面再看前面」，
    // 否则「两个鸡蛋和一个苹果」里鸡蛋会去抢后面那个「一个」（就变成 1 个蛋了）。
    const cands = portions
      .filter((p) => !used.has(p.index))
      .map((p) => ({ p, dist: Math.min(Math.abs(p.index - hit.index), Math.abs(hit.index - p.end)) }))
      .filter((x) => x.dist <= PAIR_WINDOW)
      .sort((a, b) => a.dist - b.dist);
    // 同距离时优先「紧挨着前面」的那个（「两个鸡蛋」而不是后面别的东西的份量）
    const found = cands[0]?.p || null;
    if (found) used.add(found.index);
    pairs.push({ hit, portion: found || null, counting: Boolean(found?.counting) });
  }
  return pairs;
}

/**
 * 找做法关键词（炒、炸、红烧…），用来给生鲜食材调整用油量。
 * 只看「没有被菜名/食物名覆盖」的文字，否则「红烧肉」「烧烤」会被当成烹饪方式。
 */
function styleHit(text, covered) {
  const gap = [...text].map((ch, i) => (covered[i] ? ' ' : ch)).join('');
  for (const style of COOKING_STYLE) {
    if (style.aliases.some((a) => gap.includes(a))) return style;
  }
  return null;
}

/** 标记文字里被识别出的名称所占的位置 */
function markCovered(text, hits) {
  const covered = new Array(text.length).fill(false);
  for (const h of hits) {
    for (let i = h.index; i < h.index + h.text.length && i < covered.length; i++) covered[i] = true;
  }
  return covered;
}

/**
 * 把份量说法换算成克数。
 * 优先用这个食物自己的份量表（粥的一碗 250 克 ≠ 米饭的一碗 180 克），
 * 再退回通用份量表。
 */
export function gramsForPortion(food, portion) {
  if (!portion) return null;
  if (portion.counting) {
    // 鸡蛋一个 50 克、苹果一个 200 克：单位重量按这个食物自己的标准份量修正
    const perUnit = food.servings?.[0]?.[1] || FOOD_DEFAULT_GRAMS[food.id] || portion.perUnit || 100;
    return Math.round((portion.count || 1) * perUnit);
  }
  if (portion.portionWord && Array.isArray(food.servings)) {
    const unit = portion.portionWord.replace(/^一/, '');
    const hit = food.servings.find(([label]) => {
      const key = String(label).replace(/^一/, '').replace(/[（(].*?[)）]/g, '');
      return key === unit || key === portion.portionWord;
    });
    if (hit) return hit[1] * (portion.count || 1);
    // 「半包薯片」「一杯奶茶」：食物只写了「一小包/中杯」时，按同单位的份量换算
    const loose = food.servings.find(([label]) => String(label).includes(unit));
    if (loose) return loose[1] * (portion.count || 1);
    // 食物自己的份量表里没有「碗」这一项时，别用通用碗重（350 克）硬套
    if (/碗|份|盘|盒/.test(unit) && !food.servings.some(([label]) => /碗|份|盘|盒/.test(String(label)))) {
      return null;
    }
  }
  return portion.grams;
}

/** 按克数等比换算营养素 */
function scaleNutrition(base, grams, baseGrams) {
  const k = grams / baseGrams;
  return {
    kcal: Math.round(base.kcal * k),
    protein: Math.round(base.protein * k * 10) / 10,
    fat: Math.round(base.fat * k * 10) / 10,
    carb: Math.round(base.carb * k * 10) / 10,
  };
}

export function parseDescription(raw, defaultMeal = null) {
  const text = String(raw || '').trim();
  const meal = mealFromText(text, defaultMeal);
  if (!text) return { items: [], meal, unknown: [], text };

  const hits = findHits(text);
  const style = styleHit(text, markCovered(text, hits));
  const items = [];
  const usedExtras = new Set();

  // 主菜：优先「具体的菜」，其次才是「食堂/套餐」这类泛称
  const dishHits = hits.filter((h) => h.kind === 'dish');
  const chosenDish = dishHits.find((h) => !h.ref.generic)?.ref || dishHits[0]?.ref || null;
  const chosenDishIndex = dishHits.find((h) => h.ref === chosenDish)?.index ?? -1;

  // 食材：所有命中的食物（组合菜的原料也常被单独说出来，例如「黄焖鸡米饭」里的鸡）
  const foodHits = hits.filter((h) => h.kind === 'food');
  const paired = pairPortions(text, foodHits);

  if (chosenDish) {
    const nearAll = findAllPortions(text).filter((p) => Math.abs(p.index - chosenDishIndex) <= 6);
    // 「两个包子」里的「两个」是包子的个数，不能拿 200 克当整份的重量
    const near = nearAll.find((p) => !p.counting) || null;
    const dishHit = dishHits.find((h) => h.ref === chosenDish);
    // 「两个包子」：按个数算；只说「包子」时按一份算
    const units = near?.counting ? (near.count || 1) : 1;
    // 泛称（食堂/套餐）不一定就是一份，按具体名称命中的次数缩放
    const scale = chosenDish.generic ? Math.max(1, /两个|三个|两份|三份|两菜|三菜/.test(text) ? 1.6 : 1) : 1;
    const baseForThis = chosenDish.generic ? chosenDish.baseGrams * scale : chosenDish.baseGrams;
    void dishHit;
    const grams = near?.counting
      ? Math.round(units * (DISH_PER_UNIT[chosenDish.id] || 100))
      : Math.min(near?.grams || baseForThis, baseForThis * 1.6);
    const nut = scaleNutrition(
      { kcal: chosenDish.kcal, protein: chosenDish.protein, fat: chosenDish.fat, carb: chosenDish.carb },
      grams, chosenDish.baseGrams,
    );
    items.push({
      name: chosenDish.name,
      grams: Math.round(grams),
      ...nut,
      confidence: near ? 'medium' : 'low',
      needsConfirm: !near,
      question: near ? (chosenDish.ask || null) : '这一份大概多大？（小碗/普通碗/大碗，热量能差一倍）',
      source: 'dish',
      dishId: chosenDish.id,
    });
  }

  // 逐个食材
  for (const { hit, portion, counting } of paired) {
    const f = hit.ref;
    // 组合菜已经覆盖了它的原料时跳过（避免「牛肉面」再加一份牛肉）
    if (chosenDish && chosenDish.aliases.some((a) => a.includes(hit.text) || hit.text.includes(a))) continue;
    if (chosenDish && items.some((it) => it.name.includes(hit.text))) continue;
    const standard = f.servings?.[0]?.[1] || FOOD_DEFAULT_GRAMS[f.id] || 100;
    let grams = portion ? gramsForPortion(f, portion) : null;
    if (!(grams > 0)) grams = FOOD_DEFAULT_GRAMS[f.id] || standard;
    grams = Math.min(grams, 3000);
    const nut = scaleNutrition({ kcal: f.kcal, protein: f.protein, fat: f.fat, carb: f.carb }, grams, 100);
    const needsConfirm = !portion;
    items.push({
      name: f.name,
      grams: Math.round(grams),
      ...nut,
      confidence: needsConfirm ? 'low' : 'medium',
      needsConfirm,
      question: needsConfirm && !chosenDish ? `${f.name}大概多少量？（一个拳头约 150 克）` : null,
      source: 'food',
      foodId: f.id,
    });
  }

  // 配料/加料
  for (const h of hits) {
    if (h.kind !== 'extra') continue;
    if (usedExtras.has(h.ref.key)) continue;
    usedExtras.add(h.ref.key);
    // 已经被某个主菜覆盖的配料不重复加
    if (items.some((it) => it.foodId === h.ref.foodId)) continue;
    if (chosenDish && /面|粉/.test(chosenDish.name) && h.ref.key === 'noodle_extra') continue;
    const food = findFood(h.ref.foodId);
    if (!food) continue;
    const nearExtra = findAllPortions(text).find((p) => Math.abs(p.index - h.index) <= 6);
    const grams = h.ref.defaultGrams;
    const nut = scaleNutrition({ kcal: food.kcal, protein: food.protein, fat: food.fat, carb: food.carb }, grams, 100);
    items.push({
      name: `加${food.name}`,
      grams,
      ...nut,
      confidence: 'medium',
      needsConfirm: false,
      warning: h.ref.warn || null,
      source: 'extra',
      foodId: food.id,
      note: nearExtra ? `按 ${nearExtra.text} 估的` : null,
    });
  }

  // 做法只影响「生鲜食材」，组合菜的热量本身已经包含做法了
  if (style) {
    for (const it of items) {
      if (it.source !== 'food') continue;
      it.fat = Math.round(it.fat * style.oilFactor * 10) / 10;
      it.kcal = Math.round(it.protein * 4 + it.fat * 9 + it.carb * 4);
      it.cookingStyle = style.note;
      it.confidence = 'low';
      it.needsConfirm = true;
      it.question = `${it.name}是${style.aliases[0]}的，按家常油量估的，差不多吗？`;
    }
  }

  // 没认出来的部分，让界面提示她补充
  const unknown = [];
  if (!items.length) {
    const cleaned = text.replace(/[，,。.、!！?？\s]/g, '');
    if (cleaned.length >= 2) unknown.push(cleaned);
  }

  return { items, meal, unknown, text };
}

/**
 * 整理 AI 返回的条目：热量一律用本地数据算，AI 只负责听懂和给份量。
 * AI 返回格式（约定）：
 *   { meal: 'lunch', items: [{ name, grams, matchedFoodId?, note? }], questions: [string] }
 * 对不上的条目会把 AI 给的热量标注出来，但仍以本地估算为准（并标成需要确认）。
 */
export function normalizeAiItems(aiResult, defaultMeal = null) {
  const out = { items: [], meal: aiResult?.meal || defaultMeal, questions: [], unmatched: [] };
  const list = Array.isArray(aiResult?.items) ? aiResult.items : [];
  for (const raw of list) {
    const grams = Number(raw?.grams);
    if (!(grams > 0) || grams > 5000) continue;
    const food = raw?.matchedFoodId ? findFood(raw.matchedFoodId) : null;
    if (food) {
      const nut = scaleNutrition({ kcal: food.kcal, protein: food.protein, fat: food.fat, carb: food.carb }, grams, 100);
      out.items.push({
        name: raw.name || food.name,
        grams: Math.round(grams),
        ...nut,
        confidence: raw.confidence === 'high' ? 'high' : 'medium',
        needsConfirm: false,
        source: 'ai',
        foodId: food.id,
        note: raw.note || null,
      });
    } else {
      // AI 认出了东西但本地库里没有：用 AI 给的热量，但必须让她确认
      const kcal = Number(raw?.kcal) || 0;
      if (!(kcal > 0)) { out.unmatched.push(raw?.name || '?'); continue; }
      out.items.push({
        name: raw.name || '（AI 估算）',
        grams: Math.round(grams),
        kcal: Math.round(kcal),
        protein: Number(raw.protein) || 0,
        fat: Number(raw.fat) || 0,
        carb: Number(raw.carb) || 0,
        confidence: 'low',
        needsConfirm: true,
        question: `「${raw.name}」不在本地食物库里，热量 ${Math.round(kcal)} kcal 是估算的，对吗？`,
        source: 'ai-estimate',
        note: raw.note || '这条来自 AI 估算，不是本地数据',
      });
      out.unmatched.push(raw.name);
    }
  }
  for (const q of Array.isArray(aiResult?.questions) ? aiResult.questions : []) {
    if (typeof q === 'string' && q.trim()) out.questions.push(q.trim());
  }
  return out;
}

/** 汇总一组条目 */
export function sumItems(items) {
  return items.reduce((a, it) => {
    a.kcal += it.kcal || 0;
    a.protein += it.protein || 0;
    a.fat += it.fat || 0;
    a.carb += it.carb || 0;
    return a;
  }, { kcal: 0, protein: 0, fat: 0, carb: 0 });
}

/** 需要反问的问题清单 */
export function collectQuestions(items, extraQuestions = []) {
  const qs = [];
  for (const it of items) {
    if (it.question) qs.push({ item: it, text: it.question });
  }
  for (const t of extraQuestions) qs.push({ item: null, text: t });
  return qs;
}

/** 份量词 → 克数（界面上的快捷按钮用） */
export function portionGrams(word) {
  return PORTIONS[word] ?? null;
}

/** 把「一碗」这种写法解析成克数（复用 foods.js 的逻辑，但这里不依赖具体食物） */
export function gramsFromText(text) {
  const p = findPortion(String(text || ''));
  if (p) return p.grams;
  const n = parseAmount(text, null);
  return n && n > 0 ? n : null;
}

/**
 * 离线解析的基准用例：每句都写了「人肉估算的合理热量」。
 * 用途有二：一是回归测试，二是浏览器里可以直接跑（AI 不通时至少保证兜底不退化）。
 * 允许 ±25% 的偏差 —— 家常菜的份量本身就有这个浮动。
 */
export const GOLDEN_CASES = [
  { text: '早上吃了一碗白粥和两个鸡蛋', kcal: 260, note: '粥一碗 250 克（115 kcal）+ 两个蛋 100 克（143 kcal）' },
  { text: '中午吃了两个鸡蛋和一个苹果', kcal: 250, note: '两个蛋 100 克（143 kcal）+ 一个苹果 200 克（106 kcal）' },
  { text: '今天中午在食堂吃了碗牛肉面，加了个蛋', kcal: 680, note: '一碗牛肉面约 600 克 + 一个蛋' },
  { text: '下午喝了杯奶茶，还有半包薯片', kcal: 690, note: '中杯奶茶 500 克（425 kcal）+ 半包薯片 25 克（134 kcal）' },
  { text: '晚饭红烧肉配了一碗米饭，还有炒青菜', kcal: 1750, note: '红烧肉一份 + 一碗米饭 + 炒青菜' },
  { text: '中午吃了一份黄焖鸡米饭', kcal: 780, note: '一份黄焖鸡米饭' },
  { text: '晚上吃了碗馄饨', kcal: 330, note: '一碗馄饨 300 克' },
];

/** 跑一遍基准用例，返回不合格的项 */
export function selfTestParser() {
  const failed = [];
  for (const c of GOLDEN_CASES) {
    const r = parseDescription(c.text);
    const got = sumItems(r.items).kcal;
    if (!r.items.length) { failed.push(`${c.text}：一条都没解析出来`); continue; }
    const diff = Math.abs(got - c.kcal) / c.kcal;
    if (diff > 0.25) failed.push(`${c.text}：解析出 ${Math.round(got)} kcal，应在 ${Math.round(c.kcal * 0.75)}~${Math.round(c.kcal * 1.25)} 之间`);
  }
  return failed;
}
