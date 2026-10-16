/**
 * AI 设置（服务商预设、配置存取、密钥不泄露）测试
 *
 * 三条硬要求：
 *  1) 用户只需要「选一家 + 贴密钥」，地址和模型名自动带出来；
 *  2) 任何回给手机的内容都不能包含完整密钥（只能有掩码）；
 *  3) 配置文件和密钥文件都不能落在项目目录里（否则可能被提交）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRESETS, findPreset, maskKey, normalizeAiConfigInput, publicAiConfig } from '../js/providers.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fatloss-ai-cfg-'));
process.env.FATLOSS_CONFIG_DIR = TMP; // 独立目录：不会写到用户真实的配置文件里

// 必须在设置环境变量之后再导入（模块读取环境变量决定配置路径）
const proxy = await import('../tools/ai-proxy.mjs');

test('预设覆盖常见国内服务商，且每个都填好了地址和模型', () => {
  const ids = PRESETS.map((p) => p.id);
  for (const must of ['deepseek', 'dashscope', 'moonshot', 'zhipu', 'openai', 'ollama', 'custom']) {
    assert.ok(ids.includes(must), `缺少预设 ${must}`);
  }
  assert.ok(PRESETS.some((p) => p.recommended), '应当标出推荐的那一家');
  for (const p of PRESETS) {
    assert.ok(p.name && p.note, `${p.id} 缺少名字或说明`);
    if (p.id === 'custom') continue; // 自定义本来就是空的
    assert.ok(/^https?:\/\//.test(p.baseUrl), `${p.id} 的接口地址不合法：${p.baseUrl}`);
    assert.ok(p.model, `${p.id} 没有默认模型`);
    assert.ok(p.keyUrl, `${p.id} 没给「去哪拿密钥」的链接`);
  }
});

test('选预设会自动带出地址和模型（用户不用手填）', () => {
  for (const p of PRESETS.filter((x) => x.id !== 'custom')) {
    const { config, problems } = normalizeAiConfigInput({ presetId: p.id, apiKey: 'sk-x-1234567890' /* secret-scan:allow 假密钥，仅用于测试 */ });
    assert.deepEqual(problems, [], `${p.id}：${problems.join('；')}`);
    assert.equal(config.baseUrl, p.baseUrl);
    assert.equal(config.model, p.model);
  }
});

test('本地模型允许空密钥，其它服务商不允许', () => {
  const local = normalizeAiConfigInput({ presetId: 'ollama', apiKey: '' });
  assert.deepEqual(local.problems, [], '本地模型不该强制要密钥');

  const remote = normalizeAiConfigInput({ presetId: 'deepseek', apiKey: '' });
  assert.ok(remote.problems.some((p) => p.includes('密钥')), '云端服务商必须要求密钥');
});

test('自定义地址：末尾斜杠会被去掉、非法协议会被挡住', () => {
  const ok = normalizeAiConfigInput({ presetId: 'custom', baseUrl: 'https://my-gateway.example.com/v1/', model: 'm', apiKey: 'k' });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.config.baseUrl, 'https://my-gateway.example.com/v1');

  const bad = normalizeAiConfigInput({ presetId: 'custom', baseUrl: 'ftp://x', model: 'm', apiKey: 'k' });
  assert.ok(bad.problems.some((p) => p.includes('http')));
});

test('自定义端口也能用（内网/自建服务）', () => {
  const r = normalizeAiConfigInput({ presetId: 'custom', baseUrl: 'http://192.168.1.9:8000/v1', model: 'local-llm', apiKey: 'k' });
  assert.deepEqual(r.problems, []);
  assert.equal(r.config.baseUrl, 'http://192.168.1.9:8000/v1');
});

test('留空密钥表示「不改」，而不是把已保存的密钥清掉', () => {
  const existing = { presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-existing-key-0001' /* secret-scan:allow 假密钥，仅用于测试 */ };
  const r = normalizeAiConfigInput({ presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }, existing);
  assert.deepEqual(r.problems, []);
  assert.equal(r.config.apiKey, 'sk-existing-key-0001' /* secret-scan:allow 假密钥，仅用于测试 */, '留空时应当保留原密钥');
});

test('掩码只露头尾，中间打星', () => {
  const m = maskKey('sk-1234567890abcdefghij' /* secret-scan:allow 假密钥，仅用于测试 */);
  assert.ok(m.startsWith('sk-12'), m);
  assert.ok(m.endsWith('ghij'), m);
  assert.ok(m.includes('*'), m);
  assert.ok(!m.includes('7890abc'), '掩码不能露出中间部分');
  assert.equal(maskKey(''), '');
  assert.ok(!maskKey('short').includes('hort'));
});

test('给手机看的配置永远不含完整密钥', () => {
  const cfg = { presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-super-secret-key-999' /* secret-scan:allow 假密钥，仅用于测试 */, updatedAt: '2026-10-16T00:00:00Z' };
  const pub = publicAiConfig(cfg);
  const json = JSON.stringify(pub);
  assert.ok(!json.includes('sk-super-secret-key-999' /* secret-scan:allow 假密钥，仅用于测试 */), '公开配置里泄露了密钥');
  assert.equal(pub.configured, true);
  assert.ok(pub.keyMasked.includes('*'));
  assert.equal(pub.presetName, 'DeepSeek（深度求索）');
});

test('配置能存能读，文件权限是 600，且不在项目目录里', () => {
  const root = process.cwd();
  const r = proxy.saveConfigFromInput({
    presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-round-trip-0001' /* secret-scan:allow 假密钥，仅用于测试 */,
  }, root);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.mode, '600', `文件权限是 ${r.mode}，应当是 600`);

  const file = proxy.configFile();
  assert.ok(!file.startsWith(root), `配置文件落在项目目录里了：${file}`);
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);

  const loaded = proxy.loadSavedConfig();
  assert.equal(loaded.apiKey, 'sk-round-trip-0001' /* secret-scan:allow 假密钥，仅用于测试 */);
  assert.equal(loaded.model, 'deepseek-chat');

  // 清掉，避免影响后面的用例
  assert.equal(proxy.clearSavedConfig(), true);
  assert.equal(proxy.loadSavedConfig(), null);
});

test('保存接口的返回值里没有密钥，只有掩码', () => {
  const r = proxy.saveConfigFromInput({
    presetId: 'custom', baseUrl: 'http://127.0.0.1:9999/v1', model: 'x', apiKey: 'sk-must-not-appear-1234' /* secret-scan:allow 假密钥，仅用于测试 */,
  }, process.cwd());
  assert.equal(r.ok, true);
  const status = proxy.aiConfigStatus(process.cwd());
  const json = JSON.stringify(status);
  assert.ok(!json.includes('sk-must-not-appear-1234' /* secret-scan:allow 假密钥，仅用于测试 */), '状态接口里泄露了密钥');
  assert.equal(status.configured, true);
  assert.equal(status.source, 'saved');
  assert.equal(status.saved.keyMasked.includes('*'), true);
  proxy.clearSavedConfig();
});

test('手机上保存的配置优先于命令行环境变量', () => {
  const oldKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'sk-from-env-0000' /* secret-scan:allow 假密钥，仅用于测试 */;
  proxy.saveConfigFromInput({ presetId: 'custom', baseUrl: 'http://127.0.0.1:9999/v1', model: 'phone-model', apiKey: 'sk-from-phone-0000' /* secret-scan:allow 假密钥，仅用于测试 */ }, process.cwd());
  const cfg = proxy.aiConfig(process.cwd());
  assert.equal(cfg.model, 'phone-model', '应当优先用手机上保存的配置');
  assert.equal(cfg.key, 'sk-from-phone-0000' /* secret-scan:allow 假密钥，仅用于测试 */);
  proxy.clearSavedConfig();
  const after = proxy.aiConfig(process.cwd());
  assert.equal(after.key, 'sk-from-env-0000' /* secret-scan:allow 假密钥，仅用于测试 */, '清除后应当回落到环境变量');
  if (oldKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = oldKey;
});

test('连通测试：成功/401/404/连不上，各自给中文原因', async () => {
  // 先存一份配置，保证测试不依赖这台机器上有没有环境变量密钥
  const saved = proxy.saveConfigFromInput({
    presetId: 'custom', baseUrl: 'https://example.invalid/v1', model: 'test-model', apiKey: 'sk-test-key-0000' /* secret-scan:allow 假密钥，仅用于测试 */,
  }, process.cwd());
  assert.equal(saved.ok, true);
  const ok = await proxy.testConnection({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '可以' } }] }) }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.reply, '可以');

  const cases = [
    [401, '密钥不对'],
    [402, '余额不足'],
    [404, '模型名'],
    [429, '太频繁'],
  ];
  for (const [status, hint] of cases) {
    const r = await proxy.testConnection({
      fetchImpl: async () => ({ ok: false, status, text: async () => 'err', json: async () => ({}) }),
    });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes(hint), `${status} 的提示是「${r.error}」，应当包含「${hint}」`);
  }

  const down = await proxy.testConnection({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(down.ok, false);
  assert.ok(down.error.includes('连不上'), down.error);
  proxy.clearSavedConfig();
});

test('没配密钥时连通测试直接说「还没填密钥」，不发请求', async () => {
  proxy.clearSavedConfig();
  const saved = { ...process.env };
  delete process.env.AI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  let called = false;
  const r = await proxy.testConnection({ fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; } });
  // 用户机器上可能真的配了 ~/.dsh/fatloss-ai-key，所以两种结果都要能解释
  if (!r.ok) assert.ok(r.error.includes('密钥'), r.error);
  assert.equal(called, !!r.ok);
  Object.assign(process.env, saved);
});
