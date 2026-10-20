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
  humanizeNetworkError, requestParse, requestPing, requestModels,
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

test('请求里带上密钥与模型，且 system 提示词禁止模型编热量', async () => {
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
  assert.ok(captured.body.messages[0].content.includes('不要输出热量'));
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

test('normalizeResult 挡掉脏数据', () => {
  const r = normalizeResult({ meal: '夜宵', items: [{ name: '', grams: 1 }, { name: '面', grams: 0 }, { name: '饭', grams: 200 }], questions: ['q', 5, 'p', 'z'] });
  assert.equal(r.meal, null);
  assert.deepEqual(r.items.map((i) => i.name), ['饭']);
  assert.equal(r.questions.length, 2, '追问最多两个');
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
