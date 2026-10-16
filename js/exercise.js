/**
 * 运动建议 + 运动记录：练什么、练几组、大概消耗多少热量、以及记下来之后怎么统计
 *
 * 消耗热量用 METs 估算：消耗(kcal) = METs × 体重(kg) × 小时数
 * METs 数值参考《体力活动概要》（Compendium of Physical Activities）的常见条目，属于估算值。
 * 手环上的数字和这里对不上很正常，两者都是估算。
 */

import { CARDIO } from './cardio.js';
import { calcExerciseKcal } from './calc.js';
import { addExercise, shiftDate, todayKey } from './store.js';

export const EXERCISES = {
  walk: { name: '快走', mets: 4.3, kind: 'cardio', unit: '分钟' },
  jog: { name: '慢跑', mets: 8.3, kind: 'cardio', unit: '分钟' },
  cycle: { name: '骑车（中等强度）', mets: 6.8, kind: 'cardio', unit: '分钟' },
  swim: { name: '游泳', mets: 7.0, kind: 'cardio', unit: '分钟' },
  jump_rope: { name: '跳绳', mets: 11.0, kind: 'cardio', unit: '分钟' },
  elliptical: { name: '椭圆机', mets: 5.0, kind: 'cardio', unit: '分钟' },
  hiit: { name: 'HIIT 间歇训练', mets: 8.0, kind: 'cardio', unit: '分钟' },
  yoga: { name: '瑜伽/拉伸', mets: 2.5, kind: 'cardio', unit: '分钟' },
  stairs: { name: '爬楼梯', mets: 8.8, kind: 'cardio', unit: '分钟' },
  badminton: { name: '羽毛球', mets: 5.5, kind: 'cardio', unit: '分钟' },
  dance: { name: '跳舞（跟着视频）', mets: 5.0, kind: 'cardio', unit: '分钟' },
  strength: { name: '力量训练', mets: 5.0, kind: 'strength', unit: '分钟' },
  bodyweight: { name: '自重训练（徒手）', mets: 3.8, kind: 'strength', unit: '分钟' },
};

/** 训练日模板：4 天循环，按每周可练天数取前 N 天 */
export const WEEK_TEMPLATES = {
  2: [
    { title: '全身力量（A）', type: 'strength', minutes: 40, blocks: [
      { name: '深蹲（徒手或抱哑铃）', sets: '3 组 × 12 次' },
      { name: '俯卧撑（可跪姿）', sets: '3 组 × 8-12 次' },
      { name: '臀桥', sets: '3 组 × 15 次' },
      { name: '哑铃划船（或弹力带拉背）', sets: '3 组 × 12 次' },
      { name: '平板支撑', sets: '3 组 × 30 秒' },
    ] },
    { title: '快走或慢跑 + 核心', type: 'cardio', minutes: 35, blocks: [
      { name: '快走/慢跑（能说话但唱不了歌的强度）', sets: '30 分钟' },
      { name: '死虫式 / 卷腹', sets: '3 组 × 12 次' },
    ] },
  ],
  3: [
    { title: '下肢 + 臀（力量）', type: 'strength', minutes: 45, blocks: [
      { name: '深蹲', sets: '4 组 × 10-12 次' },
      { name: '罗马尼亚硬拉（哑铃）', sets: '3 组 × 12 次' },
      { name: '后撤步箭步蹲', sets: '3 组 × 每侧 10 次' },
      { name: '臀桥 / 髋外展', sets: '3 组 × 15 次' },
      { name: '平板支撑', sets: '3 组 × 40 秒' },
    ] },
    { title: '有氧（快走 / 椭圆机 / 跳绳）', type: 'cardio', minutes: 35, blocks: [
      { name: '中等强度有氧', sets: '30 分钟，心率保持在微喘但不至于说不了话' },
      { name: '拉伸', sets: '5 分钟' },
    ] },
    { title: '上肢 + 核心（力量）', type: 'strength', minutes: 45, blocks: [
      { name: '俯卧撑（可跪姿）', sets: '4 组 × 8-12 次' },
      { name: '哑铃划船', sets: '4 组 × 12 次' },
      { name: '哑铃肩推', sets: '3 组 × 12 次' },
      { name: '臀桥', sets: '3 组 × 15 次' },
      { name: '侧平板', sets: '3 组 × 每侧 30 秒' },
    ] },
  ],
  4: [
    { title: '下肢（力量）', type: 'strength', minutes: 45, blocks: [
      { name: '深蹲', sets: '4 组 × 10 次' },
      { name: '硬拉（哑铃/壶铃）', sets: '3 组 × 10 次' },
      { name: '箭步蹲', sets: '3 组 × 每侧 12 次' },
      { name: '臀桥', sets: '3 组 × 15 次' },
    ] },
    { title: '有氧 + 核心', type: 'cardio', minutes: 40, blocks: [
      { name: '快走/慢跑/单车', sets: '30 分钟' },
      { name: '卷腹 + 俄罗斯转体 + 平板', sets: '各 3 组' },
    ] },
    { title: '上肢（力量）', type: 'strength', minutes: 45, blocks: [
      { name: '俯卧撑 / 上斜俯卧撑', sets: '4 组 × 10 次' },
      { name: '哑铃划船', sets: '4 组 × 12 次' },
      { name: '哑铃推举', sets: '3 组 × 12 次' },
      { name: '俯身飞鸟（轻重量）', sets: '3 组 × 15 次' },
    ] },
    { title: 'HIIT 或跳绳', type: 'cardio', minutes: 25, blocks: [
      { name: '跳绳 30 秒 + 休息 30 秒', sets: '循环 12-15 轮' },
      { name: '拉伸', sets: '5-8 分钟' },
    ] },
  ],
};

export const STEP_TARGETS = [
  { key: 'low', label: '目前基本不动', steps: 6000, hint: '先从每天 6000 步开始，比硬上 1 万步更容易坚持' },
  { key: 'mid', label: '每天有走一点', steps: 8000, hint: '8000 步是性价比很高的一档' },
  { key: 'high', label: '已经走得比较多', steps: 10000, hint: '保持住，别为了凑步数熬夜走路' },
];

/**
 * 生成一周训练安排
 * @param {'2'|'3'|'4'|number} daysPerWeek 每周能练几天
 * @param {{ sedentary?: boolean, stepsKey?: string }} profile
 */
export function buildWeekPlan(daysPerWeek, profile = {}) {
  const days = Math.min(4, Math.max(2, Number(daysPerWeek) || 3));
  const template = WEEK_TEMPLATES[days];
  const stepInfo = STEP_TARGETS.find((s) => s.key === profile.stepsKey) || STEP_TARGETS[1];
  return {
    daysPerWeek: days,
    sessions: template,
    stepTarget: stepInfo.steps,
    stepHint: stepInfo.hint,
    notes: [
      '力量训练每周 2~4 次就足够，同一个部位之间至少隔 48 小时。',
      `每天走路目标 ${stepInfo.steps} 步，走路是减脂期最不占用意志力的消耗方式。`,
      '减脂主要靠吃，运动负责保住肌肉和让身材线条好看。别指望靠运动把吃多的热量练掉。',
      '每次力量训练后 1~2 小时内吃点蛋白质（比如一杯酸奶或两个鸡蛋），恢复更好。',
      '睡够 7 小时。睡不够会让饿感激素上升，第二天特别容易吃多。',
    ],
  };
}

export function listExercises() {
  return Object.entries(EXERCISES).map(([key, e]) => ({ key, ...e }));
}

/* ── 运动记录与统计 ────────────────────────────────
   把「记一次运动」收敛到这一个地方，是因为：
    1)「记录」页和「推荐」页都要能记，各写一遍消耗换算，两处迟早对不上；
    2) 记录里存下当时的动作名和 METs —— 动作库以后改了，历史记录不该跟着变样；
    3)「今天几次 / 这周几次 / 累计多久」只有一份实现，今天页、记录页、历史列表用的是同一个数。
   消耗始终是估算：kcal = METs × 体重(kg) × 小时数。
   ────────────────────────────────────────────────── */

/** 单次运动的最长合理时长：超过这个数基本是输错了（10 小时） */
export const MAX_TRAINING_MINUTES = 600;
/** 最短一次：再短就没法算了（四舍五入会把 0.4 分钟变成 0 分钟） */
export const MIN_TRAINING_MINUTES = 1;

/**
 * 有氧库动作 → 旧 METs 池的 key。
 *
 * 为什么两个都存：老代码（今天页的兜底、成就）还在读 exerciseKey，而动作库的 METs 比旧池细
 * （爬坡走 6.3、旧池的 walk 只有 4.3）。两处都存，历史和旧逻辑就都不会错。
 */
const CARDIO_POOL_KEY = {
  treadmill_walk: 'walk', treadmill_incline_walk: 'walk', outdoor_walk: 'walk',
  treadmill_run: 'jog', outdoor_jog: 'jog', treadmill_interval: 'jog',
  elliptical_steady: 'elliptical', elliptical_interval: 'elliptical', stepper: 'elliptical',
  bike_steady: 'cycle', bike_interval: 'cycle', spin_class: 'cycle', outdoor_cycle: 'cycle',
  rower_steady: 'strength', stair_climber: 'stairs', real_stairs: 'stairs',
  jump_rope: 'jump_rope', jump_rope_low: 'jump_rope',
  bodyweight_circuit: 'hiit', hiit_video: 'hiit',
  swim_steady: 'swim', badminton: 'badminton', dance_class: 'dance', yoga_stretch: 'yoga',
};

/** 有氧动作对应的旧池 key（真没有对应项时按快走记 —— 宁可保守，也不要凭空拔高消耗） */
export function cardioPoolKey(cardioId) {
  return CARDIO_POOL_KEY[cardioId] || 'walk';
}

/** 强度只记给自己看。不拿它去乘 METs —— 动作本身的 METs 已经代表强度了，乘两次会把消耗算虚高 */
export const TRAINING_INTENSITY = {
  easy: { name: '轻松' },
  normal: { name: '中等' },
  hard: { name: '吃力' },
};

/** 力量类动作：有氧库不收这类动作，但「一周练什么」里就有力量日，不能只有有氧可记 */
export function strengthActions() {
  return Object.entries(EXERCISES)
    .filter(([, e]) => e.kind === 'strength')
    .map(([key, e]) => ({ key, ...e }));
}

/**
 * 今天能记的动作：有氧库按勾选的器械过滤，力量类不需要器械所以都给。
 * 只给做得了的动作 —— 记一个「今天没有的机器」比不记还让人泄气。
 */
export function trainingActions(equipment = []) {
  const avail = new Set(equipment);
  return {
    cardio: CARDIO.filter((e) => e.equipment.some((q) => avail.has(q))),
    strength: strengthActions(),
  };
}

/** 动作 → 记录里要存的四样东西（哪来的、什么名字、什么强度、旧池 key） */
export function resolveTrainingAction({ cardioId = null, exerciseKey = null } = {}) {
  if (cardioId) {
    const e = CARDIO.find((x) => x.id === cardioId);
    if (!e) return null;
    return { cardioId: e.id, exerciseKey: cardioPoolKey(e.id), name: e.name, mets: e.mets };
  }
  if (exerciseKey) {
    const e = EXERCISES[exerciseKey];
    if (!e) return null;
    return { cardioId: null, exerciseKey, name: e.name, mets: e.mets };
  }
  return null;
}

/** 时长必须是真的数字：字符串 '30' 能通过 > 0 的判断，存进去却会让统计变成字符串拼接 */
function normalizeTrainingMinutes(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
    throw new Error(`时长要填数字（分钟），收到了 ${JSON.stringify(minutes)}`);
  }
  if (!(minutes > 0)) throw new Error('时长要大于 0 分钟，0 和负数都记不了。');
  const m = Math.round(minutes);
  if (m < MIN_TRAINING_MINUTES) throw new Error(`时长太短了，至少 ${MIN_TRAINING_MINUTES} 分钟。`);
  if (m > MAX_TRAINING_MINUTES) throw new Error(`单次运动 ${m} 分钟？超过 ${MAX_TRAINING_MINUTES} 分钟（10 小时）多半是输错了，请确认。`);
  return m;
}

function normalizeTrainingIntensity(intensity) {
  if (intensity === undefined || intensity === null || intensity === '') return '';
  if (!TRAINING_INTENSITY[intensity]) {
    throw new Error(`强度只能是 easy / normal / hard，收到了 ${JSON.stringify(intensity)}`);
  }
  return intensity;
}

/** 备注只留一行短句：记的是「今天为什么和平时不一样」，不是日记 */
function normalizeTrainingNote(note) {
  if (typeof note !== 'string') return '';
  return note.trim().slice(0, 60);
}

/**
 * 记一次运动。界面上的两个入口（记录页、推荐页）都走这里，记录的形状只在这里定义一次。
 * @returns {object} 新记录（调用方负责存盘）
 */
export function logTraining(state, dateKey, opts = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) {
    throw new Error(`日期格式不对：${JSON.stringify(dateKey)}`);
  }
  const action = resolveTrainingAction(opts);
  if (!action) throw new Error('要先选一个动作才能记（有氧动作或力量训练都行）。');
  const minutes = normalizeTrainingMinutes(opts.minutes);
  const intensity = normalizeTrainingIntensity(opts.intensity);
  const note = normalizeTrainingNote(opts.note);

  // 仍然走 store 的 addExercise：id、入哪个数组这些事只由 store 决定
  const item = addExercise(state, dateKey, action.exerciseKey, minutes);
  Object.assign(item, {
    cardioId: action.cardioId,
    name: action.name,
    mets: action.mets,
    intensity,
    note,
    createdAt: new Date().toISOString(),
  });
  return item;
}

/**
 * 运动消耗只把一半算进「今天还可以吃」的额度。
 *
 * 这是产品原则，不是随手取的系数：
 *  - 全算回去 = 一运动就鼓励多吃，热量缺口当天就没了，减脂直接停滞；
 *  - 完全不算 = 明明动了却不认，用户会觉得白练（而且现有文案一直说的是「只算一半」）。
 * 所以「一半」是刻意的折中，且界面上必须写清这是估算。
 */
export const TRAINING_BUDGET_SHARE = 0.5;

/** 一次运动的消耗里，可以计入当天额度的部分 */
export function trainingBudgetBonus(kcal) {
  const n = Number(kcal);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * TRAINING_BUDGET_SHARE);
}

/** 一条记录的 METs：优先用记下来那一刻的值；这次改动之前的老记录没有，退回旧 METs 池 */
export function trainingEntryMets(entry) {
  const stored = Number(entry?.mets);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const pool = EXERCISES[entry?.exerciseKey];
  return pool?.mets ?? 4;   // 都不认识时按快走强度算，不编一个好看的数字
}

/** 一条记录显示的名字 */
export function trainingEntryName(entry) {
  if (typeof entry?.name === 'string' && entry.name) return entry.name;
  return EXERCISES[entry?.exerciseKey]?.name || String(entry?.exerciseKey || '运动');
}

/** 一次运动的大致消耗（估算）。时长不合法时按 0 算，界面才不会显示 NaN */
export function estimateTrainingKcal(entry, weightKg) {
  const minutes = Math.round(Number(entry?.minutes) || 0);
  if (!(minutes > 0)) return 0;
  return calcExerciseKcal({ mets: trainingEntryMets(entry), weightKg, minutes });
}

/** 给界面用的一条：名字、时长、估算消耗、强度、备注都在这里拼好 */
export function describeTraining(entry, weightKg) {
  const intensityKey = TRAINING_INTENSITY[entry?.intensity] ? entry.intensity : '';
  return {
    id: entry?.id || null,
    name: trainingEntryName(entry),
    minutes: Math.round(Number(entry?.minutes) || 0),
    kcal: Math.round(estimateTrainingKcal(entry, weightKg)),
    intensityKey,
    intensityName: intensityKey ? TRAINING_INTENSITY[intensityKey].name : '',
    note: typeof entry?.note === 'string' ? entry.note : '',
    createdAt: entry?.createdAt || null,
  };
}

/** 一天的运动汇总。没有这一天就按 0 算，不新建空日子（汇总函数不该改存档） */
export function dayTraining(day, weightKg) {
  const list = (day?.exercises || []).filter(Boolean);
  let minutes = 0;
  let kcal = 0;
  for (const x of list) {
    minutes += Math.round(Number(x?.minutes) || 0);
    kcal += estimateTrainingKcal(x, weightKg);
  }
  return { count: list.length, minutes, kcal: Math.round(kcal) };
}

/**
 * 这一周的周一（本地日期）。按国内日历习惯，一周从周一算起；
 * 不能用 toISOString 取日期 —— 那是 UTC，晚上会串到第二天。
 */
export function weekStartKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) throw new Error(`日期格式不对：${JSON.stringify(dateKey)}`);
  const sinceMonday = (dt.getDay() + 6) % 7;   // 周一 = 0，周日 = 6
  dt.setDate(dt.getDate() - sinceMonday);
  return todayKey(dt);
}

/**
 * 运动统计：今天 / 这周 / 累计。
 * 这周只算 [周一, 周日] 这七天 —— 上周日和下周一的记录都不能算进来（跨周不串）。
 */
export function trainingSummary(state, dateKey, weightKg) {
  const days = state?.days || {};
  const start = weekStartKey(dateKey);
  const end = shiftDate(start, 6);
  const today = dayTraining(days[dateKey], weightKg);
  const week = { count: 0, minutes: 0, kcal: 0 };
  const total = { count: 0, minutes: 0, kcal: 0 };
  for (const [key, day] of Object.entries(days)) {
    const s = dayTraining(day, weightKg);
    total.count += s.count;
    total.minutes += s.minutes;
    total.kcal += s.kcal;
    if (key >= start && key <= end) {
      week.count += s.count;
      week.minutes += s.minutes;
      week.kcal += s.kcal;
    }
  }
  return { today, week, total, weekStart: start, weekEnd: end };
}

/**
 * 运动历史：按天倒序分组，最近的在前面；只返回有记录的天。
 * 列表 + 数字就够了，不做图表 —— 图表会让人盯着曲线，而不是穿上鞋。
 */
export function trainingHistory(state, { days = 14, weightKg } = {}) {
  const out = [];
  const keys = Object.keys(state?.days || {}).sort().reverse();
  for (const key of keys) {
    const raw = (state.days[key]?.exercises || []).filter(Boolean);
    if (!raw.length) continue;
    // 同一天里新记的排前面：老记录没有 createdAt，就用「倒着取」保证顺序一致
    const items = raw.slice().reverse().map((e) => ({ ...describeTraining(e, weightKg), dateKey: key }));
    items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    out.push({ dateKey: key, items });
    if (out.length >= days) break;
  }
  return out;
}
