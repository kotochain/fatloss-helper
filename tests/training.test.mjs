/**
 * 运动记录测试
 *
 * 这个功能对用户承诺的是四件事，测试就盯着这四件：
 *  1) 记了多久就统计多久：今天页、记录页、历史列表用的是同一个数（这里测的就是它们共用的那个函数）；
 *  2) 一周从周一到周日：上周日不能算进这周，下周一也不能；
 *  3) 消耗是估算，公式就是 METs × 体重 × 小时；而且运动消耗最多只把一半算进当天额度；
 *  4) 时长为 0 / 负数 / 不是数字，一律记不上（宁可挡住，也不要留一条没法统计的假记录）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXERCISES, TRAINING_INTENSITY,
  cardioPoolKey, dayTraining, describeTraining, estimateTrainingKcal,
  logTraining, resolveTrainingAction, strengthActions, trainingActions,
  trainingEntryMets, trainingEntryName, trainingHistory, trainingSummary,
  weekStartKey,
} from '../js/exercise.js';
import { emptyState, demoProfile, getDay, addExercise } from '../js/store.js';
import { calcExerciseKcal } from '../js/calc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 一份填好资料的存档（体重 58 kg，跟示例资料一致） */
function freshState() {
  const state = emptyState();
  state.profile = demoProfile();
  return state;
}

const WEIGHT = 58;

/* ── 1. 消耗估算 ────────────────────────────── */

test('消耗估算 = METs × 体重 × 小时（和手算一致）', () => {
  // 爬坡走 6.3 METs，30 分钟，58 公斤：6.3 × 58 × 0.5 = 182.7 kcal
  const walk = { mets: 6.3, minutes: 30 };
  assert.equal(estimateTrainingKcal(walk, WEIGHT), 182.7);
  // 再按公式手算一遍，避免「函数自己和自己一致」
  const hand = 6.3 * WEIGHT * (30 / 60);
  assert.ok(Math.abs(estimateTrainingKcal(walk, WEIGHT) - hand) < 0.05, `估算值应当就是手算值 ${hand}`);

  // 45 分钟 = 274.05，正好卡在四舍五入中间：全项目统一用的 round 会进到 274.1
  assert.equal(estimateTrainingKcal({ mets: 6.3, minutes: 45 }, WEIGHT), 274.1);

  // 泳池中等强度 7.0 METs，30 分钟，60 公斤 = 7 × 60 × 0.5 = 210
  assert.equal(estimateTrainingKcal({ mets: 7.0, minutes: 30 }, 60), 210);

  // 体重翻倍、时长翻倍，消耗都要翻倍（线性）
  assert.equal(estimateTrainingKcal(walk, WEIGHT * 2), 365.4);
  assert.equal(estimateTrainingKcal({ mets: 6.3, minutes: 60 }, WEIGHT), 365.4);

  // 跟全项目其它地方用的是同一个换算函数，不是这里另写一份
  assert.equal(
    estimateTrainingKcal(walk, WEIGHT),
    calcExerciseKcal({ mets: 6.3, weightKg: WEIGHT, minutes: 30 }),
  );
});

test('时长不合法时消耗按 0 算，界面上不会出现 NaN', () => {
  assert.equal(estimateTrainingKcal({ mets: 6.3, minutes: 0 }, WEIGHT), 0);
  assert.equal(estimateTrainingKcal({ mets: 6.3, minutes: -10 }, WEIGHT), 0);
  assert.equal(estimateTrainingKcal({ mets: 6.3 }, WEIGHT), 0);
  assert.equal(estimateTrainingKcal(null, WEIGHT), 0);
});

/* ── 2. 记一次运动：统计要跟着变 ───────────────── */

test('记一次运动后，今天 / 这周 / 累计的时长都对得上', () => {
  const state = freshState();
  const key = '2026-10-16';

  const before = trainingSummary(state, key, WEIGHT);
  assert.deepEqual(before.today, { count: 0, minutes: 0, kcal: 0 });
  assert.deepEqual(before.week, { count: 0, minutes: 0, kcal: 0 });

  logTraining(state, key, { cardioId: 'treadmill_incline_walk', minutes: 30 });
  logTraining(state, key, { exerciseKey: 'strength', minutes: 45 });

  const after = trainingSummary(state, key, WEIGHT);
  assert.equal(after.today.count, 2);
  assert.equal(after.today.minutes, 75);
  assert.equal(after.week.count, 2);
  assert.equal(after.week.minutes, 75);
  assert.equal(after.total.minutes, 75);

  // 跟存档里的原始数据对一遍（不是统计函数自己算给自己看）
  const raw = getDay(state, key).exercises;
  assert.equal(raw.length, 2);
  assert.equal(after.today.minutes, raw.reduce((a, x) => a + x.minutes, 0));
  for (const x of raw) assert.equal(typeof x.minutes, 'number', '时长必须是数字，字符串会让统计变成拼接');

  // 一天里两条的消耗要被加在一起
  const single = estimateTrainingKcal(raw[0], WEIGHT) + estimateTrainingKcal(raw[1], WEIGHT);
  assert.equal(after.today.kcal, Math.round(single));

  // 删掉一条之后统计要跟着回落（今天页的删除按钮走的就是 store 的 removeExercise）
  raw.splice(0, 1);
  assert.equal(trainingSummary(state, key, WEIGHT).today.minutes, 45);
});

test('删除一条记录后，这周和累计也一起回落', () => {
  const state = freshState();
  logTraining(state, '2026-10-14', { cardioId: 'outdoor_walk', minutes: 20 });
  logTraining(state, '2026-10-16', { cardioId: 'outdoor_jog', minutes: 30 });
  assert.equal(trainingSummary(state, '2026-10-16', WEIGHT).week.minutes, 50);
  getDay(state, '2026-10-14').exercises.length = 0;
  const after = trainingSummary(state, '2026-10-16', WEIGHT);
  assert.equal(after.week.minutes, 30);
  assert.equal(after.total.minutes, 30);
});

/* ── 3. 一周的分组：跨周不串 ──────────────────── */

test('一周从周一算起（周日属于「这一周」的最后一天）', () => {
  assert.equal(weekStartKey('2026-10-12'), '2026-10-12');   // 周一 → 自己
  assert.equal(weekStartKey('2026-10-16'), '2026-10-12');   // 周五 → 这周一
  assert.equal(weekStartKey('2026-10-18'), '2026-10-12');   // 周日 → 还是这周一
  assert.equal(weekStartKey('2026-10-19'), '2026-10-19');   // 下周一 → 新的一周
  assert.equal(weekStartKey('2026-10-11'), '2026-10-05');   // 上周日 → 上一周
  assert.throws(() => weekStartKey('今天'), /日期/);
});

test('跨周不串：上周日和下周一都不能算进这周', () => {
  const state = freshState();
  logTraining(state, '2026-10-11', { cardioId: 'outdoor_walk', minutes: 100 });  // 上周日
  logTraining(state, '2026-10-12', { cardioId: 'outdoor_walk', minutes: 20 });   // 这周一
  logTraining(state, '2026-10-16', { cardioId: 'outdoor_walk', minutes: 30 });   // 这周五（今天）
  logTraining(state, '2026-10-19', { cardioId: 'outdoor_walk', minutes: 50 });   // 下周一

  const s = trainingSummary(state, '2026-10-16', WEIGHT);
  assert.equal(s.weekStart, '2026-10-12');
  assert.equal(s.weekEnd, '2026-10-18');
  assert.equal(s.week.count, 2, '这周只该有周一、周五两次');
  assert.equal(s.week.minutes, 50, '上周日的 100 分钟和下周一得 50 分钟都不能算进来');
  assert.equal(s.today.minutes, 30);
  assert.equal(s.total.count, 4, '累计要包含全部记录');
  assert.equal(s.total.minutes, 200);
});

test('反向验证：如果「这周」不设结束日期，这条断言会立刻失败', () => {
  // 坑在于「只过滤开始日期」：那样下周一（2026-10-19）会被算进这周，
  // 于是这周的时长会随着未来几天的记录一直往上涨。
  const state = freshState();
  logTraining(state, '2026-10-11', { cardioId: 'outdoor_walk', minutes: 100 });  // 上周日
  logTraining(state, '2026-10-12', { cardioId: 'outdoor_walk', minutes: 20 });   // 这周一
  logTraining(state, '2026-10-19', { cardioId: 'outdoor_walk', minutes: 50 });   // 下周一

  const s = trainingSummary(state, '2026-10-16', WEIGHT);
  const noUpperBound = Object.entries(state.days)
    .filter(([key]) => key >= s.weekStart)
    .reduce((a, [, day]) => a + dayTraining(day, WEIGHT).minutes, 0);
  assert.equal(s.week.minutes, 20);
  assert.equal(noUpperBound, 70, '不带结束日期的实现会把下周一算进来 —— 说明这条断言确实盯住了行为');
  assert.notEqual(noUpperBound, s.week.minutes);
});

/* ── 4. 时长校验 ────────────────────────────── */

test('时长为 0、负数、不是数字，一律记不上（也不留半条记录）', () => {
  const state = freshState();
  const key = '2026-10-16';
  const bad = [0, -5, -0.5, NaN, Infinity, '30', null, undefined, {}, []];
  for (const minutes of bad) {
    assert.throws(
      () => logTraining(state, key, { cardioId: 'outdoor_walk', minutes }),
      /时长|数字/,
      `minutes=${JSON.stringify(minutes)} 应当被拒绝`,
    );
  }
  assert.deepEqual(Object.keys(state.days), [], '被拒绝的时长远不能留下任何一天的数据');
});

test('超过 24 小时的时长按输错处理（store 的关卡返回 null，这里要认出来）', () => {
  const state = freshState();
  assert.throws(
    () => logTraining(state, '2026-10-16', { cardioId: 'outdoor_walk', minutes: 1441 }),
    /没记上/,
  );
  assert.equal(Object.keys(state.days).length, 0);
  // 边界值本身是记得上的
  logTraining(state, '2026-10-16', { cardioId: 'outdoor_walk', minutes: 1440 });
  assert.equal(trainingSummary(state, '2026-10-16', WEIGHT).today.minutes, 1440);
});

test('小数时长取整后再存，不会出现 0 分钟的记录', () => {
  const state = freshState();
  const item = logTraining(state, '2026-10-16', { cardioId: 'outdoor_walk', minutes: 30.6 });
  assert.equal(item.minutes, 31);
  assert.throws(() => logTraining(state, '2026-10-16', { cardioId: 'outdoor_walk', minutes: 0.2 }), /时长|没记上/);
  assert.equal(getDay(state, '2026-10-16').exercises.length, 1, '被拒绝的那次不能留在记录里');
});

test('没选动作、选了不存在的动作、日期格式不对，都要挡住', () => {
  const state = freshState();
  assert.throws(() => logTraining(state, '2026-10-16', { minutes: 30 }), /动作/);
  assert.throws(() => logTraining(state, '2026-10-16', { cardioId: 'nope', minutes: 30 }), /动作/);
  assert.throws(() => logTraining(state, '2026-10-16', { exerciseKey: 'nope', minutes: 30 }), /动作/);
  assert.throws(() => logTraining(state, '今天', { cardioId: 'outdoor_walk', minutes: 30 }), /日期/);
  assert.deepEqual(Object.keys(state.days), []);
});

test('强度只能是三档，乱传要被挡住；不填就是空的', () => {
  const state = freshState();
  assert.deepEqual(Object.keys(TRAINING_INTENSITY).sort(), ['easy', 'hard', 'normal']);
  assert.throws(
    () => logTraining(state, '2026-10-16', { cardioId: 'outdoor_walk', minutes: 30, intensity: '爆汗' }),
    /强度/,
  );
  const plain = logTraining(state, '2026-10-16', { cardioId: 'outdoor_walk', minutes: 30 });
  assert.equal(plain.intensity, '');
  assert.equal(plain.note, '');
  const typed = logTraining(state, '2026-10-16', { cardioId: 'outdoor_walk', minutes: 30, intensity: 'hard', note: ' 膝盖没不适 ' });
  assert.equal(typed.intensity, 'hard');
  assert.equal(typed.note, '膝盖没不适', '备注要去掉首尾空格');
  assert.equal(describeTraining(typed, WEIGHT).intensityName, '吃力');
});

/* ── 5. 动作库与器械 ──────────────────────────── */

test('只给今天能用的动作：只有椭圆机时不该出现跑步机的动作', () => {
  const { cardio, strength } = trainingActions(['elliptical']);
  assert.ok(cardio.length > 0);
  for (const e of cardio) {
    assert.ok(e.equipment.includes('elliptical'), `${e.name} 需要 ${e.equipment.join('/')}，但今天只有椭圆机`);
  }
  assert.ok(cardio.some((e) => e.name.includes('椭圆机')));
  assert.ok(!cardio.some((e) => e.id === 'treadmill_run'), '跑步机的动作不该出现');

  // 力量类不用器械，任何情况下都能记
  assert.ok(strength.length >= 2);
  for (const s of strength) {
    assert.equal(EXERCISES[s.key].kind, 'strength');
    assert.ok(s.name && s.mets > 0);
  }
  assert.deepEqual(trainingActions([]).cardio, [], '一台器械都没勾时不该硬凑有氧动作');
  assert.ok(trainingActions([]).strength.length >= 2, '没有器械时至少还能记力量和徒手');
});

test('每个器械勾选下给出的动作，都真的能用那台器械做', () => {
  for (const key of ['treadmill', 'elliptical', 'bike', 'rower', 'pool', 'mat', 'bodyweight', 'outdoor']) {
    const { cardio } = trainingActions([key]);
    assert.ok(cardio.length > 0, `勾了 ${key} 却一个动作都没有`);
    for (const e of cardio) {
      assert.ok(e.equipment.includes(key), `${e.name} 不在 ${key} 的可用动作里`);
    }
  }
});

test('有氧库的动作都映射得到旧 METs 池的 key（老代码读的就是它）', () => {
  for (const e of trainingActions(['treadmill', 'incline_treadmill', 'elliptical', 'bike', 'rower', 'stair',
    'stepper', 'jump_rope', 'bodyweight', 'mat', 'dumbbell', 'kettlebell', 'band', 'cable', 'machine',
    'pool', 'outdoor', 'stairs_real', 'court', 'studio']).cardio) {
    const key = cardioPoolKey(e.id);
    assert.ok(EXERCISES[key], `${e.name}（${e.id}）映射到了不存在的 key：${key}`);
  }
  // 不认识的动作按快走记（保守），不凭空拔高
  assert.equal(cardioPoolKey('不存在的动作'), 'walk');
});

/* ── 6. 记录里要存下当时的名字和 METs ─────────── */

test('记录里存下当时的名字和 METs：动作库以后再改，历史记录不会跟着变样', () => {
  const state = freshState();
  const item = logTraining(state, '2026-10-16', { cardioId: 'treadmill_incline_walk', minutes: 30 });
  assert.equal(item.name, '爬坡走（跑步机加坡度）');
  assert.equal(item.mets, 6.3);
  assert.equal(item.exerciseKey, 'walk', '旧池 key 也要留着，老逻辑还能读');
  assert.equal(item.cardioId, 'treadmill_incline_walk');
  assert.equal(typeof item.createdAt, 'string');
  assert.equal(typeof item.id, 'string');

  // 存了 METs 就用存的，而不是回头看旧池（walk 只有 4.3）
  assert.equal(trainingEntryMets({ exerciseKey: 'walk', mets: 9.9 }), 9.9);
  assert.equal(estimateTrainingKcal({ exerciseKey: 'walk', mets: 9.9, minutes: 60 }, 50), 495);

  // 这次改动之前的老记录没有 mets / name：退回旧 METs 池，显示和消耗都不能变成 NaN
  const legacy = { id: 'x1', exerciseKey: 'jump_rope', minutes: 20 };
  assert.equal(trainingEntryName(legacy), '跳绳');
  assert.equal(trainingEntryMets(legacy), 11);
  assert.equal(estimateTrainingKcal(legacy, 50), calcExerciseKcal({ mets: 11, weightKg: 50, minutes: 20 }));

  // 完全不认识的 key：按快走强度兜底，不编一个好看的数字
  assert.equal(trainingEntryMets({ exerciseKey: 'unknown_key' }), 4);
  assert.equal(trainingEntryName({ exerciseKey: 'unknown_key' }), 'unknown_key');
  assert.equal(describeTraining({}, WEIGHT).name, '运动');
});

test('力量训练也能记（跟着「一周练什么」里的力量日用）', () => {
  const state = freshState();
  const item = logTraining(state, '2026-10-16', { exerciseKey: 'strength', minutes: 40, intensity: 'normal' });
  assert.equal(item.name, '力量训练');
  assert.equal(item.mets, 5.0);
  assert.equal(item.cardioId, null);
  assert.equal(item.exerciseKey, 'strength');
  assert.equal(strengthActions().length, 2);
});

/* ── 7. 历史列表 ─────────────────────────────── */

test('运动历史按天倒序分组，没有记录的那天不会凭空出现', () => {
  const state = freshState();
  logTraining(state, '2026-10-14', { cardioId: 'outdoor_walk', minutes: 20 });
  logTraining(state, '2026-10-16', { cardioId: 'outdoor_jog', minutes: 30 });
  logTraining(state, '2026-10-16', { exerciseKey: 'strength', minutes: 40 });
  getDay(state, '2026-10-15');   // 只打开过、什么都没记的一天

  const hist = trainingHistory(state, { days: 10, weightKg: WEIGHT });
  assert.deepEqual(hist.map((d) => d.dateKey), ['2026-10-16', '2026-10-14']);
  assert.equal(hist[0].items.length, 2);
  assert.equal(hist[0].items[0].name, '力量训练', '同一天里后记的排前面');
  assert.equal(hist[1].items[0].name, '户外快走');
  for (const d of hist) for (const it of d.items) assert.equal(it.dateKey, d.dateKey);

  // 历史里所有条目加起来 = 累计次数（两个数字不能各说各话）
  const flat = hist.flatMap((d) => d.items);
  assert.equal(flat.length, trainingSummary(state, '2026-10-16', WEIGHT).total.count);
  // days 限制的是「显示几天」
  assert.equal(trainingHistory(state, { days: 1, weightKg: WEIGHT }).length, 1);
  assert.deepEqual(hist[0].items.map((x) => x.minutes).sort((a, b) => a - b), [30, 40]);
});

test('统计和历史都不会修改存档（查一次不该凭空多出一天）', () => {
  const state = freshState();
  trainingSummary(state, '2026-10-16', WEIGHT);
  trainingHistory(state, { weightKg: WEIGHT });
  assert.deepEqual(Object.keys(state.days), []);
});

/* ── 8. 额度红线 ─────────────────────────────── */

test('红线：运动消耗不许加回当天可吃的额度（额度只等于目标热量）', () => {
  // 这条只能在源码层面守：额度是在 app.js 的今天页算的，而 app.js 需要浏览器环境，单元测试加载不了它。
  // 「读了 app.js 的源码」是静态检查，不是运行时验证 —— 真正的运行时验证在 tools/quicklog-check.mjs
  // （那里会记一次运动，前后对比首页显示的「今天还可以吃」，数字必须一模一样）。
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  assert.ok(
    app.includes('const budget = t.targetCalories;'),
    '今天的额度必须就是目标热量本身（budget = t.targetCalories）',
  );
  assert.ok(
    !/targetCalories\s*\+/.test(app),
    '额度后面不许再加任何东西 —— 加回运动消耗 = 同一次运动算两遍，缺口会被抹平',
  );
  assert.ok(
    !app.includes('trainingBudgetBonus') && !app.includes('TRAINING_BUDGET_SHARE'),
    '不许再有任何「运动消耗折成额度加成」的代码',
  );
  assert.ok(!app.includes('运动奖励'), '「运动奖励 X kcal 已计入」这种暗示可以多吃的胶囊必须去掉');
});

test('运动消耗只用来显示，不参与任何额度计算（没有导出这种函数）', async () => {
  const mod = await import('../js/exercise.js');
  assert.equal(mod.trainingBudgetBonus, undefined, '不该存在「运动折成额度」的函数');
  assert.equal(mod.TRAINING_BUDGET_SHARE, undefined);
  // 消耗估算本身还是要有，而且只跟 METs / 体重 / 时长有关
  assert.equal(estimateTrainingKcal({ mets: 5, minutes: 60 }, 60), 300);
});

/* ── 9. 老接口不能被改坏 ─────────────────────── */

test('旧的 addExercise 仍然能记运动，统计照样认它（推荐页还在用这条老路）', () => {
  const state = freshState();
  const item = addExercise(state, '2026-10-16', 'walk', 40);
  assert.ok(item, '老接口应当还能记上');
  assert.equal(item.minutes, 40);
  // 老记录没有 mets，靠旧 METs 池兜底
  const s = trainingSummary(state, '2026-10-16', WEIGHT);
  assert.equal(s.today.count, 1);
  assert.equal(s.today.minutes, 40);
  assert.equal(s.today.kcal, Math.round(calcExerciseKcal({ mets: 4.3, weightKg: WEIGHT, minutes: 40 })));
  // store 的关卡：0 / 负数 / 超上限直接返回 null，统计里不会多出假记录
  assert.equal(addExercise(state, '2026-10-16', 'walk', 0), null);
  assert.equal(addExercise(state, '2026-10-16', 'walk', -30), null);
  assert.equal(addExercise(state, '2026-10-16', 'walk', 1441), null);
  assert.equal(addExercise(state, '2026-10-16', '', 30), null);
  assert.equal(trainingSummary(state, '2026-10-16', WEIGHT).today.count, 1);
});

test('resolveTrainingAction 只认库里真有的动作', () => {
  assert.equal(resolveTrainingAction({}), null, '什么都没选就该是 null，不能默认记一个动作');
  assert.equal(resolveTrainingAction(), null);
  assert.equal(resolveTrainingAction({ cardioId: 'yoga_stretch' }).mets, 2.5);
  assert.equal(resolveTrainingAction({ exerciseKey: 'bodyweight' }).name, '自重训练（徒手）');
  assert.equal(resolveTrainingAction({ cardioId: 'nope' }), null);
  assert.equal(resolveTrainingAction({ exerciseKey: 'nope' }), null);
});
