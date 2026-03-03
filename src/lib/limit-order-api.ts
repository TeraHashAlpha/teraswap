/**
 * TeraSwap — Limit Order API
 *
 * Interacts with CoW Protocol's orderbook API to create, poll, and cancel
 * limit orders. Uses the same GPv2Order struct as regular swaps but with
 * partiallyFillable=true and user-defined buyAmount for price targets.
 */

import { AGGREGATOR_APIS, NATIVE_ETH, WETH_ADDRESS, FEE_RECIPIENT } from './constants'
import type { LimitOrderConfig } from './limit-order-types'

const COW_BASE = AGGREGATOR_APIS.cowswap.base

// ── Helper: resolve ETH → WETH ──────────────────────────────
function resolveToken(addr: string): string {
  return addr.toLowerCase() === NATIVE_ETH.toLowerCase() ? WETH_ADDRESS : addr
}

// ── Compute buyAmount from sellAmount + targetPrice ─────────
export function computeBuyAmount(
  sellAmount: string,
  targetPrice: number,
  sellDecimals: number,
  buyDecimals: number,
): string {
  // targetPrice = how many tokenOut per 1 tokenIn
  // buyAmount = sellAmount * targetPrice * (10^buyDecimals / 10^sellDecimals)
  const sellBig = BigInt(sellAmount)
  const priceScaled = BigInt(Math.round(targetPrice * 1e18))
  const buyRaw = sellBig * priceScaled / BigInt(1e18)
  // Adjust decimals: buyRaw is in sellDecimals scale, convert to buyDecimals
  const decimalDiff = buyDecimals - sellDecimals
  if (decimalDiff > 0) {
    return (buyRaw * BigInt(10 ** decimalDiff)).toString()
  } else if (decimalDiff < 0) {
    return (buyRaw / BigInt(10 ** Math.abs(decimalDiff))).toString()
  }
  return buyRaw.toString()
}

// ── Get current market price from CoW quote ──────────────────
export async function fetchCurrentPrice(
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  sellDecimals: number,
  buyDecimals: number,
): Promise<number> {
  const src = resolveToken(sellToken)
  const dst = resolveToken(buyToken)

  const res = await fetch(`${COW_BASE}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sellToken: src,
      buyToken: dst,
      sellAmountBeforeFee: sellAmount,
      kind: 'sell',
      from: '0x0000000000000000000000000000000000000000',
      receiver: '0x0000000000000000000000000000000000000000',
      appData: JSON.stringify({ appCode: 'TeraSwap', metadata: {} }),
      appDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
      signingScheme: 'eip712',
    }),
  })

  if (!res.ok) return 0

  const data = await res.json()
  const buyAmount = data.quote?.buyAmount
  if (!buyAmount) return 0

  // price = buyAmount / sellAmount (normalized by decimals)
  const sellNorm = Number(BigInt(sellAmount)) / (10 ** sellDecimals)
  const buyNorm = Number(BigInt(buyAmount)) / (10 ** buyDecimals)
  return sellNorm > 0 ? buyNorm / sellNorm : 0
}

// ── Build order params for EIP-712 signing ───────────────────
export function buildLimitOrderParams(
  config: LimitOrderConfig,
  from: string,
): {
  sellToken: string
  buyToken: string
  receiver: string
  sellAmount: string
  buyAmount: string
  validTo: number
  appData: string
  appDataHash: string
  feeAmount: string
  kind: string
  partiallyFillable: boolean
  sellTokenBalance: string
  buyTokenBalance: string
  from: string
  signingScheme: string
} {
  const sellToken = resolveToken(config.tokenIn.address)
  const buyToken = resolveToken(config.tokenOut.address)

  const buyAmount = computeBuyAmount(
    config.sellAmount,
    config.targetPrice,
    config.tokenIn.decimals,
    config.tokenOut.decimals,
  )

  const validTo = Math.floor(Date.now() / 1000) + config.expirySeconds

  return {
    sellToken,
    buyToken,
    receiver: from,
    sellAmount: config.sellAmount,
    buyAmount,
    validTo,
    appData: JSON.stringify({
      appCode: 'TeraSwap',
      metadata: {
        referrer: { address: FEE_RECIPIENT, version: '1.0.0' },
        orderClass: { orderClass: 'limit' },
      },
    }),
    appDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    feeAmount: '0', // Limit orders on CoW have zero fees
    kind: config.kind,
    partiallyFillable: config.partiallyFillable,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    from,
    signingScheme: 'eip712',
  }
}

// ── Submit signed limit order to CoW orderbook ───────────────
export async function submitLimitOrder(
  orderParams: ReturnType<typeof buildLimitOrderParams>,
  signature: string,
): Promise<string> {
  const res = await fetch(`${COW_BASE}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      ...orderParams,
      signingScheme: 'eip712',
      signature,
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`CoW limit order ${res.status}: ${err.description || 'submission failed'}`)
  }

  return await res.json() // returns orderUid string
}

// ── Poll limit order status ──────────────────────────────────
export async function fetchLimitOrderStatus(
  orderUid: string,
): Promise<{
  status: 'open' | 'fulfilled' | 'expired' | 'cancelled' | 'presignaturePending'
  executedBuyAmount: string
  executedSellAmount: string
  txHash?: string
  filledPercent: number
}> {
  const res = await fetch(`${COW_BASE}/orders/${orderUid}`)

  if (!res.ok) {
    throw new Error(`Failed to fetch order status: ${res.status}`)
  }

  const order = await res.json()

  // Calculate fill percentage
  const totalSell = BigInt(order.sellAmount || '0')
  const executedSell = BigInt(order.executedSellAmount || '0')
  const filledPercent = totalSell > 0n
    ? Number((executedSell * 100n) / totalSell)
    : 0

  let txHash: string | undefined
  if (order.status === 'fulfilled') {
    // Fetch settlement tx
    const tradesRes = await fetch(`${COW_BASE}/trades?orderUid=${orderUid}`)
    if (tradesRes.ok) {
      const trades = await tradesRes.json()
      txHash = trades[0]?.txHash
    }
  }

  return {
    status: order.status,
    executedBuyAmount: order.executedBuyAmount || '0',
    executedSellAmount: order.executedSellAmount || '0',
    txHash,
    filledPercent,
  }
}

// ── Cancel a limit order ─────────────────────────────────────
export async function cancelLimitOrder(
  orderUid: string,
  signature: string,
): Promise<void> {
  const res = await fetch(`${COW_BASE}/orders/${orderUid}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      signature,
      signingScheme: 'eip712',
      orderUids: [orderUid],
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Cancel failed ${res.status}: ${err.description || 'unknown'}`)
  }
}
