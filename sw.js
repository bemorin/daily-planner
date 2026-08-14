const CACHE = 'daily-planner-v51-r1';
const CORE = [
  './', './index.html', './styles.css', './runtime-config.js', './app.js', './manifest.webmanifest',
  './favicon.svg', './favicon.ico', './apple-touch-icon.png', './pwa-192.png', './pwa-512.png',
  './src/config.js', './src/domain/note-lines.js', './src/domain/planning-calendar.js', './src/domain/schedule-time.js', './src/lib/dom.js', './src/lib/dates.js', './src/lib/text.js', './src/lib/utils.js',
  './src/features/fit.js', './src/features/horizon-model.js', './src/features/pip-styles.js', './src/features/print.js', './src/features/search.js', './src/features/stats.js', './src/features/week-review.js', './src/features/week.js',
  './src/state/local-store.js', './src/state/day-state.js', './src/state/settings-state.js', './src/ui/calendar-popover.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') return caches.match('./index.html');
      throw new Error('Offline and not cached');
    })
  );
});
