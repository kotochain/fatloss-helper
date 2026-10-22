/**
 * 存档版本与迁移
 *
 * 这是「能给别人用」的关键：用户的手机里存着真实记录，我改数据结构时必须保证
 * **升级不丢数据、不读坏数据**。所以这里的规则比较硬：
 *
 *  1) 每一版结构对应一个数字，只增不改；
 *  2) 升级就是按顺序跑一系列小迁移（v1→v2→v3），每一步都能单独测试；
 *  3) **绝不删除用户的记录**：不认识的多余字段原样留着，将来可能还要用；
 *  4) 如果存档版本比当前程序还新（用户装过新版、又用回旧版），**拒绝读取并提示升级**，
 *     而不是「尽力解析」—— 那会把新字段悄悄抹掉；
 *  5) 迁移前先自动留一份快照（见 BACKUP_KEY），出错能回滚。
 *
 * 注意：这个模块**不依赖 store.js**（版本号在这里定义），否则会形成循环依赖。
 */

/** 当前程序能处理的结构版本。改结构时 +1，并补一条迁移。 */
export const SCHEMA_VERSION = 4;

/** 历史别名（最早叫 version，现在统一叫 schemaVersion） */
export const LEGACY_VERSION = SCHEMA_VERSION;

/** 主存档键（历史键名保留，避免老用户升级后找不到自己的数据） */
export const STATE_KEY = 'fatloss.state.v2';
/** 迁移前的自动快照 */
export const BACKUP_KEY = 'fatloss.backup';
/**
 * 「读不出来的存档」原样留一份。
 *
 * 为什么要有这个键：主存档损坏、或者来自更新版本时，程序只能当作新用户打开。
 * 用户一旦点了「看一个填好的例子」或者走完引导，主键就被覆盖了 —— 原始内容就真的没了。
 * 先原样抄一份到旁边，覆盖也不会丢，之后还能导出给我看 / 手工抢救。
 */
export const UNREADABLE_KEY = 'fatloss.state.unreadable';
/** 旧版本（最初几个版本用过这个键名） */
export const LEGACY_KEYS = ['fatloss.state.v1', 'fatloss_state'];

/**
 * 迁移列表：从 from 到 to 的最小改动。
 * 每一步只做一件事，方便单独测试；只加字段、改字段含义，不删数据。
 */
export const MIGRATIONS = [
  {
    from: 1,
    to: 2,
    description: '记录里补上 meal 字段（哪一餐）；补齐缺失的餐位与设置默认值',
    migrate(data) {
      const days = { ...(data.days || {}) };
      for (const [date, day] of Object.entries(days)) {
        const meals = { breakfast: [], lunch: [], dinner: [], snack: [], ...(day?.meals || {}) };
        for (const [key, list] of Object.entries(meals)) {
          meals[key] = (Array.isArray(list) ? list : []).map((e) => (e && !e.meal ? { ...e, meal: key } : e));
        }
        days[date] = { ...day, meals, exercises: Array.isArray(day?.exercises) ? day.exercises : [] };
      }
      return {
        ...data,
        days,
        settings: { trainDays: 3, stepsKey: 'mid', ...(data.settings || {}) },
        customFoods: Array.isArray(data.customFoods) ? data.customFoods : [],
        weights: Array.isArray(data.weights) ? data.weights : [],
      };
    },
  },
  {
    from: 2,
    to: 3,
    description: '加上成长记录（已庆祝的徽章、里程碑）与版本号；记录迁移时间',
    migrate(data) {
      const ach = data.achievements || {};
      return {
        ...data,
        achievements: {
          seen: Array.isArray(ach.seen) ? ach.seen : [],
          lastWeeklyAt: ach.lastWeeklyAt || null,
          milestones: Array.isArray(ach.milestones) ? ach.milestones : [],
        },
        migrations: [...(Array.isArray(data.migrations) ? data.migrations : []), new Date().toISOString()],
      };
    },
  },
  {
    from: 3,
    to: 4,
    description: '「专属徽章」改为所有人都有的成长线；清掉历史版本写进去的默认称呼',
    migrate(data) {
      // 早期版本会把默认称呼「小繁」直接写进存档。那是我为一个人做的痕迹，
      // 现在这个工具要给别人用，所以把「从没主动改过」的默认值清掉（改成不称呼）。
      // 判断依据：值恰好等于当年的默认名。用户自己改过的名字不会被删。
      const profile = data.profile;
      const cleaned = profile && profile.nickname === '小繁'
        ? { ...profile, nickname: '' }
        : profile;
      // 徽章 id 改名了：旧的三枚专属徽章换成通用的成长线，已解锁状态要跟过去
      const ach = data.achievements || {};
      const renameMap = { fan_badge: 'first_log', fan_week: 'days_7', fan_month: 'days_30' };
      const seen = (Array.isArray(ach.seen) ? ach.seen : []).map((id) => renameMap[id] || id);
      return { ...data, profile: cleaned, achievements: { ...ach, seen } };
    },
  },
];

/** 判断一段数据是不是「像存档」——不能只看是不是对象，否则会把乱七八糟的东西当数据 */
export function looksLikeState(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const hasShape = 'days' in data || 'profile' in data || 'weights' in data;
  const daysIsObject = data.days === undefined || (typeof data.days === 'object' && !Array.isArray(data.days));
  return hasShape && daysIsObject;
}

/** 猜一个存档的版本号（老存档没有 version 字段） */
export function detectVersion(data) {
  const v = Number(data?.schemaVersion ?? data?.version);
  if (Number.isFinite(v) && v > 0) return v;
  // 没有版本号的都是最初那一版（那时候记录里还没存 meal 字段）
  return 1;
}

/**
 * 把任意版本的存档迁移到当前版本。
 *
 * @returns {{ok:boolean, data?:object, from?:number, to?:number, applied?:string[], error?:string, needsApp?:boolean}}
 */
export function migrateToCurrent(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '存档是空的或者格式不对' };
  if (!looksLikeState(raw)) return { ok: false, error: '这份文件看起来不是本工具的存档' };

  const from = detectVersion(raw);
  if (from > SCHEMA_VERSION) {
    // 比程序还新的存档：拒绝读，也不覆盖 —— 让用户先更新应用
    return {
      ok: false,
      needsApp: true,
      from,
      error: `这份记录来自更新的版本（v${from}），当前程序只支持到 v${SCHEMA_VERSION}。请先刷新/更新应用再打开，避免把新数据读坏。`,
    };
  }

  let data = raw;
  const applied = [];
  let version = from;
  for (const step of MIGRATIONS) {
    if (version !== step.from) continue;
    data = step.migrate(data);
    version = step.to;
    applied.push(`v${step.from}→v${step.to}：${step.description}`);
  }
  if (version !== SCHEMA_VERSION) {
    return { ok: false, error: `迁移没有走完（停在 v${version}），当前需要 v${SCHEMA_VERSION}` };
  }
  return {
    ok: true,
    data: { ...data, schemaVersion: SCHEMA_VERSION },
    from,
    to: SCHEMA_VERSION,
    applied,
  };
}

/**
 * 迁移前的自动快照。只留最近一份，避免占满存储。
 * @returns {boolean} 是否留了快照
 */
export function saveBackup(storage, raw, note = '') {
  try {
    storage.setItem(BACKUP_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      schemaVersion: detectVersion(raw),
      note,
      data: raw,
    }));
    return true;
  } catch {
    return false;
  }
}

export function readBackup(storage) {
  try {
    const raw = storage.getItem(BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.data ? parsed : null;
  } catch {
    return null;
  }
}

export function clearBackup(storage) {
  try { storage.removeItem(BACKUP_KEY); return true; } catch { return false; }
}

/**
 * 把读不出来的原始文本留一份。存不下也不能因此打不开应用，所以吞掉异常。
 * @returns {boolean} 是否留成功
 */
export function keepUnreadable(storage, raw, reason = '') {
  if (!raw) return false;
  try {
    storage.setItem(UNREADABLE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), reason, raw }));
    return true;
  } catch {
    return false;
  }
}

/** 读回那份原始文本（用于导出给作者排查） */
export function readUnreadable(storage) {
  try {
    const raw = storage.getItem(UNREADABLE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.raw === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 从存储里读存档并迁移到当前版本。
 * 会顺带处理：老键名、坏 JSON、未来版本、迁移前备份。
 */
export function loadState(storage, { key = STATE_KEY, legacyKeys = LEGACY_KEYS } = {}) {
  let raw = null;
  let usedKey = key;
  try {
    raw = storage.getItem(key);
    if (!raw) {
      for (const oldKey of legacyKeys) {
        const old = storage.getItem(oldKey);
        if (old) { raw = old; usedKey = oldKey; break; }
      }
    }
  } catch {
    return { ok: false, error: '读不到本机存储（可能是浏览器的隐私模式）' };
  }
  if (!raw) return { ok: true, data: null, fresh: true };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 先把原始内容留一份，再报错 —— 界面会退回「新用户」，用户一点按钮主键就会被覆盖
    keepUnreadable(storage, raw, '存档不是合法 JSON（可能是写入时断电/浏览器清理）');
    return { ok: false, error: '存档读不出来（文件损坏）。可以试试「导入备份」恢复，或从自动快照恢复。' };
  }

  const from = detectVersion(parsed);
  const result = migrateToCurrent(parsed);
  if (!result.ok) {
    // 未来版本 / 迁移失败：同样先留一份再拒绝读取，绝不覆盖
    keepUnreadable(storage, raw, result.error);
    return { ...result, usedKey };
  }

  if (from < SCHEMA_VERSION) {
    // 只有真的要升级时才留快照（避免每次打开都写一遍）
    saveBackup(storage, parsed, `从 v${from} 升级到 v${SCHEMA_VERSION} 之前的自动快照`);
  }
  return { ...result, usedKey, upgradedFrom: from < SCHEMA_VERSION ? from : null };
}

/** 迁移结果给用户看的一句话 */
export function describeMigration(result) {
  if (!result) return '';
  if (result.upgradedFrom) {
    return `记录已从旧版本（v${result.upgradedFrom}）升级到 v${SCHEMA_VERSION}，数据都在。升级前自动留了一份快照。`;
  }
  return '';
}

/**
 * 兼容别名：早先的代码（和新版界面）都用 migrate(data) 这个名字。
 * 语义就是「迁移到当前版本」，失败时抛错，保持原来的调用方式可用。
 */
export function migrate(raw) {
  const r = migrateToCurrent(raw);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}


