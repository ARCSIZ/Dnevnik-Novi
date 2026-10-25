/* ==========================================================================
   sw.js — Service Worker «Колледж·ID»
   --------------------------------------------------------------------------
   Делает сайт устанавливаемым приложением (PWA) и ускоряет загрузку:

   • Статика (HTML/CSS/JS/иконки) — стратегия «сеть, затем кэш»:
     всегда свежая версия, но при обрыве связи открывается из кэша.
   • API (/api/...) — только сеть: данные журнала и чата не кэшируются,
     чтобы пользователь никогда не видел устаревшие оценки.
   • Офлайн-страница — если сети нет и страницы нет в кэше.

   Версию CACHE меняем при обновлении — старые кэши удаляются сами.
   ========================================================================== */

const CACHE = 'college-id-v1';

const PRECACHE = [
  '/',
  '/index.html',
  '/General/authorization.html',
  '/General/work.html',
  '/General/notice.js',
  '/General/perf.js',
  '/Students/diary.html',
  '/Students/support.html',
  '/Students/rating.html',
  '/Students/journal.html',
  '/Faculty/journal.html',
  '/Faculty/support-desk.html',
  '/Dev/panel.html',
  '/Data/users.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

/* страница-заглушка при отсутствии сети */
const OFFLINE_HTML = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Нет сети — Колледж·ID</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#07070d;color:#fff;font-family:system-ui,-apple-system,sans-serif;padding:24px;text-align:center}
.b{max-width:380px}.i{width:72px;height:72px;margin:0 auto 20px;border-radius:22px;
background:linear-gradient(135deg,#6366f1,#a855f7);display:flex;align-items:center;justify-content:center;font-size:32px}
h1{font-size:21px;margin:0 0 10px}p{color:rgba(255,255,255,.5);font-size:14px;line-height:1.6;margin:0 0 22px}
button{padding:13px 26px;border:0;border-radius:14px;font-size:14px;font-weight:700;color:#fff;cursor:pointer;
background:linear-gradient(120deg,#6366f1,#a855f7)}</style></head>
<body><div class="b"><div class="i">📡</div><h1>Нет подключения</h1>
<p>Проверьте интернет — приложение Колледж·ID продолжит работу сразу после восстановления связи.</p>
<button onclick="location.reload()">Повторить</button></div></body></html>`;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE).catch(() => { /* часть файлов может отсутствовать */ }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // внешние CDN не трогаем

  /* API и служебные данные — всегда из сети */
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    event.respondWith(fetch(req).catch(() =>
      new Response(JSON.stringify({ error: 'offline' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  /* статика: сеть → кэш → офлайн-страница */
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => {
        if (hit) return hit;
        if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
          return new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        return new Response('', { status: 504 });
      }))
  );
});
