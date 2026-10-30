/**
 * Probe classification: transport errors on the self probe are infra; HTTP responses are real results.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { runHealthCheck } from './health-check'

const SELF = { id: 'teraswap-self', hostname: 'www.teraswap.app', critical: true }
const COW = { id: 'cowswap', hostname: 'api.cow.fi', critical: true }

afterEach(() => vi.unstubAllGlobals())

describe('runHealthCheck — infra vs source', () => {
  it('self: a thrown fetch (timeout/DNS/reset) is reported as infra', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const r = await runHealthCheck(SELF)
    expect(r).toMatchObject({ ok: false, kind: 'infra' })
    expect(r.error).toContain('transport')
  })

  it('self: an HTTP 503 is a real source failure (no infra kind)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 503, ok: false }))
    const r = await runHealthCheck(SELF)
    expect(r.ok).toBe(false)
    expect(r.kind).toBeUndefined()
    expect(r.error).toBe('HTTP 503')
  })

  it('self: 200 is ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }))
    expect((await runHealthCheck(SELF)).ok).toBe(true)
  })

  it('aggregators: a thrown fetch stays a plain failure (behaviour unchanged)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('The operation was aborted')))
    const r = await runHealthCheck(COW)
    expect(r.ok).toBe(false)
    expect(r.kind).toBeUndefined()
  })
})
