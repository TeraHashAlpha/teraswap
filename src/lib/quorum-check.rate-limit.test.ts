/**
 * [feat/retire-force-mev C3] H5 quorum = the REAL quote path's 429 evidence (H1 only GETs CoW's quote URL). A source whose
 * breaker failed with HTTP 429 during the run is recorded rate-limited via 'quote'; one that returned a quote is clean.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/kv', () => ({ kv: { get: vi.fn(), set: vi.fn(), incr: vi.fn() } }))
vi.mock('./api', () => ({ fetchMetaQuote: vi.fn() }))
const recordRateLimited = vi.fn()
const clearRateLimited = vi.fn()
vi.mock('./source-state-machine', () => ({
  getAllStatuses: vi.fn(),
  getStatus: vi.fn(),
  getThresholds: vi.fn(() => ({})),
  forceDisable: vi.fn(),
  recordRateLimited: (...a: unknown[]) => recordRateLimited(...a),
  clearRateLimited: (...a: unknown[]) => clearRateLimited(...a),
}))

import { recordQuotePathRateLimits } from './quorum-check'
import { getCircuitBreaker, circuitKey, resetAllCircuitBreakers } from './adapters/circuit-breaker'

const err429 = new Error('CoW 429: rate limited retryAfterMs=30000')

beforeEach(() => {
  resetAllCircuitBreakers()
  recordRateLimited.mockReset().mockResolvedValue(undefined)
  clearRateLimited.mockReset().mockResolvedValue(undefined)
})

describe('recordQuotePathRateLimits', () => {
  it('a 429 on the breaker during this run → recordRateLimited(id, "quote")', async () => {
    const start = Date.now()
    getCircuitBreaker(circuitKey('cowswap')).onFailure(err429)
    expect(getCircuitBreaker(circuitKey('cowswap')).getInfo().lastFailureStatus).toBe(429)
    await recordQuotePathRateLimits(['cowswap', '1inch'], start, new Set(['1inch']))
    expect(recordRateLimited).toHaveBeenCalledWith('cowswap', 'quote')
    expect(clearRateLimited).toHaveBeenCalledWith('1inch', 'quote')
    expect(clearRateLimited).not.toHaveBeenCalledWith('cowswap', 'quote')
  })

  it('a 429 from BEFORE this run is not new evidence; a quote now is clean evidence', async () => {
    getCircuitBreaker(circuitKey('cowswap')).onFailure(err429)
    const start = Date.now() + 1
    await recordQuotePathRateLimits(['cowswap'], start, new Set(['cowswap']))
    expect(recordRateLimited).not.toHaveBeenCalled()
    expect(clearRateLimited).toHaveBeenCalledWith('cowswap', 'quote')
  })

  it('a non-429 failure is not a rate limit; no quote and no 429 = no evidence either way', async () => {
    const start = Date.now()
    getCircuitBreaker(circuitKey('cowswap')).onFailure(new Error('CoW 500: boom'))
    expect(getCircuitBreaker(circuitKey('cowswap')).getInfo().lastFailureStatus).toBe(500)
    await recordQuotePathRateLimits(['cowswap', 'kyberswap'], start, new Set())
    expect(recordRateLimited).not.toHaveBeenCalled()
    expect(clearRateLimited).not.toHaveBeenCalled()
  })

  it('liveness entries (server-rpc:*, teraswap-self) are never quote sources', async () => {
    await recordQuotePathRateLimits(['server-rpc:1', 'teraswap-self'], 0, new Set(['server-rpc:1', 'teraswap-self']))
    expect(clearRateLimited).not.toHaveBeenCalled()
  })

  it('a state-store failure never throws out of the quorum', async () => {
    const start = Date.now()
    getCircuitBreaker(circuitKey('cowswap')).onFailure(err429)
    recordRateLimited.mockRejectedValueOnce(new Error('kv down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(recordQuotePathRateLimits(['cowswap'], start, new Set())).resolves.toBeUndefined()
  })
})
