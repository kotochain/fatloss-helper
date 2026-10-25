import { round } from './calc.js';
import { buildMealPlan } from './recommend.js';

/** 结构版本号由 js/schema.js 统一管理（那里有完整的迁移链），这里只是本地别名 */
import { SCHEMA_VERSION } from './schema.js';
export const STATE_VERSION = SCHEMA_VERSION;

/** 空状态：还没填资料 */
export function emptyState() {
  return {
    version: STATE_VERSION,      // 历史字段（老代码读它）；现在统一用 schemaVersion
    schemaVersion: STATE_VERSION,
    profile: null,
    settings: { trainDays: 3, stepsKey: 'mid' },
    days: {},
    customFoods: [],
    weights: [],
    // 成长记录：已庆祝过的徽章、上次看周报的日期
    achievements: { seen: [], lastWeeklyAt: null, milestones: [] },
  };
}

/** 补齐旧版本数据缺的字段，避免升级后打不开 */
export function migrate(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    version: STATE_VERSION,
    settings: { ...base.settings, ...(raw.settings || {}) },
    days: raw.days && typeof raw.days === 'object' ? raw.days : {},
    customFoods: Array.isArray(raw.customFoods) ? raw.customFoods : [],
    weights: Array.isArray(raw.weights) ? raw.weights : [],
    achievements: {
      seen: Array.isArray(raw.achievements?.seen) ? raw.achievements.seen : [],
      lastWeeklyAt: raw.achievements?.lastWeeklyAt || null,
      milestones: Array.isArray(raw.achievements?.milestones) ? raw.achievements.milestones : [],
    },
  };
}

/** 本地日期，格式 2026-10-16。不能用 toISOString，那是 UTC，晚上会串到第二天 */
export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftDate(key, deltaDays) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + deltaDays);
  return todayKey(dt);
}

/** 取某天的数据；没有就建一个空的（懒加载，不用预填一堆空日子） */
export function getDay(state, key) {
  if (!state.days[key]) {
    state.days[key] = { meals: { breakfast: [], lunch: [], dinner: [], snack: [] }, exercises: [], note: '' };
  }
  const day = state.days[key];
  day.meals = day.meals || { breakfast: [], lunch: [], dinner: [], snack: [] };
  for (const k of ['breakfast', 'lunch', 'dinner', 'snack']) day.meals[k] = day.meals[k] || [];
  day.exercises = day.exercises || [];
  // 兼容早期存档：记录里没有 meal 字段的，按所在餐位补上
  for (const [key, list] of Object.entries(day.meals)) {
    for (const e of list) if (!e.meal) e.meal = key;
  }
  return day;
}

/**
 * 真的记过东西的日子（食物 / 运动 / 备注）。
 *
 * 为什么不能直接数 `days` 的键：渲染今天页、洞察会顺手建出空日期，
 * 于是「只记了 1 天」会被数成 14 天。备份提示和「覆盖前要不要确认」都要用这个数，
 * 所以要有一个唯一来源，不能每处各写一遍。
 */
export function recordedDays(state) {
  const days = state?.days;
  if (!days || typeof days !== 'object') return [];
  return Object.keys(days).filter((key) => {
    const d = days[key];
    if (!d) return false;
    const foods = Object.values(d.meals || {}).flat().filter((e) => e && e.food).length;
    return foods > 0 || (d.exercises || []).length > 0 || String(d.note || '').trim().length > 0;
  });
}

/**
 * 有没有「丢了会心疼」的东西：记录、体重、自己加的食物、填好的资料。
 *
 * 演示数据、导入存档都是**整包替换**，覆盖前必须先问一句并留快照。
 * 判断放在这里而不是界面里，是因为以后新增覆盖入口（比如分享链接）还会用到它。
 */
export function hasUserData(state) {
  if (!state || typeof state !== 'object') return false;
  return recordedDays(state).length > 0
    || (Array.isArray(state.weights) && state.weights.length > 0)
    || (Array.isArray(state.customFoods) && state.customFoods.length > 0)
    || Boolean(state.profile);
}

let seq = 0;
function newId(prefix) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

/**
 * 把一条食物记录放进某一天某一餐
 * @returns {object} 新记录（调用方负责存盘）
 */
/** 份量必须是真正的数字：字符串 '200' 会悄悄通过 > 0 的判断，必须显式挡住 */
export function normalizeGrams(grams) {
  if (typeof grams !== 'number' || !Number.isFinite(grams) || grams <= 0) {
    throw new Error(`份量必须是大于 0 的数字，收到了 ${JSON.stringify(grams)}`);
  }
  if (grams > 5000) throw new Error('单次份量超过 5000 克，请确认单位（斤 / 两 / 克）');
  return Math.round(grams);
}

export function addFoodEntry(state, dateKey, mealKey, food, grams) {
  const g = normalizeGrams(grams);
  const day = getDay(state, dateKey);
  const slot = day.meals[mealKey];
  if (!slot) throw new Error(`没有这一餐：${mealKey}`);
  // meal 字段必须存进记录里：按餐汇总、界面分组都靠它
  const entry = { id: newId('e'), meal: mealKey, food: { ...food }, grams: g, createdAt: new Date().toISOString() };
  slot.push(entry);
  return entry;
}

export function removeFoodEntry(state, dateKey, entryId) {
  const day = getDay(state, dateKey);
  for (const k of Object.keys(day.meals)) {
    const i = day.meals[k].findIndex((e) => e.id === entryId);
    if (i >= 0) {
      day.meals[k].splice(i, 1);
      return true;
    }
  }
  return false;
}

export function updateFoodEntry(state, dateKey, entryId, patch) {
  const day = getDay(state, dateKey);
  for (const k of Object.keys(day.meals)) {
    const e = day.meals[k].find((x) => x.id === entryId);
    if (e) {
      Object.assign(e, patch);
      return e;
    }
  }
  return null;
}

/**
 * 记一次运动。
 *
 * 时长必须校验：0 或负数会被存进去变成「练了 0 分钟」，
 * 让统计里多出一条假记录（次数对了、时长却没变），比直接拒绝更难查。
 * 校验放在这里而不是各个界面里 —— 界面有两个入口，漏一个就漏了。
 *
 * @returns {object|null} 记上的条目；时长不合法时返回 null（由界面提示）
 */
export function addExercise(state, dateKey, exerciseKey, minutes) {
  const m = Math.round(Number(minutes));
  if (!Number.isFinite(m) || m <= 0 || m > 1440) return null;
  if (!exerciseKey) return null;
  const day = getDay(state, dateKey);
  const item = { id: newId('x'), exerciseKey, minutes: m };
  day.exercises.push(item);
  return item;
}

export function removeExercise(state, dateKey, id) {
  const day = getDay(state, dateKey);
  const i = day.exercises.findIndex((x) => x.id === id);
  if (i >= 0) {
    day.exercises.splice(i, 1);
    return true;
  }
  return false;
}

export function addWeight(state, dateKey, kg) {
  if (!(kg > 0)) throw new Error('体重必须大于 0');
  const list = state.weights.filter((w) => w.date !== dateKey);
  list.push({ date: dateKey, kg: Math.round(kg * 10) / 10 });
  list.sort((a, b) => a.date.localeCompare(b.date));
  state.weights = list;
  return list;
}

/**
 * 常吃的食物：按出现次数排序，用来做「记录」页的快捷入口。
 * 只看最近 30 天，避免一年前的习惯一直霸榜。
 */
export function frequentFoods(state, limit = 8) {
  const counter = new Map();
  const dates = Object.keys(state.days || {}).sort().reverse().slice(0, 30);
  for (const d of dates) {
    for (const e of Object.values(state.days[d].meals || {}).flat()) {
      if (!e || !e.food || !e.food.id) continue;
      // 「只填热量」是一条一次性的数字，不是一种食物：放进「常吃的」会变成
      // 一个「100 克 = 650 kcal」的怪快捷项，点它还得再填克数
      if (e.food.kcalOnly) continue;
      const cur = counter.get(e.food.id) || { food: e.food, count: 0, grams: e.grams };
      cur.count += 1;
      cur.grams = e.grams;
      counter.set(e.food.id, cur);
    }
  }
  return [...counter.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * 把一样「我的食物」存进本机（每 100 克营养）。
 *
 * 来源有两种：
 *  - `manual`：照包装/手动新增；
 *  - `ai-estimate`（v34）：AI 估的营养，过完本地校验后由「说一句」的保存流程自动存进来。
 *    下次再说同一个名字会优先命中它（不用再让 AI 估一遍，数字也稳定）。
 *
 * 同名（忽略空格/大小写）已经存过就更新数字，不再追加 —— 否则反复说同一道菜会把列表撑爆，
 * 而匹配永远只取第一条，后面的改了也没用。
 */
export function addCustomFood(state, food) {
  const name = String(food?.name || '').trim().slice(0, 40);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const now = new Date().toISOString();
  const numbers = {
    kcal: num(food.kcal),
    protein: num(food.protein),
    fat: num(food.fat),
    carb: num(food.carb),
    servings: food.servings && food.servings.length ? food.servings : [['一份', food.baseGrams || 100]],
  };
  const meta = {
    source: food.source === 'ai-estimate' ? 'ai-estimate' : 'manual',
    note: food.note ? String(food.note).slice(0, 120) : '',
  };
  const key = name.toLowerCase().replace(/\s+/g, '');
  const exists = state.customFoods.find((f) => String(f.name || '').toLowerCase().replace(/\s+/g, '') === key);
  if (exists) {
    Object.assign(exists, numbers, meta, { updatedAt: now });
    if (food.originalText) exists.originalText = String(food.originalText).slice(0, 200);
    return exists;
  }
  const item = { id: newId('c'), name, category: 'custom', ...numbers, ...meta, createdAt: now };
  if (food.originalText) item.originalText = String(food.originalText).slice(0, 200);
  state.customFoods.push(item);
  return item;
}

/** 体重趋势：取最近 N 条，算出平均每天变化 */
export function weightTrend(state, limit = 30) {
  const list = [...state.weights].sort((a, b) => a.date.localeCompare(b.date)).slice(-limit);
  return list;
}

/**
 * 按体重变化推算「实际热量缺口」，用来验证吃得对不对。
 * 需要至少 2 条记录、间隔至少 7 天，否则不给结论。
 */
export function analyzeProgress(state) {
  const list = weightTrend(state, 60);
  if (list.length < 2) {
    return { ok: false, reason: '至少记录两次体重（间隔 7 天以上）才能看出趋势。' };
  }
  const first = list[0];
  const last = list[list.length - 1];
  const days = Math.round((new Date(last.date) - new Date(first.date)) / 86400000);
  if (days < 7) {
    return { ok: false, reason: `两次记录只隔了 ${days} 天，至少要 7 天才看得出趋势（体重每天会上下浮动 1 公斤左右）。` };
  }
  const deltaKg = last.kg - first.kg;
  const perWeek = (deltaKg / days) * 7;
  let verdict;
  if (perWeek <= -0.2 && perWeek >= -1.0) verdict = '节奏很好，保持现在的吃法和运动。';
  else if (perWeek < -1.0) verdict = '掉得偏快，容易掉肌肉和代谢下降，建议每天多吃 150~200 kcal（比如多半碗饭）。';
  else if (perWeek < -0.05) verdict = '掉得比较慢但方向对。如果连续两周几乎不动，可以每天少吃 100~150 kcal，或把走路加到 8000 步。';
  else if (perWeek <= 0.05) verdict = '体重基本没动。先确认是不是漏记了零食和饮料，再考虑调整。';
  else verdict = '体重在涨。如果不是在增肌，检查一下份量记录和外食频率。';
  return {
    ok: true,
    days,
    fromKg: first.kg,
    toKg: last.kg,
    deltaKg: round(deltaKg, 1),
    perWeek: round(perWeek, 2),
    verdict,
  };
}

/**
 * 演示/自检用的完整示例：填资料 → 生成餐单 → 记一天饮食。
 * 只在本地用，用户点「试用示例」时才会跑。
 */
export function demoProfile() {
  return {
    nickname: '小繁',
    sex: 'female',
    age: 26,
    heightCm: 163,
    weightKg: 58,
    bodyFatPct: null,
    activity: 'light',
    pace: 'standard',
    goal: 'lose',
    targetWeightKg: 54,
  };
}

export function demoEntries(state, dateKey, targets) {
  const plan = buildMealPlan(targets, { seed: 1 });
  const added = [];
  for (const meal of plan.meals) {
    for (const item of meal.items) {
      added.push(addFoodEntry(state, dateKey, meal.key, item.food, item.grams));
    }
  }
  addExercise(state, dateKey, 'walk', 30);
  return added;
}

