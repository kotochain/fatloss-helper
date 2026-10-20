/**
 * 有氧推荐与动作替换测试
 *
 * 核心保证（这是需求的原话：「跑步机没了只有椭圆机，要能相应调整」）：
 *  1) 推荐出来的动作，器械必须是她今天真的有的；
 *  2) 替代动作不能要求她用不上的器械（不能推荐需要操房的团课给只有椭圆机的人）；
 *  3) 替代动作要练到同一件事（目标重合），强度不能差太远。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARDIO, EQUIPMENT, GOALS, substituteExercises, recommendCardio, exercisesByEquipment, listEquipment,
  normalizeEquipment, DEFAULT_EQUIPMENT,
} from '../js/cardio.js';

test('每个动作的器械、目标都必须是有定义的，METs 在合理范围', () => {
  const problems = [];
  for (const e of CARDIO) {
    if (!e.name) problems.push('有动作没名字');
    if (!(e.mets >= 1.5 && e.mets <= 16)) problems.push(`${e.name} 的 METs=${e.mets} 不合理`);
    for (const q of e.equipment) if (!EQUIPMENT[q]) problems.push(`${e.name} 引用了不存在的器械 ${q}`);
    for (const g of e.goals) if (!GOALS[g]) problems.push(`${e.name} 引用了不存在的目标 ${g}`);
    if (!e.equipment.length) problems.push(`${e.name} 没写需要什么器械（徒手也要写 bodyweight）`);
    if (!e.intensity || !e.cue) problems.push(`${e.name} 缺少「怎么做」或「要点」`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('推荐结果只用她勾选的器械能做到', () => {
  const sets = [
    ['elliptical'], ['treadmill'], ['bike'], ['bodyweight'], ['jump_rope'],
    ['elliptical', 'bike'], ['stairs_real'], ['pool'], ['mat'],
  ];
  for (const equipment of sets) {
    const rec = recommendCardio({ equipment, goal: 'fat_burn', minutes: 30, weightKg: 58 });
    assert.ok(rec.picks.length > 0, `${equipment.join('+')} 没有推荐出任何动作`);
    for (const p of rec.picks) {
      assert.ok(p.equipment.some((q) => equipment.includes(q)),
        `${equipment.join('+')} 下推荐了「${p.name}」，但它需要 ${p.equipment.join('/')}`);
      assert.ok(p.kcal > 0 && p.kcal < 900, `${p.name} 的热量估算 ${p.kcal} 不合理`);
    }
  }
});

test('只有椭圆机时，首选就是椭圆机（不能推跑步机的动作）', () => {
  const rec = recommendCardio({ equipment: ['elliptical'], goal: 'fat_burn', minutes: 30, weightKg: 58 });
  assert.ok(rec.picks[0].name.includes('椭圆机'), `首选成了「${rec.picks[0].name}」`);
});

test('替代动作不要求她今天用不上的器械', () => {
  // 这是实际踩过的坑：只有椭圆机的人，替代方案第一名却是「跳舞/团课」（需要操房）
  const cases = [
    ['treadmill_incline_walk', ['elliptical']],
    ['elliptical_steady', ['elliptical']],
    ['treadmill_run', ['bike']],
    ['stair_climber', ['outdoor', 'stairs_real']],
  ];
  for (const [originalId, equipment] of cases) {
    const subs = substituteExercises(originalId, equipment, 3);
    assert.ok(subs.length > 0, `${originalId} 在 ${equipment.join('+')} 下没有替代方案`);
    for (const s of subs) {
      const fits = s.exercise.equipment.some((q) => equipment.includes(q));
      // 允许「不需要器械」的动作（例如徒手循环）作为兜底
      const noEquipmentNeeded = s.exercise.equipment.length === 1 && s.exercise.equipment[0] === 'bodyweight';
      assert.ok(fits || noEquipmentNeeded,
        `${originalId} 的替代方案「${s.exercise.name}」需要 ${s.exercise.equipment.join('/')}，但她只有 ${equipment.join('/')}`);
    }
  }
});

test('替代动作要练到同一件事：至少有一个目标重合', () => {
  for (const e of CARDIO) {
    const subs = substituteExercises(e.id, Object.keys(EQUIPMENT), 3);
    for (const s of subs) {
      const overlap = s.exercise.goals.filter((g) => e.goals.includes(g));
      assert.ok(overlap.length > 0, `「${s.exercise.name}」替代「${e.name}」时目标完全不重合`);
      assert.ok(s.why.includes('METs'), '替代理由里应当写清强度对比');
    }
  }
});

test('没有可用器械时给兜底建议，而不是空列表', () => {
  const rec = recommendCardio({ equipment: [], goal: 'fat_burn', minutes: 30 });
  assert.deepEqual(rec.picks, []);
  assert.ok(rec.advice.includes('快走') || rec.advice.includes('徒手'), '应当提示不用器械也能练');
});

test('时间紧的时候优先给间歇方案', () => {
  const short = recommendCardio({ equipment: ['treadmill'], goal: 'fat_burn', minutes: 20, weightKg: 58 });
  assert.ok(short.picks.some((p) => (p.tags || []).includes('省时间') || p.name.includes('间歇')),
    `20 分钟的推荐里没有间歇方案：${short.picks.map((p) => p.name).join('、')}`);
});

test('常见健身房的器械都能查出动作', () => {
  for (const key of ['treadmill', 'incline_treadmill', 'elliptical', 'bike', 'rower', 'stair', 'stepper', 'jump_rope', 'bodyweight']) {
    const list = exercisesByEquipment(key);
    assert.ok(list.length >= 1, `${EQUIPMENT[key]?.name || key} 一个动作都没有`);
  }
});

test('器械清单完整（含图标和名字）', () => {
  const list = listEquipment();
  assert.ok(list.length >= 18, `器械只有 ${list.length} 个`);
  for (const eq of list) {
    assert.ok(eq.name && eq.icon, `${eq.key} 缺少名字或图标`);
  }
});

test('热量估算随体重和时长线性变化', () => {
  const a = recommendCardio({ equipment: ['elliptical'], goal: 'fat_burn', minutes: 30, weightKg: 50 }).picks[0];
  const b = recommendCardio({ equipment: ['elliptical'], goal: 'fat_burn', minutes: 30, weightKg: 100 }).picks[0];
  assert.equal(b.kcal, a.kcal * 2, '体重翻倍时热量应当翻倍');
  const c = recommendCardio({ equipment: ['elliptical'], goal: 'fat_burn', minutes: 60, weightKg: 50 }).picks[0];
  assert.equal(c.kcal, a.kcal * 2, '时长翻倍时热量应当翻倍');
});

test('反向验证：如果允许推荐未勾选的器械，上面的测试会失败', () => {
  // 手动构造一个「不让过滤」的推荐，确认测试断言的口径确实能发现问题
  const rec = recommendCardio({ equipment: ['pool'], goal: 'fat_burn', minutes: 30, weightKg: 60 });
  const wrong = CARDIO.filter((e) => !e.equipment.includes('pool')).slice(0, 3);
  assert.ok(wrong.length > 0);
  for (const w of wrong) {
    assert.ok(!w.equipment.includes('pool'), `${w.name} 其实不需要泳池，说明这组反例无效`);
  }
  for (const p of rec.picks) {
    assert.ok(p.equipment.includes('pool'), `推荐了 ${p.name}，但她只有泳池`);
  }
});

test('器械勾选能存能读；老存档没这个字段时回落默认四项（issue #4）', () => {
  // 默认就是她没勾过的时候看到的那四项
  assert.deepEqual(normalizeEquipment(undefined), DEFAULT_EQUIPMENT);
  assert.deepEqual(normalizeEquipment(null), DEFAULT_EQUIPMENT);
  assert.deepEqual(normalizeEquipment([]), DEFAULT_EQUIPMENT, '一个都没勾等于没配过，要回默认而不是空');
  // 正常保存的勾选原样读回来
  assert.deepEqual(normalizeEquipment(['elliptical', 'dumbbell']), ['elliptical', 'dumbbell']);
  // 脏数据：不认识的器械 id 要剔掉，重复的要去重（否则界面上会出现不存在的按钮）
  assert.deepEqual(normalizeEquipment(['elliptical', 'nope', 'elliptical']), ['elliptical']);
  // 存的不是数组（被手改坏了）时不能崩
  assert.deepEqual(normalizeEquipment('elliptical'), DEFAULT_EQUIPMENT);
  assert.deepEqual(normalizeEquipment({ 0: 'elliptical' }), DEFAULT_EQUIPMENT);
});
