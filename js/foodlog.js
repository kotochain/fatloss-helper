/**
 * 记录本（吃了什么、练了什么）的纯逻辑部分。
 * 不碰界面，也不直接碰 localStorage —— 由 app.js 负责存盘，这样测试起来方便。
 */

import { FOODS, ALIASES } from './foods.js';
import { calcEntry, round } from './calc.js';

export const MEAL_SLOTS = [
  { key: 'breakfast', label: '早餐' },
  { key: 'lunch', label: '午餐' },
  { key: 'dinner', label: '晚餐' },
  { key: 'snack', label: '加餐' },
];

/** 去掉空格、括号等干扰，方便匹配 */
export function normalize(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[\s()（）【】\[\]·・,，。.、!！?？]/g, '');
}

/**
 * 搜索食物
 * @param {string} query
 * @param {Array} customFoods 自定义食物（会一起搜）
 * @param {number} limit
 */
export function searchFoods(query, customFoods = [], limit = 30) {
  const q = normalize(query);
  const all = [...customFoods, ...FOODS];
  if (!q) return all.slice(0, limit);

  const scored = [];
  for (const food of all) {
    const name = normalize(food.name);
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;

    const aliases = ALIASES[food.id] || [];
    for (const a of aliases) {
      const na = normalize(a);
      if (na === q) score = Math.max(score, 90);
      else if (na.includes(q) || q.includes(na)) score = Math.max(score, 55);
    }
    if (food.category && normalize(food.category).includes(q)) score = Math.max(score, 20);
    // 中文没有「按词匹配」的概念，这里只用「查询里的每个字都出现过」兜底
    if (score === 0 && q.length >= 2 && [...q].every((ch) => name.includes(ch))) score = 30;

    if (score > 0) scored.push({ food, score });
  }
  scored.sort((a, b) => b.score - a.score || a.food.name.length - b.food.name.length);
  return scored.slice(0, limit).map((s) => s.food);
}

/** 该餐已经吃了多少 */
export function mealTotals(entries, mealKey) {
  const list = entries.filter((e) => e.meal === mealKey);
  return list.reduce(
    (acc, e) => {
      const f = calcEntry(e.food, e.grams);
      acc.kcal += f.kcal;
      acc.protein += f.protein;
      acc.fat += f.fat;
      acc.carb += f.carb;
      acc.count += 1;
      return acc;
    },
    { kcal: 0, protein: 0, fat: 0, carb: 0, count: 0 },
  );
}

export function calculateTotals(entries) {
  const totals = entries.reduce(
    (acc, e) => {
      const f = calcEntry(e.food, e.grams);
      acc.kcal += f.kcal;
      acc.protein += f.protein;
      acc.fat += f.fat;
      acc.carb += f.carb;
      return acc;
    },
    { kcal: 0, protein: 0, fat: 0, carb: 0 },
  );
  return {
    kcal: round(totals.kcal, 1),
    protein: round(totals.protein, 1),
    fat: round(totals.fat, 1),
    carb: round(totals.carb, 1),
  };
}

const MEAL_ORDER = { breakfast: 0, lunch: 1, dinner: 2, snack: 3 };

export function groupByMeal(entries) {
  return MEAL_SLOTS.map((slot) => ({
    ...slot,
    entries: entries
      .filter((e) => e.meal === slot.key)
      .sort((a, b) => (MEAL_ORDER[a.meal] - MEAL_ORDER[b.meal]) || String(a.createdAt).localeCompare(String(b.createdAt))),
    totals: mealTotals(entries, slot.key),
  }));
}

/** 一餐吃掉的份量对应的评价（吃得够不够蛋白、热量超标没） */
export function entryWarnings(entry) {
  const f = calcEntry(entry.food, entry.grams);
  const out = [];
  if (entry.grams > 800) out.push('这一份超过 800 克，看看是不是把「克」和「斤/两」搞混了。');
  if (f.kcal > 1200) out.push('单次超过 1200 kcal，确认一下份量。');
  return out;
}

/** 常用食物：按出现次数排序，用来做「最近吃过」快捷入口 */
export function frequentFoods(state, limit = 8) {
  const counter = new Map();
  const dates = Object.keys(state.days || {}).sort().reverse();
  for (const d of dates) {
    for (const e of state.days[d] || []) {
      const key = e.food.id;
      const cur = counter.get(key) || { food: e.food, count: 0, grams: e.grams };
      cur.count += 1;
      cur.grams = e.grams;
      counter.set(key, cur);
    }
  }
  return [...counter.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
