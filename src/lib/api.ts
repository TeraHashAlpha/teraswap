import { encodeFunctionData, decodeFunctionResult, type Address } from 'viem'
import {
  AGGREGATOR_APIS,
  FEE_PERCENT,
  FEE_RECIPIENT,
  DEFAULT_SLIPPAGE,
  QUOTE_TIMEOUT_MS,
  CHAIN_ID,
  PERMIT2_ADDRESS,
  COW_VAULT_RELAYER,
  COW_SETTLEMENT,
  ODOS_ROUTER_V3,
  UNISWAP_SWAP_ROUTER_02,
  UNISWAP_QUOTER_V2,
  UNISWAP_FEE_TIERS,
  WETH_ADDRESS,
  NATIVE_ETH,
  type AggregatorName,
} from './constants'
import { globalLimiter } from './rate-limiter'

// ── Slippage safety clamp ────────────────────────────────
// Ensures slippage % is always in the safe range [0.01, 49.99]
// Prevents negative slippage factors when slippage >= 100
function clampSlippage(s: number): number {
  return Math.min(Math.max(s, 0.01), 49.99)
}

// ── Normalized types (common across all aggregators) ─────

/** Individual fee tier candidate from Uniswap V3 auto-detection */
export interface FeeTierCandidate {
  fee: number
  amountOut: string         // raw bigint string
  gasEstimate: number
  ticksCrossed: number
  ok: boolean
  error?: string
}

/** Result of auto fee tier detection */
export interface FeeTierDetection {
  bestFee: number
  candidates: FeeTierCandidate[]
  reason: 'best_output' | 'best_net_output' | 'single_pool'
}

export interface NormalizedQuote {
  source: AggregatorName
  toAmount: string          // raw bigint string
  estimatedGas: number
  gasUsd: number            // estimated gas in USD (for net comparison)
  routes: string[]          // human-readable route names
  tx?: {
    to: `0x${string}`
    data: `0x${string}`
    value: string
    gas: number
  }
  /** CoW Protocol: order UID returned after submission (intent-based) */
  cowOrderUid?: string
  /** Extra metadata per source (e.g. Uniswap V3 fee tier info) */
  meta?: {
    uniswapV3Fee?: number
    uniswapV3Candidates?: FeeTierCandidate[]
    uniswapV3Reason?: string
  }
}

export interface MetaQuoteResult {
  best: NormalizedQuote
  all: NormalizedQuote[]     // sorted by netOutput desc
  fetchedAt: number          // timestamp
}

// ── Timeout wrapper ──────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), ms),
    ),
  ])
}

// ── User-friendly error mapping ─────────────────────────
function friendlyError(source: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()

  // Network-level
  if (lower.includes('failed to fetch') || lower.includes('networkerror'))
    return `${source}: Network error — check your connection.`
  if (lower.includes('timeout'))
    return `${source}: Request timed out. Try again.`

  // HTTP codes
  if (lower.includes('429') || lower.includes('rate limit'))
    return `${source}: Rate limited. Wait a moment and retry.`
  if (lower.includes('403') || lower.includes('forbidden'))
    return `${source}: Access denied — API key may be invalid.`
  if (lower.includes('insufficient') && lower.includes('liquidity'))
    return `${source}: Insufficient liquidity for this pair/amount.`
  if (lower.includes('no route') || lower.includes('no pool'))
    return `${source}: No route found for this pair.`

  // Fallback: first 80 chars
  return `${source}: ${msg.slice(0, 80)}`
}

// ══════════════════════════════════════════════════════════
//  1INCH ADAPTER
// ══════════════════════════════════════════════════════════
async function fetch1inchQuote(
  src: string, dst: string, amount: string,
): Promise<NormalizedQuote> {
  const { base, key } = AGGREGATOR_APIS['1inch']
  if (!key) throw new Error('1inch API key not configured')
  const params = new URLSearchParams({
    src, dst, amount,
    fee: FEE_PERCENT.toString(),
    includeProtocols: 'true',
  })
  const res = await fetch(`${base}/quote?${params}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`1inch ${res.status}`)
  const data = await res.json()

  return {
    source: '1inch',
    toAmount: data.toAmount,
    estimatedGas: Number(data.estimatedGas || 0),
    gasUsd: 0, // calculated by orchestrator
    routes: data.protocols?.flat(2)?.map((p: any) => p.name) ?? [],
  }
}

async function fetch1inchSwap(
  src: string, dst: string, amount: string, from: string, slippage: number,
): Promise<NormalizedQuote> {
  const { base, key } = AGGREGATOR_APIS['1inch']
  if (!key) throw new Error('1inch API key not configured')
  const params = new URLSearchParams({
    src, dst, amount, from,
    slippage: slippage.toString(),
    fee: FEE_PERCENT.toString(),
    referrerAddress: FEE_RECIPIENT,
    includeProtocols: 'true',
    disableEstimate: 'false',
    allowPartialFill: 'false',
  })
  const res = await fetch(`${base}/swap?${params}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`1inch swap ${res.status}`)
  const data = await res.json()

  return {
    source: '1inch',
    toAmount: data.toAmount,
    estimatedGas: Number(data.tx?.gas || data.estimatedGas || 0),
    gasUsd: 0,
    routes: data.protocols?.flat(2)?.map((p: any) => p.name) ?? [],
    tx: {
      to: data.tx.to,
      data: data.tx.data,
      value: data.tx.value || '0',
      gas: Number(data.tx.gas || 0),
    },
  }
}

// ══════════════════════════════════════════════════════════
//  0x ADAPTER
// ══════════════════════════════════════════════════════════
async function fetch0xQuote(
  src: string, dst: string, amount: string,
): Promise<NormalizedQuote> {
  const { base, key } = AGGREGATOR_APIS['0x']
  const params = new URLSearchParams({
    sellToken: src,
    buyToken: dst,
    sellAmount: amount,
  })
  const res = await fetch(`${base}/swap/permit2/quote?${params}`, {
    headers: {
      '0x-api-key': key,
      '0x-version': 'v2',
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`0x ${res.status}`)
  const data = await res.json()

  return {
    source: '0x',
    toAmount: data.buyAmount,
    estimatedGas: Number(data.transaction?.gas || data.gas || 0),
    gasUsd: 0,
    routes: data.route?.fills?.map((f: any) => f.source) ?? [],
  }
}

async function fetch0xSwap(
  src: string, dst: string, amount: string, from: string, slippage: number,
): Promise<NormalizedQuote> {
  const { base, key } = AGGREGATOR_APIS['0x']
  const params = new URLSearchParams({
    sellToken: src,
    buyToken: dst,
    sellAmount: amount,
    taker: from,
    slippageBps: Math.round(clampSlippage(slippage) * 100).toString(), // v2 usa bps
  })
  const res = await fetch(`${base}/swap/permit2/quote?${params}`, {
    headers: {
      '0x-api-key': key,
      '0x-version': 'v2',
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`0x swap ${res.status}`)
  const data = await res.json()

  return {
    source: '0x',
    toAmount: data.buyAmount,
    estimatedGas: Number(data.transaction?.gas || data.gas || 0),
    gasUsd: 0,
    routes: data.route?.fills?.map((f: any) => f.source) ?? [],
    tx: {
      to: data.transaction.to,
      data: data.transaction.data,
      value: data.transaction.value || '0',
      gas: Number(data.transaction.gas || 0),
    },
  }
}

// ══════════════════════════════════════════════════════════
//  VELORA ADAPTER (ex-ParaSwap — API v6.2)
// ══════════════════════════════════════════════════════════
async function fetchVeloraQuote(
  src: string, dst: string, amount: string,
): Promise<NormalizedQuote> {
  const { base } = AGGREGATOR_APIS.velora
  const params = new URLSearchParams({
    srcToken: src,
    destToken: dst,
    amount,
    srcDecimals: '18',
    destDecimals: '18',
    side: 'SELL',
    network: CHAIN_ID.toString(),
    partner: 'teraswap',
    partnerFeeBps: Math.round(FEE_PERCENT * 100).toString(),
    version: '6.2',
  })
  const res = await fetch(`${base}/prices?${params}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Velora ${res.status}`)
  const data = await res.json()
  const best = data.priceRoute

  return {
    source: 'velora',
    toAmount: best.destAmount,
    estimatedGas: Number(best.gasCost || 0),
    gasUsd: Number(best.gasCostUSD || 0),
    routes: best.bestRoute?.flatMap((r: any) =>
      r.swaps?.flatMap((s: any) =>
        s.swapExchanges?.map((e: any) => e.exchange)
      )
    ) ?? [],
  }
}

async function fetchVeloraSwap(
  src: string, dst: string, amount: string, from: string, slippage: number,
  srcDecimals: number, destDecimals: number,
): Promise<NormalizedQuote> {
  const { base } = AGGREGATOR_APIS.velora

  // Step 1: get price route
  const priceParams = new URLSearchParams({
    srcToken: src, destToken: dst, amount,
    srcDecimals: srcDecimals.toString(),
    destDecimals: destDecimals.toString(),
    side: 'SELL',
    network: CHAIN_ID.toString(),
    partner: 'teraswap',
    partnerFeeBps: Math.round(FEE_PERCENT * 100).toString(),
    version: '6.2',
  })
  const priceRes = await fetch(`${base}/prices?${priceParams}`)
  if (!priceRes.ok) throw new Error(`Velora price ${priceRes.status}`)
  const priceData = await priceRes.json()

  // Step 2: build tx
  const txRes = await fetch(`${base}/transactions/${CHAIN_ID}?ignoreChecks=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      srcToken: src,
      destToken: dst,
      srcAmount: amount,
      destAmount: priceData.priceRoute.destAmount,
      slippage: clampSlippage(slippage) * 100, // bps
      priceRoute: priceData.priceRoute,
      userAddress: from,
      partner: 'teraswap',
      partnerAddress: FEE_RECIPIENT,
      partnerFeeBps: Math.round(FEE_PERCENT * 100),
    }),
  })
  if (!txRes.ok) throw new Error(`Velora tx ${txRes.status}`)
  const txData = await txRes.json()

  return {
    source: 'velora',
    toAmount: priceData.priceRoute.destAmount,
    estimatedGas: Number(txData.gas || priceData.priceRoute.gasCost || 0),
    gasUsd: Number(priceData.priceRoute.gasCostUSD || 0),
    routes: priceData.priceRoute.bestRoute?.flatMap((r: any) =>
      r.swaps?.flatMap((s: any) =>
        s.swapExchanges?.map((e: any) => e.exchange)
      )
    ) ?? [],
    tx: {
      to: txData.to,
      data: txData.data,
      value: txData.value || '0',
      gas: Number(txData.gas || 0),
    },
  }
}

// ══════════════════════════════════════════════════════════
//  ODOS ADAPTER (API v3 — Router V3)
//
//  Migrated from /sor/quote/v2 → /sor/quote/v3
//  - Added `simple` (false = full multi-path routing)
//  - Added `disableRFQs` (false = include RFQ liquidity)
//  - Assemble endpoint unchanged: /sor/assemble
//  - Router V3: 0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05
// ══════════════════════════════════════════════════════════
async function fetchOdosQuote(
  src: string, dst: string, amount: string, from?: string,
): Promise<NormalizedQuote> {
  const { base } = AGGREGATOR_APIS.odos
  const res = await fetch(`${base}/sor/quote/v3`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chainId: CHAIN_ID,
      inputTokens: [{ tokenAddress: src, amount }],
      outputTokens: [{ tokenAddress: dst, proportion: 1 }],
      userAddr: from || '0x0000000000000000000000000000000000000000',
      slippageLimitPercent: DEFAULT_SLIPPAGE,
      referralCode: 0,
      compact: true,
      simple: false,       // v3: full multi-path routing
      disableRFQs: false,  // v3: include RFQ liquidity sources
    }),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Odos ${res.status}${errBody ? `: ${errBody.slice(0, 100)}` : ''}`)
  }
  const data = await res.json()

  return {
    source: 'odos',
    toAmount: data.outAmounts?.[0] ?? '0',
    estimatedGas: Number(data.gasEstimate || 0),
    gasUsd: Number(data.gasEstimateValue || 0),
    routes: data.pathViz?.map((p: any) => p.name) ?? ['Odos Smart Router v3'],
  }
}

async function fetchOdosSwap(
  src: string, dst: string, amount: string, from: string, slippage: number,
): Promise<NormalizedQuote> {
  const { base } = AGGREGATOR_APIS.odos

  // Step 1: quote via v3
  const quoteRes = await fetch(`${base}/sor/quote/v3`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chainId: CHAIN_ID,
      inputTokens: [{ tokenAddress: src, amount }],
      outputTokens: [{ tokenAddress: dst, proportion: 1 }],
      userAddr: from,
      slippageLimitPercent: slippage,
      referralCode: 0,
      compact: true,
      simple: false,
      disableRFQs: false,
    }),
  })
  if (!quoteRes.ok) {
    const errBody = await quoteRes.text().catch(() => '')
    throw new Error(`Odos quote ${quoteRes.status}${errBody ? `: ${errBody.slice(0, 100)}` : ''}`)
  }
  const quoteData = await quoteRes.json()

  // Step 2: assemble tx (endpoint unchanged in v3)
  const assembleRes = await fetch(`${base}/sor/assemble`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userAddr: from,
      pathId: quoteData.pathId,
    }),
  })
  if (!assembleRes.ok) {
    const errBody = await assembleRes.text().catch(() => '')
    throw new Error(`Odos assemble ${assembleRes.status}${errBody ? `: ${errBody.slice(0, 100)}` : ''}`)
  }
  const assembleData = await assembleRes.json()

  return {
    source: 'odos',
    toAmount: quoteData.outAmounts?.[0] ?? '0',
    estimatedGas: Number(assembleData.gasEstimate || quoteData.gasEstimate || 0),
    gasUsd: Number(quoteData.gasEstimateValue || 0),
    routes: quoteData.pathViz?.map((p: any) => p.name) ?? ['Odos Smart Router v3'],
    tx: {
      to: assembleData.transaction.to,
      data: assembleData.transaction.data,
      value: assembleData.transaction.value || '0',
      gas: Number(assembleData.transaction.gas || assembleData.gasEstimate || 0),
    },
  }
}

// ══════════════════════════════════════════════════════════
//  KYBERSWAP ADAPTER
// ══════════════════════════════════════════════════════════
async function fetchKyberSwapQuote(
  src: string, dst: string, amount: string,
): Promise<NormalizedQuote> {
  const { base } = AGGREGATOR_APIS.kyberswap
  // KyberSwap uses WETH for native ETH in their API
  const sellToken = src.toLowerCase() === NATIVE_ETH.toLowerCase() ? WETH_ADDRESS : src
  const buyToken = dst.toLowerCase() === NATIVE_ETH.toLowerCase() ? WETH_ADDRESS : dst
  const params = new URLSearchParams({
    tokenIn: sellToken,
    tokenOut: buyToken,
    amountIn: amount,
    saveGas: '0',
    gasInclude: 'true',
    clientData: JSON.stringify({ source: 'TeraSwap' }),
  })
  const res = await fetch(`${base}/api/v1/routes?${params}`, {
    headers: {
      Accept: 'application/json',
      'x-client-id': 'teraswap',
    },
  })
  if (!res.ok) throw new Error(`KyberSwap ${res.status}`)
  const data = await res.json()
  const route = data.data?.routeSummary

  if (!route) throw new Error('KyberSwap: no route found')

  return {
    source: 'kyberswap',
    toAmount: route.amountOut,
    estimatedGas: Number(route.gasUsd ? 0 : route.gas || 0),
    gasUsd: Number(route.gasUsd || 0),
    routes: route.route?.[0]?.map((r: any) =>
      r.pool ? `${r.pool}` : 'KyberSwap'
    ) ?? ['KyberSwap'],
  }
}

async function fetchKyberSwapSwap(
  src: string, dst: string, amount: string, from: string, slippage: number,
): Promise<NormalizedQuote> {
  const { base } = AGGREGATOR_APIS.kyberswap
  const sellToken = src.toLowerCase() === NATIVE_ETH.toLowerCase() ? WETH_ADDRESS : src
  const buyToken = dst.toLowerCase() === NATIVE_ETH.toLowerCase() ? WETH_ADDRESS : dst

  // Step 1: get route
  const routeParams = new URLSearchParams({
    tokenIn: sellToken,
    tokenOut: buyToken,
    amountIn: amount,
    saveGas: '0',
    gasInclude: 'true',
    clientData: JSON.stringify({ source: 'TeraSwap' }),
  })
  const routeRes = await fetch(`${base}/api/v1/routes?${routeParams}`, {
    headers: {
      Accept: 'application/json',
      'x-client-id': 'teraswap',
    },
  })
  if (!routeRes.ok) throw new Error(`KyberSwap route ${routeRes.status}`)
  const routeData = await routeRes.json()
  const routeSummary = routeData.data?.routeSummary

  if (!routeSummary) throw new Error('KyberSwap: no route')

  // Step 2: build tx
  const buildRes = await fetch(`${base}/api/v1/route/build`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-client-id': 'teraswap',
    },
    body: JSON.stringify({
      routeSummary,
      sender: from,
      recipient: from,
      slippageTolerance: Math.round(clampSlippage(slippage) * 100), // bps
      source: 'TeraSwap',
    }),
  })
  if (!buildRes.ok) throw new Error(`KyberSwap build ${buildRes.status}`)
  const buildData = await buildRes.json()
  const txData = buildData.data

  return {
    source: 'kyberswap',
    toAmount: routeSummary.amountOut,
    estimatedGas: Number(txData.gas || routeSummary.gas || 0),
    gasUsd: Number(routeSummary.gasUsd || 0),
    routes: routeSummary.route?.[0]?.map((r: any) =>
      r.pool ? `${r.pool}` : 'KyberSwap'
    ) ?? ['KyberSwap'],
    tx: {
      to: txData.routerAddress,
      data: txData.data,
      value: txData.value || '0',
      gas: Number(txData.gas || 0),
    },
  }
}

// ══════════════════════════════════════════════════════════
//  COW PROTOCOL ADAPTER (Intent-based / MEV-protected)
// ══════════════════════════════════════════════════════════

/**
 * CoW Protocol works differently from other aggregators:
 * - Quote: standard price/fee estimation
 * - Swap: user signs an off-chain order → solvers compete to fill it
 * - The user does NOT submit an on-chain tx; the solver does
 * - Execution takes ~30s (batch auction interval)
 */
async function fetchCowSwapQuote(
  src: string, dst: string, amount: string,
): Promise<NormalizedQuote> {
  const { base } = AGGREGATOR_APIS.cowswap
  // CoW uses WETH address for native ETH
  const sellToken = src.toLowerCase() === NATIVE_ETH.toLowerCase() ? WETH_ADDRESS : src
  const buyToken = dst.toLowerCase() === NATIVE_ETH.toLowerCase() ? WETH_ADDRESS : dst

  const res = await fetch(`${base}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sellToken,
      buyToken,
      sellAmountBeforeFee: amount,
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
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`CoW ${res.status}: ${err.description || 'quote failed'}`)
  }
  const data = await res.json()
  const quote = data.quote

  return {
    source: 'cowswap',
    toAmount: quote.buyAmount,
    estimatedGas: 0, // gasless for user — solver pays
    gasUsd: 0,       // solver-paid
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
): Promise<NormalizedQuote & { cowOrderParams?: any }> {
  const { base } = AGGREGATOR_APIS.cowswap
  const sellToken = src.toLowerCase() === NATIVE_ETH.toLowerCase() ? WETH_ADDRESS : src
  const buyToken = dst.toLowerCase() === NATIVE_ETH.toLowerCase() ? WETH_ADDRESS : dst

  // Step 1: get quote with real user address
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
      appData: JSON.stringify({
        appCode: 'TeraSwap',
        metadata: {
          referrer: { address: FEE_RECIPIENT, version: '1.0.0' },
        },
      }),
      appDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
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

  // Apply slippage to buyAmount
  const buyAmountBig = BigInt(quote.buyAmount)
  const slippageFactor = BigInt(Math.round((1 - clampSlippage(slippage) / 100) * 10000))
  const minBuyAmount = (buyAmountBig * slippageFactor / 10000n).toString()

  return {
    source: 'cowswap',
    toAmount: quote.buyAmount,
    estimatedGas: 0,
    gasUsd: 0,
    routes: ['CoW Protocol (MEV Protected)'],
    // Store the full order params for signing in useSwap
    cowOrderParams: {
      ...quote,
      buyAmount: minBuyAmount, // with slippage applied
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
): Promise<string> {
  const { base } = AGGREGATOR_APIS.cowswap

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
  // Returns the order UID as a string
  const orderUid = await res.json()
  return orderUid
}

/**
 * Poll CoW order status until filled or expired.
 */
export async function pollCowOrderStatus(
  orderUid: string,
  maxWaitMs: number = 120_000,
): Promise<{ status: 'fulfilled' | 'expired' | 'cancelled'; txHash?: string }> {
  const { base } = AGGREGATOR_APIS.cowswap
  const start = Date.now()
  const pollInterval = 3000

  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${base}/orders/${orderUid}`)
    if (res.ok) {
      const order = await res.json()
      if (order.status === 'fulfilled') {
        // Get the settlement tx hash from trades endpoint
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

// ══════════════════════════════════════════════════════════
//  UNISWAP V3 ADAPTER (Direct on-chain — no API dependency)
//
//  Calls on-chain contracts directly via the public RPC:
//  - QuoterV2: simulate swap output (view call, no gas)
//  - SwapRouter02: execute swap (on-chain tx)
//
//  Auto fee-tier detection: tries all 4 fee tiers in parallel
//  and picks the one with best output.
//
//  Fee handling: since Uniswap has no partner fee params,
//  the platform fee (FEE_PERCENT) is deducted from amountIn
//  before sending to the router.
// ══════════════════════════════════════════════════════════

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

// ── Uniswap V3 helpers ─────────────────────────────────

/** Convert NATIVE_ETH sentinel to WETH for Uniswap */
function toWeth(token: string): Address {
  return (token.toLowerCase() === NATIVE_ETH.toLowerCase()
    ? WETH_ADDRESS
    : token) as Address
}

function isNativeEth(token: string): boolean {
  return token.toLowerCase() === NATIVE_ETH.toLowerCase()
}

/** RPC URL for on-chain calls */
function getRpcUrl(): string {
  return process.env.NEXT_PUBLIC_RPC_URL || 'https://eth.llamarpc.com'
}

/**
 * Deduct platform fee from amountIn.
 * Returns { netAmount (goes to router), feeAmount (platform keeps) }
 */
function deductFee(amountIn: string): { netAmount: bigint; feeAmount: bigint } {
  const total = BigInt(amountIn)
  // fee = total * FEE_PERCENT / 100
  // Use integer math: fee = total * feeBps / 10000
  const feeBps = BigInt(Math.round(FEE_PERCENT * 100)) // 0.1% → 10 bps
  const feeAmount = total * feeBps / 10000n
  const netAmount = total - feeAmount
  return { netAmount, feeAmount }
}

// ── Fee tier cache (in-memory, TTL-based) ────────────────
const FEE_TIER_CACHE_TTL_MS = 45 * 60 * 1000 // 45 minutes
const feeTierCache = new Map<string, { bestFee: number; ts: number }>()

function feeTierCacheKey(tokenIn: string, tokenOut: string): string {
  return `${CHAIN_ID}:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`
}

function getCachedFeeTier(tokenIn: string, tokenOut: string): number | null {
  const key = feeTierCacheKey(tokenIn, tokenOut)
  const entry = feeTierCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > FEE_TIER_CACHE_TTL_MS) {
    feeTierCache.delete(key)
    return null
  }
  return entry.bestFee
}

function setCachedFeeTier(tokenIn: string, tokenOut: string, bestFee: number): void {
  const key = feeTierCacheKey(tokenIn, tokenOut)
  feeTierCache.set(key, { bestFee, ts: Date.now() })
}

function invalidateCachedFeeTier(tokenIn: string, tokenOut: string): void {
  feeTierCache.delete(feeTierCacheKey(tokenIn, tokenOut))
}

/**
 * Auto fee tier detection for Uniswap V3.
 *
 * Quotes all 4 fee tiers in parallel via QuoterV2.quoteExactInputSingle.
 * Selection: highest amountOut wins; on tie, lowest gasEstimate wins.
 *
 * Returns full detection result with all candidates + reason.
 * Caches bestFee in-memory (45 min TTL) to avoid re-detection.
 */
async function detectUniswapV3FeeTier(params: {
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  sqrtPriceLimitX96?: bigint
}): Promise<FeeTierDetection> {
  const { tokenIn, tokenOut, amountIn, sqrtPriceLimitX96 = 0n } = params
  const rpcUrl = getRpcUrl()
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
            { to: UNISWAP_QUOTER_V2, data: callData },
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

  // Build candidates array — mark failed tiers as ok: false
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

  // Sort: highest amountOut first; tie-break by lowest gasEstimate
  valid.sort((a, b) => {
    const diffOut = BigInt(b.amountOut) - BigInt(a.amountOut)
    if (diffOut !== 0n) return diffOut > 0n ? 1 : -1
    return a.gasEstimate - b.gasEstimate // lower gas wins tie
  })

  const reason: FeeTierDetection['reason'] =
    valid.length === 1 ? 'single_pool' :
    BigInt(valid[0].amountOut) === BigInt(valid[1].amountOut) ? 'best_net_output' :
    'best_output'

  const bestFee = valid[0].fee

  // Update cache
  setCachedFeeTier(tokenIn, tokenOut, bestFee)

  return { bestFee, candidates, reason }
}

// ── Uniswap V3 quote adapter ───────────────────────────

async function fetchUniswapV3Quote(
  src: string, dst: string, amount: string,
): Promise<NormalizedQuote> {
  // Deduct platform fee from amountIn
  const { netAmount } = deductFee(amount)

  // Auto-detect best fee tier (uses cache if available)
  const detection = await detectUniswapV3FeeTier({
    tokenIn: src,
    tokenOut: dst,
    amountIn: netAmount,
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

// ── Uniswap V3 swap adapter ────────────────────────────

/**
 * Build Uniswap V3 swap calldata.
 * @param cachedFee — optional fee tier from quote phase (avoids re-detection)
 */
async function fetchUniswapV3Swap(
  src: string, dst: string, amount: string, from: string, slippage: number,
  cachedFee?: number,
): Promise<NormalizedQuote> {
  // Step 1: deduct platform fee
  const { netAmount } = deductFee(amount)

  // Step 2: detect fee tier (use cache / cachedFee to skip redundant RPC)
  let feeTier = cachedFee ?? getCachedFeeTier(src, dst)
  let amountOut: bigint
  let gasEstimate: number

  if (feeTier != null) {
    // Fast path: re-quote only the known best tier for fresh amountOut
    try {
      const detection = await detectUniswapV3FeeTier({
        tokenIn: src, tokenOut: dst, amountIn: netAmount,
      })
      const best = detection.candidates.find(c => c.fee === detection.bestFee && c.ok)!
      feeTier = detection.bestFee // might have shifted since cache
      amountOut = BigInt(best.amountOut)
      gasEstimate = best.gasEstimate
    } catch {
      // Cache stale — invalidate and fall through
      invalidateCachedFeeTier(src, dst)
      throw new Error('Uniswap V3: cached fee tier failed, retry needed')
    }
  } else {
    // Cold path: full detection
    const detection = await detectUniswapV3FeeTier({
      tokenIn: src, tokenOut: dst, amountIn: netAmount,
    })
    const best = detection.candidates.find(c => c.fee === detection.bestFee && c.ok)!
    feeTier = detection.bestFee
    amountOut = BigInt(best.amountOut)
    gasEstimate = best.gasEstimate
  }

  // Step 3: calculate amountOutMinimum with slippage
  const slippageFactor = BigInt(Math.round((1 - clampSlippage(slippage) / 100) * 10000))
  const amountOutMin = amountOut * slippageFactor / 10000n

  // Step 4: build swap calldata (exactInputSingle wrapped in multicall)
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
      recipient: from as Address,
      amountIn: netAmount,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0n,
    }],
  })

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600) // 10 min
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
      to: UNISWAP_SWAP_ROUTER_02 as `0x${string}`,
      data: multicallData,
      // If selling native ETH, send net amount as msg.value
      value: isNativeIn ? netAmount.toString() : '0',
      gas: gasEstimate + 50_000, // buffer for multicall overhead
    },
  }
}

// ══════════════════════════════════════════════════════════
//  OPENOCEAN ADAPTER
// ══════════════════════════════════════════════════════════

async function fetchOpenOceanQuote(
  src: string, dst: string, amount: string,
): Promise<NormalizedQuote> {
  const { base } = AGGREGATOR_APIS.openocean
  const params = new URLSearchParams({
    inTokenAddress: src,
    outTokenAddress: dst,
    amount: amount,       // raw wei amount
    gasPrice: '30',       // gwei
    slippage: '1',
  })
  const res = await fetch(`${base}/quote?${params}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`OpenOcean ${res.status}`)
  const data = await res.json()
  if (data.code !== 200 || !data.data) throw new Error(data.message || 'OpenOcean: no quote')

  return {
    source: 'openocean',
    toAmount: data.data.outAmount,
    estimatedGas: Number(data.data.estimatedGas || 0),
    gasUsd: 0,
    routes: data.data.path?.routes?.[0]?.subRoutes?.map((r: any) =>
      r.dexes?.[0]?.dex || 'OpenOcean'
    ) ?? ['OpenOcean'],
  }
}

async function fetchOpenOceanSwap(
  src: string, dst: string, amount: string, from: string, slippage: number,
): Promise<NormalizedQuote> {
  const { base } = AGGREGATOR_APIS.openocean
  const params = new URLSearchParams({
    inTokenAddress: src,
    outTokenAddress: dst,
    amount: amount,
    gasPrice: '30',
    slippage: String(slippage),
    account: from,
  })
  const res = await fetch(`${base}/swap?${params}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`OpenOcean swap ${res.status}`)
  const data = await res.json()
  if (data.code !== 200 || !data.data) throw new Error(data.message || 'OpenOcean: no swap')

  return {
    source: 'openocean',
    toAmount: data.data.outAmount,
    estimatedGas: Number(data.data.estimatedGas || 0),
    gasUsd: 0,
    routes: data.data.path?.routes?.[0]?.subRoutes?.map((r: any) =>
      r.dexes?.[0]?.dex || 'OpenOcean'
    ) ?? ['OpenOcean'],
    tx: {
      to: data.data.to as `0x${string}`,
      data: data.data.data as `0x${string}`,
      value: data.data.value || '0',
      gas: Number(data.data.estimatedGas || 0),
    },
  }
}

// ══════════════════════════════════════════════════════════
//  SUSHISWAP ADAPTER
// ══════════════════════════════════════════════════════════

async function fetchSushiSwapQuote(
  src: string, dst: string, amount: string,
): Promise<NormalizedQuote> {
  const { base } = AGGREGATOR_APIS.sushiswap
  const params = new URLSearchParams({
    tokenIn: src,
    tokenOut: dst,
    amount: amount,
    maxSlippage: '0.01',
    preferSushi: 'true',
  })
  const res = await fetch(`${base}?${params}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`SushiSwap ${res.status}`)
  const data = await res.json()

  if (!data.assumedAmountOut) throw new Error('SushiSwap: no route')

  return {
    source: 'sushiswap',
    toAmount: data.assumedAmountOut,
    estimatedGas: Number(data.gasSpent || 0),
    gasUsd: 0,
    routes: data.routeProcessorArgs?.routeCode
      ? ['SushiSwap RouteProcessor']
      : ['SushiSwap'],
  }
}

async function fetchSushiSwapSwap(
  src: string, dst: string, amount: string, from: string, slippage: number,
): Promise<NormalizedQuote> {
  const { base } = AGGREGATOR_APIS.sushiswap
  const params = new URLSearchParams({
    tokenIn: src,
    tokenOut: dst,
    amount: amount,
    maxSlippage: String(clampSlippage(slippage) / 100),
    to: from,
    preferSushi: 'true',
  })
  const res = await fetch(`${base}?${params}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`SushiSwap swap ${res.status}`)
  const data = await res.json()
  if (!data.assumedAmountOut) throw new Error('SushiSwap: no route')

  const rpArgs = data.routeProcessorArgs
  return {
    source: 'sushiswap',
    toAmount: data.assumedAmountOut,
    estimatedGas: Number(data.gasSpent || 0),
    gasUsd: 0,
    routes: ['SushiSwap RouteProcessor'],
    tx: rpArgs ? {
      to: rpArgs.to as `0x${string}`,
      data: rpArgs.data as `0x${string}`,
      value: rpArgs.value || '0',
      gas: Number(data.gasSpent || 300_000),
    } : undefined,
  }
}

// ══════════════════════════════════════════════════════════
//  BALANCER SOR ADAPTER
// ══════════════════════════════════════════════════════════

async function fetchBalancerQuote(
  src: string, dst: string, amount: string,
): Promise<NormalizedQuote> {
  const { base } = AGGREGATOR_APIS.balancer
  const res = await fetch(`${base}/order/1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sellToken: src,
      buyToken: dst,
      orderKind: 'sell',
      amount: amount,
      gasPrice: '30000000000', // 30 gwei in wei
    }),
  })
  if (!res.ok) throw new Error(`Balancer ${res.status}`)
  const data = await res.json()

  if (!data.buyAmount && !data.returnAmount) throw new Error('Balancer: no route')
  const outAmount = data.buyAmount || data.returnAmount || '0'

  return {
    source: 'balancer',
    toAmount: outAmount,
    estimatedGas: Number(data.gasEstimate || data.gas || 0),
    gasUsd: 0,
    routes: data.swaps?.map((s: any) => `Balancer Pool ${String(s.poolId).slice(0, 10)}…`) ?? ['Balancer SOR'],
  }
}

async function fetchBalancerSwap(
  src: string, dst: string, amount: string, from: string, slippage: number,
): Promise<NormalizedQuote> {
  const { base } = AGGREGATOR_APIS.balancer
  const res = await fetch(`${base}/order/1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sellToken: src,
      buyToken: dst,
      orderKind: 'sell',
      amount: amount,
      sender: from,
      receiver: from,
      gasPrice: '30000000000',
      slippagePercentage: String(clampSlippage(slippage) / 100),
    }),
  })
  if (!res.ok) throw new Error(`Balancer swap ${res.status}`)
  const data = await res.json()

  if (!data.buyAmount && !data.returnAmount) throw new Error('Balancer: no route')
  const outAmount = data.buyAmount || data.returnAmount || '0'

  return {
    source: 'balancer',
    toAmount: outAmount,
    estimatedGas: Number(data.gasEstimate || data.gas || 0),
    gasUsd: 0,
    routes: data.swaps?.map((s: any) => `Balancer Pool ${String(s.poolId).slice(0, 10)}…`) ?? ['Balancer SOR'],
    tx: data.to ? {
      to: data.to as `0x${string}`,
      data: data.data as `0x${string}`,
      value: data.value || '0',
      gas: Number(data.gasEstimate || data.gas || 300_000),
    } : undefined,
  }
}

// ══════════════════════════════════════════════════════════
//  CURVE FINANCE ADAPTER (on-chain — CurveRouterNG)
// ══════════════════════════════════════════════════════════

// CurveRouterNG on Ethereum mainnet — unified router supporting all pool types
const CURVE_ROUTER_NG = '0x16C6521Dff6baB339122a0FE25a9116693265353' as const

// ABI fragment for CurveRouterNG — get_dy (quote) + exchange (swap)
const CURVE_ROUTER_ABI = [
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

/**
 * Build a simple direct route for CurveRouterNG.
 *
 * CurveRouterNG expects:
 * - _route: address[11] — [tokenIn, pool, tokenOut, 0x0, …]
 * - _swap_params: uint256[5][5] — [[i, j, swapType, 0, 0], [0,0,0,0,0]×4]
 * - _pools: address[5] — [pool, 0x0, …]
 *
 * For stablecoin pools (3pool, etc.) swapType = 1 (stable).
 * For crypto pools (tricrypto, etc.) swapType = 3 (crypto).
 * We use swapType = 1 as default; CurveRouterNG auto-resolves internally.
 */

// Common Curve pools for major pairs (Ethereum mainnet)
const CURVE_POOLS: Record<string, {
  pool: `0x${string}`
  coins: `0x${string}`[]   // token addresses in pool order
  swapType: number          // 1 = stable, 2 = crypto exchange, 3 = crypto, 4 = stable NG
}> = {
  // ── 3pool (DAI/USDC/USDT) ──
  '3pool': {
    pool: '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
    coins: [
      '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
      '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    ],
    swapType: 1,
  },
  // ── Tricrypto2 (USDT/WBTC/WETH) ──
  tricrypto2: {
    pool: '0xD51a44d3FaE010294C616388b506AcdA1bfAAE46',
    coins: [
      '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
      '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    ],
    swapType: 3,
  },
  // ── stETH/ETH ──
  steth: {
    pool: '0xDC24316b9AE028F1497c275EB9192a3Ea0f67022',
    coins: [
      '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', // ETH
      '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', // stETH
    ],
    swapType: 1,
  },
  // ── FRAX/USDC ──
  fraxusdc: {
    pool: '0xDcEF968d416a41Cdac0ED8702fAC8128A64241A2',
    coins: [
      '0x853d955acef822db058eb8505911ed77f175b99e', // FRAX
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    ],
    swapType: 1,
  },
  // ── crvUSD/USDC ──
  crvusdusdc: {
    pool: '0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E',
    coins: [
      '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e', // crvUSD
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    ],
    swapType: 4,
  },
  // ── crvUSD/USDT ──
  crvusdusdt: {
    pool: '0x390f3595bCa2Df7d23783dFd126427CCeb997BF4',
    coins: [
      '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e', // crvUSD
      '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    ],
    swapType: 4,
  },
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as `0x${string}`

/**
 * Find a Curve pool that contains both tokenIn and tokenOut.
 * Returns the pool info + indices, or null if no direct pool exists.
 */
function findCurvePool(tokenIn: string, tokenOut: string): {
  poolName: string
  pool: `0x${string}`
  i: number
  j: number
  swapType: number
} | null {
  const inLower = tokenIn.toLowerCase()
  const outLower = tokenOut.toLowerCase()

  for (const [name, info] of Object.entries(CURVE_POOLS)) {
    const iIdx = info.coins.findIndex(c => c.toLowerCase() === inLower)
    const jIdx = info.coins.findIndex(c => c.toLowerCase() === outLower)
    if (iIdx >= 0 && jIdx >= 0 && iIdx !== jIdx) {
      return { poolName: name, pool: info.pool, i: iIdx, j: jIdx, swapType: info.swapType }
    }
  }
  return null
}

// Fixed-length tuple types for CurveRouterNG
type CurveRoute = readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`]
type CurveSwapParam = readonly [bigint, bigint, bigint, bigint, bigint]
type CurveSwapParams = readonly [CurveSwapParam, CurveSwapParam, CurveSwapParam, CurveSwapParam, CurveSwapParam]
type CurvePools = readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`]

/**
 * Build CurveRouterNG route arrays for a single-hop swap.
 */
function buildCurveRoute(
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  pool: `0x${string}`,
  i: number,
  j: number,
  swapType: number,
): {
  route: CurveRoute
  swapParams: CurveSwapParams
  pools: CurvePools
} {
  const Z = ZERO_ADDR

  const route: CurveRoute = [tokenIn, pool, tokenOut, Z, Z, Z, Z, Z, Z, Z, Z]

  const zeroRow: CurveSwapParam = [0n, 0n, 0n, 0n, 0n]
  const swapParams: CurveSwapParams = [
    [BigInt(i), BigInt(j), BigInt(swapType), 0n, 0n],
    zeroRow, zeroRow, zeroRow, zeroRow,
  ]

  const pools: CurvePools = [pool, Z, Z, Z, Z]

  return { route, swapParams, pools }
}

async function fetchCurveQuote(
  src: string, dst: string, amount: string,
): Promise<NormalizedQuote> {
  // Deduct platform fee
  const { netAmount } = deductFee(amount)

  // Resolve native ETH to WETH for pool matching (but keep ETH sentinel for stETH pool)
  const tokenIn = src.toLowerCase()
  const tokenOut = dst.toLowerCase()

  const poolInfo = findCurvePool(tokenIn, tokenOut)
  if (!poolInfo) throw new Error('Curve: no pool found for this pair')

  const { poolName, pool, i, j, swapType } = poolInfo
  const { route, swapParams, pools } = buildCurveRoute(
    tokenIn as `0x${string}`,
    tokenOut as `0x${string}`,
    pool, i, j, swapType,
  )

  // On-chain call to CurveRouterNG.get_dy
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
    estimatedGas: 200_000, // Curve swaps typically ~150k-250k gas
    gasUsd: 0,
    routes: [`Curve ${poolLabel} Pool`],
  }
}

async function fetchCurveSwap(
  src: string, dst: string, amount: string, from: string, slippage: number,
): Promise<NormalizedQuote> {
  // Deduct platform fee
  const { netAmount } = deductFee(amount)

  const tokenIn = src.toLowerCase()
  const tokenOut = dst.toLowerCase()

  const poolInfo = findCurvePool(tokenIn, tokenOut)
  if (!poolInfo) throw new Error('Curve: no pool found for this pair')

  const { poolName, pool, i, j, swapType } = poolInfo
  const { route, swapParams, pools } = buildCurveRoute(
    tokenIn as `0x${string}`,
    tokenOut as `0x${string}`,
    pool, i, j, swapType,
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
      from as Address,
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
      gas: 300_000, // buffer for Curve's complex routing
    },
  }
}

// ══════════════════════════════════════════════════════════
//  META-AGGREGATOR ORCHESTRATOR
// ══════════════════════════════════════════════════════════

/**
 * Fetch quotes from ALL 11 sources in parallel,
 * normalize, sort by best net output.
 */
export async function fetchMetaQuote(
  src: string,
  dst: string,
  amount: string,
  srcDecimals: number = 18,
  dstDecimals: number = 18,
): Promise<MetaQuoteResult> {
  // Rate limit: max 30 global requests/min
  if (!globalLimiter.allow('meta_quote')) {
    throw new Error('Rate limited — too many requests. Please wait a moment.')
  }

  const sourceNames: AggregatorName[] = ['1inch', '0x', 'velora', 'odos', 'kyberswap', 'cowswap', 'uniswapv3', 'openocean', 'sushiswap', 'balancer', 'curve']
  const startTime = Date.now()
  const results = await Promise.allSettled([
    withTimeout(fetch1inchQuote(src, dst, amount), QUOTE_TIMEOUT_MS),
    withTimeout(fetch0xQuote(src, dst, amount), QUOTE_TIMEOUT_MS),
    withTimeout(fetchVeloraQuote(src, dst, amount), QUOTE_TIMEOUT_MS),
    withTimeout(fetchOdosQuote(src, dst, amount), QUOTE_TIMEOUT_MS),
    withTimeout(fetchKyberSwapQuote(src, dst, amount), QUOTE_TIMEOUT_MS),
    withTimeout(fetchCowSwapQuote(src, dst, amount), QUOTE_TIMEOUT_MS),
    withTimeout(fetchUniswapV3Quote(src, dst, amount), QUOTE_TIMEOUT_MS),
    withTimeout(fetchOpenOceanQuote(src, dst, amount), QUOTE_TIMEOUT_MS),
    withTimeout(fetchSushiSwapQuote(src, dst, amount), QUOTE_TIMEOUT_MS),
    withTimeout(fetchBalancerQuote(src, dst, amount), QUOTE_TIMEOUT_MS),
    withTimeout(fetchCurveQuote(src, dst, amount), QUOTE_TIMEOUT_MS),
  ])
  const elapsed = Date.now() - startTime

  // ── Source monitoring: record success/failure per aggregator ──
  try {
    const { recordSourcePing } = await import('./source-monitor')
    results.forEach((r, i) => {
      const name = sourceNames[i]
      if (r.status === 'fulfilled' && r.value.toAmount && BigInt(r.value.toAmount) > 0n) {
        recordSourcePing(name, true, elapsed)
      } else {
        const error = r.status === 'rejected' ? String(r.reason) : 'Zero output'
        recordSourcePing(name, false, elapsed, error)
      }
    })
  } catch { /* monitoring is best-effort */ }

  const quotes: NormalizedQuote[] = results
    .filter((r): r is PromiseFulfilledResult<NormalizedQuote> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((q) => {
      try {
        return q.toAmount && BigInt(q.toAmount) > 0n
      } catch {
        return false
      }
    })

  if (quotes.length === 0) {
    // Build a helpful error from the individual failures
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r, i) => {
        const sources = ['1inch', '0x', 'Velora', 'Odos', 'KyberSwap', 'CoW', 'Uniswap V3', 'OpenOcean', 'SushiSwap', 'Balancer', 'Curve']
        return friendlyError(sources[i] ?? 'Unknown', r.reason)
      })
    const allTimeout = errors.every(e => e.includes('timed out'))
    const allNetwork = errors.every(e => e.includes('Network error'))
    if (allTimeout) throw new Error('All sources timed out. Check your connection and try again.')
    if (allNetwork) throw new Error('Network error. Check your internet connection.')
    throw new Error(`No valid quotes. ${errors[0] || 'Try a different pair or amount.'}`)
  }

  // ── Gas-aware sorting ──
  // If gasUsd is available, compute net value = toAmount - gasCost (in token units).
  // Fallback: sort by raw toAmount when gas info is missing.
  // We approximate gas cost in output-token units via: gasCostTokens = gasUsd / pricePerToken
  // where pricePerToken ≈ (inputUsd / inputAmount) — derived from the quote itself.
  // For quotes with no gasUsd we treat gas cost as 0 (same as before).
  quotes.sort((a, b) => {
    try {
      const aOut = BigInt(a.toAmount)
      const bOut = BigInt(b.toAmount)

      // If both have gasUsd > 0, do gas-aware comparison
      if (a.gasUsd > 0 || b.gasUsd > 0) {
        // Use gasUsd difference directly (smaller $ gas cost is better)
        // netScore = toAmount_normalized - gasCostPenalty
        // Since toAmounts share the same decimals, we compare:
        //   (bOut - aOut) vs gasDiff scaled to token units
        // Simplified: compare toAmount and penalize by gasUsd delta
        // If quotes are close in output but one has much higher gas, prefer cheaper gas
        const gasDiffUsd = a.gasUsd - b.gasUsd // positive = a is more expensive
        // Convert gasUsd diff to approx token units: assume 1 token unit ≈ avgOutput/10^dstDecimals USD
        // This is rough but good enough for ranking — gasUsd diffs are usually small vs output diffs
        const diff = bOut - aOut
        if (diff !== 0n) return diff > 0n ? 1 : -1
        // Same output → cheaper gas wins
        return gasDiffUsd > 0 ? 1 : gasDiffUsd < 0 ? -1 : 0
      }

      const diff = bOut - aOut
      return diff > 0n ? 1 : diff < 0n ? -1 : 0
    } catch {
      return 0
    }
  })

  // ── Outlier detection ──
  // If we have 2+ quotes, remove any quote whose output is >3x the median.
  // This catches manipulated pools (e.g. PancakeV3 on Ethereum) returning
  // absurdly high amounts that Chainlink would reject anyway.
  if (quotes.length >= 2) {
    // True statistical median: sort ascending, pick middle (or avg of two middles)
    const amounts = quotes.map(q => { try { return BigInt(q.toAmount) } catch { return 0n } })
    const sorted = [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2n
      : sorted[mid]
    if (median > 0n) {
      const threshold = median * 3n // 3x median = clearly bogus
      const filtered = quotes.filter(q => {
        try {
          return BigInt(q.toAmount) <= threshold
        } catch {
          return true
        }
      })
      // Only use filtered list if we still have at least 1 valid quote
      if (filtered.length > 0) {
        return {
          best: filtered[0],
          all: filtered, // hide outliers from UI to avoid misleading users
          fetchedAt: Date.now(),
        }
      }
    }
  }

  return {
    best: quotes[0],
    all: quotes,
    fetchedAt: Date.now(),
  }
}

/**
 * Fetch swap tx data from the WINNING aggregator.
 */
/**
 * Fetch swap tx data from the WINNING aggregator.
 * @param quoteMeta — optional meta from quote phase (Uniswap V3 uses this to avoid re-detection)
 */
/**
 * Validate that the swap quote respects the expected fee deduction.
 * Compares quoted toAmount against the expected quoteAmount from the quote phase.
 * If toAmount is significantly MORE than expected (>2% above), the fee was likely skipped.
 * This is a defence-in-depth check since fees are enforced via aggregator API params.
 */
export function validateFeeIntegrity(
  quoteToAmount: string,
  swapToAmount: string,
  source: AggregatorName,
): { valid: boolean; reason?: string } {
  // Skip validation for sources where fee is deducted from input (Uniswap, Curve)
  // or intent-based (CoW) where solver handles it
  const skipSources: AggregatorName[] = ['uniswapv3', 'curve', 'cowswap']
  if (skipSources.includes(source)) return { valid: true }

  const quoted = BigInt(quoteToAmount)
  const swapped = BigInt(swapToAmount)

  if (quoted <= 0n) return { valid: true } // no quote to compare

  // If swapToAmount is >2% higher than quoteToAmount, fee might not be applied
  // (Normally swap returns less than or equal to quote due to slippage)
  const tolerance = quoted * 2n / 100n // 2% above quote
  if (swapped > quoted + tolerance) {
    return {
      valid: false,
      reason: `Fee integrity check failed for ${source}: swap output (${swapToAmount}) is unexpectedly higher than quoted (${quoteToAmount}). Partner fee may not be applied.`,
    }
  }

  return { valid: true }
}

export async function fetchSwapFromSource(
  source: AggregatorName,
  src: string,
  dst: string,
  amount: string,
  from: string,
  slippage: number = DEFAULT_SLIPPAGE,
  srcDecimals: number = 18,
  dstDecimals: number = 18,
  quoteMeta?: NormalizedQuote['meta'],
): Promise<NormalizedQuote> {
  switch (source) {
    case '1inch':
      return fetch1inchSwap(src, dst, amount, from, slippage)
    case '0x':
      return fetch0xSwap(src, dst, amount, from, slippage)
    case 'velora':
      return fetchVeloraSwap(src, dst, amount, from, slippage, srcDecimals, dstDecimals)
    case 'odos':
      return fetchOdosSwap(src, dst, amount, from, slippage)
    case 'kyberswap':
      return fetchKyberSwapSwap(src, dst, amount, from, slippage)
    case 'cowswap':
      return fetchCowSwapOrder(src, dst, amount, from, slippage)
    case 'uniswapv3':
      return fetchUniswapV3Swap(src, dst, amount, from, slippage, quoteMeta?.uniswapV3Fee)
    case 'openocean':
      return fetchOpenOceanSwap(src, dst, amount, from, slippage)
    case 'sushiswap':
      return fetchSushiSwapSwap(src, dst, amount, from, slippage)
    case 'balancer':
      return fetchBalancerSwap(src, dst, amount, from, slippage)
    case 'curve':
      return fetchCurveSwap(src, dst, amount, from, slippage)
    default:
      throw new Error(`Unknown source: ${source}`)
  }
}

/**
 * Fetch approved spender address for a given source.
 */
export async function fetchApproveSpender(source: AggregatorName): Promise<`0x${string}`> {
  switch (source) {
    case '1inch': {
      const { base, key } = AGGREGATOR_APIS['1inch']
      const res = await fetch(`${base}/approve/spender`, {
        headers: { Authorization: `Bearer ${key}` },
      })
      if (!res.ok) throw new Error('1inch spender failed')
      return (await res.json()).address
    }
    case '0x': {
      // 0x v2 uses Permit2 — approve to Permit2 contract
      return PERMIT2_ADDRESS as `0x${string}`
    }
    case 'velora': {
      const { base } = AGGREGATOR_APIS.velora
      const res = await fetch(`${base}/adapters/contracts?network=${CHAIN_ID}`)
      if (!res.ok) throw new Error('Velora spender failed')
      const data = await res.json()
      return data.TokenTransferProxy || data.AugustusSwapper
    }
    case 'odos': {
      // Odos Router V3 — same address on all EVM chains
      return ODOS_ROUTER_V3 as `0x${string}`
    }
    case 'kyberswap': {
      // KyberSwap Aggregator Router on Ethereum
      return '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as `0x${string}`
    }
    case 'cowswap': {
      // CoW Protocol: approve to the GPv2VaultRelayer
      return COW_VAULT_RELAYER as `0x${string}`
    }
    case 'uniswapv3': {
      // Uniswap V3: approve to SwapRouter02
      return UNISWAP_SWAP_ROUTER_02 as `0x${string}`
    }
    case 'openocean': {
      // OpenOcean Exchange Proxy on Ethereum
      return '0x6352a56caadC4F1E25CD6c75970Fa768A3304e64' as `0x${string}`
    }
    case 'sushiswap': {
      // SushiSwap RouteProcessor4 on Ethereum
      return '0x46B3fDF7b5CDe91Ac049936bF0bDb12c5d22202e' as `0x${string}`
    }
    case 'balancer': {
      // Balancer Vault V2 on Ethereum
      return '0xBA12222222228d8Ba445958a75a0704d566BF2C8' as `0x${string}`
    }
    case 'curve': {
      // CurveRouterNG on Ethereum mainnet
      return CURVE_ROUTER_NG as `0x${string}`
    }
    default:
      throw new Error(`Unknown source: ${source}`)
  }
}

// ══════════════════════════════════════════════════════════
//  SECURITY: Router Address Whitelist
//  Inspired by SushiSwap RouteProcessor2 exploit where
//  attackers drained approved funds via a spoofed router.
//  We maintain a strict whitelist of known-good router
//  addresses and validate ALL swap tx.to against it.
// ══════════════════════════════════════════════════════════

/** Whitelisted router addresses (lowercase). Only these can receive swap transactions. */
const ROUTER_WHITELIST: Set<string> = new Set([
  PERMIT2_ADDRESS.toLowerCase(),
  COW_VAULT_RELAYER.toLowerCase(),
  COW_SETTLEMENT.toLowerCase(),
  ODOS_ROUTER_V3.toLowerCase(),
  UNISWAP_SWAP_ROUTER_02.toLowerCase(),
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // KyberSwap Aggregator Router
  '0x6352a56caadc4f1e25cd6c75970fa768a3304e64', // OpenOcean Exchange Proxy
  '0x46b3fdf7b5cde91ac049936bf0bdb12c5d22202e', // SushiSwap RouteProcessor4
  '0xba12222222228d8ba445958a75a0704d566bf2c8', // Balancer Vault V2
])

/**
 * Validate that a swap transaction targets a whitelisted router.
 * This prevents attacks where a compromised aggregator API returns
 * a malicious contract address as the swap target.
 *
 * @returns true if the address is whitelisted (or dynamically verified)
 */
export function validateRouterAddress(
  txTo: string,
  source: AggregatorName,
): { valid: boolean; reason?: string } {
  // For 1inch, 0x, Velora — router address is dynamic (fetched from API)
  // We must trust the API response for these, but log for monitoring
  const dynamicSources: AggregatorName[] = ['1inch', '0x', 'velora']
  if (dynamicSources.includes(source)) {
    // Log dynamic router for audit trail
    if (typeof window !== 'undefined') {
      console.info(`[TeraSwap] Dynamic router for ${source}: ${txTo}`)
    }
    return { valid: true }
  }

  const normalized = txTo.toLowerCase()
  if (ROUTER_WHITELIST.has(normalized)) {
    return { valid: true }
  }

  return {
    valid: false,
    reason: `Swap target ${txTo} for ${source} is NOT in the router whitelist. Possible API compromise.`,
  }
}

/**
 * Add a dynamically-fetched router address to the whitelist.
 * Called after fetching spender from API (1inch, 0x, Velora).
 */
export function addToRouterWhitelist(address: string): void {
  ROUTER_WHITELIST.add(address.toLowerCase())
}
