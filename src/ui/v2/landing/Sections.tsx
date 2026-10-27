'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  ADMIN_TIMELOCK_HOURS,
  CHAINLINK_STALENESS_CLAIM,
  INTEGRATED_DEX_SOURCE_COUNT,
  INTEGRATED_DEX_SOURCE_COUNT_WORDS,
  INTEGRATED_DEX_SOURCE_LABELS,
  OUTLIER_MEDIAN_MULTIPLE,
  POST_EXECUTION_SHORTFALL_WARN_PCT,
  PRICE_DEVIATION_BLOCK_PCT,
  PRICE_DEVIATION_WARN_PCT,
  PRIVACY_BADGE,
  PRIVACY_DIRECT_NOTE,
  PRIVACY_PROXY_CLAIM,
  SWAP_CHAIN_LIST_LABEL,
  chainNameFor,
  chainlinkFeedCountFor,
  dcaFeatureTitle,
  formatChainList,
  isOrderTypeLive,
  type OrderTypeId,
} from '@/config/product-claims'
import { useQuoteChainId } from '@/hooks/useChainId'
import { Button, EyebrowLabel, HandUnderline, Surface } from '../primitives'
import { PhotoBackground } from '../photos/PhotoBackground'
import { rvAt } from './narrative'
import { RouteRace } from './RouteRace'
import { securityStats } from './slots'

const H2 = 'font-v2-display font-bold uppercase leading-[0.98] tracking-[-0.005em] text-v2-text text-[44px] sm:text-[64px] lg:text-[80px]'
const BODY = 'max-w-[640px] text-[16px] leading-relaxed text-v2-muted'
const SECTION = 'relative scroll-mt-8 px-4 py-16 sm:px-8 sm:py-24'
const WRAP = 'relative z-10 mx-auto max-w-[1240px]'

function SectionHead({ eyebrow, children, reveal = false }: { eyebrow: string; children: ReactNode; reveal?: boolean }) {
  return (
    <div className={reveal ? 'ts-v2-rv mb-8 sm:mb-10' : 'mb-8 sm:mb-10'}>
      <EyebrowLabel>{eyebrow}</EyebrowLabel>
      <h2 className={`mt-4 ${H2}`}>{children}</h2>
    </div>
  )
}

// ── 2 · Performance (Round 7 D4: the route race replaces the radial source graph) ─────────────────────────────

export function PerformanceSection() {
  return (
    <section id="performance" className={`ts-v2-opaque ts-v2-scrim ts-v2-scrim--race ${SECTION} overflow-hidden`}>
      <PhotoBackground photoId="arch-night" section aboveFold={false} />
      <div className={`${WRAP} grid items-center gap-10 lg:grid-cols-[7fr_5fr] lg:gap-16`}>
        <div>
          <EyebrowLabel>Performance</EyebrowLabel>
          <h2 className={`mt-4 ${H2}`}>
            <span className="block">
              <HandUnderline>Limitless Liquidity.</HandUnderline>
            </span>
            <span className="block text-v2-cream">Relentless Execution.</span>
          </h2>
          <p className={`mt-6 ${BODY}`}>
            Stop searching for the best price. TeraSwap&apos;s meta-aggregation engine simultaneously scans {INTEGRATED_DEX_SOURCE_COUNT_WORDS}{' '}
            liquidity sources across {SWAP_CHAIN_LIST_LABEL} — identifying and executing the optimal route to deliver the highest net output
            on every single swap. Gas costs are folded into the ranking, so the quote you see is the one your wallet actually feels.
          </p>
        </div>
        <RouteRace />
      </div>
    </section>
  )
}

// ── 3 · What makes TeraSwap different ───────────────────────────────────────────────────────────────────────

export function DifferentSection() {
  const BLOCKS: { title: string; desc: string }[] = [
    {
      title: 'Meta-Aggregator',
      desc: "We don't pick one routing model. TeraSwap compares intent-based solvers against traditional DEX routing — you get whichever gives the better price.",
    },
    {
      title: 'Oracle-Verified Execution',
      desc: `Every quote is checked against Chainlink price feeds before execution. Deviations above ${PRICE_DEVIATION_BLOCK_PCT} are blocked automatically — before your trade happens, not after.`,
    },
    {
      title: 'MEV Protection on CoW Routes',
      desc: 'When a swap routes through CoW Protocol, execution is an intent-based batch auction — solvers compete to give you the best outcome, with no in-block ordering window for a front-running or sandwich bot to exploit.',
    },
  ]
  return (
    <section id="why-teraswap" className={`ts-v2-opaque ${SECTION}`}>
      <div className={WRAP}>
        <SectionHead eyebrow="Why TeraSwap">
          What Makes TeraSwap <HandUnderline className="text-v2-cream">Different</HandUnderline>
        </SectionHead>
        <ol className="grid list-none gap-4 lg:grid-cols-3">
          {BLOCKS.map((b, i) => (
            <li key={b.title}>
              <Surface edge="rule" className="h-full py-1">
                <span className="font-v2-display text-5xl font-bold text-v2-cream">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="mt-5 text-xl text-v2-text">{b.title}</h3>
                <p className="mt-3 text-[15px] leading-relaxed text-v2-muted">{b.desc}</p>
              </Surface>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

// ── 4 · Security ─────────────────────────────────────────────────────────────────────────────────────────────

export function SecuritySection() {
  const chainId = useQuoteChainId()
  const chainName = chainNameFor(chainId)
  const feedCount = chainlinkFeedCountFor(chainId)
  const stats = securityStats(chainId)
  const CHECKS: { tag: string; title: string; body: ReactNode }[] = [
    {
      tag: 'PRE-SWAP',
      title: 'Chainlink Oracle Check',
      body: `${feedCount} token price feeds on ${chainName} — warns at ${PRICE_DEVIATION_WARN_PCT}+ deviation, blocks at ${PRICE_DEVIATION_BLOCK_PCT}. ${CHAINLINK_STALENESS_CLAIM}`,
    },
    {
      tag: 'POST-SWAP',
      title: 'Post-Execution Validation',
      body: `Transfer event logs verify actual output vs expected. Shortfall above ${POST_EXECUTION_SHORTFALL_WARN_PCT} triggers a P0 alert and the source is auto-disabled.`,
    },
  ]
  return (
    <section id="security" data-ts-narrative="security" className={`ts-v2-scrim ${SECTION}`}>
      <div className={WRAP}>
        <SectionHead eyebrow="Security" reveal>
          Institutional-Grade <HandUnderline className="text-v2-cream">Security.</HandUnderline>
        </SectionHead>
        <div className="grid items-start gap-8 lg:grid-cols-[1fr_1fr]">
          <div className="ts-v2-rv">
            <h3 className="font-v2-display text-3xl text-v2-cream sm:text-4xl">Your Capital, Protected.</h3>
            <div className={`${BODY} mt-5 flex flex-col gap-4`}>
              <p>
                MEV bots never sleep — but neither does our protection. Through our native integration with CoW Protocol, real-time Chainlink
                price validation, and an independent DefiLlama oracle layer, swaps that route through CoW execute via batch auctions that remove
                the in-block ordering window front-running and sandwich attacks depend on.
              </p>
              <p>
                Your privacy matters too. {PRIVACY_PROXY_CLAIM} {PRIVACY_DIRECT_NOTE}
              </p>
              <p className="font-semibold text-v2-text">MEV-protected CoW routes. Proxied RPC and quote requests.</p>
              <p>
                TeraSwap was built around one non-negotiable principle: <span className="font-semibold">your profitability and privacy come first.</span>
              </p>
            </div>
          </div>
          <ul className="grid list-none gap-4 sm:grid-cols-2">
            {CHECKS.map((c, i) => (
              <li key={c.tag} className="ts-v2-rv" style={rvAt(i)}>
                <Surface edge="rule" className="h-full py-1">
                  <span className="ts-v2-badge">{c.tag}</span>
                  <div className="mt-4 text-[17px] text-v2-text">{c.title}</div>
                  <p className="mt-2 text-[14px] leading-relaxed text-v2-muted">{c.body}</p>
                </Surface>
              </li>
            ))}
          </ul>
        </div>
        <Surface edge="both" className="ts-v2-rv mt-8 py-6 sm:py-8" style={rvAt(CHECKS.length)}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label} className="flex min-w-0 flex-col-reverse justify-end gap-2">
                <dt className="text-[13px] text-v2-muted">{s.label}</dt>
                <dd className="font-v2-display text-5xl font-bold leading-none text-v2-cream sm:text-6xl">{s.value === null ? s.text : s.value}</dd>
              </div>
            ))}
          </dl>
        </Surface>
      </div>
    </section>
  )
}

// ── 5 · Experience ───────────────────────────────────────────────────────────────────────────────────────────

export function ExperienceSection({ onLaunchApp }: { onLaunchApp: () => void }) {
  return (
    <section id="experience" data-ts-narrative="experience" className={`ts-v2-scrim ${SECTION}`}>
      <div className={`${WRAP} grid items-center gap-10 lg:grid-cols-[7fr_5fr] lg:gap-16`}>
        <div>
          <div className="ts-v2-rv">
            <EyebrowLabel>Experience</EyebrowLabel>
            <h2 className={`mt-4 ${H2}`}>
              <span className="block">
                <HandUnderline>Zero Friction.</HandUnderline>
              </span>
              <span className="block text-[32px] text-v2-cream sm:text-[44px] lg:text-[52px]">Design That Thinks With You.</span>
            </h2>
          </div>
          <p className={`${BODY} ts-v2-rv mt-6`}>
            Forget slow approval flows. Approvals are <span className="font-v2-mono text-v2-cream">exact-amount</span>: one on-chain approval for what
            each swap needs, never infinite, and the system handles everything else. All wrapped in a precision-crafted cream-on-black interface.
            Because visual clarity is the first step toward financial clarity.
          </p>
        </div>
        <Surface edge="rule" className="ts-v2-rv flex items-center py-8" style={rvAt(0)}>
          <Button variant="text" onClick={onLaunchApp}>
            Launch the full app <span aria-hidden="true">&nbsp;→</span>
          </Button>
        </Surface>
      </div>
    </section>
  )
}

// ── 6 · Features, 7 · Roadmap ────────────────────────────────────────────────────────────────────────────────

interface Feature {
  title: string
  desc: string
  orderType?: OrderTypeId
}

const FEATURES: Feature[] = [
  {
    title: `${INTEGRATED_DEX_SOURCE_COUNT} Liquidity Sources`,
    desc: `Simultaneous queries across aggregator APIs and direct DEX protocols — ${formatChainList(INTEGRATED_DEX_SOURCE_LABELS)}.`,
  },
  {
    title: 'Gas-Aware Routing',
    desc: 'Quotes ranked by net output minus estimated gas cost. The ranking metric that actually matters to your wallet — not just raw amounts.',
  },
  {
    title: 'Statistical Outlier Detection',
    desc: `True median-based filtering across all ${INTEGRATED_DEX_SOURCE_COUNT} sources automatically removes quotes more than ${OUTLIER_MEDIAN_MULTIPLE}× the median.`,
  },
  { title: 'Privacy-First Architecture', desc: `${PRIVACY_PROXY_CLAIM} ${PRIVACY_DIRECT_NOTE}` },
  {
    title: 'DCA',
    desc: 'Automated dollar-cost averaging on a fixed schedule. Keeper-executed on-chain — no browser required.',
    orderType: 'dca',
  },
  {
    title: 'Limit Orders',
    desc: `Set your target price and walk away. Your signed order is filled on-chain by the OrderExecutor contract when a keeper sees your price reached — you pay no gas at fill time, and changes to the executor's configuration sit behind a ${ADMIN_TIMELOCK_HOURS}-hour timelock.`,
    orderType: 'limit',
  },
  {
    title: 'Stop Loss / Take Profit',
    desc: `Automated position protection gated by Chainlink oracles. Prices are monitored in real-time — when your trigger is reached, a keeper fills the order on-chain through the OrderExecutor, behind the same ${ADMIN_TIMELOCK_HOURS}-hour configuration timelock.`,
    orderType: 'stopLoss',
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
    title: 'Exact-Amount Approvals',
    desc: 'A one-time on-chain approval for exactly what each swap needs — never an infinite allowance. Revoke it later from the approvals manager.',
  },
  {
    title: 'Active Approvals Manager',
    desc: 'Full visibility into token approvals made through TeraSwap. Revoke any residual allowance in one click — security you control.',
  },
]

/** v1's rule, unchanged: an order type that is not live yet goes to the roadmap; everything else is a feature. */
function splitFeatures() {
  const all = FEATURES.map((f) => ({
    ...f,
    title: f.orderType === 'dca' ? dcaFeatureTitle() : f.title,
    comingSoon: f.orderType ? !isOrderTypeLive(f.orderType) : false,
  }))
  return { live: all.filter((f) => !f.comingSoon), roadmap: all.filter((f) => f.comingSoon) }
}

export function FeaturesSection() {
  const { live, roadmap } = splitFeatures()
  return (
    <>
      <section id="features" data-ts-narrative="features" className={`ts-v2-scrim ts-v2-scrim--features ${SECTION}`}>
        <div className={WRAP}>
          <SectionHead eyebrow="Features" reveal>
            Built for every EVM trader.
          </SectionHead>
          <p className="ts-v2-rv -mt-4 mb-8 text-[15px] text-v2-muted">Every capability shipping today, plus what&apos;s next on the roadmap.</p>
          {/* Round 7 D4: a numbered editorial list — hairline above each item, two columns from 601 px, one below, no boxes. */}
          <ol data-ts-flist="" className="m-0 grid list-none grid-cols-1 p-0 sm:grid-cols-2 sm:gap-x-[72px]">
            {live.map((f, i) => (
              <li key={f.title} className="ts-v2-rv ts-v2-rule-t grid grid-cols-[44px_1fr] py-4 sm:grid-cols-[56px_1fr] sm:py-5" style={rvAt(i)}>
                <span aria-hidden="true" data-list-index="" className="font-v2-display text-2xl font-bold leading-none text-v2-cream sm:text-[28px]">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3 className="text-[17px] font-semibold leading-snug text-v2-text">{f.title}</h3>
                  <p className="mt-1.5 text-[14px] leading-[22px] text-v2-muted">{f.desc}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
      {roadmap.length > 0 ? (
        <section id="roadmap" data-ts-narrative="roadmap" className={`ts-v2-scrim ${SECTION}`}>
          <div className={WRAP}>
            <SectionHead eyebrow="Roadmap" reveal>
              Coming Soon
            </SectionHead>
            <ul className="grid list-none gap-6 md:grid-cols-2 md:gap-8">
              {roadmap.map((f, i) => (
                <li key={f.title} className="ts-v2-rv" style={rvAt(i)}>
                  <Surface edge="rule" className="h-full py-1">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-xl text-v2-text">{f.title}</h3>
                      <span className="ts-v2-badge ts-v2-badge--soon shrink-0 uppercase">Soon</span>
                    </div>
                    <p className="mt-4 text-[15px] leading-relaxed text-v2-muted">{f.desc}</p>
                  </Surface>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </>
  )
}

// ── 8 · Bottom CTA, 9 · Docs ─────────────────────────────────────────────────────────────────────────────────

export function BottomCtaSection({ onLaunchApp }: { onLaunchApp: () => void }) {
  return (
    <section className={`ts-v2-opaque ts-v2-scrim ts-v2-scrim--center ${SECTION} overflow-hidden text-center`}>
      <PhotoBackground photoId="trails" section aboveFold={false} />
      <div className="relative z-10 mx-auto max-w-[900px]">
        <h2 className={H2}>
          <span className="block">Don&apos;t leave</span>
          <span className="block text-v2-cream">
            <HandUnderline>performance</HandUnderline>
          </span>
          <span className="block">on the table.</span>
        </h2>
        <p className="mx-auto mt-6 max-w-[520px] text-[16px] leading-relaxed text-v2-muted">
          Experience decentralized trading engineered to work harder than any single exchange ever could.
        </p>
        <div className="mt-8">
          <Button className="h-14 w-[220px]" onClick={onLaunchApp}>
            Launch app
          </Button>
        </div>
        <div className="mt-6 font-v2-mono text-[11px] font-medium uppercase tracking-[1.5px] text-v2-muted">
          Non-custodial · {SWAP_CHAIN_LIST_LABEL} · Powered by Chainlink · {PRIVACY_BADGE}
        </div>
      </div>
    </section>
  )
}

export function DocsSection() {
  return (
    <section id="docs" data-ts-narrative="docs" className={`ts-v2-scrim ${SECTION} pb-24`}>
      <div className={WRAP}>
        <SectionHead eyebrow="Docs" reveal>
          Read the docs.
        </SectionHead>
        <Surface edge="rule" className="ts-v2-rv flex flex-col items-start justify-between gap-6 py-2 sm:flex-row sm:items-center" style={rvAt(0)}>
          <span className="font-v2-mono text-sm text-v2-cream">/docs</span>
          {/* Round 7 D3 item 7: text + hairline underline, no outline box */}
          <Link
            href="/docs"
            className="ts-v2-underline inline-flex min-h-[44px] items-center gap-2 bg-transparent px-1 font-v2-mono text-[12px] font-medium uppercase tracking-[1.5px] text-v2-cream hover:text-v2-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-teal"
          >
            Read the docs <span aria-hidden="true">→</span>
          </Link>
        </Surface>
      </div>
    </section>
  )
}
