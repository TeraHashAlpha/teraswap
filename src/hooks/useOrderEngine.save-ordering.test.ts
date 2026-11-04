// @vitest-environment jsdom
/**
 * [fix/v1-maintenance C4] saveOrders write ordering.
 *
 * secureSet is async (AES-GCM) with a variable duration, so two overlapping saveOrders calls could finish
 * out of order and the OLDER list would win. Writes are now serialised per storage key: the later call is
 * always written last. Here secureSet is a controllable fake — each write stays pending until the test
 * settles it, and the test settles the NEWEST pending write first (the worst case).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface PendingWrite { key: string; value: unknown; settle: (ok: boolean) => void }
const h = vi.hoisted(() => ({
  pending: [] as Array<{ key: string; value: unknown; settle: (ok: boolean) => void }>,
  stored: new Map<string, unknown>(),
}))

vi.mock('@/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => null),
  secureSet: vi.fn((key: string, value: unknown) => new Promise<void>((resolve, reject) => {
    const w: PendingWrite = {
      key, value,
      settle: (ok) => { if (ok) { h.stored.set(key, value); resolve() } else reject(new Error('write failed')) },
    }
    h.pending.push(w)
  })),
  secureRemove: vi.fn(),
}))

import { saveOrders } from './useOrderEngine'
import type { AutonomousOrder } from '@/lib/order-engine/types'

const KEY = 'teraswap_orders_v4'
const order = (id: string) => ({ id, amount: 10n ** 18n }) as unknown as AutonomousOrder
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const ids = (v: unknown) => (v as Array<{ id: string }>).map((o) => o.id)

/** Settle the newest pending write first, until nothing is left in flight. */
async function drainNewestFirst(ok = true) {
  for (let i = 0; i < 20; i++) {
    await flush()
    const w = h.pending.pop()
    if (w) w.settle(ok)
  }
  await flush()
}

beforeEach(() => {
  h.pending.length = 0
  h.stored.clear()
})

describe('saveOrders — serialised per storage key [fix/v1-maintenance C4]', () => {
  it('two overlapping saves → the stored state is the LATER call\'s, even if the newest write is settled first', async () => {
    const p1 = saveOrders([order('A')])
    const p2 = saveOrders([order('A'), order('B')])
    await drainNewestFirst()
    await Promise.all([p1, p2])
    expect(ids(h.stored.get(KEY))).toEqual(['A', 'B'])
  })

  it('a second write does not start until the first has settled (queued, not concurrent)', async () => {
    const p1 = saveOrders([order('A')])
    const p2 = saveOrders([order('A'), order('B')])
    await flush()
    expect(h.pending.length).toBe(1)
    expect(ids(h.pending[0].value)).toEqual(['A'])
    h.pending.pop()!.settle(true)
    await flush()
    expect(h.pending.length).toBe(1)
    expect(ids(h.pending[0].value)).toEqual(['A', 'B'])
    h.pending.pop()!.settle(true)
    await Promise.all([p1, p2])
  })

  it('a failed earlier write does not block the later one', async () => {
    const p1 = saveOrders([order('A')])
    const p2 = saveOrders([order('A'), order('B')])
    const r1 = p1.catch((e: Error) => e.message)
    await flush()
    h.pending.pop()!.settle(false)
    await flush()
    h.pending.pop()!.settle(true)
    await p2
    expect(await r1).toBe('write failed')
    expect(ids(h.stored.get(KEY))).toEqual(['A', 'B'])
  })

  it('the payload is snapshotted at call time (BigInt → string), so later mutation cannot change it', async () => {
    const list = [order('A')]
    const p1 = saveOrders(list)
    list.push(order('LATE')) // mutation after the call
    await drainNewestFirst()
    await p1
    expect(ids(h.stored.get(KEY))).toEqual(['A'])
    expect((h.stored.get(KEY) as Array<{ amount: string }>)[0].amount).toBe('1000000000000000000')
  })
})
