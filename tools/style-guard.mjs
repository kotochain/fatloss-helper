/**
 * 样式守卫：把「视觉 token 收敛」这条规则钉住（总账 R78 / R79）。
 *
 * 为什么要有这个文件：
 * v53 把全站颜色和字号收进了一套 CSS 变量，但规则只写在文档里 —— 文档不会拦人。
 * 结果就是 v54 开工时发现 `js/app.js` 里还藏着 4 个渐变写死的色值、9 处内联 font-size、
 * 2 处内联 `background:#FFFFFF`：改配色的人看 CSS 找不到它们，改完页面就半新半旧。
 * 这类问题肉眼几乎发现不了（都是同一批颜色，只是硬编码了一遍），只有机器扫才可靠。
 *
 * 查三件事：
 *  1) `font-size` 只许用 `var(--text-*)`，不许写裸 px（`:root` 里定义 token 的地方除外）；
 *  2) 颜色只许用 `var(--*)`；`:root` 之外只放行纯白 `#fff`（白字/白底没有语义色名）；
 *  3) `js/*.js` 里一处 hex 颜色都不许有（SVG 渐变已经在 :root 里定义了变量）。
 *
 * 豁免要写在那一行上：`style-guard:allow 原因`。
 * 显式豁免比放宽规则好 —— 审查时能一眼看到「哪些是刻意留的」，而不是规则整体形同虚设。
 *
 * 用法：node tools/style-guard.mjs
 * 退出码：有违规 → 1（接入 `npm run check`，所以违规会直接拦下发布）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];

/** 在某一行的注释里写了豁免就跳过 */
const allowed = (line) => /style-guard:allow/.test(line);

/**
 * 整份文件豁免。
 *
 * 只有一类东西能进这里：**自带调色板的资产**。
 * 图标插画里的叶子、花瓣、花盆是画出来的东西，不是界面语义色 ——
 * 如果让它们跟着 --brand 走，换主题时徽章会一起变色，那才是错。
 * 界面结构里的颜色一律不许豁免。
 */
const ALLOW_FILES = new Map([
  ['js/icons.js', '图标插画自带的调色板（叶子、花瓣、花盆），不跟界面主题走'],
]);

/**
 * 单行豁免：写清楚「为什么这一行不能改成变量」。
 * 匹配用正则，避免行号漂移 —— 行号一改，豁免就失效，比不豁免更坑。
 */
const ALLOW_LINES = new Map([
  ['index.html', [
    { match: /name="theme-color"/, why: 'meta 标签不能写 CSS 变量；它与 --bg 的一致性由 live-audit 守' },
    { match: /id="verBar"/, why: '这条更新提示要在 CSS 加载前就能显示，样式只能内联' },
  ]],
]);

function lineExempt(file, line) {
  const list = ALLOW_LINES.get(rel(file)) || [];
  return list.some((r) => r.match.test(line));
}

function rel(file) {
  return path.relative(root, file);
}

/* ── 一、CSS：字号与颜色 ───────────────────────────── */

/** 找出 `:root { ... }` 的行号范围，token 定义本身当然要写裸值 */
function rootBlockRange(lines) {
  const start = lines.findIndex((l) => /^\s*:root\s*\{/.test(l));
  if (start === -1) return null;
  for (let i = start; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) return [start, i];
  }
  return [start, lines.length - 1];
}

function checkCss(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rootRange = rootBlockRange(lines);
  const inRoot = (i) => rootRange && i >= rootRange[0] && i <= rootRange[1];

  for (const [i, line] of lines.entries()) {
    if (allowed(line)) continue;

    // 1) font-size 裸像素
    if (/font-size:\s*[0-9.]+px/.test(line) && !inRoot(i)) {
      problems.push({
        file: rel(file), line: i + 1,
        what: 'font-size 写了裸 px',
        fix: '换成 var(--text-*)；要新档位先在 :root 加 token',
        text: line.trim(),
      });
    }

    // 2) 颜色：根块外只放行纯白
    const hexes = line.match(/#[0-9A-Fa-f]{3,8}\b/g) || [];
    const nonWhite = hexes.filter((h) => !/^#(fff|ffffff)$/i.test(h));
    if (nonWhite.length && !inRoot(i)) {
      problems.push({
        file: rel(file), line: i + 1,
        what: `硬编码颜色 ${nonWhite.join(' ')}`,
        fix: '换成 var(--brand) / var(--danger) 这类变量；新颜色先加进 :root',
        text: line.trim(),
      });
    }
  }
}

/* ── 二、JS 与 HTML：内联样式里的字号和颜色 ─────────── */

function checkScript(file) {
  const name = rel(file);
  if (ALLOW_FILES.has(name)) {
    console.log(`· 跳过 ${name}：${ALLOW_FILES.get(name)}`);
    return;
  }
  const isHtml = name.endsWith('.html');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let inHtmlComment = false;

  for (const [i, line] of lines.entries()) {
    // HTML 注释里的历史色值不算违规（那是说明文字，不是生效的样式）
    if (isHtml) {
      if (/<!--/.test(line) && !/-->/.test(line)) inHtmlComment = true;
      const wasComment = inHtmlComment;
      if (/-->/.test(line)) inHtmlComment = false;
      if (wasComment || /<!--/.test(line)) continue;
    }
    if (allowed(line) || lineExempt(file, line)) continue;

    if (/font-size:\s*[0-9.]+px/.test(line)) {
      problems.push({
        file: rel(file), line: i + 1,
        what: '内联 style 里写了 font-size 裸 px',
        fix: '抽成 CSS 类，或写 font-size:var(--text-*)',
        text: line.trim().slice(0, 120),
      });
    }

    // 排掉注释行：说明历史色值的注释不该算违规
    const code = line.replace(/\/\/.*$/, '');
    const hexes = code.match(/#[0-9A-Fa-f]{6}\b/g) || [];
    if (hexes.length) {
      problems.push({
        file: rel(file), line: i + 1,
        what: `JS 里硬编码颜色 ${hexes.join(' ')}`,
        fix: '颜色只放在 css/style.css 的 :root 里，JS 用 var(--*) 引用',
        text: code.trim().slice(0, 120),
      });
    }
  }
}

/* ── 三、自带样式的孤立页面（update.html）─────────────
 *
 * 这一页是「手机卡在旧版」时的救命页，不能依赖 css/style.css 加载成功，所以样式必须内联。
 * 但内联不等于可以乱写：**每个色值都必须取自 :root，每个字号都必须落在 --text-* 的档位上**。
 * 这条规则是 v54 补的 —— 换配色时 update.html 被漏掉了，主界面是青苔绿、自救页还是旧玫瑰粉，
 * 用户真遇到「卡在旧版」时看到的是一个和平时完全不同的应用。
 */
/** #fff 和 #FFFFFF 是同一个颜色，比较前统一展开成 6 位大写 */
function normalizeHex(hex) {
  const h = hex.toUpperCase();
  if (h.length === 4) return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  return h;
}

function rootTokens() {
  const cssPath = path.join(root, 'css/style.css');
  const src = fs.readFileSync(cssPath, 'utf8');
  const start = src.indexOf(':root');
  const end = src.indexOf('\n}', start);
  const block = src.slice(start, end === -1 ? undefined : end);
  return {
    colors: new Set((block.match(/#[0-9A-Fa-f]{3,8}\b/g) || []).map(normalizeHex)),
    sizes: new Set(((block.match(/--text-[a-z]+:\s*(\d+)px/g) || [])
      .map((s) => (s.match(/(\d+)px/) || [])[1]))),
  };
}

function checkStandalonePage(file, { colors, sizes }) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let inCssComment = false;
  for (const [i, line] of lines.entries()) {
    if (/\/\*/.test(line) && !/\*\//.test(line)) { inCssComment = true; continue; }
    if (inCssComment) { if (/\*\//.test(line)) inCssComment = false; continue; }
    if (/<!--/.test(line)) continue;

    for (const hex of line.match(/#[0-9A-Fa-f]{3,8}\b/g) || []) {
      if (!colors.has(normalizeHex(hex))) {
        problems.push({
          file: rel(file), line: i + 1,
          what: `色值 ${hex} 不在 :root 里`,
          fix: '这一页只能内联样式，但值必须取自 :root；改配色时这里一起改，别让它变成另一套皮肤',
          text: line.trim().slice(0, 120),
        });
      }
    }
    const fsMatch = line.match(/font-size:\s*([0-9.]+)px/g) || [];
    for (const m of fsMatch) {
      const n = (m.match(/([0-9.]+)px/) || [])[1];
      if (!sizes.has(n)) {
        problems.push({
          file: rel(file), line: i + 1,
          what: `字号 ${n}px 不在 --text-* 的档位里`,
          fix: '从 11 / 12 / 13 / 14 / 15 / 17 / 18 / 21 / 44 里选一个',
          text: line.trim().slice(0, 120),
        });
      }
    }
  }
}

/* ── 四、跑起来 ────────────────────────────────────── */

const cssFiles = [path.join(root, 'css/style.css')];
const scriptFiles = fs.readdirSync(path.join(root, 'js'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join(root, 'js', f));

for (const f of cssFiles) {
  if (!fs.existsSync(f)) {
    problems.push({ file: rel(f), line: 0, what: '找不到样式文件', fix: '确认 css/style.css 还在', text: '' });
    continue;
  }
  checkCss(f);
}
for (const f of scriptFiles) checkScript(f);

// index.html：首页内联脚本里有更新提示条的样式（CSS 还没加载就要能显示），按行豁免
const indexPath = path.join(root, 'index.html');
if (fs.existsSync(indexPath)) checkScript(indexPath);

// 救命页：内联样式，但值必须与 :root 同源
const updatePath = path.join(root, 'update.html');
if (fs.existsSync(updatePath)) checkStandalonePage(updatePath, rootTokens());

/* ── 输出 ──────────────────────────────────────────── */

if (!problems.length) {
  console.log('✅ 样式守卫通过：字号全走 --text-*，颜色全走变量，JS 里没有硬编码色值');
  process.exit(0);
}

console.log(`❌ 样式守卫发现 ${problems.length} 处硬编码：\n`);
for (const p of problems) {
  console.log(`${p.file}${p.line ? `:${p.line}` : ''}`);
  console.log(`   ${p.what}`);
  console.log(`   → ${p.fix}`);
  if (p.text) console.log(`   那行：${p.text}`);
  console.log('');
}
console.log('如果这处是刻意的（例如 CSS 还没加载就要显示的提示条），在该行加注释：style-guard:allow 原因');
process.exit(1);
