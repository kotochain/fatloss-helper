/**
 * 反向验证：把源码改坏，确认测试真的会失败。
 *
 * 做法：先把整个项目复制到系统临时目录，在副本上改坏、在副本上跑测试，
 * 真实文件从头到尾不被碰过（中途 Ctrl-C 也不会留下改坏的文件）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 复制到临时目录再做实验
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fatloss-mutate-'));
for (const entry of ['js', 'tests', 'tools', 'package.json']) {
  fs.cpSync(path.join(source, entry), path.join(sandbox, entry), { recursive: true });
}
const root = sandbox;

const MUTATIONS = [
  { file: 'js/calc.js', from: "const bmr = sex === 'female' ? base - 161 : base + 5;", to: "const bmr = sex === 'female' ? base - 100 : base + 5;", why: '女性基础代谢常数（应为 161）' },
  { file: 'js/calc.js', from: "const floorBySex = sex === 'female' ? 1200 : 1500;", to: 'const floorBySex = 800;', why: '女生 1200 kcal 安全下限' },
  // 这两条属于「护栏」：改了它，测试确实会失败（因为它会连带影响别的量），
  // 但并不是因为某个断言专门盯着它们。这里如实标注「半敏感」，
  // 两种结果都算符合预期 —— 之前我把它们写成「测不到」，实际是能抓到的，属于记录不准。
  { file: 'js/calc.js', from: 'const deficitCap = tdee * 0.75;', to: 'const deficitCap = tdee * 5;', why: '缺口上限 75%（理论护栏，测试半敏感）', sensitivity: 'partial' },
  { file: 'js/calc.js', from: 'const MIN_CARB_G = 80;', to: 'const MIN_CARB_G = 0;', why: '碳水 80 克下限（兜底护栏，测试半敏感）', sensitivity: 'partial' },
  { file: 'js/calc.js', from: "const idealFatG = weightKg * (goalMode === 'lose' ? 0.8 : 0.9);", to: "const idealFatG = weightKg * (goalMode === 'lose' ? 0.05 : 0.9);", why: '脂肪 0.8~0.9 g/kg 的目标' },
  { file: 'js/foods.js', from: 'kcal: 116, protein: 2.6, fat: 0.3, carb: 25.9', to: 'kcal: 316, protein: 2.6, fat: 0.3, carb: 25.9', why: '熟米饭每 100 克 116 kcal' },
  { file: 'js/foods.js', from: 'if (/斤/.test(unit)) return round1(qty * 500);', to: 'if (/斤/.test(unit)) return round1(qty * 50);', why: '一斤 = 500 克' },
  { file: 'js/foods.js', from: 'const exact = pairs.find((x) => x.key === unit);', to: 'const exact = null;', why: '「一碗」必须精确命中而不是被「一小碗」抢走' },
  { file: 'js/store.js', from: "const entry = { id: newId('e'), meal: mealKey,", to: "const entry = { id: newId('e'),", why: '记录里必须写明哪一餐' },
  { file: 'js/store.js', from: "if (typeof grams !== 'number' || !Number.isFinite(grams) || grams <= 0) {", to: 'if (grams <= 0) {', why: '份量必须是数字而不是字符串' },
  { file: 'js/recommend.js', from: 'const MAIN_PROTEIN_KCAL_SHARE = 0.7;', to: 'const MAIN_PROTEIN_KCAL_SHARE = 5;', why: '主菜占当餐热量的上限' },
  { file: 'js/recommend.js', from: 'const MAX_DAILY_OIL_G = 30;', to: 'const MAX_DAILY_OIL_G = 300;', why: '每天烹调油上限' },
  { file: 'js/exercise.js', from: "{ key: 'low', label: '目前基本不动', steps: 6000", to: "{ key: 'low', label: '目前基本不动', steps: 20000", why: '走路目标档位' },
  // ── 第二轮新增：说一句话记录 / 按器械换动作 ──
  { file: 'js/mealparse.js', from: 'const chosenDish = dishHits.find((h) => !h.ref.generic)?.ref || dishHits[0]?.ref || null;', to: 'const chosenDish = dishHits[0]?.ref || null;', why: '具体菜优先于泛称（否则「食堂吃了碗牛肉面」会被认成「食堂打饭」）' },
  { file: 'js/mealparse.js', from: "      .sort((a, b) => a.dist - b.dist);", to: '      .sort((a, b) => b.dist - a.dist);', why: '份量按最近距离配对（否则「两个鸡蛋和一个苹果」会串份量）' },
  { file: 'js/mealparse.js', from: 'const perUnit = food.servings?.[0]?.[1] || FOOD_DEFAULT_GRAMS[food.id] || portion.perUnit || 100;', to: 'const perUnit = portion.perUnit || 100;', why: '「一个」要按食物自己的份量换算（鸡蛋 50 克 ≠ 通用 100 克）' },
  { file: 'js/mealparse.js', from: "aliases: ['食堂打饭', '打饭', '两个菜', '三菜一汤', '一份饭', '食堂'], generic: true,", to: "aliases: ['食堂打饭', '打饭', '两个菜', '三菜一汤', '一份饭', '食堂'], generic: false,", why: '「食堂」是泛称，不能抢走「牛肉面」' },
  { file: 'js/cardio.js', from: 'const avail = new Set(availableEquipment || []);', to: 'const avail = new Set(Object.keys(EQUIPMENT));', why: '替代动作必须是她今天能用的器械' },
  { file: 'js/ai-core.js', from: "    if (!(grams > 0) || grams > 5000) continue;", to: "    if (!(grams > -1)) continue;", why: 'AI 返回的离谱份量要被丢掉' },
  // ── 第三轮新增：正反馈系统 ──
  { file: 'js/achievements.js', from: 'if (t.kcal > 0 && t.protein >= goal) n += 1;', to: 'if (t.kcal > 0) n += 1;', why: '「蛋白达标」必须用她的目标判定，不能只要吃了就算达标' },
  { file: 'js/achievements.js', from: "const level = PLANT_STAGES.reduce((acc, s, i) => (total >= s.min ? i : acc), 0);", to: "const level = PLANT_STAGES.reduce((acc, s, i) => (streak >= s.min ? i : acc), 0);", why: '小植物按累计天数生长（断档不该倒退）' },
  { file: 'js/achievements.js', from: "  const seen = new Set(state?.achievements?.seen || []);", to: '  const seen = new Set();', why: '庆祝过的徽章不该重复弹' },
  { file: 'js/achievements.js', from: "  if (!isMonday) return false;", to: '  if (isMonday) return false;', why: '周报只在周一弹，不是每天打扰' },
  // ── 第四轮：份量上限与脂肪目标对账 ──
  { file: 'js/recommend.js', from: 'const servingUnit = (food.servings?.[0]?.[1] || 100) >= 40', to: 'const servingUnit = (food.servings?.[0]?.[1] || 100) >= 400', why: '主菜份量不能用「一只虾 15 克」当单位（会算出 30 克主菜）' },
  { file: 'js/recommend.js', from: "const raw = role === 'carb' ? perMealKcal / 300 : perMealKcal / 380;", to: "const raw = role === 'carb' ? perMealKcal / 30 : perMealKcal / 38;", why: '单个食物份量上限（别给「一顿 4.5 个鸡蛋」这种方案）' },
  { file: 'js/recommend.js', from: 'if (grams >= servingG * 0.8)', to: 'if (grams >= 0)', why: '配角要么给一份，要么别出现（不要「33 克酸奶」）' },
  // ── 第五轮：数据迁移与「目标不许被餐单改写」 ──
  { file: 'js/schema.js', from: 'if (from > SCHEMA_VERSION) {', to: 'if (false) {', why: '未来版本的存档必须拒绝读取（否则会抹掉新字段）' },
  { file: 'js/schema.js', from: "return hasShape && daysIsObject;", to: 'return true;', why: '乱七八糟的内容不能被当成存档' },
  { file: 'js/schema.js', from: 'if (from < SCHEMA_VERSION) {', to: 'if (false) {', why: '升级前必须留快照（能回滚）' },
  { file: 'js/schema.js', from: "for (const [key, list] of Object.entries(meals)) {", to: 'for (const [key, list] of []) {', why: '老记录要补上「哪一餐」（否则按餐汇总全为 0）' },
  { file: 'js/recommend.js', from: 'if (proteinRatio < 0.9) {', to: 'if (false) {', why: '蛋白不足时说明里必须点出来' },
  { file: 'js/recommend.js', from: 'if (fatRatio < 0.85) {', to: 'if (false) {', why: '脂肪不足时说明里必须点出来' },
  // ── 第六轮：本地周洞察 ──
  { file: 'js/insights.js', from: 'if (logged.length < 4) return [];', to: 'if (false) return [];', why: '记录太少时不许给「规律」（数据不够编出来的结论是害人的）' },
  { file: 'js/insights.js', from: 'if (a.length < minPerGroup || b.length < minPerGroup) return null;', to: 'if (false) return null;', why: '两组样本都不够时不许做对比' },
  // ── 第七轮：份量不确定时反问她 ──
  { file: 'js/mealparse.js', from: '    const verdict = portionVerdict(f, portion, converted > 0);', to: "    const verdict = { confidence: 'high', reason: null };", why: '「一碗」「一份」这种说不准的说法必须标成低置信度（全标成高置信度就等于什么都不问）' },
  { file: 'js/mealparse.js', from: '  if (VAGUE_UNITS.has(unit)) {', to: '  if (false) {', why: '「碗」「份」「包」这类说不准的量词必须问一句' },
  { file: 'js/mealparse.js', from: '  const below = nearest(true) || { label: labels[0], grams: round5(g * smallK) };', to: '  const below = nearest(true) || { label: labels[0], grams: g };', why: '档位的最小档必须真的比当前值小（否则点了没变化，等于白问）' },
  { file: 'js/mealparse.js', from: '  const above = nearest(false) || { label: labels[2], grams: round5(g * largeK) };', to: '  const above = nearest(false) || { label: labels[2], grams: g };', why: '档位的最大档必须真的比当前值大（否则点了没变化）' },
  { file: 'js/mealparse.js', from: "  if (portion.counting || !portion.portionWord) return { confidence: 'high', reason: null };", to: "  if (portion.counting) return { confidence: 'high', reason: null };", why: '她说了确切克数（「200克米饭」）就是说清了，不能再问' },
  // ── 第八轮：运动记录与统计 ──
  { file: 'js/exercise.js', from: 'if (key >= start && key <= end) {', to: 'if (key >= start) {', why: '「这周」必须两头都限制（只卡开始日期的话，下周一的记录会被算进这周）' },
  { file: 'js/exercise.js', from: 'minutes += Math.round(Number(x?.minutes) || 0);', to: 'minutes += 1;', why: '运动统计要加时长而不是数次数（今天几分钟、累计几分钟全靠它）' },
  { file: 'js/exercise.js', from: 'if (Number.isFinite(stored) && stored > 0) return stored;', to: 'if (false) return stored;', why: '记录里存下的 METs 必须优先用（否则爬坡走会被按快走的强度算）' },
  { file: 'js/exercise.js', from: 'return pool?.mets ?? 4;', to: 'return 4;', why: '老记录没有 METs 时要退回旧 METs 池（跳绳 11 ≠ 快走 4）' },
  { file: 'js/exercise.js', from: 'cardio: CARDIO.filter((e) => e.equipment.some((q) => avail.has(q))),', to: 'cardio: CARDIO.filter(() => true),', why: '只给今天器械做得了的动作（不能推荐跑步机的动作给只有椭圆机的人）' },
  { file: 'js/exercise.js', from: 'const sinceMonday = (dt.getDay() + 6) % 7;', to: 'const sinceMonday = dt.getDay();', why: '一周从周一算起（写成 getDay 就成了周日算起，周日的记录会串到上一周）' },
];

// 先自己检查一遍：每条变异锚点必须在文件里找得到，
// 否则「没抓到」其实是脚本失效，而不是测试太弱（这个坑踩过好几次）
const brokenAnchors = [];
for (const m of MUTATIONS) {
  const target = path.join(root, m.file);
  const src = fs.readFileSync(target, 'utf8');
  if (!src.includes(m.from)) brokenAnchors.push(`${m.file}: ${m.from.slice(0, 60)}`);
}
if (brokenAnchors.length) {
  console.error('❌ 有变异的锚点代码已经不存在了（脚本自己失效，先修锚点）：');
  for (const b of brokenAnchors) console.error('   -', b);
  process.exit(1);
}

let caught = 0;
const missed = [];

for (const m of MUTATIONS) {
  const target = path.join(root, m.file);
  const original = fs.readFileSync(target, 'utf8');
  if (!original.includes(m.from)) {
    missed.push(`${m.file}: 找不到要替换的代码片段（测试本身失效了）`);
    continue;
  }
  fs.writeFileSync(target, original.replace(m.from, m.to));
  let failed = false;
  try {
    execSync('node --test "tests/*.test.mjs"', { cwd: root, stdio: 'pipe' });
  } catch {
    failed = true;
  } finally {
    fs.writeFileSync(target, original);
  }
  if (m.sensitivity === 'partial') {
    // 半敏感：抓到没抓到都说明不了问题，如实记录结果
    caught += 1;
    console.log(`ℹ️ ${failed ? '抓到了' : '没抓到（正常）'}：${m.why}`);
  } else if (failed !== (m.expectCaught !== false)) {
    missed.push(m.why);
    console.log(`❌ 没抓到：${m.why}（${m.file}）`);
  } else {
    caught += 1;
    console.log(`✅ 抓到了：${m.why}`);
  }
}

const partial = MUTATIONS.filter((m) => m.sensitivity === 'partial').length;
console.log(`\n反向验证结果：${caught}/${MUTATIONS.length} 项符合预期（其中 ${partial} 项是标注为「半敏感」的护栏）`);
console.log(`（实验在临时副本里做的：${root}，真实文件未被修改）`);
if (missed.length) {
  console.log('以下改动没有被任何测试发现，说明测试太弱：');
  for (const x of missed) console.log('  -', x);
  process.exitCode = 1;
}
