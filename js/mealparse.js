/**
 * 把 AI 说回来的一顿饭，整理成本地能记的条目。
 *
 * 这里只做三件事（**不再自己猜句子**）：
 *  1) 整理 AI 返回的结果（normalizeAiItems）：本地库/「我的食物」命中时用本地数字；
 *     本地没有的菜，AI 可以直接给营养估算，但必须过本地校验（4/9/4 对账 + 上下限），
 *     过不了就退回同类均值 —— 数字始终能核对、能离线复算。
 *  2) 把「一碗」「两个」「半斤」这类说法换算成克数（findPortion / gramsForPortion）。
 *  3) 给「份量是猜的」条目生成几个档位按钮（buildPortionChoices）。
 *
 * v43（issue #24）：原来还有一套「靠关键词猜整句话」的离线解析器（parseDescription），
 * 只有普通模式在用。普通模式删掉后它不再被任何地方调用，已整体删除 ——
 * 现在"听懂人话"只有一条路：AI。没配 AI 就不发请求，界面直说「还没配置 AI」。
 *
 * 统一的中间结果叫「条目（item）」：
 *   { name, grams, kcal, protein, fat, carb, confidence, confidenceReason,
 *     portionChoices, needsConfirm, question, source }
 *
 * confidence（'high' | 'low' | 'medium'）说的是「份量有多确定」，不是「这条准不准」：
 * 有确切克数就是 high；AI 没给份量、按常见一份猜的是 low，
 * 界面会拿 portionChoices 里的档位反问用户一句，而不是默默按默认值记上。
 */

import { findMatchableFood, matchFoodByName, detectFoodForm, genericEstimateFor } from './foods.js';
import { validateNutritionEstimate } from './label.js';
import { macroKcal } from './calc.js';

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

/* ── 份量档位：AI 没说清克数时，给用户几个能点的按钮 ──────────────
   用户的原话是「一碗在食堂和家里能差一倍」。所以「说了份量词」不等于「说得够准」：
     · 「200克」「半斤」→ 能换成一个确定的克数，别打扰用户；
     · 「一碗」「一份」→ 碗有大小、份量看食堂，给档位让用户点一下比猜准。
   ────────────────────────────────────────────── */

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

const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const CN_GRAMS = { 半: 0.5 };

const COUNTING_UNITS = new Set(['个', '块', '串', '根', '片', '条', '只', '颗', '粒', '枚', '把']);
const BASE_UNIT = { 小把: '把', 大把: '把', 小块: '块', 大片: '片', 小片: '片', 小包: '包', 大包: '包', 小份: '份', 大份: '份' };

/**
 * 找一段文字里的份量说法（支持中文数字：一碗 / 两个 / 半斤 / 一两 / 200毫升）。
 * AI 有时不给克数、只给「一碗」这种说法，靠它换算。
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
      const gramsGuessed = Boolean(raw?.gramsMissing);
      out.items.push({
        name: name || food.name,
        grams,
        ...nut,
        // 份量是本地按常见一份猜的：标 low，界面会显示「份量是猜的」并给档位
        confidence: gramsGuessed ? 'low' : 'high',
        confidenceReason: gramsGuessed ? 'AI 没给份量，按这种食物常见的一份估的' : '',
        portionChoices: gramsGuessed ? buildPortionChoices(food, grams) : undefined,
        needsConfirm: false,
        source: 'ai',
        foodId: food.id,
        foodName: food.name,
        matchedCustom,
        // AI 说的名字和库里名字不一样时告诉用户对应到哪一个，避免用户以为记错了
        // 命中「我的食物」时永远标出来：数字是你自己存的（也是上次 AI 估的），不是这次又估的
        note: [
          gramsGuessed ? `AI 没给份量，按常见一份 ${grams} 克算的（可以改）` : '',
          matchedCustom ? `按你之前存的「${food.name}」算的` : (nameDiffers ? `按「${food.name}」算的（${matchedBy}）` : (raw.note || '')),
        ].filter(Boolean).join('；') || null,
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
        ? `食物库里没有「${name}」，AI 估的数字没通过本地校验（${checked.reason}），先按「${generic.name.replace(/（.*?）/g, '')}」的平均值估的；不准就删掉或改克数${why}`
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
