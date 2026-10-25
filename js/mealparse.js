/**
 * 把「今天在食堂吃了碗牛肉面」这类大白话，拆成可确认的食物条目。
 *
 * 这里做两件事：
 *  1) 离线解析（parseDescription）：靠关键词匹配 + 份量推断，把用户说的东西拆成几项。
 *     解析不了的会标成「需要确认」，界面负责反问用户。
 *  2) 整理 AI 返回的结果（normalizeAiItems）：本地库/「我的食物」命中时用本地数字；
 *     本地没有的菜，AI 现在可以直接给营养估算，但必须过本地校验（4/9/4 对账 + 上下限），
 *     过不了就退回同类均值 —— 数字始终能核对、能离线复算。
 *
 * 统一的中间结果叫「条目（item）」：
 *   { name, grams, kcal, protein, fat, carb, confidence, confidenceReason,
 *     portionChoices, needsConfirm, question, source }
 *
 * confidence（'high' | 'low'）说的是「份量有多确定」，不是「这条准不准」：
 * 用户给了确切克数、或者用了个头/包装有标准的量词，就是 high；
 * 「一碗」「一份」这种说不准的说法、以及什么都没说时，是 low，
 * 界面会拿 portionChoices 里的档位反问用户一句，而不是默默按默认值记上。
 */

import { FOODS, ALIASES, findFood, findMatchableFood, parseAmount, matchFoodByName, detectFoodForm, genericEstimateFor } from './foods.js';
import { DISHES } from './dishes.js';
import { validateNutritionEstimate } from './label.js';

// 老代码/测试从 mealparse 里取 DISHES，这里继续转出去，避免调用方改动
export { DISHES };

/** 单份默认克数：用户没说份量时按「正常一份」估，而不是统一 100 克 */
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
  chicken_breast: 150, chicken_breast_cooked: 150, chicken_thigh: 100, chicken_thigh_cooked: 100, chicken_wing: 50,
  pork_lean: 100, pork_lean_cooked: 100, beef_lean: 100, beef_lean_cooked: 120,
  shrimp: 100, shrimp_cooked: 100, salmon: 120, salmon_cooked: 120, white_fish: 150, white_fish_cooked: 150, tuna_can: 120,
  oats: 40, milk: 250,
};

/** 组合菜按「个」计时每个多少克（包子 100、饺子 20 之类） */
const DISH_PER_UNIT = { baozi_pork: 100, dumpling_meal: 20, burger_meal: 250 };

/** 常见份量的克数：写「一碗」时按这个算，界面会让用户确认/改 */
export const PORTIONS = {
  '一小碗': 200, '一碗': 350, '大碗': 500, '超大碗': 650,
  '一份': 200, '一盘': 250, '一盒': 250, '一袋': 100, '一包': 80,
  '一杯': 300, '一瓶': 500, '一罐': 330,
  '一个': 100, '一块': 100, '一串': 80, '一勺': 15, '一筷子': 20,
  // 日常口语里按「个/根/片/只/颗」说的东西很多（一根香蕉、一片吐司、一颗糖）。
  // 这里只是兜底值，具体食物会用自己份量表里的第一个规格修正（香蕉一根 120 克，不是 100）。
  '一根': 100, '一片': 30, '一条': 80, '一只': 50, '一颗': 10, '一粒': 5, '一枚': 50, '一把': 30,
};

/** 份量疑问的选项，界面直接拿它渲染按钮 */
export const PORTION_CHOICES = [
  { label: '小碗（约 200 克）', value: '一小碗', grams: 200 },
  { label: '普通碗（约 350 克）', value: '一碗', grams: 350 },
  { label: '大碗（约 500 克）', value: '大碗', grams: 500 },
  { label: '超大碗（约 650 克）', value: '超大碗', grams: 650 },
];

/* ── 份量置信度：什么时候该反问用户 ──────────────────
   用户的原话是「一碗在食堂和家里能差一倍」。所以「说了份量词」不等于「说得够准」：
     · 「200克」「半斤」「两个鸡蛋」「一罐可乐」→ 能换成一个确定的克数，别打扰用户；
     · 「一碗」「一份」「半包」→ 碗有大小、份量看食堂、包装有大有小包，问一句比猜准。
   判据落在每条 item 的 confidence / confidenceReason 上，界面据此决定要不要给档位按钮。
   ────────────────────────────────────────────── */

/** 说了这些量词也还是说不准：碗有大小、份量看食堂、包装有大有小包 */
const VAGUE_UNITS = new Set(['碗', '小碗', '大碗', '超大碗', '份', '盘', '盒', '袋', '包']);

/**
 * 补档的幅度：按「这东西平时还有多小/多大」分开定，不是所有食物统一乘 0.6/1.5 ——
 * 一碗面能从 400 吃到 900，一杯奶就 200~350，一勺油只从 8 到 15。
 * 只在食物库没写那一头时才用得上：库里的份量表永远优先（米饭写的就是「一小碗 130 / 一碗 180 / 一大碗 250」）。
 */
const KIND_SPREAD = {
  bowl: [0.7, 1.4],
  cup: [0.8, 1.4],
  plate: [0.6, 1.6],
  piece: [0.75, 1.35],
  pack: [0.6, 1.8],
  spoon: [0.6, 1.5],
  handful: [0.6, 1.6],
};

/** 补出来的档位怎么念（跟库里「一小碗」「中杯」的说法保持同一个口吻） */
const KIND_LABELS = {
  bowl: ['小碗', '正常', '大碗'],
  cup: ['小杯', '正常', '大杯'],
  plate: ['小份', '正常', '大份'],
  piece: ['小个', '正常', '大个'],
  pack: ['小包', '正常', '大包'],
  spoon: ['少一点', '正常', '多一点'],
  handful: ['小把', '正常', '大把'],
};

/** 分类 → 平时按什么盛：主食按碗、奶和饮料按杯、坚果油脂按勺、零食按包装、水果蛋按个 */
const KIND_BY_CATEGORY = {
  staple: 'bowl', dairy: 'cup', drink: 'cup', fat: 'spoon', snack: 'pack', fruit: 'piece',
};

/** 个别食物跟所在分类的盛法不一样（坚果是一小把、饺子和虾按个，都不是按勺/按份） */
const KIND_BY_ID = {
  oats: 'bowl', noodle_raw: 'bowl', pasta_cooked: 'bowl', quinoa_cooked: 'bowl',
  peanut: 'handful', walnut: 'handful', almond: 'handful', cashew: 'handful',
  cheese_slice: 'piece', dumpling_pork: 'piece', shrimp: 'piece', avocado: 'piece',
};

/** 汤面/粥这类组合菜是一碗盛出来的，档位该按碗问，不是按「份」 */
const KIND_BY_DISH = {
  beef_noodle: 'bowl', pork_noodle: 'bowl', noodle_soup_plain: 'bowl', noodle_fried: 'bowl',
  rice_noodle_soup: 'bowl', instant_noodle: 'bowl', wonton_meal: 'bowl', porridge_meal: 'bowl',
};

/** 这个食物（或这道菜）平时按什么盛，决定档位的说法和补档幅度 */
export function portionKindOf(target) {
  if (!target) return 'plate';
  if (KIND_BY_ID[target.id]) return KIND_BY_ID[target.id];
  if (KIND_BY_DISH[target.id]) return KIND_BY_DISH[target.id];
  return KIND_BY_CATEGORY[target.category] || 'plate';
}

/** 把库里的「一小碗」「中杯」写成按钮上好念的字样 */
function prettyTierLabel(raw) {
  const t = String(raw).replace(/^一/, '').replace(/[（(].*?[)）]/g, '').trim();
  const map = {
    碗: '普通碗', 份: '一份', 盘: '一盘', 杯: '一杯', 个: '一个', 块: '一块', 把: '一把',
    勺: '一勺', 盒: '一盒', 瓶: '一瓶', 罐: '一罐', 包: '一小包', 袋: '一袋', 串: '一串',
    只: '一只', 根: '一根', 片: '一片', 顿: '一顿', 桶: '一桶',
  };
  return map[t] || t;
}

/**
 * 给一条「份量是猜的」生成几个可选档位，界面做成按钮，点一下就改。
 * 保证「最小档 < 当前记的克数 < 最大档」—— 否则按钮点了没变化，等于白问一句。
 * @param {object|null} target 食物或组合菜（取它的 servings 和类型）
 * @param {number} defaultGrams 现在按多少克记的
 * @param {number} count 用户说的份数（「两碗米饭」的档位也要跟着翻倍）
 * @returns {Array<{label:string, grams:number}>} 小/正常/大 三档，从小到大；不值得问时给空数组
 */
export function buildPortionChoices(target, defaultGrams, count = 1) {
  const g = Math.round(Number(defaultGrams) || 0);
  // 20 克以下的份量（一勺油 10 克、一勺糖 8 克）差几克也无所谓，不值得在界面上多问一句
  if (!(g >= 20)) return [];
  const kind = portionKindOf(target);
  const [smallK, largeK] = KIND_SPREAD[kind] || KIND_SPREAD.plate;
  const labels = KIND_LABELS[kind] || KIND_LABELS.plate;
  const times = Math.max(1, Math.round(Number(count) || 1));
  // 库里的份量按用户说的份数放大（「两碗米饭」的档位就该是 260/360/500）
  const table = [];
  for (const [label, grams] of Array.isArray(target?.servings) ? target.servings : []) {
    const v = Math.round(Number(grams) * times);
    // 离当前值太远的规格不拿出来当档位：说「6 斤米饭」时列一个「一小碗 130 克」，用户也选不下去
    if (v > 0 && v >= g / 3 && v <= g * 2.5) table.push({ label: prettyTierLabel(label), grams: v });
  }
  // 只取离当前值最近的那一头：库里有 130/180/250 时，不会拿 130 当「大碗」
  const nearest = (below) => table
    .filter((x) => (below ? x.grams < g : x.grams > g))
    .sort((a, b) => (below ? b.grams - a.grams : a.grams - b.grams))[0] || null;
  const round5 = (v) => (v >= 100 ? Math.round(v / 10) * 10 : v >= 20 ? Math.round(v / 5) * 5 : Math.round(v));
  const exact = table.find((x) => x.grams === g);
  const below = nearest(true) || { label: labels[0], grams: round5(g * smallK) };
  const above = nearest(false) || { label: labels[2], grams: round5(g * largeK) };
  const suffix = times > 1 ? `×${times}` : '';
  // 三档的说法不能撞车（「小包 30」和「小包 50」两个按钮用户会不知道选哪个），撞了就用中性说法
  const useLabel = (() => {
    const used = new Set([exact ? exact.label : labels[1]]);
    const alt = ['小一点', '大一点'];
    return (want) => {
      const pick = used.has(want) ? (alt.find((a) => !used.has(a)) || want) : want;
      used.add(pick);
      return pick;
    };
  })();
  // 库里的说法可能两头撞上（比如「一小份」既算小档又算大档），撞了就用类型标签区分
  const belowLabel = useLabel(below.label);
  const aboveLabel = useLabel(below.label === above.label ? labels[2] : above.label);
  return [
    // 兜底档收在 5 克以上，并且一定比当前值小，避免四舍五入把小档抬得跟默认一样
    { label: belowLabel + suffix, grams: Math.max(5, Math.min(below.grams, g - 1)) },
    { label: (exact ? exact.label : labels[1]) + suffix, grams: g },
    { label: aboveLabel + suffix, grams: Math.max(above.grams, g + 1) },
  ];
}

/** 食物库里写没写过这个量词（牛奶写了「一杯 250 克」才算换算明确） */
function servingMatch(food, unit) {
  if (!food || !Array.isArray(food.servings)) return null;
  const clean = (x) => String(x).replace(/^一/, '').replace(/[（(].*?[)）]/g, '');
  const exact = food.servings.find(([label]) => clean(label) === unit);
  if (exact) return { exact: true, label: exact[0] };
  const loose = food.servings.find(([label]) => String(label).includes(unit));
  return loose ? { exact: false, label: loose[0] } : null;
}

/**
 * 这条的份量算不算说清了。
 * 高：给了克数/斤两，或用了个头、包装有标准的量词（两个鸡蛋、一罐可乐）；
 * 低：什么都没说，或者只有「一碗」「一份」「半包」这种说不准的说法。
 * @param {boolean} converted 用户说的那个份量能不能换算成克数（换不出来就等于没说清）
 */
function portionVerdict(food, portion, converted = true) {
  // 换不出克数（比如「半包」套在一个没有包装规格的食物上）：等于没说，别拿用户没说的量词当理由
  if (!portion || !converted) return { confidence: 'low', reason: '你没说多少，我先按常见的一份记的' };
  if (portion.counting || !portion.portionWord) return { confidence: 'high', reason: null };
  const said = portion.text || portion.portionWord;
  const unit = String(portion.portionWord).replace(/^一/, '');
  if (VAGUE_UNITS.has(unit)) {
    return { confidence: 'low', reason: `「${said}」有大有小，先按常见的估的` };
  }
  const hit = servingMatch(food, unit);
  if (hit?.exact) return { confidence: 'high', reason: null };
  return {
    confidence: 'low',
    reason: hit
      ? `「${said}」没有统一规格，我按「${prettyTierLabel(hit.label)}」估的`
      : `「${said}」没有固定规格，先按常见的估的`,
  };
}

/** 常见配料/加料：识别出来就往上加。vague = 加多少全看用户手，界面要反问一句 */
const EXTRA_INGREDIENTS = [
  { key: 'egg', aliases: ['加蛋', '加个蛋', '卤蛋', '鸡蛋', '煎蛋', '荷包蛋', '蛋'], foodId: 'egg', defaultGrams: 50 },
  { key: 'beef_extra', aliases: ['加肉', '加牛肉', '加份肉', '肉多'], foodId: 'beef_lean_cooked', defaultGrams: 60, vague: true },
  { key: 'pork_extra', aliases: ['加猪排', '加大排', '加排骨'], foodId: 'pork_lean_cooked', defaultGrams: 80, vague: true },
  { key: 'tofu_extra', aliases: ['加豆腐', '豆腐'], foodId: 'tofu_firm', defaultGrams: 100, vague: true },
  { key: 'veg_extra', aliases: ['加青菜', '青菜', '加菜', '蔬菜', '小白菜', '生菜'], foodId: 'bokchoy', defaultGrams: 150, vague: true },
  { key: 'rice_extra', aliases: ['加饭', '加米饭', '多饭'], foodId: 'rice_cooked', defaultGrams: 150, vague: true },
  { key: 'noodle_extra', aliases: ['加面'], foodId: 'noodle_cooked', defaultGrams: 150, vague: true },
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
    const clean = f.name.replace(/[（(].*?[)）]/g, '');
    // 带 form 的条目（生重/熟重肉鱼）允许单字名进字典：「虾」这种日常说法不然永远认不出来。
    // 其余食物仍要求 ≥2 字，避免「米」「面」「蛋」这种单字把别的词抢走。
    dict.push({ text: clean, kind: 'food', ref: f, allowSingle: Boolean(f.form) });
    if (f.name.length > 2) dict.push({ text: f.name, kind: 'food', ref: f });
    // 别名也要进解析字典 —— **v31 修的大坑**：
    // 以前只有「生熟两条」的食物把别名放进来了，其它食物的别名（酸奶、牛奶、肉丸、蛋糕…）
    // 只有搜索和 AI 匹配在用，离线解析根本看不见。于是「一杯酸奶」这种话在离线模式下
    // 会整句认不出来，AI 没开/没接上时用户就只能重说。
    for (const a of (ALIASES[f.id] || [])) {
      if (a.length >= 2) dict.push({ text: a, kind: 'food', ref: f });
    }
  }
  // 极少数单字是安全的：它们只在口语里指那一样东西，而且长词（米饭/面条/鸡蛋…）会先匹配走。
  for (const [word, id] of [['粥', 'congee'], ['饭', 'rice_cooked'], ['面', 'noodle_cooked'], ['蛋', 'egg'], ['糖', 'sugar']]) {
    const f = FOODS.find((x) => x.id === id);
    if (f) dict.push({ text: word, kind: 'food', ref: f, allowSingle: true });
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
    if (!entry.text) continue;
    if (entry.text.length < 2 && !entry.allowSingle) continue;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(entry.text, from);
      if (idx < 0) break;
      const free = taken.slice(idx, idx + entry.text.length).every((x) => !x);
      // 单字词（粥/饭/面/蛋/糖）最容易误伤：「晚饭」里的「饭」不是一碗米饭，
      // 「皮蛋」里的「蛋」也不是一颗蛋。前后紧挨着这些字时不当独立食物。
      const mealWord = entry.text.length === 1 && /[早午晚夜中宵]/.test(text[idx - 1] || '');
      if (free && !mealWord) {
        for (let i = idx; i < idx + entry.text.length; i++) taken[i] = true;
        hits.push({ ...entry, index: idx });
      }
      from = idx + entry.text.length;
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

const COUNTING_UNITS = new Set(['个', '块', '串', '根', '片', '条', '只', '颗', '粒', '枚', '把']);
const BASE_UNIT = { 小把: '把', 大把: '把', 小块: '块', 大片: '片', 小片: '片', 小包: '包', 大包: '包', 小份: '份', 大份: '份' };

/**
 * 找一段文字里的份量说法（支持中文数字：一碗 / 两个 / 半斤 / 一两 / 200毫升）。
 * @returns {{grams:number, text:string, portionWord?:string, counting?:boolean, count?:number}|null}
 */
export function findPortion(text) {
  const numMatch = String(text || '').match(
    /([0-9]+(?:\.[0-9]+)?|[一二两三四五六七八九十半])\s*(超大碗|小碗|大碗|小把|大把|小块|大片|小片|小包|大包|小份|大份|碗|份|盘|盒|袋|包|杯|瓶|罐|个|块|串|根|片|条|只|颗|粒|枚|把|勺|筷子|克|g|毫升|ml|斤|两)/i,
  );
  if (!numMatch) return null;
  const numText = numMatch[1];
  // 「一小把」「一大块」：把「小/大」当修饰，后面的量词才是真的量词
  const unit = BASE_UNIT[numMatch[2]] || numMatch[2];
  const full = numMatch[0];
  const qty = /^[0-9.]+$/.test(numText) ? Number(numText) : (CN_NUM[numText] ?? CN_GRAMS[numText] ?? 1);
  if (!(qty > 0)) return null;

  if (/斤/.test(unit)) return { grams: Math.round(qty * 500), text: full, counting: false };
  if (unit === '两') return { grams: Math.round(qty * 50), text: full, counting: false };
  if (/毫升|ml/i.test(unit)) return { grams: Math.round(qty), text: full, counting: false };
  if (/克|g/i.test(unit)) return { grams: Math.round(qty), text: full, counting: false };
  // 「一个」「两个」是个数；换算要按具体食物的标准份量，这里先记下来
  if (COUNTING_UNITS.has(unit)) {
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
  const re = /([0-9]+(?:\.[0-9]+)?|[一二两三四五六七八九十半])\s*(超大碗|小碗|大碗|小把|大把|小块|大片|小片|小包|大包|小份|大份|碗|份|盘|盒|袋|包|杯|瓶|罐|个|块|串|根|片|条|只|颗|粒|枚|把|勺|筷子|克|g|毫升|ml|斤|两)/gi;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const one = findPortion(m[0]);
    if (one) out.push({ ...one, index: m.index, end: m.index + m[0].length });
  }
  // 口语里常常不带「一」：「喝了杯奶茶」「吃了碗面」「来份沙拉」。
  // 不认这些说法的话，这句话里就只剩「半包」一个份量，会被离得近的奶茶抢走（issue #3）。
  const bare = /(?:喝|吃|点|来|要|买|加)\s*(?:了|个)?\s*(超大碗|小碗|大碗|小把|大把|小块|大片|小片|小包|大包|小份|大份|碗|份|盘|盒|袋|包|杯|瓶|罐|个|块|串|根|片|条|只|颗|粒|枚|把)/g;
  while ((m = bare.exec(text)) !== null) {
    const unit = m[1];
    const index = m.index + m[0].length - unit.length;
    const end = index + unit.length;
    // 前面已经带数字的（「一杯」）由上面的规则处理，别重复加
    if (out.some((p) => index < p.end && end > p.index)) continue;
    out.push(portionFromBareUnit(unit, index));
  }
  return out.sort((a, b) => a.index - b.index);
}

/** 「喝了杯奶茶」里的那个「杯」→ 一个标准份量（碗大小有别，交给界面确认） */
function portionFromBareUnit(rawUnit, index) {
  const unit = BASE_UNIT[rawUnit] || rawUnit;
  const base = { text: rawUnit, index, end: index + rawUnit.length, count: 1 };
  if (COUNTING_UNITS.has(unit)) {
    const perUnit = PORTIONS[`一${unit}`] || 100;
    return { ...base, grams: Math.round(perUnit), portionWord: `一${unit}`, counting: true, perUnit };
  }
  if (['碗', '小碗', '大碗', '超大碗'].includes(unit)) {
    const key = unit === '碗' ? '一碗' : unit === '小碗' ? '一小碗' : unit;
    return { ...base, grams: PORTIONS[key], portionWord: key, counting: false, unitKey: key };
  }
  return { ...base, grams: null, portionWord: `一${unit}`, counting: false, unitKey: `一${unit}` };
}

/**
 * 把每个食物配上「它自己的」份量说法。
 *
 * 三个必须守住的规则（否则份量会离谱）：
 *  1) 不能拿整句话里唯一的份量去套所有食物
 *     （「一杯奶茶和半包薯片」里 325 克是奶茶的，不能套给薯片）；
 *  2) 匹配要有距离窗口，且「一碗」「一份」里的「一」不算个数
 *     （「一碗白粥和两个鸡蛋」不能变成白粥 1300 克）；
 *  3) **单位和食物类型要对得上**：「半包」是包装食品的说法，奶茶按杯算。
 *     只看距离会让离得近的奶茶把「半包」抢走，薯片就按默认 50 克记了（issue #3）。
 */
const PAIR_WINDOW = 8;

/**
 * 这个单位平时装什么（按食物分类）。
 * 只列「明显该给谁」，没列到的按中立处理 —— 宁可交给距离判断，也不要乱扣分。
 */
const UNIT_CATEGORY_FIT = {
  '杯': ['drink', 'dairy'],
  '瓶': ['drink'],
  '罐': ['drink'],
  '包': ['snack'],
  '袋': ['snack', 'staple'],
  '盒': ['dairy', 'snack', 'staple'],
  '碗': ['staple', 'dish', 'vegetable', 'protein'],
  '盘': ['dish', 'vegetable', 'protein', 'staple'],
  '个': ['fruit', 'protein', 'staple', 'dairy', 'snack', 'fat'],
  '块': ['protein', 'fruit', 'snack', 'dairy', 'staple'],
  '串': ['protein', 'vegetable'],
  '勺': ['fat', 'dairy', 'staple'],
  '根': ['fruit', 'staple', 'protein'],
  '片': ['protein', 'snack', 'dairy', 'staple', 'vegetable'],
  '条': ['protein', 'vegetable', 'fruit'],
  '只': ['protein', 'fruit'],
  '颗': ['fruit', 'snack', 'vegetable'],
  '粒': ['fruit', 'snack'],
  '枚': ['fruit', 'protein'],
  '把': ['fat', 'vegetable'],
};

/** 明显说不通的组合：「半包奶茶」「一瓶米饭」不是口语里会出现的说法 */
const UNIT_CATEGORY_CLASH = {
  '包': ['drink'],
  '袋': ['drink'],
  '碗': ['drink'],
  '盘': ['drink'],
  '瓶': ['staple', 'vegetable', 'protein', 'fruit', 'dish'],
  '罐': ['staple', 'vegetable', 'protein', 'fruit', 'dish'],
  '串': ['drink', 'dairy', 'snack', 'fruit'],
};

/**
 * 这个份量说法有多像是给这个食物的：
 *  3 = 食物自己的份量表里就有这个单位（薯片写了「一小包」）
 *  1 = 分类上说得通（一杯奶茶）
 *  0 = 看不出来（「一份」什么都能说）
 * -2 = 明显对不上（半包奶茶）
 */
function unitFitScore(food, portion) {
  const unitKey = portion?.unitKey || portion?.portionWord;
  if (!unitKey) return 0;
  const unit = String(unitKey).replace(/^一/, '');
  const labels = (food?.servings || []).map(([label]) => String(label));
  if (labels.some((label) => label.includes(unit))) return 3;
  if ((UNIT_CATEGORY_CLASH[unit] || []).includes(food?.category)) return -2;
  const fits = UNIT_CATEGORY_FIT[unit];
  if (!fits) return 0;
  return fits.includes(food?.category) ? 1 : 0;
}

export function pairPortions(text, foodHits) {
  const portions = findAllPortions(text);
  const cands = [];
  foodHits.forEach((hit, hi) => {
    for (const p of portions) {
      // 距离按「食物开头」和「份量结尾」算，紧挨着的说法距离为 0
      const dist = Math.min(Math.abs(p.index - hit.index), Math.abs(hit.index - p.end));
      if (dist > PAIR_WINDOW) continue;
      const fit = unitFitScore(hit.ref, p);
      if (fit < 0) continue; // 单位跟食物类型明显对不上，不许抢
      // 同分时优先「紧挨着前面」的那个（「两个鸡蛋」而不是后面别的东西的份量）
      const before = p.end <= hit.index ? 1 : 0;
      cands.push({ hi, p, dist, before, score: fit * 3 - dist });
    }
  });
  // 全局挑「最说得通的组合」：先给匹配度最高的，避免先遍历到的食物把别人更该拿的份量抢走
  cands.sort((a, b) => b.score - a.score || a.dist - b.dist || b.before - a.before || a.p.index - b.p.index);
  const usedHit = new Set();
  const usedPortion = new Set();
  const chosen = new Map();
  for (const c of cands) {
    if (usedHit.has(c.hi) || usedPortion.has(c.p.index)) continue;
    usedHit.add(c.hi);
    usedPortion.add(c.p.index);
    chosen.set(c.hi, c.p);
  }
  return foodHits.map((hit, hi) => ({
    hit,
    portion: chosen.get(hi) || null,
    counting: Boolean(chosen.get(hi)?.counting),
  }));
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
    // 「一碗馄饨」「一碗酸菜鱼」：这道菜自己写的是「一份 XXX 克」，
    // 用户说「一碗」其实就是一个碗/一份的意思，按它的份量算，别套通用碗重 350 克。
    if (/碗|份|盘|盒/.test(unit)) {
      const perServing = food.servings.find(([label]) => /份|盘|盒/.test(String(label)));
      if (perServing) return perServing[1] * (portion.count || 1);
      return null;
    }
  }
  return portion.grams;
}

/**
 * 组合菜的一份有多大。
 *
 * 「一碗牛肉面」里的「一碗」是**一份**的意思，不是通用碗重 350 克 ——
 * 以前两种说法（「吃了碗牛肉面」600 克 / 「一碗牛肉面」350 克）能差 260 kcal。
 * 碗的大小仍然有别，所以按份量表里的比例缩放，不是一律乘 1。
 */
const DISH_UNIT_SCALE = { '一小碗': 0.7, '一碗': 1, '大碗': 1.4, '超大碗': 1.6, '一份': 1, '一盘': 1.1, '一盒': 0.9 };

function dishGramsFor(dish, portion, baseGrams) {
  if (!portion) return baseGrams;
  const scale = DISH_UNIT_SCALE[portion.portionWord];
  if (scale) return Math.round(baseGrams * scale);
  const grams = Number(portion.grams);
  if (grams > 0) return Math.min(grams, baseGrams * 1.6);
  return baseGrams;
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

  // 泛称组合菜（食堂打饭/盖饭套餐）和具体的菜同时出现时，具体菜更准：
  // 「食堂打了三个菜：土豆丝、青椒肉丝、炒青菜」按过去会记成「食堂套餐 650 + 三道菜」，
  // 一顿饭算成两顿。这里改成：有两道以上具体的菜时，就不再用泛称套餐兜底。
  const foodDishCount = paired.filter(({ hit }) => hit.ref.category === 'dish').length;
  const dropGeneric = Boolean(chosenDish && chosenDish.generic && foodDishCount >= 2);
  if (chosenDish && !dropGeneric) {
    // 已经被食材拿走的份量，组合菜不能再来抢一次：
    // 「红烧肉配了一碗米饭」里的一碗是米饭的，抢走就变成 350 克红烧肉 + 130 克米饭（issue #3）
    const takenByFoods = new Set(paired.map((x) => x.portion?.index).filter((i) => Number.isFinite(i)));
    const nearAll = findAllPortions(text)
      .filter((p) => Math.abs(p.index - chosenDishIndex) <= 6 && !takenByFoods.has(p.index));
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
      : dishGramsFor(chosenDish, near, baseForThis);
    const nut = scaleNutrition(
      { kcal: chosenDish.kcal, protein: chosenDish.protein, fat: chosenDish.fat, carb: chosenDish.carb },
      grams, chosenDish.baseGrams,
    );
    // 组合菜大多是「一碗」「一份」这种说法（碗有大小、份量看食堂），这里误差最大；
    // 但用户要是直接说了 600 克，那就是说清了，不该再问。组合菜没有份量表，所以第一个参数给 null。
    const dishVerdict = near
      ? portionVerdict(null, near)
      : { confidence: 'low', reason: '你没说这一份多大，我先按常见的一份记的' };
    items.push({
      name: chosenDish.name,
      grams: Math.round(grams),
      ...nut,
      confidence: dishVerdict.confidence,
      confidenceReason: dishVerdict.reason,
      portionChoices: dishVerdict.confidence === 'low'
        ? buildPortionChoices({ id: chosenDish.id, category: 'dish' }, grams)
        : [],
      needsConfirm: !near,
      question: near ? (chosenDish.ask || null) : '这一份大概多大？（小碗/普通碗/大碗，热量能差一倍）',
      source: 'dish',
      dishId: chosenDish.id,
    });
  }

  // 逐个食材
  const effectiveDish = dropGeneric ? null : chosenDish;
  for (const { hit, portion, counting } of paired) {
    const f = hit.ref;
    // 组合菜已经覆盖了它的原料时跳过（避免「牛肉面」再加一份牛肉）
    if (effectiveDish && effectiveDish.aliases.some((a) => a.includes(hit.text) || hit.text.includes(a))) continue;
    if (effectiveDish && items.some((it) => it.name.includes(hit.text))) continue;
    const standard = f.servings?.[0]?.[1] || FOOD_DEFAULT_GRAMS[f.id] || 100;
    const converted = portion ? gramsForPortion(f, portion) : null;
    let grams = converted;
    if (!(grams > 0)) grams = FOOD_DEFAULT_GRAMS[f.id] || standard;
    grams = Math.min(grams, 3000);
    const nut = scaleNutrition({ kcal: f.kcal, protein: f.protein, fat: f.fat, carb: f.carb }, grams, 100);
    const needsConfirm = !portion;
    const verdict = portionVerdict(f, portion, converted > 0);
    items.push({
      name: f.name,
      grams: Math.round(grams),
      ...nut,
      confidence: verdict.confidence,
      confidenceReason: verdict.reason,
      portionChoices: verdict.confidence === 'low'
        ? buildPortionChoices(f, grams, portion?.count || 1)
        : [],
      needsConfirm,
      question: needsConfirm && !effectiveDish ? `${f.name}大概多少量？（一个拳头约 150 克）` : null,
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
    if (effectiveDish && /面|粉/.test(effectiveDish.name) && h.ref.key === 'noodle_extra') continue;
    const food = findFood(h.ref.foodId);
    if (!food) continue;
    const nearExtra = findAllPortions(text).find((p) => Math.abs(p.index - h.index) <= 6);
    const grams = h.ref.defaultGrams;
    const nut = scaleNutrition({ kcal: food.kcal, protein: food.protein, fat: food.fat, carb: food.carb }, grams, 100);
    items.push({
      name: `加${food.name}`,
      grams,
      ...nut,
      // 「加了个蛋」是一颗标准大小，不用问；「加了点肉/加饭」加多少全看用户手，得问一句
      confidence: h.ref.vague ? 'low' : 'high',
      confidenceReason: h.ref.vague ? `「${h.text}」没说多少，先按常见的估的` : null,
      portionChoices: h.ref.vague ? buildPortionChoices(food, grams) : [],
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
      const foodForm = findFood(it.foodId)?.form;
      if (foodForm === 'cooked') continue; // 熟重数据已经包含做法，不能再按做法乘油量
      it.fat = Math.round(it.fat * style.oilFactor * 10) / 10;
      it.kcal = Math.round(it.protein * 4 + it.fat * 9 + it.carb * 4);
      it.cookingStyle = style.note;
      // 注意别在这里动 confidence：那个字段专门表示「份量有多确定」。
      // 油量不确定走 needsConfirm/question，两件事混在一起界面就分不清该问哪一句了。
      it.needsConfirm = true;
      it.question = `${it.name}是${style.aliases[0]}的，按家常油量估的，差不多吗？`;
    }
  }

  // 没认出来的部分，让界面提示用户补充
  const unknown = [];
  if (!items.length) {
    const cleaned = text.replace(/[，,。.、!！?？\s]/g, '');
    if (cleaned.length >= 2) unknown.push(cleaned);
  }

  return { items, meal, unknown, text };
}

/**
 * 整理 AI 返回的条目。
 *
 * 优先级（v34，用户明确要求「AI 要像助手，不是查表员」）：
 *  1) 本地食物库 / 「我的食物」命中 → 用本地固定数字（稳定、可离线复算）；
 *  2) 本地没有、但 AI 给了这一份的营养 → 过本地校验（4/9/4 + 上下限）后直接用；
 *  3) 都没有（或 AI 的数字不可信）→ 按同类均值兜底，标明估算（v31 的行为）。
 *
 * AI 返回格式（v34）：{ meal, items: [{ name, grams, nutrition? }], questions: [] }
 *
 * **老格式（只有 name + grams）必须继续能记上** —— 换模型/换服务商时它们不一定按新提示词回，
 * 那时退回第 3 步，而不是「一条都记不上」。
 */
export function normalizeAiItems(aiResult, defaultMeal = null, { text = '', customFoods = [] } = {}) {
  const out = {
    items: [], meal: aiResult?.meal || defaultMeal, questions: [],
    unmatched: [], unmatchedItems: [], estimated: [], aiEstimated: [],
  };
  // 生熟按「用户原句」判断（AI 通常只会回「鸡胸肉」，但用户可能说的是「生鸡胸肉」）
  const preferForm = detectFoodForm(text) || null;
  const list = Array.isArray(aiResult?.items) ? aiResult.items : [];
  for (const raw of list) {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (!name) continue;

    // 份量：AI 有时给数字，有时给「一碗」「一份」这种说法，还有的干脆没给
    const portionText = typeof raw?.portion === 'string' ? raw.portion : '';
    const portion = portionText ? findPortion(portionText) : null;
    let grams = Number(raw?.grams);
    if (!(grams > 0) || grams > 5000) grams = null;

    // 先看 AI 有没有直接给 id（一般没有），没有就按名字在本地库 + 「我的食物」里找
    let food = raw?.matchedFoodId ? findMatchableFood(raw.matchedFoodId) : null;
    let matchedBy = food ? 'AI 给的 id' : null;
    let matchedCustom = false;
    if (!food) {
      const hit = matchFoodByName(name, { preferForm: preferForm || detectFoodForm(name), customFoods });
      if (hit) { food = hit.food; matchedBy = hit.reason; matchedCustom = Boolean(hit.custom); }
    }

    if (food) {
      // 1) 本地命中：数字以本地为准（AI 估的营养只用于本地没有的条目）
      if (!(grams > 0)) grams = (portion && gramsForPortion(food, portion)) || food.servings?.[0]?.[1] || FOOD_DEFAULT_GRAMS[food.id] || 100;
      grams = Math.min(Math.round(grams), 3000);
      const nut = scaleNutrition({ kcal: food.kcal, protein: food.protein, fat: food.fat, carb: food.carb }, grams, 100);
      const nameDiffers = normLoose(name) !== normLoose(food.name);
      out.items.push({
        name: name || food.name,
        grams,
        ...nut,
        confidence: 'high',
        needsConfirm: false,
        source: 'ai',
        foodId: food.id,
        foodName: food.name,
        matchedCustom,
        // AI 说的名字和库里名字不一样时告诉用户对应到哪一个，避免用户以为记错了
        // 命中「我的食物」时永远标出来：数字是你自己存的（也是上次 AI 估的），不是这次又估的
        note: matchedCustom
          ? `按你之前存的「${food.name}」算的`
          : (nameDiffers ? `按「${food.name}」算的（${matchedBy}）` : (raw.note || null)),
      });
      continue;
    }

    // 2) 本地没有：AI 给了这一份的营养，本地先校验（v34）
    const checked = grams > 0 && raw?.nutrition
      ? validateNutritionEstimate({ grams, nutrition: raw.nutrition })
      : null;
    if (checked?.ok) {
      const p100 = checked.per100;
      const nut = scaleNutrition(p100, grams, 100);
      out.items.push({
        name,
        grams: Math.round(grams),
        ...nut,
        // 存成「我的食物」要用每 100 克的数字（下次按克数直接算）
        per100: p100,
        confidence: 'medium',
        confidenceReason: '食物库里没有这样东西，这份营养是 AI 估的（本地已核对）',
        needsConfirm: false,
        source: 'ai-estimate',
        estimated: true,
        estimateSource: 'ai',
        foodId: null,
        note: checked.recalced
          ? `热量和营养素对不上，已按 4/9/4 重算（原差 ${checked.diffPct}%）；记上后会存进「我的食物」`
          : '这份营养是 AI 估的（本地已核对）；记上后会存进「我的食物」，下次直接认得',
        ...(checked.recalced ? { warning: `AI 给的热量和营养素差 ${checked.diffPct}%，热量按蛋白/脂肪/碳水重算过` } : {}),
      });
      out.aiEstimated.push(name);
      continue;
    }

    // 3) 连 AI 也没给可信数字 → 同类均值兜底（v31 起的行为，绝不让用户白说一句）
    // 数字来自本地写死的表（见 foods.js 的 GENERIC_ESTIMATES），不是模型编的。
    const generic = genericEstimateFor(name);
    if (!(grams > 0)) grams = (portion && portion.grams) || generic.servings?.[0]?.[1] || 200;
    grams = Math.min(Math.round(grams), 3000);
    const nut = scaleNutrition(generic, grams, 100);
    const why = checked && !checked.ok && checked.reason ? `：${checked.reason}` : '';
    out.items.push({
      name,
      grams,
      ...nut,
      confidence: 'low',
      confidenceReason: '食物库里没有这样东西，先按平均值估的',
      portionChoices: buildPortionChoices(generic, grams),
      needsConfirm: false,
      source: 'estimate',
      foodId: null,
      estimated: true,
      estimateId: generic.id,
      note: checked && !checked.ok
        ? `食物库里没有「${name}」，AI 估的数字没通过本地校验（${checked.reason}），先按「${generic.name.replace(/（.*?）/g, '')}」的平均值估的；不准就删掉或改克数`
        : `食物库里没有「${name}」，先按「${generic.name.replace(/（.*?）/g, '')}」的平均值估的；不准就删掉或改克数`,
    });
    out.unmatched.push(name);
    out.unmatchedItems.push({ name, grams, estimateId: generic.id });
    out.estimated.push(name);
  }

  // 有问题要问，但**只有真有条目时才问** ——
  // 一条都没记上却问「这碗多大」是答不上来的（用户看到的就是三个粉色气泡 + 0 kcal）
  if (out.items.length) {
    for (const q of Array.isArray(aiResult?.questions) ? aiResult.questions : []) {
      if (typeof q === 'string' && q.trim()) out.questions.push(q.trim());
    }
  }
  return out;
}

/**
 * 「这句话是不是只用你之前存过的某样食物就能说清」—— 能说清就不花 AI 请求（v34）。
 *
 * 场景：使用者上次用 AI 估了一道本地库里没有的菜（比如「某网红限定轻食碗」），
 * 保存时它被存进「我的食物」；下次再说「下午又吃了某网红限定轻食碗 200 克」，
 * 其实不需要再问模型 —— 名字和份量本地都认得。
 *
 * 判定必须**保守**：名字之外的文字只允许剩下份量/餐次/口语词（去掉后少于 2 个字），
 * 一旦还有没覆盖的词（「……和一碗饭」），就照常调用 AI ——
 * 宁可多花一次请求，也绝不允许因为省请求而悄悄漏记东西。
 *
 * @returns {{food:object, leftover:string}|null}
 */
export function cachedOnlyMatch(rawText, customFoods = []) {
  const text = String(rawText || '').trim();
  if (!text) return null;
  // 自己存的食物都算（照包装手动加的、AI 估的）：名字够长才参与，避免「饭」这种单字误伤
  const candidates = (customFoods || []).filter((f) => f && String(f.name || '').length >= 2);
  if (!candidates.length) return null;
  let rest = text;
  let hit = null;
  for (const f of candidates) {
    const name = String(f.name);
    if (!rest.includes(name)) continue;
    // 一句话里出现两样「我的食物」：份量归属说不清（哪个词配哪样），交给 AI
    if (hit) return null;
    hit = f;
    rest = rest.split(name).join(' ');
  }
  if (!hit) return null;
  const leftover = rest
    .replace(/[0-9０-９]+(\.[0-9]+)?/g, ' ')
    .replace(CACHED_ONLY_NOISE, ' ')
    .replace(/[\s，,。.、！!?？:：;；()（）【】]/g, '');
  if (leftover.length >= 2) return null;
  return { food: hit, leftover };
}

/** cachedOnlyMatch 允许出现的「非食物」文字：餐次、吃/喝、份量、口语 */
const CACHED_ONLY_NOISE = /(今天|昨天|前天|早上|上午|中午|下午|晚上|夜宵|早餐|午饭|晚饭|加餐|吃了|喝的|吃的|喝完|吃|喝|又|还|再|大概|大约|左右|差不多|一份|一碗|一个|一杯|半|几|些|点|了|的|克|g|ml|毫升|斤|两|个|碗|份|杯|瓶|盘|盒|袋|包|块|片|根|只|颗|粒|把|勺)/g;

/** 比较名字用的宽松归一化 */
function normLoose(text) {
  return String(text || '').toLowerCase().replace(/[\s·・,，。.、!！?？（）()【】\[\]\/\\-]/g, '');
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
 * 默认允许 ±25% 的偏差 —— 家常菜的份量本身就有这个浮动。
 * 但**能算准的句子要单独收紧**：容差太宽会把真 bug 盖住（「半包薯片」那条就是这么被漏掉的，issue #3）。
 */
export const GOLDEN_CASES = [
  { text: '早上吃了一碗白粥和两个鸡蛋', kcal: 260, note: '粥一碗 250 克（115 kcal）+ 两个蛋 100 克（143 kcal）' },
  { text: '中午吃了两个鸡蛋和一个苹果', kcal: 250, note: '两个蛋 100 克（143 kcal）+ 一个苹果 200 克（106 kcal）' },
  { text: '今天中午在食堂吃了碗牛肉面，加了个蛋', kcal: 680, note: '一碗牛肉面约 600 克 + 一个蛋' },
  { text: '下午喝了杯奶茶，还有半包薯片', kcal: 559, tol: 0.05, note: '中杯奶茶 500 克（425 kcal）+ 半包薯片 25 克（134 kcal）' },
  { text: '晚饭红烧肉配了一碗米饭，还有炒青菜', kcal: 969, note: '红烧肉一份 150 克（570）+ 一碗米饭 180 克（209）+ 炒青菜 200 克（190）。旧值 1750 是「一碗」被红烧肉抢走算出来的（issue #3）' },
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
    const tol = c.tol ?? 0.25;
    const diff = Math.abs(got - c.kcal) / c.kcal;
    if (diff > tol) failed.push(`${c.text}：解析出 ${Math.round(got)} kcal，应在 ${Math.round(c.kcal * (1 - tol))}~${Math.round(c.kcal * (1 + tol))} 之间`);
  }
  return failed;
}
