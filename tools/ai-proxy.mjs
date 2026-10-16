/**
 * AI 解析转发（"中间人"）
 *
 * 为什么需要它：手机上的网页不能直接调用 AI 服务（各家默认不允许网页跨域调用），
 * 把密钥放在手机里也不安全（谁翻到手机就等于拿到你的账号）。
 * 所以密钥只放在这台电脑上，由这个转发程序代手机去问 AI。
 *
 * 启动：
 *   node tools/serve.mjs
 * 密钥来源（三种任选，优先级从高到低）：
 *   1) 环境变量 DEEPSEEK_API_KEY
 *   2) 文件 ~/.dsh/fatloss-ai-key（内容就是密钥，一行）
 *   3) 工作区外的 data/ai-key.txt（已加入 .gitignore，永远不会被提交）
 *
 * 支持任何 OpenAI 兼容接口（DeepSeek / 通义 / Kimi / 智谱 / OpenAI），用环境变量切换：
 *   AI_BASE_URL=https://api.deepseek.com   AI_MODEL=deepseek-chat
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-chat';

/** 从环境变量或密钥文件里取密钥。返回 null 表示没配置。 */
export function readApiKey(root) {
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY.trim(), from: '环境变量 DEEPSEEK_API_KEY' };
  if (process.env.AI_API_KEY) return { key: process.env.AI_API_KEY.trim(), from: '环境变量 AI_API_KEY' };
  const candidates = [
    path.join(os.homedir(), '.dsh', 'fatloss-ai-key'),
    path.join(root, 'data', 'ai-key.txt'),
  ];
  for (const file of candidates) {
    try {
      const key = fs.readFileSync(file, 'utf8').trim().split('\n')[0].trim();
      if (key) return { key, from: file };
    } catch { /* 没有这个文件就继续找 */ }
  }
  return null;
}

export function aiConfig(root) {
  const found = readApiKey(root);
  return {
    configured: Boolean(found),
    from: found?.from || null,
    baseUrl: (process.env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
    model: process.env.AI_MODEL || DEFAULT_MODEL,
  };
}

/** 系统提示词：只让它听懂和估份量，热量一律不许它编 */
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

/** 调上游 AI，返回已解析的 JSON 对象 */
export async function callUpstream({ text, meal, hour, config, fetchImpl = fetch }) {
  const userContent = [
    `用户说：${text}`,
    meal ? `她指定了这一餐是：${meal}` : '',
    `当前时间：${hour ?? new Date().getHours()} 点`,
  ].filter(Boolean).join('\n');

  const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.key}`,
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
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = res.status === 401 ? '密钥不对或已失效'
      : res.status === 402 ? '账户余额不足'
        : res.status === 429 ? '请求太频繁，稍后再试'
          : `上游返回 ${res.status}`;
    throw new Error(`${hint}${body ? `（${body.slice(0, 160)}）` : ''}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('上游没有返回内容');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 有些模型会包一层 ```json，这里兜一下
    const m = String(content).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('上游返回的不是 JSON');
    parsed = JSON.parse(m[0]);
  }
  return normalizeResult(parsed);
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
