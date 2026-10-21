/**
 * 内联 SVG 图标库。
 *
 * 为什么不用 emoji（issue #9）：
 *  1) 同一颗 emoji 在 iPhone / 安卓 / Windows 上是三套完全不同的画 ——
 *     产品在别人手机上长什么样，我们控制不了；
 *  2) 风格不统一：有的带底色块、有的纯线、有的立体渐变，摆一起像从三个 App 里抠的；
 *  3) 读屏软件会念「米饭 emoji」这种噪音。
 *
 * 这里全部是矢量、内联、可断网 —— 不引外部字体、不引 CDN、不加位图。
 *  - 界面（按钮、分段、设置行、洞察、器械）：单色线性，跟着 currentColor 变；
 *  - 徽章：柔和底色的圆形勋章 + 同一套线性字形（BADGE 表里配 2 种颜色）；
 *  - 植物：2~3 色插画（叶子→开花→树），这类图标承担情绪价值，纯线条会变冷。
 *
 * 新增图标只需在对应的表里加一条，不用改样式。
 */
/** 只用于拼进属性里的短字符串（图标名、aria-label），不用于正文 */
function attr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── 线性字形（24 × 24，1.6 描边）─────────────────
   名字尽量用具象的英文，界面里按语义引用。 */
const LINE = {
  /* 界面 chrome */
  bowl: '<path d="M4 11h16c0 4.3-3.6 7.2-8 7.2S4 15.3 4 11z"/><path d="M9.2 8.2c0-1.3 1-1.9 1-3.2M13.4 8.2c0-1.3 1-1.9 1-3.2"/>',
  run: '<circle cx="15.2" cy="4.6" r="1.7"/><path d="M14.3 7.7 11 10l1.9 3.1-2.6 2.7M14.3 7.7l2.7 1.9.9 3.7M12.9 13.1l2.7 2.4.5 3.1M11 15.8 8.3 17.7 7.4 20"/>',
  chat: '<path d="M4.5 6.5h15v9.7h-9.2L4.5 20z"/><path d="M8 10h8M8 12.8h5"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5h6v2.6H9z"/><path d="M8.5 11.2h7M8.5 14.6h5"/>',
  camera: '<path d="M4.5 8.5h3l1.4-2h6.2l1.4 2h3v10h-15z"/><circle cx="12" cy="13.2" r="3.1"/>',
  user: '<circle cx="12" cy="8.2" r="3.3"/><path d="M5.4 20c.6-3.5 3.3-5.5 6.6-5.5s6 2 6.6 5.5"/>',
  sparkles: '<path d="M11.5 3.5l1.5 4.2 4.2 1.5-4.2 1.5-1.5 4.2L10 10.7 5.8 9.2l4.2-1.5z"/><path d="M18.2 14.8l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z"/>',
  save: '<path d="M5 4.5h11l3 3v12H5z"/><path d="M8.5 4.5v5h7v-5M8.2 15.6h7.6"/>',
  trash: '<path d="M5 7h14M9.2 7V4.5h5.6V7M7.2 7l1 13h7.6l1-13M10.2 10.6v6M13.8 10.6v6"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="M15.3 8.7l-1.8 4.8-4.8 1.8 1.8-4.8z"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 10.6V17"/><circle cx="12" cy="7.6" r=".95" fill="currentColor" stroke="none"/>',
  alert: '<path d="M12 4.2 21 20H3z"/><path d="M12 9.4v5"/><circle cx="12" cy="17.2" r=".95" fill="currentColor" stroke="none"/>',
  check: '<path d="M5 12.6 9.4 17 19 6.8"/>',
  close: '<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>',
  lock: '<rect x="5.5" y="10.4" width="13" height="9.2" rx="2"/><path d="M8.6 10.4V7.8a3.4 3.4 0 0 1 6.8 0v2.6"/>',
  star: '<path d="M12 4.2l2.2 4.7 5.1.7-3.7 3.6.9 5.1-4.5-2.4-4.5 2.4.9-5.1L4.7 9.6l5.1-.7z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.9v2.1M12 19v2.1M2.9 12h2.1M19 12h2.1M5.5 5.5l1.5 1.5M17 17l1.5 1.5M5.5 18.5 7 17M17 7l1.5-1.5"/>',
  moon: '<path d="M19.2 15A7.7 7.7 0 0 1 9.1 4.9a7.8 7.8 0 1 0 10.1 10.1z"/>',
  tree: '<path d="M12 3.8 7 10.6h10z"/><path d="M12 7.4 7.6 14.6h8.8z"/><path d="M12 14.6V20M8.5 20h7"/>',

  /* 食物 / 身体 */
  egg: '<path d="M12 3.6c3.2 0 5.9 4.3 5.9 8.1A5.9 5.9 0 0 1 6.1 11.7c0-3.8 2.7-8.1 5.9-8.1z"/><circle cx="12" cy="12" r="2.3"/>',
  protein: '<path d="M13.4 4.4a5.1 5.1 0 0 1 6.2 6.2c-.7 3.2-3.7 5.5-7 5.2l-1.6-.2-3.2 3.2-1.9-1.9 3.2-3.2-.2-1.6c-.3-3.3 2-6.3 5.2-7z"/><path d="M6.7 16.9 4.5 19.1"/><circle cx="5" cy="18.6" r="1.5"/>',
  muscle: '<path d="M4 18.2c0-2.6 2-4.7 4.6-4.7h2.3c1.5 0 2.7-1.1 2.7-2.5 0-1.2-.9-2.1-2.1-2.1H10"/><path d="M9 13.5c0-2.8 2.2-5 5-5h.7c2.3 0 4.1 1.8 4.1 4.1 0 3.7-3 6.7-6.7 6.7H4"/><path d="M13.7 8.5v2.9"/>',
  flame: '<path d="M12 3.5c3 3.4 5.4 5.5 5.4 8.9a5.4 5.4 0 0 1-10.8 0c0-1.9.8-3.1 1.9-4.6.4 1.4 1 2.2 2 2.6-.6-2.6.3-4.9 1.5-6.9z"/>',
  mountain: '<path d="M3 19 9 8l4 6 2-3 6 8z"/><path d="M7 12.4l2-1.7 2 1.7"/>',

  /* 记录 / 体重 */
  scale: '<rect x="4" y="4.6" width="16" height="14.8" rx="3"/><path d="M8.4 9.6h7.2"/><path d="M12 9.6l2 3.1"/>',
  trend: '<path d="M4 17l5-5 3.5 3.5L20 8"/><path d="M15 8h5v5"/>',
  receipt: '<path d="M6 3.8h12v16.4l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3z"/><path d="M9 8h6M9 11.4h6M9 14.8h4"/>',
  search: '<circle cx="10.6" cy="10.6" r="6"/><path d="M15 15l5 5"/>',
  calendar: '<rect x="4.5" y="6" width="15" height="13.6" rx="2"/><path d="M4.5 10.4h15M8.6 4v4M15.4 4v4"/>',
  note: '<path d="M6.5 3.6h8l4 4v12.8h-12z"/><path d="M14.5 3.6v4h4M9.6 12h5.8M9.6 15.4h5.8"/>',

  /* 徽章用的花与器物 */
  leaf: '<path d="M20 4C10.6 4 4.2 8.6 4.2 16c0 2.2 1.8 4 4 4C15.6 20 20 13.4 20 4z"/><path d="M5.2 19C8 13.2 12.2 9 17 6.6"/>',
  pot: '<path d="M7 14.2h10l-1 6.3H8z"/><path d="M8.8 14.2c0-3.9 1.4-6.1 3.2-6.1s3.2 2.2 3.2 6.1"/><path d="M12 8.1V4.4"/><path d="M12 7c-1.8 0-2.9-1-2.9-2.9C11 4.1 12 5.1 12 7z"/><path d="M12 6c1.8 0 2.9-1 2.9-2.9C13 3.1 12 4.1 12 6z"/>',
  flower: '<circle cx="12" cy="8" r="2.5"/><circle cx="7.7" cy="11.2" r="2.5"/><circle cx="16.3" cy="11.2" r="2.5"/><circle cx="9.7" cy="15.8" r="2.5"/><circle cx="14.3" cy="15.8" r="2.5"/><circle cx="12" cy="12.4" r="1.3"/>',
  blossom: '<path d="M12 3.8c1.4 1.2 1.6 2.8 1 4.1 1.5-.4 3 .1 3.9 1.4-.9 1.5-2.4 2.1-3.9 1.8.9 1.2 1 2.8.2 4.1-1.4-.3-2.5-1.3-2.9-2.7-.6 1.3-1.9 2.2-3.4 2.2-.6-1.5-.2-3 .8-4-1.4.4-2.9 0-3.9-1.2 1-1.3 2.5-1.9 4-1.6-.8-1.2-.8-2.8.1-4 1.3.3 2.3 1.2 2.8 2.5.3-1.4 1.2-2.6 2.3-2.6z"/><circle cx="12" cy="12" r="1.1"/>',
  tulip: '<path d="M12 20v-8.5"/><path d="M8.6 6h6.8v3.3a3.4 3.4 0 0 1-6.8 0z"/><path d="M9.7 6V4.6M12 6V4M14.3 6V4.6M12 13.2c-2.4 0-4-1.5-4-3.8 1.5 0 2.8.7 3.5 1.9M12 14c2.4 0 4-1.5 4-3.8-1.5 0-2.8.7-3.5 1.9"/>',
  sunflower: '<path d="M12 20v-6.6"/><circle cx="12" cy="9" r="2.6"/><path d="M12 4.2v2.2M12 11.6v2.2M7.2 9h2.2M14.6 9h2.2M8.6 5.6l1.5 1.5M13.9 10.9l1.5 1.5M8.6 12.4l1.5-1.5M13.9 7.1l1.5-1.5"/>',
  bouquet: '<path d="M12 20v-6"/><path d="M8 8.6c0-1.8 1.5-3.2 3.2-3.2.5 0 1 .1 1.4.3.4-1 1.4-1.7 2.5-1.7 1.5 0 2.7 1.2 2.7 2.7 0 .6-.2 1.2-.6 1.7 1.1.4 1.8 1.4 1.8 2.6 0 1.5-1.2 2.7-2.7 2.7H9.3c-1.5 0-2.7-1.2-2.7-2.7 0-1.1.6-2 1.4-2.4z"/><path d="M10.4 13.5 12 20l1.6-6.5"/>',
  trophy: '<path d="M8 4.5h8v3.2c0 2.4-1.8 4.3-4 4.3s-4-1.9-4-4.3z"/><path d="M8 6H4.6v1.5a3 3 0 0 0 3 3M16 6h3.4v1.5a3 3 0 0 1-3 3"/><path d="M12 12v3.6M8.6 19.5h6.8"/>',
  medal: '<circle cx="12" cy="14.4" r="4.6"/><path d="M8.4 3.5l2 5.1M15.6 3.5l-2 5.1"/><path d="M12 12.6v3.6"/>',
  jersey: '<path d="M8.2 4.4 4.2 6.9l1.7 4 2.3-1V20h7.6V9.9l2.3 1 1.7-4-4-2.5c-.9 1.1-2.2 1.7-3.8 1.7s-2.9-.6-3.8-1.7z"/>',
  heart: '<path d="M12 20.2S4.4 15.7 4.4 10.6a4.3 4.3 0 0 1 7.6-2.7 4.3 4.3 0 0 1 7.6 2.7c0 5.1-7.6 9.6-7.6 9.6z"/>',

  /* 器械（名字与 cardio.js 的 key 一致） */
  treadmill: '<path d="M3.4 19h13.2"/><path d="M5 19 6.8 11.6h8.4l2.4 7.4"/><path d="M15.2 11.6 17.4 6.4h3.4"/><path d="M8.2 14.4h6.4M7.3 16.7h7.8"/>',
  incline_treadmill: '<path d="M3.4 19h13.2"/><path d="M5 19 6.8 11.6h8.4l2.4 7.4"/><path d="M15.2 11.6 17.4 6.4h3.4"/><path d="M8.2 14.4h6.4M7.3 16.7h7.8"/><path d="M5.6 8.8 8.2 5.4M8.2 5.4H5.7M8.2 5.4v2.5"/>',
  elliptical: '<ellipse cx="7.6" cy="17" rx="3.7" ry="1.9"/><ellipse cx="16.4" cy="17" rx="3.7" ry="1.9"/><path d="M5.6 5.2 8.6 15.2M18.4 5.2 15.4 15.2"/><path d="M8.6 10.6h6.8"/><path d="M12 10.6V5.2"/>',
  bike: '<circle cx="6.4" cy="16.6" r="3.4"/><circle cx="17.6" cy="16.6" r="3.4"/><path d="M6.4 16.6 10 9h4l3.6 7.6M10 9l2.6 7.6h4.6"/><path d="M13.6 5.8h2.6"/>',
  rower: '<path d="M4 18.6h16"/><circle cx="7.6" cy="15.4" r="1.6"/><path d="M11 15.4h3.8"/><path d="M14.8 15.4 18 10"/><path d="M5.6 9.2h5.2"/>',
  stair: '<path d="M3 19h4.2v-3.8h4.2v-3.8h4.2V7.6H20"/>',
  stepper: '<path d="M4 17.2h5l2-3.2M20 17.2h-5l-2-3.2"/><path d="M12 14V6.2"/><path d="M10 6.2h4"/>',
  jump_rope: '<path d="M7 6.2c-3.1 3.1-3.1 8.5 0 11.6M17 6.2c3.1 3.1 3.1 8.5 0 11.6"/><rect x="4.6" y="4.4" width="3.2" height="3.2" rx="1"/><rect x="16.2" y="4.4" width="3.2" height="3.2" rx="1"/>',
  bodyweight: '<circle cx="12" cy="5.4" r="2"/><path d="M12 7.8v5.4M12 9.8l4.2 3M12 9.8l-4.2 3M9 19.6l3-6.4 3 6.4"/>',
  mat: '<rect x="4" y="13.4" width="16" height="4.8" rx="2.4"/><path d="M7.4 13.4V9.2a2 2 0 0 1 4 0v4.2"/><circle cx="9.4" cy="10.6" r="1.4"/>',
  dumbbell: '<path d="M4 9.4v5.2M7 7.6v8.8M17 7.6v8.8M20 9.4v5.2M7 12h10"/>',
  kettlebell: '<path d="M9 9.2a3 3 0 0 1 6 0"/><path d="M8.2 9.4h7.6c2 1.8 3.2 4.3 3.2 6.6 0 2.3-3.1 4.1-7 4.1s-7-1.8-7-4.1c0-2.3 1.2-4.8 3.2-6.6z"/>',
  band: '<path d="M4.6 7.6c4 0 4 8.8 8 8.8s4-8.8 6.8-8.8"/><path d="M4.6 6v3.2M19.4 6v3.2"/>',
  cable: '<circle cx="7.2" cy="6" r="2"/><path d="M7.2 8v5.8"/><path d="M7.2 13.8 5 19.4"/><path d="M9.2 6h6l2.2 4"/><path d="M17.4 10v4.2"/>',
  machine: '<rect x="4.4" y="4.4" width="5.6" height="9.2" rx="1"/><path d="M4.4 7.4h5.6M4.4 10.4h5.6"/><path d="M10 6.6h5.2l2.8 3"/><path d="M18 9.6v6.8"/><path d="M15.4 16.4h5.2"/><path d="M7.2 13.6V20"/>',
  pool: '<path d="M3 15.8c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0"/><path d="M3 19.8c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0"/><path d="M7 13.4V6a2 2 0 0 1 4 0v7.4"/>',
  outdoor: '<path d="M12 3.8 7 10.6h10z"/><path d="M12 7.4 7.6 14.6h8.8z"/><path d="M12 14.6V20"/><path d="M4 20h16"/>',
  stairs_real: '<path d="M3 19h4.2v-3.8h4.2v-3.8h4.2V7.6H20"/><path d="M17.2 4.6v3M15.6 6l1.6 1.6L18.8 6"/>',
  court: '<circle cx="12" cy="12" r="7.6"/><path d="M4.4 12h15.2M12 4.4v15.2"/><path d="M7 7c2 2 2 8 0 10M17 7c-2 2-2 8 0 10"/>',
  studio: '<path d="M9.4 17V6.2l7.4-1.8v10.4"/><circle cx="7.2" cy="17.4" r="2.1"/><circle cx="14.6" cy="15.4" r="2.1"/>',

  _fallback: '<rect x="4.5" y="4.5" width="15" height="15" rx="3"/><path d="M9 9.6h6v4.8H9z"/>',
};

/* ── 徽章：柔和底色的圆形勋章 + 同名字形 ─────────
   tint 是底色，ink 是字形色。两者都按“暖、低饱和”选，跟界面色调一致。 */
const BADGE = {
  sprout: { glyph: 'tree', tint: '#EEF6F0', ink: '#4F8368' },
  leaf: { glyph: 'leaf', tint: '#EEF6F0', ink: '#4F8368' },
  pot: { glyph: 'pot', tint: '#F5F0E9', ink: '#8C6B4F' },
  sunflower: { glyph: 'sunflower', tint: '#FDF3E2', ink: '#B98432' },
  flame: { glyph: 'flame', tint: '#FBEAE2', ink: '#C2694B' },
  sparkle: { glyph: 'sparkles', tint: '#F6EFE3', ink: '#B08A45' },
  mountain: { glyph: 'mountain', tint: '#EDF2F4', ink: '#5C7D8A' },
  muscle: { glyph: 'dumbbell', tint: '#FBEDEF', ink: '#B4636F' },
  egg: { glyph: 'egg', tint: '#FDF6E7', ink: '#B58C3E' },
  protein: { glyph: 'protein', tint: '#F7EFE8', ink: '#9A6A4B' },
  run: { glyph: 'run', tint: '#FBEDEF', ink: '#B4636F' },
  jersey: { glyph: 'jersey', tint: '#EEF2F6', ink: '#5F7D99' },
  scale: { glyph: 'scale', tint: '#F2F0EA', ink: '#7A7264' },
  trend: { glyph: 'trend', tint: '#EEF6F0', ink: '#4F8368' },
  receipt: { glyph: 'receipt', tint: '#F5F0E9', ink: '#8C6B4F' },
  flower: { glyph: 'flower', tint: '#FBEDEF', ink: '#B4636F' },
  blossom: { glyph: 'blossom', tint: '#FBF0F3', ink: '#B4636F' },
  heart: { glyph: 'heart', tint: '#FBEDEF', ink: '#B4636F' },
  trophy: { glyph: 'trophy', tint: '#FDF3E2', ink: '#B98432' },
  medal: { glyph: 'medal', tint: '#FDF3E2', ink: '#B98432' },
  tulip: { glyph: 'tulip', tint: '#FBEDEF', ink: '#B4636F' },
  bouquet: { glyph: 'bouquet', tint: '#FBF0F3', ink: '#B4636F' },
};

/* ── 植物插画：2~3 色，承担情绪价值 ───────── */
const PLANT = {
  'plant-sprout': `
    <path d="M12 21v-7" stroke="#4F7A5E" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M12 14.2c-3.6.2-5.7-1.8-5.9-5 3.4-.3 5.7 1.7 5.9 5z" fill="#8FBF9E"/>
    <path d="M12 14.2c.2-3.2 2.3-5.2 5.7-5.2-.2 3.2-2.3 5.2-5.7 5.2z" fill="#6FA98B"/>
    <path d="M6.5 21h11" stroke="#C9A98F" stroke-width="1.6" stroke-linecap="round"/>`,
  'plant-leaf': `
    <path d="M12 21c0-6.2 3.1-10.2 8.2-10.2 0 6.1-3.6 9.7-8.2 10.2z" fill="#7FB292"/>
    <path d="M12 21c-4.6-.5-8.2-4.1-8.2-10.2 5.1 0 8.2 4 8.2 10.2z" fill="#A8CFB4"/>
    <path d="M12 21V9.4" stroke="#4F7A5E" stroke-width="1.4" stroke-linecap="round"/>`,
  'plant-pot': `
    <path d="M7 14.6h10l-1 6.4H8z" fill="#D3A27C"/>
    <path d="M7.6 14.6h8.8" stroke="#B07E56" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M8.6 14.6c0-4.1 1.5-6.2 3.4-6.2s3.4 2.1 3.4 6.2" fill="#8FBF9E"/>
    <path d="M12 8.4V4.6" stroke="#4F7A5E" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M12 7c-2 0-3-1-3-3 2 0 3 1 3 3z" fill="#6FA98B"/>
    <path d="M12 6c2 0 3-1 3-3-2 0-3 1-3 3z" fill="#A8CFB4"/>`,
  'plant-tulip': `
    <path d="M12 20.4v-9" stroke="#4F7A5E" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M12 14.2c-2.5 0-4.1-1.5-4.1-3.9 1.5 0 2.8.7 3.5 1.9" fill="#8FBF9E"/>
    <path d="M12 15c2.5 0 4.1-1.5 4.1-3.9-1.5 0-2.8.7-3.5 1.9" fill="#6FA98B"/>
    <path d="M8.4 6.2h7.2v3.4a3.6 3.6 0 0 1-7.2 0z" fill="#E39AA7"/>
    <path d="M9.6 6.2V4.6M12 6.2V4M14.4 6.2V4.6" stroke="#C97C8B" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M6 20.8h12" stroke="#C9A98F" stroke-width="1.5" stroke-linecap="round"/>`,
  'plant-sunflower': `
    <path d="M12 20.4v-7.2" stroke="#4F7A5E" stroke-width="1.5" stroke-linecap="round"/>
    <g fill="#E8B15C">
      <circle cx="12" cy="4" r="2.1"/><circle cx="12" cy="12.4" r="2.1"/>
      <circle cx="7.8" cy="6.1" r="2.1"/><circle cx="16.2" cy="6.1" r="2.1"/>
      <circle cx="7.8" cy="10.3" r="2.1"/><circle cx="16.2" cy="10.3" r="2.1"/>
    </g>
    <circle cx="12" cy="8.2" r="2.8" fill="#B98A4E"/>
    <path d="M12 14.6c-2.6 0-4.3-1.6-4.7-4.1 2.5.2 4.3 1.6 4.7 4.1z" fill="#8FBF9E"/>
    <path d="M12 16c2.6 0 4.3-1.6 4.7-4.1-2.5.2-4.3 1.6-4.7 4.1z" fill="#6FA98B"/>
    <path d="M6 20.8h12" stroke="#C9A98F" stroke-width="1.5" stroke-linecap="round"/>`,
  'plant-tree': `
    <path d="M12 21v-8.4" stroke="#8A6146" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="12" cy="7.8" r="6" fill="#8FBF9E"/>
    <circle cx="7.8" cy="10.8" r="4" fill="#6FA98B"/>
    <circle cx="16.2" cy="10.8" r="4" fill="#6FA98B"/>
    <path d="M5 21h14" stroke="#C9A98F" stroke-width="1.6" stroke-linecap="round"/>`,
};

/**
 * 取一个图标。
 *
 * @param {string} name 图标名（见 LINE / BADGE / PLANT）
 * @param {{size?:number, cls?:string, label?:string}} opts
 *   label 为空时按「装饰性」处理（aria-hidden），读屏不会念图标；
 *   传了 label 就当有含义的图（role="img" + aria-label）。
 */
export function icon(name, { size = 18, cls = '', label = '' } = {}) {
  const key = String(name || '');
  const badgeKey = key.startsWith('badge-') ? key.slice(6) : key;
  let body;
  let kind;
  if (PLANT[key]) { body = PLANT[key]; kind = 'plant'; }
  else if (BADGE[badgeKey]) {
    const b = BADGE[badgeKey];
    body = `
      <circle cx="12" cy="12" r="10.4" fill="${b.tint}"/>
      <circle cx="12" cy="12" r="9.1" fill="none" stroke="${b.ink}" stroke-width=".7" opacity=".26"/>
      <g transform="translate(12 12) scale(.6) translate(-12 -12)" fill="none" stroke="${b.ink}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${LINE[b.glyph] || LINE._fallback}</g>`;
    kind = 'badge';
  } else {
    body = LINE[key] || LINE._fallback;
    kind = LINE[key] ? 'line' : 'fallback';
  }
  const a11y = label
    ? `role="img" aria-label="${attr(label)}"`
    : 'aria-hidden="true"';
  const klass = `icon${cls ? ` ${cls}` : ''}`;
  // 线性图标把描边放在根上，字形里只写 path —— 漏了这一句，图标就是「透明的」，
  // 页面上只剩布局占位（真机上表现为「设置行前面空了一块」）。
  const stroke = kind === 'line' || kind === 'fallback'
    ? ' stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
    : '';
  return `<svg class="${klass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"${stroke} ${a11y} focusable="false" data-icon="${attr(key || 'none')}" data-kind="${kind}">${body}</svg>`;
}

/** 名字是不是真的有对应图标（未知名字会走兜底方块） */
export function hasIcon(name) {
  const key = String(name || '');
  const badgeKey = key.startsWith('badge-') ? key.slice(6) : key;
  return Boolean(LINE[key] || BADGE[badgeKey] || PLANT[key]);
}

/** 所有可用的图标名（测试与自检用） */
export function iconNames() {
  return {
    line: Object.keys(LINE).filter((k) => !k.startsWith('_')),
    badge: Object.keys(BADGE).map((k) => `badge-${k}`),
    plant: Object.keys(PLANT),
  };
}
