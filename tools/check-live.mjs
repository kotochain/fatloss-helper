/**
 * 线上部署一致性检查（需要联网）
 *
 * 为什么需要：用户手机上的问题，有一半是「线上文件互相不匹配」造成的 ——
 * 比如 index.html 是新版、js/app.js 还是旧版，或者 Service Worker 把旧缓存还给用户。
 * 本地测试永远测不到这种情况，因为它测的是本机文件。
 *
 * 这一版升级过：以前只检查 7 个文件 + 几个字符串，等于「文件传上去了」；
 * 现在**逐个文件逐字节比对**，等于「传上去的和本地要发出去的一模一样」。
 * 注意它仍然只证明「文件对」，不证明「跑起来对」——跑起来由 tools/live-audit.mjs 负责。
 *
 * 用法：node tools/check-live.mjs [网址]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.argv[2] || 'https://kotochain.github.io/fatloss-helper').replace(/\/$/, '');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;

console.log(`检查 ${BASE}\n`);

/** 会被部署、并且运行时会用到的文件（README / 测试 / 工具都不算） */
function runtimeFiles() {
  const out = ['index.html', 'sw.js', 'manifest.webmanifest'];
  // 根目录的其它 html 也算运行时文件（update.html 就漏发过一次：代码在仓库里、
  // 发布脚本没带上，线上打开是 404，而这份检查只问清单里的文件，所以当时没发现）。
  for (const f of fs.readdirSync(root)) {
    if (f.endsWith('.html') && !out.includes(f)) out.push(f);
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  for (const dir of ['js', 'css', 'icons']) walk(dir);
  return out.sort();
}

const files = runtimeFiles();
let mismatched = 0;
for (const f of files) {
  try {
    const res = await fetch(`${BASE}/${f}`, { cache: 'no-store' });
    const remote = Buffer.from(await res.arrayBuffer());
    const local = fs.readFileSync(path.join(root, f));
    const same = local.equals(remote);
    if (!same) {
      mismatched += 1;
      bad += 1;
      console.log(`❌ ${f}  线上与本地不一致（本地 ${local.length} 字节／线上 ${remote.length} 字节，HTTP ${res.status}）`);
    }
  } catch (err) {
    bad += 1;
    console.log(`❌ ${f}  取不到：${err.message}`);
  }
}
console.log(mismatched
  ? `\n❌ ${mismatched} 个文件线上与本地不一致`
  : `✅ ${files.length} 个运行时文件线上与本地逐字节一致`);

/** 版本：线上真的部署完了没有 */
const localSw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const liveSwRes = await fetch(`${BASE}/sw.js`, { cache: 'no-store' });
const liveSw = await liveSwRes.text();
const versionOf = (text) => (text.match(/APP_VERSION = '([^']+)'/) || [])[1];
const cacheOf = (text) => (text.match(/CACHE = '([^']+)'/) || [])[1];
const localVersion = versionOf(localSw);
const liveVersion = versionOf(liveSw);
console.log(`\n本地版本：${localVersion || '未知'}｜线上版本：${liveVersion || '未知'}｜线上缓存名：${cacheOf(liveSw) || '未知'}`);
if (!liveVersion) { bad += 1; console.log('❌ 线上 sw.js 里读不到版本号'); }
else if (liveVersion !== localVersion) {
  bad += 1;
  console.log(`❌ 线上还没部署到 ${localVersion}（现在线上是 ${liveVersion}）—— 要么等部署，要么这次的改动没推上去`);
}

/** 关键功能在线上代码里真的存在（防止推送漏文件或部署了半截） */
const need = {};
for (const f of ['index.html', 'update.html', 'js/app.js', 'sw.js', 'css/style.css', 'js/schema.js', 'js/insights.js', 'manifest.webmanifest']) {
  try {
    const res = await fetch(`${BASE}/${f}`, { cache: 'no-store' });
    need[f] = await res.text();
  } catch { need[f] = ''; }
}
const mustHave = [
  ['index.html', 'id="bootFail"', '启动失败的兜底界面（元素本身，不只是引用）'],
  // 手机卡在旧版时唯一的自救入口。它必须真的在线上，否则用户照着说明打开只会看到 404。
  ['update.html', 'fatloss.updatedTo', '自救更新页（清完旧缓存再带回应用）'],
  ['update.html', "location.replace('./?fresh=", '自救更新页会跳回应用并带上 fresh 标记'],
  ['js/app.js', 'renderCrash', '渲染错误边界'],
  ['js/app.js', 'data-act="recover"', '找回记录入口'],
  ['js/app.js', 'openWipeSheet', '从头开始'],
  ['js/app.js', 'exportUnreadable', '读不出来的存档能导出'],
  ['js/schema.js', 'keepUnreadable', '读不出来的存档先留一份'],
  ['sw.js', 'stale-while-revalidate', '缓存策略（不能退回缓存优先）'],
];
console.log('\n关键改动是否已部署：');
// TDZ 那个白屏事故：startupNotice 必须在 load() 之前声明。
// 不能靠整段字符串匹配 —— 中间插一行函数，匹配就失效了（这次就红了一次假失败）。
{
  const app = String(need['js/app.js'] || '');
  const decl = app.indexOf('let startupNotice = null;');
  const load = app.indexOf('let state = load();');
  const ok = decl >= 0 && load >= 0 && decl < load;
  if (!ok) bad += 1;
  console.log(`${ok ? '✅' : '❌'} 启动顺序（startupNotice 在 load 之前声明）`);
}
for (const [file, needle, what] of mustHave) {
  const has = String(need[file] || '').includes(needle);
  if (!has) bad += 1;
  console.log(`${has ? '✅' : '❌'} ${what}`);
}

/** Service Worker 不能退回「缓存优先」（那是用户卡死在旧版的原因） */
if (/caches\.match\(request\)\.then\(\(hit\) => hit \|\| fetch/.test(liveSw)) {
  bad += 1;
  console.log('❌ sw.js 又变回缓存优先了 —— 这会让用户永远拿不到新版本');
}

/** 装到桌面那一套：主题色和图标要和界面配色一致 */
const manifest = (() => { try { return JSON.parse(need['manifest.webmanifest'] || '{}'); } catch { return {}; } })();
const metaTheme = (need['index.html'] || '').match(/<meta name="theme-color" content="([^"]+)"/)?.[1];
if (!manifest.theme_color) { bad += 1; console.log('❌ manifest 里没有主题色'); }
else if (metaTheme && metaTheme !== manifest.theme_color) {
  bad += 1;
  console.log(`❌ 页面 theme-color(${metaTheme}) 和 manifest 主题色(${manifest.theme_color}) 不一致`);
} else console.log(`✅ 主题色一致：${manifest.theme_color}（背景 ${manifest.background_color}）`);
const iconFiles = (manifest.icons || []).map((ic) => ic.src);
const missingIcons = iconFiles.filter((f) => !fs.existsSync(path.join(root, f)));
if (missingIcons.length) { bad += 1; console.log('❌ manifest 里引用了不存在的图标：', missingIcons.join(', ')); }
else console.log(`✅ ${iconFiles.length} 个图标文件都在（${iconFiles.join('，')}）`);

console.log(bad ? `\n❌ 有 ${bad} 项不对，别让用户先用` : '\n✅ 线上部署一致，可以让用户用');
console.log('（这份检查只证明「传上去的文件对」；跑起来对不对，用 node tools/live-audit.mjs）');
process.exit(bad ? 1 : 0);
