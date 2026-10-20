/**
 * AI 调用核心：提示词、请求、结果收敛
 *
 * 这一层不关心「谁去调用」——浏览器直连和电脑中转都用它，逻辑只有一份，避免两边跑偏。
 */

import { coachSystemPrompt, coachUserMessage } from './coach.js';

export const REQUEST_TIMEOUT_MS = 25000;

/**
 * 系统提示词：只让它听懂和估份量，热量一律不许它编。
 * 热量由本地食物库算，这样数字能核对、能离线复算。
 */
export function buildSystemPrompt() {
  return [
    '你是一个帮中国用户记录饮食的解析器。用户会用大白话描述吃了什么，你只负责理解，不要输出热量数字。',
    '',
    '要求：',
    '1. 把描述拆成若干条食物，每条给出：name（中文名，尽量具体，例如"牛肉面"而不是"面"）、grams（估算克数，整数）。',
    '2. 常见份量参考：一小碗米饭 130 克、一碗米饭 180 克、一碗面 600 克（含汤和浇头）、一碗粥 250 克、',
    '   一个鸡蛋 50 克、一个包子 100 克、一个苹果 200 克、一杯牛奶 250 克、中杯奶茶 500 克、',
    '   一份盖饭 500 克、一份麻辣烫 500 克、一杯酸奶 150 克、一片吐司 35 克。',
    '3. 如果用户说的份量含糊（例如只说"吃了碗面"），按上面参考值估一个，并在 questions 里提一个最关键的追问，',
    '   例如"面大概多大一碗？（小碗/普通碗/大碗）"。最多问 2 个问题，别问不重要的。',
    '4. 组合菜（牛肉面、盖饭、麻辣烫、火锅）算成一条，不要拆成原料再加一遍。',
    '5. 用户提到"加了蛋""加了肉""加了麻酱""喝了一瓶啤酒"这类加料，单独列一条。',
    '6. 识别餐次放进 meal："breakfast" | "lunch" | "dinner" | "snack"；用户没说就根据上下文和当前时间判断。',
    '7. 不要输出热量、蛋白质、脂肪、碳水等营养数字，那些由本地数据库计算。',
    '8. 只输出 JSON，不要任何解释文字。',
    '',
    '输出格式：',
    '{"meal":"lunch","items":[{"name":"牛肉面","grams":600}],"questions":["面大概多大一碗？"]}',
  ].join('\n');
}

/** 把上游结果收敛成固定形状，挡住乱七八糟的输出 */
export function normalizeResult(raw) {
  const items = [];
  for (const it of Array.isArray(raw?.items) ? raw.items : []) {
    const name = typeof it?.name === 'string' ? it.name.trim().slice(0, 40) : '';
    const grams = Number(it?.grams);
    if (!name) continue;
    if (!(grams > 0) || grams > 5000) continue;
    items.push({ name, grams: Math.round(grams), note: typeof it?.note === 'string' ? it.note.slice(0, 60) : null });
  }
  const meals = ['breakfast', 'lunch', 'dinner', 'snack'];
  const questions = (Array.isArray(raw?.questions) ? raw.questions : [])
    .filter((q) => typeof q === 'string' && q.trim())
    .map((q) => q.trim().slice(0, 80))
    .slice(0, 2);
  return {
    meal: meals.includes(raw?.meal) ? raw.meal : null,
    items,
    questions,
  };
}

/** 从模型返回的文本里抠出 JSON（有的模型会包一层 ```json） */
export function extractJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const m = String(content).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('模型返回的不是 JSON');
    return JSON.parse(m[0]);
  }
}

/** 把 HTTP 状态码翻译成人话 */
export function humanizeHttpError(status, body, extra = {}) {
  const detail = body ? `（${String(body).slice(0, 140)}）` : '';
  switch (status) {
    case 400: return `请求被服务商拒绝${detail}。常见原因：模型名不对，或者该模型不支持这种调用方式`;
    case 401: return `密钥不对或者已失效，检查有没有复制完整${detail}`;
    case 402: return `账户余额不足，去服务商后台充一点${detail}`;
    case 403: return `这家服务不允许这样调用（可能是权限或地区限制）${detail}`;
    case 404: return `模型名「${extra.model || '?'}」在这家服务上不存在，点「获取模型列表」看看有哪些可选${detail}`;
    case 429: return `请求太频繁，等一分钟再试${detail}`;
    case 500: case 502: case 503: case 504: return `服务商这边出问题了（${status}），过一会儿再试${detail}`;
    default: return `服务返回 ${status}${detail}`;
  }
}

/** 把网络层错误翻译成人话（浏览器直连和中转都要用同一套说法） */
export function humanizeNetworkError(err, baseUrl) {
  const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  if (isTimeout) return `等了 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒没有响应（${baseUrl}）。检查网络，或者换一家服务商`;
  const msg = String(err?.message || err || '');
  if (/Failed to fetch|NetworkError|load failed/i.test(msg)) {
    return `连不上 ${baseUrl}。可能原因：地址填错、手机没网、或者这家服务不允许网页直接调用（这种情况要用中转服务）。`;
  }
  return `调用失败：${msg}`;
}

/**
 * 发一次解析请求。浏览器直连和电脑中转都调它。
 * @param {{text:string, meal?:string|null, hour?:number, config:{baseUrl:string, model:string, apiKey:string}, fetchImpl?:Function}} opts
 */
export async function requestParse({ text, meal, hour, config, fetchImpl = fetch }) {
  const userContent = [
    `用户说：${text}`,
    meal ? `用户指定了这一餐是：${meal}` : '',
    `当前时间：${hour ?? new Date().getHours()} 点`,
  ].filter(Boolean).join('\n');

  let res;
  try {
    res = await fetchImpl(`${String(config.baseUrl).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: userContent },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(humanizeNetworkError(err, config.baseUrl));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(humanizeHttpError(res.status, body, { model: config.model }));
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('服务商没有返回内容');
  return normalizeResult(extractJson(content));
}

/**
 * 让 AI 把「本地已经算好的事实」说成一段人话。
 *
 * 注意这里**不给它 JSON 格式**：教练要的是自然语言，不是结构化数据。
 * 数字安全靠 js/coach.js 的 checkCoachText 事后校验 —— 说了清单外的数字就整段退回本地版。
 */
export async function requestCoach({ brief, config, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${String(config.baseUrl).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: coachSystemPrompt() },
          { role: 'user', content: coachUserMessage(brief) },
        ],
        temperature: 0.5,
        max_tokens: 420,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(humanizeNetworkError(err, config.baseUrl));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(humanizeHttpError(res.status, body, { model: config.model }));
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('服务商没有返回内容');
  return { text: String(content).trim() };
}

/** 发一次最小请求，只为了验证「密钥+地址+模型」能不能用 */
export async function requestPing({ config, fetchImpl = fetch }) {  let res;
  try {
    res = await fetchImpl(`${String(config.baseUrl).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: '回复两个字：可以' }],
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(humanizeNetworkError(err, config.baseUrl));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(humanizeHttpError(res.status, body, { model: config.model }));
  }
  const data = await res.json();
  return { reply: String(data?.choices?.[0]?.message?.content || '').trim().slice(0, 40) };
}

/** 拉取这家服务商有哪些模型 */
export async function requestModels({ baseUrl, apiKey, fetchImpl = fetch }) {
  const url = `${String(baseUrl).replace(/\/$/, '')}/models`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(humanizeNetworkError(err, baseUrl));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(humanizeHttpError(res.status, body, {}));
  }
  const data = await res.json();
  const { parseModelsResponse } = await import('./providers.js');
  const models = parseModelsResponse(data);
  if (!models.length) throw new Error('这家服务没有返回可用的模型列表，可以手动填模型名');
  return models;
}

/* ── 读营养成分表（拍照） ─────────────────────
 *
 * 这一块和「解析一句话」的原则是反过来的，写清楚免得以后有人以为红线破了：
 *  - 解析一句话：**不许模型输出任何营养数字**，热量由本地食物库算；
 *  - 读营养成分表：**必须**让模型把包装上印的数字读出来 —— 但只许「读」，不许换算、
 *    不许估算、看不清就填 null。读回来的数字还要过本地校验（单位、4/9/4 对账）
 *    并由她确认后才保存。算术仍然在本地，AI 只是 OCR。
 */

export function buildLabelPrompt() {
  return [
    '你是营养成分表读取器。用户会给你一张食品包装背面的「营养成分表」照片。',
    '你只做一件事：把表里印的数字原样读出来。不要换算、不要估算、不要补充表里没有的数字。',
    '',
    '要求：',
    '1. 默认按「每 100 克」输出；如果标签写的是「每份」，就按每份的数值输出，同时给出 baseGrams（一份多少克）。',
    '2. 能量按标签上的**原始单位**返回：unit 填 "kJ"（千焦）或 "kcal"（千卡），value 填数字。不要替用户换算。',
    '3. 蛋白质、脂肪、碳水化合物的单位都是克。',
    '4. name 用包装上最显眼的品名，尽量短（不超过 20 字）；读不到就留空字符串。',
    '5. 任何一个数字看不清就填 null，**绝对不要猜**。',
    '6. 如果图片里没有营养成分表，输出 {"error":"没有找到营养成分表"}。',
    '7. 只输出 JSON，不要解释文字。',
    '',
    '输出格式：',
    '{"name":"低脂鸡胸肉","baseGrams":100,"energy":{"value":349,"unit":"kJ"},"protein":13.7,"fat":0.7,"carb":5.3}',
  ].join('\n');
}

/** 模型返回的 content 可能是字符串，也可能是 [{type:'text',text}] 数组 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return '';
}

/**
 * 把模型读出来的表收敛成固定形状：只认合理数字，越界一律当作「没读到」。
 * 不在这里换算单位 —— 单位换算留给本地 label.js，方便单独测试。
 */
export function normalizeLabelResult(raw) {
  const num = (v, max) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  };
  const energyRaw = raw && typeof raw.energy === 'object' ? raw.energy : {};
  const energyValue = num(energyRaw.value, 100000);
  const unitRaw = String(energyRaw.unit || '').toLowerCase();
  const unit = unitRaw === 'kj' ? 'kJ' : unitRaw === 'kcal' ? 'kcal' : null;
  const baseGrams = num(raw?.baseGrams, 5000);
  return {
    name: typeof raw?.name === 'string' ? raw.name.trim().slice(0, 20) : '',
    baseGrams: baseGrams && baseGrams > 0 ? baseGrams : null,
    energy: energyValue === null ? null : { value: energyValue, unit },
    protein: num(raw?.protein, 100),
    fat: num(raw?.fat, 100),
    carb: num(raw?.carb, 100),
  };
}

/**
 * 请求模型读一张营养成分表照片。
 * @param {{imageDataUrl:string, config:{baseUrl:string, model:string, apiKey:string}, fetchImpl?:Function}} opts
 */
export async function requestLabelParse({ imageDataUrl, config, fetchImpl = fetch }) {
  if (!/^data:image\//.test(String(imageDataUrl || ''))) throw new Error('图片格式不对（需要 data:image/...）');
  let res;
  try {
    res = await fetchImpl(`${String(config.baseUrl).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: buildLabelPrompt() },
          {
            role: 'user',
            content: [
              { type: 'text', text: '这是包装上的营养成分表，把数字读出来。' },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS + 15000),
    });
  } catch (err) {
    throw new Error(humanizeNetworkError(err, config.baseUrl));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 大量文字模型会直接拒绝：不支持 image_url / 不是多模态模型
    if (/image|vision|multimodal|content type|unsupported/i.test(body)) {
      throw new Error('当前这个模型看不了图片。换一个支持看图的模型（例如 qwen-vl-plus、glm-4v、gpt-4o-mini），或者直接手动填 —— 数字都一样准。');
    }
    throw new Error(humanizeHttpError(res.status, body, { model: config.model }));
  }
  const data = await res.json();
  const text = contentToText(data?.choices?.[0]?.message?.content);
  if (!text) throw new Error('模型没有返回内容');
  const parsed = extractJson(text);
  if (parsed?.error) throw new Error(String(parsed.error).slice(0, 80));
  return normalizeLabelResult(parsed);
}
