/**
 * AI 配置的存取（纯逻辑，可测试）
 *
 * 设计取舍（2026-10-16 改）：
 *   上一版把密钥发到电脑上的中转服务保存，理由是「手机丢了也不泄露」。
 *   实际使用中这带来一个更大的问题：必须开着电脑、手机还得同一个 Wi-Fi。
 *   现在改成：密钥存在这台手机上（浏览器本地存储），手机直接调服务商，
 *   不需要电脑、不需要服务器，走到哪都能用。
 *   代价是「手机丢了 = 密钥可能泄露」——所以界面上要能随时清除密钥，
 *   并且提供「用中转服务」的选项给在意这一点的人。
 */

export const AI_CONFIG_KEY = 'fatloss.ai.v1';

/** 浏览器用 localStorage；测试时传一个假的进来 */
export function defaultStorage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* 隐私模式等情况下会抛错 */ }
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

export function readAiConfig(storage = defaultStorage()) {
  try {
    const raw = storage.getItem(AI_CONFIG_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (!data.baseUrl || !data.model) return null;
    return {
      presetId: data.presetId || 'custom',
      baseUrl: String(data.baseUrl).replace(/\/+$/, ''),
      model: String(data.model),
      // 拍照读表专用的看图模型：空串 = 跟随 model（老配置里没有这一栏，读出来就是空）
      visionModel: String(data.visionModel || '').trim(),
      apiKey: String(data.apiKey || ''),
      mode: data.mode === 'relay' ? 'relay' : 'direct',
      updatedAt: data.updatedAt || null,
    };
  } catch {
    return null;
  }
}

export function writeAiConfig(config, storage = defaultStorage()) {
  storage.setItem(AI_CONFIG_KEY, JSON.stringify({
    presetId: config.presetId || 'custom',
    baseUrl: String(config.baseUrl).replace(/\/+$/, ''),
    model: config.model,
    visionModel: String(config.visionModel || '').trim(),
    apiKey: config.apiKey || '',
    mode: config.mode === 'relay' ? 'relay' : 'direct',
    updatedAt: new Date().toISOString(),
  }));
  return readAiConfig(storage);
}

export function clearAiConfig(storage = defaultStorage()) {
  storage.removeItem(AI_CONFIG_KEY);
  return readAiConfig(storage);
}
