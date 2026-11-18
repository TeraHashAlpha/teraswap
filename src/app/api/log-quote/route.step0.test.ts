// @vitest-environment node
/**
 * [fix/log-routes-bounded-input, Step 0] The two findings of the 2026-11-17 security audit (origin/main 4a4129ef), each as
 * one request to POST /api/log-quote. Both tests FAILED on origin/main (output in
 * docs/feedback/fix-log-routes-bounded-input.md, evidence 1); they import nothing this branch added, so they still run
 * against the old code.
 *
 * (a) SEC-3: one request naming 300 invented sources, none of which "responded", wrote one security_events row per name.
 *     A request may cause at most one failure event per adapter-registry source.
 * (b) SEC-8: the body cap was read from the Content-Length header only, so a chunked 778 KB body with no header was read
 *     in full and stored. It must answer 413 and stop reading at the cap.
 *
 * The database is a recording stub (every insert is kept), the trackers are the real modules writing through it, and the
 * limiter always allows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const inserts = vi.hoisted(() => [] as Array<{ table: string; row: Record<string, unknown> }>)
vi.mock('@/lib/supabase', () => {
  const client = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push({ table, row })
        return Promise.resolve({ error: null })
      },
    }),
  }
  return { getSupabase: () => client, getSupabaseLogger: () => client }
})
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  const allow = async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 })
  return { ...actual, checkRateLimit: allow, checkRateLimitWithin: allow }
})

import { POST } from './route'
import { ADAPTER_REGISTRY } from '@/lib/adapters'
import { DEFAULT_MAX_BODY_BYTES } from '@/lib/body-limit'

const QUOTE = {
  tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  amountIn: '1000000000000000000',
}

const table = (name: string) => inserts.filter((i) => i.table === name)

beforeEach(() => {
  inserts.length = 0
})

describe('Step 0 (a), SEC-3: invented source names', () => {
  it('one request with 300 invented names causes at most one failure event per registry source', async () => {
    const invented = Array.from({ length: 300 }, (_, i) => `made-up-${i}`)
    const body = JSON.stringify({ ...QUOTE, sourcesQueried: invented, sourcesResponded: [] })
    const res = await POST(new NextRequest('http://localhost/api/log-quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body,
    }))
    expect(res.status).toBe(200)
    expect(table('security_events').length).toBeLessThanOrEqual(ADAPTER_REGISTRY.length)
  })
})

describe('Step 0 (b), SEC-8: chunked body over the cap, no Content-Length', () => {
  it('answers 413, stores nothing and stops reading at the cap', async () => {
    const CHUNK = 1024
    const json = JSON.stringify({ ...QUOTE, tokenInSymbol: 'X'.repeat(778 * 1024) })
    const bytes = new TextEncoder().encode(json)
    // `pulled` counts the bytes the server took: the stream makes a chunk only when one is asked for (high-water mark 0).
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulled >= bytes.length) return controller.close()
          const chunk = bytes.subarray(pulled, pulled + CHUNK)
          pulled += chunk.length
          controller.enqueue(chunk)
        },
      },
      { highWaterMark: 0 },
    )
    const req = new NextRequest('http://localhost/api/log-quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half', // a stream body needs it (fetch spec); NextRequest's init type does not list it
    } as unknown as ConstructorParameters<typeof NextRequest>[1])
    expect(req.headers.get('content-length')).toBeNull()

    const res = await POST(req)
    expect({ status: res.status, quotesStored: table('quotes').length }).toEqual({ status: 413, quotesStored: 0 })
    expect(pulled).toBeLessThanOrEqual(DEFAULT_MAX_BODY_BYTES + CHUNK)
  })
})
