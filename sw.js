/* 离线缓存：装到手机主屏幕后，没有网络也能打开。
 * 改动文件后把 CACHE 的版本号加一，手机上刷新一次就会拿到新版本。 */

const CACHE = 'fatloss-v23';
// 版本号同时给页面用（排查「她手机上到底是哪一版」时，一眼就能看到）
const APP_VERSION = 'v23';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/calc.js',
  './js/foods.js',
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
  './js/store.js',
  './js/schema.js',
  './js/insights.js',
  './js/coach.js',
  './icons/icon.svg',
  // 桌面图标也进缓存：manifest 在离线时也要能拿到图标，不然装到桌面后图标可能空一块
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

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

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  // 接口请求（/api/）绝对不能走缓存：设置页读的是「当前配置」，
  // 一旦被缓存，改完设置刷新还是旧状态（这个坑真踩过）。
  if (new URL(request.url).pathname.startsWith('/api/')) return;
  /*
   * 策略：**先用缓存（打开快）+ 后台拉一份新的存起来**（stale-while-revalidate）。
   *
   * 这里以前是「缓存优先」——命中缓存就永远返回它，网络请求都不发。
   * 后果很严重：她手机上可能一直卡在某一版代码上，新版本永远进不来。
   * 用户实际遇到的就是这个：手机上白屏/点不动，让她刷新也没用，
   * 因为 Service Worker 每次都把那套坏的缓存还给她。
   *
   * 换成 stale-while-revalidate 之后：每次打开都用当前缓存（不慢），
   * 同时后台把最新版存下来，**下一次打开就是新的**。最多旧一次，不会一直旧。
   */
  e.respondWith(
    caches.match(request).then((hit) => {
      const fromNetwork = fetch(request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => null);

      if (hit) {
        // 命中缓存：立刻返回，同时让上面的网络请求在后台跑完
        e.waitUntil(fromNetwork);
        return hit;
      }
      // 没有缓存（第一次打开、或新文件）：等网络
      return fromNetwork.then((res) => res || caches.match('./index.html'));
    }),
  );
});
