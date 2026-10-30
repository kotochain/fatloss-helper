/**
 * AI 服务商预设
 *
 * 用户只需要「选一家、贴一个密钥」，其他都由这里带出来。
 * 所有预设都是 OpenAI 兼容接口（/chat/completions + /models），所以只有一套调用代码。
 *
 * directCall 表示「浏览器能不能直接调这家」——我用 OPTIONS 预检 + 实际 POST 实测过。
 * 允许的话，手机可以完全不依赖电脑上的中转服务；不允许的只能走中转（或本地模型）。
 * 这一栏会直接决定用户看到的是「填个密钥就能用」还是「还要在电脑上开中转」，
 * 所以**允许/不允许都必须是实测过的**，不能凭印象。下次复核时间见各条的 verifiedAt。
 */

export const PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    // 2026-10-27 按官方文档更新：deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用；
    // 现在可用的是 deepseek-flash（v4.1，能看图、官方推荐 JSON）和 deepseek-v4-pro。
    // V4 默认开思考模式，请求里会显式传 thinking: disabled（js/ai-core.js#providerExtras），
    // 否则正文会被 reasoning_content 占空（2026-10-21 实测过这个坑）。
    note: '国内直连、便宜、中文理解好，也能看照片（拍照读营养成分表可用）。一次解析大约几厘钱，充 10 块能用很久。',
    recommended: true,
    directCall: true,
    verifiedAt: '2026-10-16',
  },
  {
    id: 'dashscope',
    name: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/',
    note: '阿里云，新用户有免费额度，qwen-turbo 更便宜。',
    directCall: true,
    verifiedAt: '2026-10-16',
  },
  {
    id: 'moonshot',
    name: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: '中文长文本强，日常对话够用。',
    directCall: true,
    verifiedAt: '2026-10-16',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: 'glm-4-flash 有免费额度，适合先试。',
    // 2026-10-20 复核：OPTIONS 预检 + 无密钥 POST 都回 access-control-allow-origin，
    // 也就是浏览器可以直连。之前记成「不允许直连」是错的，会让用户白搭一套中转服务。
    directCall: true,
    verifiedAt: '2026-10-20',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '一家聚合了很多开源模型，部分模型免费。',
    directCall: true,
    verifiedAt: '2026-10-16',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '需要国外网络环境和国外支付方式，国内一般用不上。浏览器直连会把密钥暴露给页面，只建议自己用。',
    directCall: true,
    directCallCaution: true,
    verifiedAt: '2026-10-16',
  },
  {
    id: 'ollama',
    name: '本地模型（Ollama 等）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    keyUrl: 'https://ollama.com/download',
    note: '完全免费、数据不出本机，但要在电脑上先装好模型（几个 GB），速度取决于电脑。密钥随便填（例如 ollama）。',
    allowEmptyKey: true,
    directCall: true,
    needsLocalHost: true,
  },
  {
    id: 'custom',
    name: '自定义（其它 OpenAI 兼容接口）',
    baseUrl: '',
    model: '',
    keyUrl: null,
    note: '填接口地址（通常以 /v1 结尾）、模型名和密钥。公司内部网关、自建服务都可以。',
    directCall: true, // 自定义地址无法预判，先按能直连处理，失败时会给出提示
    unknownCors: true,
  },
];

/**
 * 拼出「获取模型列表」的地址。
 * OpenAI 兼容接口基本都是 GET {baseUrl}/models。
 */
export function modelsUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/models`;
}

/**
 * 从接口返回里解析出模型名列表，并按「优先推荐」排序。
 *
 * 排序规则（这是「默认模型过时」这个问题的解法）：
 *   1) 排除和本工具无关的（embedding / 语音 / 图像 / 审核）；
 *   2) 带 legacy / old / deprecated / preview / beta / 日期后缀的降级（老版本排后面）；
 *   3) 名字里带 chat / instruct / pro / max / turbo / plus 的升级（更适合对话）；
 *   4) 最后按名字倒序 —— 多数厂商用 v3 > v2 这种编号，倒序能把新一代排前面。
 */
export function parseModelsResponse(data) {
  const raw = Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.models) ? data.models
      : Array.isArray(data) ? data : [];
  const names = [];
  for (const m of raw) {
    const id = typeof m === 'string' ? m : (m?.id || m?.name || m?.model);
    if (typeof id === 'string' && id.trim()) names.push(id.trim());
  }
  const uniq = [...new Set(names)];
  // 和本工具无关的：向量、语音、图像、审核
  const IRRELEVANT = /embed|rerank|whisper|tts|speech|audio|dall|image|(^|[-_/])vl([-_/]|$)|vision|omni|moderation|ocr|video/i;
  // 老版本 / 预览版
  const STALE = /legacy|deprecated|\bold\b|preview|beta|experimental|snapshot|\d{4}[-_]?\d{2}[-_]?\d{2}|-0\d{3}|-date/i;
  // 轻量快模型最适合这个场景（一句话解析，要快、要便宜）
  const FAST = /chat|instruct|turbo|flash|mini|lite|air|small|plus/i;
  // 推理模型能用但更慢更贵，不该当默认
  const SLOW = /reasoner|reasoning|thinking|think|(^|[-_/])r1([-_/]|$)|(^|[-_/])o[13]([-_/]|$)/i;

  const score = (n) => {
    if (IRRELEVANT.test(n)) return -100;
    let s = 0;
    if (STALE.test(n)) s -= 10;
    if (SLOW.test(n)) s -= 3;
    if (FAST.test(n)) s += 4;
    return s;
  };
  return uniq.sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    // 同分按名字倒序：多数厂商用 v3 / v2 这种编号，倒序能把新一代排前面
    return b.localeCompare(a);
  });
}

export function findPreset(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS.find((p) => p.id === 'custom');
}

/**
 * 拍照读表实际用哪个模型：单独填了就用它，没填跟随解析用的模型。
 *
 * 为什么单独成一个函数：这条规则一旦写反（例如没填时返回空、或者反过来把解析也换成看图模型），
 * 用户看到的是「换个便宜模型以后读表就坏了」，很难一眼看出问题。抽出来就能被测试守住。
 */
export function labelVisionModel(config) {
  const own = String(config?.visionModel || '').trim();
  return own || String(config?.model || '').trim();
}

/** 密钥掩码：只留头尾，用来在界面上确认「填的是哪一个」，同时不泄露完整内容 */
export function maskKey(key) {
  if (!key) return '';
  const s = String(key).trim();
  if (s.length <= 10) return `${s.slice(0, 2)}${'*'.repeat(Math.max(4, s.length - 2))}`;
  return `${s.slice(0, 5)}${'*'.repeat(6)}${s.slice(-4)}`;
}

/** 把用户填的内容收敛成一份干净的配置 */
export function normalizeAiConfigInput(input = {}, existing = null) {
  const preset = findPreset(input.presetId || existing?.presetId || 'custom');
  const baseUrl = String(input.baseUrl ?? existing?.baseUrl ?? preset.baseUrl ?? '').trim().replace(/\/+$/, '');
  const model = String(input.model ?? existing?.model ?? preset.model ?? '').trim();
  // 拍照读表用的看图模型：留空 = 跟随上面的 model（这是默认，也是最省事的用法）。
  // 「留空则跟随」必须能真的留空 —— 所以空串也当「清掉」，不能退回旧值。
  const askedVision = String(input.visionModel ?? existing?.visionModel ?? '').trim();
  // 「留空则不改」是输入框上写着的承诺 —— 空串（以及只有空格）和「没传」都是留空。
  // 以前这里只认 undefined，而界面拿到的是 ''，于是用户清空输入框点保存会看到「密钥没填」。
  const askedKey = input.apiKey === undefined || input.apiKey === null
    ? ''
    : String(input.apiKey).trim();
  // 但换了服务商就不能沿用上一家的密钥：DeepSeek 的钥匙递给通义，既用不了，也等于泄露给第三方
  const presetChanged = Boolean(existing?.apiKey && existing.presetId && preset.id !== existing.presetId);
  const apiKey = askedKey || (presetChanged ? '' : (existing?.apiKey || ''));
  const problems = [];
  if (!baseUrl) problems.push('接口地址没填');
  else if (!/^https?:\/\//.test(baseUrl)) problems.push('接口地址要以 http:// 或 https:// 开头');
  if (!model) problems.push('模型名没填');
  if (!apiKey && !preset.allowEmptyKey) {
    problems.push(presetChanged ? '换了服务商，密钥要重新填（不会沿用上一家的）' : '密钥没填');
  }
  const mode = input.mode === 'relay' || input.mode === 'direct'
    ? input.mode
    : (existing?.mode || (preset.directCall === false ? 'relay' : 'direct'));
  return {
    config: {
      presetId: preset.id,
      baseUrl,
      model,
      // 换服务商时同样不能沿用上一家的模型名（那家的模型名在别家不存在，填着就是必然报错）
      visionModel: presetChanged ? '' : askedVision,
      apiKey,
      mode,
      updatedAt: new Date().toISOString(),
    },
    problems,
  };
}

/** 给界面用的安全版本：绝不包含密钥本身 */
export function publicAiConfig(config) {
  if (!config) {
    return { configured: false, presetId: null, presetName: null, baseUrl: null, model: null, visionModel: null, keyMasked: null, updatedAt: null };
  }
  const preset = findPreset(config.presetId);
  return {
    configured: Boolean(config.apiKey && config.baseUrl && config.model),
    presetId: preset.id,
    presetName: preset.name,
    baseUrl: config.baseUrl || null,
    model: config.model || null,
    // null = 没单独配，拍照读表跟 model 用同一个（界面上不要显示成「空」）
    visionModel: config.visionModel || null,
    keyMasked: maskKey(config.apiKey),
    mode: config.mode || (preset.directCall === false ? 'relay' : 'direct'),
    directCall: preset.directCall !== false,
    updatedAt: config.updatedAt || null,
  };
}
