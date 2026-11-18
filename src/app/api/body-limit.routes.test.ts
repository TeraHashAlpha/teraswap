// @vitest-environment node
/**
 * [fix/log-routes-bounded-input, SEC-8] One end-to-end request per route handler that calls bodySizeGuard: a chunked
 * body over the route's cap, no Content-Length, with whatever auth the route needs to reach its body read.
 *
 * - Routes that read a body and that this branch edits answer 413 and take at most one chunk past the cap.
 * - orders POST, orders/[id] PATCH, log-swap POST and PATCH are outside this branch (goal's Do-NOT; owner answer
 *   2026-11-17): their read stops at the cap as well and nothing is written; they answer their own error.
 * - log-event, monitor/alerts and monitor/tick never read a body: they take 0 bytes and answer as before.
 * No route reaches a database write or an upstream fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'

const writes = vi.hoisted(() => [] as string[])
vi.mock('@/lib/supabase', () => {
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'gte', 'lte', 'gt', 'lt', 'order', 'limit', 'range', 'single', 'maybeSingle']) c[m] = () => c
    for (const m of ['insert', 'update', 'upsert', 'delete']) {
      c[m] = () => {
        writes.push(`${m}:${table}`)
        return c
      }
    }
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 })
    return c
  }
  const client = { from: chain, rpc: () => chain('rpc') }
  return { getSupabase: () => client, getSupabaseLogger: () => client, getSupabaseAdmin: () => client }
})
vi.mock('@/lib/kv', async () => {
  const { fakeUpstash } = await import('@/test-utils/fake-upstash-kv')
  return { kv: fakeUpstash.kv, kvRaw: fakeUpstash.kvRaw }
})
vi.mock('@/lib/kv-rate-limiter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/kv-rate-limiter')>('@/lib/kv-rate-limiter')
  const allow = async () => ({ allowed: true, remaining: 99, resetAt: Date.now() + 60_000 })
  return { ...actual, checkRateLimit: allow, checkRateLimitWithin: allow }
})
vi.mock('@/lib/api-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-auth')>('@/lib/api-auth')
  return {
    ...actual,
    verifyApiKey: async () => ({ ok: true, keyId: 'k', keyName: 'test', tier: 'free', rateLimitHeaders: {} }),
  }
})

import { BodyTooLargeError, DEFAULT_MAX_BODY_BYTES, RPC_MAX_BODY_BYTES } from '@/lib/body-limit'
import { COW_PROXY_MAX_BODY_BYTES } from '@/lib/cow-proxy'
import * as apiKeys from './admin/api-keys/route'
import * as dcaFreeze from './admin/dca-freeze/route'
import * as killSwitch from './admin/kill-switch/route'
import * as uiVersion from './admin/ui-version/route'
import * as cowOrders from './cow/orders/route'
import * as cowQuote from './cow/quote/route'
import * as logActivity from './log-activity/route'
import * as logEvent from './log-event/route'
import * as logQuote from './log-quote/route'
import * as logSwap from './log-swap/route'
import * as monitorAlerts from './monitor/alerts/route'
import * as monitorTick from './monitor/tick/route'
import * as validateExecution from './monitor/validate-execution/route'
import * as orders from './orders/route'
import * as orderById from './orders/[id]/route'
import * as quote from './quote/route'
import * as rpc from './rpc/route'
import * as telegram from './telegram/webhook/route'
import * as v1Swap from './v1/swap/route'

// Built at run time: a fake bearer secret for the route tests, never a credential (no literal for gitleaks to flag).
const SECRET = `tsbl-${randomUUID()}`
const BEARER = { authorization: `Bearer ${SECRET}` }
const CHUNK = 1024

type Handler = (req: NextRequest, ctx?: unknown) => Promise<Response>
interface Case {
  route: string
  handler: Handler
  method?: string
  query?: string
  headers?: Record<string, string>
  cap?: number
  ctx?: unknown
}

function chunkedRequest(c: Case) {
  const cap = c.cap ?? DEFAULT_MAX_BODY_BYTES
  const bytes = new TextEncoder().encode(JSON.stringify({ pad: 'x'.repeat(cap * 2) }))
  let taken = 0
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (taken >= bytes.length) return controller.close()
        const part = bytes.subarray(taken, taken + CHUNK)
        taken += part.length
        controller.enqueue(part)
      },
    },
    { highWaterMark: 0 },
  )
  const req = new NextRequest(`http://localhost/api/${c.route}${c.query ?? ''}`, {
    method: c.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...c.headers },
    body: stream,
    duplex: 'half',
  } as unknown as ConstructorParameters<typeof NextRequest>[1])
  expect(req.headers.get('content-length')).toBeNull()
  return { req, taken: () => taken, cap }
}

const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }))
beforeEach(() => {
  writes.length = 0
  fetchSpy.mockClear()
  vi.stubGlobal('fetch', fetchSpy)
  for (const name of ['ADMIN_API_KEYS_SECRET', 'DCA_FREEZE_SECRET', 'KILL_SWITCH_SECRET', 'UI_V2_ADMIN_SECRET', 'EXECUTOR_VALIDATION_SECRET', 'TELEGRAM_WEBHOOK_SECRET']) {
    vi.stubEnv(name, SECRET)
  }
  vi.stubEnv('MONITOR_SECRET', '')
  vi.stubEnv('MONITOR_CRON_SECRET', '')
  vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:9')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'route-test-key')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const EDITED: Case[] = [
  { route: 'admin/api-keys', handler: apiKeys.POST as Handler, headers: BEARER },
  { route: 'admin/dca-freeze', handler: dcaFreeze.POST as Handler, headers: BEARER },
  { route: 'admin/kill-switch', handler: killSwitch.POST as Handler, headers: BEARER },
  { route: 'admin/ui-version', handler: uiVersion.POST as Handler, headers: BEARER },
  { route: 'cow/orders', handler: cowOrders.POST as Handler, query: '?chainId=1', cap: COW_PROXY_MAX_BODY_BYTES },
  { route: 'cow/orders', handler: cowOrders.DELETE as Handler, method: 'DELETE', query: `?chainId=1&uid=0x${'ab'.repeat(56)}`, cap: COW_PROXY_MAX_BODY_BYTES },
  { route: 'cow/quote', handler: cowQuote.POST as Handler, query: '?chainId=1', cap: COW_PROXY_MAX_BODY_BYTES },
  { route: 'log-activity', handler: logActivity.POST as Handler },
  { route: 'log-quote', handler: logQuote.POST as Handler },
  { route: 'monitor/validate-execution', handler: validateExecution.POST as Handler, headers: BEARER },
  { route: 'quote', handler: quote.POST as Handler },
  { route: 'rpc', handler: rpc.POST as Handler, cap: RPC_MAX_BODY_BYTES },
  { route: 'telegram/webhook', handler: telegram.POST as Handler, headers: { 'x-telegram-bot-api-secret-token': SECRET } },
  { route: 'v1/swap', handler: v1Swap.POST as Handler, headers: { 'x-api-key': 'test-key' } },
]

describe('routes this branch edits: a chunked over-cap body answers 413', () => {
  it.each(EDITED.map((c) => [`${c.method ?? 'POST'} /api/${c.route}`, c] as const))('%s', async (_label, c) => {
    const { req, taken, cap } = chunkedRequest(c)
    const res = await c.handler(req, c.ctx)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'Request body too large' })
    expect(taken()).toBeGreaterThan(cap)
    expect(taken()).toBeLessThanOrEqual(cap + CHUNK)
    expect(writes).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('routes outside this branch (orders/**, log-swap): the read stops at the cap and nothing is written', () => {
  it('POST /api/orders answers its own 500 with the size error', async () => {
    const { req, taken, cap } = chunkedRequest({ route: 'orders', handler: orders.POST as Handler })
    const res = await (orders.POST as Handler)(req)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/too large/i)
    expect(taken()).toBeLessThanOrEqual(cap + CHUNK)
    expect(writes).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('PATCH /api/orders/[id] throws BodyTooLargeError (Next answers 500), before any database call', async () => {
    const { req, taken, cap } = chunkedRequest({ route: 'orders/1', handler: orderById.PATCH as Handler, method: 'PATCH' })
    await expect((orderById.PATCH as Handler)(req, { params: Promise.resolve({ id: '1' }) })).rejects.toBeInstanceOf(BodyTooLargeError)
    expect(taken()).toBeLessThanOrEqual(cap + CHUNK)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POST /api/log-swap answers its own 200 { ok: false } and logs nothing', async () => {
    const { req, taken, cap } = chunkedRequest({ route: 'log-swap', handler: logSwap.POST as Handler })
    const res = await (logSwap.POST as Handler)(req)
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(false)
    expect(taken()).toBeLessThanOrEqual(cap + CHUNK)
    expect(writes).toEqual([])
  })

  it('PATCH /api/log-swap answers its own 200 { ok: true } and updates nothing', async () => {
    const { req, taken, cap } = chunkedRequest({ route: 'log-swap', handler: logSwap.PATCH as Handler, method: 'PATCH' })
    const res = await (logSwap.PATCH as Handler)(req)
    expect(res.status).toBe(200)
    expect(taken()).toBeLessThanOrEqual(cap + CHUNK)
    expect(writes).toEqual([])
  })
})

describe('routes that never read a body: nothing is taken from it', () => {
  it.each([
    ['POST /api/log-event', { route: 'log-event', handler: logEvent.POST as Handler }, 204],
    ['POST /api/monitor/alerts (no secret configured)', { route: 'monitor/alerts', handler: monitorAlerts.POST as Handler, headers: BEARER }, 401],
    ['POST /api/monitor/tick (no secret configured)', { route: 'monitor/tick', handler: monitorTick.POST as Handler, headers: BEARER }, 503],
  ] as const)('%s', async (_label, c, status) => {
    const { req, taken } = chunkedRequest(c)
    const res = await c.handler(req)
    expect(res.status).toBe(status)
    expect(taken()).toBe(0)
  })
})
