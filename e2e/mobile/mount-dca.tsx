/**
 * [chore/mobile-ux-polish-2] Real-render harness for the props-only #236 DCA Positions dashboard
 * components — the wallet-gated controls the dev-server audit can't reach in a disconnected session.
 * Mounts the REAL components (real Tailwind classes) with representative fixtures so the mobile suite
 * can prove every swept tap target is ≥44px and every critical NUMBER is ≥12px at phone widths — what
 * JSDOM cannot. No network, no next/image, no timers (leaf presentational components only).
 *
 * Bundled by build.mjs with the app's compiled Tailwind and loaded via file:// — deterministic in CI.
 */
import { createRoot } from 'react-dom/client'
import type { AutonomousOrder } from '../../src/lib/order-engine'
import type { FillRow } from '../../src/hooks/useOrderExecutions'
import DCAFillsTimeline from '../../src/components/dca/DCAFillsTimeline'
import OrbitStatRow from '../../src/components/dca/OrbitStatRow'
import DCADashboard from '../../src/components/dca/DCADashboard'
import DCAOrderCard from '../../src/components/dca/DCAOrderCard'
import CategoryChips from '../../src/components/CategoryChips'

// ── Base-chain DCA fixture (USDC → WETH, 6 buys of 100 USDC) ──
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WETH = '0x4200000000000000000000000000000000000006'
const AUGUSTUS = '0x6A000F20005980200259B80c5102003040001068' // Augustus V6 (Velora) on Base
const OWNER = '0x1111111111111111111111111111111111111111'
const now = Date.now()

function makeOrder(over: Partial<AutonomousOrder> = {}): AutonomousOrder {
  return {
    id: 'fixture-1',
    orderHash: '0xhash',
    signature: '0xsig',
    status: 'active',
    orderType: 'dca',
    chainId: 8453,
    tokenInSymbol: 'USDC',
    tokenInDecimals: 6,
    tokenOutSymbol: 'WETH',
    tokenOutDecimals: 18,
    dcaExecuted: 2,
    dcaTotal: 6,
    createdAt: now - 3_600_000,
    executedAt: null,
    expiresAt: now + 7 * 86_400_000,
    error: null,
    amountOut: null,
    txHash: null,
    order: {
      owner: OWNER,
      tokenIn: USDC,
      tokenOut: WETH,
      amountIn: 600_000000n, // 600 USDC over 6 buys = 100 each
      minAmountOut: 0n,
      orderType: 'dca',
      condition: 'none',
      targetPrice: 0n,
      priceFeed: '0x0000000000000000000000000000000000000000',
      expiry: BigInt(Math.floor((now + 7 * 86_400_000) / 1000)),
      nonce: 1n,
      router: AUGUSTUS,
      routerDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      dcaInterval: 86_400n,
      dcaTotal: 6n,
    },
    ...over,
  } as unknown as AutonomousOrder
}

const FILLS: FillRow[] = [
  {
    id: 'f2', execution_number: 2, tx_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    amount_in: '100000000', amount_out: '30000000000000000', status: 'success', error: null,
    created_at: new Date(now - 600_000).toISOString(),
  },
  {
    id: 'f1', execution_number: 1, tx_hash: null,
    amount_in: '100000000', amount_out: null, status: 'failed',
    error: 'SwapFailed: insufficient output amount on the routed path',
    created_at: new Date(now - 90_000_000).toISOString(),
  },
]

const CATEGORIES = ['Stablecoins', 'Layer 2', 'DeFi', 'Meme', 'Liquid Staking', 'RWA', 'Gaming', 'AI']

const noop = () => {}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="w-full" data-testid="dca-section">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-cream-35">{title}</h2>
      {children}
    </section>
  )
}

function Harness() {
  return (
    // Mirror page.tsx's in-app column padding so the bounded-width layout is faithful at phone widths.
    <main className="swap-main flex min-h-screen flex-col items-stretch gap-6 px-3 pt-4 sm:px-4" data-testid="dca-harness">
      <Section title="Category chips">
        <CategoryChips categories={CATEGORIES} active="DeFi" onToggle={noop} />
      </Section>

      <Section title="OrbitStatRow">
        <OrbitStatRow order={makeOrder()} />
      </Section>

      <Section title="Fills timeline">
        <DCAFillsTimeline
          fills={FILLS}
          tokenInSymbol="USDC"
          tokenInDecimals={6}
          tokenOutSymbol="WETH"
          tokenOutDecimals={18}
          chainId={8453}
        />
      </Section>

      <Section title="History card (active → Cancel)">
        <DCAOrderCard order={makeOrder({ id: 'h-active' })} onCancel={noop} />
      </Section>

      <Section title="History card (terminal → Remove + explorer link)">
        <DCAOrderCard
          order={makeOrder({
            id: 'h-done',
            status: 'filled',
            dcaExecuted: 6,
            // A real txHash surfaces the "View on explorer" link so the tap-target test measures it.
            txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          })}
          onRemove={noop}
        />
      </Section>

      <Section title="Dashboard history list (Remove All + cards)">
        <DCADashboard
          active={[]}
          history={[
            makeOrder({ id: 'd1', status: 'filled', dcaExecuted: 6 }),
            makeOrder({ id: 'd2', status: 'cancelled', dcaExecuted: 3 }),
          ]}
          onCancel={noop}
          onCancelAll={noop}
          onRemove={noop}
        />
      </Section>

      <Section title="Dashboard empty state (Start a DCA)">
        <DCADashboard active={[]} history={[]} onCancel={noop} onCancelAll={noop} onRemove={noop} onCreate={noop} />
      </Section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
