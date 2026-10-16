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
  // 下面两条是「有意测不出来」的护栏，不是测试太弱（详见 tests/calc.test.mjs 的说明）：
  //  - 缺口上限 75%：按内置三档节奏，250 kg 的人也到不了，真实兜底是「每周 ≤1% 体重」那条不变量
  //  - 碳水 80 克下限：脂肪上限已经先给碳水留了位置，这个常量不会在实际输入下被触发
  { file: 'js/calc.js', from: 'const deficitCap = tdee * 0.75;', to: 'const deficitCap = tdee * 5;', why: '缺口上限（理论护栏，测不到）', expectCaught: false },
  { file: 'js/calc.js', from: 'const MIN_CARB_G = 80;', to: 'const MIN_CARB_G = 0;', why: '碳水 80 克下限（结构性成立，测不到）', expectCaught: false },
  { file: 'js/calc.js', from: 'const idealFatG = weightKg * (goalMode === ', to: 'const idealFatG = weightKg * 0.1 * (goalMode === ', why: '脂肪 0.8~0.9 g/kg 的目标' },
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
  { file: 'js/cardio.js', from: "    .filter((e) => e.equipment.some((q) => avail.has(q)))\n    .map((e) => {", to: "    .filter(() => true)\n    .map((e) => {", why: '替代动作必须是她今天能用的器械' },
  { file: 'js/ai-core.js', from: "    if (!(grams > 0) || grams > 5000) continue;", to: "    if (!(grams > -1)) continue;", why: 'AI 返回的离谱份量要被丢掉' },
  // ── 第三轮新增：正反馈系统 ──
  { file: 'js/achievements.js', from: 'if (t.kcal > 0 && t.protein >= goal) n += 1;', to: 'if (t.kcal > 0) n += 1;', why: '「蛋白达标」必须用她的目标判定，不能只要吃了就算达标' },
  { file: 'js/achievements.js', from: "const level = PLANT_STAGES.reduce((acc, s, i) => (total >= s.min ? i : acc), 0);", to: "const level = PLANT_STAGES.reduce((acc, s, i) => (streak >= s.min ? i : acc), 0);", why: '小植物按累计天数生长（断档不该倒退）' },
  { file: 'js/achievements.js', from: "  const seen = new Set(state?.achievements?.seen || []);", to: '  const seen = new Set();', why: '庆祝过的徽章不该重复弹' },
  { file: 'js/achievements.js', from: "  if (!isMonday) return false;", to: '  if (isMonday) return false;', why: '周报只在周一弹，不是每天打扰' },
];

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
  const expected = m.expectCaught !== false;
  if (failed === expected) {
    caught += 1;
    console.log(expected ? `✅ 抓到了：${m.why}` : `✅ 如预期测不到（已说明原因）：${m.why}`);
  } else {
    missed.push(m.why);
    console.log(`❌ ${expected ? '没抓到' : '居然抓到了（说明注释写错了）'}：${m.why}（${m.file}）`);
  }
}

console.log(`\n反向验证结果：${caught}/${MUTATIONS.length} 项符合预期（其中 2 项是已说明原因的护栏）`);
console.log(`（实验在临时副本里做的：${root}，真实文件未被修改）`);
if (missed.length) {
  console.log('以下改动没有被任何测试发现，说明测试太弱：');
  for (const x of missed) console.log('  -', x);
  process.exitCode = 1;
}
