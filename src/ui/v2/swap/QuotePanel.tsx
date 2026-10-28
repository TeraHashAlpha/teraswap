'use client'

import { useId, useState, type ReactNode } from 'react'
import type { MetaQuoteResult } from '@/lib/adapters/types'
import type { ApprovalPlan } from '@/lib/approvals'
import type { PriceCheck } from '@/lib/chainlink'
import { fmtUsd } from '@/lib/format'
import { Button, Surface } from '../primitives'
import { Tip } from './Tip'
import { priceImpact, type QuoteView } from './quote-model'

const RATE_KEY = 'teraswap:rateInverted' // v1's key: one reading direction across v1 and v2

function readInverted(): boolean {
  try {
    return sessionStorage.getItem(RATE_KEY) === '1'
  } catch {
    return false
  }
}

/** A calm text notice: 2 px accent rule on the left, no fill, no border (round 7: boxes are gone). */
export function Notice({ tone, testId, children }: { tone: 'amber' | 'red' | 'cream' | 'green' | 'teal'; testId?: string; children: ReactNode }) {
  const rule = { amber: 'border-v2-amber', red: 'border-v2-red', cream: 'border-v2-cream', green: 'border-v2-green', teal: 'border-v2-teal' }[tone]
  return (
    <Surface data-testid={testId} className={`border-l-2 ${rule} py-1 pl-3 text-[13px] leading-snug text-v2-text/90`}>
      {children}
    </Surface>
  )
}

function Row({ label, children, strong = false, tone }: { label: ReactNode; children: ReactNode; strong?: boolean; tone?: 'danger' | 'warn' | 'green' }) {
  const color = tone === 'danger' ? 'text-v2-red' : tone === 'warn' ? 'text-v2-amber' : tone === 'green' ? 'text-v2-green' : 'text-v2-text/90'
  return (
    <div className="ts-swap-row">
      <span className={strong ? 'font-semibold text-v2-text' : 'text-v2-muted'}>{label}</span>
      <span className={`ts-swap-val font-v2-mono tabular-nums ${strong ? 'font-semibold text-v2-text' : color}`}>{children}</span>
    </div>
  )
}

export interface QuotePanelProps {
  view: QuoteView
  symbolIn: string
  symbolOut: string
  countdown: number
  onRefresh: () => void
  refreshing: boolean
  priceCheck: PriceCheck
  approvalPlan: ApprovalPlan | null
  /** Max-slippage ✎ — the editor itself is a B4 modal. */
  onEditSlippage: () => void
  smartMevApplied: boolean
  gasless: MetaQuoteResult['gasless']
  lowConfidence: boolean
  sourceCount: number
  onUseGasless: () => void
  /** Tier notice (commit 2) — rendered with the other price notices, above the breakdown. */
  tierNotice?: ReactNode
}

/** The right column of the Swap tab (round7 20): "Best via X", the rows, "+Δ vs second best", the Compare disclosure. */
export function QuotePanel(p: QuotePanelProps) {
  const { view: v, priceCheck, approvalPlan } = p
  // The panel only exists once a quote has arrived (client state), so reading storage / the viewport here cannot mismatch SSR.
  const [inverted, setInverted] = useState(readInverted)
  // m02: the disclosure starts closed on a phone, open on a desktop (the rows stay in the DOM either way).
  const [compareOpen, setCompareOpen] = useState(() => !(typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 600px)').matches))
  const compareId = useId()

  const flip = () =>
    setInverted((prev) => {
      const next = !prev
      try {
        sessionStorage.setItem(RATE_KEY, next ? '1' : '0')
      } catch {
        /* session-only is fine */
      }
      return next
    })

  const impact = priceImpact(priceCheck)
  const rateTitle = priceCheck.oracleReadFailed
    ? `⚠ Chainlink feed could not be read — price NOT independently verified. This is a temporary feed/network problem, not a property of ${p.symbolIn}.`
    : priceCheck.oracleUnavailable
      ? `⚠ No Chainlink oracle for ${p.symbolIn} — price NOT independently verified. Risk of mispricing on wrapped/exotic tokens.`
      : priceCheck.chainlinkPrice != null
        ? `✓ Verified by Chainlink (${fmtUsd(priceCheck.chainlinkPrice)})`
        : undefined

  return (
    <div id="quote-breakdown" data-quote-panel="" className="flex flex-col gap-3">
      {priceCheck.level === 'danger' && <Notice tone="red">{priceCheck.message}</Notice>}
      {priceCheck.level === 'warn' && !priceCheck.oracleUnavailable && priceCheck.message && <Notice tone="amber">{priceCheck.message}</Notice>}
      {priceCheck.oracleUnavailable && priceCheck.oracleReadFailed && (
        <Notice tone="amber" testId="oracle-read-failed-notice">
          <span className="font-semibold">&#9888; Price not verified</span> — the Chainlink feed could not be read right now. This is not a problem with the
          token: we simply could not reach the oracle, so this price has not been independently verified. It clears as soon as the feed responds.
        </Notice>
      )}
      {p.tierNotice}
      {p.lowConfidence && (
        <Notice tone="cream">
          <span className="font-semibold">Low confidence</span> — only {p.sourceCount} {p.sourceCount === 1 ? 'source' : 'sources'} responded with a usable
          quote, so this price couldn&apos;t be cross-checked. Your swap is still protected by the on-chain <strong>minimum-output</strong> guarantee —
          double-check the rate looks right before swapping.
        </Notice>
      )}
      {p.gasless?.recommended && !v.intentBased && (
        <section aria-label="Gasless route recommendation" className="border-l-2 border-v2-teal py-1 pl-3">
          <p className="text-[14px] font-semibold text-v2-text">&#9889; Zero Gas Available</p>
          <p className="mt-0.5 text-[13px] text-v2-text/90">
            {p.gasless.gasSavingsUsd >= 0.5 ? `Save ~${fmtUsd(p.gasless.gasSavingsUsd)} in gas fees by using CoW Protocol.` : 'Use CoW Protocol for a fully gasless swap.'}{' '}
            Your swap is fully MEV-protected.
          </p>
          <div className="mt-1 flex items-center gap-3">
            <Button variant="text" onClick={p.onUseGasless} aria-label="Switch to the gasless CoW Protocol route">
              Use Gasless Route
            </Button>
            <span className="text-[12px] text-v2-muted">or keep current</span>
          </div>
        </section>
      )}
      {p.gasless?.recommended && v.intentBased && (
        <Notice tone="teal" testId="gasless-confirm">
          <span role="status">
            <span className="font-semibold">&#10003; You&apos;re using the gasless route</span>
            {p.gasless.gasSavingsUsd >= 0.5 && <span> — saving ~{fmtUsd(p.gasless.gasSavingsUsd)} in gas.</span>}
          </span>
        </Notice>
      )}

      {p.smartMevApplied && (
        <p className="text-[12px] text-v2-text/90">
          ✦ Smart-routed via CoW {p.gasless && p.gasless.gasSavingsUsd >= 0.5 ? `(gasless, ~${fmtUsd(p.gasless.gasSavingsUsd)} saved)` : '(MEV protected)'}
        </p>
      )}

      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[15px] font-medium text-v2-green">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-v2-green" />
          Best via {v.bestLabel}
          {p.smartMevApplied && (
            <span
              className="text-[11px] font-normal text-v2-muted"
              title="CoW Protocol's price was within 0.3% of the highest quote, so TeraSwap routed through it for MEV protection."
            >
              · auto-selected for MEV protection
            </span>
          )}
        </span>
        <span className="flex items-center gap-1 font-v2-mono text-[12px] uppercase tracking-[1.5px] text-v2-muted">
          {p.countdown}s
          <Button variant="icon" onClick={p.onRefresh} disabled={p.refreshing} aria-label="Refresh quote" title="Refresh quote">
            <span aria-hidden="true" className={`text-[18px] ${p.refreshing ? 'inline-block animate-spin' : 'inline-block'}`}>⟳</span>
          </Button>
        </span>
      </div>

      {(v.direct || v.mevProtected || v.intentBased || v.gaslessBadge) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-v2-mono text-[11px] uppercase tracking-[1.5px]">
          {v.direct && <span className="text-v2-amber">Direct DEX</span>}
          {v.mevProtected && <span className="text-v2-cream">MEV Protected</span>}
          {v.intentBased && <span className="text-v2-teal">Intent-Based</span>}
          {v.gaslessBadge && <span className="text-v2-teal">Gasless</span>}
        </div>
      )}

      {v.intentBased && v.executionSeconds ? (
        <p className="text-[13px] text-v2-text/90">
          <span className="font-medium">Execution time: ~{v.executionSeconds}s</span>
          <span className="text-v2-muted"> — Solvers compete in batch auctions for the best fill. Your trade is fully protected from MEV (frontrunning, sandwich attacks).</span>
        </p>
      ) : null}

      <div className="ts-swap-rows">
        <div className="ts-swap-row">
          <span className="text-v2-muted" title={rateTitle}>
            Rate {priceCheck.oracleUnavailable && <span className="text-v2-amber">&#9888;</span>}
            {priceCheck.chainlinkPrice != null && !priceCheck.oracleUnavailable && <span className="text-v2-green">&#10003;</span>}
          </span>
          <button
            type="button"
            onClick={flip}
            aria-label="Flip rate direction"
            title="Click to flip the rate direction"
            className="ts-swap-val inline-flex min-h-[44px] items-center gap-1 font-v2-mono tabular-nums text-v2-text/90 hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal"
          >
            {inverted ? `1 ${p.symbolOut} = ${v.inverseRate} ${p.symbolIn}` : `1 ${p.symbolIn} = ${v.rate} ${p.symbolOut}`}
            <span aria-hidden="true" className="text-v2-muted">&#8644;</span>
          </button>
        </div>

        {v.mevSavings && (
          <div
            className="ts-swap-row"
            title="Difference between CoW Protocol's quote and the median of the non-CoW (public-mempool) quotes for this pair. A rough lower-bound estimate of what MEV bots could have extracted on a non-protected route."
          >
            <span className="text-v2-muted">Est. MEV savings</span>
            <span className="ts-swap-val font-v2-mono tabular-nums text-v2-green">{v.mevSavings}</span>
          </div>
        )}

        <Row label="Route">
          <span className="ts-swap-route">{v.route}</span>
        </Row>

        {v.uniswapFee && (
          <div>
            <Row
              label={
                <span className="inline-flex items-center gap-1">
                  Pool fee tier
                  <Tip
                    label="Pool fee tier info"
                    content="Uniswap V3 pools charge a fee on every swap. Each token pair can have multiple pools with different fee tiers (0.01%, 0.05%, 0.3%, 1%). TeraSwap automatically picks the pool with the best output for you."
                  />
                </span>
              }
            >
              {v.uniswapFee.tier}
              {v.uniswapFee.reason && <span className="ml-1 font-normal text-v2-muted">({v.uniswapFee.reason})</span>}
            </Row>
            {v.uniswapFee.candidates.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-3 font-v2-mono text-[11px]">
                {v.uniswapFee.candidates.map((c) => (
                  <span key={c.fee} className={c.best ? 'font-bold text-v2-cream' : c.ok ? 'text-v2-muted' : 'text-v2-dim line-through'}>
                    {c.fee}
                    {c.ok ? '' : ' N/A'}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="ts-swap-row">
          <span className="text-v2-muted">Max slippage</span>
          <button
            type="button"
            onClick={p.onEditSlippage}
            data-b4-stub="slippage-modal"
            className="ts-swap-val inline-flex min-h-[44px] items-center gap-1 font-v2-mono tabular-nums text-v2-text/90 hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal"
          >
            {v.slippage} <span aria-hidden="true">&#9998;</span>
          </button>
        </div>
      </div>

      <div className="ts-swap-rows ts-rule-t">
        <Row label="Est. gas" tone={v.gasFree ? 'green' : undefined}>
          {v.gas}
        </Row>
        <div data-fee-mode={v.feeMode} className="ts-swap-row">
          <span className="inline-flex items-center gap-1 text-v2-muted">
            {v.feeLabel}
            <Tip
              label="Platform fee info"
              content={v.feeCollected ? 'This fee supports platform development. Collected by the aggregator API.' : 'No fee for this route. Fees are collected on 1inch, 0x, and KyberSwap routes.'}
            />
          </span>
          {v.feeCollected ? (
            <span className="ts-swap-val font-v2-mono tabular-nums text-v2-text/90">{v.feeValue}</span>
          ) : (
            <span className="ts-swap-val font-v2-mono text-v2-green">Free</span>
          )}
        </div>
        {approvalPlan && approvalPlan.extraGas === 0 && (
          <Row label="Approval" tone="green">
            {approvalPlan.label}
          </Row>
        )}
        {approvalPlan?.method === 'permit2' && (
          <p className="py-1 text-[12px] leading-relaxed text-v2-muted">
            <span className="font-semibold text-v2-text/90">Permit2 Signature</span> — Deadline capped at 30 min. Never sign Permit2 requests from unknown dApps.
          </p>
        )}
        {impact && (
          <Row
            label={
              <span className="inline-flex items-center gap-1">
                Price impact
                <Tip label="Price impact info" content="Estimated impact based on Chainlink oracle vs execution price. Higher impact means your trade is large relative to available liquidity." />
              </span>
            }
            tone={impact.tone === 'danger' ? 'danger' : impact.tone === 'warn' ? 'warn' : undefined}
          >
            {impact.text}
          </Row>
        )}
      </div>

      <div className="ts-swap-rows ts-rule-t">
        <Row label="Min. output" strong>
          {v.minOutput} {p.symbolOut}
        </Row>
        {v.delta && <p className="py-1 text-right font-v2-mono text-[13px] font-semibold text-v2-green">{v.delta}</p>}
      </div>

      {v.compare.length > 1 && (
        <div>
          <button
            type="button"
            aria-expanded={compareOpen}
            aria-controls={compareId}
            onClick={() => setCompareOpen((o) => !o)}
            className="ts-swap-compare inline-flex min-h-[44px] items-center gap-2 font-v2-mono text-[12px] font-medium uppercase tracking-[1.5px] text-v2-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal"
          >
            Compare ({v.compare.length} sources)
            <svg aria-hidden="true" viewBox="0 0 12 12" width="12" height="12" className={`ts-swap-chev ${compareOpen ? 'is-open' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 4.5 6 8l4-3.5" />
            </svg>
          </button>
          <ul id={compareId} hidden={!compareOpen} className="ts-swap-compare-list ts-rule-l">
            {v.compare.map((q) => (
              <li key={q.source} data-best={q.isBest ? '' : undefined} className={`ts-swap-row ${q.isBest ? 'text-v2-green' : 'text-v2-muted'}`}>
                <span className="flex flex-wrap items-center gap-x-2">
                  {q.isBest && <span>&#10003;</span>}
                  {q.label}
                  {q.direct && (
                    <span className="font-v2-mono text-[10px] uppercase tracking-[1.5px] text-v2-amber" title="Direct on-chain swap — no API middleman">
                      Direct
                    </span>
                  )}
                  {q.quoteOnly && (
                    <span
                      className="font-v2-mono text-[10px] uppercase tracking-[1.5px] text-v2-muted"
                      title="Price shown for comparison — this source can't settle swaps on this network yet, so it is never used for execution."
                    >
                      Quote only
                    </span>
                  )}
                  {q.poolFee && (
                    <span className="font-v2-mono text-[10px] text-v2-amber" title={`Pool fee: ${q.poolFee}`}>
                      {q.poolFee}
                    </span>
                  )}
                  {q.mev && (
                    <span className="font-v2-mono text-[10px] uppercase tracking-[1.5px] text-v2-cream" title="MEV Protected — no frontrunning or sandwich attacks">
                      MEV
                    </span>
                  )}
                  {q.time && (
                    <span className="font-v2-mono text-[10px] text-v2-teal" title={`Intent-based: ${q.time} execution`}>
                      {q.time}
                    </span>
                  )}
                </span>
                <span className="ts-swap-val font-v2-mono tabular-nums">{q.amount}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
