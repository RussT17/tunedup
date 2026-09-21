// Cache-first for the shell, so the tuner opens instantly and works with no
// network at all. The version string is the cache key: bump it and every old
// asset is dropped on the next activation.
const VERSION = 'tunedup-v3';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './src/capture-worklet.js', './src/worker.js',
  './src/dsp/engine.js', './src/dsp/fft.js', './src/dsp/window.js', './src/dsp/ring.js',
  './src/dsp/room.js', './src/dsp/acquire.js', './src/dsp/partials.js', './src/dsp/fit.js',
  './src/dsp/glide.js', './src/dsp/gates.js', './src/dsp/settle.js', './src/dsp/notes.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
      if (res.ok && new URL(event.request.url).origin === self.location.origin) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(event.request, copy));
      }
      return res;
    }).catch(() => hit)),
  );
});
