// @vitest-environment jsdom
/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] useOrderExecutions — ONE fetch per active card feeding BOTH the ring
 * (lastFillAtMs) and the fills timeline. Refreshes every 30s, pauses while the tab is hidden, refetches
 * immediately on a dca_execution event for this order, and computes lastFillAtMs = max(created_at).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useOrderExecutions } from './useOrderExecutions'
import type { OrderEngineEvent } from '@/lib/order-engine'

const ID = 'order-123'
const WALLET = '0x1111111111111111111111111111111111111111'
const fetchMock = vi.fn()
let hidden = false

function setHidden(v: boolean) { hidden = v }

beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue({ json: async () => ({ executions: [], order: { chain_id: 8453 } }) })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('useOrderExecutions', () => {
  it('fetches the executions endpoint once on mount when enabled', async () => {
    renderHook(() => useOrderExecutions(ID, WALLET, { enabled: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/api/orders/${ID}/executions?wallet=${WALLET}`)
  })

  it('does not fetch when disabled', async () => {
    renderHook(() => useOrderExecutions(ID, WALLET, { enabled: false }))
    await act(async () => { await vi.advanceTimersByTimeAsync(35_000) })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('computes lastFillAtMs = max(created_at), null when there are no fills', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ executions: [
      { id: '1', execution_number: 1, created_at: '2026-06-01T00:00:00Z', amount_in: '1', amount_out: '1', tx_hash: '0xa', status: 'confirmed' },
      { id: '2', execution_number: 2, created_at: '2026-06-02T00:00:00Z', amount_in: '1', amount_out: '1', tx_hash: '0xb', status: 'confirmed' },
    ], order: { chain_id: 8453 } }) })
    const { result } = renderHook(() => useOrderExecutions(ID, WALLET, { enabled: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.lastFillAtMs).toBe(Date.parse('2026-06-02T00:00:00Z'))
    expect(result.current.executions).toHaveLength(2)
  })

  it('lastFillAtMs is null with zero fills', async () => {
    const { result } = renderHook(() => useOrderExecutions(ID, WALLET, { enabled: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.lastFillAtMs).toBeNull()
  })

  it('refreshes on a 30s interval', async () => {
    renderHook(() => useOrderExecutions(ID, WALLET, { enabled: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT poll while the tab is hidden', async () => {
    renderHook(() => useOrderExecutions(ID, WALLET, { enabled: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) }) // mount fetch = 1
    setHidden(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetchMock).toHaveBeenCalledTimes(1) // interval ticks skipped while hidden
  })

  it('refetches immediately on a dca_execution event for this order', async () => {
    const { rerender } = renderHook(
      ({ evt }: { evt: OrderEngineEvent | null }) => useOrderExecutions(ID, WALLET, { enabled: true, latestEvent: evt }),
      { initialProps: { evt: null as OrderEngineEvent | null } },
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    rerender({ evt: { type: 'dca_execution', orderId: ID, executionNumber: 2 } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  // [A87b R2-1] A live order's fills need the wallet's read signature.
  it('sends the cached read-signature headers the Orders tab holds (no extra prompt: nothing is signed here)', async () => {
    const { storeOrdersReadAuth, ORDERS_READ_HEADER_SIGNATURE, ORDERS_READ_HEADER_ISSUED } = await import('@/lib/order-engine/read-auth')
    sessionStorage.clear()
    storeOrdersReadAuth(WALLET, { issuedAt: Math.floor(Date.now() / 1000), signature: `0x${'ab'.repeat(65)}` })
    renderHook(() => useOrderExecutions(ID, WALLET, { enabled: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1]
    expect(Object.keys(init.headers).sort()).toEqual([ORDERS_READ_HEADER_ISSUED, ORDERS_READ_HEADER_SIGNATURE])
    sessionStorage.clear()
  })

  it('a 401 that stays a 401 keeps the fills already on screen (never blanks them as "no fills")', async () => {
    sessionStorage.clear()
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ executions: [
      { id: '1', execution_number: 1, created_at: '2026-06-01T00:00:00Z', amount_in: '1', amount_out: '1', tx_hash: '0xa', status: 'confirmed' },
    ], order: { chain_id: 8453, dca_executed: 1 } }) })
    const { result } = renderHook(() => useOrderExecutions(ID, WALLET, { enabled: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.executions).toHaveLength(1)
    fetchMock.mockResolvedValue({ status: 401, json: async () => ({ code: 'READ_AUTH_REQUIRED', error: 'x' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    expect(result.current.executions).toHaveLength(1)
    expect(result.current.orderMeta).toMatchObject({ dca_executed: 1 })
    expect(result.current.loading).toBe(false)
  })
})
