import { encodeFunctionData, decodeFunctionResult, type Address } from 'viem'
import { UNISWAP_FEE_TIERS } from '@/lib/constants'
import { getUniswapV3Contracts } from '@/lib/chains/uniswap-v3'
import { DEFAULT_CHAIN_ID } from '@/lib/chains/registry'
import {
  clampSlippage,
  toWeth,
  isNativeEth,
  getRpcUrlForChain,
  getCachedFeeTier,
  setCachedFeeTier,
  invalidateCachedFeeTier,
} from './shared'
import type {
  DEXAdapter,
  NormalizedQuote,
  QuoteParams,
  SwapParams,
  FeeTierCandidate,
  FeeTierDetection,
} from './types'

// ── Minimal ABIs (inline) ───────────────────────────────

const QUOTER_V2_ABI = [
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

const SWAP_ROUTER_02_ABI = [
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

// ── Auto fee tier detection ─────────────────────────────

/**
 * Auto fee tier detection for Uniswap V3.
 *
 * Quotes all 4 fee tiers in parallel via QuoterV2.quoteExactInputSingle.
 * Selection: highest amountOut wins; on tie, lowest gasEstimate wins.
 *
 * Returns full detection result with all candidates + reason.
 * Caches bestFee in-memory (45 min TTL) to avoid re-detection.
 */
export async function detectUniswapV3FeeTier(params: {
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  sqrtPriceLimitX96?: bigint
  // [SPRINT-9C] Target chain. Omitted → mainnet (DEFAULT_CHAIN_ID), so existing
  // mainnet behaviour is byte-identical.
  chainId?: number
}): Promise<FeeTierDetection> {
  const { tokenIn, tokenOut, amountIn, sqrtPriceLimitX96 = 0n, chainId = DEFAULT_CHAIN_ID } = params
  // [SPRINT-9C] Resolve the Quoter + RPC for the REQUESTED chain. Never fall back
  // to mainnet off-mainnet: if V3 isn't configured for this chain, return no pool.
  const contracts = getUniswapV3Contracts(chainId)
  if (!contracts) throw new Error(`Uniswap V3: not deployed on chain ${chainId}`)
  const rpcUrl = getRpcUrlForChain(chainId)
  const sellToken = toWeth(tokenIn)
  const buyToken = toWeth(tokenOut)

  const results = await Promise.allSettled(
    UNISWAP_FEE_TIERS.map(async (fee) => {
      const callData = encodeFunctionData({
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{
          tokenIn: sellToken,
          tokenOut: buyToken,
          amountIn,
          fee,
          sqrtPriceLimitX96,
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
            { to: contracts.quoterV2, data: callData },
            'latest',
          ],
        }),
      })
      if (!res.ok) throw new Error(`RPC request failed: ${res.status}`)
      const json = await res.json()
      if (json.error) throw new Error(json.error.message || 'Quote reverted')

      const decoded = decodeFunctionResult({
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        data: json.result,
      })

      return {
        fee: fee as number,
        amountOut: (decoded[0] as bigint).toString(),
        gasEstimate: Number(decoded[3]),
        ticksCrossed: Number(decoded[2]),
        ok: true,
      } satisfies FeeTierCandidate
    })
  )

  const candidates: FeeTierCandidate[] = UNISWAP_FEE_TIERS.map((fee, i) => {
    const r = results[i]
    if (r.status === 'fulfilled') return r.value
    return {
      fee: fee as number,
      amountOut: '0',
      gasEstimate: 0,
      ticksCrossed: 0,
      ok: false,
      error: r.reason?.message || 'Reverted',
    }
  })

  const valid = candidates.filter(c => c.ok && BigInt(c.amountOut) > 0n)

  if (valid.length === 0) {
    throw new Error('Uniswap V3: no pool found for this pair')
  }

  valid.sort((a, b) => {
    const diffOut = BigInt(b.amountOut) - BigInt(a.amountOut)
    if (diffOut !== 0n) return diffOut > 0n ? 1 : -1
    return a.gasEstimate - b.gasEstimate
  })

  const reason: FeeTierDetection['reason'] =
    valid.length === 1 ? 'single_pool' :
    BigInt(valid[0].amountOut) === BigInt(valid[1].amountOut) ? 'best_net_output' :
    'best_output'

  const bestFee = valid[0].fee

  setCachedFeeTier(tokenIn, tokenOut, bestFee)

  return { bestFee, candidates, reason }
}

// ── Quote ───────────────────────────────────────────────

async function fetchUniswapV3Quote(
  src: string, dst: string, amount: string,
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<NormalizedQuote> {
  const netAmount = BigInt(amount)

  const detection = await detectUniswapV3FeeTier({
    tokenIn: src,
    tokenOut: dst,
    amountIn: netAmount,
    chainId,
  })

  const best = detection.candidates.find(c => c.fee === detection.bestFee && c.ok)!
  const feeLabel = `${detection.bestFee / 10000}%`

  return {
    source: 'uniswapv3',
    toAmount: best.amountOut,
    estimatedGas: best.gasEstimate,
    gasUsd: 0,
    routes: [`Uniswap V3 Direct (${feeLabel} pool)`],
    meta: {
      uniswapV3Fee: detection.bestFee,
      uniswapV3Candidates: detection.candidates,
      uniswapV3Reason: detection.reason,
    },
  }
}

// ── Swap ────────────────────────────────────────────────

async function fetchUniswapV3Swap(
  src: string, dst: string, amount: string, from: string, slippage: number,
  cachedFee?: number,
  // [P101] Output destination — defaults to sender when not provided.
  recipient?: string,
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<NormalizedQuote> {
  const netAmount = BigInt(amount)

  // [SPRINT-9C] Resolve the per-chain SwapRouter02 for the tx target. No V3 on
  // this chain → no swap (mirrors the quote-path guard).
  const contracts = getUniswapV3Contracts(chainId)
  if (!contracts) throw new Error(`Uniswap V3: not deployed on chain ${chainId}`)

  let feeTier = cachedFee ?? getCachedFeeTier(src, dst)
  let amountOut: bigint
  let gasEstimate: number

  if (feeTier != null) {
    try {
      const detection = await detectUniswapV3FeeTier({
        tokenIn: src, tokenOut: dst, amountIn: netAmount, chainId,
      })
      const best = detection.candidates.find(c => c.fee === detection.bestFee && c.ok)!
      feeTier = detection.bestFee
      amountOut = BigInt(best.amountOut)
      gasEstimate = best.gasEstimate
    } catch {
      invalidateCachedFeeTier(src, dst)
      throw new Error('Uniswap V3: cached fee tier failed, retry needed')
    }
  } else {
    const detection = await detectUniswapV3FeeTier({
      tokenIn: src, tokenOut: dst, amountIn: netAmount, chainId,
    })
    const best = detection.candidates.find(c => c.fee === detection.bestFee && c.ok)!
    feeTier = detection.bestFee
    amountOut = BigInt(best.amountOut)
    gasEstimate = best.gasEstimate
  }

  const slippageFactor = BigInt(Math.round((1 - clampSlippage(slippage) / 100) * 10000))
  const amountOutMin = amountOut * slippageFactor / 10000n

  const sellToken = toWeth(src)
  const buyToken = toWeth(dst)
  const isNativeIn = isNativeEth(src)

  const swapCalldata = encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: sellToken,
      tokenOut: buyToken,
      fee: feeTier,
      // [P101] SwapRouter02.recipient — defaults to sender. The router sends
      // `tokenOut` to this address; downstream FeeCollector calldata wrapping
      // (in /v1/swap) does NOT override this for non-CoW sources.
      recipient: (recipient ?? from) as Address,
      amountIn: netAmount,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0n,
    }],
  })

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
  const multicallData = encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: 'multicall',
    args: [deadline, [swapCalldata]],
  })

  const feeLabel = `${feeTier / 10000}%`

  return {
    source: 'uniswapv3',
    toAmount: amountOut.toString(),
    estimatedGas: gasEstimate,
    gasUsd: 0,
    routes: [`Uniswap V3 Direct (${feeLabel} pool)`],
    meta: { uniswapV3Fee: feeTier },
    tx: {
      to: contracts.swapRouter02,
      data: multicallData,
      value: isNativeIn ? netAmount.toString() : '0',
      gas: gasEstimate + 50_000,
    },
  }
}

// ── Adapter interface ───────────────────────────────────

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  return fetchUniswapV3Quote(params.src, params.dst, params.amount, params.chainId ?? DEFAULT_CHAIN_ID)
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  // [11-L-03] Narrow on the QuoteMeta discriminator before reading uniswapV3Fee.
  // The `typeof` check is needed because GenericQuoteMeta's index signature
  // returns `unknown` even after the source narrowing.
  const meta = params.quoteMeta
  const cachedFee = meta?.source === 'uniswapv3' && typeof meta.uniswapV3Fee === 'number'
    ? meta.uniswapV3Fee
    : undefined
  return fetchUniswapV3Swap(
    params.src, params.dst, params.amount, params.from, params.slippage,
    cachedFee,
    params.recipient,
    params.chainId ?? DEFAULT_CHAIN_ID,
  )
}

const adapter: DEXAdapter = {
  name: 'uniswapv3' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
