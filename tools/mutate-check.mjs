/**
 * 反向验证：把源码临时改坏，确认测试真的会失败。
 * 只在临时副本上操作，跑完自动还原，不会污染真实文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
  { file: 'js/calc.js', from: 'const bmr = sex === \'female\' ? base - 161 : base + 5;', to: 'const bmr = sex === \'female\' ? base - 100 : base + 5;', why: '女性基础代谢常数（应为 161）' },
  { file: 'js/calc.js', from: 'const floorBySex = sex === \'female\' ? 1200 : 1500;', to: 'const floorBySex = 800;', why: '女生 1200 kcal 安全下限' },
  { file: 'js/calc.js', from: 'if (deficit > cap) {', to: 'if (false) {', why: '每周减重不超过 1% 的收窄逻辑' },
  { file: 'js/foods.js', from: "kcal: 116, protein: 2.6, fat: 0.3, carb: 25.9", to: "kcal: 316, protein: 2.6, fat: 0.3, carb: 25.9", why: '熟米饭每 100 克 116 kcal' },
  { file: 'js/foods.js', from: "if (/斤/.test(unit)) return round1(qty * 500);", to: "if (/斤/.test(unit)) return round1(qty * 50);", why: '一斤 = 500 克' },
  { file: 'js/store.js', from: "const entry = { id: newId('e'), meal: mealKey,", to: "const entry = { id: newId('e'),", why: '记录里必须写明哪一餐' },
  { file: 'js/store.js', from: "if (typeof grams !== 'number' || !Number.isFinite(grams) || grams <= 0) {", to: "if (grams <= 0) {", why: '份量必须是数字而不是字符串' },
  { file: 'js/recommend.js', from: 'const MAIN_PROTEIN_KCAL_SHARE = 0.7;', to: 'const MAIN_PROTEIN_KCAL_SHARE = 5;', why: '主菜占当餐热量的上限' },
  { file: 'js/exercise.js', from: "{ key: 'low', label: '目前基本不动', steps: 6000", to: "{ key: 'low', label: '目前基本不动', steps: 20000", why: '走路目标档位' },
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
  if (failed) {
    caught += 1;
    console.log(`✅ 抓到了：${m.why}`);
  } else {
    missed.push(m.why);
    console.log(`❌ 没抓到：${m.why}（${m.file}）`);
  }
}

console.log(`\n反向验证结果：${caught}/${MUTATIONS.length} 个故意引入的错误被测试抓到`);
if (missed.length) {
  console.log('以下改动没有被任何测试发现，说明测试太弱：');
  for (const x of missed) console.log('  -', x);
  process.exitCode = 1;
}
