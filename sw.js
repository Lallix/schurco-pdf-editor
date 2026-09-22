const CACHE = 'schurco-pdf-editor-v4';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/state.js',
  './js/pdf-engine.js',
  './js/file-io.js',
  './js/ui/toolbar.js',
  './js/ui/sidebar.js',
  './js/ui/canvas.js',
  './js/ui/properties-panel.js',
  './js/ui/modals.js',
  './js/vendor/pdf.min.mjs',
  './js/vendor/pdf.worker.min.mjs',
  './js/vendor/pdf-lib.esm.min.js',
  './js/vendor/tesseract/tesseract.esm.min.js',
  './js/vendor/tesseract/worker.min.js',
  './js/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  './js/vendor/tesseract/lang-data/eng.traineddata.gz',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept cross-origin calls — let them fail naturally offline
  // so the app receives a proper network error, not an HTML fallback
  if (url.hostname !== self.location.hostname) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).catch(() => {
        if (e.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
