/**
 * 「成长回顾」（v38，issue #14 的 C）
 *
 * 目的：一周小结（achievements.weeklyReview）看的是最近 7 天，**看不到更长的变化**。
 * 这里给最近 30 天的回顾：记了几天、最长连续、蛋白达标几天、体重趋势、最常吃的东西、运动。
 *
 * 设计约束（别改坏）：
 *  - **只陈述事实**：不评判、不施压（不出现「你应该」「吃多了」「失败」）；
 *  - **体重只报趋势**：明确写「单次波动不用当真」，也不庆祝掉秤快（那是鼓励节食）；
 *  - **数据不够就直说**：没记录时给「先从记几天开始」，不编数字；
 *  - 纯函数、只读存档，Node 可测。
 */
import { sumEntries } from './calc.js';
import { longestStreak, currentStreak } from './achievements.js';
import { shiftDate, todayKey } from './store.js';

/** 某天有内容的条目（只读，不新建空日子） */
function entriesOf(state, key) {
  const day = state?.days?.[key];
  if (!day?.meals) return [];
  return Object.values(day.meals).flat();
}

/**
 * 最近 30 天的回顾数据。
 *
 * @param {{state:object, targets:{proteinG:number,targetCalories:number}, today?:string, days?:number}} input
 */
export function buildRecap({ state, targets, today = todayKey(), days = 30 } = {}) {
  const span = Math.max(7, Math.min(90, Math.round(days)));
  const from = shiftDate(today, -(span - 1));
  const keys = [];
  for (let i = 0; i < span; i++) keys.push(shiftDate(from, i));

  const dayRows = keys.map((key) => {
    const entries = entriesOf(state, key);
    const totals = sumEntries(entries);
    const day = state?.days?.[key];
    const exerciseMin = (day?.exercises || []).reduce((a, x) => a + (Number(x.minutes) || 0), 0);
    const weight = (state?.weights || []).find((w) => w.date === key) || null;
    return { key, entries, totals, exerciseMin, weight };
  }).filter((r) => r.entries.length > 0 || r.exerciseMin > 0);

  const loggedDays = dayRows.length;
  const totalEntries = dayRows.reduce((a, r) => a + r.entries.length, 0);
  const proteinTarget = Math.max(0, Number(targets?.proteinG) || 0);
  const proteinHitDays = proteinTarget > 0
    ? dayRows.filter((r) => r.totals.protein >= proteinTarget).length
    : 0;
  const exerciseDays = dayRows.filter((r) => r.exerciseMin > 0).length;
  const exerciseMinutes = Math.round(dayRows.reduce((a, r) => a + r.exerciseMin, 0));
  const kcalDays = dayRows.filter((r) => r.entries.length > 0);
  const avgKcal = kcalDays.length
    ? Math.round(kcalDays.reduce((a, r) => a + r.totals.kcal, 0) / kcalDays.length)
    : 0;

  // 体重：只看窗口内第一笔和最后一笔；不足两笔就不给「变化」，只给数字
  const weights = (state?.weights || [])
    .filter((w) => w.date >= from && w.date <= today && Number.isFinite(Number(w.kg)))
    .sort((a, b) => a.date.localeCompare(b.date));
  const weight = weights.length >= 2
    ? {
      start: Number(weights[0].kg),
      end: Number(weights[weights.length - 1].kg),
      deltaKg: Math.round((Number(weights[weights.length - 1].kg) - Number(weights[0].kg)) * 10) / 10,
      measuredDays: weights.length,
    }
    : weights.length === 1
      ? { start: Number(weights[0].kg), end: Number(weights[0].kg), deltaKg: 0, measuredDays: 1 }
      : null;

  // 最常吃的东西（按次数，同 id 优先；没有 id 时用名字）
  const counter = new Map();
  for (const r of dayRows) {
    for (const e of r.entries) {
      const food = e.food || {};
      const key = food.id || food.name || '(无名)';
      const cur = counter.get(key) || { name: food.name || '(无名)', times: 0, grams: 0 };
      cur.times += 1;
      cur.grams += Number(e.grams) || 0;
      counter.set(key, cur);
    }
  }
  const topFoods = [...counter.values()]
    .sort((a, b) => b.times - a.times || b.grams - a.grams)
    .slice(0, 3)
    .map((f) => ({ name: f.name, times: f.times, grams: Math.round(f.grams) }));

  return {
    days: span,
    from,
    to: today,
    loggedDays,
    totalEntries,
    proteinTarget,
    proteinHitDays,
    exerciseDays,
    exerciseMinutes,
    avgKcal,
    weight,
    topFoods,
    longestStreak: longestStreak(state, today),
    currentStreak: currentStreak(state, today),
    enough: loggedDays >= 3,
  };
}

/**
 * 把回顾数据变成给人看的几句话（最多 3 条）。
 * 不评判、不施压；体重只报趋势并注明单次不算数。
 */
export function recapLines(recap) {
  if (!recap || !recap.enough) {
    return ['先记上几天（3 天就够）再回来看看 —— 有数据才谈得上回顾。'];
  }
  const lines = [];
  lines.push(`这 ${recap.days} 天里，你有 ${recap.loggedDays} 天记了东西，一共 ${recap.totalEntries} 笔。`);
  if (recap.proteinTarget > 0) {
    const ratio = Math.round((recap.proteinHitDays / recap.loggedDays) * 100);
    lines.push(recap.proteinHitDays > 0
      ? `蛋白质吃到目标的 ${recap.proteinHitDays} 天，占记录天数的 ${ratio}%；没吃够的那些天也很正常，下一餐顺手补一点就行。`
      : '蛋白质还没怎么吃到目标，不用急 —— 早餐加个蛋、午餐主菜选肉，比硬撑更容易坚持。');
  }
  if (recap.weight && recap.weight.measuredDays >= 2) {
    const d = recap.weight.deltaKg;
    const sign = d > 0 ? '+' : '';
    lines.push(`体重从 ${recap.weight.start} kg 到 ${recap.weight.end} kg（${sign}${d} kg）—— 看趋势就行，单次波动不用当真。`);
  } else if (recap.topFoods.length) {
    const top = recap.topFoods[0];
    lines.push(`最常记的是「${top.name}」（${top.times} 次），这没什么好坏，只是你自己的一面镜子。`);
  } else if (recap.exerciseDays > 0) {
    lines.push(`运动了 ${recap.exerciseDays} 天，一共 ${recap.exerciseMinutes} 分钟 —— 动过就算数。`);
  }
  if (recap.exerciseDays > 0 && lines.length < 3) {
    lines.push(`运动了 ${recap.exerciseDays} 天，一共 ${recap.exerciseMinutes} 分钟。`);
  }
  return lines.slice(0, 3);
}
