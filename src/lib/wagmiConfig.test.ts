// @vitest-environment jsdom
/**
 * [SPRINT-9K] WalletConnect config guards.
 *
 * The prod bug was a SYSTEMATIC 0-settle: the wallet approves a pairing topic
 * the dApp's WC Core isn't subscribed to. Root cause was multiple
 * @walletconnect/core versions in the tree (a stray @walletconnect/ethereum-
 * provider direct dep), now deduped to one via package.json overrides. These
 * tests guard the dApp-side invariants that must hold for a session to settle:
 *   - explicit metadata url matching a Reown-verified domain (no SSR-empty url),
 *   - the config is a single module singleton (one WC Core),
 *   - exactly one WalletConnect connector is registered.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { getSupportedChainIds } from './chains/registry'
import { __resetChainIdentityCache } from './rpc-chain-identity'

type WagmiConfigModule = typeof import('./wagmiConfig')
let config: WagmiConfigModule['config']
let WALLETCONNECT_METADATA: WagmiConfigModule['WALLETCONNECT_METADATA']
let WALLET_GROUPS: WagmiConfigModule['WALLET_GROUPS']

beforeAll(async () => {
  // getDefaultConfig throws without a projectId; provide a dummy BEFORE the
  // module is first evaluated (module body calls getDefaultConfig at import).
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test_projectid_0123456789abcdef')
  const mod = await import('./wagmiConfig')
  config = mod.config
  WALLETCONNECT_METADATA = mod.WALLETCONNECT_METADATA
  WALLET_GROUPS = mod.WALLET_GROUPS
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('wagmiConfig — WalletConnect metadata [SPRINT-9K]', () => {
  it('sets an explicit metadata url matching a Reown-verified domain', () => {
    expect(WALLETCONNECT_METADATA.appName).toBe('TeraSwap')
    expect(WALLETCONNECT_METADATA.appUrl).toBe('https://www.teraswap.app')
    // icon must be an absolute https URL on the verified domain (wallets reject relative)
    expect(WALLETCONNECT_METADATA.appIcon).toMatch(/^https:\/\/www\.teraswap\.app\/.+/)
  })

  it('exports a single config instance (module singleton → one WC Core)', async () => {
    const again = (await import('./wagmiConfig')).config
    expect(again).toBe(config)
  })

  it('configures WalletConnect (≥1 WC-protocol connector)', () => {
    // RainbowKit registers several WC-protocol wallet connectors (MetaMask,
    // Rainbow, …) that SHARE a single provider — so the count is >1 by design.
    // The "exactly ONE WC Core" guarantee is enforced at the DEPENDENCY level
    // (package.json overrides pin @walletconnect/core+sign-client+universal-
    // provider to one version; `npm ls @walletconnect/core` → 1), not here.
    const wc = config.connectors.filter(
      (c) => c.type === 'walletConnect' || c.id === 'walletConnect',
    )
    expect(wc.length).toBeGreaterThanOrEqual(1)
  })
})

describe('wagmiConfig — explicit mobile-friendly wallet list [SPRINT-9Z]', () => {
  // RainbowKit's DEFAULT getDefaultConfig list curates a subset that HIDES
  // several wallets on mobile (Rabby/Ledger/D'CENT not findable). We pass an
  // EXPLICIT wallet list instead. Wallet creator fns need projectId/appName to
  // build, but each wallet's `.id` is independent of those values.
  const WALLET_OPTS = {
    projectId: 'test_projectid_0123456789abcdef',
    appName: 'TeraSwap',
    appUrl: 'https://www.teraswap.app',
    appIcon: 'https://www.teraswap.app/apple-touch-icon.png',
  }
  const listedWalletIds = (): string[] =>
    WALLET_GROUPS.flatMap((g) => g.wallets).map(
      (fn) => (fn as (o: typeof WALLET_OPTS) => { id: string })(WALLET_OPTS).id,
    )

  it('lists exactly the wallets mobile users need to find (Rabby/MetaMask/Coinbase/WalletConnect/Ledger/Injected)', () => {
    // Exact set match — an unintended extra or missing wallet must fail the test.
    expect([...listedWalletIds()].sort()).toEqual(
      ['coinbase', 'injected', 'ledger', 'metaMask', 'rabby', 'walletConnect'].sort(),
    )
  })

  it("includes the generic walletConnect catch-all (covers D'CENT and any WC wallet via QR/deep-link)", () => {
    expect(listedWalletIds()).toContain('walletConnect')
  })

  it('exposes the same wallet list under a mobile user-agent (UA-independent — fixes the mobile-hiding regression)', () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    })
    try {
      expect(listedWalletIds()).toEqual(
        expect.arrayContaining(['rabby', 'metaMask', 'coinbase', 'walletConnect', 'ledger', 'injected']),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('builds connectors that preserve every wallet identity (RainbowKit rkDetails.id)', () => {
    const rkIds = config.connectors
      .map((c) => (c as unknown as { rkDetails?: { id?: string } }).rkDetails?.id)
      .filter((x): x is string => Boolean(x))
    expect(rkIds).toEqual(
      expect.arrayContaining(['rabby', 'metaMask', 'coinbase', 'walletConnect', 'ledger', 'injected']),
    )
  })
})

describe('wagmiConfig — chain/registry parity guard [CHORE-WAGMI-ARBITRUM]', () => {
  // The bug: wagmiConfig.ts hardcoded `chains: [mainnet, base]` while the chain
  // registry (getSupportedChainIds) already listed 42161 (Arbitrum) — the
  // ChainSelector let users PICK Arbitrum, but switchChain(42161) silently
  // failed because wagmi's config never registered that chain. This test pins
  // the two lists together so they can never silently diverge again: any chain
  // added to (or removed from) the registry MUST be reflected in wagmiConfig's
  // `chains` array in the same PR, or this fails.
  it('registers exactly the same chain ids as the chain registry', () => {
    const wagmiChainIds = config.chains.map((c) => c.id).sort((a, b) => a - b)
    const registryChainIds = getSupportedChainIds().sort((a, b) => a - b)
    expect(wagmiChainIds).toEqual(registryChainIds)
  })
})

describe('wagmiConfig — RPC chain-identity guard [FIX-RPC-CHAIN-IDENTITY-GUARD]', () => {
  // The incident: NEXT_PUBLIC_ARBITRUM_RPC_URL held a BASE endpoint for three weeks. Every
  // browser read for chain 42161 was answered by chain 8453 with a clean HTTP 200, and nothing
  // logged, because nothing was an error. wagmi transports are the browser-side place an upstream
  // is resolved, so every one of them must prove its chain before a read is trusted.
  const BASE_CHAIN_ID_HEX = '0x2105' // what the misconfigured endpoint actually answered

  const jsonRpc = (result: string) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  const methodOf = (init: RequestInit | undefined): string => {
    const parsed = JSON.parse(String(init?.body ?? '{}'))
    return Array.isArray(parsed) ? parsed[0]?.method : parsed.method
  }

  beforeEach(() => {
    __resetChainIdentityCache()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    __resetChainIdentityCache()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // Chain 1 is excluded from the wired-config cases below, and ONLY for an environment reason:
  // in the browser its transport is the relative `/api/rpc`, and viem builds a `new Request(url)`
  // before fetching, which no non-browser runtime can construct from a relative path. The
  // mainnet transport is covered instead by wagmiConfig.server.test.ts (node env, absolute URL)
  // and by rpc-guarded-transport.test.ts.
  const WIRED_CHAINS = [
    { id: 8453, urlHint: 'base', lie: '0x1', lieId: 1 },
    { id: 42161, urlHint: 'arb', lie: BASE_CHAIN_ID_HEX, lieId: 8453 },
  ]

  it('refuses a read on a configured chain whose endpoint reports a different chain id', async () => {
    // Each endpoint answers eth_chainId with a chain that is NOT the one it is configured for —
    // Arbitrum's answers Base (the real incident), Base's answers mainnet.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (methodOf(init) !== 'eth_chainId') return jsonRpc('0xdeadbeef')
        return jsonRpc(String(url).includes('base') ? '0x1' : BASE_CHAIN_ID_HEX)
      }),
    )

    for (const { id, lieId } of WIRED_CHAINS) {
      __resetChainIdentityCache()
      const client = config.getClient({ chainId: id as 8453 })
      const err = await client.request({ method: 'eth_blockNumber' }).catch((e: unknown) => e)

      const text = String((err as Error)?.message ?? err)
      expect(text).toContain(`chain ${id}`)
      expect(text).toContain(`chain ${lieId}`)
    }
  })

  it('still serves the read when the identity probe is UNREACHABLE (outage, not a lie)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (methodOf(init) === 'eth_chainId') throw new Error('ECONNRESET')
        return jsonRpc('0x1b4')
      }),
    )

    const client = config.getClient({ chainId: 42161 })
    await expect(client.request({ method: 'eth_blockNumber' })).resolves.toBe('0x1b4')
    expect(console.error).not.toHaveBeenCalled()
  })

  it('lets a correctly configured chain through after a single probe', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      methodOf(init) === 'eth_chainId' ? jsonRpc('0xa4b1') /* 42161 */ : jsonRpc('0x1b4'),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = config.getClient({ chainId: 42161 })
    await expect(client.request({ method: 'eth_blockNumber' })).resolves.toBe('0x1b4')
    await expect(client.request({ method: 'eth_blockNumber' })).resolves.toBe('0x1b4')

    const probes = fetchMock.mock.calls.filter(([, init]) => methodOf(init) === 'eth_chainId')
    expect(probes).toHaveLength(1)
    expect(console.error).not.toHaveBeenCalled()
  })
})
