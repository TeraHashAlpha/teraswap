import { encodeFunctionData, decodeFunctionResult, type Address } from 'viem'
import { clampSlippage, isNativeEth, getRpcUrl } from './shared'
import { DEFAULT_CHAIN_ID } from '@/lib/chains/registry'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

// CurveRouterNG on Ethereum mainnet
export const CURVE_ROUTER_NG = '0x16C6521Dff6baB339122a0FE25a9116693265353' as const

// ABI fragment for CurveRouterNG
export const CURVE_ROUTER_ABI = [
  {
    name: 'get_dy',
    inputs: [
      { name: '_route', type: 'address[11]' },
      { name: '_swap_params', type: 'uint256[5][5]' },
      { name: '_amount', type: 'uint256' },
      { name: '_pools', type: 'address[5]' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    name: 'exchange',
    inputs: [
      { name: '_route', type: 'address[11]' },
      { name: '_swap_params', type: 'uint256[5][5]' },
      { name: '_amount', type: 'uint256' },
      { name: '_expected', type: 'uint256' },
      { name: '_pools', type: 'address[5]' },
      { name: '_receiver', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function',
  },
] as const

// Common Curve pools for major pairs (Ethereum mainnet).
//
// `poolType` is CurveRouterNG's required pool-ABI selector — `_swap_params[..][3]`
// (1 = legacy stable, 10 = stable-ng, 2/3 = crypto/tricrypto-ng, 20/30 = crypto-ng,
// 4 = llamma). It is NOT derived from the pool family name: every value below was
// proven with a live `eth_call` per pool, both swap directions, against the real
// CurveRouterNG (see scripts/verify-curve-pool-types.mjs — run its output is
// reproduced in this branch's PR feedback). A pool whose poolType could not be
// proven on-chain is excluded below rather than defaulted.
export const CURVE_POOLS: Record<string, {
  pool: `0x${string}`
  coins: `0x${string}`[]
  swapType: number
  poolType: number
}> = {
  '3pool': {
    pool: '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
    coins: [
      '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
      '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    ],
    swapType: 1,
    poolType: 1, // proven: legacy stable — get_dy succeeds both directions, DAI<->USDC
  },
  steth: {
    pool: '0xDC24316b9AE028F1497c275EB9192a3Ea0f67022',
    coins: [
      '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', // ETH
      '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', // stETH
    ],
    swapType: 1,
    poolType: 1, // proven: legacy stable — get_dy succeeds both directions, ETH<->stETH
  },
  fraxusdc: {
    pool: '0xDcEF968d416a41Cdac0ED8702fAC8128A64241A2',
    coins: [
      '0x853d955acef822db058eb8505911ed77f175b99e', // FRAX
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    ],
    swapType: 1,
    poolType: 1, // proven: legacy stable — get_dy succeeds both directions, FRAX<->USDC
  },
  // ── Excluded from routing — poolType could not be proven on-chain ──
  //
  // tricrypto2 (0xD51a44d3FaE010294C616388b506AcdA1bfAAE46): every poolType
  // candidate reverts get_dy with this pool's configured swapType=3. Debugging
  // showed swapType=1 succeeds (amountOut matches a direct pool call) regardless
  // of poolType — i.e. `swapType`, not `poolType`, is wrong for this pool. Fixing
  // swapType is outside this fix's scope (poolType/_swap_params[..][3] only, per
  // the task). Flagged in this branch's PR feedback as a separate pre-existing bug.
  //
  // crvusdusdc (0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E) / crvusdusdt
  // (0x390f3595bCa2Df7d23783dFd126427CCeb997BF4): this file's declared `coins`
  // order ([crvUSD, USDC]) does NOT match the pool's on-chain coins() order
  // ([USDC, crvUSD]) — confirmed via coins(0)/coins(1) — a pre-existing bug
  // independent of poolType. Because `findCurvePool` derives i/j from the
  // (wrong) declared order, any get_dy result through the router is not trustworthy
  // proof of a correct poolType. Flagged in this branch's PR feedback; left out
  // until the coin order is fixed.
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as `0x${string}`

function findCurvePool(tokenIn: string, tokenOut: string): {
  poolName: string
  pool: `0x${string}`
  i: number
  j: number
  swapType: number
  poolType: number
} | null {
  const inLower = tokenIn.toLowerCase()
  const outLower = tokenOut.toLowerCase()

  for (const [name, info] of Object.entries(CURVE_POOLS)) {
    const iIdx = info.coins.findIndex(c => c.toLowerCase() === inLower)
    const jIdx = info.coins.findIndex(c => c.toLowerCase() === outLower)
    if (iIdx >= 0 && jIdx >= 0 && iIdx !== jIdx) {
      return {
        poolName: name, pool: info.pool, i: iIdx, j: jIdx,
        swapType: info.swapType, poolType: info.poolType,
      }
    }
  }
  return null
}

// Fixed-length tuple types for CurveRouterNG
type CurveRoute = readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`]
type CurveSwapParam = readonly [bigint, bigint, bigint, bigint, bigint]
type CurveSwapParams = readonly [CurveSwapParam, CurveSwapParam, CurveSwapParam, CurveSwapParam, CurveSwapParam]
type CurvePools = readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`]

export function buildCurveRoute(
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  pool: `0x${string}`,
  i: number,
  j: number,
  swapType: number,
  poolType: number,
): {
  route: CurveRoute
  swapParams: CurveSwapParams
  pools: CurvePools
} {
  const Z = ZERO_ADDR

  const route: CurveRoute = [tokenIn, pool, tokenOut, Z, Z, Z, Z, Z, Z, Z, Z]

  const zeroRow: CurveSwapParam = [0n, 0n, 0n, 0n, 0n]
  const swapParams: CurveSwapParams = [
    [BigInt(i), BigInt(j), BigInt(swapType), BigInt(poolType), 0n],
    zeroRow, zeroRow, zeroRow, zeroRow,
  ]

  const pools: CurvePools = [pool, Z, Z, Z, Z]

  return { route, swapParams, pools }
}

async function fetchCurveQuote(
  src: string, dst: string, amount: string,
): Promise<NormalizedQuote> {
  const netAmount = BigInt(amount)

  const tokenIn = src.toLowerCase()
  const tokenOut = dst.toLowerCase()

  const poolInfo = findCurvePool(tokenIn, tokenOut)
  if (!poolInfo) throw new Error('Curve: no pool found for this pair')

  const { poolName, pool, i, j, swapType, poolType } = poolInfo
  const { route, swapParams, pools } = buildCurveRoute(
    tokenIn as `0x${string}`,
    tokenOut as `0x${string}`,
    pool, i, j, swapType, poolType,
  )

  const callData = encodeFunctionData({
    abi: CURVE_ROUTER_ABI,
    functionName: 'get_dy',
    args: [route, swapParams, netAmount, pools],
  })

  const rpcUrl = getRpcUrl()
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: CURVE_ROUTER_NG, data: callData }, 'latest'],
    }),
  })
  if (!res.ok) throw new Error(`RPC request failed: ${res.status}`)
  const json = await res.json()
  if (json.error) throw new Error(json.error.message || 'Curve: get_dy reverted')
  if (!json.result || json.result === '0x') throw new Error('Curve: empty result from get_dy')

  const decoded = decodeFunctionResult({
    abi: CURVE_ROUTER_ABI,
    functionName: 'get_dy',
    data: json.result,
  })

  const amountOut = (decoded as bigint).toString()
  if (amountOut === '0') throw new Error('Curve: zero output')

  const poolLabel = poolName.charAt(0).toUpperCase() + poolName.slice(1)

  return {
    source: 'curve',
    toAmount: amountOut,
    estimatedGas: 200_000,
    gasUsd: 0,
    routes: [`Curve ${poolLabel} Pool`],
  }
}

async function fetchCurveSwap(
  src: string, dst: string, amount: string, from: string, slippage: number,
  // [P101] Output destination; defaults to `from` when not provided.
  recipient?: string,
): Promise<NormalizedQuote> {
  const netAmount = BigInt(amount)

  const tokenIn = src.toLowerCase()
  const tokenOut = dst.toLowerCase()

  const poolInfo = findCurvePool(tokenIn, tokenOut)
  if (!poolInfo) throw new Error('Curve: no pool found for this pair')

  const { poolName, pool, i, j, swapType, poolType } = poolInfo
  const { route, swapParams, pools } = buildCurveRoute(
    tokenIn as `0x${string}`,
    tokenOut as `0x${string}`,
    pool, i, j, swapType, poolType,
  )

  // Step 1: get expected output
  const dyCallData = encodeFunctionData({
    abi: CURVE_ROUTER_ABI,
    functionName: 'get_dy',
    args: [route, swapParams, netAmount, pools],
  })

  const rpcUrl = getRpcUrl()
  const dyRes = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: CURVE_ROUTER_NG, data: dyCallData }, 'latest'],
    }),
  })
  const dyJson = await dyRes.json()
  if (dyJson.error) throw new Error(dyJson.error.message || 'Curve: get_dy failed')

  const amountOut = decodeFunctionResult({
    abi: CURVE_ROUTER_ABI,
    functionName: 'get_dy',
    data: dyJson.result,
  }) as bigint

  if (amountOut === 0n) throw new Error('Curve: zero output')

  // Step 2: calculate minimum output with slippage
  const slippageFactor = BigInt(Math.round((1 - clampSlippage(slippage) / 100) * 10000))
  const amountOutMin = amountOut * slippageFactor / 10000n

  // Step 3: build exchange calldata
  const exchangeCallData = encodeFunctionData({
    abi: CURVE_ROUTER_ABI,
    functionName: 'exchange',
    args: [
      route,
      swapParams,
      netAmount,
      amountOutMin,
      pools,
      // [P101] _receiver — the contract sends `dst` here. Defaults to sender.
      (recipient ?? from) as Address,
    ],
  })

  const isNativeIn = isNativeEth(src)
  const poolLabel = poolName.charAt(0).toUpperCase() + poolName.slice(1)

  return {
    source: 'curve',
    toAmount: amountOut.toString(),
    estimatedGas: 250_000,
    gasUsd: 0,
    routes: [`Curve ${poolLabel} Pool`],
    tx: {
      to: CURVE_ROUTER_NG as `0x${string}`,
      data: exchangeCallData,
      value: isNativeIn ? netAmount.toString() : '0',
      gas: 300_000,
    },
  }
}

// ── Adapter interface ───────────────────────────────────

// [SPRINT-9C] The pools + CurveRouterNG above are MAINNET-ONLY (mainnet addresses
// hardcoded). Off mainnet, skip cleanly (return null) and issue ZERO RPC calls —
// never quote a mainnet Curve pool over a mainnet RPC for an L2 request (that was
// the "mainnet-priced quote on Base" class of bug this sprint fixes).
// TODO(future sprint): add Base Curve pools + CurveRouterNG (Basescan: "Curve.fi:
// Router" 0x4f37A9d177470499A2dD084621020b023fcffc1F) to support curve on Base.
// TODO(future sprint): add Arbitrum Curve pools + CurveRouterNG — router address
// 0xf0d4C12e3C5589b1de35eaF85B163Cc23827e854 (docs/Reports/ARBITRUM-READINESS.md,
// registered inert in chains/routers.ts by SPRINT-46-ARBITRUM-CONFIG). This
// mainnet-only check already fail-closes 42161 with zero code change.
async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  if ((params.chainId ?? DEFAULT_CHAIN_ID) !== DEFAULT_CHAIN_ID) return null
  return fetchCurveQuote(params.src, params.dst, params.amount)
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  if ((params.chainId ?? DEFAULT_CHAIN_ID) !== DEFAULT_CHAIN_ID) return null
  return fetchCurveSwap(
    params.src, params.dst, params.amount, params.from, params.slippage,
    params.recipient,
  )
}

const adapter: DEXAdapter = {
  name: 'curve' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
