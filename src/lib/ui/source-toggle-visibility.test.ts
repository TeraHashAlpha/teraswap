/**
 * [SPRINT-9F bug5] The Liquidity Sources selector used to render only when
 * `meta.all.length > 1`. Excluding sources down to a single one made the quote
 * collapse to one source, the toggle disappeared, and the user was trapped —
 * the only escape was remounting (switching tabs). The selector must stay
 * reachable whenever the user has excluded anything, regardless of how many
 * quotes currently come back, so they can always re-enable sources.
 */
import { describe, it, expect } from 'vitest'
import { shouldShowSourceToggle } from './source-toggle-visibility'

describe('shouldShowSourceToggle [SPRINT-9F bug5]', () => {
  it('shows when multiple sources are quoted and nothing is excluded (mainnet default)', () => {
    expect(shouldShowSourceToggle(5, 0)).toBe(true)
  })

  it('hides when a single source is quoted and nothing is excluded (byte-identical to old behaviour)', () => {
    expect(shouldShowSourceToggle(1, 0)).toBe(false)
  })

  it('hides when there is no quote yet and nothing is excluded', () => {
    expect(shouldShowSourceToggle(null, 0)).toBe(false)
  })

  it('STAYS visible when the user has excluded sources down to one quote (the trap fix)', () => {
    expect(shouldShowSourceToggle(1, 3)).toBe(true)
  })

  it('STAYS visible when exclusions leave no quote at all (escape even from "no valid quotes")', () => {
    expect(shouldShowSourceToggle(null, 11)).toBe(true)
  })
})
