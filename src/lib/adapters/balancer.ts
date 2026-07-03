/**
 * ⚠ SUPERSEDED — DISABLED via DISABLED_SOURCES ('balancer') since
 * CHORE-QUOTE-SOURCE-FIXES C2 (2026-07-03). Do NOT delete (repo rule #4).
 *
 * The v2 SOR order endpoint this adapter targets
 * (`api-v3.balancer.fi/order/{chainId}`) returns **404** — the host now
 * serves only `/`, `/graphql` and `/log` (verified live 2026-07-02, T-SAF
 * W7-L-02 coverage check). The adapter has produced 0 production quotes
 * ever; while enabled it only contributed errors to the quote fan-out.
 *
 * Re-enable path: rewrite fetchQuote/fetchSwapData against the Balancer v3
 * GraphQL SOR (`POST https://api-v3.balancer.fi/graphql`, query
 * `sorGetSwapPaths(chain, swapAmount, swapType, tokenIn, tokenOut)`), keep
 * the [SPRINT-9G G7] fail-closed router-whitelist gate on the swap target,
 * then remove the DISABLED_SOURCES entry. Note W7-L-02's verdict before
 * investing: Balancer pools are already routed by the whitelisted
 * aggregators (Kyber/Velora/…), so its unique-liquidity value is ~0.
 */
import { getAdapterApiUrl, getRouterWhitelist, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { clampSlippage, parseJsonOrThrow } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, chainId = DEFAULT_CHAIN_ID } = params
  const base = getAdapterApiUrl('balancer', chainId)
  const res = await fetch(`${base}/order/${chainId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sellToken: src,
      buyToken: dst,
      orderKind: 'sell',
      amount: amount,
      gasPrice: '30000000000',
    }),
  })
  if (!res.ok) throw new Error(`Balancer ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'Balancer')

  if (!data.buyAmount && !data.returnAmount) throw new Error('Balancer: no route')
  const outAmount = data.buyAmount || data.returnAmount || '0'

  return {
    source: 'balancer',
    toAmount: outAmount,
    estimatedGas: Number(data.gasEstimate || data.gas || 0),
    gasUsd: 0,
    routes: data.swaps?.map((s: any) => `Balancer Pool ${String(s.poolId).slice(0, 10)}...`) ?? ['Balancer SOR'],
  }
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage, recipient, chainId = DEFAULT_CHAIN_ID } = params
  const base = getAdapterApiUrl('balancer', chainId)
  const res = await fetch(`${base}/order/${chainId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sellToken: src,
      buyToken: dst,
      orderKind: 'sell',
      amount: amount,
      sender: from,
      // [P101] Recipient defaults to sender when not provided.
      receiver: recipient ?? from,
      gasPrice: '30000000000',
      slippagePercentage: String(clampSlippage(slippage) / 100),
    }),
  })
  if (!res.ok) throw new Error(`Balancer swap ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'Balancer')

  if (!data.buyAmount && !data.returnAmount) throw new Error('Balancer: no route')
  const outAmount = data.buyAmount || data.returnAmount || '0'

  // [SPRINT-9G G7] Fail closed: the SOR API's swap target (`data.to`) must be a
  // whitelisted router on this chain — the Balancer V2 Vault — mirroring the
  // Bebop gate (bebop.ts:122-128). Refuse rather than hand back executable
  // calldata aimed at an unverified contract. This matches the whitelist
  // enforcement already applied downstream (useSwap.validateRouterAddress) and
  // also covers the /v1/swap path. Verify the live Vault-vs-relayer target per
  // chain before relying on Balancer execution (see FEEDBACK.md).
  if (data.to && !getRouterWhitelist(chainId).includes(String(data.to).toLowerCase())) {
    throw new Error(`Balancer: swap target ${data.to} not whitelisted on chain ${chainId} — refusing swap`)
  }

  return {
    source: 'balancer',
    toAmount: outAmount,
    estimatedGas: Number(data.gasEstimate || data.gas || 0),
    gasUsd: 0,
    routes: data.swaps?.map((s: any) => `Balancer Pool ${String(s.poolId).slice(0, 10)}...`) ?? ['Balancer SOR'],
    tx: data.to ? {
      to: data.to as `0x${string}`,
      data: data.data as `0x${string}`,
      value: data.value || '0',
      gas: Number(data.gasEstimate || data.gas || 300_000),
    } : undefined,
  }
}

const adapter: DEXAdapter = {
  name: 'balancer' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
