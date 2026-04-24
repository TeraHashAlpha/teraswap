'use client'

import { useState, useEffect, useRef } from 'react'
import { motion, useInView } from 'framer-motion'

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
  { id: 'privacy', title: 'Privacy', icon: '◍' },
  { id: 'fee-structure', title: 'Fee Structure', icon: '◇' },
  { id: 'limit-orders', title: 'Limit Orders', icon: '⊕' },
  { id: 'stop-loss', title: 'Stop Loss / Take Profit', icon: '⛊' },
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
    { label: 'TeraSwap', sub: 'Queries 11 sources', color: '#E8D5B7' },
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
            TeraSwap is a <strong className="text-cream">meta-aggregator</strong> for decentralized exchanges on Ethereum.
            Instead of searching manually across multiple DEXs, TeraSwap queries <strong className="text-cream">11 independent
            liquidity sources</strong> simultaneously and automatically routes your trade through whichever offers the best
            net output — accounting for gas costs, slippage, and pool fees.
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
            <Tag>Open source</Tag>
            <Tag>11 DEX sources</Tag>
            <Tag>Multi-oracle verified</Tag>
            <Tag>MEV protected</Tag>
            <Tag>IP protected</Tag>
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
            The entire comparison happens in under <strong className="text-cream">5 seconds</strong>. Each source
            has an independent timeout — if one API is slow, the others still compete. The winning quote
            is then executed directly from the user&apos;s wallet with a single transaction.
          </p>
        </AnimatedSection>

        <Divider />

        {/* ═══ LIQUIDITY SOURCES ═══ */}
        <AnimatedSection id="liquidity-sources">
          <SectionTitle icon="◉" title="Liquidity Sources" />
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            TeraSwap integrates 11 liquidity sources across three categories: API aggregators that
            themselves search hundreds of pools, direct on-chain protocols, and intent-based systems.
          </p>

          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-cream-50">API Aggregators</h3>
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="mb-6 grid gap-3 sm:grid-cols-2"
          >
            <SourceCard name="1inch" type="Aggregator" desc="Pathfinder algorithm searching 400+ liquidity sources across DeFi." />
            <SourceCard name="0x / Matcha" type="Aggregator" desc="Professional-grade RFQ system with Permit2 gasless approvals." />
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

          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-cream-50">Intent-Based</h3>
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="grid gap-3 sm:grid-cols-2"
          >
            <SourceCard name="CoW Protocol" type="Intent" desc="Batch auction system where solvers compete to fill your order — full MEV protection, gasless execution." />
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
              { num: '01', title: 'Parallel Fan-Out', desc: 'All 11 sources queried simultaneously with independent 5s timeouts. No source blocks another.' },
              { num: '02', title: 'Gas-Aware Ranking', desc: 'Quotes ranked by net output considering estimated gas costs in USD. When outputs are close, cheaper gas wins the tiebreak. CoW Protocol (gasless for users) naturally benefits.' },
              { num: '03', title: 'Statistical Outlier Detection', desc: 'True median-based filtering removes manipulated quotes. Amounts sorted independently, median computed (average of two middle values for even counts), anything above 3× median is rejected.' },
              { num: '04', title: 'Uniswap V3 Fee-Tier Detection', desc: 'Automatically tests all 4 fee tiers (0.01%, 0.05%, 0.3%, 1%) and selects the pool with best output. Results are cached for faster subsequent quotes.' },
              { num: '05', title: 'Oracle Validation', desc: 'Before execution, the quoted rate is compared against Chainlink price feeds. Deviations above 2% trigger a warning; above 3% the swap is blocked. A second server-side check via DefiLlama blocks swaps >8% below fair market value.' },
              { num: '06', title: 'Cross-Quote Consensus', desc: 'The winning quote is compared against the median of all 11 sources. If it deviates >5% from consensus, a warning is raised. Quotes >3× above median are automatically removed as outliers.' },
              { num: '07', title: 'Slippage Safety', desc: 'User-configurable slippage clamped to [0.01%, 15%] — impossible to create negative factors. Enforced at both UI input and calculation level across all 11 sources.' },
              { num: '08', title: 'Multi-Chain EIP-712', desc: 'CoW Protocol signing uses the wallet\'s current chainId dynamically, enabling future multi-chain support without code changes.' },
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
              { title: 'Chainlink Oracle Validation', desc: 'Every swap rate is cross-referenced with decentralized price feeds. Supports 24+ token pairs with automatic deviation detection. Warns at 2%, blocks at 3%.', badge: 'Oracle' },
              { title: 'DefiLlama Server-Side Check', desc: 'A second independent oracle validates swap output on the server before returning calldata. Blocks swaps where output is >8% below fair market value. Covers thousands of tokens.', badge: 'Oracle' },
              { title: 'Cross-Quote Consensus', desc: 'The winning quote is validated against the median of all aggregator responses. Deviations >5% are flagged; quotes >3× above median are removed automatically.', badge: 'Safety' },
              { title: 'Privacy Proxy', desc: 'All blockchain reads and aggregator API calls are routed through a server-side proxy. Your IP address is never exposed to external RPC providers or DEX APIs.', badge: 'Privacy' },
              { title: 'MEV Protection', desc: 'CoW Protocol routes execute via batch auctions where professional solvers compete — your trade is never exposed to sandwich attacks.', badge: 'MEV' },
              { title: 'Permit2 Approvals', desc: 'Off-chain signature-based approvals eliminate the need for unlimited token allowances. Your tokens stay under your control.', badge: 'Approval' },
              { title: 'No Infinite Approvals', desc: 'Each approval is scoped to the exact amount needed for the swap. Nothing more, nothing less.', badge: 'Wallet' },
              { title: 'Non-Custodial', desc: 'TeraSwap never takes custody of your tokens. All swaps execute directly between your wallet and the DEX contracts.', badge: 'Trust' },
              { title: 'Transaction Simulation', desc: 'Before execution, the swap calldata is validated to ensure it will succeed. Failed simulations are caught before you spend gas.', badge: 'Safety' },
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
              { num: '01', title: 'RPC Privacy Proxy', desc: 'All on-chain read operations from the browser are routed through a server-side proxy (/api/rpc) instead of directly calling RPC providers. Only our server\'s IP is visible to Alchemy, LlamaRPC, and other providers — never yours.' },
              { num: '02', title: 'API Proxy Layer', desc: 'All external aggregator API calls (1inch, 0x, CoW, Odos, KyberSwap, etc.) are also proxied server-side through /api/quote and /api/swap. Your browser never makes direct requests to these services.' },
              { num: '03', title: 'Method Whitelist', desc: 'The RPC proxy only allows read-only methods (eth_call, eth_getTransactionReceipt, eth_getBalance, etc.). Write methods like eth_sendRawTransaction are blocked to prevent misuse.' },
              { num: '04', title: 'Rate Limiting', desc: '60 requests per IP per minute on the RPC proxy to prevent abuse. Swap endpoint limited to 20 requests per minute.' },
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
                  ['CoW Protocol order submission', '/api/orders', 'Yes'],
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
            TeraSwap maintains a transparent, simple fee structure with no hidden costs:
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

        {/* ═══ LIMIT ORDERS ═══ */}
        <AnimatedSection id="limit-orders">
          <SectionTitle icon="⊕" title="Limit Orders" />
          <p className="mb-6 text-[15px] leading-relaxed text-cream-65">
            Set your target price and let CoW Protocol solvers execute when the market reaches your level. Zero gas fees, MEV-protected, and partially fillable. Limit orders use <strong className="text-cream">2% default slippage</strong> and are ideal for precise entry and exit targets where you want solver competition to deliver the best possible fill price.
          </p>

          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="space-y-4"
          >
            {[
              { num: '01', title: 'Set Target Price', desc: 'Define exactly how many tokens you want to receive per unit sold. The market price is shown for reference, with percentage difference calculated in real-time.' },
              { num: '02', title: 'Choose Expiry', desc: 'Orders can be valid from 1 hour to 90 days. After expiry, unfilled orders are automatically removed from the orderbook.' },
              { num: '03', title: 'EIP-712 Signing', desc: 'Sign the order with your wallet — no on-chain transaction needed. Your tokens stay in your wallet until a solver fills the order.' },
              { num: '04', title: 'Solver Competition', desc: 'Professional solvers on CoW Protocol compete to fill your order at the best possible rate, often providing price improvement beyond your limit price.' },
              { num: '05', title: 'Partial Fills', desc: 'Enable partial fills to allow your order to be executed across multiple solver batches. This increases the chances of getting filled for larger orders.' },
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

        {/* ═══ STOP LOSS / TAKE PROFIT ═══ */}
        <AnimatedSection id="stop-loss">
          <SectionTitle icon="⛊" title="Stop Loss / Take Profit" />
          <p className="mb-4 text-[15px] leading-relaxed text-cream-65">
            Protect your positions or lock in gains automatically. Chainlink oracles monitor prices in real-time, and when your trigger is hit, a CoW Protocol limit order is auto-submitted for MEV-protected execution.
          </p>
          <div className="mb-6 rounded-lg border border-cream-08 bg-surface-secondary p-3 text-xs text-cream-50">
            <span className="font-semibold text-cream-65">Key difference from Limit Orders:</span> While limit orders let you target a specific price for a planned trade, SL/TP is designed to <strong className="text-cream-65">react to market movements</strong> and protect existing positions. Stop loss uses <strong className="text-cream-65">5% default slippage</strong> to prioritize fast execution during volatile drops, while take profit uses <strong className="text-cream-65">2% slippage</strong> like limit orders.
          </div>

          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={stagger} className="space-y-4"
          >
            {[
              { num: '01', title: 'Set Trigger Price (USD)', desc: 'Define your stop loss or take profit level in USD. For stop loss, the order triggers when price drops below your target. For take profit, it triggers when price rises above.' },
              { num: '02', title: 'Chainlink Oracle Monitoring', desc: 'Prices are polled every 5 seconds via Chainlink on-chain oracles — the industry standard for reliable, tamper-proof price feeds.' },
              { num: '03', title: 'Automatic Execution', desc: 'When your trigger fires, a CoW Protocol limit order is automatically created and submitted. You sign once upfront — no manual action needed at trigger time.' },
              { num: '04', title: 'MEV-Protected Fill', desc: 'The triggered order goes through CoW Protocol\'s solver competition, ensuring MEV-protected execution with zero gas fees.' },
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
              { num: '01', title: 'Quote Collection', desc: 'All 11 sources are queried at multiple sub-amounts (20%, 30%, 40%, 50%, 60%, 70%, 80%) in parallel. Each source reports its output for each partial amount.' },
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
              { n: 3, title: 'Hourly Heatmap', desc: 'Visual breakdown of volume by hour (UTC), revealing peak trading windows and optimal DCA scheduling times.' },
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
                'Meta-aggregator with 11 liquidity sources',
                'Chainlink oracle price validation (2% warn / 3% block)',
                'DefiLlama server-side oracle validation',
                'Cross-quote median consensus validation',
                'Privacy proxy (IP hidden from all external services)',
                'MEV protection via CoW Protocol',
                'Permit2 + EIP-2612 gasless approvals',
                'Active approvals manager with revoke',
                'Curve Finance on-chain routing',
                'Smart DCA with price-aware buying windows',
                'Gas-aware quote ranking',
                'Statistical outlier detection (true median)',
                'Slippage safety clamp across all sources',
                'Dynamic multi-chain EIP-712 signing',
                'Limit orders via CoW Protocol (zero gas, partially fillable)',
                'Stop loss + take profit (Chainlink-triggered, adaptive slippage)',
                'Split routing (multi-DEX trade optimization)',
                'Public analytics dashboard (volume, routes, pairs, activity)',
                'Private admin monitor (revenue, sybil detection, wallet cohorts)',
                'Sybil/wash trading detector (6 heuristics + wallet clustering)',
                'Airdrop-ready wallet snapshots & exports',
                'Supabase backend (24/7 order monitoring without PC)',
                'Fee collection smart contract (verified on Etherscan)',
                'Order Engine smart contract (EIP-712 signed orders)',
                'Sentry error monitoring',
              ] },
              { phase: 'Phase 2', status: 'Next', color: '#C8B89A', items: [
                'Own DCA smart contracts (Chainlink Automation)',
                'Trailing stop loss (auto-adjust trigger)',
                'Bebop RFQ (12th source)',
                'Base network support',
                'Multi-hop Curve routing',
              ] },
              { phase: 'Phase 3', status: 'Planned', color: 'rgba(200,184,154,0.4)', items: [
                'Multi-chain expansion (Arbitrum, Optimism, Base)',
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

        {/* Bottom spacer */}
        <div className="h-20" />
      </div>
    </div>
  )
}
