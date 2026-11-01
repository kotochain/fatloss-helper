/**
 * AI 门面：界面只跟这个文件打交道
 *
 * 两条路径，按设置自动选：
 *   1) 直连：密钥存在这台手机上，浏览器直接调服务商（默认，不需要电脑）
 *   2) 中转：如果你自己起了 tools/serve.mjs，可以把密钥交给它保管，手机只发内容
 *
 * 没配密钥时**一个请求都不发**，界面直说「还没配置 AI」并指路配置 ——
 * 产品没有「离线解析」这条路（v42 删掉普通模式，v43 把解析代码也删了）。
 */

import { publicAiConfig, normalizeAiConfigInput, findPreset, labelVisionModel } from './providers.js';
import { readAiConfig, writeAiConfig, clearAiConfig, defaultStorage } from './ai-config.js';
import { requestParse, requestPing, requestModels, requestLabelParse, requestCoach } from './ai-core.js';

export { readAiConfig, writeAiConfig, clearAiConfig };

/** 当前配置「给界面看」的版本（只有掩码，没有密钥） */
export function currentAiConfig() {
  return publicAiConfig(readAiConfig());
}

/** 把设置保存到这台手机，返回给界面看的版本 */
export function saveAiConfigLocal(input) {
  const existing = readAiConfig();
  const { config, problems } = normalizeAiConfigInput(input, existing);
  if (problems.length) return { ok: false, problems };
  writeAiConfig(config);
  return { ok: true, config: publicAiConfig(readAiConfig()) };
}

/** 本机服务（中转）在不在、配没配。没起服务时立刻返回，不卡界面 */
export async function relayStatus(timeoutMs = 2000) {
  try {
    const res = await fetch('/api/ai-status', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { available: false, configured: false };
    const data = await res.json();
    return { available: true, configured: Boolean(data.configured), model: data.model || null };
  } catch {
    return { available: false, configured: false };
  }
}

/**
 * 给界面用的状态汇总。
 *
 * v52 把两件事拆开了（以前混成一个 configured）：
 *   · saved —— 本机有没有存着配置（能不能「试一次」）
 *   · ok    —— 上次检查的结论：true 通了 / false 没通 / null 还没试过
 *
 * 为什么要拆：密钥明明存着、只是那一次没连上，界面却写「还没配 AI」，
 * 用户会以为白填了、跑去重新配一遍；而「我的」页同一个时刻又说「已开启」，
 * 两页各说一套（评估里被点出来的那条）。
 */
export async function aiStatus() {
  const local = currentAiConfig();
  if (local.mode === 'relay') {
    const relay = await relayStatus();
    if (relay.configured) {
      return { saved: true, ok: true, mode: 'relay', model: relay.model || local.model, presetName: local.presetName };
    }
    return {
      saved: Boolean(local.baseUrl || local.model),
      ok: false,
      mode: 'relay',
      model: local.model || null,
      presetName: local.presetName,
      reason: '设置成「走中转服务」，但电脑上的服务没开或没配密钥',
    };
  }
  if (local.configured) {
    // 直连配好了，但启动时不花一次请求去测 —— ok 留 null 表示「还没试过」，
    // 界面就写「已开启」而不是假装知道通不通。
    return { saved: true, ok: null, mode: 'direct', model: local.model, presetName: local.presetName };
  }
  return { saved: false, ok: null, mode: local.mode || null, presetName: local.presetName, reason: '还没配置 AI' };
}

/**
 * AI 状态 → 一句人话。记录页那个小胶囊、我的页、设置页共用这一份判断，
 * 免得同一个时刻三处各说一套（以前「还没配 AI」和「已开启」会同时出现在两页）。
 *
 * @param {{saved?:boolean, ok?:boolean|null}} state
 * @returns {{text:string, short:string, tone:'idle'|'ok'|'bad'}}
 */
export function aiLabelOf(state = {}) {
  if (!state.saved) return { text: '还没配 AI', short: '去配置', tone: 'idle' };
  if (state.ok === false) return { text: 'AI 连不上', short: '连不上', tone: 'bad' };
  return { text: 'AI 已开启', short: '已开启', tone: 'ok' };
}

/**
 * 拍一张营养成分表 -> 把数字读出来（只支持直连）。
 *
 * 为什么只支持直连：电脑上的中转服务只转发「文字解析」那一个接口，图片不经过它。
 * 返回的是**原始读数**（可能带千焦），单位换算、对账、保存都由界面那层做，用户确认后才落库。
 */
export async function readLabelImage(imageDataUrl) {
  const local = readAiConfig();
  const configured = Boolean(local?.baseUrl && local?.model && local?.apiKey);
  if (!configured) {
    return { ok: false, error: '还没配置 AI。可以手动照包装填，数字一样准。' };
  }
  if (local.mode === 'relay') {
    return { ok: false, error: '拍照读表需要「手机直连」模式（图片不经过电脑中转）。也可以手动填。' };
  }
  /*
   * 用哪个模型：设置里单独填了「拍照读表用的模型」就用它，没填就跟解析用同一个。
   * 为什么需要单独一个：解析要快、要便宜（文字模型足够），读表必须能看图 ——
   * 两者共用一个模型时，用户只能二选一：配便宜的读不了表，配能看图的解析又慢又贵。
   */
  const model = labelVisionModel(local);
  const separate = Boolean(local.visionModel) && local.visionModel !== local.model;
  try {
    const r = await requestLabelParse({
      imageDataUrl,
      config: { baseUrl: local.baseUrl, model, apiKey: local.apiKey },
    });
    return { ok: true, model, ...r };
  } catch (err) {
    const msg = String(err?.message || '');
    // 单独配的看图模型自己也看不了图时说清楚是「哪一栏」要改，别让用户去猜
    if (separate && /看不了图片/.test(msg)) {
      return { ok: false, error: `${msg}（设置里「拍照读表用的模型」填的是 ${model}；换成能看图的，或者清空它，就会跟着「${local.model}」走）` };
    }
    return { ok: false, error: err.message };
  }
}

/**
 * 解析一句话。
 * @returns {Promise<{ok:boolean, items?:Array, meal?:string|null, questions?:string[], source?:string, error?:string, note?:string}>}
 */
export async function askAi(text, ctx = {}, timeoutMs = 30000) {
  const local = readAiConfig();
  const hour = ctx.hour ?? new Date().getHours();
  const mode = local?.mode || 'direct';

  // 路径 1：直连（默认）
  if (mode === 'direct' && local?.baseUrl && local?.model) {
    try {
      const r = await requestParse({
        text,
        meal: ctx.meal || null,
        hour,
        config: { baseUrl: local.baseUrl, model: local.model, apiKey: local.apiKey },
      });
      return { ok: true, source: 'direct', ...r };
    } catch (err) {
      // 直连失败时，如果本机碰巧有中转服务，就兜一次（例如这家不允许浏览器直连）
      const relay = await relayStatus(1500);
      if (relay.available && relay.configured) {
        const viaRelay = await askViaRelay(text, { meal: ctx.meal, hour }, timeoutMs);
        if (viaRelay.ok) return { ...viaRelay, note: `直连没成功（${err.message}），这次走了电脑上的中转服务` };
      }
      return { ok: false, error: err.message };
    }
  }

  // 路径 2：中转
  if (mode === 'relay') {
    const viaRelay = await askViaRelay(text, { meal: ctx.meal, hour }, timeoutMs);
    return viaRelay.ok ? viaRelay : { ok: false, error: viaRelay.error };
  }

  return { ok: false, error: '还没配置 AI' };
}

/**
 * 让 AI 把教练建议说得更像人话。
 *
 * 输入是 js/coach.js 算好的事实清单（数字都在里面），输出只是一段文字。
 * **调用方必须再用 checkCoachText 过一遍** —— 模型编数字是这个功能唯一的真风险。
 * @returns {Promise<{ok:boolean, text?:string, source?:string, error?:string}>}
 */
export async function askCoach(brief) {
  const local = readAiConfig();
  const mode = local?.mode || 'direct';

  if (mode === 'direct' && local?.baseUrl && local?.model) {
    try {
      const r = await requestCoach({
        brief,
        config: { baseUrl: local.baseUrl, model: local.model, apiKey: local.apiKey },
      });
      return { ok: true, source: 'direct', text: r.text };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (mode === 'relay') {
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, error: data?.error || `中转服务返回 ${res.status}` };
      if (!data?.text) return { ok: false, error: '中转服务返回的格式不对' };
      return { ok: true, source: 'relay', text: String(data.text) };
    } catch (err) {
      const msg = err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? 'AI 响应太慢（超过 30 秒）'
        : '连不上中转服务';
      return { ok: false, error: msg };
    }
  }

  return { ok: false, error: '还没配置 AI' };
}

async function askViaRelay(text, ctx, timeoutMs = 30000) {
  try {
    const res = await fetch('/api/parse-meal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, meal: ctx.meal || null, hour: ctx.hour }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: data?.error || `中转服务返回 ${res.status}` };
    if (!data || !Array.isArray(data.items)) return { ok: false, error: '中转服务返回的格式不对' };
    return { ok: true, source: 'relay', items: data.items, meal: data.meal || null, questions: data.questions || [] };
  } catch (err) {
    const msg = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? 'AI 响应太慢（超过 30 秒）'
      : '连不上中转服务';
    return { ok: false, error: msg };
  }
}

/** 测试连通：直连就直接测；走中转时让电脑代测 */
export async function testConnection() {
  const local = readAiConfig();
  const mode = local?.mode || 'direct';
  if (mode === 'direct' && local?.baseUrl && local?.model) {
    try {
      const r = await requestPing({ config: { baseUrl: local.baseUrl, model: local.model, apiKey: local.apiKey } });
      return { ok: true, via: 'direct', model: local.model, baseUrl: local.baseUrl, reply: r.reply };
    } catch (err) {
      const relay = await relayStatus(1500);
      if (relay.available && relay.configured) {
        const viaRelay = await fetch('/api/ai-config/test', { method: 'POST' }).then((r) => r.json()).catch(() => null);
        if (viaRelay?.ok) return { ...viaRelay, via: 'relay', note: `直连没成功（${err.message}），但电脑上的中转服务是通的` };
      }
      return { ok: false, error: err.message };
    }
  }
  const res = await fetch('/api/ai-config/test', { method: 'POST' }).catch(() => null);
  if (!res) return { ok: false, error: '连不上中转服务（电脑上的服务没开）' };
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, via: 'relay', ...data } : { ok: false, error: data.error || `测试失败（${res.status}）` };
}

/**
 * 获取这家服务商的模型列表。
 * 直连模式直接问服务商；问不到时交给中转（有些服务不允许浏览器读模型列表）。
 */
export async function fetchModels({ baseUrl, apiKey } = {}) {
  const local = readAiConfig();
  const useBase = String(baseUrl || local?.baseUrl || '').trim();
  const useKey = apiKey !== undefined ? apiKey : (local?.apiKey || '');
  if (!useBase) return { ok: false, error: '先填接口地址' };
  try {
    const models = await requestModels({ baseUrl: useBase, apiKey: useKey });
    return { ok: true, models, via: 'direct' };
  } catch (err) {
    try {
      const res = await fetch('/api/ai-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: useBase, apiKey: useKey }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.models) && data.models.length) return { ok: true, models: data.models, via: 'relay' };
      }
    } catch { /* 中转也不可用，返回直连时的原始错误 */ }
    return { ok: false, error: err.message };
  }
}

/** 这家预设是否支持浏览器直连（界面上要提示清楚） */
export function presetDirectCall(presetId) {
  return findPreset(presetId).directCall !== false;
}

export { defaultStorage };
