/**
 * [SPRINT-DCA-UNGATE] DCA launch-flag + Base-only gating.
 *
 * Pins the launch flag semantics (NEXT_PUBLIC_DCA_ENABLED, default OFF, only
 * the literal "true" turns it on) and the three-way live gate. The gate's
 * dependencies (isChainActive, getOrderExecutor) are mocked so each AND term
 * is exercised in isolation — including the Base-chain pin, which is required
 * because getOrderExecutor(1) (mainnet) is ALSO non-null.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const isChainActiveMock = vi.fn()
const getOrderExecutorMock = vi.fn()

vi.mock('@/lib/chains', () => ({
  isChainActive: (id: number) => isChainActiveMock(id),
}))
vi.mock('@/lib/order-engine', () => ({
  getOrderExecutor: (id: number) => getOrderExecutorMock(id),
}))

import { isDcaLaunchEnabled, isDcaLive, BASE_CHAIN_ID } from './dca-launch'

const ORIG_FLAG = process.env.NEXT_PUBLIC_DCA_ENABLED

beforeEach(() => {
  vi.clearAllMocks()
  // Default fixture: Base active + every wired executor resolves. Tests vary
  // only the flag + connected chain so each gate term is isolated.
  isChainActiveMock.mockReturnValue(true)
  getOrderExecutorMock.mockImplementation((id: number) =>
    id === 8453
      ? '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598'
      : id === 1
        ? '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
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

describe('dca-launch — isDcaLive (Base-only gate)', () => {
  it('flag OFF ⇒ not live, even on Base', () => {
    delete process.env.NEXT_PUBLIC_DCA_ENABLED
    expect(isDcaLive(BASE_CHAIN_ID)).toBe(false)
  })

  it('flag ON + Base (active + executor wired) ⇒ live', () => {
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    expect(isDcaLive(8453)).toBe(true)
  })

  it('flag ON + mainnet ⇒ NOT live — the Base-chain pin blocks it even though getOrderExecutor(1) is non-null', () => {
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    expect(getOrderExecutorMock(1)).not.toBeNull() // sanity: mainnet executor exists…
    expect(isDcaLive(1)).toBe(false) // …but DCA is still not offered on mainnet
  })

  it('flag ON + unwired L2 (Arbitrum 42161) ⇒ not live (no executor there)', () => {
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    expect(isDcaLive(42161)).toBe(false)
  })

  it('flag ON + on Base but Base inactive (feeCollector unset) ⇒ not live', () => {
    process.env.NEXT_PUBLIC_DCA_ENABLED = 'true'
    isChainActiveMock.mockReturnValue(false)
    expect(isDcaLive(8453)).toBe(false)
  })
})
