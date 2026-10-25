/**
 * 包装营养成分表：单位换算、对账、AI 读数收敛
 *
 * 背景（真实需求）：包装上写的是「能量 349 千焦」，以前只能填 kcal，
 * 等于让用户自己除 4.184；抄错单位还看不出来。这里的测试守三件事：
 *  1) 千焦 → 千卡换算必须对；
 *  2) 「蛋白×4+脂肪×9+碳水×4」对不上时要提醒，不能默默记下；
 *  3) 拍照读表只允许「读数字」，模型返回垃圾/越界值时一律当作没读到。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KJ_PER_KCAL,
  normalizeUnit,
  energyToKcal,
  macroKcal,
  labelToPer100,
  checkConsistency,
  photoRetakeHint,
  validateNutritionEstimate,
} from '../js/label.js';
import { buildLabelPrompt, normalizeLabelResult, requestLabelParse } from '../js/ai-core.js';

/* 用户拍的那张包装的真实数字（2026-10-20）：能量 349 千焦、蛋白 13.7、脂肪 0.7、碳水 5.3，每 100 克 */
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

test('照包装填：用户的那张表算出来每 100 克 83.4 kcal', () => {
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
  // 单位没选时也要用户选，而不是默认当成 kcal
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

test('AI 读表提示词：只许读、不许换算、看不清留空、不许读串行', () => {
  const p = buildLabelPrompt();
  assert.ok(p.includes('不要换算'), '必须明确禁止换算');
  assert.ok(p.includes('不要猜'), '看不清时不许猜');
  assert.ok(p.includes('kJ'), '要让模型按原始单位返回千焦');
  // 这两条是拿真模型跑糊照片跑出来的：整行错位（蛋白质读到能量那行的 NRV%）是最危险的错，
  // 它不会留空、会自信地填错数字。措辞被删掉就等于把这个坑埋回去。
  assert.ok(p.includes('同一行'), '必须要求数字和项目名在同一行');
  assert.ok(p.includes('4/9/4'), '必须让它输出前自查一遍（读串行时热量对不上）');
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
      assert.ok(/qwen-vl|glm-4v|gpt-4o/.test(err.message), '要告诉用户换成哪种模型');
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

test('正文是空的、但模型写了「思考过程」：要说清是模型在做深度思考，别说成断网', async () => {
  // 真事（2026-10-21 用真密钥测）：显式指定 deepseek-flash，它先把答案写进 reasoning_content，
  // max_tokens 不够时 content 是空串 —— 界面上原本显示「没读出来：服务商没有返回内容」，像网断了。
  const truncated = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '让我先看看这张图……' } }] }),
  });
  await assert.rejects(
    () => requestLabelParse({ imageDataUrl: 'data:image/jpeg;base64,AAAA', config: { baseUrl: 'https://x', model: 'deepseek-flash', apiKey: 'k' }, fetchImpl: truncated }),
    (err) => {
      assert.ok(/思考/.test(err.message), err.message);
      assert.ok(/deepseek-chat/.test(err.message), '要说出换哪个模型才不会踩同一个坑');
      assert.ok(!/没有返回内容/.test(err.message), '不能让人以为是断网');
      return true;
    },
  );

  // 完全空（既没正文也没思考）才是真的「没返回内容」，别把这句话弄丢了
  const silent = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' } }] }) });
  await assert.rejects(
    () => requestLabelParse({ imageDataUrl: 'data:image/jpeg;base64,AAAA', config: { baseUrl: 'https://x', model: 'm', apiKey: 'k' }, fetchImpl: silent }),
    /没有返回内容/,
  );
});

test('照片读出来对不上时，劝用户重拍；手动填的、或只差一点点，不多嘴', () => {
  // 真事：糊照片里模型把「蛋白质」读成能量那行的 NRV%（13），把脂肪读成 9.2 ——
  // 标称 1078 kJ = 258 kcal，按读到的算却是 323 kcal，差 25%。这种就该让用户重拍。
  const shifted = checkConsistency(labelToPer100({ baseGrams: 100, energyValue: 1078, energyUnit: 'kJ', protein: 13, fat: 9.2, carb: 46.5 }).per100);
  assert.ok(shifted.diffPct > 20, `这条用例要求真的对不上，实际差 ${shifted.diffPct}%`);
  const hint = photoRetakeHint(shifted);
  assert.ok(hint.includes('重拍'), '要明说重拍');
  assert.ok(hint.includes('拍满'), '要告诉用户怎么拍（拍满画面）');
  assert.ok(hint.includes('别直接保存'), '要拦住用户直接保存');

  // 读对了的那张不该出现这句话（否则每次拍照都吓用户一下）
  const right = checkConsistency(labelToPer100(HER_LABEL).per100);
  assert.equal(photoRetakeHint(right), '', '对得上时不要多嘴');
  // 差 20% 以内是包装自己的问题（糖醇/膳食纤维），也不劝重拍
  assert.equal(photoRetakeHint({ stated: 300, diffPct: 18 }), '');
  // 没填热量时没法对账，更不该说话
  assert.equal(photoRetakeHint(checkConsistency({ kcal: null, protein: 10, fat: 5, carb: 20 })), '');
  assert.equal(photoRetakeHint(null), '');
});


/*
 * v34：AI 估的营养必须过本地校验。
 * 这是「AI  bisa 估」和「AI 爱怎么编就怎么编」之间的那道门。
 */

test('v34：AI 营养估算 —— 正常的放过，每 100 克换算正确', () => {
  const r = validateNutritionEstimate({ grams: 150, nutrition: { kcal: 450, protein: 20, fat: 38, carb: 6 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.per100, { kcal: 300, protein: 13.3, fat: 25.3, carb: 4 });
  assert.equal(r.recalced, false);
  assert.ok(r.diffPct <= 30);
});

test('v34：AI 营养估算 —— 数字离谱/不全/自相矛盾要挡下来', () => {
  assert.equal(validateNutritionEstimate({ grams: 0, nutrition: { kcal: 100, protein: 1, fat: 1, carb: 1 } }).ok, false, '份量必须大于 0');
  assert.equal(validateNutritionEstimate({ grams: 100, nutrition: null }).ok, false, '没有营养数字');
  assert.equal(validateNutritionEstimate({ grams: 100, nutrition: { kcal: 100 } }).ok, false, '字段不全');
  // 每 100 克 2500 kcal：不可能
  assert.equal(validateNutritionEstimate({ grams: 100, nutrition: { kcal: 2500, protein: 10, fat: 10, carb: 10 } }).ok, false);
  // 每 100 克蛋白 150 克：不可能
  assert.equal(validateNutritionEstimate({ grams: 100, nutrition: { kcal: 700, protein: 150, fat: 10, carb: 10 } }).ok, false);
  // 只有热量、三大营养素全 0：合计会被带偏
  assert.equal(validateNutritionEstimate({ grams: 100, nutrition: { kcal: 300, protein: 0, fat: 0, carb: 0 } }).ok, false);
  // 热量和 4/9/4 差超过 50%：自相矛盾
  const bad = validateNutritionEstimate({ grams: 100, nutrition: { kcal: 500, protein: 5, fat: 5, carb: 5 } });
  assert.equal(bad.ok, false);
  assert.ok(bad.reason.includes('对不上'), `要说清原因：${bad.reason}`);
});

test('v34：AI 营养估算 —— 差 30%~50% 时热量按 4/9/4 重算，并标记重算过', () => {
  // 4/9/4 = 10*4 + 5*9 + 25*4 = 185；AI 说 300（差 38%）
  const r = validateNutritionEstimate({ grams: 100, nutrition: { kcal: 300, protein: 10, fat: 5, carb: 25 } });
  assert.equal(r.ok, true);
  assert.equal(r.recalced, true);
  assert.equal(r.per100.kcal, 185);
  assert.ok(r.diffPct > 30);
});
