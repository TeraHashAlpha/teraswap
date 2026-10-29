'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { formatUnits } from 'viem'
import ChainIcon from '@/components/icons/ChainIcon'
import { INTEGRATED_DEX_SOURCE_COUNT } from '@/config/product-claims'
import {
  DCA_CUSTOM_BUYS_MAX,
  DCA_CUSTOM_BUYS_MIN,
  DCA_CUSTOM_INTERVAL_NUMBER_MAX,
  DCA_CUSTOM_INTERVAL_NUMBER_MIN,
  DCA_INTERVAL_PRESETS,
  DCA_TOTAL_PRESETS,
  EXPIRY_PRESETS,
  MAX_ORDER_SLIPPAGE_BPS,
  clampCustomBuys,
  clampCustomIntervalNumber,
} from '@/lib/order-engine'
import { perChunkRaw } from '@/lib/dca-quick-fill'
import { fmtPct, fmtToken } from '@/lib/format'
import { playCancelOrderMP3, playSwapConfirmMP3, playTouchMP3, stopWaitingSound } from '@/lib/sounds'
import { trackTrade } from '@/lib/analytics-tracker'
import { useOrderEngine } from '@/hooks/useOrderEngine'
import { useOrderNotifications } from '@/hooks/useOrderNotifications'
import type { CreateOrderConfig } from '@/lib/order-engine'
import { Button, Chip, Input, Segmented, Skeleton, Surface } from '../primitives'
import { Notice } from '../swap/QuotePanel'
import { TokenButton } from '../swap/TokenButton'
import { TokenSheet } from '../modals/TokenSheet'
import { useV2Toast } from '../shell/toasts'
import { DcaOrdersList } from './DcaOrdersList'
import { DcaReviewSheet, type DcaReviewView } from './DcaReviewSheet'
import '../swap/swap.css'
import './dca.css'
import { protectionHint, protectionLabel, sanitizeAmountInput } from './dca-model'
import { useDcaForm, type DcaForm, type PreparedReview } from './use-dca-form'

/** README §3: the thousands separator is a thin space (v1's `fmtToken` groups with U+0020). */
const thin = (s: string) => s.replace(/ /g, '\u2009')

const LABEL = 'font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-muted'

// v1's DCAPanel copy, verbatim.
export const AUTONOMOUS_LEAD = 'Autonomous execution'
export const AUTONOMOUS_BODY = ' — DCA orders run 24/7 via Chainlink oracles. No browser required. Approve once, then sign — no infinite approvals, and the executor runs every buy automatically.'
export const WRAP_HINT = 'DCA spends an ERC-20 token. You hold native ETH — wrap it to WETH first to start a DCA.'
export const IMPORTED_NOTICE = 'Imported token — limited liquidity. We’ll verify a swap route before placing the order.'
export const PAUSED_LEAD = 'DCA temporarily paused.'
export const PAUSED_BODY = ' New DCA orders are paused right now — existing orders are unaffected and you can still cancel them.'
export const DEPEG_BLOCK_TAIL = 'The market price has diverged sharply from the protocol exchange rate — likely a depeg or oracle manipulation. This cannot be overridden. Try again once the prices reconverge.'
export const DEPEG_UNVERIFIED_TAIL = 'We could not get usable price-feed data to check this asset against its exchange rate, so we are not letting the order be created on a price we have not verified. This is not itself a depeg finding — we have not been able to make one either way. It clears once the feeds return good data.'
export const ORACLE_DEVIATION_TAIL = 'The quoted rate and the Chainlink reference price disagree by more than we allow. This is about the price, not about the feed — it clears when they reconverge.'
export const oracleIntegrityTail = (symbol: string) =>
  `This is a problem on our side with the Chainlink price feed for this pair — not a finding about ${symbol}, and not a sign the price moved. Every buy is signed against a minimum-output floor derived from that reference price, so we will not create an order on a price we could not verify. It clears once the feed returns good data.`

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="mt-5">
      <label htmlFor={htmlFor} className={LABEL}>{label}</label>
      {children}
    </div>
  )
}

function Row({ label, children, testId, tone }: { label: ReactNode; children: ReactNode; testId?: string; tone?: 'amber' }) {
  return (
    <div className="ts-swap-row" data-testid={testId}>
      <span className="text-v2-muted">{label}</span>
      <span className={`ts-swap-val font-v2-mono tabular-nums ${tone === 'amber' ? 'text-v2-amber' : 'text-v2-text/90'}`}>{children}</span>
    </div>
  )
}

/** The DCA tab's form (round7 31 / 32 / m04). Everything it shows comes from `useDcaForm` (v1's hooks, unchanged). */
export function DcaCreate({ form, onReviewReady }: { form: DcaForm; onReviewReady: (review: PreparedReview) => void }) {
  const { openConnectModal } = useConnectModal()
  const { switchChain } = useSwitchChain()
  const [picker, setPicker] = useState<'sell' | 'buy' | null>(null)
  const { tokenIn, tokenOut, cta, pairFloor } = form
  const protection = protectionLabel(pairFloor)
  const hint = tokenOut ? protectionHint(pairFloor) : null
  const hasAmount = Number(form.totalDisplay) > 0
  const loadingTier = form.v3Enabled && !!tokenIn && !!tokenOut && !pairFloor
  const oracleReason = form.oracleGate.reason
  const buySymbol = tokenOut?.symbol ?? 'this token'

  async function onCta() {
    playTouchMP3()
    if (cta.kind === 'connect') return void openConnectModal?.()
    if (cta.kind === 'wrong-network') return void switchChain({ chainId: form.chainId })
    if (cta.kind !== 'review') return
    const result = await form.prepare()
    if (result.ok) onReviewReady(result.review)
  }

  return (
    <>
      <div className="ts-dca-form">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-v2-display text-[28px] uppercase leading-none text-v2-text">Dollar Cost Averaging</h2>
          <span className="inline-flex items-center gap-2">
            <ChainIcon chainId={form.chainId} className="h-4 w-4 shrink-0" />
            <span className={LABEL}>{form.chainDisplayName}</span>
          </span>
        </div>

        <Field label="Total to spend" htmlFor="v2-dca-total">
          <div className="ts-swap-field">
            <Input
              id="v2-dca-total"
              scale="amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={form.totalDisplay}
              onChange={(e) => form.setTotalDisplay(sanitizeAmountInput(e.target.value))}
              aria-label="Total to spend"
              invalid={form.insufficient}
            />
            <TokenButton token={tokenIn} side="sell" onOpen={() => setPicker('sell')} />
          </div>
          <div className="mt-1 flex items-center justify-between gap-3 text-[13px] text-v2-muted">
            <span data-testid="dca-spend-balance">Balance: {form.balanceDisplay}</span>
            <span className="flex gap-1">
              {([25, 50, 100] as const).map((p) => (
                <Chip key={p} disabled={form.presetsDisabled} onClick={() => { form.playClick(); form.fillPct(p) }}>
                  {p}%
                </Chip>
              ))}
            </span>
          </div>
          {form.minBuyMessage && <p className="mt-1 text-[12px] text-v2-amber">{form.minBuyMessage}</p>}
          {form.hasNativeOnly && <p className="mt-1 text-[12px] text-v2-muted">{WRAP_HINT}</p>}
          {form.hasImported && !form.routeBlock && (
            <p className="mt-1 text-[12px] text-v2-amber" data-testid="dca-imported-notice">
              <span aria-hidden="true">⚠️ </span>
              {IMPORTED_NOTICE}
            </p>
          )}
          {form.routeBlock && <p className="mt-1 text-[12px] text-v2-red" data-testid="dca-route-block">{form.routeBlock}</p>}
        </Field>

        <div className="mt-2 flex justify-center" aria-hidden="true">
          <span className="text-[18px] text-v2-muted">↓</span>
        </div>

        <Field label="Buy">
          <div className="ts-swap-field">
            <span className="ts-swap-out flex-1 text-right text-[14px] text-v2-muted">Best price at each execution</span>
            <TokenButton token={tokenOut} side="receive" onOpen={() => setPicker('buy')} />
          </div>
          {hint && (
            <p
              className={`mt-2 text-[12px] leading-relaxed ${hint.tier === 'onchain-feed' ? 'text-v2-muted' : 'text-v2-amber'}`}
              data-testid="dca-tier-hint"
              data-tier={hint.tier}
            >
              {hint.text}
            </p>
          )}
        </Field>

        <div className="mt-3 flex flex-col gap-2">
          {form.depegHardBlocked && (
            <Notice tone="red" testId="dca-depeg-block">
              <span className="font-semibold">&#9888; DCA blocked — {form.depegCheck.symbol} depeg.</span> {form.depegCheck.message}
              <span className="mt-1 block text-v2-red/80">{DEPEG_BLOCK_TAIL}</span>
            </Notice>
          )}
          {form.depegUnverified && tokenIn && tokenOut && hasAmount && (
            <Notice tone="red" testId="dca-depeg-unverified">
              <span className="font-semibold">&#9888; DCA paused — price not verified.</span> {form.depegCheck.message}
              <span className="mt-1 block text-v2-red/80">{DEPEG_UNVERIFIED_TAIL}</span>
            </Notice>
          )}
          {form.depegConsentNeeded && (
            <Notice tone="amber" testId="dca-depeg-consent">
              <span className="font-semibold">&#9888; Possible depeg:</span> {form.depegCheck.message}
              <label className="mt-2 flex min-h-[44px] items-center gap-2 text-v2-amber/90">
                <input
                  type="checkbox"
                  checked={form.depegAccepted}
                  onChange={(e) => form.setAcceptedDepeg(e.target.checked ? form.depegCheck.divergence : null)}
                  className="h-5 w-5 accent-[#EADFB6]"
                />
                I understand {form.depegCheck.symbol} may be depegged and want to proceed.
              </label>
            </Notice>
          )}
          {!form.v3Enabled && (
            <Notice tone="cream" testId="dca-chain-unavailable">
              <span className="font-semibold text-v2-text">DCA is not available on {form.chainDisplayName} yet.</span> The order engine does not have an executor deployed on this chain.
            </Notice>
          )}
          {form.oracleBlocked && (
            <Notice tone="red" testId="dca-oracle-block">
              {oracleReason === 'extreme-deviation' ? (
                <>
                  <span className="font-semibold">&#9888; DCA blocked — price moved too far from the oracle.</span> {form.oracleGate.detail}
                  <span className="mt-1 block text-v2-red/80">{ORACLE_DEVIATION_TAIL}</span>
                </>
              ) : (
                <>
                  <span className="font-semibold">&#9888; DCA blocked — price could not be verified.</span> {form.oracleGate.detail}
                  <span className="mt-1 block text-v2-red/80">{oracleIntegrityTail(buySymbol)}</span>
                </>
              )}
            </Notice>
          )}
          {form.submitBlock && (
            <Notice tone="red" testId="dca-submit-block">
              <span className="font-semibold">&#9888; DCA not started.</span> {form.submitBlock}
            </Notice>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between">
          <span className={LABEL}>Number of Buys</span>
          <Button variant="text" onClick={() => { form.setCustomMode(!form.customMode); form.playClick() }} data-testid="dca-custom-toggle">
            {form.customMode ? 'Use presets' : 'Custom'}
          </Button>
        </div>
        {form.customMode ? (
          <div className="flex items-center gap-3">
            <Input
              type="number"
              inputMode="numeric"
              min={DCA_CUSTOM_BUYS_MIN}
              max={DCA_CUSTOM_BUYS_MAX}
              value={form.customBuysRaw}
              onChange={(e) => form.setCustomBuysRaw(Number(e.target.value))}
              onBlur={() => form.setCustomBuysRaw(clampCustomBuys(form.customBuysRaw))}
              data-testid="dca-custom-buys-input"
              aria-label="Number of buys"
              className="w-24"
            />
            <span className="text-[13px] text-v2-muted">buys ({DCA_CUSTOM_BUYS_MIN}–{DCA_CUSTOM_BUYS_MAX})</span>
          </div>
        ) : (
          <div className="ts-dca-chips ts-dca-chips--buys" role="group" aria-label="Number of buys">
            {DCA_TOTAL_PRESETS.map((n, idx) => (
              <Chip key={n} selected={form.partsIdx === idx} onClick={() => { form.setPartsIdx(idx); form.playClick() }}>
                {n}
              </Chip>
            ))}
          </div>
        )}
        {form.customMode && form.minChunkGuard.warning && (
          <p className={`mt-1 text-[12px] ${form.minChunkGuard.blocked ? 'text-v2-red' : 'text-v2-amber'}`} data-testid="dca-min-chunk-warning">
            {form.minChunkGuard.warning}
          </p>
        )}
        {form.minChunkUncheckable && (
          <p className="mt-1 text-[12px] text-v2-amber" data-testid="dca-minchunk-uncheckable">
            The per-chunk minimum could not be checked — {tokenIn?.symbol ?? 'this token'} has no live price right now. The ${form.dcaMinChunkUsd} minimum wasn&apos;t verified, but the base-unit minimum order amount still applies to every buy.
          </p>
        )}

        <Field label="Interval">
          {form.customMode ? (
            <div className="flex flex-wrap items-center gap-3">
              <Input
                type="number"
                inputMode="numeric"
                min={DCA_CUSTOM_INTERVAL_NUMBER_MIN}
                max={DCA_CUSTOM_INTERVAL_NUMBER_MAX}
                value={form.customIntervalNumRaw}
                onChange={(e) => form.setCustomIntervalNumRaw(Number(e.target.value))}
                onBlur={() => form.setCustomIntervalNumRaw(clampCustomIntervalNumber(form.customIntervalNumRaw))}
                data-testid="dca-custom-interval-input"
                aria-label="Interval"
                className="w-20"
              />
              {(['hours', 'days'] as const).map((u) => (
                <Chip key={u} selected={form.customIntervalUnit === u} data-testid={`dca-custom-interval-unit-${u}`} onClick={() => { form.setCustomIntervalUnit(u); form.playClick() }}>
                  {u === 'hours' ? 'Hours' : 'Days'}
                </Chip>
              ))}
            </div>
          ) : (
            <div className="ts-dca-chips" role="group" aria-label="Interval">
              {DCA_INTERVAL_PRESETS.map((iv, idx) => (
                <Chip key={iv.seconds} selected={form.intervalIdx === idx} onClick={() => { form.setIntervalIdx(idx); form.playClick() }}>
                  {iv.label}
                </Chip>
              ))}
            </div>
          )}
        </Field>

        <Field label="Order expiry">
          {form.customMode ? (
            <p className="text-[13px] text-v2-muted" data-testid="dca-custom-expiry-auto">
              Auto: <span className="font-medium text-v2-text">{form.expiry.label}</span> ({form.parts} × {form.interval.label} + buffer)
            </p>
          ) : (
            <div className="ts-dca-chips" role="group" aria-label="Order expiry">
              {EXPIRY_PRESETS.map((e, idx) => (
                <Chip key={e.seconds} selected={form.expiryIdx === idx} onClick={() => { form.setExpiryIdx(idx); form.playClick() }}>
                  {e.label}
                </Chip>
              ))}
            </div>
          )}
          {!form.scheduleFit.fits && (
            <p className="mt-2 text-[12px] text-v2-red" data-testid="dca-expiry-block">{form.scheduleFit.reason}</p>
          )}
        </Field>
      </div>

      <div className="ts-dca-summary">
        <Surface edge="top" aria-busy={loadingTier || undefined}>
          <h3 className={`${LABEL} pt-4`}>Summary</h3>
          <div className="mt-2 flex flex-col">
            <Row label="Per buy" testId="dca-sum-per-buy">{hasAmount && tokenIn ? `${thin(form.perPart)} ${tokenIn.symbol}` : '—'}</Row>
            <Row label="Total duration" testId="dca-sum-duration">{hasAmount ? form.totalDuration : '—'}</Row>
            <Row label="Execution" testId="dca-sum-exec">{hasAmount ? `Every ${form.interval.label}` : '—'}</Row>
            <Row label="Expires" testId="dca-sum-expires">{hasAmount ? form.expiry.label : '—'}</Row>
            <Row label="Protection" testId="dca-sum-protection" tone={protection?.tone === 'amber' ? 'amber' : undefined}>
              {loadingTier ? <Skeleton height={14} width={96} /> : protection ? <span title={protection.title}>{protection.text}</span> : '—'}
            </Row>
          </div>
          <p className="mt-3 text-[12px] text-v2-muted">
            Each buy routes through {INTEGRATED_DEX_SOURCE_COUNT} DEX sources via 1inch aggregation. Orders execute autonomously — no browser needed.
          </p>

          <Button variant="text" className="mt-2" aria-expanded={form.showAdvanced} onClick={() => form.setShowAdvanced(!form.showAdvanced)}>
            <span aria-hidden="true">{form.showAdvanced ? '▾' : '▸'}&nbsp;</span>Advanced settings
          </Button>
          {form.showAdvanced && (
            <div className="mt-2 flex flex-col gap-4">
              <div>
                <span className={LABEL}>Slippage tolerance</span>
                <div className="ts-dca-chips">
                  {['0.3', '0.5', '1.0'].map((s) => (
                    <Chip key={s} selected={form.slippage === s} onClick={() => form.setSlippage(s)}>{s}%</Chip>
                  ))}
                </div>
              </div>
              {form.v3Enabled && (
                <div>
                  <span className={LABEL}>Max output slippage (per fill)</span>
                  <div className="ts-dca-chips">
                    {[100, 300, 500].map((bps) => (
                      <Chip key={bps} selected={form.maxSlippageBps === bps} onClick={() => form.setMaxSlippageBps(Math.min(bps, MAX_ORDER_SLIPPAGE_BPS))}>
                        {fmtPct(bps / 100, 1)}
                      </Chip>
                    ))}
                  </div>
                  {form.signingMin != null && tokenOut && form.parts > 0 && (
                    <p className="mt-2 text-[12px] text-v2-muted">
                      Signed floor per order (total): ≥ {formatUnits(form.signingMin.minAmountOut, tokenOut.decimals)} {tokenOut.symbol} across {form.parts} buys
                      {' '}— ≥ {formatUnits(perChunkRaw(form.signingMin.minAmountOut, form.parts), tokenOut.decimals)} {tokenOut.symbol} enforced per buy
                      {!form.signingMin.hasFeed && (
                        <span className="ml-1 text-v2-amber">
                          (no price reference for this pair — fixed floor, not price-derived; it may strand the order if price rises, or offer weak protection if it falls)
                        </span>
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {form.cta.kind === 'paused' && (
            <div className="mt-3">
              <Notice tone="amber" testId="dca-paused">
                <span className="font-semibold">{PAUSED_LEAD}</span>{PAUSED_BODY}
              </Notice>
            </div>
          )}

          <div className="pt-5">
            <Button
              variant="primary"
              className="w-full"
              disabled={cta.disabled}
              data-cta={cta.kind}
              aria-busy={cta.kind === 'checking-route' || undefined}
              onClick={onCta}
            >
              {cta.label}
            </Button>
          </div>

          <p className="mt-4 text-[12px] leading-relaxed text-v2-muted" data-testid="dca-autonomous">
            <span className="font-semibold text-v2-cream">{AUTONOMOUS_LEAD}</span>
            {AUTONOMOUS_BODY}
          </p>
        </Surface>
      </div>

      {picker && (
        <TokenSheet
          hideNativeInput={picker === 'sell'}
          disabledAddress={(picker === 'sell' ? tokenOut : tokenIn)?.address}
          onSelect={(t) => (picker === 'sell' ? form.setTokenIn(t) : form.setBuySelection(t))}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  )
}

/** What the review sheet prints for a prepared review: the form's own display strings, plus the signed floor when v3 derived one. */
export function reviewViewFor(form: DcaForm, review: PreparedReview): DcaReviewView {
  const { draft } = review
  const floor = form.v3Enabled && draft.minAmountOut !== '1' ? BigInt(draft.minAmountOut) : null
  return {
    symbolIn: draft.tokenIn.symbol,
    symbolOut: draft.tokenOut.symbol,
    chainName: form.chainDisplayName,
    total: thin(fmtToken(BigInt(draft.amountIn), draft.tokenIn.decimals)),
    perBuy: thin(form.perPart),
    buys: form.parts,
    every: form.interval.label,
    duration: form.totalDuration,
    expires: form.expiry.label,
    floorTotal: floor == null ? null : thin(fmtToken(floor, draft.tokenOut.decimals)),
    floorPerBuy: floor == null || form.parts <= 0 ? null : thin(fmtToken(perChunkRaw(floor, form.parts), draft.tokenOut.decimals)),
  }
}

const ACTIVE_STATUSES = ['active', 'executing', 'partially_filled', 'signing']
const HISTORY_STATUSES = ['filled', 'expired', 'cancelled', 'error']

/** v1's freeze-403 message starts "New DCA orders are temporarily paused…". */
const DCA_PAUSED_RE = /temporarily paused/i

/**
 * The DCA tab (round7 30b / 31 / 35). `chainId` is the SELECTED chain (v1 passes the selector chain, not wagmi's). The order list and the
 * cancel actions are v1's `useOrderEngine`, unchanged; the Create CTA ends in a STUB (the review's `Create DCA`) — B6b wires signing.
 */
export function DcaCard({ chainId, onCreate }: { chainId: number; onCreate?: (draft: CreateOrderConfig) => void }) {
  const { address } = useAccount()
  const { dcaOrders, latestEvent, cancelOrder, cancelAllOrders, removeOrder } = useOrderEngine()
  const { toast } = useV2Toast()
  const [frozen, setFrozen] = useState(false)
  const [tab, setTab] = useState<'create' | 'positions'>('create')
  const [review, setReview] = useState<PreparedReview | null>(null)
  const form = useDcaForm(chainId, frozen)
  useOrderNotifications(latestEvent)
  // v1 latches `frozen` on the freeze-403 inside its event effect; the same latch, set while rendering the event in (no effect-set).
  const [seenEvent, setSeenEvent] = useState(latestEvent)
  if (latestEvent !== seenEvent) {
    setSeenEvent(latestEvent)
    if (latestEvent?.type === 'order_error' && DCA_PAUSED_RE.test(latestEvent.error || '')) setFrozen(true)
  }

  // v1's sound + toast per engine event (DCAPanel), same calls, same copy.
  useEffect(() => {
    if (!latestEvent) return
    if (latestEvent.type === 'order_created') {
      stopWaitingSound()
      playSwapConfirmMP3()
      toast({ type: 'success', title: 'DCA order placed', description: 'Your DCA is live — it will execute automatically on schedule.' })
    }
    if (latestEvent.type === 'dca_execution') {
      playSwapConfirmMP3()
      toast({ type: 'success', title: 'DCA buy executed', description: `Buy #${latestEvent.executionNumber} completed autonomously.` })
    }
    if (latestEvent.type === 'order_filled') {
      playSwapConfirmMP3()
      toast({ type: 'success', title: 'DCA complete!', description: 'All DCA buys executed successfully.', txHash: latestEvent.txHash, duration: 10000 })
      if (address) {
        trackTrade({ type: 'dca_buy', wallet: address, tokenIn: '', tokenInAddress: '', tokenOut: '', tokenOutAddress: '', amountIn: '0', amountOut: '0', volumeUsd: 0, source: 'teraswap_order_engine', txHash: latestEvent.txHash || '' })
      }
    }
    if (latestEvent.type === 'order_cancelled') {
      playCancelOrderMP3()
      toast({ type: 'success', title: 'DCA order cancelled', description: 'Your DCA order has been cancelled on-chain.' })
    }
    if (latestEvent.type === 'order_error') {
      stopWaitingSound()
      playCancelOrderMP3()
      if (DCA_PAUSED_RE.test(latestEvent.error || '')) {
        toast({ type: 'error', title: 'DCA temporarily paused', description: 'Only new DCA orders are paused — your existing ones keep running.' })
      } else {
        toast({ type: 'error', title: 'DCA order failed', description: latestEvent.error || 'Order could not be submitted.' })
      }
    }
    // v1 depends on the event alone: re-running on a new toast identity would replay the sound.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestEvent])

  const active = dcaOrders.filter((o) => ACTIVE_STATUSES.includes(o.status))
  const history = dcaOrders.filter((o) => HISTORY_STATUSES.includes(o.status))

  return (
    <section data-dca-card="" aria-label="DCA" className="ts-dca">
      <div className="ts-dca-tabs">
        <Segmented
          label="DCA"
          active={tab}
          onSelect={(id) => setTab(id as 'create' | 'positions')}
          tabs={[
            { id: 'create', label: 'New DCA' },
            { id: 'positions', label: `Positions${active.length > 0 ? ` (${active.length})` : ''}` },
          ]}
        />
      </div>
      {tab === 'create' ? (
        <DcaCreate form={form} onReviewReady={setReview} />
      ) : (
        <div className="ts-dca-wide">
          <DcaOrdersList
            active={active}
            history={history}
            latestEvent={latestEvent}
            connectedChainId={chainId}
            onCancel={cancelOrder}
            onCancelAll={cancelAllOrders}
            onRemove={removeOrder}
            onCreate={() => setTab('create')}
          />
        </div>
      )}
      {review && <DcaReviewSheet review={review} view={reviewViewFor(form, review)} onCreate={onCreate} onClose={() => setReview(null)} />}
    </section>
  )
}
