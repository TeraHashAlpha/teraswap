// @vitest-environment node
/**
 * [INC-2026-05-31-001] End-to-end guard for GET/POST /api/quote.
 *
 * Root cause of the SEV-1: the route's try/catch wrapped ONLY fetchMetaQuote.
 * isSystemHalted(), checkRateLimit(), param parsing and the debug branch ran
 * UNPROTECTED, so any throw there (in prod, the Upstash halt/rate-limit path)
 * escaped the handler → Vercel served HTML 502 → the browser threw
 * "Unexpected token '<'". These tests invoke the REAL handler and assert it
 * ALWAYS returns a JSON Response — never a throw that escapes to 502/HTML — both
 * on the happy path (chains 1 + 8453) and when a pre-try dependency throws.
 *
 * This is the gap that let the SEV-1 ship: 1307 unit tests passed but none
 * exercised the real route handler end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const isSystemHaltedMock = vi.fn()
const checkRateLimitMock = vi.fn()
vi.mock('@/lib/circuit-breaker', () => ({ isSystemHalted: (...a: unknown[]) => isSystemHaltedMock(...a) }))
vi.mock('@/lib/kv-rate-limiter', () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimitMock(...a),
  QUOTE_RATE_LIMIT: { limit: 120, windowMs: 60_000 },
}))
vi.mock('@/lib/source-monitor', () => ({ recordSourcePing: vi.fn() }))
vi.mock('@/lib/source-state-machine', () => ({ getAllStatuses: vi.fn().mockResolvedValue([]) }))
// [feat/quote-before-wallet] The route now reads/writes a quote cache — stub it out
// (always a miss) so this suite still exercises the real fetchMetaQuote/adapters path.
vi.mock('@/lib/kv', () => ({
  kv: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') },
}))

// Keep the REAL ADAPTER_REGISTRY shape (all 12 incl. bebop) but make every
// fetchQuote fail fast so no network is hit and the "no valid quotes" path runs.
vi.mock('@/lib/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/adapters')>()
  const fakes = actual.ADAPTER_REGISTRY.map((a) => ({
    ...a,
    fetchQuote: async () => { throw new Error(`mocked-no-network:${a.name}`) },
  }))
  return { ...actual, ADAPTER_REGISTRY: fakes }
})

const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

function getReq(chainId: number): NextRequest {
  return new NextRequest(
    `http://localhost/api/quote?src=${ETH}&dst=${USDC}&amount=1000000000000000000&srcDecimals=18&dstDecimals=6&chainId=${chainId}`,
  )
}

async function isJsonResponse(res: unknown): Promise<boolean> {
  if (!(res instanceof Response)) return false
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return false
  await res.json() // throws if the body is not valid JSON (e.g. HTML)
  return true
}

describe('GET/POST /api/quote — never escapes to 502/HTML [INC-2026-05-31-001]', () => {
  beforeEach(() => {
    isSystemHaltedMock.mockReset().mockResolvedValue(false)
    checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true, remaining: 99, resetAt: 1_000 })
  })

  for (const chainId of [1, 8453]) {
    it(`returns a JSON Response on chainId ${chainId} (happy path)`, async () => {
      const { GET } = await import('./route')
      const res = await GET(getReq(chainId))
      expect(await isJsonResponse(res)).toBe(true)
    })
  }

  it('returns a JSON 500 (not an escaped throw) when checkRateLimit throws — the SEV-1 mechanism', async () => {
    checkRateLimitMock.mockRejectedValueOnce(new Error('Upstash pipeline blew up'))
    const { GET } = await import('./route')
    // Before the fix this REJECTS (throw escapes the route → Vercel HTML 502).
    const res = await GET(getReq(1))
    expect(await isJsonResponse(res)).toBe(true)
    expect((res as Response).status).toBe(500)
  })

  it('returns a JSON 500 when isSystemHalted throws', async () => {
    isSystemHaltedMock.mockRejectedValueOnce(new Error('halt-check KV crash'))
    const { GET } = await import('./route')
    const res = await GET(getReq(8453))
    expect(await isJsonResponse(res)).toBe(true)
    expect((res as Response).status).toBe(500)
  })

  it('POST also never escapes when a pre-try dependency throws', async () => {
    checkRateLimitMock.mockRejectedValueOnce(new Error('Upstash pipeline blew up'))
    const { POST } = await import('./route')
    const req = new NextRequest('http://localhost/api/quote', {
      method: 'POST',
      body: JSON.stringify({ src: ETH, dst: USDC, amount: '1000000000000000000', chainId: 1 }),
      headers: { 'content-type': 'application/json' },
    })
    const res = await POST(req)
    expect(await isJsonResponse(res)).toBe(true)
    expect((res as Response).status).toBe(500)
  })
})
