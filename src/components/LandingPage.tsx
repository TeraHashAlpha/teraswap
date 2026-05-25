'use client'

/* Hallmark · genre: atmospheric · macrostructure: Stat-Led
 * hero: H4 Stat-Led — 3 anchor numbers above a single-line H1, left-biased 7/5 grid
 * theme: project-locked (cream #F5F0E8 paper-inverted on surface #080B10 · gold #C8B89A accent — preserved per pre-flight)
 * reveal: one orchestrated hero entrance (~220ms · ease-out-expo) · static elsewhere
 * studied: no (URL studies of jup.ag/cow.fi/aave.com blocked by SPA shells — editorial DNA from SPRINT-27 spec used as input)
 * pre-emit critique: P5 H4 E4 S5 R5 V4
 */

import { useEffect, useRef, useState } from 'react'
import { motion, useInView } from 'framer-motion'
import Link from 'next/link'
import { playTouchMP3 } from '@/lib/sounds'

interface Props {
  onLaunchApp: () => void
}

// ── Animation variants ────────────────────────────────────

const easeOutExpo = [0.16, 1, 0.3, 1] as [number, number, number, number]

const fadeInUp = {
  hidden: { opacity: 0, y: 32 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: easeOutExpo } },
}

const staggerContainer = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08 } },
}

const fadeInUpChild = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: easeOutExpo } },
}

// ── Reusable section headline with scroll animation ───────

// [P84] Text-shadow is the primary readability mechanism over particles.
// A 30px dark halo provides ~200 luminance units of contrast — actual
// WCAG AA protection, unlike sub-perceptual background overlays.
const HEADLINE_TEXT_SHADOW = '0 0 30px rgba(8,11,16,0.9), 0 0 60px rgba(8,11,16,0.6)'
const BODY_TEXT_SHADOW = '0 0 20px rgba(8,11,16,0.8), 0 0 40px rgba(8,11,16,0.5)'

function SectionHeadline({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.h2
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.1 }}
      variants={fadeInUp}
      className={`font-display font-bold text-cream ${className}`}
      style={{ textShadow: HEADLINE_TEXT_SHADOW }}
    >
      {children}
    </motion.h2>
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
   *  visible before the observer has a chance to fire. Existing scroll-
   *  triggered call sites (Performance, Security) keep the default. */
  immediate?: boolean
}) {
  const [count, setCount] = useState(immediate ? value : 0)
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  useEffect(() => {
    // Hero stats: nothing to animate — initial state already holds value.
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
// Static mock of the real SwapBox — 0.5 ETH → 994.68 USDC via Velora.
// Lives in the hero's right column so first-time visitors see the
// product immediately (Sprint 27B / Prompt 73). Clicking the Swap
// button launches the live app via the passed onLaunchApp handler.
// NOT functional — purely a marketing surface; no quotes, no
// allowance, no real swap. If the mock data goes stale, edit here.
function SwapPreview({ onLaunchApp }: { onLaunchApp: () => void }) {
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
            <span className="text-2xl font-bold text-cream-75" style={{ fontVariantNumeric: 'tabular-nums' }}>
              994.68
            </span>
            <div className="flex items-center gap-2 rounded-full bg-surface-tertiary px-3 py-1.5">
              <span className="text-sm font-semibold text-cream">USDC</span>
            </div>
          </div>
        </div>
        <div className="mt-3 rounded-lg bg-surface px-3 py-2 text-xs text-cream-75">
          <div className="flex justify-between">
            <span>Best via</span>
            <span className="font-semibold" style={{ color: '#C8B89A' }}>Velora</span>
          </div>
          <div className="mt-1 flex justify-between">
            <span>Platform fee</span>
            <span>0.1%</span>
          </div>
        </div>
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
    { v: 11, label: 'LIQUIDITY SOURCES' },
    { v: 2,  label: 'VERIFICATION LAYERS' },
    { v: 29, label: 'CHAINLINK ORACLES' },
  ]

  return (
    <section className="relative px-6 pt-28 pb-20 sm:px-10 sm:pt-32">
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

          {/* H1 — single line at ≤ 50 chars per Hallmark sizing brackets */}
          <motion.h1
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: easeOutExpo, delay: 0.08 }}
            className="mb-5 font-display text-[36px] sm:text-[52px] md:text-[68px] font-extrabold leading-[1.05] tracking-[-0.02em] text-cream"
            style={{ textShadow: HEADLINE_TEXT_SHADOW }}
          >
            One swap. Eleven routes.{' '}
            <span className="text-shimmer">Verified.</span>
          </motion.h1>

          {/* Subhead — single line; long-form pitch moved to Performance section */}
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: easeOutExpo, delay: 0.14 }}
            className="mb-10 max-w-xl text-[16px] sm:text-[18px] leading-relaxed text-cream-75"
            style={{ textShadow: BODY_TEXT_SHADOW }}
          >
            TeraSwap compares eleven liquidity sources for every trade, verifies the price against
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
        <span>Ethereum Mainnet</span>
        <span aria-hidden className="text-cream-35">·</span>
        <span>Powered by Chainlink</span>
        <span aria-hidden className="text-cream-35">·</span>
        <span>IP-protected</span>
      </div>
    </section>
  )
}

// ══════════════════════════════════════════════════════════
//  SECTION 02: PERFORMANCE
// ══════════════════════════════════════════════════════════

function PerformanceSection() {
  return (
    <section id="performance" className="relative py-16 px-6">
      <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[7fr_5fr] lg:gap-16">
        {/* Left — copy */}
        <div>
          <SectionHeadline className="mb-6 max-w-2xl text-[24px] sm:text-[36px] md:text-[44px] leading-[1.15]">
            Limitless Liquidity. Relentless Execution.
          </SectionHeadline>

          <p
            className="max-w-2xl text-[16px] leading-relaxed text-cream-75"
            style={{ textShadow: BODY_TEXT_SHADOW }}
          >
            Stop searching for the best price. TeraSwap&apos;s meta-aggregation engine simultaneously
            scans eleven liquidity sources across Ethereum — identifying and executing the optimal
            route to deliver the highest net output on every single swap. Gas costs are folded into
            the ranking, so the quote you see is the one your wallet actually feels.
          </p>
        </div>

        {/* Right — adapter constellation. Lived in the hero during Sprint 27;
            P73 reclaims the hero's right column for the SwapPreview, so the
            constellation comes home to the section it originally illustrated. */}
        <div className="relative">
          <AdapterConstellation />
        </div>
      </div>
    </section>
  )
}

// ── AdapterConstellation — 11-source orbital layout ───────
// Central TeraSwap hub with 11 source nodes distributed on an elliptical
// orbit. SVG draws the constellation lines (non-scaling stroke so they
// stay crisp at any container size); HTML/React positions the nodes so
// hover + category labels compose cleanly with the rest of the page.
// Gentle twinkle (staggered opacity pulse) keeps motion subtle and does
// NOT rotate the container, so text labels stay upright and legible.
// Below the sm breakpoint, falls back to a simple vertical list.
function AdapterConstellation() {
  const adapters: { name: string; category: string }[] = [
    { name: '1inch', category: 'API' },
    { name: '0x', category: 'API' },
    { name: 'Velora', category: 'API' },
    { name: 'Odos', category: 'API' },
    { name: 'KyberSwap', category: 'API' },
    { name: 'OpenOcean', category: 'API' },
    { name: 'SushiSwap', category: 'API' },
    { name: 'Uniswap V3', category: 'On-chain' },
    { name: 'Curve', category: 'On-chain' },
    { name: 'CoW Protocol', category: 'Intent' },
    { name: 'Balancer', category: 'Hybrid' },
  ]

  // Distribute nodes on an ellipse; start at the top (-π/2) for a balanced look.
  // Radius values are conservative (≤ ~38%) so bottom labels stay inside the
  // container and top labels don't collide with the hub.
  const RX = 42 // horizontal radius (%)
  const RY = 36 // vertical radius (%) — slightly shorter to leave room for labels
  const positions = adapters.map((_, i) => {
    const angle = -Math.PI / 2 + (i / adapters.length) * 2 * Math.PI
    return {
      x: 50 + RX * Math.cos(angle),
      y: 50 + RY * Math.sin(angle),
      angle,
    }
  })

  return (
    <div className="w-full">
      {/* Desktop: orbital constellation (sm+) */}
      <div className="relative mx-auto hidden aspect-square w-full max-w-[520px] sm:block">
        {/* Constellation lines — SVG with non-scaling stroke */}
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {positions.map((p, i) => (
            <line
              key={i}
              x1="50" y1="50"
              x2={p.x} y2={p.y}
              stroke="rgba(200,184,154,0.15)"
              strokeWidth="0.2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {/* Central TeraSwap hub — gentle pulse */}
        <motion.div
          animate={{
            boxShadow: [
              '0 0 20px rgba(200,184,154,0.15)',
              '0 0 44px rgba(200,184,154,0.35)',
              '0 0 20px rgba(200,184,154,0.15)',
            ],
          }}
          transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute left-1/2 top-1/2 flex h-14 w-36 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border"
          style={{
            borderColor: 'rgba(200,184,154,0.4)',
            background: 'linear-gradient(135deg, rgba(200,184,154,0.1) 0%, rgba(200,184,154,0.04) 100%)',
          }}
        >
          <span className="font-display text-sm font-bold" style={{ color: '#C8B89A' }}>
            TeraSwap
          </span>
        </motion.div>

        {/* Source nodes */}
        {adapters.map((adapter, i) => {
          const pos = positions[i]
          return (
            <div
              key={adapter.name}
              className="group absolute"
              style={{ left: `${pos.x}%`, top: `${pos.y}%`, transform: 'translate(-50%, -50%)' }}
            >
              <div className="flex flex-col items-center">
                {/* Twinkling dot — staggered so nodes don't pulse in unison */}
                <motion.div
                  animate={{ opacity: [0.55, 1, 0.55] }}
                  transition={{
                    duration: 3 + (i % 3),
                    repeat: Infinity,
                    delay: i * 0.22,
                    ease: 'easeInOut',
                  }}
                  className="h-3 w-3 rounded-full transition-transform group-hover:scale-150"
                  style={{
                    background: '#C8B89A',
                    boxShadow: '0 0 8px rgba(200,184,154,0.4)',
                  }}
                />
                <div className="mt-1.5 whitespace-nowrap text-center">
                  <div className="text-[11px] font-medium text-cream-75 transition-colors duration-200 group-hover:text-cream">
                    {adapter.name}
                  </div>
                  {/* Category — hidden by default, revealed on hover */}
                  <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-cream-35 opacity-0 transition-opacity group-hover:opacity-100">
                    {adapter.category}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Mobile fallback (< sm): compact vertical list */}
      <div className="block sm:hidden">
        <div className="flex flex-col items-stretch gap-2">
          {adapters.map((adapter, i) => (
            <motion.div
              key={adapter.name}
              initial={{ opacity: 0, x: -12 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.02, duration: 0.35 }}
              className="flex items-center justify-between gap-3 rounded-lg border border-cream-08 bg-surface-secondary px-3 py-2"
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: '#C8B89A', boxShadow: '0 0 6px rgba(200,184,154,0.5)' }}
                />
                <span className="text-sm font-medium text-cream">{adapter.name}</span>
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-cream-35">
                {adapter.category}
              </span>
            </motion.div>
          ))}
          <motion.div
            initial={{ opacity: 0, scale: 0.92 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2, duration: 0.45 }}
            className="mt-3 self-center rounded-full border px-5 py-2 text-sm font-semibold"
            style={{
              borderColor: 'rgba(200,184,154,0.4)',
              background: 'linear-gradient(135deg, rgba(200,184,154,0.1) 0%, rgba(200,184,154,0.04) 100%)',
              color: '#C8B89A',
            }}
          >
            TeraSwap
          </motion.div>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  SECTION 03b: WHAT MAKES TERASWAP DIFFERENT
// ══════════════════════════════════════════════════════════

// Hero-scale differentiator icons (96px). Gold stroke, no fill,
// 1.5px line weight — consistent visual voice across the three blocks.

// Central hub with 8 radiating lines + 8 outer dots. A simplified
// version of the AdapterConstellation that lives in PerformanceSection.
function DiffHubIcon() {
  const angles = [0, 45, 90, 135, 180, 225, 270, 315]
  const RADIUS = 9
  return (
    <svg
      width="96" height="96" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      {angles.map((deg) => {
        const r = (deg * Math.PI) / 180
        const x = 12 + RADIUS * Math.cos(r)
        const y = 12 + RADIUS * Math.sin(r)
        return (
          <g key={deg}>
            <line x1="12" y1="12" x2={x.toFixed(2)} y2={y.toFixed(2)} />
            <circle cx={x.toFixed(2)} cy={y.toFixed(2)} r="1.1" fill="currentColor" />
          </g>
        )
      })}
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  )
}

// Shield + checkmark + tiny "ORACLE" wordmark hex — Oracle-Verified.
function DiffOracleShieldIcon() {
  return (
    <svg
      width="96" height="96" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M12 2 L20 5.5 V12 C20 16.6 16.6 20.4 12 22 C7.4 20.4 4 16.6 4 12 V5.5 Z" />
      <polyline points="8 12.5 11 15.5 16 9.5" />
      {/* Chainlink-style hex glyph below the check, small */}
      <path d="M12 17 L13.2 17.7 V19 L12 19.7 L10.8 19 V17.7 Z" />
    </svg>
  )
}

// Shield with crossed-out bot — Active MEV Protection.
function DiffMEVBotIcon() {
  return (
    <svg
      width="96" height="96" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M12 2 L20 5.5 V12 C20 16.6 16.6 20.4 12 22 C7.4 20.4 4 16.6 4 12 V5.5 Z" />
      {/* Bot silhouette inside the shield: antenna + head + two eye dots */}
      <line x1="12" y1="7.5" x2="12" y2="9" />
      <rect x="9" y="9" width="6" height="5" rx="0.6" />
      <circle cx="10.5" cy="11" r="0.5" fill="currentColor" />
      <circle cx="13.5" cy="11" r="0.5" fill="currentColor" />
      {/* Diagonal strike-through across the bot */}
      <line x1="8" y1="15.5" x2="16" y2="7.5" />
    </svg>
  )
}

function DifferentiationSection() {
  const BLOCKS: { num: string; icon: React.ReactNode; title: string; desc: string }[] = [
    {
      num: '01',
      icon: <DiffHubIcon />,
      title: 'Meta-Aggregator',
      desc: "We don't pick one routing model. TeraSwap compares intent-based solvers against traditional DEX routing — you get whichever gives the better price.",
    },
    {
      num: '02',
      icon: <DiffOracleShieldIcon />,
      title: 'Oracle-Verified Execution',
      desc: 'Every quote is checked against Chainlink price feeds before execution. Deviations above 3% are blocked automatically — before your trade happens, not after.',
    },
    {
      num: '03',
      icon: <DiffMEVBotIcon />,
      title: 'Active MEV Protection',
      desc: 'Intent-based execution powered by CoW Protocol batch auctions — solvers compete to give you the best outcome. Zero front-running, zero sandwich attacks.',
    },
  ]

  // Tight motion variant for the per-block reveal — total time <300ms.
  const blockReveal = {
    hidden: { opacity: 0, y: 14 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.25, ease: easeOutExpo } },
  }

  return (
    <section id="why-teraswap" className="relative py-16 px-6">
      <div className="mx-auto max-w-5xl">
        {/* Left-aligned headline (was centered) */}
        <SectionHeadline className="mb-12 max-w-2xl text-[24px] sm:text-[36px] md:text-[44px] leading-[1.15]">
          What Makes TeraSwap Different
        </SectionHeadline>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.1 }}
          variants={staggerContainer}
          className="divide-y divide-cream-08"
        >
          {BLOCKS.map((b, i) => (
            <motion.div
              key={b.title}
              variants={blockReveal}
              className={`flex flex-col gap-8 py-10 md:flex-row md:items-center md:gap-14 ${
                i % 2 === 1 ? 'md:flex-row-reverse' : ''
              }`}
            >
              {/* Icon side — gold stroke, ~96px */}
              <div
                className="flex shrink-0 items-center justify-center md:w-1/3"
                style={{ color: '#C8B89A' }}
              >
                {b.icon}
              </div>

              {/* Text side */}
              <div className="flex-1">
                <span className="mb-3 block font-mono text-sm tracking-widest text-cream-gold">
                  {b.num}
                </span>
                <h3 className="mb-3 text-2xl font-bold text-cream sm:text-3xl">
                  {b.title}
                </h3>
                <p
                  className="max-w-2xl text-[16px] leading-relaxed text-cream-75"
                  style={{ textShadow: BODY_TEXT_SHADOW }}
                >
                  {b.desc}
                </p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}

// ══════════════════════════════════════════════════════════
//  SECTION 03: SECURITY
// ══════════════════════════════════════════════════════════

function SecuritySection() {
  const stats: { value: number; suffix: string; label: string; prefix?: string; isText?: boolean; textValue?: string }[] = [
    { value: 7, suffix: '', label: 'Independent validation layers' },
    { value: 29, suffix: '', label: 'Chainlink oracle price feeds' },
    { value: 0, suffix: '', label: 'Post-execution verified', isText: true, textValue: '✓ Verified' },
  ]

  return (
    <section id="security" className="relative py-16 px-6">
      <div className="mx-auto max-w-3xl text-center">
        {/* Shield animation (SVG) */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8 }}
          className="mx-auto mb-10 flex h-28 w-28 items-center justify-center"
        >
          <svg viewBox="0 0 100 100" className="h-24 w-24">
            <motion.path
              d="M50 5 L90 25 L90 55 C90 75 70 92 50 98 C30 92 10 75 10 55 L10 25 Z"
              fill="none"
              stroke="#C8B89A"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0, opacity: 0 }}
              whileInView={{ pathLength: 1, opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
            />
            <motion.path
              d="M50 5 L90 25 L90 55 C90 75 70 92 50 98 C30 92 10 75 10 55 L10 25 Z"
              fill="rgba(200,184,154,0.05)"
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ delay: 0.2, duration: 0.5 }}
            />
            <motion.g
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ delay: 0.2 }}
            >
              <rect x="40" y="48" width="20" height="16" rx="2" fill="#C8B89A" opacity="0.3" />
              <path d="M44 48V42a6 6 0 0112 0v6" fill="none" stroke="#C8B89A" strokeWidth="1.5" />
            </motion.g>
          </svg>
        </motion.div>

        {/* Headlines */}
        <SectionHeadline className="mb-2 text-[24px] sm:text-[36px] md:text-[44px] leading-[1.15]">
          Institutional-Grade Security.
        </SectionHeadline>
        <motion.h3
          initial="hidden" whileInView="visible" viewport={{ once: true }}
          variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0, transition: { delay: 0.15, duration: 0.5 } } }}
          className="mb-8 font-display text-[24px] sm:text-[36px] md:text-[44px] font-bold leading-[1.15]"
          style={{ color: '#E8DCC4' }}
        >
          Your Capital, Protected.
        </motion.h3>

        {/* Body */}
        <motion.div
          initial="hidden" whileInView="visible" viewport={{ once: true }}
          variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { delay: 0.3, duration: 0.5 } } }}
          className="mb-6 text-[16px] leading-relaxed text-cream-75"
          style={{ textShadow: BODY_TEXT_SHADOW }}
        >
          <p>
            MEV bots never sleep — but neither does our protection. Through our native integration with
            CoW Protocol, real-time Chainlink price validation, and an independent DefiLlama oracle layer,
            your trades are executed via batch auctions that eliminate front-running and slippage manipulation entirely.
          </p>
          <p className="mt-4">
            Your privacy matters too. All blockchain reads and aggregator API calls are routed through our{' '}
            <span className="font-semibold">server-side privacy proxy</span> — your IP address is never exposed
            to external infrastructure providers.
          </p>
          <p className="mt-4 text-center font-semibold text-cream">
            Zero predatory extraction. Zero data leaks. Zero compromises.
          </p>
          <p className="mt-4">
            TeraSwap was built around one non-negotiable principle:{' '}
            <span className="font-semibold">your profitability and privacy come first.</span>
          </p>
        </motion.div>

        {/* Verification pipeline — two highlighted checkpoints from the
            7-layer guard chain (formerly its own section, folded in here
            per Sprint 27B / Prompt 71 to cut redundancy). */}
        <ul className="mb-4 mt-2 list-none space-y-3 text-left">
          <li className="flex items-start gap-3 rounded-lg border border-cream-08 bg-surface-secondary/60 backdrop-blur-sm p-4">
            <span
              className="mt-1 inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded px-2 py-1 text-[9px] font-bold tracking-[0.06em] min-w-[80px]"
              style={{ background: '#C8B89A', color: '#080B10' }}
            >
              PRE-SWAP
            </span>
            <div>
              <div className="mb-0.5 text-[14px] font-semibold text-cream">Chainlink Oracle Check</div>
              <p className="text-[13px] leading-relaxed text-cream-75">
                29 token price feeds — warns at 2%+ deviation, blocks at 3%. Staleness check every hour.
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3 rounded-lg border border-cream-08 bg-surface-secondary/60 backdrop-blur-sm p-4">
            <span
              className="mt-1 inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded px-2 py-1 text-[9px] font-bold tracking-[0.06em] min-w-[80px]"
              style={{ background: '#C8B89A', color: '#080B10' }}
            >
              POST-SWAP
            </span>
            <div>
              <div className="mb-0.5 text-[14px] font-semibold text-cream">Post-Execution Validation</div>
              <p className="text-[13px] leading-relaxed text-cream-75">
                Transfer event logs verify actual output vs expected. Shortfall above 2% triggers a P0 alert and the source is auto-disabled.
              </p>
            </div>
          </li>
        </ul>

        {/* Stats bar */}
        <motion.div
          initial="hidden" whileInView="visible" viewport={{ once: true, amount: 0.1 }}
          variants={staggerContainer}
          className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-3"
        >
          {stats.map((stat, i) => (
            <motion.div
              key={i}
              variants={fadeInUpChild}
              className="rounded-xl border border-cream-08 bg-surface-secondary backdrop-blur-md p-5 text-center"
            >
              <div className="mb-1 font-mono text-3xl font-bold text-cream">
                {stat.isText ? stat.textValue : (
                  <>{stat.prefix}<AnimatedCounter value={stat.value} suffix={stat.suffix} /></>
                )}
              </div>
              <div className="text-xs font-medium text-cream-75">{stat.label}</div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}

// ══════════════════════════════════════════════════════════
//  SECTION 04: EXPERIENCE
// ══════════════════════════════════════════════════════════

function ExperienceSection({ onLaunchApp }: { onLaunchApp: () => void }) {
  return (
    <section id="experience" className="relative py-16 px-6 overflow-hidden">
      {/* Single-column text section after P73 — the widget moved to the
          hero, so this section keeps only the Permit2 narrative + CTA.
          The Hallmark "cream-on-black" template watermark that used to
          sit behind this section was removed in P76 — it was a design-
          token label, not marketing content. */}
      <div className="relative z-10 mx-auto max-w-3xl">
        <SectionHeadline className="mb-6 text-[24px] sm:text-[36px] md:text-[44px] leading-[1.15]">
          <motion.span
            initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={{ hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0, transition: { duration: 0.3 } } }}
            className="block"
          >
            Zero Friction.
          </motion.span>
          <motion.span
            initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={{ hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0, transition: { duration: 0.5, delay: 0.15 } } }}
            className="block"
          >
            Design That Thinks With You.
          </motion.span>
        </SectionHeadline>

        <motion.p
          initial="hidden" whileInView="visible" viewport={{ once: true }}
          variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { delay: 0.2, duration: 0.5 } } }}
          className="mb-8 max-w-2xl text-[16px] leading-relaxed text-cream-75"
          style={{ textShadow: BODY_TEXT_SHADOW }}
        >
          Forget high gas fees and slow approval flows. Our{' '}
          <span className="font-mono" style={{ color: '#C8B89A' }}>Permit2</span> technology delivers{' '}
          <span className="font-mono" style={{ color: '#C8B89A' }}>100%</span> gasless
          token approvals — sign off-chain and let the system handle everything else. All wrapped in a
          precision-crafted cream-on-black interface with a dynamic animated particle environment that
          responds to your every move. Because visual clarity is the first step toward financial clarity.
        </motion.p>

        <motion.button
          initial="hidden" whileInView="visible" viewport={{ once: true }}
          variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { delay: 0.2 } } }}
          onClick={onLaunchApp}
          className="inline-flex items-center gap-2 text-sm font-semibold transition-opacity duration-200 hover:opacity-80 focus-visible:outline-none focus-visible:underline"
          style={{ color: '#C8B89A' }}
        >
          Launch the full app <span aria-hidden>→</span>
        </motion.button>
      </div>
    </section>
  )
}

// ══════════════════════════════════════════════════════════
//  SECTION 05: FEATURES
// ══════════════════════════════════════════════════════════

// Feature icons — 24×24 viewBox, gold (#C8B89A) stroke at 1.5px, no fill.
// One icon per live feature; Roadmap entries stay icon-less.
const featIconProps = {
  width: 28,
  height: 28,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

function FeatNetworkIcon() {
  return (
    <svg {...featIconProps}>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="18" cy="6" r="2.4" />
      <circle cx="12" cy="18" r="2.4" />
      <line x1="8" y1="7" x2="16" y2="7" />
      <line x1="7" y1="8" x2="11" y2="16" />
      <line x1="17" y1="8" x2="13" y2="16" />
    </svg>
  )
}

function FeatGasIcon() {
  return (
    <svg {...featIconProps}>
      <rect x="3.5" y="6" width="9" height="14" rx="1" />
      <line x1="3.5" y1="10" x2="12.5" y2="10" />
      <path d="M12.5 9 L16 9 V14 a1 1 0 0 0 1 1 H18 V19 a1.5 1.5 0 0 1 -1.5 1.5" />
      <line x1="20" y1="6" x2="20" y2="13" />
    </svg>
  )
}

function FeatChartAlertIcon() {
  return (
    <svg {...featIconProps}>
      <polyline points="3 17 8 12 12 15 18 8" />
      <line x1="20" y1="4" x2="20" y2="9" />
      <circle cx="20" cy="11" r="0.7" fill="currentColor" />
    </svg>
  )
}

function FeatLockIcon() {
  return (
    <svg {...featIconProps}>
      <rect x="5" y="11" width="14" height="10" rx="1.5" />
      <path d="M8 11 V7.5 a4 4 0 0 1 8 0 V11" />
    </svg>
  )
}

function FeatSplitIcon() {
  return (
    <svg {...featIconProps}>
      <line x1="3" y1="12" x2="10" y2="12" />
      <line x1="10" y1="12" x2="20" y2="6" />
      <line x1="10" y1="12" x2="20" y2="18" />
      <circle cx="10" cy="12" r="1.2" fill="currentColor" />
    </svg>
  )
}

function FeatBarChartIcon() {
  return (
    <svg {...featIconProps}>
      <line x1="3" y1="20.5" x2="21" y2="20.5" />
      <rect x="6" y="13" width="3" height="7" />
      <rect x="11" y="9" width="3" height="11" />
      <rect x="16" y="6" width="3" height="14" />
    </svg>
  )
}

function FeatPenIcon() {
  return (
    <svg {...featIconProps}>
      <path d="M14 4 L20 10 L10 20 L4 20 L4 14 Z" />
      <line x1="16" y1="6" x2="18" y2="8" />
    </svg>
  )
}

function FeatKeyIcon() {
  return (
    <svg {...featIconProps}>
      <circle cx="8" cy="12" r="4" />
      <line x1="12" y1="12" x2="21" y2="12" />
      <line x1="17" y1="12" x2="17" y2="15" />
      <line x1="20" y1="12" x2="20" y2="15" />
    </svg>
  )
}

const FEATURES: {
  title: string
  desc: string
  icon?: React.ReactNode
  comingSoon?: boolean
}[] = [
  {
    title: '11 Liquidity Sources',
    desc: 'Simultaneous queries across 7 aggregator APIs and 4 direct DEX protocols — 1inch, 0x, Velora, Odos, KyberSwap, CoW Protocol, OpenOcean, Uniswap V3, SushiSwap, Balancer V2, and Curve Finance.',
    icon: <FeatNetworkIcon />,
  },
  // "Active MEV Protection" lives on the DifferentiationSection hero card
  // — removed here per Sprint 27B / Prompt 72 to avoid duplication.
  {
    title: 'Gas-Aware Routing',
    desc: 'Quotes ranked by net output minus estimated gas cost. The ranking metric that actually matters to your wallet — not just raw amounts.',
    icon: <FeatGasIcon />,
  },
  {
    title: 'Statistical Outlier Detection',
    desc: 'True median-based filtering across all 11 sources removes manipulated quotes automatically. No bogus prices ever reach your screen.',
    icon: <FeatChartAlertIcon />,
  },
  // "Multi-Oracle Price Protection" overlaps with the Oracle-Verified
  // Execution hero card on DifferentiationSection — removed per P72.
  {
    title: 'Privacy-First Architecture',
    desc: 'All RPC reads and aggregator API calls are routed through a server-side proxy. Your IP address is never exposed to external blockchain providers or DEX APIs.',
    icon: <FeatLockIcon />,
  },
  {
    title: 'Smart DCA Engine',
    desc: 'Automated dollar-cost averaging with price-aware buying windows. Fully autonomous execution powered by Chainlink oracles — no browser required.',
    comingSoon: true,
  },
  {
    title: 'Limit Orders',
    desc: 'Set your target price and walk away. CoW Protocol solvers compete to fill your order — zero gas, MEV-protected, with partial fills and price improvement.',
    comingSoon: true,
  },
  {
    title: 'Stop Loss / Take Profit',
    desc: 'Automated position protection powered by Chainlink oracles. Prices are monitored in real-time — when your trigger fires, a CoW limit order is auto-submitted.',
    comingSoon: true,
  },
  {
    title: 'Split Routing',
    desc: 'Large trades auto-split across multiple DEXes to minimize price impact. The optimizer tests dozens of 2-way and 3-way split configurations.',
    icon: <FeatSplitIcon />,
  },
  {
    title: 'Analytics Dashboard',
    desc: 'Real-time protocol performance: volume trends, aggregator win-rates, popular pairs, and activity feed — built-in transparency for every user.',
    icon: <FeatBarChartIcon />,
  },
  {
    title: 'Gasless Approvals',
    desc: 'Permit2 and EIP-2612 off-chain signing keeps your ETH in your wallet where it belongs. No approval gas fees, ever.',
    icon: <FeatPenIcon />,
  },
  {
    title: 'Active Approvals Manager',
    desc: 'Full visibility into token approvals made through TeraSwap. Revoke any residual allowance in one click — security you control.',
    icon: <FeatKeyIcon />,
  },
]

function FeaturesSection() {
  // Split: live features get full-card treatment; Coming-Soon features
  // get a visually distinct, smaller "Roadmap" subsection so visitors can
  // tell at a glance what ships today vs what's queued.
  const liveFeatures = FEATURES.filter((f) => !('comingSoon' in f && f.comingSoon))
  const roadmapFeatures = FEATURES.filter((f) => 'comingSoon' in f && f.comingSoon)

  return (
    <section id="features" className="relative py-16 px-6">
      <div className="mx-auto max-w-5xl">
        {/* Section head — left-biased instead of centered template */}
        <div className="mb-12 max-w-2xl">
          <SectionHeadline className="mb-3 text-[24px] sm:text-[36px] md:text-[44px] leading-[1.15]">
            Engineered for the Ethereum Elite.
          </SectionHeadline>
          <p
            className="text-[15px] leading-relaxed text-cream-75"
            style={{ textShadow: BODY_TEXT_SHADOW }}
          >
            Every capability shipping today, plus what&apos;s next on the roadmap.
          </p>
        </div>

        {/* Live features — full-weight cards with hover lift + gold border.
            [P84] surface.secondary is hex (#0F1318) in tailwind.config — the
            Tailwind /80 slash-opacity modifier doesn't reliably apply on hex
            tokens here (Sprint 27C P74 bug), so we use an explicit rgba()
            value to guarantee the glass effect renders. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          {liveFeatures.map((feature) => (
            <div
              key={feature.title}
              className="group rounded-2xl border border-cream-08 bg-[rgba(15,19,24,0.8)] backdrop-blur-md p-5 transition-[background-color,border-color,transform] duration-200 hover:-translate-y-1 hover:border-[#C8B89A] hover:bg-surface-tertiary sm:p-6"
            >
              {/* Icon — gold stroke, scales up on hover */}
              {feature.icon && (
                <div
                  className="mb-4 inline-flex transition-transform duration-200 group-hover:scale-110"
                  style={{ color: '#C8B89A' }}
                >
                  {feature.icon}
                </div>
              )}
              <h3 className="mb-2 text-[17px] font-semibold text-cream">
                {feature.title}
              </h3>
              <p className="text-[14px] leading-relaxed text-cream-75">
                {feature.desc}
              </p>
            </div>
          ))}
        </div>

        {/* Roadmap — visually demoted per P72: opacity-60, dashed border,
            no hover state, with a per-card ribbon in the top-right corner
            so each card is recognisable as queued work even at a glance. */}
        {roadmapFeatures.length > 0 && (
          <div className="mt-16 border-t border-cream-08 pt-12">
            <h3 className="mb-6 font-display text-[18px] sm:text-[22px] font-semibold text-cream-75">
              Roadmap
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {roadmapFeatures.map((feature) => (
                <div
                  key={feature.title}
                  className="relative rounded-xl border border-dashed border-cream-08 bg-surface-secondary/50 backdrop-blur-sm p-5 opacity-60"
                >
                  {/* Top-right ribbon */}
                  <span
                    className="absolute right-3 top-3 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-amber-300"
                  >
                    Coming Soon
                  </span>
                  <h4 className="mb-2 pr-24 text-[14px] font-semibold text-cream">
                    {feature.title}
                  </h4>
                  <p className="text-[13px] leading-relaxed text-cream-75">
                    {feature.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

// ══════════════════════════════════════════════════════════
//  SECTION 06: BOTTOM CTA
// ══════════════════════════════════════════════════════════

function BottomCTASection({ onLaunchApp }: { onLaunchApp: () => void }) {
  return (
    <section className="relative px-6 py-16 text-center">
      {/* Headline */}
      <SectionHeadline className="relative z-10 mx-auto mb-5 max-w-3xl text-[36px] sm:text-[52px] leading-[1.1]">
        Don&apos;t leave{' '}
        <span className="text-shimmer">performance</span>{' '}
        on the table.
      </SectionHeadline>

      {/* Supporting copy — single paragraph, AA contrast */}
      <p
        className="relative z-10 mx-auto mb-10 max-w-[520px] text-[16px] leading-relaxed text-cream-75"
        style={{ textShadow: BODY_TEXT_SHADOW }}
      >
        Experience decentralized trading engineered to work harder than any single exchange ever could.
      </p>

      {/* CTA — flat fill, no glow, no hover-scale */}
      <button
        onClick={() => { playTouchMP3(); onLaunchApp() }}
        style={{ background: '#C8B89A' }}
        className="relative z-10 inline-flex h-14 w-[220px] items-center justify-center rounded-full text-[15px] font-semibold tracking-[0.02em] text-[#080B10] transition-colors duration-200 hover:bg-[#E8D5B7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8B89A] focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        Launch app
      </button>

      {/* Trust bookend — bumped to AA contrast */}
      <div className="relative z-10 mt-6 text-[11px] font-medium uppercase tracking-[0.1em] text-cream-75">
        Non-custodial · Ethereum Mainnet · Powered by Chainlink · IP-protected
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
      <PerformanceSection />
      <DifferentiationSection />
      <SecuritySection />
      <ExperienceSection onLaunchApp={onLaunchApp} />
      <FeaturesSection />
      <BottomCTASection onLaunchApp={onLaunchApp} />

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
