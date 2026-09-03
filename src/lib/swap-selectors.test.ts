/**
 * [SPRINT-9H] KNOWN_SWAP_SELECTORS allowlist — coverage for the Velora/ParaSwap
 * Augustus V6.2 single-DEX Curve methods that Base (and mainnet) swaps emit.
 *
 * The selector whitelist is a SECURITY control (blocks unknown calldata before
 * a wallet prompt + at /api/swap). These selectors were verified three ways
 * against the live Augustus V6.2 contract (0x6a00…1068, identical address on
 * Ethereum + Base):
 *   - codeslaw verified ABI,
 *   - openchain.xyz signature database,
 *   - local viem toFunctionSelector() over the canonical signature.
 * All three agree; the known-good swapExactAmountIn (0xe3ead59e) reproduced
 * exactly, confirming the method.
 */
import { describe, it, expect } from 'vitest'
import { toFunctionSelector } from 'viem'
import { KNOWN_SWAP_SELECTORS, isKnownSwapSelector } from './swap-selectors'

const CALLDATA = (selector: string) => `${selector}${'0'.repeat(128)}`

// ── [ADR-021] 0x API v2 selectors ───────────────────────────────────────────
//
// The two selectors production rejected on 2026-09-03 12:35–12:36 UTC:
//   [SC-04] Rejected unknown swap selector: 0x2213bc0b source: 0x   (x2)
//   [SC-04] Rejected unknown swap selector: 0x1fff991f source: 0x   (x1)
// These are OBSERVATIONS copied from the server log, never "known" constants.
// Every assertion below puts the keccak-DERIVED value on the expected side and
// the observation on the actual side, so the test proves the signature
// reproduces the bytes rather than restating them.
const OBSERVED_IN_PROD = {
  exec: '0x2213bc0b',
  execute: '0x1fff991f',
} as const

/**
 * AllowanceHolder.exec — 0xProject/0x-settler,
 * src/allowanceholder/AllowanceHolderBase.sol:
 *   function exec(address operator, address token, uint256 amount,
 *                 address payable target, bytes calldata data)
 * `address payable` is `address` in the ABI encoding.
 */
const ALLOWANCE_HOLDER_EXEC_SIG = 'exec(address,address,uint256,address,bytes)'

/**
 * Settler.execute — 0xProject/0x-settler, src/Settler.sol:
 *   function execute(AllowedSlippage memory slippage, bytes[] calldata actions,
 *                    bytes32 /* zid & affiliate *\/)
 * with src/interfaces/ISettlerBase.sol:
 *   struct AllowedSlippage { address payable recipient; IERC20 buyToken; uint256 minAmountOut; }
 * → the struct flattens to the ABI tuple (address,address,uint256).
 */
const SETTLER_EXECUTE_SIG = 'execute((address,address,uint256),bytes[],bytes32)'

describe('KNOWN_SWAP_SELECTORS — Augustus V6.2 Curve methods [SPRINT-9H]', () => {
  it('allows swapExactAmountInOnCurveV1 (0x1a01c532) — the CurveV1StableNg route that failed on Base', () => {
    expect(KNOWN_SWAP_SELECTORS.has('0x1a01c532')).toBe(true)
    expect(isKnownSwapSelector(CALLDATA('0x1a01c532'))).toBe(true)
  })

  it('allows swapExactAmountInOnCurveV2 (0xe37ed256) — Curve crypto-pool routes', () => {
    expect(KNOWN_SWAP_SELECTORS.has('0xe37ed256')).toBe(true)
    expect(isKnownSwapSelector(CALLDATA('0xe37ed256'))).toBe(true)
  })

  it('still allows the existing Augustus V6 swapExactAmountIn (0xe3ead59e) — unchanged', () => {
    expect(KNOWN_SWAP_SELECTORS.has('0xe3ead59e')).toBe(true)
  })

  it('still blocks an unknown selector (gate not blindly widened)', () => {
    expect(isKnownSwapSelector(CALLDATA('0xdeadbeef'))).toBe(false)
  })
})

describe('KNOWN_SWAP_SELECTORS — mainnet selector set preserved [SPRINT-9H]', () => {
  // Every selector that was allowed before SPRINT-9H must remain allowed, so no
  // previously-working mainnet swap regresses (the allowlist is global, shared
  // by all chains — we only ADD, never remove).
  const PRE_9H = [
    '0x12aa3caf', '0xe449022e', '0x0502b1c5', '0x2e95b6c8', // 1inch
    '0xd9627aa4', '0x415565b0',                               // 0x
    '0x3598d8ab', '0xa94e78ef', '0x46c67b6d',                 // Paraswap V5
    '0xe3ead59e',                                             // Augustus V6 swapExactAmountIn
    '0x83800a8e',                                             // Odos
    '0xe21fd0e9',                                             // KyberSwap
    '0xac9650d8', '0x5ae401dc', '0x04e45aaf', '0xb858183f',   // Uniswap V3
    '0x472b43f3', '0x38ed1739', '0x7ff36ab5', '0x18cbafe5',   // Uniswap V2 / Sushi
  ]

  it('retains all 20 pre-9H selectors', () => {
    for (const sel of PRE_9H) expect(KNOWN_SWAP_SELECTORS.has(sel)).toBe(true)
  })

  it('adds exactly the two verified Curve selectors + the one 0x v2 selector (23 total, no accidental widening)', () => {
    // +2 Curve (SPRINT-9H) +1 AllowanceHolder.exec (ADR-021).
    expect(KNOWN_SWAP_SELECTORS.size).toBe(PRE_9H.length + 2 + 1)
  })
})

describe('KNOWN_SWAP_SELECTORS — 0x API v2 execution path [ADR-021]', () => {
  it('the derivation method itself is sound: it reproduces two selectors already in the set', () => {
    // Control for the method, not for 0x. If viem/keccak or the canonical-signature
    // convention were wrong, these two long-standing entries would not reproduce.
    expect(toFunctionSelector('sellToUniswap(address[],uint256,uint256,bool)')).toBe('0xd9627aa4')
    expect(
      toFunctionSelector('transformERC20(address,address,uint256,uint256,(uint32,bytes)[])'),
    ).toBe('0x415565b0')
    expect(KNOWN_SWAP_SELECTORS.has('0xd9627aa4')).toBe(true)
    expect(KNOWN_SWAP_SELECTORS.has('0x415565b0')).toBe(true)
  })

  it('0x2213bc0b IS AllowanceHolder.exec — derived, not asserted', () => {
    // Derived value on the expected side; the production observation on the actual side.
    expect(OBSERVED_IN_PROD.exec).toBe(toFunctionSelector(ALLOWANCE_HOLDER_EXEC_SIG))
  })

  it('0x1fff991f IS Settler.execute — derived, not asserted', () => {
    expect(OBSERVED_IN_PROD.execute).toBe(toFunctionSelector(SETTLER_EXECUTE_SIG))
  })

  it('accepts AllowanceHolder.exec — the only selector the chosen v2 flow emits', () => {
    const sel = toFunctionSelector(ALLOWANCE_HOLDER_EXEC_SIG)
    expect(KNOWN_SWAP_SELECTORS.has(sel)).toBe(true)
    expect(isKnownSwapSelector(CALLDATA(sel))).toBe(true)
  })

  it('still REJECTS Settler.execute — deliberate, not an oversight', () => {
    // [ADR-021] The allowance-holder flow puts Settler.execute in the `data`
    // ARGUMENT of exec(), never in `transaction.data`'s first four bytes. Since
    // the adapter no longer calls the permit2 endpoint on any chain, nothing we
    // build can emit this as an outer selector — and the Settler address rotates,
    // so it is not (and cannot be) router-whitelisted either. Whitelisting it
    // would widen the gate for calldata no TeraSwap flow produces.
    const sel = toFunctionSelector(SETTLER_EXECUTE_SIG)
    expect(KNOWN_SWAP_SELECTORS.has(sel)).toBe(false)
    expect(isKnownSwapSelector(CALLDATA(sel))).toBe(false)
  })

  it('negative control: an invented selector is still rejected', () => {
    expect(isKnownSwapSelector(CALLDATA('0xdeadbeef'))).toBe(false)
    expect(KNOWN_SWAP_SELECTORS.has('0xdeadbeef')).toBe(false)
  })
})
