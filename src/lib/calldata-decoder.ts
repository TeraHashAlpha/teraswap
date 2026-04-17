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

import { decodeAbiParameters, type Hex } from 'viem'
import { getSelector } from '@/lib/swap-selectors'
import {
  VALIDATED_SELECTORS,
  MSG_SENDER_SELECTORS,
  TRUSTED_ROUTER_SELECTORS,
} from '@/lib/calldata-recipient'

// ── Types ──────────────────────────────────────────────

export interface TransactionPreview {
  sourceDex: string
  functionName: string
  selector: string
  recipient: string | null
  recipientType: 'extracted' | 'implicit'
  tokenIn?: string
  tokenOut?: string
  amountIn?: string
  amountOutMin?: string
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
  // ParaSwap
  '0x3598d8ab': { functionName: 'megaSwap', dexLabel: 'ParaSwap' },
  '0xa94e78ef': { functionName: 'multiSwap', dexLabel: 'ParaSwap' },
  '0x46c67b6d': { functionName: 'simpleSwap', dexLabel: 'ParaSwap' },
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
    // Groups A & F: no additional params decodable from proprietary calldata
  }

  return { ...preview, ...params }
}
