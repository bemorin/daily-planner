const CACHE = 'daily-planner-1.26.0';
const CORE = [
  './', './index.html', './styles.css', './runtime-config.js', './app.js', './manifest.webmanifest',
  './favicon.svg', './favicon.ico', './apple-touch-icon.png', './pwa-192.png', './pwa-512.png',
  './src/config.js', './src/domain/note-lines.js', './src/domain/planning-calendar.js', './src/domain/schedule-time.js', './src/lib/dom.js', './src/lib/dates.js', './src/lib/text.js', './src/lib/utils.js',
  './src/features/day-swipe.js', './src/features/fit.js', './src/features/horizon-model.js', './src/features/horizon-view.js', './src/features/pip-date-picker.js', './src/features/pip-styles.js', './src/features/pip-window.js', './src/features/print.js', './src/features/search.js', './src/features/settings-schedule.js', './src/features/stats.js', './src/features/week-review.js', './src/features/week.js', './src/features/workspace.js', './src/features/personal-sync.js',
  './src/features/progress-model.js', './src/features/progress-view.js', './src/features/onboarding.js', './src/features/install.js', './src/features/sync-guide.js', './src/features/feedback.js', './src/features/privacy.js', './src/features/category-manager.js', './src/features/year-print.js', './src/features/year-plan.js', './src/features/year-review.js', './src/features/quarter-review.js', './src/features/quarter-session.js', './src/features/quarter-print.js', './src/features/paint-palettes.js', './src/features/plus-dialog.js', './src/features/plus-check.js', './src/features/plus-previews.js', './src/features/plus-cycle.js', './src/features/plus-samples.js', './src/features/plus-insights.js', './src/features/whats-new.js', './src/features/tour.js', './src/features/tour-model.js', './src/features/day-summary.js', './src/features/view-switch.js', './src/features/week-agenda.js', './src/features/share-image.js', './src/features/share-dialog.js', './src/features/insights.js', './src/features/insights-model.js', './src/features/insights-view.js', './src/features/insights-sample.js', './src/lib/plus.js', './src/lib/planner-api.js', './src/lib/pricing.js',
  './src/state/local-store.js', './src/state/day-state.js', './src/state/settings-state.js', './src/state/planner-backup.js', './src/sync/document.js', './src/sync/engine.js', './src/sync/google-drive.js', './src/sync/hash.js', './src/sync/ledger.js', './src/sync/merge.js', './src/sync/records.js', './src/sync/recovery-store.js', './src/sync/scheduler.js', './src/ui/calendar-popover.js', './src/ui/listbox.js', './src/ui/motion.js', './src/ui/theme.js', './src/ui/tooltip.js', './src/vendor/motion.js'
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
  // API responses (feedback, waitlist, owner dashboard) are never cached.
  if (url.pathname.includes('/api/') || url.pathname.includes('/admin/')) return;

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
