/**
 * [Auditor M2 / PR #497] Chain-aware keeper monitoring.
 *
 * Before this module, the only keeper-liveness check anywhere in the stack was
 * `.github/workflows/daily-health-report.yml`'s single Base-only gas-balance step keyed off
 * `KEEPER_ADDRESS_BASE` — nothing checked whether a chain's keeper was actually alive once an env
 * var was set. That meant "Arbitrum DCA gate opens, KEEPER_ADDRESS_ARBITRUM never gets set (or its
 * keeper dies)" was a SILENT failure: orders would be accepted and never filled with no alert.
 *
 * This module is the single per-chain rule (one check body, iterated over KEEPER_CHAINS) for:
 *   - keeper gas balance (read-only RPC eth_getBalance, chain-aware thresholds)
 *   - DCA fill liveness (orders whose next scheduled fill is overdue with no recent fill)
 *
 * A chain is "monitored" once BOTH its env var is set AND isChainActive(chainId) is true. A
 * monitored chain in trouble (dead/unreachable keeper, overdue fills) is a LOUD failure via the
 * existing emitTransitionAlert() fan-out (Telegram/Email/Discord) — never a silently-skipped row.
 * An unmonitored chain is reported as such explicitly (never silent either) — see
 * describeKeeperHealth().
 *
 * Read-only: this module never touches the keeper, the order engine, or contracts. It only reads
 * `orders` (already-public schema per src/lib/order-engine/supabase.ts's OrderRow) and RPC balances.
 */

import { getSupabase } from '@/lib/supabase'
import { getPublicClientForChain } from './chains/clients'
import { isChainActive } from './chains/activation'
import { nextBuyAtMs } from './order-engine/dca-countdown'
import { emitTransitionAlert } from './alert-wrapper'

// ── Per-chain keeper table ───────────────────────────────
// [Task 2] ONE rule iterates this table — no per-chain copy of the check body. Add a chain here
// only once its keeper registry row exists (docs/DEPLOYMENTS.md § Keeper registry) — today that's
// Base (polling) and Arbitrum (whitelisted, not yet polling; see docs/Runbooks/EC2-EXECUTOR-HOST.md
// § S2 for the Arbitrum keeper's own boot procedure).

export interface KeeperChainConfig {
  chainId: number
  /** Repo secret / Vercel env var name that carries this chain's keeper wallet address. */
  envVar: string
}

export const KEEPER_CHAINS: readonly KeeperChainConfig[] = [
  { chainId: 8453, envVar: 'KEEPER_ADDRESS_BASE' },
  { chainId: 42161, envVar: 'KEEPER_ADDRESS_ARBITRUM' },
] as const

// ── Cadence ──────────────────────────────────────────────
// The Vercel Cron / Cloudflare Worker tick interval this loop runs on (see monitoring-loop.ts
// docblock). Keeper polling itself runs on the same cadence in production today (Base keeper —
// docs/Runbooks/EC2-EXECUTOR-HOST.md).
export const KEEPER_POLL_INTERVAL_SECONDS = 60

/** A fill more than this many poll intervals late, with no fill/heartbeat seen, is overdue. */
const OVERDUE_POLL_INTERVALS = 2
const OVERDUE_THRESHOLD_MS = OVERDUE_POLL_INTERVALS * KEEPER_POLL_INTERVAL_SECONDS * 1000

// ── Gas thresholds ───────────────────────────────────────
// Base: measured live (docs/Prompts/FIX-KEEPER-GAS-TIER-BASE.md — real Base gas ~0.006 gwei,
// ~$0.016/fill). The existing 0.01 ETH warning / 0.002 ETH critical convention (already used in
// Audits/Daily/health-*.md and the GHA workflow) is preserved byte-identical here.
//
// Arbitrum: no real-fill calibration exists yet (docs/feedback/sprint-keeper-multichain-arbitrum.md
// — "PENDING real-fill calibration, no Arbitrum fills exist yet"). Derived, not measured: the
// keeper's own Arbitrum gas tiers (gas-tier.js, same sprint) set NORMAL priority fee at 0.001 gwei
// vs Base's recommended ~0.02 gwei ceiling — Nitro's FCFS sequencer needs near-zero tips, and
// Nitro's L1-calldata compression keeps the data-posting component small too. A conservative 5x
// (not the full ~20x priority-fee ratio) is used so this threshold doesn't need to track the
// keeper's own tier calibration exactly: warning 0.01/5 = 0.002 ETH, critical 0.002/5 = 0.0004 ETH.
// Revisit once real Arbitrum fills give a measured $/fill like Base's.
interface GasThresholdEth {
  warningEth: number
  criticalEth: number
}

const GAS_THRESHOLDS_ETH: Record<number, GasThresholdEth> = {
  8453: { warningEth: 0.01, criticalEth: 0.002 },
  42161: { warningEth: 0.002, criticalEth: 0.0004 },
}

function gasThresholdsFor(chainId: number): GasThresholdEth {
  return GAS_THRESHOLDS_ETH[chainId] ?? GAS_THRESHOLDS_ETH[8453]
}

// ── Result types ─────────────────────────────────────────

export type KeeperGasStatus = 'ok' | 'warning' | 'critical' | 'rpc-unreachable'

export interface KeeperChainHealth {
  chainId: number
  /** False when the env var is unset OR the chain isn't active yet — never silently dropped. */
  monitored: boolean
  gasStatus?: KeeperGasStatus
  balanceEth?: number
  /** [Task 2] DCA orders on this chain whose next scheduled fill is >2 poll intervals overdue
   *  with no fill/heartbeat seen since. */
  overdueOrderCount?: number
}

// ── Gas balance check ────────────────────────────────────

async function checkGasBalance(
  chainId: number,
  address: `0x${string}`,
): Promise<{ gasStatus: KeeperGasStatus; balanceEth?: number }> {
  try {
    const client = getPublicClientForChain(chainId)
    const wei = await client.getBalance({ address })
    const balanceEth = Number(wei) / 1e18
    const { warningEth, criticalEth } = gasThresholdsFor(chainId)
    const gasStatus: KeeperGasStatus =
      balanceEth < criticalEth ? 'critical' : balanceEth < warningEth ? 'warning' : 'ok'
    return { gasStatus, balanceEth }
  } catch (err) {
    console.warn(
      `[KEEPER] Gas balance RPC failed (chain ${chainId}):`,
      err instanceof Error ? err.message : err,
    )
    return { gasStatus: 'rpc-unreachable' }
  }
}

// ── Overdue-fill liveness check ──────────────────────────

interface OrderLivenessRow {
  created_at: string
  executed_at: string | null
  dca_interval: number | null
}

/** Active DCA orders on `chainId` whose next scheduled fill is overdue by >2 poll intervals. */
async function countOverdueDcaOrders(chainId: number): Promise<number> {
  const supabase = getSupabase()
  if (!supabase) return 0

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('created_at, executed_at, dca_interval')
      .eq('chain_id', chainId)
      .eq('order_type', 'dca')
      .in('status', ['active', 'partially_filled'])

    if (error || !data) return 0

    const now = Date.now()
    let overdue = 0
    for (const row of data as OrderLivenessRow[]) {
      if (!row.dca_interval) continue // no interval → not on a schedule, can't be "overdue"

      const scheduleStartMs = Date.parse(row.created_at)
      if (!Number.isFinite(scheduleStartMs)) continue

      const lastFillMs = row.executed_at ? Date.parse(row.executed_at) : null
      const nextAt = nextBuyAtMs({
        lastFillAtMs: lastFillMs !== null && Number.isFinite(lastFillMs) ? lastFillMs : null,
        scheduleStartMs,
        intervalSec: row.dca_interval,
      })

      if (now - nextAt > OVERDUE_THRESHOLD_MS) overdue++
    }
    return overdue
  } catch (err) {
    console.warn(
      `[KEEPER] Overdue-order query failed (chain ${chainId}):`,
      err instanceof Error ? err.message : err,
    )
    return 0
  }
}

// ── Per-chain check (the ONE rule Task 2 asks for) ───────

export async function checkKeeperChain(cfg: KeeperChainConfig): Promise<KeeperChainHealth> {
  const address = process.env[cfg.envVar]

  if (!address || !isChainActive(cfg.chainId)) {
    return { chainId: cfg.chainId, monitored: false }
  }

  const [{ gasStatus, balanceEth }, overdueOrderCount] = await Promise.all([
    checkGasBalance(cfg.chainId, address as `0x${string}`),
    countOverdueDcaOrders(cfg.chainId),
  ])

  return { chainId: cfg.chainId, monitored: true, gasStatus, balanceEth, overdueOrderCount }
}

export async function checkAllKeeperChains(): Promise<KeeperChainHealth[]> {
  return Promise.all(KEEPER_CHAINS.map(checkKeeperChain))
}

// ── Alerts ────────────────────────────────────────────────
// Loud, per the existing on-chain-monitor.ts convention: 'active' → 'disabled' for a dead/
// unreachable keeper, 'active' → 'degraded' for overdue fills. Never throws — a monitoring
// failure must not crash the tick.

export async function alertOnKeeperTrouble(results: KeeperChainHealth[]): Promise<void> {
  for (const r of results) {
    if (!r.monitored) continue

    if (r.gasStatus === 'critical' || r.gasStatus === 'rpc-unreachable') {
      const reason =
        r.gasStatus === 'rpc-unreachable'
          ? `keeper-rpc-unreachable: chain ${r.chainId}`
          : `keeper-gas-critical: chain ${r.chainId} balance ${r.balanceEth} ETH`
      try {
        await emitTransitionAlert(`keeper-gas-${r.chainId}`, 'active', 'disabled', reason)
      } catch (err) {
        console.warn('[KEEPER] Alert dispatch failed:', err instanceof Error ? err.message : err)
      }
    }

    if ((r.overdueOrderCount ?? 0) > 0) {
      const reason = `keeper-overdue-orders: chain ${r.chainId} count=${r.overdueOrderCount}`
      try {
        await emitTransitionAlert(`keeper-overdue-${r.chainId}`, 'active', 'degraded', reason)
      } catch (err) {
        console.warn('[KEEPER] Alert dispatch failed:', err instanceof Error ? err.message : err)
      }
    }
  }
}

// ── Reporting line (shared textual convention with the daily-report workflow) ──

/** e.g. "8453: ok (0.0421 ETH)" / "42161: not monitored" / "42161: critical (0.0001 ETH)". Never
 *  silent — every chain in KEEPER_CHAINS produces a line, monitored or not. */
export function describeKeeperHealth(health: KeeperChainHealth): string {
  if (!health.monitored) return `${health.chainId}: not monitored`

  const gasPart =
    health.gasStatus === 'rpc-unreachable'
      ? 'rpc-unreachable'
      : `${health.gasStatus} (${health.balanceEth} ETH)`
  const overdue = health.overdueOrderCount ?? 0
  return overdue > 0 ? `${health.chainId}: ${gasPart}, ${overdue} overdue fill(s)` : `${health.chainId}: ${gasPart}`
}
