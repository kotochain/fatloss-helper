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
// 沙箱必须和真实仓库一样「该有的都有」：以前只拷了 js/tests/tools/package.json，
// 但 tests/icons.test.mjs 会读 index.html —— 沙箱里没有这个文件 → 测试直接 ENOENT 崩，
// 于是每一条变异都被判「抓到了」，77/77 是假的（v27 由独立验证员发现）。
// 文案护栏会扫 README / HANDOFF / docs / .github，沙箱里也要有，否则那条变异测不出来
for (const entry of ['js', 'tests', 'tools', 'package.json', 'index.html', 'sw.js', 'css', 'icons', 'manifest.webmanifest', 'README.md', 'HANDOFF.md', 'docs', '.github']) {
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
  // v36：「顺手做两件事」的三条硬规则（今天空着不出卡、最多两条、蛋白缺口要提）
  { file: 'js/nextsteps.js', from: '  if (entriesOn(state, today).length === 0) return [];', to: '  if (false) return [];', why: '今天一笔都没记时不能重复催（交给接住卡）' },
  { file: 'js/nextsteps.js', from: '  return candidates.slice(0, 2);', to: '  return candidates.slice(0, 3);', why: '今天页最多两条，多了就是骚扰' },
  { file: 'js/nextsteps.js', from: '  if (remaining > 0 && gap > 10) {', to: '  if (remaining > 0 && gap > 100) {', why: '蛋白缺口明显时要给补蛋白的建议' },
  // v35：单源化与 #13（4/9/4 只有一处、没给份量不许丢、部分漏识别要提示、合计只有一份）
  { file: 'js/calc.js', from: 'export function macroKcal({ protein = 0, fat = 0, carb = 0 } = {}) {', to: 'export function macroKcal({ protein = 0, fat = 0, carb = 0 } = {) {', why: '4/9/4 折算只有一处实现（语法级破坏：改坏后测试会红）' },
  { file: 'js/ai-core.js', from: '      gramsMissing: !rounded && !portion,', to: '      gramsMissing: false,', why: 'AI 只给名字没给份量时必须标出来（否则又变成悄悄丢/悄悄估）' },
  { file: 'js/mealparse.js', from: "    if (leftover.length < 2) leftover = '';", to: "    leftover = '';", why: '部分漏识别要提示（认出一部分时不能一声不响）' },
  { file: 'js/calc.js', from: '      acc.protein += f.protein;', to: '      acc.protein += 0;', why: '每日合计只有一份（改坏蛋白累加后，合计断言必须红）' },
  // v34：AI 归位相关的三条（估营养优先级 / 4-9-4 校验 / 省请求的保守判定）
  { file: 'js/mealparse.js', from: 'if (checked?.ok) {', to: 'if (false) {', why: 'AI 估的营养通过本地校验后必须真的用上（否则又退回「只给名字」的老路）' },
  { file: 'js/label.js', from: 'if (diffPct > 50) return { ok: false, reason: \'热量和营养素对不上（差超过 50%）\' };', to: 'if (false) return { ok: false, reason: \'热量和营养素对不上（差超过 50%）\' };', why: 'AI 数字自相矛盾（差 >50%）时必须退回本地均值' },
  { file: 'js/mealparse.js', from: '  if (leftover.length >= 2) return null;', to: '  if (false) return null;', why: '句子还有别的吃的时不能省 AI 请求（省请求不能变成悄悄漏记）' },
  // v33：数据安全相关的三条（覆盖前判断 + 范围只认一处）
  { file: 'js/store.js', from: 'return foods > 0 || (d.exercises || []).length > 0 || String(d.note || \'\').trim().length > 0;', to: 'return true;', why: '「记过的日子」不能把打开页面顺手建的空日期算进去（会把备份页/覆盖确认的数字撑大）' },
  { file: 'js/store.js', from: '|| Boolean(state.profile);', to: '|| false;', why: '只填了资料也算「丢了会心疼」——演示/导入会把它换掉' },
  { file: 'js/calc.js', from: 'bodyFatPct: [3, 60],', to: 'bodyFatPct: [8, 55],', why: '体脂率范围只认 LIMITS 一处（表单校验和基础代谢公式共用）' },
  { file: 'js/store.js', from: "const entry = { id: newId('e'), meal: mealKey,", to: "const entry = { id: newId('e'),", why: '记录里必须写明哪一餐' },
  { file: 'js/store.js', from: "if (typeof grams !== 'number' || !Number.isFinite(grams) || grams <= 0) {", to: 'if (grams <= 0) {', why: '份量必须是数字而不是字符串' },
  { file: 'js/recommend.js', from: 'const MAIN_PROTEIN_KCAL_SHARE = 0.7;', to: 'const MAIN_PROTEIN_KCAL_SHARE = 5;', why: '主菜占当餐热量的上限' },
  { file: 'js/recommend.js', from: 'const MAX_DAILY_OIL_G = 30;', to: 'const MAX_DAILY_OIL_G = 300;', why: '每天烹调油上限' },
  { file: 'js/exercise.js', from: "{ key: 'low', label: '目前基本不动', steps: 6000", to: "{ key: 'low', label: '目前基本不动', steps: 20000", why: '走路目标档位' },
  // ── 第二轮新增：说一句话记录 / 按器械换动作 ──
  { file: 'js/mealparse.js', from: 'const chosenDish = dishHits.find((h) => !h.ref.generic)?.ref || dishHits[0]?.ref || null;', to: 'const chosenDish = dishHits[0]?.ref || null;', why: '具体菜优先于泛称（否则「食堂吃了碗牛肉面」会被认成「食堂打饭」）' },
  // v27 用真实沙箱复核过：下面这些「改坏」在自然语料下输出完全不变（其它护栏先兜住了），
  // 任何测试都抓不到 —— 如实标成等价变异，不假装它们是被测试守住的。
  { file: 'js/mealparse.js', from: 'cands.push({ hi, p, dist, before, score: fit * 3 - dist });', to: 'cands.push({ hi, p, dist, before, score: -dist });', why: '份量归属要看「单位配不配这个食物」（等价变异：fit<0 的过滤已先兜住，137 条自然语料输出不变）', sensitivity: 'equivalent' },
  { file: 'js/mealparse.js', from: '      if (fit < 0) continue; // 单位跟食物类型明显对不上，不许抢', to: '      if (false) continue;', why: '「半包」这种包装说法不能配给奶茶（等价变异：得分排序里 -2 分永远排最后，改掉过滤后仍抢不到）', sensitivity: 'equivalent' },
  { file: 'js/mealparse.js', from: '      .filter((p) => Math.abs(p.index - chosenDishIndex) <= 6 && !takenByFoods.has(p.index));', to: '      .filter((p) => Math.abs(p.index - chosenDishIndex) <= 6);', why: '组合菜不能抢走已经被食材认领的份量（「吃完火锅又喝了杯奶茶」的份量/理由必须归奶茶）' },
  { file: 'js/mealparse.js', from: '  const scale = DISH_UNIT_SCALE[portion.portionWord];', to: '  const scale = null;', why: '组合菜的「一碗」是一份，不是通用碗重 350 克（一碗牛肉面 600 克）' },
  { file: 'js/mealparse.js', from: '    out.push(portionFromBareUnit(unit, index));', to: '    void unit;', why: '口语里不带「一」的份量词也要算（喝了瓶运动饮料=瓶、吃了碗牛肉面=碗；删掉后置信度/理由/追问全变）' },
  { file: 'js/cardio.js', from: '  return valid.length ? valid : [...DEFAULT_EQUIPMENT];', to: '  return valid;', why: '器械一个都不剩时要回默认四项（空列表会让推荐全空）' },
  { file: 'js/mealparse.js', from: 'const perUnit = food.servings?.[0]?.[1] || FOOD_DEFAULT_GRAMS[food.id] || portion.perUnit || 100;', to: 'const perUnit = portion.perUnit || 100;', why: '「一个」要按食物自己的份量换算（鸡蛋 50 克 ≠ 通用 100 克）' },
  { file: 'js/cardio.js', from: 'const avail = new Set(availableEquipment || []);', to: 'const avail = new Set(Object.keys(EQUIPMENT));', why: '替代动作必须是用户今天能用的器械' },
  { file: 'js/ai-core.js', from: '    if (grams > 5000) continue;', to: '    if (false) continue;', why: 'AI 返回的离谱份量要被丢掉' },
  // ── 第三轮新增：正反馈系统 ──
  { file: 'js/achievements.js', from: 'if (t.kcal > 0 && t.protein >= goal) n += 1;', to: 'if (t.kcal > 0) n += 1;', why: '「蛋白达标」必须用用户的目标判定，不能只要吃了就算达标' },
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
  // ── 第七轮：AI 解析后按名字匹配本地食物（修的是一个「AI 模式从来没工作过」的 bug）──
  { file: 'js/mealparse.js', from: 'const hit = matchFoodByName(name, { preferForm: preferForm || detectFoodForm(name), customFoods });', to: 'const hit = null;', why: 'AI 认出的食物必须能在本地库/我的食物里匹配上（否则一条都记不上）' },
  { file: 'js/mealparse.js', from: 'if (out.items.length) {', to: 'if (true) {', why: '一条都没记上时不该再追问（答不上来）' },
  { file: 'js/mealparse.js', from: 'out.unmatchedItems.push({ name, grams, estimateId: generic.id });', to: "out.unmatchedItems.push({ name: '?', grams: 0 });", why: '没匹配上的食物要原样告诉用户（名字和克数）' },
  { file: 'js/foods.js', from: 'if (!best || best.score < minScore) return null;', to: 'if (!best) return null;', why: '匹配分数太低宁可不算（等价变异：现有食物库/查询里没有「有匹配但低分」的样本，实测输出一致）', sensitivity: 'equivalent' },
  { file: 'js/insights.js', from: 'if (logged.length < 4) return [];', to: 'if (false) return [];', why: '记录太少时不许给「规律」（等价变异：后面的 topSourceInsight 也有 ≥4 天门槛，0~3 天输出仍为空）', sensitivity: 'equivalent' },
  { file: 'js/insights.js', from: 'if (a.length < minPerGroup || b.length < minPerGroup) return null;', to: 'if (false) return null;', why: '两组样本都不够时不许做对比' },
  // ── 第七轮：份量不确定时反问用户 ──
  { file: 'js/mealparse.js', from: '    const verdict = portionVerdict(f, portion, converted > 0);', to: "    const verdict = { confidence: 'high', reason: null };", why: '「一碗」「一份」这种说不准的说法必须标成低置信度（全标成高置信度就等于什么都不问）' },
  { file: 'js/mealparse.js', from: '  if (VAGUE_UNITS.has(unit)) {', to: '  if (false) {', why: '「碗」「份」「包」这类说不准的量词必须问一句' },
  { file: 'js/mealparse.js', from: '  const below = nearest(true) || { label: labels[0], grams: round5(g * smallK) };', to: '  const below = nearest(true) || { label: labels[0], grams: g };', why: '档位的最小档必须真的比当前值小（否则点了没变化，等于白问）' },
  { file: 'js/mealparse.js', from: '  const above = nearest(false) || { label: labels[2], grams: round5(g * largeK) };', to: '  const above = nearest(false) || { label: labels[2], grams: g };', why: '档位的最大档必须真的比当前值大（否则点了没变化）' },
  { file: 'js/mealparse.js', from: "  if (portion.counting || !portion.portionWord) return { confidence: 'high', reason: null };", to: "  if (portion.counting) return { confidence: 'high', reason: null };", why: '用户说了确切克数（「200克米饭」）就是说清了，不能再问' },
  // ── 第八轮：运动记录与统计 ──
  { file: 'js/exercise.js', from: 'if (key >= start && key <= end) {', to: 'if (key >= start) {', why: '「这周」必须两头都限制（只卡开始日期的话，下周一的记录会被算进这周）' },
  { file: 'js/exercise.js', from: 'minutes += Math.round(Number(x?.minutes) || 0);', to: 'minutes += 1;', why: '运动统计要加时长而不是数次数（今天几分钟、累计几分钟全靠它）' },
  { file: 'js/exercise.js', from: 'if (Number.isFinite(stored) && stored > 0) return stored;', to: 'if (false) return stored;', why: '记录里存下的 METs 必须优先用（否则爬坡走会被按快走的强度算）' },
  { file: 'js/exercise.js', from: 'return pool?.mets ?? 4;', to: 'return 4;', why: '老记录没有 METs 时要退回旧 METs 池（跳绳 11 ≠ 快走 4）' },
  { file: 'js/exercise.js', from: 'cardio: CARDIO.filter((e) => e.equipment.some((q) => avail.has(q))),', to: 'cardio: CARDIO.filter(() => true),', why: '只给今天器械做得了的动作（不能推荐跑步机的动作给只有椭圆机的人）' },
  { file: 'js/exercise.js', from: 'const sinceMonday = (dt.getDay() + 6) % 7;', to: 'const sinceMonday = dt.getDay();', why: '一周从周一算起（写成 getDay 就成了周日算起，周日的记录会串到上一周）' },
  // ── 第九轮：AI 教练（数字本地算，AI 只组织语言）──
  { file: 'js/coach.js', from: 'const gramsByBudget = Math.floor((budget / f.kcal) * 100 / 10) * 10;', to: 'const gramsByBudget = 300;', why: '教练建议的份量必须受剩余额度限制（不能劝用户吃超）' },
  { file: 'js/coach.js', from: '  if (bad.length) {', to: '  if (false) {', why: 'AI 说了清单外的数字必须退回本地版（模型编数字是这个功能唯一的真风险）' },
  { file: 'js/coach.js', from: "if (/(运动|锻炼|练了|健身|跑步)", to: "if (/(游泳)", why: '不许暗示「运动了可以多吃」（红线）' },
  { file: 'js/coach.js', from: '    if (totals.kcal < MIN_DAY_KCAL) continue;', to: '    if (false) continue;', why: '只记了一百多卡的那天不算「记了」（否则平均热量被拉低）' },
  { file: 'js/coach.js', from: '  if (remainingKcal <= 0) {', to: '  if (false) {', why: '已经吃超了就不能再给加餐建议' },
  { file: 'js/cardio.js', from: '  return CARDIO_MINUTES.reduce((best, m) => (Math.abs(m - v) < Math.abs(best - v) ? m : best), CARDIO_MINUTES[0]);', to: '  return v;', why: '训练时长要吸附到界面的档位（存档里 37 分钟会让所有按钮都不选中）' },
  // ── 第十轮：拍照读表用真模型跑出来的问题 ──
  { file: 'js/label.js', from: "if (!(consistency.diffPct > 20)) return '';", to: "if (false) return '';", why: '只有真对不上（>20%）才劝重拍，否则每次拍照都吓用户一次' },
  { file: 'js/ai-core.js', from: '数字必须和它左边的项目名在**同一行**', to: '数字必须和它左边的项目名在**附近**', why: '读表提示词必须要求「数字和项目名同一行」（糊照片上最容易整行错位）' },
  { file: 'js/ai-core.js', from: "const thinking = String(choice?.message?.reasoning_content || '').trim();", to: "const thinking = '';", why: '正文空但只有思考时，要说是模型在深度思考，不能说成断网' },
  { file: 'js/cardio.js', from: "  return Object.prototype.hasOwnProperty.call(GOALS, key) ? key : 'fat_burn';", to: '  return key;', why: '训练目标认不出来要回「燃脂」（否则推荐拿不到目标）' },
  // ── 第十一轮：AI 设置留空密钥 + 「只填热量」──
  { file: 'js/providers.js', from: "const apiKey = askedKey || (presetChanged ? '' : (existing?.apiKey || ''));", to: 'const apiKey = askedKey;', why: '输入框留空（空字符串）必须沿用已保存的密钥，不能报「密钥没填」' },
  { file: 'js/providers.js', from: "const presetChanged = Boolean(existing?.apiKey && existing.presetId && preset.id !== existing.presetId);", to: 'const presetChanged = false;', why: '换了服务商不能沿用上一家的密钥（等于把钥匙递给第三方）' },
  { file: 'js/foods.js', from: "if (!Number.isFinite(k) || k <= 0) return { ok: false, error: '热量要填一个大于 0 的数字（kcal）。' };", to: 'if (!Number.isFinite(k)) return { ok: false };', why: '「只填热量」要挡住 0 / 负数（否则会记一条 0 kcal 的空记录）' },
  { file: 'js/foods.js', from: 'if (k > 5000) return { ok: false', to: 'if (k > 99999) return { ok: false', why: '「只填热量」要挡住明显多填一位的数字' },
  { file: 'js/store.js', from: '      if (e.food.kcalOnly) continue;', to: '      if (false) continue;', why: '「只填热量」的条目不该出现在「常吃的」里（否则变成 100 克 = 650 kcal 的怪快捷项）' },
  // ── 第十二轮：emoji 换内联 SVG 图标 ──
  { file: 'js/icons.js', from: "    ? ' stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"'", to: "    ? ''", why: '线性图标必须在根 svg 上带描边（漏了就是整片透明，界面上只剩空位）' },
  { file: 'js/icons.js', from: '    body = LINE[key] || LINE._fallback;', to: '    body = LINE[key];', why: '未知图标名要有兜底字形（不能把 undefined 塞进 DOM）' },
  { file: 'js/icons.js', from: "  const badgeKey = key.startsWith('badge-') ? key.slice(6) : '';", to: "  const badgeKey = key.startsWith('badge-') ? key.slice(6) : key;", why: '只有 badge- 前缀才是徽章：裸名字（sprout / run / leaf）不能被同名徽章抢走' },
  // ── 第十三轮：图标放大 + 徽章重画（v27）──
  { file: 'js/icons.js', from: '    body = badgeBody(badgeKey, BADGE[badgeKey]);', to: '    body = LINE._fallback;', why: '徽章要有花边渐变（改回扁平圆就退化了）' },
  { file: 'js/icons.js', from: '  const glyph = BADGE_GLYPH[key] || BADGE_GLYPH._fallback;', to: '  const glyph = BADGE_GLYPH._fallback;', why: '每个徽章必须画自己的字形（都画成方块就没意义了）' },
  { file: 'js/icons.js', from: "  play: '<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M10.4 8.8l4.9 3.2-4.9 3.2z\"/>',", to: '', why: '设置页「重看新手引导」的新图标不能丢' },
  { file: 'js/app.js', from: 'badgeLabel(state, x)', to: 'badgeLabel(x)', why: '徽章名要带存档参数，否则徽章墙 16 个名字全部为空（v26 真踩过）' },
  { file: 'js/icons.js', from: "  database: '<ellipse cx=\"12\" cy=\"6.4\" rx=\"7\" ry=\"2.7\"/><path d=\"M5 6.4v11.2c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7V6.4\"/><path d=\"M5 12c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7\"/>',", to: '', why: '设置页「数据与备份」的数据图标不能丢' },
  // ── 第十四轮：更新弹窗 + 称呼清理（v28）──
  // 不写死版本号：改成往版本号里插一个非法前缀（'v0v29'），下个版本不用改这条
  { file: 'js/version.js', from: "export const APP_VERSION = '", to: "export const APP_VERSION = 'v0", why: '版本号必须合法且和 CHANGELOG 最新一条、sw.js 一致（不一致手机上看版本会对不上）' },
  { file: 'js/whatsnew.js', from: '  return Number.isFinite(x) && Number.isFinite(y) && x > y;', to: '  return Number.isFinite(x) && Number.isFinite(y) && x < y;', why: '「服务端比本地新」的方向不能反（反了就会说「有新版本」其实没有）' },
  { file: 'js/whatsnew.js', from: "  if (!lastSeen) return changelog.slice(0, 1);", to: '  if (!lastSeen) return [];', why: '老用户升级到带更新说明的版本时，至少要看一次最新一版的更新' },
  { file: 'js/app.js', from: "const STORAGE_KEY = STATE_KEY;", to: "const STORAGE_KEY = STATE_KEY; // \u5979", why: '文案护栏：源码/文档里不许再出现第三人称（使用者是自己用的，只能叫「你」）' },
  // ── 第十五轮：生重/熟重口径（v30）──
  { file: 'js/foods.js', from: "  const wantForm = preferForm || detectFoodForm(name) || 'cooked';", to: "  const wantForm = preferForm || detectFoodForm(name) || 'raw';", why: '没说生熟时默认按熟重（普通人称/估的是做熟后的重量；默认生重会少算 20%+）' },
  { file: 'js/foods.js', from: '    const formBonus = food.form ? (food.form === wantForm ? 8 : -8) : 0;', to: '    const formBonus = food.form ? (food.form === wantForm ? -8 : 8) : 0;', why: '生熟加分的正负不能反（反了「生鸡胸肉」会匹配成熟重）' },
  { file: 'js/foods.js', from: "  if (/生重|生(?:的)?(?:[\\u4e00-\\u9fa5]{0,2})(鸡|鸡脯|鸡腿|牛|猪|羊|鱼|虾|肉)/.test(s)) return 'raw';", to: "  if (false) return 'raw';", why: '句子里说「生」必须识别为生重（否则 100 克生鸡胸会按熟的算，多算 25%）' },
  { file: 'js/mealparse.js', from: '      if (foodForm === \'cooked\') continue; // 熟重数据已经包含做法，不能再按做法乘油量', to: '      if (false) continue;', why: '熟重条目不能再按做法乘油量（水煮鸡胸会变成 145 kcal）' },
  { file: 'js/recommend.js', from: "{ name: '鸡胸肉 + 米饭 + 西兰花', protein: ['chicken_breast_cooked'], ratio: [1], carb: 'rice_cooked', veg: 'broccoli', side: null },", to: "{ name: '鸡胸肉 + 米饭 + 西兰花', protein: ['chicken_breast'], ratio: [1], carb: 'rice_cooked', veg: 'broccoli', side: null },", why: '餐单的肉/鱼必须是熟重条目（用户照餐单克数去记录时默认也是熟重，两边口径要一致）' },
  // ── v31：说一句记不上 / AI 听懂了却记不上 ──
  { file: 'js/mealparse.js', from: 'for (const a of (ALIASES[f.id] || [])) {', to: 'for (const a of []) {', why: '食物别名要进离线词典（否则「一杯酸奶」「半斤牛奶」整句认不出来）' },
  { file: 'js/foods.js', from: 'export const CATALOG_FOODS = [...FOODS, ...DISH_FOODS];', to: 'export const CATALOG_FOODS = [...FOODS];', why: '组合菜也要进「可匹配目录」（AI 说「黄焖鸡米饭」才能对上）' },
  { file: 'js/dishes.js', from: '    _aliases: dish.aliases,', to: '    _aliases: [],', why: '组合菜的别名要带上（「盖饭」「三明治」「烧烤」全靠它）' },
  { file: 'js/mealparse.js', from: '    const generic = genericEstimateFor(name);', to: "    const generic = genericEstimateFor('米饭');", why: '兜底要按名字归类（不能全按主食算）' },
  { file: 'js/mealparse.js', from: '      if (perServing) return perServing[1] * (portion.count || 1);', to: '      if (perServing) return portion.grams;', why: '「一碗馄饨」要按一份 300 克算，不是通用碗重 350 克' },
  { file: 'js/mealparse.js', from: '      const mealWord = entry.text.length === 1 && /[早午晚夜中宵]/.test(text[idx - 1] || \'\');', to: '      const mealWord = false;', why: '「晚饭」里的「饭」不能当成一碗米饭（否则热量翻倍）' },
  { file: 'js/mealparse.js', from: '  if (chosenDish && !dropGeneric) {', to: '  if (chosenDish) {', why: '食堂打饭 + 三道具体菜时不能一顿算成两顿' },
  { file: 'js/ai-core.js', from: '  if (cn) return CN_QTY[cn[1]] * (cn[2] === \'斤\' ? 500 : 50);', to: '  if (false) return 0;', why: '「三两」「半斤」这种中文数字 + 市制单位要能认' },
  { file: 'js/ai-core.js', from: '  if (!attempt.ok && attempt.status === 400 && /response_format|json_object|json mode/i.test(attempt.body || \'\')) {', to: '  if (false) {', why: '服务商不支持 JSON 模式时要自动去掉参数重试（否则用户只看到「AI 没成功」）' },
  { file: 'js/ai-core.js', from: "      { role: 'user', content: '上面这段不是合法 JSON。请只输出 JSON 对象，格式：{\"meal\":\"lunch\",\"items\":[{\"name\":\"食物名\",\"grams\":150,\"kcal\":200,\"protein\":10,\"fat\":5,\"carb\":25}],\"questions\":[]}' },", to: "      { role: 'user', content: '再试一次' },", why: '模型没按 JSON 回时要再要一次，并重申只要 JSON' },
  { file: 'js/ai-core.js', from: '    const portion = portionRaw && PORTION_HINT.test(portionRaw) ? portionRaw.trim().slice(0, 20) : null;', to: '    const portion = null;', why: 'AI 只给「一碗」这种份量说法时不能丢（否则用户白说）' },
  { file: 'js/foodlog.js', from: '  const all = [...customFoods, ...CATALOG_FOODS];', to: '  const all = [...customFoods];', why: '搜食物也要能搜到本地食物库和组合菜' },
  // ── v31 补充：提示词与兜底 ──
  { file: 'js/ai-core.js', from: "    '4. 只要这句话提到了吃或喝的东西（哪怕只说了一样、或者很不确定），items 里就**至少要有 1 条**。',", to: "    '4. 只要这句话提到了吃或喝的东西，items 里可以有 0 条。',", why: '提示词必须禁止「返回空 items / 说看不懂」（用户看到的就是没听懂）' },
  { file: 'js/foods.js', from: '  for (const g of GENERIC_ESTIMATES) {\n    if (g.keywords && g.keywords.test(q)) return g;', to: '  for (const g of GENERIC_ESTIMATES) {\n    if (false) return g;', why: '兜底要按关键词归类（肉菜/主食/甜点…）' },
  { file: 'js/ai-core.js', from: '  if (!first.items.length) {', to: '  if (false) {', why: '模型返回空 items 时要再要一次（这是「AI 说没听懂」最常见的来源）' },
  { file: 'js/insights.js', from: '  const food = findFood(id) || findMatchableFood(id);', to: '  const food = findFood(id);', why: '组合菜从搜索里记进去后，也要能出现在「热量大头」洞察里' },
  // ── v32：留存 B（今天页的「接住」）──
  { file: 'js/achievements.js', from: "  if (!loggedToday) return { kind: 'today-empty' };", to: '  if (false) return { kind: \'today-empty\' };', why: '今天还没记时要给「先记一口」的接住' },
  { file: 'js/achievements.js', from: '  if (state?.settings?.yesterdayNudgeSkipped === today) return null;', to: '  if (false) return null;', why: '「今天不补」要真的跳过当天（否则一直问）' },
  { file: 'js/achievements.js', from: '  const hasHistory = Object.keys(state?.days || {}).some((k) => k < yesterday && hasLog(state, k));', to: '  const hasHistory = true;', why: '第一次用的人不该被问「昨天怎么没记」' },

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
let equivalents = 0;
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
  if (m.sensitivity === 'equivalent') {
    // 等价变异：改坏后行为不变，任何测试都不该抓到。抓到了说明标注错了（不是等价），要拿出来看。
    equivalents += 1;
    if (failed) {
      missed.push(`标成等价变异但其实被测试抓到了（标注要更新）：${m.why}`);
      console.log(`❌ 标注不符：${m.why}`);
    } else {
      console.log(`ℹ️ 等价变异（改坏后行为不变，测试抓不到是正常的）：${m.why}`);
    }
  } else if (m.sensitivity === 'partial') {
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
const strictTotal = MUTATIONS.length - partial - equivalents;
const strictCaught = caught - partial; // partial 那两条不论抓到没抓到都会累加，这里要扣掉
console.log(`\n反向验证结果：严格捕获 ${strictCaught}/${strictTotal} 项符合预期`
  + `（另有 ${partial} 项标注为「半敏感」、${equivalents} 项标注为「等价变异」—— 都不是测试能守住的，如实分开记）`);
console.log(`（实验在临时副本里做的：${root}，真实文件未被修改）`);
if (missed.length) {
  console.log('以下改动没有被任何测试发现，说明测试太弱：');
  for (const x of missed) console.log('  -', x);
  process.exitCode = 1;
}
