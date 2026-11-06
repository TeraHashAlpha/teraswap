'use client'

import { DISABLED_SOURCES, SUPPORT_EMAIL } from '@/lib/constants'
import {
  INTEGRATED_DEX_SOURCE_COUNT,
  INTEGRATED_DEX_SOURCES_CLAIM,
  INTEGRATED_DEX_SOURCE_LABELS,
  ADMIN_TIMELOCK_GRACE_DAYS,
  ADMIN_TIMELOCK_HOURS,
  ADMIN_TRANSFER_TIMELOCK_DAYS,
  CHAINLINK_STALENESS_CLAIM,
  CROSS_QUOTE_WARN_PCT,
  DEFILLAMA_BLOCK_PCT,
  DEFILLAMA_HIGH_VALUE_USD_LABEL,
  OUTLIER_MEDIAN_MULTIPLE,
  PLATFORM_FEE_BPS,
  PLATFORM_FEE_LABEL,
  PRIVACY_BADGE,
  PRIVACY_DIRECT_NOTE,
  PRIVACY_PROXY_CLAIM,
  PRICE_DEVIATION_BLOCK_PCT,
  PRICE_DEVIATION_WARN_PCT,
  QUOTE_TIMEOUT_SEC,
  SLIPPAGE_CLAMP_MAX_PCT,
  SLIPPAGE_CLAMP_MIN_PCT,
  SPLIT_MIN_IMPROVEMENT_BPS_SLOT,
  SPLIT_MIN_IMPROVEMENT_PCT,
  SWAP_CHAIN_LIST_LABEL,
  UNISWAP_FEE_TIER_COUNT,
  UNISWAP_FEE_TIER_LABELS,
  chainNameFor,
  chainlinkFeedCountFor,
  isOrderTypeLive,
} from '@/config/product-claims'
import { useQuoteChainId } from '@/hooks/useChainId'
import { EyebrowLabel, Surface } from '../primitives'
import { useScrollSpy, scrollToSection } from './use-scroll-spy'
import './docs-legal.css'

/**
 * [feat/ui-v2-docs-legal] v2 Docs — a full restyle of v1's DocsPage.tsx, six owner-approved containers (5 Nov):
 *   (1) tables -> hairline rows, no box/fill
 *   (2) sticky TOC / scroll-spy -> a text list, one hairline per item, active item cream
 *   (3) long prose on the photo -> a LOCAL scrim (docs-legal.css), not the shell's uniform appScrim
 *   (4) FlowDiagram -> a numbered 01-0N list with hairlines (landing FeaturesSection pattern), no boxes/arrows
 *   (5) SourceCard grid -> one hairline row per source
 *   (6) ComingSoonBanner -> a strip with an accent (FUNCTIONAL-CONTAINERS item 14); Tag -> mono caps text
 * Every OTHER repeating "numbered step" card in v1 (Smart Routing, Order Engine, Limit, SL/TP, DCA, Split
 * Routing, Security, Analytics, Roadmap) falls under the general no-box rule already applied elsewhere in v2
 * (same hairline-numbered-row shape as (4)/(5) — no separate owner decision needed for those).
 * Text content below is byte-identical to v1's DocsPage.tsx (product-claims stay live); a parity test and a
 * claims-live test both pin that. No framer-motion / scroll-reveal here — static render, nothing to animate.
 */

interface DocSection {
  id: string
  title: string
  icon: string
}

const SECTIONS: DocSection[] = [
  { id: 'overview', title: 'Overview', icon: '◈' },
  { id: 'architecture', title: 'Architecture', icon: '⬡' },
  { id: 'liquidity-sources', title: 'Liquidity Sources', icon: '◉' },
  { id: 'smart-routing', title: 'Smart Routing', icon: '⟁' },
  { id: 'security', title: 'Security', icon: '⬢' },
  { id: 'mev', title: 'MEV & CoW Protocol', icon: '⌬' },
  { id: 'privacy', title: 'Privacy', icon: '◍' },
  { id: 'fee-structure', title: 'Fee Structure', icon: '◇' },
  { id: 'order-engine', title: 'Order Engine', icon: '⊞' },
  { id: 'limit-orders', title: 'Limit Orders', icon: '⊕' },
  { id: 'stop-loss', title: 'Stop Loss / Take Profit', icon: '⛊' },
  { id: 'dca', title: 'DCA', icon: '⟳' },
  { id: 'split-routing', title: 'Split Routing', icon: '⫘' },
  { id: 'analytics', title: 'Analytics Dashboard', icon: '◫' },
  { id: 'roadmap', title: 'Roadmap', icon: '▸' },
  { id: 'support', title: 'Support', icon: '✉' },
]

/* ── shared wrapper primitives ─────────────────────────────────────────── */

function SectionTitle({ icon, title }: { icon: string; title: string }) {
  return (
    <div className="mb-6 flex items-center gap-3">
      <span className="text-xl text-v2-cream">{icon}</span>
      <h2 className="font-v2-display text-[26px] font-bold uppercase leading-none text-v2-text sm:text-[32px]">{title}</h2>
    </div>
  )
}

function Rule() {
  return <div className="ts-v2-rule-t my-8" />
}

/** Container 6: Tag -> mono caps text, never a pill. */
function DocTag({ children }: { children: React.ReactNode }) {
  return <span className="font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-cream">{children}</span>
}

/** Container 6: ComingSoonBanner -> a strip with an accent, same surface the toasts/notice banner use. */
function ComingSoonBanner({ note }: { note?: string }) {
  return (
    <Surface variant="strip" accent="amber" className="mb-5 flex items-start gap-3 px-4 py-3">
      <DocTag>Coming Soon</DocTag>
      <p className="text-[13px] leading-relaxed text-v2-muted">
        {note ?? 'This feature is not yet available — the section below is a preview of upcoming functionality.'}
      </p>
    </Surface>
  )
}

/** Containers (4) and most of the page's own repeating "numbered step" cards: one hairline row, no box. */
function StepRow({ num, badge, title, desc }: { num?: string; badge?: string; title: string; desc: string }) {
  return (
    <div className="ts-v2-rule-t flex gap-4 py-5">
      {num ? (
        <span className="mt-0.5 font-v2-display text-2xl font-bold leading-none text-v2-dim">
          {num}
        </span>
      ) : null}
      <div className="min-w-0">
        {badge ? (
          <div className="mb-1">
            <DocTag>{badge}</DocTag>
          </div>
        ) : null}
        {/* h3, not v1's h4: a step row sits directly under the h2 SectionTitle with no intervening h3 in these
            sections, so h4 would skip a level (a11y finding during this restyle — v1 has the same gap). */}
        <h3 className="mb-1 text-[15px] font-semibold text-v2-text">{title}</h3>
        <p className="text-[13px] leading-relaxed text-v2-muted">{desc}</p>
      </div>
    </div>
  )
}

/** Container (4): FlowDiagram -> a numbered 01-0N list, no boxes, no connecting arrows. */
function FlowDiagram() {
  const steps = [
    { label: 'User', sub: 'Initiates swap' },
    { label: 'TeraSwap', sub: 'Queries all sources' },
    { label: 'Compare', sub: 'Best net output' },
    { label: 'Validate', sub: 'Chainlink oracle' },
    { label: 'Execute', sub: 'On-chain swap' },
  ]
  return (
    <ol className="my-8 list-none">
      {steps.map((step, i) => (
        <li key={step.label} className="ts-v2-rule-t flex items-center gap-4 py-3">
          <span className="font-v2-display text-xl font-bold leading-none text-v2-dim">{String(i + 1).padStart(2, '0')}</span>
          <span className="text-[14px] font-semibold text-v2-text">{step.label}</span>
          <span className="text-[12px] text-v2-muted">{step.sub}</span>
          {/* The numbered list replaces v1's boxed steps; this plain separator (not a box, not a connecting
              line) keeps the same "→" v1 shows between steps so nothing is lost. */}
          {i < steps.length - 1 ? <span className="text-v2-dim">→</span> : null}
        </li>
      ))}
    </ol>
  )
}

/** Container (5): SourceCard grid -> one hairline row per source. */
function SourceRow({ name, type, desc }: { name: string; type: string; desc: string }) {
  return (
    <div className="ts-v2-rule-t flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="mb-0.5 text-[14px] font-semibold text-v2-text">{name}</div>
        <p className="text-[13px] leading-relaxed text-v2-muted">{desc}</p>
      </div>
      <div className="shrink-0 pt-0.5">
        <DocTag>{type}</DocTag>
      </div>
    </div>
  )
}

/** Container (1): a hairline-row table, no box/fill. */
function DocTable({ head, rows }: { head: readonly string[]; rows: readonly (readonly [string, string, string])[] }) {
  return (
    <div className="my-6 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="ts-v2-rule-b">
            {head.map((h) => (
              <th key={h} className="px-0 py-3 pr-5 text-left font-semibold text-v2-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-v2-muted">
          {rows.map((row, i) => (
            <tr key={i} className="ts-v2-rule-t">
              {row.map((cell, c) => (
                <td key={c} className={`px-0 py-3 pr-5 ${c === 0 ? 'font-medium text-v2-text' : c === 2 && (cell === 'None' || cell === 'Yes') ? 'font-bold text-v2-green' : ''}`}>
                  {c === 1 ? <span className="font-v2-mono text-xs text-v2-cream">{cell}</span> : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ── main component ─────────────────────────────────────────────────────── */

export function DocsTabV2() {
  const chainId = useQuoteChainId()
  const chainName = chainNameFor(chainId)
  const feedCount = chainlinkFeedCountFor(chainId)
  const activeId = useScrollSpy(SECTIONS.map((s) => s.id))

  const tocList = (
    <ol className="mt-4 space-y-0">
      {SECTIONS.map((s) => {
        const active = activeId === s.id
        return (
          <li key={s.id} className="ts-v2-rule-t">
            <button
              type="button"
              onClick={() => scrollToSection(s.id)}
              aria-current={active ? 'true' : undefined}
              className={`flex w-full items-center gap-2 py-2 text-left text-[13px] transition-colors ${active ? 'text-v2-cream' : 'text-v2-muted hover:text-v2-text'}`}
            >
              <span className="text-xs">{s.icon}</span>
              {s.title}
            </button>
          </li>
        )
      })}
    </ol>
  )

  return (
    <div className="relative mx-auto flex max-w-6xl gap-10 lg:gap-14">
      {/* Container 2: sticky TOC / scroll-spy — a text list, one hairline per item, active item cream. Desktop
          (>= 1024) only; below that it collapses to an in-page list (MobileToc, further down). */}
      <nav aria-label="Table of contents" className="sticky top-24 hidden h-fit w-56 shrink-0 lg:block">
        <EyebrowLabel>Documentation</EyebrowLabel>
        {tocList}
        <div className="ts-v2-rule-t mt-6 py-3 text-center text-[10px] text-v2-dim">
          TeraSwap Protocol v1.0
          <br />
          <span>{SWAP_CHAIN_LIST_LABEL}</span>
        </div>
      </nav>

      {/* Container 3: a local scrim for the prose, not the shell's uniform appScrim (ContentShell omits it). */}
      <div className="ts-v2-prose-scrim min-w-0 flex-1 px-4 pb-20 pt-2 sm:px-6">
        <div className="relative z-[1]">
          <div className="mb-8">
            {/* v1 has no <h1> on this page at all (a pre-existing gap); added here so the heading order is well
                formed (h1 -> h2 section titles -> h3 sub-headings) — additive only, nothing v1 shows is removed. */}
            <EyebrowLabel>Documentation</EyebrowLabel>
            <h1 className="sr-only">TeraSwap Documentation</h1>
            <div className="mt-4 inline-flex items-center gap-2">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-v2-green" />
              <span className="font-v2-mono text-[11px] font-semibold uppercase tracking-[1.5px] text-v2-muted">Live on {SWAP_CHAIN_LIST_LABEL}</span>
            </div>
          </div>

          {/* Below 1024: the TOC collapses to an in-page list (a <details>, not sticky, not a sidebar). */}
          <details className="ts-v2-rule-t mb-8 pb-2 lg:hidden">
            <summary className="cursor-pointer py-2 font-v2-mono text-[11px] font-bold uppercase tracking-[2px] text-v2-cream">Documentation</summary>
            {tocList}
          </details>

          {/* ═══ OVERVIEW ═══ */}
          <section id="overview" className="scroll-mt-28">
            <SectionTitle icon="◈" title="Overview" />
            <p className="mb-4 text-[15px] leading-relaxed text-v2-muted">
              TeraSwap is a <strong className="text-v2-text">meta-aggregator</strong> for decentralized exchanges. Instant swaps are live on{' '}
              {SWAP_CHAIN_LIST_LABEL}. Instead of searching manually across multiple DEXs, TeraSwap queries
              <strong className="text-v2-text"> {INTEGRATED_DEX_SOURCE_COUNT} independent liquidity sources</strong> simultaneously and
              automatically routes your trade through whichever offers the best net output — accounting for gas costs, slippage, and pool fees.
            </p>
            <p className="mb-6 text-[15px] leading-relaxed text-v2-muted">
              Every swap is validated against <strong className="text-v2-text">Chainlink price oracles</strong> and{' '}
              <strong className="text-v2-text">DefiLlama</strong> to protect against price manipulation.{' '}
              {PRIVACY_PROXY_CLAIM} See{' '}
              <em>Privacy</em> for what is not proxied.
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <DocTag>Non-custodial</DocTag>
              <DocTag>Permissionless · no KYC</DocTag>
              <DocTag>{INTEGRATED_DEX_SOURCES_CLAIM}</DocTag>
              <DocTag>Multi-oracle verified</DocTag>
              <DocTag>{PRIVACY_BADGE}</DocTag>
              <DocTag>Not externally audited</DocTag>
            </div>
          </section>

          <Rule />

          {/* ═══ ARCHITECTURE ═══ */}
          <section id="architecture" className="scroll-mt-28">
            <SectionTitle icon="⬡" title="Architecture" />
            <p className="mb-4 text-[15px] leading-relaxed text-v2-muted">
              TeraSwap operates as a client-side meta-aggregator. When a user initiates a swap, the protocol performs a parallel fan-out query to
              all integrated sources, normalizes the responses into a common format, and ranks them by net output (amount received minus
              estimated gas).
            </p>
            <FlowDiagram />
            <p className="text-[15px] leading-relaxed text-v2-muted">
              Each source has an independent timeout — if one API is slow, the others still compete. The winning quote is then executed directly
              from the user&apos;s wallet with a single transaction.
            </p>
          </section>

          <Rule />

          {/* ═══ LIQUIDITY SOURCES ═══ */}
          <section id="liquidity-sources" className="scroll-mt-28">
            <SectionTitle icon="◉" title="Liquidity Sources" />
            <p className="mb-6 text-[15px] leading-relaxed text-v2-muted">
              TeraSwap integrates {INTEGRATED_DEX_SOURCE_COUNT} liquidity sources across three categories: API aggregators that themselves search
              hundreds of pools, direct on-chain protocols, and intent-based systems. Every integrated adapter is queried in parallel on each
              quote; sources marked Disabled are listed for reference only and are never queried.
            </p>

            <h3 className="mb-1 text-sm font-semibold uppercase tracking-wider text-v2-muted">API Aggregators</h3>
            <div className="mb-6">
              <SourceRow name="1inch" type="Aggregator" desc="Pathfinder algorithm searching 400+ liquidity sources across DeFi." />
              <SourceRow name="0x / Matcha" type="Aggregator" desc="Professional-grade RFQ system; uses Permit2's pull model for allowances." />
              <SourceRow name="Velora (ParaSwap)" type="Aggregator" desc="Multi-path routing with MEV-aware execution strategies." />
              <SourceRow name="Odos" type="Disabled" desc={`Smart order routing with atomic multi-hop path optimization. Disabled: ${DISABLED_SOURCES.odos}.`} />
              <SourceRow name="KyberSwap" type="Aggregator" desc="Dynamic trade routing across 100+ DEXs with auto-compounding." />
              <SourceRow name="OpenOcean" type="Disabled" desc={`Cross-chain aggregation covering 40+ chains and 1000+ sources. Disabled: ${DISABLED_SOURCES.openocean}.`} />
            </div>

            <h3 className="mb-1 text-sm font-semibold uppercase tracking-wider text-v2-muted">Direct Protocols</h3>
            <div className="mb-6">
              <SourceRow name="Uniswap V3" type="Direct" desc="On-chain concentrated liquidity with auto fee-tier detection across 4 pools." />
              <SourceRow name="SushiSwap" type="Direct" desc="RouteProcessor4 with smart routing across Sushi's native pools." />
              <SourceRow name="Balancer" type="Disabled" desc={`Smart Order Router optimizing across weighted, stable, and boosted pools. Disabled: ${DISABLED_SOURCES.balancer}.`} />
              <SourceRow name="Curve Finance" type="On-Chain" desc="CurveRouterNG for optimized stablecoin and crypto pool swaps with minimal slippage." />
            </div>

            <h3 className="mb-1 text-sm font-semibold uppercase tracking-wider text-v2-muted">Intent-Based &amp; RFQ</h3>
            <div>
              <SourceRow
                name="CoW Protocol"
                type="Intent"
                desc="Batch auction system where solvers compete to fill your order, with no gas paid by the user at execution."
              />
              <SourceRow name="Bebop" type="Disabled" desc={`Request-for-quote market makers via JAM settlement. Disabled: ${DISABLED_SOURCES.bebop}.`} />
            </div>
          </section>

          <Rule />

          {/* ═══ SMART ROUTING ═══ */}
          <section id="smart-routing" className="scroll-mt-28">
            <SectionTitle icon="⟁" title="Smart Routing" />
            <p className="mb-2 text-[15px] leading-relaxed text-v2-muted">The routing engine runs several optimization layers to find the true best execution:</p>
            <div>
              {[
                { num: '01', title: 'Parallel Fan-Out', desc: `All registered sources are queried simultaneously, each with an independent ${QUOTE_TIMEOUT_SEC}-second timeout. No source blocks another — a slow API simply drops out of that round.` },
                { num: '02', title: 'Gas-Aware Ranking', desc: 'Quotes ranked by net output considering estimated gas costs in USD. When outputs are close, cheaper gas wins the tiebreak. CoW Protocol (gasless for users) naturally benefits.' },
                { num: '03', title: 'Statistical Outlier Detection', desc: `True median-based filtering removes manipulated quotes. Amounts sorted independently, median computed (average of two middle values for even counts), anything above ${OUTLIER_MEDIAN_MULTIPLE}× median is rejected.` },
                { num: '04', title: 'Uniswap V3 Fee-Tier Detection', desc: `Automatically tests all ${UNISWAP_FEE_TIER_COUNT} fee tiers (${UNISWAP_FEE_TIER_LABELS.join(', ')}) and selects the pool with best output. Results are cached for faster subsequent quotes.` },
                { num: '05', title: 'Oracle Validation', desc: `Before execution, the quoted rate is compared against Chainlink price feeds. Deviations above ${PRICE_DEVIATION_WARN_PCT} trigger a warning; above ${PRICE_DEVIATION_BLOCK_PCT} the swap is blocked. A second server-side check via DefiLlama blocks swaps >${DEFILLAMA_BLOCK_PCT} below fair market value.` },
                { num: '06', title: 'Cross-Quote Consensus', desc: `The winning quote is compared against the median of all responding sources. If it deviates >${CROSS_QUOTE_WARN_PCT} from consensus, a warning is raised. Quotes >${OUTLIER_MEDIAN_MULTIPLE}× above median are automatically removed as outliers.` },
                { num: '07', title: 'Slippage Safety', desc: `User-configurable slippage clamped to [${SLIPPAGE_CLAMP_MIN_PCT}%, ${SLIPPAGE_CLAMP_MAX_PCT}%] — impossible to create negative factors. Enforced at both UI input and calculation level across every source.` },
                { num: '08', title: 'Chain-Aware EIP-712', desc: "EIP-712 signing binds to the wallet's current chainId dynamically. This is what lets the order engine operate per-chain today — a separate OrderExecutor is deployed on both Ethereum Mainnet and Base — rather than being mainnet-only." },
              ].map((step) => (
                <StepRow key={step.num} num={step.num} title={step.title} desc={step.desc} />
              ))}
            </div>
          </section>

          <Rule />

          {/* ═══ SECURITY ═══ */}
          <section id="security" className="scroll-mt-28">
            <SectionTitle icon="⬢" title="Security" />
            <p className="mb-2 text-[15px] leading-relaxed text-v2-muted">TeraSwap is designed with multiple security layers that protect users at every stage of a trade:</p>
            <div>
              {[
                { title: 'Chainlink Oracle Validation', desc: `Every swap rate is cross-referenced with decentralized price feeds — both the input and output token of each swap are checked. The ${chainName} registry covers ${feedCount} token feeds, with automatic deviation detection: warns at ${PRICE_DEVIATION_WARN_PCT}, hard-blocks at ${PRICE_DEVIATION_BLOCK_PCT}. ${CHAINLINK_STALENESS_CLAIM}`, badge: 'Oracle' },
                { title: 'DefiLlama Server-Side Check', desc: `A second independent oracle validates swap output on the server before returning calldata. Blocks swaps where output is >${DEFILLAMA_BLOCK_PCT} below fair market value. If this secondary oracle is unreachable, swaps estimated above ${DEFILLAMA_HIGH_VALUE_USD_LABEL} are blocked while small swaps fail open.`, badge: 'Oracle' },
                { title: 'Cross-Quote Consensus', desc: `The winning quote is validated against the median of all aggregator responses. Deviations >${CROSS_QUOTE_WARN_PCT} are flagged; quotes >${OUTLIER_MEDIAN_MULTIPLE}× above median are removed automatically.`, badge: 'Safety' },
                { title: 'Privacy Proxy', desc: `${PRIVACY_PROXY_CLAIM} ${PRIVACY_DIRECT_NOTE}`, badge: 'Privacy' },
                { title: 'Exact-Amount Approvals', desc: "Approvals are always scoped to the exact amount needed and granted directly to the actual spender, which is checked against a trusted allowlist — never an infinite/max-uint approval. (The 0x source uses Permit2's pull model, which still requires an on-chain approve to the Permit2 contract — TeraSwap does not ship gasless off-chain signature approvals as the general path.)", badge: 'Approval' },
                { title: 'Non-Custodial', desc: 'TeraSwap never takes custody of your tokens. The fee-collector contract pulls funds, takes the fee, forwards the net to the DEX router, and atomically refunds any leftovers in the same transaction — it never holds user funds between transactions.', badge: 'Trust' },
                { title: 'Permissionless · No KYC', desc: 'There is no sign-up, no account, and no identity check. You connect a wallet and trade directly with on-chain contracts.', badge: 'Access' },
                { title: 'Token-Catalog Guard (CI)', desc: 'Every curated token is verified against its on-chain reality before it ships: contract bytecode must exist (no dead addresses), on-chain symbol() and decimals() must match the catalog entry (decimals are fund-affecting for swap sizing), the address must appear in a reputable per-chain token list, and no two catalog tokens may share a symbol on the same chain. This runs as a CI gate.', badge: 'Safety' },
                { title: 'On-Chain Admin Timelocks', desc: `Sensitive contract admin actions are time-locked: changing the whitelist of allowed DEX routers, adding/removing a whitelisted executor, and fund sweeps each take effect only after a ${ADMIN_TIMELOCK_HOURS}-hour delay (and expire if not executed within a ${ADMIN_TIMELOCK_GRACE_DAYS}-day grace window). An emergency pause is also available.`, badge: 'Contract' },
                { title: 'Audit Status', desc: "TeraSwap's smart contracts have not been externally audited. Contracts are deployed and verified on the block explorer; the underlying DEXs you route through have their own audited contracts.", badge: 'Notice' },
              ].map((item) => (
                <StepRow key={item.title} badge={item.badge} title={item.title} desc={item.desc} />
              ))}
            </div>
          </section>

          <Rule />

          {/* ═══ MEV & COW PROTOCOL ═══ [feat/retire-force-mev, owner 2026-11-06] Was "MEV Protection": TeraSwap makes no MEV-related promise; CoW is an ordinary source. */}
          <section id="mev" className="scroll-mt-28">
            <SectionTitle icon="⌬" title="MEV & CoW Protocol" />
            <p className="mb-6 text-[15px] leading-relaxed text-v2-muted">
              Most DEX trades on Ethereum settle on a public mempool, which is where searchers and block builders extract value from regular
              users. TeraSwap does not claim to prevent MEV: it compares quotes and routes each swap through the source with the best net
              output, and the transaction-preview screen shows the route and the on-chain-enforced minimum output before you sign.
            </p>

            <h3 className="mb-2 mt-8 font-v2-display text-[18px] font-semibold text-v2-text">What is MEV?</h3>
            <p className="mb-6 text-[15px] leading-relaxed text-v2-muted">
              MEV (Maximal Extractable Value) is profit that block builders and searchers can capture by reordering, inserting, or censoring
              transactions inside the block they produce. For DEX users this most often appears as a <strong className="text-v2-text">sandwich attack</strong>: a
              bot spots a pending swap in the public mempool, places its own buy directly in front of it to push the price up, then sells
              immediately after at the inflated price — taking the difference out of the user&apos;s slippage budget. Researchers at Flashbots
              and elsewhere estimate cumulative MEV extracted from Ethereum users in the billions of USD since 2020.
            </p>

            <h3 className="mb-2 mt-8 font-v2-display text-[18px] font-semibold text-v2-text">CoW Protocol is an ordinary source</h3>
            <p className="mb-4 text-[15px] leading-relaxed text-v2-muted">
              CoW Protocol is one of the liquidity sources TeraSwap compares on every quote. It is used only when it answers and its quote
              ranks best, exactly like any other source. When it does:
            </p>
            <ul className="mb-6 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-v2-muted marker:text-v2-dim">
              <li>
                You sign an <strong className="text-v2-text">off-chain EIP-712 order</strong>, not a transaction, and pay no gas to submit it.
              </li>
              <li>
                Professional solvers compete in a <strong className="text-v2-text">batch auction</strong> to fill the order. How that auction treats
                MEV is part of CoW Protocol&apos;s own design, described in its documentation — not a TeraSwap guarantee.
              </li>
            </ul>
            <p className="mb-6 text-[15px] leading-relaxed text-v2-muted">
              Every other route — aggregator APIs and direct on-chain swaps (Uniswap V3, Curve, SushiSwap) — is a public-mempool transaction.
              To reduce mempool exposure in general, you can configure a privacy-focused RPC in your wallet settings (see <em>Privacy</em>).
            </p>
          </section>

          <Rule />

          {/* ═══ PRIVACY ═══ */}
          <section id="privacy" className="scroll-mt-28">
            <SectionTitle icon="◍" title="Privacy" />
            <p className="mb-6 text-[15px] leading-relaxed text-v2-muted">
              TeraSwap implements a privacy-preserving architecture that protects users&apos; IP addresses from external blockchain
              infrastructure providers and aggregator APIs.
            </p>

            <div>
              {[
                { num: '01', title: 'RPC Privacy Proxy', desc: "All on-chain read operations from the browser are routed through a server-side proxy (/api/rpc) instead of directly calling RPC providers. Only our server's IP is visible to the third-party RPC providers while the proxy is reachable (see Graceful Degradation)." },
                { num: '02', title: 'API Proxy Layer', desc: `All external aggregator API calls (${INTEGRATED_DEX_SOURCE_LABELS.join(', ')}) are also proxied server-side through /api/quote and /api/swap. Quote and swap requests do not go directly from your browser to these services.` },
                { num: '03', title: 'Method Policy (Blacklist)', desc: 'The RPC proxy relays every read method by default and explicitly blocks only signing/transaction methods (eth_sendRawTransaction, eth_sendTransaction, eth_signTransaction, eth_sign, personal_sign and the eth_signTypedData variants). A blacklist is used deliberately — a method whitelist devolves into whack-a-mole. Your wallet still signs and broadcasts transactions itself; the proxy never sees your keys.' },
                { num: '04', title: 'Rate Limiting', desc: '300 requests per IP per minute on the RPC proxy to prevent abuse. The swap endpoint is limited to 20 requests per minute.' },
                { num: '05', title: 'Graceful Degradation', desc: 'If the privacy proxy is unreachable, the client falls back to direct RPC. Privacy is never a single point of failure — connectivity takes priority.' },
              ].map((step) => (
                <StepRow key={step.num} num={step.num} title={step.title} desc={step.desc} />
              ))}
            </div>

            <DocTable
              head={['External Service', 'Proxy Endpoint', 'IP Hidden']}
              rows={[
                ['All DEX aggregator quotes', '/api/quote', 'Yes'],
                ['Swap calldata from all aggregators', '/api/swap', 'Yes'],
                ['RPC reads (eth_call, receipts, etc.)', '/api/rpc', 'Yes'],
                ['Conditional-order create / read', '/api/orders', 'Yes'],
                ['Spender addresses', '/api/spender', 'Yes'],
              ]}
            />

            <div className="mt-4 text-xs text-v2-muted">
              <span className="font-semibold text-v2-text">Note:</span> Your wallet&apos;s own RPC connection (MetaMask, Coinbase Wallet, etc.)
              and transaction signing are handled by your wallet directly and are not proxied. For maximum privacy, configure a privacy-focused
              RPC in your wallet settings (e.g., MEV Blocker, Flashbots Protect). {PRIVACY_DIRECT_NOTE}
            </div>
          </section>

          <Rule />

          {/* ═══ FEES ═══ */}
          <section id="fee-structure" className="scroll-mt-28">
            <SectionTitle icon="◇" title="Fee Structure" />
            <p className="mb-6 text-[15px] leading-relaxed text-v2-muted">
              TeraSwap charges a flat <strong className="text-v2-text">{PLATFORM_FEE_LABEL} ({PLATFORM_FEE_BPS} bps)</strong> platform fee,
              deducted from the input amount before the swap and collected on-chain by the <strong className="text-v2-text">TeraSwapFeeCollector</strong>{' '}
              contract. The collector pulls the input, takes the fee, forwards the net amount to the DEX router, and atomically refunds any
              leftover input and ETH in the same transaction — so it never holds your funds between transactions. Token approvals to the
              collector are <strong className="text-v2-text">exact-amount</strong> (never infinite / max-uint), granted directly to the spender.
              No spread markup, no hidden costs.
            </p>

            <DocTable
              head={['Fee Type', 'Amount', 'Notes']}
              rows={[
                ['Platform fee', PLATFORM_FEE_LABEL, 'Deducted from input amount before swap. Fully transparent.'],
                ['Pool fee (Uniswap V3)', `${UNISWAP_FEE_TIER_LABELS[0]} – ${UNISWAP_FEE_TIER_LABELS[UNISWAP_FEE_TIER_LABELS.length - 1]}`, 'Charged by the liquidity pool. TeraSwap auto-selects the cheapest tier.'],
                ['Gas', 'Variable', 'Network gas paid in ETH. CoW Protocol swaps are gasless for the user.'],
                ['Hidden fees', 'None', 'No spread markup, no referral fees, no deposit or withdrawal fees.'],
              ]}
            />
          </section>

          <Rule />

          {/* ═══ ORDER ENGINE ═══ */}
          <section id="order-engine" className="scroll-mt-28">
            <SectionTitle icon="⊞" title="Order Engine" />
            <p className="mb-4 text-[15px] leading-relaxed text-v2-muted">
              Limit orders, stop-loss / take-profit, and DCA are all <strong className="text-v2-text">conditional orders</strong> on a single
              on-chain engine: the non-upgradeable <strong className="text-v2-text">TeraSwapOrderExecutor</strong> contract (EIP-712 domain{' '}
              <span className="font-v2-mono text-[13px] text-v2-text">TeraSwapOrderExecutor</span> version 2). You place an order by signing it{' '}
              <strong className="text-v2-text">off-chain with EIP-712</strong> — there is no on-chain transaction to create an order — and an
              autonomous keeper later executes it on-chain when its conditions are met. Conditional orders are{' '}
              <strong className="text-v2-text">not</strong> routed through CoW Protocol; CoW is only used for instant swaps, as one of the
              compared liquidity sources.
            </p>
            <p className="mb-2 text-[15px] leading-relaxed text-v2-muted">
              There are three order types: <strong className="text-v2-text">LIMIT</strong>, <strong className="text-v2-text">STOP_LOSS</strong>,
              and <strong className="text-v2-text">DCA</strong>. Take-profit is not a separate type — it is a STOP_LOSS order with an
              &ldquo;above&rdquo; price condition (stop-loss uses &ldquo;below&rdquo;).
            </p>

            <div>
              {[
                { num: '01', title: 'Sign Once, Off-Chain (EIP-712)', desc: 'You sign the order with your wallet and grant a direct, exact-amount ERC-20 allowance to the executor contract for the order total — never an infinite/max-uint approval, and not Permit2. The executor pulls tokens via a direct transferFrom when it executes. No transaction is broadcast to place the order.' },
                { num: '02', title: 'Whitelisted DEX Routing', desc: 'When a keeper executes an order, the contract routes the swap through a whitelisted DEX router (1inch by default) and enforces a per-execution minimum-output (slippage) floor. The router set is governed on-chain by an allowlist.' },
                { num: '03', title: 'On-Chain Validation (canExecute)', desc: 'Before any execution the contract independently re-checks the order signature, that it is not cancelled or nonce-invalidated, that it has not expired, the router whitelist, the schedule, the price condition, and that your balance and allowance still cover the amount. The same checks are re-enforced inside executeOrder — the gate is on-chain, not advisory.' },
                { num: '04', title: 'Chainlink Price Conditions', desc: 'Limit and stop-loss / take-profit orders carry a Chainlink price feed plus a target price and a direction (above / below). The order is only eligible once the on-chain feed crosses the trigger. (A pure DCA order carries no price condition — see the DCA section.)' },
                { num: '05', title: 'Cancel & Mass-Invalidate', desc: 'Any order can be cancelled on-chain at any time, and a single mass nonce-invalidation can void all of your pending orders at once. You stay in control of your own funds throughout.' },
                { num: '06', title: 'Keeper Signs in an HSM', desc: `The off-chain keeper that submits executions signs with a key held in a hardware security module (AWS KMS): the private key never leaves the HSM and only signatures are returned. Adding or rotating a keeper, changing the router whitelist, or sweeping funds is gated by a ${ADMIN_TIMELOCK_HOURS}-hour on-chain timelock (admin transfer uses a longer ${ADMIN_TRANSFER_TIMELOCK_DAYS}-day delay), each with a ${ADMIN_TIMELOCK_GRACE_DAYS}-day grace window.` },
                { num: '07', title: 'Fail-Closed, Chain-Aware', desc: "The engine refuses to sign, read, or execute on any chain without a wired OrderExecutor, and the EIP-712 domain is bound to the connected chain. Order creation is rejected server-side — before the signature is even verified — for any chain whose executor is not in the fixed allowlist. Today only Ethereum Mainnet and Base are wired." },
              ].map((step) => (
                <StepRow key={step.num} num={step.num} title={step.title} desc={step.desc} />
              ))}
            </div>

            <div className="mt-4 text-xs text-v2-muted">
              <span className="font-semibold text-v2-text">Deployments:</span> the OrderExecutor is deployed and verified on the block explorer —
              Ethereum Mainnet at <span className="font-v2-mono">0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130</span> and Base at{' '}
              <span className="font-v2-mono">0x135B339902Ea4E0fB4CF059961dc8856bA1D2598</span>. Conditional-order creation panels are
              chain-agnostic in the UI; per-chain availability is enforced centrally by the fail-closed engine.
            </div>
          </section>

          <Rule />

          {/* ═══ LIMIT ORDERS ═══ */}
          <section id="limit-orders" className="scroll-mt-28">
            <SectionTitle icon="⊕" title="Limit Orders" />
            {!isOrderTypeLive('limit') && (
              <ComingSoonBanner note="Limit-order creation is not currently exposed in the app — the section below previews the flow on the order engine. Watch the roadmap for availability." />
            )}
            <div className={isOrderTypeLive('limit') ? '' : 'opacity-50'}>
              <p className="mb-2 text-[15px] leading-relaxed text-v2-muted">
                A limit order (OrderType LIMIT) lets you set a target price; the order becomes eligible once a Chainlink price feed crosses your
                level, and the keeper then executes it on-chain through the order engine. Limit orders use a{' '}
                <strong className="text-v2-text">2% default slippage</strong> floor and are ideal for precise entry and exit targets. See the{' '}
                <strong className="text-v2-text">Order Engine</strong> section above for the shared signing, validation, and execution model.
              </p>

              <div>
                {[
                  { num: '01', title: 'Set Target Price', desc: 'Define exactly how many tokens you want to receive per unit sold. The market price is shown for reference, with percentage difference calculated in real-time.' },
                  { num: '02', title: 'Choose Expiry', desc: 'Orders carry an expiry; the contract refuses to execute an order past its expiry, and expired orders stop being eligible.' },
                  { num: '03', title: 'EIP-712 Signing', desc: 'Sign the order off-chain with your wallet — no on-chain transaction to place it. You grant an exact-amount allowance to the executor; your tokens stay in your wallet until the order executes.' },
                  { num: '04', title: 'Chainlink-Gated Execution', desc: 'The order is monitored against a Chainlink feed. When the trigger is reached, the keeper executes it on-chain via the OrderExecutor through a whitelisted DEX router (1inch by default) — you pay no gas at execution time because the keeper sends the transaction.' },
                  { num: '05', title: 'On-Chain Min-Output Floor', desc: 'Execution enforces a per-order minimum-output (slippage) floor on-chain, so a fill below your tolerance reverts rather than settling against you.' },
                ].map((step) => (
                  <StepRow key={step.num} num={step.num} title={step.title} desc={step.desc} />
                ))}
              </div>
            </div>
          </section>

          <Rule />

          {/* ═══ STOP LOSS / TAKE PROFIT ═══ */}
          <section id="stop-loss" className="scroll-mt-28">
            <SectionTitle icon="⛊" title="Stop Loss / Take Profit" />
            {!isOrderTypeLive('stopLoss') && !isOrderTypeLive('takeProfit') && (
              <ComingSoonBanner note="Stop-loss / take-profit creation is not currently exposed in the app — the section below previews the flow on the order engine. Watch the roadmap for availability." />
            )}
            <div className={isOrderTypeLive('stopLoss') && isOrderTypeLive('takeProfit') ? '' : 'opacity-50'}>
              <p className="mb-4 text-[15px] leading-relaxed text-v2-muted">
                Protect your positions or lock in gains automatically. Stop-loss and take-profit are the same on-chain order type (STOP_LOSS)
                distinguished by direction: stop-loss triggers when the price falls <strong className="text-v2-text">below</strong> your target,
                take-profit when it rises <strong className="text-v2-text">above</strong>. A Chainlink feed gates the trigger, and when the
                condition is met the keeper executes the swap on-chain via the OrderExecutor and a whitelisted DEX router.
              </p>
              <div className="mb-4 text-xs text-v2-muted">
                <span className="font-semibold text-v2-text">Key difference from Limit Orders:</span> While limit orders let you target a
                specific price for a planned trade, SL/TP is designed to <strong className="text-v2-text">react to market movements</strong> and
                protect existing positions. Stop loss uses <strong className="text-v2-text">5% default slippage</strong> to prioritize fast
                execution during volatile drops, while take profit uses <strong className="text-v2-text">2% slippage</strong> like limit orders.
              </div>

              <div>
                {[
                  { num: '01', title: 'Set Trigger Price', desc: 'Define your stop loss or take profit level. For stop loss, the order becomes eligible when price drops below your target; for take profit, when price rises above it.' },
                  { num: '02', title: 'Chainlink Oracle Monitoring', desc: 'The trigger is evaluated against Chainlink on-chain price feeds — the industry standard for reliable, tamper-proof prices. The condition is checked on-chain inside the contract before any execution.' },
                  { num: '03', title: 'Automatic Execution', desc: 'You sign once upfront. When the trigger fires, the keeper executes the order on-chain via the OrderExecutor — no manual action needed at trigger time, and no gas paid by you at execution.' },
                  { num: '04', title: 'Whitelisted-Router Fill', desc: 'The triggered swap routes through a whitelisted DEX router (1inch by default), with a per-order minimum-output floor enforced on-chain.' },
                  { num: '05', title: 'Adaptive Slippage', desc: 'Stop loss orders use 5% default slippage to ensure execution during sharp price drops — speed matters more than precision when protecting against losses. Take profit uses the standard 2% slippage since there is no urgency to exit.' },
                ].map((step) => (
                  <StepRow key={step.num} num={step.num} title={step.title} desc={step.desc} />
                ))}
              </div>
            </div>
          </section>

          <Rule />

          {/* ═══ DCA ═══ */}
          <section id="dca" className="scroll-mt-28">
            <SectionTitle icon="⟳" title="DCA (Dollar-Cost Averaging)" />
            {!isOrderTypeLive('dca') && (
              <ComingSoonBanner note="DCA ships with launch — it is not live yet. It rolls out first on Base (L2). The section below previews how it works." />
            )}
            <div className={isOrderTypeLive('dca') ? '' : 'opacity-50'}>
              <p className="mb-4 text-[15px] leading-relaxed text-v2-muted">
                DCA splits a single buy into a series of smaller, scheduled purchases that run autonomously —{' '}
                <strong className="text-v2-text">without you signing each one</strong>. You set the input token, the output token, the total
                amount, the number of buys, and the interval between them. Each buy is settled at execution time by the keeper through the
                single whitelisted DEX router committed in your signed order (1inch by default), bounded by your per-buy minimum-output
                (slippage) floor enforced on-chain. Unlike the instant-swap path, conditional and DCA orders are not routed through CoW.
              </p>
              <p className="mb-2 text-[15px] leading-relaxed text-v2-muted">
                Setup is two steps: a one-time, <strong className="text-v2-text">exact-amount</strong> ERC-20 approval to the OrderExecutor for
                the full total (never an infinite/max approval), and a <strong className="text-v2-text">single EIP-712 signature</strong> over
                the whole plan. Because the contract pulls the input via a direct ERC-20 transfer, the input is always an ERC-20 — a native-ETH
                input is automatically wrapped to WETH before signing. From there a self-hosted keeper executes each buy on-chain when its turn
                comes due, paying the gas itself.
              </p>

              <div>
                {[
                  { num: '01', title: 'Sign Once, Run Autonomously', desc: "One exact-amount WETH approval to the OrderExecutor plus a single EIP-712 signature covers the whole series. The keeper supplies fresh swap calldata each run; it never asks you to sign again. There is no per-execution signing." },
                  { num: '02', title: 'Cumulative Chunk Accounting', desc: 'Each buy is sized by cumulative accounting: executeAmount = total × (n+1) / count − total × n / count, with the final buy taking the exact remainder. Across all executions the amounts sum to exactly your total — no buy is skipped, duplicated, or double-spent, and no dust is stranded.' },
                  { num: '03', title: 'On-Chain Gating Each Run', desc: "Before each execution the contract independently re-checks your balance, your allowance, the schedule interval (it will not run early), and the order's expiry. An execution counter only advances after a successful swap, so the schedule can never run ahead of itself." },
                  { num: '04', title: 'Schedule-Only, No Oracle Needed', desc: 'A pure DCA order carries no price condition (priceFeed = address(0) ⇒ the price check is always true): it runs on schedule regardless of price. It is not price-aware. An optional Chainlink condition can be attached, but the shipped DCA flow runs purely on a fixed interval for a fixed number of buys.' },
                  { num: '05', title: 'Routed at Market, Floor Enforced On-Chain', desc: 'At each turn the keeper builds a swap at market time and settles it through the single whitelisted DEX router committed in your signed order (1inch by default), with your per-buy minimum-output floor enforced on-chain. Unlike the instant-swap path, conditional and DCA orders are not routed through CoW.' },
                  { num: '06', title: 'You Stay in Control', desc: 'Any order can be cancelled on-chain at any time, and a single mass nonce-invalidation can void all pending orders. A manual circuit-breaker can pause the creation of new DCA orders — but it only delays: it never cancels or moves funds, existing orders keep running, and they can still be cancelled.' },
                ].map((step) => (
                  <StepRow key={step.num} num={step.num} title={step.title} desc={step.desc} />
                ))}
              </div>

              <div className="mt-4 text-xs text-v2-muted">
                <span className="font-semibold text-v2-text">Why Base first:</span> DCA is offered only on Base (an Ethereum L2), by design —
                never on mainnet. A recurring series of small buys on Ethereum Mainnet would be dominated by per-execution gas, so DCA rolls out
                on a low-fee L2 where small, frequent buys are viable. It ships with launch and is not presented as live until then.
              </div>
            </div>
          </section>

          <Rule />

          {/* ═══ SPLIT ROUTING ═══ */}
          <section id="split-routing" className="scroll-mt-28">
            <SectionTitle icon="⫘" title="Split Routing" />
            <p className="mb-2 text-[15px] leading-relaxed text-v2-muted">
              For large trades, routing the whole trade through a single DEX causes significant price impact. TeraSwap&apos;s split routing
              engine automatically divides the trade across multiple sources to minimize slippage and maximize output.
            </p>

            <div>
              {[
                { num: '01', title: 'Quote Collection', desc: 'Split-eligible sources are queried at multiple sub-amounts in parallel (the set of percentages is derived from the candidate split configurations). Each source reports its output for each partial amount.' },
                { num: '02', title: 'Combinatorial Optimization', desc: 'The engine tests all 2-way and 3-way split configurations across eligible sources. Pre-defined splits (50/50, 60/40, 70/30, 80/20, 50/30/20, etc.) are evaluated for every pairwise and triple source combination.' },
                { num: '03', title: 'Gas-Adjusted Comparison', desc: `Each split candidate's total output is compared against the best single-source quote. Gas costs are factored in — a split that gains ${SPLIT_MIN_IMPROVEMENT_PCT} but doubles gas cost may not be worth it.` },
                { num: '04', title: 'Visualization & Execution', desc: `When a split improves output by ≥${SPLIT_MIN_IMPROVEMENT_PCT} (${SPLIT_MIN_IMPROVEMENT_BPS_SLOT} bps), the UI shows a visual breakdown with per-source allocation bars. Users can toggle split on/off. Execution sends multiple transactions — one per leg — with the pre-computed amounts.` },
              ].map((step) => (
                <StepRow key={step.num} num={step.num} title={step.title} desc={step.desc} />
              ))}
            </div>

            <div className="mt-4 text-xs text-v2-muted">
              <span className="font-semibold text-v2-text">Threshold:</span> Split routing activates for trades estimated above $5,000 USD. Below
              this threshold, single-source routing is always used as the gas savings don&apos;t justify the extra transactions.
            </div>
          </section>

          <Rule />

          {/* ═══ ANALYTICS ═══ */}
          <section id="analytics" className="scroll-mt-28">
            <SectionTitle icon="◫" title="Analytics Dashboard" />
            <p className="mb-2 text-[15px] leading-relaxed text-v2-muted">
              The built-in Analytics Dashboard provides real-time visibility into protocol activity: trade volumes, fee generation, aggregator
              performance, and wallet tracking — all updated live with each swap.
            </p>
            <div>
              {[
                { n: '1', title: 'KPI Metrics', desc: 'Total volume, fees collected, unique wallets, and average trade size — filterable by period (24h, 7d, 30d, All Time).' },
                { n: '2', title: 'Aggregator Ranking', desc: 'Volume and win-rate per source, showing which DEX routes deliver the best execution for your trades.' },
                { n: '3', title: 'Hourly Heatmap', desc: 'Visual breakdown of volume by hour (UTC), revealing peak trading windows.' },
                { n: '4', title: 'Wallet Tracker', desc: 'Automatic wallet profiling with trade counts and volumes. Export snapshots for airdrop planning or loyalty programs.' },
                { n: '5', title: 'Daily Volume Chart', desc: '30-day bar chart showing daily trading volume trends and trade frequency.' },
              ].map((step) => (
                <StepRow key={step.n} num={`0${step.n}`} title={step.title} desc={step.desc} />
              ))}
            </div>
          </section>

          <Rule />

          {/* ═══ ROADMAP ═══ */}
          <section id="roadmap" className="scroll-mt-28">
            <SectionTitle icon="▸" title="Roadmap" />
            <div>
              {[
                {
                  phase: 'Phase 1',
                  status: 'Live',
                  items: [
                    `Instant swaps on ${SWAP_CHAIN_LIST_LABEL}`,
                    `Meta-aggregator with ${INTEGRATED_DEX_SOURCES_CLAIM}`,
                    `Chainlink oracle price validation (${PRICE_DEVIATION_WARN_PCT} warn / ${PRICE_DEVIATION_BLOCK_PCT} block)`,
                    'DefiLlama server-side oracle validation',
                    'Cross-quote median consensus validation',
                    'Privacy proxy for RPC reads and aggregator quote / swap requests',
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
                  ],
                },
                {
                  phase: 'Phase 2',
                  status: 'Ships with launch',
                  items: [
                    'DCA on Base (schedule-based, keeper-executed)',
                    'Limit orders on the order engine (Chainlink-gated)',
                    'Stop loss + take profit (Chainlink-gated, adaptive slippage)',
                    'Base network activation for swaps',
                    `Bebop RFQ source (currently disabled: ${DISABLED_SOURCES.bebop})`,
                  ],
                },
                {
                  phase: 'Phase 3',
                  status: 'Planned',
                  items: [
                    'Further multi-chain expansion (Arbitrum, Optimism)',
                    'Cross-chain swaps via LI.FI',
                    'Uniswap V4 Hooks integration',
                    'TeraShield — premium privacy mode (paid feature)',
                    'Stealth addresses (ERC-5564 / ERC-6538)',
                    'Railgun shielded swaps (zkSNARK with sanctions compliance)',
                    'Governance token',
                    'DAO treasury management',
                  ],
                },
              ].map((phase) => (
                <div key={phase.phase} className="ts-v2-rule-t py-5">
                  <div className="mb-2 flex items-center gap-3">
                    <span className="text-base font-bold text-v2-text">{phase.phase}</span>
                    <DocTag>{phase.status}</DocTag>
                  </div>
                  <p className="text-[13px] leading-relaxed text-v2-muted">{phase.items.join(' · ')}</p>
                </div>
              ))}
            </div>
          </section>

          <Rule />

          <section id="support" className="scroll-mt-28">
            <SectionTitle icon="✉" title="Support" />
            <div className="text-sm text-v2-muted">
              <p>Questions, bug reports, or feedback? Reach us on X or by email:</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                {/* min-h-[44px]: these are standalone links (not inline in running text), so the WCAG 2.5.8
                    inline exception does not apply — a real 375 Playwright gate caught the 20 px row height. */}
                <a
                  href="https://x.com/TeraHash"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ts-v2-underline inline-flex min-h-[44px] items-center font-medium text-v2-cream hover:text-v2-text"
                >
                  @TeraHash on X
                </a>
                <a href={`mailto:${SUPPORT_EMAIL}`} className="ts-v2-underline inline-flex min-h-[44px] items-center font-medium text-v2-cream hover:text-v2-text">
                  {SUPPORT_EMAIL}
                </a>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
