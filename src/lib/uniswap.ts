/**
 * Uniswap V3 Direct Integration
 *
 * Calls on-chain contracts directly via the public RPC:
 * - Quoter V2: simulate swap output (view call, no gas)
 * - SwapRouter02: execute swap (on-chain tx)
 *
 * Auto fee-tier detection: tries all 4 fee tiers (0.01%, 0.05%, 0.3%, 1%)
 * and picks the one with best output.
 */
import { encodeFunctionData, decodeFunctionResult, type Address } from 'viem'
import {
  UNISWAP_QUOTER_V2,
  UNISWAP_SWAP_ROUTER_02,
  UNISWAP_FEE_TIERS,
  WETH_ADDRESS,
  NATIVE_ETH,
  CHAIN_ID,
} from './constants'

// ── Minimal ABIs ─────────────────────────────────────────

// QuoterV2.quoteExactInputSingle
export const quoterV2Abi = [
  {
    inputs: [
      {
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'quoteExactInputSingle',
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

// SwapRouter02.exactInputSingle (no deadline — wrapped in multicall)
export const swapRouter02Abi = [
  {
    inputs: [
      {
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'exactInputSingle',
    outputs: [{ name: 'amountOut', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'deadline', type: 'uint256' },
      { name: 'data', type: 'bytes[]' },
    ],
    name: 'multicall',
    outputs: [{ name: 'results', type: 'bytes[]' }],
    stateMutability: 'payable',
    type: 'function',
  },
] as const

// ── Helpers ──────────────────────────────────────────────

/** Convert NATIVE_ETH sentinel to WETH for Uniswap */
function toWeth(token: string): Address {
  return (token.toLowerCase() === NATIVE_ETH.toLowerCase()
    ? WETH_ADDRESS
    : token) as Address
}

function isNativeEth(token: string): boolean {
  return token.toLowerCase() === NATIVE_ETH.toLowerCase()
}

// ── Types ────────────────────────────────────────────────

export interface UniswapQuoteResult {
  amountOut: bigint
  fee: number        // winning fee tier
  gasEstimate: bigint
  ticksCrossed: number
}

// ── Quote (view call via RPC) ────────────────────────────

/**
 * Try all fee tiers and return the best quote.
 * Uses eth_call (no gas cost) against QuoterV2.
 */
export async function quoteUniswapV3(
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  rpcUrl: string,
): Promise<UniswapQuoteResult> {
  const sellToken = toWeth(tokenIn)
  const buyToken = toWeth(tokenOut)

  const results = await Promise.allSettled(
    UNISWAP_FEE_TIERS.map(async (fee) => {
      const callData = encodeFunctionData({
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [{
          tokenIn: sellToken,
          tokenOut: buyToken,
          amountIn: BigInt(amountIn),
          fee,
          sqrtPriceLimitX96: 0n,
        }],
      })

      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: fee,
          method: 'eth_call',
          params: [
            { to: UNISWAP_QUOTER_V2, data: callData },
            'latest',
          ],
        }),
      })
      const json = await res.json()
      if (json.error) throw new Error(json.error.message || 'Quote reverted')

      const decoded = decodeFunctionResult({
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        data: json.result,
      })

      return {
        amountOut: decoded[0] as bigint,
        fee,
        gasEstimate: decoded[3] as bigint,
        ticksCrossed: Number(decoded[2]),
      }
    })
  )

  // Filter successful results and pick highest amountOut
  const fulfilled = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<UniswapQuoteResult>[]
  const successful = fulfilled
    .map(r => r.value)
    .filter(r => r.amountOut > 0n)

  if (successful.length === 0) {
    throw new Error('Uniswap V3: no pool found for this pair')
  }

  // Sort by amountOut descending (best first)
  successful.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0))

  return successful[0]
}

// ── Build swap transaction ───────────────────────────────

/**
 * Build the swap calldata for SwapRouter02.
 * Wraps `exactInputSingle` in `multicall(deadline, data[])`.
 */
export function buildUniswapSwapTx(
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  amountOutMinimum: string,
  fee: number,
  recipient: string,
  deadlineSeconds: number = 600, // 10 minutes
): { to: Address; data: `0x${string}`; value: string } {
  const sellToken = toWeth(tokenIn)
  const buyToken = toWeth(tokenOut)
  const isNativeIn = isNativeEth(tokenIn)

  // Encode the exactInputSingle call
  const swapCalldata = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: sellToken,
      tokenOut: buyToken,
      fee,
      recipient: recipient as Address,
      amountIn: BigInt(amountIn),
      amountOutMinimum: BigInt(amountOutMinimum),
      sqrtPriceLimitX96: 0n,
    }],
  })

  // Wrap in multicall with deadline
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds)
  const multicallData = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: 'multicall',
    args: [deadline, [swapCalldata]],
  })

  return {
    to: UNISWAP_SWAP_ROUTER_02,
    data: multicallData,
    // If selling native ETH, send as msg.value
    value: isNativeIn ? amountIn : '0',
  }
}
