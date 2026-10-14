// @vitest-environment jsdom
/**
 * [fix/dca-chain-switch / P3] The BUY-side note is driven by the server's floor tier (the answer the
 * consent dialog reads), not by the Chainlink-only oracle-coverage probe it used to contradict.
 *   onchain-feed   → no note
 *   offchain-price → "Protected by executor price checks (no Chainlink feed registered yet)"
 *   unpriced       → "No market price source right now — buys capped at $<cap> and flagged"
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stubFloorEndpoint } from './dca/__tests__/stub-floor-endpoint'

const useAccountMock = vi.fn()
const useChainIdMock = vi.fn(() => 8453)
const createOrderMock = vi.fn()
const checkRouteMock = vi.fn()
const checkOracleMock = vi.fn()
const llamaMock = vi.fn()

/** The Base (8453) OrderExecutorV3 — docs/DEPLOYMENTS.md. */
const V3_ADDRESS = '0x686b4f812291F4De238E59ED00BA6dD6129e60a0'
const BASE_REGISTERED: Record<string, readonly unknown[]> = {
  // WETH — the DCA spend leg on Base.
  '0x4200000000000000000000000000000000000006': ['0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', 8, 18, 3600n, true],
  // USDC — the feed-covered control output.
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': ['0x458138Fc0D67027E9A6778ef40a6ffC318c69061', 8, 6, 90000n, true],
}

vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync: vi.fn().mockResolvedValue(undefined) }),
  useAccount: () => useAccountMock(),
  useChainId: () => useChainIdMock(),
}))
vi.mock('@/hooks/useChainlinkPrice', () => ({
  useChainlinkPrice: () => ({ chainlinkPrice: null, executionPrice: null, deviation: 0, level: 'none', message: null, oracleUnavailable: false }),
}))
// [FEAT-DEPEG-GATE-ORDER-CREATION] Same precedent as useChainlinkPrice above — stub directly
// rather than expanding this file's minimal wagmi mock with useReadContract. This suite doesn't
// exercise depeg behaviour, so a static 'ok' (no exchange-rate pair) keeps every test unaffected.
vi.mock('@/hooks/useDepegCheck', () => ({
  useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }),
}))
vi.mock('@/hooks/useTokenBalances', () => ({ useTokenBalances: () => ({ balances: new Map(), isLoading: false, isError: false }) }))
vi.mock('@/hooks/useTokenBalance', () => ({
  useTokenBalance: () => ({ raw: 1_000000000000000000000n, hasValue: true, formatted: '1000', isLoading: false, isError: false }),
}))
vi.mock('@/lib/order-engine/check-route', () => ({
  checkRoute: (...args: unknown[]) => checkRouteMock(...args),
  NO_ROUTE_REASON: 'No swap route found for this pair on this network.',
}))
vi.mock('@/lib/order-engine/check-oracle', () => ({
  checkOracleCoverage: (...args: unknown[]) => checkOracleMock(...args),
}))
vi.mock('@/lib/defillama', () => ({ fetchDefiLlamaPrice: (...a: unknown[]) => llamaMock(...a) }))
// [FIX-DCA-NOFEED-FAIL-CLOSED] v3 live on Base — the shape of any chain a user can reach this panel
// on, and the condition the new gate is armed under.
vi.mock('@/lib/order-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  return {
    ...actual,
    getOrderExecutorV3: (chainId: number) => (chainId === 8453 ? V3_ADDRESS : null),
  }
})
// The executor's own `tokenUsdFeeds` registry, answering with the REAL Base rows read 2026-09-09:
// WETH and USDC registered, everything else the zero struct (registered: false).
vi.mock('@/lib/chains/clients', () => ({
  getPublicClientForChain: () => ({
    readContract: async ({ args }: { args: readonly unknown[] }) =>
      BASE_REGISTERED[String(args[0]).toLowerCase()] ?? ['0x0000000000000000000000000000000000000000', 0, 0, 0n, false],
  }),
  _clearClientCache: vi.fn(),
}))
vi.mock('@/hooks/useOrderEngine', () => ({
  useOrderEngine: () => ({
    dcaOrders: [], activeOrders: [], historyOrders: [], latestEvent: null, isSubmitting: false,
    createOrder: createOrderMock,
    pendingOrder: null, confirmOrder: vi.fn(), clearPendingOrder: vi.fn(),
    pendingCancel: null, confirmCancel: vi.fn(), clearPendingCancel: vi.fn(),
    cancelOrder: vi.fn(), cancelAllOrders: vi.fn(), removeOrder: vi.fn(),
  }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => <button>Connect</button> }))
vi.mock('@/lib/sounds', () => ({
  playClick: vi.fn(), playTouchMP3: vi.fn(), playSwapConfirmMP3: vi.fn(),
  playCancelOrderMP3: vi.fn(), startWaitingSound: vi.fn(), stopWaitingSound: vi.fn(),
}))
vi.mock('@/lib/analytics-tracker', () => ({ trackTrade: vi.fn() }))
vi.mock('@/hooks/useOrderNotifications', () => ({ useOrderNotifications: vi.fn() }))
// Output-picker mock: NOT marked "Imported" (category is orthogonal to feed coverage), so the
// separate routability gate (hasImported) never engages — this test is only about the consent gate.
vi.mock('@/components/TokenSelector', () => ({
  default: ({ selected, onSelect, hideNativeInput }: { selected: { symbol?: string } | null; onSelect: (t: unknown) => void; hideNativeInput?: boolean }) => (
    <div data-testid={hideNativeInput ? 'token-selector-in' : 'token-selector-out'}>
      <span>{selected?.symbol ?? 'Select'}</span>
      {!hideNativeInput && (
        <>
          <button
            data-testid="pick-nofeed-output"
            onClick={() => onSelect({
              address: '0x6c240ca4a1a3d8c4c2c7e6b8d6f6e8a4b4c2a2a2', // no Chainlink feed on Base
              symbol: 'ETHFI', name: 'Ether.fi', decimals: 18, logoURI: '', category: 'DeFi', chainId: 8453,
            })}
          >pick-nofeed-output</button>
          <button
            data-testid="pick-feed-output"
            onClick={() => onSelect({
              address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC — feed-covered on Base
              symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: '', category: 'Stablecoin', chainId: 8453,
            })}
          >pick-feed-output</button>
        </>
      )}
    </div>
  ),
}))
vi.mock('@/components/BetaDisclaimer', () => ({ default: () => <div /> }))
vi.mock('./OrderReviewModal', () => ({ default: () => null }))
vi.mock('./OrderCancelReviewModal', () => ({ default: () => null }))

import { renderWithProviders, screen, fireEvent, waitFor } from '@/test-utils/render'
import DCAPanel from './DCAPanel'
import { floorTierHint, UNPRICED_FALLBACK } from './dca/pair-floor-info'
import { DCA_NO_PRICE_FILL_CAP_MAX_USD as MAX } from '@/lib/order-engine'

const ADDRESS = '0x1111111111111111111111111111111111111111'

beforeEach(() => {
  stubFloorEndpoint()
  vi.clearAllMocks()
  useAccountMock.mockReturnValue({ address: ADDRESS, isConnected: true })
  useChainIdMock.mockReturnValue(8453)
  // Chainlink-only probe says "no oracle" for everything — the old note would have fired on all three.
  checkOracleMock.mockResolvedValue({ hasOracle: false })
  checkRouteMock.mockResolvedValue({ routable: true })
  llamaMock.mockResolvedValue(null)
})

const HINT = 'dca-tier-hint'
const OFFCHAIN = 'Protected by executor price checks (no Chainlink feed registered yet)'

describe('DCAPanel BUY hint per tier [P3]', () => {
  it('onchain-feed (USDC, registered) → no hint', async () => {
    renderWithProviders(<DCAPanel />) // default buy = canonical USDC
    await new Promise(r => setTimeout(r, 450)) // past the old probe's 400ms debounce
    expect(screen.queryByTestId(HINT)).toBeNull()
    expect(document.body.textContent).not.toMatch(/no price oracle/i)
  })

  it('offchain-price (no feed, but a quorum price) → "Protected by executor price checks…"', async () => {
    llamaMock.mockResolvedValue({ price: 1, symbol: 'ETHFI', timestamp: 0, confidence: 1 })
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-nofeed-output'))
    const hint = await screen.findByTestId(HINT)
    expect(hint.textContent).toBe(OFFCHAIN)
    expect(hint.getAttribute('data-tier')).toBe('offchain-price')
    expect(document.body.textContent).not.toMatch(/no price oracle|best available DEX route/i)
  })

  it('unpriced (no feed, no price) → "No market price source right now — buys capped at $<max> and flagged"', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-nofeed-output'))
    const hint = await screen.findByTestId(HINT)
    expect(hint.textContent).toBe(`No market price source right now — buys capped at $${MAX} and flagged`)
    expect(hint.getAttribute('data-tier')).toBe('unpriced')
  })

  it('is informational — never blocks submit (the consent dialog still owns the decision)', async () => {
    renderWithProviders(<DCAPanel />)
    fireEvent.click(screen.getByTestId('pick-nofeed-output'))
    await screen.findByTestId(HINT)
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1' } })
    await waitFor(() => expect(screen.getByRole('button', { name: /Start DCA/i })).not.toBeDisabled())
  })
})

describe('floorTierHint', () => {
  const info = (tier: 'onchain-feed' | 'offchain-price' | 'unpriced', effectiveCap: number | null) =>
    ({ ...UNPRICED_FALLBACK, tier, effectiveCap })
  it('no answer yet / onchain-feed → null', () => {
    expect(floorTierHint(null)).toBeNull()
    expect(floorTierHint(info('onchain-feed', null))).toBeNull()
  })
  it('the cap follows the server value but never exceeds the ceiling; junk falls back to the ceiling', () => {
    expect(floorTierHint(info('unpriced', 75))).toBe('No market price source right now — buys capped at $75 and flagged')
    expect(floorTierHint(info('unpriced', MAX * 10))).toContain(`$${MAX} `)
    expect(floorTierHint(info('unpriced', null))).toContain(`$${MAX} `)
    expect(floorTierHint(info('unpriced', -5))).toContain(`$${MAX} `)
  })
  it('the fail-closed fallback reads as unpriced', () => {
    expect(floorTierHint(UNPRICED_FALLBACK)).toMatch(/^No market price source right now/)
  })
})
