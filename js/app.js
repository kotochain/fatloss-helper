/**
 * 减脂小助手 —— 界面与交互
 * 数据全部存在这台设备上（浏览器本地存储），不联网、不上传。
 */

import {
  calcTargets, calcEntry, calcExerciseKcal, diffAgainstTargets, macroSplit,
  defaultTargetWeight, ACTIVITY_LEVELS, GOAL_PACE, LIMITS, round,
} from './calc.js';
import { FOODS, FOOD_CATEGORIES, findFood, parseAmount } from './foods.js';
import { searchFoods, MEAL_SLOTS } from './foodlog.js';
import { listExercises, buildWeekPlan, EXERCISES } from './exercise.js';
import {
  parseDescription, normalizeAiItems, sumItems, collectQuestions, PORTION_CHOICES,
  gramsFromText, portionGrams,
} from './mealparse.js';
import {
  askAi, aiStatus, currentAiConfig, saveAiConfigLocal, clearAiConfig,
  testConnection, fetchModels, relayStatus, presetDirectCall,
} from './ai.js';
import { PRESETS, findPreset } from './providers.js';
import {
  achievements, plantState, weeklyReview, weeklyHighlight, afterLogMessage,
  markAchievementsSeen, shouldShowWeekly, nickname, greeting, hitMilestone, badgeLabel,
} from './achievements.js';
import {
  CARDIO, EQUIPMENT, GOALS, recommendCardio, substituteExercises, listEquipment,
} from './cardio.js';
import { buildMealPlan, buildDailyTips } from './recommend.js';
import {
  SCHEMA_VERSION, loadState, migrateToCurrent, readBackup, clearBackup, saveBackup, describeMigration,
} from './schema.js';
import {
  emptyState, todayKey, shiftDate, getDay, addFoodEntry, removeFoodEntry,
  addExercise, removeExercise, addWeight, addCustomFood, weightTrend, analyzeProgress,
  demoProfile, demoEntries, frequentFoods,
} from './store.js';

const STORAGE_KEY = 'fatloss.state.v2';
const $ = (sel, root = document) => root.querySelector(sel);

let state = load();
let view = 'today';
let dateKey = todayKey();
let planSeed = 0;
let pendingFood = null;
/** 「说一句」流程的临时状态：解析出来的条目等她确认 */
let draft = null;
/** AI 是否可用（进界面时问一次服务端） */
let ai = { configured: false, checked: false, reason: null };
/** 「说一句」是从哪一餐点进来的（界面上的餐次提示，默认按时间猜） */
let quickMealHint = null;
/** 有氧推荐的选择 */
let cardioPick = { equipment: ['treadmill', 'elliptical', 'bike', 'bodyweight'], goal: 'fat_burn', minutes: 30 };
const app = $('#app');

/* ── 存档 ────────────────────────────────── */

/** 存档读取结果（用于启动后提示「已升级、数据都在」） */
let startupNotice = null;

function load() {
  const res = loadState(localStorage, { key: STORAGE_KEY });
  if (!res.ok) {
    // 读不出来或版本太新：绝不用空数据覆盖她的记录
    startupNotice = { kind: 'error', text: res.error };
    console.warn('存档读取失败：', res.error);
    return null;
  }
  if (res.data && res.upgradedFrom) {
    startupNotice = { kind: 'ok', text: describeMigration(res) };
  }
  return res.data;
}

function save() {
  try {
    state.schemaVersion = SCHEMA_VERSION;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    toast('存不进去了（浏览器存储可能满了），请到「体重」页导出备份。');
    console.error(err);
  }
}

/**
 * 她的每日目标 —— **只由公式决定，跟餐单无关**。
 *
 * 这里曾经让目标跟着餐单对账（为了让「目标」和「餐单」一致），
 * 但那是错的：同一个人的目标会随「换一套」在 36~69 克脂肪之间跳，
 * 甚至会压穿 0.6 g/kg 的安全线（独立核验实测：9.67% 的正常体型组合中招）。
 * 目标必须是稳定的 —— 它同时决定首页圆环、达成率和成就的达标线。
 *
 * 餐单给不到目标时，由餐单自己如实说明差多少、怎么补（见 recommend.js 的 deviationNote）。
 */
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
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  // 从顶部滑下来：底部是会放输入框和按钮的地方，挡住最常用的操作很烦
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 260);
  }, 2800);
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
$('#dateLabel').addEventListener('click', openCalendarSheet);
$('#profileBtn').addEventListener('click', openSettingsSheet);

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
  const dn = $('#dateText');
  if (dn) dn.textContent = dateLabel();
  else $('#dateLabel').textContent = dateLabel();
  const nameTag = $('#nameTag');
  if (nameTag) {
    const who = nickname(state);
    nameTag.textContent = who;
    nameTag.hidden = !who;   // 没填称呼就不显示，不硬塞一个名字
  }
  if (!state.profile && view !== 'progress') {
    renderWelcome();
    return;
  }
  if (view === 'today') renderToday();
  else if (view === 'log') renderLog();
  else if (view === 'plan') renderPlan();
  else renderProgress();
  bindCommon();
  if (view === 'today') {
    bindQuickLog();
    $('#aiSettingsBtn')?.addEventListener('click', openAiSettingsSheet);
  }
}

function bindCommon() {
  app.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', () => handleAction(el.dataset.act, el.dataset));
  });
}

function handleAction(act, data) {
  switch (act) {
    case 'add-food': return openFoodSheet(data.meal);
    case 'growth': return openGrowthSheet();
    case 'go-log':
      view = 'log';
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'log'));
      render();
      return;
    case 'quick-fill': {
      quickMealHint = data.meal || null;
      view = 'log';
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'log'));
      render();
      const ta = $('#quickText');
      if (ta) { ta.focus(); toast('在这里写一句，会自动记到她那一餐。'); }
      return;
    }
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

  const R = 78;                       // 圆环半径
  const CIRC = 2 * Math.PI * R;
  const ringPct = Math.max(0, Math.min(1, totals.kcal / budget));
  const offset = CIRC * (1 - ringPct);
  const settled = remaining < 0;      // 超了就把圆环走满
  const streak = streakDays(state);
  const exerciseMin = day.exercises.reduce((a, x) => a + x.minutes, 0);
  const plant = { state: plantState(state), ach: achievements(state, t.proteinG) };
  const greet = greeting(state);
  const macros = diff.filter((d) => d.key !== 'kcal');

  app.innerHTML = `
    <div class="card hero">
      <div class="greet">${greet.emoji} <span>${greet.name ? `${esc(greet.word)}，<b>${esc(greet.name)}</b>` : esc(greet.word)}</span></div>
      <div class="ring-wrap">
        <svg class="ring" viewBox="0 0 190 190" aria-hidden="true">
          <defs>
            <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="${settled ? '#F2A08A' : '#FF9E7A'}"/>
              <stop offset="100%" stop-color="${settled ? '#E4572E' : '#E86A82'}"/>
            </linearGradient>
          </defs>
          <circle class="track" cx="95" cy="95" r="${R}"/>
          <circle class="bar" cx="95" cy="95" r="${R}"
            stroke-dasharray="${CIRC.toFixed(1)}"
            stroke-dashoffset="${(settled ? 0 : offset).toFixed(1)}"/>
        </svg>
        <div class="ring-center">
          <span class="big ${settled ? 'over' : ''}">${Math.abs(remaining)}</span>
          <span class="unit">kcal</span>
          <span class="cap">${settled ? '已超出' : '今天还可以吃'}</span>
        </div>
      </div>
      <div class="sub">已吃 <b>${Math.round(totals.kcal)}</b> / 目标约 ${budget} kcal</div>
      ${bonus ? `<div class="bonus-pill"><svg viewBox="0 0 24 24" class="ic"><use href="#i-fire"/></svg>运动奖励 ${bonus} kcal 已计入</div>` : ''}

      <div class="macro-list">
        ${macros.map((d) => {
          const map = { protein: ['p', '蛋白'], fat: ['f', '脂肪'], carb: ['c', '碳水'] };
          const [cls2, label] = map[d.key];
          const pct = Math.min(100, d.pct);
          return `
          <div class="macro-row ${cls2} ${d.status === 'over' ? 'over' : ''}">
            <span class="mlabel">${label}</span>
            <span class="mbar"><i style="width:${pct}%"></i></span>
            <span class="mval"><b>${fmt(d.eaten)}</b>/${fmt(d.target)} g</span>
          </div>`;
        }).join('')}
      </div>

      <div class="stats">
        ${streak > 1 ? `<span class="stat"><svg viewBox="0 0 24 24" class="ic"><use href="#i-fire"/></svg>连续记录 <b>${streak}</b> 天</span>` : ''}
        ${exerciseMin ? `<span class="stat"><svg viewBox="0 0 24 24" class="ic"><use href="#i-today"/></svg>今天运动 <b>${exerciseMin}</b> 分钟</span>` : ''}
        <span class="stat"><svg viewBox="0 0 24 24" class="ic"><use href="#i-pin"/></svg>蛋白 <b>${Math.round((totals.protein / t.proteinG) * 100)}%</b></span>
      </div>
    </div>

    <button class="plant-card" data-act="growth">
      <span class="plant-emoji-sm">${plant.state.stage.emoji}</span>
      <span class="plant-text">
        <b>${esc(plant.state.stage.name)}</b>
        <em>${plant.ach.unlocked.length} 个徽章 · ${plant.state.nextStage ? `再记 ${plant.state.toNext} 天长大` : '已长成'}</em>
      </span>
      <span class="plant-go">看成长 ›</span>
    </button>

    ${tip ? `<div class="warn info">${tip}</div>` : ''}

    <div class="card">
      <div class="card-title">说一句就记上
        <button class="btn ghost" id="aiSettingsBtn" style="padding:4px 11px;font-size:12px">
          ${!ai.checked ? '检查中…' : ai.configured ? 'AI 已开启' : '去设置 AI'}
        </button>
      </div>
      <textarea id="quickText" rows="2" placeholder="今天中午在食堂吃了碗牛肉面，加了个蛋"></textarea>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn grow" id="quickParse">解析这一句</button>
        <button class="btn ghost" data-act="go-log">搜索食物</button>
      </div>
      <div id="quickResult"></div>
    </div>
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
        <div class="row" style="gap:6px;margin-top:8px">
          <button class="add-line grow" data-act="add-food" data-meal="${slot.key}" style="margin-top:0">＋ 加食物</button>
          <button class="add-line grow" data-act="quick-fill" data-meal="${slot.key}" style="margin-top:0">💬 说一句</button>
        </div>
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

`;
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
  const recent = frequentFoods(state, 8);
  app.innerHTML = `
    <div class="card">
      <div class="card-title">说一句就记上
        <button class="btn ghost" id="aiSettingsBtn" style="padding:3px 10px;font-size:12px">
          ${!ai.checked ? '检查中…' : ai.configured ? 'AI 已开启' : '去设置 AI'}
        </button>
      </div>
      <textarea id="quickText" rows="3" placeholder="今天吃了什么？例如：中午吃了碗牛肉面，加了个蛋"></textarea>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn grow" id="quickParse">解析这一句</button>
      </div>
      <div id="quickResult"></div>
    </div>

    <div class="card">
      <div class="card-title">手动记一笔</div>
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
  bindQuickLog();
  $('#aiSettingsBtn')?.addEventListener('click', openAiSettingsSheet);
  app.querySelectorAll('[data-act="quick-add"]').forEach((el) => {
    el.addEventListener('click', () => {
      const food = [...state.customFoods, ...FOODS].find((f) => f.id === el.dataset.id);
      openAmountSheet(food, guessMeal());
    });
  });
}

/* ── 「说一句就记上」流程 ─────────────────────
   流程：她说一句话 → 解析（AI 优先，失败退回离线）→ 展示条目让她确认/改 → 记进当天
   关键原则：解析结果永远先给她看，不直接记账；AI 只负责听懂，热量由本地食物库算。
   ─────────────────────────────────────────── */

function bindQuickLog() {
  const input = $('#quickText');
  const btn = $('#quickParse');
  if (!input || !btn) return;
  $('#quickVoice')?.addEventListener('click', () => {
    toast('点输入框，用手机键盘上的话筒图标说话，说完再点「解析这一句」。');
    input.focus();
  });
  btn.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return toast('先写一句她吃了什么。');
    btn.disabled = true;
    btn.textContent = ai.configured ? 'AI 正在解析…' : '正在解析…';
    try {
      await runQuickParse(text);
    } finally {
      btn.disabled = false;
      btn.textContent = '解析这一句';
    }
  });
  if (draft) drawDraft();
}

/** 解析结果用弹层展示：在「今天」页结果本来会被挤到屏幕下面，得滚才看得到 */
function openDraftSheet() {
  if (!draft) return;
  openSheet({
    title: '这样记对吗？',
    body: '<div id="draftHost"></div>',
    onMount: () => {
      drawDraft();
    },
  });
}

async function runQuickParse(text) {
  const meal = quickMealHint || guessMeal();
  let items = [];
  let questions = [];
  let source = 'offline';
  let aiError = null;
  let aiNote = null;

  if (ai.configured) {
    const res = await askAi(text, { meal });
    if (res.ok && res.items.length) {
      const norm = normalizeAiItems(
        { meal: res.meal || meal, items: res.items, questions: res.questions },
        meal,
      );
      items = norm.items;
      questions = norm.questions;
      source = 'ai';
      if (res.note) aiNote = res.note;
    } else {
      aiError = res.error || 'AI 没解析出内容';
    }
  }

  if (!items.length) {
    // 离线兜底（AI 没开、或者 AI 没解析出东西时都走这里）
    const local = parseDescription(text, meal);
    items = local.items;
    if (local.unknown.length) {
      questions = questions.concat(local.unknown.map((u) => `「${u}」我不太确定是什么，能再说具体点吗？（或者用手动记一笔）`));
    }
  }

  for (const it of items) {
    if (it.needsConfirm && it.question) questions.push(it.question);
  }

  draft = {
    text,
    meal,
    items,
    questions: [...new Set(questions)].slice(0, 4),
    source,
    aiError,
    note: aiNote,
  };
  openDraftSheet();
}

/** 把解析结果画成「可以改的清单」 */
function drawDraft() {
  const box = $('#draftHost') || $('#quickResult');
  if (!box || !draft) return;
  if (!draft.items.length && !draft.questions.length) {
    box.innerHTML = '<div class="warn" style="margin-top:10px">这句我没认出来。可以换种说法（比如「一碗牛肉面」），或者用下面的手动记一笔。</div>';
    return;
  }
  const totals = sumItems(draft.items);
  const needsCheck = draft.items.some((it) => it.needsConfirm);
  box.innerHTML = `
    <div class="warn ${draft.source === 'ai' ? 'info' : ''}" style="margin-top:10px">
      解析方式：${draft.source === 'ai' ? 'AI 识别' : '离线识别（常见说法）'}
      ${draft.aiError ? `｜AI 这次没成功：${esc(draft.aiError)}` : ''}
      ${draft.note ? `<br>${esc(draft.note)}` : ''}
    </div>
    ${draft.questions.map((q) => `<div class="warn" style="margin-bottom:6px">想确认一下：${esc(q)}</div>`).join('')}
    <div style="margin-top:8px">
      ${draft.items.map((it, i) => `
        <div class="entry">
          <span class="name">${esc(it.name)}
            ${it.needsConfirm ? '<span class="tag amber">待确认</span>' : ''}
            ${it.warning ? `<em style="display:block;color:#92400e">${esc(it.warning)}</em>` : ''}
          </span>
          <input type="number" value="${it.grams}" data-grams="${i}" class="draft-grams" style="width:80px;padding:4px 6px;font-size:14px">
          <span class="kcal">克</span>
          <span class="kcal">${Math.round(it.kcal)} kcal</span>
        </div>`).join('')}
    </div>
    <div class="row between small" style="margin-top:8px">
      <span>这一餐合计约 <b>${Math.round(totals.kcal)}</b> kcal · 蛋白 ${Math.round(totals.protein)} g</span>
    </div>
    <label class="field" style="margin-top:10px"><span>记到哪一餐</span>
      <div class="chips" id="draftMeal">
        ${MEAL_SLOTS.map((sl) => `<button class="chip ${sl.key === draft.meal ? 'on' : ''}" data-meal="${sl.key}">${sl.label}</button>`).join('')}
      </div>
    </label>
    <div class="btn-row">
      <button class="btn grow" id="draftSave">就这样，记上</button>
      <button class="btn ghost" id="draftCancel">重写</button>
    </div>
    ${needsCheck ? '<p class="tiny muted" style="margin:8px 0 0">有「待确认」的条目也可以直接记 —— 记录本来就有误差，先记上比不记强，之后可以随时改份量。</p>' : ''}`;

  box.querySelectorAll('.draft-grams').forEach((inp) => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.dataset.grams);
      const g = Number(inp.value);
      if (!(g > 0)) return;
      const it = draft.items[idx];
      const ratio = g / it.grams;
      it.grams = Math.round(g);
      it.kcal = Math.round(it.kcal * ratio);
      it.protein = Math.round(it.protein * ratio * 10) / 10;
      it.fat = Math.round(it.fat * ratio * 10) / 10;
      it.carb = Math.round(it.carb * ratio * 10) / 10;
      it.needsConfirm = false;
      const totals2 = sumItems(draft.items);
      const summary = box.querySelector('.row.between.small b');
      if (summary) summary.textContent = Math.round(totals2.kcal);
    });
  });
  $('#draftMeal', box)?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-meal]');
    if (!b) return;
    draft.meal = b.dataset.meal;
    box.querySelectorAll('#draftMeal .chip').forEach((c) => c.classList.toggle('on', c === b));
  });
  $('#draftSave', box)?.addEventListener('click', () => {
    const savedMeal = draft.meal;
    for (const it of draft.items) {
      addFoodEntry(state, dateKey, draft.meal, {
        id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: it.name,
        category: 'custom',
        kcal: it.grams > 0 ? Math.round((it.kcal / it.grams) * 1000) / 10 : it.kcal,
        protein: it.grams > 0 ? Math.round((it.protein / it.grams) * 1000) / 10 : it.protein,
        fat: it.grams > 0 ? Math.round((it.fat / it.grams) * 1000) / 10 : it.fat,
        carb: it.grams > 0 ? Math.round((it.carb / it.grams) * 1000) / 10 : it.carb,
        servings: [['一份', it.grams]],
        fromDescription: true,
      }, it.grams);
    }
    save();
    const n = draft.items.length;
    draft = null;
    closeSheet();
    render();
    // 先给一句落在「记录」这件事上的反馈，再检查有没有解锁新徽章
    const t = targets();
    const msg = afterLogMessage(state, savedMeal, t?.proteinG || 60);
    toast(`${msg.emoji} ${msg.text}`);
    checkNewAchievements();
  });
  $('#draftCancel', box)?.addEventListener('click', () => {
    draft = null;
    closeSheet();
    render();
  });
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
      <div class="card-title">一天怎么吃 <span class="tiny muted">按约 ${Math.round(t.targetCalories / 10) * 10} kcal / 蛋白 ${Math.round(t.proteinG)} g 配</span></div>
      <div class="row between small" style="margin-bottom:6px">
        <span>这份餐单合计约 <b>${Math.round(plan.planKcalWithOil / 10) * 10}</b> kcal、蛋白约 <b>${Math.round(plan.planProteinG)}</b> g</span>
        <span class="tag ${Math.abs(plan.deviation) <= 10 ? 'green' : 'amber'}">${plan.deviation > 0 ? '+' : ''}${Math.round(plan.deviation)}%</span>
      </div>
      ${plan.cookingOilG > 0 ? `<div class="warn info" style="margin-bottom:8px">
        这份餐单里的菜是按下面这个油量做的：全天<b>烹调油 ${plan.cookingOilG} 克</b>（约 ${plan.cookingOilKcal} kcal），
        大约 ${plan.meals.filter((m) => m.oilG > 0).map((m) => `${m.name} ${m.oilG} 克`).join('、')}。
        这个量已经算进上面的总数里了，不用另外再加。
      </div>` : ''}
      <p class="tiny muted" style="margin:0 0 10px">${esc(plan.deviationNote)}</p>
      ${plan.meals.map((m) => `
        <div class="session">
          <h4>${m.name} <span class="tiny muted">${m.kcal} kcal / 蛋白 ${m.proteinG} g${m.oilG ? ` / 油 ${m.oilG} g` : ''}</span></h4>
          <div class="small muted" style="margin-bottom:4px">${esc(m.dishName)}</div>
          <ul>${m.items.map((it) => `<li>${esc(it.food.name)} ${esc(it.desc)}${it.clampedBy ? ' <span class="tag amber">已按热量封顶</span>' : ''}</li>`).join('')}</ul>
        </div>`).join('')}
      <div class="btn-row">
        <button class="btn grow" data-act="use-plan">按这个餐单记入今天</button>
        <button class="btn ghost" data-act="next-plan">换一套</button>
      </div>
      <p class="tiny muted" style="margin:8px 0 0">「记入今天」只是把食物写进今天的记录里，之后可以按实际吃的改份量或删掉。</p>
    </div>

    ${renderCardioCard()}

    <div class="card">
      <div class="card-title">每天的固定提醒</div>
      <ul class="small" style="margin:0;padding-left:18px;color:var(--ink-2)">
        ${buildDailyTips(t, plan.cookingOilG).map((x) => `<li style="margin-bottom:4px">${esc(x)}</li>`).join('')}
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
  bindCardioCard();
}

/**
 * 「今天练什么」：先问她今天有什么器械，再据此推荐；推荐里直接给出「没有 X 就做 Y」。
 * 这是为了让计划跟着现实走 —— 计划写爬坡走，结果健身房只有椭圆机，计划就废了。
 */
function renderCardioCard() {
  const weightKg = state.profile?.weightKg ?? 60;
  const rec = recommendCardio({
    equipment: cardioPick.equipment,
    goal: cardioPick.goal,
    minutes: cardioPick.minutes,
    weightKg,
  });
  const today = getDay(state, dateKey);
  return `
    <div class="card">
      <div class="card-title">今天练什么 <span class="tiny muted">按她今天能用的器械排</span></div>

      <label class="field"><span>今天有哪些器械？（可多选）</span>
        <div class="chips" id="equipChips">
          ${listEquipment().map((eq) => `
            <button class="chip ${cardioPick.equipment.includes(eq.key) ? 'on' : ''}" data-eq="${eq.key}">${eq.icon} ${eq.name}</button>
          `).join('')}
        </div>
      </label>

      <div class="grid2">
        <label class="field"><span>今天想练什么</span>
          <div class="chips" id="goalChips">
            ${Object.entries(GOALS).map(([k, g]) => `<button class="chip ${cardioPick.goal === k ? 'on' : ''}" data-goal="${k}">${g.name}</button>`).join('')}
          </div>
        </label>
        <label class="field"><span>有多少时间</span>
          <div class="chips" id="minuteChips">
            ${[20, 30, 45, 60].map((m) => `<button class="chip ${cardioPick.minutes === m ? 'on' : ''}" data-min="${m}">${m} 分钟</button>`).join('')}
          </div>
        </label>
      </div>

      ${rec.picks.length ? `
        <div class="small muted" style="margin-bottom:8px">${esc(rec.advice)}</div>
        ${rec.picks.map((p, i) => `
          <div class="session cardio-session">
            <h4>${i === 0 ? '首选：' : '也可以：'}${esc(p.name)} <span class="badge cardio">约 ${p.kcal} kcal / ${cardioPick.minutes} 分钟</span></h4>
            <ul>
              <li>怎么做：${esc(p.intensity)}</li>
              <li>要点：${esc(p.cue)}</li>
              <li>注意：${esc(p.note)}</li>
            </ul>
            <button class="add-line" data-log-cardio="${p.id}">今天就做这个（记入记录）</button>
          </div>`).join('')}
        <details style="margin-top:6px">
          <summary class="small" style="cursor:pointer">想做的机器没空？点这里看替代方案</summary>
          <div style="margin-top:8px">
            ${CARDIO.filter((e) => e.equipment.some((q) => cardioPick.equipment.includes(q))).slice(0, 8).map((e) => `
              <div class="search-hit" data-subs="${e.id}">
                <span class="nm">${esc(e.name)}<em>METs ${e.mets} · ${e.tags?.join('/') || ''}</em></span>
                <span class="kk">看替代 →</span>
              </div>`).join('')}
          </div>
        </details>
      ` : `<div class="warn">${esc(rec.advice)}</div>`}

      ${today.exercises.length ? `
        <hr class="sep">
        <div class="small muted">今天已经记了：</div>
        ${today.exercises.map((x) => {
          const ex = EXERCISES[x.exerciseKey] || { name: x.exerciseKey, mets: 4 };
          const kcal = calcExerciseKcal({ mets: ex.mets, weightKg, minutes: x.minutes });
          return `<div class="entry">
            <span class="name">${esc(ex.name)}<em>${x.minutes} 分钟</em></span>
            <span class="kcal">约 ${Math.round(kcal)} kcal</span>
            <button class="del" data-act="del-exercise" data-id="${x.id}">✕</button>
          </div>`;
        }).join('')}
      ` : ''}
    </div>`;
}

/** 有氧卡片的交互：选器械/目标/时长，以及「记入记录」和「看替代」 */
function bindCardioCard() {
  const eqBox = $('#equipChips');
  if (eqBox) {
    eqBox.addEventListener('click', (e) => {
      const b = e.target.closest('[data-eq]');
      if (!b) return;
      const key = b.dataset.eq;
      cardioPick.equipment = cardioPick.equipment.includes(key)
        ? cardioPick.equipment.filter((k) => k !== key)
        : [...cardioPick.equipment, key];
      if (!cardioPick.equipment.length) cardioPick.equipment = ['bodyweight'];
      save();
      render();
    });
  }
  $('#goalChips')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goal]');
    if (!b) return;
    cardioPick.goal = b.dataset.goal;
    render();
  });
  $('#minuteChips')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-min]');
    if (!b) return;
    cardioPick.minutes = Number(b.dataset.min);
    render();
  });
  app.querySelectorAll('[data-log-cardio]').forEach((el) => {
    el.addEventListener('click', () => {
      const ex = CARDIO.find((c) => c.id === el.dataset.logCardio);
      if (!ex) return;
      // 运动记录用 key 存，这里把有氧库的动作映射到运动库（没有对应项就用最接近的）
      const map = {
        incline_treadmill: 'walk', treadmill_walk: 'walk', outdoor_walk: 'walk',
        treadmill_run: 'jog', outdoor_jog: 'jog', treadmill_interval: 'jog',
        elliptical_steady: 'elliptical', elliptical_interval: 'elliptical',
        bike_steady: 'cycle', bike_interval: 'cycle', spin_class: 'cycle', outdoor_cycle: 'cycle',
        rower_steady: 'strength', stair_climber: 'stairs', stepper: 'elliptical',
        jump_rope: 'jump_rope', jump_rope_low: 'jump_rope', bodyweight_circuit: 'hiit', hiit_video: 'hiit',
        real_stairs: 'stairs', swim_steady: 'swim', badminton: 'badminton', dance_class: 'dance',
        yoga_stretch: 'yoga',
      };
      addExercise(state, dateKey, map[ex.id] || 'walk', cardioPick.minutes);
      save();
      render();
      toast(`记上了：${ex.name} ${cardioPick.minutes} 分钟。`);
    });
  });
  app.querySelectorAll('[data-subs]').forEach((el) => {
    el.addEventListener('click', () => {
      openSubstituteSheet(el.dataset.subs);
    });
  });
}

/** 「想做的机器没空」→ 给可用器械下的同类动作 */
function openSubstituteSheet(originalId) {
  const original = CARDIO.find((c) => c.id === originalId);
  if (!original) return;
  const subs = substituteExercises(originalId, cardioPick.equipment, 4);
  const weightKg = state.profile?.weightKg ?? 60;
  const minutes = cardioPick.minutes;
  openSheet({
    title: `${original.name} 做不了？`,
    body: `
      <p class="small muted" style="margin:0 0 10px">
        原动作需要：${original.equipment.map((q) => EQUIPMENT[q]?.name || q).join('、')}。
        按你勾选的可用器械，下面几个效果最接近：
      </p>
      ${subs.length ? subs.map((s) => `
        <div class="session cardio-session">
          <h4>${esc(s.exercise.name)} <span class="badge cardio">约 ${Math.round((s.exercise.mets * weightKg * minutes) / 60)} kcal / ${minutes} 分钟</span></h4>
          <ul>
            <li>为什么能替代：${esc(s.why)}</li>
            <li>怎么做：${esc(s.exercise.intensity)}</li>
            <li>要点：${esc(s.exercise.cue)}</li>
          </ul>
          <button class="add-line" data-subs-log="${s.exercise.id}">就做这个</button>
        </div>`).join('') : '<div class="warn">按现在勾选的器械找不到合适的替代。可以放宽目标（比如改成「不伤膝」），或者把「徒手/地面」勾上 —— 徒手循环不需要任何器械。</div>'}
      <p class="tiny muted">替代原则：先保证练到同一件事（心肺 or 腿臀），再挑不伤膝、能坚持的那个。时长可以先按原计划，强度以「能说话但唱不了歌」为准。</p>`,
    onMount: (body) => {
      body.querySelectorAll('[data-subs-log]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const ex = CARDIO.find((c) => c.id === btn.dataset.subsLog);
          const map = { elliptical_steady: 'elliptical', bike_steady: 'cycle', rower_steady: 'strength', stair_climber: 'stairs', real_stairs: 'stairs', outdoor_walk: 'walk', jump_rope: 'jump_rope', bodyweight_circuit: 'hiit', hiit_video: 'hiit', swim_steady: 'swim', dance_class: 'dance', badminton: 'badminton', yoga_stretch: 'yoga', treadmill_walk: 'walk', outdoor_jog: 'jog' };
          addExercise(state, dateKey, map[ex.id] || 'walk', minutes);
          save();
          closeSheet();
          render();
          toast(`记上了：${ex.name} ${minutes} 分钟。`);
        });
      });
    },
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
        目标体重约 ${t.targetWeightKg} kg，还要减约 ${t.toLoseKg} kg。<br>
        ${t.deficit > 0
          ? `按现在的节奏大约每周减 ${t.weeklyLossKg} kg${t.estimatedWeeks ? `，大概 ${t.estimatedWeeks} 周达到目标` : ''}。<br>`
          : '<b>当前是维持状态</b>：按这个体型，安全下限已经不低于总消耗，暂时没有减脂空间。<br>'}

        蛋白质约 ${Math.round(t.proteinG)} g · 脂肪约 ${Math.round(t.fatG)} g · 碳水约 ${Math.round(t.carbG)} g。
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
    toast('记上了。目标热量会跟着新体重重算。');
    checkNewAchievements();
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
        checkNewAchievements();
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
        checkNewAchievements();
      });
    },
  });
}

/* ── 庆祝：彩条 + 一句话 ─────────────────────
   只在真的解锁新徽章时放，而且要能关掉（有人不喜欢动画）。
   ─────────────────────────────────────────── */

function celebrate(opts) {
  const { emoji, title, sub, badge } = opts;
  if (state?.settings?.celebrations === false) return;
  const el = document.createElement('div');
  el.className = `celebrate${opts.special ? ' special' : ''}`;
  el.innerHTML = `
    <div class="confetti">${Array.from({ length: 14 }, (_, i) => `<i style="--i:${i};--x:${(i * 37) % 100};--d:${(i % 5) * 0.12}s"></i>`).join('')}</div>
    <div class="celebrate-card">
      <div class="celebrate-emoji">${badge || emoji || '🎉'}</div>
      <div class="celebrate-title">${esc(title || '解锁了一个徽章')}</div>
      ${sub ? `<div class="celebrate-sub">${esc(sub)}</div>` : ''}
      <button class="btn block" id="celebrateOk">好</button>
    </div>`;
  document.body.appendChild(el);
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 240); };
  el.querySelector('#celebrateOk').addEventListener('click', close);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  setTimeout(close, 6000);
}

/**
 * 检查有没有刚解锁的徽章，有就庆祝一次（同一个徽章只庆祝一次）。
 * 放在记完一笔、记完体重、记完运动之后调用。
 */
function checkNewAchievements() {
  const t = targets();
  const a = achievements(state, t?.proteinG || 60);
  if (!a.justUnlocked.length) return;
  const first = a.justUnlocked[0];
  markAchievementsSeen(state, a.justUnlocked.map((x) => x.id));
  save();
  celebrate({
    badge: first.emoji,
    title: badgeLabel(state, first),
    sub: first.congrats,
  });

  // 顺带检查有没有踩到「每 10 天」的里程碑
  const mile = hitMilestone(state);
  if (mile && !(state.achievements?.milestones || []).includes(mile.days)) {
    state.achievements.milestones = [...(state.achievements?.milestones || []), mile.days];
    save();
    setTimeout(() => celebrate({
      badge: mile.emoji,
      title: mile.text,
      sub: '记录满这个数了，给你一朵。',
    }), 1400);
  }
}

/* ── 设置页（「我的」）────────────────────
   以前这些东西散在四个地方（AI 在记录页、备份在体重页、资料在头像、示例在今天页尾部）。
   收成一处，找起来才不费劲。
   ─────────────────────────────────────────── */

/**
 * 使用模式：普通 / AI。
 *
 * 这是产品层面的划分，不是「功能阉割」：普通模式自己就能算、能记、能配餐、能给运动方案，
 * 只是说话方式和自由度不如 AI 模式。默认普通模式 —— 大多数人不会去配 API。
 */
function useMode() {
  return state?.settings?.mode === 'ai' ? 'ai' : 'basic';
}

function setMode(next) {
  state.settings = { ...(state.settings || {}), mode: next === 'ai' ? 'ai' : 'basic' };
  if (next !== 'ai') clearDraft();
  save();
  render();
}

function openSettingsSheet() {
  const t = targets();
  const current = useMode();
  const aiCfg = currentAiConfig();
  const plant = plantState(state);
  const a = achievements(state, t?.proteinG || 60);
  const backup = readBackup(localStorage);

  openSheet({
    title: '设置',
    body: `
      <button class="set-row" data-set="profile">
        <span class="set-ico">👤</span>
        <span class="set-main"><b>她的资料</b><em>${state.profile ? `${state.profile.heightCm} cm · ${state.profile.weightKg} kg · ${state.profile.age} 岁` : '还没填'}</em></span>
        <span class="set-go">›</span>
      </button>

      <div class="mode-switch">
        <div class="mode-head">使用模式</div>
        <div class="mode-chips">
          <button class="mode-chip ${current === 'basic' ? 'on' : ''}" data-mode="basic">
            <b>普通模式</b>
            <em>内置规则算，不用配任何东西</em>
          </button>
          <button class="mode-chip ${current === 'ai' ? 'on' : ''}" data-mode="ai">
            <b>AI 模式</b>
            <em>${aiCfg.configured ? '已开启' : '需要填一次 API 密钥'}</em>
          </button>
        </div>
      </div>

      <button class="set-row" data-set="ai">
        <span class="set-ico">✨</span>
        <span class="set-main"><b>AI 设置</b><em>${aiCfg.configured ? `${aiCfg.presetName || ''} · ${aiCfg.model || ''}` : '还没配（普通模式不需要）'}</em></span>
        <span class="set-go">›</span>
      </button>

      <button class="set-row" data-set="growth">
        <span class="set-ico">${plant.stage.emoji}</span>
        <span class="set-main"><b>我的成长</b><em>${a.unlocked.length} / ${a.list.length} 个徽章 · ${plant.stage.name}</em></span>
        <span class="set-go">›</span>
      </button>

      <button class="set-row" data-set="backup">
        <span class="set-ico">💾</span>
        <span class="set-main"><b>数据与备份</b><em>存档 v${SCHEMA_VERSION}${backup ? ` · 有升级前快照（${String(backup.savedAt).slice(0, 10)}）` : ''}</em></span>
        <span class="set-go">›</span>
      </button>

      <button class="set-row" data-set="about">
        <span class="set-ico">ℹ️</span>
        <span class="set-main"><b>关于</b><em>算得准不准、数据存在哪、更新怎么生效</em></span>
        <span class="set-go">›</span>
      </button>

      <p class="tiny muted" style="margin:14px 0 0;text-align:center">
        所有记录只存在这台手机上，不上传。<br>换手机或清缓存前，记得导出备份。
      </p>`,
    onMount: (body) => {
      body.querySelectorAll('[data-mode]').forEach((el) => {
        el.addEventListener('click', () => {
          if (el.dataset.mode === 'ai' && !aiCfg.configured) {
            // 想切到 AI 模式但还没配：直接带她去配，别只弹一句「请先配置」
            closeSheet();
            openAiSettingsSheet();
            return;
          }
          setMode(el.dataset.mode);
          toast(el.dataset.mode === 'ai' ? '已切到 AI 模式。' : '已切到普通模式。');
          openSettingsSheet();
        });
      });
      body.querySelectorAll('[data-set]').forEach((el) => {
        el.addEventListener('click', () => {
          const which = el.dataset.set;
          if (which === 'profile') { closeSheet(); openProfileSheet(); }
          else if (which === 'ai') { closeSheet(); openAiSettingsSheet(); }
          else if (which === 'growth') { closeSheet(); openGrowthSheet(); }
          else if (which === 'backup') openBackupSheet();
          else if (which === 'about') openAboutSheet();
        });
      });
    },
  });
}

/** 数据与备份 */
function openBackupSheet() {
  const backup = readBackup(localStorage);
  const size = (() => {
    try { return Math.round((localStorage.getItem(STORAGE_KEY) || '').length / 1024); } catch { return 0; }
  })();
  const days = Object.keys(state.days || {}).length;

  openSheet({
    title: '数据与备份',
    body: `
      <div class="warn info">
        当前存档：<b>v${SCHEMA_VERSION}</b> · ${days} 天的记录 · 约 ${size} KB<br>
        位置：这台手机的浏览器存储（不上传任何服务器）
      </div>
      <div class="set-note">
        <b>为什么要有备份</b><br>
        换手机、清浏览器缓存、卸载重装都会把本地记录清掉。导出一份存到微信收藏或网盘里最稳妥。
      </div>
      <button class="btn block" id="doExport">导出备份文件</button>
      <div class="btn-row">
        <button class="btn ghost grow" id="doImport">从文件导入</button>
        <button class="btn ghost grow" id="doSnapshot">现在留一份快照</button>
      </div>
      ${backup ? `
        <hr class="sep">
        <div class="set-note">
          <b>升级前的自动快照</b><br>
          时间：${esc(String(backup.savedAt).slice(0, 16).replace('T', ' '))}<br>
          来源版本：v${esc(String(backup.schemaVersion))}<br>
          ${esc(backup.note || '')}
        </div>
        <div class="btn-row">
          <button class="btn ghost grow" id="doRestore">回滚到这份快照</button>
          <button class="btn ghost" id="doForget">删除快照</button>
        </div>` : '<p class="tiny muted" style="margin-top:10px">还没有快照。下次存档结构升级时会自动留一份。</p>'}
    `,
    onMount: (body) => {
      $('#doExport', body).addEventListener('click', exportData);
      $('#doImport', body).addEventListener('click', importData);
      $('#doSnapshot', body).addEventListener('click', () => {
        saveBackup(localStorage, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'), '手动留的快照');
        toast('已留一份快照。');
        openBackupSheet();
      });
      $('#doRestore', body)?.addEventListener('click', () => {
        if (!confirm('用这份快照覆盖当前的记录？当前记录会先被导出保存（以防万一）。')) return;
        const b = readBackup(localStorage);
        if (!b) return toast('快照读不出来了。');
        const migrated = migrateToCurrent(b.data);
        if (!migrated.ok) return toast(migrated.error);
        exportData();
        state = migrated.data;
        save();
        closeSheet();
        render();
        toast('已回滚到快照。');
      });
      $('#doForget', body)?.addEventListener('click', () => {
        if (!confirm('删除这份快照？删掉就不能回滚了。')) return;
        clearBackup(localStorage);
        openBackupSheet();
      });
    },
  });
}

/** 关于：把「算得准不准」讲清楚 */
function openAboutSheet() {
  const t = targets();
  openSheet({
    title: '关于',
    body: `
      <div class="set-note">
        <b>算得准不准</b><br>
        基础代谢用国际通用的公式，误差一般 ±10%。食物热量里，包装食品最准（照标签填），
        炒菜和外卖误差最大（同一道菜不同人放油差一倍）。<br>
        所以真正准的是「体重」页的趋势判断 —— 它按她实际掉秤速度来校准，比任何公式都准。
      </div>
      <div class="set-note">
        <b>数据存在哪</b><br>
        只在这台手机的浏览器里，不上传、不需要注册。<br>
        ${t ? `当前目标：约 ${t.targetCalories} kcal / 蛋白 ${Math.round(t.proteinG)} g` : ''}
      </div>
      <div class="set-note">
        <b>更新怎么生效</b><br>
        应用会自动更新。如果提示「有新版本」，刷新一次页面就生效 ——
        记录不会丢，升级时还会自动留一份快照。
      </div>
      <div class="set-note">
        <b>安全边界（写死在代码里的）</b><br>
        每天不低于基础代谢的 1.1 倍、女生不低于 1200 kcal、每周掉秤不超过体重 1%、
        偏瘦不给减脂方案、不满 18 岁拒绝计算。<br>
        有疾病、怀孕哺乳、在吃影响体重的药，请先问医生。
      </div>
      <div class="set-note">
        <b>版本</b><br>
        存档结构 v${SCHEMA_VERSION} · 应用每次推送自动发布
      </div>`,
  });
}

/* ── 弹层：成长（成就墙 + 小植物 + 周报）───── */

function openGrowthSheet() {
  const t = targets();
  const a = achievements(state, t?.proteinG || 60);
  const plant = plantState(state);
  const review = weeklyReview(state, { proteinTarget: t?.proteinG || 60, calorieTarget: t?.targetCalories || 1500 });
  const hl = weeklyHighlight(review);
  const showWeekly = shouldShowWeekly(state);
  const recent = a.unlocked.slice(-6).reverse();

  openSheet({
    title: '我的成长',
    body: `
      <div class="plant-box">
        <div class="plant-emoji">${plant.stage.emoji}</div>
        <div class="plant-info">
          <div class="plant-name">${esc(plant.stage.name)}</div>
          <div class="tiny muted">${esc(plant.line)}</div>
          <div class="plant-bar"><i style="width:${plant.nextStage ? Math.min(100, Math.round((plant.total / plant.nextStage.min) * 100)) : 100}%"></i></div>
          <div class="tiny muted">${plant.nextStage ? `再记 ${plant.toNext} 天，就会${esc(plant.nextStage.name)}` : '已经长到最大了 🌳'}</div>
        </div>
      </div>

      ${showWeekly ? `
        <div class="card" style="margin-top:12px;box-shadow:none;background:#FFFCFC;border:1px solid var(--line)">
          <div class="card-title">这周的小结</div>
          <div class="hl">${hl.emoji} <b>${esc(hl.text)}</b></div>
          ${review.lines.map((l) => `<div class="small muted" style="margin:4px 0">· ${esc(l)}</div>`).join('')}
          <div class="week-dots">
            ${review.days.map((d) => `<span class="${d.logged ? 'on' : ''}" title="${d.date}">${d.date.slice(-2)}</span>`).join('')}
          </div>
        </div>` : ''}

      <div class="card" style="margin-top:12px;box-shadow:none;background:#FFFCFC;border:1px solid var(--line)">
        <div class="card-title">徽章墙 <span class="tiny muted">${a.unlocked.length} / ${a.list.length}</span></div>
        <div class="badge-grid">
          ${a.list.map((x) => `
            <div class="ach ${x.unlocked ? 'on' : ''}" data-ach="${x.id}">
              <span class="ach-emoji">${x.unlocked ? x.emoji : '🔒'}</span>
              <span class="ach-name">${esc(badgeLabel(x))}</span>
              ${x.unlocked ? '' : `<span class="ach-bar"><i style="width:${x.pct}%"></i></span>`}
            </div>`).join('')}
        </div>
        <p class="tiny muted" style="margin:10px 0 0">
          徽章只跟「记录、吃够蛋白、动起来」有关 —— 我们没有"少吃几天"这种徽章，那类目标长期是有害的。
        </p>
      </div>

      ${recent.length ? `
        <div class="small muted" style="text-align:center;margin-top:10px">最近拿到：${recent.map((x) => x.emoji + x.name).join('、')}</div>` : ''}`,
    onMount: (body) => {
      body.querySelectorAll('[data-ach]').forEach((el) => {
        el.addEventListener('click', () => {
          const x = a.list.find((y) => y.id === el.dataset.ach);
          if (!x) return;
          toast(x.unlocked ? `${x.emoji} ${x.congrats}` : `${x.hint}（${x.value}/${x.target}）`);
        });
      });
    },
  });
}

/* ── 弹层：日历 ─────────────────────────────
   点顶部日期打开。有记录的日期会标出来（点 + 记录条数），一眼能看出「哪几天没记」。
   另外给了「连续记录天数」——比单看某一天更能反映坚持情况。
   ─────────────────────────────────────────── */

/** 某天的记录概况 */
export function dayStats(state, key) {
  const day = state.days?.[key];
  if (!day) return { entries: 0, kcal: 0, exercises: 0, hasWeight: false };
  const entries = Object.values(day.meals || {}).flat();
  const kcal = entries.reduce((a, e) => a + calcEntry(e.food, e.grams).kcal, 0);
  return {
    entries: entries.length,
    kcal: Math.round(kcal),
    exercises: (day.exercises || []).length,
    hasWeight: (state.weights || []).some((w) => w.date === key),
  };
}

/** 连续记录天数（从今天往前数，允许今天还没记） */
export function streakDays(state, today = todayKey()) {
  let streak = 0;
  let cursor = today;
  if (dayStats(state, cursor).entries === 0) cursor = shiftDate(cursor, -1); // 今天还没记不算断
  for (let i = 0; i < 400; i++) {
    if (dayStats(state, cursor).entries === 0) break;
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }
  return streak;
}

function openCalendarSheet() {
  let month = dateKey.slice(0, 7); // YYYY-MM
  const draw = () => {
    const [y, m] = month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const startWeekday = first.getDay(); // 0=周日
    const daysInMonth = new Date(y, m, 0).getDate();
    const today = todayKey();
    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);

    const streak = streakDays(state);
    const monthStats = cells.filter(Boolean).map((k) => dayStats(state, k));
    const logged = monthStats.filter((s) => s.entries > 0).length;

    openSheet({
      title: `${y} 年 ${m} 月`,
      body: `
        <div class="row between" style="margin-bottom:10px">
          <button class="btn ghost" id="calPrev">‹ 上个月</button>
          <button class="btn ghost" id="calToday">回到今天</button>
          <button class="btn ghost" id="calNext">下个月 ›</button>
        </div>
        <div class="warn info" style="margin-bottom:10px">
          本月记了 <b>${logged}</b> 天${streak ? `｜当前连续记录 <b>${streak}</b> 天` : ''}
        </div>
        <div class="cal-week">${['日', '一', '二', '三', '四', '五', '六'].map((w) => `<span>${w}</span>`).join('')}</div>
        <div class="cal-grid">
          ${cells.map((k) => {
            if (!k) return '<span class="cal-cell empty"></span>';
            const st = dayStats(state, k);
            const d = Number(k.slice(-2));
            const cls = [
              'cal-cell',
              k === dateKey ? 'selected' : '',
              k === today ? 'today' : '',
              st.entries ? 'has-data' : '',
            ].filter(Boolean).join(' ');
            return `<button class="${cls}" data-date="${k}">
              <span class="d">${d}</span>
              ${st.entries ? `<span class="mark">${st.entries}</span>` : ''}
            </button>`;
          }).join('')}
        </div>
        <p class="tiny muted" style="margin-top:10px">
          格子里的数字是当天记了几条。没记的日子一眼能看出来 —— 漏记比记错更影响判断。
        </p>`,
      onMount: (body) => {
        body.querySelectorAll('[data-date]').forEach((btn) => {
          btn.addEventListener('click', () => {
            dateKey = btn.dataset.date;
            closeSheet();
            render();
          });
        });
        $('#calPrev', body).addEventListener('click', () => {
          const [yy, mm] = month.split('-').map(Number);
          const d = new Date(yy, mm - 2, 1);
          month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          draw();
        });
        $('#calNext', body).addEventListener('click', () => {
          const [yy, mm] = month.split('-').map(Number);
          const d = new Date(yy, mm, 1);
          month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          draw();
        });
        $('#calToday', body).addEventListener('click', () => {
          dateKey = todayKey();
          closeSheet();
          render();
        });
      },
    });
  };
  draw();
}

/* ── 弹层：AI 设置 ─────────────────────────
   默认「直连」：密钥存在这台手机上，手机直接调服务商，不需要电脑、不需要服务器。
   想更保险的人可以切到「走电脑中转」，那样密钥存在电脑上（但要开着电脑、同一个 Wi-Fi）。
   ─────────────────────────────────────────── */

let lastModels = [];

async function openAiSettingsSheet() {
  const cfg = currentAiConfig();
  const relay = await relayStatus(1200);
  drawAiSettings(cfg, relay);
}

function drawAiSettings(cfg, relay) {
  const presetId = cfg.presetId || 'deepseek';
  const preset = findPreset(presetId);
  const mode = cfg.mode || (preset.directCall === false ? 'relay' : 'direct');
  const directOk = preset.directCall !== false;

  const body = `
    <label class="field"><span>选一个服务商</span>
      <div class="chips" id="presetChips">
        ${PRESETS.map((p) => `
          <button class="chip ${presetId === p.id ? 'on' : ''}" data-preset="${p.id}">
            ${esc(p.name)}${p.recommended ? ' ★' : ''}${p.directCall === false ? ' ⚠' : ''}
          </button>`).join('')}
      </div>
    </label>
    <div id="presetNote" class="small muted" style="margin:-4px 0 12px"></div>

    <label class="field"><span>接口地址</span>
      <input type="text" id="aiBaseUrl" value="${esc(cfg.baseUrl || preset.baseUrl || '')}" placeholder="https://api.deepseek.com">
    </label>

    <label class="field"><span>模型名 <button class="btn ghost" id="aiFetchModels" style="padding:2px 8px;font-size:12px;float:right">获取模型列表</button></span>
      <input type="text" id="aiModel" value="${esc(cfg.model || preset.model || '')}" placeholder="deepseek-chat" list="aiModelList" autocomplete="off">
      <datalist id="aiModelList">${lastModels.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
      <div id="modelPick" class="chips" style="margin-top:6px"></div>
    </label>

    <label class="field"><span>密钥（只存在这台手机上）</span>
      <input type="text" id="aiKey" placeholder="${cfg.keyMasked ? `已保存：${esc(cfg.keyMasked)}（留空则不改）` : '粘贴服务商的 API Key'}" autocomplete="off" autocapitalize="off" spellcheck="false">
    </label>

    <label class="field"><span>用哪种方式连接</span>
      <div class="chips" id="modeChips">
        <button class="chip ${mode === 'direct' ? 'on' : ''}" data-mode="direct">手机直连（推荐）</button>
        <button class="chip ${mode === 'relay' ? 'on' : ''}" data-mode="relay">走电脑中转</button>
      </div>
    </label>
    <div id="modeNote" class="tiny muted" style="margin:-6px 0 12px"></div>

    <div id="aiSettingsMsg"></div>
    ${cfg.configured ? `<div class="small muted">当前生效：${esc(cfg.presetName || '')} · ${esc(cfg.model || '')} · 密钥 ${esc(cfg.keyMasked || '')}</div>` : ''}
    <div class="tiny muted" style="margin-top:8px" id="relayInfo">
      本机中转服务：${relay.available ? (relay.configured ? '在运行且已配置' : '在运行但没配密钥') : '没在运行（不影响手机直连）'}
    </div>
    <p class="tiny muted">
      直连说明：密钥保存在这台手机的浏览器里，只发给上面这个服务商。手机上点「清除密钥」可以随时删掉。
      换手机或清缓存会丢设置，重新填一次即可（记录本身也有导出备份）。
    </p>`;

  const foot = `
    <button class="btn block" id="aiSave">保存并测试连通</button>
    <div class="btn-row">
      <button class="btn ghost grow" id="aiTest">只测当前连通</button>
      ${cfg.configured ? '<button class="btn ghost grow" id="aiClear">清除密钥</button>' : ''}
    </div>`;

  openSheet({ title: 'AI 设置', body, foot });
  const bodyEl = $('#sheetBody');
  const msg = $('#aiSettingsMsg');
  const show = (html, kind = 'info') => { msg.className = `warn ${kind}`; msg.innerHTML = html; };

  let pickedMode = mode;

  const renderModeNote = () => {
    $('#modeNote').textContent = pickedMode === 'relay'
      ? '走电脑中转：密钥保存在电脑上（不会发到手机），但必须开着电脑、且手机连同一个 Wi-Fi。'
      : (directOk
        ? '手机直连：不需要电脑，走到哪都能用。密钥存在这台手机上，只发给服务商。'
        : `注意：${preset.name} 不允许网页直接调用，这一家请选「走电脑中转」。`);
  };
  renderModeNote();

  const applyPreset = (id, { overwrite = true } = {}) => {
    const p = findPreset(id);
    $('#presetNote').innerHTML = `${esc(p.note)}${p.keyUrl ? ` <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">去拿密钥 →</a>` : ''}`;
    if (overwrite) {
      if (p.baseUrl) $('#aiBaseUrl').value = p.baseUrl;
      if (p.model) $('#aiModel').value = p.model;
      $('#aiKey').placeholder = p.allowEmptyKey ? '本地模型随便填，例如 ollama' : '粘贴服务商的 API Key';
      if (p.directCall === false) {
        pickedMode = 'relay';
      } else if (pickedMode === 'relay' && !relay.configured) {
        pickedMode = 'direct';
      }
      bodyEl.querySelectorAll('#modeChips .chip').forEach((c) => c.classList.toggle('on', c.dataset.mode === pickedMode));
      renderModeNote();
    }
    updateModelChips();
  };

  const updateModelChips = () => {
    const box = $('#modelPick');
    if (!box) return;
    box.innerHTML = lastModels.slice(0, 8).map((m) => `
      <button class="chip ${$('#aiModel').value.trim() === m ? 'on' : ''}" data-model="${esc(m)}">${esc(m)}</button>`).join('');
  };

  applyPreset(presetId, { overwrite: false });

  bodyEl.querySelectorAll('#presetChips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      bodyEl.querySelectorAll('#presetChips .chip').forEach((c) => c.classList.toggle('on', c === chip));
      applyPreset(chip.dataset.preset);
    });
  });
  bodyEl.querySelectorAll('#modeChips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      pickedMode = chip.dataset.mode;
      bodyEl.querySelectorAll('#modeChips .chip').forEach((c) => c.classList.toggle('on', c === chip));
      renderModeNote();
    });
  });
  $('#modelPick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-model]');
    if (!b) return;
    $('#aiModel').value = b.dataset.model;
    updateModelChips();
  });

  // 获取模型列表：直接问服务商（问不到就走本机中转）
  $('#aiFetchModels').addEventListener('click', async () => {
    const baseUrl = $('#aiBaseUrl').value.trim();
    const key = $('#aiKey').value.trim() || readLocalKey();
    if (!baseUrl) return show('先填接口地址。', '');
    show('正在向服务商查询模型列表…', 'info');
    const r = await fetchModels({ baseUrl, apiKey: key });
    if (!r.ok) {
      return show(`没拿到模型列表：${esc(r.error)}<br>可以直接手填模型名，或者点服务商说明里的「去拿密钥」页面查看可用模型。`, '');
    }
    lastModels = r.models;
    const dl = $('#aiModelList');
    dl.innerHTML = r.models.map((m) => `<option value="${esc(m)}"></option>`).join('');
    // 当前模型不在列表里时，自动选第一个（这就是「默认模型过时」的解法）
    if (!$('#aiModel').value.trim() || !r.models.includes($('#aiModel').value.trim())) {
      $('#aiModel').value = r.models[0];
    }
    updateModelChips();
    show(`拿到 ${r.models.length} 个模型${r.via === 'relay' ? '（经电脑中转查询）' : ''}，已选「${esc($('#aiModel').value)}」。下面列的是前 8 个，也可以直接在输入框里挑。`, 'info');
  });

  function readLocalKey() {
    const c = currentAiConfig();
    return c.configured ? (readAiConfigRaw()?.apiKey || '') : '';
  }
  function readAiConfigRaw() {
    try { return JSON.parse(localStorage.getItem('fatloss.ai.v1') || 'null'); } catch { return null; }
  }

  const collect = () => ({
    presetId: bodyEl.querySelector('#presetChips .chip.on')?.dataset.preset || 'custom',
    baseUrl: $('#aiBaseUrl').value.trim(),
    model: $('#aiModel').value.trim(),
    apiKey: $('#aiKey').value.trim(),
    mode: pickedMode,
  });

  $('#aiSave').addEventListener('click', async () => {
    const input = collect();
    if (!input.baseUrl) return show('接口地址要填。', '');
    if (!input.model) return show('模型名要填 —— 可以点「获取模型列表」自动带出来。', '');
    if (!input.apiKey && !cfg.configured) return show('密钥还没填。', '');
    const saved = saveAiConfigLocal(input);
    if (!saved.ok) return show(esc(saved.problems.join('；')), '');
    show('已保存，正在测试连通…', 'info');
    const t = await testConnection();
    if (t.ok) {
      show(`✅ 保存成功，连通正常（${esc(t.model || '')} 回复：${esc(t.reply || '正常')}）<br>现在她怎么写都能听懂了。`, 'info');
      ai = { configured: true, checked: true, mode: currentAiConfig().mode };
    } else {
      show(`设置已保存，但连通测试失败：<b>${esc(t.error)}</b><br>修好之前会用离线识别记录（常见说法也能认）。`, '');
      ai = { configured: false, checked: true, reason: t.error };
    }
    render();
  });

  $('#aiTest')?.addEventListener('click', async () => {
    show('正在测试…（最多 20 秒）', 'info');
    const r = await testConnection();
    if (r.ok) show(`✅ 连通正常（${esc(r.model || '')} 回复：${esc(r.reply || '正常')}）${r.via === 'relay' ? '（走电脑中转）' : ''}`, 'info');
    else show(`❌ ${esc(r.error)}`, '');
  });

  $('#aiClear')?.addEventListener('click', () => {
    if (!confirm('清除这台手机上保存的 AI 密钥？清除后会退回离线识别，随时可以重新填。')) return;
    clearAiConfig();
    ai = { configured: false, checked: true };
    closeSheet();
    render();
    toast('已清除。现在走离线识别。');
  });
}

/* ── 弹层：资料 ──────────────────────────── */

/**
 * 资料校验。界面上的红字提示只是提示，保存前必须真的挡住，
 * 否则清空身高会存进 heightCm:0，目标热量静默掉到 1200 而用户不知道。
 * @returns {string|null} 有问题就返回说明，没问题返回 null
 */
export function validateProfile(form) {
  const ranges = {
    age: [LIMITS.ageYears[0], LIMITS.ageYears[1], '年龄'],
    heightCm: [LIMITS.heightCm[0], LIMITS.heightCm[1], '身高'],
    weightKg: [LIMITS.weightKg[0], LIMITS.weightKg[1], '体重'],
  };
  for (const [key, [lo, hi, label]] of Object.entries(ranges)) {
    const v = form[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${label}要填一个数字。`;
    if (v < lo || v > hi) return `${label}要在 ${lo}~${hi} 之间。`;
  }
  if (form.age < 18) return '这个工具只适合 18 岁以上使用，未成年人请先问医生。';
  // 昵称是可选的，不校验；空值由 nickname() 统一回落到默认名
  if (form.bodyFatPct !== null && form.bodyFatPct !== undefined) {
    const bf = form.bodyFatPct;
    if (typeof bf !== 'number' || !Number.isFinite(bf) || bf < 3 || bf > 60) {
      return '体脂率要么留空，要么填 3~60 之间的数（填的是百分数，例如 25）。';
    }
  }
  if (form.targetWeightKg !== null && form.targetWeightKg !== undefined) {
    if (typeof form.targetWeightKg !== 'number' || !Number.isFinite(form.targetWeightKg)) return '目标体重要么留空，要么填数字。';
    if (form.targetWeightKg < LIMITS.weightKg[0] || form.targetWeightKg > LIMITS.weightKg[1]) {
      return `目标体重要在 ${LIMITS.weightKg[0]}~${LIMITS.weightKg[1]} 之间。`;
    }
  }
  return null;
}

function openProfileSheet() {
  const p = state.profile || {
    nickname: '',
    sex: 'female', age: 25, heightCm: 163, weightKg: 58, bodyFatPct: null,
    activity: 'light', pace: 'standard', goal: 'lose', targetWeightKg: null,
  };
  const hasProfile = Boolean(state.profile);
  openSheet({
    title: hasProfile ? '我的资料' : '填写资料',
    body: `
      <label class="field"><span>怎么称呼她</span>
        <input type="text" id="pNickname" value="${esc(p.nickname || '')}" maxlength="8" placeholder="选填，例如：小繁">
        <span class="tiny muted" style="margin-top:4px;display:block">会用在问候和周报里。留空就不称呼。</span>
      </label>
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
        nickname: ($('#pNickname', body).value || '').trim().slice(0, 8),
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
        const invalid = validateProfile(f);
        if (invalid) {
          preview.className = 'warn';
          preview.textContent = invalid;
          return;
        }
        try {
          const t = calcTargets({ ...f, targetWeightKg: f.targetWeightKg });
          const tw = f.targetWeightKg || defaultTargetWeight(f);
          preview.className = 'warn info';
          const gapText = t.deficit > 0
            ? `消耗约 ${Math.round(t.tdee / 10) * 10} − 缺口约 ${Math.round(t.deficit / 10) * 10}`
            : `消耗约 ${Math.round(t.tdee / 10) * 10}，已经是维持（安全下限不低于消耗）`;
          preview.innerHTML = `每天大约吃 <b>${Math.round(t.targetCalories / 10) * 10} kcal</b>（${gapText}）·
            蛋白约 ${Math.round(t.proteinG)} g / 脂肪约 ${Math.round(t.fatG)} g / 碳水约 ${Math.round(t.carbG)} g<br>
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
        const invalid = validateProfile(f);
        if (invalid) {
          toast(invalid);
          return;
        }
        try {
          const t = calcTargets({ ...f, targetWeightKg: f.targetWeightKg });
          state.profile = { ...f, targetWeightKg: f.targetWeightKg || round(defaultTargetWeight(f), 1) };
          if (!state.weights.some((w) => w.date === todayKey())) addWeight(state, todayKey(), f.weightKg);
          save();
          closeSheet();
          view = 'today';
          document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'today'));
          render();
          toast(`已保存。她每天的目标大约是 ${Math.round(t.targetCalories / 10) * 10} kcal。`);
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
        checkNewAchievements();
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
        const migrated = migrateToCurrent(parsed);
        if (!migrated.ok) {
          toast(migrated.error);
          return;
        }
        if (!confirm('导入会覆盖现在这台设备上的所有记录，确定吗？')) return;
        state = migrated.data;
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

// 离线缓存要无条件注册：放在「有资料」的分支里会导致第一次打开（欢迎页）不注册，
// 结果装到主屏幕后第一次断网就打不开。
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const register = () => navigator.serviceWorker.register('sw.js').catch((err) => console.warn('离线缓存未启用：', err));
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
}

// 问一次服务端「AI 配好了没」。没配也不影响使用，只是走离线解析。
aiStatus().then((st) => { ai = { ...st, checked: true }; if (view === 'log') render(); }).catch(() => {});

const bootParams = new URLSearchParams(location.search);
if (bootParams.has('__selfcheck')) {
  selfCheck();
} else if (bootParams.get('demo') === '1') {
  // ?demo=1：一键进演示（GitHub Pages 上可以直接把链接发人看）
  state = emptyState();
  state.profile = demoProfile();
  const demoToday = todayKey();
  demoEntries(state, demoToday, calcTargets(state.profile));
  addWeight(state, shiftDate(demoToday, -14), 59.4);
  addWeight(state, demoToday, 58);
  save();
  render();
} else if (!state) {
  state = emptyState();
  renderWelcome();
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'today'));
  bindCommon();
} else {
  render();
}

// 启动时如果发生过数据迁移（或读不出来），第一时间告诉她 —— 这种信息不能藏
if (startupNotice) {
  setTimeout(() => {
    if (startupNotice.kind === 'error') {
      celebrate({ badge: '⚠️', title: '记录读取有问题', sub: startupNotice.text });
    } else {
      toast(startupNotice.text);
    }
  }, 600);
}

// 启动成功的标记：浏览器自检靠它判断「模块有没有炸掉导致白屏」
window.__appReady = true;

