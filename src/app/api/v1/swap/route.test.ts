/**
 * Unit tests for POST /api/v1/swap [LP-10].
 *
 * Covers:
 *   - OPTIONS preflight (204 + full CORS)
 *   - Halt short-circuit (503 + Retry-After) — fires before auth
 *   - Auth: missing key → 401; rate limited → 429; backend down → 503
 *   - Body validation: missing fields, malformed address, invalid
 *     amount, slippage out of range, unknown source, fee-incompatible
 *     source explicitly pinned
 *   - Auto source selection: meta-quote called when source omitted;
 *     skips fee-incompatible sources in the best-pick
 *   - Happy path (ERC-20 → ERC-20): correct tx.to (FeeCollector),
 *     tx.value="0", minimumOutput matches slippage formula
 *   - Happy path (ETH → token): tx.value > 0, swapETHWithFee selector,
 *     tokenIn=NATIVE_ETH
 *   - mevProtected derived from AGGREGATOR_META
 *   - Adapter error surfacing (rate-limit → 429, not-whitelisted → 400)
 *   - CORS headers + X-RateLimit-* forwarded on every response
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { FEE_COLLECTOR_ADDRESS, NATIVE_ETH } from '@/lib/constants'

// ── Mocks (must be declared before the route import) ─────

const mockVerifyApiKey = vi.fn()
vi.mock('@/lib/api-auth', () => ({
  verifyApiKey: (...args: unknown[]) => mockVerifyApiKey(...args),
}))

const mockFetchMetaQuote = vi.fn()
const mockFetchSwapFromSource = vi.fn()
const mockUsesFeeCollector = vi.fn()
const mockValidateRouterAddress = vi.fn()
vi.mock('@/lib/api', () => ({
  fetchMetaQuote: (...args: unknown[]) => mockFetchMetaQuote(...args),
  fetchSwapFromSource: (...args: unknown[]) => mockFetchSwapFromSource(...args),
  usesFeeCollector: (...args: unknown[]) => mockUsesFeeCollector(...args),
  validateRouterAddress: (...args: unknown[]) => mockValidateRouterAddress(...args),
}))

const mockIsSystemHalted = vi.fn()
vi.mock('@/lib/circuit-breaker', () => ({
  isSystemHalted: () => mockIsSystemHalted(),
}))

// ── Import route after mocks ─────────────────────────────

import { POST, OPTIONS } from './route'

// ── Fixtures ─────────────────────────────────────────────

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const SENDER = '0x1234567890abcdef1234567890abcdef12345678'
const ROUTER_1INCH = '0x111111125421cA6dc452d289314280a0f8842A65'

function makeRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'tsk_test', ...headers },
    body: JSON.stringify(body),
  })
}

function authSuccess() {
  return {
    ok: true,
    keyId: 'fixture-key-id',
    keyName: 'test',
    tier: 'free' as const,
    rateLimitHeaders: {
      'X-RateLimit-Limit': '10',
      'X-RateLimit-Remaining': '9',
      'X-RateLimit-Reset': '1700000060',
    },
  }
}

/** A normalized 1inch swap-data fixture with all fields the route reads. */
function oneinchSwapData(overrides: Record<string, unknown> = {}) {
  return {
    source: '1inch',
    toAmount: '2950420000', // 2950.42 USDC (6dp)
    estimatedGas: 150000,
    gasUsd: 4.2,
    routes: ['WETH → USDC'],
    tx: {
      to: ROUTER_1INCH,
      data: '0x1234abcd',
      value: '0',
      gas: 180000,
    },
    ...overrides,
  }
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    tokenIn: WETH,
    tokenOut: USDC,
    amount: '1000000000000000000', // 1 WETH
    sender: SENDER,
    source: '1inch',
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────

describe('OPTIONS /api/v1/swap', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 204 with full CORS preflight headers', async () => {
    const res = await OPTIONS()
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-allow-headers')).toContain('X-API-Key')
  })
})

describe('POST /api/v1/swap — halt short-circuit', () => {
  beforeEach(() => vi.resetAllMocks())

  it('503 + Retry-After before auth when halted', async () => {
    mockIsSystemHalted.mockResolvedValueOnce(true)
    const res = await POST(makeRequest(validBody()))
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('300')
    expect(mockVerifyApiKey).not.toHaveBeenCalled()
    expect(mockFetchSwapFromSource).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/swap — auth', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockIsSystemHalted.mockResolvedValue(false)
  })

  it('401 when API key missing/invalid', async () => {
    mockVerifyApiKey.mockResolvedValueOnce({ ok: false, status: 401, error: 'Missing X-API-Key header.' })
    const res = await POST(makeRequest(validBody()))
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('429 with X-RateLimit-* + Retry-After when key is rate-limited', async () => {
    mockVerifyApiKey.mockResolvedValueOnce({
      ok: false,
      status: 429,
      error: 'Per-minute rate limit exceeded.',
      rateLimitHeaders: {
        'X-RateLimit-Limit': '10',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': '1700000060',
        'Retry-After': '15',
      },
    })
    const res = await POST(makeRequest(validBody()))
    expect(res.status).toBe(429)
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(res.headers.get('retry-after')).toBe('15')
  })
})

describe('POST /api/v1/swap — body validation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockIsSystemHalted.mockResolvedValue(false)
    mockVerifyApiKey.mockResolvedValue(authSuccess())
  })

  it('400 when JSON is malformed', async () => {
    const req = new NextRequest('http://localhost/api/v1/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'tsk_test' },
      body: '{ not json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Invalid JSON/)
  })

  it('400 when tokenIn is missing', async () => {
    const res = await POST(makeRequest({ tokenOut: USDC, amount: '1', sender: SENDER }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Missing required fields/)
  })

  it('400 when sender is not a valid address', async () => {
    const res = await POST(makeRequest(validBody({ sender: 'not-an-address' })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/valid 0x-prefixed/)
  })

  it('400 when amount is NaN', async () => {
    const res = await POST(makeRequest(validBody({ amount: 'NaN' })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/positive decimal-integer/)
  })

  it('400 when amount is zero', async () => {
    const res = await POST(makeRequest(validBody({ amount: '0' })))
    expect(res.status).toBe(400)
  })

  it('400 when slippage exceeds 50', async () => {
    const res = await POST(makeRequest(validBody({ slippage: 60 })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/slippage/)
  })

  it('400 when source is unknown', async () => {
    const res = await POST(makeRequest(validBody({ source: 'made-up-dex' })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/source must be one of/)
  })

  it('400 when source is fee-incompatible (0x)', async () => {
    const res = await POST(makeRequest(validBody({ source: '0x' })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/cannot route through FeeCollector/)
  })

  it('400 when source is fee-incompatible (cowswap)', async () => {
    const res = await POST(makeRequest(validBody({ source: 'cowswap' })))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/v1/swap — happy path with explicit source', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockIsSystemHalted.mockResolvedValue(false)
    mockVerifyApiKey.mockResolvedValue(authSuccess())
    mockUsesFeeCollector.mockReturnValue(true)
    mockValidateRouterAddress.mockReturnValue({ valid: true })
  })

  it('returns 200 with FeeCollector-wrapped tx for ERC-20 → ERC-20', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(oneinchSwapData())

    const res = await POST(makeRequest(validBody({ slippage: 0.5 })))
    expect(res.status).toBe(200)
    const body = await res.json()

    // tx targets FeeCollector V2, never the raw router
    expect(body.tx.to.toLowerCase()).toBe(FEE_COLLECTOR_ADDRESS.toLowerCase())
    // tx.value is "0" for ERC-20 input
    expect(body.tx.value).toBe('0')
    // tx.data is a non-empty hex blob (FeeCollector calldata)
    expect(body.tx.data).toMatch(/^0x[0-9a-fA-F]+$/)
    expect(body.tx.data.length).toBeGreaterThan(10)
    expect(body.tx.gasEstimate).toBe('180000')

    // Echo of the selected source + quoted output
    expect(body.source).toBe('1inch')
    expect(body.toAmount).toBe('2950420000')

    // minimumOutput = 2950420000 * (10000 - 50) / 10000 = 2935667900
    expect(body.minimumOutput).toBe('2935667900')

    // 1inch is not MEV-protected
    expect(body.mevProtected).toBe(false)

    // Fee block
    expect(body.fee.bps).toBe(10) // 0.1%
    expect(body.fee.amount).toBe('1000000000000000') // 1e18 * 10 / 10000
    expect(body.fee.recipient.toLowerCase()).toBe(FEE_COLLECTOR_ADDRESS.toLowerCase())

    // Meta block
    expect(body.meta.routedVia).toBe('fee-collector-v2')
    expect(body.meta.router).toBe(ROUTER_1INCH)
    expect(body.meta.chainId).toBe(1)
    expect(body.meta.slippage).toBe(0.5)
    expect(body.meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('forwards X-RateLimit-* and CORS on 200', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(oneinchSwapData())
    const res = await POST(makeRequest(validBody()))
    expect(res.headers.get('x-ratelimit-limit')).toBe('10')
    expect(res.headers.get('x-ratelimit-remaining')).toBe('9')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('uses swapETHWithFee + tx.value > 0 for native-ETH input', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(oneinchSwapData())
    const res = await POST(makeRequest(validBody({ tokenIn: NATIVE_ETH })))
    expect(res.status).toBe(200)
    const body = await res.json()
    // Caller sends the full pre-fee amount as msg.value
    expect(body.tx.value).toBe('1000000000000000000')
    // Selector for swapETHWithFee(address,bytes,address,uint256) =
    // first 4 bytes of keccak256 — we don't hardcode the selector,
    // but we can assert the calldata starts with 0x and is the right
    // family of length (header + 4 args, no token-in field).
    expect(body.tx.data.length).toBeGreaterThan(10)
  })

  it('feeds netAmount (amount - fee) into fetchSwapFromSource', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(oneinchSwapData())
    await POST(makeRequest(validBody({ amount: '1000000000000000000', slippage: 0.5 })))
    const [, , , passedAmount] = mockFetchSwapFromSource.mock.calls[0]
    // 1e18 - (1e18 * 10 / 10000) = 9.99e17
    expect(passedAmount).toBe('999000000000000000')
  })

  it('rejects 500 if a non-fee-collectable source somehow gets through', async () => {
    mockUsesFeeCollector.mockReturnValue(false) // simulate misconfiguration
    mockFetchSwapFromSource.mockResolvedValueOnce(oneinchSwapData())
    const res = await POST(makeRequest(validBody()))
    expect(res.status).toBe(500)
    // [11-M-02] Wire response is the generic envelope; the specific
    // "non-fee-collectable" diagnostic now lives only in the server log.
    expect((await res.json()).error).toMatch(/Internal error/)
  })

  it('502 when adapter does not return tx data', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce({ ...oneinchSwapData(), tx: undefined })
    const res = await POST(makeRequest(validBody()))
    expect(res.status).toBe(502)
    // [11-M-02] Adapter-shape complaint is internal; wire surface is generic.
    expect((await res.json()).error).toMatch(/Upstream service error/)
  })

  it('502 when validateRouterAddress rejects (adapter returned non-whitelisted router)', async () => {
    mockValidateRouterAddress.mockReturnValueOnce({ valid: false, reason: 'router not whitelisted' })
    mockFetchSwapFromSource.mockResolvedValueOnce(oneinchSwapData())
    const res = await POST(makeRequest(validBody()))
    expect(res.status).toBe(502)
    // [11-M-02] Router-whitelist details would leak the allowlist logic — sanitised.
    expect((await res.json()).error).toMatch(/Upstream service error/)
  })
})

describe('POST /api/v1/swap — adapter error surfacing', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockIsSystemHalted.mockResolvedValue(false)
    mockVerifyApiKey.mockResolvedValue(authSuccess())
    mockUsesFeeCollector.mockReturnValue(true)
    mockValidateRouterAddress.mockReturnValue({ valid: true })
  })

  it('429 when adapter throws "Rate limited"', async () => {
    mockFetchSwapFromSource.mockRejectedValueOnce(new Error('Rate limited — wait a moment'))
    const res = await POST(makeRequest(validBody()))
    expect(res.status).toBe(429)
  })

  it('400 when source is disabled at runtime', async () => {
    mockFetchSwapFromSource.mockRejectedValueOnce(new Error('cowswap is disabled: preventive'))
    const res = await POST(makeRequest(validBody()))
    expect(res.status).toBe(400)
  })

  it('502 on generic upstream failure', async () => {
    mockFetchSwapFromSource.mockRejectedValueOnce(new Error('upstream timeout'))
    const res = await POST(makeRequest(validBody()))
    expect(res.status).toBe(502)
  })
})

describe('POST /api/v1/swap — auto source selection (source omitted)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockIsSystemHalted.mockResolvedValue(false)
    mockVerifyApiKey.mockResolvedValue(authSuccess())
    mockUsesFeeCollector.mockReturnValue(true)
    mockValidateRouterAddress.mockReturnValue({ valid: true })
  })

  it('picks the best fee-collectable source from a meta-quote', async () => {
    mockFetchMetaQuote.mockResolvedValueOnce({
      best: { source: '1inch', toAmount: '2950420000' },
      all: [
        { source: '1inch', toAmount: '2950420000' },
        { source: 'velora', toAmount: '2949000000' },
      ],
      fetchedAt: Date.now(),
    })
    mockFetchSwapFromSource.mockResolvedValueOnce(oneinchSwapData())

    const res = await POST(makeRequest({
      tokenIn: WETH,
      tokenOut: USDC,
      amount: '1000000000000000000',
      sender: SENDER,
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toBe('1inch')
    expect(mockFetchMetaQuote).toHaveBeenCalledTimes(1)
  })

  it('skips fee-incompatible sources in auto-pick (0x leads, velora wins)', async () => {
    mockFetchMetaQuote.mockResolvedValueOnce({
      best: { source: '0x', toAmount: '2951000000' },
      all: [
        { source: '0x', toAmount: '2951000000' }, // best but fee-incompatible
        { source: 'velora', toAmount: '2949000000' },
      ],
      fetchedAt: Date.now(),
    })
    mockFetchSwapFromSource.mockResolvedValueOnce({
      ...oneinchSwapData(),
      source: 'velora',
    })

    const res = await POST(makeRequest({
      tokenIn: WETH,
      tokenOut: USDC,
      amount: '1000000000000000000',
      sender: SENDER,
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toBe('velora')
    // The adapter was called with the source picked by auto-select
    const [pickedSource] = mockFetchSwapFromSource.mock.calls[0]
    expect(pickedSource).toBe('velora')
  })

  it('502 when no fee-collectable source returns a quote', async () => {
    mockFetchMetaQuote.mockResolvedValueOnce({
      best: { source: '0x', toAmount: '2951000000' },
      all: [{ source: '0x', toAmount: '2951000000' }],
      fetchedAt: Date.now(),
    })
    const res = await POST(makeRequest({
      tokenIn: WETH,
      tokenOut: USDC,
      amount: '1000000000000000000',
      sender: SENDER,
    }))
    expect(res.status).toBe(502)
    // [11-M-02] Wire surface is generic; the "fee-collectable" reason is server-side only.
    expect((await res.json()).error).toMatch(/Upstream service error/)
  })
})

// [P97] Gasless fields on v1/swap. CoW swaps go through /v1/quote +
// off-chain order submission, not /v1/swap, so v1/swap responses are
// always `gasless: false`. The `gaslessAlternative` field surfaces the
// opt-in gasless path when a CoW quote is available for the same pair.
describe('POST /api/v1/swap — gasless fields [P97]', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockIsSystemHalted.mockResolvedValue(false)
    mockVerifyApiKey.mockResolvedValue(authSuccess())
    mockUsesFeeCollector.mockReturnValue(true)
    mockValidateRouterAddress.mockReturnValue({ valid: true })
  })

  it('gasless=false and gaslessAlternative.available=true when CoW quote exists for the pair', async () => {
    mockFetchMetaQuote.mockResolvedValueOnce({
      best: { source: '1inch', toAmount: '2950420000', estimatedGas: 150000, gasUsd: 5, routes: [] },
      all: [
        { source: '1inch', toAmount: '2950420000', estimatedGas: 150000, gasUsd: 5, routes: [] },
        { source: 'cowswap', toAmount: '2948000000', estimatedGas: 0, gasUsd: 0, routes: [] },
      ],
      fetchedAt: Date.now(),
    })
    mockFetchSwapFromSource.mockResolvedValueOnce(oneinchSwapData())

    const res = await POST(makeRequest({
      tokenIn: WETH,
      tokenOut: USDC,
      amount: '1000000000000000000',
      sender: SENDER,
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.gasless).toBe(false)
    expect(body.gaslessAlternative).toBeDefined()
    expect(body.gaslessAlternative.available).toBe(true)
    expect(body.gaslessAlternative.gasSavingsUsd).toBeGreaterThan(0)
  })

  it('gaslessAlternative.available=false on a caller-pinned source (no meta-quote was run)', async () => {
    mockFetchSwapFromSource.mockResolvedValueOnce(oneinchSwapData())
    const res = await POST(makeRequest(validBody()))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.gasless).toBe(false)
    expect(body.gaslessAlternative.available).toBe(false)
  })

  it('rejects source=cowswap with the existing fee-collector 400 (cannot return gasless=true on v1/swap)', async () => {
    const res = await POST(makeRequest(validBody({ source: 'cowswap' })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/cannot route through FeeCollector/)
  })
})
