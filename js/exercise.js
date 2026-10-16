/**
 * 运动建议：练什么、练几组、大概消耗多少热量
 *
 * 消耗热量用 METs 估算：消耗(kcal) = METs × 体重(kg) × 小时数
 * METs 数值参考《体力活动概要》（Compendium of Physical Activities）的常见条目，属于估算值。
 * 手环上的数字和这里对不上很正常，两者都是估算。
 */

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
