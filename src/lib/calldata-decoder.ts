/**
 * Calldata transaction preview decoder.
 *
 * Decodes DEX swap calldata into a human-readable TransactionPreview for the
 * swap confirmation modal ("clear signing" — no blind signing).
 *
 * Reuses selector classification from calldata-recipient.ts (VALIDATED_SELECTORS,
 * MSG_SENDER_SELECTORS, TRUSTED_ROUTER_SELECTORS). Adds full parameter extraction
 * (amounts, tokens, deadlines) for display purposes.
 *
 * Graceful degradation: unknown/undecodable selectors return a valid preview
 * with validated=false and partial information. Never throws.
 */

import { decodeAbiParameters, zeroAddress, type Hex } from 'viem'
import { getSelector } from '@/lib/swap-selectors'
import {
  VALIDATED_SELECTORS,
  MSG_SENDER_SELECTORS,
  TRUSTED_ROUTER_SELECTORS,
  ALLOWANCE_HOLDER_EXEC_SELECTOR,
  ALLOWANCE_HOLDER_INNER_SELECTORS,
  AUGUSTUS_UNIV3_EXACT_IN_SELECTOR,
  AUGUSTUS_UNIV3_ARG_TYPES,
  AUGUSTUS_GENERIC_EXACT_IN_SELECTOR,
  AUGUSTUS_CURVE_V1_EXACT_IN_SELECTOR,
  AUGUSTUS_CURVE_V2_EXACT_IN_SELECTOR,
  decodeAugustusV62ExactIn,
} from '@/lib/calldata-recipient'

// ── Types ──────────────────────────────────────────────

export interface TransactionPreview {
  sourceDex: string
  functionName: string
  selector: string
  recipient: string | null
  /** 'invalid': a recipient was decoded but R1 rejects it outright (e.g. Augustus address(0)). */
  recipientType: 'extracted' | 'implicit' | 'invalid'
  tokenIn?: string
  tokenOut?: string
  amountIn?: string
  amountOutMin?: string
  /**
   * What `amountOutMin` actually is, when it is NOT the net minimum the
   * recipient receives — e.g. a router minimum its own fees are taken after.
   */
  amountOutMinLabel?: string
  deadline?: number
  validated: boolean
  validationReason?: string
}

// ── Selector metadata ──────────────────────────────────

export const SELECTOR_INFO: Record<string, { functionName: string; dexLabel: string }> = {
  // 1inch
  '0x12aa3caf': { functionName: 'swap', dexLabel: '1inch' },
  '0xe449022e': { functionName: 'uniswapV3Swap', dexLabel: '1inch' },
  '0x0502b1c5': { functionName: 'unoswap', dexLabel: '1inch' },
  '0x2e95b6c8': { functionName: 'unoswapTo', dexLabel: '1inch' },
  // 0x
  '0xd9627aa4': { functionName: 'sellToUniswap', dexLabel: '0x' },
  '0x415565b0': { functionName: 'transformERC20', dexLabel: '0x' },
  // [R1 Group G / ADR-021] 0x API v2 — AllowanceHolder.exec. Key derived from the
  // signature in calldata-recipient.ts, never typed, so the two cannot drift.
  [ALLOWANCE_HOLDER_EXEC_SELECTOR]: { functionName: 'exec', dexLabel: '0x v2' },
  // ParaSwap (Augustus V5 — legacy)
  '0x3598d8ab': { functionName: 'megaSwap', dexLabel: 'ParaSwap' },
  '0xa94e78ef': { functionName: 'multiSwap', dexLabel: 'ParaSwap' },
  '0x46c67b6d': { functionName: 'simpleSwap', dexLabel: 'ParaSwap' },
  // [R1 Group I] ParaSwap / Velora (Augustus V6.2 — generic + single-DEX Curve).
  // Keys derived in calldata-recipient.ts, never typed, so the two cannot drift.
  [AUGUSTUS_GENERIC_EXACT_IN_SELECTOR]: { functionName: 'swapExactAmountIn', dexLabel: 'ParaSwap V6' },
  [AUGUSTUS_CURVE_V1_EXACT_IN_SELECTOR]: { functionName: 'swapExactAmountInOnCurveV1', dexLabel: 'Velora V6.2' },
  [AUGUSTUS_CURVE_V2_EXACT_IN_SELECTOR]: { functionName: 'swapExactAmountInOnCurveV2', dexLabel: 'Velora V6.2' },
  // [R1 Group H] Velora (Augustus V6.2 — single-DEX Uniswap V3). Key derived in
  // calldata-recipient.ts, never typed, so the two cannot drift.
  [AUGUSTUS_UNIV3_EXACT_IN_SELECTOR]: { functionName: 'swapExactAmountInOnUniswapV3', dexLabel: 'Velora V6.2' },
  // Odos
  '0x83800a8e': { functionName: 'swap', dexLabel: 'Odos' },
  // KyberSwap
  '0xe21fd0e9': { functionName: 'swap', dexLabel: 'KyberSwap' },
  // Uniswap V3
  '0x04e45aaf': { functionName: 'exactInputSingle', dexLabel: 'Uniswap V3' },
  '0xb858183f': { functionName: 'exactInput', dexLabel: 'Uniswap V3' },
  '0xac9650d8': { functionName: 'multicall', dexLabel: 'Uniswap V3' },
  '0x5ae401dc': { functionName: 'multicall', dexLabel: 'Uniswap V3' },
  // Uniswap V2 / Sushi
  '0x472b43f3': { functionName: 'swapExactTokensForTokens', dexLabel: 'Uniswap V2' },
  '0x38ed1739': { functionName: 'swapExactTokensForTokens', dexLabel: 'Uniswap V2' },
  '0x7ff36ab5': { functionName: 'swapExactETHForTokens', dexLabel: 'Uniswap V2' },
  '0x18cbafe5': { functionName: 'swapExactTokensForETH', dexLabel: 'Uniswap V2' },
}

// ── Helpers ────────────────────────────────────────────

function strip(calldata: string): Hex {
  return `0x${calldata.slice(10)}` as Hex
}

// ── Parameter extractors (best-effort, never throw) ───
// These use the same ABI parameter shapes as calldata-recipient.ts
// decoders but extract ALL fields, not just the recipient.

function tryDecodeV3ExactInputSingle(data: Hex): Partial<TransactionPreview> {
  try {
    const decoded = decodeAbiParameters(
      [{
        name: 'params', type: 'tuple', components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      }],
      data,
    )
    const p = decoded[0] as {
      tokenIn: string; tokenOut: string; recipient: string
      amountIn: bigint; amountOutMinimum: bigint
    }
    return {
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      recipient: p.recipient,
      recipientType: 'extracted',
      amountIn: p.amountIn.toString(),
      amountOutMin: p.amountOutMinimum.toString(),
    }
  } catch { return {} }
}

/**
 * [R1 Group G] 0x v2 AllowanceHolder.exec — the display recipient lives inside
 * the nested Settler call, exactly where calldata-recipient.ts reads it. Without
 * this the confirmation modal would show "implicit" for a call whose recipient is
 * explicit, which is the opposite of clear signing.
 *
 * Display only, and best-effort: an inner selector this decoder does not know
 * simply yields no recipient. It grants nothing — R1 remains the gate.
 */
function tryDecodeAllowanceHolderExec(data: Hex): Partial<TransactionPreview> {
  try {
    const decoded = decodeAbiParameters(
      [
        { name: 'operator', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'target', type: 'address' },
        { name: 'data', type: 'bytes' },
      ],
      data,
    )
    const base: Partial<TransactionPreview> = {
      tokenIn: decoded[1] as string,
      amountIn: (decoded[2] as bigint).toString(),
    }
    const inner = decoded[4] as string
    if (inner.length < 10) return base
    if (!ALLOWANCE_HOLDER_INNER_SELECTORS.has(inner.slice(0, 10).toLowerCase())) return base

    const innerDecoded = decodeAbiParameters(
      [
        {
          name: 'slippage', type: 'tuple', components: [
            { name: 'recipient', type: 'address' },
            { name: 'buyToken', type: 'address' },
            { name: 'minAmountOut', type: 'uint256' },
          ],
        },
        { name: 'actions', type: 'bytes[]' },
        { name: 'zid', type: 'bytes32' },
      ],
      `0x${inner.slice(10)}` as Hex,
    )
    const slippage = innerDecoded[0] as {
      recipient: string; buyToken: string; minAmountOut: bigint
    }
    return {
      ...base,
      tokenOut: slippage.buyToken,
      amountOutMin: slippage.minAmountOut.toString(),
      recipient: slippage.recipient,
      recipientType: 'extracted',
    }
  } catch { return {} }
}

/**
 * [R1 Group H] Augustus V6.2 swapExactAmountInOnUniswapV3 — `uniData.beneficiary`
 * is where calldata-recipient.ts reads the recipient, so the modal shows it as
 * extracted. Reuses R1's ABI so the two cannot drift. Display only — R1 remains
 * the gate.
 *
 * [Audit round 1, L-02] A zero beneficiary (msg.sender on-chain, rejected by R1)
 * is shown as 'invalid' and unvalidated, never as an extracted recipient.
 * `toAmount` is labelled as the router minimum: Augustus checks it BEFORE taking
 * its fees (AugustusFees.sol:239-340), so it is not the net amount received.
 */
function tryDecodeAugustusUniswapV3(data: Hex): Partial<TransactionPreview> {
  try {
    const [uniData] = decodeAbiParameters(AUGUSTUS_UNIV3_ARG_TYPES, data)
    const params: Partial<TransactionPreview> = {
      tokenIn: uniData.srcToken,
      tokenOut: uniData.destToken,
      amountIn: uniData.fromAmount.toString(),
      amountOutMin: uniData.toAmount.toString(),
      amountOutMinLabel: 'router minimum (before router fees)',
      recipient: uniData.beneficiary,
      recipientType: 'extracted',
    }
    if (uniData.beneficiary.toLowerCase() === zeroAddress) {
      params.recipientType = 'invalid'
      params.validated = false
      params.validationReason = 'Augustus beneficiary is address(0) — resolves to msg.sender on-chain; rejected by R1'
    }
    return params
  } catch { return {} }
}

/**
 * [R1 Group I] Augustus V6.2 swapExactAmountIn / swapExactAmountInOnCurveV1 / V2 —
 * shown like Group H, read through R1's own decodeAugustusV62ExactIn so the two
 * cannot drift. Calldata that does not decode is shown as 'invalid', not left
 * to fall back to 'implicit': R1 rejects it.
 */
function tryDecodeAugustusV62ExactIn(selector: string, data: Hex): Partial<TransactionPreview> {
  try {
    const call = decodeAugustusV62ExactIn(selector, data)
    const params: Partial<TransactionPreview> = {
      tokenIn: call.srcToken,
      tokenOut: call.destToken,
      amountIn: call.fromAmount.toString(),
      amountOutMin: call.toAmount.toString(),
      amountOutMinLabel: 'router minimum (before router fees)',
      recipient: call.beneficiary,
      recipientType: 'extracted',
    }
    if (call.beneficiary.toLowerCase() === zeroAddress) {
      params.recipientType = 'invalid'
      params.validated = false
      params.validationReason = 'Augustus beneficiary is address(0) — resolves to msg.sender on-chain; rejected by R1'
    }
    return params
  } catch {
    return {
      recipientType: 'invalid',
      validated: false,
      validationReason: 'Augustus calldata does not decode — no recipient is provable; rejected by R1',
    }
  }
}

function tryDecodeV3ExactInput(data: Hex): Partial<TransactionPreview> {
  try {
    const decoded = decodeAbiParameters(
      [{
        name: 'params', type: 'tuple', components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      }],
      data,
    )
    const p = decoded[0] as {
      path: string; recipient: string
      amountIn: bigint; amountOutMinimum: bigint
    }
    // V3 path: tokenIn (20 bytes) + fee (3 bytes) + ... + tokenOut (20 bytes)
    const pathHex = p.path as string
    const tokenIn = pathHex.length >= 42 ? ('0x' + pathHex.slice(2, 42)) : undefined
    const tokenOut = pathHex.length >= 46 ? ('0x' + pathHex.slice(pathHex.length - 40)) : undefined
    return {
      tokenIn,
      tokenOut,
      recipient: p.recipient,
      recipientType: 'extracted',
      amountIn: p.amountIn.toString(),
      amountOutMin: p.amountOutMinimum.toString(),
    }
  } catch { return {} }
}

function tryDecode1inchSwap(data: Hex): Partial<TransactionPreview> {
  try {
    const decoded = decodeAbiParameters(
      [
        { name: 'executor', type: 'address' },
        {
          name: 'desc', type: 'tuple', components: [
            { name: 'srcToken', type: 'address' },
            { name: 'dstToken', type: 'address' },
            { name: 'srcReceiver', type: 'address' },
            { name: 'dstReceiver', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'minReturnAmount', type: 'uint256' },
            { name: 'flags', type: 'uint256' },
          ],
        },
        { name: 'permit', type: 'bytes' },
        { name: 'data', type: 'bytes' },
      ],
      data,
    )
    const desc = decoded[1] as {
      srcToken: string; dstToken: string; dstReceiver: string
      amount: bigint; minReturnAmount: bigint
    }
    return {
      tokenIn: desc.srcToken,
      tokenOut: desc.dstToken,
      recipient: desc.dstReceiver,
      recipientType: 'extracted',
      amountIn: desc.amount.toString(),
      amountOutMin: desc.minReturnAmount.toString(),
    }
  } catch { return {} }
}

function tryDecode1inchUnoswapTo(data: Hex): Partial<TransactionPreview> {
  try {
    const decoded = decodeAbiParameters(
      [
        { name: 'recipient', type: 'address' },
        { name: 'srcToken', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'minReturn', type: 'uint256' },
        { name: 'pools', type: 'uint256[]' },
      ],
      data,
    )
    return {
      tokenIn: decoded[1] as string,
      recipient: decoded[0] as string,
      recipientType: 'extracted',
      amountIn: (decoded[2] as bigint).toString(),
      amountOutMin: (decoded[3] as bigint).toString(),
    }
  } catch { return {} }
}

function tryDecodeV2Swap(selector: string, data: Hex): Partial<TransactionPreview> {
  try {
    switch (selector) {
      case '0x472b43f3': {
        const d = decodeAbiParameters(
          [
            { name: 'amountIn', type: 'uint256' },
            { name: 'amountOutMin', type: 'uint256' },
            { name: 'path', type: 'address[]' },
            { name: 'to', type: 'address' },
          ],
          data,
        )
        const path = d[2] as string[]
        return {
          tokenIn: path[0], tokenOut: path[path.length - 1],
          recipient: d[3] as string, recipientType: 'extracted',
          amountIn: (d[0] as bigint).toString(),
          amountOutMin: (d[1] as bigint).toString(),
        }
      }
      case '0x38ed1739': {
        const d = decodeAbiParameters(
          [
            { name: 'amountIn', type: 'uint256' },
            { name: 'amountOutMin', type: 'uint256' },
            { name: 'path', type: 'address[]' },
            { name: 'to', type: 'address' },
            { name: 'deadline', type: 'uint256' },
          ],
          data,
        )
        const path = d[2] as string[]
        return {
          tokenIn: path[0], tokenOut: path[path.length - 1],
          recipient: d[3] as string, recipientType: 'extracted',
          amountIn: (d[0] as bigint).toString(),
          amountOutMin: (d[1] as bigint).toString(),
          deadline: Number(d[4]),
        }
      }
      case '0x7ff36ab5': {
        const d = decodeAbiParameters(
          [
            { name: 'amountOutMin', type: 'uint256' },
            { name: 'path', type: 'address[]' },
            { name: 'to', type: 'address' },
            { name: 'deadline', type: 'uint256' },
          ],
          data,
        )
        const path = d[1] as string[]
        return {
          tokenIn: path[0], tokenOut: path[path.length - 1],
          recipient: d[2] as string, recipientType: 'extracted',
          amountOutMin: (d[0] as bigint).toString(),
          deadline: Number(d[3]),
        }
      }
      case '0x18cbafe5': {
        const d = decodeAbiParameters(
          [
            { name: 'amountIn', type: 'uint256' },
            { name: 'amountOutMin', type: 'uint256' },
            { name: 'path', type: 'address[]' },
            { name: 'to', type: 'address' },
            { name: 'deadline', type: 'uint256' },
          ],
          data,
        )
        const path = d[2] as string[]
        return {
          tokenIn: path[0], tokenOut: path[path.length - 1],
          recipient: d[3] as string, recipientType: 'extracted',
          amountIn: (d[0] as bigint).toString(),
          amountOutMin: (d[1] as bigint).toString(),
          deadline: Number(d[4]),
        }
      }
      default: return {}
    }
  } catch { return {} }
}

function tryDecodeMulticall(selector: string, data: Hex): Partial<TransactionPreview> {
  try {
    let innerCalls: readonly Hex[]
    let deadline: number | undefined

    if (selector === '0xac9650d8') {
      const d = decodeAbiParameters([{ name: 'data', type: 'bytes[]' }], data)
      innerCalls = d[0] as readonly Hex[]
    } else if (selector === '0x5ae401dc') {
      const d = decodeAbiParameters(
        [{ name: 'deadline', type: 'uint256' }, { name: 'data', type: 'bytes[]' }],
        data,
      )
      deadline = Number(d[0])
      innerCalls = d[1] as readonly Hex[]
    } else {
      return {}
    }

    if (innerCalls.length === 0) return { deadline }

    // Decode first inner call for token/amount info
    const first = innerCalls[0] as string
    const innerSel = getSelector(first)
    const innerData = strip(first)

    let inner: Partial<TransactionPreview> = {}
    if (innerSel === '0x04e45aaf') inner = tryDecodeV3ExactInputSingle(innerData)
    else if (innerSel === '0xb858183f') inner = tryDecodeV3ExactInput(innerData)

    return { ...inner, deadline }
  } catch { return {} }
}

// ── Main decoder ───────────────────────────────────────

export function decodeTransactionPreview(
  calldata: string,
  routerAddress: string,
  sourceName: string,
): TransactionPreview {
  const selector = getSelector(calldata)

  // Base preview from selector metadata
  const info = SELECTOR_INFO[selector]
  const preview: TransactionPreview = {
    sourceDex: info?.dexLabel ?? sourceName,
    functionName: info?.functionName ?? 'unknown',
    selector: selector || 'none',
    recipient: null,
    recipientType: 'implicit',
    validated: false,
  }

  // Empty/short calldata
  if (!selector) {
    preview.validationReason = 'Calldata too short to decode'
    return preview
  }

  // Validation: is this selector in the allowlist?
  preview.validated = VALIDATED_SELECTORS.has(selector)
  if (!preview.validated) {
    preview.validationReason = `Unknown selector ${selector} — not in validated allowlist`
  }

  // Classify recipient type
  if (MSG_SENDER_SELECTORS.has(selector) || TRUSTED_ROUTER_SELECTORS.has(selector)) {
    preview.recipientType = 'implicit'
  }

  // Extract full parameters (best-effort)
  const data = strip(calldata)
  let params: Partial<TransactionPreview> = {}

  switch (selector) {
    case '0x04e45aaf': params = tryDecodeV3ExactInputSingle(data); break
    case '0xb858183f': params = tryDecodeV3ExactInput(data); break
    case '0x12aa3caf': params = tryDecode1inchSwap(data); break
    case '0x2e95b6c8': params = tryDecode1inchUnoswapTo(data); break
    case '0x472b43f3': case '0x38ed1739': case '0x7ff36ab5': case '0x18cbafe5':
      params = tryDecodeV2Swap(selector, data); break
    case '0xac9650d8': case '0x5ae401dc':
      params = tryDecodeMulticall(selector, data); break
    case ALLOWANCE_HOLDER_EXEC_SELECTOR:
      params = tryDecodeAllowanceHolderExec(data); break
    case AUGUSTUS_UNIV3_EXACT_IN_SELECTOR:
      params = tryDecodeAugustusUniswapV3(data); break
    case AUGUSTUS_GENERIC_EXACT_IN_SELECTOR:
    case AUGUSTUS_CURVE_V1_EXACT_IN_SELECTOR:
    case AUGUSTUS_CURVE_V2_EXACT_IN_SELECTOR:
      params = tryDecodeAugustusV62ExactIn(selector, data); break
    // Groups A & F: no additional params decodable from proprietary calldata
  }

  return { ...preview, ...params }
}
