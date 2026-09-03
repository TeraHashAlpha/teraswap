import { AGGREGATOR_APIS, FEE_RECIPIENT, FEE_BPS, NATIVE_ETH } from '@/lib/constants'
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
 *   - swapFeeToken     = an ERC-20 the fee is collected in (0x v2 requires it to be the buy or
 *                        sell token). Prefer the SELL token, mirroring the FeeCollector charging on
 *                        INPUT; but native ETH (the 0xEeee… sentinel) is NOT a collectible 0x fee
 *                        token, so on an ETH SELL fall back to the buy token. At most one side is
 *                        native (no native→native swap), so this always yields a real ERC-20.
 *                        0x deducts the fee from the chosen token, so the returned buyAmount is
 *                        already POST-fee → our normalized toAmount is honest in Compare.
 * Applied to BOTH the quote and the swap-build request so the displayed quote == what executes.
 */
function applyPartnerFee(qs: URLSearchParams, src: string, dst: string): void {
  qs.set('swapFeeRecipient', FEE_RECIPIENT)
  qs.set('swapFeeBps', String(FEE_BPS))
  const sellIsNative = src.toLowerCase() === NATIVE_ETH.toLowerCase()
  qs.set('swapFeeToken', sellIsNative ? dst : src)
}

/**
 * [ADR-021] 0x v2 endpoint family — ALLOWANCE-HOLDER on every chain, mainnet included.
 *
 * Was: mainnet on `/swap/permit2/*`, Base/Arbitrum on `/swap/allowance-holder/*`
 * (SPRINT-9E). The permit2 endpoint returns a **Settler** address as `transaction.to`,
 * and 0x rotates the Settler with each release — so it can never be safely whitelisted:
 * pinning one guarantees an outage at the next rotation, and not pinning it defeats the
 * router gate. The AllowanceHolder is a fixed, deterministic address (already trusted on
 * 8453/42161, and verified deployed on mainnet — see ZEROX_ALLOWANCE_HOLDER).
 *
 * The permit2 flow was also never executable here: it requires the taker to sign the
 * returned `permit2.eip712` payload and the integrator to append that signature to the
 * calldata. This repo has no Permit2 signing on the swap path at all (`signTypedData`
 * appears nowhere in useSwap.ts / useSplitSwap.ts), so a permit2 quote would revert
 * on-chain even with both gates open.
 *
 * Exported so the tests can pin the exact path — a silent revert to the permit2 family
 * would change `transaction.to` back to a non-whitelisted Settler.
 */
export const ZEROX_V2_QUOTE_PATH = '/swap/allowance-holder/quote'
export const ZEROX_V2_PRICE_PATH = '/swap/allowance-holder/price'

// [fix/zerox-price-endpoint] The /quote endpoint is the firm, signable quote and
// REQUIRES `taker` (https://docs.0x.org/api-reference/evm-ap-is/swap/allowanceholder-getquote).
// Since quote-before-wallet (#439) there is no taker at quote time, so fetchQuote must
// use the indicative /price endpoint instead
// (https://docs.0x.org/api-reference/evm-ap-is/swap/allowanceholder-getprice).

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, chainId = DEFAULT_CHAIN_ID } = params
  const { key } = AGGREGATOR_APIS['0x']
  const base = getAdapterApiUrl('0x', chainId)
  const qs = new URLSearchParams({
    sellToken: src,
    buyToken: dst,
    sellAmount: amount,
  })
  // [P217, corrected] `chainId` is a REQUIRED query param on every 0x v2 price/quote
  // call, mainnet included — https://docs.0x.org/api-reference/evm-ap-is/swap/permit-2-getprice
  // and .../allowanceholder-getprice both list it as required, with no mainnet default.
  qs.set('chainId', String(chainId))
  applyPartnerFee(qs, src, dst) // [SPRINT-9T T1] uniform 0.1% (ERC-20 fee token)
  const res = await fetch(`${base}${ZEROX_V2_PRICE_PATH}?${qs}`, {
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
  // [P101] 0x v2 doesn't expose a separate recipient field —
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
  // [P217, corrected] `chainId` is required on /quote too — see fetchQuote.
  qs.set('chainId', String(chainId))
  applyPartnerFee(qs, src, dst) // [SPRINT-9T T1] same fee on swap-build → quote == execution
  const res = await fetch(`${base}${ZEROX_V2_QUOTE_PATH}?${qs}`, {
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
