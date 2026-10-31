// @vitest-environment jsdom
/**
 * [ADR-025] Content parity, Swap tab (the B10 gate, instance 3): v1's SwapBox (which embeds QuoteBreakdown) and the v2 card
 * are rendered against the SAME mocked hook answers, and every visible v1 text node must be in v2 ("nothing lost", pack D5).
 * The only way a v1 string may vanish is an ALLOW entry carrying its reason; a stale entry fails.
 *
 * Quote state = a priced pair, quiet oracle, one executable best, a runner-up, no split, no swap in flight. The conditional
 * v1 surfaces that need the wallet lifecycle (price-gate banners and consent boxes, split visualiser/progress, simulation,
 * tx links, share, slippage/permit2/review/consent modals) are B4/B5 and are not part of this fixture.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareContent, type AllowedRemoval } from '../__tests__/content-parity'
import { NO_ORACLE, fixtureMeta, taggedFixture } from './test-fixtures'

const noop = () => {}
const h = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: false, chain: undefined as { id: number } | undefined },
  balance: undefined as { value: bigint; decimals: number } | undefined,
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: () => {} },
  oracle: { chainlinkPrice: 2490, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false } as Record<string, unknown>,
  approval: { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 } as unknown, status: 'ready', error: null, approve: () => {}, isReady: true, needsPermit2Education: false, confirmPermit2Education: () => {}, cancelPermit2Education: () => {} },
  tier: { data: null as unknown, loading: false },
}))

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useBalance: () => ({ data: h.balance }),
  useChains: () => [{ id: 1, name: 'Ethereum' }],
  useSwitchChain: () => ({ switchChain: () => {} }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ useConnectModal: () => ({ openConnectModal: () => {} }) }))
vi.mock('@/hooks/useQuote', () => ({ useQuote: () => h.quote }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1, useActiveChainId: () => 1 }))
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: () => h.oracle }))
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => ({ ethPrice: 2490, gasPriceGwei: 0.1, estimate: () => ({ eth: 0.000012, usd: 0.03 }) }) }))
vi.mock('@/hooks/useApproval', () => ({ useApproval: () => h.approval }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => h.tier }))
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: '' }) }))
vi.mock('@/hooks/useSwap', () => ({
  useSwap: () => ({ status: 'idle', txHash: undefined, errorMessage: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false, simulationPassed: null, simulationSkipped: false, fallbackNotice: null, pendingSwap: null, pendingCowOrder: null, mevSurplusActualWei: null, execute: () => {}, confirmSwap: () => {}, confirmCowOrder: () => {}, reset: () => {} }),
}))
vi.mock('@/hooks/useSplitRoute', () => ({ useSplitRoute: () => ({ splitResult: null, analyzing: false, useSplit: false, toggleSplit: () => {} }) }))
vi.mock('@/hooks/useSplitSwap', () => ({
  useSplitSwap: () => ({ status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, plannedLegs: [], unpricedAckRequired: false, execute: () => {}, confirmPlan: () => {}, reset: () => {} }),
}))
vi.mock('@/hooks/useSwapHistory', () => ({ useSwapHistory: () => ({ addRecord: () => {} }) }))
vi.mock('@/hooks/useActiveApprovals', () => ({ useActiveApprovals: () => ({ addApproval: () => {} }) }))
vi.mock('@/components/ActiveApprovals', () => ({ default: () => null }))
vi.mock('@/components/ParticleNetwork', () => ({ setParticleTurbo: () => {} }))
vi.mock('@/components/ToastProvider', () => ({ useToast: () => ({ toast: () => '', dismiss: () => {} }) }))
vi.mock('@/components/TokenSelector', () => ({ default: ({ selected }: { selected: { symbol: string } | null }) => <button type="button">{selected?.symbol}</button> }))
vi.mock('@/lib/analytics', () => ({ updateSwapStatus: () => {}, logQuoteToSupabase: () => {} }))
vi.mock('@/lib/wallet-activity-tracker', () => ({ trackWalletActivity: () => {} }))
vi.mock('@/lib/sounds', () => ({ playQuoteReceived: () => {}, playTouchMP3: () => {}, playSwapConfirmMP3: () => {}, playCancelOrderMP3: () => {}, startWaitingSound: () => {}, stopWaitingSound: () => {} }))

vi.mock('../shell/toasts', () => ({ useV2Toast: () => ({ toast: () => 'toast-id', dismiss: () => {}, update: () => {} }) }))

import SwapBox from '@/components/SwapBox'
import { SwapCard } from './SwapCard'

/**
 * Decorative glyphs: v1 prints them as bare text; v2 draws them aria-hidden next to a control that keeps its aria-label
 * (the Round 7 icon-button rule), so they are not "visible text" in v2 — nothing is lost, the name moved to the control.
 */
const GLYPH = 'decorative glyph, aria-hidden in v2; the control keeps its accessible name'
const ALLOW: AllowedRemoval[] = [
  { text: '⇅', reason: `owner round 7 item 11 (bare 44 px icon): ${GLYPH}` },
  { text: '⟳', reason: `refresh: ${GLYPH}` },
  { text: '✎', reason: `max-slippage edit: ${GLYPH}` },
  { text: 'ⓘ', reason: `tooltip trigger: ${GLYPH}` },
  { text: '⚙', reason: `sources trigger: ${GLYPH}` },
  { text: '×', reason: `dismiss MEV hint: ${GLYPH}` },
]

const addr = '0xd44d00000000000000000000000000000000962d'
const type = (container: HTMLElement, value: string) =>
  fireEvent.change(container.querySelector('input[inputmode="decimal"]') as HTMLInputElement, { target: { value } })

function renderBoth(setup: () => void, amount = '1') {
  setup()
  const v1 = render(<SwapBox />)
  type(v1.container, amount)
  const v2 = render(<SwapCard />)
  type(v2.container, amount)
  return { v1: v1.container, v2: v2.container }
}

beforeEach(() => {
  h.account = { address: undefined, isConnected: false, chain: undefined }
  h.balance = undefined
  h.oracle = { ...NO_ORACLE, chainlinkPrice: 2490 }
  h.tier = { data: null, loading: false }
  h.quote = { meta: taggedFixture(fixtureMeta(), '1'), loading: false, error: null, countdown: 12, refresh: noop }
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function report(label: string, r: ReturnType<typeof compareContent>) {
  console.log(`[parity] ${label}: v1 text nodes ${r.v1Nodes}, v1 links ${r.v1Hrefs}, missing text ${r.missingText.length}, missing hrefs ${r.missingHrefs.length}, stale allow ${r.staleAllow.length}${r.staleAllow.length ? ` ${JSON.stringify(r.staleAllow)}` : ''}`)
}

describe('Swap: v1 SwapBox + QuoteBreakdown → v2 SwapCard, quote state', () => {
  it('connected, with a balance (50% / MAX, Balance line)', () => {
    const { v1, v2 } = renderBoth(() => {
      h.account = { address: addr, isConnected: true, chain: { id: 1 } }
      h.balance = { value: 3_000_000_000_000_000_000n, decimals: 18 }
    })
    const r = compareContent(v1, v2, ALLOW)
    report('connected + balance', r)
    expect(r.v1Nodes).toBeGreaterThan(30) // the fixture really renders the quote state, not an empty shell
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(r.staleAllow).toEqual([])
  })

  it('disconnected, no balance (the token identity line replaces the balance)', () => {
    const { v1, v2 } = renderBoth(() => {})
    const r = compareContent(v1, v2, ALLOW)
    report('disconnected', r)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
  })

  it('a non-native sell token shows its short address, as v1 does (USDC → ETH)', () => {
    // v1 and v2 both start on ETH → USDC; flip both so the sell side is the ERC-20.
    h.quote = { meta: null, loading: false, error: null, countdown: 12, refresh: noop }
    const v1 = render(<SwapBox />)
    const v2 = render(<SwapCard />)
    for (const r of [v1, v2]) fireEvent.click(r.container.querySelector('button[class*="h-11"], button[aria-label="Swap sell and receive tokens"]') as HTMLElement)
    const res = compareContent(v1.container, v2.container, ALLOW)
    report('USDC → ETH', res)
    expect(res.missingText).toEqual([])
  })

  it('a CoW best (intent-based): execution-time text, MEV Protected / Intent-Based / Gasless badges, gasless confirmation, MEV savings', () => {
    const m = fixtureMeta()
    const cow = { ...m.all[0], source: 'cowswap' as const, estimatedGas: 0, routes: ['CoW Protocol'] }
    m.all = [cow, ...m.all.slice(1)]
    m.best = cow
    m.gasless = { available: true, recommended: true, reason: 'x', gasSavingsUsd: 2.5 } as never
    const { v1, v2 } = renderBoth(() => {
      h.account = { address: addr, isConnected: true, chain: { id: 1 } }
      h.quote = { meta: taggedFixture(m, '1'), loading: false, error: null, countdown: 12, refresh: noop }
    })
    const r = compareContent(v1, v2, ALLOW)
    report('CoW best', r)
    expect(r.missingText).toEqual([])
  })

  it('low confidence + oracle read failed notices (QuoteBreakdown)', () => {
    const m = fixtureMeta({ lowConfidence: true })
    // 0.1 ETH out ≈ $25: under the $1 000 "no oracle, high value" warn line, which is a price-gate surface (B5), not QuoteBreakdown
    m.all = m.all.map((q) => ({ ...q, toAmount: (BigInt(q.toAmount) / 100n).toString() }))
    m.best = m.all[0]
    const { v1, v2 } = renderBoth(() => {
      h.account = { address: addr, isConnected: true, chain: { id: 1 } }
      h.quote = { meta: taggedFixture(m, '0.1'), loading: false, error: null, countdown: 12, refresh: noop }
      h.oracle = { ...NO_ORACLE, chainlinkPrice: null, oracleUnavailable: true, oracleReadFailed: true }
    }, '0.1')
    const r = compareContent(v1, v2, ALLOW)
    report('notices', r)
    expect(r.missingText).toEqual([])
  })

  it('tier: single-source — the amber notice is v1\'s, verbatim (0 missing, no allow entry)', () => {
    const { v1, v2 } = renderBoth(() => {
      h.account = { address: addr, isConnected: true, chain: { id: 1 } }
      h.tier = { data: { tier: 'single-source', legs: { in: { tier: 'single-source', sources: ['defillama'], usd: 2490 }, out: { tier: 'single-source', sources: ['defillama'], usd: 1 } } }, loading: false }
    })
    const r = compareContent(v1, v2, ALLOW)
    report('single-source', r)
    expect(r.missingText).toEqual([])
    expect(v1.textContent).toContain('Price from one source only (DefiLlama).')
  })

  it('tier: unpriced — v1\'s three-sentence notice becomes the owner\'s one line; ONLY those sentences are allowed to go', () => {
    const UNPRICED: AllowedRemoval[] = [
      { text: '⚠ No reference price for this pair.', reason: 'B3 goal: unpriced = one line `No reference price — consent required before swapping`; the informed-consent dialog is B4' },
      { text: "We couldn't find a Chainlink, DefiLlama or CoinGecko price for", reason: 'same: the explanation moves into the B4 consent dialog (it already carries these words)' },
      { text: ", so we can't estimate this trade's USD value or apply value-based limits. You'll be asked to confirm before swapping.", reason: 'same' },
    ]
    const { v1, v2 } = renderBoth(() => {
      h.account = { address: addr, isConnected: true, chain: { id: 1 } }
      h.tier = { data: { tier: 'unpriced', legs: { in: { tier: 'unpriced', sources: [] }, out: { tier: 'unpriced', sources: [] } } }, loading: false }
    })
    const withAllow = compareContent(v1, v2, [...ALLOW, ...UNPRICED])
    report('unpriced (allow-listed)', withAllow)
    expect(withAllow.missingText).toEqual([])
    expect(withAllow.staleAllow).toEqual([])
    expect(v2.textContent).toContain('No reference price — consent required before swapping')
    // and without the allow-list the gate would catch the change (the entries are load-bearing, not decoration)
    expect(compareContent(v1, v2, ALLOW).missingText.length).toBeGreaterThan(0)
  })
})
