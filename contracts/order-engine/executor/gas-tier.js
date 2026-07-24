/**
 * [FIX-KEEPER-GAS-TIER-BASE] Per-chain keeper gas-tier resolution.
 *
 * FILL-ECONOMICS-CALIBRATION.md (2026-07-22/23) measured the two real OE_V3 fills at ~$3.90
 * each and found the cost is NOT L1 data fees (0.0004% of cost — noise under Base's blob DA
 * pricing) but the keeper's own `PRIORITY_FEE_NORMAL = 1.5 gwei`: a mainnet-calibrated default
 * applied uniformly with no Base override, against a live Base gas price of ~0.005-0.006 gwei
 * (`baseFeePerGas` pegged at that floor across a sampled 24h window) — a ~250x overpayment.
 * Same fill at real Base pricing ≈ $0.016.
 *
 * This module makes every gas-tier number PER CHAIN so mainnet can stay exactly as it was
 * while Base gets its own regime. Extracted as a pure module (no I/O, no clock) because
 * executor.js auto-runs main() on import and so is not unit-testable — same reason
 * order-floor.js / retry-policy.js / executor-routing.js / pinned-route.js are separate.
 */

export const MAINNET_CHAIN_ID = 1
export const BASE_CHAIN_ID = 8453
/** [SPRINT-KEEPER-MULTICHAIN-ARBITRUM] Arbitrum One — a second CHAIN_ID this keeper can serve. */
export const ARBITRUM_CHAIN_ID = 42161

function num(envVar, fallback) {
  const raw = process.env[envVar]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Mainnet — BYTE-IDENTICAL to the pre-fix hardcoded defaults, read from the SAME unsuffixed env
 * vars as before this change (GAS_TIER_NORMAL_GWEI, GAS_PRIORITY_NORMAL_GWEI, ...). No operator
 * config that already sets these needs to change.
 */
function mainnetConfig() {
  return {
    thresholdsGwei: {
      NORMAL: num("GAS_TIER_NORMAL_GWEI", 30),
      ELEVATED: num("GAS_TIER_ELEVATED_GWEI", 80),
      URGENT: num("GAS_TIER_URGENT_GWEI", 100),
    },
    priorityFeeGwei: {
      NORMAL: num("GAS_PRIORITY_NORMAL_GWEI", 1.5),
      ELEVATED: num("GAS_PRIORITY_ELEVATED_GWEI", 2.5),
      URGENT: num("GAS_PRIORITY_URGENT_GWEI", 4),
    },
    baseFeeMult: {
      NORMAL: num("GAS_BASEFEE_MULT_NORMAL", 2),
      ELEVATED: num("GAS_BASEFEE_MULT_ELEVATED", 2.5),
      URGENT: num("GAS_BASEFEE_MULT_URGENT", 3),
    },
  }
}

/**
 * Base (8453) — derived from FILL-ECONOMICS-CALIBRATION.md's measured reality. `_BASE`-suffixed
 * env vars (mirroring this repo's existing per-chain override convention, e.g.
 * NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE) let an operator retune without a redeploy.
 *
 * Derivation (documented so a future recalibration has the reasoning, not just numbers):
 *   - Priority fees (0.02 / 0.05 / 0.1 gwei): ~3-4x the measured ~0.005-0.006 gwei live floor —
 *     enough headroom for normal inclusion, while cutting the calibration's measured 250x
 *     overpayment down to a ~4x intentional margin. Ratios (1 : 2.5 : 5) roughly mirror
 *     mainnet's (1 : 1.67 : 2.67) shape.
 *   - Thresholds (0.05 / 0.15 / 0.3 gwei): scaled ~10x/30x/60x over the observed floor. Using
 *     mainnet's absolute thresholds (30/80/100 gwei) on Base would mean gasPriceGwei > 30 NEVER
 *     happens under Base's normal regime, silently disabling the ELEVATED/URGENT/SKIP gates
 *     entirely (every order would always resolve NORMAL, gas price notwithstanding). REVISIT
 *     once a real Base congestion event has been observed and measured — the calibration report
 *     only captured a quiet 24h window (L2 baseFeePerGas pegged at its 0.005 gwei floor
 *     throughout), so there is no data yet on how high Base's gas price actually spikes.
 *   - Base-fee multipliers (2 / 2.5 / 3): unchanged from mainnet. These are RELATIVE multipliers
 *     on an already-tiny Base baseFee, so keeping them conservative costs essentially nothing.
 */
function baseConfig() {
  return {
    thresholdsGwei: {
      NORMAL: num("GAS_TIER_NORMAL_GWEI_BASE", 0.05),
      ELEVATED: num("GAS_TIER_ELEVATED_GWEI_BASE", 0.15),
      URGENT: num("GAS_TIER_URGENT_GWEI_BASE", 0.3),
    },
    priorityFeeGwei: {
      NORMAL: num("GAS_PRIORITY_NORMAL_GWEI_BASE", 0.02),
      ELEVATED: num("GAS_PRIORITY_ELEVATED_GWEI_BASE", 0.05),
      URGENT: num("GAS_PRIORITY_URGENT_GWEI_BASE", 0.1),
    },
    baseFeeMult: {
      NORMAL: num("GAS_BASEFEE_MULT_NORMAL_BASE", 2),
      ELEVATED: num("GAS_BASEFEE_MULT_ELEVATED_BASE", 2.5),
      URGENT: num("GAS_BASEFEE_MULT_URGENT_BASE", 3),
    },
  }
}

/**
 * Arbitrum One (42161) — [SPRINT-KEEPER-MULTICHAIN-ARBITRUM]. `_ARBITRUM`-suffixed env vars
 * mirror the `_BASE` convention above, so an operator can retune without a redeploy.
 *
 * ⚠️ PENDING REAL-FILL CALIBRATION. Base's numbers came from FILL-ECONOMICS-CALIBRATION.md, which
 * measured two REAL OE_V3 fills. There is no Arbitrum executor deployed yet (this sprint ships
 * DARK), so there are ZERO real Arbitrum fills to calibrate against — the values below are derived
 * from Arbitrum Nitro's published fee mechanics, NOT from measurement. Re-derive them from the
 * first real fills exactly as the Base note was, and treat them as provisional until then.
 *
 * Derivation (documented so a future recalibration has the reasoning, not just numbers):
 *   - Priority fees (0.001 / 0.005 / 0.01 gwei) — effectively ~0, and deliberately so. Nitro's
 *     sequencer orders transactions FIRST-COME-FIRST-SERVED: there is no priority auction, so a
 *     tip buys NO inclusion advantage (unlike mainnet, and unlike even Base's small margin). The
 *     values are kept strictly ABOVE zero only so a node/RPC that rejects a literal-zero
 *     maxPriorityFeePerGas still accepts the tx — paying ~0.001 gwei on Arbitrum's ~0.01 gwei
 *     floor is a rounding error, whereas a rejected tx would defer the fill. Ratios (1 : 5 : 10)
 *     keep the same escalating shape as mainnet (1 : 1.67 : 2.67) and Base (1 : 2.5 : 5).
 *   - Thresholds (0.1 / 0.5 / 1.0 gwei): ArbOS enforces a 0.01 gwei L2 base-fee FLOOR, and quiet
 *     Arbitrum sits on it, so the floor is a full 10x BELOW NORMAL — a quiet-market fill always
 *     resolves NORMAL, never SKIP. They are still real ceilings rather than decorative: Arbitrum's
 *     congestion spikes are sub-gwei, so ELEVATED/URGENT/SKIP genuinely trigger under load —
 *     the exact failure mode the Base note calls out for mainnet's 30/80/100 gwei on an L2
 *     (thresholds so far above the regime that every order silently resolves NORMAL).
 *   - Base-fee multipliers (2 / 2.5 / 3): unchanged from mainnet and Base. These are RELATIVE
 *     multipliers on an already-tiny L2 baseFee, so keeping them conservative costs ~nothing and
 *     absorbs the intra-block base-fee drift Nitro's rapid blocks produce.
 *
 * Deferral semantics are IDENTICAL to Base/mainnet: resolveGasTier only ever returns
 * execute:false, which the executor.js call site treats as "leave the order active, retry next
 * cycle". Gas price alone can never fail an order on Arbitrum either.
 */
function arbitrumConfig() {
  return {
    thresholdsGwei: {
      NORMAL: num("GAS_TIER_NORMAL_GWEI_ARBITRUM", 0.1),
      ELEVATED: num("GAS_TIER_ELEVATED_GWEI_ARBITRUM", 0.5),
      URGENT: num("GAS_TIER_URGENT_GWEI_ARBITRUM", 1),
    },
    priorityFeeGwei: {
      NORMAL: num("GAS_PRIORITY_NORMAL_GWEI_ARBITRUM", 0.001),
      ELEVATED: num("GAS_PRIORITY_ELEVATED_GWEI_ARBITRUM", 0.005),
      URGENT: num("GAS_PRIORITY_URGENT_GWEI_ARBITRUM", 0.01),
    },
    baseFeeMult: {
      NORMAL: num("GAS_BASEFEE_MULT_NORMAL_ARBITRUM", 2),
      ELEVATED: num("GAS_BASEFEE_MULT_ELEVATED_ARBITRUM", 2.5),
      URGENT: num("GAS_BASEFEE_MULT_URGENT_ARBITRUM", 3),
    },
  }
}

const CONFIG_FACTORY_BY_CHAIN = {
  [MAINNET_CHAIN_ID]: mainnetConfig,
  [BASE_CHAIN_ID]: baseConfig,
  [ARBITRUM_CHAIN_ID]: arbitrumConfig,
}

/**
 * Resolve the gas-tier config for a chain. An unconfigured chain fails closed to MAINNET's
 * config (higher thresholds, higher priority fees) — safe in the sense that a keeper on a new
 * chain will still get included rather than silently underpaying, mirroring this repo's existing
 * "unknown chain -> mainnet fallback" convention (e.g. getWhitelistedRouters). It deliberately
 * never falls back to Base's LOW values for an unrecognised chain, since underpaying gas on an
 * unmodeled chain risks a stuck fill, which is worse than the cost overpayment this fix targets.
 */
export function getGasTierConfig(chainId) {
  const factory = CONFIG_FACTORY_BY_CHAIN[chainId] ?? mainnetConfig
  return factory()
}

/**
 * Determine if an order should execute at the current gas price, and return EIP-1559 params if
 * so. Pure function of (chainId, currentGasPriceWei, baseFeeWei, urgency) — no I/O.
 *
 * [FIX-KEEPER-GAS-TIER-BASE] Deferring here (execute:false) is ALREADY consistent with the M-01
 * transient pattern — the caller unlocks the order back to 'active' and tries again next cycle;
 * it never routes through the failure ladder. This function only decides the classification; the
 * "never fail on gas-price grounds" property lives at the call site in executor.js, unchanged by
 * this fix.
 *
 * @param {object} p
 * @param {number} p.chainId
 * @param {bigint} p.currentGasPriceWei
 * @param {bigint} p.baseFeeWei
 * @param {"URGENT"|"ELEVATED"|"NORMAL"} p.urgency
 * @returns {{ execute: boolean, tier: string, maxFeePerGas?: bigint, maxPriorityFeePerGas?: bigint }}
 */
export function resolveGasTier({ chainId, currentGasPriceWei, baseFeeWei, urgency }) {
  const cfg = getGasTierConfig(chainId)
  const gasPriceGwei = Number(currentGasPriceWei) / 1e9

  if (gasPriceGwei > cfg.thresholdsGwei.URGENT) {
    return { execute: false, tier: "SKIP" }
  }

  if (gasPriceGwei > cfg.thresholdsGwei.ELEVATED) {
    if (urgency !== "URGENT") return { execute: false, tier: "URGENT_ONLY" }
    return tierResult("URGENT_ONLY", cfg, "URGENT", baseFeeWei)
  }

  if (gasPriceGwei > cfg.thresholdsGwei.NORMAL) {
    if (urgency === "NORMAL") return { execute: false, tier: "ELEVATED" }
    return tierResult("ELEVATED", cfg, "ELEVATED", baseFeeWei)
  }

  return tierResult("NORMAL", cfg, "NORMAL", baseFeeWei)
}

function gweiToWei(g) {
  // Mirrors the precision the original code got from viem's parseGwei(String(x)) without
  // importing viem into this otherwise dependency-free pure module: round to the nearest wei
  // via a fixed 1e9 multiplier, which is exact for the gwei values this module deals in.
  return BigInt(Math.round(g * 1e9))
}

function tierResult(tierLabel, cfg, key, baseFeeWei) {
  const priorityWei = gweiToWei(cfg.priorityFeeGwei[key])
  const mult = BigInt(Math.ceil(cfg.baseFeeMult[key]))
  return {
    execute: true,
    tier: tierLabel,
    maxPriorityFeePerGas: priorityWei,
    maxFeePerGas: baseFeeWei * mult + priorityWei,
  }
}

/** Boot-time sanity check: NORMAL < ELEVATED < URGENT for a given chain's thresholds. */
export function assertTierOrdering(chainId) {
  const cfg = getGasTierConfig(chainId)
  const { NORMAL, ELEVATED, URGENT } = cfg.thresholdsGwei
  if (!(NORMAL < ELEVATED && ELEVATED < URGENT)) {
    throw new Error(
      `Invalid gas tier ordering for chain ${chainId}: NORMAL(${NORMAL}) < ELEVATED(${ELEVATED}) < URGENT(${URGENT}) required`,
    )
  }
}
