import { getAdapterApiUrl, getChainConfig, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { clampSlippage, parseJsonOrThrow } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

/**
 * [CHORE-SUSHI-V7] The v7 API REQUIRES `sender` — without it every request
 * is a deterministic 422 ("expected string, received undefined", parameter
 * "sender"), which kept Sushi at 0 prod quotes (T-SAF W7-followup). Any
 * valid address is accepted and the QUOTED amount is sender-independent
 * (probed live 2026-07-03, incl. the zero address); what the value means is
 * the account that will call the router (v7 tx.to = RedSnwapper, both
 * chains) — the chain's FeeCollector in TeraSwap's fee-routed flow. Quote
 * path has no wallet in scope → FeeCollector, else zero address; swap path
 * falls back to the user. NOTE: Sushi v7 is scoped QUOTE-ONLY on both
 * chains (src/lib/executable-sources.ts) until RedSnwapper is execution-
 * wired (SC-04 selector + R1 decoder + mainnet on-chain whitelist).
 */
const ZERO_SENDER = '0x0000000000000000000000000000000000000000'
function senderFor(chainId: number, from?: string): string {
  try {
    return getChainConfig(chainId).contracts.feeCollector ?? from ?? ZERO_SENDER
  } catch {
    return from ?? ZERO_SENDER
  }
}

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, chainId = DEFAULT_CHAIN_ID } = params
  const base = getAdapterApiUrl('sushiswap', chainId)
  const qs = new URLSearchParams({
    tokenIn: src,
    tokenOut: dst,
    amount: amount,
    maxSlippage: '0.01',
    sender: senderFor(chainId),
    preferSushi: 'true',
  })
  const res = await fetch(`${base}?${qs}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`SushiSwap ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'SushiSwap')

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

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage, recipient, chainId = DEFAULT_CHAIN_ID } = params
  const base = getAdapterApiUrl('sushiswap', chainId)
  const qs = new URLSearchParams({
    tokenIn: src,
    tokenOut: dst,
    amount: amount,
    maxSlippage: String(clampSlippage(slippage) / 100),
    // [P101] `to` is the router's output destination — defaults to sender.
    to: recipient ?? from,
    // [CHORE-SUSHI-V7] Required by v7 (see senderFor) — the router caller:
    // the FeeCollector when deployed on this chain, else the user.
    sender: senderFor(chainId, from),
    preferSushi: 'true',
  })
  const res = await fetch(`${base}?${qs}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`SushiSwap swap ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'SushiSwap')
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

const adapter: DEXAdapter = {
  name: 'sushiswap' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
