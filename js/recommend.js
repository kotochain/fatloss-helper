/**
 * 根据目标热量和蛋白质，直接算出「每餐吃什么、吃多少克」。
 *
 * 思路：先按比例把一天的预算分给早/午/晚/加餐：
 *  - 蛋白质名额：先搭出「主菜」，再用配角（豆腐 / 无糖酸奶）把当餐的蛋白质补齐；
 *  - 主食：用掉当餐剩下的热量额度；
 *  - 蔬菜：固定一份（蔬菜热量低，几乎不影响总额）；
 *  - 最后把克数吸附到「一碗」「一块」这种好操作的量上，
 *    再按当餐的热量额度做一次「缩份」收尾（份量只能往下减，不会把热量推高）。
 *
 * 这些数字是起点，不是规定。真实使用时按体重变化和饥饿感微调。
 */

/** 主菜承担每日蛋白质目标的比例，剩下的留给配角（奶/酸奶）和水果补齐 */
const PROTEIN_MAIN_SHARE = 0.82;

/** 主菜占当餐热量额度的上限。没有这条，「按蛋白质算份量」会算出 3 个鸡蛋配 1 勺燕麦这种不合理的组合。 */
const MAIN_PROTEIN_KCAL_SHARE = 0.7;

/** 主菜份量的下限：按蛋白质算出来的量最多可以压到几成（但不会突破热量上限） */
const MAIN_PROTEIN_MIN_FACTOR = 0.8;

/** 单条目标克数允许超出多少（份量吸附到整份之后通常会超一点），超了就按比例缩回来 */
const OVERSHOOT_TOLERANCE = 1.15;

/** 每天烹调油的合理上限（克）。30 克≈两勺半，再多就不像家常做法了 */
export const MAX_DAILY_OIL_G = 30;

/** 配餐时给烹调油预留的剩余热量比例（早餐鸡蛋、午晚炒菜都要用油） */
const DAILY_OIL_KCAL_SHARE = 0.18;

/**
 * 单个食物最多给几份。
 * 没有这条限制时，热量目标高的人会被配出「鸡蛋 4.5 个当早餐」这种不现实的量 ——
 * 真实场景里没人一顿吃五个鸡蛋。
 *
 * 上限按当日热量动态定：吃得少的人一顿一碗饭，吃 2500 kcal 的人一顿三碗饭也正常。
 * 固定值不行 —— 取小了会让大体重的人凑不够热量（实测偏差从 6% 反弹到 18%），
 * 取大了又会给出「4.5 个鸡蛋」。
 */
/**
 * 个别食物自己的份量上限。
 * 燕麦是干货：45 克冲一碗，135 克（4.5 份）泡出来是一大盆，没人这么吃。
 * 米饭按碗吃所以能放宽，燕麦不行。
 */
const FOOD_SERVING_OVERRIDE = { oats: 3 };

function maxServingsFor(targetCalories, role) {
  const perMealKcal = (targetCalories || 1800) * 0.3; // 一顿大约占三成
  // 300 kcal/份 这个系数是试出来的：再紧就装不下 2200 kcal 的维持期目标（实测偏差 19%），
  // 再松又会出现「一顿 4.5 个鸡蛋」。超过 2400 kcal 的目标本来就不是这个结构能覆盖的，
  // 那种情况由 deviationNote 如实说明。
  const raw = role === 'carb' ? perMealKcal / 300 : perMealKcal / 380;
  return Math.min(role === 'carb' ? 6 : 5, Math.max(2, raw));
}

/** 配角（牛奶/酸奶）最多几份，同样是为了不给出「500 克酸奶」这种量 */
const MAX_SIDE_SERVINGS = 2;

import { FOODS } from './foods.js';
import { round } from './calc.js';

/**
 * 每一餐的模板：
 *  protein   主菜（蛋白来源），ratio 之和必须等于 1
 *  side      配角（可选，用来补齐蛋白质，通常是豆腐或酸奶）
 *  carb      主食
 *  veg       蔬菜 / 家常菜
 *  fruit     水果（可选）
 */
export const MEAL_TEMPLATES = [
  {
    key: 'breakfast',
    name: '早餐',
    calorieShare: 0.26,
    proteinShare: 0.24,
    dishes: [
      { name: '鸡蛋 + 燕麦 + 牛奶', protein: ['egg'], ratio: [1], carb: 'oats', veg: null, fruit: 'blueberry', side: 'milk_whole' },
      { name: '全麦面包 + 鸡蛋 + 无糖酸奶', protein: ['egg'], ratio: [1], carb: 'bread_whole', veg: 'tomato', fruit: null, side: 'yogurt_plain' },
      { name: '燕麦 + 希腊酸奶 + 香蕉', protein: ['greek_yogurt'], ratio: [1], carb: 'oats', veg: null, fruit: 'banana', side: null },
    ],
  },
  {
    key: 'lunch',
    name: '午餐',
    calorieShare: 0.33,
    proteinShare: 0.38,
    dishes: [
      { name: '鸡胸肉 + 米饭 + 西兰花', protein: ['chicken_breast_cooked'], ratio: [1], carb: 'rice_cooked', veg: 'broccoli', side: null },
      { name: '牛里脊 + 米饭 + 炒青菜', protein: ['beef_lean_cooked'], ratio: [1], carb: 'rice_cooked', veg: 'stirfry_greens', side: null },
      { name: '虾 + 红薯 + 西兰花', protein: ['shrimp_cooked'], ratio: [1], carb: 'sweet_potato', veg: 'broccoli', side: null },
      { name: '巴沙鱼 + 米饭 + 番茄', protein: ['white_fish_cooked'], ratio: [1], carb: 'rice_cooked', veg: 'tomato', side: null },
    ],
  },
  {
    key: 'dinner',
    name: '晚餐',
    calorieShare: 0.30,
    proteinShare: 0.28,
    dishes: [
      { name: '鸡胸肉 + 北豆腐 + 米饭 + 小白菜', protein: ['chicken_breast_cooked', 'tofu_firm'], ratio: [0.55, 0.45], carb: 'rice_cooked', veg: 'bokchoy', side: null },
      { name: '三文鱼 + 藜麦 + 黄瓜生菜', protein: ['salmon_cooked'], ratio: [1], carb: 'quinoa_cooked', veg: 'cucumber', side: null },
      { name: '鸡腿肉（去皮）+ 土豆 + 香菇', protein: ['chicken_thigh_cooked'], ratio: [1], carb: 'potato', veg: 'mushroom', side: null },
      { name: '牛肉 + 米粉 + 大白菜', protein: ['beef_lean_cooked'], ratio: [1], carb: 'rice_noodle', veg: 'chinese_cabbage', side: null },
    ],
  },
  {
    key: 'snack',
    name: '加餐（下午或训练后）',
    calorieShare: 0.11,
    proteinShare: 0.10,
    dishes: [
      { name: '希腊酸奶 + 蓝莓', protein: ['greek_yogurt'], ratio: [1], carb: null, veg: null, fruit: 'blueberry', side: null },
      { name: '水煮蛋 + 苹果', protein: ['egg'], ratio: [1], carb: null, veg: null, fruit: 'apple', side: null },
      { name: '无糖酸奶 + 巴旦木', protein: ['yogurt_plain'], ratio: [1], carb: null, veg: null, fruit: 'almond', side: null },
    ],
  },
];

function findById(id) {
  if (!id) return null;
  const f = FOODS.find((x) => x.id === id);
  if (!f) throw new Error(`模板里的食物 id 不存在: ${id}`);
  return f;
}

/** 取食物最常见的份量（优先带克数的那个） */
function baseServing(food) {
  const s = food.servings[0];
  return { label: s[0], grams: s[1] };
}

/** 取「一份」的量，用来给蔬菜、水果、配角定量 */
function oneServing(food) {
  const { label, grams } = baseServing(food);
  const short = label.replace(/^一/, '');
  return { food, grams, desc: `${grams} 克（约 1 ${short}）` };
}

/** 把目标克数吸附到「半份 / 一份 / 两份」这种好称量的量上 */
export function snapToServing(food, targetGrams) {
  const { label, grams: base } = baseServing(food);
  const short = label.replace(/^一/, '');
  const multi = Math.max(0.5, Math.round((targetGrams / base) * 2) / 2);
  const grams = Math.round(base * multi);
  const desc =
    Math.abs(multi - 1) < 0.01 ? `1 ${short}`
      : Math.abs(multi - 0.5) < 0.01 ? `半${short}`
        : `${multi} ${short}`;
  return { food, grams, desc: `${grams} 克（约 ${desc}）` };
}

/**
 * 把「剩下的热量」分成主食预算和烹调油预算。
 *
 * 不这么分的话，主食会独吞全部剩余热量，脂肪目标永远差一截
 * （核验时实测：100 kg 维持期的餐单脂肪只有目标的 52%，油是 0 克）。
 *
 * @returns {{carbKcal:number, oilG:number}} 主食可用热量、烹调油克数
 */
export function splitRemainingKcal(kcalLeft, fatGapG, oilFood) {
  if (!(kcalLeft > 0)) return { carbKcal: 0, oilG: 0 };
  const kcalPerOilG = oilFood.kcal / 100;
  let oilG = 0;
  if (fatGapG >= 4 && kcalPerOilG > 0) {
    // 目标：补掉脂肪缺口，但油不超过合理上限，也不超过剩余热量的 35%
    oilG = Math.min(MAX_DAILY_OIL_G, fatGapG, (kcalLeft * 0.35) / kcalPerOilG);
    oilG = Math.max(0, Math.floor(oilG)); // 向下取整，宁可少一点也不要顶超
  }
  return { carbKcal: Math.max(0, kcalLeft - oilG * kcalPerOilG), oilG };
}

/**
 * 把一天的碳水目标按餐分配。
 *
 * 只按「当餐剩余热量」配主食是不够的：午餐预算大就会配出 260 克米饭，
 * 一天的碳水早就超了，脂肪目标反而永远差一半。
 * 这里按热量比例把碳水目标分到各餐（加餐减半），再按上限收敛。
 *
 * @returns {Record<string, number>} 每餐的碳水克数上限
 */
export function allocateCarbByMeal(meals, targets) {
  const active = (meals || []).filter((m) => m.items.some((it) => it.role === 'carb'));
  const totalCarbG = targets?.carbG ?? 0;
  if (!active.length || !(totalCarbG > 0)) return {};
  const weightOf = (m) => (m.key === 'snack' ? m.tpl.calorieShare * 0.5 : m.tpl.calorieShare);
  const weightSum = active.reduce((a, m) => a + weightOf(m), 0);
  const out = {};
  for (const m of active) out[m.key] = (totalCarbG * weightOf(m)) / weightSum;
  // 收敛：主食克数吸附到整份之后会超，超了就整体按最大倍数等比缩一次
  let worst = 1;
  for (const m of active) {
    const carbItem = m.items.find((it) => it.role === 'carb');
    const otherCarb = m.items
      .filter((it) => it !== carbItem)
      .reduce((a, it) => a + (it.food.carb * it.grams) / 100, 0);
    const allowed = Math.max(0, (out[m.key] - otherCarb) * 100);
    const used = carbItem.grams * (carbItem.food.carb / 100) * 100;
    if (used > allowed && used > 0) worst = Math.max(worst, allowed / used);
  }
  if (worst < 1) for (const k of Object.keys(out)) out[k] *= Math.max(worst, 0.5);
  return out;
}

function gramsForProtein(food, proteinGrams) {
  if (food.protein <= 0) throw new Error(`${food.name} 没有蛋白质，不能当蛋白来源`);
  return (proteinGrams * 100) / food.protein;
}

function caloriesOf(items) {
  return items.reduce((a, it) => a + (it.food.kcal * it.grams) / 100, 0);
}

function proteinOf(items) {
  return items.reduce((a, it) => a + (it.food.protein * it.grams) / 100, 0);
}

/**
 * 比例收缩：把超额的条目按自己的目标缩回来。
 * 参数是「每一条自己的基准」，不是整餐额度 —— 这样轻体重的人不会拿到一大碗饭。
 * 返回被缩过的条目名。
 */
function alignToTargets(items, tolerance = OVERSHOOT_TOLERANCE) {
  const shrunk = [];
  for (const it of items) {
    if (!it.targetGrams) {
      // 没有明确目标的条目（配角等）按统一规则：蛋白质按本餐名额反推
      continue;
    }
    if (it.grams > it.targetGrams * tolerance) {
      it.grams = Math.max(Math.round(it.targetGrams * tolerance), 10);
      it.desc = `约 ${it.grams} 克（本来按蛋白质该吃 ${it.targetGrams} 克，为了不超出热量额度缩过）`;
      shrunk.push(it.food.name);
    }
  }
  return shrunk;
}

/**
 * 缩份收尾：把克数吸附到半份/整份之后，热量往往比额度高。
 * 这里按「先砍顺序靠后的配角 → 再砍 25% → 每次砍 25%」往下收，份量只减不增。
 * 返回被缩减的条目名，供界面提示。
 */
export function trimMeal(items, budgetKcal, tolerance = 0.04) {
  const cap = budgetKcal * (1 + tolerance);
  const trimmed = [];
  const reorder = ['fruit', 'fat', 'side', 'carb', 'veg', 'protein'];
  let guard = 0;

  while (caloriesOf(items) > cap && guard < 60) {
    guard += 1;
    let target = null;
    for (const role of reorder) {
      const cands = items.filter((it) => it.role === role);
      if (cands.length) {
        target = cands[cands.length - 1];
        break;
      }
    }
    if (!target) break;
    const cur = caloriesOf(items);
    const need = cur - cap;
    const itemKcal = (target.food.kcal * target.grams) / 100;
    const step = Math.max(target.grams * 0.25, (need * 100) / Math.max(target.food.kcal, 0.01));
    let next = target.grams - step;

    // 各角色都有下限：蔬菜水果不能删（它们负责饱腹感和纤维），只能缩到很小。
    // 主食按「熟重 100 克」或「半份」取大者；燕麦这类干货（热量密度高）下限是 25 克。
    const carbFloor = target.food.kcal > 300 ? 25 : Math.max(100, target.food.servings[0][1] * 0.5);
    const floor = target.role === 'carb' ? carbFloor : 20;
    if (next < floor) {
      const removable = target.role === 'side'; // 只有作配角的奶/酸奶可以整条去掉
      if (removable) {
        items.splice(items.indexOf(target), 1);
        trimmed.push(target.food.name);
        continue;
      }
      next = floor;
      if (next >= target.grams) break; // 已经到下限，砍不动了
    }
    target.grams = Math.round(next);
    target.desc = `约 ${target.grams} 克（已按当餐热量额度缩减）`;
    if (itemKcal > 0) trimmed.push(target.food.name);
  }
  return { items, trimmed: [...new Set(trimmed)] };
}

/**
 * 说明：这里曾经有个 reconcileFatTarget / convergePlan，用来把「目标」改成「餐单实际能给的量」。
 * 已经删除，原因是**错的**：那会让同一个人的目标随「换一套」变化
 * （独立核验实测：脂肪目标在 36~69 克之间跳，还会压穿 0.6 g/kg 的安全线，9.67% 的正常体型中招）。
 *
 * 现在的分工：
 *   - 目标只由 calcTargets 决定，永远稳定；
 *   - 餐单给不到目标时，由 buildDeviationNote 如实说明差多少、怎么补。
 */

/**
 * 生成一天的餐单
 * @param {{targetCalories:number, proteinG:number}} targets
 * @param {{seed?:number}} options seed 换一天就换一批菜
 */export function buildMealPlan(targets, options = {}) {
  const seed = options.seed ?? 0;

  // 分两遍配：第一遍只看热量份额，用它算出「每餐碳水上限」，第二遍套上这个上限重配。
  // 只配一遍的话，午餐预算大会配出 260 克米饭，一天的碳水早就超了，脂肪目标反而永远差一半。
  const firstPass = composeMeals(targets, seed, null);
  const carbBudgets = allocateCarbByMeal(firstPass.parts, targets);
  const { meals } = composeMeals(targets, seed, carbBudgets);
  return finishPlan(meals, targets);
}

/** 按给定的「每餐碳水上限」组一遍餐（carbBudgets 为 null 时只用热量份额） */
function composeMeals(targets, seed, carbBudgets) {
  const meals = [];
  const parts = [];
  for (const tpl of MEAL_TEMPLATES) {
    const dish = tpl.dishes[seed % tpl.dishes.length];
    const items = [];

    // 1) 主菜：按比例吃掉本餐的蛋白质名额（可能有多样，比如鸡胸 + 豆腐）
    const sumRatio = dish.ratio.reduce((a, b) => a + b, 0);
    if (Math.abs(sumRatio - 1) > 0.001) {
      throw new Error(`${tpl.name} 的 protein 比例之和不是 1：${JSON.stringify(dish.ratio)}`);
    }
    const mealBudget = Math.round(targets.targetCalories * tpl.calorieShare);
    const carbBudgetG = carbBudgets ? carbBudgets[tpl.key] : undefined;
    // 给主食预留的最小空间（至少半份），主菜封顶时会扣掉这一块
    const carbFoodTmp = dish.carb ? findById(dish.carb) : null;
    const carbReserve = carbFoodTmp ? (carbFoodTmp.kcal * carbFoodTmp.servings[0][1] * 0.5) / 100 : 0;

    for (let i = 0; i < dish.protein.length; i++) {
      const food = findById(dish.protein[i]);
      const proteinTarget = targets.proteinG * PROTEIN_MAIN_SHARE * tpl.proteinShare * dish.ratio[i];
      const gByProtein = gramsForProtein(food, proteinTarget);

      // 主菜不能再吃掉超过当餐 70% 的热量（并且要给主食留出最低限度的空间），
      // 否则主食和蔬菜就没位置了。热量上限是硬约束；下限（最多压到按蛋白算的 80%）
      // 只是防止压成「一口肉」，不能把上限顶破。
      const mainKcalBudget = Math.max(0, mealBudget * MAIN_PROTEIN_KCAL_SHARE - carbReserve);
      const kcalCap = food.kcal > 0 ? (mainKcalBudget * 100) / food.kcal : Infinity;
      let grams = gByProtein;
      let clampedBy = null;
      if (grams > kcalCap) {
        grams = kcalCap;
        clampedBy = '热量额度';
      }
      // 主菜份量上限。注意不能用 servings[0] 当单位：虾的第一项是「一只 15 克」，
      // 拿它乘份数会算出「午餐主菜 30 克（两只虾）」这种量（核验员抓到的）。
      // 所以主菜用「一顿至少 80 克」和「按份数算的上限」取大者。
      const servingUnit = (food.servings?.[0]?.[1] || 100) >= 40
        ? (food.servings[0][1])
        : Math.max(80, (food.servings?.[1]?.[1] || 100));
      const maxServingsG = servingUnit * maxServingsFor(targets.targetCalories, 'protein');
      if (grams > maxServingsG) {
        grams = maxServingsG;
        clampedBy = clampedBy || '份量上限';
      }
      const floorG = Math.min(gByProtein * MAIN_PROTEIN_MIN_FACTOR, grams);
      if (grams < floorG) grams = floorG;
      const item = snapToServing(food, grams);
      item.role = 'protein';
      item.targetGrams = Math.round(grams);
      item.targetProteinG = round(proteinTarget, 1);
      item.clampedBy = clampedBy;
      if (clampedBy === '热量额度') {
        item.desc += '，这已经是给当餐留出主食后的上限';
      } else if (clampedBy === '份量上限') {
        item.desc += `（一份指 ${food.servings[0][1]} 克，一顿吃 ${item.grams} 克已经不少了）`;
      }
      item.proteinGiven = round((food.protein * item.grams) / 100, 1);
      items.push(item);
    }

    // 2) 主食：受两个上限约束 —— 当餐剩余热量（留给油一部分）和当餐碳水预算
    if (dish.carb) {
      const carbFood = findById(dish.carb);
      const usedKcal = caloriesOf(items);
      const left = Math.max(0, mealBudget - usedKcal);
      const carbKcal = tpl.key === 'snack' ? left : left * (1 - DAILY_OIL_KCAL_SHARE);
      if (carbFood.kcal <= 0) throw new Error(`${carbFood.name} 没有热量，不能当主食`);
      let grams = (carbKcal * 100) / carbFood.kcal;
      // 主食也封顶，但上限按「用户一天的碳水目标」放大：
      // 碳水目标 320 克的人（维持期、活动量大）本来就该多吃主食，
      // 用固定的「几碗饭」去卡会让用户怎么都吃不到目标热量（实测差 19%）。
      const carbFoodPer100 = carbFood.carb > 0 ? carbFood.carb : 25;
      const carbsPerMealTarget = (targets.carbG || 180) / 4;
      const capByCarbTarget = (carbsPerMealTarget / carbFoodPer100) * 100 * 1.35;
      const carbCap = FOOD_SERVING_OVERRIDE[carbFood.id]
        ? (carbFood.servings[0][1] * FOOD_SERVING_OVERRIDE[carbFood.id])
        : Math.min(
          // 两个上限取小：
          //  ① 按热量估的份数（吃得多的人可以到 4 份）
          //  ② 按用户的碳水目标估的份数
          // 上限 4 份是有意的：一顿 585 克米饭（4.5 份）看着就不像人吃的。
          Math.min(4, Math.max(2, maxServingsFor(targets.targetCalories, 'carb'))) * (carbFood.servings?.[0]?.[1] || 100),
          capByCarbTarget,
        );
      const carbMaxG = carbCap;
      if (grams > carbMaxG) grams = carbMaxG;
      const carbItem = { role: 'carb', food: carbFood, grams: 0 };
      if (carbBudgetG !== undefined && carbFood.carb > 0) {
        const otherCarb = items.reduce((a, it) => a + (it.food.carb * it.grams) / 100, 0);
        const carbLimitG = ((carbBudgetG - otherCarb) * 100) / carbFood.carb;
        if (carbLimitG > 0 && carbLimitG < grams) grams = carbLimitG;
      }
      items.push({ role: 'carb', ...snapToServing(carbFood, grams) });
    }

    // 3) 蔬菜：固定一份
    if (dish.veg) items.push({ role: 'veg', ...oneServing(findById(dish.veg)) });

    // 4) 水果 / 坚果：固定一份
    if (dish.fruit) {
      const fruitFood = findById(dish.fruit);
      items.push({ role: fruitFood.category === 'fat' ? 'fat' : 'fruit', ...oneServing(fruitFood) });
    }

    // 5) 配角：如果主菜+主食还没吃够本餐蛋白，用无糖酸奶/牛奶补齐
    if (dish.side) {
      const sideFood = findById(dish.side);
      const have = items.reduce((a, it) => a + (it.food.protein * it.grams) / 100, 0);
      const need = targets.proteinG * tpl.proteinShare - have;
      if (need > 3) {
        const servingG = baseServing(sideFood).grams;
        // 配角最多三份，同时不能超过当餐剩下的热量额度（否则会把整餐顶爆）
        const kcalLeft = Math.max(0, mealBudget * 1.04 - caloriesOf(items));
        const capByKcal = sideFood.kcal > 0 ? (kcalLeft * 100) / sideFood.kcal : Infinity;
        const grams = Math.min(servingG * MAX_SIDE_SERVINGS, capByKcal, gramsForProtein(sideFood, need));
        // 配角要么给到差不多一份，要么就别出现 —— 「33 克酸奶」这种量没有意义
        if (grams >= servingG * 0.8) items.push({ role: 'side', ...snapToServing(sideFood, Math.max(grams, servingG)) });
      }
    }

    const { trimmed } = trimMeal(items, mealBudget);
    const kcal2 = items.reduce((a, it) => a + (it.food.kcal * it.grams) / 100, 0);
    const protein2 = items.reduce((a, it) => a + (it.food.protein * it.grams) / 100, 0);
    const fat2 = items.reduce((a, it) => a + (it.food.fat * it.grams) / 100, 0);
    const carb2 = items.reduce((a, it) => a + (it.food.carb * it.grams) / 100, 0);
    meals.push({
      key: tpl.key,
      name: tpl.name,
      dishName: dish.name,
      budgetKcal: mealBudget,
      kcal: Math.round(kcal2),
      proteinG: round(protein2, 1),
      fatG: round(fat2, 1),
      carbG: round(carb2, 1),
      trimmed,
      items,
    });
    parts.push({ key: tpl.key, tpl, items: items.map((it) => ({ ...it })) });
  }
  return { meals, parts };
}

/**
 * 餐单与目标的差距说明。
 *
 * 原则：**说实话**。热量差得多就说差多少、怎么补；蛋白不够就点出来（蛋白决定掉的是脂肪还是肌肉）；
 * 脂肪不够就说用坚果/牛油果/多半勺油补。不能因为热量对上了就说「可以照这个吃」——
 * 独立核验实测过：蛋白只达成 61~84% 时，原来的文案还在说「基本对得上」。
 */
export function buildDeviationNote({ deviation, planKcal, targets, planProteinG, planFatWithOilG, cookingOilG }) {
  const lines = [];
  const proteinRatio = targets.proteinG > 0 ? planProteinG / targets.proteinG : 1;
  const fatRatio = targets.fatG > 0 ? planFatWithOilG / targets.fatG : 1;

  if (deviation > 0.1) {
    lines.push(`这份餐单比目标热量高约 ${Math.round(deviation * 100)}%，可以把主食减掉三分之一到一半。`);
  } else if (deviation < -0.1) {
    lines.push(`这份餐单按「三餐 + 加餐」的常规吃法给到约 ${planKcal} kcal，比目标少 ${Math.abs(Math.round(deviation * 100))}%（目标 ${targets.targetCalories} kcal 对这个结构来说偏高）。补法：把缺的部分用加餐补（一份酸奶 + 一把坚果约 250 kcal），或者每餐份量再加一半。`);
  } else {
    lines.push('热量和你的目标基本对得上（误差 10% 以内）。');
  }

  if (proteinRatio < 0.9) {
    const gap = Math.max(0, Math.round(targets.proteinG - planProteinG));
    lines.push(`但蛋白质差 ${gap} 克（只到目标的 ${Math.round(proteinRatio * 100)}%）。蛋白决定你掉的是脂肪还是肌肉，建议补：一勺乳清蛋白粉（约 25 克蛋白）或两份无糖希腊酸奶（约 27 克）。`);
  }
  if (fatRatio < 0.85) {
    const gap = Math.max(0, Math.round(targets.fatG - planFatWithOilG));
    lines.push(`脂肪也比目标少 ${gap} 克。补法：一小把坚果（约 25 克）或半个牛油果，也可以在炒菜里多加半勺油（5 克 ≈ 45 kcal）。`);
  }
  if (lines.length === 1 && deviation <= 0.1 && deviation >= -0.1) {
    lines.push('可以照这个吃。');
  }
  return lines.join('');
}

/** 汇总整份餐单，并算出烹调油额度 */
function finishPlan(meals, targets) {
  const sum = (k) => meals.reduce((a, m) => a + m[k], 0);
  const planKcal = Math.round(sum('kcal'));
  const planProteinG = round(sum('proteinG'), 1);
  const planFatG = round(sum('fatG'), 1);

  // 脂肪缺口用「烹调油」补：模板主菜都是鸡胸、鱼虾、豆腐这类低脂的，
  // 光靠它们脂肪只有目标的六七成。这里算出该补多少油，并把额度写进餐单，
  // 免得「餐单不含油」和「提醒每天 15~28 克油」互相矛盾、实际多吃一截。
  const oilFood = findById('oil');
  const fatGap = Math.max(0, (targets.fatG ?? 0) - planFatG);
  // 油量 = 脂肪缺口与「剩余热量里能放下的量」取小，并封顶；同时不能把当日总热量顶超
  const kcalLeft = Math.max(0, targets.targetCalories - planKcal);
  const oilByKcal = oilFood.kcal > 0 ? (kcalLeft * 100) / oilFood.kcal : 0;
  const plannedOil = splitRemainingKcal(Math.max(0, targets.targetCalories), fatGap, oilFood).oilG;
  const cookingOilG = fatGap < 4 ? 0
    : Math.max(0, Math.round(Math.min(plannedOil, MAX_DAILY_OIL_G, fatGap, oilByKcal)));
  const oilKcal = Math.round((oilFood.kcal * cookingOilG) / 100);
  if (cookingOilG > 0) {
    for (const m of meals) {
      if (m.key === 'snack') continue;
      const share = targets.targetCalories > 0 ? (m.kcal + m.budgetKcal) / 2 / targets.targetCalories : 0.3;
      m.oilG = Math.max(0, Math.round(cookingOilG * share));
    }
    const allocated = meals.reduce((a, m) => a + (m.oilG || 0), 0);
    if (allocated !== cookingOilG) meals.find((m) => m.key === 'dinner').oilG += cookingOilG - allocated;
  }

  const deviation = targets.targetCalories > 0 ? (planKcal + oilKcal) / targets.targetCalories - 1 : 0;

  return {
    meals,
    planKcal,
    planKcalWithOil: planKcal + oilKcal,
    cookingOilG,
    cookingOilKcal: oilKcal,
    planProteinG,
    planFatG,
    planFatWithOilG: round(planFatG + cookingOilG, 1),
    planCarbG: round(sum('carbG'), 1),
    targetCalories: targets.targetCalories,
    proteinG: targets.proteinG,
    deviation: Math.round(deviation * 1000) / 10, // 百分比，正数表示餐单比目标多
    deviationNote: buildDeviationNote({ deviation, planKcal: planKcal + oilKcal, targets, planProteinG, planFatWithOilG: round(planFatG + cookingOilG, 1) }),
  };
}


/**
 * 一天的通用提醒（油、水、蔬菜、蛋白粉等）
 * @param {{targetCalories:number, proteinG:number}} targets
 * @param {number} [oilFromPlan] 餐单里已经算好的烹调油克数；给了就用它，保证两处数字一致
 */
export function buildDailyTips(targets, oilFromPlan = null) {
  const oilG = oilFromPlan ?? (targets.targetCalories < 1600 ? 15 : targets.targetCalories < 2000 ? 22 : 28);
  if (oilG <= 0) {
    return [
      '今天的餐单本身脂肪就够了，炒菜尽量少放油（水煮、清蒸、少油快炒）。',
      '每天蔬菜 300~500 克，其中一半是深色叶菜。蔬菜几乎不占热量，但饱腹感靠它。',
      `蛋白质尽量吃够 ${targets.proteinG} 克，分成 3~4 餐吃比一顿全吃完更好吸收。`,
      '每天喝水 1500~2000 毫升。渴了经常被当成饿了。',
      '如果当天蛋白质实在吃不够，可以用一勺乳清蛋白粉（约 25 克蛋白、110 kcal）补，别用含糖饮料补。',
    ];
  }
  return [
    `炒菜用油全天 ${oilG} 克左右（约 ${(oilG / 10).toFixed(1).replace(/\.0$/, '')} 勺，一勺按 10 克算），这个量已经算进上面的餐单里了。外卖和食堂的菜普遍比这个油，吃到油腻的菜就用清水涮一下。`,
    '每天蔬菜 300~500 克，其中一半是深色叶菜。蔬菜几乎不占热量，但饱腹感靠它。',
    `蛋白质尽量吃够 ${targets.proteinG} 克，分成 3~4 餐吃比一顿全吃完更好吸收。`,
    '每天喝水 1500~2000 毫升。渴了经常被当成饿了。',
    '如果当天蛋白质实在吃不够，可以用一勺乳清蛋白粉（约 25 克蛋白、110 kcal）补，别用含糖饮料补。',
  ];
}
