'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, useInView } from 'framer-motion'
import { playTouchMP3 } from '@/lib/sounds'

interface Props {
  onLaunchApp: () => void
  onDocs?: () => void
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

function SectionHeadline({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.h2
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.3 }}
      variants={fadeInUp}
      className={`font-display font-bold text-cream ${className}`}
    >
      {children}
    </motion.h2>
  )
}

// ── Animated number counter ───────────────────────────────

function AnimatedCounter({ value, suffix = '', duration = 1500 }: { value: number; suffix?: string; duration?: number }) {
  const [count, setCount] = useState(0)
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  useEffect(() => {
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
  }, [inView, value, duration])

  return <span ref={ref}>{count}{suffix}</span>
}

// ══════════════════════════════════════════════════════════
//  SECTION 01: HERO
// ══════════════════════════════════════════════════════════

function HeroSection({ onLaunchApp }: { onLaunchApp: () => void }) {
  const [showTrust, setShowTrust] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setShowTrust(true), 2000)
    return () => clearTimeout(timer)
  }, [])

  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center px-4 pb-16 pt-28 text-center sm:px-6">
      {/* Radial glow behind headline */}
      <div className="pointer-events-none absolute top-[35%] left-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[800px] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(200,184,154,0.06)_0%,transparent_70%)]" />

      {/* H1 */}
      <motion.h1
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: easeOutExpo }}
        className="relative z-10 mb-8 font-display text-[28px] font-extrabold leading-[1.1] tracking-[-0.02em] text-cream sm:text-[44px] md:text-[64px] lg:text-[76px]"
      >
        The{' '}
        <span className="text-shimmer">Gold Standard</span>
        <br />
        of DeFi Trading.
      </motion.h1>

      {/* H2 */}
      <motion.p
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.2, ease: easeOutExpo }}
        className="relative z-10 mb-12 max-w-[640px] text-lg leading-relaxed text-cream-75"
      >
        Maximum liquidity. Absolute protection. TeraSwap connects multiple leading Ethereum liquidity
        sources into one intelligent engine — always routing your trades through the best possible price,
        with <span className="font-semibold">gasless approvals</span> and full immunity against{' '}
        <span className="font-semibold">predatory bots</span>.{' '}
        <span className="font-semibold">Institutional-grade precision</span>, built for Web3.
      </motion.p>

      {/* CTA Button */}
      <motion.button
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, delay: 0.4 }}
        whileHover={{ scale: 1.03, boxShadow: '0 0 40px rgba(200,184,154,0.4)' }}
        whileTap={{ scale: 0.96 }}
        onClick={() => { playTouchMP3(); onLaunchApp() }}
        style={{ background: 'linear-gradient(135deg, #C8B89A 0%, #E8D5B7 50%, #C8B89A 100%)' }}
        className="group relative z-10 inline-flex h-14 items-center gap-1.5 rounded-full px-8 text-base font-semibold tracking-[0.04em] text-[#080B10]"
      >
        Launch App
      </motion.button>

      {/* Trust strip */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: showTrust ? 1 : 0 }}
        transition={{ duration: 0.6 }}
        className="relative z-10 mt-10 flex items-center gap-3 text-[12px] font-medium uppercase tracking-[0.1em]"
        style={{ color: 'rgba(200,184,154,0.5)' }}
      >
        <span>Non-custodial</span>
        <span style={{ color: 'rgba(200,184,154,0.25)' }}>·</span>
        <span>Ethereum Mainnet</span>
        <span style={{ color: 'rgba(200,184,154,0.25)' }}>·</span>
        <span>Powered by Chainlink</span>
        <span style={{ color: 'rgba(200,184,154,0.25)' }}>·</span>
        <span>IP Protected</span>
      </motion.div>
    </section>
  )
}

// ══════════════════════════════════════════════════════════
//  SECTION 02: PERFORMANCE
// ══════════════════════════════════════════════════════════

function PerformanceSection() {
  return (
    <section id="performance" className="scan-line relative py-28 px-6">
      <div className="mx-auto grid max-w-6xl items-center gap-8 sm:gap-12 lg:grid-cols-[55%_45%] lg:gap-16">
        {/* Copy */}
        <div>
          <SectionHeadline className="mb-6 text-[24px] sm:text-[36px] md:text-[44px] leading-[1.15]">
            <motion.span
              initial="hidden" whileInView="visible" viewport={{ once: true }}
              variants={{ hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: easeOutExpo } } }}
              className="block"
            >
              Limitless Liquidity.
            </motion.span>
            <motion.span
              initial="hidden" whileInView="visible" viewport={{ once: true }}
              variants={{ hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0, transition: { duration: 0.5, delay: 0.12, ease: easeOutExpo } } }}
              className="block"
            >
              Relentless Execution.
            </motion.span>
          </SectionHeadline>

          <motion.p
            initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { delay: 0.3, duration: 0.5 } } }}
            className="mb-8 max-w-xl text-[16px] leading-relaxed text-cream-75"
          >
            Stop searching for the best price. TeraSwap&apos;s proprietary meta-aggregation engine does it
            for you in milliseconds. Our team engineered a system that simultaneously scans multiple top-tier
            liquidity sources across the Ethereum ecosystem — identifying and executing the optimal route to
            deliver the highest net output on every single swap. More tokens in your wallet, every time.
          </motion.p>

          {/* Stat callout */}
          <motion.div
            initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { delay: 0.5 } } }}
            className="inline-flex items-center gap-3 rounded-xl border border-cream-08 bg-surface-secondary px-5 py-3"
          >
            <span className="font-mono text-2xl font-semibold" style={{ color: '#C8B89A' }}>
              <AnimatedCounter value={1} suffix="ms" />
            </span>
            <span className="text-sm text-cream-50">Execution speed</span>
          </motion.div>
        </div>

        {/* Visual — Route flow diagram */}
        <motion.div
          initial="hidden" whileInView="visible" viewport={{ once: true }}
          variants={{ hidden: { opacity: 0, x: 40 }, visible: { opacity: 1, x: 0, transition: { duration: 0.7, delay: 0.2 } } }}
          className="relative flex flex-col items-center"
        >
          <RouteVisualization />
        </motion.div>
      </div>
    </section>
  )
}

// Animated route visualization (CSS-based, no Rive dependency)
function RouteVisualization() {
  const sources = [
    { name: '1inch', color: '#E8D5B7' },
    { name: 'Velora', color: '#C8B89A' },
    { name: 'KyberSwap', color: '#E8D5B7' },
    { name: 'Uniswap', color: '#C8B89A' },
    { name: 'OpenOcean', color: '#E8D5B7' },
    { name: 'SushiSwap', color: '#C8B89A' },
    { name: 'Balancer', color: '#E8D5B7' },
    { name: 'Curve', color: '#C8B89A' },
  ]

  return (
    <div className="w-full max-w-sm">
      {/* Source nodes */}
      <div className="flex flex-col gap-3">
        {sources.map((s, i) => (
          <motion.div
            key={s.name}
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.3 + i * 0.1, duration: 0.4 }}
            className="flex items-center gap-3"
          >
            <div className="flex h-10 w-28 items-center justify-center rounded-lg border border-cream-08 bg-surface-secondary text-xs font-medium text-cream-65">
              {s.name}
            </div>
            <motion.div
              className="h-[1px] flex-1"
              style={{ background: `linear-gradient(90deg, ${s.color}33, ${s.color}66)` }}
              initial={{ scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true }}
              transition={{ delay: 0.5 + i * 0.15, duration: 0.6, ease: 'easeOut' }}
            />
          </motion.div>
        ))}
      </div>

      {/* Central engine node */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true }}
        transition={{ delay: 1, duration: 0.5 }}
        className="my-4 ml-8 flex h-14 w-48 items-center justify-center rounded-xl border sm:ml-16 lg:ml-32"
        style={{ borderColor: 'rgba(200,184,154,0.3)', background: 'linear-gradient(90deg, rgba(200,184,154,0.08), rgba(200,184,154,0.04))' }}
      >
        <span className="text-sm font-semibold" style={{ color: '#C8B89A' }}>TeraSwap Engine</span>
      </motion.div>

      {/* Output */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ delay: 1.3, duration: 0.4 }}
        className="ml-8 flex items-center gap-2 sm:ml-16 lg:ml-32"
      >
        <div className="h-[2px] w-20" style={{ background: 'linear-gradient(90deg, #C8B89A, #4ADE80)' }} />
        <div className="rounded-lg border px-4 py-2 text-sm font-semibold" style={{ borderColor: 'rgba(74,222,128,0.3)', background: 'rgba(74,222,128,0.05)', color: '#4ADE80' }}>
          Best Price
        </div>
      </motion.div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  SECTION 03: SECURITY
// ══════════════════════════════════════════════════════════

function SecuritySection() {
  const stats = [
    { value: 100, suffix: '%', label: 'Front-running blocked' },
    { value: 3, prefix: '< ', suffix: '%', label: 'Chainlink enforced deviation' },
    { value: 0, suffix: '', label: 'IP Protected', isText: true, textValue: '🛡' },
  ]

  return (
    <section id="security" className="relative py-28 px-6">
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
              transition={{ delay: 0.8, duration: 0.5 }}
            />
            <motion.g
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ delay: 1 }}
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

        {/* Stats bar */}
        <motion.div
          initial="hidden" whileInView="visible" viewport={{ once: true, amount: 0.5 }}
          variants={staggerContainer}
          className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-3"
        >
          {stats.map((stat, i) => (
            <motion.div
              key={i}
              variants={fadeInUpChild}
              className="rounded-xl border border-cream-08 bg-surface-secondary p-5 text-center"
            >
              <div className="mb-1 font-mono text-3xl font-bold text-cream">
                {stat.isText ? stat.textValue : (
                  <>{stat.prefix}<AnimatedCounter value={stat.value} suffix={stat.suffix} /></>
                )}
              </div>
              <div className="text-xs font-medium text-cream-50">{stat.label}</div>
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
    <section id="experience" className="relative py-28 px-6 overflow-hidden">
      {/* Background watermark — z-0 so it stays fully behind content */}
      <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center overflow-hidden">
        <span
          className="font-display text-[48px] sm:text-[100px] md:text-[120px] font-bold select-none whitespace-nowrap"
          style={{ color: 'rgba(200,184,154,0.03)' }}
        >
          cream-on-black
        </span>
      </div>

      <div className="relative z-10 mx-auto grid max-w-6xl items-center gap-8 sm:gap-12 lg:grid-cols-2 lg:gap-16">
        {/* Copy */}
        <div>
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
            variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { delay: 0.3, duration: 0.5 } } }}
            className="mb-8 max-w-xl text-[16px] leading-relaxed text-cream-75"
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
            variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { delay: 0.5 } } }}
            whileHover={{ x: 4 }}
            onClick={onLaunchApp}
            className="inline-flex items-center gap-2 text-sm font-semibold transition-opacity hover:opacity-80"
            style={{ color: '#C8B89A' }}
          >
            Launch the full app <span>→</span>
          </motion.button>
        </div>

        {/* Widget preview teaser */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.3, duration: 0.7 }}
          className="relative mx-auto w-full max-w-sm"
        >
          <div className="rounded-2xl border border-cream-08 bg-surface-secondary p-5" style={{ boxShadow: '0 0 60px rgba(200,184,154,0.04)' }}>
            <div className="mb-3 text-xs font-medium text-cream-50">Swap</div>
            <div className="mb-2 rounded-xl border border-cream-08 bg-surface p-4">
              <div className="flex items-center justify-between">
                <span className="text-2xl font-bold text-cream">0.5</span>
                <div className="flex items-center gap-2 rounded-full bg-surface-tertiary px-3 py-1.5">
                  <span className="text-sm font-semibold text-cream">ETH</span>
                </div>
              </div>
            </div>
            <div className="mb-2 rounded-xl border border-cream-08 bg-surface p-4">
              <div className="flex items-center justify-between">
                <span className="text-2xl font-bold text-cream-50">994.68</span>
                <div className="flex items-center gap-2 rounded-full bg-surface-tertiary px-3 py-1.5">
                  <span className="text-sm font-semibold text-cream">USDC</span>
                </div>
              </div>
            </div>
            <div className="mt-3 rounded-lg bg-surface px-3 py-2 text-xs text-cream-50">
              <div className="flex justify-between">
                <span>Best via</span>
                <span className="font-semibold" style={{ color: '#C8B89A' }}>Velora</span>
              </div>
              <div className="flex justify-between mt-1">
                <span>Platform fee</span>
                <span>0.1%</span>
              </div>
            </div>
            <div
              className="mt-3 h-12 rounded-xl flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, #C8B89A 0%, #E8D5B7 50%, #C8B89A 100%)' }}
            >
              <span className="text-sm font-semibold text-[#080B10]">Swap</span>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  )
}

// ══════════════════════════════════════════════════════════
//  SECTION 05: FEATURES
// ══════════════════════════════════════════════════════════

const FEATURES: { title: string; desc: string; comingSoon?: boolean }[] = [
  {
    title: '11 Liquidity Sources',
    desc: 'Simultaneous queries across 7 aggregator APIs and 4 direct DEX protocols — 1inch, 0x, Velora, Odos, KyberSwap, CoW Protocol, OpenOcean, Uniswap V3, SushiSwap, Balancer V2, and Curve Finance.',
  },
  {
    title: 'Active MEV Protection',
    desc: 'Intent-based execution powered by CoW Protocol batch auctions — solvers compete to give you the best outcome. Zero front-running, zero sandwich attacks.',
  },
  {
    title: 'Gas-Aware Routing',
    desc: 'Quotes ranked by net output minus estimated gas cost. The ranking metric that actually matters to your wallet — not just raw amounts.',
  },
  {
    title: 'Statistical Outlier Detection',
    desc: 'True median-based filtering across all 11 sources removes manipulated quotes automatically. No bogus prices ever reach your screen.',
  },
  {
    title: 'Multi-Oracle Price Protection',
    desc: 'Chainlink on-chain oracles block deviations above 3%. DefiLlama server-side validation adds a second independent price check. Cross-quote consensus across all 11 sources catches outliers automatically.',
  },
  {
    title: 'Privacy-First Architecture',
    desc: 'All RPC reads and aggregator API calls are routed through a server-side proxy. Your IP address is never exposed to external blockchain providers or DEX APIs.',
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
  },
  {
    title: 'Analytics Dashboard',
    desc: 'Real-time protocol performance: volume trends, aggregator win-rates, popular pairs, and activity feed — built-in transparency for every user.',
  },
  {
    title: 'Gasless Approvals',
    desc: 'Permit2 and EIP-2612 off-chain signing keeps your ETH in your wallet where it belongs. No approval gas fees, ever.',
  },
  {
    title: 'Active Approvals Manager',
    desc: 'Full visibility into token approvals made through TeraSwap. Revoke any residual allowance in one click — security you control.',
  },
]

function FeaturesSection() {
  return (
    <section id="features" className="relative py-28 px-6">
      <div className="mx-auto max-w-5xl">
        {/* Headline */}
        <SectionHeadline className="mb-16 text-center text-[24px] sm:text-[36px] md:text-[44px] leading-[1.15]">
          Engineered for the Ethereum{' '}
          <span className="relative inline-block">
            Elite
            <motion.span
              initial={{ width: 0 }}
              whileInView={{ width: '100%' }}
              viewport={{ once: true }}
              transition={{ delay: 0.8, duration: 0.6, ease: 'easeOut' }}
              className="absolute bottom-0 left-0 h-[2px]"
              style={{ background: '#C8B89A' }}
            />
          </span>
          .
        </SectionHeadline>

        {/* Feature cards — 2x2 grid */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.2 }}
          variants={staggerContainer}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3"
        >
          {FEATURES.map((feature) => (
            <motion.div
              key={feature.title}
              variants={fadeInUpChild}
              whileHover={{ y: -4, borderColor: 'rgba(200,184,154,0.4)' }}
              transition={{ duration: 0.2 }}
              className="group rounded-2xl border bg-surface-secondary p-8 transition-all"
              style={{ borderColor: '#1E2530' }}
            >
              {/* Title */}
              <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold text-cream">
                {feature.title}
                {'comingSoon' in feature && feature.comingSoon && (
                  <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                    Coming Soon
                  </span>
                )}
              </h3>

              {/* Separator */}
              <div className="mb-3 h-[1px] w-12" style={{ background: 'rgba(245,240,232,0.2)' }} />

              {/* Description */}
              <p className="text-[15px] leading-relaxed text-cream-65">
                {feature.desc}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}

// ══════════════════════════════════════════════════════════
//  SECTION 06: BOTTOM CTA
// ══════════════════════════════════════════════════════════

function BottomCTASection({ onLaunchApp }: { onLaunchApp: () => void }) {
  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center px-6 text-center">
      {/* Pulsing radial glow */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div
          className="h-[500px] w-[500px] animate-pulse-glow rounded-full"
          style={{ background: 'radial-gradient(ellipse at center, rgba(200,184,154,0.08) 0%, transparent 70%)' }}
        />
      </div>

      {/* Headline */}
      <SectionHeadline className="relative z-10 mb-6 text-[40px] sm:text-[56px] leading-[1.1]">
        Don&apos;t leave{' '}
        <span className="text-shimmer">performance</span>
        <br />
        on the table.
      </SectionHeadline>

      {/* Supporting copy */}
      <motion.p
        initial="hidden" whileInView="visible" viewport={{ once: true }}
        variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0, transition: { delay: 0.2, duration: 0.5 } } }}
        className="relative z-10 mb-2 text-xl text-cream-80"
      >
        Join the traders who refuse to settle.
      </motion.p>
      <motion.p
        initial="hidden" whileInView="visible" viewport={{ once: true }}
        variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { delay: 0.35, duration: 0.5 } } }}
        className="relative z-10 mb-10 max-w-[480px] text-base text-cream-65"
      >
        Experience the next evolution of decentralized trading — engineered to work harder than any
        single exchange ever could.
      </motion.p>

      {/* CTA Button — Grand */}
      <motion.button
        initial={{ opacity: 0, scale: 0.95 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true }}
        transition={{ delay: 0.4, duration: 0.5 }}
        whileHover={{ scale: 1.03, boxShadow: '0 0 60px rgba(200,184,154,0.4)' }}
        whileTap={{ scale: 0.96 }}
        onClick={() => { playTouchMP3(); onLaunchApp() }}
        style={{ background: 'linear-gradient(135deg, #C8B89A 0%, #E8D5B7 50%, #C8B89A 100%)' }}
        className="relative z-10 inline-flex h-16 w-[220px] items-center justify-center rounded-full text-base font-semibold tracking-[0.04em] text-[#080B10]"
      >
        Launch App
      </motion.button>

      {/* Trust bookend */}
      <motion.div
        initial="hidden" whileInView="visible" viewport={{ once: true }}
        variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { delay: 0.6 } } }}
        className="relative z-10 mt-6 text-[11px] font-medium uppercase tracking-[0.08em] text-cream-50"
      >
        Non-custodial · Ethereum Mainnet · Powered by Chainlink · IP Protected
      </motion.div>
    </section>
  )
}

// ══════════════════════════════════════════════════════════
//  MAIN LANDING PAGE COMPONENT
// ══════════════════════════════════════════════════════════

export default function LandingPage({ onLaunchApp, onDocs }: Props) {
  return (
    <div className="relative z-[1]">
      <HeroSection onLaunchApp={onLaunchApp} />
      <PerformanceSection />
      <SecuritySection />
      <ExperienceSection onLaunchApp={onLaunchApp} />
      <FeaturesSection />
      <BottomCTASection onLaunchApp={onLaunchApp} />

      {/* Docs link — subtle, bottom of page */}
      {onDocs && (
        <div className="flex justify-center pb-8">
          <button
            onClick={onDocs}
            className="group flex items-center gap-2 rounded-full border px-5 py-2.5 text-[12px] font-medium tracking-wider text-cream-50 transition-all hover:text-cream"
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
          </button>
        </div>
      )}
    </div>
  )
}
