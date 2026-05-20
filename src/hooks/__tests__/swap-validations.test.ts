/**
 * [P132 / M-01] Direct unit tests for the security validation chain that
 * useSwap.execute() runs before sending a transaction. Tests the imported
 * pure functions — the React hook itself is covered by useSwap.test.ts.
 *
 * Validator order in useSwap.execute() (see src/hooks/useSwap.ts):
 *   1. tx.data shape       (length 10–200000)
 *   2. validateRouterAddress
 *   3. isKnownSwapSelector (KNOWN_SWAP_SELECTORS)
 *   4. validateCallDataRecipient
 *   5. validateFeeIntegrity
 *   6. minimumOutput computation (inline at useSwap.ts:329-338)
 *
 * CoW Protocol path (useSwap.ts:545-631): native ETH block, receiver check,
 * validTo cap.
 */

import { describe, it, expect, vi } from 'vitest'
import { encodeAbiParameters } from 'viem'

import { validateRouterAddress, validateFeeIntegrity } from '@/lib/api'
import {
  isKnownSwapSelector,
  getSelector,
  KNOWN_SWAP_SELECTORS,
} from '@/lib/swap-selectors'
import { validateCallDataRecipient } from '@/lib/calldata-recipient'
import { isNativeETH } from '@/lib/tokens'
import type { Token } from '@/lib/tokens'
import { safeBigInt } from '@/lib/utils'
import {
  FEE_COLLECTOR_ADDRESS,
  FEE_COLLECTOR_V1_ADDRESS,
  NATIVE_ETH,
  COW_MAX_ORDER_DURATION_SEC,
} from '@/lib/constants'

// ─── Test fixtures ───────────────────────────────────────────

const USER_ADDR = '0x1111111111111111111111111111111111111111'
const ATTACKER_ADDR = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

// 1inch AggregationRouter v6 — a known whitelisted router
const ROUTER_1INCH_V6 = '0x111111125421ca6dc452d289314280a0f8842a65'
// 0x Exchange Proxy
const ROUTER_0X = '0xdef1c0ded9bec7f1a1670819833240f027b25eff'

// Build Uniswap V3 exactInputSingle (selector 0x04e45aaf, Group C of
// VALIDATED_SELECTORS — single tuple, no dynamic types) with a specific
// recipient. The architecture-level prompt calls this "Group B" (recipient
// extracted from calldata) regardless of which DEX it targets.
function buildV3ExactInputSingleCalldata(recipient: string): string {
  const encoded = encodeAbiParameters(
    [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    [
      {
        tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}`,
        tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
        fee: 3000,
        recipient: recipient as `0x${string}`,
        amountIn: 1_000_000_000_000_000_000n,
        amountOutMinimum: 3_000_000_000n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  )
  return '0x04e45aaf' + encoded.slice(2)
}

// ═══════════════════════════════════════════════════════════════
// A1 — Router address whitelist
// ═══════════════════════════════════════════════════════════════

describe('A1 — validateRouterAddress', () => {
  it('accepts a known 1inch v6 router', () => {
    const result = validateRouterAddress(ROUTER_1INCH_V6, '1inch')
    expect(result.valid).toBe(true)
  })

  it('accepts the FeeCollector address (proxied swaps route through it)', () => {
    const result = validateRouterAddress(FEE_COLLECTOR_ADDRESS, 'cowswap')
    expect(result.valid).toBe(true)
  })

  it('rejects an arbitrary attacker address with a clear reason', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = validateRouterAddress(ATTACKER_ADDR, '1inch')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('NOT in the router whitelist')
    consoleSpy.mockRestore()
  })

  it('rejects the zero address', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = validateRouterAddress(
      '0x0000000000000000000000000000000000000000',
      '1inch',
    )
    expect(result.valid).toBe(false)
    consoleSpy.mockRestore()
  })

  it('normalises checksum vs lowercase — same address either way', () => {
    const lower = validateRouterAddress(ROUTER_1INCH_V6, '1inch')
    const upper = validateRouterAddress(ROUTER_1INCH_V6.toUpperCase().replace('0X', '0x'), '1inch')
    expect(lower.valid).toBe(true)
    expect(upper.valid).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// A2 — Swap selector allowlist
// ═══════════════════════════════════════════════════════════════

describe('A2 — isKnownSwapSelector', () => {
  it('returns true for every selector in KNOWN_SWAP_SELECTORS', () => {
    for (const sel of KNOWN_SWAP_SELECTORS) {
      // Pad with arbitrary calldata body so the function sees a full hex string.
      expect(isKnownSwapSelector(sel + '00')).toBe(true)
    }
  })

  it('returns false for an unknown selector (0xdeadbeef + body)', () => {
    expect(isKnownSwapSelector('0xdeadbeef' + '00'.repeat(32))).toBe(false)
  })

  it('returns false for empty calldata', () => {
    expect(isKnownSwapSelector('')).toBe(false)
  })

  it('returns false for partial selector (only 3 bytes)', () => {
    expect(isKnownSwapSelector('0x123456')).toBe(false)
  })

  it('getSelector lowercases the extracted 4 bytes', () => {
    expect(getSelector('0x38ED1739abcd')).toBe('0x38ed1739')
  })
})

// ═══════════════════════════════════════════════════════════════
// A3 — Calldata recipient validation
// ═══════════════════════════════════════════════════════════════

describe('A3 — validateCallDataRecipient', () => {
  it('Group A selector → valid with implicitRecipient (msg.sender)', () => {
    // 0xe449022e — 1inch uniswapV3Swap (msg.sender by design)
    const calldata = '0xe449022e' + '00'.repeat(64)
    const result = validateCallDataRecipient(calldata, USER_ADDR)
    expect(result.valid).toBe(true)
    expect(result.implicitRecipient).toBe(true)
  })

  it('Group B selector with user address as recipient → valid', () => {
    const calldata = buildV3ExactInputSingleCalldata(USER_ADDR)
    const result = validateCallDataRecipient(calldata, USER_ADDR)
    expect(result.valid).toBe(true)
    expect(result.extracted?.toLowerCase()).toBe(USER_ADDR.toLowerCase())
  })

  it('Group B selector with FeeCollector V2 address → valid (proxy path)', () => {
    const calldata = buildV3ExactInputSingleCalldata(FEE_COLLECTOR_ADDRESS)
    const result = validateCallDataRecipient(calldata, USER_ADDR)
    expect(result.valid).toBe(true)
  })

  it('Group B selector with FeeCollector V1 address → valid (legacy proxy)', () => {
    const calldata = buildV3ExactInputSingleCalldata(FEE_COLLECTOR_V1_ADDRESS)
    const result = validateCallDataRecipient(calldata, USER_ADDR)
    expect(result.valid).toBe(true)
  })

  it('Group B selector with attacker address → invalid, extracted = attacker', () => {
    const calldata = buildV3ExactInputSingleCalldata(ATTACKER_ADDR)
    const result = validateCallDataRecipient(calldata, USER_ADDR)
    expect(result.valid).toBe(false)
    expect(result.extracted?.toLowerCase()).toBe(ATTACKER_ADDR.toLowerCase())
  })

  it('unknown selector → invalid (fail-closed)', () => {
    const calldata = '0xdeadbeef' + '00'.repeat(32)
    const result = validateCallDataRecipient(calldata, USER_ADDR)
    expect(result.valid).toBe(false)
  })

  it('malformed calldata (too short) → invalid', () => {
    const result = validateCallDataRecipient('0x12', USER_ADDR)
    expect(result.valid).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// A4 — Fee integrity validation
// ═══════════════════════════════════════════════════════════════

describe('A4 — validateFeeIntegrity', () => {
  it('swap output within normal range of quote → valid', () => {
    // 1% lower than quote — well within the 2% tolerance band.
    const result = validateFeeIntegrity('1000000', '990000', '1inch')
    expect(result.valid).toBe(true)
  })

  it('swap output suspiciously HIGHER than quote → invalid (fee-bypass)', () => {
    // 10% higher than quote — exceeds 2% tolerance.
    const result = validateFeeIntegrity('1000000', '1100000', '1inch')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('Fee integrity check failed')
  })

  it('quote = 0 → valid (skip — no fee to verify)', () => {
    const result = validateFeeIntegrity('0', '1000000', '1inch')
    expect(result.valid).toBe(true)
  })

  it('uniswapv3 source → valid (skip — no FeeCollector fee on direct path)', () => {
    // Even a wildly higher swap output passes because uniswapv3 skips the check.
    const result = validateFeeIntegrity('1000000', '5000000', 'uniswapv3')
    expect(result.valid).toBe(true)
  })

  it('cowswap source → valid (skip — surplus paid via solver, not deduction)', () => {
    const result = validateFeeIntegrity('1000000', '5000000', 'cowswap')
    expect(result.valid).toBe(true)
  })

  it('swap exactly at the 2% tolerance ceiling → valid', () => {
    // 1_000_000 + 20_000 (2%) = 1_020_000 — the boundary; ">" not ">="
    const result = validateFeeIntegrity('1000000', '1020000', '1inch')
    expect(result.valid).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// A5 — minimumOutput computation edge cases
// ───────────────────────────────────────────────────────────────
// The real computation lives inline in src/hooks/useSwap.ts:329-338. We
// replicate it as a pure helper so the edge cases can be pinned down in
// a unit test without rendering the hook. If the production formula
// changes, this helper must be updated to match.
// ═══════════════════════════════════════════════════════════════

function computeMinimumOutput(toAmount: string, slippageBps: number): bigint {
  const swapToAmountBn = safeBigInt(toAmount)
  const slippageBpsBn = BigInt(Math.max(0, Math.round(slippageBps)))
  if (swapToAmountBn === null || slippageBpsBn >= 10_000n) return 0n
  return (swapToAmountBn * (10_000n - slippageBpsBn)) / 10_000n
}

describe('A5 — computeMinimumOutput (mirrors useSwap.ts:329-338)', () => {
  it('valid toAmount with 1% slippage → toAmount * 9900 / 10000', () => {
    // 1_000_000 * 9900 / 10000 = 990_000
    expect(computeMinimumOutput('1000000', 100)).toBe(990_000n)
  })

  it('toAmount = "abc" (non-numeric) → 0n (safeBigInt returns null)', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(computeMinimumOutput('abc', 100)).toBe(0n)
    consoleSpy.mockRestore()
  })

  it('toAmount = "0" → 0n', () => {
    expect(computeMinimumOutput('0', 100)).toBe(0n)
  })

  it('toAmount = "" (empty string) → 0n (safeBigInt returns null)', () => {
    expect(computeMinimumOutput('', 100)).toBe(0n)
  })

  it('slippageBps = 10000 (100%) → 0n (defence: never accept zero output)', () => {
    expect(computeMinimumOutput('1000000', 10_000)).toBe(0n)
  })

  it('slippageBps = 9999 → toAmount * 1 / 10000 (NOT zero)', () => {
    // 1_000_000 * 1 / 10000 = 100
    expect(computeMinimumOutput('1000000', 9_999)).toBe(100n)
  })

  it('slippageBps = 0 → toAmount unchanged', () => {
    expect(computeMinimumOutput('1000000', 0)).toBe(1_000_000n)
  })

  it('negative slippageBps is clamped to 0 (Math.max guard)', () => {
    expect(computeMinimumOutput('1000000', -50)).toBe(1_000_000n)
  })
})

// ═══════════════════════════════════════════════════════════════
// B — CoW Protocol path validations
// ───────────────────────────────────────────────────────────────
// The CoW guards live inline in useSwap.ts:545-631 (native ETH block,
// receiver check, validTo cap). Receiver + validTo logic is replicated
// as helpers; native ETH detection uses the exported isNativeETH.
// ═══════════════════════════════════════════════════════════════

function checkCowReceiver(receiver: string | undefined, userAddress: string): void {
  const r = (receiver || '').toLowerCase()
  if (r && r !== userAddress.toLowerCase()) {
    throw new Error(`CoW order receiver (${r}) does not match your wallet. Possible API compromise.`)
  }
}

function capValidTo(validTo: number, nowSec: number = Math.floor(Date.now() / 1000)): number {
  const maxValidTo = nowSec + COW_MAX_ORDER_DURATION_SEC
  return validTo > maxValidTo ? maxValidTo : validTo
}

function makeToken(address: string): Token {
  return {
    address: address as `0x${string}`,
    symbol: 'TEST',
    name: 'Test Token',
    decimals: 18,
    logoURI: '',
    category: 'Other',
  }
}

describe('B — CoW Protocol path guards', () => {
  it('native ETH detection: NATIVE_ETH pseudoaddress → true (would be blocked)', () => {
    expect(isNativeETH(makeToken(NATIVE_ETH))).toBe(true)
  })

  it('native ETH detection: WETH → false (allowed for CoW)', () => {
    expect(isNativeETH(makeToken('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'))).toBe(false)
  })

  it('receiver === userAddress → does not throw', () => {
    expect(() => checkCowReceiver(USER_ADDR, USER_ADDR)).not.toThrow()
  })

  it('receiver === undefined → does not throw (defaults to user)', () => {
    expect(() => checkCowReceiver(undefined, USER_ADDR)).not.toThrow()
  })

  it('receiver === attacker → throws with "does not match"', () => {
    expect(() => checkCowReceiver(ATTACKER_ADDR, USER_ADDR)).toThrow(/does not match/)
  })

  it('validTo > now + 1800s → clamped to now + 1800s', () => {
    const now = 1_700_000_000
    const futureFar = now + 10 * 3600 // 10 hours from now
    expect(capValidTo(futureFar, now)).toBe(now + COW_MAX_ORDER_DURATION_SEC)
  })

  it('validTo within range → unchanged', () => {
    const now = 1_700_000_000
    const ok = now + 600 // 10 min from now
    expect(capValidTo(ok, now)).toBe(ok)
  })

  it('COW_MAX_ORDER_DURATION_SEC is 30 minutes (1800s)', () => {
    expect(COW_MAX_ORDER_DURATION_SEC).toBe(1800)
  })
})
