/**
 * [P207] Shared pre-swap simulation helpers.
 *
 * Extracted from useSwap.ts so the split-swap path (useSplitSwap.ts) can run
 * the same `eth_call` pre-flight per leg. `buildSimulationTx` constructs the
 * exact transaction shape (FeeCollector-wrapped or direct) that will be
 * broadcast; `simulateSwapTx` runs it through the RPC and classifies the
 * result. Both single-swap and split-swap now share this code path so a
 * change to the simulation contract only has to happen in one place.
 */
import { encodeFunctionData } from 'viem'
import { getPrivateClient } from '@/lib/rpc'
import { parseSimulationError } from '@/lib/simulation'
import { FEE_COLLECTOR_ADDRESS, FEE_COLLECTOR_ABI } from '@/lib/constants'
import { isNativeETH, type Token } from '@/lib/tokens'
import { safeBigInt } from '@/lib/utils'
import type { NormalizedQuote } from '@/lib/api'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

// Simulation only checks revert/success, not gas usage. The adapter's
// tx.gas is too low for eth_call: Uniswap V3's QuoterV2 returns the
// quotation gas (~40K), which excludes multicall overhead, WETH wrapping,
// and pool/token transfers (~200-250K total). Use a generous floor so the
// sim never OOGs and misreports a fake revert. Real-tx gas is set
// separately at send time (still swapData.tx.gas).
export const SIM_GAS_FLOOR = 500_000n

export interface SimulationResult {
  success: boolean
  gasUsed?: bigint
  error?: string
}

/** Final tx shape handed to `simulateSwapTx`. */
export interface SimulationTx {
  to: `0x${string}`
  data: `0x${string}`
  value: bigint
  gas: bigint
  from: `0x${string}`
  expectedOutput: string
  tokenOut: Token
  source: string
}

export interface SimulationParams {
  swapData: NormalizedQuote
  routeViaFeeCollector: boolean
  isNativeIn: boolean
  tokenIn: Token
  tokenOut: Token
  /** Full (pre-fee) input amount in wei — FeeCollector deducts the fee on-chain. */
  rawAmount: bigint
  slippage: number
  fromAddress: `0x${string}`
  source: string
}

/**
 * Build the exact transaction that would be broadcast, so we can `eth_call`
 * it first. Mirrors the calldata construction in useSwap/useSplitSwap:
 *   - FeeCollector routing wraps the router calldata in swapETH/TokenWithFee
 *     and enforces a minimumOutput derived from the quote + user slippage.
 *   - Direct routing forwards the adapter calldata unchanged.
 */
export function buildSimulationTx(params: SimulationParams): SimulationTx {
  const { swapData, routeViaFeeCollector, isNativeIn, tokenIn, tokenOut, rawAmount, slippage, fromAddress, source } = params
  // Callers guard `if (!swapData.tx) throw` before reaching simulation.
  const tx = swapData.tx!

  // minimumOutput = toAmount * (10000 - slippageBps) / 10000.
  // `slippage` is a percentage (0.5 = 0.5%), so slippageBps = slippage * 100.
  // [10-L-01] A malformed toAmount disables the on-chain minimum (0n) rather
  // than crashing calldata encoding — better degraded than dead.
  const slippageBpsBn = BigInt(Math.max(0, Math.round(slippage * 100)))
  const swapToAmountBn = safeBigInt(swapData.toAmount)
  const minimumOutput =
    swapToAmountBn === null || slippageBpsBn >= 10_000n
      ? 0n
      : (swapToAmountBn * (10_000n - slippageBpsBn)) / 10_000n
  const tokenOutForFc: `0x${string}` = isNativeETH(tokenOut)
    ? ZERO_ADDRESS
    : (tokenOut.address as `0x${string}`)

  const router = tx.to
  const routerData = tx.data

  const to = routeViaFeeCollector ? (FEE_COLLECTOR_ADDRESS as `0x${string}`) : router
  const data = routeViaFeeCollector
    ? encodeFunctionData({
        abi: FEE_COLLECTOR_ABI,
        functionName: isNativeIn ? 'swapETHWithFee' : 'swapTokenWithFee',
        args: isNativeIn
          ? [router, routerData, tokenOutForFc, minimumOutput]
          : [tokenIn.address as `0x${string}`, rawAmount, router, routerData, tokenOutForFc, minimumOutput],
      })
    : routerData
  const value = routeViaFeeCollector && isNativeIn ? rawAmount : BigInt(tx.value || '0')

  const adapterGas = tx.gas > 0 ? BigInt(tx.gas) : 0n
  const fcOverhead = routeViaFeeCollector ? (isNativeIn ? 100_000n : 120_000n) : 0n
  const gas = adapterGas + fcOverhead < SIM_GAS_FLOOR ? SIM_GAS_FLOOR : adapterGas + fcOverhead

  return { to, data, value, gas, from: fromAddress, expectedOutput: swapData.toAmount, tokenOut, source }
}

/**
 * Simulate the transaction via `eth_call` before the wallet prompt.
 * Catches reverts, insufficient gas, and sandwich attacks.
 * [P140] Error parsing extracted to src/lib/simulation.ts for unit testing.
 */
export async function simulateSwapTx(params: SimulationTx): Promise<SimulationResult> {
  try {
    const client = getPrivateClient()
    await client.call({
      account: params.from,
      to: params.to,
      data: params.data,
      value: params.value,
      gas: params.gas,
    })
    // If eth_call returns data without reverting, the tx would succeed.
    return { success: true, gasUsed: params.gas }
  } catch (err) {
    const parsed = parseSimulationError(err)
    if (!parsed.success && parsed.error) {
      // Structured diagnostic — selector + tx shape only; never log full calldata.
      console.error('[TeraSwap] Simulation failed:', {
        source: params.source,
        to: params.to,
        value: params.value.toString(),
        gasLimit: params.gas?.toString(),
        errorMessage: parsed.error,
        selector: params.data.slice(0, 10),
      })
      return { success: false, error: parsed.error }
    }
    // Non-critical simulation failures shouldn't block the swap.
    console.warn('[TeraSwap] Simulation inconclusive:', err instanceof Error ? err.message : String(err))
    return { success: true }
  }
}
