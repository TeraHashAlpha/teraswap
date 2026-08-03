# FILL-ECONOMICS-CALIBRATION — measuring where OE_V3 fill cost actually goes

**Date:** 2026-07-22. **Method:** on-chain reads (`https://mainnet.base.org`) + a local `anvil --fork-url` of Base (no transaction ever sent to the real network) + one read-only HTTP call to the public Paraswap/Velora price API. No code/config changed, no envs touched.

## 1. Decomposing the two real fills

| | Fill 1 | Fill 2 |
|---|---|---|
| Block / tx | `48934744` / [`0x4a8d0b52…94a6f`](https://basescan.org/tx/0x4a8d0b520ee2dfec0ccbeb949c8ef05509711ea616b03c427b0ccf9753794a6f) | `48934819` / [`0xc27e4c52…8d81d`](https://basescan.org/tx/0xc27e4c52ad137e8729d2ca34c6f8974d620b5e928ec5d7e0da956cdc9f28d81d) |
| `OrderExecuted` (owner `0xD44d…c962d`, DCA) | 0.00870775 WETH → 16.6673 USDC | 0.00580517 WETH → 11.1276 USDC |
| Route (`order.router`) | Augustus V6 `0x6A00…1068`, routerData **1156 B**, full `tx.input` **1924 B** | same shape, 1156 B / 1924 B |
| L2 execution gas (`gasUsed`) | **1,364,707** | **1,347,595** |
| `effectiveGasPrice` | 1.505 gwei | 1.505 gwei |
| L1 data fee (`l1Fee`, `l1GasUsed`=8473/8593) | 8.83e9 wei = 0.0000000088 ETH | 7.82e9 wei = 0.0000000078 ETH |
| **Total fee** | 0.00205389 ETH ≈ **$3.93** (implied price $1914.08 = trade's own out/in ratio) | 0.00202814 ETH ≈ **$3.89** ($1916.84) |
| **L1 share of total fee** | **0.00043%** | **0.00039%** |

**Headline 1 — L1 data fee is a rounding error.** Base's blob-based DA pricing makes posting 1.9 KB of calldata cost ~$0.00002. The entire $3.9 is L2 execution gas. This reframes the whole investigation: optimizing calldata size (compact routes) matters far less than optimizing *what the calldata costs to execute*.

**Headline 2 — the L2 cost is dominated by the keeper's gas TIER, not the swap.** `effectiveGasPrice` = 1.505 gwei matches `executor.js`'s `PRIORITY_FEE_NORMAL` default (**1.5 gwei**, `maxFeePerGas = baseFee×2 + priority`, `executor.js:234,943-947`) exactly. The *actual* Base network price right now (read live, `eth_gasPrice` + `baseFeePerGas`, block 48974880, 2026-07-22T16:51Z) is **0.005–0.006 gwei** — **~250× lower**. Running the *same* 1,364,707-gas aggregator fill at today's real market price costs **~$0.016**, not $3.93. The 1.5 gwei floor is a mainnet-calibrated safety margin applied uniformly with no Base-specific override (`grep` confirms no `*_BASE` gas-tier env exists).

## 2–3. Compact alternative + price delta

Built the exact `canonical-route.ts` calldata (SwapRouter02 `exactInputSingle`, fee tier 500, recipient=OE_V3) for both real fills, then **executed it for real on a local Base fork** (anvil, forked at block 48934900 — after both real fills, same warm contract state; a throwaway keypair funded via `WETH.deposit()`, whitelisted as an executor via a storage-slot match against the real contract's `whitelistedExecutors` slot #7; nothing left this machine). `amountOutMinimum=1` — gas/output measurement only, not a production floor.

| | Fill 1 (aggregator → canonical) | Fill 2 (aggregator → canonical) |
|---|---|---|
| gasUsed | 1,364,707 → **259,386** (ratio **5.26×**) | 1,347,595 → **258,623** (ratio **5.21×**) |
| Full `tx.input` | 1924 B → **996 B** | 1924 B → 996 B |
| amountOut | 16.6673 → **16.6960 USDC** (+0.17%) | 11.1276 → **11.1307 USDC** (+0.03%) |

At these sub-$20 sizes the canonical single 0.05% pool is **as good or slightly better** in output *and* uses ~19% of the gas.

**$10/$100/$1000 samples** (Paraswap/Velora public quote API read, 2026-07-22, WETH→USDC/8453; QuoterV2 `0x3d4e…C997a` read for canonical; local-fork `executeOrder` sim for gas):

| chunk | aggregator out (est., API) | canonical out (measured, QuoterV2) | Δ bps / $ | canonical full-order gasUsed (measured) |
|---|---|---|---|---|
| $10 | 10.177632 | 10.172599 | 4.9 bps / $0.005 | 258,613 |
| $100 | 101.782857 | 101.723804 | 5.8 bps / $0.059 | 258,613 |
| $1000 | 1017.800388 | 1017.233681 | 5.6 bps / $0.567 | 258,632 |

**Headline 3 — the "worse price" cost of the compact route is ~5–6 bps, flat across size, and gas is essentially size-invariant (~259k) across two orders of magnitude of notional** (single-tick-range swaps at this depth). The aggregator's own quote API reports a self-estimated gas cost of $0.0026 (218,300 gas) — a model estimate that does **not** match what we actually measured on-chain (1.35M gas); treat aggregator-reported gas costs as unreliable for calibration.

## 4. Competitor effective-cost estimates (EVM-only, methodology-first)

Neither model below is independently re-implemented here; each row reuses **our own measured single-swap settlement gas** (259k, current Base price) as the floor any comparable EVM settlement contract pays for one fill — this is a **lower bound**, since neither model publishes a Base-specific gas figure and both extract additional value via solver/resolver margin that is not observable without live solver quotes.

| Model | Basis | $10 | $25 | $50 | $100 | $500 |
|---|---|---|---|---|---|---|
| (a) Batch-auction (CoW-style) — gas floor ONLY, solver margin unknown *(est., 2026-07-22)* | 259k gas @ $0.006 gwei ≈ $0.003 flat, no stated protocol fee | 0.030% | 0.012% | 0.006% | 0.003% | 0.0006% |
| (b) Intent-based aggregator — gas floor ONLY, resolver margin unknown *(est., 2026-07-22)* | same proxy | 0.030% | 0.012% | 0.006% | 0.003% | 0.0006% |
| (c) Ours: 0.20% fee + measured compact-route gas *(measured, 2026-07-22)* | fee + $0.003 | **0.230%** | 0.212% | 0.206% | 0.203% | 0.2006% |

⚠️ **(a)/(b) are not a fair "all-in" comparison** — they omit the solver's required price-improvement margin, which is the actual mechanism by which those models are paid; public docs describe the *fill condition* (price beats limit by enough to cover solver gas) but not a quoted fee, so no all-in % can be produced from public information alone. Row (c) is the only fully-specified all-in figure in this table.

## 5. Calibration

**Viability line:** `gas$ ≤ notional×(maxSlippageBps/10000) − notional×0.0020`.

| gas scenario | min viable bps @ $10 | @ $25 | @ $50 | @ $100 | @ $500 |
|---|---|---|---|---|---|
| Canonical route, **current keeper tier** (1.5 gwei, $0.75/fill) | 770 bps *(exceeds the 500 bps contract cap — NOT viable)* | 320 bps | 170 bps | 95 bps | 35 bps |
| Canonical route, **current Base market price** (0.006 gwei, $0.003/fill) | **23 bps** | 21.2 bps | 20.6 bps | 20.3 bps | 20.06 bps |

**Base L1 volatility (5 samples, ~24h span, `L1Block` predeploy `0x4200…0015`):** `blobBaseFee` ranged **4.56M–10.04M wei (2.2×)**; `baseFeePerGas` (L2) stayed **pegged at the 0.005 gwei floor the entire window**. Virtually all cost variance you'll see fill-to-fill is the keeper's own tier choice, not the network.

**Recommendations:**
1. **`MIN_ORDER_AMOUNT`/chunk for public go-live: $50.** Under the *current, unfixed* gas tier, $10–$25 chunks require an unreasonable (or outright uncapped) slippage budget; $50 stays viable (≤170 bps) under today's tier and trivially viable (≤21 bps) once the tier is fixed. Revisit down to $10–$20 after recommendation 3.
2. **DCAPanel budget presets: keep the existing 100/300(default)/500 bps chips — no change.** 300 bps already clears the $100-chunk floor even under the unfixed tier (95 bps) with large headroom, and clears every scenario once the tier is Base-scoped.
3. **Highest-leverage fix (not this report's to make): scope `GAS_PRIORITY_NORMAL_GWEI` per chain.** The mainnet-calibrated 1.5 gwei default, applied on Base where 0.001–0.006 gwei fills the same block, is the single biggest lever — bigger than any route change. Until it ships, the keeper's defer-window (mirroring the M-01 pinned-route-revert pattern) should treat "signed budget bps materially below the *current-tier-implied* floor bps" as a defer signal rather than force-filling, at the existing ~30s poll cadence.
