/**
 * 更新机制的纯判断测试（v38）。
 *
 * 这条链路出过真事故：手机卡在旧版本、截图里是早已修掉的老行为。
 * 所以这里把「什么算更新」「什么时候能安全重载」钉死。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { hasNewerVersion, canRefreshNow, updateBannerText } from '../js/update.js';

test('v38：线上版本更高才算更新；相等/更旧/乱写都不触发', () => {
  assert.equal(hasNewerVersion('v38', 'v39'), true);
  assert.equal(hasNewerVersion('v38', 'v38'), false);
  assert.equal(hasNewerVersion('v39', 'v38'), false);
  assert.equal(hasNewerVersion('v38', ''), false, '拿不到线上版本时不折腾');
  assert.equal(hasNewerVersion('', 'v39'), false);
  assert.equal(hasNewerVersion('v38', 'latest'), false, '不是 v数字 的一律当不知道');
  assert.equal(hasNewerVersion('v38', 'v100'), true, '版本号按数字比，不是按字面量');
});

test('v38：正在填东西时不自动重载；空闲时才可以', () => {
  assert.equal(canRefreshNow({}), true);
  assert.equal(canRefreshNow({ sheetOpen: true }), false, '弹层开着不重载');
  assert.equal(canRefreshNow({ hasDraft: true }), false, '草稿没保存不重载');
  assert.equal(canRefreshNow({ typing: true }), false, '输入框里有字不重载');
});

test('v38：横幅文案要说清版本、点哪里、记录不会丢', () => {
  const text = updateBannerText('v39');
  assert.ok(text.includes('v39'));
  assert.ok(text.includes('点这里'));
  assert.ok(text.includes('记录'));
  assert.ok(!/应该|必须|失败/.test(text));
});
