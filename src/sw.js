// Service worker: застосунок працює офлайн після першого відкриття з інтернетом.
// Список файлів сайту з хешами вмісту підставляє build.mjs (FILES). Кожен файл зберігається в кеші
// під ключем «адреса?rev=хеш»: при новій версії завантажуються лише змінені файли, тож модуль DWG
// (≈ 9,5 МБ) не завантажується повторно, доки не зміниться.
const FILES = self.__FILES__; // { 'index.html': 'хеш', 'dwg/libredwg-web.wasm': 'хеш', … }
const CACHE = 'cpz-viewer';

const base = self.registration.scope; // https://…/cpz-3d-viewer/
const keyOf = (path) => `${new URL(path, base).href}?rev=${FILES[path]}`;

// Шлях файлу відносно сайту для запиту; навігація (відкриття сторінки) — це index.html
function pathOf(request) {
  const url = new URL(request.url);
  if (url.origin !== location.origin || !url.href.startsWith(base)) return null;
  if (request.mode === 'navigate') return 'index.html';
  const path = url.pathname.slice(new URL(base).pathname.length) || 'index.html';
  return path in FILES ? path : null;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const path of Object.keys(FILES)) {
      const key = keyOf(path);
      if (await cache.match(key)) continue; // файл не змінився — вже збережено
      const res = await fetch(new URL(path, base), { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      await cache.put(key, res);
    }
    // Нова версія вмикається одразу; сторінка, що вже відкрита, отримає її при наступному запуску
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const keep = new Set(Object.keys(FILES).map(keyOf));
    for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const path = pathOf(event.request);
  if (!path) return;
  event.respondWith((async () => {
    const hit = await caches.match(keyOf(path), { cacheName: CACHE });
    return hit || fetch(event.request);
  })());
});
