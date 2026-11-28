/**
 * /api/monitor/validate-execution is closed (goal 139): every method answers 404 with an empty body, before a body, a
 * header or a secret is read, and nothing is logged.
 *
 * CHANGED EXPECTATION (goal 139, owner, 2026-11-27): this file tested the open route (503/401 auth, 400 validation,
 * 200 pass-through, 500 safety net, chainId threading). Nothing in the repository called it. The validator keeps its
 * own tests (src/lib/post-execution-validator.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'

const mockValidateExecution = vi.fn()
vi.mock('@/lib/post-execution-validator', () => ({
  validateExecution: (...args: unknown[]) => mockValidateExecution(...args),
}))

import * as route from './route'

/** The methods a Next route handler can export (next/dist/server/web/http.js). Any other, Next refuses itself. */
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
type Handler = (req: unknown) => Response | Promise<Response>
const handler = (method: (typeof METHODS)[number]) => (route as unknown as Record<string, Handler>)[method]

// Built at run time: a fake bearer secret, never a credential.
const SECRET = `tsve-${randomUUID()}`
const realEnv = process.env
let envReads: string[] = []
const logged: unknown[][] = []

beforeEach(() => {
  vi.clearAllMocks()
  envReads = []
  logged.length = 0
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args))
  }
  vi.stubEnv('EXECUTOR_VALIDATION_SECRET', SECRET)
})
afterEach(() => {
  process.env = realEnv
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

/** Calls a handler with a request that records every property read, while process.env records every name read. */
async function untouched(method: (typeof METHODS)[number]) {
  const requestReads: PropertyKey[] = []
  const request = new Proxy({}, { get: (_t, key) => void requestReads.push(key) })
  process.env = new Proxy(realEnv, {
    get: (target, key) => {
      envReads.push(String(key))
      return Reflect.get(target, key)
    },
  })
  try {
    const res = await handler(method)(request)
    return { res, requestReads }
  } finally {
    process.env = realEnv
  }
}

describe('/api/monitor/validate-execution is closed', () => {
  it('exports a handler for every method Next can route', () => {
    for (const method of METHODS) expect(typeof handler(method), method).toBe('function')
  })

  it.each(METHODS)('%s: 404, empty body; nothing of the request and no environment name is read; nothing is logged', async (method) => {
    const { res, requestReads } = await untouched(method)
    expect(res.status).toBe(404)
    expect(res.body).toBeNull()
    expect(await res.text()).toBe('')
    expect(requestReads).toEqual([])
    expect(envReads).toEqual([])
    expect(logged).toEqual([])
    expect(mockValidateExecution).not.toHaveBeenCalled()
  })

  it('the call the open route answered 200 (the right bearer, a valid body) is the same empty 404 and validates nothing', async () => {
    const req = new NextRequest('http://localhost/api/monitor/validate-execution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ txHash: `0x${'a'.repeat(64)}`, source: '1inch', recipient: `0x${'1'.repeat(40)}`, tokenOut: `0x${'2'.repeat(40)}`, tokenOutDecimals: 6, expectedMinOutput: '1000000' }),
    })
    const res = await handler('POST')(req)
    expect([res.status, await res.text()]).toEqual([404, ''])
    expect(req.bodyUsed).toBe(false)
    expect(mockValidateExecution).not.toHaveBeenCalled()
    expect(logged).toEqual([])
  })
})
