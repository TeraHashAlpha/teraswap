/**
 * [AUDIT-W7 / W7-L-01] cow-fee-monitor — systematic CoW fee-zeroing alert.
 *
 * The counter + threshold gate WHEN an alert fires; the alert itself goes
 * through the real `emitTransitionAlert` fan-out (mocked here). KV is mocked so
 * we drive the windowed count deterministically and prove the fail-open path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockIncr = vi.fn<() => Promise<number>>()
const mockExpire = vi.fn(async () => 1)
vi.mock('@/lib/kv', () => ({
  kv: {
    incr: (...a: unknown[]) => mockIncr(...(a as [])),
    expire: (...a: unknown[]) => mockExpire(...(a as [])),
  },
}))

const mockEmit = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {})
vi.mock('@/lib/alert-wrapper', () => ({
  emitTransitionAlert: (...a: unknown[]) => mockEmit(...a),
}))

import {
  recordCowFeeZeroing,
  COW_FEE_ZERO_ALERT_THRESHOLD,
  COW_FEE_ZERO_SOURCE_ID,
  COW_FEE_ZERO_WINDOW_SECONDS,
} from './cow-fee-monitor'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('recordCowFeeZeroing', () => {
  it('does NOT alert below the threshold', async () => {
    mockIncr.mockResolvedValue(COW_FEE_ZERO_ALERT_THRESHOLD - 1)
    await recordCowFeeZeroing(400, 'appData partnerFee rejected')
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('alerts exactly when the count reaches the threshold', async () => {
    mockIncr.mockResolvedValue(COW_FEE_ZERO_ALERT_THRESHOLD)
    await recordCowFeeZeroing(400, 'appData partnerFee rejected')
    expect(mockEmit).toHaveBeenCalledTimes(1)
    const [sourceId, from, to, reason] = mockEmit.mock.calls[0]
    expect(sourceId).toBe(COW_FEE_ZERO_SOURCE_ID)
    expect(from).toBe('active')
    expect(to).toBe('active') // non-transition informational convention
    expect(String(reason)).toMatch(/0\.1% fee is being DROPPED/i)
    expect(String(reason)).toMatch(/revenue loss/i)
  })

  it('keeps alerting above the threshold (downstream dedup handles repeats)', async () => {
    mockIncr.mockResolvedValue(COW_FEE_ZERO_ALERT_THRESHOLD + 10)
    await recordCowFeeZeroing(400, 'schema')
    expect(mockEmit).toHaveBeenCalledTimes(1)
  })

  it('sets the window TTL only on the first event (count === 1)', async () => {
    mockIncr.mockResolvedValue(1)
    await recordCowFeeZeroing(400, 'schema')
    expect(mockExpire).toHaveBeenCalledWith(expect.any(String), COW_FEE_ZERO_WINDOW_SECONDS)
    expect(mockEmit).not.toHaveBeenCalled()

    vi.clearAllMocks()
    mockIncr.mockResolvedValue(2)
    await recordCowFeeZeroing(400, 'schema')
    expect(mockExpire).not.toHaveBeenCalled()
  })

  it('fails OPEN — a KV error never throws and never alerts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockIncr.mockRejectedValue(new Error('kv down'))
    await expect(recordCowFeeZeroing(400, 'schema')).resolves.toBeUndefined()
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('truncates a very long CoW reason in the alert', async () => {
    mockIncr.mockResolvedValue(COW_FEE_ZERO_ALERT_THRESHOLD)
    await recordCowFeeZeroing(400, 'x'.repeat(500))
    const reason = String(mockEmit.mock.calls[0][3])
    // 160-char reason cap + surrounding copy stays bounded.
    expect(reason.length).toBeLessThan(400)
  })
})
