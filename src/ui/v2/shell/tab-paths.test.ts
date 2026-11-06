/**
 * @vitest-environment node
 *
 * [ADR-025] The 8 tab paths are the single list shared by the shell and (C3) the proxy rule.
 */
import { describe, expect, it } from 'vitest'
import { V2_TABS, V2_TAB_PATHS, V2_ONLY_TAB_PATHS, tabIdFromPathname } from './tab-paths'

describe('v2 tabs', () => {
  it('are exactly the 8 pack tabs, in pack order, with their labels', () => {
    expect(V2_TABS.map((t) => t.label)).toEqual(['Swap', 'Portfolio', 'DCA', 'Limit', 'SL/TP', 'Orders', 'History', 'Analytics'])
    expect(V2_TAB_PATHS).toEqual(['/swap', '/portfolio', '/dca', '/limit', '/sltp', '/orders', '/history', '/analytics'])
  })

  // [L-5, A75] Swap and Analytics are real v1 pages (src/app/swap, src/app/analytics) — with v2 off, those two
  // URLs stay untouched and v1 renders its own page. The other 6 have no v1 page at all: proxy.ts redirects them
  // to `/` under v1 rather than falling through to Next's generic 404.
  it('V2_ONLY_TAB_PATHS: the 6 tabs with no v1 page of their own — everything but Swap and Analytics', () => {
    expect(V2_ONLY_TAB_PATHS).toEqual(['/portfolio', '/dca', '/limit', '/sltp', '/orders', '/history'])
    expect(V2_TAB_PATHS.filter((p) => !V2_ONLY_TAB_PATHS.includes(p))).toEqual(['/swap', '/analytics'])
  })

  it.each([
    ['/portfolio', 'portfolio'],
    ['/v2/portfolio', 'portfolio'],
    ['/v2/sltp/', 'sltp'],
    ['/', 'swap'],
    ['/v2', 'swap'],
    ['/nope', 'swap'],
    [null, 'swap'],
  ])('tabIdFromPathname(%s) → %s', (path, id) => {
    expect(tabIdFromPathname(path)).toBe(id)
  })
})
