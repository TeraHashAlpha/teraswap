// @vitest-environment node
/**
 * [#184] Chain-aware OrderExecutor core — config.ts.
 *
 * Complements order-executor.test.ts (which covers the happy-path 1/8453 + a single
 * unwired chain). This file hardens the FAIL-CLOSED surface and documents the
 * mainnet-only behaviour of the router/feed getters:
 *
 *   - More unwired chainIds (0, 999999, -1) → null (an unwired chain must NEVER
 *     resolve to a real-looking address; the engine would EIP-712-sign / execute
 *     against the wrong contract).
 *   - The Base EIP-712 domain is byte-identical to the Base deployment (checksummed
 *     verifyingContract + chainId 8453).
 *   - getOrderExecutorDomain(unwired) throws with the SPECIFIC message the callers grep.
 *   - CANCEL_ORDER_TYPES.CancelOrder structure ([FULL-H-01]) — recoverTypedDataAddress
 *     depends on this exact field order/types.
 *   - getChainlinkFeeds still IGNORES chainId and always returns the mainnet map — asserted
 *     here so a future per-chain change can't silently land unnoticed.
 *   - [ADR-020] getWhitelistedRouters / getDefaultRouter no longer do: an unknown chain gets
 *     an EMPTY map and a null default instead of mainnet's. The exhaustive fail-closed surface
 *     (every unknown chain, both siblings, the negative controls, and the pre-fix snapshots of
 *     1/8453) lives in router-map-fail-closed.test.ts; what stays here is the chain-aware
 *     behaviour of 1 and 8453 plus the one unwired-chain case this file already carried.
 *   - The chain-1 env override (NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS) is read at module
 *     load → exercised via vi.resetModules() + dynamic import.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ORDER_EXECUTOR_BY_CHAIN,
  getOrderExecutor,
  getOrderExecutorDomain,
  ORDER_EXECUTOR_ADDRESS,
  CANCEL_ORDER_TYPES,
  getWhitelistedRouters,
  getDefaultRouter,
  getChainlinkFeeds,
  MIN_ORDER_AMOUNT,
  DCA_TOTAL_PRESETS,
  DCA_INTERVAL_PRESETS,
  ORDER_EXECUTOR_V3_BY_CHAIN,
  getOrderExecutorV3,
  getOrderExecutorV3Domain,
  // [INC-2026-08-26-001] v3 chain eligibility is a code decision, never env alone.
  ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS,
} from './config'

// Byte-identical, checksummed mainnet-behaviour constants (must match config.ts exactly).
const MAINNET_EXECUTOR = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'
const BASE_EXECUTOR = '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598'
const ONEINCH_V6 = '0x111111125421cA6dc452d289314280a0f8842A65'
const BASE_AUGUSTUS_V6 = '0x6A000F20005980200259B80c5102003040001068'
const BASE_SWAPROUTER02 = '0x2626664c2603336E57B271c5C0b26F421741e481'
const ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'

describe('getOrderExecutor — wired chains', () => {
  it('chain 1 resolves to the exact checksummed mainnet OrderExecutor', () => {
    expect(getOrderExecutor(1)).toBe(MAINNET_EXECUTOR)
  })

  it('chain 8453 resolves to Base OrderExecutor — its OWN deployment, NOT the mainnet string', () => {
    expect(getOrderExecutor(8453)).toBe(BASE_EXECUTOR)
    // Guard the documented invariant: Base must not reuse the mainnet executor string
    // (on Base that address is a FeeCollector with different bytecode, no executeOrder).
    expect(getOrderExecutor(8453)).not.toBe(MAINNET_EXECUTOR)
  })
})

describe('getOrderExecutor — fail-closed on unwired chains', () => {
  // Arbitrum (42161) is the canonical "looks plausible but unwired" case.
  it('chain 42161 (Arbitrum) is unwired → null', () => {
    expect(getOrderExecutor(42161)).toBeNull()
  })

  // [SPRINT-46-ARBITRUM-CONFIG] 42161 stopped being a purely hypothetical "unwired chain"
  // fixture the moment CHAIN_CONFIGS[42161] was registered (chains/registry.ts) — it is now a
  // REAL, resolvable ChainConfig. This pins that registering the chain-config layer did NOT
  // also (accidentally or otherwise) wire an OrderExecutor: ORDER_EXECUTOR_BY_CHAIN has no
  // 42161 key, so the config-only registry change carries zero order/DCA surface with it.
  it('registering CHAIN_CONFIGS[42161] did not wire an OrderExecutor — no key in the map', () => {
    expect(Object.prototype.hasOwnProperty.call(ORDER_EXECUTOR_BY_CHAIN, 42161)).toBe(false)
  })

  // Edge chainIds: 0 (falsy — must not be confused with "no key"), a huge unknown id,
  // and a negative id. All are unwired and must fail-closed to null.
  it.each([0, 999999, -1])('chain %i is unwired → null', (chainId) => {
    expect(getOrderExecutor(chainId)).toBeNull()
  })

  it('chainId 0 specifically returns null (the ?? guard, not a falsy-coercion bug)', () => {
    // ORDER_EXECUTOR_BY_CHAIN[0] is `undefined`, so `?? null` must yield null — assert the
    // exact null, not just falsy, so a future `|| null` regression (which would also be null
    // here) is still distinguished by the other branches.
    expect(getOrderExecutor(0)).toBeNull()
    expect(ORDER_EXECUTOR_BY_CHAIN[0]).toBeUndefined()
  })
})

describe('getOrderExecutorDomain — EIP-712 domain', () => {
  it('chain 1 deep-equals the byte-identical mainnet domain', () => {
    expect(getOrderExecutorDomain(1)).toEqual({
      name: 'TeraSwapOrderExecutor',
      version: '2',
      chainId: 1,
      verifyingContract: MAINNET_EXECUTOR,
    })
  })

  it('chain 8453 returns the Base verifyingContract bound to chainId 8453', () => {
    const domain = getOrderExecutorDomain(8453)
    expect(domain).toEqual({
      name: 'TeraSwapOrderExecutor',
      version: '2',
      chainId: 8453,
      verifyingContract: BASE_EXECUTOR,
    })
    // chainId must track the requested chain (H-05: not `as const`), and the
    // verifyingContract must be the Base executor — never the mainnet one.
    expect(domain.chainId).toBe(8453)
    expect(domain.verifyingContract).not.toBe(MAINNET_EXECUTOR)
  })

  it('chain 42161 (unwired) THROWS with the specific fail-closed message', () => {
    expect(() => getOrderExecutorDomain(42161)).toThrow(
      'No OrderExecutor deployed on chain 42161',
    )
  })

  it('the throw message interpolates the requested chainId (so callers can identify it)', () => {
    expect(() => getOrderExecutorDomain(999999)).toThrow(
      'No OrderExecutor deployed on chain 999999',
    )
  })
})

describe('ORDER_EXECUTOR_ADDRESS — deprecated mainnet alias', () => {
  it('equals getOrderExecutor(1) (the mainnet entry)', () => {
    expect(ORDER_EXECUTOR_ADDRESS).toBe(getOrderExecutor(1))
    expect(ORDER_EXECUTOR_ADDRESS).toBe(MAINNET_EXECUTOR)
  })
})

describe('CANCEL_ORDER_TYPES [FULL-H-01]', () => {
  it('CancelOrder has the exact field order/types recoverTypedDataAddress depends on', () => {
    expect(CANCEL_ORDER_TYPES.CancelOrder).toEqual([
      { name: 'id', type: 'string' },
      { name: 'action', type: 'string' },
    ])
  })
})

describe('MIN_ORDER_AMOUNT [CHORE-DCA-PRELAUNCH-FIXES] — single source pinned to the contract', () => {
  it('equals the on-chain constant TeraSwapOrderExecutor.sol MIN_ORDER_AMOUNT = 10_000 (bigint)', () => {
    // Contract: `uint256 public constant MIN_ORDER_AMOUNT = 10_000;` (TeraSwapOrderExecutor.sol:126),
    // pinned on-chain by contracts/order-engine/test-run.js ("MIN_ORDER_AMOUNT is 10000"). If the
    // contract floor ever changes, this MUST change with it — the client guard + server API both read it.
    expect(MIN_ORDER_AMOUNT).toBe(10_000n)
    expect(typeof MIN_ORDER_AMOUNT).toBe('bigint')
  })
})

describe('getWhitelistedRouters / getDefaultRouter — chain-aware [chore/dca-router-chainaware]', () => {
  it('mainnet (1) is UNCHANGED — 1inch v6 with its exact whitelisted address', () => {
    const routers = getWhitelistedRouters(1)
    expect(routers['1inch']).toEqual({ address: ONEINCH_V6, label: '1inch v6' })
  })

  it('getDefaultRouter(1) is the 1inch entry (mainnet byte-identical)', () => {
    expect(getDefaultRouter(1)).toEqual({ address: ONEINCH_V6, label: '1inch v6' })
  })

  it('Base (8453) returns the Base-whitelisted, /api/swap-serveable routers (Augustus V6 + SwapRouter02)', () => {
    const routers = getWhitelistedRouters(8453)
    expect(routers['augustusV6']).toEqual({ address: BASE_AUGUSTUS_V6, label: 'ParaSwap Augustus v6' })
    expect(routers['uniswapV3']).toEqual({ address: BASE_SWAPROUTER02, label: 'Uniswap SwapRouter02' })
  })

  it('Base (8453) does NOT offer 1inch — /api/swap cannot serve it on Base (was the SwapFailed cause)', () => {
    expect(getWhitelistedRouters(8453)['1inch']).toBeUndefined()
  })

  it('getDefaultRouter(8453) commits Augustus V6 (0x6A00…1068), not mainnet 1inch', () => {
    const base = getDefaultRouter(8453)
    expect(base).toEqual({ address: BASE_AUGUSTUS_V6, label: 'ParaSwap Augustus v6' })
    expect(base?.address).not.toBe(ONEINCH_V6)
  })

  // [ADR-020] This test used to assert the OPPOSITE — that an unwired chain fell back to the
  // mainnet map and mainnet's default router. That fallback was finding B6: on Arbitrum One the
  // app would have offered, signed and self-validated mainnet routers the deployed Arbitrum
  // OrderExecutorV3 does not whitelist. A chain map that does not know the chain must fail closed.
  it('an unwired chain gets NOTHING — no map, no default router (never mainnet\'s)', () => {
    expect(getWhitelistedRouters(42161)).toEqual({})
    expect(getWhitelistedRouters(42161)).not.toBe(getWhitelistedRouters(1))
    expect(getDefaultRouter(42161)).toBeNull()
  })
})

describe('getChainlinkFeeds — mainnet-only (chainId ignored)', () => {
  it('returns the mainnet ETH/USD feed with exact address + 8 decimals', () => {
    const feeds = getChainlinkFeeds(1)
    expect(feeds['ETH/USD']).toEqual({
      address: ETH_USD_FEED,
      label: 'ETH / USD',
      decimals: 8,
    })
  })

  it('IGNORES chainId — every chain gets the SAME mainnet feed map', () => {
    const mainnet = getChainlinkFeeds(1)
    expect(getChainlinkFeeds(8453)).toBe(mainnet)
    expect(getChainlinkFeeds(42161)).toBe(mainnet)
    expect(getChainlinkFeeds(-1)).toBe(mainnet)
  })
})

describe('NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS env override (read at module load)', () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS

  afterEach(() => {
    // Restore the env + module registry so other suites see pristine state.
    if (ORIGINAL === undefined) {
      delete process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS
    } else {
      process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS = ORIGINAL
    }
    vi.resetModules()
  })

  it('a set override flows into ORDER_EXECUTOR_BY_CHAIN[1] on fresh import', async () => {
    const OVERRIDE = '0x00000000000000000000000000000000DeaDBeef'
    process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS = OVERRIDE
    vi.resetModules()
    const fresh = await import('./config')
    expect(fresh.ORDER_EXECUTOR_BY_CHAIN[1]).toBe(OVERRIDE)
    expect(fresh.getOrderExecutor(1)).toBe(OVERRIDE)
    // The alias is derived from the same entry at load time → also picks up the override.
    expect(fresh.ORDER_EXECUTOR_ADDRESS).toBe(OVERRIDE)
    // Base is unaffected by the mainnet-only override.
    expect(fresh.getOrderExecutor(8453)).toBe(BASE_EXECUTOR)
  })

  it('with no override set, chain 1 falls back to the hardcoded mainnet executor', async () => {
    delete process.env.NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS
    vi.resetModules()
    const fresh = await import('./config')
    expect(fresh.getOrderExecutor(1)).toBe(MAINNET_EXECUTOR)
  })
})

describe('DCA presets [chore/dca-ux-tweaks]', () => {
  it('DCA_TOTAL_PRESETS = 3, 5, 10, 15, 20, 30 (dropped 7+14, added 15+20)', () => {
    expect([...DCA_TOTAL_PRESETS]).toEqual([3, 5, 10, 15, 20, 30])
  })

  it('DCA_INTERVAL_PRESETS leads with 1h (3600s) then 4h…7d', () => {
    expect(DCA_INTERVAL_PRESETS[0]).toEqual({ label: '1h', seconds: 3600 })
    expect(DCA_INTERVAL_PRESETS.map((p) => p.label)).toEqual(['1h', '4h', '8h', '12h', '1d', '3d', '7d'])
    expect(DCA_INTERVAL_PRESETS.map((p) => p.seconds)).toEqual([3600, 14400, 28800, 43200, 86400, 259200, 604800])
  })

  it('every interval is ≥ the server minimum (60s)', () => {
    for (const p of DCA_INTERVAL_PRESETS) expect(p.seconds).toBeGreaterThanOrEqual(60)
  })
})

// ── [SPRINT-V3-P2] v3 config — fail-closed while unconfigured ──────────────────────────────
describe('getOrderExecutorV3 — fail-closed while v3 is not deployed', () => {
  it('mainnet (1) and Base (8453) are both null — v3 is not deployed anywhere yet', () => {
    expect(getOrderExecutorV3(1)).toBeNull()
    expect(getOrderExecutorV3(8453)).toBeNull()
  })

  it('ORDER_EXECUTOR_V3_BY_CHAIN has no non-null entries by default', () => {
    expect(Object.values(ORDER_EXECUTOR_V3_BY_CHAIN).every((v) => v === null)).toBe(true)
  })

  it.each([0, 999999, -1, 42161])('unwired/unknown chain %i is also null', (chainId) => {
    expect(getOrderExecutorV3(chainId)).toBeNull()
  })

  it('getOrderExecutorV3Domain THROWS while unconfigured — callers must check getOrderExecutorV3 first', () => {
    expect(() => getOrderExecutorV3Domain(1)).toThrow(/No OrderExecutorV3 deployed on chain 1/)
    expect(() => getOrderExecutorV3Domain(8453)).toThrow(/No OrderExecutorV3 deployed on chain 8453/)
  })

  it('v3 does not inherit v2 configuration — a wired v2 chain does NOT imply a wired v3 chain', () => {
    // Mainnet + Base both have real v2 executors (asserted above), yet v3 stays null on both —
    // "v3 enabled" must be an explicit address, never derived from v2's presence.
    expect(getOrderExecutor(1)).not.toBeNull()
    expect(getOrderExecutor(8453)).not.toBeNull()
    expect(getOrderExecutorV3(1)).toBeNull()
    expect(getOrderExecutorV3(8453)).toBeNull()
  })
})

// [INC-2026-08-26-001] These cases used to configure MAINNET (chain 1) as the "once configured" chain.
// Mainnet is not in ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS (no v3 executor is deployed there — the
// mainnet section of docs/Runbooks/V3-EXECUTOR-DEPLOY.md is a deferred template; DCA_CHAINS and
// LIMIT_TP_CHAIN_ID both exclude it), so env can no longer light chain 1. The positive path now
// runs on Base (8453), the one eligible chain; mainnet's slot is exercised below as the
// "env set, not eligible ⇒ null" case.
describe('getOrderExecutorV3Domain — once configured on an ELIGIBLE chain (env override on Base)', () => {
  const V3_MAINNET = '0x3333333333333333333333333333333333333333'
  const V3_BASE = '0x4444444444444444444444444444444444444444'

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS
    delete process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE
    vi.resetModules()
  })

  it('resolves version "3" + the configured verifyingContract once Base\'s address is set', async () => {
    process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE = V3_BASE
    vi.resetModules()
    const fresh = await import('./config')
    expect(fresh.getOrderExecutorV3(8453)).toBe(V3_BASE)
    expect(fresh.getOrderExecutorV3Domain(8453)).toEqual({
      name: 'TeraSwapOrderExecutor',
      version: '3',
      chainId: 8453,
      verifyingContract: V3_BASE,
    })
    // Mainnet is unaffected — configuring Base's v3 address doesn't enable mainnet.
    expect(fresh.getOrderExecutorV3(1)).toBeNull()
  })

  it('the v3 domain version ("3") differs from the v2 domain version ("2") on the same chain', async () => {
    process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE = V3_BASE
    vi.resetModules()
    const fresh = await import('./config')
    const v2Domain = fresh.getOrderExecutorDomain(8453)
    const v3Domain = fresh.getOrderExecutorV3Domain(8453)
    expect(v2Domain.version).toBe('2')
    expect(v3Domain.version).toBe('3')
    expect(v2Domain.verifyingContract).not.toBe(v3Domain.verifyingContract)
  })

  it('throws when the SAME v3 address is configured on two chains (config-typo guard) — checked on the RAW env map, eligibility notwithstanding', async () => {
    process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS = V3_MAINNET
    process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE = V3_MAINNET
    vi.resetModules()
    await expect(import('./config')).rejects.toThrow(/the same v3 address is configured on two chains/)
  })

  it('accepts distinct addresses per chain without error — but only the eligible chain resolves', async () => {
    process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS = V3_MAINNET
    process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE = V3_BASE
    vi.resetModules()
    const fresh = await import('./config')
    // The RAW env view reflects both...
    expect(fresh.ORDER_EXECUTOR_V3_BY_CHAIN[1]).toBe(V3_MAINNET)
    expect(fresh.ORDER_EXECUTOR_V3_BY_CHAIN[8453]).toBe(V3_BASE)
    // ...the gate resolves only Base. Mainnet's populated slot is NOT a decision to enable mainnet.
    expect(fresh.getOrderExecutorV3(8453)).toBe(V3_BASE)
    expect(fresh.getOrderExecutorV3(1)).toBeNull()
  })
})

// ── [SPRINT-48-ARBITRUM-DCA-PREP] Arbitrum (42161) v3 plumbing — shipped DARK ───────────────
describe('getOrderExecutorV3 — Arbitrum (42161) dark-state regression', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM
    vi.resetModules()
  })

  it('unset NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM ⇒ 42161 resolves null, byte-identical to before this entry existed', () => {
    delete process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM
    expect(getOrderExecutorV3(42161)).toBeNull()
    expect(ORDER_EXECUTOR_V3_BY_CHAIN[42161]).toBeNull()
  })

  it('42161 IS a key in ORDER_EXECUTOR_V3_BY_CHAIN (unlike v2, which has no 42161 entry at all)', () => {
    expect(Object.prototype.hasOwnProperty.call(ORDER_EXECUTOR_V3_BY_CHAIN, 42161)).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(ORDER_EXECUTOR_BY_CHAIN, 42161)).toBe(false)
  })

  it('getOrderExecutorV3Domain(42161) throws while unconfigured', () => {
    expect(() => getOrderExecutorV3Domain(42161)).toThrow(/No OrderExecutorV3 deployed on chain 42161/)
  })

  // [INC-2026-08-26-001] This case used to be named "setting NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM
  // wires 42161 without disturbing mainnet/Base" and asserted getOrderExecutorV3(42161) === the env
  // value — i.e. it SPECIFIED the defect: one Vercel env var (set 2026-08-04, All Environments) was
  // enough to light DCA on a chain with no keeper for 22 days. It now pins the opposite.
  it('setting NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM populates the RAW slot but does NOT wire 42161 — getOrderExecutorV3 stays null, the domain still throws, the v3 signing executor is null', async () => {
    const V3_ARBITRUM = '0x5555555555555555555555555555555555555555'
    process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM = V3_ARBITRUM
    vi.resetModules()
    const fresh = await import('./config')
    // Env plumbing genuinely reached the slot — this is exactly the Production state of the incident.
    expect(fresh.ORDER_EXECUTOR_V3_BY_CHAIN[42161]).toBe(V3_ARBITRUM)
    // ...and the gate still says no: 42161 is not in ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS.
    expect(fresh.getOrderExecutorV3(42161)).toBeNull()
    expect(() => fresh.getOrderExecutorV3Domain(42161)).toThrow(/No OrderExecutorV3 deployed on chain 42161/)
    expect(fresh.resolveSigningExecutor(42161, true)).toBeNull()
    // An unrelated chain's env var never implicitly wires another chain either.
    expect(fresh.getOrderExecutorV3(1)).toBeNull()
    expect(fresh.getOrderExecutorV3(8453)).toBeNull()
  })

  it('the same-address-on-two-chains typo guard also catches Arbitrum reusing another chain\'s v3 address', async () => {
    const SHARED = '0x6666666666666666666666666666666666666666'
    process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE = SHARED
    process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM = SHARED
    vi.resetModules()
    await expect(import('./config')).rejects.toThrow(/the same v3 address is configured on two chains/)
    delete process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE
  })
})

// ── [INC-2026-08-26-001] v3 chain eligibility is a CODE decision — env alone cannot enable a chain ──
// DCA was reachable on Arbitrum One for 22 days (2026-08-04 → 08-26) on a chain with no keeper because
// ORDER_EXECUTOR_V3_BY_CHAIN[42161] went non-null the moment one Vercel env var was populated, and every
// consumer treated "address configured" as "chain enabled". This block is data-driven off the map itself:
// a chain added to ORDER_EXECUTOR_V3_BY_CHAIN is covered the day it is added (the key-set pin fails
// until its env var is registered here, and the it.each cases then exercise it automatically).
describe('getOrderExecutorV3 — ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS gates EVERY env slot (data-driven off the map)', () => {
  // chainId → the env var that feeds its ORDER_EXECUTOR_V3_BY_CHAIN slot. Not derivable by convention
  // (mainnet's var has no suffix) and process.env[...] cannot be dynamic in the client bundle (Next.js
  // only inlines static `process.env.NEXT_PUBLIC_*` member access), so the map keeps static reads and
  // this table names them. The key-set test below fails the day the two drift.
  const V3_ENV_VAR_BY_CHAIN: Record<number, string> = {
    1: 'NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS',
    8453: 'NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE',
    42161: 'NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM',
  }
  // Synthetic, syntactically valid 20-byte addresses (this file's existing test constants); distinct
  // per slot so the "same address on two chains" module-load invariant can't trip when all are set.
  const DISTINCT_VALID_ADDRESSES = [
    '0x3333333333333333333333333333333333333333',
    '0x4444444444444444444444444444444444444444',
    '0x5555555555555555555555555555555555555555',
    '0x6666666666666666666666666666666666666666',
  ] as const
  const MAP_CHAIN_IDS = Object.keys(ORDER_EXECUTOR_V3_BY_CHAIN).map(Number)
  const NOT_ELIGIBLE = MAP_CHAIN_IDS.filter(id => !ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS.includes(id))
  const ELIGIBLE = MAP_CHAIN_IDS.filter(id => ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS.includes(id))

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('the allowlist is exactly the set intended today — Base (8453) only; changing it is a reviewed code change, never an env flip', () => {
    // Base: OrderExecutor V3 deployed + verified + LIVE (docs/DEPLOYMENTS.md, README) and the one
    // chain a keeper polls (CHAIN_ID=8453 in every keeper runbook). Mainnet: deferred template, no v3
    // deploy. Arbitrum: pre-deploy audit only, and the keeper is single-chain — no keeper polls 42161.
    expect([...ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS]).toEqual([8453])
  })

  it('every eligible chain has an env slot in ORDER_EXECUTOR_V3_BY_CHAIN (an allowlisted chain with no slot could never resolve)', () => {
    for (const id of ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS) expect(MAP_CHAIN_IDS).toContain(id)
  })

  it('every env slot in ORDER_EXECUTOR_V3_BY_CHAIN has its env var registered here — a new chain must be covered the day it is added', () => {
    expect(Object.keys(V3_ENV_VAR_BY_CHAIN).map(Number).sort((a, b) => a - b))
      .toEqual([...MAP_CHAIN_IDS].sort((a, b) => a - b))
    expect(MAP_CHAIN_IDS.length).toBeLessThanOrEqual(DISTINCT_VALID_ADDRESSES.length)
  })

  it.each(NOT_ELIGIBLE)(
    'chain %i is NOT eligible: its env var set to a valid address populates the RAW slot, yet getOrderExecutorV3 is null, the domain throws and resolveSigningExecutor(v3) is null',
    async (chainId) => {
      const address = DISTINCT_VALID_ADDRESSES[0]
      vi.stubEnv(V3_ENV_VAR_BY_CHAIN[chainId], address)
      vi.resetModules()
      const fresh = await import('./config')
      expect(fresh.ORDER_EXECUTOR_V3_BY_CHAIN[chainId]).toBe(address) // the env var name above is right
      expect(fresh.isOrderExecutorV3EligibleChain(chainId)).toBe(false)
      expect(fresh.getOrderExecutorV3(chainId)).toBeNull()
      expect(() => fresh.getOrderExecutorV3Domain(chainId)).toThrow(
        new RegExp(`No OrderExecutorV3 deployed on chain ${chainId}`),
      )
      expect(fresh.resolveSigningExecutor(chainId, true)).toBeNull()
    },
  )

  it.each(ELIGIBLE)(
    'chain %i IS eligible: its env var set ⇒ resolves (env can only enable what code already allows), unset ⇒ null (env keeps the power to disable)',
    async (chainId) => {
      const address = DISTINCT_VALID_ADDRESSES[0]
      vi.stubEnv(V3_ENV_VAR_BY_CHAIN[chainId], address)
      vi.resetModules()
      const set = await import('./config')
      expect(set.isOrderExecutorV3EligibleChain(chainId)).toBe(true)
      expect(set.getOrderExecutorV3(chainId)).toBe(address)
      expect(set.getOrderExecutorV3Domain(chainId).verifyingContract).toBe(address)

      vi.stubEnv(V3_ENV_VAR_BY_CHAIN[chainId], undefined)
      vi.resetModules()
      const unset = await import('./config')
      expect(unset.ORDER_EXECUTOR_V3_BY_CHAIN[chainId]).toBeNull()
      expect(unset.getOrderExecutorV3(chainId)).toBeNull()
    },
  )

  it('EVERY slot set at once (distinct valid addresses — the strongest env can do) ⇒ only allowlisted chains resolve', async () => {
    MAP_CHAIN_IDS.forEach((chainId, i) => vi.stubEnv(V3_ENV_VAR_BY_CHAIN[chainId], DISTINCT_VALID_ADDRESSES[i]))
    vi.resetModules()
    const fresh = await import('./config')
    for (const [i, chainId] of MAP_CHAIN_IDS.entries()) {
      expect(fresh.ORDER_EXECUTOR_V3_BY_CHAIN[chainId]).toBe(DISTINCT_VALID_ADDRESSES[i])
      expect(fresh.getOrderExecutorV3(chainId)).toBe(
        fresh.ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS.includes(chainId) ? DISTINCT_VALID_ADDRESSES[i] : null,
      )
    }
    expect(NOT_ELIGIBLE.length + ELIGIBLE.length).toBe(MAP_CHAIN_IDS.length)
  })
})
