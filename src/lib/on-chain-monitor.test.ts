/**
 * Unit tests for src/lib/on-chain-monitor.ts — P47 on-chain event monitoring.
 *
 * Tests cover: event classification (OrderExecuted, ExecutorChangeProposed,
 * AdminTransferred, SwapWithFee), severity assignment, large fee elevation,
 * block range chunking, RPC failure graceful skip, scan cadence gating,
 * alert routing by severity, and KV persistence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  scanContractEvents,
  shouldRunOnChainScan,
  runOnChainScan,
  _internal,
  type OnChainEvent,
} from './on-chain-monitor'

// ── Mocks ────────────────────────────────────────────────

const mockGetLogs = vi.fn().mockResolvedValue([])
const mockGetBlockNumber = vi.fn().mockResolvedValue(20000000n)

vi.mock('viem', async () => {
  const actual = await vi.importActual('viem')
  return {
    ...actual,
    createPublicClient: () => ({
      getLogs: (...args: unknown[]) => mockGetLogs(...args),
      getBlockNumber: () => mockGetBlockNumber(),
    }),
  }
})

const mockKvSet = vi.fn().mockResolvedValue(undefined)
const mockKvGet = vi.fn().mockResolvedValue(null)
const mockKvIncr = vi.fn().mockResolvedValue(5) // defaults to trigger (5 % 5 === 0)

vi.mock('@/lib/kv', () => ({
  kv: {
    set: (...args: unknown[]) => mockKvSet(...args),
    get: (...args: unknown[]) => mockKvGet(...args),
    incr: (...args: unknown[]) => mockKvIncr(...args),
  },
}))

const mockEmitTransitionAlert = vi.fn().mockResolvedValue(undefined)
vi.mock('./alert-wrapper', () => ({
  emitTransitionAlert: (...args: unknown[]) => mockEmitTransitionAlert(...args),
}))

// ── Helpers ──────────────────────────────────────────────

const { TOPICS, MAX_BLOCKS_PER_SCAN, classifyOrderExecutorEvent, classifyFeeCollectorEvent, LARGE_FEE_THRESHOLD } = _internal

/** Create a mock log with the given topic0 */
function makeLog(topic0: string, opts?: {
  topics?: string[]
  data?: string
  transactionHash?: string
  blockNumber?: bigint
  address?: string
}) {
  return {
    address: opts?.address ?? '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130',
    topics: [topic0, ...(opts?.topics ?? [])],
    data: opts?.data ?? '0x',
    transactionHash: opts?.transactionHash ?? '0x' + 'a'.repeat(64),
    blockNumber: opts?.blockNumber ?? 20000000n,
    logIndex: 0,
    blockHash: '0x' + '0'.repeat(64),
    transactionIndex: 0,
    removed: false,
  }
}

// ── Tests ────────────────────────────────────────────────

describe('event classification', () => {

  describe('OrderExecutor events', () => {
    it('classifies OrderExecuted as info', () => {
      const result = classifyOrderExecutorEvent(TOPICS.OrderExecuted)
      expect(result).toEqual({ eventName: 'OrderExecuted', severity: 'info', contract: 'OrderExecutor' })
    })

    it('classifies OrderCancelled as info', () => {
      const result = classifyOrderExecutorEvent(TOPICS.OrderCancelled)
      expect(result).toEqual({ eventName: 'OrderCancelled', severity: 'info', contract: 'OrderExecutor' })
    })

    it('classifies ExecutorChangeProposed as critical', () => {
      const result = classifyOrderExecutorEvent(TOPICS.ExecutorChangeProposed)
      expect(result?.severity).toBe('critical')
      expect(result?.eventName).toBe('ExecutorChangeProposed')
    })

    it('classifies AdminTransferred as critical', () => {
      const result = classifyOrderExecutorEvent(TOPICS.AdminTransferred)
      expect(result?.severity).toBe('critical')
    })

    it('classifies RouterWhitelisted as critical', () => {
      const result = classifyOrderExecutorEvent(TOPICS.RouterWhitelisted)
      expect(result?.severity).toBe('critical')
    })

    it('classifies Paused as critical', () => {
      const result = classifyOrderExecutorEvent(TOPICS.Paused)
      expect(result?.severity).toBe('critical')
    })

    it('classifies Unpaused as critical', () => {
      const result = classifyOrderExecutorEvent(TOPICS.Unpaused)
      expect(result?.severity).toBe('critical')
    })

    it('classifies TimelockQueued as critical', () => {
      const result = classifyOrderExecutorEvent(TOPICS.TimelockQueued)
      expect(result?.severity).toBe('critical')
    })

    it('classifies SweepQueued as warning', () => {
      const result = classifyOrderExecutorEvent(TOPICS.SweepQueued)
      expect(result?.severity).toBe('warning')
    })

    it('returns null for unknown topic', () => {
      expect(classifyOrderExecutorEvent('0xdeadbeef')).toBeNull()
    })
  })

  describe('FeeCollector events', () => {
    it('classifies SwapWithFee as info', () => {
      const result = classifyFeeCollectorEvent(TOPICS.SwapWithFee)
      expect(result).toEqual({ eventName: 'SwapWithFee', severity: 'info', contract: 'FeeCollector' })
    })

    it('classifies OwnershipTransferred as critical', () => {
      const result = classifyFeeCollectorEvent(TOPICS.OwnershipTransferred)
      expect(result?.severity).toBe('critical')
    })

    it('returns null for unknown topic', () => {
      expect(classifyFeeCollectorEvent('0xdeadbeef')).toBeNull()
    })
  })
})

describe('large fee elevation', () => {
  it('keeps SwapWithFee as info when fee is small', () => {
    const smallFee = (LARGE_FEE_THRESHOLD - 1n).toString(16).padStart(64, '0')
    const data = '0x' + '0'.repeat(64) + '0'.repeat(64) + smallFee
    const log = makeLog(TOPICS.SwapWithFee, { data })

    const event: OnChainEvent = {
      contract: 'FeeCollector',
      eventName: 'SwapWithFee',
      txHash: '0x' + 'a'.repeat(64),
      blockNumber: 20000000,
      args: {},
      severity: 'info',
    }

    const result = _internal.maybeElevateFeeEvent(event, log as any)
    expect(result.severity).toBe('info')
  })

  it('elevates SwapWithFee to warning when fee >= 1 ETH', () => {
    const largeFee = LARGE_FEE_THRESHOLD.toString(16).padStart(64, '0')
    const data = '0x' + '0'.repeat(64) + '0'.repeat(64) + largeFee
    const log = makeLog(TOPICS.SwapWithFee, { data })

    const event: OnChainEvent = {
      contract: 'FeeCollector',
      eventName: 'SwapWithFee',
      txHash: '0x' + 'a'.repeat(64),
      blockNumber: 20000000,
      args: {},
      severity: 'info',
    }

    const result = _internal.maybeElevateFeeEvent(event, log as any)
    expect(result.severity).toBe('warning')
  })
})

describe('scanContractEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetLogs.mockResolvedValue([])
  })

  it('returns parsed events from both contracts', async () => {
    // OrderExecutor returns an AdminTransferred log
    // FeeCollector returns a SwapWithFee log
    mockGetLogs
      .mockResolvedValueOnce([makeLog(TOPICS.AdminTransferred, {
        topics: ['0x' + '0'.repeat(64), '0x' + '1'.repeat(64)],
        transactionHash: '0x' + 'b'.repeat(64),
      })])
      .mockResolvedValueOnce([makeLog(TOPICS.SwapWithFee, {
        data: '0x' + '0'.repeat(192),
        transactionHash: '0x' + 'c'.repeat(64),
      })])

    const mockClient = {
      getLogs: mockGetLogs,
    } as any

    const events = await scanContractEvents(20000000, 20000100, mockClient)
    expect(events).toHaveLength(2)

    const admin = events.find(e => e.eventName === 'AdminTransferred')
    expect(admin?.severity).toBe('critical')
    expect(admin?.contract).toBe('OrderExecutor')

    const swap = events.find(e => e.eventName === 'SwapWithFee')
    expect(swap?.severity).toBe('info')
    expect(swap?.contract).toBe('FeeCollector')
  })

  it('caps block range to MAX_BLOCKS_PER_SCAN', async () => {
    const mockClient = {
      getLogs: mockGetLogs,
    } as any

    await scanContractEvents(20000000, 20005000, mockClient)

    // Both getLogs calls should use capped toBlock
    for (const call of mockGetLogs.mock.calls) {
      const args = call[0] as { toBlock: bigint }
      expect(Number(args.toBlock)).toBeLessThanOrEqual(20000000 + MAX_BLOCKS_PER_SCAN - 1)
    }
  })

  it('handles empty logs gracefully', async () => {
    const mockClient = { getLogs: mockGetLogs } as any
    const events = await scanContractEvents(20000000, 20000100, mockClient)
    expect(events).toEqual([])
  })
})

describe('shouldRunOnChainScan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true on every 5th tick', async () => {
    mockKvIncr.mockResolvedValue(10)
    expect(await shouldRunOnChainScan()).toBe(true)
  })

  it('returns false on non-5th tick', async () => {
    mockKvIncr.mockResolvedValue(7)
    expect(await shouldRunOnChainScan()).toBe(false)
  })

  it('returns false on KV failure', async () => {
    mockKvIncr.mockRejectedValue(new Error('KV unavailable'))
    expect(await shouldRunOnChainScan()).toBe(false)
  })
})

describe('runOnChainScan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBlockNumber.mockResolvedValue(20000100n)
    mockKvGet.mockResolvedValue(20000000) // last scanned block
    mockGetLogs.mockResolvedValue([])
  })

  it('scans from last-block+1 to current block', async () => {
    const result = await runOnChainScan()
    expect(result).not.toBeNull()
    expect(result!.fromBlock).toBe(20000001)
    expect(result!.toBlock).toBe(20000100)
  })

  it('advances last-block KV on success', async () => {
    await runOnChainScan()
    expect(mockKvSet).toHaveBeenCalledWith(
      _internal.LAST_BLOCK_KEY,
      20000100,
    )
  })

  it('returns null and does NOT advance last-block on RPC failure', async () => {
    mockGetLogs.mockRejectedValue(new Error('RPC timeout'))

    const result = await runOnChainScan()
    expect(result).toBeNull()

    // Should NOT have written last-block
    const lastBlockWrites = mockKvSet.mock.calls.filter(
      (call: unknown[]) => call[0] === _internal.LAST_BLOCK_KEY,
    )
    expect(lastBlockWrites).toHaveLength(0)
  })

  it('emits P0 alert for critical events', async () => {
    mockGetLogs
      .mockResolvedValueOnce([makeLog(TOPICS.AdminTransferred, {
        topics: ['0x' + '0'.repeat(64), '0x' + '1'.repeat(64)],
      })])
      .mockResolvedValueOnce([])

    const result = await runOnChainScan()
    expect(result!.criticalCount).toBe(1)
    expect(mockEmitTransitionAlert).toHaveBeenCalledWith(
      'onchain-orderexecutor',
      'active',
      'disabled',
      expect.stringContaining('on-chain-critical'),
    )
  })

  it('does NOT emit alert for info events', async () => {
    mockGetLogs
      .mockResolvedValueOnce([makeLog(TOPICS.OrderExecuted)])
      .mockResolvedValueOnce([])

    const result = await runOnChainScan()
    expect(result!.infoCount).toBe(1)
    expect(mockEmitTransitionAlert).not.toHaveBeenCalled()
  })

  it('handles first run (no last-block in KV) by scanning last 100 blocks', async () => {
    mockKvGet.mockResolvedValue(null)
    mockGetBlockNumber.mockResolvedValue(20000500n)

    const result = await runOnChainScan()
    expect(result!.fromBlock).toBe(20000400) // 20000500 - 100
  })

  it('returns no-op result when no new blocks', async () => {
    mockKvGet.mockResolvedValue(20000100) // last scanned = current
    mockGetBlockNumber.mockResolvedValue(20000100n)

    const result = await runOnChainScan()
    expect(result!.eventsFound).toBe(0)
  })

  it('caps scan range when gap > MAX_BLOCKS_PER_SCAN', async () => {
    mockKvGet.mockResolvedValue(19995000) // 5000 blocks behind
    mockGetBlockNumber.mockResolvedValue(20000100n)

    const result = await runOnChainScan()
    // Should scan at most MAX_BLOCKS_PER_SCAN blocks
    expect(result!.toBlock - result!.fromBlock + 1).toBeLessThanOrEqual(MAX_BLOCKS_PER_SCAN)
    // Last-block should advance to capped range, not current block
    const lastBlockWrite = mockKvSet.mock.calls.find(
      (call: unknown[]) => call[0] === _internal.LAST_BLOCK_KEY,
    )
    expect(lastBlockWrite![1]).toBeLessThanOrEqual(19995001 + MAX_BLOCKS_PER_SCAN - 1)
  })
})
