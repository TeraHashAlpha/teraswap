'use client'

/* Hallmark · genre: atmospheric · macrostructure: Stat-Led
 * hero: H4 Stat-Led — 3 anchor numbers above a single-line H1, left-biased 7/5 grid
 * theme: project-locked (cream #F5F0E8 paper-inverted on surface #080B10 · gold #C8B89A accent — preserved per pre-flight)
 * reveal: one orchestrated hero entrance (~220ms · ease-out-expo) · static elsewhere
 * studied: no (URL studies of jup.ag/cow.fi/aave.com blocked by SPA shells — editorial DNA from SPRINT-27 spec used as input)
 * pre-emit critique: P5 H4 E4 S5 R5 V4
 *
 * [P91] Below-fold sections (Performance/Differentiation/Security/Experience/
 * Features/BottomCTA) live in LandingBelowFold.tsx and are dynamically
 * imported with ssr: true. Hero stays in this file so it ships in the
 * initial bundle for fastest FCP/LCP.
 */

import { useEffect, useRef, useState } from 'react'
import { motion, useInView } from 'framer-motion'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { playTouchMP3 } from '@/lib/sounds'
import {
  INTEGRATED_DEX_SOURCE_COUNT,
  INTEGRATED_DEX_SOURCE_COUNT_WORDS,
  INTEGRATED_DEX_SOURCE_COUNT_WORDS_CAP,
  SWAP_CHAIN_LIST_LABEL,
} from '@/config/product-claims'
import { useQuote } from '@/hooks/useQuote'
import { findToken } from '@/lib/tokens'
import { formatUnits } from 'viem'
import { formatDisplay } from '@/lib/format'
import { safeBigInt } from '@/lib/utils'

interface Props {
  onLaunchApp: () => void
}

// [P91] Dynamic import — SSR keeps the HTML present (SEO + no scroll flash);
// JS hydration is deferred so the initial bundle drives only the hero.
// The loading placeholder reserves ~2vh of scroll height so the layout
// doesn't reflow before the chunk hydrates.
const LandingBelowFold = dynamic(() => import('./LandingBelowFold'), {
  ssr: true,
  loading: () => <div style={{ minHeight: '200vh' }} />,
})

// ── Environment flags ─────────────────────────────────────
// [P87] SSR-safe checks — both `window` and `matchMedia` references are
// gated. These are module-level constants captured at first import; they
// don't react to a viewport resize between mount and the next reveal,
// which is acceptable for one-shot headline animations.
const IS_MOBILE_VIEWPORT =
  typeof window !== 'undefined' && window.innerWidth < 768
const PREFERS_REDUCED =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ── Animation constants ───────────────────────────────────

const easeOutExpo = [0.16, 1, 0.3, 1] as [number, number, number, number]

// [P84] Text-shadow is the primary readability mechanism over particles.
// A 30px dark halo provides ~200 luminance units of contrast — actual
// WCAG AA protection, unlike sub-perceptual background overlays.
const HEADLINE_TEXT_SHADOW = '0 0 30px rgba(8,11,16,0.9), 0 0 60px rgba(8,11,16,0.6)'
const BODY_TEXT_SHADOW = '0 0 20px rgba(8,11,16,0.8), 0 0 40px rgba(8,11,16,0.5)'

// [P87] Headline wrapper that splits text into characters and animates
// each one via Framer Motion stagger. The blur filter (2px → 0) is
// desktop-only — on mobile or under prefers-reduced-motion we use
// opacity + y only, which avoids per-character compositing layers
// (architect note R2). aria-label preserves the full string for screen
// readers; the per-character spans are aria-hidden.
function SplitText({
  children,
  className = '',
  style,
}: {
  children: string
  className?: string
  style?: React.CSSProperties
}) {
  const useBlur = !PREFERS_REDUCED && !IS_MOBILE_VIEWPORT
  const words = children.split(' ')

  if (PREFERS_REDUCED) {
    return (
      <span className={className} style={style} aria-label={children}>
        {children}
      </span>
    )
  }

  return (
    <motion.span
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.3 }}
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: 0.03 } },
      }}
      className={className}
      style={style}
      aria-label={children}
    >
      {words.map((word, wi) => (
        <span key={wi} className="inline-block whitespace-nowrap">
          {word.split('').map((char, ci) => (
            <motion.span
              key={`${wi}-${ci}`}
              className="inline-block"
              variants={{
                hidden: {
                  opacity: 0,
                  y: 20,
                  ...(useBlur ? { filter: 'blur(2px)' } : {}),
                },
                visible: {
                  opacity: 1,
                  y: 0,
                  ...(useBlur ? { filter: 'blur(0px)' } : {}),
                  transition: { duration: 0.4, ease: easeOutExpo },
                },
              }}
              aria-hidden="true"
            >
              {char}
            </motion.span>
          ))}
          {wi < words.length - 1 && <span className="inline-block">&nbsp;</span>}
        </span>
      ))}
    </motion.span>
  )
}

// ── Animated number counter ───────────────────────────────

function AnimatedCounter({
  value,
  suffix = '',
  duration = 1500,
  immediate = false,
}: {
  value: number
  suffix?: string
  duration?: number
  /** Above-the-fold use: skip the useInView gate and render the final
   *  value on mount (SSR-safe). Prevents the "0 ... 0 ... 0" flash that
   *  IntersectionObserver causes for hero counters where the element is
   *  visible before the observer has a chance to fire. */
  immediate?: boolean
}) {
  const [count, setCount] = useState(immediate ? value : 0)
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  useEffect(() => {
    if (immediate) return
    if (!inView) return
    const start = Date.now()
    const tick = () => {
      const elapsed = Date.now() - start
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setCount(Math.round(value * eased))
      if (progress < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, [inView, value, duration, immediate])

  return <span ref={ref}>{count}{suffix}</span>
}

// ── SwapPreview ──────────────────────────────────────────
// [feat/quote-before-wallet] A LIVE preview of the real SwapBox — 0.5 ETH →
// a real quote for USDC, via the SAME useQuote hook SwapBox uses (never a
// second quote implementation — the two paths would drift). Lives in the
// hero's right column so first-time visitors see the actual product
// immediately (Sprint 27B / Prompt 73 established the layout; the mock data
// it originally shipped with is gone). Clicking the Swap button launches the
// live app via the passed onLaunchApp handler. This page is the
// highest-traffic surface in the app — /api/quote's own server-side cache
// (see the quote route) is what keeps N anonymous visitors here from each
// fanning out to every liquidity source.
const LANDING_PREVIEW_AMOUNT_IN = '0.5'

function SwapPreview({ onLaunchApp }: { onLaunchApp: () => void }) {
  const previewTokenIn = findToken('ETH')
  const previewTokenOut = findToken('USDC')
  const { meta, loading, error } = useQuote(
    previewTokenIn ?? null,
    previewTokenOut ?? null,
    LANDING_PREVIEW_AMOUNT_IN,
    true,
  )

  const receiveDisplay = (() => {
    if (!meta?.best || !previewTokenOut) return null
    const outBig = safeBigInt(meta.best.toAmount)
    if (outBig === null) return null
    return formatDisplay(Number(formatUnits(outBig, previewTokenOut.decimals)), 4)
  })()

  // "Compared" only claims a comparison happened once a quote has actually
  // resolved — never while loading, and never on a failed quote.
  const hasResolvedQuote = receiveDisplay !== null && !error

  return (
    <div className="mx-auto w-full max-w-sm md:max-w-[380px] lg:max-w-sm">
      <div
        className="rounded-2xl border border-cream-08 bg-surface-secondary p-5"
        style={{ boxShadow: '0 0 60px rgba(200,184,154,0.04)' }}
      >
        <div className="mb-3 text-xs font-medium text-cream-75">Swap</div>
        <div className="mb-2 rounded-xl border border-cream-08 bg-surface p-4">
          <div className="flex items-center justify-between">
            <span className="text-2xl font-bold text-cream" style={{ fontVariantNumeric: 'tabular-nums' }}>
              0.5
            </span>
            <div className="flex items-center gap-2 rounded-full bg-surface-tertiary px-3 py-1.5">
              <span className="text-sm font-semibold text-cream">ETH</span>
            </div>
          </div>
        </div>
        <div className="mb-2 rounded-xl border border-cream-08 bg-surface p-4">
          <div className="flex items-center justify-between">
            <span
              className="text-2xl font-bold text-cream-75"
              style={{ fontVariantNumeric: 'tabular-nums' }}
              aria-live="polite"
            >
              {receiveDisplay ?? (error ? 'Unavailable' : loading ? '···' : '···')}
            </span>
            <div className="flex items-center gap-2 rounded-full bg-surface-tertiary px-3 py-1.5">
              <span className="text-sm font-semibold text-cream">USDC</span>
            </div>
          </div>
        </div>
        {hasResolvedQuote && (
          <div className="mt-3 rounded-lg bg-surface px-3 py-2 text-xs text-cream-75">
            <div className="flex justify-between">
              <span>Compared</span>
              <span className="font-semibold" style={{ color: '#C8B89A' }}>{INTEGRATED_DEX_SOURCE_COUNT} DEX sources</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span>Platform fee</span>
              <span>0.1%</span>
            </div>
          </div>
        )}
        <button
          onClick={() => { playTouchMP3(); onLaunchApp() }}
          style={{ background: '#C8B89A' }}
          className="mt-3 flex h-12 w-full items-center justify-center rounded-xl text-sm font-semibold text-[#080B10] transition-colors duration-200 hover:bg-[#E8D5B7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8B89A] focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          Swap →
        </button>
      </div>
      {/* Subtle affordance — this is a preview, the real swap is one click away */}
      <p className="mt-3 text-center text-[11px] font-medium uppercase tracking-[0.12em] text-cream-75">
        Try it live →
      </p>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  SECTION 01: HERO
// ══════════════════════════════════════════════════════════

function HeroSection({ onLaunchApp }: { onLaunchApp: () => void }) {
  // Three anchor numbers pulled above the H1 (Stat-Led DNA).
  // Values per docs/Prompts/SPRINT-27B.md → Prompt 69.
  // NOTE: "2 verification layers" departs from the SecuritySection stats
  // bar ("7 Independent validation layers"). Prompts 69 and 71 are both
  // explicit; an Architect-side reconciliation is queued.
  const ANCHOR_STATS: { v: number; label: string }[] = [
    { v: INTEGRATED_DEX_SOURCE_COUNT, label: 'LIQUIDITY SOURCES' },
    { v: 2,  label: 'VERIFICATION LAYERS' },
    { v: 29, label: 'CHAINLINK ORACLES' },
  ]

  return (
    <section id="hero" className="relative px-6 pt-28 pb-20 sm:px-10 sm:pt-32">
      <div className="relative z-10 mx-auto grid max-w-6xl items-start gap-12 lg:grid-cols-[7fr_5fr] lg:gap-16">
        {/* Left column — stats anchor, headline, CTA */}
        <div className="text-left">
          {/* Stat strip — orchestrated entrance, tabular numerals */}
          <motion.dl
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: easeOutExpo }}
            className="mb-8 grid grid-cols-3 gap-x-6 gap-y-1 sm:gap-x-10"
          >
            {ANCHOR_STATS.map((s) => (
              <div key={s.label}>
                <dd
                  className="font-display text-[40px] sm:text-[52px] md:text-[60px] font-bold leading-none text-cream"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  <AnimatedCounter value={s.v} immediate />
                </dd>
                <dt className="mt-2 text-[10px] sm:text-[11px] font-medium uppercase tracking-[0.12em] text-cream-75">
                  {s.label}
                </dt>
              </div>
            ))}
          </motion.dl>

          {/* Hairline under stats — quiet structural mark */}
          <div className="mb-10 h-px w-24 bg-cream-15" />

          {/* H1 — single line at ≤ 50 chars per Hallmark sizing brackets.
              [P87] SplitText drives the main reveal per character; the
              h1 itself is static so the two whileInView triggers don't
              fight. The "Verified." shimmer span stays whole. */}
          <h1
            className="mb-5 font-display text-[36px] sm:text-[52px] md:text-[68px] font-extrabold leading-[1.05] tracking-[-0.02em] text-cream"
            style={{ textShadow: HEADLINE_TEXT_SHADOW }}
          >
            <SplitText>{`One swap. ${INTEGRATED_DEX_SOURCE_COUNT_WORDS_CAP} routes.`}</SplitText>{' '}
            <span className="text-shimmer">Verified.</span>
          </h1>

          {/* Subhead — single line; long-form pitch moved to Performance section */}
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: easeOutExpo, delay: 0.14 }}
            className="mb-10 max-w-xl text-[16px] sm:text-[18px] leading-relaxed text-cream-75"
            style={{ textShadow: BODY_TEXT_SHADOW }}
          >
            TeraSwap compares {INTEGRATED_DEX_SOURCE_COUNT_WORDS} liquidity sources for every trade, verifies the price against
            Chainlink oracles, and routes through MEV-protected execution.
          </motion.p>

          {/* CTA — flat fill, hairline focus ring, no gradient, no glow, no hover-scale */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.28, ease: easeOutExpo, delay: 0.2 }}
            className="flex flex-wrap items-center gap-5"
          >
            <button
              onClick={() => { playTouchMP3(); onLaunchApp() }}
              style={{ background: '#C8B89A' }}
              className="inline-flex h-12 items-center rounded-full px-7 text-[15px] font-semibold tracking-[0.02em] text-[#080B10] transition-colors duration-200 hover:bg-[#E8D5B7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8B89A] focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              Launch app
            </button>
            <a
              href="#performance"
              className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-cream-75 transition-colors duration-200 hover:text-cream focus-visible:outline-none focus-visible:underline"
            >
              See the routing engine <span aria-hidden>→</span>
            </a>
          </motion.div>
        </div>

        {/* Right column — live product preview (P73). On mobile the
            wrapper centres the card; on lg+ it sits next to the headline. */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: easeOutExpo, delay: 0.2 }}
          className="relative"
        >
          <SwapPreview onLaunchApp={onLaunchApp} />
        </motion.div>
      </div>

      {/* Trust strip — full-width hairline below the grid · WCAG AA contrast */}
      <div className="relative z-10 mx-auto mt-16 flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 text-[11px] font-medium uppercase tracking-[0.12em] text-cream-75">
        <span>Non-custodial</span>
        <span aria-hidden className="text-cream-35">·</span>
        <span>{SWAP_CHAIN_LIST_LABEL}</span>
        <span aria-hidden className="text-cream-35">·</span>
        <span>Powered by Chainlink</span>
        <span aria-hidden className="text-cream-35">·</span>
        <span>IP-protected</span>
      </div>
    </section>
  )
}

// ══════════════════════════════════════════════════════════
//  MAIN LANDING PAGE COMPONENT
// ══════════════════════════════════════════════════════════

export default function LandingPage({ onLaunchApp }: Props) {
  return (
    <div className="relative z-[1]">
      {/* [P84] Vignette — radial darken at edges, transparent in the centre
          so the particle canvas remains visible behind copy. Pointer-events-
          none so it never blocks interaction. Sits between the particle
          canvas (z-0) and content (z-10+) via the parent's z-[1] stack. */}
      <div
        className="pointer-events-none fixed inset-0 z-[1]"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 40%, rgba(8,11,16,0.4) 100%)',
        }}
      />
      <HeroSection onLaunchApp={onLaunchApp} />
      <LandingBelowFold onLaunchApp={onLaunchApp} />

      {/* Docs link — subtle, bottom of page. Hard-linked to /docs route. */}
      <div className="flex justify-center pb-8">
        <Link
          href="/docs"
          className="group flex items-center gap-2 rounded-full border px-5 py-2.5 text-[12px] font-medium tracking-wider text-cream-75 transition-colors duration-200 hover:text-cream"
          style={{ borderColor: 'rgba(200,184,154,0.15)', background: 'rgba(200,184,154,0.03)' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-50 group-hover:opacity-80 transition-opacity">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          READ THE DOCS
          <span className="transition-transform group-hover:translate-x-0.5">→</span>
        </Link>
      </div>
    </div>
  )
}
