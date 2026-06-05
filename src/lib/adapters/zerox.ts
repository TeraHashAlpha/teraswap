import { AGGREGATOR_APIS, FEE_RECIPIENT, FEE_BPS } from '@/lib/constants'
import { getAdapterApiUrl, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { clampSlippage, parseJsonOrThrow } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

/**
 * [SPRINT-9T T1] Attach TeraSwap's uniform partner fee to a 0x v2 swap request.
 *
 * 0x is FEE_INCOMPATIBLE (Permit2 pull model — can't wrap via the FeeCollector), so its
 * 0.1% is collected through 0x's NATIVE integrator-fee params instead:
 *   - swapFeeRecipient = FEE_RECIPIENT (env/constant, never hardcoded)
 *   - swapFeeBps       = FEE_BPS (the SAME bps the FeeCollector + Bebop use — no new number)
 *   - swapFeeToken     = the SELL token, mirroring the FeeCollector charging on INPUT. 0x deducts
 *                        the fee from the sell side, so the returned buyAmount is already POST-fee
 *                        → our normalized toAmount is honest in Compare (no artificial +0.1% edge).
 * Applied to BOTH the quote and the swap-build request so the displayed quote == what executes.
 */
function applyPartnerFee(qs: URLSearchParams, sellToken: string): void {
  qs.set('swapFeeRecipient', FEE_RECIPIENT)
  qs.set('swapFeeBps', String(FEE_BPS))
  qs.set('swapFeeToken', sellToken)
}

// [SPRINT-9E] 0x v2 flow per chain. Mainnet keeps the permit2 endpoint
// (byte-identical). Other chains (Base) use the allowance-holder endpoint so the
// returned tx.to is the AllowanceHolder — the address whitelisted for 0x on Base
// in chains/routers.ts (the permit2 Settler tx.to would fail that whitelist).
function zeroxQuotePath(chainId: number): string {
  return chainId === DEFAULT_CHAIN_ID ? '/swap/permit2/quote' : '/swap/allowance-holder/quote'
}

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, chainId = DEFAULT_CHAIN_ID } = params
  const { key } = AGGREGATOR_APIS['0x']
  const base = getAdapterApiUrl('0x', chainId)
  const qs = new URLSearchParams({
    sellToken: src,
    buyToken: dst,
    sellAmount: amount,
  })
  // [P217] 0x v2 defaults to mainnet when chainId is omitted; only attach it
  // for non-mainnet chains so the mainnet request stays byte-identical.
  if (chainId !== DEFAULT_CHAIN_ID) qs.set('chainId', String(chainId))
  applyPartnerFee(qs, src) // [SPRINT-9T T1] uniform 0.1% on the sell side
  const res = await fetch(`${base}${zeroxQuotePath(chainId)}?${qs}`, {
    headers: {
      '0x-api-key': key,
      '0x-version': 'v2',
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`0x ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, '0x')

  return {
    source: '0x',
    toAmount: data.buyAmount,
    estimatedGas: Number(data.transaction?.gas || data.gas || 0),
    gasUsd: 0,
    routes: data.route?.fills?.map((f: any) => f.source) ?? [],
  }
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage, recipient, chainId = DEFAULT_CHAIN_ID } = params
  // [P101] 0x v2 permit2 swap doesn't expose a separate recipient field —
  // `taker` is both signer and destination. The /v1/swap route already
  // rejects this source (FEE_INCOMPATIBLE_SOURCES), so this branch is
  // mostly defensive: log when an upstream caller threads recipient.
  if (recipient && recipient !== from) {
    console.warn(
      `[0x] recipient (${recipient}) differs from sender (${from}) — `
        + '0x v2 has no recipient parameter; output will route to sender.',
    )
  }
  const { key } = AGGREGATOR_APIS['0x']
  const base = getAdapterApiUrl('0x', chainId)
  const qs = new URLSearchParams({
    sellToken: src,
    buyToken: dst,
    sellAmount: amount,
    taker: from,
    slippageBps: Math.round(clampSlippage(slippage) * 100).toString(),
  })
  // [P217] Attach chainId only for non-mainnet chains (see fetchQuote).
  if (chainId !== DEFAULT_CHAIN_ID) qs.set('chainId', String(chainId))
  applyPartnerFee(qs, src) // [SPRINT-9T T1] same fee on swap-build → quote == execution
  const res = await fetch(`${base}${zeroxQuotePath(chainId)}?${qs}`, {
    headers: {
      '0x-api-key': key,
      '0x-version': 'v2',
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`0x swap ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, '0x')

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

const adapter: DEXAdapter = {
  name: '0x' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
