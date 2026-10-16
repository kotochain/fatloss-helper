/* 离线缓存：装到手机主屏幕后，没有网络也能打开。
 * 改动文件后把 CACHE 的版本号加一，手机上刷新一次就会拿到新版本。 */

const CACHE = 'fatloss-v5';
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
  './js/recommend.js',
  './js/store.js',
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
  // 先给缓存，保证打开快；没有缓存再走网络
  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html'))),
  );
});
