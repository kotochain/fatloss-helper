/**
 * 热量与营养素计算（纯函数，浏览器和 Node 都能用）
 *
 * 单位约定：
 *   体重 kg、身高 cm、年龄 岁
 *   热量 kcal、蛋白质/脂肪/碳水 克(g)
 */

export const KCAL_PER_G = { protein: 4, fat: 9, carb: 4 };

/** 活动量系数表。文案刻意写得保守——大多数自称「中等活动」的人其实是久坐。 */
export const ACTIVITY_LEVELS = [
  { key: 'sedentary', label: '久坐', hint: '整天坐着办公，几乎不运动', factor: 1.2 },
  { key: 'light', label: '轻度活动', hint: '每周运动 1-3 天，或每天走路通勤', factor: 1.375 },
  { key: 'moderate', label: '中度活动', hint: '每周运动 3-5 天', factor: 1.55 },
  { key: 'active', label: '高度活动', hint: '每周运动 6-7 天，或体力工作', factor: 1.725 },
  { key: 'athlete', label: '非常高', hint: '每天高强度训练两次，或重体力工作', factor: 1.9 },
];

export const GOAL_PACE = [
  { key: 'gentle', label: '慢慢来', hint: '每周减约 0.25% 体重，几乎不掉肌肉、饿感最轻', pctPerWeek: 0.0025 },
  { key: 'standard', label: '标准', hint: '每周减约 0.5% 体重，多数人推荐的节奏', pctPerWeek: 0.005 },
  { key: 'fast', label: '想快一点', hint: '每周减约 0.75% 体重，更饿、更容易掉肌肉', pctPerWeek: 0.0075 },
];

/** 女生/男生的大致身高体重范围，用来挡住手滑输错 */
export const LIMITS = {
  weightKg: [30, 250],
  heightCm: [130, 220],
  ageYears: [18, 80],
  bodyFatPct: [8, 55],
};

/** 每减掉 1 公斤体重（主要是脂肪）大致需要 7700 kcal 的热量缺口。这是估算值。 */
export const KCAL_PER_KG_FAT = 7700;

export function round(value, digits = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  const f = Math.pow(10, digits);
  // (1.005).toFixed 会得到 1.00，(1.005 + 极小量) 才是 1.01。乘除各一次同样有这个陷阱。
  const out = Math.round((value + Number.EPSILON * Math.sign(value || 1)) * f) / f;
  return out === 0 ? 0 : out; // 别把 -0 传出去，界面会显示成 "-0"

}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function assertNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} 必须是数字，收到了 ${JSON.stringify(value)}`);
  }
}

/**
 * 基础代谢（躺着不动一天消耗的热量）
 * 默认用 Mifflin-St Jeor 公式；如果测过体脂率，用 Katch-McArdle 更准（它直接按瘦体重算）。
 */
export function calcBMR({ sex, weightKg, heightCm, age, bodyFatPct = null }) {
  assertNumber(weightKg, '体重');
  assertNumber(heightCm, '身高');
  assertNumber(age, '年龄');
  if (sex !== 'female' && sex !== 'male') throw new Error('性别必须是 female 或 male');

  if (typeof bodyFatPct === 'number' && Number.isFinite(bodyFatPct) && bodyFatPct > 0) {
    const leanMass = weightKg * (1 - bodyFatPct / 100);
    return { bmr: 370 + 21.6 * leanMass, method: 'katch', leanMass };
  }
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  const bmr = sex === 'female' ? base - 161 : base + 5;
  return { bmr, method: 'mifflin', leanMass: null };
}

export function calcBMI({ weightKg, heightCm }) {
  assertNumber(weightKg, '体重');
  assertNumber(heightCm, '身高');
  const m = heightCm / 100;
  return weightKg / (m * m);
}

/** 中国成人 BMI 分类 */
export function classifyBMI(bmi) {
  if (bmi < 18.5) return { key: 'under', label: '偏瘦' };
  if (bmi < 24) return { key: 'normal', label: '正常' };
  if (bmi < 28) return { key: 'over', label: '偏胖' };
  return { key: 'obese', label: '肥胖' };
}

export function getActivity(key) {
  return ACTIVITY_LEVELS.find((a) => a.key === key) || ACTIVITY_LEVELS[0];
}

export function getPace(key) {
  return GOAL_PACE.find((p) => p.key === key) || GOAL_PACE[1];
}

/** 每日总消耗 = 基础代谢 × 活动量系数 */
export function calcTDEE(profile) {
  const { bmr } = calcBMR(profile);
  const activity = getActivity(profile.activity);
  return bmr * activity.factor;
}

/** 目标体重（没填就用 BMI 22 对应的体重，属于健康区间中段） */
export function defaultTargetWeight({ sex, heightCm }) {
  const bmiTarget = sex === 'female' ? 21 : 22;
  const m = heightCm / 100;
  return bmiTarget * m * m;
}

function firstWeekDeltaKg(profile, pacePct) {
  return profile.weightKg * pacePct;
}

/**
 * 给出目标热量和三大营养素分配。
 *
 * 安全规则（会体现在 warnings 里）：
 *  - 每天至少吃到基础代谢的 1.1 倍；
 *  - 女生不低于 1200 kcal，男生不低于 1500 kcal；
 *  - 每周减重不超过体重的 1%；
 *  - 体重已经偏瘦则不给减脂缺口，改成「维持 + 增肌」。
 */
export function calcTargets(profile) {
  const { sex, weightKg, heightCm, age, activity, pace, goal } = profile;
  const { bmr, method, leanMass } = calcBMR(profile);
  const activityInfo = getActivity(activity);
  const tdee = bmr * activityInfo.factor;
  const paceInfo = getPace(pace);
  const warnings = [];

  const targetWeightKg = profile.targetWeightKg > 0 ? profile.targetWeightKg : defaultTargetWeight({ sex, heightCm });
  const goalMode = goal === 'maintain' ? 'maintain' : 'lose';
  const bmi = calcBMI({ weightKg, heightCm });
  const toLose = weightKg - targetWeightKg;

  let deficit = 0;
  if (goalMode === 'lose') {
    const desired = firstWeekDeltaKg(profile, paceInfo.pctPerWeek) * KCAL_PER_KG_FAT / 7;
    deficit = desired;
    const maxDeficitByBmi = bmi >= 28 ? 0.30 : bmi >= 24 ? 0.25 : 0.20;
    const cap = tdee * maxDeficitByBmi;
    if (deficit > cap) {
      deficit = cap;
      warnings.push(`按你选的节奏缺口太大，已自动收窄到每天 ${Math.round(cap)} kcal（约为总消耗的 ${Math.round(maxDeficitByBmi * 100)}%），更安全也更不容易掉肌肉。`);
    }
  }

  let targetCalories = tdee - deficit;
  const floorByBmr = bmr * 1.1;
  const floorBySex = sex === 'female' ? 1200 : 1500;
  const floor = Math.max(floorByBmr, floorBySex);
  if (targetCalories < floor) {
    targetCalories = floor;
    deficit = tdee - targetCalories;
    warnings.push(`目标热量低于安全下限，已锁在每天 ${Math.round(floor)} kcal（不低于基础代谢的 1.1 倍）。想吃更少请先咨询医生或营养师。`);
  }
  if (goalMode === 'maintain') {
    warnings.push('你选的是「维持体重」，所以没有设热量缺口。');
  }

  // 蛋白质：减脂期给足，保护肌肉；肾病人群需遵医嘱
  // 1.8 g/kg 在减脂期属于常见推荐区间（1.6~2.2）。
  // 另外有两条现实约束：
  //   下限 —— 配餐时米饭、蔬菜、奶蛋本身就会带来 30~50 克蛋白，
  //           所以目标定得比「结构自带量」还低是没意义的；
  //   上限 —— 蛋白质最多占总热量 35%，否则脂肪和主食没地方放。
  const proteinPerKg = goalMode === 'lose' ? 1.8 : 1.4;
  const structuredProteinFloor = weightKg * 0.9 + 0.12 * targetCalories / KCAL_PER_G.protein;
  const rawProteinG = Math.max(weightKg * proteinPerKg, structuredProteinFloor);
  const maxProteinByCalories = (targetCalories * 0.35) / KCAL_PER_G.protein;
  const proteinG = Math.min(rawProteinG, maxProteinByCalories);
  if (rawProteinG > maxProteinByCalories) {
    warnings.push('蛋白质目标受总热量限制做了下调，否则脂肪和主食就没地方放了。');
  }

  // 脂肪：不低于 0.6 g/kg（激素和脂溶性维生素需要它）
  const fatPerKg = goalMode === 'lose' ? 0.8 : 0.9;
  let fatG = weightKg * fatPerKg;
  const minFatG = weightKg * 0.6;
  if (fatG < minFatG) fatG = minFatG;
  const maxFatByCalories = (targetCalories * 0.4) / KCAL_PER_G.fat;
  if (fatG > maxFatByCalories) {
    fatG = maxFatByCalories;
    warnings.push('脂肪目标受总热量限制做了下调，但仍保持在安全下限以上。');
  }

  // 剩下的热量给碳水
  let carbG = (targetCalories - proteinG * KCAL_PER_G.protein - fatG * KCAL_PER_G.fat) / KCAL_PER_G.carb;
  const minCarbG = 80;
  if (carbG < minCarbG) {
    // 碳水太少时，优先保证碳水下限，从脂肪里挤（脂肪仍有下限保护）
    const need = (minCarbG - carbG) * KCAL_PER_G.carb;
    const fatCut = Math.min(need / KCAL_PER_G.fat, Math.max(0, fatG - minFatG));
    fatG -= fatCut;
    carbG = (targetCalories - proteinG * KCAL_PER_G.protein - fatG * KCAL_PER_G.fat) / KCAL_PER_G.carb;
    warnings.push('按你的热量和蛋白质目标，主食偏少，已把脂肪压到下限来保证碳水不低于 80 g。');
  }

  const weeklyLossKg = (deficit * 7) / KCAL_PER_KG_FAT;
  const estimatedWeeks = weeklyLossKg > 0 && toLose > 0 ? toLose / weeklyLossKg : null;

  if (bmi < 18.5) {
    warnings.push(`你现在 BMI ${round(bmi, 1)}（偏瘦），不建议再减脂。建议改成增肌增重。`);
  }
  if (method === 'mifflin') {
    warnings.push('基础代谢用的是身高体重公式（Mifflin-St Jeor），误差一般在 ±10% 左右。有条件测一次体脂率会更准。');
  }

  return {
    bmr: round(bmr),
    bmrMethod: method,
    leanMassKg: leanMass ? round(leanMass, 1) : null,
    activityFactor: activityInfo.factor,
    tdee: round(tdee),
    targetCalories: round(targetCalories),
    deficit: Math.round(deficit),
    proteinG: round(proteinG, 1),
    fatG: round(fatG, 1),
    carbG: round(carbG, 1),
    bmi: round(bmi, 1),
    bmiClass: classifyBMI(bmi),
    targetWeightKg: round(targetWeightKg, 1),
    toLoseKg: round(Math.max(0, toLose), 1),
    weeklyLossKg: round(weeklyLossKg, 2),
    estimatedWeeks: estimatedWeeks ? Math.ceil(estimatedWeeks) : null,
    warnings,
  };
}

/** 一次记录（吃了多少）换算成热量和营养素 */
/** 把可能缺字段/类型不对的食物数据补成安全数字，避免算出 NaN */
function nutritionOf(food) {
  if (!food || typeof food !== 'object') throw new Error('食物数据不合法');
  const pick = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return { kcal: pick(food.kcal), protein: pick(food.protein), fat: pick(food.fat), carb: pick(food.carb) };
}

export function calcEntry(food, grams) {
  assertNumber(grams, '份量');
  if (grams <= 0) throw new Error(`份量必须大于 0，收到了 ${grams}`);
  const f = nutritionOf(food);
  const k = grams / 100;
  const protein = f.protein * k;
  const fat = f.fat * k;
  const carb = f.carb * k;
  return {
    kcal: round(f.kcal * k, 1),
    protein: round(protein, 1),
    fat: round(fat, 1),
    carb: round(carb, 1),
    // 用 4/9/4 反算出来的热量，和食物表上的热量可能有出入，用来发现数据填错
    kcalFromMacros: round(protein * 4 + fat * 9 + carb * 4, 1),
  };
}

export function sumEntries(entries) {
  return entries.reduce(
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
}

/** 运动消耗估算：METs × 体重(kg) × 小时数 */
export function calcExerciseKcal({ mets, weightKg, minutes }) {
  assertNumber(mets, 'METs');
  assertNumber(weightKg, '体重');
  assertNumber(minutes, '时长');
  return round((mets * weightKg * minutes) / 60, 1);
}

/** 把当天进度和推荐目标放在一起比较 */
export function diffAgainstTargets(totals, targets) {
  const rows = [
    { key: 'kcal', label: '热量', unit: 'kcal', eaten: round(totals.kcal), target: targets.targetCalories, overIsBad: true },
    { key: 'protein', label: '蛋白质', unit: 'g', eaten: round(totals.protein, 1), target: targets.proteinG, overIsBad: false },
    { key: 'fat', label: '脂肪', unit: 'g', eaten: round(totals.fat, 1), target: targets.fatG, overIsBad: true },
    { key: 'carb', label: '碳水', unit: 'g', eaten: round(totals.carb, 1), target: targets.carbG, overIsBad: true },
  ];
  return rows.map((r) => {
    const remaining = round(r.target - r.eaten, r.unit === 'g' ? 1 : 0);
    const pct = r.target > 0 ? Math.round((r.eaten / r.target) * 100) : 0;
    let status = 'ok';
    if (pct > 105) status = 'over';
    else if (pct < 80) status = 'under';
    return { ...r, remaining, pct, status };
  });
}

/** 热量占三大营养素的比例（用于画比例条） */
export function macroSplit(totals) {
  const pKcal = totals.protein * KCAL_PER_G.protein;
  const fKcal = totals.fat * KCAL_PER_G.fat;
  const cKcal = totals.carb * KCAL_PER_G.carb;
  const total = pKcal + fKcal + cKcal;
  if (total <= 0) return { protein: 0, fat: 0, carb: 0, totalKcal: 0 };
  return {
    protein: Math.round((pKcal / total) * 100),
    fat: Math.round((fKcal / total) * 100),
    carb: Math.round((cKcal / total) * 100),
    totalKcal: round(total),
  };
}
