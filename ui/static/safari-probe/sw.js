// Copyright 2026 The Swarm Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Keeps the probe iframe loadable offline: cache-first for its own files,
// matched without the query string the embedding page adds to bust caches.
const CACHE = 'safari-probe-v1'
const FILES = ['frame.html', 'common.js']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches
      .match(event.request, { ignoreSearch: true })
      .then((cached) => cached ?? fetch(event.request)),
  )
})
