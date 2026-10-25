/**
 * 包装食品的营养成分表：换算与核对（纯函数，方便测试）
 *
 * 为什么单独一个文件：
 *  - 中国包装上的「能量」写的是**千焦（kJ）**，不是千卡。以前的自定义食物只收 kcal，
 *    等于让用户自己拿计算器除 4.184 —— 这一步最容易抄错，而且错了根本看不出来。
 *  - 抄错行/抄错单位（把千焦当千卡）是真实会发生的事，所以要有一道「4/9/4 对账」提醒：
 *    蛋白×4 + 脂肪×9 + 碳水×4 应当接近标称热量。对不上就提示用户核对，而不是默默记下。
 *
 * 这里只做换算和判断，不碰界面、不碰存档。
 */

import { macroKcal, round } from './calc.js';

/** 1 千卡 = 4.184 千焦（营养学通用换算） */
export const KJ_PER_KCAL = 4.184;

/** 每 100 克的热量上限：纯油脂约 900，超过基本是抄错单位 */
export const MAX_KCAL_PER_100 = 900;
/** 每 100 克任一营养素上限（克） */
export const MAX_MACRO_PER_100 = 100;

/** 把标签上的单位写法收成两种：'kJ' / 'kcal'，认不出返回 null */
export function normalizeUnit(unit) {
  const u = String(unit ?? '').toLowerCase().trim();
  if (u === 'kj' || u === '千焦' || u === '千焦耳') return 'kJ';
  if (u === 'kcal' || u === '千卡' || u === '大卡' || u === '卡路里') return 'kcal';
  return null;
}

/**
 * 能量换成千卡。
 * @returns {number|null} 数值不合理或单位认不出时返回 null（宁可让用户重选，也不猜）
 */
export function energyToKcal(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return null;
  const u = normalizeUnit(unit);
  if (u === 'kJ') return v / KJ_PER_KCAL;
  if (u === 'kcal') return v;
  return null;
}

// 4/9/4 折算与四舍五入都只有一份实现（见 js/calc.js）；这里转出去给老调用方/测试用
export { macroKcal };
const round1 = (n) => round(n, 1);

/**
 * 把「一份（或一份是多少克）」的营养数据换算成每 100 克。
 *
 * @param {{baseGrams:number, energyValue:number|null, energyUnit:string, protein:number|null, fat:number|null, carb:number|null}} input
 * @returns {{ok:true, per100:{kcal:number|null, protein:number, fat:number, carb:number}, kcalFromMacros:boolean}|{ok:false, error:string}}
 */
export function labelToPer100({ baseGrams, energyValue, energyUnit, protein, fat, carb }) {
  const base = Number(baseGrams);
  if (!Number.isFinite(base) || base <= 0) return { ok: false, error: '「每份是多少克」要填大于 0 的数字。' };
  if (base > 5000) return { ok: false, error: '「每份是多少克」太大了，包装不会这么标。' };

  const macroOf = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  };
  const p = macroOf(protein);
  const f = macroOf(fat);
  const c = macroOf(carb);
  if (p === null || f === null || c === null) return { ok: false, error: '蛋白质/脂肪/碳水要填大于等于 0 的数字。' };

  const scale = 100 / base;
  const hasEnergy = energyValue !== null && energyValue !== undefined && energyValue !== '';
  const kcalPerBase = hasEnergy ? energyToKcal(energyValue, energyUnit) : null;
  if (hasEnergy && kcalPerBase === null) return { ok: false, error: '能量的单位没认出来，选一下「千焦」或「千卡」。' };

  const per100 = {
    kcal: kcalPerBase === null ? null : round1(kcalPerBase * scale),
    protein: round1(p * scale),
    fat: round1(f * scale),
    carb: round1(c * scale),
  };
  const kcalFromMacros = per100.kcal === null;
  if (kcalFromMacros) per100.kcal = round1(macroKcal(per100));

  if (per100.kcal > MAX_KCAL_PER_100) {
    return { ok: false, error: `每 100 克 ${per100.kcal} kcal 太高了。看看是不是把「千焦」当成「千卡」了（${round1(per100.kcal)} kcal 相当于 ${round1(per100.kcal * KJ_PER_KCAL)} 千焦）。` };
  }
  if ([per100.protein, per100.fat, per100.carb].some((v) => v > MAX_MACRO_PER_100)) {
    return { ok: false, error: '每 100 克里蛋白质/脂肪/碳水超过 100 克了，检查一下是不是单位或每份克数填错。' };
  }
  return { ok: true, per100, kcalFromMacros };
}

/**
 * 热量和营养素对账。包装偶尔会因膳食纤维/糖醇出现偏差，所以只在差得多时提醒。
 * @returns {{level:'ok'|'warn'|'info', computed:number, stated:number|null, diffPct:number, message:string}}
 */
export function checkConsistency(per100) {
  const computed = round1(macroKcal(per100));
  const stated = per100?.kcal;
  if (stated === null || stated === undefined || !(stated > 0)) {
    return { level: 'info', computed, stated: null, diffPct: 0, message: `热量按营养素算：约 ${computed} kcal。` };
  }
  const diffPct = Math.abs(stated - computed) / stated * 100;
  if (diffPct <= 10) {
    return { level: 'ok', computed, stated, diffPct: round1(diffPct), message: `对得上：标称 ${round1(stated)} kcal，按营养素算 ${computed} kcal。` };
  }
  if (diffPct <= 20) {
    return { level: 'warn', computed, stated, diffPct: round1(diffPct), message: `标称 ${round1(stated)} kcal，按营养素算 ${computed} kcal，差 ${round1(diffPct)}%。包装有时会这样（膳食纤维/糖醇），核对一眼就行。` };
  }
  return {
    level: 'warn',
    computed,
    stated,
    diffPct: round1(diffPct),
    message: `对不上：标称 ${round1(stated)} kcal，按蛋白/脂肪/碳水算却是 ${computed} kcal。最可能是抄错了行或单位（把「千焦」当「千卡」最常见）。`,
  };
}

/**
 * AI 估的营养数字：本地校验（v34）。
 *
 * 为什么要这一步：AI 现在可以直接估「本地库里没有的菜」的营养（以前只让它给名字，
 * 结果最会用的大模型被当成查表员）。但估出来的数字必须能核对、能复算，否则又回到
 * 「AI 编数字没人管」的老问题。所以先过这里：
 *   1) 份量、上下限：每 100 克热量 ≤ 900、任一营养素 ≤ 100 克（和读标签共用同一组上限）；
 *   2) 4/9/4 对账：蛋白×4 + 脂肪×9 + 碳水×4 与 AI 给的热量差得太远，就按营养素重算热量
 *      （差 30%~50% 重算并标注；差超过 50% 认为数字自相矛盾，整条退回本地同类均值）。
 *
 * @param {{grams:number, nutrition:{kcal:number,protein:number,fat:number,carb:number}}} input
 * @returns {{ok:true, per100:{kcal,protein,fat,carb}, recalced:boolean, diffPct:number}|{ok:false, reason:string}}
 */
export function validateNutritionEstimate({ grams, nutrition } = {}) {
  const g = Number(grams);
  if (!Number.isFinite(g) || g <= 0 || g > 3000) return { ok: false, reason: '份量不合理' };
  if (!nutrition || typeof nutrition !== 'object') return { ok: false, reason: '没有营养数字' };
  const pick = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const kcal = pick(nutrition.kcal);
  const protein = pick(nutrition.protein);
  const fat = pick(nutrition.fat);
  const carb = pick(nutrition.carb);
  if ([kcal, protein, fat, carb].some((v) => v === null)) return { ok: false, reason: '营养数字不全' };
  if (kcal > 5000) return { ok: false, reason: '热量超出常识' };
  const scale = 100 / g;
  const per100 = {
    kcal: round1(kcal * scale),
    protein: round1(protein * scale),
    fat: round1(fat * scale),
    carb: round1(carb * scale),
  };
  if (per100.kcal > MAX_KCAL_PER_100) return { ok: false, reason: `每 100 克 ${per100.kcal} kcal 太高了` };
  if ([per100.protein, per100.fat, per100.carb].some((v) => v > MAX_MACRO_PER_100)) {
    return { ok: false, reason: '每 100 克营养素超过 100 克' };
  }
  if ([per100.protein, per100.fat, per100.carb].every((v) => v === 0) && per100.kcal > 5) {
    return { ok: false, reason: '只有热量、没有营养素' };
  }
  const computed = round1(macroKcal(per100));
  const diffPct = per100.kcal > 0 ? Math.abs(computed - per100.kcal) / per100.kcal * 100 : 100;
  if (diffPct > 50) return { ok: false, reason: '热量和营养素对不上（差超过 50%）' };
  let recalced = false;
  if (diffPct > 30) {
    // 数字自相矛盾时，热量按 4/9/4 重算 —— 营养素是模型给的原始信息，热量可以由它决定
    per100.kcal = computed;
    recalced = true;
  }
  if (!(per100.kcal > 0)) return { ok: false, reason: '重算后热量为 0' };
  return { ok: true, per100, recalced, diffPct: round1(diffPct) };
}

/**
 * 照片读出来的数字自己对不上时，额外要告诉用户「怎么办」。
 *
 * 为什么需要单独一句：这些数字用户没敲过，是「读出来的」，所以看到「对不上」也不知道该改哪个 ——
 * 真正该做的不是改数字，是重拍。只有照片来源才给这句，手动填的时候不该出现（那是用户自己抄的）。
 * 偏差 20% 以内不给（包装上的膳食纤维/糖醇本来就会让两者差一点，喊重拍是白折腾）。
 *
 * @param {{stated:number|null, diffPct:number}} consistency checkConsistency 的结果
 * @returns {string} 不需要时返回空字符串
 */
export function photoRetakeHint(consistency) {
  if (!consistency || consistency.stated === null || consistency.stated === undefined) return '';
  if (!(consistency.diffPct > 20)) return '';
  return '这张照片可能没读准（最常见的是把上一行/下一行的数字读串了）。重拍一张会更快：把营养成分表拍满画面、正对着、别反光；也可以照着包装手动改这几个数 —— 先别直接保存。';
}
