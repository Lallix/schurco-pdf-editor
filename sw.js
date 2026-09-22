const CACHE = 'schurco-pdf-editor-v6';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/state.js',
  './js/pdf-engine.js',
  './js/file-io.js',
  './js/export-formats.js',
  './js/ui/toolbar.js',
  './js/ui/sidebar.js',
  './js/ui/canvas.js',
  './js/ui/properties-panel.js',
  './js/ui/modals.js',
  './js/vendor/pdf.min.mjs',
  './js/vendor/pdf.worker.min.mjs',
  './js/vendor/pdf-lib.esm.min.js',
  './js/vendor/docx.esm.js',
  './js/vendor/xlsx.esm.mjs',
  // WASM image/colour decoders — required for pdf.js to correctly render
  // some scanned PDFs (e.g. a JBIG2-masked image renders washed-out
  // without jbig2.wasm), so these are precached rather than left to
  // runtime caching below.
  './js/vendor/pdfjs-data/wasm/jbig2.wasm',
  './js/vendor/pdfjs-data/wasm/openjpeg.wasm',
  './js/vendor/pdfjs-data/wasm/qcms_bg.wasm',
  './js/vendor/tesseract/tesseract.esm.min.js',
  './js/vendor/tesseract/worker.min.js',
  './js/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  './js/vendor/tesseract/lang-data/eng.traineddata.gz',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// pdf.js's character maps (cmaps/) and non-embedded standard fonts
// (standard_fonts/) are ~190 small files fetched only for the specific
// glyphs a given PDF actually needs — not worth precaching all of, but
// still cached the first time each is used so offline viewing of a
// previously-opened PDF keeps working.
const RUNTIME_CACHE_PREFIX = './js/vendor/pdfjs-data/';

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
      return fetch(e.request).then(response => {
        if (response.ok && url.pathname.includes(RUNTIME_CACHE_PREFIX.slice(1))) {
          const copy = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return response;
      }).catch(() => {
        if (e.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
