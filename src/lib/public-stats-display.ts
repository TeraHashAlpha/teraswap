/**
 * Display rules for GET /api/stats. Honesty lives here: disabled or empty
 * metrics become "not available yet" + a reason. Zeros are never treated
 * as measurements. The API route is not changed.
 */

export const NOT_AVAILABLE_YET = 'not available yet'

export type PublicStatsGasless = {
  totalGaslessSwaps?: number
  totalGasSavedUsd?: number
  gaslessRatio?: number
  avgGasSavingsPerSwap?: number
}

export type PublicStatsPayload = {
  enabled?: boolean
  error?: string
  totalSwaps?: number
  totalQuotes?: number
  topSwapSources?: [string, number][]
  topQuoteWinners?: [string, number][]
  gasless?: PublicStatsGasless
}

export type UnavailableMetric = {
  available: false
  message: typeof NOT_AVAILABLE_YET
  reason: string
}

export type AvailableCount = {
  available: true
  value: number
}

export type AvailableList<T> = {
  available: true
  items: T[]
}

export type ProtocolStatsGate =
  | { status: 'loading' }
  | { status: 'unavailable'; message: typeof NOT_AVAILABLE_YET; reason: string }
  | { status: 'ready' }

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function protocolStatsGate(
  payload: PublicStatsPayload | null,
  opts: { loading: boolean; failed: boolean },
): ProtocolStatsGate {
  if (opts.loading) return { status: 'loading' }
  if (opts.failed) {
    return {
      status: 'unavailable',
      message: NOT_AVAILABLE_YET,
      reason: 'Could not load protocol stats from the server.',
    }
  }
  if (!payload || payload.enabled === false) {
    return {
      status: 'unavailable',
      message: NOT_AVAILABLE_YET,
      reason: payload?.error
        ? payload.error
        : 'The stats backend is not configured.',
    }
  }
  return { status: 'ready' }
}

export function countMetric(
  value: number | undefined | null,
  emptyReason: string,
): UnavailableMetric | AvailableCount {
  if (!isPositiveNumber(value)) {
    return { available: false, message: NOT_AVAILABLE_YET, reason: emptyReason }
  }
  return { available: true, value }
}

export function listMetric(
  items: [string, number][] | undefined | null,
  emptyReason: string,
): UnavailableMetric | AvailableList<[string, number]> {
  const positive = (items ?? []).filter(([, n]) => isPositiveNumber(n))
  if (positive.length === 0) {
    return { available: false, message: NOT_AVAILABLE_YET, reason: emptyReason }
  }
  return { available: true, items: positive }
}

export function gaslessMetrics(gasless: PublicStatsGasless | undefined): {
  totalGaslessSwaps: UnavailableMetric | AvailableCount
  totalGasSavedUsd: UnavailableMetric | AvailableCount
  gaslessRatio: UnavailableMetric | AvailableCount
  avgGasSavingsPerSwap: UnavailableMetric | AvailableCount
} {
  const none = 'No gasless swaps recorded yet.'
  return {
    totalGaslessSwaps: countMetric(gasless?.totalGaslessSwaps, none),
    totalGasSavedUsd: countMetric(gasless?.totalGasSavedUsd, none),
    gaslessRatio: countMetric(gasless?.gaslessRatio, none),
    avgGasSavingsPerSwap: countMetric(gasless?.avgGasSavingsPerSwap, none),
  }
}
