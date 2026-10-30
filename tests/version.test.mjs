/**
 * 版本与更新提示的护栏（v28）。
 *
 * 要守住四件事：
 *  1) `js/version.js` 的版本号和 `sw.js` 的 CACHE / APP_VERSION 必须一致（两边写成两个数最容易漂）；
 *  2) 发版必须同时写更新说明：CHANGELOG 最上面那条的 version 必须等于当前版本；
 *  3) 「更新了什么」的挑选逻辑要认得出「没记录过 / 记录的是老版本 / 已经是最新」三种情况；
 *  4) 界面文案里不许再出现第三人称「\u5979」—— 使用者是自己用的，应用里只能叫「你」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, CHANGELOG } from '../js/version.js';
import { versionNumber, isNewerVersion, updatesAfter, pendingUpdates } from '../js/whatsnew.js';
import { listNames } from './_files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swSource = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

test('版本号只有一个来源：version.js 和 sw.js 必须一致', () => {
  assert.match(APP_VERSION, /^v\d+$/, `版本号格式不对：${APP_VERSION}`);
  const swVersion = (swSource.match(/const APP_VERSION = '([^']+)'/) || [])[1];
  assert.equal(swVersion, APP_VERSION, 'sw.js 的 APP_VERSION 和 js/version.js 不一致（手机上看版本会对不上）');
  const cache = (swSource.match(/const CACHE = '([^']+)'/) || [])[1];
  assert.equal(cache, `fatloss-${APP_VERSION}`, 'sw.js 的 CACHE 名要跟版本号一起升');
  // 新增的 js 文件必须进离线缓存清单（CI 里也有一条同样的检查，这里提前在单测里抓）
  for (const f of ['js/version.js', 'js/whatsnew.js']) {
    assert.ok(swSource.includes(`'./${f}'`), `${f} 没进 sw.js 的 ASSETS，断网会打不开`);
  }
});

test('index.html 内联的版本自查不能漏改（漏了就永远不提示更新）', () => {
  /*
   * v45 真事故：打开网页是旧版、没有任何更新提示，手动刷新才好。
   * 根因是版本检查放在 app.js 里，而线上 sw.js 带 cache-control: max-age=600 + CDN 缓存，
   * cache:'no-store' 绕不过 CDN → 读回旧版本号 → 判定「已是最新」。
   * 现在 index.html 里内联了一段「页面一解析就查版本」的脚本，版本号硬编码在 HERE 里；
   * 它必须等于 APP_VERSION，否则提示要么永远不出现，要么每次打开都误报。
   */
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const here = (html.match(/var HERE = '(v\d+)'/) || [])[1];
  assert.ok(here, 'index.html 里找不到版本自查用的 `var HERE`');
  assert.equal(here, APP_VERSION, '改版本号时漏改了 index.html 的 HERE（更新提示会失效）');
  // 请求必须带时间戳：不带的话 CDN 会把旧 sw.js 直接还回来，版本号读不到新的
  assert.match(html, /fetch\('sw\.js\?ts=' \+ Date\.now\(\)/, 'index.html 的版本自查必须给 sw.js 带时间戳（绕 CDN 缓存）');
});

test('更新说明：每条都完整，且最上面那条必须就是当前版本', () => {
  assert.ok(Array.isArray(CHANGELOG) && CHANGELOG.length >= 2, '更新说明至少要能回看到上一版');
  const versions = CHANGELOG.map((e) => e.version);
  assert.equal(new Set(versions).size, versions.length, '同一个版本不能写两条');
  // 版本号必须从新到旧排列，不然「上次看到 v27 → 之后有哪些」会算错
  for (let i = 1; i < CHANGELOG.length; i++) {
    assert.ok(versionNumber(versions[i - 1]) > versionNumber(versions[i]), `版本顺序不对：${versions.join(' / ')}`);
  }
  assert.equal(versions[0], APP_VERSION, '发了新版却没在 CHANGELOG 最前面写更新说明（使用者看不到改了什么）');

  for (const e of CHANGELOG) {
    assert.match(e.version, /^v\d+$/, `版本号格式不对：${e.version}`);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, `${e.version} 的日期要写 YYYY-MM-DD`);
    assert.ok(Array.isArray(e.items) && e.items.length >= 1 && e.items.length <= 4,
      `${e.version} 的条目要 1~4 条（弹窗太长没人看）`);
    for (const item of e.items) {
      assert.equal(typeof item, 'string');
      assert.ok(item.trim().length >= 8, `${e.version} 有一条太短了：${item}`);
      assert.ok(!/[`<>]/.test(item), `${e.version} 的条目里不要写 HTML 标签（会被转义显示成一堆符号）`);
    }
  }
});

test('「上次看到哪个版本」→ 该给用户看哪几条更新', () => {
  // 不写死版本号：以后每发一版都会在 CHANGELOG 前面加一条，写死的话这个测试每周都要改。
  const latest = CHANGELOG[0].version;
  const prev = CHANGELOG[1].version;
  const oldest = CHANGELOG[CHANGELOG.length - 1].version;

  assert.deepEqual(updatesAfter(prev).map((e) => e.version), [latest], '上一版升上来只看最新一版的说明');
  assert.deepEqual(updatesAfter(latest), [], '已经是最新：不弹');
  // 没记录过（老用户第一次用上带更新说明的版本）：只看最新一版，不翻旧账
  assert.deepEqual(updatesAfter('').map((e) => e.version), [latest]);
  // 认不出的历史值：也给最新一版，宁可少给不要给错
  assert.deepEqual(updatesAfter('v1').map((e) => e.version), [latest]);
  // 跨多个版本：要把「上次之后」的都补上（从新到旧；上次之前的不翻旧账）
  assert.deepEqual(updatesAfter(oldest).map((e) => e.version), CHANGELOG.slice(0, -1).map((e) => e.version));
  // 存档结构里的字段名
  assert.deepEqual(pendingUpdates({ settings: { lastSeenVersion: prev } }).map((e) => e.version), [latest]);
  assert.deepEqual(pendingUpdates({}).map((e) => e.version), [latest], '没有 settings 时按「没记录过」处理');
  assert.deepEqual(pendingUpdates({ settings: { lastSeenVersion: latest } }), []);
});

test('判断「服务端版本是不是比手机上跑的新」', () => {
  assert.equal(versionNumber('v28'), 28);
  assert.equal(versionNumber('28'), 28);
  assert.ok(Number.isNaN(versionNumber('latest')));
  assert.equal(isNewerVersion('v29', 'v28'), true);
  assert.equal(isNewerVersion('v28', 'v28'), false);
  assert.equal(isNewerVersion('v27', 'v28'), false);
  assert.equal(isNewerVersion('', 'v28'), false, '读不到版本时宁可漏提醒，也不能吓人');
  assert.equal(isNewerVersion('v29', 'v28-beta'), false, '认不出的版本号一律不提醒');
});

test('界面文案里不许再出现第三人称「\u5979」—— 使用者是自己用的', () => {
  // 真踩过：产品原则写的是「对使用者说『你』」，但代码注释、文档、甚至给 AI 的提示词里
  // 还留着一堆「\u5979」，AI 会学过去用第三人称回答。这个测试扫全仓库的文本文件，出现就红。
  const BAD = '\u5979';
  const dirs = ['js', 'tests', 'tools', 'docs', 'css'];
  const files = [];
  for (const d of dirs) {
    const dir = path.join(root, d);
    // 沙箱（反向验证的临时副本）里可能只复制了一部分目录：没有就跳过，
    // 否则 readdirSync 直接抛错，会让「所有变异都被抓到」—— 又一个假绿灯。
    if (!fs.existsSync(dir)) continue;
    for (const f of listNames(dir)) {
      if (/\.(js|mjs|md|css)$/.test(f)) files.push(path.join(dir, f));
    }
  }
  files.push(path.join(root, 'index.html'), path.join(root, 'README.md'), path.join(root, 'HANDOFF.md'), path.join(root, 'sw.js'));
  const ghDir = path.join(root, '.github', 'workflows');
  if (fs.existsSync(ghDir)) {
    for (const f of fs.readdirSync(ghDir)) if (/\.ya?ml$/.test(f)) files.push(path.join(ghDir, f));
  }
  const hits = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.includes(BAD)) hits.push(`${path.relative(root, file)}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(hits, [], `这些地方还在用第三人称「\u5979」，请改成「你」或「使用者」：\n${hits.join('\n')}`);
});

test('发布脚本必须把根目录的页面都带上（update.html 漏发过一次）', () => {
  // 真事故：v38 新加了「手机卡在旧版时的自救页」update.html，代码推上去了，
  // Pages 也显示「发布成功」，但用户打开那个网址是 404 ——
  // 因为 .github/workflows/pages.yml 里是写死的文件名清单，没人想到去补。
  // 线上检查 tools/check-live.mjs 只比对「清单里的文件」，清单外的文件它根本不会问。
  const pagesPath = path.join(root, '.github', 'workflows', 'pages.yml');
  assert.ok(fs.existsSync(pagesPath), '发布脚本不见了：.github/workflows/pages.yml');
  const pages = fs.readFileSync(pagesPath, 'utf8');
  // 找 `cp -r … _site/` 那一行（忽略注释行）
  const copyLine = pages.split('\n').find((l) => /^\s*cp\s+-r\s/.test(l) && l.includes('_site'));
  assert.ok(copyLine, '发布脚本里找不到打包命令（cp -r … _site/）');

  const pagesInRoot = listNames(root).filter((f) => f.endsWith('.html')).sort();
  assert.ok(pagesInRoot.includes('index.html') && pagesInRoot.includes('update.html'),
    `根目录的页面不对：${pagesInRoot.join('、')}`);
  // 两种写法都算过：显式列出每个 html，或者用通配符把根目录 html 全打进去。
  // 通配符优先 —— 以后再加页面不用回来改发布脚本。
  const wildcard = /\/\*\.html/.test(copyLine);
  const missing = wildcard ? [] : pagesInRoot.filter((f) => !copyLine.includes(f));
  assert.deepEqual(missing, [], `发布会漏掉这些页面（用户打开是 404）：${missing.join('、')}。改成 ./*.html 或补进发布脚本。`);

  // 应用本体那几样也不能少
  for (const f of ['sw.js', 'manifest.webmanifest', 'css', 'js', 'icons']) {
    assert.ok(copyLine.includes(f), `发布脚本漏了 ${f}`);
  }
});
