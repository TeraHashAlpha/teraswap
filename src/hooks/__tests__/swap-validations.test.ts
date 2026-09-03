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
 *   6. minimumOutput derivation (deriveMinimumOutput, src/lib/minimum-output.ts)
 *
 * CoW Protocol path (useSwap.ts:545-631): native ETH block, receiver check,
 * validTo cap.
 */

import { describe, it, expect, vi } from 'vitest'
import { encodeAbiParameters } from 'viem'

import { validateRouterAddress, validateFeeIntegrity } from '@/lib/api'
import { FEE_NATIVE_SOURCES } from '@/lib/constants'
import type { AggregatorName } from '@/lib/constants'
import {
  isKnownSwapSelector,
  getSelector,
  KNOWN_SWAP_SELECTORS,
} from '@/lib/swap-selectors'
import { validateCallDataRecipient } from '@/lib/calldata-recipient'
import { isNativeETH } from '@/lib/tokens'
import type { Token } from '@/lib/tokens'
import { deriveMinimumOutput, UnusableQuoteError } from '@/lib/minimum-output'
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
const _ROUTER_0X = '0xdef1c0ded9bec7f1a1670819833240f027b25eff'

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
// A4b — Fee integrity call-site guard (mirrors useSwap.ts:314-345)
// ───────────────────────────────────────────────────────────────
// [P156] The check is now gated on FEE_NATIVE_SOURCES — i.e. only sources
// that apply the 0.1% fee inside their own API response. The previous
// gate was !routeViaFeeCollector, which fired on every non-FeeCollector
// swap and produced false positives once FEE_INCOMPATIBLE_SOURCES expanded
// to cover all 11 sources (Sprint 25D). The check is unchanged for the
// partner-fee model it was designed for — only the entry condition moved.
//
// Three fee modes the guard distinguishes:
//   1. routeViaFeeCollector       → contract enforces fee on-chain; skip.
//   2. source ∈ FEE_NATIVE_SOURCES → aggregator applies fee in API; check.
//   3. source ∈ FEE_INCOMPATIBLE   → no fee at all; check is meaningless.
// ═══════════════════════════════════════════════════════════════

/**
 * Mirrors the production guard in useSwap.ts so a future drift between
 * the two flags the test rather than the user. Membership is injected
 * explicitly here so each branch can be exercised in isolation; the guard
 * driven by the REAL constant lives in lib/fee-integrity-armed.test.ts.
 *
 * [fix/zerox-partner-fee-armed] `FEE_NATIVE_SOURCES` is no longer empty — it
 * names 0x, cowswap and bebop, the three sources whose adapters actually send
 * partner-fee params. These cases are therefore reachable in production now.
 */
function runFeeIntegrityCallSite(args: {
  quoteToAmount: string | null
  swapToAmount: string
  source: AggregatorName
  usesPartnerFee: boolean
}): { ran: boolean; valid: boolean } {
  if (args.quoteToAmount && args.usesPartnerFee) {
    const r = validateFeeIntegrity(args.quoteToAmount, args.swapToAmount, args.source)
    return { ran: true, valid: r.valid }
  }
  return { ran: false, valid: true }
}

describe('A4b — fee integrity call-site guard [P156]', () => {
  // ── Case 1: FeeCollector route (irrelevant — fee is on-chain) ──

  it('FeeCollector route + non-partner source → SKIPS validateFeeIntegrity', () => {
    // Same inputs that would FAIL the check (10% higher output) but the
    // partner-fee guard short-circuits before validateFeeIntegrity runs.
    // A FeeCollector-routed source is also never in FEE_NATIVE_SOURCES, so
    // usesPartnerFee=false here regardless of the FeeCollector flag.
    const result = runFeeIntegrityCallSite({
      quoteToAmount: '1000000',
      swapToAmount: '1100000',
      source: 'kyberswap',
      usesPartnerFee: false,
    })
    expect(result.ran).toBe(false)
    expect(result.valid).toBe(true)
  })

  // ── Case 2: partner-fee source (the only case the check applies to) ──

  it('source IS in FEE_NATIVE_SOURCES → RUNS validateFeeIntegrity', () => {
    // Injected membership keeps this case source-agnostic. In production the
    // reachable members are 0x / cowswap / bebop (FEE_NATIVE_SOURCES).
    const result = runFeeIntegrityCallSite({
      quoteToAmount: '1000000',
      swapToAmount: '990000', // ~1% lower → fee likely applied → valid
      source: '1inch',
      usesPartnerFee: true,
    })
    expect(result.ran).toBe(true)
    expect(result.valid).toBe(true)
  })

  it('source IS in FEE_NATIVE_SOURCES with suspiciously high output → still fails', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = runFeeIntegrityCallSite({
      quoteToAmount: '1000000',
      swapToAmount: '1100000', // 10% higher → fee never applied → fails
      source: '1inch',
      usesPartnerFee: true,
    })
    expect(result.ran).toBe(true)
    expect(result.valid).toBe(false)
    consoleSpy.mockRestore()
  })

  // ── Case 3: fee-incompatible source (no fee — check is meaningless) ──

  it('source NOT in FEE_NATIVE_SOURCES → SKIPS check (was the false-positive path)', () => {
    // The exact shape that used to fire the false positive: an aggregator
    // returning a slightly higher swap-output than the original quote due
    // to routing volatility on small amounts. The previous guard ran the
    // check here (case 3) and blocked the swap; the new guard skips.
    const result = runFeeIntegrityCallSite({
      quoteToAmount: '1000000',
      swapToAmount: '1025000', // +2.5% — would have tripped the 2% tolerance
      source: 'kyberswap',
      usesPartnerFee: false,
    })
    expect(result.ran).toBe(false)
    expect(result.valid).toBe(true)
  })

  // ── Boundary: missing quote anchor ──

  it('quoteToAmount=null → skipped regardless of partner-fee membership', () => {
    const result = runFeeIntegrityCallSite({
      quoteToAmount: null,
      swapToAmount: '1100000',
      source: '1inch',
      usesPartnerFee: true,
    })
    expect(result.ran).toBe(false)
  })

  // ── Constant invariant: FEE_NATIVE_SOURCES names the real partner-fee sources ──

  it('FEE_NATIVE_SOURCES names the sources whose adapters send partner-fee params', () => {
    // [fix/zerox-partner-fee-armed] This assertion used to read `toEqual([])`
    // and called that "the current production reality". It had stopped being
    // true: SPRINT-9T shipped native partner-fee params in adapters/zerox.ts,
    // cow.ts and bebop.ts while this list stayed empty, so the guard below was
    // skipping the very sources it exists to check. Pinning the empty list is
    // what let that drift survive — the list is now derived from what the
    // adapters actually put on the wire, enforced by
    // lib/adapters/partner-fee-drift.test.ts.
    expect([...FEE_NATIVE_SOURCES].sort()).toEqual(['0x', 'bebop', 'cowswap'])
  })

  it('a 0x swap therefore RUNS the check at the call site', () => {
    const result = runFeeIntegrityCallSite({
      quoteToAmount: '1000000',
      swapToAmount: '990000',
      source: '0x',
      usesPartnerFee: FEE_NATIVE_SOURCES.includes('0x'),
    })
    expect(result).toEqual({ ran: true, valid: true })
  })
})

// ═══════════════════════════════════════════════════════════════
// A5 — minimumOutput derivation edge cases [W2-L-01]
// ───────────────────────────────────────────────────────────────
// The real derivation is the exported deriveMinimumOutput
// (src/lib/minimum-output.ts) — shared by useSwap.ts, useSplitSwap.ts
// and buildSimulationTx — tested here directly (no mirror). Since
// W2-L-01, an unusable toAmount (malformed / zero / unparseable)
// THROWS UnusableQuoteError — the swap is REFUSED — instead of the
// old 10-L-01 fallback to minimumOutput = 0n, which silently disabled
// the FeeCollector's on-chain InsufficientOutput check.
// Takes slippage as a PERCENT (0.5 = 0.5%), exactly like the hooks.
// ═══════════════════════════════════════════════════════════════

describe('A5 — deriveMinimumOutput (src/lib/minimum-output.ts) [W2-L-01]', () => {
  it('valid toAmount with 1% slippage → toAmount * 9900 / 10000', () => {
    // 1_000_000 * 9900 / 10000 = 990_000
    expect(deriveMinimumOutput('1000000', 1)).toBe(990_000n)
  })

  it('toAmount = "abc" (non-numeric) → UnusableQuoteError (swap refused, NOT minOutput 0)', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => deriveMinimumOutput('abc', 1)).toThrow(UnusableQuoteError)
    consoleSpy.mockRestore()
  })

  it('toAmount = "0" → UnusableQuoteError (a zero-output quote is not executable)', () => {
    expect(() => deriveMinimumOutput('0', 1)).toThrow(UnusableQuoteError)
  })

  it('toAmount = "" (empty string) → UnusableQuoteError', () => {
    expect(() => deriveMinimumOutput('', 1)).toThrow(UnusableQuoteError)
  })

  it('slippage = 100% with a VALID toAmount → 0n (explicit user setting, unchanged)', () => {
    expect(deriveMinimumOutput('1000000', 100)).toBe(0n)
  })

  it('slippage = 99.99% → toAmount * 1 / 10000 (NOT zero)', () => {
    // 1_000_000 * 1 / 10000 = 100
    expect(deriveMinimumOutput('1000000', 99.99)).toBe(100n)
  })

  it('slippage = 0% → toAmount unchanged', () => {
    expect(deriveMinimumOutput('1000000', 0)).toBe(1_000_000n)
  })

  it('negative slippage is clamped to 0 (Math.max guard)', () => {
    expect(deriveMinimumOutput('1000000', -0.5)).toBe(1_000_000n)
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
