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
import { parseDescription, normalizeAiItems, selfTestParser, GOLDEN_CASES, sumItems, cachedOnlyMatch } from '../js/mealparse.js';

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

test('上游请求带上了密钥和模型，提示词要求「给营养估算 + 本地会校验」', async () => {
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
  // v34：AI 不再只当查表员 —— 本地没有的菜要它直接估营养，数字由本地校验（见 js/label.js）
  assert.ok(system.includes('protein') && system.includes('kcal'), '提示词必须要求模型给出营养估算');
  assert.ok(system.includes('本地'), '要告诉模型数字会被本地核对，别乱给');
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

test('AI 给的条目：说「生鸡胸肉」时按生重算（默认是熟重）', () => {
  const out = normalizeAiItems({ meal: 'lunch', items: [{ name: '生鸡胸肉', grams: 100 }] }, null, { text: '中午吃了100克生鸡胸肉' });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].foodId, 'chicken_breast', '带「生」要落到生重那条');
  assert.equal(out.items[0].kcal, 118, '100 克生鸡胸 × 118/100');
});

test('AI 给的条目：按名字在本地库里匹配，热量用本地数据算', () => {
  // 这是修过一个严重 bug 之后的行为：
  // 以前要求 AI 提供 matchedFoodId 或 kcal，但提示词禁止 AI 输出热量、也从没让它给 id
  // —— 结果**每一条都被丢掉**，AI 模式实际上从来没工作过。
  // 现在：AI 只给名字和克数，本地按名字匹配。
  const out = normalizeAiItems({
    meal: 'lunch',
    items: [
      { name: '鸡胸肉', grams: 150 },
      { name: '米饭', grams: 200 },
      { name: '牛肉面', grams: 600 },
    ],
    questions: ['面多大一碗？'],
  });
  assert.equal(out.items.length, 3, `三条都该记上，实际只记上 ${out.items.length} 条`);
  // v30 起「鸡胸肉」默认按**熟重**算（普通人称/估的都是做熟后的重量）；
  // 说「生鸡胸肉」才会落到生重那条（见下面那条测试）。
  assert.equal(out.items[0].foodId, 'chicken_breast_cooked');
  assert.equal(out.items[0].kcal, 236, '150 克熟鸡胸 × 157/100');
  assert.equal(out.items[1].foodId, 'rice_cooked');
  assert.equal(out.items[2].foodId, 'beef_noodle', '牛肉面要用库里那条组合菜');
  for (const it of out.items) {
    assert.equal(it.source, 'ai');
    assert.equal(it.needsConfirm, false, '匹配上的不需要用户再确认');
  }
});

test('AI 认出但本地库里没有的：按同类均值记上、并标明是估算（v31 起不再一条都不记）', () => {
  // 用户反馈：「AI 说没看懂/库里没有，一条都记不上」——记不上比记不准更伤积极性。
  // 现在的做法：本地写死的同类均值先顶上，界面写明「按同类估算」、可以删。
  const out = normalizeAiItems({
    items: [
      { name: '米饭', grams: 200 },
      { name: '某网红限定轻食碗', grams: 300 },
      { name: '另一个没听过的菜', grams: 150 },
    ],
    questions: ['酱放了吗？'],
  });
  assert.equal(out.items.length, 3, '三条都要能记上');
  assert.deepEqual(out.unmatched, ['某网红限定轻食碗', '另一个没听过的菜'], '仍要告诉用户哪些是兜底估的');
  assert.equal(out.unmatchedItems.length, 2);
  assert.deepEqual(out.unmatchedItems[1].name, '另一个没听过的菜', '要带上名字，界面上要告诉用户');
  const est = out.items.filter((i) => i.source === 'estimate');
  assert.equal(est.length, 2);
  for (const it of est) {
    assert.equal(it.estimated, true);
    assert.ok(it.note.includes('食物库里没有'), `要写明是估的：${it.note}`);
    assert.ok(it.estimateId.startsWith('generic_'), '数字必须来自本地同类均值表');
    assert.equal(it.foodId, null);
  }
  // 老格式（只有 name + grams）没有营养可校验：继续按本地同类均值兜底，不许凭空出现「AI 估的」
  // v34：这条断言不再是空转 —— 新格式确实会产生 source === 'ai-estimate'（见下面那条测试）
  assert.equal(out.items.some((i) => i.source === 'ai-estimate'), false);
  assert.equal(est[0].kcal, 450, '300 克 × 家常菜均值 150/100');
});

test('一条都没认出来时不问问题（问了也答不上来）', () => {
  // 用户实际看到的：三个粉色追问气泡 + 「这一餐合计约 0 kcal」+ 还能点「记上」
  const out = normalizeAiItems({ items: [], questions: ['碗有多大？', '肉丸多大？'] });
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.questions, [], '没有条目时追问没有意义');
});

test('AI 的追问只在有条目时才带出来', () => {
  const withItems = normalizeAiItems({ items: [{ name: '米饭', grams: 200 }], questions: ['一碗还是一小碗？'] });
  assert.deepEqual(withItems.questions, ['一碗还是一小碗？']);
});

test('AI 说的名字和库里名字不同时，要说明按哪个算的', () => {
  const out = normalizeAiItems({ items: [{ name: '炒河粉', grams: 200 }] });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].foodId, 'fried_rice_noodle');
  assert.ok(out.items[0].note.includes('炒河粉（干炒）'), `要告诉用户按哪条算：${out.items[0].note}`);
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

test('离线解析：一句话里的多个份量不会被串到一起（issue #3）', () => {
  // 真出过的 bug：「半包」被奶茶抢走，薯片按默认 50 克记（误差 100%）。
  // 以前的断言写成「薯片 <= 60 克」——默认值刚好 50，于是这条测试一直在假绿。
  // 现在钉死克数，并且正反两种语序都要对。
  const cases = [
    '下午喝了杯奶茶，还有半包薯片',
    '半包薯片和一杯奶茶',
    '一杯奶茶和半包薯片',
    '喝了奶茶，还有半包薯片',        // 口语里常常不说「一杯」
    '奶茶和半包薯片',
  ];
  for (const text of cases) {
    const r = parseDescription(text);
    const milkTea = r.items.find((i) => i.name.includes('奶茶'));
    const chips = r.items.find((i) => i.name.includes('薯片'));
    assert.ok(milkTea && chips, `${text}：两样都要解析出来`);
    assert.equal(chips.grams, 25, `${text}：「半包」应当归薯片（25 克），实际 ${chips.grams} 克`);
    assert.ok(milkTea.grams >= 400 && milkTea.grams <= 500,
      `${text}：奶茶该按中杯 500 克算，实际 ${milkTea.grams} 克`);
  }
});

test('基准用例「半包薯片」这条必须收紧容差（±25% 会把真 bug 盖住）', () => {
  const c = GOLDEN_CASES.find((x) => x.text.includes('半包薯片'));
  assert.ok(c, '基准用例里必须有这条：用户日常真会这么说');
  assert.ok((c.tol ?? 0.25) <= 0.1, `这条的容差要收紧到 10% 以内，现在 ${c.tol}`);
  const got = sumItems(parseDescription(c.text).items).kcal;
  const diff = Math.abs(got - c.kcal) / c.kcal;
  assert.ok(diff <= c.tol, `解析出 ${got} kcal，应在 ${c.kcal} ±${Math.round(c.tol * 100)}% 之内`);
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

test('v31 整条链路：AI 返回组合菜 + 库里没有的菜，本地都要能记上（不能空手而归）', async () => {
  const upstream = fakeFetch({
    json: {
      choices: [{
        message: {
          content: JSON.stringify({
            meal: 'dinner',
            // 故意用「foods」而不是「items」，名字故意用口语 —— 模拟模型不按约定来
            foods: [
              { food: '黄焖鸡米饭', amount: '约 550 克' },
              { dish: '外婆家秘制扣肉', grams: 180 },
              { name: '某网红限定轻食碗', portion: '一大碗' },
            ],
            questions: ['扣肉咸不咸？'],
          }),
        },
      }],
    },
  });
  const aiRaw = await callUpstream({ text: '晚上吃了黄焖鸡米饭、外婆家秘制扣肉和某网红限定轻食碗', hour: 19, config: CONFIG, fetchImpl: upstream });
  assert.equal(aiRaw.items.length, 3, '三种写法都要被收敛进来');

  const out = normalizeAiItems(aiRaw, 'dinner', { text: '晚上吃了黄焖鸡米饭、外婆家秘制扣肉和某网红限定轻食碗' });
  assert.equal(out.items.length, 3, '三条都要能记上');
  assert.equal(out.items[0].foodId, 'huangmenji');
  assert.equal(out.items[0].grams, 550);
  const est = out.items.filter((i) => i.source === 'estimate');
  assert.equal(est.length, 2, '库里没有的两样要按同类均值兜底');
  assert.deepEqual(out.estimated.length, 2);
  // 兜底数字来自本地同类均值表，不是模型编的
  assert.ok(est.every((i) => i.estimateId.startsWith('generic_')));
});

test('v34：提示词要求给营养估算（本地没有的菜也要估），不再禁止模型给数字', () => {
  const p = buildSystemPrompt();
  // 旧的「绝对不要输出热量」红线在 v34 被推翻了：AI 现在要估营养，否则又变成查表员。
  assert.ok(!p.includes('绝对不要输出热量'), '旧红线要删掉，否则模型不会给估算');
  assert.ok(p.includes('必须照样估营养'), '本地没有的菜要模型估，不能只给名字');
  assert.ok(p.includes('kcal') && p.includes('protein') && p.includes('fat') && p.includes('carb'));
  assert.ok(p.includes('4') && p.includes('9'), '要告诉模型 4/9/4 对账关系（否则热量和营养素对不上）');
  assert.ok(p.includes('照用户的叫法写名字'), '库里没有的菜要照实说名字，别换成别的食物');
});


/*
 * v34：AI 归位 —— 本地没有的菜，AI 直接给营养估算（本地校验），
 * 记上后存成「我的食物」，下次同名优先命中本机。这几条守的就是「AI 不再只是查表员」。
 */

test('v34：本地库命中优先，AI 估的营养不覆盖本地固定数字', () => {
  const out = normalizeAiItems({
    items: [
      // 故意给一个和本地不一致的营养估算：本地命中时必须以本地为准
      { name: '米饭', grams: 200, nutrition: { kcal: 999, protein: 1, fat: 1, carb: 1 } },
    ],
  });
  assert.equal(out.items[0].source, 'ai', '本地命中还是本地算，不标成 AI 估的');
  assert.equal(out.items[0].foodId, 'rice_cooked');
  assert.ok(out.items[0].kcal < 400, `要用本地米饭数字，实际 ${out.items[0].kcal}`);
  assert.deepEqual(out.aiEstimated, []);
});

test('v34：库里没有的菜，用 AI 估的营养记上（并标出是 AI 估的）', () => {
  const out = normalizeAiItems({
    items: [{ name: '我妈做的梅菜扣肉', grams: 150, nutrition: { kcal: 450, protein: 20, fat: 38, carb: 6 } }],
  });
  assert.equal(out.items.length, 1, '必须记上，不许丢');
  const it = out.items[0];
  assert.equal(it.source, 'ai-estimate');
  assert.equal(it.estimated, true);
  assert.equal(it.foodId, null);
  assert.equal(it.kcal, 450, '这一份 150 克的总热量');
  assert.equal(it.protein, 20);
  // 每 100 克要存下来：保存时用它落成「我的食物」
  assert.equal(it.per100.kcal, 300, '450 / 150 × 100');
  assert.equal(it.per100.fat, 25.3, '38 / 150 × 100（保留 1 位）');
  assert.deepEqual(out.aiEstimated, ['我妈做的梅菜扣肉']);
  assert.deepEqual(out.estimated, [], '不该再走同类均值兜底');
  assert.ok(it.note.includes('AI 估的'), `要说清来源：${it.note}`);
});

test('v34：AI 的营养数字过不了本地校验时，退回同类均值（并说清为什么）', () => {
  const out = normalizeAiItems({
    items: [
      // 每 100 克 2500 kcal：离谱
      { name: '宇宙能量块', grams: 100, nutrition: { kcal: 2500, protein: 10, fat: 10, carb: 10 } },
      // 热量和营养素差太远（500 kcal 但 4/9/4 只有 145 kcal）
      { name: '矛盾菜', grams: 100, nutrition: { kcal: 500, protein: 5, fat: 5, carb: 5 } },
    ],
  });
  assert.equal(out.items.length, 2, '校验不过也要记上（走同类均值），不能让用户白说');
  for (const it of out.items) {
    assert.equal(it.source, 'estimate');
    assert.ok(it.estimateId.startsWith('generic_'));
    assert.ok(it.note.includes('本地校验'), `要说明 AI 的数字没通过本地校验：${it.note}`);
  }
  assert.deepEqual(out.aiEstimated, []);
});

test('v34：AI 热量和营养素差 30%~50% 时，热量按 4/9/4 重算并标注', () => {
  // 4/9/4 = 10*4 + 5*9 + 25*4 = 185 kcal，AI 说 250（差 26%…这里取更明显的一组）
  const out = normalizeAiItems({
    items: [{ name: '某家自制便当', grams: 100, nutrition: { kcal: 300, protein: 10, fat: 5, carb: 25 } }],
  });
  const it = out.items[0];
  assert.equal(it.source, 'ai-estimate');
  assert.equal(it.kcal, 185, '热量按营养素重算');
  assert.ok(it.warning && it.warning.includes('重算'), `要提示重算过：${it.warning}`);
});

test('v34：「我的食物」优先匹配，并说明是按自己存的算的', () => {
  const customFoods = [{ id: 'c1', name: '某网红限定轻食碗', kcal: 120, protein: 8, fat: 3, carb: 15, servings: [['一份', 100]] }];
  const out = normalizeAiItems(
    { items: [{ name: '某网红限定轻食碗', grams: 200, nutrition: { kcal: 900, protein: 1, fat: 1, carb: 1 } }] },
    null,
    { customFoods },
  );
  const it = out.items[0];
  assert.equal(it.matchedCustom, true);
  assert.equal(it.foodId, 'c1');
  assert.equal(it.kcal, 240, '用自己存的 120 kcal/100g × 200 克');
  assert.ok((it.note || '').includes('你之前存的'), `要说明是按自己存的算的：${it.note}`);
});


test('v34：只用「我的食物」就能说清的句子，识别为「不用再问 AI」', () => {
  const customFoods = [{
    id: 'c1', name: '某网红限定轻食碗', source: 'ai-estimate',
    kcal: 140, protein: 7.3, fat: 4, carb: 17.3, servings: [['一份', 300]],
  }];
  assert.equal(cachedOnlyMatch('下午又吃了某网红限定轻食碗200克', customFoods)?.food?.name, '某网红限定轻食碗');
  assert.equal(cachedOnlyMatch('昨天中午吃了某网红限定轻食碗', customFoods)?.food?.name, '某网红限定轻食碗');
  // 保守：只要还有别的食物/没认出来的词，就必须照常调 AI（宁可多一次请求，也不能悄悄漏记）
  assert.equal(cachedOnlyMatch('吃了某网红限定轻食碗和一个苹果', customFoods), null, '「和一个苹果」不能被省掉');
  assert.equal(cachedOnlyMatch('吃了某网红限定轻食碗和同事点的外卖', customFoods), null);
  // 一句话里两样自己存的食物：份量归属说不清，交给 AI
  const two = [...customFoods, { id: 'c2', name: '某牌蛋白棒', kcal: 380, protein: 30, fat: 12, carb: 35 }];
  assert.equal(cachedOnlyMatch('吃了某网红限定轻食碗和某牌蛋白棒', two), null);
  assert.equal(cachedOnlyMatch('随便吃了点', customFoods), null, '没有食物名就正常走 AI');
  assert.equal(cachedOnlyMatch('吃了某网红限定轻食碗', []), null, '没有「我的食物」不省请求');
});
