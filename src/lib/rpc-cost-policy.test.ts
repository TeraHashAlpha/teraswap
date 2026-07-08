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
  clampGetLogsRange,
  MAX_RPC_BATCH_SIZE,
  MAX_GET_LOGS_BLOCK_RANGE,
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

describe('clampGetLogsRange — bound eth_getLogs cost without breaking the call', () => {
  it('leaves a narrow numeric range untouched', () => {
    const req = { method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2' }] }
    const out = clampGetLogsRange(req)
    expect(out.clamped).toBe(false)
    expect(out.request).toEqual(req)
  })

  it('CLAMPS a wide numeric range by rewriting fromBlock (keeps the call working, bounds cost)', () => {
    const from = 0
    const to = 100_000
    const req = { method: 'eth_getLogs', params: [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] }
    const out = clampGetLogsRange(req)
    expect(out.clamped).toBe(true)
    const params = out.request.params as Array<{ fromBlock: string; toBlock: string }>
    const newFrom = Number.parseInt(params[0].fromBlock, 16)
    expect(to - newFrom).toBe(MAX_GET_LOGS_BLOCK_RANGE)
    expect(params[0].toBlock).toBe(req.params[0].toBlock) // toBlock untouched
  })

  it('boundary: a range exactly at the cap is untouched (inclusive)', () => {
    const req = { method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: `0x${MAX_GET_LOGS_BLOCK_RANGE.toString(16)}` }] }
    expect(clampGetLogsRange(req).clamped).toBe(false)
  })

  it('leaves a tag-based range ("latest"/"earliest"/absent) untouched — cannot bound cheaply', () => {
    expect(clampGetLogsRange({ method: 'eth_getLogs', params: [{ fromBlock: 'latest', toBlock: 'latest' }] }).clamped).toBe(false)
    expect(clampGetLogsRange({ method: 'eth_getLogs', params: [{}] }).clamped).toBe(false)
    expect(clampGetLogsRange({ method: 'eth_getLogs', params: [] }).clamped).toBe(false)
  })

  it('is a no-op for non-eth_getLogs methods', () => {
    const req = { method: 'eth_call', params: [{ fromBlock: '0x0', toBlock: '0x186a0' }] }
    expect(clampGetLogsRange(req).clamped).toBe(false)
  })

  it('never throws on malformed params', () => {
    expect(() => clampGetLogsRange({ method: 'eth_getLogs', params: null })).not.toThrow()
    expect(() => clampGetLogsRange({ method: 'eth_getLogs' })).not.toThrow()
    expect(clampGetLogsRange({ method: 'eth_getLogs', params: [{ fromBlock: 'not-hex', toBlock: '0x5' }] }).clamped).toBe(false)
  })
})
