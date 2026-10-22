/**
 * 数据版本与迁移测试
 *
 * 「别人在用，我更新之后数据不能丢」这句话，落到测试上就是下面这些断言。
 * 每一条都对应一个真实会发生的场景。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SCHEMA_VERSION, STATE_KEY, BACKUP_KEY, LEGACY_KEYS, MIGRATIONS,
  migrateToCurrent, detectVersion, looksLikeState, loadState, saveBackup, readBackup,
  clearBackup, describeMigration, readUnreadable,
} from '../js/schema.js';
import { emptyState, addFoodEntry, addWeight, demoProfile, todayKey } from '../js/store.js';
import { findFood } from '../js/foods.js';

// 这份测试不该碰用户真实的 AI 配置文件（别的测试会读写它）
process.env.FATLOSS_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fatloss-schema-cfg-'));

/** 内存版 localStorage */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

/** 一份「最初版本」的存档：没有 schemaVersion，记录里没有 meal 字段 */
function legacyV1() {
  return {
    version: 1,
    profile: demoProfile(),
    days: {
      [todayKey()]: {
        meals: { lunch: [{ id: 'e1', food: findFood('rice_cooked'), grams: 200 }] },
        exercises: [{ id: 'x1', exerciseKey: 'walk', minutes: 30 }],
      },
      '2026-10-01': {
        meals: { dinner: [{ id: 'e2', food: findFood('egg'), grams: 50 }] },
      },
    },
    customFoods: [{ id: 'c1', name: '自制酸奶', kcal: 60, protein: 3, fat: 3, carb: 5, servings: [['一份', 150]] }],
    weights: [{ date: '2026-10-01', kg: 58.5 }],
  };
}

test('版本号是单调递增的，迁移链首尾相接（否则会出现升不上去的存档）', () => {
  assert.ok(SCHEMA_VERSION >= 1);
  let cursor = 1;
  for (const step of MIGRATIONS) {
    assert.equal(step.from, cursor, `迁移链断了：期望从 v${cursor} 开始，实际是 v${step.from}`);
    assert.equal(step.to, step.from + 1, `迁移必须一版一版走：v${step.from} 跳到了 v${step.to}`);
    assert.ok(step.description && typeof step.migrate === 'function', `v${step.from} 的迁移缺说明或实现`);
    cursor = step.to;
  }
  assert.equal(cursor, SCHEMA_VERSION, `迁移链只到 v${cursor}，但当前版本是 v${SCHEMA_VERSION}`);
});

test('最初的存档（没有版本号）能升到当前版本，且记录一条都不少', () => {
  const legacy = legacyV1();
  const before = {
    meals: Object.values(legacy.days).reduce((a, d) => a + Object.values(d.meals).flat().length, 0),
    weights: legacy.weights.length,
    customFoods: legacy.customFoods.length,
  };

  const r = migrateToCurrent(legacy);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.from, 1, '没有版本号的存档应当被当成 v1');
  assert.equal(r.to, SCHEMA_VERSION);
  assert.ok(r.applied.length >= 1, '应当记录做过哪些迁移');

  const after = {
    meals: Object.values(r.data.days).reduce((a, d) => a + Object.values(d.meals).flat().length, 0),
    weights: r.data.weights.length,
    customFoods: r.data.customFoods.length,
  };
  assert.deepEqual(after, before, '迁移前后记录条数必须一致');
  assert.equal(r.data.schemaVersion, SCHEMA_VERSION);
});

test('升级时给记录补上「哪一餐」（老数据没有这个字段）', () => {
  const r = migrateToCurrent(legacyV1());
  const lunch = r.data.days[todayKey()].meals.lunch[0];
  assert.equal(lunch.meal, 'lunch', '午餐里的记录必须补上 meal=lunch');
  const dinner = r.data.days['2026-10-01'].meals.dinner[0];
  assert.equal(dinner.meal, 'dinner');
  // 内容不能被改动
  assert.equal(lunch.grams, 200);
  assert.equal(lunch.food.name, '米饭（熟）');
});

test('升级时补齐缺失的餐位，不让界面因为少一个键就崩', () => {
  const r = migrateToCurrent(legacyV1());
  const day = r.data.days[todayKey()];
  for (const key of ['breakfast', 'lunch', 'dinner', 'snack']) {
    assert.ok(Array.isArray(day.meals[key]), `缺失的餐位 ${key} 没被补上`);
  }
  assert.ok(Array.isArray(r.data.days['2026-10-01'].exercises), '缺失的运动数组没被补上');
});

test('升级会补上成长记录的默认值', () => {
  const r = migrateToCurrent(legacyV1());
  assert.deepEqual(r.data.achievements, { seen: [], lastWeeklyAt: null, milestones: [] });
  assert.ok(Array.isArray(r.data.migrations), '应当记录迁移时间，方便排查');
});

test('升级会清掉历史版本写进去的默认称呼，但保留用户自己改过的', () => {
  // 早期版本会把默认称呼「小繁」直接写进存档 —— 那是为一个人做的痕迹。
  // 要给别人用，所以升级时把「从没主动改过」的默认值清掉（改成不称呼）。
  const legacy = legacyV1();
  legacy.profile = { ...legacy.profile, nickname: '小繁' };
  const r = migrateToCurrent(legacy);
  assert.equal(r.ok, true);
  assert.equal(r.data.profile.nickname, '', '历史默认称呼应当被清掉');

  const custom = legacyV1();
  custom.profile = { ...custom.profile, nickname: '阿宝' };
  const r2 = migrateToCurrent(custom);
  assert.equal(r2.data.profile.nickname, '阿宝', '用户自己填的称呼必须保留');
});

test('升级会把旧徽章 id 跟到新 id（已解锁状态不能丢）', () => {
  const legacy = legacyV1();
  legacy.achievements = { seen: ['fan_badge', 'days_3', 'fan_week'], lastWeeklyAt: null, milestones: [10] };
  const r = migrateToCurrent(legacy);
  assert.deepEqual(r.data.achievements.seen, ['first_log', 'days_3', 'days_7']);
  assert.deepEqual(r.data.achievements.milestones, [10], '里程碑进度也要保留');
});

test('未来版本的存档会被拒绝读取，而不是「尽力解析」把新字段抹掉', () => {
  const future = { schemaVersion: SCHEMA_VERSION + 5, days: {}, weights: [] };
  const r = migrateToCurrent(future);
  assert.equal(r.ok, false);
  assert.equal(r.needsApp, true, '这种要提示用户先更新应用');
  assert.ok(r.error.includes('更新'), r.error);
});

test('乱七八糟的内容不会被当成存档（否则会把用户的数据覆盖成垃圾）', () => {
  for (const junk of [null, undefined, 'abc', 42, [], {}, { foo: 'bar' }, { days: 'not-an-object' }]) {
    assert.equal(looksLikeState(junk), false, `${JSON.stringify(junk)} 不该被当成存档`);
    assert.equal(migrateToCurrent(junk).ok, false);
  }
  // 反过来，正常存档要认得出来
  assert.equal(looksLikeState(emptyState()), true);
  assert.equal(looksLikeState(legacyV1()), true);
});

test('读取存档：会留一份升级前快照（能回滚）', () => {
  const legacy = legacyV1();
  const st = fakeStorage({ [STATE_KEY]: JSON.stringify(legacy) });
  const r = loadState(st);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.upgradedFrom, 1, '应当报告是从 v1 升上来的');

  const backup = readBackup(st);
  assert.ok(backup, '升级前必须留快照');
  assert.equal(detectVersion(backup.data), 1, '快照里应当是升级前的那份');
  assert.equal(backup.data.days['2026-10-01'].meals.dinner[0].meal, undefined, '快照要保持原样（还没迁移）');
  assert.ok(backup.note.includes('v1'), backup.note);

  const msg = describeMigration(r);
  assert.ok(msg.includes('升级'), msg);
  assert.ok(msg.includes('数据都在') || msg.includes('快照'), '要告诉用户数据没丢');
});

test('读取存档：同一版本不再写快照（避免每次打开都写一遍）', () => {
  const current = { ...emptyState(), schemaVersion: SCHEMA_VERSION };
  const st = fakeStorage({ [STATE_KEY]: JSON.stringify(current) });
  const r = loadState(st);
  assert.equal(r.ok, true);
  assert.equal(r.upgradedFrom, null, '已经是最新版就不该报告升级');
  assert.equal(st.getItem(BACKUP_KEY), null, '不升级就不该写快照');
});

test('读取存档：从老键名（fatloss.state.v1）也能读出来', () => {
  const st = fakeStorage({ [LEGACY_KEYS[0]]: JSON.stringify(legacyV1()) });
  const r = loadState(st);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.usedKey, LEGACY_KEYS[0], '应当报告是从哪个键读到的');
  assert.equal(Object.keys(r.data.days).length, 2);
});

test('读取存档：文件坏掉时给出可操作的提示，而不是白屏', () => {
  const st = fakeStorage({ [STATE_KEY]: '{这不是 JSON' });
  const r = loadState(st);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('损坏') || r.error.includes('读不出来'), r.error);
  assert.ok(r.error.includes('备份') || r.error.includes('快照'), '要告诉用户怎么恢复');
});

test('读不出来的存档：原始内容必须原样留一份（否则点一次按钮就没了）', () => {
  // 真实场景：主存档损坏 / 来自更新版本 → 界面退回「新用户」→
  // 用户点「看一个填好的例子」或走完引导，主键立刻被覆盖。
  // 如果不在读失败时另存一份，原来那份就永久消失了。
  const broken = '{这不是 JSON';
  const st = fakeStorage({ [STATE_KEY]: broken });
  const r = loadState(st);
  assert.equal(r.ok, false);

  const kept = readUnreadable(st);
  assert.ok(kept, '读失败时必须留一份原始内容');
  assert.equal(kept.raw, broken, '留下的必须是原始文本，不能是转述');
  assert.ok(kept.savedAt, '要记下什么时候留的');

  // 模拟用户自己点了「看一个填好的例子」：主键被覆盖，留存的那份还在
  st.setItem(STATE_KEY, JSON.stringify({ ...emptyState(), schemaVersion: SCHEMA_VERSION }));
  assert.equal(readUnreadable(st).raw, broken, '覆盖主存档不能把留存的原始内容也弄丢');
});

test('未来版本的存档：拒绝读取，但也要留一份（不能因为拒绝就丢）', () => {
  const future = { schemaVersion: SCHEMA_VERSION + 1, days: { '2026-10-12': { meals: {} } } };
  const st = fakeStorage({ [STATE_KEY]: JSON.stringify(future) });
  const r = loadState(st);
  assert.equal(r.ok, false);
  assert.equal(r.needsApp, true);
  assert.equal(st.getItem(STATE_KEY), JSON.stringify(future), '拒绝读取不等于可以覆盖');
  assert.equal(readUnreadable(st).raw, JSON.stringify(future), '也要留一份原始内容');
});

test('留不下的情况不能反过来把应用弄崩（存储写满）', () => {
  const st = fakeStorage({ [STATE_KEY]: '{坏的' });
  st.setItem = () => { throw new Error('QuotaExceededError'); };
  const r = loadState(st);
  assert.equal(r.ok, false, '存不下也要照常返回「读不出来」');
  assert.equal(readUnreadable(st), null, '没留下就是没有，别假装有');
});

test('读取存档：没有存档时返回空，而不是报错', () => {
  const r = loadState(fakeStorage());
  assert.equal(r.ok, true);
  assert.equal(r.data, null);
  assert.equal(r.fresh, true);
});

test('备份可以读取和清除', () => {
  const st = fakeStorage();
  assert.equal(saveBackup(st, legacyV1(), '手动备份'), true);
  const b = readBackup(st);
  assert.equal(b.note, '手动备份');
  assert.equal(clearBackup(st), true);
  assert.equal(readBackup(st), null);
});

test('迁移是幂等的：重复迁移同一份数据不会越迁越乱', () => {
  const once = migrateToCurrent(legacyV1()).data;
  const twice = migrateToCurrent(JSON.parse(JSON.stringify(once)));
  assert.equal(twice.ok, true);
  assert.deepEqual(twice.applied, [], '已经是当前版本，不该再跑迁移');
  const mealsA = Object.values(once.days).reduce((a, d) => a + Object.values(d.meals).flat().length, 0);
  const mealsB = Object.values(twice.data.days).reduce((a, d) => a + Object.values(d.meals).flat().length, 0);
  assert.equal(mealsA, mealsB);
});

test('迁移不吃掉新加的字段（将来加功能时老数据不会被抹）', () => {
  const withExtra = { ...legacyV1(), someFutureFeature: { enabled: true }, days: { ...legacyV1().days } };
  withExtra.days[todayKey()].someNote = '用户自己写的一句话';
  const r = migrateToCurrent(withExtra);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.someFutureFeature, { enabled: true }, '不认识的顶层字段要原样保留');
  assert.equal(r.data.days[todayKey()].someNote, '用户自己写的一句话', '不认识的天级字段也要保留');
});

test('真实场景串起来：老版本 → 继续记录 → 再打开，数据都在', () => {
  const st = fakeStorage({ [STATE_KEY]: JSON.stringify(legacyV1()) });
  const first = loadState(st);                       // 模拟：用户打开新版应用
  assert.equal(first.ok, true);

  // 用户在升级后的版本里继续记一天
  const state = first.data;
  addFoodEntry(state, todayKey(), 'breakfast', findFood('egg'), 100);
  addWeight(state, todayKey(), 58);
  st.setItem(STATE_KEY, JSON.stringify(state));

  // 再打开一次：应当读回全部内容，且不需要再迁移
  const second = loadState(st);
  assert.equal(second.ok, true);
  assert.equal(second.upgradedFrom, null);
  const allMeals = Object.values(second.data.days).reduce((a, d) => a + Object.values(d.meals).flat().length, 0);
  assert.equal(allMeals, 3, '原来的 2 条 + 新记的 1 条');
  assert.equal(second.data.weights.length, 2);
});
