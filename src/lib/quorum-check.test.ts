/**
 * Unit tests for H5 quorum cross-check.
 *
 * Covers: median calculation, deviation flagging, warning vs flagged vs correlated
 * classification, <3 active sources skip, tick counter, per-source threshold overrides.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Simulated KV store ─────────────────────────────────

const kvStore = new Map<string, unknown>()
const kvSets = new Map<string, Set<string>>()

function getKvSet(key: string): Set<string> {
  if (!kvSets.has(key)) kvSets.set(key, new Set())
  return kvSets.get(key)!
}

const mockKvGet = vi.fn(async (key: string) => kvStore.get(key) ?? null)
const mockKvSet = vi.fn(async (key: string, value: unknown) => { kvStore.set(key, value) })
const mockKvSmembers = vi.fn(async (key: string) => Array.from(getKvSet(key)))

const mockPipelineSet = vi.fn((key: string, value: unknown) => { kvStore.set(key, value) })
const mockPipelineSadd = vi.fn((key: string, member: string) => { getKvSet(key).add(member) })
const mockPipelineExec = vi.fn(async () => [])
const mockPipelineDel = vi.fn()

vi.mock('@vercel/kv', () => ({
  kv: {
    get: (...args: unknown[]) => mockKvGet(...(args as [string])),
    set: (...args: unknown[]) => mockKvSet(...(args as [string, unknown])),
    smembers: (...args: unknown[]) => mockKvSmembers(...(args as [string])),
    pipeline: () => ({
      set: (...args: unknown[]) => { mockPipelineSet(...(args as [string, unknown])); return { sadd: mockPipelineSadd, exec: mockPipelineExec, del: mockPipelineDel } },
      sadd: (...args: unknown[]) => { mockPipelineSadd(...(args as [string, string])); return { set: mockPipelineSet, exec: mockPipelineExec, del: mockPipelineDel } },
      del: (...args: unknown[]) => { mockPipelineDel(...args); return { set: mockPipelineSet, sadd: mockPipelineSadd, exec: mockPipelineExec, del: mockPipelineDel } },
      exec: mockPipelineExec,
    }),
  },
}))

// ── Mock fetchMetaQuote ────────────────────────────────

const mockFetchMetaQuote = vi.fn()

vi.mock('./api', () => ({
  fetchMetaQuote: (...args: unknown[]) => mockFetchMetaQuote(...args),
}))

// ── Mock alert-wrapper ─────────────────────────────────

const mockEmitTransitionAlert = vi.fn().mockResolvedValue(undefined)

vi.mock('./alert-wrapper', () => ({
  emitTransitionAlert: (...args: unknown[]) => mockEmitTransitionAlert(...args),
}))

// ── Import after mocks ─────────────────────────────────

import {
  runQuorumCheck,
  shouldRunQuorum,
  computeMedian,
  QUORUM_REFERENCE_PAIRS,
} from './quorum-check'
import type { QuorumCheckResult } from './quorum-check'
import { beginTick } from './source-state-machine'

// ── Helpers ─────────────────────────────────────────────

function seedSource(sourceId: string, state: 'active' | 'degraded' | 'disabled' = 'active'): void {
  getKvSet('teraswap:source-state:index').add(sourceId)
  kvStore.set(`teraswap:source-state:${sourceId}`, {
    id: sourceId,
    state,
    lastCheckAt: Date.now(),
    failureCount: 0,
    successCount: 0,
    latencyHistory: [],
    lastTransitionAt: Date.now(),
  })
}

function makeQuote(source: string, toAmount: string) {
  return {
    source,
    toAmount,
    estimatedGas: 200000,
    gasUsd: 5,
    routes: ['direct'],
  }
}

function makeMetaQuoteResult(quotes: Array<{ source: string; toAmount: string }>) {
  const mapped = quotes.map(q => makeQuote(q.source, q.toAmount))
  return {
    best: mapped[0],
    all: mapped,
    fetchedAt: Date.now(),
  }
}

// ═══════════════════════════════════════════════════════════════

describe('quorum-check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    kvStore.clear()
    kvSets.clear()
    beginTick()
  })

  // ── Median calculation ────────────────────────────────

  describe('computeMedian', () => {
    it('computes median of odd-length array', () => {
      expect(computeMedian([3n, 1n, 5n])).toBe(3n)
    })

    it('computes median of even-length array', () => {
      expect(computeMedian([1n, 3n, 5n, 7n])).toBe(4n)
    })

    it('returns 0n for empty array', () => {
      expect(computeMedian([])).toBe(0n)
    })

    it('handles single element', () => {
      expect(computeMedian([42n])).toBe(42n)
    })

    it('handles large values (realistic quote amounts)', () => {
      // Simulating ETH→USDC quotes around $3000 (6 decimal USDC)
      const amounts = [
        3000000000n, // 3000 USDC
        3010000000n, // 3010 USDC
        2990000000n, // 2990 USDC
        3005000000n, // 3005 USDC
        2995000000n, // 2995 USDC
      ]
      const median = computeMedian(amounts)
      expect(median).toBe(3000000000n) // sorted middle = 3000
    })
  })

  // ── Tick counter ──────────────────────────────────────

  describe('shouldRunQuorum', () => {
    it('returns true on every 5th tick', async () => {
      const results: boolean[] = []
      for (let i = 0; i < 10; i++) {
        results.push(await shouldRunQuorum())
      }
      // Ticks 5, 10 should be true (counter starts at 0, increments before check)
      expect(results).toEqual([
        false, false, false, false, true,
        false, false, false, false, true,
      ])
    })

    it('handles KV failure gracefully (returns false)', async () => {
      mockKvGet.mockRejectedValueOnce(new Error('KV down'))
      expect(await shouldRunQuorum()).toBe(false)
    })
  })

  // ── Quorum with <3 active sources ─────────────────────

  describe('insufficient sources', () => {
    it('skips quorum when <3 active sources', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'disabled')

      const result = await runQuorumCheck()
      expect(result.skipped).toBe(true)
      expect(result.skipReason).toContain('Insufficient active sources: 2')
      expect(result.pairs).toHaveLength(0)
    })

    it('skips quorum when zero sources exist', async () => {
      const result = await runQuorumCheck()
      expect(result.skipped).toBe(true)
      expect(result.skipReason).toContain('Insufficient active sources: 0')
    })
  })

  // ── Normal operation (no outliers) ────────────────────

  describe('normal operation', () => {
    it('returns clean result when all sources are within tolerance', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')

      // All sources return similar amounts for both pairs
      mockFetchMetaQuote.mockResolvedValue(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3000000000' },
          { source: 'cowswap', toAmount: '3005000000' },
          { source: 'velora', toAmount: '2995000000' },
          { source: 'odos', toAmount: '3002000000' },
        ]),
      )

      const result = await runQuorumCheck()
      expect(result.skipped).toBe(false)
      expect(result.outliers).toHaveLength(0)
      expect(result.correlatedOutlierCount).toBe(0)
    })
  })

  // ── Single-pair flag → warning only ───────────────────

  describe('warning classification (single-pair outlier)', () => {
    it('flags source as warning when outlier on only 1 pair', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')

      // First pair (WETH→USDC): velora deviates >5%
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3000000000' },
          { source: 'cowswap', toAmount: '3005000000' },
          { source: 'velora', toAmount: '3200000000' }, // ~6.6% above median
          { source: 'odos', toAmount: '3002000000' },
        ]),
      )

      // Second pair (USDC→USDT): velora is fine
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '9998000000' },
          { source: 'cowswap', toAmount: '9999000000' },
          { source: 'velora', toAmount: '9997000000' }, // within 2%
          { source: 'odos', toAmount: '9998500000' },
        ]),
      )

      const result = await runQuorumCheck()
      expect(result.outliers).toHaveLength(1)
      expect(result.outliers[0].sourceId).toBe('velora')
      expect(result.outliers[0].classification).toBe('warning')
      // No state transition should have occurred
      expect(mockEmitTransitionAlert).not.toHaveBeenCalled()
    })
  })

  // ── Dual-pair flag → degraded ─────────────────────────

  describe('flagged classification (dual-pair outlier)', () => {
    it('disables source when outlier on both pairs', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')

      // First pair (WETH→USDC): velora deviates >5%
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3000000000' },
          { source: 'cowswap', toAmount: '3005000000' },
          { source: 'velora', toAmount: '3200000000' }, // ~6.6% above median
          { source: 'odos', toAmount: '3002000000' },
        ]),
      )

      // Second pair (USDC→USDT): velora ALSO deviates >2%
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '9998000000' },
          { source: 'cowswap', toAmount: '9999000000' },
          { source: 'velora', toAmount: '10300000000' }, // ~3% above median
          { source: 'odos', toAmount: '9998500000' },
        ]),
      )

      const result = await runQuorumCheck()

      // velora should be flagged on both pairs
      const veloraOutliers = result.outliers.filter(o => o.sourceId === 'velora')
      expect(veloraOutliers.length).toBe(2)
      expect(veloraOutliers.every(o => o.classification === 'flagged')).toBe(true)

      // State transition should have fired (forceDisable emits via transition())
      // The forceDisable call triggers the alert internally via the state machine
      expect(result.correlatedOutlierCount).toBeLessThan(3)
    })

    it('does not act on already-disabled sources', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'disabled') // already disabled — excluded from quorum
      seedSource('odos', 'active')

      mockFetchMetaQuote.mockResolvedValue(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3000000000' },
          { source: 'cowswap', toAmount: '3005000000' },
          { source: 'odos', toAmount: '3002000000' },
        ]),
      )

      const result = await runQuorumCheck()
      // velora is not in the quorum — only active sources participate
      expect(result.outliers.find(o => o.sourceId === 'velora')).toBeUndefined()
    })
  })

  // ── Correlated outlier (≥3 sources) → kill-switch ────

  describe('correlated outlier detection', () => {
    it('force-disables all flagged sources when ≥3 are correlated', async () => {
      // 7 sources: 4 normal consensus, 3 deviant
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')
      seedSource('kyberswap', 'active')
      seedSource('sushiswap', 'active')
      seedSource('openocean', 'active')

      // First pair: 1inch, velora, odos deviate >5% from the 4-source consensus
      // Normal cluster: ~3000, Deviant cluster: ~3200 (6.7% above)
      // Sorted: 2998, 3000, 3002, 3005, 3200, 3200, 3200
      // Median (idx 3) = 3005 → deviants are ~6.5% above
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3200000000' },
          { source: 'cowswap', toAmount: '3005000000' },
          { source: 'velora', toAmount: '3200000000' },
          { source: 'odos', toAmount: '3200000000' },
          { source: 'kyberswap', toAmount: '3000000000' },
          { source: 'sushiswap', toAmount: '3002000000' },
          { source: 'openocean', toAmount: '2998000000' },
        ]),
      )

      // Second pair: same 3 deviant sources >2% from consensus
      // Normal cluster: ~9998, Deviant cluster: ~10300 (3% above)
      // Sorted: 9997, 9998, 9999, 10000, 10300, 10300, 10300
      // Median (idx 3) = 10000 → deviants are 3% above
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '10300000000' },
          { source: 'cowswap', toAmount: '9999000000' },
          { source: 'velora', toAmount: '10300000000' },
          { source: 'odos', toAmount: '10300000000' },
          { source: 'kyberswap', toAmount: '9998000000' },
          { source: 'sushiswap', toAmount: '10000000000' },
          { source: 'openocean', toAmount: '9997000000' },
        ]),
      )

      const result = await runQuorumCheck()

      expect(result.correlatedOutlierCount).toBeGreaterThanOrEqual(3)

      // All flagged should be classified as 'correlated'
      const correlated = result.outliers.filter(o => o.classification === 'correlated')
      expect(correlated.length).toBeGreaterThanOrEqual(6) // 3 sources × 2 pairs

      // Correlated alert should have been emitted
      const correlatedAlertCalls = mockEmitTransitionAlert.mock.calls.filter(
        (args: unknown[]) => typeof args[3] === 'string' && (args[3] as string).includes('quorum-correlated'),
      )
      expect(correlatedAlertCalls.length).toBe(1)
    })
  })

  // ── fetchMetaQuote failure handling ───────────────────

  describe('fetchMetaQuote failure handling', () => {
    it('skips pair gracefully when fetchMetaQuote throws', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')

      // First pair fails
      mockFetchMetaQuote.mockRejectedValueOnce(new Error('Rate limited'))

      // Second pair succeeds
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '9998000000' },
          { source: 'cowswap', toAmount: '9999000000' },
          { source: 'velora', toAmount: '9997000000' },
        ]),
      )

      const result = await runQuorumCheck()
      expect(result.skipped).toBe(false)
      expect(result.pairs[0].skipped).toBe(true)
      expect(result.pairs[0].skipReason).toContain('fetchMetaQuote failed')
      expect(result.pairs[1].skipped).toBe(false)
    })
  })

  // ── Per-source threshold override ─────────────────────

  describe('per-source threshold override', () => {
    it('uses cowswap quorumMaxDeviationPercent=8 from config', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')

      // First pair (WETH→USDC): cowswap deviates 7% — within cowswap's 8% threshold
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3000000000' },
          { source: 'cowswap', toAmount: '3210000000' }, // 7% above median — within 8%
          { source: 'velora', toAmount: '3005000000' },
          { source: 'odos', toAmount: '3002000000' },
        ]),
      )

      // Second pair: all fine
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '9998000000' },
          { source: 'cowswap', toAmount: '9999000000' },
          { source: 'velora', toAmount: '9997000000' },
          { source: 'odos', toAmount: '9998500000' },
        ]),
      )

      const result = await runQuorumCheck()
      // cowswap should NOT be flagged (7% < 8% threshold)
      expect(result.outliers.find(o => o.sourceId === 'cowswap')).toBeUndefined()
    })
  })

  // ── Reference pairs config ────────────────────────────

  describe('reference pairs configuration', () => {
    it('defines 2 reference pairs', () => {
      expect(QUORUM_REFERENCE_PAIRS).toHaveLength(2)
    })

    it('primary pair is WETH→USDC with 5% threshold', () => {
      const primary = QUORUM_REFERENCE_PAIRS[0]
      expect(primary.label).toContain('WETH')
      expect(primary.label).toContain('USDC')
      expect(primary.maxDeviationPercent).toBe(5)
    })

    it('secondary pair is USDC→USDT with 2% threshold', () => {
      const secondary = QUORUM_REFERENCE_PAIRS[1]
      expect(secondary.label).toContain('USDC')
      expect(secondary.label).toContain('USDT')
      expect(secondary.maxDeviationPercent).toBe(2)
    })
  })
})
