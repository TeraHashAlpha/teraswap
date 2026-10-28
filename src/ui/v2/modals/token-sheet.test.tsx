// @vitest-environment jsdom
/**
 * [ADR-025] Frame 23 / m02 — the token selector sheet. v1's hooks are NOT mocked except at the wallet boundary: the real
 * useTokenImport reads the contract over a fake /api/rpc, the real custom-token store persists to localStorage per chain
 * (#607), and v1's own TokenSelector is rendered next to the sheet to prove the lists are the same lists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  chainId: 1,
  balances: new Map<string, { raw: bigint; formatted: string }>(),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111', isConnected: true, chain: { id: h.chainId, name: 'chain' } }),
  useBalance: () => ({ data: undefined }),
  useReadContracts: () => ({ data: [] }),
}))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => h.chainId, useActiveChainId: () => h.chainId }))
vi.mock('@/hooks/useTokenBalances', () => ({ useTokenBalances: () => ({ balances: h.balances }) }))

const KEY = (chainId: number) => `ts:imported-tokens:v1:${chainId}`
const TOKEN = '0x00000000000000000000000000000000000c0de1' // synthetic, never a real token

const SEL = { symbol: '0x95d89b41', name: '0x06fdde03', decimals: '0x313ce567' }
const abiString = (v: string) => '0x' + (32).toString(16).padStart(64, '0') + v.length.toString(16).padStart(64, '0') + Buffer.from(v, 'utf8').toString('hex').padEnd(64, '0')
const abiUint = (n: number) => '0x' + n.toString(16).padStart(64, '0')

let behaviour: 'token' | 'empty' | 'down' = 'token'
let tokenSymbol = 'TESTTOK'
function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (behaviour === 'down') throw new TypeError('Failed to fetch')
      const data: string = JSON.parse(String(init?.body ?? '{}'))?.params?.[0]?.data ?? ''
      let result = '0x'
      if (behaviour === 'token') {
        if (data === SEL.symbol) result = abiString(tokenSymbol)
        else if (data === SEL.name) result = abiString('Test Token')
        else if (data === SEL.decimals) result = abiUint(18)
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
}

/** A fresh page load: new module graph (and React), same localStorage. */
async function freshSheet(extra: { disabledAddress?: string } = {}) {
  vi.resetModules()
  const rtl = await import('@testing-library/react')
  const { TokenSheet } = await import('./TokenSheet')
  const onSelect = vi.fn()
  const onClose = vi.fn()
  rtl.render(<TokenSheet onSelect={onSelect} onClose={onClose} {...extra} />)
  return { ...rtl, onSelect, onClose }
}
type App = Awaited<ReturnType<typeof freshSheet>>

const search = (app: App, v: string) => app.fireEvent.change(app.screen.getByLabelText(/Search name, symbol or paste address/), { target: { value: v } })
const rowSymbols = (root: ParentNode = document) => Array.from(root.querySelectorAll('[data-token-row] .ts-token-sym')).map((e) => e.textContent)

beforeEach(() => {
  h.chainId = 1
  h.balances = new Map()
  behaviour = 'token'
  tokenSymbol = 'TESTTOK'
  localStorage.clear()
  installFetch()
})
afterEach(async () => {
  const { cleanup } = await import('@testing-library/react')
  cleanup()
  vi.unstubAllGlobals()
})

describe('browse (23)', () => {
  it('title, ✕, an underline search with v1 placeholder, category chips, popular quick-selects — no "All" chip', async () => {
    const app = await freshSheet()
    expect(app.screen.getByRole('dialog', { name: 'Select token' })).toBeTruthy()
    expect(app.screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    const input = app.screen.getByPlaceholderText('Search name, symbol or paste address...') as HTMLInputElement
    expect(input.className).toContain('ts-v2-input') // underline input
    expect(document.activeElement).toBe(input) // the search field takes focus
    const cats = app.screen.getByRole('group', { name: 'Filter tokens by category' })
    expect(cats.textContent).not.toMatch(/\bAll\b/)
    expect(cats.querySelectorAll('button').length).toBeGreaterThan(2)
    expect(document.querySelector('[data-popular]')?.textContent).toContain('USDC')
  })

  it('rows are hairline-separated list items — no row boxes, no radius', async () => {
    await freshSheet()
    const rows = document.querySelectorAll('[data-token-list] li')
    expect(rows.length).toBeGreaterThan(5)
    for (const li of Array.from(rows).slice(0, 12)) {
      expect(li.className).toContain('ts-sheet-row')
      expect(li.className + (li.firstElementChild?.className ?? '')).not.toMatch(/rounded|border |bg-|shadow/)
    }
  })

  it('a category chip filters the list; a second press clears it (v1 toggle)', async () => {
    const app = await freshSheet()
    const before = rowSymbols().length
    const chip = app.screen.getByRole('group', { name: 'Filter tokens by category' }).querySelector('button') as HTMLButtonElement
    app.fireEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(rowSymbols().length).toBeLessThan(before)
    app.fireEvent.click(chip)
    expect(rowSymbols().length).toBe(before)
  })

  it('connected balances: "Your Tokens" first, balance on the row, highest raw first; none → no heading', async () => {
    const { findToken } = await import('@/lib/tokens')
    const usdc = findToken('USDC')!
    const eth = findToken('ETH')!
    h.balances = new Map([
      [eth.address.toLowerCase(), { raw: 10n, formatted: '0.0014' }],
      [usdc.address.toLowerCase(), { raw: 5_000_000n, formatted: '5' }],
    ])
    const app = await freshSheet()
    expect(app.screen.getByText('Your Tokens')).toBeTruthy()
    const first = document.querySelector('[data-token-list] li') as HTMLElement
    expect(first.textContent).toContain('USDC')
    expect(first.textContent).toContain('5')
    expect(rowSymbols().indexOf('ETH')).toBe(1)
    app.cleanup()
    h.balances = new Map()
    const bare = await freshSheet()
    expect(bare.screen.queryByText('Your Tokens')).toBeNull()
  })

  it('every row carries a short address (copyable); the native asset says so', async () => {
    const app = await freshSheet()
    const ethRow = document.querySelector('[data-token-list] li') as HTMLElement
    expect(app.screen.getAllByLabelText(/Copy .* contract address/).length).toBeGreaterThan(3)
    expect(Array.from(document.querySelectorAll('[data-token-list] li')).some((li) => li.textContent?.includes('Native asset'))).toBe(true)
    expect(ethRow).toBeTruthy()
  })

  it('never lists the token already on the other side', async () => {
    const { findToken } = await import('@/lib/tokens')
    const usdc = findToken('USDC')!
    await freshSheet({ disabledAddress: usdc.address })
    expect(rowSymbols()).not.toContain('USDC')
    expect(document.querySelector('[data-popular]')?.textContent).not.toContain('USDC')
  })

  it('choosing a row selects it and closes the sheet', async () => {
    const app = await freshSheet()
    const row = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-token-row]')).find((b) => b.textContent?.startsWith('USDC'))!
    app.fireEvent.click(row)
    expect(app.onSelect).toHaveBeenCalledTimes(1)
    expect(app.onSelect.mock.calls[0][0]).toMatchObject({ symbol: 'USDC' })
    expect(app.onClose).toHaveBeenCalledTimes(1)
  })
})

describe('search (symbol, name, address)', () => {
  it('by symbol, with the v1 result count and exact-symbol-first ranking', async () => {
    const app = await freshSheet()
    search(app, 'usdc')
    expect(rowSymbols()[0]).toBe('USDC')
    expect(app.screen.getByText(/^\d+ results?$|^first \d+ results — refine to narrow$/)).toBeTruthy()
  })

  it('by name', async () => {
    const app = await freshSheet()
    search(app, 'tether')
    expect(rowSymbols()).toContain('USDT')
  })

  it('by address', async () => {
    const { findToken } = await import('@/lib/tokens')
    const dai = findToken('DAI')!
    const app = await freshSheet()
    search(app, dai.address)
    expect(rowSymbols()).toEqual(['DAI'])
  })

  it('no match: "No tokens found" and the paste-an-address hint (v1 copy)', async () => {
    const app = await freshSheet()
    search(app, 'zzzzqq')
    expect(app.screen.getByText('No tokens found')).toBeTruthy()
    expect(app.screen.getByText('Paste a contract address to import any ERC-20 token')).toBeTruthy()
  })

  it('parity: the same lists as v1 TokenSelector — browse and three searches', async () => {
    const { findToken } = await import('@/lib/tokens')
    const eth = findToken('ETH')!
    h.balances = new Map([[eth.address.toLowerCase(), { raw: 10n, formatted: '0.0014' }]])
    const rtl = await import('@testing-library/react')
    const { default: TokenSelector } = await import('@/components/TokenSelector')
    const { TokenSheet } = await import('./TokenSheet')
    const v1Symbols = () => Array.from(document.querySelectorAll('div.text-cream-gold')).map((e) => e.textContent)
    const results: Array<[string, (string | null)[], (string | null)[]]> = []
    for (const q of ['', 'usd', 'eth', 'wrapped']) {
      const a = rtl.render(<TokenSelector selected={null} onSelect={() => {}} />)
      rtl.fireEvent.click(a.getByText('Select'))
      if (q) rtl.fireEvent.change(a.getByPlaceholderText(/Search name, symbol/), { target: { value: q } })
      const v1 = v1Symbols()
      a.unmount()
      const b = rtl.render(<TokenSheet onSelect={() => {}} onClose={() => {}} />)
      if (q) rtl.fireEvent.change(b.getByLabelText(/Search name, symbol or paste address/), { target: { value: q } })
      const v2 = rowSymbols()
      b.unmount()
      results.push([q, v1, v2])
    }
    for (const [, v1, v2] of results) {
      expect(v1.length).toBeGreaterThan(0)
      expect(v2).toEqual(v1)
    }
  })
})

describe('import (v1 useTokenImport) · persist per chain (#607) · Imported badge · Remove', () => {
  it('paste an unknown address → v1 notice → Import → selected, closed, saved under the versioned per-chain key', async () => {
    const app = await freshSheet()
    search(app, TOKEN)
    expect(app.screen.getByText('Token not in list')).toBeTruthy()
    expect(app.screen.getByText(/You are importing a token not in TeraSwap's default list\. Anyone can create a token using any symbol or name\. Verify the contract address matches the official source\./)).toBeTruthy()
    app.fireEvent.click(app.screen.getByRole('button', { name: 'Import token' }))
    await app.waitFor(() => expect(app.onSelect).toHaveBeenCalledTimes(1))
    expect(app.onSelect.mock.calls[0][0]).toMatchObject({ symbol: 'TESTTOK', name: 'Test Token', decimals: 18, chainId: 1 })
    expect(app.onClose).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(localStorage.getItem(KEY(1))!)
    expect(stored).toHaveLength(1)
    expect(stored[0].address.toLowerCase()).toBe(TOKEN)
    expect(localStorage.getItem(KEY(8453))).toBeNull() // per chain
  })

  it('after a reload the import is listed with an Imported badge and a Remove; Remove deletes it from the list and storage', async () => {
    const first = await freshSheet()
    search(first, TOKEN)
    first.fireEvent.click(first.screen.getByRole('button', { name: 'Import token' }))
    await first.waitFor(() => expect(first.onSelect).toHaveBeenCalled())
    first.cleanup()

    const app = await freshSheet() // new module graph — only localStorage survived
    await app.waitFor(() => expect(rowSymbols()).toContain('TESTTOK'))
    const row = document.querySelector(`[data-token="${TOKEN}"]`) as HTMLElement
    expect(row.textContent).toContain('Imported')
    app.fireEvent.click(app.screen.getByRole('button', { name: 'Remove TESTTOK' }))
    await app.waitFor(() => expect(rowSymbols()).not.toContain('TESTTOK'))
    expect(JSON.parse(localStorage.getItem(KEY(1)) ?? '[]')).toHaveLength(0)
  })

  it('an import is only listed on its own chain', async () => {
    const first = await freshSheet()
    search(first, TOKEN)
    first.fireEvent.click(first.screen.getByRole('button', { name: 'Import token' }))
    await first.waitFor(() => expect(first.onSelect).toHaveBeenCalled())
    first.cleanup()
    h.chainId = 8453
    const base = await freshSheet()
    expect(rowSymbols()).not.toContain('TESTTOK')
    base.cleanup()
  })

  it('a symbol that collides with a listed token gets the full address, an explorer link and v1\'s warning', async () => {
    tokenSymbol = 'USDC'
    const first = await freshSheet()
    search(first, TOKEN)
    first.fireEvent.click(first.screen.getByRole('button', { name: 'Import token' }))
    await first.waitFor(() => expect(first.onSelect).toHaveBeenCalled())
    first.cleanup()
    const app = await freshSheet()
    await app.waitFor(() => expect(document.querySelector(`[data-token="${TOKEN}"]`)).not.toBeNull())
    const row = document.querySelector(`[data-token="${TOKEN}"]`) as HTMLElement
    expect(row.textContent).toContain('Same symbol as a listed token — verify the contract address')
    expect(row.querySelector('[data-address]')?.textContent?.toLowerCase()).toBe(TOKEN) // full, not shortened
    expect(row.querySelector('a[href*="/token/"]')).not.toBeNull()
    // a clean (non-colliding) listed row stays short
    const plain = Array.from(document.querySelectorAll<HTMLElement>('[data-token-list] li')).find((li) => li.textContent?.includes('Tether'))
    expect(plain?.querySelector('[data-address]')?.textContent).toMatch(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/)
  })

  it('not an ERC-20 → v1 message; RPC down → the read-failure message (never "invalid token")', async () => {
    behaviour = 'empty'
    const a = await freshSheet()
    search(a, TOKEN)
    a.fireEvent.click(a.screen.getByRole('button', { name: 'Import token' }))
    expect(await a.screen.findByText('Not a valid ERC-20 token')).toBeTruthy()
    expect(a.onSelect).not.toHaveBeenCalled()
    a.cleanup()
    behaviour = 'down'
    const b = await freshSheet()
    search(b, TOKEN)
    b.fireEvent.click(b.screen.getByRole('button', { name: 'Import token' }))
    expect(await b.screen.findByText('Network error — could not read this contract. Please try again.')).toBeTruthy()
    expect(b.screen.queryByText('Not a valid ERC-20 token')).toBeNull()
  })

  it('an invalid address string is not offered for import', async () => {
    const app = await freshSheet()
    search(app, '0x1234')
    expect(app.screen.queryByRole('button', { name: 'Import token' })).toBeNull()
    expect(app.screen.getByText('No tokens found')).toBeTruthy()
  })
})

describe('keyboard', () => {
  it('ArrowDown from the search field enters the rows; arrows walk them; ArrowUp from the first returns to the field; Home / End jump', async () => {
    const app = await freshSheet()
    const input = app.screen.getByLabelText(/Search name, symbol or paste address/)
    const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-token-row]'))
    expect(document.activeElement).toBe(input)
    app.fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows()[0])
    app.fireEvent.keyDown(rows()[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows()[1])
    app.fireEvent.keyDown(rows()[1], { key: 'End' })
    expect(document.activeElement).toBe(rows()[rows().length - 1])
    app.fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' })
    expect(document.activeElement).toBe(rows()[0])
    app.fireEvent.keyDown(rows()[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(input)
  })

  it('the focused row is a button: Enter / Space activate it (selects + closes)', async () => {
    const app = await freshSheet()
    const input = app.screen.getByLabelText(/Search name, symbol or paste address/)
    app.fireEvent.keyDown(input, { key: 'ArrowDown' })
    const focused = document.activeElement as HTMLButtonElement
    expect(focused.tagName).toBe('BUTTON')
    app.fireEvent.click(focused) // what the browser dispatches for Enter / Space on a button
    expect(app.onSelect).toHaveBeenCalledTimes(1)
  })

  it('Esc closes the sheet', async () => {
    const app = await freshSheet()
    app.fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(app.onClose).toHaveBeenCalledTimes(1)
  })
})
