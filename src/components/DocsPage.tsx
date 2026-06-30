'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'

import { SUPPORT_EMAIL } from '@/lib/constants'

// ── Animation helpers ─────────────────────────────────────

const ease = [0.16, 1, 0.3, 1] as [number, number, number, number]

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease } },
}

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
}

const childFade = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease } },
}

// ── Section data ──────────────────────────────────────────

interface DocSection {
  id: string
  title: string
  icon: string
}

// Section IDs are kebab-case slugs that double as URL fragments
// (e.g. /docs#security). They must match the `id` on each <AnimatedSection>.
const SECTIONS: DocSection[] = [
  { id: 'overview', title: 'Overview', icon: '◈' },
  { id: 'architecture', title: 'Architecture', icon: '⬡' },
  { id: 'liquidity-sources', title: 'Liquidity Sources', icon: '◉' },
  { id: 'smart-routing', title: 'Smart Routing', icon: '⟁' },
  { id: 'security', title: 'Security', icon: '⬢' },
  { id: 'mev-protection', title: 'MEV Protection', icon: '⌬' },
  { id: 'privacy', title: 'Privacy', icon: '◍' },
  { id: 'fee-structure', title: 'Fee Structure', icon: '◇' },
  { id: 'order-engine', title: 'Order Engine', icon: '⊞' },
  { id: 'limit-orders', title: 'Limit Orders', icon: '⊕' },
  { id: 'stop-loss', title: 'Stop Loss / Take Profit', icon: '⛊' },
  { id: 'dca', title: 'DCA', icon: '⟳' },
  { id: 'split-routing', title: 'Split Routing', icon: '⫘' },
  { id: 'analytics', title: 'Analytics Dashboard', icon: '◫' },
  { id: 'roadmap', title: 'Roadmap', icon: '▸' },
]

// ── Animated section wrapper ──────────────────────────────

function AnimatedSection({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <motion.section
      id={id}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.15 }}
      variants={fadeIn}
      className="mb-20 scroll-mt-28"
    >
      {children}
    </motion.section>
  )
}

function SectionTitle({ icon, title }: { icon: string; title: string }) {
  return (
    <div className="mb-6 flex items-center gap-3">
      <span className="text-2xl" style={{ color: '#C8B89A' }}>{icon}</span>
      <h2 className="font-display text-[28px] font-bold text-cream sm:text-[34px]">{title}</h2>
    </div>
  )
}

function Divider() {
  return <div className="my-8 h-px w-full" style={{ background: 'linear-gradient(90deg, transparent 0%, rgba(200,184,154,0.2) 50%, transparent 100%)' }} />
}

// Prominent banner placed above a section's body to flag preview / coming-soon
// content. The body below should be wrapped in `<div className="opacity-50">`
// so it visually reads as a preview rather than as available functionality.
function ComingSoonBanner({ note }: { note?: string }) {
  return (
    <div className="mb-5 flex items-start gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3">
      <span className="mt-0.5 rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
        Coming Soon
      </span>
      <p className="text-[13px] leading-relaxed text-amber-200/90">
        {note ?? 'This feature is not yet available — the section below is a preview of upcoming functionality.'}
      </p>
    </div>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wider"
      style={{ borderColor: 'rgba(200,184,154,0.25)', color: '#C8B89A', background: 'rgba(200,184,154,0.06)' }}
    >
      {children}
    </span>
  )
}

// ── Flow diagram component ────────────────────────────────

function FlowDiagram() {
  const steps = [
    { label: 'User', sub: 'Initiates swap', color: '#C8B89A' },
    { label: 'TeraSwap', sub: 'Queries all sources', color: '#E8D5B7' },
    { label: 'Compare', sub: 'Best net output', color: '#C8B89A' },
    { label: 'Validate', sub: 'Chainlink oracle', color: '#4ADE80' },
    { label: 'Execute', sub: 'On-chain swap', color: '#E8D5B7' },
  ]
  return (
    <motion.div
      initial="hidden" whileInView="visible" viewport={{ once: true }}
      variants={stagger}
      className="my-8 flex flex-wrap items-center justify-center gap-2"
    >
      {steps.map((step, i) => (
        <motion.div key={step.label} variants={childFade} className="flex items-center gap-2">
          <div className="rounded-xl border px-4 py-3 text-center"
            style={{ borderColor: `${step.color}33`, background: `${step.color}0A` }}
          >
            <div className="text-sm font-semibold" style={{ color: step.color }}>{step.label}</div>
            <div className="text-[10px] text-cream-50">{step.sub}</div>
          </div>
          {i < steps.length - 1 && (
            <span className="text-cream-20">→</span>
          )}
        </motion.div>
      ))}
    </motion.div>
  )
}

// ── Source card ────────────────────────────────────────────

function SourceCard({ name, type, desc }: { name: string; type: string; desc: string }) {
  return (
    <motion.div
      variants={childFade}
      whileHover={{ y: -2, borderColor: 'rgba(200,184,154,0.3)' }}
      className="rounded-xl border p-4 transition-all"
      style={{ borderColor: '#1E2530', background: 'rgba(14,18,24,0.6)' }}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-semibold text-cream">{name}</span>
        <Tag>{type}</Tag>
      </div>
      <p className="text-[13px] leading-relaxed text-cream-50">{desc}</p>
    </motion.div>
  )
}

// ── Main docs page ────────────────────────────────────────

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState('overview')

  // Track scroll position to highlight active sidebar item
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id)
          }
        }
      },
      { rootMargin: '-20% 0px -70% 0px' }
    )

    for (const s of SECTIONS) {
      const el = document.getElementById(s.id)
      if (el) observer.observe(el)
    }

    return () => observer.disconnect()
  }, [])

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div className="relative z-10 mx-auto flex max-w-6xl gap-10 px-6 py-16">
      {/* ── Sidebar ── */}
      <nav className="sticky top-28 hidden h-fit w-52 shrink-0 lg:block">
        <div className="mb-4 text-[10px] font-bold uppercase tracking-[0.15em] text-cream-35">
          Documentation
        </div>
        <div className="space-y-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => scrollTo(s.id)}
              className={`group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-all ${
                activeSection === s.id
                  ? 'text-cream'
                  : 'text-cream-50 hover:text-cream-80'
              }`}
              style={activeSection === s.id ? { background: 'rgba(200,184,154,0.08)' } : {}}
            >
              <span
                className="text-xs transition-transform group-hover:scale-110"
                style={{ color: activeSection === s.id ? '#C8B89A' : 'rgba(200,184,154,0.4)' }}
              >
                {s.icon}
              </span>
              {s.title}
            </button>
          ))}
        </div>

        {/* Version badge */}
        <div className="mt-8 rounded-lg border px-3 py-2 text-center text-[10px] text-cream-35"
          style={{ borderColor: '#1E2530' }}
        >
          TeraSwap Protocol v1.0
          <br />
          <span className="text-cream-20">Ethereum Mainnet</span>
        </div>
      </nav>

      {/* ── Content ── */}
      <div className="min-w-0 flex-1">
        {/* Hero badge */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-8">
          <div className="inline-flex items-center gap-2 rounded-full border px-4 py-1.5"
            style={{ borderColor: 'rgba(200,184,154,0.15)', background: 'rgba(200,184,154,0.04)' }}
          >
            <span className="h-2 w-2 rounded-full" style={{ background: '#4ADE80' }} />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-cream-65">
              Live on Ethereum Mainnet
            </span>
          </div>
        </motion.div>

        {/* ═══ OVERVIEW ═══ */}
        <AnimatedSection id="overview">
          <SectionTitle icon="◈" title="Overview" />
          <p className="mb-4 text-[15px] leading-relaxed text-cream-65">
            TeraSwap is a <strong className="text-cream">meta-aggregator</strong> for decentralized exchanges. Instant
            swaps are live on Ethereum Mainnet. Instead of searching manually across multiple DEXs, TeraSwap queries
            <strong className="text-cream"> up to 12 independent liquidity sources</strong> simultaneously and
            automatically routes your trade through whichever offers the best net output — accounting for gas costs,
            slippage, and pool fees.
          </p>
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            Every swap is validated against <strong className="text-cream">Chainlink price oracles</strong> and{' '}
            <strong className="text-cream">DefiLlama</strong> to protect against price manipulation, and intent-based
            execution via CoW Protocol provides <strong className="text-cream">MEV protection</strong> out of the box.
            All external requests are routed through a <strong className="text-cream">server-side privacy proxy</strong> that
            shields your IP from blockchain providers.
          </p>
          <div className="flex flex-wrap gap-2">
            <Tag>Non-custodial</Tag>
            <Tag>Permissionless · no KYC</Tag>
            <Tag>Up to 12 DEX sources</Tag>
            <Tag>Multi-oracle verified</Tag>
            <Tag>MEV protected</Tag>
            <Tag>IP protected</Tag>
            <Tag>Beta · unaudited</Tag>
          </div>
        </AnimatedSection>

        <Divider />

        {/* ═══ ARCHITECTURE ═══ */}
        <AnimatedSection id="architecture">
          <SectionTitle icon="⬡" title="Architecture" />
          <p className="mb-4 text-[15px] leading-relaxed text-cream-65">
            TeraSwap operates as a client-side meta-aggregator. When a user initiates a swap, the protocol
            performs a parallel fan-out query to all integrated sources, normalizes the responses into a
            common format, and ranks them by net output (amount received minus estimated gas).
          </p>
          <FlowDiagram />
          <p className="text-[15px] leading-relaxed text-cream-65">
            Each source has an independent timeout — if one API is slow, the others still compete. The winning quote
            is then executed directly from the user&apos;s wallet with a single transaction.
          </p>
        </AnimatedSection>

        <Divider />

        {/* ═══ LIQUIDITY SOURCES ═══ */}
        <AnimatedSection id="liquidity-sources">
          <SectionTitle icon="◉" title="Liquidity Sources" />
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            TeraSwap integrates up to 12 liquidity sources across three categories: API aggregators that
            themselves search hundreds of pools, direct on-chain protocols, and intent-based systems. Every
            registered adapter is queried in parallel on each quote.
          </p>

          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-cream-50">API Aggregators</h3>
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="mb-6 grid gap-3 sm:grid-cols-2"
          >
            <SourceCard name="1inch" type="Aggregator" desc="Pathfinder algorithm searching 400+ liquidity sources across DeFi." />
            <SourceCard name="0x / Matcha" type="Aggregator" desc="Professional-grade RFQ system; uses Permit2's pull model for allowances." />
            <SourceCard name="Velora (ParaSwap)" type="Aggregator" desc="Multi-path routing with MEV-aware execution strategies." />
            <SourceCard name="Odos" type="Aggregator" desc="Smart order routing with atomic multi-hop path optimization." />
            <SourceCard name="KyberSwap" type="Aggregator" desc="Dynamic trade routing across 100+ DEXs with auto-compounding." />
            <SourceCard name="OpenOcean" type="Aggregator" desc="Cross-chain aggregation covering 40+ chains and 1000+ sources." />
          </motion.div>

          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-cream-50">Direct Protocols</h3>
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="mb-6 grid gap-3 sm:grid-cols-2"
          >
            <SourceCard name="Uniswap V3" type="Direct" desc="On-chain concentrated liquidity with auto fee-tier detection across 4 pools." />
            <SourceCard name="SushiSwap" type="Direct" desc="RouteProcessor4 with smart routing across Sushi&apos;s native pools." />
            <SourceCard name="Balancer" type="SOR" desc="Smart Order Router optimizing across weighted, stable, and boosted pools." />
            <SourceCard name="Curve Finance" type="On-Chain" desc="CurveRouterNG for optimized stablecoin and crypto pool swaps with minimal slippage." />
          </motion.div>

          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-cream-50">Intent-Based & RFQ</h3>
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="grid gap-3 sm:grid-cols-2"
          >
            <SourceCard name="CoW Protocol" type="Intent" desc="Batch auction system where solvers compete to fill your order — full MEV protection, gasless execution." />
            <SourceCard name="Bebop" type="RFQ" desc="Request-for-quote market makers via JAM settlement. Chain-aware adapter; participates when its partner key is configured." />
          </motion.div>
        </AnimatedSection>

        <Divider />

        {/* ═══ SMART ROUTING ═══ */}
        <AnimatedSection id="smart-routing">
          <SectionTitle icon="⟁" title="Smart Routing" />
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            The routing engine runs several optimization layers to find the true best execution:
          </p>

          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="space-y-4"
          >
            {[
              { num: '01', title: 'Parallel Fan-Out', desc: 'All registered sources are queried simultaneously, each with an independent 10-second timeout. No source blocks another — a slow API simply drops out of that round.' },
              { num: '02', title: 'Gas-Aware Ranking', desc: 'Quotes ranked by net output considering estimated gas costs in USD. When outputs are close, cheaper gas wins the tiebreak. CoW Protocol (gasless for users) naturally benefits.' },
              { num: '03', title: 'Statistical Outlier Detection', desc: 'True median-based filtering removes manipulated quotes. Amounts sorted independently, median computed (average of two middle values for even counts), anything above 3× median is rejected.' },
              { num: '04', title: 'Uniswap V3 Fee-Tier Detection', desc: 'Automatically tests all 4 fee tiers (0.01%, 0.05%, 0.3%, 1%) and selects the pool with best output. Results are cached for faster subsequent quotes.' },
              { num: '05', title: 'Oracle Validation', desc: 'Before execution, the quoted rate is compared against Chainlink price feeds. Deviations above 2% trigger a warning; above 3% the swap is blocked. A second server-side check via DefiLlama blocks swaps >8% below fair market value.' },
              { num: '06', title: 'Cross-Quote Consensus', desc: 'The winning quote is compared against the median of all responding sources. If it deviates >5% from consensus, a warning is raised. Quotes >3× above median are automatically removed as outliers.' },
              { num: '07', title: 'Slippage Safety', desc: 'User-configurable slippage clamped to [0.01%, 15%] — impossible to create negative factors. Enforced at both UI input and calculation level across every source.' },
              { num: '08', title: 'Chain-Aware EIP-712', desc: 'EIP-712 signing binds to the wallet\'s current chainId dynamically. This is what lets the order engine operate per-chain today — a separate OrderExecutor is deployed on both Ethereum Mainnet and Base — rather than being mainnet-only.' },
            ].map((step) => (
              <motion.div key={step.num} variants={childFade}
                className="flex gap-4 rounded-xl border p-5"
                style={{ borderColor: '#1E2530', background: 'rgba(14,18,24,0.4)' }}
              >
                <span className="mt-0.5 text-2xl font-bold" style={{ color: 'rgba(200,184,154,0.2)' }}>{step.num}</span>
                <div>
                  <h4 className="mb-1 text-sm font-semibold text-cream">{step.title}</h4>
                  <p className="text-[13px] leading-relaxed text-cream-50">{step.desc}</p>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </AnimatedSection>

        <Divider />

        {/* ═══ SECURITY ═══ */}
        <AnimatedSection id="security">
          <SectionTitle icon="⬢" title="Security" />
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            TeraSwap is designed with multiple security layers that protect users at every stage of a trade:
          </p>

          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="grid gap-4 sm:grid-cols-2"
          >
            {[
              { title: 'Chainlink Oracle Validation', desc: 'Every swap rate is cross-referenced with decentralized price feeds — both the input and output token of each swap are checked. The mainnet registry covers roughly 30 token feeds, with automatic deviation detection: warns at 2%, hard-blocks at 3%.', badge: 'Oracle' },
              { title: 'DefiLlama Server-Side Check', desc: 'A second independent oracle validates swap output on the server before returning calldata. Blocks swaps where output is >8% below fair market value. If this secondary oracle is unreachable, swaps estimated above $10,000 are blocked while small swaps fail open.', badge: 'Oracle' },
              { title: 'Cross-Quote Consensus', desc: 'The winning quote is validated against the median of all aggregator responses. Deviations >5% are flagged; quotes >3× above median are removed automatically.', badge: 'Safety' },
              { title: 'Privacy Proxy', desc: 'All blockchain reads and aggregator API calls are routed through a server-side proxy. Your IP address is never exposed to external RPC providers or DEX APIs.', badge: 'Privacy' },
              { title: 'MEV Protection', desc: 'CoW Protocol routes execute via batch auctions where professional solvers compete — your trade is never exposed to sandwich attacks.', badge: 'MEV' },
              { title: 'Exact-Amount Approvals', desc: 'Approvals are always scoped to the exact amount needed and granted directly to the actual spender, which is checked against a trusted allowlist — never an infinite/max-uint approval. (The 0x source uses Permit2\'s pull model, which still requires an on-chain approve to the Permit2 contract — TeraSwap does not ship gasless off-chain signature approvals as the general path.)', badge: 'Approval' },
              { title: 'Non-Custodial', desc: 'TeraSwap never takes custody of your tokens. The fee-collector contract pulls funds, takes the fee, forwards the net to the DEX router, and atomically refunds any leftovers in the same transaction — it never holds user funds between transactions.', badge: 'Trust' },
              { title: 'Permissionless · No KYC', desc: 'There is no sign-up, no account, and no identity check. You connect a wallet and trade directly with on-chain contracts.', badge: 'Access' },
              { title: 'Token-Catalog Guard (CI)', desc: 'Every curated token is verified against its on-chain reality before it ships: contract bytecode must exist (no dead addresses), on-chain symbol() and decimals() must match the catalog entry (decimals are fund-affecting for swap sizing), the address must appear in a reputable per-chain token list, and no two catalog tokens may share a symbol on the same chain. This runs as a CI gate.', badge: 'Safety' },
              { title: 'On-Chain Admin Timelocks', desc: 'Sensitive contract admin actions are time-locked: changing the whitelist of allowed DEX routers, adding/removing a whitelisted executor, and fund sweeps each take effect only after a 48-hour delay (and expire if not executed within a 7-day grace window). An emergency pause is also available.', badge: 'Contract' },
              { title: 'Beta · Unaudited', desc: 'TeraSwap is in beta and its smart contracts are unaudited — a site-wide banner and per-panel disclaimer say so. Contracts are deployed and verified on the block explorer; the underlying DEXs you route through have their own audited contracts.', badge: 'Notice' },
            ].map((item) => (
              <motion.div key={item.title} variants={childFade}
                whileHover={{ y: -2, borderColor: 'rgba(200,184,154,0.25)' }}
                className="rounded-xl border p-5 transition-all"
                style={{ borderColor: '#1E2530', background: 'rgba(14,18,24,0.5)' }}
              >
                <div className="mb-2 flex items-center gap-2">
                  <Tag>{item.badge}</Tag>
                </div>
                <h4 className="mb-1 text-sm font-semibold text-cream">{item.title}</h4>
                <p className="text-[13px] leading-relaxed text-cream-50">{item.desc}</p>
              </motion.div>
            ))}
          </motion.div>
        </AnimatedSection>

        <Divider />

        {/* ═══ MEV PROTECTION ═══ */}
        <AnimatedSection id="mev-protection">
          <SectionTitle icon="⌬" title="MEV Protection" />
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            Most DEX trades on Ethereum settle on a public mempool, which is where searchers and block
            builders extract value from regular users. TeraSwap reduces that exposure by routing through
            CoW Protocol whenever it offers the better price-and-MEV outcome — and by always letting the
            user see the trade-off before they sign.
          </p>

          <h3 className="mt-8 mb-2 font-display text-[18px] font-semibold text-cream">
            What is MEV?
          </h3>
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            MEV (Maximal Extractable Value) is profit that block builders and searchers can capture by
            reordering, inserting, or censoring transactions inside the block they produce. For DEX users
            this most often appears as a <strong className="text-cream">sandwich attack</strong>: a bot
            spots a pending swap in the public mempool, places its own buy directly in front of it to
            push the price up, then sells immediately after at the inflated price — taking the difference
            out of the user&apos;s slippage budget. Researchers at Flashbots and elsewhere estimate
            cumulative MEV extracted from Ethereum users in the billions of USD since 2020.
          </p>

          <h3 className="mt-8 mb-2 font-display text-[18px] font-semibold text-cream">
            How TeraSwap protects you
          </h3>
          <p className="mb-4 text-[15px] leading-relaxed text-cream-65">
            For every swap, TeraSwap evaluates CoW Protocol alongside its other liquidity sources.
            When CoW wins, the swap follows an MEV-protected path:
          </p>
          <ul className="mb-6 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-cream-65 marker:text-cream-35">
            <li>
              You sign an <strong className="text-cream">off-chain EIP-712 order</strong>, not a
              transaction. Nothing hits the public mempool.
            </li>
            <li>
              Professional solvers compete in a <strong className="text-cream">batch auction</strong> to
              fill the order. The auction picks the best execution across multiple venues at the same
              block, so there&apos;s no in-block reordering window for a sandwicher to exploit.
            </li>
            <li>
              <strong className="text-cream">Conditional orders</strong> (limit, stop-loss / take-profit, DCA)
              are signed off-chain on the order engine, so the trigger price isn&apos;t observable in a public
              mempool until the keeper executes — unlike on-chain conditional orders whose target price is
              public. Note: conditional orders are settled by the keeper through whitelisted DEX routers via
              the OrderExecutor contract, not through CoW&apos;s solver auction.
            </li>
          </ul>
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            For direct on-chain swaps (Uniswap V3, Curve, Balancer, SushiSwap), the trade does pass through
            the public mempool and isn&apos;t MEV-protected — that&apos;s why the price comparison
            explicitly accounts for the MEV-protected vs. public-mempool trade-off, and why CoW gets
            evaluated on every quote.
          </p>

          <h3 className="mt-8 mb-2 font-display text-[18px] font-semibold text-cream">
            Why meta-aggregation matters
          </h3>
          <p className="mb-4 text-[15px] leading-relaxed text-cream-65">
            Most MEV-protected venues quote against their own internal liquidity. That solves the MEV
            problem but caps the trade to a single source&apos;s pricing. Most general-purpose aggregators
            do the opposite — they query 5-10 sources for the best public price but route through the
            public mempool, accepting the MEV exposure as the cost of cheaper execution.
          </p>
          <p className="mb-4 text-[15px] leading-relaxed text-cream-65">
            TeraSwap compares <strong className="text-cream">every source, including CoW</strong>, on
            every quote. When CoW&apos;s batch-auction price (net of solver competition) beats the
            public-mempool venues by more than the gas savings, the swap auto-routes through CoW — best
            price <em>and</em> MEV protection, picked algorithmically. When a public-mempool venue
            quotes materially better and the trade is small enough that MEV exposure is bounded by your
            slippage tolerance, you keep the option to take the faster path. Either way, the
            transaction-preview screen shows the route and the on-chain-enforced minimum output before
            you sign.
          </p>
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            We don&apos;t claim &ldquo;zero MEV&rdquo; — we claim significantly reduced MEV exposure on
            the paths that flow through CoW, a hard on-chain minimum-output floor that bounds any sandwich
            on conditional and DCA orders, and an algorithmic choice on every other swap that takes both
            price and MEV cost into account.
          </p>
        </AnimatedSection>

        <Divider />

        {/* ═══ PRIVACY ═══ */}
        <AnimatedSection id="privacy">
          <SectionTitle icon="◍" title="Privacy" />
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            TeraSwap implements a privacy-preserving architecture that protects users&apos; IP addresses
            from external blockchain infrastructure providers and aggregator APIs.
          </p>

          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="space-y-4"
          >
            {[
              { num: '01', title: 'RPC Privacy Proxy', desc: 'All on-chain read operations from the browser are routed through a server-side proxy (/api/rpc) instead of directly calling RPC providers. Only our server\'s IP is visible to the third-party RPC providers — never yours.' },
              { num: '02', title: 'API Proxy Layer', desc: 'All external aggregator API calls (1inch, 0x, CoW, Odos, KyberSwap, etc.) are also proxied server-side through /api/quote and /api/swap. Your browser never makes direct requests to these services.' },
              { num: '03', title: 'Method Policy (Blacklist)', desc: 'The RPC proxy relays every read method by default and explicitly blocks only signing/transaction methods (eth_sendRawTransaction, eth_sendTransaction, eth_signTransaction, eth_sign, personal_sign and the eth_signTypedData variants). A blacklist is used deliberately — a method whitelist devolves into whack-a-mole. Your wallet still signs and broadcasts transactions itself; the proxy never sees your keys.' },
              { num: '04', title: 'Rate Limiting', desc: '300 requests per IP per minute on the RPC proxy to prevent abuse. The swap endpoint is limited to 20 requests per minute.' },
              { num: '05', title: 'Graceful Degradation', desc: 'If the privacy proxy is unreachable, the client falls back to direct RPC. Privacy is never a single point of failure — connectivity takes priority.' },
            ].map((step) => (
              <motion.div key={step.num} variants={childFade}
                className="flex gap-4 rounded-xl border p-5"
                style={{ borderColor: '#1E2530', background: 'rgba(14,18,24,0.4)' }}
              >
                <span className="mt-0.5 text-2xl font-bold" style={{ color: 'rgba(200,184,154,0.2)' }}>{step.num}</span>
                <div>
                  <h4 className="mb-1 text-sm font-semibold text-cream">{step.title}</h4>
                  <p className="text-[13px] leading-relaxed text-cream-50">{step.desc}</p>
                </div>
              </motion.div>
            ))}
          </motion.div>

          <div className="mt-6 overflow-hidden rounded-xl border" style={{ borderColor: '#1E2530' }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'rgba(200,184,154,0.06)' }}>
                  <th className="px-5 py-3 text-left font-semibold text-cream-65">External Service</th>
                  <th className="px-5 py-3 text-left font-semibold text-cream-65">Proxy Endpoint</th>
                  <th className="px-5 py-3 text-left font-semibold text-cream-65">IP Hidden</th>
                </tr>
              </thead>
              <tbody className="text-cream-50">
                {[
                  ['All DEX aggregator quotes', '/api/quote', 'Yes'],
                  ['Swap calldata from all aggregators', '/api/swap', 'Yes'],
                  ['RPC reads (eth_call, receipts, etc.)', '/api/rpc', 'Yes'],
                  ['Conditional-order create / read', '/api/orders', 'Yes'],
                  ['Spender addresses', '/api/spender', 'Yes'],
                ].map(([service, endpoint, hidden], i) => (
                  <tr key={i} style={{ borderTop: '1px solid #1E2530' }}>
                    <td className="px-5 py-2.5 font-medium text-cream">{service}</td>
                    <td className="px-5 py-2.5 font-mono text-xs" style={{ color: '#C8B89A' }}>{endpoint}</td>
                    <td className="px-5 py-2.5 font-bold" style={{ color: '#4ADE80' }}>{hidden}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 rounded-lg border border-cream-08 bg-surface-secondary p-3 text-xs text-cream-50">
            <span className="font-semibold text-cream-65">Note:</span> Your wallet&apos;s own RPC connection (MetaMask, Coinbase Wallet, etc.)
            and transaction signing are handled by your wallet directly and are not proxied. For maximum privacy,
            configure a privacy-focused RPC in your wallet settings (e.g., MEV Blocker, Flashbots Protect).
          </div>
        </AnimatedSection>

        <Divider />

        {/* ═══ FEES ═══ */}
        <AnimatedSection id="fee-structure">
          <SectionTitle icon="◇" title="Fee Structure" />
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            TeraSwap charges a flat <strong className="text-cream">0.1% (10 bps)</strong> platform fee, deducted from
            the input amount before the swap and collected on-chain by the <strong className="text-cream">TeraSwapFeeCollector</strong> contract.
            The collector pulls the input, takes the fee, forwards the net amount to the DEX router, and atomically
            refunds any leftover input and ETH in the same transaction — so it never holds your funds between
            transactions. Token approvals to the collector are <strong className="text-cream">exact-amount</strong>
            {' '}(never infinite / max-uint), granted directly to the spender. No spread markup, no hidden costs.
          </p>

          <div className="overflow-hidden rounded-xl border" style={{ borderColor: '#1E2530' }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'rgba(200,184,154,0.06)' }}>
                  <th className="px-5 py-3 text-left font-semibold text-cream-65">Fee Type</th>
                  <th className="px-5 py-3 text-left font-semibold text-cream-65">Amount</th>
                  <th className="px-5 py-3 text-left font-semibold text-cream-65">Notes</th>
                </tr>
              </thead>
              <tbody className="text-cream-50">
                <tr style={{ borderTop: '1px solid #1E2530' }}>
                  <td className="px-5 py-3 font-medium text-cream">Platform fee</td>
                  <td className="px-5 py-3" style={{ color: '#C8B89A' }}>0.1%</td>
                  <td className="px-5 py-3">Deducted from input amount before swap. Fully transparent.</td>
                </tr>
                <tr style={{ borderTop: '1px solid #1E2530' }}>
                  <td className="px-5 py-3 font-medium text-cream">Pool fee (Uniswap V3)</td>
                  <td className="px-5 py-3" style={{ color: '#C8B89A' }}>0.01% – 1%</td>
                  <td className="px-5 py-3">Charged by the liquidity pool. TeraSwap auto-selects the cheapest tier.</td>
                </tr>
                <tr style={{ borderTop: '1px solid #1E2530' }}>
                  <td className="px-5 py-3 font-medium text-cream">Gas</td>
                  <td className="px-5 py-3" style={{ color: '#C8B89A' }}>Variable</td>
                  <td className="px-5 py-3">Network gas paid in ETH. CoW Protocol swaps are gasless for the user.</td>
                </tr>
                <tr style={{ borderTop: '1px solid #1E2530' }}>
                  <td className="px-5 py-3 font-medium text-cream">Hidden fees</td>
                  <td className="px-5 py-3 font-bold" style={{ color: '#4ADE80' }}>None</td>
                  <td className="px-5 py-3">No spread markup, no referral fees, no deposit or withdrawal fees.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </AnimatedSection>

        <Divider />

        {/* ═══ ORDER ENGINE ═══ */}
        <AnimatedSection id="order-engine">
          <SectionTitle icon="⊞" title="Order Engine" />
          <p className="mb-4 text-[15px] leading-relaxed text-cream-65">
            Limit orders, stop-loss / take-profit, and DCA are all <strong className="text-cream">conditional orders</strong>{' '}
            on a single on-chain engine: the non-upgradeable <strong className="text-cream">TeraSwapOrderExecutor</strong> contract
            (EIP-712 domain <span className="font-mono text-[13px] text-cream">TeraSwapOrderExecutor</span> version 2). You place
            an order by signing it <strong className="text-cream">off-chain with EIP-712</strong> — there is no on-chain
            transaction to create an order — and an autonomous keeper later executes it on-chain when its conditions are met.
            Conditional orders are <strong className="text-cream">not</strong> routed through CoW Protocol; CoW is only used on
            the instant-swap MEV-protection path.
          </p>
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            There are three order types: <strong className="text-cream">LIMIT</strong>, <strong className="text-cream">STOP_LOSS</strong>,
            and <strong className="text-cream">DCA</strong>. Take-profit is not a separate type — it is a STOP_LOSS order with an
            &ldquo;above&rdquo; price condition (stop-loss uses &ldquo;below&rdquo;).
          </p>

          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="space-y-4"
          >
            {[
              { num: '01', title: 'Sign Once, Off-Chain (EIP-712)', desc: 'You sign the order with your wallet and grant a direct, exact-amount ERC-20 allowance to the executor contract for the order total — never an infinite/max-uint approval, and not Permit2. The executor pulls tokens via a direct transferFrom when it executes. No transaction is broadcast to place the order.' },
              { num: '02', title: 'Whitelisted DEX Routing', desc: 'When a keeper executes an order, the contract routes the swap through a whitelisted DEX router (1inch by default) and enforces a per-execution minimum-output (slippage) floor. The router set is governed on-chain by an allowlist.' },
              { num: '03', title: 'On-Chain Validation (canExecute)', desc: 'Before any execution the contract independently re-checks the order signature, that it is not cancelled or nonce-invalidated, that it has not expired, the router whitelist, the schedule, the price condition, and that your balance and allowance still cover the amount. The same checks are re-enforced inside executeOrder — the gate is on-chain, not advisory.' },
              { num: '04', title: 'Chainlink Price Conditions', desc: 'Limit and stop-loss / take-profit orders carry a Chainlink price feed plus a target price and a direction (above / below). The order is only eligible once the on-chain feed crosses the trigger. (A pure DCA order carries no price condition — see the DCA section.)' },
              { num: '05', title: 'Cancel & Mass-Invalidate', desc: 'Any order can be cancelled on-chain at any time, and a single mass nonce-invalidation can void all of your pending orders at once. You stay in control of your own funds throughout.' },
              { num: '06', title: 'Keeper Signs in an HSM', desc: 'The off-chain keeper that submits executions signs with a key held in a hardware security module (AWS KMS): the private key never leaves the HSM and only signatures are returned. Adding or rotating a keeper, changing the router whitelist, or sweeping funds is gated by a 48-hour on-chain timelock (admin transfer uses a longer 7-day delay), each with a 7-day grace window.' },
              { num: '07', title: 'Fail-Closed, Chain-Aware', desc: 'The engine refuses to sign, read, or execute on any chain without a wired OrderExecutor, and the EIP-712 domain is bound to the connected chain. Order creation is rejected server-side — before the signature is even verified — for any chain whose executor is not in the fixed allowlist. Today only Ethereum Mainnet and Base are wired.' },
            ].map((step) => (
              <motion.div key={step.num} variants={childFade}
                className="flex gap-4 rounded-xl border p-5"
                style={{ borderColor: '#1E2530', background: 'rgba(14,18,24,0.4)' }}
              >
                <span className="mt-0.5 text-2xl font-bold" style={{ color: 'rgba(200,184,154,0.2)' }}>{step.num}</span>
                <div>
                  <h4 className="mb-1 text-sm font-semibold text-cream">{step.title}</h4>
                  <p className="text-[13px] leading-relaxed text-cream-50">{step.desc}</p>
                </div>
              </motion.div>
            ))}
          </motion.div>

          <div className="mt-4 rounded-lg border border-cream-08 bg-surface-secondary p-3 text-xs text-cream-50">
            <span className="font-semibold text-cream-65">Deployments:</span> the OrderExecutor is deployed and verified on
            the block explorer — Ethereum Mainnet at <span className="font-mono">0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130</span>{' '}
            and Base at <span className="font-mono">0x135B339902Ea4E0fB4CF059961dc8856bA1D2598</span>. Conditional-order
            creation panels are chain-agnostic in the UI; per-chain availability is enforced centrally by the fail-closed engine.
          </div>
        </AnimatedSection>

        <Divider />

        {/* ═══ LIMIT ORDERS ═══ */}
        <AnimatedSection id="limit-orders">
          <SectionTitle icon="⊕" title="Limit Orders" />
          <ComingSoonBanner note="Limit-order creation is not currently exposed in the app — the section below previews the flow on the order engine. Watch the roadmap for availability." />
          <div className="opacity-50">
            <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
              A limit order (OrderType LIMIT) lets you set a target price; the order becomes eligible once a Chainlink
              price feed crosses your level, and the keeper then executes it on-chain through the order engine. Limit
              orders use a <strong className="text-cream">2% default slippage</strong> floor and are ideal for precise
              entry and exit targets. See the <strong className="text-cream">Order Engine</strong> section above for the
              shared signing, validation, and execution model.
            </p>

            <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
              variants={stagger} className="space-y-4"
            >
              {[
                { num: '01', title: 'Set Target Price', desc: 'Define exactly how many tokens you want to receive per unit sold. The market price is shown for reference, with percentage difference calculated in real-time.' },
                { num: '02', title: 'Choose Expiry', desc: 'Orders carry an expiry; the contract refuses to execute an order past its expiry, and expired orders stop being eligible.' },
                { num: '03', title: 'EIP-712 Signing', desc: 'Sign the order off-chain with your wallet — no on-chain transaction to place it. You grant an exact-amount allowance to the executor; your tokens stay in your wallet until the order executes.' },
                { num: '04', title: 'Chainlink-Gated Execution', desc: 'The order is monitored against a Chainlink feed. When the trigger is reached, the keeper executes it on-chain via the OrderExecutor through a whitelisted DEX router (1inch by default) — you pay no gas at execution time because the keeper sends the transaction.' },
                { num: '05', title: 'On-Chain Min-Output Floor', desc: 'Execution enforces a per-order minimum-output (slippage) floor on-chain, so a fill below your tolerance reverts rather than settling against you.' },
              ].map((step) => (
                <motion.div key={step.num} variants={childFade}
                  className="flex gap-4 rounded-xl border p-5"
                  style={{ borderColor: '#1E2530', background: 'rgba(14,18,24,0.4)' }}
                >
                  <span className="mt-0.5 text-2xl font-bold" style={{ color: 'rgba(200,184,154,0.2)' }}>{step.num}</span>
                  <div>
                    <h4 className="mb-1 text-sm font-semibold text-cream">{step.title}</h4>
                    <p className="text-[13px] leading-relaxed text-cream-50">{step.desc}</p>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </AnimatedSection>

        <Divider />

        {/* ═══ STOP LOSS / TAKE PROFIT ═══ */}
        <AnimatedSection id="stop-loss">
          <SectionTitle icon="⛊" title="Stop Loss / Take Profit" />
          <ComingSoonBanner note="Stop-loss / take-profit creation is not currently exposed in the app — the section below previews the flow on the order engine. Watch the roadmap for availability." />
          <div className="opacity-50">
            <p className="mb-4 text-[15px] leading-relaxed text-cream-65">
              Protect your positions or lock in gains automatically. Stop-loss and take-profit are the same on-chain
              order type (STOP_LOSS) distinguished by direction: stop-loss triggers when the price falls <strong className="text-cream">below</strong>{' '}
              your target, take-profit when it rises <strong className="text-cream">above</strong>. A Chainlink feed gates the
              trigger, and when the condition is met the keeper executes the swap on-chain via the OrderExecutor and a
              whitelisted DEX router.
            </p>
            <div className="mb-6 rounded-lg border border-cream-08 bg-surface-secondary p-3 text-xs text-cream-50">
              <span className="font-semibold text-cream-65">Key difference from Limit Orders:</span> While limit orders let you target a specific price for a planned trade, SL/TP is designed to <strong className="text-cream-65">react to market movements</strong> and protect existing positions. Stop loss uses <strong className="text-cream-65">5% default slippage</strong> to prioritize fast execution during volatile drops, while take profit uses <strong className="text-cream-65">2% slippage</strong> like limit orders.
            </div>

            <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
              variants={stagger} className="space-y-4"
            >
              {[
                { num: '01', title: 'Set Trigger Price', desc: 'Define your stop loss or take profit level. For stop loss, the order becomes eligible when price drops below your target; for take profit, when price rises above it.' },
                { num: '02', title: 'Chainlink Oracle Monitoring', desc: 'The trigger is evaluated against Chainlink on-chain price feeds — the industry standard for reliable, tamper-proof prices. The condition is checked on-chain inside the contract before any execution.' },
                { num: '03', title: 'Automatic Execution', desc: 'You sign once upfront. When the trigger fires, the keeper executes the order on-chain via the OrderExecutor — no manual action needed at trigger time, and no gas paid by you at execution.' },
                { num: '04', title: 'Whitelisted-Router Fill', desc: 'The triggered swap routes through a whitelisted DEX router (1inch by default), with a per-order minimum-output floor enforced on-chain.' },
                { num: '05', title: 'Adaptive Slippage', desc: 'Stop loss orders use 5% default slippage to ensure execution during sharp price drops — speed matters more than precision when protecting against losses. Take profit uses the standard 2% slippage since there is no urgency to exit.' },
              ].map((step) => (
                <motion.div key={step.num} variants={childFade}
                  className="flex gap-4 rounded-xl border p-5"
                  style={{ borderColor: '#1E2530', background: 'rgba(14,18,24,0.4)' }}
                >
                  <span className="mt-0.5 text-2xl font-bold" style={{ color: 'rgba(200,184,154,0.2)' }}>{step.num}</span>
                  <div>
                    <h4 className="mb-1 text-sm font-semibold text-cream">{step.title}</h4>
                    <p className="text-[13px] leading-relaxed text-cream-50">{step.desc}</p>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </AnimatedSection>

        <Divider />

        {/* ═══ DCA ═══ */}
        <AnimatedSection id="dca">
          <SectionTitle icon="⟳" title="DCA (Dollar-Cost Averaging)" />
          <ComingSoonBanner note="DCA ships with launch — it is not live yet. It rolls out first on Base (L2). The section below previews how it works." />
          <div className="opacity-50">
            <p className="mb-4 text-[15px] leading-relaxed text-cream-65">
              DCA splits a single buy into a series of smaller, scheduled purchases that run autonomously —{' '}
              <strong className="text-cream">without you signing each one</strong>. You set the input token, the output
              token, the total amount, the number of buys, and the interval between them. Each buy is settled at
              execution time by the keeper through the single whitelisted DEX router committed in your signed order
              (1inch by default), bounded by your per-buy minimum-output (slippage) floor enforced on-chain. Unlike
              the instant-swap path, conditional and DCA orders are not routed through CoW.
            </p>
            <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
              Setup is two steps: a one-time, <strong className="text-cream">exact-amount</strong> ERC-20 approval to the
              OrderExecutor for the full total (never an infinite/max approval), and a{' '}
              <strong className="text-cream">single EIP-712 signature</strong> over the whole plan. Because the contract
              pulls the input via a direct ERC-20 transfer, the input is always an ERC-20 — a native-ETH input is
              automatically wrapped to WETH before signing. From there a self-hosted keeper executes each buy on-chain
              when its turn comes due, paying the gas itself.
            </p>

            <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
              variants={stagger} className="space-y-4"
            >
              {[
                { num: '01', title: 'Sign Once, Run Autonomously', desc: 'One exact-amount WETH approval to the OrderExecutor plus a single EIP-712 signature covers the whole series. The keeper supplies fresh swap calldata each run; it never asks you to sign again. There is no per-execution signing.' },
                { num: '02', title: 'Cumulative Chunk Accounting', desc: 'Each buy is sized by cumulative accounting: executeAmount = total × (n+1) / count − total × n / count, with the final buy taking the exact remainder. Across all executions the amounts sum to exactly your total — no buy is skipped, duplicated, or double-spent, and no dust is stranded.' },
                { num: '03', title: 'On-Chain Gating Each Run', desc: 'Before each execution the contract independently re-checks your balance, your allowance, the schedule interval (it will not run early), and the order\'s expiry. An execution counter only advances after a successful swap, so the schedule can never run ahead of itself.' },
                { num: '04', title: 'Schedule-Only, No Oracle Needed', desc: 'A pure DCA order carries no price condition (priceFeed = address(0) ⇒ the price check is always true): it runs on schedule regardless of price. It is not price-aware. An optional Chainlink condition can be attached, but the shipped DCA flow runs purely on a fixed interval for a fixed number of buys.' },
                { num: '05', title: 'Routed at Market, Floor Enforced On-Chain', desc: 'At each turn the keeper builds a swap at market time and settles it through the single whitelisted DEX router committed in your signed order (1inch by default), with your per-buy minimum-output floor enforced on-chain. Unlike the instant-swap path, conditional and DCA orders are not routed through CoW.' },
                { num: '06', title: 'You Stay in Control', desc: 'Any order can be cancelled on-chain at any time, and a single mass nonce-invalidation can void all pending orders. A manual circuit-breaker can pause the creation of new DCA orders — but it only delays: it never cancels or moves funds, existing orders keep running, and they can still be cancelled.' },
              ].map((step) => (
                <motion.div key={step.num} variants={childFade}
                  className="flex gap-4 rounded-xl border p-5"
                  style={{ borderColor: '#1E2530', background: 'rgba(14,18,24,0.4)' }}
                >
                  <span className="mt-0.5 text-2xl font-bold" style={{ color: 'rgba(200,184,154,0.2)' }}>{step.num}</span>
                  <div>
                    <h4 className="mb-1 text-sm font-semibold text-cream">{step.title}</h4>
                    <p className="text-[13px] leading-relaxed text-cream-50">{step.desc}</p>
                  </div>
                </motion.div>
              ))}
            </motion.div>

            <div className="mt-4 rounded-lg border border-cream-08 bg-surface-secondary p-3 text-xs text-cream-50">
              <span className="font-semibold text-cream-65">Why Base first:</span> DCA is offered only on Base (an
              Ethereum L2), by design — never on mainnet. A recurring series of small buys on Ethereum Mainnet would be
              dominated by per-execution gas, so DCA rolls out on a low-fee L2 where small, frequent buys are viable. It
              ships with launch and is not presented as live until then.
            </div>
          </div>
        </AnimatedSection>

        <Divider />

        {/* ═══ SPLIT ROUTING ═══ */}
        <AnimatedSection id="split-routing">
          <SectionTitle icon="⫘" title="Split Routing" />
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            For large trades, routing 100% through a single DEX causes significant price impact.
            TeraSwap&apos;s split routing engine automatically divides the trade across multiple
            sources to minimize slippage and maximize output.
          </p>

          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="space-y-4"
          >
            {[
              { num: '01', title: 'Quote Collection', desc: 'Split-eligible sources are queried at multiple sub-amounts in parallel (the set of percentages is derived from the candidate split configurations). Each source reports its output for each partial amount.' },
              { num: '02', title: 'Combinatorial Optimization', desc: 'The engine tests all 2-way and 3-way split configurations across eligible sources. Pre-defined splits (50/50, 60/40, 70/30, 80/20, 50/30/20, etc.) are evaluated for every pairwise and triple source combination.' },
              { num: '03', title: 'Gas-Adjusted Comparison', desc: 'Each split candidate\'s total output is compared against the best single-source quote. Gas costs are factored in — a split that gains 0.1% but doubles gas cost may not be worth it.' },
              { num: '04', title: 'Visualization & Execution', desc: 'When a split improves output by ≥0.1% (10 bps), the UI shows a visual breakdown with per-source allocation bars. Users can toggle split on/off. Execution sends multiple transactions — one per leg — with the pre-computed amounts.' },
            ].map((step) => (
              <motion.div key={step.num} variants={childFade}
                className="flex gap-4 rounded-xl border p-5"
                style={{ borderColor: '#1E2530', background: 'rgba(14,18,24,0.4)' }}
              >
                <span className="mt-0.5 text-2xl font-bold" style={{ color: 'rgba(200,184,154,0.2)' }}>{step.num}</span>
                <div>
                  <h4 className="mb-1 text-sm font-semibold text-cream">{step.title}</h4>
                  <p className="text-[13px] leading-relaxed text-cream-50">{step.desc}</p>
                </div>
              </motion.div>
            ))}
          </motion.div>

          <div className="mt-4 rounded-lg border border-cream-08 bg-surface-secondary p-3 text-xs text-cream-50">
            <span className="font-semibold text-cream-65">Threshold:</span> Split routing activates for trades estimated above $5,000 USD.
            Below this threshold, single-source routing is always used as the gas savings don&apos;t justify the extra transactions.
          </div>
        </AnimatedSection>

        <Divider />

        {/* ═══ ANALYTICS ═══ */}
        <AnimatedSection id="analytics">
          <SectionTitle icon="◫" title="Analytics Dashboard" />

          <p className="mb-4 text-[15px] leading-relaxed text-cream-65">
            The built-in Analytics Dashboard provides real-time visibility into protocol activity:
            trade volumes, fee generation, aggregator performance, and wallet tracking — all
            updated live with each swap.
          </p>

          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="mt-6 space-y-3"
          >
            {[
              { n: 1, title: 'KPI Metrics', desc: 'Total volume, fees collected, unique wallets, and average trade size — filterable by period (24h, 7d, 30d, All Time).' },
              { n: 2, title: 'Aggregator Ranking', desc: 'Volume and win-rate per source, showing which DEX routes deliver the best execution for your trades.' },
              { n: 3, title: 'Hourly Heatmap', desc: 'Visual breakdown of volume by hour (UTC), revealing peak trading windows.' },
              { n: 4, title: 'Wallet Tracker', desc: 'Automatic wallet profiling with trade counts and volumes. Export snapshots for airdrop planning or loyalty programs.' },
              { n: 5, title: 'Daily Volume Chart', desc: '30-day bar chart showing daily trading volume trends and trade frequency.' },
            ].map((step) => (
              <motion.div key={step.n} variants={childFade}
                className="flex gap-4 rounded-xl border p-4"
                style={{ borderColor: '#1E2530', background: 'rgba(14,18,24,0.4)' }}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                  style={{ background: 'rgba(74,222,128,0.1)', color: '#4ADE80', border: '1px solid rgba(74,222,128,0.2)' }}
                >
                  {step.n}
                </span>
                <div>
                  <span className="text-sm font-semibold text-cream">{step.title}</span>
                  <span className="ml-2 text-sm text-cream-50">{step.desc}</span>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </AnimatedSection>

        <Divider />

        {/* ═══ ROADMAP ═══ */}
        <AnimatedSection id="roadmap">
          <SectionTitle icon="▸" title="Roadmap" />

          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="space-y-4"
          >
            {[
              { phase: 'Phase 1', status: 'Live', color: '#4ADE80', items: [
                'Instant swaps on Ethereum Mainnet',
                'Meta-aggregator with up to 12 liquidity sources',
                'Chainlink oracle price validation (2% warn / 3% block)',
                'DefiLlama server-side oracle validation',
                'Cross-quote median consensus validation',
                'Privacy proxy (IP hidden from all external services)',
                'MEV protection via CoW Protocol',
                'Exact-amount approvals (no infinite approvals)',
                'Active approvals manager with revoke',
                'Curve Finance on-chain routing',
                'Gas-aware quote ranking',
                'Statistical outlier detection (true median)',
                'Slippage safety clamp across all sources',
                'Dynamic chain-aware EIP-712 signing',
                'Split routing (multi-DEX trade optimization)',
                'Public analytics dashboard (volume, routes, pairs, activity)',
                'Token-catalog guard (on-chain identity check in CI)',
                'Fee collection smart contract (deployed & verified)',
                'Order Engine smart contract (EIP-712 signed orders, deployed & verified)',
                'Sentry error monitoring',
              ] },
              { phase: 'Phase 2', status: 'Ships with launch', color: '#C8B89A', items: [
                'DCA on Base (schedule-based, keeper-executed)',
                'Limit orders on the order engine (Chainlink-gated)',
                'Stop loss + take profit (Chainlink-gated, adaptive slippage)',
                'Base network activation for swaps',
                'Bebop RFQ source',
              ] },
              { phase: 'Phase 3', status: 'Planned', color: 'rgba(200,184,154,0.4)', items: [
                'Further multi-chain expansion (Arbitrum, Optimism)',
                'Cross-chain swaps via LI.FI',
                'Uniswap V4 Hooks integration',
                'TeraShield — premium privacy mode (paid feature)',
                'Stealth addresses (ERC-5564 / ERC-6538)',
                'Railgun shielded swaps (zkSNARK with sanctions compliance)',
                'Governance token',
                'DAO treasury management',
              ] },
            ].map((phase) => (
              <motion.div key={phase.phase} variants={childFade}
                className="rounded-xl border p-5"
                style={{ borderColor: '#1E2530', background: 'rgba(14,18,24,0.4)' }}
              >
                <div className="mb-3 flex items-center gap-3">
                  <span className="text-base font-bold text-cream">{phase.phase}</span>
                  <span className="rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: phase.color, background: `${phase.color}15`, border: `1px solid ${phase.color}30` }}
                  >
                    {phase.status}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {phase.items.map((item) => (
                    <span key={item} className="rounded-lg px-3 py-1.5 text-[12px] text-cream-65"
                      style={{ background: 'rgba(200,184,154,0.05)', border: '1px solid rgba(200,184,154,0.1)' }}
                    >
                      {item}
                    </span>
                  ))}
                </div>
              </motion.div>
            ))}
          </motion.div>
        </AnimatedSection>

        <Divider />

        <AnimatedSection id="support">
          <SectionTitle icon="✉" title="Support" />
          <div className="rounded-lg border border-cream-08 bg-surface-secondary p-4 text-sm text-cream-50">
            <p>Questions, bug reports, or feedback? Reach us on X or by email:</p>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
              <a
                href="https://x.com/TeraHash"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-cream-65 transition hover:text-cream hover:underline"
              >
                @TeraHash on X
              </a>
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="font-medium text-cream-65 transition hover:text-cream hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>
            </div>
          </div>
        </AnimatedSection>

        {/* Bottom spacer */}
        <div className="h-20" />
      </div>
    </div>
  )
}
