/**
 * [CHORE-DCA-UX-FIXES] Bug 3b — failed orders must always carry a human reason.
 *
 * The keeper marks an order 'failed' but did NOT persist an error string, so the UI's error field was
 * usually null. failedOrderReason() supplies a clear default so a failed order is never shown as
 * "Failed" with no explanation (and never silently vanishes without context).
 *
 * [chore/dca-resilience] The keeper now ALSO persists a SPECIFIC reason code in orders.error
 * (expired / no_route_after_retries / insufficient_balance / insufficient_allowance / nonce_invalid /
 * cancelled — the shared contract with retry-policy.js FAILURE_REASON). failedOrderReason maps each
 * code to a clear message, replacing the generic "the swap route may have become unavailable".
 */

import { describe, it, expect } from 'vitest'
import { failedOrderReason, DEFAULT_FAILED_REASON, FAILURE_REASON_LABELS } from './failed-reason'

describe('failedOrderReason — backward compatibility', () => {
  it('returns a legacy free-text error verbatim', () => {
    expect(failedOrderReason('Signature rejected in wallet.')).toBe('Signature rejected in wallet.')
  })

  it('falls back to a default reason when the error is null (legacy keeper-marked failure)', () => {
    expect(failedOrderReason(null)).toBe(DEFAULT_FAILED_REASON)
  })

  it('falls back when the error is empty/whitespace/undefined', () => {
    expect(failedOrderReason('   ')).toBe(DEFAULT_FAILED_REASON)
    expect(failedOrderReason(undefined)).toBe(DEFAULT_FAILED_REASON)
    expect(failedOrderReason('')).toBe(DEFAULT_FAILED_REASON)
  })
})

describe('failedOrderReason — specific terminal reason codes', () => {
  // A friendly message is a human sentence — it contains whitespace and is NOT
  // just the raw snake_case code echoed back.
  const expectFriendly = (code: string, msg: string) => {
    expect(msg).toMatch(/\s/)
    expect(msg).not.toBe(code)
    expect(msg).not.toBe(DEFAULT_FAILED_REASON)
  }

  it('expired → mentions expiry, NOT the generic route line', () => {
    const msg = failedOrderReason('expired')
    expectFriendly('expired', msg)
    expect(msg).toMatch(/expired/i)
    expect(msg).not.toMatch(/swap route may have become unavailable/i)
  })

  it('no_route_after_retries → mentions no route AND that it retried', () => {
    const msg = failedOrderReason('no_route_after_retries')
    expectFriendly('no_route_after_retries', msg)
    expect(msg).toMatch(/route/i)
    expect(msg).toMatch(/retr/i)
  })

  it('insufficient_balance → mentions balance', () => {
    const msg = failedOrderReason('insufficient_balance')
    expectFriendly('insufficient_balance', msg)
    expect(msg).toMatch(/balance/i)
  })

  it('insufficient_allowance → mentions approval/allowance', () => {
    const msg = failedOrderReason('insufficient_allowance')
    expectFriendly('insufficient_allowance', msg)
    expect(msg).toMatch(/approv|allowance/i)
  })

  it('nonce_invalid → explains the order is no longer valid', () => {
    const msg = failedOrderReason('nonce_invalid')
    expectFriendly('nonce_invalid', msg)
    expect(msg).toMatch(/no longer valid|nonce/i)
  })

  it('cancelled → says cancelled', () => {
    const msg = failedOrderReason('cancelled')
    expectFriendly('cancelled', msg)
    expect(msg).toMatch(/cancel/i)
  })

  it('every known code maps to a distinct, friendly, non-default message', () => {
    const seen = new Set<string>()
    for (const code of Object.keys(FAILURE_REASON_LABELS)) {
      const msg = failedOrderReason(code)
      expectFriendly(code, msg)
      expect(seen.has(msg)).toBe(false)
      seen.add(msg)
    }
  })

  it('matching is trimmed + case-insensitive (keeper writes lowercase, be tolerant)', () => {
    expect(failedOrderReason('  EXPIRED  ')).toBe(failedOrderReason('expired'))
  })
})
