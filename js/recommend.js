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
      { name: '鸡胸肉 + 米饭 + 西兰花', protein: ['chicken_breast'], ratio: [1], carb: 'rice_cooked', veg: 'broccoli', side: null },
      { name: '牛里脊 + 米饭 + 炒青菜', protein: ['beef_lean'], ratio: [1], carb: 'rice_cooked', veg: 'stirfry_greens', side: null },
      { name: '虾 + 红薯 + 西兰花', protein: ['shrimp'], ratio: [1], carb: 'sweet_potato', veg: 'broccoli', side: null },
      { name: '巴沙鱼 + 米饭 + 番茄', protein: ['white_fish'], ratio: [1], carb: 'rice_cooked', veg: 'tomato', side: null },
    ],
  },
  {
    key: 'dinner',
    name: '晚餐',
    calorieShare: 0.30,
    proteinShare: 0.28,
    dishes: [
      { name: '鸡胸肉 + 北豆腐 + 米饭 + 小白菜', protein: ['chicken_breast', 'tofu_firm'], ratio: [0.55, 0.45], carb: 'rice_cooked', veg: 'bokchoy', side: null },
      { name: '三文鱼 + 藜麦 + 黄瓜生菜', protein: ['salmon'], ratio: [1], carb: 'quinoa_cooked', veg: 'cucumber', side: null },
      { name: '鸡腿肉（去皮）+ 土豆 + 香菇', protein: ['chicken_thigh'], ratio: [1], carb: 'potato', veg: 'mushroom', side: null },
      { name: '牛肉 + 米粉 + 大白菜', protein: ['beef_lean'], ratio: [1], carb: 'rice_noodle', veg: 'chinese_cabbage', side: null },
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
 * 生成一天的餐单
 * @param {{targetCalories:number, proteinG:number}} targets
 * @param {{seed?:number}} options seed 换一天就换一批菜
 */
export function buildMealPlan(targets, options = {}) {
  const seed = options.seed ?? 0;
  const meals = [];

  for (const tpl of MEAL_TEMPLATES) {
    const dish = tpl.dishes[seed % tpl.dishes.length];
    const items = [];

    // 1) 主菜：按比例吃掉本餐的蛋白质名额（可能有多样，比如鸡胸 + 豆腐）
    const sumRatio = dish.ratio.reduce((a, b) => a + b, 0);
    if (Math.abs(sumRatio - 1) > 0.001) {
      throw new Error(`${tpl.name} 的 protein 比例之和不是 1：${JSON.stringify(dish.ratio)}`);
    }
    const mealBudget = Math.round(targets.targetCalories * tpl.calorieShare);
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
      const floorG = Math.min(gByProtein * MAIN_PROTEIN_MIN_FACTOR, grams);
      if (grams < floorG) grams = floorG;
      const item = snapToServing(food, grams);
      item.role = 'protein';
      item.targetGrams = Math.round(grams);
      item.targetProteinG = round(proteinTarget, 1);
      item.clampedBy = clampedBy;
      if (clampedBy) {
        item.desc += `，这已经是给当餐留出主食后的上限`;
      }
      item.proteinGiven = round((food.protein * item.grams) / 100, 1);
      items.push(item);
    }

    // 2) 主食：用掉本餐剩下的热量额度
    if (dish.carb) {
      const carbFood = findById(dish.carb);
      const usedKcal = caloriesOf(items);
      const budget = mealBudget - usedKcal;
      if (carbFood.kcal <= 0) throw new Error(`${carbFood.name} 没有热量，不能当主食`);
      // 主食最少给 0.4 份，但绝不因此把整餐顶爆（份额不够时按额度给）
      const floorByServing = carbFood.servings[0][1] * 0.4;
      const grams = Math.max(Math.min(floorByServing, (budget * 100) / carbFood.kcal), (budget * 100) / carbFood.kcal);
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
        const grams = Math.min(servingG * 3, capByKcal, gramsForProtein(sideFood, need));
        if (grams >= 20) items.push({ role: 'side', ...snapToServing(sideFood, grams) });
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
  }

  const sum = (k) => meals.reduce((a, m) => a + m[k], 0);
  const planKcal = Math.round(sum('kcal'));
  const planProteinG = round(sum('proteinG'), 1);
  const deviation = targets.targetCalories > 0 ? planKcal / targets.targetCalories - 1 : 0;

  return {
    meals,
    planKcal,
    planProteinG,
    planFatG: round(sum('fatG'), 1),
    planCarbG: round(sum('carbG'), 1),
    targetCalories: targets.targetCalories,
    proteinG: targets.proteinG,
    deviation: Math.round(deviation * 1000) / 10, // 百分比，正数表示餐单比目标多
    deviationNote:
      deviation > 0.1
        ? '这份餐单比目标热量高一些，可以把主食减掉三分之一到一半。'
        : deviation < -0.1
          ? '这份餐单比目标热量低一些，主食可以多加一点。'
          : '这份餐单和你的目标基本对得上（误差 10% 以内），可以照这个吃。',
  };
}

/** 一天的通用提醒（油、水、蔬菜、蛋白粉等），按目标热量给量 */
export function buildDailyTips(targets) {
  const oilG = targets.targetCalories < 1600 ? 15 : targets.targetCalories < 2000 ? 22 : 28;
  return [
    `炒菜用油全天控制在 ${oilG} 克左右（约 ${oilG <= 15 ? '一勺半' : '两勺'}）。外卖和食堂的菜普遍比这个油，吃到油腻的菜就用清水涮一下。`,
    '每天蔬菜 300~500 克，其中一半是深色叶菜。蔬菜几乎不占热量，但饱腹感靠它。',
    `蛋白质尽量吃够 ${targets.proteinG} 克，分成 3~4 餐吃比一顿全吃完更好吸收。`,
    '每天喝水 1500~2000 毫升。渴了经常被当成饿了。',
    '如果当天蛋白质实在吃不够，可以用一勺乳清蛋白粉（约 25 克蛋白、110 kcal）补，别用含糖饮料补。',
  ];
}
