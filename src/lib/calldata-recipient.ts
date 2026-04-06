/**
 * [R1] Calldata Recipient Validation
 *
 * Extracts the recipient address from DEX swap calldata and validates it
 * matches the user's wallet address. This is a defense-in-depth measure
 * against compromised aggregator APIs that might try to redirect swap
 * output to an attacker-controlled address.
 *
 * Fail-open design: if we cannot parse the calldata, we allow the swap
 * through (with a warning) rather than blocking legitimate transactions.
 */

import { decodeAbiParameters, type Hex } from 'viem'
import { FEE_COLLECTOR_ADDRESS } from '@/lib/constants'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecipientCheckResult {
  valid: boolean
  extracted: string | null
  reason?: string
  implicitRecipient: boolean
}

// ---------------------------------------------------------------------------
// Constants — selectors grouped by decode strategy
// ---------------------------------------------------------------------------

/** Group A: msg.sender selectors — output goes to caller, no explicit recipient */
const MSG_SENDER_SELECTORS = new Set([
  '0xe449022e', // 1inch uniswapV3Swap
  '0x0502b1c5', // 1inch unoswap
  '0xd9627aa4', // 0x sellToUniswap
  '0x415565b0', // 0x transformERC20
])

/** Group F: complex/proprietary selectors we cannot decode yet */
const UNSUPPORTED_SELECTORS = new Set([
  '0x83800a8e', // Odos
  '0xe21fd0e9', // KyberSwap
  '0x3598d8ab', // ParaSwap megaSwap
  '0xa94e78ef', // ParaSwap multiSwap
  '0x46c67b6d', // ParaSwap simpleSwap
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSelector(calldata: string): string {
  return calldata.slice(0, 10).toLowerCase()
}

function stripSelector(calldata: string): Hex {
  return `0x${calldata.slice(10)}` as Hex
}

function isValidRecipient(extracted: string, expected: string): boolean {
  const validAddresses = [expected.toLowerCase()]
  if (FEE_COLLECTOR_ADDRESS) {
    validAddresses.push(FEE_COLLECTOR_ADDRESS.toLowerCase())
  }
  return validAddresses.includes(extracted.toLowerCase())
}

// ---------------------------------------------------------------------------
// Group B — V2 router decoders
// ---------------------------------------------------------------------------

function decodeV2Recipient(selector: string, data: Hex): string {
  switch (selector) {
    // swapExactTokensForTokens(uint256,uint256,address[],address)
    case '0x472b43f3': {
      const decoded = decodeAbiParameters(
        [
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'path', type: 'address[]' },
          { name: 'to', type: 'address' },
        ],
        data,
      )
      return decoded[3] as string
    }

    // swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
    case '0x38ed1739': {
      const decoded = decodeAbiParameters(
        [
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'path', type: 'address[]' },
          { name: 'to', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
        data,
      )
      return decoded[3] as string
    }

    // swapExactETHForTokens(uint256,address[],address,uint256)
    case '0x7ff36ab5': {
      const decoded = decodeAbiParameters(
        [
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'path', type: 'address[]' },
          { name: 'to', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
        data,
      )
      return decoded[2] as string
    }

    // swapExactTokensForETH(uint256,uint256,address[],address,uint256)
    case '0x18cbafe5': {
      const decoded = decodeAbiParameters(
        [
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'path', type: 'address[]' },
          { name: 'to', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
        data,
      )
      return decoded[3] as string
    }

    default:
      throw new Error(`Unknown V2 selector: ${selector}`)
  }
}

// ---------------------------------------------------------------------------
// Group C — Uniswap V3 struct decoders
// ---------------------------------------------------------------------------

function decodeV3Recipient(selector: string, data: Hex): string {
  switch (selector) {
    // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
    case '0x04e45aaf': {
      const decoded = decodeAbiParameters(
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
        data,
      )
      const params = decoded[0] as {
        tokenIn: string
        tokenOut: string
        fee: number
        recipient: string
        amountIn: bigint
        amountOutMinimum: bigint
        sqrtPriceLimitX96: bigint
      }
      return params.recipient
    }

    // exactInput((bytes,address,uint256,uint256))
    case '0xb858183f': {
      const decoded = decodeAbiParameters(
        [
          {
            name: 'params',
            type: 'tuple',
            components: [
              { name: 'path', type: 'bytes' },
              { name: 'recipient', type: 'address' },
              { name: 'amountIn', type: 'uint256' },
              { name: 'amountOutMinimum', type: 'uint256' },
            ],
          },
        ],
        data,
      )
      const params = decoded[0] as {
        path: string
        recipient: string
        amountIn: bigint
        amountOutMinimum: bigint
      }
      return params.recipient
    }

    default:
      throw new Error(`Unknown V3 selector: ${selector}`)
  }
}

// ---------------------------------------------------------------------------
// Group D — 1inch decoders
// ---------------------------------------------------------------------------

function decode1inchRecipient(selector: string, data: Hex): string {
  switch (selector) {
    // swap(address,(address,address,address,address,uint256,uint256,uint256),bytes,bytes)
    case '0x12aa3caf': {
      const decoded = decodeAbiParameters(
        [
          { name: 'executor', type: 'address' },
          {
            name: 'desc',
            type: 'tuple',
            components: [
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
      // viem returns tuples with named fields
      const desc = decoded[1] as {
        srcToken: string
        dstToken: string
        srcReceiver: string
        dstReceiver: string
        amount: bigint
        minReturnAmount: bigint
        flags: bigint
      }
      return desc.dstReceiver
    }

    // unoswapTo(address,address,uint256,uint256,uint256[])
    case '0x2e95b6c8': {
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
      return decoded[0] as string
    }

    default:
      throw new Error(`Unknown 1inch selector: ${selector}`)
  }
}

// ---------------------------------------------------------------------------
// Group E — Multicall wrappers (1 level of recursion max)
// ---------------------------------------------------------------------------

function decodeMulticallRecipient(
  selector: string,
  data: Hex,
  expectedAddress: string,
  depth: number,
): RecipientCheckResult {
  if (depth > 0) {
    return {
      valid: true,
      extracted: null,
      implicitRecipient: false,
      reason: 'Nested multicall — skipping recursive decode',
    }
  }

  let innerCalls: readonly Hex[]

  switch (selector) {
    // multicall(bytes[])
    case '0xac9650d8': {
      const decoded = decodeAbiParameters(
        [{ name: 'data', type: 'bytes[]' }],
        data,
      )
      innerCalls = decoded[0] as readonly Hex[]
      break
    }

    // multicall(uint256,bytes[])
    case '0x5ae401dc': {
      const decoded = decodeAbiParameters(
        [
          { name: 'deadline', type: 'uint256' },
          { name: 'data', type: 'bytes[]' },
        ],
        data,
      )
      innerCalls = decoded[1] as readonly Hex[]
      break
    }

    default:
      throw new Error(`Unknown multicall selector: ${selector}`)
  }

  if (innerCalls.length === 0) {
    return {
      valid: true,
      extracted: null,
      implicitRecipient: false,
      reason: 'Multicall with no inner calls',
    }
  }

  // Recursively validate the first inner call only
  const firstCall = innerCalls[0] as string
  return validateCallDataRecipientInner(firstCall, expectedAddress, depth + 1)
}

// ---------------------------------------------------------------------------
// Internal recursive entry point
// ---------------------------------------------------------------------------

function validateCallDataRecipientInner(
  calldata: string,
  expectedAddress: string,
  depth: number,
): RecipientCheckResult {
  try {
    if (!calldata || calldata.length < 10) {
      return {
        valid: true,
        extracted: null,
        implicitRecipient: false,
        reason: 'Calldata too short to decode',
      }
    }

    const selector = getSelector(calldata)
    const data = stripSelector(calldata)

    // Group A — msg.sender implicit recipient
    if (MSG_SENDER_SELECTORS.has(selector)) {
      return { valid: true, extracted: null, implicitRecipient: true }
    }

    // Group F — unsupported proprietary formats
    if (UNSUPPORTED_SELECTORS.has(selector)) {
      return {
        valid: true,
        extracted: null,
        implicitRecipient: false,
        reason:
          'Recipient extraction not yet supported for this selector',
      }
    }

    // Group B — V2 routers
    const V2_SELECTORS = ['0x472b43f3', '0x38ed1739', '0x7ff36ab5', '0x18cbafe5']
    if (V2_SELECTORS.includes(selector)) {
      const recipient = decodeV2Recipient(selector, data)
      return {
        valid: isValidRecipient(recipient, expectedAddress),
        extracted: recipient,
        implicitRecipient: false,
        ...(!isValidRecipient(recipient, expectedAddress) && {
          reason: `Recipient ${recipient} does not match expected ${expectedAddress}`,
        }),
      }
    }

    // Group C — Uniswap V3 structs
    const V3_SELECTORS = ['0x04e45aaf', '0xb858183f']
    if (V3_SELECTORS.includes(selector)) {
      const recipient = decodeV3Recipient(selector, data)
      return {
        valid: isValidRecipient(recipient, expectedAddress),
        extracted: recipient,
        implicitRecipient: false,
        ...(!isValidRecipient(recipient, expectedAddress) && {
          reason: `Recipient ${recipient} does not match expected ${expectedAddress}`,
        }),
      }
    }

    // Group D — 1inch
    const ONEINCH_SELECTORS = ['0x12aa3caf', '0x2e95b6c8']
    if (ONEINCH_SELECTORS.includes(selector)) {
      const recipient = decode1inchRecipient(selector, data)
      return {
        valid: isValidRecipient(recipient, expectedAddress),
        extracted: recipient,
        implicitRecipient: false,
        ...(!isValidRecipient(recipient, expectedAddress) && {
          reason: `Recipient ${recipient} does not match expected ${expectedAddress}`,
        }),
      }
    }

    // Group E — Multicall wrappers
    const MULTICALL_SELECTORS = ['0xac9650d8', '0x5ae401dc']
    if (MULTICALL_SELECTORS.includes(selector)) {
      return decodeMulticallRecipient(selector, data, expectedAddress, depth)
    }

    // Unknown selector — fail open
    return {
      valid: true,
      extracted: null,
      implicitRecipient: false,
      reason: `Unknown selector ${selector}`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[calldata-recipient] Decode error:', message)
    return {
      valid: true,
      extracted: null,
      implicitRecipient: false,
      reason: `Decode error: ${message}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validateCallDataRecipient(
  calldata: string,
  expectedAddress: string,
): RecipientCheckResult {
  return validateCallDataRecipientInner(calldata, expectedAddress, 0)
}
