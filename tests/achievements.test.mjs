/**
 * 正反馈系统测试
 *
 * 除了常规正确性，这里有一组「防帮倒忙」的测试，比功能测试更重要：
 *  1) 徽章只能跟行为有关（记录、蛋白、运动、体重记录），不能跟「吃得少」「掉秤快」有关；
 *  2) 断记录不许有惩罚（植物不倒退、徽章不回收）；
 *  3) 体重上涨也要给正反馈（肯上秤这个行为本身值得肯定）；
 *  4) 同一个徽章只庆祝一次（不然会烦）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyState, addFoodEntry, addExercise, addWeight, demoProfile, todayKey, shiftDate } from '../js/store.js';
import { calcTargets } from '../js/calc.js';
import { findFood } from '../js/foods.js';
import {
  ACHIEVEMENTS, PLANT_STAGES, achievements, plantState, currentStreak, longestStreak,
  totalLoggedDays, weeklyReview, weeklyHighlight, shouldShowWeekly, afterLogMessage,
  markAchievementsSeen, dayTotals, hasLog, recentDays,
} from '../js/achievements.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** 造一份「连续记了 N 天」的存档 */
function loggedState(days, { withExercise = false, withWeight = false, mealsPerDay = 3 } = {}) {
  const s = emptyState();
  s.profile = demoProfile();
  const today = todayKey();
  for (let i = days - 1; i >= 0; i--) {
    const key = shiftDate(today, -i);
    addFoodEntry(s, key, 'breakfast', findFood('egg'), 100);
    if (mealsPerDay >= 2) addFoodEntry(s, key, 'lunch', findFood('chicken_breast'), 150);
    if (mealsPerDay >= 3) addFoodEntry(s, key, 'dinner', findFood('rice_cooked'), 200);
    if (withExercise && i % 2 === 0) addExercise(s, key, 'walk', 30);
    if (withWeight) addWeight(s, key, 58);
  }
  return s;
}

/* ── 基础统计 ─────────────────────────────── */

test('连续记录：今天没记时从昨天算起，不算断', () => {
  const s = loggedState(3); // 含今天
  assert.equal(currentStreak(s), 3);
  // 把今天的记录删掉，连续天数应当仍是 2（昨天、前天）
  delete s.days[todayKey()];
  assert.equal(currentStreak(s), 2);
  assert.equal(hasLog(s, todayKey()), false);
});

test('连续记录：中间断过只算最后一段', () => {
  const s = emptyState();
  const today = todayKey();
  for (const offset of [0, 1, 3, 4, 5]) addFoodEntry(s, shiftDate(today, -offset), 'lunch', findFood('egg'), 50);
  assert.equal(currentStreak(s), 2, '今天+昨天是连续 2 天');
  assert.equal(longestStreak(s), 3, '历史最长是 3 天');
});

test('累计天数与最近 N 天', () => {
  const s = loggedState(4);
  assert.equal(totalLoggedDays(s), 4);
  assert.equal(recentDays(7).length, 7);
  assert.equal(recentDays(7).at(-1), todayKey(), '最后一天应当是今天');
});

/* ── 防帮倒忙（最重要的一组）───────────────── */

test('徽章只跟行为有关，不许有「吃得少」「掉秤快」这类目标', () => {
  const banned = /少吃|低卡|断食|节食|掉秤|减重|瘦|体重下降|lose|deficit|fasting|少食/i;
  for (const a of ACHIEVEMENTS) {
    const text = `${a.id} ${a.name} ${a.hint} ${a.congrats}`;
    assert.ok(!banned.test(text), `徽章「${a.name}」的文案涉及"少吃/掉秤"这类目标：${text}`);
  }
});

test('徽章定义里不许出现「卡路里低于某个值」这种条件', () => {
  const src = fs.readFileSync(path.join(root, 'js', 'achievements.js'), 'utf8');
  const achBlock = src.slice(src.indexOf('export const ACHIEVEMENTS'), src.indexOf('/** 蛋白质达标的天数 */'));
  assert.ok(!/kcal\s*<\s*|kcal\s*<=\s*|calorieTarget\s*-/.test(achBlock),
    '徽章里出现了"热量低于…"的判断，这会鼓励节食');
  // 反过来：应当确实用到了蛋白质（吃够，而不是吃少）
  assert.ok(/protein/.test(achBlock), '徽章应当包含"吃够蛋白"这类正向目标');
});

test('断记录不受惩罚：植物不倒退、徽章不回收', () => {
  const ongoing = loggedState(10);
  const levelBefore = plantState(ongoing).level;

  // 再补几天更早的记录（模拟用得更久）
  for (const offset of [11, 12, 13]) {
    addFoodEntry(ongoing, shiftDate(todayKey(), -offset), 'lunch', findFood('egg'), 50);
  }
  const levelAfter = plantState(ongoing).level;
  assert.ok(levelAfter >= levelBefore, '多记几天之后植物不该变小');

  // 模拟「中间断了 5 天」：连续天数归零，但累计与徽章都该在
  const gapped = emptyState();
  gapped.profile = demoProfile();
  for (const offset of [10, 11, 12, 13, 14, 30]) {
    addFoodEntry(gapped, shiftDate(todayKey(), -offset), 'lunch', findFood('egg'), 50);
  }
  assert.equal(currentStreak(gapped), 0, '断档后连续天数为 0');
  const a = achievements(gapped, 60);
  assert.ok(a.unlocked.some((x) => x.id === 'days_3'), '累计类徽章不该因为断档被收回');
  assert.ok(plantState(gapped).level >= 1, '断档后植物不该退回最初状态');
});

test('体重上涨也算成就（肯上秤本身值得肯定）', () => {
  const s = emptyState();
  s.profile = demoProfile();
  // 两条体重记录都落在最近 7 天内；再随手记一顿饭，周报才会展开（没记录时它只说"没关系"）
  addFoodEntry(s, todayKey(), 'lunch', findFood('egg'), 100);
  addWeight(s, shiftDate(todayKey(), -5), 58);
  addWeight(s, todayKey(), 58.8); // 涨了
  const a = achievements(s, 60);
  assert.ok(a.unlocked.some((x) => x.id === 'weight_2'), '记录体重就应当解锁，跟涨跌无关');
  const rev = weeklyReview(s, { proteinTarget: 60 });
  assert.equal(rev.weightChange, 0.8);
  assert.ok(rev.lines.some((l) => l.includes('浮动') || l.includes('两周')), '体重上涨的文案要解释，而不是指责');
  assert.ok(!rev.lines.some((l) => /指责|白吃|注意点|管住/.test(l)), '不许出现责备语气');
});

test('文案里不许出现责备或施压的词', () => {
  const src = fs.readFileSync(path.join(root, 'js', 'achievements.js'), 'utf8');
  const bad = /失败|惩罚|扣分|退步|你怎么|必须|不许|懒惰|自律一点|管住嘴/;
  const hits = src.split('\n').filter((l) => bad.test(l) && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
  assert.deepEqual(hits, [], `文案里出现了责备性说法：\n${hits.join('\n')}`);
});

/* ── 成就解锁 ─────────────────────────────── */

test('记满 7 天会解锁「一周记录」，并给出进度', () => {
  const s = loggedState(5);
  const a = achievements(s, 60);
  const week = a.list.find((x) => x.id === 'days_7');
  assert.equal(week.unlocked, false);
  assert.equal(week.value, 5);
  assert.equal(week.pct, 71);
  assert.ok(a.next, '应当给出"最接近解锁"的那个');

  for (const offset of [5, 6]) addFoodEntry(s, shiftDate(todayKey(), -offset), 'lunch', findFood('egg'), 50);
  assert.equal(achievements(s, 60).list.find((x) => x.id === 'days_7').unlocked, true);
});

test('蛋白达标徽章按目标值判定，不按固定数字', () => {
  // 明确构造：100 克鸡蛋（13.3 克蛋白）+ 150 克鸡胸（36 克蛋白）≈ 49 克
  const s = emptyState();
  s.profile = demoProfile();
  addFoodEntry(s, todayKey(), 'breakfast', findFood('egg'), 100);
  addFoodEntry(s, todayKey(), 'lunch', findFood('chicken_breast'), 150);
  const actual = dayTotals(s, todayKey()).protein;
  assert.ok(actual > 40 && actual < 60, `这组数据应当是 40~60 克蛋白，实际 ${actual}`);

  const tooHigh = achievements(s, actual + 20).list.find((x) => x.id === 'protein_1');
  assert.equal(tooHigh.unlocked, false, `目标设在 ${actual + 20} 克时不该算达标`);
  const fits = achievements(s, actual - 10).list.find((x) => x.id === 'protein_1');
  assert.equal(fits.unlocked, true, `目标设在 ${actual - 10} 克时应当算达标`);
});

test('运动与自定义食物徽章', () => {
  const s = loggedState(1, { withExercise: true });
  assert.equal(achievements(s, 60).list.find((x) => x.id === 'first_exercise').unlocked, true);
  const s2 = loggedState(1);
  s2.customFoods.push({ id: 'c1', name: '自制酸奶', kcal: 60, protein: 3, fat: 3, carb: 5, servings: [['一份', 150]] });
  assert.equal(achievements(s2, 60).list.find((x) => x.id === 'custom_food').unlocked, true);
});

test('同一个徽章只庆祝一次（记下来之后 isNew 变 false）', () => {
  const s = loggedState(3);
  s.achievements = s.achievements || { seen: [] };
  const first = achievements(s, 60);
  assert.ok(first.justUnlocked.length > 0, '第一次应当有可庆祝的徽章');
  markAchievementsSeen(s, first.justUnlocked.map((x) => x.id));
  const second = achievements(s, 60);
  assert.equal(second.justUnlocked.length, 0, '庆祝过的徽章不该再弹一次');
  assert.equal(second.unlocked.length, first.unlocked.length, '解锁数量不变');
});

test('空存档不会崩，也不会凭空解锁', () => {
  const s = emptyState();
  const a = achievements(s, 60);
  assert.equal(a.unlocked.length, 0);
  assert.equal(plantState(s).level, 0);
  assert.ok(plantState(s).line.includes('发芽'));
  assert.deepEqual(weeklyReview(s, {}).lines.length > 0, true);
});

/* ── 小植物 ───────────────────────────────── */

test('植物按累计天数生长，且阶段是递增的', () => {
  const levels = PLANT_STAGES.map((s) => s.min);
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] > levels[i - 1], '阶段门槛必须递增');
  assert.equal(plantState(loggedState(1)).level, 0);
  assert.equal(plantState(loggedState(3)).level, 1);
  assert.equal(plantState(loggedState(7)).level, 2);
  assert.equal(plantState(loggedState(14)).level, 3);
  assert.equal(plantState(loggedState(31)).level, 4);
});

test('植物会告诉她还差几天长大', () => {
  const p = plantState(loggedState(5));
  assert.equal(p.nextStage.min, 7);
  assert.equal(p.toNext, 2);
});

/* ── 即时反馈与周报 ───────────────────────── */

test('第一笔记录给的是鼓励，而不是评价吃得多不多', () => {
  const s = loggedState(1, { mealsPerDay: 1 });
  const msg = afterLogMessage(s, 'lunch', 60);
  assert.ok(msg.text.includes('第一笔') || msg.text.includes('记上'), msg.text);
  assert.ok(!/太多|超标|注意/.test(msg.text), `第一笔不该评价吃了多少：${msg.text}`);
});

test('蛋白达标时明确告诉她是这件事最值钱', () => {
  const s = loggedState(2); // 连续 2 天，避开「第一笔」和「连续 3 天」两个分支
  const target = Math.max(1, dayTotals(s, todayKey()).protein - 10); // 保证达标
  const msg = afterLogMessage(s, 'dinner', target);
  assert.ok(msg.text.includes('蛋白'), `达标时的反馈应当点明蛋白：${msg.text}`);
  assert.ok(msg.emoji, '应当带一个表情');
});

test('周报把行为放前面，体重只作为其中一个数字', () => {
  const s = loggedState(6, { withExercise: true, withWeight: true });
  const rev = weeklyReview(s, { proteinTarget: 60, calorieTarget: 1500 });
  assert.equal(rev.loggedDays, 6);
  assert.ok(rev.exerciseDays >= 3);
  assert.ok(rev.lines[0].includes('记了'), `第一句应当是记录情况：${rev.lines[0]}`);
  const weightIdx = rev.lines.findIndex((l) => l.includes('体重'));
  const proteinIdx = rev.lines.findIndex((l) => l.includes('蛋白'));
  assert.ok(proteinIdx < weightIdx, '蛋白质（行为）应当排在体重（结果）前面');
});

test('一周没记录时不说重话，而是给台阶', () => {
  const s = emptyState();
  const rev = weeklyReview(s, {});
  assert.equal(rev.loggedDays, 0);
  assert.ok(rev.lines[0].includes('新开始') || rev.lines[0].includes('没关系'), rev.lines[0]);
  assert.ok(!/失败|放弃|退步/.test(rev.lines.join('')));
});

test('周报高光：记录多、蛋白好、运动勤分别有不同说法', () => {
  assert.equal(weeklyHighlight({ loggedDays: 7 }).emoji, '🏆');
  assert.ok(weeklyHighlight({ loggedDays: 5, proteinHitDays: 5 }).text.includes('蛋白'));
  assert.ok(weeklyHighlight({ loggedDays: 5, proteinHitDays: 1, exerciseDays: 4 }).text.includes('动'));
  assert.ok(weeklyHighlight({ loggedDays: 2, proteinHitDays: 0, exerciseDays: 0 }).text.includes('开始') || weeklyHighlight({ loggedDays: 2 }).text.includes('稳定'));
});

test('周报只在周一弹，且这周有记录；同一天不重复弹', () => {
  const monday = '2026-10-19'; // 周一
  const tuesday = '2026-10-20';
  const s = loggedState(3);
  assert.equal(shouldShowWeekly(s, tuesday), false, '不是周一不该弹');
  assert.equal(shouldShowWeekly(s, monday), true, '周一且有记录应当弹');
  s.achievements.lastWeeklyAt = monday;
  assert.equal(shouldShowWeekly(s, monday), false, '同一天不该弹第二次');
  const empty = emptyState();
  assert.equal(shouldShowWeekly(empty, monday), false, '这周没记录就不弹，不打扰');
});

test('每日合计与记录判定（供其它模块复用）', () => {
  const s = loggedState(1);
  const t = dayTotals(s, todayKey());
  assert.ok(t.kcal > 0 && t.protein > 0);
  assert.equal(hasLog(s, '2020-01-01'), false);
  assert.deepEqual(dayTotals(s, '2020-01-01'), { kcal: 0, protein: 0, fat: 0, carb: 0 });
});
