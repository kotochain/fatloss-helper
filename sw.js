/* 离线缓存：装到手机主屏幕后，没有网络也能打开。
 * 改动文件后把 CACHE 的版本号加一，手机上刷新一次就会拿到新版本。 */

const CACHE = 'fatloss-v10';
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
  './js/providers.js',
  './js/achievements.js',
  './js/recommend.js',
  './js/store.js',
  './js/schema.js',
  './icons/icon.svg',
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
  // 静态文件先给缓存，保证打开快；没有缓存再走网络
  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html'))),
  );
});
