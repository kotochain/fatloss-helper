/**
 * 减脂小助手 —— 界面与交互
 * 数据全部存在这台设备上（浏览器本地存储），不联网、不上传。
 */

import {
  calcTargets, calcEntry, calcExerciseKcal, diffAgainstTargets, macroSplit,
  defaultTargetWeight, ACTIVITY_LEVELS, GOAL_PACE, LIMITS, round,
  isProfileUsable, validateProfile, sumEntries, toPer100,
} from './calc.js';
import { FOODS, FOOD_CATEGORIES, findFood, parseAmount, kcalOnlyFood } from './foods.js';
import { icon } from './icons.js';
import { searchFoods, MEAL_SLOTS } from './foodlog.js';
import {
  listExercises, buildWeekPlan, EXERCISES,
  TRAINING_INTENSITY, trainingActions, trainingSummary, trainingHistory,
  resolveTrainingAction, logTraining, describeTraining, estimateTrainingKcal,
} from './exercise.js';
import {
  normalizeAiItems, sumItems, cachedOnlyMatch, findPortion, gramsForPortion,
} from './mealparse.js';
import {
  askAi, aiStatus, currentAiConfig, saveAiConfigLocal, clearAiConfig,
  testConnection, fetchModels, relayStatus, presetDirectCall,
  readLabelImage, askCoach,
} from './ai.js';
import { buildCoachBrief, localCoachAdvice, checkCoachText } from './coach.js';
import { labelToPer100, checkConsistency, photoRetakeHint } from './label.js';
import { PRESETS, findPreset } from './providers.js';
import {
  achievements, plantState, weeklyReview, weeklyHighlight, afterLogMessage,
  markAchievementsSeen, shouldShowWeekly, nickname, greeting, hitMilestone, badgeLabel, dailyNudge,
  currentStreak,
} from './achievements.js';
import {
  CARDIO, EQUIPMENT, GOALS, recommendCardio, substituteExercises, listEquipment, normalizeEquipment,
  normalizeCardioGoal, normalizeCardioMinutes,
} from './cardio.js';
import { buildMealPlan, buildDailyTips } from './recommend.js';
import { nextSteps, nextStepsTitle } from './nextsteps.js';
import { buildRecap, recapLines } from './recap.js';
import { insights, insightHint } from './insights.js';
import { APP_VERSION, CHANGELOG } from './version.js';
import { pendingUpdates } from './whatsnew.js';
import { hasNewerVersion, canRefreshNow, updateBannerText, AUTO_UPDATE_FLAG } from './update.js';
import {
  SCHEMA_VERSION, STATE_KEY, loadState, migrateToCurrent, migrate, readBackup, clearBackup, saveBackup, describeMigration,
  readUnreadable,
} from './schema.js';
import {
  emptyState, todayKey, shiftDate, getDay, addFoodEntry, removeFoodEntry,
  addExercise, removeExercise, addWeight, addCustomFood, weightTrend, analyzeProgress,
  demoProfile, demoEntries, frequentFoods, recordedDays, hasUserData,
} from './store.js';

const STORAGE_KEY = STATE_KEY; // 键名只有一份定义（schema.js），别在两处写字面量
const $ = (sel, root = document) => root.querySelector(sel);

/**
 * 启动时的提示（数据迁移、读取失败）。
 * **必须声明在 load() 之前**：load() 会在模块顶层立刻执行，而它要给这个变量赋值。
 * 之前它写在 200 行之后，结果是 —— 只要手机里有存档，一打开就白屏
 * （`Cannot access 'startupNotice' before initialization`），而且新用户不受影响，
 * 所以本地跑测试一直没暴露。这是最该记住的一课：模块顶层调用的函数，不能用后面才声明的 let。
 */
let startupNotice = null;

/**
 * 上一次**由本页**写进本地存储的原文。
 *
 * 为什么要记：两个标签页/窗口同时开着时，各自持有一份整包存档，
 * 后保存的会把先保存的整个盖掉（用户看不见、也找不回）。
 * 每次保存前比一下「存储里的原文还是不是本页上次写的那份」：
 * 不是就说明别的窗口写过，这一笔先不写，改为把对方的数据接过来并说清原因。
 */
let lastWrittenRaw = null;

let state = load();
// 资料存在但残缺：退回「还没填资料」，但原始资料原样留着，不删用户的东西
if (state && state.profile && !isProfileUsable(state.profile)) {
  state.legacyProfile = state.profile;
  state.profile = null;
  startupNotice = {
    kind: 'error',
    text: '这台手机上的资料读不完整（身高/体重/年龄/性别至少缺一项），没法算目标。以前的记录都还在，重新填一下资料就好。',
  };
}
let view = 'today';
let dateKey = todayKey();
let planSeed = 0;
let pendingFood = null;
/** 「说一句」流程的临时状态：解析出来的条目等用户确认 */
let draft = null;
/** AI 是否可用（进界面时问一次服务端） */
let ai = { configured: false, checked: false, reason: null };
/** 「说一句」是从哪一餐点进来的（界面上的餐次提示，默认按时间猜） */
let quickMealHint = null;
/** 教练弹层当前展示什么（本地版 / AI 版 / 正在问 / 失败原因） */
let coachView = null;
/** 有氧推荐的选择（器械勾过就存在 settings 里，刷新/重开都还在） */
let cardioPick = {
  equipment: normalizeEquipment(state?.settings?.equipment),
  // 目标和时长也存过就带回来：用户固定练 45 分钟、想练低冲击，不该每次重选
  goal: normalizeCardioGoal(state?.settings?.cardioGoal),
  minutes: normalizeCardioMinutes(state?.settings?.cardioMinutes),
};
/**
 * 勾/取消一个器械：界面上的两处（计划页、记录→练的）共用这一份，勾完立刻存盘。
 * 全部取消时留「徒手」—— 一个都没有的话推荐不出任何动作（跟以前的行为一致）。
 */
function toggleEquipment(key) {
  const cur = normalizeEquipment(cardioPick.equipment);
  const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
  cardioPick.equipment = next.length ? next : ['bodyweight'];
  if (state) {
    state.settings = state.settings || {};
    state.settings.equipment = [...cardioPick.equipment];
    save();
  }
  render();
}

/** 目标/时长的选择也存进 settings（跟器械一样，重开还在） */
function setCardioGoal(key) {
  cardioPick.goal = normalizeCardioGoal(key);
  if (state) {
    state.settings = state.settings || {};
    state.settings.cardioGoal = cardioPick.goal;
    save();
  }
  render();
}

function setCardioMinutes(minutes) {
  cardioPick.minutes = normalizeCardioMinutes(minutes);
  if (state) {
    state.settings = state.settings || {};
    state.settings.cardioMinutes = cardioPick.minutes;
    save();
  }
  render();
}

/**
 * 「练的」那一半正在填的东西。
 * 放在模块里而不是当场读输入框：换分段、切换器械重绘之后，已经填好的时长和备注不能丢。
 */
let trainingPick = { cardioId: null, exerciseKey: null, minutes: 30, intensity: '', note: '' };
/** 器械选择器展开着没有 —— 展开时点一个器械会重绘，重绘不该把它又收起来 */
let trainingEquipOpen = false;
const app = $('#app');

/* ── 存档 ────────────────────────────────── */

function load() {
  const res = loadState(localStorage, { key: STORAGE_KEY });
  if (!res.ok) {
    // 读不出来或版本太新：绝不用空数据覆盖用户的记录
    startupNotice = { kind: 'error', text: res.error };
    console.warn('存档读取失败：', res.error);
    return null;
  }
  if (res.data && res.upgradedFrom) {
    startupNotice = { kind: 'ok', text: describeMigration(res) };
  }
  // 记下本页看到的存档原文：之后别的窗口写过，保存前才能发现并让路（见 save()）
  try { lastWrittenRaw = localStorage.getItem(STORAGE_KEY); } catch { lastWrittenRaw = null; }
  return res.data;
}

/** 上一次存盘成功了没有 —— 用来拦住「存不进去」之后又报喜 */
let lastSaveOk = true;

/**
 * 把别的窗口写的最新存档接过来。
 *
 * 只在「确认别的窗口写过」时调用：要么保存时发现存档被改过，要么收到 storage 事件。
 * 接过来之后本页的内存状态就是存储里的最新那份，下一次保存不会再覆盖别人。
 */
function adoptExternalState(message = '') {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* 读不到就只提示，至少不覆盖 */ }
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.days) {
        state = migrate(parsed);
        lastWrittenRaw = raw;
        hideSyncBanner();
        render();
      }
    } catch {
      // 对方写的内容坏了：不动内存里的数据，至少不会把它盖掉
      console.warn('另一个窗口的存档读不出来，先不切换');
    }
  }
  toast(message || '另一个窗口改了记录，已换成最新的那份。');
}

function save() {
  try {
    const rawNow = localStorage.getItem(STORAGE_KEY);
    /*
     * 别的窗口在本页上次保存之后又写过：这份内存数据已经旧了，
     * 直接写下去会把对方的新记录整个盖掉（用户看不见、也找不回）。
     * 所以先让路：接过来对方的版本，并说清楚这一笔没记上。
     */
    if (lastWrittenRaw !== null && rawNow !== lastWrittenRaw) {
      lastSaveOk = false;
      adoptExternalState('另一个窗口刚改过记录，这一笔没记上 —— 看一眼最新记录，再点一次就好。');
      return false;
    }
    state.schemaVersion = SCHEMA_VERSION;
    const json = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, json);
    lastWrittenRaw = json;
    lastSaveOk = true;
    return true;
  } catch (err) {
    // 存不进手机（存储满/隐私模式）时，只报这一句实话；后面不许再弹「记上了」。
    lastSaveOk = false;
    toast('存不进去了（浏览器存储可能满了），请到「我的 → 数据与备份」导出，再清理一下空间。');
    console.error(err);
    return false;
  }
}

/*
 * 另一个窗口/标签页存了盘 —— 本页手里的数据就旧了。
 * 空闲时直接同步（不然会出现「页面上有、其实已经被人改掉」的错觉）；
 * 正在填东西（面板开着 / 输入框里有字）时只挂一条提示，绝不把输入到一半的内容冲掉。
 * 等关面板时会自动补同步（见 closeSheet）。
 */
let syncBanner = null;
function showSyncBanner() {
  if (syncBanner) return;
  const el = document.createElement('div');
  el.className = 'sync-banner';
  const text = document.createElement('span');
  text.textContent = '另一个窗口改了记录';
  const btn = document.createElement('button');
  btn.className = 'btn ghost';
  btn.textContent = '同步';
  btn.addEventListener('click', () => adoptExternalState('已同步到另一个窗口的最新记录。'));
  el.append(text, btn);
  document.body.appendChild(el);
  syncBanner = el;
}
function hideSyncBanner() { if (syncBanner) { syncBanner.remove(); syncBanner = null; } }

window.addEventListener('storage', (e) => {
  if (!e || e.key !== STORAGE_KEY || !e.newValue) return;
  const sheetOpen = !$('#sheetRoot').classList.contains('hidden');
  const ae = document.activeElement;
  const typing = Boolean(ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && String(ae.value || '').trim());
  if (sheetOpen || typing) { showSyncBanner(); return; }
  adoptExternalState('另一个窗口改了记录，已同步到这里。');
});

/**
 * 用户的每日目标 —— **只由公式决定，跟餐单无关**。
 *
 * 这里曾经让目标跟着餐单对账（为了让「目标」和「餐单」一致），
 * 但那是错的：同一个人的目标会随「换一套」在 36~69 克脂肪之间跳，
 * 甚至会压穿 0.6 g/kg 的安全线（独立核验实测：9.67% 的正常体型组合中招）。
 * 目标必须是稳定的 —— 它同时决定首页圆环、达成率和成就的达标线。
 *
 * 餐单给不到目标时，由餐单自己如实说明差多少、怎么补（见 recommend.js 的 deviationNote）。
 */
function targets() {
  if (!state.profile || !isProfileUsable(state.profile)) return null;
  return calcTargets(state.profile);
}

/* ── 小工具 ──────────────────────────────── */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 顶部短提示。
 * iconName 可选：图标是我们自己的内联 SVG（可信），正文用 textContent 塞进去 ——
 * 食物名里可能有尖括号之类的字符，不能拼进 HTML。
 */
function toast(msg, iconName = '') {
  const el = document.createElement('div');
  el.className = 'toast';
  if (iconName) {
    // 徽章在 toast 里出现得比较多，16px 会糊成一团；线性图标 18px 也不挤
    el.innerHTML = icon(iconName, { size: 18 });
  }
  const text = document.createElement('span');
  text.textContent = msg;
  el.appendChild(text);
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

/** 把一个日期键说成人话：今天 / 昨天 / 明天 / 10月14日 周二 */
function dayLabel(key) {
  const today = todayKey();
  if (key === today) return '今天';
  if (key === shiftDate(today, -1)) return '昨天';
  if (key === shiftDate(today, 1)) return '明天';
  const [, m, d] = key.split('-');
  return `${Number(m)}月${Number(d)}日 ${weekdayLabel(key)}`;
}

function dateLabel() {
  return dayLabel(dateKey);
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
  /*
   * 面板开着时如果别的窗口改过记录，只在顶部挂了提示（怕冲掉正在填的内容）。
   * 关面板了就补上同步 —— 否则下一次保存会拿旧数据把对方的新记录盖掉。
   */
  if (syncBanner) adoptExternalState('已同步另一个窗口的最新记录。');
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

/**
 * 界面坏了时的兜底页。
 *
 * 设计原则：**绝不让人卡在点不动的页面**。所以这里给三个出口，
 * 而且第一个是最安全的（先让用户能用），最后才是清数据（会丢记录，必须用户说清才做）。
 */
function renderCrash(err, which) {
  const where = { today: '今天', log: '记录', plan: '计划', progress: '我的' }[which] || which;
  app.innerHTML = `
    <div class="card">
      <div class="card-title">这一页出了点问题</div>
      <p class="small muted" style="margin:0 0 12px">
        「${esc(where)}」这一页没能显示出来。你的记录还在，不用怕 —— 先试试下面第一个按钮。
      </p>
      <button class="btn block" data-act="crash-retry">重新打开这一页</button>
      <div class="btn-row">
        <button class="btn ghost grow" data-act="crash-other">回到今天</button>
        <button class="btn ghost grow" data-act="crash-export">先导出备份</button>
      </div>
      <details style="margin-top:14px">
        <summary class="tiny muted" style="cursor:pointer">技术信息（可以截图发给我）</summary>
        <p class="tiny muted" style="word-break:break-all;margin:8px 0 0">${esc(String(err && err.message || err))}</p>
      </details>
      <p class="tiny muted" style="margin:14px 0 0">
        如果一直打不开，可以用「我的 → 设置 → 数据与备份」导出记录，然后重新开始。
      </p>
    </div>`;
  bindCommon();
}

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
    try {
      renderWelcome();
    } catch (err) {
      console.error('欢迎页渲染失败：', err);
      renderCrash(err, 'welcome');
      return;
    }
    // 这个 return 曾经直接跳过了末尾的 bindCommon()，
    // 于是欢迎页上所有 [data-act] 按钮都点不动 —— 用户报的「卡页面死机点都点不了」就是它。
    // 教训：渲染函数和「绑事件」必须成对，不能让中间某个 return 把绑定漏掉。
    bindCommon();
    return;
  }
  // 有资料但没走完引导：补一句提示，不硬拦（用户可能只是想先看看）
  // 引导入口固定放在欢迎页和「我的 → 设置」里，不重复弹窗打扰。
  // 错误边界：任何一个界面抛异常，都不许让应用变成点不动的砖头。
  // 之前没有这层保护 —— renderToday 里任何一处报错都会让页面停在半渲染状态，
  // 表现就是用户说的「卡页面死机点都点不了」。宁可显示一个能救回来的界面。
  try {
    if (view === 'today') renderToday();
    else if (view === 'log') renderLog();
    else if (view === 'plan') renderPlan();
    else renderProgress();
  } catch (err) {
    console.error('界面渲染失败：', err);
    renderCrash(err, view);
    return;
  }
  bindCommon();
  if (view === 'today') {
    bindQuickLog();
  }
  syncTestState();
}

/**
 * 给当前页面里所有 [data-act] 按钮绑事件。
 *
 * 幂等：同一个按钮只绑一次（用 dataset.bound 记着）。
 * 为什么需要幂等：renderCrash、欢迎页、正常渲染都各自要绑，
 * 万一哪条路径重复调用，按钮就会被绑两次 —— 点一下执行两次（表现是"记了两笔"）。
 */
function bindCommon() {
  app.querySelectorAll('[data-act]').forEach((el) => {
    if (el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('click', () => {
      // 点了没反应是最难查的问题（用户只会说「点不动」）。
      // 所以这里兜住异常：至少弹一句，让用户知道发生了什么。
      try {
        handleAction(el.dataset.act, el.dataset);
      } catch (err) {
        console.error(`操作失败（${el.dataset.act}）：`, err);
        toast('这一步没能完成，可以再试一次。');
      }
    });
  });
}

function handleAction(act, data) {
  switch (act) {
    case 'add-food': return openFoodSheet(data.meal);
    case 'growth': return openGrowthSheet();
    case 'insights': return openInsightsSheet();
    case 'coach': return openCoachSheet();
    case 'ai-settings': return openAiSettingsSheet();
    case 'crash-retry': view = view || 'today'; return render();
    case 'crash-other': return goView('today');
    case 'crash-export': return exportData();
    case 'recover': return openRecoverSheet();
    case 'export-unreadable': return exportUnreadable();
    case 'wipe': return openWipeSheet();
    case 'onboard': return onboard({ step: 'intro' });
    case 'go-log':
      // 这两条都是「记吃」的入口，所以要把记录页切回「吃的」那一半 ——
      // 上次停在「练的」时如果不切，用户点「搜索食物」会落到运动那一半上，找不到输入框
      state.settings.recordTab = 'food';
      return goView('log');
    case 'quick-fill': {
      quickMealHint = data.meal || null;
      state.settings.recordTab = 'food';
      goView('log');
      const ta = $('#quickText');
      if (ta) {
        if (data.text) ta.value = data.text;
        ta.focus();
        toast(data.text ? '已经帮你填好了，点「解析这一句」就行。' : '在这里写一句，会自动记到你那一餐。');
      }
      return;
    }
    case 'nudge-yesterday': {
      // 补记昨天：把当前日期切到昨天，再进「说一句」。
      // 不自动切回今天（用户可能还想补别的），但会告诉他怎么回去。
      dateKey = shiftDate(todayKey(), -1);
      state.settings = { ...(state.settings || {}), recordTab: 'food' };
      save();
      goView('log');
      const ta = $('#quickText');
      if (ta) { ta.focus(); toast('现在记到昨天。记完点顶部日期 →「回到今天」就行。'); }
      return;
    }
    case 'nudge-skip-yesterday': {
      // 只跳过「今天」这一天：明天打开如果昨天还是空的，还会再问一次（但不会骂人）
      state.settings = { ...(state.settings || {}), yesterdayNudgeSkipped: todayKey() };
      save();
      render();
      return;
    }
    case 'del-food': {
      const day = getDay(state, dateKey);
      const entry = Object.values(day.meals).flat().find((e) => e.id === data.id);
      const what = entry ? (entry.food.kcalOnly ? `${entry.food.name}（${entry.food.kcal} kcal）` : `${entry.food.name} ${entry.grams} 克`) : '';
      if (entry && confirm(`删除「${what}」？`)) {
        removeFoodEntry(state, dateKey, data.id);
        save();
        render();
      }
      return;
    }
    case 'add-exercise': return openExerciseSheet();
    case 'del-exercise':
      // 历史列表里可能列出别的日子的记录，所以删除要认记录自己那一天，
      // 不能用当前选中的日期（否则会去错误的那天找一个不存在的 id，删不掉也不报错）
      removeExercise(state, data.date || dateKey, data.id);
      save();
      render();
      return;
    case 'use-plan': return usePlanForToday();
    case 'next-plan': planSeed += 1; render(); return;
    case 'edit-profile': return openProfileSheet();
    case 'log-weight': return openWeightSheet();
    case 'export': return exportData();
    case 'import': return importData();
    case 'demo': return requestDemo();
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

/* ── 新手引导 ───────────────────────────────
   为什么要做：第一次打开的人面对的是一个空界面和一堆没解释的词（目标热量、碳蛋脂、METs）。
   引导要解决三件事，一件都不能少：
     1) 让用户知道「这工具是干嘛的、数据在哪」（信任）
     2) 拿到算目标需要的几个数字（不然什么都算不出来）
     3) **让用户当场把 AI 配好** —— v44 起这一步是硬性的：产品只有 AI 一条理解路径，
        所以第 3 步不再给「先跳过」，配好才进最后一步；教程要手把手（官网 → 登录 → 密钥 → 粘贴），
        并且说清「API 的钱是给服务商的，跟我们无关」。
   最后一定要让用户**记下第一笔**再结束 —— 空着的应用用户不会再打开第二次。
   ─────────────────────────────────────────── */

const ONBOARD_STEPS = ['intro', 'profile', 'mode', 'first'];

/**
 * 新手引导。
 * @param {{step?:string, targets?:object, review?:boolean}} options
 *   review=true 表示「重看一遍」：走完回设置页，而且**不要**重置已经选好的模式、
 *   也不要把用户推到记录页（用户只是忘了怎么用，不是新人）。
 */
function onboard({ step, targets: t = null, review = false } = {}) {
  if (step === 'intro') return onboardIntro(review);
  if (step === 'profile') {
    // 重看时不逼用户重填资料：有资料就直接跳到模式那一步
    if (review && state.profile) return onboard({ step: 'mode', targets: calcTargets(state.profile), review });
    return openProfileSheet({ firstTime: true, onSaved: (tt) => onboard({ step: 'mode', targets: tt, review }) });
  }
  if (step === 'mode') return onboardMode(t, review);
  if (step === 'first') return onboardFirst(review);
  return onboardIntro(review);
}

function onboardIntro(review = false) {
  openSheet({
    title: '先说三件事',
    body: `
      <div class="onboard-step">1 / 4</div>
      <div class="onboard-hero">${icon('bowl', { size: 52 })}</div>
      <div class="onboard-h">
        <b>它帮你算「今天该吃多少」</b>
        <p>不是让你少吃，是让你知道自己在吃多少。填几个数字，它会算出你的热量和蛋白脂肪碳水目标，
        然后按这个给你配餐、配运动。</p>
      </div>
      <div class="onboard-h">
        <b>记录只要说一句话</b>
        <p>「中午在食堂吃了碗牛肉面，加了个蛋」—— 它听得懂。说不清份量的时候它会问你一句，
        不会瞎猜。</p>
      </div>
      <div class="onboard-h">
        <b>你的数据只在这台手机上</b>
        <p>不联网、不上传、不需要注册。换手机或清缓存前记得导出备份（在「我的」里）。
        它只做估算和记录，不是医疗建议。</p>
      </div>`,
    foot: `<button class="btn block" id="obNext">${review ? '继续' : '开始'}</button>`,
    onMount: (_b, foot) => {
      $('#obNext', foot).addEventListener('click', () => onboard({ step: 'profile', review }));
    },
  });
}

function onboardMode(t, review = false) {
  const kcal = t ? Math.round(t.targetCalories / 10) * 10 : null;
  const cfg = currentAiConfig();
  openSheet({
    title: '配好 AI 再开始',
    body: `
      <div class="onboard-step">3 / 4</div>
      ${kcal ? `<div class="warn info">你每天的目标大约是 <b>${kcal} kcal</b>。</div>` : ''}
      <div class="onboard-h">
        <b>这个应用靠 AI 听懂你说的话</b>
        <p>「中午在食堂吃了碗牛肉面，加了个蛋」—— 说人话就行，剩下的交给 AI：
        它把这句话拆成食物和份量，再按本地食物库算热量。所以这一步必须做完才能开始记。</p>
      </div>
      <div class="onboard-h">
        <b>要准备两样东西</b>
        <p>一个手机号（注册用）、支付宝或微信（充值用，10 元能用很久）。
        不用懂技术 —— 点下面的按钮，里面有一份<b>从打开官网到粘贴密钥的手把手教程</b>，
        跟着点就行。</p>
      </div>
      <div class="onboard-h">
        <b>关于钱：这笔钱不是给我们的</b>
        <p>AI 由 <b>DeepSeek 官方按用量收费</b>，钱直接付给 DeepSeek。
        我们<b>不收任何费用</b>，也拿不到你的密钥、看不到你的账单 —— 这笔交易跟我们无关。
        觉得贵随时可以换别家服务商（教程里有说明）。</p>
      </div>`,
    foot: `
      <button class="btn block" id="obAi">${cfg.configured ? '已经配好了，继续' : '开始配置（手把手教）'}</button>`,
    onMount: (_b, foot) => {
      $('#obAi', foot).addEventListener('click', () => {
        closeSheet();
        if (cfg.configured) onboard({ step: 'first', review });
        else openAiSettingsSheet({ then: () => onboard({ step: 'first', review }) });
      });
    },
  });
}

function onboardFirst(review = false) {
  openSheet({
    title: '最后一步',
    body: `
      <div class="onboard-step">4 / 4</div>
      <div class="onboard-hero">${icon('plant-sprout', { size: 52 })}</div>
      <div class="onboard-h">
        <b>${review ? '记一笔试试' : '记下第一笔，就开始了'}</b>
        <p>不用追求记得准。第一笔随便记点什么 —— 早饭、一杯奶茶、一顿外卖都行。
        记录本身就会让它越来越懂你：记满 4 天，「你的规律」里就会出现只属于你的结论。</p>
      </div>
      <div class="onboard-h">
        <b>怎么记</b>
        <p>在「记录」页说一句话，或者点「加一笔」手动搜食物。<br>
        练了什么也能记 —— 记录页切到「练的」。</p>
      </div>`,
    foot: `<button class="btn block" id="obGo">去记一笔</button>
      <button class="btn ghost block" id="obLater" style="margin-top:8px">我先随便看看</button>`,
    onMount: (_b, foot) => {
      $('#obGo', foot).addEventListener('click', () => {
        finishOnboarding(review);
        goView('log');
        setTimeout(() => { $('#quickText')?.focus(); }, 300);
      });
      $('#obLater', foot).addEventListener('click', () => {
        finishOnboarding(review);
        goView(review ? 'progress' : 'today');
      });
    },
  });
}

/** 引导只做一次；记在存档里，换设备要重新走（数据不在，走了才有意义） */
function finishOnboarding(review = false) {
  state.settings = { ...(state.settings || {}), onboarded: true, lastSeenVersion: APP_VERSION };
  save();
  closeSheet();
  render();
  if (review) return; // 重看一遍不需要再提示一遍目标
  setTimeout(() => {
    const t = targets();
    if (t) toast(`记一笔试试。你今天的目标是约 ${Math.round(t.targetCalories / 10) * 10} kcal。`);
  }, 500);
}

/** 切到某个标签页（多处要用，抽出来免得每处都写一遍 classList 循环） */
function goView(next) {
  view = next;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === next));
  render();
  window.scrollTo({ top: 0 });
}

function renderWelcome() {
  /*
   * 存档读不出来（损坏 / 来自更新版本）时，欢迎页必须**一直**说这件事。
   * 以前只弹一个 6 秒的浮层，关掉之后页面跟全新用户一模一样 ——
   * 用户既不知道记录出了问题，也不知道再去点「看一个填好的例子」会把原来的内容盖掉。
   * 原始内容已经在 schema.js 里另存了一份（UNREADABLE_KEY），这里负责让用户看见、能导出来。
   */
  const trouble = startupNotice?.kind === 'error'
    ? `
    <div class="card" style="border:1px solid #F3C7CF;background:#FFF6F7">
      <div class="card-title">${icon('alert', { size: 16 })} 有一份记录没读出来</div>
      <p class="small" style="margin:0 0 8px">${esc(startupNotice.text)}</p>
      <p class="tiny muted" style="margin:0 0 12px">
        原始内容我已经原样留在这台手机里了，没有删。你可以先导出一份发我，或者重新开始 —— 原来的记录不会因为重新开始就被抹掉。
      </p>
      <div class="btn-row">
        <button class="btn ghost grow" data-act="export-unreadable">导出一份原始文件</button>
        <button class="btn ghost grow" data-act="recover">试试恢复</button>
      </div>
    </div>`
    : '';
  app.innerHTML = `
    ${trouble}
    <div class="card">
      <div class="onboard-hero">${icon('bowl', { size: 52 })}</div>
      <div class="card-title">知道自己在吃多少，比少吃更有用</div>
      <p class="small muted" style="margin:0 0 14px">
        记一句话就能记下吃了什么，它会算出你每天该吃多少、给你配餐和运动方案。
        数据只在这台手机上，不联网、不上传。
      </p>
      <button class="btn block" data-act="onboard">开始（约 1 分钟）</button>
      <div class="btn-row">
        <button class="btn ghost grow" data-act="edit-profile">直接填资料</button>
        <button class="btn ghost grow" data-act="demo">看一个填好的例子</button>
      </div>
      <div class="btn-row">
        <button class="btn ghost grow" data-act="recover">已经用过？点这里找回记录</button>
      </div>
      <p class="tiny muted" style="margin:12px 0 0">
        它只做估算和记录，不是医疗建议。如果你怀孕/哺乳、有甲状腺或肾脏问题、在吃影响体重的药，
        或者年龄未满 18 岁，请先问医生，不要照这里的数字吃。
      </p>
    </div>`;
}

/**
 * 演示入口。
 *
 * `?demo=1` 这个链接的用途是「发给别人看一眼」，但它在**任何**手机上都会整包覆盖存档。
 * 自己的手机打开一次，几个月的记录就没了 —— 所以有记录时必须先问，并且留快照。
 * 没有记录（新装）就直接进，不要拦。
 */
function requestDemo() {
  if (!hasUserData(state)) return startDemo();
  const days = recordedDays(state).length;
  const what = days > 0 ? `这台设备上有 ${days} 天的记录` : '这台设备上已经填好资料了';
  openSheet({
    title: '看演示会覆盖现在的记录',
    body: `
      <div class="warn">${what}。演示会用一份假数据把它整包换掉。</div>
      <div class="set-note">
        换之前会<b>自动留一份快照</b>。看完演示想回来，在「我的 → 数据与备份」里点「回滚」就行。
      </div>`,
    foot: `
      <button class="btn block" id="demoGo">留快照并看演示</button>
      <button class="btn ghost block" id="demoCancel">取消</button>`,
    onMount: (body, foot) => {
      $('#demoGo', foot).addEventListener('click', () => { closeSheet(); startDemo(); });
      $('#demoCancel', foot).addEventListener('click', closeSheet);
    },
  });
}

/** 真的装演示数据（整包替换，只由 requestDemo 调用） */
function startDemo() {
  const hadData = hasUserData(state);
  // 有东西就先留底：演示的代价不能是「记录没了」
  if (hadData) saveBackup(localStorage, state, '看演示之前的自动快照');
  state = emptyState();
  state.profile = demoProfile();
  // 示例是「新装上的样子」，不是老用户升级 —— 不该弹更新说明
  state.settings = { trainDays: 3, stepsKey: 'mid', lastSeenVersion: APP_VERSION };
  const t = calcTargets(state.profile);
  demoEntries(state, todayKey(), t);
  addWeight(state, shiftDate(todayKey(), -14), 59.2);
  addWeight(state, todayKey(), 58);
  save();
  view = 'today';
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'today'));
  render();
  toast(hadData
    ? '已填入示例数据。你原来的记录留了快照，看完在「我的 → 数据与备份」里能回滚。'
    : '已填入一份示例数据（26 岁女性 163cm 58kg），可以随便改。');
}

/* ── 今天 ────────────────────────────────── */

/** 某天吃进去的合计（只读：绝不因为「看了一眼」就新建空日子） */
function totalsOfDay(day) {
  // 合计逻辑只有一份（calc.js#sumEntries），这里只负责把当天的条目摊平
  return sumEntries(Object.values(day?.meals || {}).flat());
}

function renderToday() {
  const t = targets();
  if (!t) return renderWelcome();
  const day = getDay(state, dateKey);
  const totals = totalsOfDay(day);

  // 运动消耗按记录里的 METs 算（老记录没有 mets 时退回旧池），跟记录页/计划页同一套
  const exerciseKcal = day.exercises.reduce((a, x) => a + estimateTrainingKcal(x, state.profile.weightKg), 0);
  /**
   * 当天可吃的额度就是目标热量，不加任何运动补偿。
   *
   * 这里曾经把消耗的一半加进额度，去掉了，原因是它把同一次运动算了两遍：
   * 用户的活动量在资料里已经算过一次（选「轻度活动」= BMR × 1.375，已包含平时的走动）。
   * 再加回来额度就凭空变多 —— 58 kg 的人爬坡走 30 分钟多出 91 kcal，一周 640 kcal，
   * 够把「每周减 0.5%」变成「几乎不减」。而且这是这类 App 最坑人的地方：
   * 练了就奖励自己多吃，缺口全抹平，还觉得自己很努力。
   *
   * 现在用户每天都吃同一个数，最容易执行；动的那天缺口自然更大。
   */
  const budget = t.targetCalories;
  const remaining = Math.round(budget - totals.kcal);
  const pct = Math.min(100, Math.round((totals.kcal / budget) * 100));
  const cls = totals.kcal > budget * 1.05 ? 'over' : totals.kcal < budget * 0.8 ? 'under' : 'ok';
  const diff = diffAgainstTargets(totals, t);
  const split = macroSplit(totals);
  /*
   * v36（issue #14 A）：今天页的「顺手做两件事」。
   * 只在「今天」这一页给（过去的日期给「现在可以做什么」没有意义）；
   * 今天一笔都没记时不显示 —— 那时由上面的「接住」卡负责，避免同一句话说两遍。
   */
  const steps = dateKey === todayKey() ? nextSteps({ state, totals, targets: t, today: dateKey }) : [];

  const R = 78;                       // 圆环半径
  const CIRC = 2 * Math.PI * R;
  const ringPct = Math.max(0, Math.min(1, totals.kcal / budget));
  const offset = CIRC * (1 - ringPct);
  const settled = remaining < 0;      // 超了就把圆环走满
  const streak = currentStreak(state);
  const exerciseMin = day.exercises.reduce((a, x) => a + x.minutes, 0);
  const plant = { state: plantState(state), ach: achievements(state, t.proteinG) };
  const greet = greeting(state);
  // v32：今天页的「接住」——今天空着就提醒先记一口；昨天空着就问要不要补（各只一句）
  const nudge = dateKey === todayKey() ? dailyNudge(state) : null;
  const macros = diff.filter((d) => d.key !== 'kcal');

  app.innerHTML = `
    ${nudge ? `
      <div class="card nudge">
        ${nudge.kind === 'today-empty' ? `
          <p class="nudge-title">今天还空着</p>
          <p class="nudge-text">先记一口也算 —— 一句话就行，不用纠结准不准。</p>
          <button class="btn block" data-act="quick-fill">说一句</button>` : `
          <p class="nudge-title">昨天没记，要补一笔吗？</p>
          <p class="nudge-text">补上之后连续记录就能接上；不补也没关系，今天记了就算重新开始。</p>
          <div class="btn-row">
            <button class="btn grow" data-act="nudge-yesterday">补记昨天</button>
            <button class="btn ghost" data-act="nudge-skip-yesterday">不补了</button>
          </div>`}
      </div>` : ''}

    <div class="card hero">
      <div class="greet">${icon(greet.icon, { size: 18 })} <span>${greet.name ? `${esc(greet.word)}，<b>${esc(greet.name)}</b>` : esc(greet.word)}</span></div>
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
      ${exerciseKcal >= 30 ? `<div class="bonus-pill"><svg viewBox="0 0 24 24" class="ic"><use href="#i-fire"/></svg>今天动了 ${exerciseMin} 分钟 · 约 ${Math.round(exerciseKcal)} kcal（估算，不用吃回来）</div>` : ''}

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
        ${streak >= 1 ? `<span class="stat"><svg viewBox="0 0 24 24" class="ic"><use href="#i-fire"/></svg>连续记录 <b>${streak}</b> 天</span>` : ''}
        ${exerciseMin ? `<span class="stat"><svg viewBox="0 0 24 24" class="ic"><use href="#i-today"/></svg>今天运动 <b>${exerciseMin}</b> 分钟</span>` : ''}
        <span class="stat"><svg viewBox="0 0 24 24" class="ic"><use href="#i-pin"/></svg>蛋白 <b>${Math.round((totals.protein / t.proteinG) * 100)}%</b></span>
      </div>
    </div>

    ${myInsights(3).length || insightHint(state) ? `
      <div class="card insight-card">
        <div class="card-title">你的规律</div>
        ${myInsights(3).map((x) => `
          <div class="insight">
            <span class="insight-ico">${icon(x.icon, { size: 18 })}</span>
            <div>
              <b>${esc(x.title)}</b>
              <p>${esc(x.detail)}</p>
            </div>
          </div>`).join('')}
        ${insightHint(state) ? `<p class="tiny muted" style="margin:8px 0 0">${esc(insightHint(state).text)}</p>` : ''}
        ${myInsights(3).length ? `<button class="btn ghost block" style="margin-top:10px" data-act="insights">看全部规律</button>` : ''}
      </div>` : ''}

    <div class="card coach-card">
      <div class="card-title">接下来怎么吃</div>
      <p class="tiny muted" style="margin:0 0 10px">用你今天的记录算的，不猜、不编。</p>
      <button class="btn ghost block" data-act="coach">问教练</button>
    </div>

    <button class="plant-card" data-act="growth">
      <span class="plant-icon-sm">${icon(plant.state.stage.icon, { size: 30 })}</span>
      <span class="plant-text">
        <b>${esc(plant.state.stage.name)}</b>
        <em>${plant.ach.unlocked.length} 个徽章 · ${plant.state.nextStage ? `再记 ${plant.state.toNext} 天长大` : '已长成'}</em>
      </span>
      <span class="plant-go">看成长 ›</span>
    </button>

    ${steps.length ? `
      <div class="card steps">
        <div class="card-title">${esc(nextStepsTitle(steps.length))}</div>
        ${steps.map((st) => `
          <div class="step" data-step="${esc(st.key)}">
            <div class="step-body">
              <b>${esc(st.title)}</b>
              <p>${esc(st.text)}</p>
            </div>
            ${st.action ? `<button class="btn ghost step-go" data-act="${esc(st.action)}"${st.payload?.meal ? ` data-meal="${esc(st.payload.meal)}"` : ''}${st.payload?.text ? ` data-text="${esc(st.payload.text)}"` : ''}>${st.action === 'log-weight' ? '去记' : '记这笔'}</button>` : ''}
          </div>`).join('')}
      </div>` : ''}

    <button class="btn block big-log" data-act="go-log">
      <span class="big-log-plus">＋</span> 记一笔
    </button>
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
            <span class="name">${esc(e.food.name)}<em>${e.food.kcalOnly ? '按热量记' : `${e.grams} 克`}</em></span>
            <span class="kcal">${Math.round(f.kcal)} kcal</span>
            <button class="del" data-act="del-food" data-id="${e.id}" aria-label="删除">${icon('close', { size: 14 })}</button>
          </div>`;
        }).join('') || '<div class="tiny muted">还没记</div>'}
        <div class="row" style="gap:6px;margin-top:8px">
          <button class="add-line grow" data-act="add-food" data-meal="${slot.key}" style="margin-top:0">＋ 加食物</button>
          <button class="add-line grow" data-act="quick-fill" data-meal="${slot.key}" style="margin-top:0">${icon('chat', { size: 15 })} 说一句</button>
        </div>
      </div>`;
    }).join('')}

    <div class="card">
      <div class="card-title">今天的运动 <span class="tiny muted">消耗按体重和时长估算</span></div>
      ${day.exercises.map((x) => {
        const info = describeTraining(x, state.profile.weightKg);
        return `<div class="entry">
          <span class="name">${esc(info.name)}<em>${info.minutes} 分钟${info.intensityName ? ` · ${esc(info.intensityName)}` : ''}</em></span>
          <span class="kcal">约 ${info.kcal} kcal</span>
          <button class="del" data-act="del-exercise" data-id="${x.id}" aria-label="删除">${icon('close', { size: 14 })}</button>
        </div>`;
      }).join('') || '<div class="tiny muted">还没记（走路也算，记上会更准）</div>'}
      <button class="add-line" data-act="add-exercise">＋ 加运动</button>
      <p class="tiny muted" style="margin:8px 0 0">消耗是按体重和时长估的（手环通常偏高）。这部分不会加进你能吃的额度 —— 动了就多吃，缺口就白练了。</p>
    </div>

`;
}

/** 根据已吃的，给一句「接下来怎么吃」 */
/* ── 记录页 ──────────────────────────────── */

/**
 * 记录页的两个分段：吃的 / 练的。
 *
 * 为什么不新增底部标签页：底部已经四个了，再加一个会把「今天」推远；
 * 运动本来就是「记录」的一部分，和吃饭记在一起才顺手。
 * 上次停在哪一半存在 settings.recordTab 里（老存档没有这个字段 → 按「吃的」处理）：
 * 减脂的人一天要记好几顿饭，不能每次都让用户重新点一下。
 */
function currentRecordTab() {
  return state.settings?.recordTab === 'training' ? 'training' : 'food';
}

function setRecordTab(tab) {
  const next = tab === 'training' ? 'training' : 'food';
  if (next === currentRecordTab()) return;
  state.settings.recordTab = next;
  save();
  render();
  // 换分段要回到顶部：不回的话会停在上一半的中间位置，看起来像点了没反应
  window.scrollTo({ top: 0 });
}

function renderLog() {
  const tab = currentRecordTab();
  app.innerHTML = `
    <div class="segments" id="recordTabs" role="tablist" aria-label="记什么">
      <button class="seg-btn ${tab === 'food' ? 'on' : ''}" data-record-tab="food" role="tab" aria-selected="${tab === 'food'}">${icon('bowl', { size: 16 })} 吃的</button>
      <button class="seg-btn ${tab === 'training' ? 'on' : ''}" data-record-tab="training" role="tab" aria-selected="${tab === 'training'}">${icon('run', { size: 16 })} 练的</button>
    </div>
    ${tab === 'training' ? renderTrainingPane() : renderFoodPane()}`;
  app.querySelectorAll('[data-record-tab]').forEach((b) => {
    b.addEventListener('click', () => setRecordTab(b.dataset.recordTab));
  });
  // 两个分段各绑各的：绑错分段会拿到 null 的输入框，点一下就报错
  if (tab === 'training') bindTrainingPane();
  else bindFoodPane();
}

/** 「吃的」那一半：内容跟原来一模一样（说一句 / 手动记 / 常吃的 / 全部食物 / 自定义） */
function renderFoodPane() {
  const recent = frequentFoods(state, 8);
  return `
    <div class="card">
      <div class="card-title">说一句就记上
        <button class="mode-pill" id="usageModeBtn" title="AI 设置">
          ${ai.configured ? 'AI 已开启' : '还没配 AI'}<span class="mode-pill-go">›</span>
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
}

/** 「吃的」那一半的交互：搜索、常吃的、自定义、说一句 */
function bindFoodPane() {
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
  $('#customFoodBtn').addEventListener('click', () => openLabelSheet());
  bindQuickLog();
  // 模式胶囊在「说一句」卡片右上角：点它就是切模式（不是跳 AI 配置，那是两件事）
  $('#usageModeBtn')?.addEventListener('click', () => openAiSettingsSheet());
  app.querySelectorAll('[data-act="quick-add"]').forEach((el) => {
    el.addEventListener('click', () => {
      const food = [...state.customFoods, ...FOODS].find((f) => f.id === el.dataset.id);
      openAmountSheet(food, guessMeal());
    });
  });
}

/* ── 记录页：练的（运动记录）───────────────────
   为什么和「吃的」并列放在记录页，而不是塞进「计划」页：
    1) 练完想马上记一笔，第一反应是点「记录」；
    2) 「计划」页是「今天练什么」的建议 —— 建议和记录分开，换建议不会动到已经记下的东西。
   消耗一律是估算，界面上必须写清楚（手环给的数字通常更高）。
   红线：这里算出来的消耗**不参与**当天可吃额度的计算，只用来显示。
   ─────────────────────────────────────────── */

/** 默认选一个动作：先用「计划」页排出来的首选，其次是当前器械能做的第一个 */
function defaultTrainingPick(actions) {
  const rec = recommendCardio({
    equipment: cardioPick.equipment,
    goal: cardioPick.goal,
    minutes: Number(trainingPick.minutes) || 30,
    weightKg: state.profile?.weightKg ?? 60,
  });
  const first = rec.picks.find((p) => actions.cardio.some((e) => e.id === p.id)) || actions.cardio[0];
  if (first) trainingPick.cardioId = first.id;
  else if (actions.strength.length) trainingPick.exerciseKey = actions.strength[0].key;
}

/** 选好的动作如果已经做不了了（器械被取消勾选），要换掉 —— 否则会记下一个做不了的动作 */
function ensureTrainingPick(actions) {
  const cardioOk = trainingPick.cardioId && actions.cardio.some((e) => e.id === trainingPick.cardioId);
  const strengthOk = trainingPick.exerciseKey && actions.strength.some((s) => s.key === trainingPick.exerciseKey);
  if (cardioOk || strengthOk) return;
  trainingPick.cardioId = null;
  trainingPick.exerciseKey = null;
  defaultTrainingPick(actions);
}

/** 这次运动的大致消耗（只用于显示，不参与额度计算） */
function currentTrainingKcal() {
  const weightKg = state.profile?.weightKg ?? 60;
  const action = resolveTrainingAction(trainingPick);
  const minutes = Number(trainingPick.minutes);
  if (!action || !(minutes > 0)) return { action: null, minutes: 0, kcal: 0, weightKg };
  return {
    action,
    minutes,
    weightKg,
    kcal: Math.round(estimateTrainingKcal({ mets: action.mets, minutes }, weightKg)),
  };
}

/** 算式直接写在界面上：用户可以自己核对，不用信一个来路不明的数字 */
function drawTrainingEstimate() {
  const box = $('#trainEstimate');
  if (!box) return;
  const { action, minutes, kcal, weightKg } = currentTrainingKcal();
  box.innerHTML = `
    <div class="te-main">这次大约 <b>${action ? kcal : '—'}</b> kcal <span class="tiny muted">（估算，不是实测）</span></div>
    <div class="tiny muted">
      ${action ? `${esc(action.name)} · ${minutes} 分钟 · METs ${action.mets} × 体重 ${weightKg} kg × ${round(minutes / 60, 2)} 小时` : '先挑一个动作，这里会算出大概消耗'}
    </div>
    <div class="tiny muted" style="margin-top:4px">
      这部分消耗不会加回「今天还可以吃」的额度 —— 它直接变成当天的缺口，所以不用、也不该吃回来。
      手环给的数字通常比这里高，这里只是粗略估算。
    </div>`;
}

/**
 * 一条运动记录在列表里的样子。计划页的「今天已经记了」和记录页的历史共用一份 ——
 * 两处各写一遍的话，改了一处忘了另一处，同一个数据会显示成两个样子。
 */
function trainingRow(it, { showDate = false } = {}) {
  return `
    <div class="entry">
      <span class="name">${esc(it.name)}<em>${showDate ? `${dayLabel(it.dateKey)} · ` : ''}${it.minutes} 分钟${it.intensityName ? ` · ${esc(it.intensityName)}` : ''}${it.note ? ` · ${esc(it.note)}` : ''}</em></span>
      <span class="kcal">约 ${it.kcal} kcal</span>
      <button class="del" data-act="del-exercise" data-id="${it.id}"${showDate ? ` data-date="${it.dateKey}"` : ''} aria-label="删除">${icon('close', { size: 14 })}</button>
    </div>`;
}

function renderTrainingPane() {
  const weightKg = state.profile?.weightKg ?? 60;
  const today = todayKey();
  const actions = trainingActions(cardioPick.equipment);
  ensureTrainingPick(actions);
  const sum = trainingSummary(state, today, weightKg);
  const rows = trainingHistory(state, { days: 14, weightKg }).flatMap((d) => d.items).slice(0, 12);
  const minutes = Number(trainingPick.minutes);
  return `
    <div class="card">
      <div class="card-title">记一次运动 <span class="tiny muted">消耗是估算，不是实测</span></div>

      <details class="train-equip" id="trainEquipBox"${trainingEquipOpen ? ' open' : ''}>
        <summary>
          <span class="te-label">今天能用的器械</span>
          <em>${esc(cardioPick.equipment.map((k) => EQUIPMENT[k]?.name || k).join('、'))}</em>
        </summary>
        <div class="chips" id="trainEquip">
          ${listEquipment().map((eq) => `<button class="chip ${cardioPick.equipment.includes(eq.key) ? 'on' : ''}" data-train-eq="${eq.key}">${icon(eq.icon, { size: 15 })} ${eq.name}</button>`).join('')}
        </div>
        <p class="tiny muted" style="margin:8px 0 0">勾了哪些，下面就只列哪些做得了的动作（和「计划」页共用同一份勾选）。</p>
      </details>

      <div class="tiny muted" style="margin:12px 0 6px">练了什么？<span class="muted">（只列出现在勾的器械做得了的动作）</span></div>
      <div class="chips" id="trainCardio">
        ${actions.cardio.map((e) => `<button class="chip ${trainingPick.cardioId === e.id ? 'on' : ''}" data-train-cardio="${e.id}">${esc(e.name)}</button>`).join('')
          || '<span class="tiny muted">按现在勾的器械没有能做的动作。勾上「徒手/地面」—— 徒手循环和 HIIT 都不需要器械。</span>'}
      </div>

      <div class="tiny muted" style="margin:12px 0 6px">力量训练<span class="muted">（不用器械也能做）</span></div>
      <div class="chips" id="trainStrength">
        ${actions.strength.map((s) => `<button class="chip ${trainingPick.exerciseKey === s.key ? 'on' : ''}" data-train-strength="${s.key}">${esc(s.name)}</button>`).join('')}
      </div>

      <label class="field" style="margin-top:12px"><span>练了多久</span>
        <div class="chips" id="trainMinutes">
          ${[15, 20, 30, 45, 60].map((m) => `<button class="chip ${minutes === m ? 'on' : ''}" data-train-min="${m}">${m} 分钟</button>`).join('')}
        </div>
      </label>
      <div class="row" style="gap:8px;align-items:center;margin:2px 0 4px">
        <span class="tiny muted">也可以自己填</span>
        <input type="number" id="trainMinutesInput" inputmode="numeric" min="1" max="1440"
          value="${minutes > 0 ? minutes : ''}" style="width:86px;padding:6px 8px;font-size:14px">
        <span class="tiny muted">分钟</span>
      </div>

      <label class="field"><span>强度（可不填，只记进历史）</span>
        <div class="chips" id="trainIntensity">
          <button class="chip ${trainingPick.intensity === '' ? 'on' : ''}" data-train-intensity="">不填</button>
          ${Object.entries(TRAINING_INTENSITY).map(([k, v]) => `<button class="chip ${trainingPick.intensity === k ? 'on' : ''}" data-train-intensity="${k}">${v.name}</button>`).join('')}
        </div>
      </label>

      <label class="field"><span>备注（可不填）</span>
        <input type="text" id="trainNote" maxlength="40" placeholder="例如：跑步机 8 档，膝盖没不适" value="${esc(trainingPick.note)}">
      </label>

      <div class="train-estimate" id="trainEstimate"></div>
      ${dateKey !== today ? `<div class="warn info" style="margin-top:10px">这些数字按「今天」算；你上面选的是${dayLabel(dateKey)}，记完会写到那一天。</div>` : ''}
      <button class="btn block" id="trainSave" style="margin-top:10px">记上这次运动</button>
    </div>

    <div class="card">
      <div class="card-title">运动记录 <span class="tiny muted">都在这台设备上算，不联网</span></div>
      <div class="stats">
        <span class="stat">今天 <b>${sum.today.count}</b> 次</span>
        <span class="stat">这周 <b>${sum.week.count}</b> 次</span>
        <span class="stat">累计 <b>${sum.total.minutes}</b> 分钟</span>
      </div>
      <p class="tiny muted" style="text-align:center;margin:6px 0 0">
        今天 ${sum.today.minutes} 分钟 · 这周 ${sum.week.minutes} 分钟 · 累计约 ${sum.total.kcal} kcal（估算）
      </p>
      <hr class="sep">
      ${rows.length ? rows.map((r) => trainingRow(r, { showDate: true })).join('') : '<div class="tiny muted">还没有运动记录。走路也算 —— 记上比不记准。</div>'}
      <p class="tiny muted" style="margin:10px 0 0">
        消耗按「动作强度 × 体重 × 时长」估算，和手环对不上很正常。记运动是为了看清自己动了多少，不是给「多吃一点」找理由。
      </p>
    </div>`;
}

/** 「练的」那一半的交互：挑动作、改时长、记上 */
function bindTrainingPane() {
  drawTrainingEstimate();
  // 器械选择器收起来时也要记住状态：展开着点器械 → 重绘 → 还要是展开的
  const equipBox = $('#trainEquipBox');
  equipBox?.addEventListener('toggle', () => { trainingEquipOpen = equipBox.open; });
  const markMinutes = () => {
    app.querySelectorAll('[data-train-min]').forEach((c) => {
      c.classList.toggle('on', Number(c.dataset.trainMin) === Number(trainingPick.minutes));
    });
  };

  app.querySelectorAll('[data-train-eq]').forEach((b) => b.addEventListener('click', () => {
    // 动作列表要跟着器械变，所以整页重绘；已填的时长和备注在 trainingPick 里，不会丢
    toggleEquipment(b.dataset.trainEq);
  }));

  app.querySelectorAll('[data-train-cardio]').forEach((b) => b.addEventListener('click', () => {
    trainingPick.cardioId = b.dataset.trainCardio;
    trainingPick.exerciseKey = null;
    // 只改选中状态，不整页重绘：重绘会把光标从输入框里踢出去
    app.querySelectorAll('[data-train-cardio]').forEach((c) => c.classList.toggle('on', c === b));
    app.querySelectorAll('[data-train-strength]').forEach((c) => c.classList.remove('on'));
    drawTrainingEstimate();
  }));

  app.querySelectorAll('[data-train-strength]').forEach((b) => b.addEventListener('click', () => {
    trainingPick.exerciseKey = b.dataset.trainStrength;
    trainingPick.cardioId = null;
    app.querySelectorAll('[data-train-strength]').forEach((c) => c.classList.toggle('on', c === b));
    app.querySelectorAll('[data-train-cardio]').forEach((c) => c.classList.remove('on'));
    drawTrainingEstimate();
  }));

  app.querySelectorAll('[data-train-min]').forEach((b) => b.addEventListener('click', () => {
    trainingPick.minutes = Number(b.dataset.trainMin);
    const box = $('#trainMinutesInput');
    if (box) box.value = trainingPick.minutes;
    markMinutes();
    drawTrainingEstimate();
  }));

  const minuteInput = $('#trainMinutesInput');
  minuteInput?.addEventListener('input', () => {
    // 边输边算：填 37 分钟也要立刻看到消耗，不能等点了「记上」才算
    trainingPick.minutes = Number(minuteInput.value);
    markMinutes();
    drawTrainingEstimate();
  });

  app.querySelectorAll('[data-train-intensity]').forEach((b) => b.addEventListener('click', () => {
    trainingPick.intensity = b.dataset.trainIntensity;
    app.querySelectorAll('[data-train-intensity]').forEach((c) => c.classList.toggle('on', c === b));
  }));

  $('#trainNote')?.addEventListener('input', (e) => { trainingPick.note = e.target.value; });

  $('#trainSave')?.addEventListener('click', () => {
    try {
      const item = logTraining(state, dateKey, {
        cardioId: trainingPick.cardioId,
        exerciseKey: trainingPick.exerciseKey,
        minutes: Number(trainingPick.minutes),
        intensity: trainingPick.intensity,
        note: trainingPick.note,
      });
      const saved = describeTraining(item, state.profile?.weightKg ?? 60);
      // 备注写的是「这一次」的情况，记完清掉；动作和时长留着（下次多半差不多，省一步）
      trainingPick.note = '';
      const stored = save();
      // 反馈落在「记了什么 + 大约多少 + 写到哪天」，不说「成功」这种空话
      if (stored) toast(`记上了：${saved.name} ${saved.minutes} 分钟，大约 ${saved.kcal} kcal${dateKey === todayKey() ? '' : `（写到${dayLabel(dateKey)}）`}。`);
      render();
    } catch (err) {
      // 时长没填 / 填了 0：store 会拒绝，这里把原因原样说给用户听
      toast(err.message);
    }
  });
}

/* ── 「说一句就记上」流程 ─────────────────────
   流程：用户说一句话 → AI 解析 → 展示条目让用户确认/改 → 记进当天
   关键原则：解析结果永远先给用户看，不直接记账；AI 只负责听懂，热量由本地食物库算。
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
    if (!text) return toast('先写一句你吃了什么。');
    btn.disabled = true;
    btn.textContent = 'AI 正在解析…';
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
    // 一条都没认出来时，标题不能还问「这样记对吗？」
    title: draft.items.length ? '这样记对吗？' : '这句没能解析',
    body: '<div id="draftHost"></div>',
    onMount: () => {
      drawDraft();
    },
  });
}

async function runQuickParse(text, mealOverride = null) {
  // 餐次优先级：调用方指定（「加到午餐」里说的）> 今天页那个按钮带的提示 > 按时钟猜
  const meal = mealOverride || quickMealHint || guessMeal();
  let items = [];
  let questions = [];
  // AI 的追问和本地「份量没说清」的问题分开存：前者可以答「不知道」让 AI 自己估，
  // 后者直接就是本地估算的档位按钮，两件事混在一起界面会分不清该给哪种操作。
  let aiQuestions = [];
  let source = 'ai';
  let aiError = null;
  let aiNote = null;
  let unmatchedItems = [];
  let normEstimated = [];
  let normAiEstimated = [];

  // 产品只有 AI 一种模式：没配密钥就明说，并把「去配置」放在最前面。
  // 不静默退回本地词表 —— 用户看到「没认出来」会以为是 AI 不行。
  if (!aiOn()) {
    draft = {
      text,
      meal,
      items: [],
      questions: [],
      aiQuestions: [],
      source: 'no-ai',
      aiError: null,
      noAi: true,
      note: null,
      unmatchedItems: [],
      estimated: [],
      aiEstimated: [],
    };
    openDraftSheet();
    return;
  }

  /*
   * v34：这句话如果只涉及「你之前存过的菜」（上次 AI 估过、已经存成我的食物），
   * 本地就能说清，不再花一次 AI 请求 —— 这是「下次同名直接命中」的兑现方式。
   * 判定很保守：除了名字只剩份量/餐次/口语词才走这里；有别的吃的就照常问 AI（见 cachedOnlyMatch）。
   */
  const cached = cachedOnlyMatch(text, state.customFoods);
  if (cached) {
    const food = cached.food;
    const portion = findPortion(text);
    let grams = (portion && gramsForPortion(food, portion)) || food.servings?.[0]?.[1] || 100;
    grams = Math.max(1, Math.min(Math.round(grams), 3000));
    const nut = calcEntry(food, grams);
    items = [{
      name: food.name,
      grams,
      kcal: nut.kcal, protein: nut.protein, fat: nut.fat, carb: nut.carb,
      confidence: 'high',
      needsConfirm: false,
      source: 'my-food',
      foodId: food.id,
      note: '按你之前存的算的（这次没花 AI 请求）',
    }];
    source = 'cache';
  } else {
    const res = await askAi(text, { meal });
    if (res.ok && res.items.length) {
      const norm = normalizeAiItems(
        { meal: res.meal || meal, items: res.items, questions: res.questions },
        meal,
        // 「我的食物」也参与匹配：自己存过的优先，数字不靠 AI 每次发挥（v34）
        { text, customFoods: state.customFoods },
      );
      // AI 认出来了但本地库里没有的，要原样带出去给用户看（以前是直接丢掉，用户以为记上了）
      unmatchedItems = norm.unmatchedItems || [];
      normEstimated = norm.estimated || [];
      normAiEstimated = norm.aiEstimated || [];
      if (norm.items.length) {
        items = norm.items;
        aiQuestions = norm.questions;
        source = 'ai';
        if (res.note) aiNote = res.note;
      }
    } else {
      aiError = res.error || 'AI 没解析出内容';
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
    aiQuestions: [...new Set(aiQuestions)].slice(0, 2),
    source,
    aiError,
    note: aiNote,
    unmatchedItems,
    estimated: (normEstimated || []),
    // v34：AI 直接估了营养的条目（本地已核对），记上后会存进「我的食物」
    aiEstimated: (normAiEstimated || []),
  };
  openDraftSheet();
}

/** 份量是猜的、而且有档位可点时，界面才多出这块反问（一条都不用问时界面跟以前一模一样） */
function needsPortionPick(it) {
  return it.confidence === 'low' && Array.isArray(it.portionChoices) && it.portionChoices.length >= 2;
}

/**
 * 改一条的克数：营养按比例换算，行内热量和下面的合计立刻跟着变。
 * 点档位和用户自己在输入框里敲数字都走这里 —— 两条路各写一遍，迟早有一条忘了更新合计。
 */
function applyDraftGrams(box, idx, grams) {
  const it = draft?.items?.[idx];
  const g = Number(grams);
  if (!it || !(g > 0)) return;
  const ratio = g / it.grams;
  it.grams = Math.round(g);
  it.kcal = Math.round(it.kcal * ratio);
  it.protein = Math.round(it.protein * ratio * 10) / 10;
  it.fat = Math.round(it.fat * ratio * 10) / 10;
  it.carb = Math.round(it.carb * ratio * 10) / 10;
  it.needsConfirm = false;
  const input = box.querySelector(`.draft-grams[data-grams="${idx}"]`);
  if (input) input.value = it.grams;
  const kcalCell = box.querySelector(`[data-kcal="${idx}"]`);
  if (kcalCell) kcalCell.textContent = `${Math.round(it.kcal)} kcal`;
  const summary = box.querySelector('.row.between.small b');
  if (summary) summary.textContent = Math.round(sumItems(draft.items).kcal);
}

/**
 * 「用 AI 重新解析这一句」。
 *
 * 只在「AI 没连上」时出现；没配 AI 时按钮变成「去配 AI」。
 */
async function retryWithAi() {
  if (!draft) return;
  const meal = draft.meal;
  const original = draft.text;
  if (!aiOn()) {
    closeSheet();
    openAiSettingsSheet();
    return;
  }
  draft = null;
  closeSheet();
  await runQuickParse(original, meal);
}

/** 把解析结果画成「可以改的清单」 */
function drawDraft() {
  const box = $('#draftHost') || $('#quickResult');
  if (!box || !draft) return;
  // 一条都没认出来：不许显示「记上」（记 0 条 = 留一条空记录，之后更乱）。
  // 而且要分清两种情况：AI 认出来了但库里没有 vs 完全没听懂 —— 给用户的建议完全不同。
  if (!draft.items.length) {
    // 一条都认不出来很少见了（v31 起 AI 认出来的东西就算库里没有也会按同类均值记上），
    // 但真遇到时也不能让用户卡在这儿：给能点的例子 + 直接进食物搜索 + 保留原句重写。
    const original = draft.text || '';
    const examples = ['一碗牛肉面加了个蛋', '半碗米饭、一份红烧肉', '一杯奶茶、一份鸡排'];
    const canRetry = Boolean(ai.configured);
    box.innerHTML = `
      <div class="warn" style="margin-top:10px">
        ${draft.noAi
          ? '还没配置 AI，所以这句话还没解析。配好后说一句话就能记；也可以先手动记一笔。'
          : (draft.aiError
            ? `这句没能记上：AI 没连上（${esc(draft.aiError)}）。检查网络或密钥后再试一次。`
            : '这句没能记上：AI 这次没解析出食物。可以换个说法再试，或者手动记一笔。')}
      </div>
      <p class="tiny muted" style="margin:0 0 8px">
        ${canRetry
          ? '用 AI 重新解析这一句，它会按最接近的常见食物估一条。'
          : '在「我的 → 设置 → AI 设置」配好 AI，任何食物都能估。'}
      </p>
      <button class="btn block" style="margin-top:12px" id="draftRetryAi">${canRetry ? '用 AI 重新解析这一句' : '去配 AI'}</button>
      <button class="btn ghost block" style="margin-top:8px" id="draftManual">手动搜食物记一笔</button>
      <button class="btn ghost block" style="margin-top:8px" id="draftAgain">回到输入框改一改</button>
      <p class="tiny muted" style="margin:12px 0 8px">或者换成下面这种说法再试：</p>
      <div class="chips" id="draftExamples">
        ${examples.map((e) => `<button class="chip" type="button" data-example="${esc(e)}">${esc(e)}</button>`).join('')}
      </div>`;
    // 两个入口（记录页大输入框 / 加食物弹层里的「说一句」）都要能接上：
    // 前者有 #quickText，后者弹层已经关了，只能重新打开「说一句」并把文字填好
    const fillSay = (text, hint) => {
      const meal = draft?.meal || null;
      draft = null;
      closeSheet();
      const ta = $('#quickText');
      if (ta) {
        ta.value = text;
        ta.focus();
        toast(hint);
        return;
      }
      openFoodSheet(meal, text);
    };
    box.querySelectorAll('[data-example]').forEach((btn) => {
      btn.addEventListener('click', () => fillSay(btn.dataset.example, $('#quickText') ? '改成例句了，点「解析这一句」试试。' : '改成例句了，点「解析并记到这一餐」试试。'));
    });
    $('#draftAgain', box)?.addEventListener('click', () => fillSay(original, '原句给你留着了，改一改再点解析。'));
    $('#draftRetryAi', box)?.addEventListener('click', retryWithAi);
    $('#draftManual', box)?.addEventListener('click', () => {
      const meal = draft.meal;
      draft = null;
      closeSheet();
      // 以前这里只是滚动到某个按钮 + toast，什么都打不开；现在直接进食物搜索
      openFoodSheet(meal);
    });
    return;
  }
  const totals = sumItems(draft.items);
  const needsCheck = draft.items.some((it) => it.needsConfirm);
  box.innerHTML = `
    <div class="warn ${draft.source === 'ai' ? 'info' : ''}" style="margin-top:10px">
      这次是：${draft.source === 'ai'
        ? 'AI 认出来的'
        : (draft.source === 'cache' ? '用的是你之前存过的食物（没花 AI 请求）' : '本地记的')}
      ${draft.aiError ? `｜AI 这次没成功：${esc(draft.aiError)}` : ''}
      ${draft.note ? `<br>${esc(draft.note)}` : ''}
    </div>
    ${(draft.aiEstimated || []).length ? `<div class="warn" style="margin-bottom:6px">
      有 ${draft.aiEstimated.length} 样食物库里没有，这份营养是 <b>AI 估的</b>（本地按 4/9/4 核对过）：
      <b>${draft.aiEstimated.map((x) => esc(x)).join('、')}</b>。记上后会存进「我的食物」，下次直接认得；
      不准就点右边的 × 删掉，或者直接改克数。
    </div>` : ''}
    ${(draft.estimated || []).length ? `<div class="warn" style="margin-bottom:6px">
      有 ${draft.estimated.length} 样食物库里没有，先按<b>同类食物的平均值</b>估了（标签「估算」）：
      <b>${draft.estimated.map((x) => esc(x)).join('、')}</b>。不准就点右边的 × 删掉，或者直接改克数。
    </div>` : ''}
    ${(draft.aiQuestions || []).map((q, i) => `
      <div class="warn info" style="margin-bottom:6px" data-ai-question="${i}">
        <div>AI 想确认一下：${esc(q)}</div>
        <input type="text" data-aiq-input="${i}" maxlength="60" placeholder="知道就补一句；不知道就点下面" style="margin-top:6px">
        <div class="chips" style="margin-top:6px">
          <button class="chip" type="button" data-aiq-send="${i}">按这个重新估</button>
          <button class="chip" type="button" data-aiq-skip="${i}">我也不知道，你按常见的估</button>
        </div>
      </div>`).join('')}
    ${draft.questions.map((q) => `<div class="warn" style="margin-bottom:6px">想确认一下：${esc(q)}</div>`).join('')}
    <div style="margin-top:8px">
      ${draft.items.map((it, i) => `
        <div class="entry draft-entry">
          <div class="draft-line">
            <span class="name">${esc(it.name)}
              ${it.needsConfirm ? '<span class="tag amber">待确认</span>' : ''}
              ${it.source === 'my-food' ? '<span class="tag">我的食物</span>' : (it.source === 'ai-estimate' ? '<span class="tag amber">AI 估的</span>' : (it.estimated ? '<span class="tag amber">估算</span>' : ''))}
              ${!it.estimated && needsPortionPick(it) ? '<span class="tag amber">份量是猜的</span>' : ''}
            </span>
            <input type="number" value="${it.grams}" data-grams="${i}" class="draft-grams" style="width:80px;padding:4px 6px;font-size:14px">
            <span class="kcal">克</span>
            <span class="kcal" data-kcal="${i}">${Math.round(it.kcal)} kcal</span>
            <button class="del" type="button" data-del="${i}" aria-label="删掉这条" title="删掉这条">×</button>
          </div>
          ${it.warning ? `<em class="draft-warn">${esc(it.warning)}</em>` : ''}
          ${it.note ? `<em class="draft-note">${esc(it.note)}</em>` : ''}
        </div>
        ${needsPortionPick(it) ? `
          <div class="portion-guess" data-guess="${i}">
            <span class="guess-tag">这个份量我是猜的</span>
            <span class="guess-why">${esc(it.confidenceReason || '')}</span>
            <div class="chips">
              ${it.portionChoices.map((c, ci) => `<button class="chip" data-pick-portion="${i}:${ci}">${esc(c.label)} ${c.grams} 克</button>`).join('')}
            </div>
          </div>` : ''}`).join('')}
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

  // AI 追问：补一句就带着原句重新估；点「不知道」就按现有估算记，问题当场消失。
  // 「不知道」只有用户有资格说 —— 点了之后 AI 不再追问，数字用它已经估好的那份。
  box.querySelectorAll('[data-aiq-send]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!draft) return;
      const i = Number(btn.dataset.aiqSend);
      const q = draft.aiQuestions?.[i];
      if (!q) return;
      const answer = String(box.querySelector(`[data-aiq-input="${i}"]`)?.value || '').trim();
      if (!answer) return toast('先补一句，或者点「我也不知道」。');
      const meal = draft.meal;
      const merged = `${draft.text}（补充说明：${q}${answer}）`;
      draft = null;
      closeSheet();
      await runQuickParse(merged, meal);
    });
  });
  box.querySelectorAll('[data-aiq-skip]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!draft) return;
      const i = Number(btn.dataset.aiqSkip);
      if (!Number.isInteger(i) || !draft.aiQuestions?.[i]) return;
      // 只把这一块拿掉、把槽位留空，不整页重绘 —— 否则别的问题里已经打好的补充会丢
      box.querySelector(`[data-ai-question="${i}"]`)?.remove();
      draft.aiQuestions[i] = null;
      toast('好，就按现在的估算记。');
    });
  });
  // 改份量：点档位和用户自己敲数字走同一条路 —— 两处各写一遍，迟早有一处忘了更新合计（这个坑踩过）
  box.querySelectorAll('.draft-grams').forEach((inp) => {
    inp.addEventListener('input', () => {
      if (!(Number(inp.value) > 0)) return;
      applyDraftGrams(box, Number(inp.dataset.grams), Number(inp.value));
      // 用户自己填了克数，这一条就不用再问了
      box.querySelector(`[data-guess="${inp.dataset.grams}"]`)?.remove();
    });
  });
  // 删掉一条：AI 认错/估错的东西要能当场拿掉，不然用户只能整条重写（更常见的做法是干脆不记了）
  box.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!draft) return;
      const idx = Number(btn.dataset.del);
      if (!Number.isInteger(idx) || idx < 0 || idx >= draft.items.length) return;
      draft.items.splice(idx, 1);
      if (!draft.items.length) {
        draft = null;
        closeSheet();
        toast('这条没记上，可以换个说法再说一次。');
        return;
      }
      drawDraft();
    });
  });
  box.querySelectorAll('[data-pick-portion]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [idx, pick] = btn.dataset.pickPortion.split(':').map(Number);
      const choice = draft.items[idx]?.portionChoices?.[pick];
      if (!choice) return;
      applyDraftGrams(box, idx, choice.grams);
      // 用户答过了就把追问收起来，别一直挂在那儿再问第二遍
      box.querySelector(`[data-guess="${idx}"]`)?.remove();
    });
  });
  $('#draftMeal', box)?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-meal]');
    if (!b) return;
    draft.meal = b.dataset.meal;
    box.querySelectorAll('#draftMeal .chip').forEach((c) => c.classList.toggle('on', c === b));
  });
  $('#draftSave', box)?.addEventListener('click', () => {
    // 防重入：先把草稿取走再置空。万一事件触发两次（双击、脚本连点、合成事件），
    // 第二次进来 draft 已经是 null，直接返回 —— 不会把同一份草稿记两遍。
    if (!draft) return;
    const items = draft.items;
    const savedMeal = draft.meal;
    const savedText = draft.text;
    draft = null;
    let cachedCount = 0;
    for (const it of items) {
      // 每 100 克的数字：记录本身和「我的食物」都用它（换算只有一份：calc#toPer100）
      const per100 = it.grams > 0 ? toPer100(it, it.grams) : null;
      addFoodEntry(state, dateKey, savedMeal, {
        id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: it.name,
        category: 'custom',
        ...(per100 || { kcal: it.kcal, protein: it.protein, fat: it.fat, carb: it.carb }),
        servings: [['一份', it.grams]],
        fromDescription: true,
      }, it.grams);
      /*
       * AI 估的条目存成「我的食物」（v34）：下次同一个名字优先命中本机，
       * 不用再让 AI 估一遍，数字也稳定。只存过了本地校验的（source 是 ai-estimate）。
       */
      if (it.source === 'ai-estimate' && per100) {
        addCustomFood(state, {
          name: it.name,
          ...per100,
          source: 'ai-estimate',
          note: 'AI 估的营养（本地已按 4/9/4 核对）',
          originalText: savedText,
        });
        cachedCount += 1;
      }
    }
    const stored = save();
    const n = items.length;
    closeSheet();
    render();
    // 存不进去时 save() 已经说了实话，这里不许再报喜（否则「存不进去」和「成了」同时出现）
    if (!stored) return;
    // 先给一句落在「记录」这件事上的反馈，再检查有没有解锁新徽章
    const t = targets();
    const msg = afterLogMessage(state, savedMeal, t?.proteinG || 60);
    // 存了「我的食物」时要说清：不然用户不知道下次为什么不用再等 AI
    const extra = cachedCount ? `（${cachedCount} 样 AI 估的营养已存进「我的食物」，下次直接认得）` : '';
    // 补记昨天时，保存反馈要写清「记到昨天了」——不然用户不知道这一笔落在哪一天
    toast(dateKey === todayKey() ? `${msg.text}${extra}` : `${msg.text}（记到${dayLabel(dateKey)}）${extra}`, msg.icon);
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
        ${myInsights(2).map((x) => `<li style="margin-bottom:4px">${icon(x.icon, { size: 16 })} <b>${esc(x.title)}</b><br><span class="muted">${esc(x.detail)}</span></li>`).join('')
          || buildDailyTips(t, plan.cookingOilG).map((x) => `<li style="margin-bottom:4px">${esc(x)}</li>`).join('')}
      </ul>
    </div>

    <div class="card">
      <div class="card-title">一周练什么</div>
      <label class="field"><span>你每周能练几天？</span>
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
 * 「今天练什么」：先问用户今天有什么器械，再据此推荐；推荐里直接给出「没有 X 就做 Y」。
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
      <div class="card-title">今天练什么 <span class="tiny muted">按你今天能用的器械排</span></div>

      <label class="field"><span>今天有哪些器械？（可多选）</span>
        <div class="chips" id="equipChips">
          ${listEquipment().map((eq) => `
            <button class="chip ${cardioPick.equipment.includes(eq.key) ? 'on' : ''}" data-eq="${eq.key}">${icon(eq.icon, { size: 15 })} ${eq.name}</button>
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
        ${today.exercises.map((x) => trainingRow(describeTraining(x, weightKg))).join('')}
      ` : ''}
    </div>`;
}

/**
 * 「计划」页记一笔运动。和记录页走同一条路（logTraining），只是动作是这里推荐出来的 ——
 * 动作名、METs、旧池 key 的对应关系只在 exercise.js 维护一份，两边各写一份迟早会对不上。
 */
function logRecommendCardio(cardioId, minutes) {
  try {
    const item = logTraining(state, dateKey, { cardioId, minutes });
    const saved = describeTraining(item, state.profile?.weightKg ?? 60);
    save();
    render();
    toast(`记上了：${saved.name} ${saved.minutes} 分钟，大约 ${saved.kcal} kcal。`);
  } catch (err) {
    toast(err.message);
  }
}

/** 有氧卡片的交互：选器械/目标/时长，以及「记入记录」和「看替代」 */
function bindCardioCard() {
  const eqBox = $('#equipChips');
  if (eqBox) {
    eqBox.addEventListener('click', (e) => {
      const b = e.target.closest('[data-eq]');
      if (!b) return;
      toggleEquipment(b.dataset.eq);
    });
  }
  $('#goalChips')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goal]');
    if (!b) return;
    setCardioGoal(b.dataset.goal);
  });
  $('#minuteChips')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-min]');
    if (!b) return;
    setCardioMinutes(b.dataset.min);
  });
  app.querySelectorAll('[data-log-cardio]').forEach((el) => {
    el.addEventListener('click', () => {
      const ex = CARDIO.find((c) => c.id === el.dataset.logCardio);
      if (!ex) return;
      logRecommendCardio(ex.id, cardioPick.minutes);
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
          if (!ex) return;
          closeSheet();   // 先收起弹层再记录：记录完界面会重绘，弹层不该还挂在上面
          logRecommendCardio(ex.id, minutes);
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

  const aiCfg = currentAiConfig();
  app.innerHTML = `
    <button class="set-row" data-act="ai-settings">
      <span class="set-main">
        <b>AI 设置</b>
        <em>${aiCfg.configured
          ? `说一句由 AI 听懂：${esc(aiCfg.model || '已配置')}`
          : '还没配 AI —— 点这里配（手把手教程）'}</em>
      </span>
      <span class="mode-pill">${aiCfg.configured ? '已开启' : '去配置'}<span class="mode-pill-go">›</span></span>
    </button>

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
    const stored = save();
    render();
    if (!stored) return;   // 存不进去就别报喜
    toast('记上了。目标热量会跟着新体重重算。');
    checkNewAchievements();
  }
}

/* ── 弹层：加食物 ────────────────────────── */

/**
 * 「加到某一餐」的弹层：两条路。
 *
 * 以前只有「搜食物库」：用户已经点了「午餐」，脑子里是「一碗牛肉面加个蛋」，
 * 却得先去库里搜「牛肉面」再挑份量 —— 逆着用户的意图走。
 * 现在顶部可以切到「说一句」，解析走的是和记录页顶部同一个流程（草稿确认 → 记进这一餐），
 * 差别只是**默认餐次已经定好**，不用用户再选。
 */
function openFoodSheet(mealKey, initialSay = '') {
  const slot = MEAL_SLOTS.find((s) => s.key === mealKey) || MEAL_SLOTS[0];
  // 记住上次用的哪条路：习惯说一句的人，不用每次再切一遍
  const savedPane = state.settings?.foodSheetPane;
  // 从「整句没认出来」的兜底页点例句进来时，直接落回「说一句」并把例句填好
  let pane = initialSay ? 'say' : (['say', 'kcal'].includes(savedPane) ? savedPane : 'search');

  openSheet({
    title: `加到${slot.label}`,
    body: `
      <div class="chips" id="foodPaneChips">
        <button class="chip" data-pane="search">搜食物库</button>
        <button class="chip" data-pane="say">说一句</button>
        <button class="chip" data-pane="kcal">只填热量</button>
      </div>

      <div id="paneSearch">
        <input type="text" id="foodSearch" placeholder="搜食物，例如：鸡胸 / 米饭 / 奶茶 / 苹果" autocomplete="off" style="margin-top:10px">
        <p class="tiny muted" style="margin:6px 0 0">肉和鱼默认按「熟重」算；如果你称的是生重，选名字里带「生」的那条。</p>
        <div id="foodResults" style="margin-top:6px"></div>
        <button class="btn ghost block" id="foodLabelBtn" style="margin-top:12px">${icon('clipboard', { size: 16 })} 照包装营养成分表填（更准）</button>
      </div>

      <div id="paneSay" class="hidden">
        <textarea id="foodSayText" rows="3" style="margin-top:10px" placeholder="例如：一碗牛肉面，加了个蛋">${esc(initialSay)}</textarea>
        <button class="btn block" id="foodSayParse" style="margin-top:8px">解析并记到${slot.label}</button>
        <p class="tiny muted" style="margin:8px 0 0">
          解析完先给你看清单，克数能改，确认了才记上。连着说几样也行（「米饭一碗、青菜一份」）。
        </p>
      </div>

      <div id="paneKcal" class="hidden">
        <p class="tiny muted" style="margin:10px 0 6px">
          在外面吃、没包装、也懒得描述时用这个：直接填这一顿大概多少大卡，不用先找食物。
        </p>
        <label class="field"><span>吃了什么（可不填，写了方便以后翻）</span>
          <input type="text" id="kcalName" maxlength="20" placeholder="例如：公司楼下的牛肉面" autocomplete="off">
        </label>
        <label class="field"><span>多少 kcal</span>
          <input type="number" id="kcalValue" inputmode="numeric" min="1" max="5000" placeholder="例如：650">
        </label>
        <label class="field"><span>蛋白（克，知道就填）</span>
          <input type="number" id="kcalProtein" inputmode="decimal" min="0" max="300" placeholder="不填就按 0 算">
        </label>
        <button class="btn block" id="kcalSave">记到${slot.label}</button>
        <p class="tiny muted" style="margin:8px 0 0">
          只填热量时，蛋白质和碳水那两栏会少算；「今天还能吃多少」不受影响。
        </p>
      </div>`,
    onMount: (body) => {
      const chips = [...body.querySelectorAll('#foodPaneChips [data-pane]')];
      const paneSearch = body.querySelector('#paneSearch');
      const paneSay = body.querySelector('#paneSay');
      const paneKcal = body.querySelector('#paneKcal');
      const paint = () => {
        chips.forEach((c) => c.classList.toggle('on', c.dataset.pane === pane));
        paneSearch.classList.toggle('hidden', pane !== 'search');
        paneSay.classList.toggle('hidden', pane !== 'say');
        paneKcal.classList.toggle('hidden', pane !== 'kcal');
        const focus = pane === 'search' ? body.querySelector('#foodSearch')
          : pane === 'say' ? body.querySelector('#foodSayText')
            : body.querySelector('#kcalValue');
        setTimeout(() => focus?.focus(), 60);
      };
      chips.forEach((c) => c.addEventListener('click', () => {
        pane = c.dataset.pane;
        state.settings = { ...(state.settings || {}), foodSheetPane: pane };
        save();
        paint();
      }));
      paint();

      /* 路一：搜食物库（和原来一样） */
      const input = $('#foodSearch', body);
      const results = $('#foodResults', body);
      const draw = () => {
        const list = searchFoods(input.value, state.customFoods, 14);
        results.innerHTML = list.length ? list.map((f) => `
          <div class="search-hit" data-pick="${f.id}">
            <span class="nm">${esc(f.name)}<em>每 100 克</em></span>
            <span class="kk">${f.kcal} kcal</span>
          </div>`).join('') : '<div class="tiny muted">没搜到。可以用下面的「照包装营养成分表填」，或者切到「说一句」直接描述。</div>';
      };
      draw();
      input.addEventListener('input', draw);
      results.addEventListener('click', (ev) => {
        const hit = ev.target.closest('[data-pick]');
        if (!hit) return;
        const food = [...state.customFoods, ...FOODS].find((f) => f.id === hit.dataset.pick);
        openAmountSheet(food, mealKey);
      });
      $('#foodLabelBtn', body).addEventListener('click', () => {
        closeSheet();
        openLabelSheet(mealKey);
      });

      /* 路三：只填热量 —— 用户知道这一顿多少大卡，但不想（也没法）描述份量 */
      body.querySelector('#kcalSave').addEventListener('click', () => {
        const r = kcalOnlyFood({
          name: body.querySelector('#kcalName').value,
          kcal: body.querySelector('#kcalValue').value,
          protein: body.querySelector('#kcalProtein').value,
        });
        if (!r.ok) return toast(r.error);
        addFoodEntry(state, dateKey, slot.key, r.food, 100);
        const stored = save();
        closeSheet();
        render();
        if (stored) toast(`已记：${r.food.name} ${r.food.kcal} kcal`);
      });

      /* 路二：说一句 —— 关掉这个弹层，走「草稿确认」那条老路，餐次锁定这一餐 */
      const sayBtn = body.querySelector('#foodSayParse');
      sayBtn.addEventListener('click', async () => {
        const text = body.querySelector('#foodSayText').value.trim();
        if (!text) return toast('先写一句你吃了什么。');
        sayBtn.disabled = true;
        sayBtn.textContent = 'AI 正在解析…';
        closeSheet(); // 草稿弹层要占同一个位置，先收起这个
        try {
          await runQuickParse(text, slot.key);
        } finally {
          sayBtn.disabled = false;
          sayBtn.textContent = `解析并记到${slot.label}`;
        }
      });
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
        ${list.map((e) => `<button class="chip" data-ex="${e.key}">${esc(e.name)}</button>`).join('')}
      </div>
      <label class="field" style="margin-top:14px"><span>练了多久（分钟）</span>
        <input type="number" id="exMinutes" inputmode="numeric" value="30" min="1" max="1440">
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
        const kcal = m > 0
          ? estimateTrainingKcal({ mets: ex.mets, minutes: m }, state.profile?.weightKg ?? 60)
          : 0;
        // 这里绝不能写「一半算进可以多吃的额度」—— 运动消耗不参与额度计算，写反了就是在鼓励多吃
        preview.innerHTML = `${esc(ex.name)} ${m} 分钟 ≈ 消耗 <b>${Math.round(kcal)} kcal</b>（估算）。这部分不会加回今天可吃的额度，它直接变成当天的缺口。`;
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
        try {
          // 走和记录页同一条路：时长不合法时 store 会拒绝，这里把原因原样说出来
          logTraining(state, dateKey, { exerciseKey: picked, minutes: Number(minutes.value) });
        } catch (err) {
          return toast(err.message);
        }
        save();
        closeSheet();
        render();
        checkNewAchievements();
      });
    },
  });
}

/* ── 弹层：自定义食物 ────────────────────── */

/**
 * 把手机拍的照片压小再发出去。
 * 原图动辄 3~8 MB，直接编码成 base64 会让请求变得很慢；长边 1400 足够看清营养成分表。
 */
function fileToCompressedDataUrl(file, maxEdge = 1400, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('这张图片打不开，换一张试试'));
    };
    img.src = url;
  });
}

/**
 * 照包装背面的「营养成分表」记一笔。
 *
 * 为什么值得单独做：预包装食品（调理鸡胸肉、酸奶、面包）和食物库里的「生鸡胸肉」不是一回事，
 * 蛋白从 24 g 掉到 13.7 g 很常见（注水/淀粉/调味），借用食材条目会差 40%。
 * 这里让用户直接照包装填，记下来的就是包装上的数字。
 *
 * 拍照只是「帮用户抄」，不是「帮用户算」：AI 读出来的数字会填进同一个表单，
 * 还是由用户核对后保存；单位换算和 4/9/4 对账全在本地做（js/label.js）。
 */
function openLabelSheet(mealKey = null) {
  const canPhoto = aiOn() && ai.mode !== 'relay';
  const slot = MEAL_SLOTS.find((s) => s.key === mealKey) || null;
  openSheet({
    title: slot ? `照包装记 → ${slot.label}` : '照包装营养成分表记',
    body: `
      <p class="small muted" style="margin:0 0 12px">
        照包装背面的「营养成分表」填，以后按克数记就是准的。
        <b>国内包装的能量大多写千焦</b>，选「千焦」直接抄数字，我帮你换成 kcal。
      </p>
      ${canPhoto ? `
        <input type="file" id="labelFile" accept="image/*" style="display:none">
        <button class="btn ghost block" id="labelShot">${icon('camera', { size: 16 })} 拍营养成分表，自动读出来</button>
        <p class="tiny muted" id="labelShotHint" style="margin:8px 0 0">照片只会发给你在设置里配置的 AI 服务商。读出来先核对，再保存。</p>
      ` : `
        <p class="tiny" style="margin:0 0 12px;color:var(--ink-3)">
          拍照自动读需要先在「我的 → 设置 → AI 设置」配一个<b>支持看图的模型</b>（例如 qwen-vl-plus、glm-4v、gpt-4o-mini）。
          手动照包装填也一样准。
        </p>
      `}
      <label class="field"><span>名称</span><input type="text" id="labelName" maxlength="30" placeholder="例如：低脂鸡胸肉"></label>
      <div class="grid2">
        <label class="field"><span>标签是按多少克标的</span><input type="number" id="labelBase" value="100" inputmode="decimal"></label>
        <label class="field"><span>能量</span><input type="number" id="labelEnergy" inputmode="decimal" placeholder="例如 349"></label>
      </div>
      <div class="chips" id="labelUnit">
        <button class="chip on" data-unit="kJ">千焦 kJ（国内最常见）</button>
        <button class="chip" data-unit="kcal">千卡 kcal</button>
      </div>
      <div class="grid2" style="margin-top:10px">
        <label class="field"><span>蛋白质 g</span><input type="number" id="labelProtein" inputmode="decimal"></label>
        <label class="field"><span>脂肪 g</span><input type="number" id="labelFat" inputmode="decimal"></label>
        <label class="field"><span>碳水 g</span><input type="number" id="labelCarb" inputmode="decimal"></label>
      </div>
      <div id="labelPreview" class="warn info" style="margin-top:10px">填完会自动算成每 100 克，并帮你核对一遍。</div>`,
    foot: '<button class="btn block" id="labelSave">保存并记一笔</button>',
    onMount: (body, foot) => {
      const el = (id) => $(id, body);
      let unit = 'kJ';
      // 这几个数字是「照片读出来的」还是「用户自己敲的」—— 分不清就不知道该劝重拍还是劝改数字
      let fromPhoto = false;
      const preview = el('#labelPreview');

      const readForm = () => ({
        baseGrams: Number(el('#labelBase').value || 100),
        energyValue: el('#labelEnergy').value === '' ? null : Number(el('#labelEnergy').value),
        energyUnit: unit,
        protein: el('#labelProtein').value === '' ? null : Number(el('#labelProtein').value),
        fat: el('#labelFat').value === '' ? null : Number(el('#labelFat').value),
        carb: el('#labelCarb').value === '' ? null : Number(el('#labelCarb').value),
      });

      const update = () => {
        const r = labelToPer100(readForm());
        if (!r.ok) {
          preview.className = 'warn';
          preview.textContent = r.error;
          return;
        }
        const c = checkConsistency(r.per100);
        // 照片读出来的数字自己对不上，多半是读串了行 —— 该劝重拍，而不是让用户猜哪个数错了
        const retake = fromPhoto ? photoRetakeHint(c) : '';
        preview.className = c.level === 'warn' ? 'warn' : 'warn info';
        preview.innerHTML = `每 100 克：<b>${r.per100.kcal}</b> kcal · 蛋白 ${r.per100.protein} g · 脂肪 ${r.per100.fat} g · 碳水 ${r.per100.carb} g<br>${esc(c.message)}`
          + (retake ? `<br><b>${esc(retake)}</b>` : '');
      };
      body.querySelectorAll('input').forEach((i) => i.addEventListener('input', () => {
        fromPhoto = false; // 用户自己动过手了，这就不是「纯读出来」的数字了
        update();
      }));
      el('#labelUnit').addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-unit]');
        if (!btn) return;
        unit = btn.dataset.unit;
        el('#labelUnit').querySelectorAll('[data-unit]').forEach((b) => b.classList.toggle('on', b === btn));
        update();
      });
      update();

      // 拍照 -> 读数字 -> 填进表单（还是要用户核对一遍）
      if (canPhoto) {
        const fileInput = el('#labelFile');
        const hint = el('#labelShotHint');
        el('#labelShot').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          hint.textContent = '正在读这张图…（一般 5~15 秒）';
          try {
            const dataUrl = await fileToCompressedDataUrl(file);
            const r = await readLabelImage(dataUrl);
            if (!r.ok) {
              hint.textContent = `没读出来：${r.error}`;
              return;
            }
            const fill = (id, v) => { if (v !== null && v !== undefined && v !== '') el(id).value = v; };
            fill('#labelName', r.name);
            fill('#labelBase', r.baseGrams || 100);
            fill('#labelEnergy', r.energy ? r.energy.value : null);
            if (r.energy && r.energy.unit) {
              unit = r.energy.unit;
              el('#labelUnit').querySelectorAll('[data-unit]').forEach((b) => b.classList.toggle('on', b.dataset.unit === unit));
            }
            fill('#labelProtein', r.protein);
            fill('#labelFat', r.fat);
            fill('#labelCarb', r.carb);
            fromPhoto = true;
            update();
            const empty = !r.energy && r.protein === null && r.fat === null && r.carb === null;
            hint.textContent = empty
              ? '这张图里没读出数字，可能是拍糊了或者不是营养成分表。可以重拍，或者手动填。'
              : '读出来了，核对一下下面的数字再保存。';
          } catch (err) {
            hint.textContent = `读书失败：${err.message}`;
          }
        });
      }

      $('#labelSave', foot).addEventListener('click', () => {
        const name = el('#labelName').value.trim();
        if (!name) return toast('先填个名字，方便以后搜。');
        const r = labelToPer100(readForm());
        if (!r.ok) return toast(r.error);
        const base = Number(el('#labelBase').value || 100);
        const food = addCustomFood(state, {
          name,
          kcal: r.per100.kcal,
          protein: r.per100.protein,
          fat: r.per100.fat,
          carb: r.per100.carb,
          baseGrams: base,
          servings: [['一份', base]],
        });
        const stored = save();
        closeSheet();
        view = 'log';
        document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'log'));
        render();
        if (!stored) return;
        toast(`已存成「${name}」，每 100 克 ${r.per100.kcal} kcal`);
        checkNewAchievements();
        // 存完顺手记这一笔 —— 用户的目的就是现在吃的东西
        setTimeout(() => openAmountSheet(food, mealKey || quickMealHint || guessMeal()), 250);
      });
    },
  });
}

/* ── 庆祝：彩条 + 一句话 ─────────────────────
   只在真的解锁新徽章时放，而且要能关掉（有人不喜欢动画）。
   ─────────────────────────────────────────── */

function celebrate(opts) {
  const { iconName = 'sparkles', title, sub } = opts;
  if (state?.settings?.celebrations === false) return;
  // 刚刚存盘失败：这时候庆祝「解锁徽章 / 成了」是假的，先不庆祝
  if (!lastSaveOk) return;
  const el = document.createElement('div');
  el.className = `celebrate${opts.special ? ' special' : ''}`;
  el.innerHTML = `
    <div class="confetti">${Array.from({ length: 14 }, (_, i) => `<i style="--i:${i};--x:${(i * 37) % 100};--d:${(i % 5) * 0.12}s"></i>`).join('')}</div>
    <div class="celebrate-card">
      <div class="celebrate-icon">${icon(iconName, { size: 76 })}</div>
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
    iconName: first.icon,
    title: badgeLabel(state, first),
    sub: first.congrats,
  });

  // 顺带检查有没有踩到「每 10 天」的里程碑
  const mile = hitMilestone(state);
  if (mile && !(state.achievements?.milestones || []).includes(mile.days)) {
    state.achievements.milestones = [...(state.achievements?.milestones || []), mile.days];
    save();
    setTimeout(() => celebrate({
      iconName: mile.icon,
      title: mile.text,
      sub: '记录满这个数了，给你一朵。',
    }), 1400);
  }
}

/* ── 设置页（「我的」）────────────────────
   以前这些东西散在四个地方（AI 在记录页、备份在体重页、资料在头像、示例在今天页尾部）。
   收成一处，找起来才不费劲。
   ─────────────────────────────────────────── */

/** 从记录里算出的「用户自己的规律」（数据不够时返回空数组） */
function myInsights(limit) {
  const t = targets();
  if (!t) return [];
  try {
    const list = insights(state, { proteinG: t.proteinG, targetCalories: t.targetCalories, days: 14 });
    return limit ? list.slice(0, limit) : list;
  } catch (err) {
    console.warn('洞察计算失败：', err);
    return [];
  }
}

/** 现在会不会真的去调 AI = 密钥配好了。产品只有一种模式，不再有「普通模式」开关。 */
function aiOn() {
  return Boolean(ai.configured);
}

function openSettingsSheet() {
  const t = targets();
  const aiCfg = currentAiConfig();
  const plant = plantState(state);
  const a = achievements(state, t?.proteinG || 60);
  const backup = readBackup(localStorage);

  openSheet({
    title: '设置',
    body: `
      <button class="set-row" data-set="profile">
        <span class="set-ico" data-tone="rose">${icon('user', { size: 23 })}</span>
        <span class="set-main"><b>你的资料</b><em>${state.profile ? `${state.profile.heightCm} cm · ${state.profile.weightKg} kg · ${state.profile.age} 岁` : '还没填'}</em></span>
        <span class="set-go">›</span>
      </button>

      <button class="set-row" data-set="ai">
        <span class="set-ico" data-tone="gold">${icon('sparkles', { size: 23 })}</span>
        <span class="set-main"><b>AI 设置</b><em>${aiCfg.configured ? `${aiCfg.presetName || ''} · ${aiCfg.model || ''}` : '还没配（点这里，手把手教程）'}</em></span>
        <span class="set-go">›</span>
      </button>

      <button class="set-row" data-set="growth">
        <span class="set-ico" data-tone="green">${icon('sprout', { size: 23 })}</span>
        <span class="set-main"><b>我的成长</b><em>${a.unlocked.length} / ${a.list.length} 个徽章 · ${plant.stage.name}</em></span>
        <span class="set-go">›</span>
      </button>

      <button class="set-row" data-set="backup">
        <span class="set-ico" data-tone="blue">${icon('database', { size: 23 })}</span>
        <span class="set-main"><b>数据与备份</b><em>存档 v${SCHEMA_VERSION}${backup ? ` · 有升级前快照（${String(backup.savedAt).slice(0, 10)}）` : ''}</em></span>
        <span class="set-go">›</span>
      </button>

      <button class="set-row" data-set="wipe">
        <span class="set-ico" data-tone="red">${icon('trash', { size: 23 })}</span>
        <span class="set-main"><b>从头开始</b><em>清掉这台手机上的记录，重新走一遍新手引导</em></span>
        <span class="set-go">›</span>
      </button>

      <button class="set-row" data-set="guide">
        <span class="set-ico" data-tone="mauve">${icon('play', { size: 23 })}</span>
        <span class="set-main"><b>重看新手引导</b><em>忘了怎么用，从这里（不会动你的记录）</em></span>
        <span class="set-go">›</span>
      </button>

      <button class="set-row" data-set="about">
        <span class="set-ico" data-tone="gray">${icon('info', { size: 23 })}</span>
        <span class="set-main"><b>关于</b><em>算得准不准、数据存在哪、更新怎么生效</em></span>
        <span class="set-go">›</span>
      </button>

      <p class="tiny muted" style="margin:14px 0 0;text-align:center">
        所有记录只存在这台手机上，不上传。<br>换手机或清缓存前，记得导出备份。
      </p>`,
    onMount: (body) => {
      body.querySelectorAll('[data-set]').forEach((el) => {
        el.addEventListener('click', () => {
          const which = el.dataset.set;
          if (which === 'profile') { closeSheet(); openProfileSheet(); }
          else if (which === 'ai') { closeSheet(); openAiSettingsSheet(); }
          else if (which === 'growth') { closeSheet(); openGrowthSheet(); }
          else if (which === 'backup') openBackupSheet();
          else if (which === 'about') openAboutSheet();
          else if (which === 'guide') { closeSheet(); setTimeout(() => onboard({ step: 'intro', review: true }), 250); }
          else if (which === 'wipe') openWipeSheet();
        });
      });
    },
  });
}

/* ── 找回记录 / 清除数据 ────────────────────
   这一对是给「用不下去了」准备的，两个都要有：
   · 找回：记录其实还在，只是进了欢迎页（读取出问题、或换了键名）
   · 清除：记录确实不想要了（试用期的乱数据），想从头走一遍
   ─────────────────────────────────────────── */

/** 存档在不在（顺便看有几个键里有东西） */
function inspectStorage() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('fatloss')) continue;
      const val = localStorage.getItem(key) || '';
      let days = 0;
      let hasProfile = false;
      try {
        const parsed = JSON.parse(val);
        days = Object.keys(parsed?.days || {}).length;
        hasProfile = Boolean(parsed?.profile);
      } catch { /* 坏数据就只报大小 */ }
      out.push({ key, kb: Math.round(val.length / 1024), days, hasProfile });
    }
  } catch { /* 隐私模式下读不到 */ }
  return out;
}

function openRecoverSheet() {
  const found = inspectStorage();
  const backup = readBackup(localStorage);
  openSheet({
    title: '找回记录',
    body: `
      <div class="set-note">
        <b>先别急着重来</b><br>
        记录一般都还在手机里。下面这几步从上往下试，能找回来就不用重来。
      </div>

      <div class="set-note">
        <b>这台手机上找到的东西</b><br>
        ${found.length
          ? found.map((f) => `· ${esc(f.key)}：约 ${f.kb} KB${f.days ? `，${f.days} 天记录` : ''}${f.hasProfile ? '，有资料' : ''}`).join('<br>')
          : '（没找到任何记录）'}
      </div>

      ${backup ? `
        <button class="btn block" data-recover="backup">用升级前的快照恢复（${esc(String(backup.savedAt).slice(0, 10))}）</button>
        <p class="tiny muted" style="margin:6px 0 12px">${esc(backup.note || '')}</p>` : ''}

      <button class="btn block" data-recover="reload">重新读一次存档</button>
      <button class="btn ghost block" style="margin-top:8px" data-recover="import">从备份文件导入</button>

      <hr class="sep">
      <p class="tiny muted">
        都不行的话，可以「先导出备份」把现在的内容存下来发给我看，
        然后去「数据与备份」里从头开始（会清掉这台手机上的记录）。
      </p>`,
    onMount: (body) => {
      body.querySelectorAll('[data-recover]').forEach((el) => {
        el.addEventListener('click', () => {
          const how = el.dataset.recover;
          if (how === 'backup') {
            const b = readBackup(localStorage);
            if (!b) return toast('快照读不出来了。');
            const migrated = migrateToCurrent(b.data);
            if (!migrated.ok) return toast(migrated.error);
            if (!confirm('用这份快照覆盖现在的记录？（当前内容会先导出保存）')) return;
            exportData();
            state = migrated.data;
            save();
            closeSheet();
            render();
            return toast('已从快照恢复。');
          }
          if (how === 'reload') {
            const res = loadState(localStorage, { key: STORAGE_KEY });
            if (!res.ok) return toast(res.error);
            if (!res.data) return toast('这台手机上确实没有记录。');
            state = res.data;
            save();
            closeSheet();
            render();
            return toast('读到了，记录已经回来。');
          }
          if (how === 'import') { closeSheet(); return importData(); }
          return undefined;
        });
      });
    },
  });
}

/**
 * 从头开始（清掉记录）。
 *
 * 为什么单独做这个：试用期记的乱数据会一直影响目标、洞察和徽章，
 * 想干净地走一遍新手引导，就必须能清。
 * 但它会删掉真实记录，所以**要求输入「清除」两个字**，而不是点一下 confirm 就没了。
 */
function openWipeSheet() {
  const found = inspectStorage();
  const totalDays = found.reduce((a, f) => a + f.days, 0);
  openSheet({
    title: '从头开始',
    body: `
      <div class="warn">
        这会删掉这台手机上的<b>全部记录</b>：${totalDays ? `${totalDays} 天的饮食和运动、` : ''}体重、徽章、设置，
        还有升级前自动留的那份快照（「找回记录」里会一起没有）。
        <br>删掉之后不能撤销。
      </div>
      <div class="set-note">
        <b>开始之前建议先导出</b><br>
        导出的是一个文件，以后想恢复（或想让我看看到底哪里出错）都能用。
      </div>
      <button class="btn block" data-wipe="export">先导出备份</button>
      <hr class="sep">
      <label class="field"><span>确认的话，输入「清除」两个字</span>
        <input type="text" id="wipeConfirm" placeholder="清除" autocomplete="off">
      </label>`,
    foot: '<button class="btn ghost block" id="wipeGo" disabled>清除全部记录，从头开始</button>',
    onMount: (body, foot) => {
      const input = $('#wipeConfirm', body);
      const go = $('#wipeGo', foot);
      body.querySelector('[data-wipe="export"]').addEventListener('click', exportData);
      input.addEventListener('input', () => { go.disabled = input.value.trim() !== '清除'; });
      go.addEventListener('click', () => {
        if (input.value.trim() !== '清除') return;
        try {
          localStorage.removeItem(STORAGE_KEY);
          clearBackup(localStorage);
        } catch (err) {
          return toast(`没能清掉：${err.message}`);
        }
        state = emptyState();
        save();
        closeSheet();
        // 清完直接进新手引导 —— 用户的目的就是「从头开始」
        render();
        toast('已经清空，我们从头来一遍。');
        setTimeout(() => onboard({ step: 'intro' }), 400);
        return undefined;
      });
    },
  });
}

/** 全部规律（本地算的，不调用任何接口） */
function openInsightsSheet() {
  const t = targets();
  const list = myInsights();
  const hint = insightHint(state);
  openSheet({
    title: '你的规律',
    body: `
      ${list.length ? list.map((x) => `
        <div class="insight full">
          <span class="insight-ico">${icon(x.icon, { size: 18 })}</span>
          <div>
            <b>${esc(x.title)}</b>
            <p>${esc(x.detail)}</p>
          </div>
        </div>`).join('') : `
        <div class="set-note">
          <b>还没有足够的记录</b><br>
          ${esc(hint ? hint.text : '再记几天就能看出规律了。')}
        </div>`}
      <p class="tiny muted" style="margin-top:12px">
        这些数字是从你自己的记录里数出来的，不联网、不上传、不调用 AI。
        少于 4 天记录时我不会给结论 —— 数据不够编出来的「规律」是害人的。
      </p>
      ${t ? `<p class="tiny muted">目标是每天约 ${t.targetCalories} kcal、蛋白 ${Math.round(t.proteinG)} g。</p>` : ''}`,
  });
}


/* ── 弹层：教练 ──────────────────────────
   两条路给同一件事：
     · 本地版：按记录算好「还能吃多少、蛋白差多少、吃哪几样」，不联网、不花钱；
     · AI 版：把同一份事实交给模型组织语言。用户点一下才发请求（不自动消耗额度）。
   无论哪条路，数字都来自本地；AI 的话要再过一遍 checkCoachText，编数字就退回本地版。
   ───────────────────────────────────── */

/** 把当前记录整理成教练要的事实清单（只读，不新建空日子） */
function coachBriefNow() {
  const t = targets();
  if (!t) return null;
  const day = state.days?.[dateKey] || { meals: {} };
  return buildCoachBrief({
    state,
    targets: t,
    totals: totalsOfDay(day),
    today: dateKey,
    patterns: myInsights(3),
  });
}

function coachBody() {
  const v = coachView;
  const main = v.aiText ? { headline: '教练说的', lines: [v.aiText] } : v.local;
  return `
    <div class="coach-main">
      ${main.headline ? `<p class="coach-headline">${esc(main.headline)}</p>` : ''}
      ${main.lines.map((line) => `<p>${esc(line)}</p>`).join('')}
    </div>
    ${v.loading ? '<p class="tiny muted coach-note">正在问 AI……（会给服务商发一次请求）</p>' : ''}
    ${v.note ? `<p class="tiny muted coach-note">${esc(v.note)}</p>` : ''}
    <p class="tiny muted coach-note">${v.aiText
    ? '这段话是 AI 组织的，数字还是本地算的（发出来之前已核对过）。'
    : '数字来自你今天的记录，计算在手机本地完成。'}</p>`;
}

function coachFoot() {
  const v = coachView;
  if (v.loading) return '';
  if (!aiOn()) {
    return `<button class="btn ghost grow" data-coach="close">知道了</button>
      <button class="btn grow" data-coach="config">配一下 AI（可选）</button>`;
  }
  return `${v.aiText ? '<button class="btn ghost grow" data-coach="local">看本地版</button>' : ''}
    <button class="btn grow" data-coach="ai">让 AI 说细一点</button>`;
}

function paintCoach() {
  if (!coachView) return;
  openSheet({ title: '教练', body: coachBody(), foot: coachFoot(), onMount: bindCoachActions });
}

function bindCoachActions() {
  document.querySelectorAll('[data-coach]').forEach((b) => {
    b.addEventListener('click', async () => {
      const act = b.dataset.coach;
      if (act === 'close') { closeSheet(); return; }
      if (act === 'local') { coachView.aiText = null; coachView.note = null; paintCoach(); return; }
      if (act === 'config') {
        closeSheet();
        openAiSettingsSheet({ then: () => openCoachSheet() });
        return;
      }
      if (act !== 'ai') return;
      coachView.loading = true;
      coachView.note = null;
      paintCoach();
      const r = await askCoach(coachView.brief);
      coachView.loading = false;
      if (!r.ok) {
        coachView.aiText = null;
        coachView.note = `AI 这次没接上（${r.error}），先用本地版。`;
        paintCoach();
        return;
      }
      // 模型只许组织语言：出现清单外的数字、或者暗示「练了可以多吃」，一律退回本地版
      const checked = checkCoachText(r.text, coachView.brief);
      if (!checked.ok) {
        coachView.aiText = null;
        coachView.note = `AI 说的话里数字对不上（${checked.reason}），已换成本地版。`;
        paintCoach();
        return;
      }
      coachView.aiText = checked.text;
      paintCoach();
    });
  });
}

function openCoachSheet() {
  const brief = coachBriefNow();
  if (!brief) return;
  coachView = {
    brief,
    local: localCoachAdvice(brief),
    aiText: null,
    note: aiOn() ? null : 'AI 版要先在设置里配一个模型；上面这份是本地算的，不配也够用。',
    loading: false,
  };
  paintCoach();
}

/** 数据与备份 */
function openBackupSheet() {
  const backup = readBackup(localStorage);
  const size = (() => {
    try { return Math.round((localStorage.getItem(STORAGE_KEY) || '').length / 1024); } catch { return 0; }
  })();
  /*
   * 「X 天的记录」只算真的有东西的日子 —— 统一用 store 的 recordedDays()。
   * 以前这里自己数 days 的键：今天页一渲染就会建出「今天」这一格，洞察那段更狠，
   * 会把最近 14 天全建出来 —— 于是只记了 1 天，这里却写着「14 天的记录」。
   * 判断只留一份：备份页、「覆盖前要不要确认」都用它。
   */
  const days = recordedDays(state).length;

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
          <b>自动快照</b><br>
          时间：${esc(String(backup.savedAt).slice(0, 16).replace('T', ' '))}<br>
          来源版本：v${esc(String(backup.schemaVersion))}<br>
          ${esc(backup.note || '')}
        </div>
        <div class="btn-row">
          <button class="btn ghost grow" id="doRestore">回滚到这份快照</button>
          <button class="btn ghost" id="doForget">删除快照</button>
        </div>` : '<p class="tiny muted" style="margin-top:10px">还没有快照。存档升级、导入、看演示之前都会自动留一份。</p>'}
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
        所以真正准的是「体重」页的趋势判断 —— 它按你实际的掉秤速度来校准，比任何公式都准。
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
        界面代码：<b>${APP_VERSION}</b><br>
        <span id="swVersionLine" class="tiny muted"></span>
        存档结构：v${SCHEMA_VERSION}<br>
        <span class="tiny muted">截图这一行发我，就能知道你手机上跑的是哪一版 —— 排查问题最有用的一句话。</span>
      </div>
      <div class="btn-row" style="margin-top:2px">
        <button class="btn ghost grow" id="openWhatsNew">更新说明</button>
        <button class="btn ghost grow" id="checkUpdate">检查更新</button>
      </div>
      <button class="btn ghost block" id="forceUpdate" style="margin-top:8px">强制更新到最新版</button>
      <p class="tiny muted" style="margin:6px 0 0">
        如果手机上显示的版本和更新说明对不上（卡在旧版本），点「强制更新」：只清临时缓存再重新加载，
        记录、资料、AI 密钥都在这台手机里，不会丢。强制更新后还是旧版，把上面这行版本号截图发我。
      </p>`,
    onMount: () => {
      const line = document.getElementById('swVersionLine');
      if (line) {
        const ctrl = navigator.serviceWorker?.controller;
        line.textContent = ctrl ? '离线缓存已接管（下次打开会自动拿到新版）' : '离线缓存未接管';
      }
      $('#openWhatsNew')?.addEventListener('click', () => openWhatsNewSheet({ entries: CHANGELOG.slice(0, 3) }));
      $('#checkUpdate')?.addEventListener('click', manualCheckForUpdate);
      $('#forceUpdate')?.addEventListener('click', () => {
        if (!confirm('强制更新会清掉旧版本的临时缓存并重新加载。记录都在这台手机里，不会丢。继续？')) return;
        closeSheet();
        forceFresh();
      });
    },
  });
}

/* ── 更新提示 ────────────────────────────────
   两种，别混在一起：
   1) 「更新了什么」：新版本**已经跑起来**之后，第一次打开告诉用户改了什么（版本变了才弹）；
   2) 「有新版本了」：手机上跑的这版旧了、服务端已经有新版 —— 提醒用户刷新一下。
   两者都只在真的有事时出现，不重复打扰；文案说人话，不写版本号以外的术语。
   ───────────────────────────────────────── */

/** 更新说明的正文：一条版本一块，新的在上面 */
function whatsNewBody(entries) {
  return entries.map((e) => `
    <div class="update-entry">
      <div class="update-ver">${esc(e.version)} <span>${esc(e.date)}</span></div>
      <ul class="update-list">${e.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    </div>`).join('');
}

/** 打开「更新了什么」。markSeen=true 表示这是自动弹的：关掉/忽略都算看过了 */
function openWhatsNewSheet({ entries = CHANGELOG, markSeen = false, onDone = null } = {}) {
  if (markSeen) markVersionSeen();
  openSheet({
    title: markSeen ? '更新了什么' : '每次更新都改了什么',
    body: whatsNewBody(entries),
    foot: '<button class="btn block" id="updateOk">知道了</button>',
    onMount: (_body, foot) => {
      $('#updateOk', foot).addEventListener('click', () => {
        closeSheet();
        if (onDone) onDone();
      });
    },
  });
}

/** 记下「已经看过当前版本」，下次打开不再弹更新说明 */
function markVersionSeen() {
  state.settings = { ...(state.settings || {}), lastSeenVersion: APP_VERSION };
  save();
}

/** 启动时检查要不要弹「更新了什么」 */
function maybeShowWhatsNew() {
  if (!state?.profile) return false;               // 还没填资料的新用户：不弹
  if (startupNotice?.kind === 'error') return false; // 先让用户处理读不出来的记录，别抢同一个弹层
  // 已经开着别的弹层（引导、记一笔）时不弹：不盖上去，也不排定时器重试 ——
  // 延迟重试的定时器会在页面之外继续跑，可能和别的写存档动作撞车（踩过：一次保存记出两条）。
  // 这次错过就等下次打开再弹，更新说明不是急事。
  if ($('#sheetRoot') && !$('#sheetRoot').classList.contains('hidden')) return false;
  const pending = pendingUpdates(state);
  if (!pending.length) return false;
  openWhatsNewSheet({ entries: pending, markSeen: true });
  return true;
}

/** 问服务端要一下 sw.js 里的版本号（读不到就返回空串：离线、被缓存、格式不对都算读不到） */
async function deployedVersion() {
  try {
    const res = await fetch('sw.js', { cache: 'no-store' });
    if (!res.ok) return '';
    const text = await res.text();
    return (text.match(/APP_VERSION = '([^']+)'/) || [])[1] || '';
  } catch {
    return '';
  }
}

function sheetIsOpen() {
  const root = $('#sheetRoot');
  return Boolean(root && !root.classList.contains('hidden'));
}

function isTypingNow() {
  const ae = document.activeElement;
  return Boolean(ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && String(ae.value || '').trim());
}

/**
 * 「强制更新」：注销旧 Service Worker + 清掉临时缓存，然后重载。
 *
 * **不会碰 localStorage** —— 记录、资料、AI 密钥都还在本机，只是把「旧代码的缓存」扔掉。
 * 这是给「手机一直卡在旧版本」准备的自救按钮（真事故：用户卡在很早的版本好几天）。
 */
async function forceFresh(latest = '') {
  try { sessionStorage.setItem(AUTO_UPDATE_FLAG, '1'); } catch { /* 忽略 */ }
  try { if (latest) sessionStorage.setItem('fatloss.updatedTo', latest); } catch { /* 忽略 */ }
  toast('正在清理旧缓存并重新加载，记录不会丢…');
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch { /* 不支持就算了，下面照样重载 */ }
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* 同上 */ }
  location.reload();
}

/**
 * 常驻的更新横幅。
 *
 * 为什么不用弹层就算：弹层可以被「先不刷新」关掉，而卡在旧版本正是这次真事故的根因。
 * 横幅会一直挂着，直到真的更新；点一下就是刷新（更新记录说明仍在弹层里）。
 */
let updateBanner = null;
function showUpdateBanner(latest) {
  if (updateBanner) return;
  const el = document.createElement('div');
  el.className = 'update-banner';
  const text = document.createElement('span');
  text.textContent = updateBannerText(latest);
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = '更新';
  btn.addEventListener('click', () => openRefreshSheet(latest));
  el.append(text, btn);
  document.body.appendChild(el);
  updateBanner = el;
}
function hideUpdateBanner() { if (updateBanner) { updateBanner.remove(); updateBanner = null; } }

/** 打开「有新版本了」：一个刷新按钮 + 一个先不刷新 */
function openRefreshSheet(latest) {
  // 弹过就算提醒过：右上角 ×、点背景关掉都算（否则同一次会话里过 5 分钟切回来还会再弹）
  try { sessionStorage.setItem('fatloss.updatePrompted', latest); } catch { /* 存不了就算了 */ }
  openSheet({
    title: '有新版本了',
    body: `
      <div class="set-note">
        <b>新版本 ${esc(latest)} 已经准备好了</b><br>
        刷新一下就能用上。已经记下的记录都在这台手机里，刷新不会丢。
      </div>
      <p class="small muted" style="margin:8px 0 0">
        不刷新也能继续用，只是新功能和修复要等下次打开才生效。
      </p>`,
    foot: `<button class="btn block" id="reloadNow">刷新，用上新版</button>
      <button class="btn ghost block" id="reloadForce" style="margin-top:8px">刷新后还是旧的？点这里强制更新</button>
      <button class="btn ghost block" id="reloadLater" style="margin-top:8px">先不刷新</button>`,
    onMount: (_body, foot) => {
      $('#reloadNow', foot).addEventListener('click', () => {
        // 万一有等待中的 Service Worker，让它立刻接管，再刷新（正常情况下会自动接管）
        try { navigator.serviceWorker?.controller?.postMessage('skip-waiting'); } catch { /* 忽略 */ }
        closeSheet();
        location.reload();
      });
      $('#reloadForce', foot).addEventListener('click', () => {
        closeSheet();
        forceFresh(latest);
      });
      $('#reloadLater', foot).addEventListener('click', () => {
        closeSheet();
        toast('好，下次打开会自动用上新版。');
      });
    },
  });
}

/** 「检查更新」按钮：手动问一次（不用等启动/切前台时的自动检查） */
async function manualCheckForUpdate() {
  toast('正在检查更新…');
  // 顺便让浏览器去问一次 Service Worker 有没有新版（它自己也会定时问，这里只是手动催一下）
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg?.update) await reg.update();
  } catch { /* 离线 / 不支持：下面的版本检查会说清楚 */ }
  const latest = await deployedVersion();
  if (!latest) {
    toast('现在连不上（可能离线）。下次打开应用时我会自动再检查。');
    return;
  }
  if (!hasNewerVersion(APP_VERSION, latest)) {
    toast(`已经是最新版本（${APP_VERSION}）。`);
    return;
  }
  showUpdateBanner(latest);
  openRefreshSheet(latest);
}

/**
 * 发现线上版本比本机新时的处理（v38 加固）。
 *
 * 真事故：用户手机卡在很旧的版本好几天 —— 截图里还是早已修掉的「AI 说库里没有，一条都没记上」。
 * 原因是早期版本连 sw.js 都被缓存，更新提醒永远弹不出来。现在：
 *  1) 刚启动/切回前台、手头没事（没开弹层、没有草稿、没在输入）→ **自动更新一次**（重载，记录不丢）；
 *  2) 不方便自动更新 → 顶部常驻横幅，直到真的更新（弹层可以被关掉，横幅不会）；
 *  3) 自动更新只尝试一次/会话，网络或 CDN 不一致时不来回重载。
 */
async function checkForUpdate() {
  const latest = await deployedVersion();
  if (!hasNewerVersion(APP_VERSION, latest)) {
    hideUpdateBanner();
    try { sessionStorage.removeItem(AUTO_UPDATE_FLAG); } catch { /* 忽略 */ }
    return false;
  }
  const idle = !userTouched && canRefreshNow({ sheetOpen: sheetIsOpen(), hasDraft: Boolean(draft), typing: isTypingNow() });
  let autoTried = false;
  try { autoTried = sessionStorage.getItem(AUTO_UPDATE_FLAG) === '1'; } catch { /* 忽略 */ }
  if (idle && !autoTried) {
    toast(`发现新版本 ${latest}，正在自动更新…`);
    setTimeout(() => forceFresh(latest), 800);
    return true;
  }
  // 不方便自动更新：横幅常驻 + 弹一次说明（弹层可关，横幅不会）
  showUpdateBanner(latest);
  let prompted = false;
  try { prompted = sessionStorage.getItem('fatloss.updatePrompted') === latest; } catch { /* 忽略 */ }
  if (idle && !prompted) openRefreshSheet(latest);
  return true;
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
        <div class="plant-art">${icon(plant.stage.icon, { size: 56 })}</div>
        <div class="plant-info">
          <div class="plant-name">${esc(plant.stage.name)}</div>
          <div class="tiny muted">${esc(plant.line)}</div>
          <div class="plant-bar"><i style="width:${plant.nextStage ? Math.min(100, Math.round((plant.total / plant.nextStage.min) * 100)) : 100}%"></i></div>
          <div class="tiny muted">${plant.nextStage ? `再记 ${plant.toNext} 天，就会${esc(plant.nextStage.name)}` : '已经长到最大了'}</div>
        </div>
      </div>

      <button class="btn block" id="openRecap" style="margin-top:12px">看最近 30 天的回顾</button>

      ${showWeekly ? `
        <div class="card" style="margin-top:12px;box-shadow:none;background:#FFFCFC;border:1px solid var(--line)">
          <div class="card-title">这周的小结</div>
          <div class="hl">${icon(hl.icon, { size: 16 })} <b>${esc(hl.text)}</b></div>
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
              <span class="ach-icon">${icon(x.icon, { size: 58, label: badgeLabel(state, x) })}${x.unlocked ? '' : `<span class="ach-lock">${icon('lock', { size: 12 })}</span>`}</span>
              <span class="ach-name">${esc(badgeLabel(state, x))}</span>
              ${x.unlocked ? '' : `<span class="ach-bar"><i style="width:${x.pct}%"></i></span>`}
            </div>`).join('')}
        </div>
        <p class="tiny muted" style="margin:10px 0 0">
          徽章只跟「记录、吃够蛋白、动起来」有关 —— 我们没有"少吃几天"这种徽章，那类目标长期是有害的。
        </p>
      </div>

      ${recent.length ? `
        <div class="small muted" style="text-align:center;margin-top:10px">最近拿到：${recent.map((x) => icon(x.icon, { size: 18 }) + x.name).join('、')}</div>` : ''}`,
    onMount: (body) => {
      $('#openRecap', body)?.addEventListener('click', openRecapSheet);
      body.querySelectorAll('[data-ach]').forEach((el) => {
        el.addEventListener('click', () => {
          const x = a.list.find((y) => y.id === el.dataset.ach);
          if (!x) return;
          toast(x.unlocked ? x.congrats : `${x.hint}（${x.value}/${x.target}）`, x.unlocked ? x.icon : 'lock');
        });
      });
    },
  });
}

/**
 * 「最近 30 天的回顾」（v38，issue #14 的 C）。
 *
 * 为什么单独一个弹层：一周小结只覆盖 7 天，看不到更长的变化；
 * 这里把 30 天的记录、蛋白达标、体重趋势、最常吃的东西、运动放在一起。
 * 只陈述事实，不评判；数据不够就直说「先记几天」。
 */
function openRecapSheet() {
  const t = targets();
  if (!t) return toast('先填一下资料，回顾才有目标可以对照。');
  const recap = buildRecap({ state, targets: t, today: todayKey() });
  const lines = recapLines(recap);
  const dots = [];
  for (let i = 0; i < recap.days; i++) {
    const key = shiftDate(recap.from, i);
    const day = state.days?.[key];
    const logged = Boolean(day && (Object.values(day.meals || {}).flat().length || (day.exercises || []).length));
    dots.push(`<span class="${logged ? 'on' : ''}" title="${esc(key)}"></span>`);
  }
  const tile = (label, value, unit = '') => `
    <div class="recap-tile"><b>${value}${unit}</b><span>${label}</span></div>`;

  openSheet({
    title: '最近 30 天的回顾',
    body: `
      <div class="warn info" style="margin-top:0">${lines.map((l) => `<div style="margin:2px 0">· ${esc(l)}</div>`).join('')}</div>
      <div class="recap-grid">
        ${tile('记录天数', recap.loggedDays, ' 天')}
        ${tile('最长连续', recap.longestStreak, ' 天')}
        ${tile('蛋白达标', recap.proteinHitDays, ' 天')}
        ${tile('运动', recap.exerciseMinutes, ' 分钟')}
      </div>
      <div class="set-note" style="margin-top:6px"><b>这 30 天</b><br>
        <div class="week-dots recap-dots">${dots.join('')}</div>
        <span class="tiny muted">亮起来的是有记录的日子；没亮的不用补，从今天接着记就行。</span>
      </div>
      ${recap.topFoods.length ? `
        <hr class="sep">
        <div class="set-note"><b>最常记的</b><br>
          ${recap.topFoods.map((f, i) => `${i + 1}. ${esc(f.name)} · ${f.times} 次`).join('<br>')}
        </div>` : ''}
      <p class="tiny muted" style="margin:12px 0 0">
        回顾只陈述记录里的事实，不带评价 —— 记录少的时候也不能说明什么，接着记就好。
      </p>`,
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

    const streak = currentStreak(state);
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

/**
 * AI 设置。
 * @param {{then?:Function}} options then 是「配完/离开设置后接着做什么」——
 *   新手引导里选 AI 模式时会传，这样配完能接着走引导的最后一步，不用用户自己找。
 */
async function openAiSettingsSheet({ then = null } = {}) {
  const cfg = currentAiConfig();
  const relay = await relayStatus(1200);
  drawAiSettings(cfg, relay, then);
}

function drawAiSettings(cfg, relay, then = null) {
  const presetId = cfg.presetId || 'deepseek';
  const preset = findPreset(presetId);
  const mode = cfg.mode || (preset.directCall === false ? 'relay' : 'direct');
  const directOk = preset.directCall !== false;

  const body = `
    <label class="field"><span>选一个服务商</span>
      <div class="chips" id="presetChips">
        ${PRESETS.map((p) => `
          <button class="chip ${presetId === p.id ? 'on' : ''}" data-preset="${p.id}">
            ${esc(p.name)}${p.recommended ? ` ${icon('star', { size: 12 })}` : ''}${p.directCall === false ? '（需中转）' : ''}
          </button>`).join('')}
      </div>
    </label>
    <div id="presetNote" class="small muted" style="margin:-4px 0 12px"></div>

    <label class="field"><span>接口地址</span>
      <input type="text" id="aiBaseUrl" value="${esc(cfg.baseUrl || preset.baseUrl || '')}" placeholder="https://api.deepseek.com">
    </label>

    <label class="field"><span>模型名 <button class="btn ghost" id="aiFetchModels" style="padding:2px 8px;font-size:12px;float:right">获取模型列表</button></span>
      <input type="text" id="aiModel" value="${esc(cfg.model || preset.model || '')}" placeholder="deepseek-flash" list="aiModelList" autocomplete="off">
      <datalist id="aiModelList">${lastModels.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
      <div id="modelPick" class="chips" style="margin-top:6px"></div>
    </label>

    <label class="field"><span>密钥（只存在这台手机上）</span>
      <input type="text" id="aiKey" placeholder="${cfg.keyMasked ? `已保存：${esc(cfg.keyMasked)}（留空则不改）` : '粘贴服务商的 API Key'}" autocomplete="off" autocapitalize="off" spellcheck="false">
    </label>
    <details id="aiKeyGuide" style="margin:-4px 0 12px">
      <summary style="cursor:pointer;color:var(--rose);font-size:13px">手把手教程：从注册到粘贴（5 分钟）</summary>
      <div class="tiny" style="margin-top:8px;line-height:1.75">
        <div class="warn info" style="margin:0 0 10px">
          <b>先把钱的事说清楚</b>：API 是 <b>DeepSeek 官方按用量收费</b>，钱直接付给 DeepSeek。
          我们<b>不收任何费用</b>，也拿不到你的密钥、看不到你的账单 —— 这笔交易跟我们无关。
          不想花钱就换别家服务商（上面「选一个服务商」里随便换，流程差不多）。
        </div>
        <p style="margin:0 0 6px">以 DeepSeek 为例，照着做就行。要准备：<b>手机号</b>（注册用）+ <b>支付宝或微信</b>（充值用）。</p>
        <ol style="margin:0 0 8px 18px;padding:0">
          <li><b>打开官网</b>：在浏览器地址栏输入
            <a href="https://platform.deepseek.com" target="_blank" rel="noopener">platform.deepseek.com</a>
            （也可以直接点这个链接）。<br>
            <span class="tiny muted">注意：这是给程序用的「开放平台」，不是你平时聊天用的那个 DeepSeek 网页。</span></li>
          <li><b>注册 / 登录</b>：点「登录」，输入手机号 → 收短信验证码 → 填进去就进去了。
            没有账号的会自动注册，不用单独点注册。</li>
          <li><b>充一点钱</b>：登录后看左侧菜单，点「充值 / Top up」，充 10 元就够用很久
            （按一天记三顿算，一次解析大约几厘钱；具体价格以官方页面为准）。
            <span class="tiny muted">钱充进的是你在 DeepSeek 的账户，不是给我们。</span></li>
          <li><b>创建密钥</b>：点左侧「API Keys」→「创建 API Key / Create new API key」，
            名字随便写（例如「减脂小助手」）→ 创建。<br>
            复制那一长串 <code>sk-</code> 开头的字符，<b>它只显示这一次</b>，关掉就看不到了
            （没复制到就再创建一个新的，不要紧）。</li>
          <li><b>回来粘贴</b>：把密钥粘贴到上面的「密钥」输入框，点下面的「保存并测试连通」。
            显示「保存成功，连通正常」就能用了。</li>
          <li><b>密钥安全</b>：只存在这台手机上，不上传、不经过我们的服务器，我们看不到。
            换手机或清缓存前，在「数据与备份」里导出备份。</li>
        </ol>
        <p style="margin:0 0 4px"><b>常见问题</b></p>
        <p style="margin:0">· 提示「密钥无效」：检查是不是复制全了、前后有没有空格。<br>
          · 提示「余额不足」：回开放平台充值。<br>
          · 提示「model not found」：模型名填 <code>deepseek-flash</code>。<br>
          · 提示「连不上」：换 WiFi / 流量再试；公司网络可能挡了 API。<br>
          · 不想用 DeepSeek：在上面「选一个服务商」里换一家，步骤都差不多。</p>
      </div>
    </details>

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

  // 密钥框的占位提示必须说真话：同一个服务商 → 留空就用原来那把；
  // 换了服务商 → 留空不再沿用（原来那句「留空则不改」会误导用户以为换了也能用旧密钥）
  const keyPlaceholder = (p) => {
    // 读此刻的真实配置，而不是打开弹层那一刻的快照 ——
    // 这里刚配好、同一个弹层里再点一次保存时，快照还是「没配过」，会又提示「密钥没填」
    const live = currentAiConfig();
    const savedPresetId = readAiConfigRaw()?.presetId || live.presetId || null;
    if (p.allowEmptyKey) return '本地模型随便填，例如 ollama';
    if (live.configured && live.keyMasked && p.id === savedPresetId) return `已保存：${live.keyMasked}（留空则不改）`;
    if (live.configured && p.id !== savedPresetId) return '换了服务商，密钥要重新填（不会沿用上一家的）';
    return '粘贴服务商的 API Key';
  };

  const findPresetId = () => bodyEl.querySelector('#presetChips .chip.on')?.dataset.preset || presetId;

  const applyPreset = (id, { overwrite = true } = {}) => {
    const p = findPreset(id);
    $('#presetNote').innerHTML = `${esc(p.note)}${p.keyUrl ? ` <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">去拿密钥 →</a>` : ''}`;
    if (overwrite) {
      if (p.baseUrl) $('#aiBaseUrl').value = p.baseUrl;
      if (p.model) $('#aiModel').value = p.model;
      $('#aiKey').placeholder = keyPlaceholder(p);
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
    if (!input.apiKey && !currentAiConfig().configured) return show('密钥还没填。', '');
    const saved = saveAiConfigLocal(input);
    if (!saved.ok) return show(esc(saved.problems.join('；')), '');
    show('已保存，正在测试连通…', 'info');
    const t = await testConnection();
    if (t.ok) {
      show(`${icon('check', { size: 15 })} 保存成功，连通正常（${esc(t.model || '')} 回复：${esc(t.reply || '正常')}）<br>现在「说一句」就能用了。`, 'info');
      ai = { configured: true, checked: true, mode: currentAiConfig().mode };
      // 保存完把输入框清空，只留占位提示：密钥不该一直明文摊在屏幕上，
      // 也让「留空则不改」这句话在同一个弹层里就变成真的
      $('#aiKey').value = '';
      $('#aiKey').placeholder = keyPlaceholder(findPreset(findPresetId()));
      /*
       * 从新手引导点「开始配置」进来的：配好就直接接着走引导最后一步。
       * 以前这个 then 参数只声明、从来没被调用过 —— 用户在引导里配完密钥，
       * 弹层停在原地，得自己退出去重新点「新手引导」才能走完（v44 修）。
       * 留 600ms 让他看清「保存成功」，再关弹层跳下一步。
       */
      if (typeof then === 'function') setTimeout(() => { closeSheet(); then(); }, 600);
    } else {
      show(`设置已保存，但连通测试失败：<b>${esc(t.error)}</b><br>修好之前「说一句」还用不了；搜食物、只填热量、照包装都能正常记。`, '');
      ai = { configured: false, checked: true, reason: t.error };
    }
    render();
  });

  $('#aiTest')?.addEventListener('click', async () => {
    show('正在测试…（最多 20 秒）', 'info');
    const r = await testConnection();
    if (r.ok) show(`${icon('check', { size: 15 })} 连通正常（${esc(r.model || '')} 回复：${esc(r.reply || '正常')}）${r.via === 'relay' ? '（走电脑中转）' : ''}`, 'info');
    else show(`${icon('alert', { size: 15 })} ${esc(r.error)}`, '');
  });

  $('#aiClear')?.addEventListener('click', () => {
    if (!confirm('清除这台手机上保存的 AI 密钥？清除后「说一句」要重新配置才能用。')) return;
    clearAiConfig();
    ai = { configured: false, checked: true };
    closeSheet();
    render();
    toast('已清除。说一句话前要重新配置。');
  });
}

/* ── 弹层：资料 ──────────────────────────── */

/**
 * 资料表单。openProfileSheet 和「新手引导」共用这一套 —— 校验只有一份，
 * 免得「第一次填」和「以后修改」走两套规则，出现引导能存、设置里存不了这种怪事。
 *
 * @param {{firstTime?:boolean, onSaved?:Function}} options
 *   firstTime 时标题和按钮文案不同（引导里说的是「开始用」，不是「保存」）
 *   onSaved 可以拦住后续流程（引导要接着问下一个问题）
 */
function openProfileSheet({ firstTime = false, onSaved = null } = {}) {
  const p = state.profile || {
    nickname: '',
    sex: 'female', age: 25, heightCm: 163, weightKg: 58, bodyFatPct: null,
    activity: 'light', pace: 'standard', goal: 'lose', targetWeightKg: null,
  };
  const hasProfile = Boolean(state.profile);
  openSheet({
    title: firstTime ? '你的基础数据' : (hasProfile ? '我的资料' : '填写资料'),
    body: `
      <label class="field"><span>怎么称呼你</span>
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
    foot: `<button class="btn block" id="pSave">${firstTime ? '算算我每天该吃多少' : '保存'}</button>${hasProfile && !firstTime ? '<button class="btn ghost block" id="pCancel" style="margin-top:8px">取消</button>' : ''}`,
    onMount: (body, foot) => {
      // 取值一律走这里：字段可能因为界面变动暂时不在，
      // 直接解引用会抛异常，把整个表单（包括实时预览）打挂 —— 表单要能容忍缺字段。
      const raw = (id) => $(`#${id}`, body)?.value ?? '';
      const num = (id) => (raw(id) === '' ? NaN : Number(raw(id)));
      const form = () => ({
        nickname: (raw('pNickname') || '').trim().slice(0, 8),
        sex: body.querySelector('#sexChips .chip.on')?.dataset.sex || 'female',
        age: num('pAge'),
        heightCm: num('pHeight'),
        weightKg: num('pWeight'),
        bodyFatPct: raw('pBodyFat') === '' ? null : num('pBodyFat'),
        activity: body.querySelector('#actChips .chip.on')?.dataset.actKey || 'light',
        goal: body.querySelector('#goalChips .chip.on')?.dataset.goal || 'lose',
        pace: body.querySelector('#paceChips .chip.on')?.dataset.pace || 'standard',
        targetWeightKg: raw('pTarget') === '' ? null : num('pTarget'),
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
      // 注意这里是 `.chips, .seg`：「想做什么」那一组用的是 .seg 容器，
      // 只挑 .chips 会让「减脂 / 维持体重」两个按钮根本绑不上（点了没反应，属于最气人的那种 bug）。
      body.querySelectorAll('.chips, .seg').forEach((box) => {
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
          // 第一次填资料 = 新用户（不是升级），把「已看到当前版本」记下来，别在下次打开时弹更新说明
          if (!hasProfile && !state.settings?.lastSeenVersion) {
            state.settings = { ...(state.settings || {}), lastSeenVersion: APP_VERSION };
          }
          save();
          closeSheet();
          view = 'today';
          document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'today'));
          render();
          if (onSaved) onSaved(t);
          else toast(`已保存。你每天的目标大约是 ${Math.round(t.targetCalories / 10) * 10} kcal。`);
        } catch (err) {
          toast(err.message);
        }
      });
      if (hasProfile && !firstTime) $('#pCancel', foot).addEventListener('click', closeSheet);
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

/** 下载一段文本。导出存档、导出「读不出来的原始内容」都走这里，行为保持一致。 */
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportData() {
  downloadText(`减脂记录-${todayKey()}.json`, JSON.stringify(state, null, 2));
  toast('已导出。文件在手机的「下载」里，换设备时用「导入存档」恢复。');
}

/**
 * 导出那份「读不出来」的原始内容。
 * 程序解析不了它，但我可能能救 —— 让用户先存下来发我，比让用户自己抄现实。
 */
function exportUnreadable() {
  const kept = readUnreadable(localStorage);
  if (!kept) { toast('没有找到留存的原始内容。'); return; }
  downloadText(`读不出来的存档-${todayKey()}.json`, kept.raw);
  toast('已导出原始文件。可以把它发给我看看能不能救回来。');
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
        const hadData = hasUserData(state);
        const days = recordedDays(state).length;
        const what = days > 0 ? `${days} 天的记录` : '现在填好的资料';
        if (!confirm(`导入会覆盖这台设备上的${what}。\n会先自动留一份快照，之后可以在「我的 → 数据与备份」里回滚。继续？`)) return;
        // 覆盖前先留底：导入是唯一一个「用旧文件换掉现状」的入口，不留底就是不可恢复
        if (hadData) saveBackup(localStorage, state, '导入之前的自动快照');
        state = migrated.data;
        save();
        render();
        toast(hadData ? '导入完成。之前的记录留了快照，可以在「数据与备份」里回滚。' : '导入完成。');
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

// 问一次服务端「AI 配好了没」。没配也能手动记，只是「说一句」用不了。
aiStatus().then((st) => {
  ai = { ...st, checked: true };
  syncTestState();
  if (view === 'log') render();
}).catch(() => {});

/** 启动失败的兜底：不让用户看到一片空白 */
function renderBootFailure(err) {
  console.error('启动失败：', err);
  const box = document.getElementById('bootFail');
  if (box) {
    box.hidden = false;
    const detail = document.getElementById('bootFailDetail');
    if (detail) detail.textContent = String(err && (err.stack || err.message) || err).slice(0, 300);
    return;
  }
  // 连兜底块都没有（老版本 index.html 被缓存）：至少往页面里写一句
  const main = document.getElementById('app');
  if (main) main.innerHTML = '<div class="card"><div class="card-title">没能打开</div><p class="small muted">请刷新一次页面。如果一直这样，清理本站数据后重试。</p></div>';
}

const bootParams = new URLSearchParams(location.search);
try {
if (bootParams.has('__selfcheck')) {
  selfCheck();
} else if (bootParams.get('demo') === '1') {
  // ?demo=1：一键进演示（GitHub Pages 上可以直接把链接发人看）
  // 有记录时不能直接装：先在正常界面里弹确认，并且留快照（见 requestDemo）
  if (hasUserData(state)) {
    render();
    requestDemo();
  } else {
    startDemo();
  }
} else if (!state) {
  // 空存档：只负责建状态，界面交给 render() —— 它才会绑按钮。
  // 之前这里直接调 renderWelcome() 并且只补了 bindCommon()，
  // 后来的改动让页面结构变了，欢迎页的按钮就变成点不动了（用户报的「点都点不了」）。
  state = emptyState();
  render();
} else {
  render();
}
} catch (err) {
  renderBootFailure(err);
}

// 启动时如果发生过数据迁移（或读不出来），第一时间告诉用户 —— 这种信息不能藏
if (startupNotice) {
  setTimeout(() => {
    if (startupNotice.kind === 'error') {
      celebrate({ iconName: 'alert', title: '记录读取有问题', sub: startupNotice.text });
    } else {
      toast(startupNotice.text);
    }
  }, 600);
}

// 刚刚通过「自动/强制更新」重载过：确认一句（只提示一次，免得每次打开都念）
try {
  const updatedTo = sessionStorage.getItem('fatloss.updatedTo');
  if (updatedTo) {
    sessionStorage.removeItem('fatloss.updatedTo');
    setTimeout(() => toast(`已更新到 ${updatedTo}。`), 1200);
  }
} catch { /* 忽略 */ }

// 用户已经动过手（点了/打字了）就不再自动重载，改成常驻横幅 + 手动更新
let userTouched = false;
for (const evt of ['pointerdown', 'keydown', 'touchstart']) {
  document.addEventListener(evt, () => { userTouched = true; }, { once: true, passive: true });
}

// 更新提示要在界面渲染完之后再弹，避免和「数据迁移提示 / 读不出来的记录」抢同一个弹层。
// 900ms 是等启动 toast 出来之后；4s 后再检查一次服务端有没有更新（离线时读不到就静默跳过）。
setTimeout(() => { try { maybeShowWhatsNew(); } catch (err) { console.warn('更新说明没弹出来：', err); } }, 900);
setTimeout(() => { checkForUpdate().catch(() => {}); }, 4000);
let lastUpdateCheckAt = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (Date.now() - lastUpdateCheckAt < 5 * 60 * 1000) return; // 别每次切回来都问一次
  lastUpdateCheckAt = Date.now();
  checkForUpdate().catch(() => {});
});

// 启动成功的标记：浏览器自检靠它判断「模块有没有炸掉导致白屏」
/**
 * 给自检用的只读快照。
 *
 * 为什么需要：`ai` 是异步拿到的（aiStatus()），而界面文案会随后重绘 ——
 * 自检若能直接读到「模式 / AI 是否就绪」，就不用靠猜某个按钮的文字，也不会因为
 * 我们把「AI 已开启」改成「AI 模式」这种文案调整而误判。测试只读，不改任何东西。
 */
function syncTestState() {
  window.__appState = {
    aiConfigured: aiOn(),
    aiChecked: Boolean(ai.checked),
  };
}

/*
 * 应用真的起来了：把「正在打开…」和慢网下可能已经弹出来的「没能打开」收回去。
 * （index.html 的兜底脚本只负责显示，不负责隐藏；不在这里收，用户会一直看到错误卡。）
 */
for (const id of ['bootLoading', 'bootFail']) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}
window.__appReady = true;

