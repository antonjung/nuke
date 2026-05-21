'use strict';

const CACHE = 'nuke-v2.4.1'; // bump this whenever VERSION in app.js changes
const ASSETS = [
  './index.html',
  './styles.css',
  './app.js',
  './game3d.js',
  './manifest.json',
  './icons/icon.svg',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
