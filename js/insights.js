/**
 * 本地周洞察：从用户自己的记录里算出「规律」，不调用任何接口。
 *
 * 为什么要有这个：普通模式（不接 AI）跟 AI 模式的差别不该只是「说话笨一点」。
 * 数据里本来就有规律 —— 哪一餐吃够蛋白更容易达标、外卖日平均多多少、周末是不是吃得更多 ——
 * 这些用本地计算就能得出来，而且**比 AI 更可信**：数字是从用户自己的记录里数出来的，不是编的。
 *
 * 三条设计原则：
 *  1) **只讲行为，不评判**。「外卖日平均多 320 kcal」是事实；「你外卖吃太多了」是责备。
 *  2) **样本不够就不说话**。少于 4 天记录、或者两组里有一组不足 2 天，就不给这条洞察 ——
 *     宁可少说，也不要用 1 天的数据编出一个"规律"。
 *  3) **不把估算说成精确值**。所有数字都是「约」，且明确这是用户自己的记录算出来的。
 */

import { todayKey, shiftDate } from './store.js';
import { findFood } from './foods.js';

/** 一天至少要有这些热量才算「记了正餐」，避免只记一颗鸡蛋就算一天 */
const MIN_DAY_KCAL = 400;
/** 判断「吃够」时的容差：达标线上下 10% 都算 */
const HIT_TOLERANCE = 0.9;

export const INSIGHT_KINDS = {
  protein: '蛋白',
  calories: '热量',
  habit: '习惯',
  weight: '体重',
};

/* ── 取数 ─────────────────────────────────── */

/** 把最近 N 天的记录整理成每天一行的形式（只保留像样记录过的日子） */
function dayRows(state, days, today) {
  const rows = [];
  for (let i = 0; i < days; i++) {
    const key = shiftDate(today, -i);
    // 这里**不能**用 getDay()：它会「没有就新建」，于是光打开今天页就把最近 14 天
    // 全写进了存档，导致「数据与备份」显示「14 天的记录」（其实只记了 1 天），
    // 导出文件里也塞进 13 个空日子。看数据的地方必须是只读的。
    const day = state.days?.[key] || { meals: {}, exercises: [] };
    let kcal = 0;
    let protein = 0;
    let fat = 0;
    let carb = 0;
    let mealCount = 0;
    const foodIds = [];
    for (const [mealKey, list] of Object.entries(day.meals || {})) {
      const used = (list || []).filter((e) => e && e.food && e.grams > 0);
      if (used.length) mealCount += 1;
      for (const e of used) {
        const k = (e.food.kcal * e.grams) / 100;
        kcal += k;
        protein += (e.food.protein * e.grams) / 100;
        fat += (e.food.fat * e.grams) / 100;
        carb += (e.food.carb * e.grams) / 100;
        foodIds.push({ id: e.food.id, meal: mealKey, kcal: k });
      }
    }
    const exerciseMin = (day.exercises || []).reduce((a, x) => a + (x.minutes || 0), 0);
    rows.push({ date: key, kcal, protein, fat, carb, mealCount, exerciseMin, foodIds, logged: kcal >= MIN_DAY_KCAL });
  }
  return rows;
}

function avg(list) {
  if (!list.length) return 0;
  return list.reduce((a, x) => a + x, 0) / list.length;
}

/** 两组比较：只在两组样本都够的时候返回结论 */
function compare(groups, { minPerGroup = 2, minDiffKcal = 60 } = {}) {
  const [a, b] = groups;
  if (a.length < minPerGroup || b.length < minPerGroup) return null;
  const diff = avg(a.map((r) => r.kcal)) - avg(b.map((r) => r.kcal));
  if (Math.abs(diff) < minDiffKcal) return null;
  return { diff: Math.round(diff), aAvg: Math.round(avg(a.map((r) => r.kcal))), bAvg: Math.round(avg(b.map((r) => r.kcal))) };
}

/* ── 洞察 ─────────────────────────────────── */

/** 哪一餐吃够蛋白的日子，总热量更容易控制 */
function proteinInsight(rows, targets) {
  if (!targets?.proteinG) return null;
  const hit = [];
  const miss = [];
  for (const r of rows) {
    if (!r.logged) continue;
    if (r.protein >= targets.proteinG * HIT_TOLERANCE) hit.push(r);
    else miss.push(r);
  }
  if (hit.length < 2 || miss.length < 2) return null;

  const hitAvg = Math.round(avg(hit.map((r) => r.kcal)));
  const missAvg = Math.round(avg(miss.map((r) => r.kcal)));
  const diff = hitAvg - missAvg;
  if (Math.abs(diff) < 80) return null;

  return {
    kind: 'protein',
    icon: 'egg',
    title: diff < 0 ? '吃够蛋白的日子，总热量反而更低' : '吃够蛋白的日子吃得更多',
    detail: diff < 0
      ? `你有 ${hit.length} 天吃够了蛋白，平均 ${hitAvg} kcal；另外 ${miss.length} 天没吃够，平均 ${missAvg} kcal —— 差了约 ${Math.abs(diff)} kcal。蛋白顶饱，这个规律很常见。`
      : `你有 ${hit.length} 天吃够了蛋白，平均 ${hitAvg} kcal；另外 ${miss.length} 天没吃够，平均 ${missAvg} kcal。差距不大，蛋白主要还是影响你掉的是脂肪还是肌肉。`,
    days: hit.length + miss.length,
  };
}

/** 运动日 vs 不运动日 */
function exerciseInsight(rows) {
  const withEx = rows.filter((r) => r.logged && r.exerciseMin > 0);
  const without = rows.filter((r) => r.logged && r.exerciseMin === 0);
  const c = compare([withEx, without], { minPerGroup: 2, minDiffKcal: 100 });
  if (!c) return null;
  return {
    kind: 'habit',
    icon: 'run',
    title: c.diff > 0 ? '运动日你会多吃一些' : '运动日你反而没多吃',
    detail: `运动日平均 ${c.aAvg} kcal（${withEx.length} 天），不运动的日子平均 ${c.bAvg} kcal（${without.length} 天），差约 ${Math.abs(c.diff)} kcal。${
      c.diff > 0 ? '运动后饿是正常的，只要总缺口还在就没问题。' : '这是好事 —— 运动的热量没有被吃回去。'
    }`,
    days: withEx.length + without.length,
  };
}

/** 最大的热量来源（按食物聚合） */
function topSourceInsight(rows, days) {
  const logged = rows.filter((r) => r.logged);
  if (logged.length < 4) return null;
  const byFood = new Map();
  for (const r of logged) {
    for (const x of r.foodIds) {
      byFood.set(x.id, (byFood.get(x.id) || 0) + x.kcal);
    }
  }
  const ranked = [...byFood.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [id, total] = ranked[0];
  const food = findFood(id);
  if (!food) return null;
  const perDay = Math.round(total / logged.length);
  const share = Math.round((total / logged.reduce((a, r) => a + r.kcal, 0)) * 100);
  if (share < 15) return null;
  return {
    kind: 'calories',
    icon: 'search',
    title: `${food.name}是你这几天的热量大头`,
    detail: `最近 ${logged.length} 天里，${food.name}平均每天贡献约 ${perDay} kcal，占你总摄入的 ${share}%。${
      share >= 30 ? '不是让你别吃 —— 是这个量值得看一眼，份量差一点影响挺大。' : '想减总量的话，从这里调最省力。'
    }`,
    days: logged.length,
  };
}

/** 周末 vs 工作日 */
function weekendInsight(rows) {
  const weekend = [];
  const weekday = [];
  for (const r of rows) {
    if (!r.logged) continue;
    const dow = new Date(`${r.date}T12:00:00`).getDay();
    (dow === 0 || dow === 6 ? weekend : weekday).push(r);
  }
  const c = compare([weekend, weekday], { minPerGroup: 2, minDiffKcal: 150 });
  if (!c) return null;
  return {
    kind: 'habit',
    icon: 'calendar',
    title: c.diff > 0 ? '周末比工作日吃得多一些' : '周末比工作日吃得少',
    detail: `周末平均 ${c.aAvg} kcal（${weekend.length} 天），工作日平均 ${c.bAvg} kcal（${weekday.length} 天），差约 ${Math.abs(c.diff)} kcal。${
      c.diff > 0 ? '这很常见。知道差多少，就能提前安排 —— 比如周末留出一顿想吃的，别的地方收一点。' : ''
    }`,
    days: weekend.length + weekday.length,
  };
}

/** 吃饭的规律程度 */
function rhythmInsight(rows) {
  const logged = rows.filter((r) => r.logged);
  if (logged.length < 4) return null;
  const meals = logged.map((r) => r.mealCount);
  const fullDays = meals.filter((m) => m >= 3).length;
  if (fullDays / logged.length >= 0.8) {
    return {
      kind: 'habit',
      icon: 'bowl',
      title: '你大部分日子三餐都记全了',
      detail: `${logged.length} 天里有 ${fullDays} 天记满三餐。这种记录最有参考价值 —— 漏记一餐会让总热量看起来偏低，容易误判。`,
      days: logged.length,
    };
  }
  const light = logged.filter((r) => r.mealCount <= 1).length;
  if (light >= 2) {
    return {
      kind: 'habit',
      icon: 'note',
      title: '有些日子只记了一餐',
      detail: `${logged.length} 天里有 ${light} 天只记了一餐。只记一餐的话，总热量会显得比实际低 —— 不是让你记全，是提醒你别被那个数字骗了。`,
      days: logged.length,
    };
  }
  return null;
}

/** 体重趋势（只在真的称了两次以上时说话） */
function weightInsight(state, days, targets) {
  const weights = (state.weights || []).filter((w) => w && w.kg > 0);
  if (weights.length < 2) return null;
  const sorted = [...weights].sort((a, b) => (a.date < b.date ? -1 : 1));
  const recent = sorted.filter((w) => w.date >= shiftDate(todayKey(), -days));
  if (recent.length < 2) return null;

  const first = recent[0];
  const last = recent[recent.length - 1];
  const change = Math.round((last.kg - first.kg) * 10) / 10;
  const spanDays = Math.max(1, Math.round((new Date(`${last.date}T12:00:00`) - new Date(`${first.date}T12:00:00`)) / 86400000));
  const weekly = Math.round((change / spanDays) * 7 * 100) / 100;

  if (Math.abs(change) < 0.3) {
    return {
      kind: 'weight',
      icon: 'scale',
      title: '体重基本没动',
      detail: `最近 ${spanDays} 天称了 ${recent.length} 次，变化不到 0.3 kg。这个时间跨度太短、正常波动就有这么大 —— 别看单次数字，看两周以上的趋势。`,
      days: recent.length,
    };
  }
  const fast = Math.abs(weekly) > 1;
  return {
    kind: 'weight',
    icon: 'scale',
    title: change < 0 ? `体重在往下走（约每周 ${Math.abs(weekly)} kg）` : `体重在往上走（约每周 ${Math.abs(weekly)} kg）`,
    detail: `最近 ${spanDays} 天从 ${first.kg} kg 到 ${last.kg} kg。${
      change < 0
        ? (fast ? '这个速度偏快，掉得太快容易掉肌肉 —— 建议把每餐主食加一点。' : '这个速度是健康的，继续。')
        : '涨了不一定是脂肪 —— 含水量、生理期、吃得咸都会让秤上的数字变大。连着两三周往上走才值得调整。'
    }`,
    days: recent.length,
  };
}

/* ── 对外 ─────────────────────────────────── */

/**
 * 从记录里算出洞察。
 * @param {object} state 存档
 * @param {{proteinG?:number, targetCalories?:number, days?:number, today?:string}} options
 * @returns {Array<{kind:string, icon:string, title:string, detail:string, days:number}>}
 */
export function insights(state, options = {}) {
  const days = options.days ?? 14;
  const today = options.today ?? todayKey();
  if (!state) return [];
  const rows = dayRows(state, days, today);
  const logged = rows.filter((r) => r.logged);
  // 少于 4 天有意义的记录就不说话 —— 数据不够时编出来的"规律"是害人的
  if (logged.length < 4) return [];

  const candidates = [
    proteinInsight(rows, options),
    exerciseInsight(rows),
    topSourceInsight(rows, days),
    weekendInsight(rows),
    rhythmInsight(rows),
    weightInsight(state, days, options),
  ];
  return candidates.filter(Boolean);
}

/** 数据还不够时，告诉用户再记几天就能看到规律（不给假结论） */
export function insightHint(state, options = {}) {
  const days = options.days ?? 14;
  const today = options.today ?? todayKey();
  const rows = dayRows(state, days, today);
  const logged = rows.filter((r) => r.logged).length;
  if (logged >= 4) return null;
  return {
    need: 4 - logged,
    text: logged === 0
      ? '记满 4 天，这里就会开始出现「你自己的规律」（不是通用建议）。'
      : `再记 ${4 - logged} 天，就能看出你的规律了。`,
  };
}

export { dayRows as _dayRows, MIN_DAY_KCAL };
