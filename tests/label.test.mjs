/**
 * 包装营养成分表：单位换算、对账、AI 读数收敛
 *
 * 背景（真实需求）：包装上写的是「能量 349 千焦」，以前只能填 kcal，
 * 等于让她自己除 4.184；抄错单位还看不出来。这里的测试守三件事：
 *  1) 千焦 → 千卡换算必须对；
 *  2) 「蛋白×4+脂肪×9+碳水×4」对不上时要提醒，不能默默记下；
 *  3) 拍照读表只允许「读数字」，模型返回垃圾/越界值时一律当作没读到。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KJ_PER_KCAL, normalizeUnit, energyToKcal, macroKcal, labelToPer100, checkConsistency,
} from '../js/label.js';
import { buildLabelPrompt, normalizeLabelResult, requestLabelParse } from '../js/ai-core.js';

/* 她拍的那张包装的真实数字（2026-10-20）：能量 349 千焦、蛋白 13.7、脂肪 0.7、碳水 5.3，每 100 克 */
const HER_LABEL = { baseGrams: 100, energyValue: 349, energyUnit: 'kJ', protein: 13.7, fat: 0.7, carb: 5.3 };

test('千焦换算成千卡：349 千焦 ≈ 83.4 kcal', () => {
  assert.equal(Math.round(KJ_PER_KCAL * 1000) / 1000, 4.184);
  const kcal = energyToKcal(349, 'kJ');
  assert.ok(Math.abs(kcal - 83.41) < 0.05, `349 kJ 应约 83.4 kcal，实际 ${kcal}`);
  assert.equal(energyToKcal(100, 'kcal'), 100);
  assert.equal(energyToKcal(100, '千卡'), 100);
  assert.equal(energyToKcal(349, 'KJ'), 349 / 4.184, '大写单位也要认');
});

test('单位认不出 / 数字不合理时返回 null，不猜', () => {
  assert.equal(energyToKcal(349, '卡'), null);
  assert.equal(energyToKcal(349, ''), null);
  assert.equal(energyToKcal(-5, 'kcal'), null);
  assert.equal(energyToKcal('abc', 'kcal'), null);
  assert.equal(normalizeUnit('千焦耳'), 'kJ');
  assert.equal(normalizeUnit('大卡'), 'kcal');
});

test('照包装填：她的那张表算出来每 100 克 83.4 kcal', () => {
  const r = labelToPer100(HER_LABEL);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.per100.kcal, 83.4);
  assert.equal(r.per100.protein, 13.7);
  assert.equal(r.per100.fat, 0.7);
  assert.equal(r.per100.carb, 5.3);
  assert.equal(r.kcalFromMacros, false);
});

test('标签按「每份」标时，先换成每 100 克再记', () => {
  // 一份 30 克含 100 kcal → 每 100 克应是 333.3 kcal
  const r = labelToPer100({ ...HER_LABEL, baseGrams: 30, energyValue: 100, energyUnit: 'kcal' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.per100.kcal, 333.3);
  assert.equal(r.per100.protein, 45.7, '13.7 g / 30 g × 100');
});

test('没印能量时按 4/9/4 算，并标记是算出来的', () => {
  const r = labelToPer100({ ...HER_LABEL, energyValue: null });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.kcalFromMacros, true);
  assert.equal(r.per100.kcal, 82.3, '13.7×4 + 0.7×9 + 5.3×4 = 82.3');
});

test('把千焦当千卡抄进来时会拦下来（这是最常见的错）', () => {
  // 349 千焦被误当成 349 kcal 填 —— 每 100 克热量会高到 349
  const r = labelToPer100({ ...HER_LABEL, energyUnit: 'kcal' });
  assert.equal(r.ok, true);
  const c = checkConsistency(r.per100);
  assert.equal(c.level, 'warn');
  assert.ok(c.message.includes('对不上'), c.message);
  // 单位没选时也要她选，而不是默认当成 kcal
  const bad = labelToPer100({ ...HER_LABEL, energyUnit: '卡路里😀' });
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('单位'), bad.error);
});

test('离谱数字要拒绝：每份 0 克、热量超过 900、营养素超过 100 克', () => {
  assert.equal(labelToPer100({ ...HER_LABEL, baseGrams: 0 }).ok, false);
  assert.equal(labelToPer100({ ...HER_LABEL, baseGrams: -20 }).ok, false);
  assert.equal(labelToPer100({ ...HER_LABEL, energyValue: 5000, energyUnit: 'kcal' }).ok, false);
  assert.equal(labelToPer100({ ...HER_LABEL, protein: 150 }).ok, false);
});

test('对账：正常、小偏差、明显对不上三种情况', () => {
  const ok = checkConsistency({ kcal: 83.4, protein: 13.7, fat: 0.7, carb: 5.3 });
  assert.equal(ok.level, 'ok');
  const warn = checkConsistency({ kcal: 300, protein: 13.7, fat: 0.7, carb: 5.3 });
  assert.equal(warn.level, 'warn');
  assert.ok(warn.message.includes('对不上'), warn.message);
  const info = checkConsistency({ kcal: null, protein: 10, fat: 5, carb: 20 });
  assert.equal(info.level, 'info');
  assert.equal(info.computed, 165, '10×4 + 5×9 + 20×4 = 165');
});

test('AI 读表提示词：只许读、不许算、看不清留空', () => {
  const p = buildLabelPrompt();
  assert.ok(p.includes('不要换算'), '必须明确禁止换算');
  assert.ok(p.includes('不要猜'), '看不清时不许猜');
  assert.ok(p.includes('kJ'), '要让模型按原始单位返回千焦');
  assert.ok(!p.includes('蛋白×4'), '读表的提示词不该出现算热量的规则');
});

test('AI 读表结果收敛：字符串数字要转成数字，越界当没读到', () => {
  const r = normalizeLabelResult({
    name: '  低脂鸡胸肉  ', baseGrams: '100',
    energy: { value: '349', unit: 'KJ' },
    protein: '13.7', fat: 0.7, carb: 5.3,
  });
  assert.equal(r.name, '低脂鸡胸肉');
  assert.equal(r.baseGrams, 100);
  assert.deepEqual(r.energy, { value: 349, unit: 'kJ' });
  assert.equal(r.protein, 13.7);

  const junk = normalizeLabelResult({ name: null, baseGrams: 0, energy: { value: 999999, unit: 'x' }, protein: 500, fat: -1, carb: '?' });
  assert.equal(junk.name, '');
  assert.equal(junk.baseGrams, null);
  assert.equal(junk.energy, null, '超范围的能量当没读到');
  assert.equal(junk.protein, null);
  assert.equal(junk.fat, null);
  assert.equal(junk.carb, null);
});

test('发请求：图片用标准 image_url 结构，能被各家兼容接口接受', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"name":"低脂鸡胸肉","baseGrams":100,"energy":{"value":349,"unit":"kJ"},"protein":13.7,"fat":0.7,"carb":5.3}' } }] }),
    };
  };
  const r = await requestLabelParse({
    imageDataUrl: 'data:image/jpeg;base64,AAAA',
    config: { baseUrl: 'https://api.example.com/v1', model: 'qwen-vl-plus', apiKey: 'sk-test' },
    fetchImpl,
  });
  assert.equal(r.energy.value, 349);
  assert.equal(r.protein, 13.7);
  assert.ok(captured.url.endsWith('/chat/completions'));
  const userMsg = captured.body.messages[1];
  assert.ok(Array.isArray(userMsg.content), '图片必须放在 content 数组里');
  const img = userMsg.content.find((p) => p.type === 'image_url');
  assert.ok(img && img.image_url.url.startsWith('data:image/jpeg'), '图片要以 data URL 传');
});

test('模型不支持看图时，报错要说人话（不能直接把原始报错扔给用户）', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 400,
    text: async () => '{"error":{"message":"This model does not support image input"}}',
  });
  await assert.rejects(
    () => requestLabelParse({ imageDataUrl: 'data:image/jpeg;base64,AAAA', config: { baseUrl: 'https://x', model: 'm', apiKey: 'k' }, fetchImpl }),
    (err) => {
      assert.ok(/看不了图片/.test(err.message), err.message);
      assert.ok(/qwen-vl|glm-4v|gpt-4o/.test(err.message), '要告诉她换成哪种模型');
      return true;
    },
  );
});

test('模型返回「没有找到营养成分表」时，报错要清楚', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: '{"error":"没有找到营养成分表"}' } }] }),
  });
  await assert.rejects(
    () => requestLabelParse({ imageDataUrl: 'data:image/png;base64,AAAA', config: { baseUrl: 'https://x', model: 'm', apiKey: 'k' }, fetchImpl }),
    /没有找到营养成分表/,
  );
});
