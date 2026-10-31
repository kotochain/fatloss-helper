/**
 * 自检脚本不许往用户自己的「下载」文件夹里丢东西（2026-10-31 用户投诉）。
 *
 * 反例长什么样：跑完自检，用户在 `~/Downloads` 里看到「减脂记录-2026-10-30.json」。
 * 根因是用 CDP 的 `setDownloadBehavior` 在**页面级**连接上设下载目录 —— 命令被静默忽略，
 * Chrome 就用了系统默认下载目录。现在改成启动前把下载目录写进 profile 的 `Preferences`，
 * 浏览器一启动就生效，不依赖 CDP。这个文件守住这件事。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDownloadPrefs } from '../tools/chrome-launch.mjs';

test('无头浏览器的下载目录钉在临时资料夹里，不是用户的「下载」文件夹', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fatloss-prefs-'));
  const dir = writeDownloadPrefs(profile);

  const file = path.join(profile, 'Default', 'Preferences');
  assert.ok(fs.existsSync(file), '没有写出 Preferences，Chrome 会退回系统默认下载目录');

  const prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(prefs.download.default_directory, path.join(profile, 'downloads'));
  assert.notEqual(
    path.dirname(prefs.download.default_directory),
    path.join(os.homedir(), 'Downloads'),
    '下载目录绝不能是用户的「下载」文件夹',
  );
  assert.equal(prefs.download.prompt_for_download, false, '无头环境里没人点「保存到哪」，不能弹框');
  assert.ok(fs.existsSync(prefs.download.default_directory), '下载目录要真的建出来（Chrome 不会替你建）');
});

test('可以指定别的下载目录（导出检查要能读回自己下的文件）', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fatloss-prefs-'));
  const wanted = path.join(profile, 'audit', 'downloads');
  const got = writeDownloadPrefs(profile, wanted);
  assert.equal(got, wanted);
  const prefs = JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8'));
  assert.equal(prefs.download.default_directory, wanted);
  assert.ok(fs.existsSync(wanted));
});
