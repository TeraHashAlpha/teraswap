// @vitest-environment node
/**
 * [ADR-029 section 7.3, goal 133b I.1 and I.5] The official client's confirmation (`updateSwapStatus`):
 *   - it sends the chain the transaction was sent on, `chainId`, beside the hash and the wallet;
 *   - on 202 (the server's node has not got the transaction yet; it kept the hash) it sends the SAME body again after
 *     2 s, 8 s and 30 s, then stops; no prompt, no visible change, nothing in the console;
 *   - any other answer ends it at once; a request that can not be sent logs the one warning there was before, once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { UPDATE_SWAP_STATUS_RETRY_DELAYS_MS, updateSwapStatus } from './analytics'

const HASH = `0x${'ab'.repeat(32)}`
const WALLET = '0x00000000000000000000000000000000000000c1'

let calls: Array<{ url: string; method: string; body: string; at: number }>
let warn: ReturnType<typeof vi.spyOn>
let consoleCalls: number

function answer(statuses: Array<number | 'network'>) {
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: String(init.body), at: Date.now() })
    const next = statuses[Math.min(i++, statuses.length - 1)]
    if (next === 'network') throw new TypeError('Failed to fetch')
    return new Response(next === 202 ? '{"ok":false,"outcome":"not_found"}' : '{"ok":true}', { status: next })
  }))
}

/** Lets the pending fetch promises settle, then moves the clock. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 })
  calls = []
  consoleCalls = 0
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {
    consoleCalls++
  })
  for (const level of ['log', 'info', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation(() => {
    consoleCalls++
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('updateSwapStatus', () => {
  it('sends the chain the transaction was sent on, with the hash and the wallet, as one PATCH', async () => {
    answer([200])
    updateSwapStatus({ txHash: HASH, status: 'confirmed', wallet: WALLET, chainId: 8453 })
    await advance(60_000)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: '/api/log-swap', method: 'PATCH' })
    expect(JSON.parse(calls[0].body)).toEqual({ txHash: HASH, status: 'confirmed', wallet: WALLET, chainId: 8453 })
    expect(consoleCalls).toBe(0)
  })

  it('on 202 it asks again after 2 s, 8 s and 30 s, with the same body, then stops; nothing in the console', async () => {
    expect([...UPDATE_SWAP_STATUS_RETRY_DELAYS_MS]).toEqual([2_000, 8_000, 30_000])
    answer([202])
    updateSwapStatus({ txHash: HASH, status: 'confirmed', wallet: WALLET, chainId: 1, mevSavingsActual: '5' })
    await advance(10 * 60_000)
    expect(calls.map((c) => c.at)).toEqual([0, 2_000, 10_000, 40_000])
    expect(new Set(calls.map((c) => c.body)).size).toBe(1)
    expect(consoleCalls).toBe(0)
  })

  it('an answer that is not 202 ends it: verified on the second asking means two requests', async () => {
    answer([202, 200])
    updateSwapStatus({ txHash: HASH, status: 'confirmed', wallet: WALLET, chainId: 1 })
    await advance(10 * 60_000)
    expect(calls.map((c) => c.at - calls[0].at)).toEqual([0, 2_000])
    for (const status of [200, 400, 409, 422, 429, 500]) {
      calls = []
      answer([status])
      updateSwapStatus({ txHash: HASH, status: 'failed', wallet: WALLET, chainId: 1 })
      await advance(10 * 60_000)
      expect(calls, String(status)).toHaveLength(1)
    }
    expect(consoleCalls).toBe(0)
  })

  it('a request that can not be sent: the one warning there was before, once, and no retry', async () => {
    answer(['network'])
    updateSwapStatus({ txHash: HASH, status: 'confirmed', wallet: WALLET, chainId: 1 })
    await advance(10 * 60_000)
    expect(calls).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toBe('[analytics] updateSwapStatus failed:')
    // A 202 first, then a network failure on the second asking: still one warning, and it ends there.
    calls = []
    warn.mockClear()
    answer([202, 'network'])
    updateSwapStatus({ txHash: HASH, status: 'confirmed', wallet: WALLET, chainId: 1 })
    await advance(10 * 60_000)
    expect(calls.map((c) => c.at - calls[0].at)).toEqual([0, 2_000])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a caller that knows no chain still sends its confirmation (the server then asks the candidate chains)', async () => {
    answer([200])
    updateSwapStatus({ txHash: HASH, status: 'confirmed', wallet: WALLET })
    await advance(1_000)
    expect(JSON.parse(calls[0].body)).toEqual({ txHash: HASH, status: 'confirmed', wallet: WALLET })
  })
})
