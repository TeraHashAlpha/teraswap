/**
 * [CHORE-QUOTE-QUORUM / W7-L-02] source-health-monitor — silence/outlier/drift
 * detection + rate-limited alerting.
 *
 * The detector is pure (drive it with snapshots); the orchestrator's KV and
 * alert fan-out are mocked (cow-fee-monitor pattern) so we prove: exactly one
 * alert per source·kind per window, fail-open on KV errors, and the display-
 * drop counter records with a first-write TTL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockIncr = vi.fn<() => Promise<number>>(async () => 1)
const mockExpire = vi.fn(async () => 1)
const mockSet = vi.fn<(...a: unknown[]) => Promise<'OK' | null>>(async () => 'OK')
const mockGet = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null)
vi.mock('@/lib/kv', () => ({
  kv: {
    incr: (...a: unknown[]) => mockIncr(...(a as [])),
    expire: (...a: unknown[]) => mockExpire(...(a as [])),
    set: (...a: unknown[]) => mockSet(...a),
    get: (...a: unknown[]) => mockGet(...a),
  },
}))

const mockEmit = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {})
vi.mock('@/lib/alert-wrapper', () => ({
  emitTransitionAlert: (...a: unknown[]) => mockEmit(...a),
}))

import {
  SOURCE_HEALTH_BASELINES,
  SOURCE_HEALTH_ALERT_WINDOW_SECONDS,
  OUTLIER_DROP_ALERT_THRESHOLD,
  DRIFT_MIN_SAMPLE,
  DRIFT_WIN_COLLAPSE_FACTOR,
  detectSourceHealthFindings,
  checkSourceHealthAlerts,
  recordQuoteDisplayDrop,
  type SourceHealthSnapshot,
} from './source-health-monitor'

function snap(source: string, quoteCount: number, winCount: number): SourceHealthSnapshot {
  return { source, quoteCount, winCount }
}

/** A healthy snapshot set: every baselined source quoting at its typical rate. */
function healthySnapshots(): SourceHealthSnapshot[] {
  return Object.entries(SOURCE_HEALTH_BASELINES).map(([source, b]) =>
    snap(source, 100, Math.round(b.typicalWinRatePercent)),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSet.mockResolvedValue('OK')
  mockGet.mockResolvedValue(null)
})

describe('detectSourceHealthFindings — silence (Balancer/Odos class)', () => {
  it('flags a baselined (historically-quoting) source that is absent from the window', () => {
    const snapshots = healthySnapshots().filter(s => s.source !== 'kyberswap')
    const findings = detectSourceHealthFindings(snapshots, {})
    expect(findings).toContainEqual(
      expect.objectContaining({ source: 'kyberswap', kind: 'silence' }),
    )
  })

  it('flags a baselined source present with zero quotes', () => {
    const snapshots = [...healthySnapshots().filter(s => s.source !== 'velora'), snap('velora', 0, 0)]
    const findings = detectSourceHealthFindings(snapshots, {})
    expect(findings).toContainEqual(
      expect.objectContaining({ source: 'velora', kind: 'silence' }),
    )
  })

  it('does NOT flag a non-baselined source (known-broken/disabled sources stay quiet)', () => {
    // balancer (DISABLED_SOURCES) and the known-silent five are not baselined —
    // alerting on them every window until their keys/fixes land is pure noise.
    const findings = detectSourceHealthFindings(healthySnapshots(), {})
    expect(findings).toHaveLength(0)
  })
})

describe('detectSourceHealthFindings — win-rate drift', () => {
  it('flags a baselined source whose windowed win rate collapsed vs baseline', () => {
    const base = SOURCE_HEALTH_BASELINES.kyberswap
    const collapsedWins = 0 // 0% vs a >50% baseline — material collapse
    const snapshots = [
      ...healthySnapshots().filter(s => s.source !== 'kyberswap'),
      snap('kyberswap', DRIFT_MIN_SAMPLE, collapsedWins),
    ]
    const findings = detectSourceHealthFindings(snapshots, {})
    expect(base.typicalWinRatePercent).toBeGreaterThan(0)
    expect(findings).toContainEqual(
      expect.objectContaining({ source: 'kyberswap', kind: 'drift' }),
    )
  })

  it('does NOT flag a collapse on a too-small sample (no false page on quiet windows)', () => {
    const snapshots = [
      ...healthySnapshots().filter(s => s.source !== 'kyberswap'),
      snap('kyberswap', DRIFT_MIN_SAMPLE - 1, 0),
    ]
    const findings = detectSourceHealthFindings(snapshots, {})
    expect(findings.filter(f => f.kind === 'drift')).toHaveLength(0)
  })

  it('does NOT flag a win rate at/above the collapse floor', () => {
    const base = SOURCE_HEALTH_BASELINES.velora
    const floorWins = Math.ceil(DRIFT_MIN_SAMPLE * (base.typicalWinRatePercent / 100) * DRIFT_WIN_COLLAPSE_FACTOR)
    const snapshots = [
      ...healthySnapshots().filter(s => s.source !== 'velora'),
      snap('velora', DRIFT_MIN_SAMPLE, floorWins),
    ]
    const findings = detectSourceHealthFindings(snapshots, {})
    expect(findings.filter(f => f.kind === 'drift')).toHaveLength(0)
  })
})

describe('detectSourceHealthFindings — systematic display outliers (OpenOcean class)', () => {
  it('flags a source whose display-drop counter reached the threshold', () => {
    const findings = detectSourceHealthFindings(healthySnapshots(), {
      openocean: OUTLIER_DROP_ALERT_THRESHOLD,
    })
    expect(findings).toContainEqual(
      expect.objectContaining({ source: 'openocean', kind: 'outlier' }),
    )
  })

  it('does NOT flag below the threshold', () => {
    const findings = detectSourceHealthFindings(healthySnapshots(), {
      openocean: OUTLIER_DROP_ALERT_THRESHOLD - 1,
    })
    expect(findings.filter(f => f.kind === 'outlier')).toHaveLength(0)
  })
})

describe('checkSourceHealthAlerts — rate-limited fan-out', () => {
  it('emits exactly one informational alert per finding and rate-limits per source·kind·window', async () => {
    const snapshots = healthySnapshots().filter(s => s.source !== 'kyberswap')

    mockSet.mockResolvedValueOnce('OK') // NX acquired → alert
    await checkSourceHealthAlerts(snapshots)
    expect(mockEmit).toHaveBeenCalledTimes(1)
    const [sourceId, from, to, reason] = mockEmit.mock.calls[0]
    expect(sourceId).toBe('kyberswap')
    expect(from).toBe('active')
    expect(to).toBe('active') // non-transition informational convention
    expect(String(reason)).toMatch(/silen/i)
    // The NX key must carry the window TTL.
    expect(mockSet).toHaveBeenCalledWith(
      expect.stringContaining('kyberswap'),
      expect.anything(),
      expect.objectContaining({ nx: true, ex: SOURCE_HEALTH_ALERT_WINDOW_SECONDS }),
    )

    // Same window, same finding → NX not acquired → no second alert.
    mockSet.mockResolvedValue(null)
    await checkSourceHealthAlerts(snapshots)
    expect(mockEmit).toHaveBeenCalledTimes(1)
  })

  it('fails OPEN on KV errors (monitoring must never break the monitor)', async () => {
    mockSet.mockRejectedValue(new Error('kv down'))
    const snapshots = healthySnapshots().filter(s => s.source !== 'velora')
    await expect(checkSourceHealthAlerts(snapshots)).resolves.toBeDefined()
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('returns the findings so the monitor response can surface them', async () => {
    const snapshots = healthySnapshots().filter(s => s.source !== 'uniswapv3')
    const findings = await checkSourceHealthAlerts(snapshots)
    expect(findings).toContainEqual(
      expect.objectContaining({ source: 'uniswapv3', kind: 'silence' }),
    )
  })
})

describe('recordQuoteDisplayDrop — the outlier-detector feed', () => {
  it('increments the per-source counter and sets the window TTL on first write', async () => {
    mockIncr.mockResolvedValue(1)
    await recordQuoteDisplayDrop('openocean')
    expect(mockIncr).toHaveBeenCalledWith(expect.stringContaining('openocean'))
    expect(mockExpire).toHaveBeenCalledTimes(1)
  })

  it('does not reset the TTL on subsequent writes', async () => {
    mockIncr.mockResolvedValue(7)
    await recordQuoteDisplayDrop('openocean')
    expect(mockExpire).not.toHaveBeenCalled()
  })

  it('fails OPEN on KV errors (never breaks the quote path)', async () => {
    mockIncr.mockRejectedValue(new Error('kv down'))
    await expect(recordQuoteDisplayDrop('openocean')).resolves.toBeUndefined()
  })
})
