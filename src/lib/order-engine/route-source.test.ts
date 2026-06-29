/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] Committed-router → aggregator-source mapping for the route badge,
 * shared with the analytics route (#228). A Base DCA order routes through Augustus V6 → "Velora".
 */

import { describe, it, expect } from 'vitest'
import { sourceForRouter, routeLabel } from './route-source'

const AUGUSTUS_V6_BASE = '0x6A000F20005980200259B80c5102003040001068' // checksummed
const UNI_SWAPROUTER02_BASE = '0x2626664c2603336E57B271c5C0b26F421741e481'

describe('sourceForRouter', () => {
  it('maps the Base Augustus V6 router to velora', () => {
    expect(sourceForRouter(AUGUSTUS_V6_BASE)).toBe('velora')
  })
  it('is address-case-insensitive', () => {
    expect(sourceForRouter(AUGUSTUS_V6_BASE.toLowerCase())).toBe('velora')
    expect(sourceForRouter(AUGUSTUS_V6_BASE.toUpperCase())).toBe('velora')
  })
  it('maps Uniswap SwapRouter02 to uniswapv3', () => {
    expect(sourceForRouter(UNI_SWAPROUTER02_BASE)).toBe('uniswapv3')
  })
  it('returns null for an unknown router', () => {
    expect(sourceForRouter('0x0000000000000000000000000000000000000000')).toBeNull()
  })
})

describe('routeLabel', () => {
  it('renders a friendly label for the route badge', () => {
    expect(routeLabel(AUGUSTUS_V6_BASE)).toBe('Velora')
    expect(routeLabel(UNI_SWAPROUTER02_BASE)).toBe('Uniswap V3')
  })
  it('falls back to a generic label for an unknown router (never blank)', () => {
    expect(routeLabel('0x0000000000000000000000000000000000000000')).toBe('Aggregated')
  })
})
