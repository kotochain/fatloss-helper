/**
 * 正反馈系统：成就徽章、小植物、周报
 *
 * 设计原则（很重要，别改坏）：
 *  1) **只庆祝她能控制的行为**：记录了、吃够蛋白、去运动了、坚持了。
 *     绝不庆祝「吃得少」「掉秤快」—— 那等于鼓励节食，长期是有害的。
 *  2) **不给惩罚**：断记录不会让植物枯萎，也不会扣分。有几天没记，徽章还在、植物还在，
 *     回来接着记就行。放弃的代价必须为零，否则一次中断就等于彻底放弃。
 *  3) **体重涨了也给正反馈**：肯站上秤本身就是值得肯定的行为。
 *  4) **文案要具体、带一点幽默**，不要「加油你最棒」这种空话。
 */

import { calcEntry, round } from './calc.js';
import { todayKey, shiftDate } from './store.js';

/* ── 称呼 ───────────────────────────────── */

/**
 * 怎么称呼使用的人。可以在「她的资料」里填，留空就不显示称呼。
 *
 * 注意：默认值不再是某个具体名字 —— 这个工具要给别人用，
 * 硬编码人名会让其他人觉得「这不是给我做的」。空字符串表示「不称呼」。
 * 所有个性化文案都从这里取，不要在各处硬编码名字。
 */
export function nickname(state) {
  const n = state?.profile?.nickname;
  return (typeof n === 'string' && n.trim()) ? n.trim().slice(0, 8) : '';
}

/**
 * 徽章在界面上显示的名字。
 *
 * 以前这里会给「专属徽章」拼上用户昵称（「小繁的一周」那样）。
 * 已经去掉：这个工具要给别人用，昵称是私人的东西，不该写进通用功能里。
 * 现在所有徽章都用定义里的名字。保留这个函数是为了让界面只有一处决定显示名。
 */
export function badgeLabel(state, badge) {
  return badge?.name || '';
}

/**
 * 一天里不同时候的问候。
 * 刻意把「时段词」和「名字」分开返回：名字由界面拼（要加粗），
 * 否则容易出现「小繁，小繁」这种重复。
 */
export function greeting(state, hour = new Date().getHours()) {
  const name = nickname(state);
  const word = hour >= 5 && hour < 11 ? '早上好'
    : hour >= 11 && hour < 14 ? '中午好'
      : hour >= 14 && hour < 18 ? '下午好'
        : hour >= 18 && hour < 23 ? '晚上好'
          : '这么晚还没睡呀';
  return {
    icon: hour >= 18 || hour < 5 ? 'moon' : 'sun',
    word,
    name,
    // 没填称呼时不要留一个孤零零的逗号
    text: name ? `${word}，${name}` : word,
  };
}

/* ── 小工具 ─────────────────────────────── */

function dayEntries(state, key) {
  const day = state?.days?.[key];
  if (!day) return [];
  return Object.values(day.meals || {}).flat();
}

/** 某天有没有记录 */
export function hasLog(state, key) {
  return dayEntries(state, key).length > 0;
}

/** 某天的营养合计 */
export function dayTotals(state, key) {
  return dayEntries(state, key).reduce((acc, e) => {
    const f = calcEntry(e.food, e.grams);
    acc.kcal += f.kcal;
    acc.protein += f.protein;
    acc.fat += f.fat;
    acc.carb += f.carb;
    return acc;
  }, { kcal: 0, protein: 0, fat: 0, carb: 0 });
}

/** 连续记录天数（今天还没记不算断） */
export function currentStreak(state, today = todayKey()) {
  let cursor = today;
  if (!hasLog(state, cursor)) cursor = shiftDate(cursor, -1);
  let n = 0;
  for (let i = 0; i < 500; i++) {
    if (!hasLog(state, cursor)) break;
    n += 1;
    cursor = shiftDate(cursor, -1);
  }
  return n;
}

/** 历史最长连续记录 */
export function longestStreak(state, today = todayKey()) {
  const dates = Object.keys(state?.days || {}).filter((k) => hasLog(state, k)).sort();
  if (!dates.length) return 0;
  let best = 1; let run = 1;
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] === shiftDate(dates[i - 1], 1)) run += 1;
    else run = 1;
    best = Math.max(best, run);
  }
  return Math.max(best, currentStreak(state, today));
}

/** 累计记录天数 */
export function totalLoggedDays(state) {
  return Object.keys(state?.days || {}).filter((k) => hasLog(state, k)).length;
}

/** 最近 N 天的日期（含今天，从早到晚） */
export function recentDays(n, today = todayKey()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftDate(today, -i));
  return out;
}

/* ── 小植物 ─────────────────────────────── */

export const PLANT_STAGES = [
  { min: 0, icon: 'plant-sprout', name: '刚发芽', line: '记一笔，它就会长一点。' },
  { min: 3, icon: 'plant-leaf', name: '长叶子了', line: '三天了，它开始有样子了。' },
  { min: 7, icon: 'plant-pot', name: '变成小盆栽', line: '一周的记录，它站住了。' },
  { min: 14, icon: 'plant-tulip', name: '开花了', line: '两周。这已经不是"试试看"了。' },
  { min: 30, icon: 'plant-sunflower', name: '长成一朵向日葵', line: '一个月，养成了。' },
  { min: 60, icon: 'plant-tree', name: '长成一棵树', line: '两个月，谁也别想让你放弃了。' },
];

/**
 * 小植物的状态。
 * 刻意不返回「枯萎」这种状态：断记录只是不长，绝不倒退。
 */
export function plantState(state, today = todayKey()) {
  const streak = currentStreak(state, today);
  const total = totalLoggedDays(state);
  // 生长看「累计天数」而不是连续天数 —— 这样断过几天也不会变小
  const level = PLANT_STAGES.reduce((acc, s, i) => (total >= s.min ? i : acc), 0);
  const stage = PLANT_STAGES[level];
  const next = PLANT_STAGES[level + 1] || null;
  return {
    level,
    stage,
    streak,
    total,
    toNext: next ? next.min - total : 0,
    nextStage: next,
    line: total === 0
      ? '还没有记录。记第一笔，它就会发芽。'
      : (streak >= 2 ? stage.line : `${stage.line}（断开也不会枯萎，接着记就行）`),
  };
}

/* ── 成就徽章 ───────────────────────────── */

/**
 * 每个徽章给出：当前进度、目标、是否解锁。
 * kind 只用行为类（记录 / 蛋白 / 运动 / 体重 / 累计），不用「少吃」类。
 *
 * **条件不许重复**：v27 以前这里混进了 3 枚跟别人一模一样的徽章
 * （「开始的人」= 第一次记录、「稳定的一周」= 一周记录、「一个月」出现两次），
 * 以前徽章名是空的看不出来，名字修好后一眼就发现重复。现在 16 枚，各管一件事。
 */
export const ACHIEVEMENTS = [
  {
    id: 'first_log',
    name: '第一次记录',
    icon: 'badge-sprout',
    hint: '记下第一笔饮食',
    target: 1,
    progress: (s) => (totalLoggedDays(s) >= 1 ? 1 : 0),
    congrats: '开始了。最难的就是这一步。',
  },
  {
    id: 'days_3',
    name: '三天不断',
    icon: 'badge-leaf',
    hint: '累计记录 3 天',
    target: 3,
    progress: (s) => totalLoggedDays(s),
    congrats: '三天的数据已经能看出你平时怎么吃了 —— 这比任何猜测都准。',
  },
  {
    id: 'days_7',
    name: '一周记录',
    icon: 'badge-pot',
    hint: '累计记录 7 天',
    target: 7,
    progress: (s) => totalLoggedDays(s),
    congrats: '一周。现在可以回头看趋势了，不用再靠感觉。',
  },
  {
    id: 'days_30',
    name: '一个月',
    icon: 'badge-sunflower',
    hint: '累计记录 30 天',
    target: 30,
    progress: (s) => totalLoggedDays(s),
    congrats: '一个月。习惯这东西，到这个份上就不太容易掉了。',
  },
  {
    id: 'streak_7',
    name: '连记七天',
    icon: 'badge-flame',
    hint: '连续记录 7 天',
    target: 7,
    progress: (s) => currentStreak(s),
    congrats: '连着七天没落下。这种稳定比某一天吃得特别少有用得多。',
  },
  {
    id: 'streak_14',
    name: '两周不间断',
    icon: 'badge-sparkle',
    hint: '连续记录 14 天',
    target: 14,
    progress: (s) => currentStreak(s),
    congrats: '两周。两周的数据足够看出你真正的平均摄入，误差比任何公式都小。',
  },
  {
    id: 'streak_30',
    name: '三十天没断',
    icon: 'badge-mountain',
    hint: '连续记录 30 天',
    target: 30,
    progress: (s) => currentStreak(s),
    congrats: '三十天。说实话，大部分人做不到这一步。',
  },
  {
    id: 'protein_1',
    name: '第一次吃够蛋白',
    icon: 'badge-muscle',
    hint: '有一天蛋白质达标',
    target: 1,
    progress: (s, proteinTarget) => proteinDays(s, proteinTarget),
    congrats: '吃够蛋白是减脂期最值钱的一件事 —— 它决定了你掉的是脂肪还是肌肉。',
  },
  {
    id: 'protein_7',
    name: '蛋白七日达标',
    icon: 'badge-egg',
    hint: '累计 7 天蛋白质达标',
    target: 7,
    progress: (s, proteinTarget) => proteinDays(s, proteinTarget),
    congrats: '七天吃够蛋白。肌肉保住了，代谢就不会掉。',
  },
  {
    id: 'protein_30',
    name: '蛋白三十日达标',
    icon: 'badge-protein',
    hint: '累计 30 天蛋白质达标',
    target: 30,
    progress: (s, proteinTarget) => proteinDays(s, proteinTarget),
    congrats: '三十天。这已经是"会吃"的水平了。',
  },
  {
    id: 'first_exercise',
    name: '动了第一次',
    icon: 'badge-run',
    hint: '记下第一次运动',
    target: 1,
    progress: (s) => exerciseCount(s),
    congrats: '有氧不用多，动起来就是好事。',
  },
  {
    id: 'exercise_10',
    name: '运动十次',
    icon: 'badge-jersey',
    hint: '累计记录 10 次运动',
    target: 10,
    progress: (s) => exerciseCount(s),
    congrats: '十次。运动这件事，靠的不是强度，是次数。',
  },
  {
    id: 'weight_2',
    name: '敢上秤的人',
    icon: 'badge-scale',
    hint: '记录 2 次体重',
    target: 2,
    progress: (s) => (s?.weights || []).length,
    congrats: '体重会上下浮动，肯定期上秤看趋势，比天天称更靠谱。',
  },
  {
    id: 'weight_10',
    name: '十次体重记录',
    icon: 'badge-trend',
    hint: '累计记录 10 次体重',
    target: 10,
    progress: (s) => (s?.weights || []).length,
    congrats: '十条记录，足够画出真实趋势了 —— 单天的数字不再吓得到你。',
  },
  {
    id: 'custom_food',
    name: '自己建了食物',
    icon: 'badge-receipt',
    hint: '新增一个自定义食物',
    target: 1,
    progress: (s) => (s?.customFoods || []).length,
    congrats: '会看营养标签、会自己建食物，这就比大多数人专业了。',
  },
  {
    id: 'honest_log',
    name: '如实记录',
    icon: 'badge-heart',
    hint: '有一天吃了 3 餐以上',
    target: 1,
    progress: (s) => (maxMealsInADay(s) >= 3 ? 1 : 0),
    congrats: '把三餐都记下来不容易 —— 很多人只记"吃得健康"的那几顿。',
  },
];

/**
 * 蛋白质「达标」的天数。
 * 达标线 = 她自己的蛋白质目标（由 calcTargets 算出）。目标缺失时用 0，
 * 这样至少不会把「没达标」误判成「达标」。
 */
export function proteinDays(state, target) {
  const goal = Number.isFinite(target) && target > 0 ? target : 0;
  let n = 0;
  for (const key of Object.keys(state?.days || {})) {
    const t = dayTotals(state, key);
    if (t.kcal > 0 && t.protein >= goal) n += 1;
  }
  return n;
}

/** 运动条目总数 */
export function exerciseCount(state) {
  return Object.values(state?.days || {}).reduce((a, d) => a + (d.exercises?.length || 0), 0);
}

/** 一天里最多记了几餐 */
export function maxMealsInADay(state) {
  let best = 0;
  for (const d of Object.values(state?.days || {})) {
    const n = Object.values(d.meals || {}).filter((list) => (list || []).length > 0).length;
    best = Math.max(best, n);
  }
  return best;
}

/**
 * 算出全部徽章状态。
 * @param {object} state 存档
 * @param {number} proteinTarget 她的蛋白质目标（用于判断「达标」）
 * @returns {{list:Array, unlocked:Array, next:object|null, justUnlocked:Array}}
 */
export function achievements(state, proteinTarget) {
  const seen = new Set(state?.achievements?.seen || []);
  const list = ACHIEVEMENTS.map((a) => {
    const raw = a.progress(state, proteinTarget);
    const value = Math.max(0, Number.isFinite(raw) ? raw : 0);
    const unlocked = value >= a.target;
    return {
      id: a.id,
      name: a.name,
      icon: a.icon,
      hint: a.hint,
      congrats: a.congrats,
      target: a.target,
      value: Math.min(value, a.target),
      rawValue: value,
      unlocked,
      isNew: unlocked && !seen.has(a.id),
      pct: Math.min(100, Math.round((value / a.target) * 100)),
    };
  });
  const unlocked = list.filter((a) => a.unlocked);
  // 最接近解锁的那个，用来在界面上给「再记 1 天就……」
  const next = list
    .filter((a) => !a.unlocked)
    .sort((x, y) => (y.rawValue / y.target) - (x.rawValue / x.target))[0] || null;
  return {
    list,
    unlocked,
    next,
    justUnlocked: list.filter((a) => a.isNew),
  };
}

/** 把「已庆祝过」的徽章记下来，避免每次都弹一遍 */
export function markAchievementsSeen(state, ids) {
  state.achievements = state.achievements || { seen: [] };
  const seen = new Set(state.achievements.seen);
  for (const id of ids) seen.add(id);
  state.achievements.seen = [...seen];
  return state.achievements;
}

/* ── 记录之后的即时反馈 ──────────────────── */

/**
 * 记完一笔之后说的话。
 * 关键：反馈落在「做了记录」这件事上，而不是「吃了多少」。
 */
export function afterLogMessage(state, mealKey, proteinTarget, today = todayKey()) {
  const streak = currentStreak(state, today);
  const totals = dayTotals(state, today);
  const meals = Object.values(state.days?.[today]?.meals || {}).filter((l) => l.length).length;
  const proteinPct = proteinTarget > 0 ? totals.protein / proteinTarget : 0;

  const name = nickname(state);
  if (streak === 1 && totalLoggedDays(state) === 1) {
    return { text: name ? `${name}的第一笔记录，成了。` : '第一笔记录，成了。', icon: 'badge-flower' };
  }
  if (streak === 3) return { text: '连着三天了，数据开始有形状。', icon: 'badge-leaf' };
  if (streak === 7) return { text: name ? `${name}一整周没落下。` : '一整周没落下。', icon: 'badge-blossom' };
  if (proteinPct >= 1) return { text: '今天的蛋白质达标了，这条最值钱。', icon: 'badge-muscle' };
  if (meals >= 3) return { text: '三餐都记全了，这种记录最有参考价值。', icon: 'badge-heart' };
  if (mealKey === 'breakfast') return { text: '早餐记上了 —— 很多人的早餐是最大的盲区。', icon: 'sun' };
  if (streak >= 2) return { text: `第 ${streak} 天了，记着就行。`, icon: 'badge-sparkle' };
  return { text: '记上了。', icon: 'check' };
}

/* ── 周报 ───────────────────────────────── */

/**
 * 最近 7 天的回顾。刻意不把「体重变化」放第一位 ——
 * 前面是行为（记录了几天、蛋白达标几次、运动几次），体重只作为一个数字附上。
 */
export function weeklyReview(state, { proteinTarget = 60, calorieTarget = 1500, today = todayKey() } = {}) {
  const days = recentDays(7, today);
  const logged = days.filter((k) => hasLog(state, k));
  const totals = logged.map((k) => dayTotals(state, k));
  const proteinHit = totals.filter((t) => t.protein >= proteinTarget).length;
  const exerciseDays = days.filter((k) => (state?.days?.[k]?.exercises || []).length > 0).length;
  const exerciseMin = days.reduce((a, k) => a + (state?.days?.[k]?.exercises || []).reduce((x, e) => x + e.minutes, 0), 0);
  const avgKcal = totals.length ? Math.round(totals.reduce((a, t) => a + t.kcal, 0) / totals.length) : 0;

  const weights = (state?.weights || []).filter((w) => days.includes(w.date)).sort((a, b) => a.date.localeCompare(b.date));
  const weightChange = weights.length >= 2 ? round(weights[weights.length - 1].kg - weights[0].kg, 1) : null;

  const lines = [];
  if (!logged.length) {
    const who = nickname(state);
    lines.push(`${who ? `${who}这` : '这'}周还没记录。没关系，今天记一笔就是新开始 —— 之前的数据都还在。`);
  } else {
    const who = nickname(state);
    lines.push(`${who ? `${who}这` : '这'}一周记了 ${logged.length} 天${logged.length >= 5 ? '，很稳' : '，够用了'}。`);
    if (proteinHit >= 3) lines.push(`有 ${proteinHit} 天蛋白质吃够了 —— 这是保住肌肉的关键，比少吃更有用。`);
    else lines.push(`蛋白质达标 ${proteinHit} 天。不用急，先从"每餐都有一点肉蛋奶"开始。`);
    if (exerciseDays) lines.push(`动了 ${exerciseDays} 天，一共 ${exerciseMin} 分钟。`);
    if (avgKcal) lines.push(`记录日的平均摄入约 ${avgKcal} kcal（对比目标 ${calorieTarget}）。`);
    if (weightChange !== null) {
      if (weightChange <= -0.2 && weightChange >= -1) lines.push(`体重变化 ${weightChange} 公斤，节奏是健康的。`);
      else if (weightChange < -1) lines.push(`体重掉了 ${Math.abs(weightChange)} 公斤，有点快 —— 建议每天多吃 150~200 kcal，别掉肌肉。`);
      else if (weightChange > 0.2) lines.push(`体重涨了 ${weightChange} 公斤。一天之内的浮动很正常，看两周平均才有意义。`);
      else lines.push('体重基本没动。如果连续两周都这样，我们再调一下热量。');
    }
  }

  return {
    days: days.map((k) => ({ date: k, logged: hasLog(state, k), totals: dayTotals(state, k), exercises: state?.days?.[k]?.exercises?.length || 0 })),
    loggedDays: logged.length,
    proteinHitDays: proteinHit,
    exerciseDays,
    exerciseMin,
    avgKcal,
    weightChange,
    lines,
  };
}

/** 一周里的高光（用来做周报标题） */
export function weeklyHighlight(review) {
  if (review.loggedDays >= 7) return { icon: 'badge-trophy', text: '整整七天都记了' };
  if (review.proteinHitDays >= 5) return { icon: 'badge-muscle', text: '这周蛋白质吃得很好' };
  if (review.exerciseDays >= 3) return { icon: 'badge-run', text: '这周动得挺勤' };
  if (review.loggedDays >= 4) return { icon: 'badge-leaf', text: '记录得挺稳定' };
  if (review.loggedDays >= 1) return { icon: 'badge-sprout', text: '开始记了，这就够了' };
  return { icon: 'badge-heart', text: '这周先歇着也行' };
}

/** 里程碑：每满 10 天给一张不同的花（对所有用户一样） */
export const MILESTONES = [
  { days: 10, icon: 'badge-tulip', text: '十天了' },
  { days: 20, icon: 'badge-sunflower', text: '二十天了' },
  { days: 30, icon: 'badge-blossom', text: '一个月了' },
  { days: 50, icon: 'badge-crown', text: '五十天了' },
  { days: 100, icon: 'badge-medal', text: '一百天' },
];

/**
 * 这次记录有没有刚好踩到里程碑。
 * 返回最近踩到的那一个（没踩到返回 null）。
 */
export function hitMilestone(state, today = todayKey()) {
  const total = totalLoggedDays(state);
  const hit = MILESTONES.find((m) => m.days === total);
  if (!hit) return null;
  return { ...hit };
}

/** 该不该弹周报：每周一弹一次，且这周有记录 */
export function shouldShowWeekly(state, today = todayKey()) {
  const last = state?.achievements?.lastWeeklyAt || null;
  if (last === today) return false;
  const [y, m, d] = today.split('-').map(Number);
  const isMonday = new Date(y, m - 1, d).getDay() === 1;
  if (!isMonday) return false;
  const review = weeklyReview(state, { today });
  return review.loggedDays > 0;
}
