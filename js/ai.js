/**
 * 饮食描述的解析接口（客户端侧）
 *
 * 分工：
 *  - AI 负责「听懂她说的是什么、大概多少量」；
 *  - 热量一律由本地食物库算（ai-parse 服务端只返回名字和克数，不返回热量），
 *    这样数字能核对、能离线复算，也不会出现模型随口编一个热量。
 *
 * AI 不可用时（没配密钥、断网、手机不在同一个 Wi-Fi）自动退回离线解析。
 */

const AI_ENDPOINT = '/api/parse-meal';

/** 问服务端「AI 到底配好了没」，失败就当没配 */
export async function aiStatus(timeoutMs = 2500) {
  try {
    const res = await fetch('/api/ai-status', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { configured: false, reason: `服务返回 ${res.status}` };
    return await res.json();
  } catch (err) {
    return { configured: false, reason: '连不上解析服务（可能没开着，或者手机不在同一个 Wi-Fi）' };
  }
}

/**
 * 把一句话交给 AI 解析
 * @param {string} text 她说的话
 * @param {{meal?:string, hour?:number}} ctx
 * @returns {Promise<{ok:boolean, items?:Array, meal?:string, questions?:string[], error?:string}>}
 */
export async function askAi(text, ctx = {}, timeoutMs = 25000) {
  try {
    const res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, meal: ctx.meal || null, hour: ctx.hour ?? new Date().getHours() }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, error: data?.error || `解析服务返回 ${res.status}` };
    }
    if (!data || !Array.isArray(data.items)) {
      return { ok: false, error: '解析结果格式不对' };
    }
    return { ok: true, items: data.items, meal: data.meal || null, questions: data.questions || [] };
  } catch (err) {
    const msg = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? 'AI 响应太慢（超过 25 秒）'
      : '连不上解析服务（检查电脑上是否开着服务、手机是否在同一个 Wi-Fi）';
    return { ok: false, error: msg };
  }
}

/** 读设置页需要的信息（当前状态 + 服务商预设；服务端只回掩码，不回密钥） */
export async function loadAiConfig(timeoutMs = 4000) {
  try {
    const res = await fetch('/api/ai-config', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `服务返回 ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, error: '连不上解析服务（电脑上的服务没开，或者手机不在同一个 Wi-Fi）' };
  }
}

/** 保存设置。密钥只发给本机服务，不发给 AI 厂商，也不留在手机里 */
export async function saveAiConfig(input, timeoutMs = 8000) {
  try {
    const res = await fetch('/api/ai-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `保存失败（${res.status}）` };
    return { ok: true, data };
  } catch {
    return { ok: false, error: '保存失败：连不上电脑上的服务' };
  }
}

/** 清空设置在电脑上保存的密钥 */
export async function clearAiConfig(timeoutMs = 8000) {
  try {
    const res = await fetch('/api/ai-config', { method: 'DELETE', signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `清除失败（${res.status}）` };
    return { ok: true, data };
  } catch {
    return { ok: false, error: '清除失败：连不上电脑上的服务' };
  }
}

/** 让电脑代测一下能不能连上服务商 */
export async function testAiConnection(timeoutMs = 30000) {
  try {
    const res = await fetch('/api/ai-config/test', { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...data } : { ok: false, error: data.error || `测试失败（${res.status}）` };
  } catch (err) {
    const msg = err?.name === 'TimeoutError' ? '测试超时（等了 30 秒）' : '连不上电脑上的服务';
    return { ok: false, error: msg };
  }
}

/** 是否需要问「大概多大碗」这类追问：AI 说需要、或本地判断需要 */
export function needsPortionQuestion(items) {
  return items.some((it) => it.needsConfirm || it.portionUnclear);
}
