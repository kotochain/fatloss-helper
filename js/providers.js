/**
 * AI 服务商预设
 *
 * 用户只需要「选一家、贴一个密钥」，其他（接口地址、模型名、是否需要额外参数）都由这里带出来。
 * 所有预设都是 OpenAI 兼容接口（/chat/completions），所以转发层只有一套代码。
 *
 * 价格写的是量级估计，用于让用户判断「贵不贵」，不要当成精确报价。
 */

export const PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '国内直连、便宜、中文理解好。一次解析大约几厘钱，充 10 块能用很久。',
    recommended: true,
  },
  {
    id: 'dashscope',
    name: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/',
    note: '阿里云，新用户有免费额度，qwen-turbo 更便宜。',
  },
  {
    id: 'moonshot',
    name: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: '中文长文本强，日常对话够用。',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: 'glm-4-flash 有免费额度，适合先试。',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '一家聚合了很多开源模型，部分模型免费。',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '需要国外网络环境和国外支付方式，国内一般用不上。',
  },
  {
    id: 'ollama',
    name: '本地模型（Ollama 等）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    keyUrl: 'https://ollama.com/download',
    note: '完全免费、数据不出本机，但要在电脑上先装好模型（几个 GB），速度取决于电脑。密钥随便填（例如 ollama）。',
    allowEmptyKey: true,
  },
  {
    id: 'custom',
    name: '自定义（其它 OpenAI 兼容接口）',
    baseUrl: '',
    model: '',
    keyUrl: null,
    note: '填接口地址（通常以 /v1 结尾）、模型名和密钥。公司内部网关、自建服务都可以。',
  },
];

export function findPreset(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS.find((p) => p.id === 'custom');
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
  const apiKey = input.apiKey === undefined || input.apiKey === null
    ? (existing?.apiKey || '')
    : String(input.apiKey).trim();
  const problems = [];
  if (!baseUrl) problems.push('接口地址没填');
  else if (!/^https?:\/\//.test(baseUrl)) problems.push('接口地址要以 http:// 或 https:// 开头');
  if (!model) problems.push('模型名没填');
  if (!apiKey && !preset.allowEmptyKey) problems.push('密钥没填');
  return {
    config: { presetId: preset.id, baseUrl, model, apiKey, updatedAt: new Date().toISOString() },
    problems,
  };
}

/** 给界面用的安全版本：绝不包含密钥本身 */
export function publicAiConfig(config) {
  if (!config) {
    return { configured: false, presetId: null, presetName: null, baseUrl: null, model: null, keyMasked: null, updatedAt: null };
  }
  const preset = findPreset(config.presetId);
  return {
    configured: Boolean(config.apiKey && config.baseUrl && config.model),
    presetId: preset.id,
    presetName: preset.name,
    baseUrl: config.baseUrl || null,
    model: config.model || null,
    keyMasked: maskKey(config.apiKey),
    updatedAt: config.updatedAt || null,
  };
}
