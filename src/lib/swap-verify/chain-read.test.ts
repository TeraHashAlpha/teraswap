// @vitest-environment node
/**
 * [ADR-029, details A.2] The chain read of a swap verification: server-only RPC name, proven chain identity, an
 * explicit timeout, one retry at most, and no URL in any error. Env values here are throwaway placeholders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { __resetChainIdentityCache } from '@/lib/rpc-chain-identity'
import { ChainReadError, SWAP_VERIFY_MISSING_RETRY_DELAY_MS, SWAP_VERIFY_RPC_ATTEMPTS, SWAP_VERIFY_RPC_TIMEOUT_MS, readChain } from './chain-read'

const NAMES = ['RPC_URL_1', 'RPC_URL_8453', 'RPC_URL_42161', 'RPC_URL', 'NEXT_PUBLIC_RPC_URL', 'NEXT_PUBLIC_BASE_RPC_URL', 'NEXT_PUBLIC_ARBITRUM_RPC_URL', 'SWAP_VERIFY_MISSING_RETRY_MS'] as const
const saved: Record<string, string | undefined> = {}
const HASH = `0x${'ab'.repeat(32)}`

interface Sent {
  url: string
  method: string
}

/** A fetch stand-in: `chainIdOf(url)` is what each endpoint says its chain is, `answer` decides every other call. */
function stubFetch(chainIdOf: (url: string) => number | 'down', answer: (sent: Sent, attempt: number) => Response | Promise<Response>) {
  const sent: Sent[] = []
  let attempt = 0
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string }
    const call = { url: String(url), method: body.method }
    sent.push(call)
    if (body.method === 'eth_chainId') {
      const id = chainIdOf(call.url)
      if (id === 'down') throw new Error('connect ECONNREFUSED')
      return Response.json({ jsonrpc: '2.0', id: 1, result: `0x${id.toString(16)}` })
    }
    attempt += 1
    return answer(call, attempt)
  })
  vi.stubGlobal('fetch', fn)
  return { sent, reads: () => sent.filter((s) => s.method !== 'eth_chainId') }
}

const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result })

beforeEach(() => {
  for (const n of NAMES) { saved[n] = process.env[n]; delete process.env[n] }
  __resetChainIdentityCache()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n] }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('which endpoint answers', () => {
  it('RPC_URL_<id> for the row\'s chain; a NEXT_PUBLIC_* value is never used, even when it is the only one set', async () => {
    process.env.RPC_URL_8453 = 'https://server-base.example/v2/k'
    process.env.NEXT_PUBLIC_BASE_RPC_URL = 'https://browser-base.example/v2/k'
    process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL = 'https://browser-arbitrum.example/v2/k'
    process.env.NEXT_PUBLIC_RPC_URL = 'https://browser-mainnet.example/v2/k'
    const net = stubFetch((url) => (url.includes('base') ? 8453 : url.includes('arb') ? 42161 : 1), () => ok({ found: true }))

    await expect(readChain(8453, 'eth_getTransactionByHash', [HASH])).resolves.toEqual({ found: true })
    await expect(readChain(42161, 'eth_getTransactionByHash', [HASH])).resolves.toEqual({ found: true })
    await expect(readChain(1, 'eth_getTransactionByHash', [HASH])).resolves.toEqual({ found: true })

    const hosts = new Set(net.sent.map((s) => new URL(s.url).host))
    expect(hosts).toEqual(new Set(['server-base.example', 'arb1.arbitrum.io', 'eth.llamarpc.com']))
    expect([...hosts].some((h) => h.startsWith('browser-'))).toBe(false)
  })

  it('mainnet: RPC_URL_1, then the legacy RPC_URL', async () => {
    process.env.RPC_URL = 'https://legacy-mainnet.example'
    const net = stubFetch(() => 1, () => ok({ found: true }))
    await readChain(1, 'eth_getTransactionReceipt', [HASH])
    expect(new URL(net.reads()[0].url).host).toBe('legacy-mainnet.example')
    __resetChainIdentityCache()
    process.env.RPC_URL_1 = 'https://first-mainnet.example'
    await readChain(1, 'eth_getTransactionReceipt', [HASH])
    expect(new URL(net.reads()[1].url).host).toBe('first-mainnet.example')
  })

  it('a chain the app does not have: rpc_error, and nothing is sent', async () => {
    const net = stubFetch(() => 1, () => ok(null))
    await expect(readChain(10, 'eth_getTransactionByHash', [HASH])).rejects.toMatchObject({ code: 'rpc_error' })
    expect(net.sent).toEqual([])
  })
})

describe('the endpoint must have proved it serves the row\'s chain', () => {
  it('an endpoint that answers for ANOTHER chain is refused: no read is sent to it', async () => {
    process.env.RPC_URL_8453 = 'https://points-at-mainnet.example'
    const net = stubFetch(() => 1, () => ok({ from: '0x' }))
    await expect(readChain(8453, 'eth_getTransactionByHash', [HASH])).rejects.toMatchObject({ code: 'rpc_wrong_chain' })
    expect(net.reads()).toEqual([])
  })

  it('an endpoint whose chain could not be proved (down, or a malformed eth_chainId) is refused too', async () => {
    process.env.RPC_URL_1 = 'https://down.example'
    const net = stubFetch(() => 'down', () => ok({ from: '0x' }))
    await expect(readChain(1, 'eth_getTransactionByHash', [HASH])).rejects.toMatchObject({ code: 'rpc_unverified' })
    expect(net.reads()).toEqual([])
  })

  it('the proof is asked once per endpoint, not once per read', async () => {
    process.env.RPC_URL_1 = 'https://mainnet.example'
    const net = stubFetch(() => 1, () => ok({ found: true }))
    await readChain(1, 'eth_getTransactionByHash', [HASH])
    await readChain(1, 'eth_getTransactionReceipt', [HASH])
    await readChain(1, 'eth_getTransactionByHash', [HASH])
    expect(net.sent.filter((s) => s.method === 'eth_chainId')).toHaveLength(1)
    expect(net.reads()).toHaveLength(3)
  })
})

describe('a null answer ("no such transaction yet") is asked once more, after a pause', () => {
  beforeEach(() => {
    process.env.RPC_URL_1 = 'https://mainnet.example/v2/SECRET-KEY'
    process.env.SWAP_VERIFY_MISSING_RETRY_MS = '0'
  })

  it('null twice: null is the answer, after exactly two reads (never a third)', async () => {
    const net = stubFetch(() => 1, () => ok(null))
    await expect(readChain(1, 'eth_getTransactionReceipt', [HASH])).resolves.toBeNull()
    expect(net.reads()).toHaveLength(SWAP_VERIFY_RPC_ATTEMPTS)
  })

  it('null, then the transaction (the node caught up): the second answer is returned', async () => {
    const net = stubFetch(() => 1, (_sent, attempt) => ok(attempt === 1 ? null : { hash: HASH }))
    await expect(readChain(1, 'eth_getTransactionByHash', [HASH])).resolves.toEqual({ hash: HASH })
    expect(net.reads()).toHaveLength(2)
  })

  it('null, then a failure: rpc_error (the null is not kept as the answer), two reads', async () => {
    const net = stubFetch(() => 1, (_sent, attempt) => (attempt === 1 ? ok(null) : new Response('x', { status: 502 })))
    await expect(readChain(1, 'eth_getTransactionByHash', [HASH])).rejects.toMatchObject({ code: 'rpc_error' })
    expect(net.reads()).toHaveLength(2)
  })

  it('a failure, then null: the one retry is spent, null is the answer, two reads', async () => {
    const net = stubFetch(() => 1, (_sent, attempt) => (attempt === 1 ? new Response('x', { status: 502 }) : ok(null)))
    await expect(readChain(1, 'eth_getTransactionByHash', [HASH])).resolves.toBeNull()
    expect(net.reads()).toHaveLength(2)
  })

  it('an answer that is not null is never asked again', async () => {
    const net = stubFetch(() => 1, () => ok({ hash: HASH }))
    await readChain(1, 'eth_getTransactionByHash', [HASH])
    expect(net.reads()).toHaveLength(1)
  })

  // The pause on a fake clock: the second read is sent exactly when the pause ends, not before.
  const pauses: Array<[string, string | undefined, number]> = [
    ['not set: the default', undefined, SWAP_VERIFY_MISSING_RETRY_DELAY_MS],
    ['a shorter pause', '200', 200],
    ['a longer pause is capped at the default', '9999', SWAP_VERIFY_MISSING_RETRY_DELAY_MS],
    ['not a number: the default', 'soon', SWAP_VERIFY_MISSING_RETRY_DELAY_MS],
    ['negative: the default', '-5', SWAP_VERIFY_MISSING_RETRY_DELAY_MS],
    ['a fraction: the default', '0.5', SWAP_VERIFY_MISSING_RETRY_DELAY_MS],
    ['empty: the default', '', SWAP_VERIFY_MISSING_RETRY_DELAY_MS],
  ]
  it.each(pauses)('SWAP_VERIFY_MISSING_RETRY_MS %s', async (_name, value, expected) => {
    if (value === undefined) delete process.env.SWAP_VERIFY_MISSING_RETRY_MS
    else process.env.SWAP_VERIFY_MISSING_RETRY_MS = value
    expect(SWAP_VERIFY_MISSING_RETRY_DELAY_MS).toBe(1_500)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const net = stubFetch(() => 1, () => ok(null))
    const pending = readChain(1, 'eth_getTransactionReceipt', [HASH])
    await vi.advanceTimersByTimeAsync(expected - 1)
    expect(net.reads()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBeNull()
    expect(net.reads()).toHaveLength(2)
  })
})

describe('one retry at most and an explicit timeout', () => {
  beforeEach(() => {
    process.env.RPC_URL_1 = 'https://mainnet.example/v2/SECRET-KEY'
  })

  const failures: Array<[string, () => Response | Promise<Response>]> = [
    ['an HTTP 500', () => new Response('upstream', { status: 500 })],
    ['an HTTP 429', () => new Response('slow down', { status: 429 })],
    ['a JSON-RPC error envelope', () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } })],
    // An answer that carries an error is never used, whatever else it carries.
    ['an error envelope that also has a null result', () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' }, result: null })],
    ['an error envelope that also has a result', () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' }, result: { status: '0x1' } })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a JSON body with no result member', () => Response.json({ jsonrpc: '2.0', id: 1 })],
    ['a JSON array', () => Response.json([1, 2])],
    ['a transport error', () => { throw new TypeError('fetch failed') }],
  ]
  it.each(failures)('%s on both attempts: rpc_error after exactly two attempts', async (_name, fail) => {
    const net = stubFetch(() => 1, fail)
    const err = await readChain(1, 'eth_getTransactionByHash', [HASH]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChainReadError)
    expect((err as ChainReadError).code).toBe('rpc_error')
    expect(net.reads()).toHaveLength(SWAP_VERIFY_RPC_ATTEMPTS)
    expect(SWAP_VERIFY_RPC_ATTEMPTS).toBe(2)
  })

  it('a failure then an answer: the one retry returns the answer', async () => {
    const net = stubFetch(() => 1, (_sent, attempt) => (attempt === 1 ? new Response('x', { status: 502 }) : ok({ hash: HASH })))
    await expect(readChain(1, 'eth_getTransactionByHash', [HASH])).resolves.toEqual({ hash: HASH })
    expect(net.reads()).toHaveLength(2)
  })

  it('an endpoint that never answers: each attempt is aborted at the timeout, then rpc_error', async () => {
    const signals: AbortSignal[] = []
    const hang = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string }
      if (body.method === 'eth_chainId') return Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' }))
      const signal = init?.signal as AbortSignal
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason))
      })
    })
    vi.stubGlobal('fetch', hang)
    const started = Date.now()
    await expect(readChain(1, 'eth_getTransactionByHash', [HASH])).rejects.toMatchObject({ code: 'rpc_error' })
    const elapsed = Date.now() - started
    // Exactly two attempts, each ended by ITS OWN timeout signal (not by the test, not by a third attempt): the wait
    // is bounded by two timeouts. Only the lower bound is asserted on the clock, so a busy machine can not fail it.
    expect(signals).toHaveLength(2)
    expect(signals.every((s) => s.aborted)).toBe(true)
    expect(signals.every((s) => (s.reason as Error | undefined)?.name === 'TimeoutError')).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(SWAP_VERIFY_RPC_TIMEOUT_MS)
  }, 60_000)

  it('no error ever carries the endpoint URL (the key lives in its path)', async () => {
    stubFetch(() => 1, () => { throw new Error('getaddrinfo ENOTFOUND mainnet.example/v2/SECRET-KEY') })
    const err = (await readChain(1, 'eth_getTransactionByHash', [HASH]).catch((e: unknown) => e)) as ChainReadError
    expect(err.message).toBe('rpc_error')
    expect(`${err.name} ${err.message} ${String(err.stack)} ${JSON.stringify(err)}`).not.toContain('SECRET-KEY')
    expect(`${err.message}`).not.toContain('mainnet.example')
  })

  it('every read is a POST with no cache and the JSON-RPC method asked for', async () => {
    const inits: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init as RequestInit)
      const body = JSON.parse(String(init?.body)) as { method: string }
      return Response.json({ jsonrpc: '2.0', id: 1, result: body.method === 'eth_chainId' ? '0x1' : { status: '0x1' } })
    }))
    await readChain(1, 'eth_getTransactionReceipt', [HASH])
    const read = inits.find((i) => String(i.body).includes('eth_getTransactionReceipt')) as RequestInit
    expect(read.method).toBe('POST')
    expect(read.cache).toBe('no-store')
    expect(JSON.parse(String(read.body))).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [HASH] })
    expect(read.signal).toBeInstanceOf(AbortSignal)
  })
})
