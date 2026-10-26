// @vitest-environment jsdom
/**
 * [fix/imported-tokens-persist] Selector hygiene for saved imports:
 *   1. An import can never shadow a catalog token with the same address — dedupe by lower-cased
 *      address, CATALOG WINS (browse list, search, and the paste-an-address path).
 *   2. An import whose symbol collides with a catalog token's symbol gets the full-address badge
 *      plus a warning, so a lookalike "USDC" cannot pass for the real one.
 *
 * Saved imports are seeded straight into localStorage (the schema is the contract), then a fresh
 * module graph is mounted — see TokenSelector.imported.test.tsx for the reload mechanics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: '0x1111111111111111111111111111111111111111',
    isConnected: true,
    chain: { id: 8453, name: 'base' },
  }),
  useBalance: () => ({ data: undefined, isLoading: false, isError: false }),
  useReadContracts: () => ({ data: [], isLoading: false, isError: false }),
}))

// Expose the props the hygiene rule is about.
vi.mock('./TokenAddressBadge', () => ({
  default: ({ address, size, showExplorerLink }: { address: string; size?: string; showExplorerLink?: boolean }) => (
    <div data-testid="address-badge" data-size={size} data-explorer={String(!!showExplorerLink)}>
      {address}
    </div>
  ),
}))

const BASE = 8453
const KEY = `ts:imported-tokens:v1:${BASE}`
const FRESH = '0x00000000000000000000000000000000000c0de2' // synthetic — not a real token

const SEL = { symbol: '0x95d89b41', decimals: '0x313ce567' }
const abiString = (v: string) => {
  const hex = Buffer.from(v, 'utf8').toString('hex')
  return '0x' + (32).toString(16).padStart(64, '0') + v.length.toString(16).padStart(64, '0') + hex.padEnd(64, '0')
}

// Every saved import re-validates OK (symbol answers, decimals 18) so nothing is flagged unavailable.
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const data: string = JSON.parse(String(init?.body ?? '{}'))?.params?.[0]?.data ?? ''
      const result = data === SEL.symbol ? abiString('ANY') : data === SEL.decimals ? '0x' + (18).toString(16).padStart(64, '0') : '0x'
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

const record = (address: string, symbol: string, name = `${symbol} Token`) => ({
  address,
  symbol,
  name,
  decimals: 18,
  importedAt: 1_700_000_000_000,
})

async function freshApp() {
  vi.resetModules()
  const rtl = await import('@/test-utils/render')
  const { default: TokenSelector } = await import('./TokenSelector')
  const { getChainTokenList, getFullCatalog } = await import('@/lib/chains/tokens')
  const onSelect = vi.fn()
  rtl.renderWithProviders(<TokenSelector selected={null} onSelect={onSelect} />)
  rtl.fireEvent.click(rtl.screen.getByText('Select'))
  return { ...rtl, onSelect, getChainTokenList, getFullCatalog }
}
type App = Awaited<ReturnType<typeof freshApp>>

const search = (app: App, value: string) =>
  app.fireEvent.change(app.screen.getByPlaceholderText(/search name, symbol/i), { target: { value } })

/** A catalog token on Base, read from the catalog itself — addresses are never typed here. */
const catalogToken = (app: App, symbol: string) => {
  const t = app.getChainTokenList(BASE).find((x) => x.symbol === symbol)
  if (!t) throw new Error(`${symbol} missing from the Base catalog fixture`)
  return t
}

describe('catalog wins on a shared address', () => {
  it('a saved import at a catalog address is not listed (browse), the catalog entry stays, the record is kept', async () => {
    // Boot once just to read a real catalog address, then seed an import at its lower-cased form.
    const probe = await freshApp()
    const usdc = catalogToken(probe, 'USDC')
    probe.cleanup()
    localStorage.setItem(KEY, JSON.stringify([record(usdc.address.toLowerCase(), 'FAKEUSDC')]))

    const app = await freshApp()
    expect(app.screen.queryByText('FAKEUSDC')).toBeNull()
    expect(app.screen.queryByRole('button', { name: /^Remove / })).toBeNull()
    expect(app.screen.getAllByText('USDC').length).toBeGreaterThan(0) // the catalog token is still there
    // Not deleted: if the catalog ever drops this address, the user's import resurfaces.
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(1)
  })

  it('…and not in search results either; selecting by address returns the CATALOG token', async () => {
    const probe = await freshApp()
    const usdc = catalogToken(probe, 'USDC')
    probe.cleanup()
    localStorage.setItem(KEY, JSON.stringify([record(usdc.address.toLowerCase(), 'FAKEUSDC')]))

    const app = await freshApp()
    search(app, 'fakeusdc')
    expect(await app.screen.findByText('No tokens found')).toBeInTheDocument()

    search(app, usdc.address.toLowerCase())
    const rows = await app.screen.findAllByTestId('address-badge')
    expect(rows).toHaveLength(1) // exactly one row for that address — no import twin
    app.fireEvent.click(app.screen.getByText('USDC'))
    expect(app.onSelect).toHaveBeenCalledTimes(1)
    expect(app.onSelect.mock.calls[0][0]).toMatchObject({ symbol: 'USDC', address: usdc.address })
  })

  it('pasting a catalog address never creates an import (nothing written to storage)', async () => {
    const probe = await freshApp()
    const usdc = catalogToken(probe, 'USDC')
    probe.cleanup()

    const app = await freshApp()
    search(app, usdc.address.toUpperCase().replace('0X', '0x'))
    expect(app.screen.queryByText('Import token')).toBeNull()
    app.fireEvent.click(await app.screen.findByText('USDC'))
    expect(app.onSelect.mock.calls[0][0].address).toBe(usdc.address)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('an import at a NON-catalog address is listed once (no duplicates from re-saving)', async () => {
    localStorage.setItem(KEY, JSON.stringify([record(FRESH, 'ONLYME'), record(FRESH.toUpperCase().replace('0X', '0x'), 'ONLYME')]))
    const app = await freshApp()
    expect(await app.screen.findAllByText('ONLYME')).toHaveLength(1)
  })
})

describe('symbol collision with a catalog token', () => {
  it('shows the full-address badge + warning on the colliding import only', async () => {
    const probe = await freshApp()
    const usdc = catalogToken(probe, 'USDC')
    probe.cleanup()
    localStorage.setItem(KEY, JSON.stringify([record(FRESH, usdc.symbol, 'Lookalike Coin'), record('0x00000000000000000000000000000000000c0de3', 'UNIQUEX')]))

    const app = await freshApp()
    await app.screen.findByText('Lookalike Coin')

    // Exactly one warning, and it sits in the colliding row.
    const warning = app.screen.getByText(/Same symbol as a listed token/)
    const collidingRow = app.screen.getByText('Lookalike Coin').closest('button')!
    expect(collidingRow).toContainElement(warning)

    const { within } = app
    const badgeOf = (row: HTMLElement) => within(row).getByTestId('address-badge')
    expect(badgeOf(collidingRow).textContent!.toLowerCase()).toBe(FRESH)
    expect(badgeOf(collidingRow).dataset.size).toBe('md')
    expect(badgeOf(collidingRow).dataset.explorer).toBe('true')

    // A non-colliding import keeps the compact badge and no warning.
    const plainRow = app.screen.getByText('UNIQUEX').closest('button')!
    expect(plainRow).not.toHaveTextContent(/Same symbol/)
    expect(badgeOf(plainRow).dataset.size).toBe('sm')
    expect(badgeOf(plainRow).dataset.explorer).toBe('false')
  })

  it('the collision check is case-insensitive', async () => {
    const probe = await freshApp()
    const usdc = catalogToken(probe, 'USDC')
    probe.cleanup()
    localStorage.setItem(KEY, JSON.stringify([record(FRESH, usdc.symbol.toLowerCase(), 'Lowercase Lookalike')]))

    const app = await freshApp()
    const row = (await app.screen.findByText('Lowercase Lookalike')).closest('button')!
    expect(row).toHaveTextContent(/Same symbol as a listed token/)
  })

  it('catalog rows never get the collision warning', async () => {
    const app = await freshApp()
    expect(app.screen.queryByText(/Same symbol as a listed token/)).toBeNull()
  })
})
