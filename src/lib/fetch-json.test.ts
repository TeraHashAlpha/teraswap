// @vitest-environment node
/**
 * [SPRINT-9X X3] fetchJson — turns an HTML/non-JSON platform error into a clean typed
 * ServiceUnavailableError (+ one retry), never the raw '<!DOCTYPE ... is not valid JSON' crash.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchJson, ServiceUnavailableError } from './fetch-json'

const html = (status = 504) => new Response('<!DOCTYPE html><html><body>504 Gateway Timeout</body></html>', { status, headers: { 'content-type': 'text/html' } })
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

function mockFetchSeq(...responses: Response[]) {
  const fn = vi.fn()
  responses.forEach(r => fn.mockResolvedValueOnce(r))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchJson [SPRINT-9X X3]', () => {
  it('HTML platform error → clean ServiceUnavailableError (NEVER the raw parse string) + ONE retry', async () => {
    const fn = mockFetchSeq(html(), html())
    let caught: unknown
    try { await fetchJson('/api/quote') } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(ServiceUnavailableError)
    expect((caught as Error).message).toMatch(/service busy/i)
    expect((caught as Error).message).not.toMatch(/DOCTYPE|Unexpected token|not valid JSON/)
    expect((caught as ServiceUnavailableError).status).toBe(504)
    expect(fn).toHaveBeenCalledTimes(2) // initial + one automatic retry
  })

  it('recovers transparently when the retry returns JSON', async () => {
    const fn = mockFetchSeq(html(), json({ ok: true }))
    const { data } = await fetchJson<{ ok: boolean }>('/api/quote')
    expect(data.ok).toBe(true)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('a real JSON error envelope (429) passes through unchanged — NO retry', async () => {
    const fn = mockFetchSeq(json({ error: 'rate limited' }, 429))
    const { res, data } = await fetchJson<{ error: string }>('/api/quote')
    expect(res.status).toBe(429)
    expect(data.error).toBe('rate limited')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('success JSON → { res, data }', async () => {
    mockFetchSeq(json({ best: { source: '1inch' } }))
    const { res, data } = await fetchJson<{ best: { source: string } }>('/api/quote')
    expect(res.ok).toBe(true)
    expect(data.best.source).toBe('1inch')
  })

  it('empty / truncated body → ServiceUnavailableError (not a parse crash)', async () => {
    mockFetchSeq(new Response('', { status: 502 }), new Response('', { status: 502 }))
    await expect(fetchJson('/api/quote')).rejects.toBeInstanceOf(ServiceUnavailableError)
  })

  it('content-type lies (text/html on a 200) → still a clean error', async () => {
    mockFetchSeq(html(200), html(200))
    await expect(fetchJson('/api/quote')).rejects.toThrow(/service busy/i)
  })
})
