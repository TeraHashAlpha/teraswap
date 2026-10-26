// @vitest-environment jsdom
/**
 * [fix/imported-tokens-persist] Owner rule: a token imported by address NEVER disappears on reload
 * or a new visit — it stays in this browser, per chain, until the user removes it.
 *
 * A "reload" here is `vi.resetModules()` + fresh dynamic imports of React and the app: every
 * module-level store (lib/tokens customTokens, the probe guard) is rebuilt empty, exactly like a
 * new page load, while jsdom's localStorage — the thing under test — survives. The wallet/network
 * are mocked at the boundary (wagmi hooks, global fetch → /api/rpc); no wallet is ever connected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Chain the mocked wallet reports. Mutable so a test can "visit" another chain.
const mockChain = vi.hoisted(() => ({ id: 8453 }))

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: '0x1111111111111111111111111111111111111111',
    isConnected: true,
    chain: { id: mockChain.id, name: 'chain' },
  }),
  useBalance: () => ({ data: undefined, isLoading: false, isError: false }),
  useReadContracts: () => ({ data: [], isLoading: false, isError: false }),
}))

vi.mock('./TokenAddressBadge', () => ({
  default: ({ address }: { address: string }) => <div data-testid="address-badge">{address}</div>,
}))

const KEY = (chainId: number) => `ts:imported-tokens:v1:${chainId}`

// Synthetic contract addresses (never a real token).
const TOKEN = '0x00000000000000000000000000000000000c0de1'
const TOKEN_ADDR_LOWER = TOKEN.toLowerCase()

// ── fake /api/rpc ────────────────────────────────────────────────────────────
const SEL = { symbol: '0x95d89b41', name: '0x06fdde03', decimals: '0x313ce567' }
const abiString = (v: string) => {
  const hex = Buffer.from(v, 'utf8').toString('hex')
  return '0x' + (32).toString(16).padStart(64, '0') + v.length.toString(16).padStart(64, '0') + hex.padEnd(64, '0')
}
const abiUint = (n: number) => '0x' + n.toString(16).padStart(64, '0')

type Behaviour = 'token' | 'empty' | 'down'
let behaviour: Behaviour = 'token'
let rpcCalls: string[] = []

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      rpcCalls.push(url)
      if (behaviour === 'down') throw new TypeError('Failed to fetch')
      const data: string = JSON.parse(String(init?.body ?? '{}'))?.params?.[0]?.data ?? ''
      let result = '0x'
      if (behaviour === 'token') {
        if (data === SEL.symbol) result = abiString('TESTTOK')
        else if (data === SEL.name) result = abiString('Test Token')
        else if (data === SEL.decimals) result = abiUint(18)
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
}

/** A fresh "page load": new module graph (incl. React), same localStorage. */
async function freshApp(chainId: number) {
  mockChain.id = chainId
  vi.resetModules()
  const rtl = await import('@/test-utils/render')
  const { default: TokenSelector } = await import('./TokenSelector')
  const onSelect = vi.fn()
  const view = rtl.renderWithProviders(<TokenSelector selected={null} onSelect={onSelect} />)
  return { ...rtl, view, onSelect }
}

type App = Awaited<ReturnType<typeof freshApp>>

const open = (app: App) => app.fireEvent.click(app.screen.getByText('Select'))

/** Import TOKEN through the real UI + real useTokenImport (fetch mocked), then close the app. */
async function importViaUi(chainId: number) {
  behaviour = 'token'
  const app = await freshApp(chainId)
  open(app)
  app.fireEvent.change(app.screen.getByPlaceholderText(/search name, symbol/i), { target: { value: TOKEN } })
  app.fireEvent.click(await app.screen.findByText('Import token'))
  await app.waitFor(() => expect(app.onSelect).toHaveBeenCalledTimes(1))
  expect(app.onSelect.mock.calls[0][0]).toMatchObject({ symbol: 'TESTTOK', decimals: 18, chainId })
  app.cleanup()
}

beforeEach(() => {
  localStorage.clear()
  behaviour = 'token'
  rpcCalls = []
  installFetch()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('imported tokens survive a reload (per chain)', () => {
  it('import → persisted with the exact schema under the versioned per-chain key', async () => {
    await importViaUi(8453)
    const stored = JSON.parse(localStorage.getItem(KEY(8453))!)
    expect(stored).toHaveLength(1)
    expect(Object.keys(stored[0]).sort()).toEqual(['address', 'decimals', 'importedAt', 'name', 'symbol'])
    expect(stored[0]).toMatchObject({ symbol: 'TESTTOK', name: 'Test Token', decimals: 18 })
    expect(stored[0].address.toLowerCase()).toBe(TOKEN_ADDR_LOWER)
    expect(localStorage.getItem(KEY(1))).toBeNull()
  })

  it('import → reload: the token is in the list and selectable on that chain', async () => {
    await importViaUi(8453)

    const app = await freshApp(8453) // brand-new module graph; only localStorage carried over
    open(app)
    // Browse list (no search): the saved import is there, with the imported ⚠ badge address row.
    const symbol = await app.screen.findByText('TESTTOK')
    expect(app.screen.getAllByTestId('address-badge').some((b) => b.textContent!.toLowerCase() === TOKEN_ADDR_LOWER)).toBe(true)

    app.fireEvent.click(symbol)
    expect(app.onSelect).toHaveBeenCalledTimes(1)
    expect(app.onSelect.mock.calls[0][0]).toMatchObject({
      symbol: 'TESTTOK',
      decimals: 18,
      chainId: 8453,
      category: 'Imported',
    })
    expect(app.onSelect.mock.calls[0][0].address.toLowerCase()).toBe(TOKEN_ADDR_LOWER)
    // Not a chain-reading side effect of merely listing it: re-validation went to Base's proxy.
    expect(rpcCalls.length).toBeGreaterThan(0)
    expect(rpcCalls.every((u) => u === '/api/rpc?chainId=8453')).toBe(true)
  })

  it('is findable by search after a reload and carries a Remove action', async () => {
    await importViaUi(8453)
    const app = await freshApp(8453)
    open(app)
    app.fireEvent.change(app.screen.getByPlaceholderText(/search name, symbol/i), { target: { value: 'testtok' } })
    expect(await app.screen.findByText('TESTTOK')).toBeInTheDocument()
    expect(app.screen.getByRole('button', { name: 'Remove TESTTOK' })).toBeInTheDocument()
  })

  it('is ABSENT on another chain, and a catalog token row has no Remove', async () => {
    await importViaUi(8453)

    const mainnet = await freshApp(1)
    open(mainnet)
    expect(mainnet.screen.queryByText('TESTTOK')).toBeNull()
    expect(mainnet.screen.queryByRole('button', { name: /^Remove / })).toBeNull()
    mainnet.cleanup()

    const arb = await freshApp(42161)
    open(arb)
    expect(arb.screen.queryByText('TESTTOK')).toBeNull()
    // …and the Base entry is untouched by having visited the others.
    expect(JSON.parse(localStorage.getItem(KEY(8453))!)).toHaveLength(1)
  })

  it('does not spend RPC on other chains\' imports', async () => {
    await importViaUi(8453)
    rpcCalls = []
    const mainnet = await freshApp(1)
    open(mainnet)
    await Promise.resolve()
    expect(rpcCalls).toEqual([])
  })
})

describe('corrupt / hostile storage', () => {
  it.each([
    ['unparseable', '{not json'],
    ['wrong shape', '{"tokens":[]}'],
    ['junk entries', '[1,null,"x",{"address":"0xnope"}]'],
  ])('%s → ignored, no crash, selector still works', async (_label, raw) => {
    localStorage.setItem(KEY(8453), raw)
    const app = await freshApp(8453)
    open(app)
    expect(app.screen.getByText(/Select token/i)).toBeInTheDocument()
    expect(app.screen.queryByRole('button', { name: /^Remove / })).toBeNull()
    // Catalog browsing is unaffected.
    expect(app.screen.getAllByText('USDC').length).toBeGreaterThan(0)
  })

  it('a throwing localStorage degrades to "not persisted" without crashing', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    const app = await freshApp(8453)
    open(app)
    app.fireEvent.change(app.screen.getByPlaceholderText(/search name, symbol/i), { target: { value: TOKEN } })
    app.fireEvent.click(await app.screen.findByText('Import token'))
    // The import itself still works for this session even though it could not be saved.
    await app.waitFor(() => expect(app.onSelect).toHaveBeenCalledTimes(1))
    vi.restoreAllMocks()
  })
})

describe('Remove', () => {
  it('Remove deletes it from the list and from storage, and it stays gone after a reload', async () => {
    await importViaUi(8453)

    const app = await freshApp(8453)
    open(app)
    await app.screen.findByText('TESTTOK')
    app.fireEvent.click(app.screen.getByRole('button', { name: 'Remove TESTTOK' }))
    expect(app.screen.queryByText('TESTTOK')).toBeNull()
    expect(localStorage.getItem(KEY(8453))).toBeNull()
    expect(app.onSelect).not.toHaveBeenCalled() // Remove must not also select the row
    app.cleanup()

    const again = await freshApp(8453)
    open(again)
    expect(again.screen.queryByText('TESTTOK')).toBeNull()
  })

  it('removing on one chain leaves the same address saved on another chain alone', async () => {
    await importViaUi(8453)
    await importViaUi(1)
    expect(localStorage.getItem(KEY(1))).not.toBeNull()

    const app = await freshApp(8453)
    open(app)
    await app.screen.findByText('TESTTOK')
    app.fireEvent.click(app.screen.getByRole('button', { name: 'Remove TESTTOK' }))
    expect(localStorage.getItem(KEY(8453))).toBeNull()
    expect(JSON.parse(localStorage.getItem(KEY(1))!)).toHaveLength(1)
  })
})

describe('lazy re-validation — never silently drops', () => {
  it('chain answers with no code → kept, shown Unavailable, not selectable, still removable', async () => {
    await importViaUi(8453)
    behaviour = 'empty' // contract gone / not an ERC-20 any more

    const app = await freshApp(8453)
    open(app)
    expect(await app.screen.findByText(/Unavailable/)).toBeInTheDocument()
    const row = app.screen.getByText('TESTTOK').closest('button') as HTMLButtonElement
    expect(row.disabled).toBe(true)
    app.fireEvent.click(row)
    expect(app.onSelect).not.toHaveBeenCalled()
    // Kept in storage — the user, not the validator, decides.
    expect(JSON.parse(localStorage.getItem(KEY(8453))!)).toHaveLength(1)

    app.fireEvent.click(app.screen.getByRole('button', { name: 'Remove TESTTOK' }))
    expect(app.screen.queryByText('TESTTOK')).toBeNull()
    expect(localStorage.getItem(KEY(8453))).toBeNull()
  })

  it('RPC down (unreadable) says nothing about the token → still available and selectable', async () => {
    await importViaUi(8453)
    behaviour = 'down'

    const app = await freshApp(8453)
    open(app)
    const symbol = await app.screen.findByText('TESTTOK')
    await app.waitFor(() => expect(rpcCalls.length).toBeGreaterThan(0))
    expect(app.screen.queryByText(/Unavailable/)).toBeNull()
    app.fireEvent.click(symbol)
    expect(app.onSelect).toHaveBeenCalledTimes(1)
  })
})
