/* 离线兜底：装到手机主屏幕后，没有网络也能打开。
 *
 * ── 缓存策略（v46 改）：**网络优先** ──────────────────────────────────
 * 每次打开都先问服务器要最新的一份，拿到了就用、顺手存进缓存；
 * 拿不到（断网 / 超时）才用上次存下的。
 *
 * 以前是「先用缓存 + 后台更新」（stale-while-revalidate）：打开永远快，
 * 但**打开的必然是上一次的旧版本**，新版本要「再打开一次」才进来。
 * 用户实际体验就是「新开网页还是上次那版，得手动刷新」—— 这个不该让用户自己解决。
 *
 * 换成网络优先后：打开就是最新版；弱网/断网时靠下面的超时兜底，不会白屏。
 *
 * 改动文件后把 CACHE 的版本号加一。
 */

const CACHE = 'fatloss-v50';
// 版本号同时给页面用（排查「用户手机上到底是哪一版」时，一眼就能看到）
const APP_VERSION = 'v50';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/calc.js',
  './js/foods.js',
  './js/dishes.js',
  './js/foodlog.js',
  './js/exercise.js',
  './js/cardio.js',
  './js/mealparse.js',
  './js/ai.js',
  './js/ai-core.js',
  './js/ai-config.js',
  './js/label.js',
  './js/providers.js',
  './js/achievements.js',
  './js/recommend.js',
  './js/nextsteps.js',
  './js/recap.js',
  './js/update.js',
  './js/store.js',
  './js/schema.js',
  './js/insights.js',
  './js/icons.js',
  './js/coach.js',
  './js/version.js',
  './js/whatsnew.js',
  './icons/icon.svg',
  // 桌面图标也进缓存：manifest 在离线时也要能拿到图标，不然装到桌面后图标可能空一块
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

/*
 * 等网络最多等这么久，超过就用缓存。
 * 不能无限等：国内连 GitHub Pages 有时会慢到几秒，让用户对着白屏干等更糟；
 * 也不能太短：太短会在正常网速下也退回旧缓存，等于白改。
 * 2 秒是折中：正常网络 1 秒内能回来，只有真的连不上/极慢时才会走到缓存。
 */
const NETWORK_TIMEOUT = 2000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/*
 * 页面上的「刷新就能用上新版」按钮会发这条消息。
 * 正常情况下新版本安装时已经 skipWaiting 接管了，这条是双层保险：
 * 万一某些浏览器里新 SW 停在 waiting，收到消息也立刻接管。
 */
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

/**
 * 网络优先：先要新的，拿不到再用缓存。
 *
 * `cache: 'no-cache'` 不能省：GitHub Pages 给所有静态文件都发
 * `cache-control: max-age=600`，浏览器自己的 HTTP 缓存会直接把 10 分钟前那份还给你，
 * 于是「网络优先」实际拿到的还是旧的。带上它 = 每次都跟服务器核对一次
 * （有 ETag，内容没变时是 304，很快），保证拿到的是真的最新。
 */
/**
 * 重建一个「一定回源核对」的请求。
 *
 * `cache: 'no-cache'` 不能省：GitHub Pages 给所有静态文件都发
 * `cache-control: max-age=600`，浏览器自己的 HTTP 缓存会直接把 10 分钟前那份还给你，
 * 于是「网络优先」实际拿到的还是旧的。带上它 = 每次都跟服务器核对一次
 * （有 ETag，内容没变时是 304，很快），保证拿到的是真的最新。
 *
 * 为什么要 try/catch：打开页面那一下是「导航请求」（mode === 'navigate'），
 * 个别浏览器不允许用构造器重建这种请求。失败就用 URL 重建 ——
 * 这里全是同源 GET 静态资源，不需要 body 和自定义头，重建是安全的。
 */
function freshRequest(request) {
  try {
    return new Request(request, { cache: 'no-cache' });
  } catch {
    return new Request(request.url, {
      cache: 'no-cache',
      credentials: request.credentials,
      mode: request.mode === 'navigate' ? 'same-origin' : request.mode,
    });
  }
}

async function networkFirst(request, e) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);

  // 已经知道断网：不用等超时，直接给缓存
  if (!navigator.onLine && hit) return hit;

  const fresh = fetch(freshRequest(request)).then((res) => {
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  });

  // 没有缓存（第一次打开、或新文件）：只能等网络，失败就给离线首页
  if (!hit) {
    try {
      return await fresh;
    } catch {
      return (await caches.match('./index.html')) || Response.error();
    }
  }

  // 有缓存：和超时赛跑，谁先到用谁
  let timer = 0;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT); });
  const winner = await Promise.race([fresh.catch(() => null), timeout]);
  clearTimeout(timer);
  if (winner) return winner;

  // 超时/失败：先把缓存给用户，网络请求继续在后台跑完（下一次打开就是新的）
  e.waitUntil(fresh.catch(() => {}));
  return hit;
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  // 接口请求（/api/）绝对不能走缓存：设置页读的是「当前配置」，
  // 一旦被缓存，改完设置刷新还是旧状态（这个坑真踩过）。
  if (new URL(request.url).pathname.startsWith('/api/')) return;
  // sw.js 本身也绝不走缓存：页面靠它判断「服务端有没有新版本」，
  // 被缓存就会一直读到旧版本号（而且每次还会往缓存里塞一份）。
  if (new URL(request.url).pathname.endsWith('/sw.js')) return;
  e.respondWith(networkFirst(request, e));
});
