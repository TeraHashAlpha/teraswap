// @vitest-environment jsdom
/**
 * [ADR-025 / B5] The price gates, v2 = v1. Three layers:
 *  1. `computeGates` against v1's constants and evaluators (every verdict v1's SwapBox derives);
 *  2. the block labels against v1's OWN SwapButton rendered for each `blockReason` (so the words cannot drift);
 *  3. the card: in every blocked state Confirm can never reach a hook; the two consent states clear by v1's checkbox and re-arm
 *     when the deviation worsens past the accepted level (+ tolerance).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SwapButton from '@/components/SwapButton'
import { DEPEG_CONSENT_TOLERANCE, PRICE_IMPACT_CONSENT_CEILING, PRICE_IMPACT_CONSENT_TOLERANCE, UNVERIFIED_SWAP_BLOCK_USD, UNVERIFIED_SWAP_WARN_USD } from '@/lib/constants'
import type { PriceCheck } from '@/lib/chainlink'
import type { DepegCheck } from '@/lib/depeg-gate'
import { NO_ORACLE, fixtureMeta, taggedFixture } from '../test-fixtures'
import { blockCopy, computeGates, type BlockReason, type GateInput } from './gates'

const h = vi.hoisted(() => ({
  account: { address: '0xd44d00000000000000000000000000000000962d' as string | undefined, isConnected: true, chain: { id: 1 } as { id: number } | undefined },
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: () => {} },
  oracle: {} as Record<string, unknown>,
  depeg: { mode: 'ok', divergence: 0, symbol: '', message: null } as Record<string, unknown>,
  swap: {} as Record<string, unknown>,
  split: {} as Record<string, unknown>,
}))
vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useBalance: () => ({ data: { value: 3n * 10n ** 18n, decimals: 18 } }),
  useChains: () => [{ id: 1, name: 'Ethereum' }],
  useSwitchChain: () => ({ switchChain: () => {} }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: () => {} }) }))
vi.mock('@/hooks/useQuote', () => ({ useQuote: () => h.quote }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1, useActiveChainId: () => 1 }))
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: () => h.oracle }))
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => ({ ethPrice: 2490, gasPriceGwei: 0.1, estimate: () => ({ eth: 0.000012, usd: 0.03 }) }) }))
vi.mock('@/hooks/useApproval', () => ({ useApproval: () => ({ plan: null, status: 'ready', error: null, isReady: true, approve: async () => {}, needsPermit2Education: false }) }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => ({ data: null, loading: false }) }))
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: () => h.depeg }))
vi.mock('@/hooks/useSwap', () => ({ useSwap: () => h.swap }))
vi.mock('@/hooks/useSplitRoute', () => ({ useSplitRoute: () => ({ splitResult: null, analyzing: false, useSplit: false, toggleSplit: () => {} }) }))
vi.mock('@/hooks/useSplitSwap', () => ({ useSplitSwap: () => h.split }))
vi.mock('@/hooks/useSwapHistory', () => ({ useSwapHistory: () => ({ addRecord: () => {} }) }))
vi.mock('@/hooks/useActiveApprovals', () => ({ useActiveApprovals: () => ({ addApproval: () => {} }) }))
vi.mock('../../shell/toasts', () => ({ useV2Toast: () => ({ toast: () => 'toast-id', dismiss: () => {}, update: () => {} }) }))
vi.mock('@/lib/analytics', () => ({ updateSwapStatus: () => {}, logQuoteToSupabase: () => {} }))
vi.mock('@/lib/sounds', () => ({ playQuoteReceived: () => {}, playTouchMP3: () => {}, playSwapConfirmMP3: () => {}, playCancelOrderMP3: () => {}, startWaitingSound: () => {}, stopWaitingSound: () => {} }))

import { SwapCard } from '../SwapCard'

const ok: PriceCheck = { ...NO_ORACLE, chainlinkPrice: 2490, level: 'none' } as unknown as PriceCheck
const pc = (over: Partial<PriceCheck>): PriceCheck => ({ ...ok, ...over })
const dp = (over: Partial<DepegCheck>): DepegCheck => ({ mode: 'ok', divergence: 0, symbol: 'cbETH', message: null, ...over })
const base: GateInput = { pairCheck: ok, depegCheck: dp({}), acceptedDeviation: null, acceptedDepeg: null, estimatedSwapUsd: 100 }
const g = (over: Partial<GateInput>) => computeGates({ ...base, ...over })

describe('computeGates = SwapBox\'s verdicts', () => {
  it('a clean pair: nothing blocks', () => {
    const r = g({})
    expect(r.anyBlocked).toBe(false)
    expect(r.blockReason).toBeUndefined()
  })
  it('oracle integrity failure → hard block "oracle-stale"; an extreme deviation → hard block "extreme"', () => {
    expect(g({ pairCheck: pc({ oracleIntegrityFailed: true }) }).blockReason).toBe('oracle-stale')
    expect(g({ pairCheck: pc({ level: 'danger', deviation: PRICE_IMPACT_CONSENT_CEILING + 0.01 }) }).blockReason).toBe('extreme')
  })
  it('a healthy-oracle deviation → consent; ticking it at the live deviation clears it; a worse deviation re-arms it', () => {
    const warn = pc({ level: 'warn', deviation: 0.05 })
    expect(g({ pairCheck: warn }).blockReason).toBe('price-impact')
    expect(g({ pairCheck: warn, acceptedDeviation: 0.05 }).anyBlocked).toBe(false)
    expect(g({ pairCheck: pc({ level: 'warn', deviation: 0.05 + PRICE_IMPACT_CONSENT_TOLERANCE }), acceptedDeviation: 0.05 }).anyBlocked).toBe(false) // within tolerance
    expect(g({ pairCheck: pc({ level: 'warn', deviation: 0.05 + PRICE_IMPACT_CONSENT_TOLERANCE + 0.001 }), acceptedDeviation: 0.05 }).blockReason).toBe('price-impact')
  })
  it('depeg: consent band / hard block / unverified (could not check → blocks, never worded as a depeg)', () => {
    expect(g({ depegCheck: dp({ mode: 'consent', divergence: 0.04 }) }).blockReason).toBe('depeg-consent')
    expect(g({ depegCheck: dp({ mode: 'consent', divergence: 0.04 }), acceptedDepeg: 0.04 }).anyBlocked).toBe(false)
    expect(g({ depegCheck: dp({ mode: 'consent', divergence: 0.04 + DEPEG_CONSENT_TOLERANCE + 0.001 }), acceptedDepeg: 0.04 }).blockReason).toBe('depeg-consent')
    expect(g({ depegCheck: dp({ mode: 'block', divergence: 0.12 }) }).blockReason).toBe('depeg-block')
    expect(g({ depegCheck: dp({ mode: 'unverified' }) }).blockReason).toBe('depeg-unverified')
  })
  it('no oracle: warn above $1k, block above $10k (v1 constants, strictly greater)', () => {
    const none = pc({ oracleUnavailable: true })
    expect(g({ pairCheck: none, estimatedSwapUsd: UNVERIFIED_SWAP_WARN_USD }).oracleWarnThreshold).toBe(false)
    expect(g({ pairCheck: none, estimatedSwapUsd: UNVERIFIED_SWAP_WARN_USD + 1 }).oracleWarnThreshold).toBe(true)
    expect(g({ pairCheck: none, estimatedSwapUsd: UNVERIFIED_SWAP_BLOCK_USD }).anyBlocked).toBe(false)
    expect(g({ pairCheck: none, estimatedSwapUsd: UNVERIFIED_SWAP_BLOCK_USD + 1 }).blockReason).toBe('oracle')
  })
  it('precedence is v1\'s: depeg-block > extreme > oracle-stale > depeg-unverified > depeg-consent > price-impact > oracle', () => {
    const all = { pairCheck: pc({ oracleIntegrityFailed: true, oracleUnavailable: true, level: 'warn', deviation: 0.3 }), estimatedSwapUsd: 99999 }
    expect(g({ ...all, depegCheck: dp({ mode: 'block' }) }).blockReason).toBe('depeg-block')
    expect(g({ ...all, depegCheck: dp({ mode: 'unverified' }) }).blockReason).toBe('oracle-stale')
  })
})

describe('block labels = v1 SwapButton, word for word', () => {
  const reasons: BlockReason[] = ['price-impact', 'oracle-stale', 'extreme', 'oracle', 'depeg-consent', 'depeg-block', 'depeg-unverified']
  afterEach(cleanup)
  it.each(reasons)('%s', (reason) => {
    const v1 = render(
      <SwapButton swapStatus="idle" approvalStatus="ready" approvalReady hasAmount hasSufficientBalance hasQuote quoteLoading={false} priceBlocked blockReason={reason} onApprove={() => {}} onSwap={() => {}} />,
    )
    // SwapButton needs a connected, on-chain wallet to reach the block branch — wagmi is mocked connected on chain 1 above.
    expect(v1.container.querySelector('button')!.textContent).toBe(blockCopy(reason).text)
    expect((v1.container.querySelector('button') as HTMLButtonElement).disabled).toBe(true)
    // v1 paints the checkbox-recoverable blocks amber ('warning'), the rest red ('error')
    expect(v1.container.querySelector('button')!.className.includes('border-warning')).toBe(blockCopy(reason).recoverable)
  })
})

describe('the card never reaches a hook while blocked', () => {
  const swapSpies = () => ({ status: 'idle', txHash: undefined, errorMessage: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false, pendingSwap: null, pendingCowOrder: null, mevSurplusActualWei: null, execute: vi.fn(), confirmSwap: vi.fn(), confirmCowOrder: vi.fn(), reset: vi.fn() })
  beforeEach(() => {
    h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
    h.quote = { meta: taggedFixture(fixtureMeta(), '1'), loading: false, error: null, countdown: 12, refresh: () => {} }
    h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490 }
    h.depeg = { mode: 'ok', divergence: 0, symbol: '', message: null }
    h.swap = swapSpies()
    h.split = { status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, plannedLegs: [], unpricedAckRequired: false, execute: vi.fn(), confirmPlan: vi.fn(), reset: vi.fn() }
  })
  afterEach(cleanup)
  let view: ReturnType<typeof render>
  const open = () => {
    view = render(<SwapCard />)
    fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '1' } })
    return document.querySelector('[data-cta]') as HTMLButtonElement
  }

  it('hard blocks: the CTA says v1\'s words, is disabled, opens nothing, executes nothing', () => {
    for (const [setup, reason] of [
      [() => (h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490, oracleIntegrityFailed: true }), 'oracle-stale'],
      [() => (h.depeg = { mode: 'block', divergence: 0.12, symbol: 'cbETH', message: 'x' }), 'depeg-block'],
      [() => (h.depeg = { mode: 'unverified', divergence: 0, symbol: 'cbETH', message: 'x' }), 'depeg-unverified'],
    ] as const) {
      setup()
      const cta = open()
      expect(cta.dataset.cta).toBe('blocked')
      expect(cta.textContent).toBe(blockCopy(reason as BlockReason).text)
      expect(cta.disabled).toBe(true)
      fireEvent.click(cta)
      expect(screen.queryByRole('dialog')).toBeNull()
      expect((h.swap.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
      cleanup()
      h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490 }
      h.depeg = { mode: 'ok', divergence: 0, symbol: '', message: null }
    }
  })

  it('depeg consent: blocked until v1\'s checkbox is ticked (amber, recoverable); un-ticks itself on a new amount', () => {
    h.depeg = { mode: 'consent', divergence: 0.04, symbol: 'cbETH', message: 'cbETH trades 4.0% off its exchange rate.' }
    const cta = open()
    expect(cta.textContent).toBe('Confirm depeg risk to swap')
    expect(cta.dataset.recoverable).toBe('true')
    fireEvent.click(screen.getByTestId('gate-depeg-checkbox'))
    expect((document.querySelector('[data-cta]') as HTMLButtonElement).dataset.cta).toBe('review')
    expect((document.querySelector('[data-cta]') as HTMLButtonElement).disabled).toBe(false)
    // consent is per trade: a new amount drops it (v1: handleAmountChange → setAcceptedDepeg(null))
    fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: '2' } })
    h.quote = { ...h.quote, meta: taggedFixture(fixtureMeta(), '2') }
    view.rerender(<SwapCard />)
    expect((document.querySelector('[data-cta]') as HTMLButtonElement).textContent).toBe('Confirm depeg risk to swap')
  })

  it('a hard block is not click-through-able: no checkbox is offered for it', () => {
    h.depeg = { mode: 'block', divergence: 0.12, symbol: 'cbETH', message: 'x' }
    open()
    expect(screen.queryByTestId('gate-depeg-checkbox')).toBeNull()
    expect(screen.getByTestId('gate-depeg-block').textContent).toContain('This cannot be overridden.')
  })
})
