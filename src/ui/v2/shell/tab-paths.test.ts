/**
 * @vitest-environment node
 *
 * [ADR-025] The 8 tab paths are the single list shared by the shell and (C3) the proxy rule.
 */
import { describe, expect, it } from 'vitest'
import { V2_TABS, V2_TAB_PATHS, tabIdFromPathname } from './tab-paths'

describe('v2 tabs', () => {
  it('are exactly the 8 pack tabs, in pack order, with their labels', () => {
    expect(V2_TABS.map((t) => t.label)).toEqual(['Swap', 'Portfolio', 'DCA', 'Limit', 'SL/TP', 'Orders', 'History', 'Analytics'])
    expect(V2_TAB_PATHS).toEqual(['/swap', '/portfolio', '/dca', '/limit', '/sltp', '/orders', '/history', '/analytics'])
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
