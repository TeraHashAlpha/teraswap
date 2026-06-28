/**
 * [CHORE-DCA-UX-FIXES] Bug 3b — failed orders must always carry a human reason.
 *
 * The keeper marks an order 'failed' but does NOT persist an error string, so the UI's error field is
 * usually null. failedOrderReason() supplies a clear default so a failed order is never shown as
 * "Failed" with no explanation (and never silently vanishes without context).
 */

import { describe, it, expect } from 'vitest'
import { failedOrderReason, DEFAULT_FAILED_REASON } from './failed-reason'

describe('failedOrderReason', () => {
  it('returns the persisted error when present', () => {
    expect(failedOrderReason('Signature rejected in wallet.')).toBe('Signature rejected in wallet.')
  })

  it('falls back to a default reason when the error is null (keeper-marked failure)', () => {
    expect(failedOrderReason(null)).toBe(DEFAULT_FAILED_REASON)
  })

  it('falls back when the error is empty/whitespace', () => {
    expect(failedOrderReason('   ')).toBe(DEFAULT_FAILED_REASON)
    expect(failedOrderReason(undefined)).toBe(DEFAULT_FAILED_REASON)
  })
})
