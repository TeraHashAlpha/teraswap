/**
 * [L-7, A75] public/sw.js's fetch handler, loaded and evaluated as real text (not reimplemented) so a change to
 * the shipped file is what this test actually exercises. The final branch ("network-first for HTML pages") used
 * to call event.respondWith for EVERY remaining GET request, including a cross-origin one — e.g. the direct
 * public-RPC reads the app makes from the browser for Base/Arbitrum (only mainnet goes through /api/rpc, per
 * docs/feedback/feat-ui-v2-mobile-parity.md's residual note). A failed cross-origin fetch then fell back to
 * `caches.match('/')`, silently substituting the cached HTML shell for an RPC response. It must only handle
 * same-origin navigations; everything else reaching this point is left to the browser (no respondWith at all).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const SRC = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8')
const ORIGIN = 'https://www.teraswap.app'

function loadSw() {
  const listeners: Record<string, (event: unknown) => void> = {}
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn
    },
    skipWaiting: () => {},
    clients: { claim: () => {} },
    location: new URL(ORIGIN),
  }
  const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) }
  const caches = {
    open: vi.fn(async () => cache),
    match: vi.fn(async () => undefined),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  }
  // Evaluating the real shipped sw.js text (static repo content, read from disk at test time) — not reimplementing
  // its logic, and not interpreting any untrusted/external input.
  const fn = new Function('self', 'caches', 'fetch', SRC)
  fn(self, caches, vi.fn(async () => new Response('ok', { status: 200 })))
  return listeners
}

function fetchEvent(url: string, init: { method?: string; mode?: string } = {}) {
  return { request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'navigate' }, respondWith: vi.fn() }
}

describe('sw.js fetch handler: same-origin navigations only (the final branch)', () => {
  it('a same-origin navigation GET IS handled', () => {
    const { fetch: onFetch } = loadSw()
    const event = fetchEvent(`${ORIGIN}/swap`, { mode: 'navigate' })
    onFetch(event)
    expect(event.respondWith).toHaveBeenCalledTimes(1)
  })

  it('a CROSS-ORIGIN GET (e.g. a direct public-RPC read) is left to the browser — never respondWith', () => {
    const { fetch: onFetch } = loadSw()
    const event = fetchEvent('https://mainnet.base.org/', { mode: 'cors' })
    onFetch(event)
    expect(event.respondWith).not.toHaveBeenCalled()
  })

  it('a same-origin NON-navigation GET (e.g. a same-origin fetch() call) is left to the browser too', () => {
    const { fetch: onFetch } = loadSw()
    const event = fetchEvent(`${ORIGIN}/some-data.json`, { mode: 'cors' })
    onFetch(event)
    expect(event.respondWith).not.toHaveBeenCalled()
  })
})

// [S-2, A75b] The cache-first ASSET branch (above the navigation branch) matched on pathname alone, so it also answered
// cross-origin requests: a token logo `https://tokens.1inch.io/0x…png`, a CDN `.svg` / `.woff2`, or ANY origin's `/_next/static/…`.
// Its fetch then ran under the worker's connect-src (which omits those hosts), failed, and the catch synthesised a 504 for an
// image the page itself was allowed to load. Scope: same-origin requests only; everything else is the browser's.
describe('sw.js fetch handler: the cache-first asset branch is same-origin only', () => {
  it.each([
    ['a token-logo .png', 'https://tokens.1inch.io/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.png'],
    ['a CDN .svg', 'https://cdn.example.com/logo.svg'],
    ['a CDN .ico', 'https://cdn.example.com/favicon.ico'],
    ['a CDN .woff2 font', 'https://fonts.example.com/inter.woff2'],
    ['a CDN .woff font', 'https://fonts.example.com/inter.woff'],
    ["another origin's /_next/static/ path", 'https://evil.example.com/_next/static/chunks/main.js'],
    ["another origin's /icons/ path", 'https://cdn.example.com/icons/eth.webp'],
    ["another origin's /sounds/ path", 'https://cdn.example.com/sounds/click.mp3'],
  ])('%s is left to the browser — never respondWith', (_n, url) => {
    const { fetch: onFetch } = loadSw()
    const event = fetchEvent(url, { mode: 'no-cors' })
    onFetch(event)
    expect(event.respondWith).not.toHaveBeenCalled()
  })

  it.each([
    ['/_next/static/chunks/main.js'],
    ['/icons/eth.png'],
    ['/sounds/click.mp3'],
    ['/fonts/clash.woff2'],
    ['/logo.svg'],
  ])('same-origin %s is still served cache-first', (path) => {
    const { fetch: onFetch } = loadSw()
    const event = fetchEvent(`${ORIGIN}${path}`, { mode: 'no-cors' })
    onFetch(event)
    expect(event.respondWith).toHaveBeenCalledTimes(1)
  })
})
