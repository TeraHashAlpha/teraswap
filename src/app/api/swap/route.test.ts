/**
 * Unit tests for POST /api/swap — full validation branch coverage.
 *
 * [P121] (Sprint 17) covered the source allow-list guard.
 * [P127] (Sprint 19B) closes 17-I-02 by adding tests for the remaining
 * validation branches: V1 circuit breaker, V2 content-length, V3 missing
 * fields, V5 rate limit, V6 address format, V7 slippage, V8 swap selector,
 * V9 recipient mismatch, V11/V11b price guard, V12 upstream fetch error,
 * plus a happy-path with oracle data attachment.
 *
 * Every mock has a safe default; individual tests use `mockResolvedValueOnce`
 * / `mockReturnValueOnce` to override per-test without leaking state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mocks ─────────────────────────────────────────────────

const mockIsSystemHalted = vi.fn().mockResolvedValue(false)
vi.mock('@/lib/circuit-breaker', () => ({
  isSystemHalted: () => mockIsSystemHalted(),
}))

const mockCheckRateLimit = vi.fn().mockResolvedValue({
  allowed: true,
  remaining: 99,
  resetAt: Date.now() + 60_000,
})
vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  SWAP_RATE_LIMIT: { limit: 100, windowMs: 60_000 },
}))

const mockFetchSwapFromSource = vi.fn()
// [FULL-M-01] The route now derives routeViaFeeCollector from usesFeeCollector(source)
// to decide whether the FeeCollector is an acceptable calldata recipient.
const mockUsesFeeCollector = vi.fn().mockReturnValue(true)
vi.mock('@/lib/api', () => ({
  fetchSwapFromSource: (...args: unknown[]) => mockFetchSwapFromSource(...args),
  usesFeeCollector: (...args: unknown[]) => mockUsesFeeCollector(...args),
}))

const mockIsKnownSwapSelector = vi.fn().mockReturnValue(true)
vi.mock('@/lib/swap-selectors', () => ({
  isKnownSwapSelector: (...args: unknown[]) => mockIsKnownSwapSelector(...args),
  getSelector: (data: string) => data.slice(0, 10),
}))

const mockValidateCallDataRecipient = vi.fn().mockReturnValue({
  valid: true,
  extracted: null,
  implicitRecipient: true,
})
// [ADR-023] The execution paths call the registry-aware async entry point; the
// sync export stays mocked too so nothing in this file can reach a real RPC.
vi.mock('@/lib/calldata-recipient', () => ({
  validateCallDataRecipient: (...args: unknown[]) => mockValidateCallDataRecipient(...args),
  validateCallDataRecipientAsync: async (...args: unknown[]) =>
    mockValidateCallDataRecipient(...args),
}))

const mockValidateSwapPrice = vi.fn().mockResolvedValue(null)
const mockFetchDefiLlamaPrice = vi.fn().mockResolvedValue(null)
vi.mock('@/lib/defillama', () => ({
  validateSwapPrice: (...args: unknown[]) => mockValidateSwapPrice(...args),
  fetchDefiLlamaPrice: (...args: unknown[]) => mockFetchDefiLlamaPrice(...args),
  HIGH_VALUE_THRESHOLD_USD: 10_000,
}))

// [CHORE-ORACLE-VALUE-FAILCLOSED / TM-P2] Server Chainlink leg of the trade-value
// estimate. Default prices the trade small-and-covered so every pre-existing branch
// behaves as before; the fail-closed cases override to null / per-address values.
const mockComputeTokenAmountUsd = vi.fn().mockResolvedValue({ usd: 2_950, price: 1, decimals: 6 })
vi.mock('@/lib/chainlink', () => ({
  computeTokenAmountUsd: (...args: unknown[]) => mockComputeTokenAmountUsd(...args),
}))

// [SPRINT-9G G4] Server-side activation gate. Default 'active' so chainId-bearing
// tests (e.g. the G2 Base price-guard cases) proceed; per-test overrides drive
// the unsupported/coming-soon branches.
const mockGetChainStatus = vi.fn().mockReturnValue('active')
vi.mock('@/lib/chains/activation', () => ({
  getChainStatus: (id: number) => mockGetChainStatus(id),
}))

// [E2-I-01] Sequencer gate on the swap-BUILD path. isSequencerUp defaults to
// true so existing chainId-bearing tests pass the gate; the REAL
// SequencerDownError is kept (the route reuses it for the single-sourced
// refusal message — no wording duplicated in the route).
const mockIsSequencerUp = vi.fn().mockResolvedValue(true)
vi.mock('@/lib/chains/sequencer-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chains/sequencer-check')>()
  return {
    ...actual,
    isSequencerUp: (...args: unknown[]) => mockIsSequencerUp(...args),
  }
})

const mockGetPublicClientForChain = vi.fn().mockReturnValue({ __fake: 'client' })
vi.mock('@/lib/chains/clients', () => ({
  getPublicClientForChain: (...args: unknown[]) => mockGetPublicClientForChain(...args),
}))

// ── Import after mocks ────────────────────────────────────

import { POST, maxDuration } from './route'

// ── Helpers ───────────────────────────────────────────────

function makeRequest(
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost/api/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  })
}

const VALID_BASE = {
  src: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  dst: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  amount: '1000000000000000000',
  from: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  slippage: 0.5,
}

const VALID_SWAP_RESULT = {
  toAmount: '2950000000',
  tx: {
    to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
    data: '0x12aa3caf' + '0'.repeat(200),
    value: '0',
  },
}

beforeEach(() => {
  mockCheckRateLimit.mockClear()
  mockFetchSwapFromSource.mockReset()
  mockIsSystemHalted.mockClear().mockResolvedValue(false)
  mockIsKnownSwapSelector.mockClear().mockReturnValue(true)
  mockValidateCallDataRecipient.mockClear().mockReturnValue({
    valid: true,
    extracted: null,
    implicitRecipient: true,
  })
  mockValidateSwapPrice.mockClear().mockResolvedValue(null)
  mockFetchDefiLlamaPrice.mockClear().mockResolvedValue(null)
  mockComputeTokenAmountUsd.mockClear().mockResolvedValue({ usd: 2_950, price: 1, decimals: 6 })
  mockGetChainStatus.mockClear().mockReturnValue('active')
  mockIsSequencerUp.mockClear().mockResolvedValue(true)
  mockGetPublicClientForChain.mockClear()
})

// ── Tests ─────────────────────────────────────────────────

describe('POST /api/swap — source allow-list [P121]', () => {
  it('proceeds normally for a known source (1inch)', async () => {
    mockFetchSwapFromSource.mockResolvedValue(VALID_SWAP_RESULT)
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(200)
    expect(mockFetchSwapFromSource).toHaveBeenCalledTimes(1)
    expect(mockFetchSwapFromSource.mock.calls[0][0]).toBe('1inch')
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown source with 400 INVALID_SOURCE and skips rate-limit + upstream fetch', async () => {
    const res = await POST(makeRequest({ source: 'evil-router', ...VALID_BASE }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('INVALID_SOURCE')
    expect(body.error).toContain('Unknown aggregator source')
    // Guard fired BEFORE rate-limit deduction (don't burn budget on invalid input)
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    // Guard fired BEFORE upstream call
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V1 circuit breaker halt [P127]', () => {
  it('returns 503 with halted:true and Retry-After header when system halted', async () => {
    mockIsSystemHalted.mockResolvedValueOnce(true)
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.halted).toBe(true)
    expect(res.headers.get('Retry-After')).toBe('300')
    // Early exit: no downstream call
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V2 request body too large [P127]', () => {
  it('returns 413 when Content-Length exceeds 10KB limit', async () => {
    const res = await POST(
      makeRequest(
        { source: '1inch', ...VALID_BASE },
        { 'content-length': '99999' },
      ),
    )
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.error).toContain('too large')
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V3 missing required fields [P127]', () => {
  it('returns 400 when source field is missing', async () => {
    const { src, dst, amount, from, slippage } = VALID_BASE
    const res = await POST(makeRequest({ src, dst, amount, from, slippage }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Missing required fields')
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V5 rate limit exceeded [P127]', () => {
  it('returns 429 with rate limit headers when limit exceeded', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    })
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toContain('Rate limit')
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V6 invalid address format [P127]', () => {
  it('returns 400 when src address is malformed', async () => {
    const res = await POST(
      makeRequest({ ...VALID_BASE, source: '1inch', src: 'not-an-address' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid address')
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V7 slippage out of range [P127]', () => {
  it('returns 400 when slippage exceeds 15%', async () => {
    const res = await POST(
      makeRequest({ ...VALID_BASE, source: '1inch', slippage: 50 }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Slippage must be between')
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })

  it('returns 400 when slippage is NaN', async () => {
    const res = await POST(
      makeRequest({ ...VALID_BASE, source: '1inch', slippage: 'abc' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Slippage must be between')
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — V8 unknown swap selector [P127]', () => {
  it('returns 400 with selector in response when function selector is unknown', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce({
      toAmount: '2950000000',
      tx: {
        to: '0x1111111254EEB25477B68fb85Ed929f73A960582',
        data: '0xdeadbeef' + '0'.repeat(200),
        value: '0',
      },
    })
    mockIsKnownSwapSelector.mockReturnValueOnce(false)
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Unknown swap function selector')
    expect(typeof body.selector).toBe('string')
    expect(body.selector.startsWith('0x')).toBe(true)
  })
})

describe('POST /api/swap — V9 calldata recipient mismatch [P127]', () => {
  it('returns 400 when recipient does not match requesting wallet', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    mockValidateCallDataRecipient.mockReturnValueOnce({
      valid: false,
      extracted: '0xAttAckEr000000000000000000000000DeAdBeEf',
      implicitRecipient: false,
      reason: 'Recipient mismatch',
    })
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('recipient does not match')
  })
})

describe('POST /api/swap — V11 price guard: oracle deviation blocked [P127]', () => {
  it('returns 422 with priceGuard flag when price deviation exceeds threshold', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    mockValidateSwapPrice.mockResolvedValueOnce({
      valid: false,
      reason: 'Price deviation exceeds threshold',
      deviation: -0.125, // -12.5% (route multiplies by 100 for display)
      blocked: true,
    })
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.priceGuard).toBe(true)
    expect(body.blocked).toBe(true)
  })
})

describe('POST /api/swap — V11b price guard: high-value oracle unavailable [P127]', () => {
  it('returns 422 priceGuard when high-value swap and oracle throws', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    // 1 WETH @ $50,000 = $50,000 estimatedValueUsd > $10,000 threshold.
    // Route reads tokenInPrice.price, so the mock returns { price } shape.
    mockFetchDefiLlamaPrice.mockResolvedValueOnce({ price: 50_000 })
    // Oracle throws → catch branch fires → high-value path returns 422.
    mockValidateSwapPrice.mockRejectedValueOnce(new Error('Oracle unreachable'))
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.priceGuard).toBe(true)
    expect(body.blocked).toBe(true)
  })
})

describe('POST /api/swap — V12 upstream fetch error [P127]', () => {
  it('returns 502 when fetchSwapFromSource throws', async () => {
    mockFetchSwapFromSource.mockRejectedValueOnce(new Error('1inch API timeout'))
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toContain('1inch API timeout')
  })
})

// [SPRINT-9J J2] The route must ALWAYS return JSON on an upstream failure (never
// let the platform serve HTML), redact secrets, and declare enough maxDuration
// that a slow build fails fast as JSON instead of hitting a platform HTML 504.
describe('POST /api/swap — J2 timeout/JSON safety', () => {
  it('returns clean JSON (502) even when the build times out', async () => {
    mockFetchSwapFromSource.mockRejectedValueOnce(new Error('Timeout'))
    const res = await POST(makeRequest({ source: 'velora', ...VALID_BASE }))
    expect(res.status).toBe(502)
    expect(res.headers.get('content-type') ?? '').toContain('application/json')
    const body = await res.json()
    expect(typeof body.error).toBe('string')
  })

  it('does not leak an API key embedded in an upstream error', async () => {
    mockFetchSwapFromSource.mockRejectedValueOnce(
      new Error('velora build failed: https://api.paraswap.io/transactions/1?apiKey=SUPER_SECRET_KEY&x=1'),
    )
    const res = await POST(makeRequest({ source: 'velora', ...VALID_BASE }))
    const body = await res.json()
    expect(body.error).not.toContain('SUPER_SECRET_KEY')
  })

  it('declares an explicit maxDuration so the function is not cut off mid-build', () => {
    expect(maxDuration).toBeGreaterThanOrEqual(30)
  })
})

describe('POST /api/swap — happy path with oracle attached [P127]', () => {
  it('returns 200 with oracle data attached when validation succeeds', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    mockValidateSwapPrice.mockResolvedValueOnce({
      valid: true,
      deviation: -0.012,
      oraclePriceIn: 3500,
      oraclePriceOut: 1.0,
    })
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.oracleDeviation).toBeDefined()
    expect(body.oraclePriceIn).toBeDefined()
  })
})

// [SPRINT-9G G2 / M11] The route must derive the DefiLlama chain slug from the
// request chainId and pass it to BOTH the estimatedValueUsd price fetch and
// validateSwapPrice — so the >$10k guard validates the swap's actual chain.
describe('POST /api/swap — chain-aware price guard [SPRINT-9G G2]', () => {
  it('derives the DefiLlama slug from chainId (Base 8453 → "base")', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    // [CHORE-ORACLE-VALUE-FAILCLOSED] Price the trade so the (now fail-closed) value
    // estimate lets the flow reach validateSwapPrice — this test pins slug derivation,
    // not the pricing policy (off-mainnet has no Chainlink leg, so DefiLlama must hit).
    mockFetchDefiLlamaPrice.mockResolvedValue({ price: 3_000 })
    await POST(makeRequest({ source: '1inch', ...VALID_BASE, chainId: 8453 }))
    expect(mockFetchDefiLlamaPrice).toHaveBeenCalled()
    expect(mockFetchDefiLlamaPrice.mock.calls[0][1]).toBe('base')
    expect(mockValidateSwapPrice).toHaveBeenCalled()
    expect(mockValidateSwapPrice.mock.calls[0][0].chain).toBe('base')
  })

  it('defaults to "ethereum" when chainId is omitted (mainnet byte-identical)', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(mockFetchDefiLlamaPrice.mock.calls[0][1]).toBe('ethereum')
    expect(mockValidateSwapPrice.mock.calls[0][0].chain).toBe('ethereum')
  })
})

// [SPRINT-9G G4 / M03+M05] The server must enforce the chain-activation gate, not
// trust the client. A direct caller must not obtain executable (fee-free) swap
// calldata for an unsupported or not-yet-launched chain.
describe('POST /api/swap — server-side activation gate [SPRINT-9G G4]', () => {
  it('rejects an unsupported chain with 400 before rate-limit + upstream', async () => {
    mockGetChainStatus.mockReturnValueOnce('unsupported')
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE, chainId: 999999 }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('CHAIN_UNSUPPORTED')
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })

  it('rejects a coming-soon chain with 409', async () => {
    mockGetChainStatus.mockReturnValueOnce('coming-soon')
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE, chainId: 8453 }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('CHAIN_COMING_SOON')
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })

  it('allows an active chain (Base live) to proceed', async () => {
    mockGetChainStatus.mockReturnValue('active')
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    // [CHORE-ORACLE-VALUE-FAILCLOSED] Price the trade (fail-closed estimate would
    // otherwise 422 an unpriceable Base pair before the 200 this gate test pins).
    mockFetchDefiLlamaPrice.mockResolvedValue({ price: 3_000 })
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE, chainId: 8453 }))
    expect(res.status).toBe(200)
  })

  it('does not consult the gate when chainId is omitted (mainnet default)', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(200)
    expect(mockGetChainStatus).not.toHaveBeenCalled()
  })
})

describe('POST /api/swap — Base sequencer gate on the swap-build path [E2-I-01]', () => {
  it('refuses the swap build with 503 when the Base sequencer is down (before rate limit + upstream)', async () => {
    mockIsSequencerUp.mockResolvedValueOnce(false)
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE, chainId: 8453 }))
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('60')
    const body = await res.json()
    expect(body.sequencerDown).toBe(true)
    expect(body.error).toMatch(/sequencer/i)
    // The gate runs BEFORE the rate limiter and the upstream fetch — a down
    // sequencer burns neither rate-limit budget nor an upstream call.
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
    // The shared check was consulted with the per-chain client (api.ts shape).
    expect(mockIsSequencerUp).toHaveBeenCalledTimes(1)
    expect(mockIsSequencerUp.mock.calls[0][0]).toBe(8453)
    expect(mockGetPublicClientForChain).toHaveBeenCalledWith(8453)
  })

  it('refuses within the recovery grace window (grace logic lives in isSequencerUp → false)', async () => {
    // isSequencerUp resolves false for "recovered < SEQUENCER_GRACE_PERIOD_SEC
    // ago" exactly as for hard-down; the route must honour that false the same.
    mockIsSequencerUp.mockResolvedValueOnce(false)
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE, chainId: 8453 }))
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('60')
    const body = await res.json()
    expect(body.sequencerDown).toBe(true)
  })

  it('proceeds normally on Base when the sequencer is up', async () => {
    mockFetchSwapFromSource.mockResolvedValue(VALID_SWAP_RESULT)
    // [CHORE-ORACLE-VALUE-FAILCLOSED] Price the trade (fail-closed estimate would
    // otherwise 422 an unpriceable Base pair before the 200 this gate test pins).
    mockFetchDefiLlamaPrice.mockResolvedValue({ price: 3_000 })
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE, chainId: 8453 }))
    expect(res.status).toBe(200)
    expect(mockIsSequencerUp).toHaveBeenCalledTimes(1)
    expect(mockFetchSwapFromSource).toHaveBeenCalledTimes(1)
  })

  it('mainnet byte-identical: absent chainId and chainId=1 never consult the sequencer', async () => {
    mockFetchSwapFromSource.mockResolvedValue(VALID_SWAP_RESULT)
    const resAbsent = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(resAbsent.status).toBe(200)
    const resMainnet = await POST(makeRequest({ source: '1inch', ...VALID_BASE, chainId: 1 }))
    expect(resMainnet.status).toBe(200)
    // No isSequencerUp call, no per-chain client construction for either form.
    expect(mockIsSequencerUp).not.toHaveBeenCalled()
    expect(mockGetPublicClientForChain).not.toHaveBeenCalled()
  })
})

// [CHORE-ORACLE-VALUE-FAILCLOSED] Threat model PR #277 P2 (MED, confirmed): the >$10k
// gate estimated trade value from the INPUT token via DefiLlama only — an uncovered
// input token → estimate 0 → every high-value branch below silently failed OPEN (the
// aToken-incident bypass). The estimate is now max(inputUsd, outputUsd) across BOTH
// DefiLlama and the server Chainlink path, and a trade that prices on NEITHER source
// on EITHER side fails CLOSED (422 `unpriceable`) instead of passing as "$0".
describe('POST /api/swap — fail-closed trade value [CHORE-ORACLE-VALUE-FAILCLOSED]', () => {
  const WETH = VALID_BASE.src
  const USDC = VALID_BASE.dst

  it('blocks (422, unpriceable) when neither token prices on DefiLlama nor Chainlink', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    mockFetchDefiLlamaPrice.mockResolvedValue(null) // both sides uncovered
    mockComputeTokenAmountUsd.mockResolvedValue(null) // both sides uncovered
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.priceGuard).toBe(true)
    expect(body.blocked).toBe(true)
    expect(body.unpriceable).toBe(true)
    // The policy is a block, not a silent pass — validateSwapPrice is never even reached.
    expect(mockValidateSwapPrice).not.toHaveBeenCalled()
  })

  it('prices the OUTPUT side when the input is uncovered (the P2 bypass, DefiLlama leg)', async () => {
    // 3 000 USDC out (6 dp) at $5 → $15 000; the input token prices nowhere.
    mockFetchSwapFromSource.mockResolvedValueOnce({ ...VALID_SWAP_RESULT, toAmount: '3000000000' })
    mockComputeTokenAmountUsd.mockResolvedValue(null)
    mockFetchDefiLlamaPrice.mockImplementation(async (addr: unknown) =>
      addr === USDC ? { price: 5 } : null)
    await POST(makeRequest({ source: '1inch', ...VALID_BASE, srcDecimals: 18, dstDecimals: 6 }))
    expect(mockValidateSwapPrice).toHaveBeenCalled()
    expect(mockValidateSwapPrice.mock.calls[0][0].estimatedValueUsd).toBe(15_000)
  })

  it('takes max(inputUsd, outputUsd) when both sides price', async () => {
    // Input: 1 WETH at $20 000; output: 3 000 USDC at $5 = $15 000 → max is the input.
    mockFetchSwapFromSource.mockResolvedValueOnce({ ...VALID_SWAP_RESULT, toAmount: '3000000000' })
    mockComputeTokenAmountUsd.mockResolvedValue(null)
    mockFetchDefiLlamaPrice.mockImplementation(async (addr: unknown) =>
      addr === WETH ? { price: 20_000 } : { price: 5 })
    await POST(makeRequest({ source: '1inch', ...VALID_BASE, srcDecimals: 18, dstDecimals: 6 }))
    expect(mockValidateSwapPrice.mock.calls[0][0].estimatedValueUsd).toBe(20_000)
  })

  it('falls back to the server Chainlink path when DefiLlama misses both sides', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    mockFetchDefiLlamaPrice.mockResolvedValue(null)
    mockComputeTokenAmountUsd.mockImplementation(async (addr: unknown) =>
      addr === WETH ? { usd: 12_000, price: 12_000, decimals: 18 } : null)
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE }))
    expect(res.status).toBe(200) // priced via Chainlink → NOT the unpriceable block
    expect(mockValidateSwapPrice.mock.calls[0][0].estimatedValueUsd).toBe(12_000)
  })

  // [CHORE-API-SMALL-FIXES] computeTokenAmountUsd is now chain-aware, so the value
  // gate must consult it on non-mainnet chains too (previously hard-skipped unless
  // swapChainId === DEFAULT_CHAIN_ID, silently losing the Chainlink leg on Base).
  it('consults the Chainlink leg on Base (8453) too, passing the active chainId through', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(VALID_SWAP_RESULT)
    mockFetchDefiLlamaPrice.mockResolvedValue(null)
    mockComputeTokenAmountUsd.mockClear().mockImplementation(async (addr: unknown) =>
      addr === WETH ? { usd: 11_000, price: 11_000, decimals: 18 } : null)
    const res = await POST(makeRequest({ source: '1inch', ...VALID_BASE, chainId: 8453 }))
    expect(res.status).toBe(200)
    expect(mockValidateSwapPrice.mock.calls[0][0].estimatedValueUsd).toBe(11_000)
    expect(mockComputeTokenAmountUsd).toHaveBeenCalledWith(WETH, VALID_BASE.amount, 8453)
  })
})
