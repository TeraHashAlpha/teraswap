/**
 * [TEST-H-02] Unit tests for DefiLlama swap-price validation (validateSwapPrice).
 *
 * This is the core anti-manipulation control for swaps >$10k. The route test
 * mocks validateSwapPrice entirely, so the deviation arithmetic and the
 * high-value boundary were never exercised. Here we mock at the price-fetch
 * level (global fetch, which fetchDefiLlamaPrice uses) so the REAL deviation
 * math, decimal handling, and fail-open/closed thresholds run unchanged.
 *
 * Each test uses a fresh token-address pair so the module's in-memory price
 * cache (2-min TTL, not externally clearable) never returns a stale value.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { validateSwapPrice, HIGH_VALUE_THRESHOLD_USD, fetchDefiLlamaPrice } from './defillama'

// Mirrors BLOCK_THRESHOLD in defillama.ts validateSwapPrice (local const).
// The guard is `deviation < BLOCK_THRESHOLD` (strict) → exactly -8% is allowed.
const BLOCK_THRESHOLD = -0.08

interface PriceEntry {
  price: number
  confidence?: number
}

let addrCounter = 1
function freshAddr(): string {
  return '0x' + (addrCounter++).toString(16).padStart(40, '0')
}

/**
 * Stub global fetch so fetchDefiLlamaPrice resolves per-address from `prices`.
 * A null/absent entry simulates an unavailable oracle (DefiLlama returns no
 * coin for that key).
 */
function mockLlamaPrices(prices: Record<string, PriceEntry | null>) {
  const fetchMock = vi.fn(async (url: unknown) => {
    const key = String(url).split('/current/')[1] // "ethereum:0x...."
    const addr = key.split(':')[1].toLowerCase()
    const entry = prices[addr]
    if (!entry) {
      return { ok: true, json: async () => ({ coins: {} }) }
    }
    return {
      ok: true,
      json: async () => ({
        coins: {
          [key]: {
            price: entry.price,
            symbol: 'TKN',
            timestamp: Math.floor(Date.now() / 1000),
            confidence: entry.confidence ?? 1,
          },
        },
      }),
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('defillama — validateSwapPrice [TEST-H-02]', () => {
  it('returns valid=true for a normal swap (deviation within threshold)', async () => {
    const tokenIn = freshAddr() // WETH-like, 18 dec, $2000
    const tokenOut = freshAddr() // USDC-like, 6 dec, $1
    mockLlamaPrices({ [tokenIn]: { price: 2000 }, [tokenOut]: { price: 1 } })

    // 1 WETH -> 1960 USDC = -2% (fees + slippage)
    const res = await validateSwapPrice({
      tokenIn, tokenOut,
      amountIn: '1000000000000000000', amountOut: '1960000000',
      decimalsIn: 18, decimalsOut: 6,
    })
    expect(res).not.toBeNull()
    expect(res!.valid).toBe(true)
    expect(res!.blocked).toBe(false)
    expect(res!.deviation).toBeCloseTo(-0.02, 4)
  })

  it('returns blocked=true for >8% deviation', async () => {
    const tokenIn = freshAddr()
    const tokenOut = freshAddr()
    mockLlamaPrices({ [tokenIn]: { price: 2000 }, [tokenOut]: { price: 1 } })

    // 1 WETH -> 1820 USDC = -9%
    const res = await validateSwapPrice({
      tokenIn, tokenOut,
      amountIn: '1000000000000000000', amountOut: '1820000000',
      decimalsIn: 18, decimalsOut: 6,
    })
    expect(res!.valid).toBe(false)
    expect(res!.blocked).toBe(true)
    expect(res!.deviation).toBeLessThan(BLOCK_THRESHOLD)
  })

  it('treats exactly -8% as allowed and just beyond -8% as blocked (boundary is strict <)', async () => {
    // Exactly -8% — deviation < -0.08 is false, so NOT blocked.
    const inA = freshAddr(); const outA = freshAddr()
    mockLlamaPrices({ [inA]: { price: 2000 }, [outA]: { price: 1 } })
    const atBoundary = await validateSwapPrice({
      tokenIn: inA, tokenOut: outA,
      amountIn: '1000000000000000000', amountOut: '1840000000', // -8.0%
      decimalsIn: 18, decimalsOut: 6,
    })
    expect(atBoundary!.deviation).toBeCloseTo(BLOCK_THRESHOLD, 10)
    expect(atBoundary!.blocked).toBe(false)
    expect(atBoundary!.valid).toBe(true)

    // Just beyond -8% (-8.1%) — blocked.
    const inB = freshAddr(); const outB = freshAddr()
    mockLlamaPrices({ [inB]: { price: 2000 }, [outB]: { price: 1 } })
    const beyond = await validateSwapPrice({
      tokenIn: inB, tokenOut: outB,
      amountIn: '1000000000000000000', amountOut: '1838000000', // -8.1%
      decimalsIn: 18, decimalsOut: 6,
    })
    expect(beyond!.blocked).toBe(true)
  })

  it('returns null for a small swap with a missing oracle (fail-open)', async () => {
    const tokenIn = freshAddr()
    const tokenOut = freshAddr()
    mockLlamaPrices({ [tokenIn]: { price: 2000 }, [tokenOut]: null }) // oracle unavailable

    const res = await validateSwapPrice({
      tokenIn, tokenOut,
      amountIn: '1000000000000000000', amountOut: '1960000000',
      decimalsIn: 18, decimalsOut: 6,
      estimatedValueUsd: 500, // < HIGH_VALUE_THRESHOLD_USD
    })
    expect(res).toBeNull()
  })

  it('blocks a high-value swap with a missing oracle (fail-closed)', async () => {
    const tokenIn = freshAddr()
    const tokenOut = freshAddr()
    mockLlamaPrices({ [tokenIn]: { price: 2000 }, [tokenOut]: null })

    const res = await validateSwapPrice({
      tokenIn, tokenOut,
      amountIn: '1000000000000000000', amountOut: '1960000000',
      decimalsIn: 18, decimalsOut: 6,
      estimatedValueUsd: HIGH_VALUE_THRESHOLD_USD + 1,
    })
    expect(res).not.toBeNull()
    expect(res!.blocked).toBe(true)
    expect(res!.valid).toBe(false)
  })

  it('blocks a high-value swap when oracle confidence is too low', async () => {
    // fetchDefiLlamaPrice rejects confidence < 0.5 (returns null), so a
    // low-confidence price is treated as an unavailable oracle → high-value
    // swaps fail closed.
    const tokenIn = freshAddr()
    const tokenOut = freshAddr()
    mockLlamaPrices({ [tokenIn]: { price: 2000 }, [tokenOut]: { price: 1, confidence: 0.3 } })

    const res = await validateSwapPrice({
      tokenIn, tokenOut,
      amountIn: '1000000000000000000', amountOut: '1960000000',
      decimalsIn: 18, decimalsOut: 6,
      estimatedValueUsd: HIGH_VALUE_THRESHOLD_USD + 5000,
    })
    expect(res!.blocked).toBe(true)
  })

  it('returns null for low confidence on a small swap (fail-open)', async () => {
    const tokenIn = freshAddr()
    const tokenOut = freshAddr()
    mockLlamaPrices({ [tokenIn]: { price: 2000, confidence: 0.3 }, [tokenOut]: { price: 1 } })

    const res = await validateSwapPrice({
      tokenIn, tokenOut,
      amountIn: '1000000000000000000', amountOut: '1960000000',
      decimalsIn: 18, decimalsOut: 6,
      estimatedValueUsd: 250,
    })
    expect(res).toBeNull()
  })

  it('calculates deviation correctly with real token decimals (WETH 18 vs USDC 6)', async () => {
    const weth = freshAddr()
    const usdc = freshAddr()
    mockLlamaPrices({ [weth]: { price: 2000 }, [usdc]: { price: 1 } })

    // 1 WETH ($2000) -> 1990 USDC ($1990) = -0.5%. Exercises the 18-vs-6
    // decimal asymmetry: amountIn/1e18 vs amountOut/1e6.
    const res = await validateSwapPrice({
      tokenIn: weth, tokenOut: usdc,
      amountIn: '1000000000000000000', amountOut: '1990000000',
      decimalsIn: 18, decimalsOut: 6,
    })
    expect(res!.valid).toBe(true)
    expect(res!.deviation).toBeCloseTo(-0.005, 4)
  })

  it('returns null on a calculation error for a small swap', async () => {
    const tokenIn = freshAddr()
    const tokenOut = freshAddr()
    mockLlamaPrices({ [tokenIn]: { price: 2000 }, [tokenOut]: { price: 1 } })

    // Force the internal try/catch: a BigInt decimals makes `10 ** decimalsIn`
    // throw (cannot mix BigInt and number). Small swap → fail-open → null.
    const res = await validateSwapPrice({
      tokenIn, tokenOut,
      amountIn: '1000000000000000000', amountOut: '1960000000',
      decimalsIn: 18n as unknown as number, decimalsOut: 6,
      estimatedValueUsd: 100,
    })
    expect(res).toBeNull()
  })

  it('blocks on a calculation error for a high-value swap', async () => {
    const tokenIn = freshAddr()
    const tokenOut = freshAddr()
    mockLlamaPrices({ [tokenIn]: { price: 2000 }, [tokenOut]: { price: 1 } })

    const res = await validateSwapPrice({
      tokenIn, tokenOut,
      amountIn: '1000000000000000000', amountOut: '1960000000',
      decimalsIn: 18n as unknown as number, decimalsOut: 6,
      estimatedValueUsd: HIGH_VALUE_THRESHOLD_USD + 1,
    })
    expect(res).not.toBeNull()
    expect(res!.blocked).toBe(true)
    expect(res!.valid).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────
// [SPRINT-9G G2 / M07+M11] Chain-aware price validation. validateSwapPrice must
// forward the DefiLlama chain slug to BOTH price lookups, so a Base swap is
// validated against Base prices (key `base:<addr>`), not always-blocked /
// silently fail-open against the wrong chain. Omitted chain → 'ethereum'
// (mainnet byte-identical).
// ─────────────────────────────────────────────────────────────
describe('defillama — chain-aware validateSwapPrice [SPRINT-9G G2]', () => {
  /** Stub fetch, recording the `{chain}:{addr}` key of every oracle lookup. */
  function captureKeys(tokenIn: string): string[] {
    const keys: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const key = String(url).split('/current/')[1]
      keys.push(key)
      const addr = key.split(':')[1].toLowerCase()
      const price = addr === tokenIn.toLowerCase() ? 2000 : 1
      return {
        ok: true,
        json: async () => ({ coins: { [key]: { price, symbol: 'TKN', timestamp: Math.floor(Date.now() / 1000), confidence: 1 } } }),
      }
    }))
    return keys
  }

  it('forwards a Base chain slug to both oracle lookups', async () => {
    const tokenIn = freshAddr(); const tokenOut = freshAddr()
    const keys = captureKeys(tokenIn)
    const res = await validateSwapPrice({
      tokenIn, tokenOut,
      amountIn: '1000000000000000000', amountOut: '1960000000',
      decimalsIn: 18, decimalsOut: 6,
      chain: 'base',
    })
    expect(res!.valid).toBe(true)
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(k.startsWith('base:')).toBe(true)
  })

  it('defaults to the ethereum slug when chain is omitted (mainnet byte-identical)', async () => {
    const tokenIn = freshAddr(); const tokenOut = freshAddr()
    const keys = captureKeys(tokenIn)
    await validateSwapPrice({
      tokenIn, tokenOut,
      amountIn: '1000000000000000000', amountOut: '1960000000',
      decimalsIn: 18, decimalsOut: 6,
    })
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(k.startsWith('ethereum:')).toBe(true)
  })
})

describe('defillama — fetch timeout covers the body parse [RQ-2026-06-11]', () => {
  it('aborts a hanging res.json() at FETCH_TIMEOUT_MS and fails soft (null)', async () => {
    vi.useFakeTimers()
    try {
      const addr = freshAddr()
      let capturedSignal: AbortSignal | undefined
      // fetch resolves instantly, but the BODY PARSE hangs until the abort
      // signal fires (a stalled response stream — the INC-class hang).
      vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
        capturedSignal = init?.signal
        return {
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('The operation was aborted.', 'AbortError')),
              )
            }),
        }
      }))

      const pending = fetchDefiLlamaPrice(addr)
      // Let fetch resolve and the parse begin.
      await vi.advanceTimersByTimeAsync(0)
      // Cross the 3s budget: the timeout must STILL be armed during the parse.
      await vi.advanceTimersByTimeAsync(3_001)
      expect(capturedSignal?.aborted).toBe(true)

      // And the call fails soft (oracle failures never block the swap flow).
      await expect(pending).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
