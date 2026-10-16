/**
 * AI 解析转发（"中间人"）
 *
 * 为什么需要它：手机上的网页不能直接调用 AI 服务（各家默认不允许网页跨域调用），
 * 把密钥放在手机里也不安全（谁翻到手机就等于拿到你的账号）。
 * 所以密钥只放在这台电脑上，由这个转发程序代手机去问 AI。
 *
 * 密钥有两种来源，优先级从高到低：
 *   1) 手机上的「AI 设置」页填的（保存在本机配置文件里，权限 0600，不回传给手机）；
 *   2) 环境变量 DEEPSEEK_API_KEY / AI_API_KEY，或密钥文件（给命令行用户备用）。
 *
 * 任何 OpenAI 兼容接口都能接（DeepSeek / 通义 / Kimi / 智谱 / OpenAI / 本地 Ollama…），
 * 服务商预设见 js/providers.js。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPreset, normalizeAiConfigInput, publicAiConfig, maskKey } from '../js/providers.js';
import { requestParse, requestPing, requestModels } from '../js/ai-core.js';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-chat';

/**
 * 配置文件放哪。
 * 默认在 ~/.dsh/（和密钥文件同一处，都在项目目录之外，不会被提交）。
 * 自检脚本可以用 FATLOSS_CONFIG_DIR 指向临时目录，避免动到用户真正的配置。
 */
export function configDir() {
  return process.env.FATLOSS_CONFIG_DIR || path.join(os.homedir(), '.dsh');
}

export function configFile() {
  return path.join(configDir(), 'fatloss-ai.json');
}

/** 读保存好的配置（手机设置页写进去的那份） */
export function loadSavedConfig() {
  try {
    const raw = fs.readFileSync(configFile(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return {
      presetId: data.presetId || 'custom',
      baseUrl: String(data.baseUrl || '').replace(/\/+$/, ''),
      model: String(data.model || ''),
      apiKey: String(data.apiKey || ''),
      updatedAt: data.updatedAt || null,
    };
  } catch {
    return null;
  }
}

/** 保存配置：文件权限 0600，只有本人可读 */
export function saveConfig(config) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configFile();
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* 某些文件系统不支持，忽略 */ }
  return { file, mode: (fs.statSync(file).mode & 0o777).toString(8) };
}

/** 清空配置（只删我们自己的配置文件，不碰别的） */
export function clearSavedConfig() {
  try { fs.unlinkSync(configFile()); return true; } catch { return false; }
}

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

/**
 * 当前生效的配置（含密钥，仅服务端内部使用）。
 * 优先级：手机上保存的配置 > 环境变量/密钥文件。
 */
export function aiConfig(root) {
  const saved = loadSavedConfig();
  if (saved && saved.apiKey && saved.baseUrl && saved.model) {
    return {
      configured: true,
      from: '手机上的 AI 设置',
      presetId: saved.presetId,
      baseUrl: saved.baseUrl.replace(/\/$/, ''),
      model: saved.model,
      key: saved.apiKey,
    };
  }
  const found = readApiKey(root);
  return {
    configured: Boolean(found),
    from: found?.from || null,
    presetId: process.env.AI_PRESET_ID || null,
    baseUrl: (process.env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
    model: process.env.AI_MODEL || DEFAULT_MODEL,
    key: found?.key || null,
  };
}

/** 给手机看的配置状态（掩码，无密钥） */
export function aiConfigStatus(root) {
  const saved = loadSavedConfig();
  const env = readApiKey(root);
  const active = aiConfig(root);
  return {
    configured: active.configured,
    source: active.configured ? (saved?.apiKey ? 'saved' : 'env') : null,
    from: active.from,
    model: active.model,
    baseUrl: active.baseUrl,
    saved: publicAiConfig(saved),
    envAvailable: Boolean(env),
    configFile: configFile(),
  };
}

/** 把手机提交的设置存下来（先校验，再落盘） */
export function saveConfigFromInput(input, root) {
  const existing = loadSavedConfig();
  const { config, problems } = normalizeAiConfigInput(input, existing);
  if (problems.length) return { ok: false, problems };
  const written = saveConfig(config);
  return { ok: true, config, file: written.file, mode: written.mode, masked: maskKey(config.apiKey) };
}

/**
 * 调上游 AI。解析逻辑在 js/ai-core.js（和浏览器直连共用一份，避免两边跑偏），
 * 这里只负责把「本机保存的配置」递进去。
 */
export async function callUpstream({ text, meal, hour, config, fetchImpl = fetch }) {
  return requestParse({
    text,
    meal,
    hour,
    config: { baseUrl: config.baseUrl, model: config.model, apiKey: config.key },
    fetchImpl,
  });
}

/** 连通性测试：真发一次最小请求，错误信息已经是中文 */
export async function testConnection({ fetchImpl = fetch } = {}) {
  const cfg = aiConfig(process.cwd());
  if (!cfg.configured) return { ok: false, error: '还没填密钥' };
  try {
    const r = await requestPing({ config: { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.key }, fetchImpl });
    return { ok: true, model: cfg.model, baseUrl: cfg.baseUrl, reply: r.reply };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 让电脑代问「这家有哪些模型」（给不允许浏览器直连的服务商兜底） */
export async function listModelsFor({ baseUrl, apiKey } = {}, { fetchImpl = fetch } = {}) {
  const cfg = aiConfig(process.cwd());
  const useBase = String(baseUrl || cfg.baseUrl || '').trim();
  const useKey = apiKey !== undefined && apiKey !== '' ? apiKey : cfg.key;
  if (!useBase) return { ok: false, error: '没有接口地址' };
  try {
    const models = await requestModels({ baseUrl: useBase, apiKey: useKey, fetchImpl });
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export { normalizeResult, buildSystemPrompt } from '../js/ai-core.js';
