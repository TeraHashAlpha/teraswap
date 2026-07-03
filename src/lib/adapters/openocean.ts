import { getAdapterApiUrl, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { parseJsonOrThrow } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

/**
 * [CHORE-QUOTE-SOURCE-FIXES C1] The OpenOcean v4 API expects the sell
 * `amount` in HUMAN (decimals-adjusted) units and returns amounts in RAW
 * base units (contract verified live 2026-07-02; pinned in openocean.test.ts).
 * Convert the internal base-unit string exactly (BigInt, no float) before
 * sending; the response `outAmount` is already base units and must pass
 * through unconverted. Sending base units here priced every quote for a
 * trade 10^srcDecimals too large (10^6–10^18×) — garbage that could win the
 * DISPLAYED best price in exactly-2-responder windows, where the 3×-median
 * outlier filter cannot trigger.
 */
function toHumanAmount(baseUnits: string, decimals: number): string {
  const scale = 10n ** BigInt(decimals)
  const v = BigInt(baseUnits)
  const frac = (v % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${v / scale}.${frac}` : (v / scale).toString()
}

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, srcDecimals = 18, chainId = DEFAULT_CHAIN_ID } = params
  const base = getAdapterApiUrl('openocean', chainId)
  const qs = new URLSearchParams({
    inTokenAddress: src,
    outTokenAddress: dst,
    amount: toHumanAmount(amount, srcDecimals),
    gasPrice: '30',
    slippage: '1',
  })
  const res = await fetch(`${base}/quote?${qs}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`OpenOcean ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'OpenOcean')
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

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, srcDecimals = 18, from, slippage, recipient, chainId = DEFAULT_CHAIN_ID } = params
  // [P101] OpenOcean's /swap endpoint does NOT support a split sender/
  // receiver — `account` is both signer and destination. Warn loudly when
  // a caller requested a distinct recipient so /v1/swap can detect the
  // mismatch downstream via the calldata recipient check.
  if (recipient && recipient !== from) {
    console.warn(
      `[openocean] recipient (${recipient}) differs from sender (${from}) — `
        + 'OpenOcean API has no recipient parameter; output will route to sender.',
    )
  }
  const base = getAdapterApiUrl('openocean', chainId)
  const qs = new URLSearchParams({
    inTokenAddress: src,
    outTokenAddress: dst,
    // [CHORE-QUOTE-SOURCE-FIXES C1] Same human-units contract as /quote.
    amount: toHumanAmount(amount, srcDecimals),
    gasPrice: '30',
    slippage: String(slippage),
    account: from,
  })
  const res = await fetch(`${base}/swap?${qs}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`OpenOcean swap ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'OpenOcean')
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

const adapter: DEXAdapter = {
  name: 'openocean' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
