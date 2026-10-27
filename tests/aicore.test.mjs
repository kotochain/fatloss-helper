/**
 * 新增模块测试：AI 核心、本机配置、模型列表排序、日历统计
 *
 * 重点保三件事：
 *  1) 模型列表要能把「该用的模型」排前面（用户原话：默认的都过时了）；
 *  2) 配置存在手机本机，换设备/清空后不会留下脏数据；
 *  3) 给用户看的报错是中文人话，不是浏览器的原始异常。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt, normalizeResult, extractJson, humanizeHttpError,
  humanizeNetworkError, requestParse, requestPing, requestModels, coerceGrams,
} from '../js/ai-core.js';
import { readAiConfig, writeAiConfig, clearAiConfig, AI_CONFIG_KEY } from '../js/ai-config.js';
import { modelsUrl, parseModelsResponse, normalizeAiConfigInput, publicAiConfig, PRESETS } from '../js/providers.js';

/** 假的 localStorage，用来隔离测试 */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
  };
}

/* ── 模型列表 ─────────────────────────────── */

test('模型列表地址拼接：末尾斜杠不会拼出双斜杠', () => {
  assert.equal(modelsUrl('https://api.deepseek.com'), 'https://api.deepseek.com/models');
  assert.equal(modelsUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/models');
  assert.equal(modelsUrl('https://api.moonshot.cn/v1/'), 'https://api.moonshot.cn/v1/models');
  assert.equal(modelsUrl(''), null);
});

test('模型排序：新版聊天模型排第一，legacy 排后面', () => {
  const list = parseModelsResponse({
    data: [{ id: 'mock-chat-v3' }, { id: 'mock-reasoner-v2' }, { id: 'mock-embedding-1' }, { id: 'mock-chat-v2-legacy' }],
  });
  assert.equal(list[0], 'mock-chat-v3', `默认选中的是 ${list[0]}`);
  assert.ok(list.indexOf('mock-chat-v3') < list.indexOf('mock-chat-v2-legacy'));
  assert.ok(list.indexOf('mock-chat-v3') < list.indexOf('mock-embedding-1'), 'embedding 不该排前面');
});

test('模型排序：推理模型不该当默认（更慢更贵），轻量快模型优先', () => {
  assert.equal(parseModelsResponse({ data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] })[0], 'deepseek-chat');
  assert.equal(parseModelsResponse({ data: [{ id: 'o3-mini' }, { id: 'gpt-4o-mini' }] })[0], 'gpt-4o-mini');
});

test('模型排序：多模态/语音/向量模型排最后，日期快照也降级', () => {
  const list = parseModelsResponse({
    data: [
      { id: 'qwen-vl-max' }, { id: 'text-embedding-v3' }, { id: 'paraformer-realtime-v2' },
      { id: 'qwen-turbo' }, { id: 'qwen-max' },
    ],
  });
  assert.equal(list[0], 'qwen-turbo');
  for (const bad of ['qwen-vl-max', 'text-embedding-v3', 'paraformer-realtime-v2']) {
    assert.ok(list.indexOf(bad) > 1, `${bad} 不该排在前面（${list.join(',')}）`);
  }
  const openai = parseModelsResponse({ data: [{ id: 'gpt-4o-2024-05-13' }, { id: 'gpt-4o-mini' }] });
  assert.equal(openai[0], 'gpt-4o-mini');
});

test('模型列表：几种常见返回形状都能认，重复会去掉', () => {
  assert.deepEqual(parseModelsResponse({ data: [{ id: 'a' }, { id: 'a' }] }), ['a']);
  assert.ok(parseModelsResponse({ models: [{ name: 'b' }] }).includes('b'));
  assert.ok(parseModelsResponse(['c']).includes('c'));
  assert.deepEqual(parseModelsResponse(null), []);
  assert.deepEqual(parseModelsResponse({ data: [{ id: 123 }, { id: '' }] }), []);
});

/* ── 本机配置 ─────────────────────────────── */

test('配置能存到本机、读回来、清掉', () => {
  const st = fakeStorage();
  assert.equal(readAiConfig(st), null);
  writeAiConfig({ presetId: 'deepseek', baseUrl: 'https://api.deepseek.com/', model: 'deepseek-chat', apiKey: 'sk-x', mode: 'direct' }, st);
  const back = readAiConfig(st);
  assert.equal(back.baseUrl, 'https://api.deepseek.com', '末尾斜杠应当被去掉');
  assert.equal(back.apiKey, 'sk-x');
  assert.equal(back.mode, 'direct');
  clearAiConfig(st);
  assert.equal(readAiConfig(st), null);
});

test('配置坏掉时返回 null，而不是抛错让页面白屏', () => {
  const st = fakeStorage();
  st.setItem(AI_CONFIG_KEY, '{不是 JSON');
  assert.equal(readAiConfig(st), null);
  st.setItem(AI_CONFIG_KEY, JSON.stringify({ baseUrl: 'https://x' })); // 少了 model
  assert.equal(readAiConfig(st), null);
  st.setItem(AI_CONFIG_KEY, JSON.stringify({ baseUrl: '', model: 'm' }));
  assert.equal(readAiConfig(st), null);
});

test('模式只认 direct / relay，别的值一律当直连', () => {
  const st = fakeStorage();
  writeAiConfig({ baseUrl: 'https://x', model: 'm', apiKey: 'k', mode: '乱写' }, st);
  assert.equal(readAiConfig(st).mode, 'direct');
});

test('保存时留空密钥表示不改（避免误清）', () => {
  const existing = { presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm', apiKey: 'sk-old' };
  const { config } = normalizeAiConfigInput({ presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm2' }, existing);
  assert.equal(config.apiKey, 'sk-old');
  assert.equal(config.model, 'm2');
});

test('服务商「不允许浏览器直连」时，默认模式自动落到中转', () => {
  // 这条测的是「directCall:false → 默认走中转」这个逻辑本身。
  // 曾经用智谱当例子，但 2026-10-20 实测它其实允许浏览器直连（OPTIONS 和 POST 都回
  // access-control-allow-origin），所以不能拿真服务商冒充「不允许」——
  // 那会把一条错的事实写成测试，改了事实测试就红，而不是逻辑坏了才红。
  const blocked = {
    id: '__blocked__', name: '假装不让直连', baseUrl: 'https://blocked.example.com/v1',
    model: 'm', keyUrl: '', note: '', directCall: false,
  };
  PRESETS.push(blocked);
  try {
    const { config } = normalizeAiConfigInput({ presetId: blocked.id, apiKey: 'k' });
    assert.equal(config.mode, 'relay', '标记为不能直连的服务商，应当默认走中转');
  } finally {
    PRESETS.pop();
  }
  // 允许直连的服务商（今天实测过的）默认就该是直连，少一步配置
  for (const id of ['deepseek', 'zhipu']) {
    const { config } = normalizeAiConfigInput({ presetId: id, apiKey: 'k' });
    assert.equal(config.mode, 'direct', `${id} 允许浏览器直连，应当默认直连`);
  }
});

test('给界面看的配置不含密钥，只含掩码', () => {
  const pub = publicAiConfig({ presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm', apiKey: 'sk-very-secret-123456' /* secret-scan:allow 假密钥，用来验证掩码不泄露 */, mode: 'direct' });
  assert.ok(!JSON.stringify(pub).includes('sk-very-secret-123456' /* secret-scan:allow 假密钥，用来验证掩码不泄露 */));
  assert.ok(pub.keyMasked.includes('*'));
  assert.equal(pub.mode, 'direct');
  assert.equal(pub.directCall, true);
});

/* ── AI 核心：请求与错误处理 ───────────────── */

test('请求里带上密钥与模型，且提示词要求 AI 给营养估算（本地会校验）', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"items":[{"name":"面","grams":500}]}' } }] }) };
  };
  const r = await requestParse({
    text: '吃了碗面', meal: 'lunch', hour: 12,
    config: { baseUrl: 'https://api.example.com/v1/', model: 'm1', apiKey: 'sk-test' },
    fetchImpl,
  });
  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions', '末尾斜杠不该拼出双斜杠');
  assert.equal(captured.auth, 'Bearer sk-test');
  const system = captured.body.messages[0].content;
  // v34 推翻了旧红线：AI 要给营养估算，但必须说明本地会校验（数字不是随便编了就落库）
  assert.ok(system.includes('kcal') && system.includes('protein'), '提示词要要求给营养估算');
  assert.ok(!system.includes('绝对不要输出热量'), '旧红线要删掉，否则模型不敢估');
  assert.equal(r.items[0].name, '面');
  assert.equal(r.meal, null, '模型没给合法餐次时应当是 null');
  void buildSystemPrompt;
});

test('HTTP 错误翻译成人话，并带上该带的信息', () => {
  assert.ok(humanizeHttpError(401, '').includes('密钥'));
  assert.ok(humanizeHttpError(402, '').includes('余额'));
  assert.ok(humanizeHttpError(429, '').includes('频繁'));
  assert.ok(humanizeHttpError(404, '', { model: 'x-1' }).includes('x-1'), '404 要说清是哪个模型名不对');
  assert.ok(humanizeHttpError(503, '').includes('服务商'));
  assert.ok(humanizeHttpError(418, 'teapot').includes('418'));
});

test('网络错误翻译成人话：不说 "Failed to fetch"', () => {
  const m = humanizeNetworkError(new TypeError('Failed to fetch'), 'https://api.example.com');
  assert.ok(m.includes('连不上'), m);
  assert.ok(!m.includes('Failed to fetch'));
  assert.ok(m.includes('不允许网页直接调用'), '要提示「可能需要中转」这个真实原因');
  const t = humanizeNetworkError(Object.assign(new Error('x'), { name: 'TimeoutError' }), 'https://x');
  assert.ok(t.includes('没有响应'), t);
});

test('模型返回带 ```json 包裹也能解析', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.throws(() => extractJson('完全不是 JSON'), /不是 JSON/);
});

test('normalizeResult 挡掉脏数据，但认得「份量说法」和中文餐次', () => {
  const r = normalizeResult({ meal: '夜宵', items: [{ name: '', grams: 1 }, { name: '面', grams: 0 }, { name: '饭', grams: 200 }], questions: ['q', 5, 'p', 'z'] });
  assert.equal(r.meal, 'snack', '中文「夜宵」要能认出来（v31 起），非法值才丢');
  // v35（issue #13）：克数无效（0）但名字有效的不再丢，标 gramsMissing 交给本地估份量
  assert.deepEqual(r.items.map((i) => i.name), ['面', '饭']);
  assert.equal(r.items[0].gramsMissing, true);
  assert.equal(r.questions.length, 2, '追问最多两个');

  // v31：模型给字符串克数、或者只给「一碗」这种说法，都不能再被当成脏数据丢掉
  const tolerant = normalizeResult({
    meal: 'lunch',
    foods: [
      { food: '黄焖鸡米饭', amount: '约550克' },
      { dish: '馄饨', portion: '一碗' },
      { name: '一些', grams: '很多' },
    ],
  });
  // v35（issue #13）：没给份量的「一些」不再丢掉，而是标 gramsMissing 交给本地估
  assert.deepEqual(tolerant.items.map((i) => i.name), ['黄焖鸡米饭', '馄饨', '一些']);
  assert.equal(tolerant.items[2].gramsMissing, true);
  assert.equal(tolerant.items[0].grams, 550);
  assert.equal(tolerant.items[1].grams, null);
  assert.equal(tolerant.items[1].portion, '一碗');
  const bad = normalizeResult({ meal: 'brunch', items: [{ name: '饭', grams: 200 }] });
  assert.equal(bad.meal, null, '不认识的餐次仍然是 null');
});

test('连通测试：成功返回模型回复，失败抛出中文原因', async () => {
  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '可以' } }] }) });
  const r = await requestPing({ config: { baseUrl: 'https://x', model: 'm', apiKey: 'k' }, fetchImpl: okFetch });
  assert.equal(r.reply, '可以');

  const badFetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });
  await assert.rejects(
    () => requestPing({ config: { baseUrl: 'https://x', model: 'm', apiKey: 'k' }, fetchImpl: badFetch }),
    /密钥/,
  );
});

test('拉模型列表：鉴权头带上，返回排序后的列表', async () => {
  let auth = null;
  const fetchImpl = async (url, init) => {
    auth = init.headers.Authorization;
    assert.ok(url.endsWith('/models'));
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'b-chat' }, { id: 'a-chat' }] }) };
  };
  const list = await requestModels({ baseUrl: 'https://x/v1', apiKey: 'sk-abc', fetchImpl });
  assert.equal(auth, 'Bearer sk-abc');
  assert.deepEqual(list.sort(), ['a-chat', 'b-chat']);
});

test('拉模型列表失败时给中文原因', async () => {
  await assert.rejects(
    () => requestModels({ baseUrl: 'https://x', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'no' }) }),
    /密钥/,
  );
  await assert.rejects(
    () => requestModels({ baseUrl: 'https://x', apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) }),
    /没有返回可用的模型列表/,
  );
});

test('保存配置会记录更新时间（界面要显示「更新于」）', () => {
  const st = fakeStorage();
  writeAiConfig({ baseUrl: 'https://x', model: 'm', apiKey: 'k' }, st);
  const cfg = readAiConfig(st);
  assert.ok(cfg.updatedAt, '应当记录更新时间');
  assert.ok(!Number.isNaN(Date.parse(cfg.updatedAt)), '更新时间要是合法时间');
});

test('v31：克数容错 —— 数字、字符串、斤两、带单位都能认', () => {
  assert.equal(coerceGrams(150), 150);
  assert.equal(coerceGrams('150'), 150);
  assert.equal(coerceGrams('150克'), 150);
  assert.equal(coerceGrams('约 150g'), 150);
  assert.equal(coerceGrams('0.3kg'), 300);
  assert.equal(coerceGrams('三两'), 150);
  assert.equal(coerceGrams('很多'), null, '「很多」不是克数');
  assert.equal(coerceGrams(-5), null);
});

test('v34：提示词必须要求「至少回一条」，并给出常见口语的例子', () => {
  const p = buildSystemPrompt();
  assert.ok(p.includes('必须照样估营养'), '库里没有的菜要模型估，不能只给名字');
  assert.ok(p.includes('至少要有 1 条'), '要让模型知道「提到吃的就必须给条目」，否则用户看到的就是没听懂');
  assert.ok(p.includes('鸡蛋灌饼') && p.includes('梅菜扣肉'), '要给出用户真会说的例子');
  assert.ok(p.includes('照用户的叫法写名字'), '库里没有的菜要照实说名字，别换成别的食物');
  // v39：「不知道」只有用户有资格说 —— AI 必须自己估，不能把问题推回给用户
  assert.ok(p.includes('「不知道」只有用户有资格说'), 'AI 不能对用户说「不知道」');
  assert.ok(p.includes('不要问"这是什么"'), '追问只问能帮到估算的细节，不能问「这是什么」');
});

/** 造一个假的上游：按顺序返回预设响应 */
function scriptedFetch(responses, capture = []) {
  let i = 0;
  return async (url, init) => {
    capture.push({ url, body: JSON.parse(init.body) });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.throw) throw r.throw;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json,
      text: async () => r.text ?? '',
    };
  };
}

const CFG = { baseUrl: 'https://fake.example/v1', model: 'fake-model', apiKey: 'sk-fake' };

test('v31：服务商不支持 JSON 模式（400）时，去掉 response_format 自动重试一次', async () => {
  const calls = [];
  const fetchImpl = scriptedFetch([
    { ok: false, status: 400, text: 'response_format is not supported for this model' },
    { json: { choices: [{ message: { content: '{"items":[{"name":"米饭","grams":200}]}' } }] } },
  ], calls);
  const r = await requestParse({ text: '吃了200克米饭', config: CFG, fetchImpl });
  assert.equal(r.items.length, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.response_format, '第一次带着 JSON 模式试');
  assert.equal(calls[1].body.response_format, undefined, '第二次要去掉它');
});

test('v31：模型没按 JSON 回时，会再要一次；第二次成功就正常返回', async () => {
  const calls = [];
  const fetchImpl = scriptedFetch([
    { json: { choices: [{ message: { content: '抱歉，我理解一下……用户吃了米饭。' } }] } },
    { json: { choices: [{ message: { content: '{"meal":"lunch","items":[{"name":"米饭","grams":200}],"questions":[]}' } }] } },
  ], calls);
  const r = await requestParse({ text: '中午吃了米饭', config: CFG, fetchImpl });
  assert.equal(r.items.length, 1);
  assert.equal(r.meal, 'lunch');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].body.messages.at(-1).content.includes('只输出 JSON'), '重试时要再强调一次只要 JSON');
});

test('v31：两次都不是 JSON 时，报的是「不是 JSON」而不是空白结果', async () => {
  const fetchImpl = scriptedFetch([
    { json: { choices: [{ message: { content: '我不知道。' } }] } },
    { json: { choices: [{ message: { content: '还是不知道。' } }] } },
  ]);
  await assert.rejects(
    () => requestParse({ text: 'x', config: CFG, fetchImpl }),
    /不是 JSON/,
  );
});

test('v31：模型返回空 items 时会再要一次（真的什么都没有才交给离线兜底）', async () => {
  const calls = [];
  const fetchImpl = scriptedFetch([
    { json: { choices: [{ message: { content: '{"meal":"lunch","items":[],"questions":[]}' } }] } },
    { json: { choices: [{ message: { content: '{"meal":"lunch","items":[{"name":"牛肉面","grams":600}],"questions":[]}' } }] } },
  ], calls);
  const r = await requestParse({ text: '中午吃了碗面', config: CFG, fetchImpl });
  assert.equal(r.items.length, 1, '第二次要到的条目要能用上');
  assert.equal(r.items[0].name, '牛肉面');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].body.messages.at(-1).content.includes('不要回空 items'));

  // 第二次还是空的：返回空结果（由界面退回离线解析），不能抛错
  const emptyFetch = scriptedFetch([
    { json: { choices: [{ message: { content: '{"items":[]}' } }] } },
  ]);
  const empty = await requestParse({ text: 'x', config: CFG, fetchImpl: emptyFetch });
  assert.deepEqual(empty.items, []);
});


/*
 * v34：AI 直接给营养估算 —— 收敛层要认得这些数字，并且挡住离谱/不全的。
 * 这是「AI 归位」的地基：认不出来就等于又退回只给名字。
 */

test('v34：normalizeResult 认得营养估算（字符串 / 嵌套 / 中文键都行）', () => {
  const r = normalizeResult({
    items: [
      { name: 'A', grams: 100, kcal: '约 200', protein: '10', fat: '5', carb: '25' },
      { name: 'B', grams: 150, nutrition: { kcal: 300, protein: 20, fat: 12, carb: 30 } },
      { name: 'C', grams: 100, kcal: 6000, protein: 1, fat: 1, carb: 1 },
      { name: 'D', grams: 100, kcal: 100 },
      { name: 'E', grams: 100, 热量: 150, 蛋白质: 5, 脂肪: 5, 碳水: 20 },
    ],
  });
  assert.deepEqual(r.items[0].nutrition, { kcal: 200, protein: 10, fat: 5, carb: 25 });
  assert.deepEqual(r.items[1].nutrition, { kcal: 300, protein: 20, fat: 12, carb: 30 });
  assert.equal(r.items[2].nutrition, null, '离谱数字不许进计算');
  assert.equal(r.items[3].nutrition, null, '缺字段就不认（宁可不认，也不要 0 把合计带偏）');
  assert.deepEqual(r.items[4].nutrition, { kcal: 150, protein: 5, fat: 5, carb: 20 }, '中文键也要认');
});

test('v34：只有份量说法、没有克数时，营养不留（没法换算成每 100 克）', () => {
  const r = normalizeResult({ items: [{ name: '一碗面', portion: '一碗', kcal: 600, protein: 20, fat: 10, carb: 80 }] });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].grams, null);
  assert.equal(r.items[0].nutrition, null);
});

test('DeepSeek 请求显式关掉思考模式；别家不带这个参数', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"items":[{"name":"米饭","grams":150}]}' } }] }),
    };
  };
  await requestParse({
    text: '吃了米饭',
    config: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-fake' },
    fetchImpl,
  });
  assert.deepEqual(seen[0].body.thinking, { type: 'disabled' }, 'DeepSeek V4 默认开思考，必须显式关掉，否则正文会被 reasoning 占空');

  const other = [];
  await requestParse({
    text: '吃了米饭',
    config: CFG,
    fetchImpl: async (url, init) => {
      other.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"items":[{"name":"米饭","grams":150}]}' } }] }),
      };
    },
  });
  assert.equal(other[0].thinking, undefined, '别家服务商不认识 thinking，不能乱加');
});
