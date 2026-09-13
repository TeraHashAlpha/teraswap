// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { classifyQuoteBuildOutcome } from './quote-build-monitor'

describe('classifyQuoteBuildOutcome [T1]', () => {
  it('no error → \'built\'', () => {
    expect(classifyQuoteBuildOutcome(undefined)).toBe('built')
    expect(classifyQuoteBuildOutcome(null)).toBe('built')
  })

  it('a 429-flavored message → \'429\'', () => {
    expect(classifyQuoteBuildOutcome(new Error('0x 429'))).toBe('429')
    expect(classifyQuoteBuildOutcome(new Error('0x 429 retryAfterMs=5000'))).toBe('429')
    expect(classifyQuoteBuildOutcome(new Error('Rate limit exceeded'))).toBe('429')
  })

  it('a transient error (timeout/network/5xx/non-json) → \'upstream-error\', matching isTransientSwapError', () => {
    expect(classifyQuoteBuildOutcome(new Error('Timeout'))).toBe('upstream-error')
    expect(classifyQuoteBuildOutcome(new Error('failed to fetch'))).toBe('upstream-error')
    expect(classifyQuoteBuildOutcome(new Error('0x 502'))).toBe('upstream-error')
    expect(classifyQuoteBuildOutcome(new Error('0x 503'))).toBe('upstream-error')
    expect(classifyQuoteBuildOutcome(new Error('invalid response (non-json)'))).toBe('upstream-error')
  })

  it('a deterministic adapter-side failure (400, no route, unknown source) → \'sim-failed\'', () => {
    expect(classifyQuoteBuildOutcome(new Error('0x 400'))).toBe('sim-failed')
    expect(classifyQuoteBuildOutcome(new Error('Unknown source: foo'))).toBe('sim-failed')
    expect(classifyQuoteBuildOutcome(new Error('0x: no swap data returned'))).toBe('sim-failed')
  })
})

describe('recordQuoteBuildAttempt [T1] — fire-and-forget, never throws', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is a no-op (does not throw) when Supabase is unconfigured', async () => {
    vi.doMock('./supabase', () => ({ getSupabaseLogger: () => null }))
    const { recordQuoteBuildAttempt: record } = await import('./quote-build-monitor')
    expect(() => record({
      source: '0x', chainId: 1, sellToken: '0xa', buyToken: '0xb',
      amount: '1000000000000000000', outcome: 'built', requestId: 'r1',
    })).not.toThrow()
  })

  it('inserts into quote_build_attempts with a bucketed amount and lowercased addresses', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null })
    vi.doMock('./supabase', () => ({
      getSupabaseLogger: () => ({ from: (table: string) => ({ insert: (row: unknown) => insertSpy(table, row) }) }),
    }))
    const { recordQuoteBuildAttempt: record } = await import('./quote-build-monitor')

    record({
      source: '0x', chainId: 1, sellToken: '0xAAAA000000000000000000000000000000000A',
      buyToken: '0xBBBB000000000000000000000000000000000B',
      amount: '1234567890123456789', outcome: 'built', requestId: 'req-1', wallet: '0xCCCC',
    })
    await vi.waitFor(() => expect(insertSpy).toHaveBeenCalledTimes(1))

    const [table, row] = insertSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(table).toBe('quote_build_attempts')
    expect(row.sell_token).toBe('0xaaaa000000000000000000000000000000000a')
    expect(row.buy_token).toBe('0xbbbb000000000000000000000000000000000b')
    expect(row.wallet).toBe('0xcccc')
    expect(row.outcome).toBe('built')
    expect(row.request_id).toBe('req-1')
    // quantizeAmount buckets to 4 sig figs — the trailing digits are zeroed.
    expect(row.amount_bucket).toBe('1234000000000000000')
  })
})
