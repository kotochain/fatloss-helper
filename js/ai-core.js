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
 *
 * v31 重写：
 *  - 明确「只要提到了吃/喝就必须至少给一条」——模型返回空 items 是用户看到「没听懂」的主因之一；
 *  - 把用户真会说的话（口语、简称、组合菜、家里做的菜）写成例子，减少「这是什么意思」；
 *  - 说清「本地库里没有的菜也照实说名字」，不要为了迎合去换成别的食物（换掉的会被算错）。
 */
export function buildSystemPrompt() {
  return [
    '你是一个帮中国用户记录饮食的助手：听懂用户吃了什么、估份量、估营养成分。',
    '',
    '要求：',
    '1. 把描述拆成若干条食物，每条给出：name（中文名，用最常见的叫法，尽量具体）、grams（估算克数，整数）、',
    '   以及这一份（grams 克）的营养：kcal（千卡）、protein（蛋白质克）、fat（脂肪克）、carb（碳水克）。',
    '2. 本地食物库里有的常见菜，按常识估一版就行（数字会以本地库为准）；本地库里没有的菜',
    '   （家里做的、地方小吃、新品牌）**必须照样估营养**，不要拒绝、也不要只给名字。',
    '3. 热量要和三大营养素大致对得上（蛋白质 4、脂肪 9、碳水 4 kcal/克，误差别超过 30%）；',
    '   拿不准就给最接近的合理值，不要留空、不要写 0 了事。',
    '4. 只要这句话提到了吃或喝的东西（哪怕只说了一样、或者很不确定），items 里就**至少要有 1 条**。',
    '   不要返回空 items，也不要说自己看不懂、不知道、认不出来 —— 按最接近的常见食物估一条，把握不大就写进 questions。',
    '   「不知道」只有用户有资格说；你的职责是给出一个合理的估算，再把不确定的细节问清楚。',
    '5. 常见份量参考：一小碗米饭 130 克、一碗米饭 180 克、一碗面 600 克（含汤和浇头）、一碗粥 250 克、',
    '   一个鸡蛋 50 克、一个包子 100 克、一个苹果 200 克、一杯牛奶 250 克、中杯奶茶 500 克、',
    '   一份盖饭 500 克、一份麻辣烫 500 克、一杯酸奶 150 克、一片吐司 35 克、一根香蕉 120 克。',
    '6. 如果份量含糊（例如只说"吃了碗面"），按上面参考值估一个，并在 questions 里提一个最关键的追问，',
    '   例如"面大概多大一碗？（小碗/普通碗/大碗）"。最多问 2 个问题，别问不重要的。',
    '   questions 只问能帮到估算的细节（份量、做法、品牌），不要问"这是什么"——那是你该估的。',
    '7. 组合菜（牛肉面、盖饭、麻辣烫、火锅）算成一条，不要拆成原料再加一遍；',
    '   但用户明确说"配了一碗饭""加了个蛋""加肉""喝了瓶啤酒"这类**额外加的**，单独列一条。',
    '8. 识别餐次放进 meal："breakfast" | "lunch" | "dinner" | "snack"；用户没说就根据上下文和当前时间判断。',
    '9. 本地库里没有的菜也**照用户的叫法写名字**，不要换成别的食物；营养按你估的给，别留空。',
    '10. 只输出 JSON，不要任何解释文字。',
    '',
    '用户可能会这样说（都按正常食物处理，不要回"看不懂"）：',
    '- "早上喝了杯豆浆，吃了个鸡蛋灌饼" → 两条',
    '- "中午食堂打了三个菜：土豆丝、青椒肉丝、炒青菜" → 三条（米饭没提就不加）',
    '- "晚上我妈做的梅菜扣肉，配了半碗饭" → 梅菜扣肉 150、米饭 90',
    '- "喝了杯三分糖奶茶" → 奶茶 500',
    '- "就随便吃了点" → 按最常见的 1 条估，并在 questions 里问吃了什么',
    '',
    '输出格式（营养是这一份的总量，不是每 100 克）：',
    '{"meal":"lunch","items":[{"name":"牛肉面","grams":600,"kcal":630,"protein":28,"fat":18,"carb":78}],"questions":["面大概多大一碗？"]}',
  ].join('\n');
}

/** 餐次的各种写法（模型偶尔会回中文）统一成内部 key */
const MEAL_SYNONYMS = {
  breakfast: 'breakfast', 早餐: 'breakfast', 早饭: 'breakfast', 早上: 'breakfast',
  lunch: 'lunch', 午餐: 'lunch', 午饭: 'lunch', 中午: 'lunch',
  dinner: 'dinner', 晚餐: 'dinner', 晚饭: 'dinner', 晚上: 'dinner',
  snack: 'snack', 加餐: 'snack', 夜宵: 'snack', 宵夜: 'snack', 零食: 'snack', 下午茶: 'snack',
};

const PORTION_HINT = /[一二两三四五六七八九十半]\s*(?:小|大|超)?\s*(碗|份|个|杯|瓶|盘|盒|袋|包|块|片|根|只|颗|粒|把|勺)|^(小|大|超)?(碗|份|个|杯|瓶|盘|盒|袋|包|块|片|根|只|颗|粒|把|勺)/;

/** 把「150」「150克」「约 150g」「0.3kg」「三两」都变成克数；看不懂返回 null */
const CN_QTY = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };

export function coerceGrams(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  // 「三两」「半斤」这种中文数字 + 市制单位
  const cn = value.match(/^\s*([一二两三四五六七八九十半])\s*(斤|两)\s*$/);
  if (cn) return CN_QTY[cn[1]] * (cn[2] === '斤' ? 500 : 50);
  const m = value.match(/(\d+(?:\.\d+)?)\s*(kg|千克|克|g|毫升|ml|斤|两)?/i);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = String(m[2] || '').toLowerCase();
  if (unit === 'kg' || unit === '千克') n *= 1000;
  if (unit === '斤') n *= 500;
  if (unit === '两') n *= 50;
  return n;
}

/**
 * 模型给的数字可能是 12 / "12" / "约 12 克" —— 取第一个数；取不到返回 null。
 * 营养数字宁可不认，也不要把「约」「克」这种文字塞进计算里。
 */
function coerceNum(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const m = value.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 从一条 AI 结果里取「这一份的营养」。
 *
 * v34 起允许模型直接给营养估算（本地库里没有的菜也能记上）。字段名放宽：
 * kcal/calories/energy、protein/protein_g、fat、carb/carbs/carbohydrate 都认，
 * 也认嵌套一层 nutrition 对象。四个都给全了才算数 —— 缺一个就不认，退回本地同类均值，
 * 免得「只有热量、营养全是 0」那种假数据把合计带偏。
 *
 * @returns {{kcal:number,protein:number,fat:number,carb:number}|null}
 */
export function coerceNutrition(item) {
  const nest = item && typeof item.nutrition === 'object' && item.nutrition ? item.nutrition : {};
  const pickNum = (...keys) => {
    for (const k of keys) {
      const v = coerceNum(item?.[k] ?? nest[k]);
      if (v !== null) return v;
    }
    return null;
  };
  const kcal = pickNum('kcal', 'calories', 'energy', 'energy_kcal', '热量');
  const protein = pickNum('protein', 'protein_g', '蛋白质');
  const fat = pickNum('fat', 'fat_g', '脂肪');
  const carb = pickNum('carb', 'carbs', 'carbohydrate', 'carb_g', '碳水', '碳水化合物');
  if ([kcal, protein, fat, carb].some((v) => v === null)) return null;
  if (kcal < 0 || kcal > 5000) return null;
  if ([protein, fat, carb].some((v) => v < 0 || v > 1000)) return null;
  return { kcal, protein, fat, carb };
}

/**
 * 把上游结果收敛成固定形状，挡住乱七八糟的输出。
 *
 * v31 放宽了三处（都是为了「AI 听懂了、却还是记不上」）：
 *  - 条目的字段名不只认 items：foods / results / list / dishes 也认；
 *  - 名字不只认 name：food / dish / item / description 也认；
 *  - 克数允许是字符串（"150克"），也允许只给份量说法（"一碗"）——克数留 null 交给本地换算。
 */
export function normalizeResult(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = ['items', 'foods', 'results', 'list', 'dishes', 'data']
    .map((k) => src[k])
    .find((v) => Array.isArray(v)) || [];

  const items = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const nameRaw = it.name ?? it.food ?? it.dish ?? it.item ?? it.description ?? it.label;
    const name = typeof nameRaw === 'string' ? nameRaw.trim().slice(0, 40) : '';
    if (!name) continue;
    const gramsRaw = it.grams ?? it.amount ?? it.weight ?? it.grams_estimate ?? it.portion_grams;
    const grams = coerceGrams(gramsRaw);
    // 只给了份量说法（"一碗""一份"）也要留下：本地会按食物换算
    const portionRaw = typeof it.portion === 'string' ? it.portion : (typeof gramsRaw === 'string' ? gramsRaw : '');
    // 只认真正的份量说法（「一碗」「两份」）；「很多」「一些」这种不算，否则等于没有克数
    const portion = portionRaw && PORTION_HINT.test(portionRaw) ? portionRaw.trim().slice(0, 20) : null;
    if (grams > 5000) continue;
    const rounded = grams > 0 ? Math.round(grams) : null;
    items.push({
      name,
      grams: rounded,
      portion: portion || null,
      note: typeof it.note === 'string' ? it.note.slice(0, 60) : null,
      // 营养是「这一份」的总量，所以必须知道这一份多少克，否则没法换算出每 100 克
      nutrition: rounded ? coerceNutrition(it) : null,
      /*
       * v35（issue #13）：AI 只给了名字、没给克数也没给「一碗」这种份量说法 ——
       * 以前这里直接丢掉（用户于是看到「AI 都认出来了却记不上」）。现在留着，
       * 由本地按常见一份估克数，并在条目上说明「份量是按常见一份估的」。
       */
      gramsMissing: !rounded && !portion,
    });
  }

  const questions = (Array.isArray(src.questions) ? src.questions : (typeof src.questions === 'string' ? [src.questions] : []))
    .filter((q) => typeof q === 'string' && q.trim())
    .map((q) => q.trim().slice(0, 80))
    .slice(0, 2);
  const mealKey = MEAL_SYNONYMS[String(src.meal ?? src.meal_type ?? src.mealTime ?? '').trim().toLowerCase()] || null;
  return { meal: mealKey, items, questions };
}

/** 从模型返回的文本里抠出 JSON（有的模型会包一层 ```json，或有前后废话） */
export function extractJson(content) {
  const text = String(content || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const obj = text.match(/\{[\s\S]*\}/);
    if (obj) {
      try { return JSON.parse(obj[0]); } catch { /* 继续尝试数组 */ }
    }
    const arr = text.match(/\[[\s\S]*\]/);
    if (arr) return JSON.parse(arr[0]);
    throw new Error('模型返回的不是 JSON');
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
  const baseMessages = [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content: [
        `用户说：${text}`,
        meal ? `用户指定了这一餐是：${meal}` : '',
        `当前时间：${hour ?? new Date().getHours()} 点`,
      ].filter(Boolean).join('\n'),
    },
  ];

  const send = async (messages, withJsonMode) => {
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
          messages,
          temperature: 0.2,
          ...(withJsonMode ? { response_format: { type: 'json_object' } } : {}),
          max_tokens: 800,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(humanizeNetworkError(err, config.baseUrl));
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, body };
    }
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw emptyContentError(data) || new Error('服务商没有返回内容');
    return { ok: true, content };
  };

  let attempt = await send(baseMessages, true);
  // 有些服务商/中转不支持 JSON 模式，会直接 400。去掉这个参数再试一次，
  // 否则用户看到的就是「AI 没成功」，明明只是少了个参数（v31 补的兼容）。
  if (!attempt.ok && attempt.status === 400 && /response_format|json_object|json mode/i.test(attempt.body || '')) {
    attempt = await send(baseMessages, false);
  }
  if (!attempt.ok) throw new Error(humanizeHttpError(attempt.status, attempt.body, { model: config.model }));

  let first;
  try {
    first = normalizeResult(extractJson(attempt.content));
  } catch (err) {
    // 模型没按 JSON 回（常见于小模型/中文模型）：再要一次，并把要求重复一遍。
    // 只重试一次，避免网络不好时把 25 秒拖成 50 秒。
    const retry = await send([
      ...baseMessages,
      { role: 'assistant', content: String(attempt.content).slice(0, 500) },
      { role: 'user', content: '上面这段不是合法 JSON。请只输出 JSON 对象，格式：{"meal":"lunch","items":[{"name":"食物名","grams":150,"kcal":200,"protein":10,"fat":5,"carb":25}],"questions":[]}' },
    ], false);
    if (!retry.ok) throw new Error(humanizeHttpError(retry.status, retry.body, { model: config.model }));
    try {
      return normalizeResult(extractJson(retry.content));
    } catch {
      throw new Error(err.message || '模型返回的不是 JSON');
    }
  }

  // 模型听得懂、但返回了空 items（用户看到的就是「没听懂、记不上」）。
  // 再要一次，并把「至少要有一条」再强调一遍；第二次还没有就照原样返回，交给离线兜底。
  if (!first.items.length) {
    try {
      const retry = await send([
        ...baseMessages,
        { role: 'assistant', content: String(attempt.content).slice(0, 300) },
        { role: 'user', content: '上一轮 items 是空的。但用户确实描述了吃了或喝了什么，请至少给出 1 条最可能的食物（name + grams + kcal/protein/fat/carb），不确定的写进 questions，不要回空 items。' },
      ], false);
      if (retry.ok) {
        const second = normalizeResult(extractJson(retry.content));
        if (second.items.length) return second;
      }
    } catch { /* 第二次要不到就按第一次的结果走，别把原本的返回弄丢 */ }
  }
  return first;
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
  if (!content) throw emptyContentError(data) || new Error('服务商没有返回内容');
  return { text: String(content).trim() };
}

/** 发一次最小请求，只为了验证「密钥+地址+模型」能不能用 */
export async function requestPing({ config, fetchImpl = fetch }) {
  let res;
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
 *    并由用户确认后才保存。算术仍然在本地，AI 只是 OCR。
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
    '6. 数字必须和它左边的项目名在**同一行**。照片糊的时候最容易整行错位（把「蛋白质」读成能量那行的 NRV%、',
    '   或者把下一行的数字安到这一行）—— 只要你不确定这个数字属于哪一行，就填 null。NRV% 那一列不需要，别混进来。',
    '7. 输出前自己核一遍：三个营养素按 4/9/4 折成热量（蛋白和碳水每克 4 千卡、脂肪每克 9 千卡），',
    '   应当接近标签上的能量（标签写千焦就先除以 4.184）。差得远说明很可能读错了行或单位，',
    '   请重新看一遍图片再输出；实在看不清就把可疑的那几个填 null。',
    '8. 如果图片里没有营养成分表，输出 {"error":"没有找到营养成分表"}。',
    '9. 只输出 JSON，不要解释文字。',
    '',
    '输出格式：',
    '{"name":"低脂鸡胸肉","baseGrams":100,"energy":{"value":349,"unit":"kJ"},"protein":13.7,"fat":0.7,"carb":5.3}',
  ].join('\n');
}

/**
 * 正文是空的，但模型写了「思考过程」—— 这不是网络问题，是模型把额度花在思考上了。
 * 真事：显式指定 deepseek-flash 时，它会先吐一大段 reasoning_content，
 * max_tokens 不够时 content 直接是空串，界面上就变成「没读出来：服务商没有返回内容」，看着像断网。
 * 回到 deepseek-chat（同一个模型的别名，不做深度思考）就正常。
 */
function emptyContentError(data) {
  const choice = data?.choices?.[0] || {};
  const thinking = String(choice?.message?.reasoning_content || '').trim();
  if (!thinking) return null;
  if (choice.finish_reason === 'length') {
    return new Error('模型把额度都花在「思考」上了，正文被截断。换一个不做深度思考的模型再试（DeepSeek 用 deepseek-chat，别加 -flash）。');
  }
  return new Error('模型只回了「思考过程」，正文是空的。换一个不做深度思考的模型再试（DeepSeek 用 deepseek-chat，别加 -flash）。');
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
      throw new Error('当前这个模型看不了图片。换一个支持看图的模型（例如 deepseek-chat、qwen-vl-plus、glm-4v、gpt-4o-mini），或者直接手动填 —— 数字都一样准。');
    }
    throw new Error(humanizeHttpError(res.status, body, { model: config.model }));
  }
  const data = await res.json();
  const text = contentToText(data?.choices?.[0]?.message?.content);
  if (!text) throw emptyContentError(data) || new Error('模型没有返回内容');
  const parsed = extractJson(text);
  if (parsed?.error) throw new Error(String(parsed.error).slice(0, 80));
  return normalizeLabelResult(parsed);
}
