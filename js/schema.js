/**
 * 存档版本与迁移
 *
 * 这是「能给别人用」的关键：她的手机里存着真实记录，我改数据结构时必须保证
 * **升级不丢数据、不读坏数据**。所以这里的规则比较硬：
 *
 *  1) 每一版结构对应一个数字，只增不改；
 *  2) 升级就是按顺序跑一系列小迁移（v1→v2→v3），每一步都能单独测试；
 *  3) **绝不删除用户的记录**：不认识的多余字段原样留着，将来可能还要用；
 *  4) 如果存档版本比当前程序还新（她装过新版、又用回旧版），**拒绝读取并提示升级**，
 *     而不是「尽力解析」—— 那会把新字段悄悄抹掉；
 *  5) 迁移前先自动留一份快照（见 BACKUP_KEY），出错能回滚。
 *
 * 注意：这个模块**不依赖 store.js**（版本号在这里定义），否则会形成循环依赖。
 */

/** 当前程序能处理的结构版本。改结构时 +1，并补一条迁移。 */
export const SCHEMA_VERSION = 3;

/** 历史别名（最早叫 version，现在统一叫 schemaVersion） */
export const LEGACY_VERSION = SCHEMA_VERSION;

/** 主存档键（历史键名保留，避免老用户升级后找不到自己的数据） */
export const STATE_KEY = 'fatloss.state.v2';
/** 迁移前的自动快照 */
export const BACKUP_KEY = 'fatloss.backup';
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
    // 比程序还新的存档：拒绝读，也不覆盖 —— 让她先更新应用
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
    return { ok: false, error: '存档读不出来（文件损坏）。可以试试「导入备份」恢复，或从自动快照恢复。' };
  }

  const from = detectVersion(parsed);
  const result = migrateToCurrent(parsed);
  if (!result.ok) return { ...result, usedKey };

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


