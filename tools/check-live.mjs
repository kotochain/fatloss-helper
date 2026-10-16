/**
 * 线上部署一致性检查（可选工具，需要联网）。
 *
 * 为什么需要：用户手机上的问题，有一半是「线上文件互相不匹配」造成的 ——
 * 比如 index.html 是新版、js/app.js 还是旧版，或者 Service Worker 把旧缓存还给她。
 * 本地测试永远测不到这种情况，因为它测的是本机文件。
 *
 * 用法：node tools/check-live.mjs [网址]
 */
const BASE = process.argv[2] || 'https://kotochain.github.io/fatloss-helper';

const need = ['index.html', 'js/app.js', 'sw.js', 'css/style.css', 'manifest.webmanifest', 'js/schema.js', 'js/insights.js'];
let bad = 0;

console.log(`检查 ${BASE}\n`);

// 1) 每个文件都要能拿到，而且不能是 404 页
const contents = {};
for (const f of need) {
  try {
    const res = await fetch(`${BASE}/${f}`, { cache: 'no-store' });
    const text = await res.text();
    contents[f] = text;
    const looksLike404 = /<html/i.test(text) && f !== 'index.html' && !text.includes('<!doctype');
    const ok = res.ok && !looksLike404;
    console.log(`${ok ? '✅' : '❌'} ${f}  HTTP ${res.status}  ${text.length} 字节`);
    if (!ok) bad += 1;
  } catch (err) {
    console.log(`❌ ${f}  取不到：${err.message}`);
    bad += 1;
  }
}

// 2) 版本一致性：sw.js 里的 CACHE 要能同时被 index.html 引用的文件找到
const swVersion = (contents['sw.js'] || '').match(/APP_VERSION = '([^']+)'/) || [];
const cacheName = (contents['sw.js'] || '').match(/CACHE = '([^']+)'/) || [];
console.log(`\n部署版本：${swVersion[1] || '未知'}｜缓存名：${cacheName[1] || '未知'}`);

// 3) 关键功能在线上代码里真的存在（防止推送漏文件或部署了半截）
const mustHave = [
  ['index.html', 'bootFail', '启动失败的兜底界面'],
  ['js/app.js', 'renderCrash', '渲染错误边界'],
  ['js/app.js', 'let startupNotice = null;\n\nlet state = load();', 'TDZ 修复（startupNotice 在 load 之前）'],
  ['js/app.js', 'data-act="recover"', '找回记录入口'],
  ['js/app.js', 'openWipeSheet', '从头开始'],
  ['sw.js', 'stale-while-revalidate', '缓存策略（不能退回缓存优先）'],
];
console.log('\n关键改动是否已部署：');
for (const [file, needle, what] of mustHave) {
  const has = (contents[file] || '').includes(needle);
  if (!has) bad += 1;
  console.log(`${has ? '✅' : '❌'} ${what}`);
}

// 4) Service Worker 不能退回「缓存优先」（那是用户卡死在旧版的原因）
const sw = contents['sw.js'] || '';
if (/caches\.match\(request\)\.then\(\(hit\) => hit \|\| fetch/.test(sw)) {
  bad += 1;
  console.log('❌ sw.js 又变回缓存优先了 —— 这会让用户永远拿不到新版本');
}

console.log(bad ? `\n❌ 有 ${bad} 项不对，别让用户先用` : '\n✅ 线上部署一致，可以让她用');
process.exit(bad ? 1 : 0);
