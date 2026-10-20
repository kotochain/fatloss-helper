/**
 * 有氧运动库：按「练什么 + 需要什么器械」组织，方便器械没空时替换
 *
 * 消耗热量用 METs 估算：消耗(kcal) = METs × 体重(kg) × 小时数
 * METs 数值参考《体力活动概要》（Compendium of Physical Activities）常见条目，属估算值。
 * 手环上的数字和这里对不上很正常，两者都是估算。
 */

/** 器械（也包含「不用器械」和户外条件） */
export const EQUIPMENT = {
  treadmill: { name: '跑步机', icon: '🏃' },
  incline_treadmill: { name: '爬坡机 / 跑步机坡度', icon: '⛰️' },
  elliptical: { name: '椭圆机', icon: '🌀' },
  bike: { name: '动感单车 / 健身车', icon: '🚴' },
  rower: { name: '划船机', icon: '🚣' },
  stair: { name: '登山机 / 楼梯机', icon: '🪜' },
  stepper: { name: '踏步机', icon: '👟' },
  jump_rope: { name: '跳绳', icon: '🪢' },
  bodyweight: { name: '徒手/地面', icon: '🤸' },
  mat: { name: '瑜伽垫', icon: '🧘' },
  dumbbell: { name: '哑铃', icon: '🏋️' },
  kettlebell: { name: '壶铃', icon: '🔔' },
  band: { name: '弹力带', icon: '➰' },
  cable: { name: '龙门架 / 绳索', icon: '🕸️' },
  machine: { name: '固定器械', icon: '⚙️' },
  pool: { name: '泳池', icon: '🏊' },
  outdoor: { name: '户外（路跑/操场）', icon: '🌳' },
  stairs_real: { name: '真实楼梯', icon: '🏢' },
  court: { name: '球类场地', icon: '🏸' },
  studio: { name: '操房 / 团课', icon: '🎵' },
};

/** 没勾过器械时默认有的四项（跟她手机上第一版看到的一样，老存档升级后行为不变） */
export const DEFAULT_EQUIPMENT = ['treadmill', 'elliptical', 'bike', 'bodyweight'];

/**
 * 把她勾过的器械整理成能用的列表（存在存档 settings.equipment 里）。
 *
 * 为什么要过一道：存档可能被手改坏、可能留着已经删掉的器械 id，
 * 直接拿去筛动作会出现「勾了但界面上没有」或「推荐出根本没有的器械」。
 * 一个都不剩时回默认四项，而不是空列表（空列表等于什么动作都推荐不出来）。
 */
export function normalizeEquipment(list) {
  if (!Array.isArray(list)) return [...DEFAULT_EQUIPMENT];
  const valid = [...new Set(list.filter((key) => typeof key === 'string' && EQUIPMENT[key]))];
  return valid.length ? valid : [...DEFAULT_EQUIPMENT];
}

/** 训练目标（想练到什么） */
export const GOALS = {
  fat_burn: { name: '燃脂（长时间中低强度）', short: '燃脂' },
  cardio_health: { name: '心肺耐力', short: '心肺' },
  interval: { name: '省时间的高强度间歇', short: '间歇' },
  low_impact: { name: '不伤膝/低冲击', short: '低冲击' },
  legs_glutes: { name: '顺带练腿臀', short: '腿臀' },
  recovery: { name: '恢复/放松', short: '恢复' },
};

/**
 * 有氧动作库。
 * 每个动作：METs、需要什么器械、能达成哪些目标、强度怎么把握、注意事项。
 */
export const CARDIO = [
  // ── 跑步机系列 ──
  {
    id: 'treadmill_walk',
    name: '跑步机快走',
    mets: 4.3,
    equipment: ['treadmill'],
    goals: ['fat_burn', 'cardio_health', 'low_impact'],
    intensity: '速度 5.5~6.5 km/h，能说话但唱不了歌',
    cue: '全程别扶扶手，扶手会让消耗少两成',
    note: '膝踝不舒服时把坡度调高、速度调低，冲击更小',
    tags: ['入门', '膝盖友好'],
  },
  {
    id: 'treadmill_incline_walk',
    name: '爬坡走（跑步机加坡度）',
    mets: 6.3,
    equipment: ['incline_treadmill', 'treadmill'],
    goals: ['fat_burn', 'legs_glutes', 'cardio_health'],
    intensity: '坡度 8~12%、速度 4.5~5.5 km/h',
    cue: '身体别趴在扶手上，重心稍微后坐，臀部发力',
    note: '这是减脂期性价比最高的有氧之一：累但不太伤膝',
    tags: ['首选', '练臀'],
  },
  {
    id: 'treadmill_run',
    name: '跑步机慢跑',
    mets: 8.3,
    equipment: ['treadmill'],
    goals: ['cardio_health', 'fat_burn'],
    intensity: '速度 7.5~9 km/h，心率约最大心率的 70~80%',
    cue: '前 5 分钟先快走热身，最后 3 分钟降速走',
    note: '体重较大或膝盖不适时优先快走/爬坡',
    tags: ['高效'],
  },
  {
    id: 'treadmill_interval',
    name: '跑步机间歇（快跑+慢走循环）',
    mets: 9.0,
    equipment: ['treadmill', 'incline_treadmill'],
    goals: ['interval', 'fat_burn', 'cardio_health'],
    intensity: '快跑 1 分钟 + 慢走 1 分钟，重复 10~12 轮',
    cue: '快跑段用「说不出完整句子」的强度',
    note: '省时间，但对心肺要求高，前两周先做 6 轮',
    tags: ['省时间', '进阶'],
  },

  // ── 椭圆机系列 ──
  {
    id: 'elliptical_steady',
    name: '椭圆机匀速',
    mets: 5.0,
    equipment: ['elliptical'],
    goals: ['fat_burn', 'low_impact', 'cardio_health'],
    intensity: '阻力 6~8 档，踏频 50~60 转/分，持续 30~40 分钟',
    cue: '双手推拉把手，让上肢也参与，消耗高约一成',
    note: '没有爬坡机时的首选替代：同样练心肺和腿臀，膝盖零冲击',
    tags: ['膝盖友好', '替代首选'],
    substituteFor: ['treadmill_incline_walk', 'treadmill_walk'],
  },
  {
    id: 'elliptical_interval',
    name: '椭圆机间歇',
    mets: 6.5,
    equipment: ['elliptical'],
    goals: ['interval', 'fat_burn', 'cardio_health'],
    intensity: '高阻力 1 分钟 + 低阻力 1 分钟，重复 10 轮',
    cue: '高阻力段踏频别掉太多，靠阻力而不是靠速度',
    note: '同样 20 分钟，比匀速更省时间',
    tags: ['省时间'],
    substituteFor: ['treadmill_interval'],
  },

  // ── 单车系列 ──
  {
    id: 'bike_steady',
    name: '动感单车 / 健身车',
    mets: 6.8,
    equipment: ['bike'],
    goals: ['fat_burn', 'cardio_health', 'low_impact'],
    intensity: '阻力中等，踏频 70~90 转/分，30~40 分钟',
    cue: '座椅高度调到踩到底时膝盖微屈（约 25 度）',
    note: '膝关节压力小，久坐人群友好',
    tags: ['膝盖友好'],
  },
  {
    id: 'bike_interval',
    name: '单车冲刺间歇',
    mets: 8.8,
    equipment: ['bike'],
    goals: ['interval', 'fat_burn'],
    intensity: '冲刺 30 秒 + 轻松骑 90 秒，重复 8~10 轮',
    cue: '冲刺段站起来摇车会更容易达到强度',
    note: '做之前先轻松骑 5 分钟热身',
    tags: ['省时间', '进阶'],
  },
  {
    id: 'spin_class',
    name: '动感单车课',
    mets: 8.5,
    equipment: ['bike', 'studio'],
    goals: ['interval', 'fat_burn', 'cardio_health'],
    intensity: '跟教练节奏，45 分钟一节',
    cue: '新手把阻力调低一档，别硬跟',
    note: '有氛围更容易坚持，但一节课消耗常被高估',
    tags: ['有人带'],
  },

  // ── 划船机 / 登山机 / 踏步机 ──
  {
    id: 'rower_steady',
    name: '划船机',
    mets: 7.0,
    equipment: ['rower'],
    goals: ['fat_burn', 'cardio_health'],
    intensity: '桨频 22~26 次/分，持续 20~30 分钟',
    cue: '发力顺序：腿 → 背 → 手；回程反过来',
    note: '全身参与，同时对膝盖友好。腰不好的人注意别弓背',
    tags: ['全身', '膝盖友好'],
    substituteFor: ['treadmill_run', 'bike_steady'],
  },
  {
    id: 'stair_climber',
    name: '登山机 / 楼梯机',
    mets: 9.0,
    equipment: ['stair'],
    goals: ['fat_burn', 'legs_glutes', 'interval'],
    intensity: '中等速度持续 15~25 分钟',
    cue: '整只脚踩实，别只用前脚掌；别趴在扶手上',
    note: '很累很有效，但膝盖压力比爬坡走大，新手从 10 分钟开始',
    tags: ['高效', '练臀'],
  },
  {
    id: 'stepper',
    name: '踏步机',
    mets: 6.0,
    equipment: ['stepper'],
    goals: ['fat_burn', 'low_impact'],
    intensity: '持续 20~30 分钟，能说话的程度',
    cue: '步子别太大，膝盖对着脚尖方向',
    note: '强度比椭圆机略高一点，占地小',
    tags: ['入门'],
  },

  // ── 徒手 / 跳跃 ──
  {
    id: 'jump_rope',
    name: '跳绳',
    mets: 11.0,
    equipment: ['jump_rope', 'bodyweight'],
    goals: ['interval', 'fat_burn'],
    intensity: '跳 1 分钟 + 歇 30 秒，做 10~15 轮',
    cue: '用前脚掌落地，手腕摇绳而不是整条手臂',
    note: '消耗极高但冲击大：体重较大或膝踝不适时换成快走/椭圆机',
    tags: ['省时间', '高效', '冲击大'],
  },
  {
    id: 'jump_rope_low',
    name: '无绳跳（原地小跳）',
    mets: 8.0,
    equipment: ['bodyweight'],
    goals: ['interval', 'fat_burn'],
    intensity: '跳 40 秒 + 歇 40 秒，做 10 轮',
    cue: '离地 3~5 厘米就够，别跳高',
    note: '没有跳绳或楼下有人时的替代方案',
    tags: ['无器械'],
  },
  {
    id: 'bodyweight_circuit',
    name: '徒手循环（开合跳+高抬腿+深蹲+登山跑）',
    mets: 8.0,
    equipment: ['bodyweight', 'mat'],
    goals: ['interval', 'fat_burn'],
    intensity: '每个动作 40 秒 + 歇 20 秒，4 个动作为一轮，做 4~5 轮',
    cue: '宁可慢一点也要做标准，尤其深蹲别塌膝',
    note: '没有任何器械也能练，适合在家/出差',
    tags: ['无器械', '省时间'],
  },
  {
    id: 'hiit_video',
    name: '跟练 HIIT 视频',
    mets: 8.0,
    equipment: ['bodyweight', 'mat'],
    goals: ['interval', 'fat_burn'],
    intensity: '跟视频 20~30 分钟',
    cue: '累到动作变形就停下来歇 10 秒，别硬撑受伤',
    note: '有教练喊节奏，比自己数更容坚持',
    tags: ['有人带', '无器械'],
  },

  // ── 户外 ──
  {
    id: 'outdoor_walk',
    name: '户外快走',
    mets: 4.3,
    equipment: ['outdoor'],
    goals: ['fat_burn', 'cardio_health', 'low_impact', 'recovery'],
    intensity: '能说话但唱不了歌，30~60 分钟',
    cue: '摆臂、步幅稍大；上坡路段自然加速',
    note: '最容易坚持的一种，通勤路上就能做',
    tags: ['入门', '膝盖友好'],
    substituteFor: ['treadmill_walk'],
  },
  {
    id: 'outdoor_jog',
    name: '户外慢跑',
    mets: 8.3,
    equipment: ['outdoor'],
    goals: ['cardio_health', 'fat_burn'],
    intensity: '30 分钟轻松配速（能断续说话）',
    cue: '鼻吸口呼，前 1 公里压住速度',
    note: '水泥地冲击比跑步机大，鞋要缓冲够',
    tags: ['高效'],
    substituteFor: ['treadmill_run'],
  },
  {
    id: 'real_stairs',
    name: '爬楼梯（真实楼梯）',
    mets: 8.8,
    equipment: ['stairs_real', 'outdoor'],
    goals: ['fat_burn', 'legs_glutes', 'interval'],
    intensity: '上楼上 10~15 层，坐电梯下楼，重复 4~6 轮',
    cue: '上楼一步一台阶，别跨两级；下楼一定坐电梯（下楼最伤膝）',
    note: '免费、随时能做，消耗接近登山机',
    tags: ['免费', '练臀'],
    substituteFor: ['treadmill_incline_walk', 'stair_climber'],
  },
  {
    id: 'outdoor_cycle',
    name: '骑共享单车 / 骑行',
    mets: 6.8,
    equipment: ['outdoor', 'bike'],
    goals: ['fat_burn', 'cardio_health', 'low_impact'],
    intensity: '中等速度骑行 40~60 分钟',
    cue: '座垫调高，踩到底膝盖微屈',
    note: '通勤+运动一举两得',
    tags: ['膝盖友好'],
  },

  // ── 泳池 / 球类 / 团课 ──
  {
    id: 'swim_steady',
    name: '游泳（中等强度）',
    mets: 7.0,
    equipment: ['pool'],
    goals: ['fat_burn', 'cardio_health', 'low_impact'],
    intensity: '连续游 20~30 分钟，中间可停 1~2 次',
    cue: '先 200 米慢游热身；累了改蛙泳或仰泳',
    note: '关节零冲击，但游完特别容易饿，注意别用大餐奖励自己',
    tags: ['膝盖友好', '全身'],
    substituteFor: ['bike_steady', 'elliptical_steady'],
  },
  {
    id: 'badminton',
    name: '羽毛球',
    mets: 5.5,
    equipment: ['court'],
    goals: ['cardio_health', 'fat_burn'],
    intensity: '打 45~60 分钟（含休息）',
    cue: '双打强度偏低，想减脂就多跑动',
    note: '乐趣高、容易坚持；注意热身踝关节',
    tags: ['好玩'],
  },
  {
    id: 'dance_class',
    name: '跳舞 / 团课（Zumba、搏击操）',
    mets: 6.5,
    equipment: ['studio', 'bodyweight'],
    goals: ['fat_burn', 'cardio_health'],
    intensity: '一节课 45 分钟',
    cue: '跟不上就降幅度，别停',
    note: '氛围好、不枯燥，适合不想一个人在跑步机上熬的人',
    tags: ['有人带', '好玩'],
  },

  // ── 恢复 ──
  {
    id: 'yoga_stretch',
    name: '瑜伽 / 拉伸',
    mets: 2.5,
    equipment: ['mat', 'studio'],
    goals: ['recovery', 'low_impact'],
    intensity: '20~40 分钟',
    cue: '呼吸自然，别追求拉到疼',
    note: '不算减脂主力，但能减少酸痛、改善体态',
    tags: ['恢复'],
  },
];

/**
 * 找替代动作：原动作做不了时，给「同样能达成目标、且今天的器械能用」的动作。
 * 评分优先级：明确标注可替代 > 目标重合度 > 器械重合度 > METs 接近
 */
export function substituteExercises(originalId, availableEquipment, limit = 3) {
  const original = CARDIO.find((e) => e.id === originalId);
  if (!original) return [];
  const avail = new Set(availableEquipment || []);
  return CARDIO
    .filter((e) => e.id !== originalId)
    .filter((e) => e.equipment.some((q) => avail.has(q)))
    .map((e) => {
      const goalOverlap = e.goals.filter((g) => original.goals.includes(g)).length;
      const equipOverlap = e.equipment.filter((q) => original.equipment.includes(q)).length;
      const metsGap = Math.abs(e.mets - original.mets);
      const explicit = (e.substituteFor || []).includes(originalId) ? 3 : 0;
      // 替代的分数只看「像不像原动作」，不再叠加「首选」这类偏好分
      //（否则椭圆机会被跳舞课顶掉 —— 那是推荐偏好，不是替代相关性）
      return {
        exercise: e,
        // 权重说明：目标重合最重要（要练到同一件事），其次器械重合（更好上手），
        // 最后才是 METs 接近程度（强度像不像）
        score: explicit * 10 + goalOverlap * 4 + equipOverlap * 1.5 - metsGap,
        why: [
          explicit ? '专门标注可以替代它' : '',
          goalOverlap ? `同样能达成「${GOALS[original.goals[0]]?.short || ''}」` : '',
          `METs ${e.mets}（原动作 ${original.mets}）`,
        ].filter(Boolean).join('，'),
      };
    })
    // 排序：先用得上她勾选的器械，再看像不像原动作
    .sort((a, b) => {
      const aFit = a.exercise.equipment.some((q) => avail.has(q)) ? 1 : 0;
      const bFit = b.exercise.equipment.some((q) => avail.has(q)) ? 1 : 0;
      return bFit - aFit || b.score - a.score;
    })
    .slice(0, limit);
}

/**
 * 按「今天有什么器械 + 想练什么 + 有多少时间」推荐有氧。
 * @param {{equipment:string[], goal?:string, minutes?:number, exclude?:string[]}} opts
 */
export function recommendCardio(opts = {}) {
  const avail = new Set(opts.equipment || []);
  const goal = opts.goal || 'fat_burn';
  const minutes = opts.minutes || 30;
  const exclude = new Set(opts.exclude || []);

  const usable = CARDIO.filter((e) => e.equipment.some((q) => avail.has(q)) && !exclude.has(e.id));
  if (!usable.length) {
    return {
      picks: [],
      advice: '今天没有可用器械也没关系：快走、爬楼梯、原地徒手循环都不需要器械，效果也不差。',
    };
  }

  const scored = usable.map((e) => {
    let score = 0;
    if (e.goals.includes(goal)) score += 6;
    if (e.goals.includes('fat_burn')) score += 2;
    if (e.goals.includes('cardio_health')) score += 1;
    // 时间匹配。时间紧时「间歇」必须能压过「首选」标签，
    // 否则 20 分钟的推荐会给出一个 40 分钟才合适的爬坡走。
    const isInterval = e.goals.includes('interval');
    if (minutes <= 25 && isInterval) score += 8;
    if (minutes >= 40 && e.goals.includes('fat_burn') && !isInterval) score += 3;
    if ((e.tags || []).includes('首选')) score += 1;
    if ((e.tags || []).includes('冲击大') && minutes >= 30) score -= 1;
    return { exercise: e, score };
  }).sort((a, b) => b.score - a.score || a.exercise.mets - b.exercise.mets);

  const picks = scored.slice(0, 3).map((s) => ({
    ...s.exercise,
    kcal: Math.round((s.exercise.mets * (opts.weightKg || 60) * minutes) / 60),
  }));

  return {
    picks,
    advice: `按你今天的器械（${[...avail].map((q) => EQUIPMENT[q]?.name || q).join('、')}）和 ${minutes} 分钟时间排出上面几个，第一个最合适。`,
  };
}

/** 列出某台器械能做哪些有氧 */
export function exercisesByEquipment(equipmentKey) {
  return CARDIO.filter((e) => e.equipment.includes(equipmentKey));
}

export function listEquipment() {
  return Object.entries(EQUIPMENT).map(([key, e]) => ({ key, ...e }));
}
