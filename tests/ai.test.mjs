/**
 * AI 转发层测试
 *
 * 用假的「上游 AI」验证：
 *  - 密钥只从环境变量/密钥文件读，不会出现在返回给手机的内容里；
 *  - 上游返回乱七八糟的内容时会被收敛成固定形状；
 *  - 上游报错（401 密钥错、402 没钱、429 太频繁）会翻译成人话。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readApiKey, aiConfig, aiConfigStatus, buildSystemPrompt, callUpstream, normalizeResult } from '../tools/ai-proxy.mjs';
import { parseDescription, normalizeAiItems, selfTestParser, GOLDEN_CASES } from '../js/mealparse.js';

const CONFIG = { baseUrl: 'https://example.invalid', model: 'test-model', key: 'sk-fake-for-test' /* secret-scan:allow 假密钥 */ };

function fakeFetch(response, capture = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.body = JSON.parse(init.body);
    capture.headers = init.headers;
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.json,
      text: async () => response.text ?? '',
    };
  };
}

test('上游请求带上了密钥和模型，且提示词里明确禁止模型自己编热量', async () => {
  const capture = {};
  const result = await callUpstream({
    text: '食堂吃了碗牛肉面',
    hour: 12,
    config: CONFIG,
    fetchImpl: fakeFetch({ json: { choices: [{ message: { content: '{"meal":"lunch","items":[{"name":"牛肉面","grams":600}],"questions":[]}' } }] } }, capture),
  });
  assert.equal(capture.url, 'https://example.invalid/chat/completions');
  assert.equal(capture.headers.Authorization, 'Bearer sk-fake-for-test');
  assert.equal(capture.body.model, 'test-model');
  const system = capture.body.messages[0].content;
  assert.ok(system.includes('不要输出热量'), '提示词必须禁止模型自己编热量');
  assert.ok(capture.body.messages[1].content.includes('食堂吃了碗牛肉面'));
  assert.equal(result.items[0].name, '牛肉面');
  assert.equal(result.items[0].grams, 600);
});

test('上游返回 markdown 包裹的 JSON 也能解析', async () => {
  const result = await callUpstream({
    text: 'x',
    config: CONFIG,
    fetchImpl: fakeFetch({ json: { choices: [{ message: { content: '```json\n{"items":[{"name":"米饭","grams":200}]}\n```' } }] } }),
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].grams, 200);
});

test('上游报错会翻译成人话（401/402/429）', async () => {
  const cases = [[401, '密钥不对'], [402, '余额不足'], [429, '太频繁']];
  for (const [status, hint] of cases) {
    await assert.rejects(
      () => callUpstream({ text: 'x', config: CONFIG, fetchImpl: fakeFetch({ ok: false, status, text: 'upstream error' }) }),
      (err) => err.message.includes(hint),
      `${status} 没有给出「${hint}」的提示`,
    );
  }
});

test('上游没返回内容时报错，而不是返回空结果让用户以为没吃', async () => {
  await assert.rejects(
    () => callUpstream({ text: 'x', config: CONFIG, fetchImpl: fakeFetch({ json: { choices: [] } }) }),
    /没有返回内容/,
  );
});

test('收敛上游结果：脏数据被丢掉，形状固定', () => {
  const out = normalizeResult({
    meal: 'brunch', // 非法餐次
    items: [
      { name: '牛肉面', grams: 600 },
      { name: '', grams: 200 },
      { name: '份量离谱', grams: 99999 },
      { name: '负数', grams: -5 },
      { name: '字符串份量', grams: '很多' },
      { name: '  空格  ', grams: 100 },
    ],
    questions: ['多大一碗？', '', 42, 'q2', 'q3'],
  });
  assert.equal(out.meal, null, '非法餐次应当被丢弃');
  assert.deepEqual(out.items.map((i) => i.name), ['牛肉面', '空格']);
  assert.deepEqual(out.questions, ['多大一碗？', 'q2'], '追问最多留 2 个');
});

test('AI 给的条目：本地库有的用本地热量，本地库没有的标成「需要确认」', () => {
  const out = normalizeAiItems({
    meal: 'lunch',
    items: [
      { name: '鸡胸肉', grams: 150, matchedFoodId: 'chicken_breast' },
      { name: '某网红轻食碗', grams: 300, kcal: 420, protein: 25, fat: 12, carb: 50 },
    ],
    questions: ['轻食碗的酱放了吗？'],
  });
  assert.equal(out.items.length, 2);
  const chicken = out.items[0];
  assert.equal(chicken.foodId, 'chicken_breast');
  assert.equal(chicken.kcal, 177, '本地库有的话，热量要用本地数据算（150 克 × 118/100）');
  assert.equal(chicken.needsConfirm, false);

  const unknown = out.items[1];
  assert.equal(unknown.source, 'ai-estimate');
  assert.equal(unknown.needsConfirm, true, '本地库没有的必须让她确认');
  assert.ok(unknown.question.includes('估算'));
  assert.deepEqual(out.unmatched, ['某网红轻食碗']);
});

test('AI 返回空条目时不会伪造数据', () => {
  const out = normalizeAiItems({ items: [] });
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.unmatched, []);
});

test('密钥读取：环境变量优先，其次是密钥文件；都没有就返回 null', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fatloss-key-'));
  const file = path.join(tmp, 'data', 'ai-key.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'sk-from-file\n多余的行会被忽略\n');
  assert.equal(readApiKey(tmp).key, 'sk-from-file');
  assert.equal(readApiKey(tmp).from, file);

  const old = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-from-env';
  assert.equal(readApiKey(tmp).key, 'sk-from-env', '环境变量优先级更高');
  if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fatloss-nokey-'));
  const saved = { ...process.env };
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.AI_API_KEY;
  const r = readApiKey(empty);
  // 用户机器上可能真的配了 ~/.dsh/fatloss-ai-key，所以这里只断言「不会崩、形状对」
  assert.ok(r === null || typeof r.key === 'string');
  Object.assign(process.env, saved);
});

test('给手机看的状态里绝不包含密钥（aiConfig 内部含密钥，但不下发）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fatloss-cfg-'));
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'data', 'ai-key.txt'), 'sk-secret-should-not-leak' /* secret-scan:allow 假密钥 */);
  const cfg = aiConfig(tmp);
  assert.equal(cfg.configured, true);
  assert.ok(cfg.from.endsWith('ai-key.txt'));

  // 真正会发给手机的只有这个状态对象，它必须是掩码
  const status = aiConfigStatus(tmp);
  const json = JSON.stringify(status);
  assert.ok(!json.includes('sk-secret-should-not-leak' /* secret-scan:allow 假密钥 */), '状态接口里泄露了密钥');
  assert.equal(status.configured, true);
});

test('提示词要求模型只输出 JSON、且明确份量参考值', () => {
  const p = buildSystemPrompt();
  assert.ok(p.includes('只输出 JSON'));
  assert.ok(p.includes('一小碗米饭 130 克'));
  assert.ok(p.includes('breakfast'));
});

test('离线解析的基准用例全部合格（AI 不通时的兜底不能退化）', () => {
  const failed = selfTestParser();
  assert.deepEqual(failed, [], failed.join('\n'));
  assert.ok(GOLDEN_CASES.length >= 6, '基准用例太少，覆盖不住常见说法');
});

test('离线解析：一句话里的多个份量不会被串到一起', () => {
  // 这是之前真出过的 bug：一杯奶茶的 325 克被套到了半包薯片上
  const r = parseDescription('下午喝了杯奶茶，还有半包薯片');
  const milkTea = r.items.find((i) => i.name.includes('奶茶'));
  const chips = r.items.find((i) => i.name.includes('薯片'));
  assert.ok(milkTea && chips, '两样都要解析出来');
  assert.ok(chips.grams <= 60, `薯片被算成 ${chips.grams} 克，明显是套了奶茶的份量`);
  assert.ok(milkTea.grams <= 500, `奶茶 ${milkTea.grams} 克偏多`);
});

test('离线解析：「两个鸡蛋」不能被后面的「一个苹果」抢走份量', () => {
  const r = parseDescription('中午吃了两个鸡蛋和一个苹果');
  const egg = r.items.find((i) => i.name.includes('鸡蛋'));
  const apple = r.items.find((i) => i.name.includes('苹果'));
  assert.equal(egg.grams, 100, `两个鸡蛋应当是 100 克，实际 ${egg.grams}`);
  assert.equal(apple.grams, 200, `一个苹果应当是 200 克，实际 ${apple.grams}`);
});

test('离线解析：「一碗面」不会被「食堂」这类泛称抢走', () => {
  const r = parseDescription('今天中午在食堂吃了碗牛肉面');
  assert.equal(r.items.length, 1);
  assert.ok(r.items[0].name.includes('牛肉面'), `解析成了 ${r.items[0].name}`);
});

test('离线解析：完全看不懂的内容不伪造条目，而是回报原文', () => {
  const r = parseDescription('今天心情不好随便吃了点');
  assert.equal(r.items.length, 0);
  assert.ok(r.unknown.length > 0, '应当把没认出来的原文回报给界面');
});
