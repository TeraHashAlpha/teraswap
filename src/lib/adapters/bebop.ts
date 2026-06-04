/**
 * [ADR-010 / SPRINT-9D] Bebop — 12th meta-aggregator source (RFQ/solver).
 *
 * Uses Bebop's Aggregation API (JAM) with `gasless=false`, which returns
 * self-execution calldata (`tx { to, data, value, gas }`) that maps onto our
 * NormalizedQuote.tx exactly like 0x/1inch — no new signing flow. Chain-agnostic
 * on Ethereum (1) + Base (8453): the chain slug comes from the registry.
 *
 * Fees: Bebop is FEE-INCOMPATIBLE with our FeeCollector (it builds the tx for its
 * own settlement), so our 0.1% is taken via Bebop's partner-fee params on the
 * SWAP only (`fee` bps + `fee_recipient`). The price quote stays GROSS so Bebop
 * ranks fairly against the other (gross-quoted, fee-at-execution) sources.
 *
 * Security: Bebop's docs say "use the response addresses". Our model (rule #2/#9)
 * requires a static per-chain whitelist, so we DO use the response's
 * settlement/approvalTarget but FAIL CLOSED — the swap is refused unless
 * `tx.to === settlementAddress` AND both `settlementAddress` and `approvalTarget`
 * are already in `getRouterWhitelist(chainId)`.
 */
import {
  AGGREGATOR_APIS,
  BEBOP_SOURCE,
  FEE_BPS,
  FEE_RECIPIENT,
} from '@/lib/constants'
import { getAdapterApiUrl, getChainConfig, getRouterWhitelist, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { clampSlippage, parseJsonOrThrow } from './shared'
import type { DEXAdapter, NormalizedQuote, QuoteParams, SwapParams } from './types'

// Bebop requires `taker_address`. For price-only quotes (no connected wallet) we
// send a non-zero placeholder EOA; the firm/executable quote in fetchSwapData
// uses the real `from`. See FEEDBACK if Bebop ever rejects the placeholder.
const BEBOP_PRICE_TAKER = '0x1111111111111111111111111111111111111111'

// [SPRINT-9S S3] Bebop self-suppresses without an API key (demo mode returns no executable
// settlement), chain-agnostically — which made it silently absent on Base. Log ONCE so the
// missing-key cause is diagnosable in server logs rather than looking like a Base-only outage.
// The Base path is otherwise wired (host api.bebop.xyz, slug 'base', JAM settlement whitelisted
// on 8453); the only thing gating Bebop on Base is the env key. See FEEDBACK 9S (S3.4).
let bebopKeyWarned = false
function warnBebopKeyMissingOnce(): void {
  if (bebopKeyWarned) return
  bebopKeyWarned = true
  console.info('[bebop] skipped on every chain — BEBOP_API_KEY not set (demo mode has no executable settlement). Set BEBOP_API_KEY to enable Bebop.')
}

/** Build the JAM quote endpoint for `chainId` (slug = ethereum / base). */
function bebopQuoteUrl(chainId: number): string {
  const host = getAdapterApiUrl('bebop', chainId) // 'https://api.bebop.xyz'
  const slug = getChainConfig(chainId).slug        // 'ethereum' | 'base'
  return `${host}/jam/${slug}/v2/quote`
}

function authHeaders(): Record<string, string> {
  const { key } = AGGREGATOR_APIS.bebop
  return { Accept: 'application/json', ...(key ? { 'source-auth': key } : {}) }
}

/** Pull the output amount for `dst` from Bebop's buyTokens map (case-insensitive).
 *  Returns null when there is no usable amount (no route) — callers decide whether
 *  that's a non-fatal "absent" (fetchQuote) or a hard error (fetchSwapData). */
function buyAmount(data: { buyTokens?: Record<string, { amount?: string }> }, dst: string): string | null {
  const tokens = data?.buyTokens ?? {}
  const match = Object.entries(tokens).find(([addr]) => addr.toLowerCase() === dst.toLowerCase())
  const entry = match?.[1] ?? Object.values(tokens)[0]
  return entry?.amount ?? null
}

async function fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null> {
  // [SPRINT-9H] Demo-mode (no BEBOP_API_KEY) → the JAM firm response carries no
  // executable settlement, so a price quote here would win Best and then fail at
  // swap. Treat it as no executable quote: don't rank Bebop until the key is
  // configured. With the key present the firm path is unchanged.
  if (!AGGREGATOR_APIS.bebop.key) {
    warnBebopKeyMissingOnce()
    return null
  }
  const { src, dst, amount, chainId = DEFAULT_CHAIN_ID } = params
  // Price-only (gross): NO fee params so Bebop ranks fairly vs the other sources.
  const qs = new URLSearchParams({
    sell_tokens: src,
    buy_tokens: dst,
    sell_amounts: amount,
    taker_address: BEBOP_PRICE_TAKER,
    gasless: 'false',
    approval_type: 'Standard',
  })
  if (BEBOP_SOURCE) qs.set('source', BEBOP_SOURCE)

  // [SPRINT-9F bug3] Real upstream failures (HTTP / parse) still THROW so the
  // circuit breaker trips and source-monitoring records the error — identical to
  // every other adapter. Only a no-ROUTE is treated as non-fatal below.
  const res = await fetch(`${bebopQuoteUrl(chainId)}?${qs}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`Bebop ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'Bebop')

  // No usable buy amount = no route for this pair/size, NOT an upstream error.
  // Return null (non-fatal) so Bebop is simply absent and the other sources still
  // surface — instead of "No valid quotes. Bebop: no buyTokens amount" becoming
  // the headline when Bebop is the lone rejection (the reported bug).
  const toAmount = buyAmount(data, dst)
  if (toAmount === null) return null

  return {
    source: 'bebop',
    toAmount,
    estimatedGas: Number(data?.tx?.gas ?? 0),
    gasUsd: Number(data?.gasFee?.usd ?? 0),
    routes: ['Bebop JAM'],
  }
}

async function fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null> {
  const { src, dst, amount, from, slippage, recipient, chainId = DEFAULT_CHAIN_ID } = params
  // Firm quote with the real taker + OUR partner fee (bps + recipient).
  const qs = new URLSearchParams({
    sell_tokens: src,
    buy_tokens: dst,
    sell_amounts: amount,
    taker_address: from,
    receiver_address: recipient ?? from,
    gasless: 'false',
    approval_type: 'Standard',
    slippage: clampSlippage(slippage).toString(),
    fee: String(FEE_BPS),
    fee_recipient: FEE_RECIPIENT,
  })
  if (BEBOP_SOURCE) qs.set('source', BEBOP_SOURCE)

  const res = await fetch(`${bebopQuoteUrl(chainId)}?${qs}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`Bebop swap ${res.status}`)
  const data = await parseJsonOrThrow<any>(res, 'Bebop')

  const settlement: string | undefined = data?.settlementAddress
  const approvalTarget: string | undefined = data?.approvalTarget
  const txTo: string | undefined = data?.tx?.to
  if (!settlement || !approvalTarget || !txTo) {
    // [SPRINT-9H] Fail-soft: a response lacking executable settlement fields
    // (e.g. demo-mode without BEBOP_API_KEY) is "no executable quote", not an
    // error. Return null so it's circuit-breaker-NEUTRAL and never surfaces as a
    // hard "incomplete settlement data" failure. The SECURITY gates below
    // (settlement present-but-wrong / not whitelisted) still fail closed (throw).
    return null
  }

  // ── Security gate (fail closed) ──
  if (txTo.toLowerCase() !== settlement.toLowerCase()) {
    throw new Error('Bebop: tx.to does not match settlementAddress — refusing swap')
  }
  const whitelist = getRouterWhitelist(chainId)
  if (!whitelist.includes(settlement.toLowerCase()) || !whitelist.includes(approvalTarget.toLowerCase())) {
    throw new Error(`Bebop: settlement/approvalTarget not whitelisted on chain ${chainId} — refusing swap`)
  }

  // A firm/executable quote MUST carry an amount — a missing one here is a hard
  // error (unlike the price-only fetchQuote, where no-route is non-fatal).
  const toAmount = buyAmount(data, dst)
  if (toAmount === null) throw new Error('Bebop: no buyTokens amount in response')

  return {
    source: 'bebop',
    toAmount,
    estimatedGas: Number(data?.tx?.gas ?? 0),
    gasUsd: Number(data?.gasFee?.usd ?? 0),
    routes: ['Bebop JAM'],
    tx: {
      to: settlement as `0x${string}`,
      data: data.tx.data,
      // tx.value is hex (e.g. "0x0") — normalize to our decimal-string format.
      value: BigInt(data.tx.value ?? 0).toString(),
      gas: Number(data.tx.gas ?? 0),
    },
  }
}

const adapter: DEXAdapter = {
  name: 'bebop' as const,
  fetchQuote,
  fetchSwapData,
}

export default adapter
