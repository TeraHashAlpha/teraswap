/**
 * [ADR-025] The DCA tab's pure decisions (B6a). v1 keeps its DCA form state inside an unexported `CreateDCAForm` in DCAPanel.tsx,
 * so there is no v1 hook to import for it: this module restates the SAME derivations from v1's own lib functions (presets, bigint
 * split, schedule-fit, floor-tier copy) and `dca-draft-parity.test.tsx` renders v1 and v2 against one set of mocked answers and
 * compares the draft each builds. Display + form only — nothing here signs, sends or fetches.
 */
import { formatUnits, parseUnits } from 'viem'
import {
  OrderType,
  PriceCondition,
  DCA_NO_PRICE_FILL_CAP_MAX_USD,
  type CreateOrderConfig,
  type DcaFloorTier,
} from '@/lib/order-engine'
import { fmtFixed, fmtToken } from '@/lib/format'
import { perChunkRaw } from '@/lib/dca-quick-fill'
import { evaluatePriceGate, type PriceGateReason } from '@/lib/price-gate'
import type { PriceCheck } from '@/lib/chainlink'
import type { PairFloorInfo } from '@/components/dca/pair-floor-info'
import { FLOOR_TIER_BADGE } from '@/components/dca/FloorTierBadge'
import { floorConsentCopy } from '@/components/dca/DcaFloorConsentDialog'
import { floorTierHint } from '@/components/dca/pair-floor-info'

export type WeakerTier = Exclude<DcaFloorTier, 'onchain-feed'>

/** v1's amount input filter: digits and one dot. */
export function sanitizeAmountInput(raw: string): string {
  const v = raw.replace(/[^0-9.]/g, '')
  const parts = v.split('.')
  return parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : v
}

/** v1's `totalDuration` text (hours below a day, days below 30, else months). */
export function totalDurationText(parts: number, intervalSeconds: number): string {
  if (!parts || parts <= 0) return ''
  const hours = (parts * intervalSeconds) / 3600
  if (hours < 24) return `${fmtFixed(hours, 0)} hours`
  const days = hours / 24
  if (days < 30) return `${fmtFixed(days, 1)} days`
  return `${fmtFixed(days / 30, 1)} months`
}

/** v1's `perPart`: the bigint floor split, rendered by `fmtToken`; '0' while there is nothing to split. */
export function perBuyText(totalDisplay: string, decimals: number | undefined, parts: number): string {
  if (!parts || parts <= 0 || decimals === undefined) return '0'
  try {
    const raw = parseUnits(totalDisplay, decimals)
    return raw > 0n ? fmtToken(perChunkRaw(raw, parts), decimals) : '0'
  } catch {
    return '0'
  }
}

/** The raw amount, or null when it is empty / malformed (too many decimals). */
export function parseTotal(totalDisplay: string, decimals: number | undefined): bigint | null {
  if (!totalDisplay || decimals === undefined) return null
  try {
    return parseUnits(totalDisplay, decimals)
  } catch {
    return null
  }
}

export function formatRaw(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals)
}

// ── the order draft ──────────────────────────────────────────────────────────

export interface DraftInput {
  tokenIn: { address: string; symbol: string; decimals: number }
  tokenOut: { address: string; symbol: string; decimals: number }
  /** parseUnits(total).toString() */
  amountIn: string
  minAmountOut: string
  /** Only on the v3 path (v1 spreads it in only when v3Enabled). */
  maxSlippageBps?: number
  expirySeconds: number
  router: string
  priceInUsd: number | null
  dcaInterval: number
  dcaTotal: number
  floorAck?: { tier: WeakerTier; acknowledgedAt: string }
}

/** v1's `CreateOrderConfig` for a DCA, field for field (DCAPanel.handleCreate). DCA never carries a price condition: priceFeed = address(0). */
export function buildDcaDraft(i: DraftInput): CreateOrderConfig {
  return {
    tokenIn: { address: i.tokenIn.address, symbol: i.tokenIn.symbol, decimals: i.tokenIn.decimals },
    tokenOut: { address: i.tokenOut.address, symbol: i.tokenOut.symbol, decimals: i.tokenOut.decimals },
    amountIn: i.amountIn,
    minAmountOut: i.minAmountOut,
    ...(i.maxSlippageBps !== undefined ? { maxSlippageBps: i.maxSlippageBps } : {}),
    orderType: OrderType.DCA,
    condition: PriceCondition.ABOVE,
    targetPrice: '0',
    priceFeed: '0x0000000000000000000000000000000000000000',
    expirySeconds: i.expirySeconds,
    router: i.router,
    priceInUsd: i.priceInUsd,
    dcaInterval: i.dcaInterval,
    dcaTotal: i.dcaTotal,
    ...(i.floorAck ? { floorAck: i.floorAck } : {}),
  }
}

// ── the CTA ──────────────────────────────────────────────────────────────────

export type DcaCtaKind =
  | 'connect'
  | 'wrong-network'
  | 'paused'
  | 'select-tokens'
  | 'enter-amount'
  | 'insufficient-balance'
  | 'below-floor'
  | 'checking-route'
  | 'blocked'
  | 'review'

export interface DcaCtaInput {
  isConnected: boolean
  /** The wallet's chain is not the selected one. */
  wrongNetwork: boolean
  targetChainName: string
  paused: boolean
  hasTokens: boolean
  hasAmount: boolean
  /** Balance known AND below the amount (v1 does not gate on balance; v2 only disables when it KNOWS the wallet is short). */
  insufficient: boolean
  /** The per-buy amount is under v1's MIN_ORDER_AMOUNT floor. */
  belowFloor: boolean
  checkingRoute: boolean
  /** v1's `canCreate` minus the states above (schedule fit, dust guard, depeg, oracle, submit block, floor tier not answered). */
  blocked: boolean
}

export interface DcaCta {
  kind: DcaCtaKind
  label: string
  disabled: boolean
}

/**
 * Order = v1's CreateDCAForm (not connected → … → label by tokens / amount), with the owner's list inserted where it applies.
 * v1's labels are kept ("DCA temporarily paused", "Select Tokens", "Enter Amount", "Checking route…"); the review click is
 * "Review DCA" (the B6a sheet is what it opens; v1's "Start DCA — N buys over …" signs straight into its own review modal).
 */
export function dcaCtaFor(i: DcaCtaInput): DcaCta {
  if (!i.isConnected) return { kind: 'connect', label: 'Connect wallet', disabled: false }
  if (i.wrongNetwork) return { kind: 'wrong-network', label: `Switch to ${i.targetChainName}`, disabled: false }
  if (i.paused) return { kind: 'paused', label: 'DCA temporarily paused', disabled: true }
  if (!i.hasTokens) return { kind: 'select-tokens', label: 'Select Tokens', disabled: true }
  if (!i.hasAmount) return { kind: 'enter-amount', label: 'Enter Amount', disabled: true }
  if (i.insufficient) return { kind: 'insufficient-balance', label: 'Insufficient balance', disabled: true }
  if (i.checkingRoute) return { kind: 'checking-route', label: 'Checking route…', disabled: true }
  if (i.belowFloor) return { kind: 'below-floor', label: 'Below minimum buy', disabled: true }
  if (i.blocked) return { kind: 'blocked', label: 'Review DCA', disabled: true }
  return { kind: 'review', label: 'Review DCA', disabled: false }
}

// ── protection / cap / consent (the server's tier is the authority) ───────────

/** v1's cap: the server's effective cap clamped to the ceiling, never a literal. */
export function capUsd(info: PairFloorInfo | null): number {
  const c = info?.effectiveCap
  return typeof c === 'number' && Number.isFinite(c) && c > 0 ? Math.min(c, DCA_NO_PRICE_FILL_CAP_MAX_USD) : DCA_NO_PRICE_FILL_CAP_MAX_USD
}

/** The Summary's "Protection" value, ONLY from v1's own strings (FLOOR_TIER_BADGE): null while the server has not answered, and for the on-chain feed (v1's badge renders nothing there — no frame copy). */
export function protectionLabel(info: PairFloorInfo | null): { text: string; tone: 'amber'; title?: string } | null {
  if (!info) return null
  if (info.tier === 'onchain-feed') return null
  const b = FLOOR_TIER_BADGE[info.tier]
  return { text: b.label, tone: 'amber', title: b.title }
}

/** v1's note under the BUY selector (also the cap line for the unpriced tier): `floorTierHint`, verbatim. */
export function protectionHint(info: PairFloorInfo | null): { text: string; tier: DcaFloorTier } | null {
  const text = floorTierHint(info)
  return text && info ? { text, tier: info.tier } : null
}

/** Consent is required for BOTH weaker tiers (v1: DcaFloorConsentDialog opens for offchain-price and unpriced). */
export function consentTier(info: PairFloorInfo | null): WeakerTier | null {
  return info && info.tier !== 'onchain-feed' ? info.tier : null
}

const RANK: Record<DcaFloorTier, number> = { 'onchain-feed': 0, 'offchain-price': 1, unpriced: 2 }

/**
 * The server answers 409 `{ requiredTier }` when the acknowledged tier is weaker than the one it computes (api/orders). v1 shows
 * that as an error toast; v2 reopens the consent for the tier the server named — never for a weaker one than already shown.
 * Pure: B6b calls it with the 409 body. Returns the tier the review must now ask about, or null when nothing changes.
 */
export function reopenTier(current: WeakerTier | null, requiredTier: string | undefined): WeakerTier | null {
  if (requiredTier !== 'offchain-price' && requiredTier !== 'unpriced') return null
  if (current && RANK[requiredTier] <= RANK[current]) return null
  return requiredTier
}

/** v1's consent body, verbatim (`floorConsentCopy`), with the real {N} / symbols / cap. */
export function consentBody(info: PairFloorInfo, symbols: readonly string[]): string {
  const tier = consentTier(info)
  if (!tier) return ''
  return floorConsentCopy({ tier, symbols, effectiveCapUsd: info.effectiveCap, registeredFeedCount: info.registeredFeedCount })
}

/**
 * [B6b] The server's 409 (api/orders): `Acknowledgement required: this pair is "<tier>". Resubmit with floorAck.tier = "<tier>".`
 * v1's API client keeps only `json.error` of that body (order-engine/supabase.ts `throw new Error(json.error …)`) and the engine
 * surfaces it as an `order_error` (useOrderEngine `err.message.slice(0, 120)` — the sentence is 85 characters); the `requiredTier`
 * field itself never reaches the UI. The tier is read back from the server's own sentence, so the review can reopen for it.
 */
const REQUIRED_TIER_RE = /^Acknowledgement required: this pair is "(offchain-price|unpriced)"\./
export function requiredTierFromError(error: string | null | undefined): WeakerTier | null {
  const m = error ? REQUIRED_TIER_RE.exec(error) : null
  return m ? (m[1] as WeakerTier) : null
}

/**
 * [A70 L-1] What the review reopens for after an `order_error`. The server's own 409 sentence names the tier (`requiredTierFromError`).
 * A sentence that STARTS like that 409 ("Acknowledgement required…") but does not parse — the server's wording changed, the text was cut —
 * is still the server saying a stronger acknowledgement is due, tier unknown: it reopens at `unpriced`, the strictest, never as a plain
 * failure whose Retry would resend the weak ack that was just refused. Any other error returns null (a plain failure).
 */
const ACK_REQUIRED_PREFIX_RE = /^Acknowledgement required/
export function reopenTierFromError(error: string | null | undefined): WeakerTier | null {
  const tier = requiredTierFromError(error)
  if (tier) return tier
  return error && ACK_REQUIRED_PREFIX_RE.test(error) ? 'unpriced' : null
}

// ── the sign step (round7 34) ────────────────────────────────────────────────

/** Where the frozen order is: on the EIP-712 review, with the wallet (sign + POST — v1 exposes no boundary between the two), placed, or failed. */
export type DcaSignPhase = 'frozen' | 'signing' | 'created' | 'failed'

export interface SignStep {
  label: string
  state: 'done' | 'active' | 'todo' | 'failed'
}

/**
 * The sign sheet's timeline, in v1's own words: the approve button (`Approve {sym}`, OrderReviewModal), the form CTA while the engine
 * submits (`Signing order...`, DCAPanel) and the success toast's title (`DCA order placed`). The approve step is listed only when the
 * sheet opened on an order that still needed the exact approval (v1 renders that button XOR the sign button).
 */
export function signSteps(i: { phase: DcaSignPhase; approvalListed: boolean; approvalReady: boolean; symbolIn: string }): SignStep[] {
  const steps: SignStep[] = []
  if (i.approvalListed) {
    steps.push({ label: `Approve ${i.symbolIn}`, state: i.phase === 'frozen' ? (i.approvalReady ? 'done' : 'active') : 'done' })
  }
  const signState: SignStep['state'] =
    i.phase === 'signing' ? 'active' : i.phase === 'created' ? 'done' : i.phase === 'failed' ? 'failed' : i.approvalListed && !i.approvalReady ? 'todo' : 'active'
  steps.push({ label: 'Signing order...', state: signState })
  steps.push({ label: 'DCA order placed', state: i.phase === 'created' ? 'done' : 'todo' })
  return steps
}

/** v1's DCAPanel event effect: the freeze-403 is told as a pause, everything else as a failure. Same titles, same descriptions. */
export const DCA_PAUSED_RE = /temporarily paused/i
export function failureCopy(error: string | null): { title: string; description: string } {
  if (DCA_PAUSED_RE.test(error || '')) return { title: 'DCA temporarily paused', description: 'Only new DCA orders are paused — your existing ones keep running.' }
  return { title: 'DCA order failed', description: error || 'Order could not be submitted.' }
}

// ── the oracle gate ──────────────────────────────────────────────────────────

export interface DcaOracleGate {
  blocked: boolean
  reason: PriceGateReason
  detail: string | null
}

/** DCAPanel's `evaluateDcaOracleGate`: each leg through the swap flow's own `evaluatePriceGate`; either leg blocking poisons the ratio. */
export function evaluateDcaOracleGate(spend: PriceCheck, buy: PriceCheck): DcaOracleGate {
  for (const check of [spend, buy]) {
    const gate = evaluatePriceGate(check)
    if (gate.mode === 'block') return { blocked: true, reason: gate.reason, detail: check.message }
  }
  return { blocked: false, reason: 'none', detail: null }
}
