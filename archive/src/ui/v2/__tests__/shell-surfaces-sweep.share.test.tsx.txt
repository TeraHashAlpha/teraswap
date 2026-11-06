// @vitest-environment jsdom
/**
 * [S-1, A75b] Share text, swept: after a successful swap v1's SwapBox offers a Share button (SwapBox.tsx:1209) that opens a tweet
 * intent. Both trees run on the same mocked hooks; v1's button label and tweet text must each be in v2's (v1 text ⊆ v2, 0 missing).
 * The one ruled difference: v1 prints `saved 0.27%%` (fmtPct already ends in %, the template adds another - a v1 typo); v2 keeps one %
 * and does NOT copy the typo (content-map row "Share label %").
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_ORACLE, fixtureMeta, taggedFixture } from '../swap/test-fixtures'
import { compareContent, type AllowedRemoval } from './content-parity'

const noop = () => {}
const h = vi.hoisted(() => ({
  account: { address: '0xd44d00000000000000000000000000000000962d' as string | undefined, isConnected: true, chain: { id: 1 } as { id: number } | undefined },
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: () => {} },
  approval: {} as Record<string, unknown>,
  swap: {} as Record<string, unknown>,
  split: {} as Record<string, unknown>,
  log: [] as string[],
  toasts: [] as Record<string, unknown>[],
  dismissed: [] as string[],
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
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: () => ({ ...NO_ORACLE, chainlinkPrice: 2490 }) }))
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => ({ ethPrice: 2490, gasPriceGwei: 0.1, estimate: () => ({ eth: 0.000012, usd: 0.03 }) }) }))
vi.mock('@/hooks/useApproval', () => ({ useApproval: () => h.approval }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => ({ data: null, loading: false }) }))
vi.mock('@/hooks/useDepegCheck', () => ({ useDepegCheck: () => ({ mode: 'ok', divergence: 0, symbol: '', message: null }) }))
vi.mock('@/hooks/useSwap', () => ({ useSwap: () => h.swap }))
vi.mock('@/hooks/useSplitRoute', () => ({ useSplitRoute: () => ({ splitResult: null, analyzing: false, useSplit: false, toggleSplit: () => {} }) }))
vi.mock('@/hooks/useSplitSwap', () => ({ useSplitSwap: () => h.split }))
vi.mock('@/hooks/useSwapHistory', () => ({ useSwapHistory: () => ({ addRecord: () => {} }) }))
vi.mock('@/hooks/useActiveApprovals', () => ({ useActiveApprovals: () => ({ addApproval: () => {} }) }))
vi.mock('@/components/ActiveApprovals', () => ({ default: () => null }))
vi.mock('@/components/ParticleNetwork', () => ({ setParticleTurbo: () => {} }))
vi.mock('@/components/TokenSelector', () => ({ default: ({ selected }: { selected: { symbol: string } | null }) => <button type="button">{selected?.symbol}</button> }))
vi.mock('@/lib/analytics', () => ({ updateSwapStatus: () => {}, logQuoteToSupabase: () => {} }))
vi.mock('@/lib/wallet-activity-tracker', () => ({ trackWalletActivity: () => {} }))
// v1's toast provider and v2's both record into the same `h.toasts`; the tree under test decides which one is called.
vi.mock('@/components/ToastProvider', () => ({
  useToast: () => ({
    toast: (t: Record<string, unknown>) => {
      h.toasts.push({ ...t })
      return `t${h.toasts.length}`
    },
    dismiss: (id: string) => void h.dismissed.push(id),
  }),
}))
vi.mock('../shell/toasts', () => ({
  useV2Toast: () => ({
    toast: (t: Record<string, unknown>) => {
      h.toasts.push({ ...t })
      return `t${h.toasts.length}`
    },
    dismiss: (id: string) => void h.dismissed.push(id),
    update: () => {},
  }),
}))
vi.mock('@/lib/sounds', () => {
  const rec = (n: string) => () => void h.log.push(n)
  return { playQuoteReceived: () => {}, playTouchMP3: rec('touch'), playSwapConfirmMP3: rec('confirm'), playCancelOrderMP3: rec('cancel'), startWaitingSound: rec('wait+'), stopWaitingSound: rec('wait-') }
})

import SwapBox from '@/components/SwapBox'
import { SwapCard } from '../swap/SwapCard'

const READY = { plan: { method: 'exact', needsOnChainApprove: false, label: 'No approval needed', extraGas: 0 }, status: 'ready', error: null, isReady: true, needsPermit2Education: false, approve: async () => {}, confirmPermit2Education: noop, cancelPermit2Education: noop }
const swapHook = (over: Record<string, unknown> = {}) => ({
  status: 'idle', txHash: undefined, errorMessage: null, cowOrderUid: null, priceGuardBlocked: false, priceGuardDeviation: null, unpricedAckRequired: false, simulationPassed: null,
  simulationSkipped: false, fallbackNotice: null, pendingSwap: null, pendingCowOrder: null, mevSurplusActualWei: null, execute: vi.fn(), confirmSwap: vi.fn(), confirmCowOrder: vi.fn(), reset: vi.fn(), ...over,
})
const splitHook = (over: Record<string, unknown> = {}) => ({
  status: 'idle', legs: [], completedLegs: 0, totalLegs: 0, errorMessage: null, plannedLegs: [], unpricedAckRequired: false, execute: vi.fn(), confirmPlan: vi.fn(), reset: vi.fn(), ...over,
})
const TX = '0x8c1f000000000000000000000000000000000000000000000000000000c44b0'

beforeEach(() => {
  h.account = { address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }
  h.quote = { meta: taggedFixture(fixtureMeta(), '1'), loading: false, error: null, countdown: 12, refresh: noop }
  h.approval = { ...READY }
  h.swap = swapHook()
  h.split = splitHook()
  h.log = []
  h.toasts = []
  h.dismissed = []
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})


const typeAmount = (c: HTMLElement) => fireEvent.change(c.querySelector('input[inputmode="decimal"]') as HTMLInputElement, { target: { value: '1' } })

/** Mount a tree, settle a swap, press Share: returns the button's visible label and the tweet text it opens. */
function share(tree: 'v1' | 'v2', meta: unknown) {
  h.quote = { ...h.quote, meta }
  h.swap = swapHook()
  h.split = splitHook()
  h.approval = { ...READY }
  const open = vi.fn()
  vi.stubGlobal('open', open)
  const ui = () => (tree === 'v1' ? <SwapBox /> : <SwapCard />)
  const r = render(ui())
  typeAmount(r.container)
  h.swap = swapHook({ status: 'swapping' })
  r.rerender(ui())
  h.swap = swapHook({ status: 'success', txHash: TX })
  r.rerender(ui())
  const btn = screen.queryByRole('button', { name: /^share/i })
  const label = btn?.textContent?.trim() ?? null
  if (btn) fireEvent.click(btn)
  const url = open.mock.calls[0]?.[0] as string | undefined
  const text = url ? decodeURIComponent(url.split('?text=')[1]) : null
  cleanup()
  return { label, text }
}

describe('sweep · Swap · Share (v1 SwapBox.tsx button + tweet text)', () => {
  const PERCENT_TYPO: AllowedRemoval[] = [{ text: '%%', reason: 'v1 typo: fmtPct() already ends in %, the label template adds another; v2 keeps ONE % (content-map: "Share label %")' }]

  it('a comparison across sources with a saving: label and tweet text are v1\'s, bar the doubled %', () => {
    const v1 = share('v1', taggedFixture(fixtureMeta(), '1'))
    const v2 = share('v2', taggedFixture(fixtureMeta(), '1'))
    expect(v1.label).toMatch(/^Share — saved \d[\d.,]*%%$/) // the v1 typo is real today; if v1 fixes it, the allow-list entry goes stale and fails
    expect(v2.label).toMatch(/^Share — saved \d[\d.,]*%$/)
    const page = (x: { label: string | null; text: string | null }) => {
      const d = document.createElement('div')
      for (const t of [x.label, x.text]) d.appendChild(document.createElement('p')).textContent = t
      return d
    }
    const r = compareContent(page(v1), page(v2), PERCENT_TYPO)
    expect(r.v1Nodes).toBe(2)
    expect(r.missingText).toEqual([])
    expect(r.staleAllow).toEqual([])
    expect(v2.text).toBe(v1.text) // byte-identical tweet
  })

  it('a tie / no saving: "Share swap" and the plain tweet', () => {
    const m = fixtureMeta()
    const tie = taggedFixture({ ...m, all: [m.best, m.best] }, '1')
    const v1 = share('v1', tie)
    const v2 = share('v2', tie)
    expect(v1.label).toBe('Share swap')
    expect(v2.label).toBe(v1.label)
    expect(v2.text).toBe(v1.text)
  })
})
