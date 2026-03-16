// ══════════════════════════════════════════════════════════
//  TeraSwap Service Worker
//
//  Strategy: Network-first for API/data, Cache-first for assets.
//  DeFi apps MUST always show fresh prices — never serve stale quotes.
//  We only cache static assets (fonts, icons, CSS, JS bundles).
// ══════════════════════════════════════════════════════════

const CACHE_NAME = 'teraswap-v1'

// Static assets to pre-cache on install
const PRECACHE_ASSETS = [
  '/',
  '/manifest.json',
  '/favicon.ico',
  '/favicon.svg',
  '/apple-touch-icon.png',
]

// ── Install: pre-cache shell ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS)
    })
  )
  // Activate immediately — don't wait for old SW to die
  self.skipWaiting()
})

// ── Activate: clean old caches ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    })
  )
  // Take control of all open tabs immediately
  self.clients.claim()
})

// ── Fetch: route requests ──
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // NEVER cache API requests — DeFi data must always be fresh
  if (
    url.pathname.startsWith('/api/') ||
    request.method !== 'GET' ||
    url.protocol !== 'https:'
  ) {
    return // Let the browser handle it normally (network only)
  }

  // Cache-first for static assets (fonts, images, JS/CSS bundles)
  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/sounds/') ||
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.woff') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico')
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached
        return fetch(request).then((response) => {
          // Only cache successful responses
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
          }
          return response
        })
      })
    )
    return
  }

  // Network-first for HTML pages (always show latest UI)
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache the latest version for offline fallback
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
        }
        return response
      })
      .catch(() => {
        // Offline fallback: serve cached version
        return caches.match(request).then((cached) => {
          return cached || caches.match('/')
        })
      })
  )
})
