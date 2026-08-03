/**
 * [SPRINT-DCA-UNGATE, generalized SPRINT-48-ARBITRUM-DCA-PREP] DCA launch-flag + chain
 * allowlist gating.
 *
 * Pins the launch flag semantics (NEXT_PUBLIC_DCA_ENABLED, default OFF, only
 * the literal "true" turns it on) and the four-way live gate. The gate's
 * dependencies (isChainActive, getOrderExecutorV3) are mocked so each AND term
 * is exercised in isolation — including the DCA_CHAINS allowlist, which is
 * required because mainnet (1) may have a non-null v3 executor too and must
 * still never be offered DCA.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const isChainActiveMock = vi.fn()
const getOrderExecutorV3Mock = vi.fn()

vi.mock('@/lib/chains', () => ({
  isChainActive: (id: number) => isChainActiveMock(id),
}))
vi.mock('@/lib/order-engine', () => ({
  getOrderExecutorV3: (id: number) => getOrderExecutorV3Mock(id),
}))

import { isDcaLaunchEnabled, isDcaLive, BASE_CHAIN_ID, DCA_CHAINS } from './dca-launch'

const ORIG_FLAG = process.env.NEXT_PUBLIC_DCA_ENABLED

beforeEach(() => {
  vi.clearAllMocks()
  // Default fixture: every chain reports active + every wired v3 executor resolves. Tests
  // vary only the flag + connected chain so each gate term is isolated.
  isChainActiveMock.mockReturnValue(true)
  getOrderExecutorV3Mock.mockImplementation((id: number) =>
    id === 8453
      ? '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598'
      : id === 42161
        ? '0x000000000000000000000000000000000000dEaD'
        : null,
  )
})

afterEach(() => {
  if (ORIG_FLAG === undefined) delete process.env.NEXT_PUBLIC_DCA_ENABLED
  else process.env.NEXT_PUBLIC_DCA_ENABLED = ORIG_FLAG
})

describe('dca-launch — isDcaLaunchEnabled (the launch flag)', () => {
  it('is false when the flag is unset (default OFF)', () => {
    delete process.env.NEXT_PUBLIC_DCA_ENABLED
    expect(isDcaLaunchEnabled()).toBe(false)
  })

  it('is false for any value other than the exact literal "true"', () => {
    process.env.NEXT_PUBLIC_DCA_ENABLED = '1'
    expect(isDcaLaunchEnabled()).toBe(false)
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'TRUE'
    expect(isDcaLaunchEnabled()).toBe(false)
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'false'
    expect(isDcaLaunchEnabled()).toBe(false)
  })

  it('is true only for "true"', () => {
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    expect(isDcaLaunchEnabled()).toBe(true)
  })
})

describe('dca-launch — DCA_CHAINS allowlist', () => {
  it('contains exactly Base + Arbitrum, mainnet deliberately absent', () => {
    expect(DCA_CHAINS).toEqual([8453, 42161])
    expect(DCA_CHAINS.includes(1)).toBe(false)
  })

  it('BASE_CHAIN_ID stays 8453 (historical constant, unaffected by the allowlist generalization)', () => {
    expect(BASE_CHAIN_ID).toBe(8453)
  })
})

describe('dca-launch — isDcaLive (flag × DCA_CHAINS allowlist × active × v3-wired gate)', () => {
  it('flag OFF ⇒ not live, even on Base', () => {
    delete process.env.NEXT_PUBLIC_DCA_ENABLED
    expect(isDcaLive(BASE_CHAIN_ID)).toBe(false)
  })

  it('flag ON + Base (active + v3 wired) ⇒ live', () => {
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    expect(isDcaLive(8453)).toBe(true)
  })

  it('flag ON + mainnet ⇒ NOT live — mainnet is absent from DCA_CHAINS even if a v3 executor existed there', () => {
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    getOrderExecutorV3Mock.mockReturnValue('0x1111111111111111111111111111111111111111') // mainnet WOULD resolve non-null
    expect(isDcaLive(1)).toBe(false) // …but DCA is still not offered on mainnet
  })

  it('flag ON + Arbitrum in DCA_CHAINS but v3 unwired (real dark state, env unset) ⇒ not live', () => {
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    getOrderExecutorV3Mock.mockImplementation((id: number) => (id === 8453 ? '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598' : null))
    expect(isDcaLive(42161)).toBe(false)
  })

  it('flag ON + Arbitrum active + v3 wired ⇒ live — this IS the state SPRINT-48 prepares (still requires a real deploy + env flip later)', () => {
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    expect(isDcaLive(42161)).toBe(true)
  })

  it('flag ON + an unlisted chain reported active + a (mocked) v3 executor exists ⇒ still NOT live — DCA_CHAINS alone blocks it', () => {
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    isChainActiveMock.mockReturnValue(true)
    getOrderExecutorV3Mock.mockReturnValue('0x000000000000000000000000000000000000dEaD')
    const unlisted = 10 // Optimism — not in DCA_CHAINS
    expect(DCA_CHAINS.includes(unlisted)).toBe(false)
    expect(isDcaLive(unlisted)).toBe(false)
  })

  it('flag ON + on Base but Base inactive (feeCollector unset) ⇒ not live', () => {
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    isChainActiveMock.mockReturnValue(false)
    expect(isDcaLive(8453)).toBe(false)
  })

  it('flag ON + on Arbitrum but Arbitrum inactive ⇒ not live even with v3 wired', () => {
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    isChainActiveMock.mockImplementation((id: number) => id !== 42161)
    expect(isDcaLive(42161)).toBe(false)
  })
})

// Full gate matrix: flag × chain × (v3 wired / unwired). 3 chains × 2 flag states × 2 wiring
// states = 12 cases, expressed as a single truth table so a future regression in any AND term
// shows up as a matrix diff rather than a single failing assertion.
describe('dca-launch — isDcaLive full gate matrix (1 / 8453 / 42161 × flag × v3-wired)', () => {
  const CHAINS = [1, 8453, 42161] as const

  it.each([
    { chainId: 1, flag: false, wired: false, expected: false },
    { chainId: 1, flag: false, wired: true, expected: false },
    { chainId: 1, flag: true, wired: false, expected: false },
    { chainId: 1, flag: true, wired: true, expected: false }, // mainnet: never, allowlist absence alone blocks it
    { chainId: 8453, flag: false, wired: false, expected: false },
    { chainId: 8453, flag: false, wired: true, expected: false },
    { chainId: 8453, flag: true, wired: false, expected: false },
    { chainId: 8453, flag: true, wired: true, expected: true },
    { chainId: 42161, flag: false, wired: false, expected: false },
    { chainId: 42161, flag: false, wired: true, expected: false },
    { chainId: 42161, flag: true, wired: false, expected: false }, // today's real (dark) state
    { chainId: 42161, flag: true, wired: true, expected: true },
  ])('chain=$chainId flag=$flag wired=$wired ⇒ isDcaLive=$expected', ({ chainId, flag, wired, expected }) => {
    if (flag) process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    else delete process.env.NEXT_PUBLIC_DCA_ENABLED
    isChainActiveMock.mockReturnValue(true)
    getOrderExecutorV3Mock.mockImplementation((id: number) => (wired && id === chainId ? '0xdead00000000000000000000000000000000dead' : null))
    expect(isDcaLive(chainId)).toBe(expected)
    expect(CHAINS.includes(chainId as any)).toBe(true) // sanity: matrix covers the intended 3 chains
  })
})
