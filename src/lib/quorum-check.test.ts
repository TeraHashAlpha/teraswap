/**
 * Unit tests for H5 quorum cross-check.
 *
 * Covers: median calculation, BigInt precision, deviation flagging, warning vs
 * flagged vs correlated classification, <3 active sources skip, tick counter
 * (atomic incr), per-source threshold overrides, P0 correlated reason.
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

// Atomic incr mock — mirrors Redis INCR (initializes to 1 if key absent)
const mockKvIncr = vi.fn(async (key: string) => {
  const current = (kvStore.get(key) as number) ?? 0
  const next = current + 1
  kvStore.set(key, next)
  return next
})

const mockPipelineSet = vi.fn((key: string, value: unknown) => { kvStore.set(key, value) })
const mockPipelineSadd = vi.fn((key: string, member: string) => { getKvSet(key).add(member) })
const mockPipelineExec = vi.fn(async () => [])
const mockPipelineDel = vi.fn()

vi.mock('@vercel/kv', () => ({
  kv: {
    get: (...args: unknown[]) => mockKvGet(...(args as [string])),
    set: (...args: unknown[]) => mockKvSet(...(args as [string, unknown])),
    smembers: (...args: unknown[]) => mockKvSmembers(...(args as [string])),
    incr: (...args: unknown[]) => mockKvIncr(...(args as [string])),
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
  computeDeviationPercent,
  iqrFilter,
  QUORUM_REFERENCE_PAIRS,
  MIN_ACTIVE_SOURCES,
} from './quorum-check'
import { beginTick } from './source-state-machine'
import { isP0Reason, P0_REASONS } from './p0-reasons'

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
      const amounts = [
        3000000000n, 3010000000n, 2990000000n, 3005000000n, 2995000000n,
      ]
      const median = computeMedian(amounts)
      expect(median).toBe(3000000000n)
    })
  })

  // ── BigInt-safe deviation calculation ─────────────────

  describe('computeDeviationPercent', () => {
    it('computes basic 10% deviation', () => {
      expect(computeDeviationPercent(110n, 100n)).toBe(10)
    })

    it('computes negative deviation (source below median)', () => {
      expect(computeDeviationPercent(90n, 100n)).toBe(10)
    })

    it('returns 0 for identical values', () => {
      expect(computeDeviationPercent(100n, 100n)).toBe(0)
    })

    it('returns 0 when median is 0', () => {
      expect(computeDeviationPercent(100n, 0n)).toBe(0)
    })

    it('handles BigInt amounts above Number.MAX_SAFE_INTEGER without precision loss', () => {
      // 2^53 + 1 = 9007199254740993 — NOT representable as a Number
      const base = 2n ** 53n
      const median = base + 1n           // 9007199254740993
      const sourceAmount = base + 100n   // 9007199254741092

      // Tiny deviation: 99 / 9007199254740993 ≈ 0.000000001%
      // BPS = (99 * 10000) / 9007199254740993 = 0 → correctly rounds to 0
      const deviation = computeDeviationPercent(sourceAmount, median)
      expect(deviation).toBe(0) // < 0.01% → rounds to 0 in BPS arithmetic

      // Meaningful ~5% deviation at large scale.
      // BigInt truncation: median * 5 / 100 drops the fractional part,
      // giving 4.99% instead of 5.00% — this is correct BPS integer behaviour.
      const fivePercentAbove = median + (median * 5n / 100n)
      const largeDeviation = computeDeviationPercent(fivePercentAbove, median)
      expect(largeDeviation).toBeGreaterThanOrEqual(4.99)
      expect(largeDeviation).toBeLessThanOrEqual(5.0)

      // The critical property: both BigInt BPS and Number approaches agree
      // within ±0.01%, but BigInt never produces catastrophically wrong results
      // (e.g., 0% for a 5% deviation) like Number() would for 2^53+ values
      // where Number(2n**53n + 1n) === Number(2n**53n).
      expect(largeDeviation).toBeGreaterThan(4)

      // Verify: Number(median) loses the +1 (rounds to 2^53)
      expect(Number(median)).toBe(Number(median - 1n)) // proves Number precision loss
    })

    it('handles sub-percent deviations correctly', () => {
      // 0.5% deviation
      expect(computeDeviationPercent(1005n, 1000n)).toBe(0.5)
      // 0.01% deviation — below BPS resolution, rounds to 0
      expect(computeDeviationPercent(10001n, 10000n)).toBe(0.01)
    })
  })

  // ── Tick counter (atomic incr) ────────────────────────

  describe('shouldRunQuorum', () => {
    it('returns true on every 5th tick (uses atomic kv.incr)', async () => {
      const results: boolean[] = []
      for (let i = 0; i < 10; i++) {
        results.push(await shouldRunQuorum())
      }
      // incr starts at 1 (not 0): tick 5, 10 are true
      expect(results).toEqual([
        false, false, false, false, true,
        false, false, false, false, true,
      ])
      // Verify kv.incr was called (not get+set)
      expect(mockKvIncr).toHaveBeenCalledTimes(10)
      expect(mockKvGet).not.toHaveBeenCalled()
    })

    it('handles KV failure gracefully (returns false)', async () => {
      mockKvIncr.mockRejectedValueOnce(new Error('KV down'))
      expect(await shouldRunQuorum()).toBe(false)
    })
  })

  // ── Quorum with <5 active sources ─────────────────────

  describe('insufficient sources', () => {
    it(`skips quorum when <${MIN_ACTIVE_SOURCES} active sources`, async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')
      seedSource('kyberswap', 'disabled')

      const result = await runQuorumCheck()
      expect(result.skipped).toBe(true)
      expect(result.skipReason).toContain('Insufficient active sources: 4')
      expect(result.skipReason).toContain(`need ≥${MIN_ACTIVE_SOURCES}`)
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
      seedSource('kyberswap', 'active')

      mockFetchMetaQuote.mockResolvedValue(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3000000000' },
          { source: 'cowswap', toAmount: '3005000000' },
          { source: 'velora', toAmount: '2995000000' },
          { source: 'odos', toAmount: '3002000000' },
          { source: 'kyberswap', toAmount: '3001000000' },
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
      seedSource('kyberswap', 'active')

      // First pair (WETH→USDC): velora deviates >5%
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3000000000' },
          { source: 'cowswap', toAmount: '3005000000' },
          { source: 'velora', toAmount: '3200000000' }, // ~6.6% above median
          { source: 'odos', toAmount: '3002000000' },
          { source: 'kyberswap', toAmount: '3001000000' },
        ]),
      )

      // Second pair (USDC→USDT): velora is fine
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '9998000000' },
          { source: 'cowswap', toAmount: '9999000000' },
          { source: 'velora', toAmount: '9997000000' },
          { source: 'odos', toAmount: '9998500000' },
          { source: 'kyberswap', toAmount: '9998000000' },
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

  // ── Dual-pair flag → disabled ─────────────────────────

  describe('flagged classification (dual-pair outlier)', () => {
    it('disables source when outlier on both pairs', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')
      seedSource('kyberswap', 'active')

      // First pair (WETH→USDC): velora deviates >5%
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3000000000' },
          { source: 'cowswap', toAmount: '3005000000' },
          { source: 'velora', toAmount: '3200000000' },
          { source: 'odos', toAmount: '3002000000' },
          { source: 'kyberswap', toAmount: '3001000000' },
        ]),
      )

      // Second pair (USDC→USDT): velora ALSO deviates >2%
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '9998000000' },
          { source: 'cowswap', toAmount: '9999000000' },
          { source: 'velora', toAmount: '10300000000' },
          { source: 'odos', toAmount: '9998500000' },
          { source: 'kyberswap', toAmount: '9998000000' },
        ]),
      )

      const result = await runQuorumCheck()

      const veloraOutliers = result.outliers.filter(o => o.sourceId === 'velora')
      expect(veloraOutliers.length).toBe(2)
      expect(veloraOutliers.every(o => o.classification === 'flagged')).toBe(true)

      expect(result.correlatedOutlierCount).toBeLessThan(3)
    })

    it('does not act on already-disabled sources', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'disabled')
      seedSource('odos', 'active')
      seedSource('kyberswap', 'active')
      seedSource('sushiswap', 'active')

      mockFetchMetaQuote.mockResolvedValue(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3000000000' },
          { source: 'cowswap', toAmount: '3005000000' },
          { source: 'odos', toAmount: '3002000000' },
          { source: 'kyberswap', toAmount: '3001000000' },
          { source: 'sushiswap', toAmount: '3003000000' },
        ]),
      )

      const result = await runQuorumCheck()
      expect(result.outliers.find(o => o.sourceId === 'velora')).toBeUndefined()
    })
  })

  // ── Correlated outlier (≥3 sources) → kill-switch ────

  describe('correlated outlier detection', () => {
    it('force-disables all flagged sources with P0 reason when ≥3 are correlated', async () => {
      // 7 sources: 4 normal consensus, 3 deviant
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')
      seedSource('kyberswap', 'active')
      seedSource('sushiswap', 'active')
      seedSource('openocean', 'active')

      // First pair: 1inch, velora, odos deviate >5% from the 4-source consensus
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

      // No synthetic 'quorum-system' sourceId — alerts emitted per-source via forceDisable
      const syntheticCalls = mockEmitTransitionAlert.mock.calls.filter(
        (args: unknown[]) => args[0] === 'quorum-system',
      )
      expect(syntheticCalls.length).toBe(0)

      // forceDisable emits alerts via transition() — check that the reason is P0
      // The forceDisable reason starts with 'quorum-correlated-anomaly'
      const transitionCalls = mockEmitTransitionAlert.mock.calls.filter(
        (args: unknown[]) => typeof args[3] === 'string' && (args[3] as string).startsWith('force: quorum-correlated-anomaly'),
      )
      expect(transitionCalls.length).toBeGreaterThanOrEqual(3)
    })
  })

  // ── P0 reason for correlated anomaly ──────────────────

  describe('P0 reason classification', () => {
    it('quorum-correlated-anomaly is in P0_REASONS', () => {
      expect(P0_REASONS).toContain('quorum-correlated-anomaly')
    })

    it('isP0Reason matches quorum-correlated-anomaly with suffix', () => {
      expect(isP0Reason('quorum-correlated-anomaly: deviation 6.5% on WETH→USDC')).toBe(true)
    })

    it('quorum-deviation is NOT P0 (single-source, allows auto-recovery)', () => {
      expect(isP0Reason('quorum-deviation')).toBe(false)
    })
  })

  // ── fetchMetaQuote failure handling ───────────────────

  describe('fetchMetaQuote failure handling', () => {
    it('skips pair gracefully when fetchMetaQuote throws', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')
      seedSource('kyberswap', 'active')

      mockFetchMetaQuote.mockRejectedValueOnce(new Error('Rate limited'))

      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '9998000000' },
          { source: 'cowswap', toAmount: '9999000000' },
          { source: 'velora', toAmount: '9997000000' },
          { source: 'odos', toAmount: '9998500000' },
          { source: 'kyberswap', toAmount: '9998000000' },
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
      seedSource('kyberswap', 'active')

      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3000000000' },
          { source: 'cowswap', toAmount: '3210000000' }, // 7% above — within 8%
          { source: 'velora', toAmount: '3005000000' },
          { source: 'odos', toAmount: '3002000000' },
          { source: 'kyberswap', toAmount: '3001000000' },
        ]),
      )

      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '9998000000' },
          { source: 'cowswap', toAmount: '9999000000' },
          { source: 'velora', toAmount: '9997000000' },
          { source: 'odos', toAmount: '9998500000' },
          { source: 'kyberswap', toAmount: '9998000000' },
        ]),
      )

      const result = await runQuorumCheck()
      expect(result.outliers.find(o => o.sourceId === 'cowswap')).toBeUndefined()
    })
  })

  // ── KV persistence ────────────────────────────────────

  describe('KV persistence', () => {
    it('writes lastQuorumResult to KV after successful check', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')
      seedSource('kyberswap', 'active')

      mockFetchMetaQuote.mockResolvedValue(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3000000000' },
          { source: 'cowswap', toAmount: '3005000000' },
          { source: 'velora', toAmount: '2995000000' },
          { source: 'odos', toAmount: '3002000000' },
          { source: 'kyberswap', toAmount: '3001000000' },
        ]),
      )

      await runQuorumCheck()

      // Verify kv.set was called with the lastQuorumResult key
      const lastQuorumCalls = mockKvSet.mock.calls.filter(
        (args: unknown[]) => args[0] === 'teraswap:monitor:lastQuorumResult',
      )
      expect(lastQuorumCalls.length).toBe(1)

      const savedResult = lastQuorumCalls[0][1] as Record<string, unknown>
      expect(savedResult.skipped).toBe(false)
      expect(savedResult.correlatedOutlierCount).toBe(0)
      expect(savedResult.timestamp).toBeDefined()
    })

    it('writes correlated kill-switch audit trail to KV', async () => {
      // 7 sources: 4 normal consensus, 3 deviant
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')
      seedSource('kyberswap', 'active')
      seedSource('sushiswap', 'active')
      seedSource('openocean', 'active')

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

      // Verify audit trail was written with the killswitch prefix
      const auditCalls = mockKvSet.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).startsWith('teraswap:quorum:killswitch:'),
      )
      expect(auditCalls.length).toBe(1)

      const auditEntry = auditCalls[0][1] as Record<string, unknown>
      expect(auditEntry.flaggedSources).toBeDefined()
      expect((auditEntry.flaggedSources as string[]).length).toBeGreaterThanOrEqual(3)
      expect(auditEntry.correlatedOutlierCount).toBeGreaterThanOrEqual(3)
    })

    it('does NOT write audit trail for non-correlated outliers', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')
      seedSource('kyberswap', 'active')

      // Only 1 source deviates (flagged, not correlated)
      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3000000000' },
          { source: 'cowswap', toAmount: '3005000000' },
          { source: 'velora', toAmount: '3200000000' },
          { source: 'odos', toAmount: '3002000000' },
          { source: 'kyberswap', toAmount: '3001000000' },
        ]),
      )

      mockFetchMetaQuote.mockResolvedValueOnce(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '9998000000' },
          { source: 'cowswap', toAmount: '9999000000' },
          { source: 'velora', toAmount: '10300000000' },
          { source: 'odos', toAmount: '9998500000' },
          { source: 'kyberswap', toAmount: '9998000000' },
        ]),
      )

      await runQuorumCheck()

      const auditCalls = mockKvSet.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).startsWith('teraswap:quorum:killswitch:'),
      )
      expect(auditCalls.length).toBe(0)
    })

    it('does NOT write lastQuorumResult when check is skipped (insufficient sources)', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')
      // Only 4 active — below MIN_ACTIVE_SOURCES (5)

      const result = await runQuorumCheck()
      expect(result.skipped).toBe(true)

      const lastQuorumCalls = mockKvSet.mock.calls.filter(
        (args: unknown[]) => args[0] === 'teraswap:monitor:lastQuorumResult',
      )
      expect(lastQuorumCalls.length).toBe(0)
    })
  })

  // ── IQR outlier pre-filter ─────────────────────────────

  describe('iqrFilter', () => {
    it('returns all values when no statistical outliers', () => {
      const values = [100n, 102n, 98n, 101n, 99n]
      const { filtered, removed } = iqrFilter(values)
      expect(removed).toBe(0)
      expect(filtered).toHaveLength(5)
    })

    it('removes extreme outlier from 5 values', () => {
      // 4 values cluster around 100, one extreme at 200
      const values = [100n, 101n, 99n, 102n, 200n]
      const { filtered, removed, q1, q3 } = iqrFilter(values)
      expect(removed).toBe(1)
      expect(filtered).toHaveLength(4)
      expect(filtered).not.toContain(200n)
      expect(q1).toBeGreaterThan(0n)
      expect(q3).toBeGreaterThan(0n)
    })

    it('removes low extreme outlier', () => {
      const values = [100n, 101n, 99n, 102n, 10n]
      const { filtered, removed } = iqrFilter(values)
      expect(removed).toBe(1)
      expect(filtered).not.toContain(10n)
    })

    it('does not filter with fewer than 4 values', () => {
      const values = [100n, 200n, 300n]
      const { filtered, removed } = iqrFilter(values)
      expect(removed).toBe(0)
      expect(filtered).toHaveLength(3)
    })

    it('handles all identical values (IQR = 0)', () => {
      const values = [100n, 100n, 100n, 100n, 100n]
      const { filtered, removed } = iqrFilter(values)
      expect(removed).toBe(0)
      expect(filtered).toHaveLength(5)
    })

    it('1 extreme in 5 realistic quote amounts → filtered, median unaffected', () => {
      // 4 honest quotes ~3000 USDC, 1 manipulated at 4000
      const honest = [3000000000n, 3005000000n, 2995000000n, 3002000000n]
      const manipulated = 4000000000n
      const all = [...honest, manipulated]

      const { filtered, removed } = iqrFilter(all)
      expect(removed).toBe(1)
      expect(filtered).not.toContain(manipulated)

      // Median of filtered should match median of honest quotes
      const filteredMedian = computeMedian(filtered)
      const honestMedian = computeMedian(honest)
      expect(filteredMedian).toBe(honestMedian)
    })
  })

  describe('IQR integration in runQuorumCheck', () => {
    it('pair result includes iqrFiltered count', async () => {
      seedSource('1inch', 'active')
      seedSource('cowswap', 'active')
      seedSource('velora', 'active')
      seedSource('odos', 'active')
      seedSource('kyberswap', 'active')

      mockFetchMetaQuote.mockResolvedValue(
        makeMetaQuoteResult([
          { source: '1inch', toAmount: '3000000000' },
          { source: 'cowswap', toAmount: '3005000000' },
          { source: 'velora', toAmount: '2995000000' },
          { source: 'odos', toAmount: '3002000000' },
          { source: 'kyberswap', toAmount: '3001000000' },
        ]),
      )

      const result = await runQuorumCheck()
      expect(result.skipped).toBe(false)
      for (const pair of result.pairs) {
        if (!pair.skipped) {
          expect(pair.iqrFiltered).toBeDefined()
          expect(typeof pair.iqrFiltered).toBe('number')
        }
      }
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
