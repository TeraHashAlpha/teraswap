/**
 * [CHORE-API-HARDENING-2 / P3c CONFIRMED] rpc-cost-policy — the /api/rpc proxy's
 * blacklist blocked only signing methods, so debug_* / trace_* (archive-grade
 * queries) and an unbounded eth_getLogs block range could proxy expensive
 * queries to the paid upstream RPC with only a per-IP rate limit as a backstop.
 * These pure helpers cap batch size, deny debug_* / trace_*, and clamp eth_getLogs
 * block ranges before the request is forwarded.
 */
import { describe, it, expect } from 'vitest'
import {
  isExpensiveMethod,
  exceedsBatchLimit,
  rpcRateLimitUnits,
  MAX_RPC_BATCH_SIZE,
  RPC_MAX_RESPONSE_BYTES,
  RPC_UPSTREAM_TIMEOUT_MS,
} from './rpc-cost-policy'

describe('isExpensiveMethod — deny debug_* / trace_* archive queries', () => {
  it('flags debug_ and trace_ prefixed methods', () => {
    expect(isExpensiveMethod('debug_traceBlockByNumber')).toBe(true)
    expect(isExpensiveMethod('debug_traceCall')).toBe(true)
    expect(isExpensiveMethod('trace_block')).toBe(true)
    expect(isExpensiveMethod('trace_filter')).toBe(true)
  })

  it('does not flag ordinary read methods wagmi/viem actually use', () => {
    expect(isExpensiveMethod('eth_getBlockByNumber')).toBe(false)
    expect(isExpensiveMethod('eth_getStorageAt')).toBe(false)
    expect(isExpensiveMethod('eth_getProof')).toBe(false)
    expect(isExpensiveMethod('eth_call')).toBe(false)
    expect(isExpensiveMethod('eth_getLogs')).toBe(false)
  })

  it('is case-sensitive to the exact JSON-RPC method casing (never throws on odd input)', () => {
    expect(isExpensiveMethod('')).toBe(false)
    expect(isExpensiveMethod(null)).toBe(false) // defensive runtime guard against non-string input
  })
})

describe('exceedsBatchLimit', () => {
  it('allows a batch at or under the cap', () => {
    expect(exceedsBatchLimit(1)).toBe(false)
    expect(exceedsBatchLimit(MAX_RPC_BATCH_SIZE)).toBe(false)
  })
  it('rejects a batch over the cap', () => {
    expect(exceedsBatchLimit(MAX_RPC_BATCH_SIZE + 1)).toBe(true)
  })
})

// [fix/user-ip-privacy A76 S-3] eth_getLogs is off the allow-list (rpc-method-policy.ts), so its range clamp is
// retired; what bounds every answer now is the upstream deadline and the byte cap (route.test.ts drives both).
describe('upstream bounds [A76 S-3]', () => {
  it('10 s upstream deadline, 4 MB response cap', () => {
    expect(RPC_UPSTREAM_TIMEOUT_MS).toBe(10_000)
    expect(RPC_MAX_RESPONSE_BYTES).toBe(4 * 1024 * 1024)
  })
})

describe('rpcRateLimitUnits [FEAT-SERVER-RPC-ENV-SPLIT]', () => {
  const arr = (n: number) => Array.from({ length: n }, () => ({}))
  it('one unit per call in a batch up to the cap', () => {
    expect(rpcRateLimitUnits(arr(1))).toBe(1)
    expect(rpcRateLimitUnits(arr(25))).toBe(25)
  })
  it('1 for single, empty, non-JSON-RPC and over-cap bodies (the latter are rejected unforwarded)', () => {
    for (const b of [{}, [], null, undefined, 'x', 7, arr(26), arr(5000)]) expect(rpcRateLimitUnits(b)).toBe(1)
  })
})
