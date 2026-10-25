/**
 * 今天页的「顺手做两件事」（v36，issue #14 的 A）
 *
 * 目的：给「每天为什么打开」一个具体理由 —— 不是一个空页面 + 一堆数字，
 * 而是「现在可以顺手做的一两件事」，点一下就能动手。
 *
 * 设计约束（别改坏）：
 *  - **全部本地算**：不联网、不请求 AI、不推送；
 *  - **最多两条**：宁可少说，凑不出值得做的事就整张卡不显示；
 *  - **不指责、不施压**：不说「应该」「必须」「失败」「还差劲」，只给能做的下一步；
 *  - **和「接住」卡不重复**：今天一笔都没记时由接住卡负责（见 achievements.dailyNudge），这里返回空；
 *  - **不伪造数据**：所有数字来自当天记录与 calcTargets，不猜、不编。
 */
import { diffAgainstTargets } from './calc.js';
import { suggestFoods } from './coach.js';
import { todayKey } from './store.js';

const HOUR = (now) => (now instanceof Date ? now.getHours() : Number(now?.hour ?? 12));

/** 某一天记了几笔（食物 + 运动）—— 只读，绝不新建空日子 */
function entriesOn(state, key) {
  const day = state?.days?.[key];
  if (!day?.meals) return [];
  return Object.values(day.meals).flat();
}

/** 上次称体重是几天前；从没称过返回 null */
function daysSinceWeight(state, today) {
  const list = Array.isArray(state?.weights) ? state.weights : [];
  if (!list.length) return null;
  const last = list.map((w) => w.date).filter(Boolean).sort().pop();
  if (!last) return null;
  const [y, m, d] = last.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const diff = Math.round((new Date(ty, tm - 1, td) - new Date(y, m - 1, d)) / 86400000);
  return Number.isFinite(diff) ? diff : null;
}

/**
 * 算出今天可以顺手做的事。
 *
 * @param {{state:object, totals:object, targets:object, today?:string, now?:Date}} input
 * @returns {Array<{key:string, title:string, text:string, action?:string, payload?:object}>} 0~2 条
 */
export function nextSteps({ state, totals, targets, today = todayKey(), now = new Date() } = {}) {
  if (!state || !targets || !totals) return [];
  // 今天一笔都没记：交给「接住」卡（不要同一件事说两遍）
  if (entriesOn(state, today).length === 0) return [];

  const hour = HOUR(now);
  const diff = diffAgainstTargets(totals, targets);
  const remaining = Math.round(diff.find((d) => d.key === 'kcal')?.remaining ?? 0);
  const gap = Math.max(0, Math.round(diff.find((d) => d.key === 'protein')?.remaining ?? 0));

  const candidates = [];

  // 1) 晚饭：只有傍晚到夜里、而且今天已经记过别的的时候才提（早上提晚饭很莫名其妙）
  const day = state.days?.[today];
  const dinnerLogged = (day?.meals?.dinner || []).length > 0;
  const earlierLogged = (day?.meals?.breakfast || []).length > 0 || (day?.meals?.lunch || []).length > 0;
  if (hour >= 18 && !dinnerLogged && earlierLogged) {
    candidates.push({
      key: 'dinner',
      title: '晚饭还没记',
      text: '吃完顺手记一笔，今天的数字才完整。',
      action: 'quick-fill',
      payload: { meal: 'dinner' },
    });
  }

  // 2) 蛋白质 / 额度：这是减脂最核心的一件事，给具体到克数的建议
  const suggestions = suggestFoods({ remainingKcal: remaining, proteinGap: gap });
  if (remaining > 0 && gap > 10) {
    const options = suggestions.length
      ? suggestions.map((s) => `${s.name} ${s.grams} 克（蛋白 ${s.protein} 克）`).join(' 或 ')
      : '一杯无糖酸奶或两个鸡蛋都行';
    const first = suggestions[0];
    candidates.push({
      key: 'protein',
      title: '把蛋白质补上',
      text: `还差约 ${gap} 克。今天还有 ${remaining} kcal 额度，可以顺手来一份：${options}。`,
      action: first ? 'quick-fill' : null,
      payload: first ? { text: `${first.name} ${first.grams} 克` } : undefined,
    });
  } else if (remaining <= 0) {
    candidates.push({
      key: 'full',
      title: '今天额度用完了',
      text: gap > 20
        ? `蛋白质还差约 ${gap} 克，明天可以早餐加两个蛋、午餐主菜加大一点。`
        : '如果还饿，黄瓜、番茄、无糖酸奶这类几乎不占额度的东西可以吃。',
    });
  } else if (gap <= 10 && remaining > 400) {
    candidates.push({
      key: 'room',
      title: '蛋白质已经够了',
      text: `还有 ${remaining} kcal 额度，加一份主食和蔬菜，别让缺口太大 —— 饿过头第二天容易报复性吃。`,
    });
  } else if (gap <= 10) {
    candidates.push({
      key: 'ok',
      title: '今天安排得不错',
      text: `蛋白质基本够了，还剩 ${remaining} kcal，用水果或酸奶收尾就行。`,
    });
  }

  // 3) 体重：超过 7 天没称（或从没称过、且已经记了几天）才提；刚称过绝不催
  const since = daysSinceWeight(state, today);
  const loggedDays = Object.keys(state.days || {}).filter((k) => entriesOn(state, k).length > 0).length;
  const weighDue = since === null ? loggedDays >= 2 : since >= 7;
  if (weighDue) {
    candidates.push({
      key: 'weigh',
      title: '称个体重',
      text: since === null
        ? '固定条件称一次（早起、空腹、同样衣服），之后看趋势才准。'
        : `上次称是 ${since} 天前了。固定条件称一次，趋势才准。`,
      action: 'log-weight',
    });
  }

  // 早上最适合称重：把称重放到第一条（人站在秤上再打开 App 很自然）
  if (hour < 10) {
    const wi = candidates.findIndex((c) => c.key === 'weigh');
    if (wi > 0) candidates.unshift(...candidates.splice(wi, 1));
  }

  return candidates.slice(0, 2);
}

/** 卡片标题：一条/两条说法不同（不写「两件事」却只给一条） */
export function nextStepsTitle(count) {
  if (count <= 0) return '';
  return count === 1 ? '今天可以顺手做一件事' : '今天可以顺手做两件事';
}
