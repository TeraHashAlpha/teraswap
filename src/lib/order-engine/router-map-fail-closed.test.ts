// @vitest-environment node
/**
 * [ADR-020] The order-engine router map must FAIL CLOSED on a chain it does not know.
 *
 * Finding B6 (`Audits/Sprint/ARBITRUM-V3-STATE-2026-08-26.md` §4): `ROUTERS_BY_CHAIN` in config.ts
 * has keys 1 and 8453 only, and `getWhitelistedRouters` used to answer every other chain with
 * MAINNET's map. On Arbitrum One (42161) that meant `getCanonicalRouteRouter(42161)` resolved to
 * mainnet's Uniswap V3 SwapRouter, which the deployed Arbitrum OrderExecutorV3 does NOT whitelist
 * (inventory §2.7) — a pinned canonical route would have signed cleanly and then reverted
 * `RouterNotWhitelisted` on every fill. `isWhitelistedRouter` could not catch it, because it was
 * validating against the MAINNET map too. The whole loop agreed with itself and was wrong.
 *
 * Two halves, and both must hold:
 *
 *   (a) chains 1 and 8453 are byte-identical to the pre-ADR-020 behaviour. The expectations below
 *       are inline snapshots CAPTURED by running this file against the code as it stood BEFORE the
 *       fail-closed change — no address in this file is hand-typed, so a transcription slip cannot
 *       manufacture a passing test.
 *
 *   (b) every other chain gets an empty map, no default router, no canonical router, and
 *       `isWhitelistedRouter` false — including for addresses READ FROM the mainnet and Base maps.
 *       That last one is the negative control: it fails on the pre-fix code, which is the only
 *       reason to trust that it means anything on the post-fix code.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getWhitelistedRouters,
  getDefaultRouter,
  getCanonicalRouteRouter,
  isWhitelistedRouter,
  CANONICAL_ROUTE_ROUTER_KEY,
} from './config'
import { isLimitLive } from './limit-launch'

/**
 * The chains config.ts actually carries an order-engine router set for. [feat/arbitrum-dca-gates]
 * 42161 moved here from UNKNOWN_CHAINS: its set is now DERIVED (whitelistedRouters() true on two
 * Arbitrum RPCs, intersected with the keeper route builder — see config.ts ARBITRUM_ROUTERS and
 * ADR-020's table), which is the only way a chain is allowed to leave the unknown list.
 */
const KNOWN_CHAINS = [1, 8453, 42161] as const

/**
 * Chains config.ts has no entry for: ordinary unknowns, plus the degenerate ids that a
 * coerced/absent chainId produces. (42161 used to head this list — see KNOWN_CHAINS.)
 */
const UNKNOWN_CHAINS = [10, 137, 56, 0, -1, 999999] as const

// ── (a) chains 1 + 8453 — unchanged ──────────────────────────────────────────────────────────

describe('[ADR-020] mainnet (1) and Base (8453) are byte-identical to the pre-fix behaviour', () => {
  it('mainnet whitelisted-router map', () => {
    expect(getWhitelistedRouters(1)).toMatchInlineSnapshot(`
      {
        "0x": {
          "address": "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",
          "label": "0x Exchange Proxy",
        },
        "1inch": {
          "address": "0x111111125421cA6dc452d289314280a0f8842A65",
          "label": "1inch v6",
        },
        "paraswap": {
          "address": "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57",
          "label": "Paraswap Augustus v5",
        },
        "uniswapV3": {
          "address": "0xE592427A0AEce92De3Edee1F18E0157C05861564",
          "label": "Uniswap V3 SwapRouter",
        },
      }
    `)
  })

  it('Base whitelisted-router map', () => {
    expect(getWhitelistedRouters(8453)).toMatchInlineSnapshot(`
      {
        "augustusV6": {
          "address": "0x6A000F20005980200259B80c5102003040001068",
          "label": "ParaSwap Augustus v6",
        },
        "uniswapV3": {
          "address": "0x2626664c2603336E57B271c5C0b26F421741e481",
          "label": "Uniswap SwapRouter02",
        },
      }
    `)
  })

  // [feat/arbitrum-dca-gates] Captured from the derived set (config.ts ARBITRUM_ROUTERS). Unlike the
  // two above this is not a PRE-change capture — the chain had no set before — it is the exact
  // on-chain-whitelisted ∩ keeper-buildable pair, pinned so a later edit is a visible diff here.
  it('Arbitrum One whitelisted-router map', () => {
    expect(getWhitelistedRouters(42161)).toMatchInlineSnapshot(`
      {
        "augustusV6": {
          "address": "0x6A000F20005980200259B80c5102003040001068",
          "label": "ParaSwap Augustus v6",
        },
        "uniswapV3": {
          "address": "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
          "label": "Uniswap SwapRouter02",
        },
      }
    `)
  })

  it('mainnet default router (the entry order creation commits)', () => {
    expect(getDefaultRouter(1)).toMatchInlineSnapshot(`
      {
        "address": "0x111111125421cA6dc452d289314280a0f8842A65",
        "label": "1inch v6",
      }
    `)
  })

  it('Base default router (the entry order creation commits)', () => {
    expect(getDefaultRouter(8453)).toMatchInlineSnapshot(`
      {
        "address": "0x6A000F20005980200259B80c5102003040001068",
        "label": "ParaSwap Augustus v6",
      }
    `)
  })

  it('mainnet canonical-route router (the pinned, quote-free route)', () => {
    expect(getCanonicalRouteRouter(1)).toMatchInlineSnapshot(`
      {
        "address": "0xE592427A0AEce92De3Edee1F18E0157C05861564",
        "label": "Uniswap V3 SwapRouter",
      }
    `)
  })

  it('Base canonical-route router (the pinned, quote-free route)', () => {
    expect(getCanonicalRouteRouter(8453)).toMatchInlineSnapshot(`
      {
        "address": "0x2626664c2603336E57B271c5C0b26F421741e481",
        "label": "Uniswap SwapRouter02",
      }
    `)
  })

  it('Arbitrum One default router (the entry order creation commits) — Augustus V6, never the cross-chain 1inch coincidence', () => {
    expect(getDefaultRouter(42161)).toMatchInlineSnapshot(`
      {
        "address": "0x6A000F20005980200259B80c5102003040001068",
        "label": "ParaSwap Augustus v6",
      }
    `)
    expect(getDefaultRouter(42161)!.address).not.toBe(getWhitelistedRouters(1)['1inch'].address)
  })

  it('Arbitrum One canonical-route router is ITS OWN SwapRouter02, not the mainnet SwapRouter B6 leaked', () => {
    expect(getCanonicalRouteRouter(42161)).toMatchInlineSnapshot(`
      {
        "address": "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        "label": "Uniswap SwapRouter02",
      }
    `)
  })

  it.each(KNOWN_CHAINS)(
    'chain %i still accepts every address in its OWN map, checksummed or lowercased',
    chainId => {
      const entries = Object.values(getWhitelistedRouters(chainId))
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) {
        expect(isWhitelistedRouter(chainId, entry.address)).toBe(true)
        expect(isWhitelistedRouter(chainId, entry.address.toLowerCase())).toBe(true)
        expect(isWhitelistedRouter(chainId, entry.address.toUpperCase())).toBe(true)
      }
    },
  )

  it('mainnet and Base do not accept each other routers (the two sets are disjoint)', () => {
    for (const entry of Object.values(getWhitelistedRouters(1))) {
      expect(isWhitelistedRouter(8453, entry.address)).toBe(false)
    }
    for (const entry of Object.values(getWhitelistedRouters(8453))) {
      expect(isWhitelistedRouter(1, entry.address)).toBe(false)
    }
  })

  it('mainnet and Arbitrum do not accept each other routers either — in particular B6\'s mainnet SwapRouter is still refused on 42161', () => {
    for (const entry of Object.values(getWhitelistedRouters(1))) {
      expect(isWhitelistedRouter(42161, entry.address)).toBe(false)
    }
    for (const entry of Object.values(getWhitelistedRouters(42161))) {
      expect(isWhitelistedRouter(1, entry.address)).toBe(false)
    }
  })

  it('Base and Arbitrum share exactly ONE address (Augustus V6, a canonical cross-chain deploy) and differ on SwapRouter02', () => {
    // Both entries were derived from their OWN executor; sharing an address is allowed only when
    // each chain's whitelist says so independently — which is the case here, and only here.
    const base = getWhitelistedRouters(8453)
    const arb = getWhitelistedRouters(42161)
    expect(base.augustusV6.address).toBe(arb.augustusV6.address)
    expect(base.uniswapV3.address).not.toBe(arb.uniswapV3.address)
    expect(isWhitelistedRouter(42161, base.uniswapV3.address)).toBe(false)
    expect(isWhitelistedRouter(8453, arb.uniswapV3.address)).toBe(false)
  })

  it.each(KNOWN_CHAINS)(
    'chain %i default router is a member of its own whitelisted set (never widens it)',
    chainId => {
      const def = getDefaultRouter(chainId)
      expect(def).not.toBeNull()
      expect(isWhitelistedRouter(chainId, def!.address)).toBe(true)
    },
  )

  it.each(KNOWN_CHAINS)(
    'chain %i canonical router, when it has one, is a member of its own whitelisted set',
    chainId => {
      const canonical = getCanonicalRouteRouter(chainId)
      if (canonical === null) return
      expect(isWhitelistedRouter(chainId, canonical.address)).toBe(true)
      expect(getWhitelistedRouters(chainId)[CANONICAL_ROUTE_ROUTER_KEY]).toEqual(canonical)
    },
  )
})

// ── (b) every other chain gets NOTHING ───────────────────────────────────────────────────────

describe('[ADR-020] an unknown chain gets nothing — never a sibling chain answer', () => {
  it.each(UNKNOWN_CHAINS)('getWhitelistedRouters(%i) is an empty map', chainId => {
    expect(getWhitelistedRouters(chainId)).toEqual({})
    expect(Object.keys(getWhitelistedRouters(chainId))).toHaveLength(0)
  })

  it.each(UNKNOWN_CHAINS)('getDefaultRouter(%i) is null — there is nothing to commit', chainId => {
    expect(getDefaultRouter(chainId)).toBeNull()
  })

  it.each(UNKNOWN_CHAINS)('getCanonicalRouteRouter(%i) is null — no route can be pinned', chainId => {
    expect(getCanonicalRouteRouter(chainId)).toBeNull()
  })

  // ── THE NEGATIVE CONTROL ──
  // Every address here is READ from the mainnet / Base maps at runtime, never typed into this
  // file. On the pre-fix code these assertions FAIL (getWhitelistedRouters(42161) returned the
  // mainnet map, so mainnet addresses validated as whitelisted on Arbitrum). If they ever start
  // passing for a reason other than the fail-closed map — e.g. someone empties MAINNET_ROUTERS —
  // the `length` assertion below fails first and says so.
  it.each(UNKNOWN_CHAINS)(
    'isWhitelistedRouter(%i, <address read from the MAINNET map>) is false for every mainnet router',
    chainId => {
      const mainnet = Object.values(getWhitelistedRouters(1))
      expect(mainnet.length).toBeGreaterThan(0)
      for (const entry of mainnet) {
        expect(isWhitelistedRouter(chainId, entry.address)).toBe(false)
        expect(isWhitelistedRouter(chainId, entry.address.toLowerCase())).toBe(false)
      }
    },
  )

  it.each(UNKNOWN_CHAINS)(
    'isWhitelistedRouter(%i, <address read from the BASE map>) is false for every Base router',
    chainId => {
      const base = Object.values(getWhitelistedRouters(8453))
      expect(base.length).toBeGreaterThan(0)
      for (const entry of base) {
        expect(isWhitelistedRouter(chainId, entry.address)).toBe(false)
      }
    },
  )

  it('Arbitrum One (42161): the exact B6 leak stays closed now that the chain HAS a set', () => {
    // B6: getCanonicalRouteRouter(42161) used to resolve to mainnet's uniswapV3 entry, an address
    // the deployed Arbitrum OrderExecutorV3 reads `whitelistedRouters = false` for (§2.7). With a
    // derived set in place the canonical router is Arbitrum's OWN SwapRouter02 — and mainnet's
    // SwapRouter is still refused there.
    const mainnetCanonical = getWhitelistedRouters(1)[CANONICAL_ROUTE_ROUTER_KEY]
    expect(mainnetCanonical).toBeDefined()
    expect(getCanonicalRouteRouter(42161)).not.toBeNull()
    expect(getCanonicalRouteRouter(42161)!.address.toLowerCase()).not.toBe(mainnetCanonical.address.toLowerCase())
    expect(isWhitelistedRouter(42161, mainnetCanonical.address)).toBe(false)
    // …and the default router B6 called out as "happens to be whitelisted, cross-chain address"
    // is STILL not offered: 1inch is not in the Arbitrum set. A coincidence is not a whitelist.
    expect(getDefaultRouter(42161)!.address).not.toBe(getWhitelistedRouters(1)['1inch'].address)
    expect(isWhitelistedRouter(42161, getWhitelistedRouters(1)['1inch'].address)).toBe(false)
  })

  it('does not hand back a sibling chain map object', () => {
    expect(getWhitelistedRouters(10)).not.toBe(getWhitelistedRouters(1))
    expect(getWhitelistedRouters(10)).not.toBe(getWhitelistedRouters(8453))
    expect(getWhitelistedRouters(10)).not.toBe(getWhitelistedRouters(42161))
  })

  it('the empty map is frozen and shared — a caller cannot poison the fail-closed answer', () => {
    const first = getWhitelistedRouters(10)
    expect(Object.isFrozen(first)).toBe(true)
    // Same object for every unknown chain, so there is exactly one thing to reason about.
    expect(getWhitelistedRouters(999999)).toBe(first)
    // A caller that tries to write into it changes nothing for the next caller.
    try {
      ;(first as Record<string, { address: `0x${string}`; label: string }>)['1inch'] = {
        address: getWhitelistedRouters(1)['1inch'].address,
        label: 'poisoned',
      }
    } catch {
      /* frozen objects throw on write in strict mode — either outcome is acceptable */
    }
    expect(getWhitelistedRouters(10)).toEqual({})
    expect(isWhitelistedRouter(10, getWhitelistedRouters(1)['1inch'].address)).toBe(false)
  })
})

// ── the gates that read these functions ──────────────────────────────────────────────────────

describe('[ADR-020] downstream gates inherit the fail-closed answer', () => {
  it.each(UNKNOWN_CHAINS)('isLimitLive(%i) is false — now also because no route can be pinned', chainId => {
    expect(isLimitLive(chainId)).toBe(false)
    expect(getCanonicalRouteRouter(chainId)).toBeNull()
  })
})

// ── [feat/arbitrum-dca-gates] Limit / Take-Profit stay Base-only ─────────────────────────────
// Widening the v3 eligibility list and giving 42161 a router set removes TWO of isLimitLive's four
// conditions on Arbitrum (executor non-null, canonical router non-null). The pin that remains is
// `chainId === LIMIT_TP_CHAIN_ID` (limit-launch.ts) — this proves it is that pin, and only that pin,
// still holding the gate shut, under the MOST permissive environment the flag and env can produce.
describe('[feat/arbitrum-dca-gates] an Arbitrum Limit/TP order still cannot be created — LIMIT_TP_CHAIN_ID is the surviving pin', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('flag ON + Arbitrum v3 env SET ⇒ executor and canonical router both resolve on 42161, yet isLimitLive(42161) is false; Base under the same env is true', async () => {
    const V3_STUB = '0x5555555555555555555555555555555555555555'
    const BASE_STUB = '0x6666666666666666666666666666666666666666'
    vi.stubEnv('NEXT_PUBLIC_LIMIT_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM', V3_STUB)
    vi.stubEnv('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE', BASE_STUB)
    vi.resetModules()
    const cfg = await import('./config')
    const launch = await import('./limit-launch')

    // Every OTHER condition of isLimitLive holds on Arbitrum now…
    expect(launch.isLimitLaunchEnabled()).toBe(true)
    expect(cfg.getOrderExecutorV3(42161)).toBe(V3_STUB)
    expect(cfg.getCanonicalRouteRouter(42161)).not.toBeNull()
    // …and the gate is still shut, by the chain pin alone.
    expect(launch.LIMIT_TP_CHAIN_ID).toBe(8453)
    expect(launch.isLimitLive(42161)).toBe(false)
    // Positive control: the identical environment opens the gate on the pinned chain.
    expect(launch.isLimitLive(8453)).toBe(true)
  })
})
