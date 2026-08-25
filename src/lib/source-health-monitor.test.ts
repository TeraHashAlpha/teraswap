/**
 * [CHORE-QUOTE-QUORUM / W7-L-02, fix/source-health-relative-baselines]
 * source-health-monitor — silence/outlier/drift detection + rate-limited
 * alerting.
 *
 * The detector is pure (drive it with snapshots + outlierDrops +
 * trailingHistory); the orchestrator's KV and alert fan-out are mocked
 * (cow-fee-monitor pattern) so we prove: exactly one alert per source·kind
 * per window, fail-open on KV errors, and the display-drop counter records
 * with a first-write TTL.
 *
 * The acceptance case here is the production defect this branch fixes: win
 * rate is ZERO-SUM (one window's wins always sum to its quote count), so a
 * source's rate falling is not, on its own, evidence of a source defect — see
 * the module doc. The six-row snapshot below is real 2026-08-24 production
 * data where every baselined source's OLD win rate had collapsed purely
 * because two un-baselined sources (openocean, sushiswap) picked up 42.5% of
 * all wins. None of that is a source defect, and the fixed detector must not
 * report drift on any of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockIncr = vi.fn<() => Promise<number>>(async () => 1)
const mockExpire = vi.fn(async () => 1)
const mockSet = vi.fn<(...a: unknown[]) => Promise<'OK' | null>>(async () => 'OK')
const mockGet = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null)
const mockSadd = vi.fn<(...a: unknown[]) => Promise<number>>(async () => 1)
const mockSmembers = vi.fn<(...a: unknown[]) => Promise<string[]>>(async () => [])
const mockDel = vi.fn<(...a: unknown[]) => Promise<number>>(async () => 1)
vi.mock('@/lib/kv', () => ({
  kv: {
    incr: (...a: unknown[]) => mockIncr(...(a as [])),
    expire: (...a: unknown[]) => mockExpire(...(a as [])),
    set: (...a: unknown[]) => mockSet(...a),
    get: (...a: unknown[]) => mockGet(...a),
    sadd: (...a: unknown[]) => mockSadd(...a),
    smembers: (...a: unknown[]) => mockSmembers(...a),
    del: (...a: unknown[]) => mockDel(...a),
  },
}))

const mockEmit = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {})
vi.mock('@/lib/alert-wrapper', () => ({
  emitTransitionAlert: (...a: unknown[]) => mockEmit(...a),
}))

import {
  SOURCE_HEALTH_ALERT_WINDOW_SECONDS,
  OUTLIER_DROP_ALERT_THRESHOLD,
  DRIFT_MIN_SAMPLE,
  DRIFT_ZERO_WIN_STREAK_WINDOWS,
  detectSourceHealthFindings,
  checkSourceHealthAlerts,
  recordQuoteDisplayDrop,
  type SourceHealthSnapshot,
  type SourceTrailingHistory,
} from './source-health-monitor'

function snap(source: string, quoteCount: number, winCount: number): SourceHealthSnapshot {
  return { source, quoteCount, winCount }
}

/** The exact production window this branch fixes: wins sum to 1000 (zero-sum),
 *  every source that used to have a fixed baseline is "down" relative to it
 *  purely because openocean/sushiswap (never baselined) picked up 425 wins. */
function productionRegressionSnapshot(): SourceHealthSnapshot[] {
  return [
    snap('velora', 1000, 222),
    snap('kyberswap', 1000, 300),
    snap('sushiswap', 1000, 52),
    snap('cowswap', 426, 50),
    snap('openocean', 847, 373),
    snap('uniswapv3', 592, 3),
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSet.mockResolvedValue('OK')
  mockGet.mockResolvedValue(null)
  mockSmembers.mockResolvedValue([])
})

describe('detectSourceHealthFindings — zero-sum win rate (the production defect)', () => {
  it('produces ZERO drift findings on the exact six-row production snapshot', () => {
    const findings = detectSourceHealthFindings(productionRegressionSnapshot(), {})
    expect(findings.filter(f => f.kind === 'drift')).toHaveLength(0)
  })

  it('produces no findings at all on that snapshot with no prior history (nothing here is a source defect)', () => {
    const findings = detectSourceHealthFindings(productionRegressionSnapshot(), {})
    expect(findings).toHaveLength(0)
  })

  it('sees every source in the window, not just a hardcoded subset (openocean/sushiswap are no longer invisible)', () => {
    // A source that wins ZERO on a qualifying sample for K windows IS reported
    // even though it was never in any fixed baseline table — proves the
    // detector iterates observed sources, not a hardcoded key list.
    const history: Record<string, SourceTrailingHistory> = {
      openocean: { knownQuoting: true, priorZeroWinStreak: DRIFT_ZERO_WIN_STREAK_WINDOWS - 1 },
    }
    const snapshots = [snap('openocean', DRIFT_MIN_SAMPLE, 0)]
    const findings = detectSourceHealthFindings(snapshots, {}, history)
    expect(findings).toContainEqual(expect.objectContaining({ source: 'openocean', kind: 'drift' }))
  })
})

describe('detectSourceHealthFindings — silence (Balancer/Odos class)', () => {
  it('flags a previously-quoting source that is absent from the window', () => {
    const history: Record<string, SourceTrailingHistory> = {
      kyberswap: { knownQuoting: true, priorZeroWinStreak: 0 },
    }
    const findings = detectSourceHealthFindings([], {}, history)
    expect(findings).toContainEqual(expect.objectContaining({ source: 'kyberswap', kind: 'silence' }))
  })

  it('flags a previously-quoting source present with zero quotes', () => {
    const history: Record<string, SourceTrailingHistory> = {
      velora: { knownQuoting: true, priorZeroWinStreak: 0 },
    }
    const findings = detectSourceHealthFindings([snap('velora', 0, 0)], {}, history)
    expect(findings).toContainEqual(expect.objectContaining({ source: 'velora', kind: 'silence' }))
  })

  it('does NOT flag a source with no trailing "known quoting" history (nothing to compare against yet)', () => {
    const findings = detectSourceHealthFindings([], {}, {})
    expect(findings.filter(f => f.kind === 'silence')).toHaveLength(0)
  })

  it('does NOT flag a source whose known-quoting flag has aged out (deliberately-disabled sources stop paging on their own)', () => {
    const history: Record<string, SourceTrailingHistory> = {
      balancer: { knownQuoting: false, priorZeroWinStreak: 0 },
    }
    const findings = detectSourceHealthFindings([], {}, history)
    expect(findings.filter(f => f.kind === 'silence')).toHaveLength(0)
  })
})

describe('detectSourceHealthFindings — drift (dead weight: zero wins over K windows)', () => {
  it('does NOT flag on the first zero-win window (no prior streak yet)', () => {
    const findings = detectSourceHealthFindings([snap('uniswapv3', DRIFT_MIN_SAMPLE, 0)], {})
    expect(findings.filter(f => f.kind === 'drift')).toHaveLength(0)
  })

  it('does NOT flag below the sample floor even with a full prior streak', () => {
    const history: Record<string, SourceTrailingHistory> = {
      uniswapv3: { knownQuoting: true, priorZeroWinStreak: DRIFT_ZERO_WIN_STREAK_WINDOWS - 1 },
    }
    const findings = detectSourceHealthFindings(
      [snap('uniswapv3', DRIFT_MIN_SAMPLE - 1, 0)],
      {},
      history,
    )
    expect(findings.filter(f => f.kind === 'drift')).toHaveLength(0)
  })

  it('does NOT flag a source with ANY wins, no matter how low the rate (a low rate alone is not a defect)', () => {
    const history: Record<string, SourceTrailingHistory> = {
      uniswapv3: { knownQuoting: true, priorZeroWinStreak: DRIFT_ZERO_WIN_STREAK_WINDOWS - 1 },
    }
    const findings = detectSourceHealthFindings([snap('uniswapv3', 592, 3)], {}, history)
    expect(findings.filter(f => f.kind === 'drift')).toHaveLength(0)
  })

  it('flags a source quoting >= the sample floor with zero wins across K consecutive windows', () => {
    const history: Record<string, SourceTrailingHistory> = {
      uniswapv3: { knownQuoting: true, priorZeroWinStreak: DRIFT_ZERO_WIN_STREAK_WINDOWS - 1 },
    }
    const findings = detectSourceHealthFindings(
      [snap('uniswapv3', DRIFT_MIN_SAMPLE, 0)],
      {},
      history,
    )
    expect(findings).toContainEqual(expect.objectContaining({ source: 'uniswapv3', kind: 'drift' }))
  })
})

describe('detectSourceHealthFindings — systematic display outliers (OpenOcean class)', () => {
  it('flags a source whose display-drop counter reached the threshold', () => {
    const findings = detectSourceHealthFindings([], { openocean: OUTLIER_DROP_ALERT_THRESHOLD })
    expect(findings).toContainEqual(expect.objectContaining({ source: 'openocean', kind: 'outlier' }))
  })

  it('does NOT flag below the threshold', () => {
    const findings = detectSourceHealthFindings([], { openocean: OUTLIER_DROP_ALERT_THRESHOLD - 1 })
    expect(findings.filter(f => f.kind === 'outlier')).toHaveLength(0)
  })
})

describe('checkSourceHealthAlerts — rate-limited fan-out', () => {
  it('emits exactly one informational alert per finding and rate-limits per source·kind·window', async () => {
    mockSmembers.mockResolvedValue(['kyberswap'])
    mockGet.mockImplementation(async (key: unknown) => {
      if (typeof key === 'string' && key.includes('known-quoting')) return '1'
      return null
    })
    const snapshots: SourceHealthSnapshot[] = [] // kyberswap known-quoting but absent ⇒ silence

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
    mockSmembers.mockRejectedValue(new Error('kv down'))
    const snapshots = [snap('velora', 100, 30)]
    await expect(checkSourceHealthAlerts(snapshots)).resolves.toBeDefined()
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('returns the findings so the monitor response can surface them', async () => {
    mockSmembers.mockResolvedValue(['uniswapv3'])
    mockGet.mockImplementation(async (key: unknown) => {
      if (typeof key === 'string' && key.includes('known-quoting')) return '1'
      return null
    })
    const findings = await checkSourceHealthAlerts([])
    expect(findings).toContainEqual(expect.objectContaining({ source: 'uniswapv3', kind: 'silence' }))
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
