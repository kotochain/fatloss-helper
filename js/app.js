/**
 * 减脂小助手 —— 界面与交互
 * 数据全部存在这台设备上（浏览器本地存储），不联网、不上传。
 */

import {
  calcTargets, calcEntry, calcExerciseKcal, diffAgainstTargets, macroSplit, macroSplit as _ms,
  defaultTargetWeight, ACTIVITY_LEVELS, GOAL_PACE, round, classifyBMI,
} from './calc.js';
import { FOODS, FOOD_CATEGORIES, findFood, parseAmount } from './foods.js';
import { searchFoods, MEAL_SLOTS, normalize } from './foodlog.js';
import { listExercises, buildWeekPlan, EXERCISES } from './exercise.js';
import { buildMealPlan, buildDailyTips } from './recommend.js';
import {
  emptyState, migrate, todayKey, shiftDate, getDay, addFoodEntry, removeFoodEntry,
  addExercise, removeExercise, addWeight, addCustomFood, weightTrend, analyzeProgress,
  demoProfile, demoEntries,
} from './store.js';

const STORAGE_KEY = 'fatloss.state.v2';
const $ = (sel, root = document) => root.querySelector(sel);

let state = load();
let view = 'today';
let dateKey = todayKey();
let planSeed = 0;
let pendingFood = null;
const app = $('#app');

/* ── 存档 ────────────────────────────────── */

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  } catch (err) {
    console.warn('存档读取失败，已忽略：', err);
    return null;
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    toast('存不进去了（浏览器存储可能满了），请到「体重」页导出备份。');
    console.error(err);
  }
}

function targets() {
  if (!state.profile) return null;
  return calcTargets(state.profile);
}

/* ── 小工具 ──────────────────────────────── */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'warn info';
  el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(96px + env(safe-area-inset-bottom));z-index:80;max-width:440px;width:calc(100% - 32px);box-shadow:0 4px 16px rgba(0,0,0,.14)';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function weekdayLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(y, m - 1, d).getDay()];
  return w;
}

function dateLabel() {
  const today = todayKey();
  if (dateKey === today) return '今天';
  if (dateKey === shiftDate(today, -1)) return '昨天';
  if (dateKey === shiftDate(today, 1)) return '明天';
  const [, m, d] = dateKey.split('-');
  return `${Number(m)}月${Number(d)}日 ${weekdayLabel(dateKey)}`;
}

function fmt(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toFixed(digits).replace(/\.0+$/, '');
}

/** 弹层 */
function openSheet({ title, body, foot = '', onMount = null }) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = body;
  $('#sheetFoot').innerHTML = foot;
  $('#sheetRoot').classList.remove('hidden');
  $('#sheetRoot').setAttribute('aria-hidden', 'false');
  if (onMount) onMount($('#sheetBody'), $('#sheetFoot'));
}

function closeSheet() {
  $('#sheetRoot').classList.add('hidden');
  $('#sheetRoot').setAttribute('aria-hidden', 'true');
  $('#sheetBody').innerHTML = '';
  $('#sheetFoot').innerHTML = '';
  pendingFood = null;
}

$('#sheetClose').addEventListener('click', closeSheet);
$('.sheet-mask').addEventListener('click', closeSheet);

/* ── 顶部与标签栏 ────────────────────────── */

$('#prevDay').addEventListener('click', () => { dateKey = shiftDate(dateKey, -1); render(); });
$('#nextDay').addEventListener('click', () => { dateKey = shiftDate(dateKey, 1); render(); });
$('#dateLabel').addEventListener('click', () => { dateKey = todayKey(); render(); });
$('#profileBtn').addEventListener('click', openProfileSheet);

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    view = btn.dataset.view;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    render();
    window.scrollTo({ top: 0 });
  });
});

/* ── 主渲染 ──────────────────────────────── */

function render() {
  $('#dateLabel').textContent = dateLabel();
  if (!state.profile && view !== 'progress') {
    renderWelcome();
    return;
  }
  if (view === 'today') renderToday();
  else if (view === 'log') renderLog();
  else if (view === 'plan') renderPlan();
  else renderProgress();
  bindCommon();
}

function bindCommon() {
  app.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', () => handleAction(el.dataset.act, el.dataset));
  });
}

function handleAction(act, data) {
  switch (act) {
    case 'add-food': return openFoodSheet(data.meal);
    case 'del-food': {
      const day = getDay(state, dateKey);
      const entry = Object.values(day.meals).flat().find((e) => e.id === data.id);
      if (entry && confirm(`删除「${entry.food.name} ${entry.grams} 克」？`)) {
        removeFoodEntry(state, dateKey, data.id);
        save();
        render();
      }
      return;
    }
    case 'add-exercise': return openExerciseSheet();
    case 'del-exercise':
      removeExercise(state, dateKey, data.id);
      save();
      render();
      return;
    case 'use-plan': return usePlanForToday();
    case 'next-plan': planSeed += 1; render(); return;
    case 'edit-profile': return openProfileSheet();
    case 'log-weight': return openWeightSheet();
    case 'export': return exportData();
    case 'import': return importData();
    case 'demo': return loadDemo();
    case 'reset-today':
      if (confirm('清空这一天的所有饮食和运动记录？（历史记录不受影响）')) {
        state.days[dateKey] = { meals: { breakfast: [], lunch: [], dinner: [], snack: [] }, exercises: [], note: '' };
        save();
        render();
      }
      return;
    default: return;
  }
}

/* ── 首次进入 ────────────────────────────── */

function renderWelcome() {
  app.innerHTML = `
    <div class="card">
      <div class="card-title">先填 6 个数字，就能算出她每天该吃多少</div>
      <p class="small muted" style="margin:0 0 12px">
        需要：性别、年龄、身高、体重、平时的活动量、想多快瘦下来。<br>
        全部只存在这台设备的浏览器里，不联网、不上传，别人看不到。
      </p>
      <button class="btn block" data-act="edit-profile">开始填写</button>
      <div class="btn-row">
        <button class="btn ghost grow" data-act="demo">看一个填好的例子</button>
      </div>
      <p class="tiny muted" style="margin:12px 0 0">
        这个工具只做估算和记录，不是医疗建议。如果她怀孕/哺乳、有甲状腺或肾脏问题、在吃影响体重的药，
        或者年龄未满 18 岁，请先问医生，不要照这里的数字吃。
      </p>
    </div>`;
}

function loadDemo() {
  state = emptyState();
  state.profile = demoProfile();
  state.settings = { trainDays: 3, stepsKey: 'mid' };
  const t = calcTargets(state.profile);
  demoEntries(state, todayKey(), t);
  addWeight(state, shiftDate(todayKey(), -14), 59.2);
  addWeight(state, todayKey(), 58);
  save();
  view = 'today';
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'today'));
  render();
  toast('已填入一份示例数据（26 岁女性 163cm 58kg），可以随便改。');
}

/* ── 今天 ────────────────────────────────── */

function renderToday() {
  const t = targets();
  if (!t) return renderWelcome();
  const day = getDay(state, dateKey);
  const entries = Object.values(day.meals).flat();
  const totals = entries.reduce((acc, e) => {
    const f = calcEntry(e.food, e.grams);
    acc.kcal += f.kcal; acc.protein += f.protein; acc.fat += f.fat; acc.carb += f.carb;
    return acc;
  }, { kcal: 0, protein: 0, fat: 0, carb: 0 });

  const exerciseKcal = day.exercises.reduce((a, x) => a + calcExerciseKcal({
    mets: EXERCISES[x.exerciseKey]?.mets ?? 4, weightKg: state.profile.weightKg, minutes: x.minutes,
  }), 0);
  const bonus = Math.round(exerciseKcal * 0.5); // 只算一半，运动消耗普遍被高估
  const budget = t.targetCalories + bonus;
  const remaining = Math.round(budget - totals.kcal);
  const pct = Math.min(100, Math.round((totals.kcal / budget) * 100));
  const cls = totals.kcal > budget * 1.05 ? 'over' : totals.kcal < budget * 0.8 ? 'under' : 'ok';
  const diff = diffAgainstTargets(totals, t);
  const split = macroSplit(totals);
  const tip = suggestNext(totals, t, remaining);

  app.innerHTML = `
    <div class="card hero state-${cls}">
      <div class="big">${remaining >= 0 ? remaining : '+' + Math.abs(remaining)}<small>kcal ${remaining >= 0 ? '还可以吃' : '已超出'}</small></div>
      <div class="sub">已吃 ${Math.round(totals.kcal)} / 目标 ${budget}${bonus ? `（含运动奖励 ${bonus}）` : ''}</div>
      <div class="progress ${cls === 'ok' ? '' : cls}"><i style="width:${pct}%"></i></div>
      <div class="macros">
        ${diff.filter((d) => d.key !== 'kcal').map((d) => `
          <div class="macro ${d.status}">
            <div class="label">${d.label}</div>
            <div class="value">${fmt(d.eaten, d.unit === 'g' ? 0 : 0)}<small> / ${fmt(d.target)} g</small></div>
            <div class="tiny muted">${d.remaining >= 0 ? '还差 ' + fmt(d.remaining) : '超 ' + fmt(-d.remaining)} g</div>
          </div>`).join('')}
      </div>
      <div class="split">
        <span class="p" style="width:${split.protein}%"></span>
        <span class="f" style="width:${split.fat}%"></span>
        <span class="c" style="width:${split.carb}%"></span>
      </div>
      <div class="legend">
        <span><i style="background:#2563eb"></i>蛋白 ${split.protein}%</span>
        <span><i style="background:#f59e0b"></i>脂肪 ${split.fat}%</span>
        <span><i style="background:#16a34a"></i>碳水 ${split.carb}%</span>
      </div>
      <p class="tiny muted" style="margin:10px 0 0">比例按热量算。蛋白 25~35%、脂肪 20~30%、碳水 40~55% 是比较稳的区间。</p>
    </div>

    ${tip ? `<div class="warn info">${tip}</div>` : ''}
    ${t.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}

    ${MEAL_SLOTS.map((slot) => {
      const list = day.meals[slot.key] || [];
      const kcal = list.reduce((a, e) => a + calcEntry(e.food, e.grams).kcal, 0);
      return `
      <div class="card">
        <div class="meal-head">
          <span class="meal-name">${slot.label}</span>
          <span class="meal-kcal">${Math.round(kcal)} kcal</span>
        </div>
        ${list.map((e) => {
          const f = calcEntry(e.food, e.grams);
          return `<div class="entry">
            <span class="name">${esc(e.food.name)}<em>${e.grams} 克</em></span>
            <span class="kcal">${Math.round(f.kcal)} kcal</span>
            <button class="del" data-act="del-food" data-id="${e.id}" aria-label="删除">✕</button>
          </div>`;
        }).join('') || '<div class="tiny muted">还没记</div>'}
        <button class="add-line" data-act="add-food" data-meal="${slot.key}">＋ 加食物</button>
      </div>`;
    }).join('')}

    <div class="card">
      <div class="card-title">今天的运动 <span class="tiny muted">消耗按体重和时长估算</span></div>
      ${day.exercises.map((x) => {
        const ex = EXERCISES[x.exerciseKey] || { name: x.exerciseKey, mets: 4 };
        const kcal = calcExerciseKcal({ mets: ex.mets, weightKg: state.profile.weightKg, minutes: x.minutes });
        return `<div class="entry">
          <span class="name">${esc(ex.name)}<em>${x.minutes} 分钟</em></span>
          <span class="kcal">约 ${Math.round(kcal)} kcal</span>
          <button class="del" data-act="del-exercise" data-id="${x.id}" aria-label="删除">✕</button>
        </div>`;
      }).join('') || '<div class="tiny muted">还没记（走路也算，记上会更准）</div>'}
      <button class="add-line" data-act="add-exercise">＋ 加运动</button>
      <p class="tiny muted" style="margin:8px 0 0">手环给的消耗通常偏高，所以这里只把估算值的一半算进「可以多吃」的额度。</p>
    </div>

    <div class="card">
      <div class="btn-row">
        <button class="btn ghost grow" data-act="demo">载入示例数据</button>
        <button class="btn ghost grow" data-act="reset-today">清空这一天</button>
      </div>
      <p class="tiny muted" style="margin:10px 0 0">
        载入示例会用一份 26 岁女性（163cm / 58kg）的资料覆盖当前记录，用来先看看长什么样。
      </p>
    </div>`;
}

/** 根据已吃的，给一句「接下来怎么吃」 */
function suggestNext(totals, t, remainingKcal) {
  const proteinLeft = t.proteinG - totals.protein;
  if (remainingKcal <= 0) {
    if (proteinLeft > 20) return `热量已经吃满了，但蛋白质还差 ${Math.round(proteinLeft)} 克。明天把蛋白质提前安排（早餐加两个蛋、午餐主菜加大一点）。`;
    return '今天的热量额度用完了。如果还饿，吃黄瓜、番茄、无糖酸奶这类几乎不占额度的东西。';
  }
  if (proteinLeft > 30) {
    return `还差 ${Math.round(proteinLeft)} 克蛋白质，还有 ${remainingKcal} kcal 额度。建议：鸡胸肉 150 克（约 180 kcal）或 3 个鸡蛋（约 215 kcal）或一杯无糖希腊酸奶（135 kcal）。`;
  }
  if (proteinLeft > 10) {
    return `蛋白质还差 ${Math.round(proteinLeft)} 克，可以来一杯无糖酸奶或两个鸡蛋，剩下 ${remainingKcal} kcal 留给主食和蔬菜。`;
  }
  if (remainingKcal > 400) {
    return `蛋白质基本够了，还剩 ${remainingKcal} kcal。加一份主食（米饭 150 克约 175 kcal）和一份蔬菜，别让缺口太大，饿过头第二天容易报复性吃。`;
  }
  return `节奏不错，剩下 ${remainingKcal} kcal 用水果或酸奶收尾就行。`;
}

/* ── 记录页 ──────────────────────────────── */

function renderLog() {
  const t = targets();
  const day = getDay(state, dateKey);
  const recent = frequent(state, 8);
  app.innerHTML = `
    <div class="card">
      <div class="card-title">记一笔</div>
      <p class="small muted" style="margin:0 0 10px">支持输入「150克」「2个」「一小碗」「半斤」这类写法。包装食品照背面标签填最准。</p>
      <div class="btn-row" style="margin-top:0">
        ${MEAL_SLOTS.map((s) => `<button class="btn ghost grow" data-act="add-food" data-meal="${s.key}">${s.label}</button>`).join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-title">常吃的（点一下直接加）</div>
      ${recent.length ? recent.map((r) => `
        <div class="search-hit" data-act="quick-add" data-id="${r.food.id}" data-grams="${r.grams}">
          <span class="nm">${esc(r.food.name)}<em>上次吃了 ${r.grams} 克 · ${Math.round(calcEntry(r.food, r.grams).kcal)} kcal</em></span>
          <span class="kk">＋</span>
        </div>`).join('') : '<div class="tiny muted">还没有记录。先在上面记一笔，这里就会出现常吃的东西。</div>'}
    </div>

    <div class="card">
      <div class="card-title">全部食物 <span class="tiny muted">共 ${FOODS.length} 种</span></div>
      <input type="text" id="logSearch" placeholder="搜索食物，例如：鸡胸 / 米饭 / 奶茶" autocomplete="off">
      <div id="logResults" style="margin-top:8px"></div>
    </div>

    <div class="card">
      <div class="card-title">找不到？自己加</div>
      <button class="btn block" id="customFoodBtn">＋ 新增自定义食物</button>
      ${state.customFoods.length ? `<div style="margin-top:10px">${state.customFoods.map((f) => `
        <div class="search-hit" data-act="quick-add" data-id="${f.id}" data-grams="${f.servings[0][1]}">
          <span class="nm">${esc(f.name)}<em>每 100 克 ${f.kcal} kcal · 自定义</em></span>
          <span class="kk">＋</span>
        </div>`).join('')}</div>` : ''}
    </div>`;

  const input = $('#logSearch');
  const results = $('#logResults');
  const draw = () => {
    const q = input.value;
    const list = searchFoods(q, state.customFoods, 12);
    results.innerHTML = list.length ? list.map((f) => `
      <div class="search-hit" data-pick="${f.id}">
        <span class="nm">${esc(f.name)}<em>每 100 克 · ${FOOD_CATEGORIES.find((c) => c.key === f.category)?.label || '自定义'}</em></span>
        <span class="kk">${f.kcal} kcal</span>
      </div>`).join('') : '<div class="tiny muted">没搜到。换关键词，或者用下面的「新增自定义食物」。</div>';
  };
  draw();
  input.addEventListener('input', draw);
  results.addEventListener('click', (ev) => {
    const hit = ev.target.closest('[data-pick]');
    if (!hit) return;
    const food = [...state.customFoods, ...FOODS].find((f) => f.id === hit.dataset.pick);
    const meal = guessMeal();
    openAmountSheet(food, meal);
  });
  $('#customFoodBtn').addEventListener('click', () => openCustomFoodSheet());
  app.querySelectorAll('[data-act="quick-add"]').forEach((el) => {
    el.addEventListener('click', () => {
      const food = [...state.customFoods, ...FOODS].find((f) => f.id === el.dataset.id);
      openAmountSheet(food, guessMeal());
    });
  });
  void t;
}

function frequent(state, limit) {
  const counter = new Map();
  for (const key of Object.keys(state.days).sort().reverse().slice(0, 30)) {
    for (const e of Object.values(state.days[key].meals || {}).flat()) {
      const cur = counter.get(e.food.id) || { food: e.food, count: 0, grams: e.grams };
      cur.count += 1;
      counter.set(e.food.id, cur);
    }
  }
  return [...counter.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/** 按当前时间猜这顿该记到哪一餐 */
function guessMeal() {
  const h = new Date().getHours();
  if (h < 10) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

/* ── 推荐页 ──────────────────────────────── */

function renderPlan() {
  const t = targets();
  const plan = buildMealPlan(t, { seed: planSeed });
  const week = buildWeekPlan(state.settings.trainDays, { stepsKey: state.settings.stepsKey });

  app.innerHTML = `
    <div class="card">
      <div class="card-title">一天怎么吃 <span class="tiny muted">按 ${t.targetCalories} kcal / 蛋白 ${t.proteinG} g 配</span></div>
      <div class="row between small" style="margin-bottom:6px">
        <span>这份餐单合计 <b>${plan.planKcal}</b> kcal、蛋白 <b>${plan.planProteinG}</b> g</span>
        <span class="tag ${Math.abs(plan.deviation) <= 10 ? 'green' : 'amber'}">${plan.deviation > 0 ? '+' : ''}${plan.deviation}%</span>
      </div>
      <p class="tiny muted" style="margin:0 0 10px">${esc(plan.deviationNote)}</p>
      ${plan.meals.map((m) => `
        <div class="session">
          <h4>${m.name} <span class="tiny muted">${m.kcal} kcal / 蛋白 ${m.proteinG} g</span></h4>
          <div class="small muted" style="margin-bottom:4px">${esc(m.dishName)}</div>
          <ul>${m.items.map((it) => `<li>${esc(it.food.name)} ${esc(it.desc)}${it.clampedBy ? ' <span class="tag amber">已按热量封顶</span>' : ''}</li>`).join('')}</ul>
        </div>`).join('')}
      <div class="btn-row">
        <button class="btn grow" data-act="use-plan">按这个餐单记入今天</button>
        <button class="btn ghost" data-act="next-plan">换一套</button>
      </div>
      <p class="tiny muted" style="margin:8px 0 0">「记入今天」只是把食物写进今天的记录里，之后可以按实际吃的改份量或删掉。</p>
    </div>

    <div class="card">
      <div class="card-title">每天的固定提醒</div>
      <ul class="small" style="margin:0;padding-left:18px;color:var(--ink-2)">
        ${buildDailyTips(t).map((x) => `<li style="margin-bottom:4px">${esc(x)}</li>`).join('')}
      </ul>
    </div>

    <div class="card">
      <div class="card-title">一周练什么</div>
      <label class="field"><span>她每周能练几天？</span>
        <div class="chips" id="trainDays">
          ${[2, 3, 4].map((d) => `<button class="chip ${state.settings.trainDays === d ? 'on' : ''}" data-days="${d}">${d} 天</button>`).join('')}
        </div>
      </label>
      <label class="field"><span>平时走路多吗？</span>
        <div class="chips" id="stepKey">
          ${[['low', '基本不动'], ['mid', '有走一点'], ['high', '走得比较多']].map(([k, label]) => `<button class="chip ${state.settings.stepsKey === k ? 'on' : ''}" data-key="${k}">${label}</button>`).join('')}
        </div>
      </label>
      ${week.sessions.map((s) => `
        <div class="session">
          <h4>${esc(s.title)} <span class="badge ${s.type}">${s.type === 'strength' ? '力量' : '有氧'} · ${s.minutes} 分钟</span></h4>
          <ul>${s.blocks.map((b) => `<li>${esc(b.name)} — ${esc(b.sets)}</li>`).join('')}</ul>
        </div>`).join('')}
      <div class="warn info" style="margin-top:10px">每天走路目标 <b>${week.stepTarget}</b> 步。${esc(week.stepHint)}</div>
      <ul class="small" style="margin:0;padding-left:18px;color:var(--ink-2)">
        ${week.notes.map((n) => `<li style="margin-bottom:4px">${esc(n)}</li>`).join('')}
      </ul>
      <p class="tiny muted" style="margin:8px 0 0">
        这些动作都是在家能做的徒手或哑铃动作。做不动就先减次数、加组间休息；膝盖、腰、肩有旧伤就别做相应动作，先问医生或教练。
      </p>
    </div>`;

  $('#trainDays').addEventListener('click', (e) => {
    const b = e.target.closest('[data-days]');
    if (!b) return;
    state.settings.trainDays = Number(b.dataset.days);
    save();
    render();
  });
  $('#stepKey').addEventListener('click', (e) => {
    const b = e.target.closest('[data-key]');
    if (!b) return;
    state.settings.stepsKey = b.dataset.key;
    save();
    render();
  });
}

function usePlanForToday() {
  const t = targets();
  const plan = buildMealPlan(t, { seed: planSeed });
  const day = getDay(state, dateKey);
  if (Object.values(day.meals).flat().length && !confirm('今天已经有记录了，继续会把餐单加在现有记录后面。要继续吗？')) return;
  for (const m of plan.meals) {
    for (const it of m.items) addFoodEntry(state, dateKey, m.key, it.food, it.grams);
  }
  save();
  view = 'today';
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'today'));
  render();
  toast('已经把餐单记进今天的记录，按实际吃的改份量就行。');
}

/* ── 体重页 ──────────────────────────────── */

function renderProgress() {
  const t = state.profile ? targets() : null;
  const list = weightTrend(state, 30);
  const prog = analyzeProgress(state);
  const max = Math.max(...list.map((w) => w.kg), 1);
  const min = Math.min(...list.map((w) => w.kg), max - 1);

  app.innerHTML = `
    ${t ? `
    <div class="card">
      <div class="card-title">目标 <button class="btn ghost" data-act="edit-profile" style="padding:4px 10px;font-size:12px">修改资料</button></div>
      <div class="grid2">
        <div><div class="tiny muted">基础代谢</div><div style="font-size:18px;font-weight:600">${t.bmr} <small class="muted">kcal</small></div></div>
        <div><div class="tiny muted">每天消耗</div><div style="font-size:18px;font-weight:600">${t.tdee} <small class="muted">kcal</small></div></div>
        <div><div class="tiny muted">每天吃</div><div style="font-size:18px;font-weight:600;color:var(--green-dark)">${t.targetCalories} <small class="muted">kcal</small></div></div>
        <div><div class="tiny muted">BMI</div><div style="font-size:18px;font-weight:600">${t.bmi} <small class="muted">${t.bmiClass.label}</small></div></div>
      </div>
      <hr class="sep">
      <div class="small">
        目标体重 ${t.targetWeightKg} kg，还要减 ${t.toLoseKg} kg。<br>
        按现在的节奏大约每周减 ${t.weeklyLossKg} kg${t.estimatedWeeks ? `，大概 ${t.estimatedWeeks} 周达到目标` : ''}。<br>
        蛋白质 ${t.proteinG} g · 脂肪 ${t.fatG} g · 碳水 ${t.carbG} g。
      </div>
      ${t.warnings.map((w) => `<div class="warn" style="margin-top:10px">${esc(w)}</div>`).join('')}
    </div>` : ''}

    <div class="card">
      <div class="card-title">记体重 <span class="tiny muted">建议每周固定时间称 1~2 次</span></div>
      <div class="row">
        <input type="number" id="weightInput" inputmode="decimal" step="0.1" placeholder="例如 57.8" class="grow">
        <button class="btn" data-act="log-weight">记下</button>
      </div>
      <p class="tiny muted" style="margin:10px 0 0">
        早上空腹、上完厕所、穿同样的衣服称最可比。一天内的浮动 1 公斤很正常，看一周的平均值才有意义。
      </p>
    </div>

    <div class="card">
      <div class="card-title">趋势 ${list.length ? `<span class="tiny muted">最近 ${list.length} 次记录</span>` : ''}</div>
      ${list.length >= 2 ? `
        <div class="spark">
          ${list.map((w) => `<span class="${w.date === todayKey() ? 'on' : ''}" style="height:${Math.max(6, ((w.kg - min + 0.6) / (max - min + 0.6)) * 100)}%" title="${w.date} ${w.kg}kg"></span>`).join('')}
        </div>
        <div class="row between tiny muted"><span>${list[0].date} ${list[0].kg}kg</span><span>${list[list.length - 1].date} ${list[list.length - 1].kg}kg</span></div>
      ` : '<div class="tiny muted">至少记两次（间隔一周以上）才能画趋势。</div>'}
      ${prog.ok ? `
        <hr class="sep">
        <div class="small">
          从 ${prog.fromKg} kg 到 ${prog.toKg} kg，${prog.days} 天变化 <b>${prog.deltaKg > 0 ? '+' : ''}${prog.deltaKg} kg</b>，
          平均每周 <b>${prog.perWeek > 0 ? '+' : ''}${prog.perWeek} kg</b>。
        </div>
        <div class="warn info" style="margin-top:10px">${esc(prog.verdict)}</div>
      ` : `<div class="tiny muted" style="margin-top:8px">${esc(prog.reason)}</div>`}
    </div>

    <div class="card">
      <div class="card-title">数据与备份</div>
      <p class="small muted" style="margin:0 0 10px">所有记录只在这台设备上。换手机或清浏览器缓存前，先导出一次存档。</p>
      <div class="btn-row" style="margin-top:0">
        <button class="btn ghost grow" data-act="export">导出存档</button>
        <button class="btn ghost grow" data-act="import">导入存档</button>
      </div>
    </div>`;

  const wi = $('#weightInput');
  if (wi) {
    wi.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveWeight(); });
    const btn = app.querySelector('[data-act="log-weight"]');
    if (btn) btn.addEventListener('click', saveWeight, { once: true });
  }
  function saveWeight() {
    const v = Number($('#weightInput').value);
    if (!(v > 20 && v < 300)) return toast('体重请填 20~300 之间的数字。');
    addWeight(state, dateKey, v);
    if (state.profile) state.profile.weightKg = v; // 体重变了，目标跟着重算
    save();
    render();
    toast('已记录，目标热量按新体重重算了。');
  }
}

/* ── 弹层：加食物 ────────────────────────── */

function openFoodSheet(mealKey) {
  const slot = MEAL_SLOTS.find((s) => s.key === mealKey) || MEAL_SLOTS[0];
  openSheet({
    title: `加到${slot.label}`,
    body: `
      <input type="text" id="foodSearch" placeholder="搜食物，例如：鸡胸 / 米饭 / 奶茶 / 苹果" autocomplete="off">
      <div id="foodResults" style="margin-top:6px"></div>`,
    onMount: (body) => {
      const input = $('#foodSearch', body);
      const results = $('#foodResults', body);
      const draw = () => {
        const list = searchFoods(input.value, state.customFoods, 14);
        results.innerHTML = list.length ? list.map((f) => `
          <div class="search-hit" data-pick="${f.id}">
            <span class="nm">${esc(f.name)}<em>每 100 克</em></span>
            <span class="kk">${f.kcal} kcal</span>
          </div>`).join('') : '<div class="tiny muted">没搜到。可以用「记录」页里的自定义食物。</div>';
      };
      draw();
      input.addEventListener('input', draw);
      results.addEventListener('click', (ev) => {
        const hit = ev.target.closest('[data-pick]');
        if (!hit) return;
        const food = [...state.customFoods, ...FOODS].find((f) => f.id === hit.dataset.pick);
        openAmountSheet(food, mealKey);
      });
      setTimeout(() => input.focus(), 60);
    },
  });
}

function openAmountSheet(food, mealKey) {
  pendingFood = { food, mealKey };
  const slot = MEAL_SLOTS.find((s) => s.key === mealKey) || MEAL_SLOTS[0];
  openSheet({
    title: `${food.name} → ${slot.label}`,
    body: `
      <p class="small muted" style="margin:0 0 10px">每 100 克：${food.kcal} kcal · 蛋白 ${food.protein} g · 脂肪 ${food.fat} g · 碳水 ${food.carb} g</p>
      <label class="field"><span>吃了多少？（可写「150克」「2个」「一小碗」）</span>
        <input type="text" id="amountInput" inputmode="text" value="${food.servings[0][1]}" autocomplete="off">
      </label>
      <div class="chips" id="amountChips">
        ${food.servings.map(([label, g]) => `<button class="chip" data-grams="${g}">${label}（${g}g）</button>`).join('')}
      </div>
      <label class="field" style="margin-top:12px"><span>记到哪一餐</span>
        <div class="chips" id="mealChips">
          ${MEAL_SLOTS.map((s) => `<button class="chip ${s.key === mealKey ? 'on' : ''}" data-meal="${s.key}">${s.label}</button>`).join('')}
        </div>
      </label>
      <div id="amountPreview" class="warn info"></div>`,
    foot: '<button class="btn block" id="confirmAmount">加入记录</button>',
    onMount: (body) => {
      const input = $('#amountInput', body);
      const preview = $('#amountPreview', body);
      const update = () => {
        const g = parseAmount(input.value, food);
        if (!g) { preview.textContent = '看不懂这个写法，直接填克数（例如 150）也可以。'; return; }
        const f = calcEntry(food, g);
        preview.innerHTML = `≈ <b>${Math.round(f.kcal)} kcal</b> · 蛋白 ${f.protein} g · 脂肪 ${f.fat} g · 碳水 ${f.carb} g（按 ${Math.round(g)} 克算）`;
      };
      update();
      input.addEventListener('input', update);
      $('#amountChips', body).addEventListener('click', (e) => {
        const b = e.target.closest('[data-grams]');
        if (!b) return;
        input.value = `${b.dataset.grams}克`;
        update();
      });
      $('#mealChips', body).addEventListener('click', (e) => {
        const b = e.target.closest('[data-meal]');
        if (!b) return;
        pendingFood.mealKey = b.dataset.meal;
        body.querySelectorAll('#mealChips .chip').forEach((c) => c.classList.toggle('on', c === b));
      });
      $('#confirmAmount').addEventListener('click', () => {
        const g = parseAmount(input.value, food);
        if (!g || g <= 0) return toast('份量没填对，试试直接写克数。');
        if (g > 3000) return toast('一次超过 3000 克，确认一下单位（斤/两/克）。');
        addFoodEntry(state, dateKey, pendingFood.mealKey, food, g);
        save();
        closeSheet();
        render();
        toast(`已记：${food.name} ${Math.round(g)} 克`);
      });
      setTimeout(() => { input.focus(); input.select(); }, 60);
    },
  });
}

/* ── 弹层：加运动 ────────────────────────── */

function openExerciseSheet() {
  const list = listExercises();
  openSheet({
    title: '加运动',
    body: `
      <div class="chips" id="exChips">
        ${list.map((e) => `<button class="chip ${e.kind === 'strength' ? '' : ''}" data-ex="${e.key}">${esc(e.name)}</button>`).join('')}
      </div>
      <label class="field" style="margin-top:14px"><span>练了多久（分钟）</span>
        <input type="number" id="exMinutes" inputmode="numeric" value="30" min="1" max="600">
      </label>
      <div id="exPreview" class="warn info"></div>`,
    foot: '<button class="btn block" id="confirmEx">加入记录</button>',
    onMount: (body) => {
      let picked = list[0].key;
      const minutes = $('#exMinutes', body);
      const preview = $('#exPreview', body);
      const update = () => {
        const ex = EXERCISES[picked];
        const m = Number(minutes.value) || 0;
        const kcal = calcExerciseKcal({ mets: ex.mets, weightKg: state.profile?.weightKg ?? 60, minutes: m });
        preview.innerHTML = `${esc(ex.name)} ${m} 分钟 ≈ 消耗 <b>${Math.round(kcal)} kcal</b>，其中一半（约 ${Math.round(kcal / 2)} kcal）会算进今天可以多吃的额度。`;
      };
      body.querySelectorAll('#exChips .chip').forEach((c) => c.classList.toggle('on', c.dataset.ex === picked));
      update();
      minutes.addEventListener('input', update);
      $('#exChips', body).addEventListener('click', (e) => {
        const b = e.target.closest('[data-ex]');
        if (!b) return;
        picked = b.dataset.ex;
        body.querySelectorAll('#exChips .chip').forEach((c) => c.classList.toggle('on', c === b));
        update();
      });
      $('#confirmEx').addEventListener('click', () => {
        const m = Number(minutes.value);
        if (!(m > 0 && m <= 600)) return toast('时长请填 1~600 分钟。');
        addExercise(state, dateKey, picked, m);
        save();
        closeSheet();
        render();
      });
    },
  });
}

/* ── 弹层：自定义食物 ────────────────────── */

function openCustomFoodSheet() {
  openSheet({
    title: '新增自定义食物',
    body: `
      <p class="small muted" style="margin:0 0 12px">照包装背面的「营养成分表」抄，通常标的是每 100 克。如果标的是「每份」，就在下面填每份的克数。</p>
      <label class="field"><span>名称</span><input type="text" id="cfName" placeholder="例如：XX 牌全麦面包"></label>
      <label class="field"><span>一份是多少克</span><input type="number" id="cfBase" value="100" inputmode="decimal"></label>
      <div class="grid2">
        <label class="field"><span>热量 kcal</span><input type="number" id="cfKcal" inputmode="decimal"></label>
        <label class="field"><span>蛋白质 g</span><input type="number" id="cfProtein" inputmode="decimal"></label>
        <label class="field"><span>脂肪 g</span><input type="number" id="cfFat" inputmode="decimal"></label>
        <label class="field"><span>碳水 g</span><input type="number" id="cfCarb" inputmode="decimal"></label>
      </div>
      <div id="cfPreview" class="warn info">填完后这里会显示每 100 克的数据，方便你核对。</div>`,
    foot: '<button class="btn block" id="cfSave">保存</button>',
    onMount: (body) => {
      const val = (id) => Number($(`#${id}`, body).value);
      const base = () => val('cfBase') || 100;
      const preview = $('#cfPreview', body);
      const update = () => {
        const k = base();
        const per100 = (x) => Math.round((val(x) / k) * 100 * 10) / 10;
        preview.innerHTML = `每 100 克：${per100('cfKcal')} kcal · 蛋白 ${per100('cfProtein')} g · 脂肪 ${per100('cfFat')} g · 碳水 ${per100('cfCarb')} g`;
      };
      body.querySelectorAll('input').forEach((i) => i.addEventListener('input', update));
      $('#cfSave').addEventListener('click', () => {
        const name = $('#cfName', body).value.trim();
        if (!name) return toast('先填个名字。');
        if (!(val('cfKcal') > 0)) return toast('热量要填大于 0 的数字。');
        const k = base();
        addCustomFood(state, {
          name,
          kcal: Math.round((val('cfKcal') / k) * 100 * 10) / 10,
          protein: Math.round((val('cfProtein') / k) * 100 * 10) / 10,
          fat: Math.round((val('cfFat') / k) * 100 * 10) / 10,
          carb: Math.round((val('cfCarb') / k) * 100 * 10) / 10,
          baseGrams: k,
          servings: [['一份', k]],
        });
        save();
        closeSheet();
        view = 'log';
        document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'log'));
        render();
        toast('已保存，之后在「记录」和搜索里都能找到。');
      });
    },
  });
}

/* ── 弹层：资料 ──────────────────────────── */

function openProfileSheet() {
  const p = state.profile || {
    sex: 'female', age: 25, heightCm: 163, weightKg: 58, bodyFatPct: null,
    activity: 'light', pace: 'standard', goal: 'lose', targetWeightKg: null,
  };
  const hasProfile = Boolean(state.profile);
  openSheet({
    title: hasProfile ? '我的资料' : '填写资料',
    body: `
      <label class="field"><span>性别（决定基础代谢公式，必须选）</span>
        <div class="chips" id="sexChips">
          <button class="chip ${p.sex === 'female' ? 'on' : ''}" data-sex="female">女</button>
          <button class="chip ${p.sex === 'male' ? 'on' : ''}" data-sex="male">男</button>
        </div>
      </label>
      <div class="grid2">
        <label class="field"><span>年龄</span><input type="number" id="pAge" value="${p.age}" inputmode="numeric"></label>
        <label class="field"><span>身高 cm</span><input type="number" id="pHeight" value="${p.heightCm}" inputmode="decimal"></label>
        <label class="field"><span>现在体重 kg</span><input type="number" id="pWeight" value="${p.weightKg}" step="0.1" inputmode="decimal"></label>
        <label class="field"><span>目标体重 kg（可不填）</span><input type="number" id="pTarget" value="${p.targetWeightKg ?? ''}" step="0.1" inputmode="decimal" placeholder="自动算"></label>
      </div>
      <label class="field"><span>体脂率 %（有就填，没有留空，会更准）</span>
        <input type="number" id="pBodyFat" value="${p.bodyFatPct ?? ''}" step="0.1" inputmode="decimal" placeholder="留空">
      </label>
      <label class="field"><span>平时的活动量</span>
        <div class="chips" id="actChips">
          ${ACTIVITY_LEVELS.map((a) => `<button class="chip ${p.activity === a.key ? 'on' : ''}" data-act-key="${a.key}" title="${esc(a.hint)}">${a.label}</button>`).join('')}
        </div>
        <span class="tiny muted" id="actHint" style="margin-top:6px;display:block">${esc(ACTIVITY_LEVELS.find((a) => a.key === p.activity)?.hint || '')}</span>
      </label>
      <label class="field"><span>想做什么</span>
        <div class="seg" id="goalChips">
          <button class="chip ${p.goal !== 'maintain' ? 'on' : ''}" data-goal="lose">减脂</button>
          <button class="chip ${p.goal === 'maintain' ? 'on' : ''}" data-goal="maintain">维持体重</button>
        </div>
      </label>
      <label class="field" id="paceField" style="${p.goal === 'maintain' ? 'display:none' : ''}"><span>希望多快瘦下来</span>
        <div class="chips" id="paceChips">
          ${GOAL_PACE.map((g) => `<button class="chip ${p.pace === g.key ? 'on' : ''}" data-pace="${g.key}" title="${esc(g.hint)}">${g.label}</button>`).join('')}
        </div>
        <span class="tiny muted" id="paceHint" style="margin-top:6px;display:block">${esc(GOAL_PACE.find((g) => g.key === p.pace)?.hint || '')}</span>
      </label>
      <div id="profilePreview" class="warn info"></div>
      <p class="tiny muted">
        这些数字只用来算基础代谢（Mifflin-St Jeor 公式），误差一般 ±10%。数据只存在这台设备上。
      </p>`,
    foot: `<button class="btn block" id="pSave">保存</button>${hasProfile ? '<button class="btn ghost block" id="pCancel" style="margin-top:8px">取消</button>' : ''}`,
    onMount: (body, foot) => {
      const num = (id) => Number($(`#${id}`, body).value);
      const form = () => ({
        sex: body.querySelector('#sexChips .chip.on')?.dataset.sex || 'female',
        age: num('pAge'),
        heightCm: num('pHeight'),
        weightKg: num('pWeight'),
        bodyFatPct: $('#pBodyFat', body).value === '' ? null : num('pBodyFat'),
        activity: body.querySelector('#actChips .chip.on')?.dataset.actKey || 'light',
        goal: body.querySelector('#goalChips .chip.on')?.dataset.goal || 'lose',
        pace: body.querySelector('#paceChips .chip.on')?.dataset.pace || 'standard',
        targetWeightKg: $('#pTarget', body).value === '' ? null : num('pTarget'),
      });
      const preview = $('#profilePreview', body);
      const update = () => {
        const f = form();
        for (const [k, [lo, hi]] of Object.entries({ age: [18, 80], heightCm: [130, 220], weightKg: [30, 250] })) {
          if (!(f[k] >= lo && f[k] <= hi)) {
            preview.className = 'warn';
            preview.textContent = k === 'age' ? '年龄请填 18~80。这个工具不适合未成年人使用。'
              : k === 'heightCm' ? '身高请填 130~220 cm。'
                : '体重请填 30~250 kg。';
            return;
          }
        }
        try {
          const t = calcTargets({ ...f, targetWeightKg: f.targetWeightKg });
          const tw = f.targetWeightKg || defaultTargetWeight(f);
          preview.className = 'warn info';
          preview.innerHTML = `每天吃 <b>${t.targetCalories} kcal</b>（消耗 ${t.tdee} − 缺口 ${t.deficit}）·
            蛋白 ${t.proteinG} g / 脂肪 ${t.fatG} g / 碳水 ${t.carbG} g<br>
            BMI ${t.bmi}（${t.bmiClass.label}）· 目标 ${round(tw, 1)} kg ·
            ${t.weeklyLossKg > 0 ? `预计每周减 ${t.weeklyLossKg} kg` : '维持体重'}
            ${t.estimatedWeeks ? `，约 ${t.estimatedWeeks} 周达成` : ''}`;
        } catch (err) {
          preview.className = 'warn';
          preview.textContent = err.message;
        }
      };
      update();
      body.addEventListener('input', update);
      body.querySelectorAll('.chips').forEach((box) => {
        box.addEventListener('click', (e) => {
          const btn = e.target.closest('.chip');
          if (!btn) return;
          box.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === btn));
          if (box.id === 'actChips') $('#actHint', body).textContent = ACTIVITY_LEVELS.find((a) => a.key === btn.dataset.actKey)?.hint || '';
          if (box.id === 'paceChips') $('#paceHint', body).textContent = GOAL_PACE.find((g) => g.key === btn.dataset.pace)?.hint || '';
          if (box.id === 'goalChips') $('#paceField', body).style.display = btn.dataset.goal === 'maintain' ? 'none' : '';
          update();
        });
      });
      $('#pSave', foot).addEventListener('click', () => {
        const f = form();
        try {
          const t = calcTargets({ ...f, targetWeightKg: f.targetWeightKg });
          state.profile = { ...f, targetWeightKg: f.targetWeightKg || round(defaultTargetWeight(f), 1) };
          if (!state.weights.some((w) => w.date === todayKey())) addWeight(state, todayKey(), f.weightKg);
          save();
          closeSheet();
          view = 'today';
          document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'today'));
          render();
          toast(`已保存。她每天的目标是 ${t.targetCalories} kcal。`);
        } catch (err) {
          toast(err.message);
        }
      });
      if (hasProfile) $('#pCancel', foot).addEventListener('click', closeSheet);
    },
  });
}

/* ── 弹层：记体重 ────────────────────────── */

function openWeightSheet() {
  openSheet({
    title: '记体重',
    body: `<label class="field"><span>体重（kg）</span><input type="number" id="wInput" step="0.1" inputmode="decimal" placeholder="57.8"></label>
           <p class="tiny muted">建议早上空腹、穿同样衣服称。</p>`,
    foot: '<button class="btn block" id="wSave">保存</button>',
    onMount: (body, foot) => {
      $('#wSave', foot).addEventListener('click', () => {
        const v = Number($('#wInput', body).value);
        if (!(v > 20 && v < 300)) return toast('体重请填 20~300 之间的数字。');
        addWeight(state, todayKey(), v);
        if (state.profile) state.profile.weightKg = v;
        save();
        closeSheet();
        render();
      });
    },
  });
}

/* ── 导入导出 ────────────────────────────── */

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `减脂记录-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出。文件在手机的「下载」里，换设备时用「导入存档」恢复。');
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!confirm('导入会覆盖现在这台设备上的所有记录，确定吗？')) return;
        state = migrate(parsed);
        save();
        render();
        toast('导入完成。');
      } catch (err) {
        toast('这个文件读不出来，可能不是导出的存档。');
        console.error(err);
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

/* ── 自检模式（仅用于开发验证，正常使用不会触发）────────── */

async function selfCheck() {
  const log = [];
  const t0 = calcTargets(demoProfile());
  state = emptyState();
  state.profile = demoProfile();
  const day = getDay(state, todayKey());
  log.push(`目标热量 ${t0.targetCalories} kcal，蛋白 ${t0.proteinG} g`);

  const rice = findFood('rice_cooked');
  addFoodEntry(state, todayKey(), 'lunch', rice, 200);
  const egg = findFood('egg');
  addFoodEntry(state, todayKey(), 'breakfast', egg, 100);
  addExercise(state, todayKey(), 'walk', 40);
  addWeight(state, todayKey(), 58);

  const entries = Object.values(day.meals).flat();
  const kcal = entries.reduce((a, e) => a + calcEntry(e.food, e.grams).kcal, 0);
  log.push(`记录了 ${entries.length} 条食物，合计 ${Math.round(kcal)} kcal`);
  log.push(`运动 ${day.exercises.length} 条`);
  log.push(`体重 ${state.weights.length} 条`);

  // 走一遍存档读写，确认能恢复
  save();
  const reloaded = migrate(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  log.push(`存档读回：${Object.values(reloaded.days[todayKey()].meals).flat().length} 条食物`);

  // 检查界面元素真的渲染出来了
  view = 'today';
  render();
  log.push(`今天页卡片数 ${app.querySelectorAll('.card').length}`);
  view = 'plan';
  render();
  log.push(`推荐页卡片数 ${app.querySelectorAll('.card').length}`);
  view = 'log';
  render();
  log.push(`记录页卡片数 ${app.querySelectorAll('.card').length}`);
  view = 'progress';
  render();
  log.push(`体重页卡片数 ${app.querySelectorAll('.card').length}`);

  // 弹层能否打开
  openAmountSheet(rice, 'lunch');
  log.push(`份量弹层打开：${!$('#sheetRoot').classList.contains('hidden')}，预览：${$('#amountPreview').textContent.trim().slice(0, 40)}`);
  closeSheet();

  await fetch('/__save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ log }) }).catch(() => {});
  document.title = '自检完成';
  const pre = document.createElement('pre');
  pre.id = 'selfcheck';
  pre.textContent = log.join('\n');
  document.body.appendChild(pre);
}

/* ── 启动 ────────────────────────────────── */

if (new URLSearchParams(location.search).has('__selfcheck')) {
  selfCheck();
} else if (!state) {
  state = emptyState();
  renderWelcome();
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'today'));
  bindCommon();
} else {
  render();
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('离线缓存未启用：', err));
  });
}

void normalize; void _ms; void classifyBMI;
