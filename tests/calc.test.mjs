/**
 * 热量与营养计算测试
 *
 * 期望值都是按公开公式手算出来的独立数值（不是从代码里抄的），
 * 改坏公式就会失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcBMR, calcTDEE, calcBMI, classifyBMI, calcTargets, calcEntry,
  calcExerciseKcal, diffAgainstTargets, macroSplit, KCAL_PER_KG_FAT, round,
  LIMITS, PROFILE_ACCEPT_LEGACY, isProfileUsable, validateProfile,
  remainingRing,
} from '../js/calc.js';

const nearly = (a, b, tol = 0.5) => assert.ok(Math.abs(a - b) <= tol, `期望 ${b}，实际 ${a}`);

test('基础代谢：Mifflin-St Jeor 女性手算核对', () => {
  // 10×58 + 6.25×163 − 5×26 − 161 = 580 + 1018.75 − 130 − 161 = 1307.75
  const r = calcBMR({ sex: 'female', weightKg: 58, heightCm: 163, age: 26 });
  nearly(r.bmr, 1307.75, 0.01);
  assert.equal(r.method, 'mifflin');
});

test('基础代谢：Mifflin-St Jeor 男性手算核对', () => {
  // 10×80 + 6.25×178 − 5×35 + 5 = 800 + 1112.5 − 175 + 5 = 1742.5
  const r = calcBMR({ sex: 'male', weightKg: 80, heightCm: 178, age: 35 });
  nearly(r.bmr, 1742.5, 0.01);
});

test('基础代谢：有体脂率时改用 Katch-McArdle（按瘦体重算）', () => {
  // 瘦体重 58×0.75 = 43.5；370 + 21.6×43.5 = 370 + 939.6 = 1309.6
  const r = calcBMR({ sex: 'female', weightKg: 58, heightCm: 163, age: 26, bodyFatPct: 25 });
  nearly(r.leanMass, 43.5, 0.01);
  nearly(r.bmr, 1309.6, 0.01);
  assert.equal(r.method, 'katch');
});

test('基础代谢：参数不合法要直接报错，不能悄悄算出一个数', () => {
  assert.throws(() => calcBMR({ sex: 'female', weightKg: NaN, heightCm: 163, age: 26 }), /体重/);
  assert.throws(() => calcBMR({ sex: 'x', weightKg: 58, heightCm: 163, age: 26 }), /性别/);
  assert.throws(() => calcBMR({ sex: 'female', weightKg: 58, heightCm: 163, age: '26' }), /年龄/);
});

test('总消耗 = 基础代谢 × 活动量系数', () => {
  const p = { sex: 'female', weightKg: 58, heightCm: 163, age: 26, activity: 'light' };
  nearly(calcTDEE(p), 1307.75 * 1.375, 0.5);
});

test('BMI 与中国成人分类', () => {
  nearly(calcBMI({ weightKg: 58, heightCm: 163 }), 21.83, 0.01);
  assert.equal(classifyBMI(17).label, '偏瘦');
  assert.equal(classifyBMI(21.8).label, '正常');
  assert.equal(classifyBMI(26).label, '偏胖');
  assert.equal(classifyBMI(30).label, '肥胖');
});

test('目标热量 = 总消耗 − 缺口，且缺口按「每周减 0.5% 体重」换算', () => {
  const p = { sex: 'female', weightKg: 58, heightCm: 163, age: 26, activity: 'light', pace: 'standard', goal: 'lose' };
  const t = calcTargets(p);
  const tdee = 1307.75 * 1.375; // 1798.2
  const expectedDeficit = (58 * 0.005 * KCAL_PER_KG_FAT) / 7; // 58×0.005=0.29kg/周 → 2233kcal/周 → 319/天
  nearly(t.deficit, expectedDeficit, 1);
  nearly(t.targetCalories, tdee - expectedDeficit, 2);
});

test('三大营养素的热量加起来等于目标热量', () => {
  for (const profile of [
    { sex: 'female', weightKg: 58, heightCm: 163, age: 26, activity: 'light', pace: 'standard', goal: 'lose' },
    { sex: 'female', weightKg: 80, heightCm: 158, age: 40, activity: 'sedentary', pace: 'gentle', goal: 'lose' },
    { sex: 'male', weightKg: 90, heightCm: 180, age: 30, activity: 'moderate', pace: 'fast', goal: 'lose' },
    { sex: 'female', weightKg: 52, heightCm: 165, age: 24, activity: 'active', pace: 'standard', goal: 'maintain' },
  ]) {
    const t = calcTargets(profile);
    const sum = t.proteinG * 4 + t.fatG * 9 + t.carbG * 4;
    nearly(sum, t.targetCalories, 12); // 各自四舍五入到 0.1g，允许十几 kcal 的尾差
  }
});

test('安全下限：女生目标热量不低于 1200，男生不低于 1500', () => {
  const tiny = calcTargets({
    sex: 'female', weightKg: 42, heightCm: 150, age: 60, activity: 'sedentary', pace: 'fast', goal: 'lose',
  });
  assert.ok(tiny.targetCalories >= 1200, `实际 ${tiny.targetCalories}`);
  const man = calcTargets({
    sex: 'male', weightKg: 50, heightCm: 165, age: 70, activity: 'sedentary', pace: 'fast', goal: 'lose',
  });
  assert.ok(man.targetCalories >= 1500, `实际 ${man.targetCalories}`);
});

test('每周减重不超过体重的 1%：选「想快一点」也会被收窄', () => {
  const t = calcTargets({
    sex: 'female', weightKg: 55, heightCm: 160, age: 30, activity: 'sedentary', pace: 'fast', goal: 'lose',
  });
  assert.ok(t.weeklyLossKg <= 55 * 0.01 + 0.001, `每周掉 ${t.weeklyLossKg} kg，超过 1%`);
  assert.ok(t.warnings.some((w) => w.includes('缺口')), '被收窄时应当给出提示');
});

// 说明：deficitCap（总消耗的 75%）是理论护栏。按内置的三档节奏（每周 0.25/0.5/0.75% 体重），
// 即使 250 kg 的人选「想快一点」也到不了这个上限，所以它不会在实际使用中生效
// —— 真正兜住用户的是下面这条不变量，以及「不低于基础代谢 1.1 倍」的下限。
// 这里直接断言不变量本身，而不是断言那个护栏被触发过。
test('任何组合下每周掉秤都不超过体重的 1%，目标热量也不低于总消耗的 25%', () => {
  let worstRatio = 1; let worstLoss = 0; let n = 0;
  for (const sex of ['female', 'male']) {
    for (const weightKg of [40, 45, 55, 70, 90, 120]) {
      for (const heightCm of [150, 163, 178, 195]) {
        for (const activity of ['sedentary', 'light', 'moderate', 'active', 'athlete']) {
          for (const pace of ['gentle', 'standard', 'fast']) {
            const t = calcTargets({ sex, weightKg, heightCm, age: 30, activity, pace, goal: 'lose' });
            n += 1;
            worstRatio = Math.min(worstRatio, t.targetCalories / t.tdee);
            worstLoss = Math.max(worstLoss, t.weeklyLossKg / weightKg);
          }
        }
      }
    }
  }
  assert.ok(n >= 180, `样本太少：${n}`);
  // 缺口上限 75% → 目标热量至少是总消耗的 25%
  assert.ok(worstRatio >= 0.25 - 1e-9, `有组合的目标热量只有总消耗的 ${(worstRatio * 100).toFixed(1)}%`);
  assert.ok(worstLoss <= 0.01 + 1e-9, `有组合每周掉 ${(worstLoss * 100).toFixed(2)}% 体重`);
});

// 注意：MIN_CARB_G 这条 80 克底线是「结构性成立」的 —— 脂肪上限已经先给碳水留了位置，
// 所以这个常量本身不会在实际输入下被触发（250 kg 的极端组合最低也有 87 克）。
// 测试断言的是「碳水不会低于 80 克」这个对外承诺，而不是断言那个常量被执行过。
test('碳水永远不低于 80 克（压到极限的输入也一样）', () => {
  let minCarb = Infinity; let worst = '';
  for (const weightKg of [40, 55, 75, 100, 150]) {
    for (const heightCm of [145, 163, 190]) {
      for (const activity of ['sedentary', 'light', 'athlete']) {
        for (const goal of ['lose', 'maintain']) {
          const t = calcTargets({ sex: 'female', weightKg, heightCm, age: 40, activity, pace: 'fast', goal });
          if (t.carbG < minCarb) { minCarb = t.carbG; worst = `${weightKg}kg/${heightCm}cm/${activity}/${goal}`; }
        }
      }
    }
  }
  assert.ok(minCarb >= 80, `最低碳水出现在 ${worst}：${minCarb} 克`);
});

test('偏瘦的人不给减脂缺口，并且明确劝退', () => {
  const t = calcTargets({
    sex: 'female', weightKg: 45, heightCm: 168, age: 22, activity: 'moderate', pace: 'standard', goal: 'lose',
  });
  assert.ok(t.warnings.some((w) => w.includes('偏瘦')), 'BMI 偏瘦时必须提示');
});

test('体型很小时缺口会变负：必须给出说明，且界面不能显示「每周减 -0.03 kg」', () => {
  // 核验员实测到的案例：150cm/50kg/60岁/久坐 → 总消耗 1172，被 1200 的安全下限锁住，
  // 缺口变成 -28（等于要多吃）。这种情况必须明确说是「维持」，不能让负数直接露在界面上。
  const t = calcTargets({ sex: 'female', weightKg: 50, heightCm: 150, age: 60, activity: 'sedentary', pace: 'standard', goal: 'lose' });
  assert.ok(t.deficit < 0, `这组资料的缺口应当是负的（实际 ${t.deficit}），说明测试前提变了`);
  assert.ok(t.targetCalories >= t.tdee, '目标热量应当不低于总消耗（否则就是「减脂」变「增重」）');
  assert.ok(t.warnings.some((w) => w.includes('维持')), '必须明确告诉用户现在是维持状态，而不是显示一个负的减重速度');
  assert.ok(t.weeklyLossKg <= 0, '负缺口对应的每周变化是负数 —— 界面据此判断不要显示「每周减」');
});

test('维持体重模式：缺口为 0', () => {
  const t = calcTargets({
    sex: 'female', weightKg: 55, heightCm: 163, age: 28, activity: 'light', pace: 'standard', goal: 'maintain',
  });
  assert.equal(t.deficit, 0);
  nearly(t.targetCalories, t.tdee, 1);
});

test('脂肪按 0.8（减脂）/ 0.9（维持）g/kg 给，热量不够时才降到 0.6 的下限', () => {
  // 这条是补的：原来只断言「不低于 0.6 g/kg」，而 0.6 正好是下限值，
  // 所以就算把理想值错写成 0.05 g/kg，测试也照样通过（反向验证抓出来的漏）。
  // 现在同时断言上界：热量够用时必须给到理想值。
  for (const w of [45, 58, 75, 95, 120]) {
    for (const goal of ['lose', 'maintain']) {
      const t = calcTargets({ sex: w > 80 ? 'male' : 'female', weightKg: w, heightCm: 170, age: 30, activity: 'light', pace: 'standard', goal });
      const idealPerKg = goal === 'lose' ? 0.8 : 0.9;
      const ideal = w * idealPerKg;
      const floor = w * 0.6;
      assert.ok(t.fatG >= floor, `${w}kg/${goal}：脂肪 ${t.fatG}g 低于 0.6 g/kg 的下限 ${floor.toFixed(1)}g`);
      // 热量够（蛋白按 35% 上限 + 碳水 80 克底线之后还有余量）时必须给到理想值
      const roomForIdeal = t.targetCalories - (t.targetCalories * 0.35) - 80 * 4;
      if (roomForIdeal / 9 >= ideal) {
        assert.ok(t.fatG >= ideal - 0.1, `${w}kg/${goal}：热量够用，脂肪应当至少给到理想值 ${ideal.toFixed(1)}g，实际 ${t.fatG}g`);
      }
    }
  }
});

test('脂肪不低于 0.6 g/kg，碳水不低于 80 g', () => {
  for (const w of [45, 58, 75, 95, 120]) {
    const t = calcTargets({
      sex: w > 80 ? 'male' : 'female', weightKg: w, heightCm: 170, age: 30, activity: 'light', pace: 'fast', goal: 'lose',
    });
    assert.ok(t.fatG >= w * 0.6, `${w}kg 的脂肪目标 ${t.fatG}g 低于 0.6 g/kg 下限（${(w * 0.6).toFixed(1)}g）`);
    assert.ok(t.carbG >= 80 - 0.2, `${w}kg 的碳水目标 ${t.carbG}g 低于下限`);
  }
});

test('食物换算：200 克熟米饭 = 232 kcal', () => {
  const rice = { kcal: 116, protein: 2.6, fat: 0.3, carb: 25.9 };
  const f = calcEntry(rice, 200);
  nearly(f.kcal, 232, 0.01);
  nearly(f.carb, 51.8, 0.01);
  nearly(f.protein, 5.2, 0.01);
});

test('食物换算：份量为 0 或负数要报错', () => {
  assert.throws(() => calcEntry({ kcal: 100, protein: 1, fat: 1, carb: 1 }, 0), /份量/);
  assert.throws(() => calcEntry({ kcal: 100, protein: 1, fat: 1, carb: 1 }, -5), /份量/);
});

test('食物换算：份量非法要报错', () => {
  assert.throws(() => calcEntry({ kcal: 100, protein: 1, fat: 1, carb: 1 }, -5), /份量/);
  assert.throws(() => calcEntry({ kcal: 100, protein: 1, fat: 1, carb: 1 }, '100'), /份量/);
});

test('运动消耗 = METs × 体重 × 小时（快走 4.3 METs，60kg，40 分钟）', () => {
  // 4.3 × 60 × (40/60) = 172
  nearly(calcExerciseKcal({ mets: 4.3, weightKg: 60, minutes: 40 }), 172, 0.1);
});

test('进度对比：超标和不足能分别识别', () => {
  const targets = { targetCalories: 1500, proteinG: 90, fatG: 50, carbG: 170 };
  const rows = diffAgainstTargets({ kcal: 1700, protein: 60, fat: 52, carb: 120 }, targets);
  const kcal = rows.find((r) => r.key === 'kcal');
  const protein = rows.find((r) => r.key === 'protein');
  assert.equal(kcal.status, 'over');
  assert.equal(kcal.remaining, -200);
  assert.equal(protein.status, 'under');
  nearly(protein.remaining, 30, 0.01);
});

test('供能比例加起来是 100%（或全 0）', () => {
  const s = macroSplit({ protein: 93, fat: 46, carb: 173 });
  assert.equal(s.protein + s.fat + s.carb, 100);
  const zero = macroSplit({ protein: 0, fat: 0, carb: 0 });
  assert.equal(zero.totalKcal, 0);
});

test('round 的边界：0.5 向上进位，1.005 这类浮点陷阱要进位到 1.01', () => {
  assert.equal(round(0.5), 1);
  assert.equal(round(2.5), 3);
  // 1.005 在二进制里其实是 1.00499999...，naive 实现会得到 1.00
  assert.equal(round(1.005, 2), 1.01);
  assert.equal(round(1.015, 2), 1.02);
  // 负数是四舍五入往「更负」的方向（JS 的 Math.round 行为），这里只要求不返回 -0
  assert.equal(round(-0.5), -1);
  assert.equal(Object.is(round(-0.4), -0), false, '不要返回 -0');
  assert.equal(round(NaN), NaN);
});


/*
 * v33：资料校验只有一份来源。
 *
 * 以前同一件事有 3 套数值（表单校验 130~220/18~80、能否算目标 100~250/10~120、
 * 体脂率还有一个没人引用的 LIMITS.bodyFatPct [8,55]）。不报错，只会让
 * 「能存进去但算出来怪」悄悄发生。这几条测试就是钉住「只有一处」。
 */

const goodProfile = { sex: 'female', age: 26, heightCm: 163, weightKg: 58, bodyFatPct: null, targetWeightKg: null };

test('资料校验：正常资料通过，边界值按 LIMITS 一处判断', () => {
  assert.equal(validateProfile(goodProfile), null);
  assert.equal(LIMITS.ageYears[0], 18);
  assert.equal(LIMITS.heightCm[0], 130);
  assert.equal(LIMITS.weightKg[0], 30);
  // 上下边界本身都要能过
  assert.equal(validateProfile({ ...goodProfile, age: 18 }), null);
  assert.equal(validateProfile({ ...goodProfile, age: 80 }), null);
  assert.equal(validateProfile({ ...goodProfile, heightCm: 130 }), null);
  assert.equal(validateProfile({ ...goodProfile, heightCm: 220 }), null);
  assert.equal(validateProfile({ ...goodProfile, weightKg: 30 }), null);
  assert.equal(validateProfile({ ...goodProfile, weightKg: 250 }), null);
});

test('资料校验：越界/缺项要挡住（不是只提示）', () => {
  assert.match(validateProfile({ ...goodProfile, age: 17 }), /18 岁/, '17 岁要说清为什么不行');
  assert.match(validateProfile({ ...goodProfile, age: 81 }), /年龄要在 18~80/);
  assert.match(validateProfile({ ...goodProfile, heightCm: 129 }), /身高要在 130~220/);
  assert.match(validateProfile({ ...goodProfile, heightCm: 221 }), /身高要在 130~220/);
  assert.match(validateProfile({ ...goodProfile, weightKg: 29 }), /体重要在 30~250/);
  assert.match(validateProfile({ ...goodProfile, weightKg: 251 }), /体重要在 30~250/);
  assert.match(validateProfile({ ...goodProfile, age: undefined }), /年龄要填一个数字/);
  assert.match(validateProfile({ ...goodProfile, heightCm: '163' }), /身高要填一个数字/);
});

test('体脂率：表单和公式认同一个范围（LIMITS.bodyFatPct 不再是死常量）', () => {
  assert.deepEqual(LIMITS.bodyFatPct, [3, 60]);
  assert.equal(validateProfile({ ...goodProfile, bodyFatPct: 3 }), null);
  assert.equal(validateProfile({ ...goodProfile, bodyFatPct: 60 }), null);
  assert.match(validateProfile({ ...goodProfile, bodyFatPct: 2 }), /3~60/);
  assert.match(validateProfile({ ...goodProfile, bodyFatPct: 61 }), /3~60/);
  assert.match(validateProfile({ ...goodProfile, bodyFatPct: '25' }), /3~60/, '字符串不是数字，要挡住');
  // 基础代谢必须真的按这个范围决定用哪条公式（改坏常量这里会红）
  assert.equal(calcBMR({ sex: 'female', weightKg: 58, heightCm: 163, age: 26, bodyFatPct: 3 }).method, 'katch');
  assert.equal(calcBMR({ sex: 'female', weightKg: 58, heightCm: 163, age: 26, bodyFatPct: 60 }).method, 'katch');
  assert.equal(calcBMR({ sex: 'female', weightKg: 58, heightCm: 163, age: 26, bodyFatPct: 2 }).method, 'mifflin');
  assert.equal(calcBMR({ sex: 'female', weightKg: 58, heightCm: 163, age: 26, bodyFatPct: 61 }).method, 'mifflin');
});

test('老存档能不能算：用更宽的范围，不把老数据判成「没填资料」', () => {
  // 表单范围更严（年龄 18+），但已经有老资料的设备不该被退回欢迎页 ——
  // 否则记录还在、却看不到，而且表单填不回原值，变成死胡同。
  assert.equal(isProfileUsable({ sex: 'female', age: 16, heightCm: 110, weightKg: 40 }), true);
  assert.equal(isProfileUsable({ sex: 'male', age: 100, heightCm: 250, weightKg: 300 }), true);
  assert.equal(isProfileUsable({ sex: 'female', age: 9, heightCm: 163, weightKg: 58 }), false);
  assert.equal(isProfileUsable({ sex: 'female', age: 26, heightCm: 99, weightKg: 58 }), false);
  assert.equal(isProfileUsable({ sex: 'female', age: 26, heightCm: 163, weightKg: 24 }), false);
  assert.equal(isProfileUsable({ age: 26, heightCm: 163, weightKg: 58 }), false, '没有性别算不了代谢');
  assert.equal(isProfileUsable(null), false);
  // 两套范围是**有意**不同，不是分叉：第 17 条测试（body）已确认表单更严。
  assert.ok(PROFILE_ACCEPT_LEGACY.ageYears[0] < LIMITS.ageYears[0], '宽范围必须比表单范围宽，否则老资料会被判成没填');
});

test('今天页圆环画的是「还剩多少」，和中间那个数字同源（v50）', () => {
  // 剩 14 / 目标 1479：环几乎空。以前画「已吃/目标」会是 99% 满 —— 和「还剩 14」正好相反
  const almost = remainingRing({ remaining: 14, budget: 1479 });
  assert.ok(almost.pct < 0.02, `剩 14 时环几乎该是空的，实际 ${almost.pct}`);
  assert.equal(almost.low, true);
  assert.equal(almost.over, false);

  // 一口没吃：满环 + 中间就是目标数
  assert.deepEqual(remainingRing({ remaining: 1479, budget: 1479 }), { pct: 1, low: false, over: false });

  // 吃超了：环走满（不是负的），并标明已超
  assert.deepEqual(remainingRing({ remaining: -222, budget: 1479 }), { pct: 1, low: false, over: true });

  // 目标坏掉（0 / 负数 / 未定义）不能画出 NaN，也不能报错
  for (const budget of [0, -1, undefined, null]) {
    const r = remainingRing({ remaining: 100, budget });
    assert.equal(r.pct, 0);
    assert.equal(Number.isNaN(r.pct), false);
  }

  // 边界：剩不到两成才换告警色（19.9% 换，正好 20% 不换）
  assert.equal(remainingRing({ remaining: 295, budget: 1479 }).low, true);
  assert.equal(remainingRing({ remaining: 295.8, budget: 1479 }).pct, 0.2);
  assert.equal(remainingRing({ remaining: 295.8, budget: 1479 }).low, false);
});
