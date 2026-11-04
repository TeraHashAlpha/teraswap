// @vitest-environment jsdom
/**
 * [ADR-025 / B8 C1] Portfolio holdings parity. v1's `PortfolioTab` and the v2 tab run on the REAL `usePortfolio()` (unchanged, v1's) over one
 * fixture per chain: wallet, RPC and API are fakes (`useAccount` / `useBalance` / `fetch`), nothing is signed or sent. Gates:
 *   - content parity v1 ⊆ v2, 0 missing — and, stronger, the SAME visible text nodes in the SAME order;
 *   - the total equals v1's, and equals an independent bigint computation of the fixture (cents), not a restatement of the hook;
 *   - grouping as v1 (category buckets in CATEGORY_DISPLAY_ORDER, then "Discovered in Wallet"), rows in v1's USD-desc / unpriced-last order;
 *   - imported tokens: Add → imports → the row rejoins the curated look (Swap, no address), as v1.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareContent, normalize, visibleTextNodes } from '../__tests__/content-parity'
import { CATEGORY_DISPLAY_ORDER } from '@/lib/tokens'
import { ERC20_BY_CHAIN, NATIVE_WEI, WALLET, expectedTotalCents, expectedTotalText, portfolioFetch } from './portfolio-harness'

const h = vi.hoisted(() => ({
  chainId: 1,
  connected: true,
  importToken: vi.fn(),
  push: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: h.connected ? '0xd44d00000000000000000000000000000000962d' : undefined, isConnected: h.connected, chain: { id: h.chainId } }),
  useBalance: () => ({ data: { value: 5n * 10n ** 17n, decimals: 18, symbol: 'ETH', formatted: '0.5' } }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isSuccess: false, isLoading: false }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/useChainId', () => ({ useActiveChainId: () => h.chainId }))
vi.mock('@/hooks/useTokenBalances', () => ({ useTokenBalances: () => ({ balances: new Map(), isLoading: false, isError: false }) }))
vi.mock('@/hooks/useTokenImport', () => ({ useTokenImport: () => ({ importToken: h.importToken }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }))

import V1PortfolioTab from '@/components/PortfolioTab'
import { PortfolioTab as V2PortfolioTab } from './PortfolioTab'

beforeEach(() => {
  h.connected = true
  h.importToken.mockReset()
  h.push.mockReset()
  vi.stubGlobal('fetch', portfolioFetch())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Render both tabs on the current fixture, wait until the prices landed (a numeric total), and return their roots. */
async function mount() {
  const v1 = render(<V1PortfolioTab onSwapToken={() => h.push('/swap')} />)
  const v2 = render(<V2PortfolioTab />)
  // Settled = BOTH tabs show the fully priced total (discovery lands after the first ETH-only price fetch, so "a number" is not enough).
  await waitFor(() => {
    expect(v2.container.querySelector('[data-testid="portfolio-total"]')?.textContent).toBe(expectedTotalText(h.chainId))
    expect(normalize(v1.container.textContent ?? '')).toContain(normalize(expectedTotalText(h.chainId)))
  }, { timeout: 8_000 }) // generous: the whole suite runs these files in parallel
  return { v1: v1.container as HTMLElement, v2: v2.container as HTMLElement }
}

describe.each([1, 8453, 42161])('Portfolio holdings — chain %i', (chainId) => {
  beforeEach(() => { h.chainId = chainId })

  it('content parity v1 ⊆ v2: 0 missing, and the same text nodes in the same order', async () => {
    const { v1, v2 } = await mount()
    const r = compareContent(v1, v2)
    console.log(`[parity chain ${chainId}] v1 text nodes: ${r.v1Nodes} · missing: ${r.missingText.length} · missing hrefs: ${r.missingHrefs.length}`)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(r.v1Nodes).toBeGreaterThan(8)
    expect(visibleTextNodes(v2)).toEqual(visibleTextNodes(v1))
  })

  it('the total equals v1\'s and an independent bigint computation of the fixture', async () => {
    const { v1, v2 } = await mount()
    const v2Total = v2.querySelector('[data-testid="portfolio-total"]')!.textContent
    expect(v2Total).toBe(expectedTotalText(chainId))
    expect(visibleTextNodes(v1)).toContain(normalize(expectedTotalText(chainId))) // v1's own total node, same text
    // exact: cents, from bigint balances × cent prices — equality, not closeness
    const cents = expectedTotalCents(chainId)
    expect(Number(v2Total!.replace(/[^\d.]/g, '')) * 100).toBe(Number(cents))
  })

  it('rows: same order (USD desc, unpriced last), same symbols, balances and USD as v1', async () => {
    const { v1, v2 } = await mount()
    const rows = Array.from(v2.querySelectorAll('[data-testid="holding-row"]'))
    const v2Rows = rows.map((r) => normalize(r.textContent ?? ''))
    // v1 rows are the bordered flex rows: those holding a Swap / Add control
    const v1Rows = Array.from(v1.querySelectorAll('button[aria-label^="Swap "], button[aria-label^="Add "]')).map((b) => normalize(b.closest('div.rounded-xl')!.textContent ?? ''))
    expect(v2Rows).toEqual(v1Rows)
    const symbols = rows.map((r) => r.querySelector('.font-semibold')!.textContent)
    expect(symbols.length).toBe(1 + ERC20_BY_CHAIN[chainId].length) // native ETH + every discovered token
    expect(NATIVE_WEI > 0n).toBe(true)
    // the unpriced token shows v1's "—" and sorts last
    if (ERC20_BY_CHAIN[chainId].some((t) => t.priceCents === null)) expect(rows[rows.length - 1].textContent).toContain('—')
    else expect(rows.some((r) => r.textContent?.includes('—'))).toBe(false)
  })

  it('grouping as v1: curated category buckets in CATEGORY_DISPLAY_ORDER, then "Discovered in Wallet"', async () => {
    const { v1, v2 } = await mount()
    const v2Labels = Array.from(v2.querySelectorAll('h3')).map((e) => e.textContent)
    const v1Labels = Array.from(v1.querySelectorAll('div.uppercase.tracking-\\[0\\.14em\\]')).map((e) => e.textContent)
    expect(v2Labels).toEqual(v1Labels)
    const cats = Array.from(v2.querySelectorAll('[data-testid="holdings-group"]')).map((g) => g.getAttribute('data-category') as never)
    const idx = (c: string) => CATEGORY_DISPLAY_ORDER.indexOf(c as never)
    expect([...cats].sort((a, b) => idx(a) - idx(b))).toEqual(cats)
    if (v2Labels.length > cats.length) expect(v2Labels[v2Labels.length - 1]).toBe('Discovered in Wallet')
  })

  it('Add imports the token and the row rejoins the curated look (Swap, no address) — as v1', async () => {
    const { v1, v2 } = await mount()
    const token = ERC20_BY_CHAIN[chainId].find((t) => t.symbol === 'ETHFI')
    if (!token) return // Arbitrum's fixture holds no unknown token
    h.importToken.mockResolvedValue({ address: token.address, symbol: 'ETHFI' })
    for (const root of [v1, v2]) {
      expect(within(root).getByLabelText('Add ETHFI to tokens')).toBeTruthy()
      fireEvent.click(within(root).getByLabelText('Add ETHFI to tokens'))
    }
    await waitFor(() => expect(within(v2).queryByLabelText('Add ETHFI to tokens')).toBeNull())
    await waitFor(() => expect(within(v1).queryByLabelText('Add ETHFI to tokens')).toBeNull())
    expect(h.importToken).toHaveBeenCalledTimes(2)
    expect(h.importToken).toHaveBeenNthCalledWith(1, token.address)
    expect(h.importToken).toHaveBeenNthCalledWith(2, token.address)
    expect(within(v2).getByLabelText('Swap ETHFI')).toBeTruthy()
    expect(visibleTextNodes(v2)).toEqual(visibleTextNodes(v1))
    // the still-un-imported unknown keeps its Add and its shortened address
    expect(within(v2).getByLabelText('Add SPAM to tokens')).toBeTruthy()
  })

  it('Swap goes to the Swap tab (v1: setSwapMode("instant")), carrying nothing else', async () => {
    const { v2 } = await mount()
    fireEvent.click(within(v2).getAllByLabelText(/^Swap /)[0])
    expect(h.push).toHaveBeenCalledWith('/swap')
  })
})

it('v2 shows no address for a name, only v1\'s shortened address on a discovered row', async () => {
  h.chainId = 1
  const { v2 } = await mount()
  const row = v2.querySelector('[data-token="0x6c240dda6b5c336df09a4d011139beaaa1ea2aa2"]')!
  expect(row.textContent).toContain('0x6c24…2aa2')
  const curated = v2.querySelector('[data-token="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]')!
  expect(curated.textContent).not.toMatch(/0x[0-9a-f]{4}…/i)
  expect(screen.queryAllByRole('link')).toEqual([]) // holdings link nowhere (v1 neither)
  void WALLET
})
