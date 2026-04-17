/**
 * Unit tests for src/lib/post-execution-validator.ts — P45 post-execution balance validation.
 *
 * Tests cover: ok severity (surplus + exact), warning (0–2% shortfall), critical (>2%),
 * reverted TX, Transfer log extraction, balanceOf fallback, RPC failure graceful
 * degradation, zero expected output, audit trail write, and auto-disable on critical.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { validateExecution, type ValidateExecutionParams } from './post-execution-validator'

// ── Mocks ────────────────────────────────────────────────

// Mock viem's createPublicClient
const mockGetTransactionReceipt = vi.fn()
const mockReadContract = vi.fn()

vi.mock('viem', async () => {
  const actual = await vi.importActual('viem')
  return {
    ...actual,
    createPublicClient: () => ({
      getTransactionReceipt: mockGetTransactionReceipt,
      readContract: mockReadContract,
    }),
  }
})

// Mock KV
const mockKvSet = vi.fn().mockResolvedValue(undefined)
const mockKvGet = vi.fn().mockResolvedValue(null)

vi.mock('@vercel/kv', () => ({
  kv: {
    set: (...args: unknown[]) => mockKvSet(...args),
    get: (...args: unknown[]) => mockKvGet(...args),
  },
}))

// Mock alert-wrapper (fire-and-forget, don't test alert delivery here)
vi.mock('./alert-wrapper', () => ({
  emitTransitionAlert: vi.fn().mockResolvedValue(undefined),
}))

// Mock source-state-machine forceDisable
const mockForceDisable = vi.fn().mockResolvedValue(undefined)
vi.mock('./source-state-machine', () => ({
  forceDisable: (...args: unknown[]) => mockForceDisable(...args),
}))

// ── Helpers ──────────────────────────────────────────────

const TX_HASH = '0x' + 'a'.repeat(64)
const RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const TOKEN_OUT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // USDC
const TOKEN_DECIMALS = 6

/** Transfer event topic0 */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** Pad address to 32-byte topic */
function padAddress(addr: string): `0x${string}` {
  return ('0x' + addr.slice(2).toLowerCase().padStart(64, '0')) as `0x${string}`
}

/** Encode uint256 value as log data */
function encodeValue(n: bigint): `0x${string}` {
  return ('0x' + n.toString(16).padStart(64, '0')) as `0x${string}`
}

function makeTransferLog(from: string, to: string, value: bigint, token?: string) {
  return {
    address: (token || TOKEN_OUT).toLowerCase(),
    topics: [TRANSFER_TOPIC, padAddress(from), padAddress(to)],
    data: encodeValue(value),
    blockNumber: 1n,
    transactionHash: TX_HASH,
    logIndex: 0,
    blockHash: '0x' + '0'.repeat(64),
    transactionIndex: 0,
    removed: false,
  }
}

function baseParams(overrides?: Partial<ValidateExecutionParams>): ValidateExecutionParams {
  return {
    txHash: TX_HASH,
    source: '1inch',
    recipient: RECIPIENT,
    tokenOut: TOKEN_OUT,
    tokenOutDecimals: TOKEN_DECIMALS,
    expectedMinOutput: '1000000', // 1 USDC
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────

describe('validateExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockKvSet.mockResolvedValue(undefined)
  })

  // ── OK: actual >= expected ─────────────────────────────

  describe('ok severity', () => {
    it('returns ok when actual matches expected exactly', async () => {
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          makeTransferLog('0x' + '1'.repeat(40), RECIPIENT, 1000000n),
        ],
      })

      const result = await validateExecution(baseParams())
      expect(result.severity).toBe('ok')
      expect(result.actualOutput).toBe('1000000')
      expect(result.shortfallPercent).toBe(0)
      expect(result.extractionMethod).toBe('transfer_logs')
    })

    it('returns ok with surplus message when actual exceeds expected', async () => {
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          makeTransferLog('0x' + '1'.repeat(40), RECIPIENT, 1050000n), // 5% surplus
        ],
      })

      const result = await validateExecution(baseParams())
      expect(result.severity).toBe('ok')
      expect(result.actualOutput).toBe('1050000')
      expect(result.shortfallPercent).toBe(0)
      expect(result.reason).toContain('exceeds minimum')
    })

    it('returns ok when expected is 0', async () => {
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          makeTransferLog('0x' + '1'.repeat(40), RECIPIENT, 500n),
        ],
      })

      const result = await validateExecution(baseParams({ expectedMinOutput: '0' }))
      expect(result.severity).toBe('ok')
      expect(result.reason).toContain('any output is acceptable')
    })
  })

  // ── WARNING: 0–2% below expected ──────────────────────

  describe('warning severity', () => {
    it('returns warning when actual is 1% below expected', async () => {
      // Expected 1000000, actual 990000 (1% below)
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          makeTransferLog('0x' + '1'.repeat(40), RECIPIENT, 990000n),
        ],
      })

      const result = await validateExecution(baseParams())
      expect(result.severity).toBe('warning')
      expect(result.shortfallPercent).toBeCloseTo(0.01, 3)
      expect(result.reason).toContain('1.00%')
      // Warning does NOT auto-disable
      expect(mockForceDisable).not.toHaveBeenCalled()
    })

    it('returns warning at exactly 2% shortfall', async () => {
      // Expected 1000000, actual 980000 (2% below)
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          makeTransferLog('0x' + '1'.repeat(40), RECIPIENT, 980000n),
        ],
      })

      const result = await validateExecution(baseParams())
      expect(result.severity).toBe('warning')
      expect(result.shortfallPercent).toBeCloseTo(0.02, 3)
    })
  })

  // ── CRITICAL: >2% below expected ──────────────────────

  describe('critical severity', () => {
    it('returns critical when actual is 5% below expected', async () => {
      // Expected 1000000, actual 950000 (5% below)
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          makeTransferLog('0x' + '1'.repeat(40), RECIPIENT, 950000n),
        ],
      })

      const result = await validateExecution(baseParams())
      expect(result.severity).toBe('critical')
      expect(result.shortfallPercent).toBeCloseTo(0.05, 3)
      expect(result.reason).toContain('5.00%')
    })

    it('auto-disables source on critical', async () => {
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          makeTransferLog('0x' + '1'.repeat(40), RECIPIENT, 900000n), // 10% below
        ],
      })

      await validateExecution(baseParams())
      expect(mockForceDisable).toHaveBeenCalledWith(
        '1inch',
        expect.stringContaining('execution-validation-critical'),
      )
    })

    it('returns critical for reverted transaction', async () => {
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'reverted',
        logs: [],
      })

      const result = await validateExecution(baseParams())
      expect(result.severity).toBe('critical')
      expect(result.actualOutput).toBe('0')
      expect(result.shortfallPercent).toBe(1) // 100%
      expect(result.reason).toContain('reverted')
      expect(mockForceDisable).toHaveBeenCalled()
    })
  })

  // ── UNKNOWN: graceful degradation ─────────────────────

  describe('unknown severity (graceful degradation)', () => {
    it('returns unknown when receipt fetch fails', async () => {
      mockGetTransactionReceipt.mockRejectedValue(new Error('RPC timeout'))

      const result = await validateExecution(baseParams())
      expect(result.severity).toBe('unknown')
      expect(result.actualOutput).toBeNull()
      expect(result.shortfallPercent).toBeNull()
      expect(result.reason).toContain('Failed to fetch receipt')
      expect(result.reason).toContain('RPC timeout')
      // Must NOT auto-disable on unknown
      expect(mockForceDisable).not.toHaveBeenCalled()
    })

    it('returns unknown when receipt is null', async () => {
      mockGetTransactionReceipt.mockResolvedValue(null)

      const result = await validateExecution(baseParams())
      expect(result.severity).toBe('unknown')
      expect(result.reason).toContain('not found')
    })

    it('returns unknown when no Transfer logs and no preSwapBalance', async () => {
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [], // No Transfer events
      })

      const result = await validateExecution(baseParams())
      expect(result.severity).toBe('unknown')
      expect(result.extractionMethod).toBe('none')
      expect(result.reason).toContain('Could not extract')
    })
  })

  // ── Transfer log extraction ───────────────────────────

  describe('Transfer log extraction', () => {
    it('sums multiple Transfer events to recipient', async () => {
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          // Two transfers to recipient (split route)
          makeTransferLog('0x' + '1'.repeat(40), RECIPIENT, 600000n),
          makeTransferLog('0x' + '2'.repeat(40), RECIPIENT, 500000n),
        ],
      })

      const result = await validateExecution(baseParams())
      expect(result.severity).toBe('ok')
      expect(result.actualOutput).toBe('1100000') // 600000 + 500000
    })

    it('ignores Transfer events for wrong token', async () => {
      const wrongToken = '0x' + 'f'.repeat(40)
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          makeTransferLog('0x' + '1'.repeat(40), RECIPIENT, 999999999n, wrongToken),
        ],
      })

      const result = await validateExecution(baseParams())
      expect(result.severity).toBe('unknown') // No matching transfers
    })

    it('ignores Transfer events to wrong recipient', async () => {
      const wrongRecipient = '0x' + 'b'.repeat(40)
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          makeTransferLog('0x' + '1'.repeat(40), wrongRecipient, 999999999n),
        ],
      })

      const result = await validateExecution(baseParams())
      expect(result.severity).toBe('unknown')
    })
  })

  // ── balanceOf fallback ────────────────────────────────

  describe('balanceOf fallback', () => {
    it('uses balance diff when no Transfer logs found', async () => {
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [], // No Transfer events (e.g. non-standard token)
      })
      // Post-swap balance = 2000000, pre-swap was 900000 → diff = 1100000
      mockReadContract.mockResolvedValue(2000000n)

      const result = await validateExecution(baseParams({
        preSwapBalance: '900000',
      }))

      expect(result.severity).toBe('ok')
      expect(result.actualOutput).toBe('1100000')
      expect(result.extractionMethod).toBe('balance_diff')
    })

    it('falls back to unknown when balanceOf call fails', async () => {
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [],
      })
      mockReadContract.mockRejectedValue(new Error('contract call reverted'))

      const result = await validateExecution(baseParams({
        preSwapBalance: '900000',
      }))

      expect(result.severity).toBe('unknown')
      expect(result.extractionMethod).toBe('none')
    })
  })

  // ── Audit trail ───────────────────────────────────────

  describe('audit trail', () => {
    it('writes to KV for every validation result', async () => {
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          makeTransferLog('0x' + '1'.repeat(40), RECIPIENT, 1000000n),
        ],
      })

      await validateExecution(baseParams())
      expect(mockKvSet).toHaveBeenCalledTimes(1)
      expect(mockKvSet).toHaveBeenCalledWith(
        expect.stringContaining('teraswap:execution-audit:'),
        expect.objectContaining({ txHash: TX_HASH, severity: 'ok' }),
        { ex: 7 * 24 * 60 * 60 }, // 7-day TTL
      )
    })

    it('does not throw when KV write fails', async () => {
      mockKvSet.mockRejectedValue(new Error('KV unavailable'))
      mockGetTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          makeTransferLog('0x' + '1'.repeat(40), RECIPIENT, 1000000n),
        ],
      })

      // Should not throw
      const result = await validateExecution(baseParams())
      expect(result.severity).toBe('ok')
    })
  })

  // ── Never throws ──────────────────────────────────────

  describe('never throws', () => {
    it('returns unknown on any unexpected error', async () => {
      mockGetTransactionReceipt.mockRejectedValue(new Error('unexpected RPC failure'))

      const result = await validateExecution(baseParams())
      expect(result).toBeDefined()
      expect(result.severity).toBe('unknown')
      expect(result.txHash).toBe(TX_HASH)
    })
  })
})
