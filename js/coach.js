/**
 * AI 教练的「本地那一半」：所有数字都在这里算好，AI 只负责措辞。
 *
 * 为什么这么拆（这是整个项目的底线）：
 *  - 数字由模型算，就会和记录对不上，也没法核对、没法离线复算；
 *  - 所以给 AI 的输入是一份**已经算好的事实清单**，AI 的输出还要再过一道数字校验：
 *    出现任何不在清单里的数字，就整段退回本地版。
 *
 * 普通模式（不接 AI）不是「残废版」：localCoachAdvice() 给的建议本身就能用，
 * AI 只是把同一件事说得更像人话（issue #2 的原则）。
 */

import { calcEntry, diffAgainstTargets } from './calc.js';
import { findFood } from './foods.js';
import { shiftDate } from './store.js';

/** 一天至少吃到这些热量才算「这天记了」，跟 insights.js 的口径一致 */
const MIN_DAY_KCAL = 400;

/**
 * 补蛋白时优先推荐的食物（按常见、好买、蛋白密度高挑的）。
 * 用 id 引用食物库，克数和热量全部从库里现算，不在文案里写死。
 */
export const COACH_FOOD_IDS = [
  'chicken_breast_cooked', 'tuna_can', 'shrimp_cooked', 'white_fish_cooked', 'beef_lean_cooked',
  'greek_yogurt', 'tofu_firm', 'edamame', 'egg',
];

function roundInt(n) {
  return Math.round(Number(n) || 0);
}

function dayEntries(day) {
  if (!day?.meals) return [];
  return Object.values(day.meals).flat();
}

function dayTotals(day) {
  return dayEntries(day).reduce((acc, e) => {
    const f = calcEntry(e.food, e.grams);
    acc.kcal += f.kcal;
    acc.protein += f.protein;
    acc.fat += f.fat;
    acc.carb += f.carb;
    return acc;
  }, { kcal: 0, protein: 0, fat: 0, carb: 0 });
}

/**
 * 最近几天的概况（只读，绝不新建空日子 —— 打开一次教练就往存档写 7 天是事故）。
 * @returns {{days:number, logged:number, avgKcal:number, over:number, under:number, onTarget:number}}
 */
export function recentStats(state, today, { days = 7, targetKcal = 0 } = {}) {
  let logged = 0;
  let kcalSum = 0;
  let over = 0;
  let under = 0;
  let onTarget = 0;
  for (let i = 0; i < days; i++) {
    const key = shiftDate(today, -i);
    const day = state?.days?.[key];
    if (!day) continue;
    const totals = dayTotals(day);
    if (totals.kcal < MIN_DAY_KCAL) continue;
    logged += 1;
    kcalSum += totals.kcal;
    if (!targetKcal) continue;
    if (totals.kcal > targetKcal * 1.05) over += 1;
    else if (totals.kcal < targetKcal * 0.8) under += 1;
    else onTarget += 1;
  }
  return {
    days,
    logged,
    avgKcal: logged ? Math.round(kcalSum / logged) : 0,
    over,
    under,
    onTarget,
  };
}

/**
 * 按「蛋白缺口 + 剩余额度」挑 1~2 样具体食物。
 * 原则：先补蛋白、别超出今天的额度、份量给整数（50/100/150 克这种用户能称的量）。
 */
export function suggestFoods({ remainingKcal, proteinGap }) {
  if (!(proteinGap >= 5) || !(remainingKcal >= 60)) return [];
  const out = [];
  let gap = proteinGap;
  let budget = remainingKcal;
  const cands = COACH_FOOD_IDS
    .map((id) => findFood(id))
    .filter(Boolean)
    // 蛋白密度高的优先（同样额度能补更多蛋白）
    .sort((a, b) => b.protein / b.kcal - a.protein / a.kcal);

  for (const f of cands) {
    if (gap < 8 || budget < 60) break;
    // 上限按「用户自己的一份 × 2」：金枪鱼一罐 120 克，劝用户吃 300 克是不现实的
    const serving = f.servings?.[0]?.[1] || 100;
    const cap = Math.max(100, Math.min(300, serving * 2));
    const gramsForGap = Math.ceil((gap / f.protein) * 100 / 10) * 10;
    const gramsByBudget = Math.floor((budget / f.kcal) * 100 / 10) * 10;
    const grams = Math.min(gramsForGap, gramsByBudget, cap);
    if (grams < 50) continue;
    const got = calcEntry(f, grams);
    const protein = Math.round(got.protein);
    if (protein < 5) continue;
    out.push({ name: f.name, grams, kcal: roundInt(got.kcal), protein });
    gap -= protein;
    budget -= got.kcal;
    if (out.length >= 2) break;
  }
  return out;
}

/**
 * 把「今天 + 最近几天」整理成一份事实清单。AI 只能引用这里的数字。
 */
export function buildCoachBrief({ state, targets, totals, today, patterns = [] }) {
  const diff = diffAgainstTargets(totals, targets);
  const pick = (key) => diff.find((d) => d.key === key);
  const remainingKcal = roundInt(pick('kcal')?.remaining ?? 0);
  const proteinGap = Math.max(0, roundInt(pick('protein')?.remaining ?? 0));
  const suggestions = suggestFoods({ remainingKcal, proteinGap });
  const stats = recentStats(state, today, { days: 7, targetKcal: targets.targetCalories });
  return {
    eatenKcal: roundInt(totals.kcal),
    targetKcal: roundInt(targets.targetCalories),
    remainingKcal,
    protein: {
      target: roundInt(targets.proteinG),
      eaten: roundInt(totals.protein),
      gap: proteinGap,
    },
    fatGap: roundInt(pick('fat')?.remaining ?? 0),
    carbGap: roundInt(pick('carb')?.remaining ?? 0),
    stats,
    patterns: patterns.slice(0, 3).map((p) => ({ title: String(p.title || ''), detail: String(p.detail || '') })),
    suggestions,
    suggestionTotal: suggestions.length
      ? {
        kcal: roundInt(suggestions.reduce((a, x) => a + x.kcal, 0)),
        protein: Math.round(suggestions.reduce((a, x) => a + x.protein, 0) * 10) / 10,
      }
      : null,
    safetyNotes: Array.isArray(targets.warnings) ? targets.warnings.slice(0, 2) : [],
  };
}

/** 把建议搭配念成一句人话（本地版和 AI 提示词都用这个说法） */
function suggestionText(suggestions) {
  return suggestions
    .map((x) => `${x.name} ${x.grams} 克（${x.kcal} kcal，蛋白 ${x.protein} 克）`)
    .join('＋');
}

/**
 * 本地版建议：不联网、不花钱，本身就是完整答案。
 * 措辞原则：说事实、给下一步，不评判（不说「你吃太多了」）。
 */
export function localCoachAdvice(brief) {
  const lines = [];
  const { remainingKcal, protein, stats } = brief;

  if (remainingKcal > 0) {
    lines.push(`今天还能吃约 ${remainingKcal} kcal${protein.gap > 0 ? `，蛋白质还差 ${protein.gap} 克` : '，蛋白质已经够了'}。`);
  } else if (remainingKcal === 0) {
    lines.push(`今天的额度刚好用完了${protein.gap > 0 ? `，蛋白质还差 ${protein.gap} 克` : ''}。`);
  } else {
    lines.push(`今天超出约 ${Math.abs(remainingKcal)} kcal${protein.gap > 0 ? `，蛋白质还差 ${protein.gap} 克` : ''}。`);
  }

  if (remainingKcal <= 0) {
    lines.push('今天就别再补了，饿的话用黄瓜、番茄这类几乎不占额度的。缺口明天早餐补：两个鸡蛋（143 kcal，蛋白 13 克）是最省事的。');
  } else if (brief.suggestions.length) {
    lines.push(`最省额度的补法是：${suggestionText(brief.suggestions)}。`);
    const covered = brief.suggestionTotal?.protein || 0;
    if (protein.gap - covered >= 5) {
      lines.push(`这两样能补 ${Math.round(covered)} 克蛋白，剩下的 ${Math.max(0, Math.round(protein.gap - covered))} 克留给下一餐。`);
    }
  } else if (protein.gap > 0) {
    lines.push(`额度不多了，优先吃蛋白质：${protein.gap} 克缺口，一个鸡蛋（143 kcal，蛋白 13 克）或一杯无糖酸奶都行。`);
  } else {
    lines.push('蛋白和热量都在节奏上，剩下的额度留给水果或酸奶收尾就行。');
  }

  if (stats.logged >= 3) {
    lines.push(`最近 ${stats.days} 天你记了 ${stats.logged} 天，平均约 ${stats.avgKcal} kcal（目标 ${brief.targetKcal}）${stats.over ? `，其中 ${stats.over} 天超了` : ''}。`);
  } else {
    lines.push(`最近 ${stats.days} 天记了 ${stats.logged} 天，记录多一点，建议会更贴合你。`);
  }

  if (brief.patterns.length) {
    const p = brief.patterns[0];
    lines.push(`你自己记录里的规律：${p.title}${p.detail ? ` —— ${p.detail}` : ''}`);
  }
  for (const note of brief.safetyNotes) lines.push(note);

  return { headline: '按你今天的记录算的', lines };
}

/**
 * 系统提示词。三条硬约束（跟 issue #5 一一对应）：
 * 只准用给出的数字 / 不评判 / 不许暗示运动可以吃回来。
 */
export function coachSystemPrompt() {
  return [
    '你是一个帮中国用户安排下一餐的饮食教练。用户消息里已经算好了所有事实和数字，你只负责把它们说得自然、具体。',
    '',
    '硬性要求（违反任何一条这次回答就作废）：',
    '1. 只能使用用户消息里出现的数字。不许自己加减乘除，不许换算，不许编任何新的热量、克数、百分比、天数。',
    '2. 不评判、不说教。说事实和下一步，不说「你吃太多了」「要自律」「管住嘴」。',
    '3. 不许暗示运动消耗可以吃回来，也不许用「奖励自己」「补回来」这类说法。',
    '4. 建议要落到具体食物和份量上，但只能用消息里给出的那几样和它们的克数。',
    '5. 用中文，第二人称「你」，3~5 句话，不超过 160 字。不要分点罗列，不要标题，像朋友说话。',
    '6. 只输出这段话本身，不要任何解释、前缀或格式标记。',
  ].join('\n');
}

/** 给 AI 的事实清单（人可读，也让校验能对上） */
export function coachUserMessage(brief) {
  const s = brief.stats;
  const lines = [
    `今天已吃 ${brief.eatenKcal} kcal，目标 ${brief.targetKcal} kcal，还能吃 ${brief.remainingKcal} kcal。`,
    `蛋白质：目标 ${brief.protein.target} 克，已吃 ${brief.protein.eaten} 克，还差 ${brief.protein.gap} 克。`,
  ];
  if (brief.suggestions.length) {
    lines.push(`可以建议这几样（份量是算好的，只能用这些数字）：${suggestionText(brief.suggestions)}。`);
    lines.push(`这几样加起来 ${brief.suggestionTotal.kcal} kcal，蛋白 ${brief.suggestionTotal.protein} 克。`);
  } else {
    lines.push('今天没有合适的加餐建议（额度不够或蛋白已经够了）。');
  }
  lines.push(`最近 ${s.days} 天：记了 ${s.logged} 天，平均 ${s.avgKcal} kcal；超目标 ${s.over} 天，低于目标 ${s.under} 天。`);
  for (const p of brief.patterns) lines.push(`你自己记录里的规律：${p.title}${p.detail ? ` —— ${p.detail}` : ''}`);
  for (const n of brief.safetyNotes) lines.push(`安全提醒：${n}`);
  lines.push('');
  lines.push('请根据上面的情况，用第二人称「你」给出一个明确的下一步。不要计算任何新数字。');
  return lines.join('\n');
}

function normNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? String(v) : String(n);
}

/**
 * 允许出现的数字：清单里的所有数字 + 1~4（「一两样」「三步」这种计数）。
 * 小整数放行是有意的：编造「5 克蛋白」没意义，但编「999 克」会被抓。
 */
export function allowedNumbers(brief) {
  const set = new Set(['1', '2', '3', '4']);
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'number') { set.add(normNum(v)); return; }
    if (typeof v === 'string') {
      for (const m of v.match(/\d+(?:\.\d+)?/g) || []) set.add(normNum(m));
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(brief);
  return set;
}

/**
 * 校验 AI 说的话：只允许引用清单里的数字，且不许出现「练了可以多吃」这类暗示。
 * 不合格就整段退回本地版 —— 宁可说得朴素，也不能把编的数字给用户看。
 */
export function checkCoachText(text, brief) {
  const t = String(text || '').trim();
  // 先查红线：这句话哪怕很短，只要在暗示「运动可以吃回来」就必须打回
  if (/(运动|锻炼|练了|健身|跑步)[^。！？；;]{0,12}(吃回|多吃|奖励|补回|抵消)|(吃回|补回)[^。！？；;]{0,10}(运动|锻炼)/.test(t)) {
    return { ok: false, reason: '暗示运动可以吃回来' };
  }
  if (t.length < 20) return { ok: false, reason: 'AI 回得太短' };
  if (t.length > 600) return { ok: false, reason: 'AI 回得太长' };
  const allowed = allowedNumbers(brief);
  const bad = (t.match(/\d+(?:\.\d+)?/g) || []).filter((n) => !allowed.has(normNum(n)));
  if (bad.length) {
    return { ok: false, reason: `出现了没依据的数字：${[...new Set(bad)].slice(0, 4).join('、')}` };
  }
  return { ok: true, text: t };
}
