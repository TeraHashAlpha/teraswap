import {
  CHAIN_ID,
  FEE_RECIPIENT,
  WETH_ADDRESS,
  NATIVE_ETH,
  getCowApiBase,
} from '@/lib/constants'
import { clampSlippage } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

/**
 * CoW Protocol works differently from other aggregators:
 * - Quote: standard price/fee estimation
 * - Swap: user signs an off-chain order -> solvers compete to fill it
 * - The user does NOT submit an on-chain tx; the solver does
 * - Execution takes ~30s (batch auction interval)
 */
async function fetchCowSwapQuote(
  src: string, dst: string, amount: string,
  chainId: number = CHAIN_ID,
): Promise<NormalizedQuote> {
  const base = getCowApiBase(chainId)
  const sellToken = src.toLowerCase() === NATIVE_ETH.toLowerCase() ? WETH_ADDRESS : src
  const buyToken = dst.toLowerCase() === NATIVE_ETH.toLowerCase() ? WETH_ADDRESS : dst

  const appData = JSON.stringify({ version: '1.1.0', appCode: 'TeraSwap', metadata: {} })

  const res = await fetch(`${base}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sellToken,
      buyToken,
      sellAmountBeforeFee: amount,
      kind: 'sell',
      from: FEE_RECIPIENT,
      appData,
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
      signingScheme: 'eip712',
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const desc = err.description || err.errorType || 'quote failed'
    if (desc.includes('SellAmountDoesNotCoverFee') || desc.includes('NoLiquidity')) {
      throw new Error(`CoW: Amount too small or no liquidity for this pair`)
    }
    throw new Error(`CoW ${res.status}: ${desc}`)
  }
  const data = await res.json()
  const quote = data.quote

  return {
    source: 'cowswap',
    toAmount: quote.buyAmount,
    estimatedGas: 0,
    gasUsd: 0,
    routes: ['CoW Protocol (MEV Protected)'],
  }
}

/**
 * CoW "swap" returns the order parameters for the user to sign.
 * The actual execution is handled by useSwap which detects CoW
 * and uses EIP-712 signing instead of sendTransaction.
 */
async function fetchCowSwapOrder(
  src: string, dst: string, amount: string, from: string, slippage: number,
  chainId: number = CHAIN_ID,
): Promise<NormalizedQuote> {
  const base = getCowApiBase(chainId)
  const sellToken = src.toLowerCase() === NATIVE_ETH.toLowerCase() ? WETH_ADDRESS : src
  const buyToken = dst.toLowerCase() === NATIVE_ETH.toLowerCase() ? WETH_ADDRESS : dst

  const appData = JSON.stringify({
    version: '1.1.0',
    appCode: 'TeraSwap',
    metadata: { referrer: { address: FEE_RECIPIENT, version: '1.0.0' } },
  })
  const quoteRes = await fetch(`${base}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sellToken,
      buyToken,
      sellAmountBeforeFee: amount,
      kind: 'sell',
      from,
      receiver: from,
      appData,
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
      signingScheme: 'eip712',
    }),
  })
  if (!quoteRes.ok) {
    const err = await quoteRes.json().catch(() => ({}))
    throw new Error(`CoW quote ${quoteRes.status}: ${err.description || 'failed'}`)
  }
  const quoteData = await quoteRes.json()
  const quote = quoteData.quote

  const buyAmountBig = BigInt(quote.buyAmount)
  const slippageFactor = BigInt(Math.round((1 - clampSlippage(slippage) / 100) * 10000))
  const minBuyAmount = (buyAmountBig * slippageFactor / 10000n).toString()

  return {
    source: 'cowswap',
    toAmount: quote.buyAmount,
    estimatedGas: 0,
    gasUsd: 0,
    routes: ['CoW Protocol (MEV Protected)'],
    cowOrderParams: {
      ...quote,
      buyAmount: minBuyAmount,
      from,
      quoteId: quoteData.id,
      signingScheme: 'eip712',
    },
  }
}

/**
 * Submit a signed CoW order to the CoW Protocol orderbook.
 */
export async function submitCowOrder(
  orderParams: any,
  signature: string,
  chainId: number = CHAIN_ID,
): Promise<string> {
  const base = getCowApiBase(chainId)

  const res = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sellToken: orderParams.sellToken,
      buyToken: orderParams.buyToken,
      sellAmount: orderParams.sellAmount,
      buyAmount: orderParams.buyAmount,
      validTo: orderParams.validTo,
      appData: orderParams.appData,
      appDataHash: orderParams.appDataHash,
      feeAmount: orderParams.feeAmount,
      kind: orderParams.kind,
      partiallyFillable: orderParams.partiallyFillable,
      receiver: orderParams.receiver || orderParams.from,
      sellTokenBalance: orderParams.sellTokenBalance,
      buyTokenBalance: orderParams.buyTokenBalance,
      signingScheme: 'eip712',
      signature,
      from: orderParams.from,
      quoteId: orderParams.quoteId,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`CoW order submit ${res.status}: ${err.description || 'failed'}`)
  }
  const orderUid = await res.json()
  return orderUid
}

/**
 * Poll CoW order status until filled or expired.
 */
export async function pollCowOrderStatus(
  orderUid: string,
  maxWaitMs: number = 120_000,
  chainId: number = CHAIN_ID,
): Promise<{ status: 'fulfilled' | 'expired' | 'cancelled'; txHash?: string }> {
  const base = getCowApiBase(chainId)
  const start = Date.now()
  const pollInterval = 3000

  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${base}/orders/${orderUid}`)
    if (res.ok) {
      const order = await res.json()
      if (order.status === 'fulfilled') {
        const tradesRes = await fetch(`${base}/trades?orderUid=${orderUid}`)
        const trades = tradesRes.ok ? await tradesRes.json() : []
        return {
          status: 'fulfilled',
          txHash: trades[0]?.txHash,
        }
      }
      if (order.status === 'cancelled' || order.status === 'expired') {
        return { status: order.status }
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval))
  }
  return { status: 'expired' }
}

// Adapter: fetchQuote uses fetchCowSwapQuote, fetchSwapData uses fetchCowSwapOrder
async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  return fetchCowSwapQuote(params.src, params.dst, params.amount)
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  return fetchCowSwapOrder(
    params.src, params.dst, params.amount, params.from, params.slippage,
    params.chainId,
  )
}

const adapter: DEXAdapter = {
  name: 'cowswap' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
