'use client'

import { useMemo } from 'react'
import { formatUnits } from 'viem'
import {
  INTEGRATED_DEX_SOURCE_COUNT,
  INTEGRATED_DEX_SOURCE_COUNT_WORDS,
  INTEGRATED_DEX_SOURCE_COUNT_WORDS_CAP,
  LANDING_PREVIEW_AMOUNT_IN,
  PLATFORM_FEE_LABEL,
  PRIVACY_BADGE,
  SWAP_CHAIN_LIST_LABEL,
} from '@/config/product-claims'
import { useQuoteChainId } from '@/hooks/useChainId'
import { useQuote } from '@/hooks/useQuote'
import { getChainTokenList, remapTokenToChain } from '@/lib/chains'
import { formatDisplay } from '@/lib/format'
import { playTouchMP3 } from '@/lib/sounds'
import { findToken, type Token } from '@/lib/tokens'
import { safeBigInt } from '@/lib/utils'
import { Button, EyebrowLabel, HandUnderline, Panel } from '../primitives'
import { PhotoBackground } from '../photos/PhotoBackground'
import { heroStats } from './slots'

/**
 * Resolve a preview leg against the GIVEN chain (v1 `resolvePreviewToken`, fix/landing-preview-chain-aware): a symbol
 * the chain's own catalog does not list is null, never the mainnet address.
 */
function resolvePreviewToken(symbol: string, chainId: number): Token | null {
  const base = findToken(symbol)
  if (!base) return null
  if (!getChainTokenList(chainId).some((t) => t.symbol.toLowerCase() === symbol.toLowerCase())) return null
  return remapTokenToChain(base, chainId)
}

/**
 * The hero's live preview — 0.5 ETH → a real quote for USDC through the SAME `useQuote` hook SwapBox uses (never a
 * second quote implementation). "Compared" is claimed only once a quote has actually resolved (v1 rule, unchanged).
 */
function SwapPreview({ onLaunchApp }: { onLaunchApp: () => void }) {
  const chainId = useQuoteChainId()
  const [tokenIn, tokenOut] = useMemo(() => [resolvePreviewToken('ETH', chainId), resolvePreviewToken('USDC', chainId)], [chainId])
  const pairUnavailable = tokenIn === null || tokenOut === null
  const { meta, loading, error } = useQuote(tokenIn, tokenOut, LANDING_PREVIEW_AMOUNT_IN, !pairUnavailable)

  const receiveDisplay = (() => {
    if (pairUnavailable || !meta?.best || !tokenOut) return null
    const out = safeBigInt(meta.best.toAmount)
    return out === null ? null : formatDisplay(Number(formatUnits(out, tokenOut.decimals)), 4)
  })()
  const hasResolvedQuote = receiveDisplay !== null && !error && !pairUnavailable

  const ROW = 'flex items-center justify-between rounded-v2-control border border-v2-border bg-v2-bg px-4 py-3'
  const CHIP = 'rounded-v2-chip border border-v2-border bg-v2-surface2 px-3 py-1.5 font-v2-mono text-sm text-v2-text'
  return (
    <div className="mx-auto w-full max-w-[470px]">
      <Panel overPhoto className="flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between">
          <span className="font-v2-mono text-[11px] font-bold uppercase tracking-[2px] text-v2-muted">Swap</span>
          <span className="text-sm text-v2-text">Try it live →</span>
        </div>
        <div className={ROW}>
          <span className="font-v2-mono text-2xl text-v2-text">{LANDING_PREVIEW_AMOUNT_IN}</span>
          <span className={CHIP}>ETH</span>
        </div>
        <div className={ROW}>
          <span className="font-v2-mono text-2xl text-v2-text" aria-live="polite">
            {receiveDisplay ?? (pairUnavailable || error ? 'Unavailable' : loading ? '···' : '···')}
          </span>
          <span className={CHIP}>USDC</span>
        </div>
        {hasResolvedQuote ? (
          <div className="flex flex-col gap-1.5 px-1 text-sm text-v2-muted">
            <div className="flex justify-between">
              <span>Compared</span>
              <span className="font-v2-mono text-v2-text">{INTEGRATED_DEX_SOURCE_COUNT} DEX sources</span>
            </div>
            <div className="flex justify-between">
              <span>Platform fee</span>
              <span className="font-v2-mono text-v2-text">{PLATFORM_FEE_LABEL}</span>
            </div>
          </div>
        ) : null}
        <Button
          className="mt-1 w-full"
          onClick={() => {
            playTouchMP3()
            onLaunchApp()
          }}
        >
          Swap →
        </Button>
      </Panel>
    </div>
  )
}

/**
 * [ADR-025] Hero (pack 10a / m01, landing-a): stats card, H1, subhead, CTAs, chips, live preview. Numbers render their
 * FINAL value on the server render — no counter, so nothing ever starts from 0 (the `immediate` rule of v1, taken to
 * its end). The entrance is a CSS rise that tokens.css switches off under prefers-reduced-motion.
 */
export function Hero({ onLaunchApp }: { onLaunchApp: () => void }) {
  const chainId = useQuoteChainId()
  const stats = heroStats(chainId)

  return (
    <section id="hero" className="relative overflow-hidden px-4 pb-16 pt-8 sm:px-8 sm:pb-24 sm:pt-16">
      <PhotoBackground photoId="trails" section />
      {/* Under lg both columns are `contents`, so the four blocks order themselves as pack m01 does (copy · stats · chips ·
          preview); from lg up they are the 7/5 columns of pack 10a. */}
      <div className="relative z-10 mx-auto grid max-w-[1240px] items-start gap-10 lg:grid-cols-[7fr_5fr] lg:gap-16">
        <div className="contents text-left lg:block">
          <div className="ts-v2-rise order-1 lg:order-none">
          <EyebrowLabel className="ts-v2-plate">Meta-Aggregator</EyebrowLabel>
          <h1 className="mt-6 font-v2-display text-[56px] font-bold uppercase leading-[0.95] tracking-[-0.01em] text-v2-text sm:text-[96px] lg:text-[112px]">
            <span className="block">One swap.</span>{' '}
            <span className="block">{INTEGRATED_DEX_SOURCE_COUNT_WORDS_CAP} routes.</span>{' '}
            <span className="block text-v2-cream">
              <HandUnderline>Verified.</HandUnderline>
            </span>
          </h1>
          <p className="ts-v2-plate mt-8 inline-block max-w-xl text-[16px] leading-relaxed text-v2-muted sm:text-[18px]">
            TeraSwap compares {INTEGRATED_DEX_SOURCE_COUNT_WORDS} liquidity sources for every trade, verifies the price against
            Chainlink oracles, and offers MEV-protected routes via CoW Protocol.
          </p>
          <div className="mt-8 flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:gap-6">
            <Button
              className="h-14 sm:min-w-[180px]"
              onClick={() => {
                playTouchMP3()
                onLaunchApp()
              }}
            >
              Launch app
            </Button>
            <a
              href="#performance"
              className="ts-v2-plate inline-flex items-center justify-center gap-1.5 text-[15px] text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal"
            >
              See the routing engine <span aria-hidden="true">→</span>
            </a>
          </div>
          </div>
          <div className="order-3 flex flex-wrap items-center gap-x-3 gap-y-3 font-v2-mono lg:order-none lg:mt-10 text-[11px] font-bold uppercase tracking-[1.5px] text-v2-text">
            {[
              'Non-custodial',
              SWAP_CHAIN_LIST_LABEL,
              'Powered by Chainlink',
              PRIVACY_BADGE,
            ].map((chip) => (
              <span key={chip} className="ts-v2-plate border-l-2 border-v2-cream pl-2">
                {chip}
              </span>
            ))}
          </div>
        </div>

        <div className="contents lg:flex lg:flex-col lg:gap-4 lg:pt-4">
          <Panel overPhoto className="ts-v2-rise order-2 p-5 lg:order-none">
            <dl className="grid grid-cols-3 gap-x-4">
              {stats.map((s) => (
                <div key={s.label} className="flex min-w-0 flex-col-reverse justify-end gap-2">
                  <dt className="font-v2-mono text-[10px] font-medium uppercase leading-snug tracking-[1.5px] text-v2-muted">{s.label}</dt>
                  <dd className="font-v2-display text-[44px] font-bold leading-none text-v2-cream sm:text-[56px]">{s.value}</dd>
                </div>
              ))}
            </dl>
          </Panel>
          <div className="ts-v2-rise order-4 lg:order-none">
            <SwapPreview onLaunchApp={onLaunchApp} />
          </div>
        </div>
      </div>
    </section>
  )
}
