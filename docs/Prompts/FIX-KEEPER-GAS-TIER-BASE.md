# FIX-KEEPER-GAS-TIER-BASE — per-chain keeper gas tiers (the 250× overpayment fix)

> **Source:** FILL-ECONOMICS-CALIBRATION.md (2026-07-23), headline finding: the two real OE_V3 fills cost
> ~$3.90 each NOT because of Base L1 data fees (measured: 0.0004% of cost — noise under blob DA) but because
> the keeper's `PRIORITY_FEE_NORMAL = 1.5 gwei` is mainnet-calibrated with NO Base override — live Base gas
> ~0.006 gwei, ~250× lower. Same fill at real Base pricing ≈ **$0.016**. This is the calibration's flagged
> highest-leverage fix. Keeper gas-pricing config only — no fund-flow logic, no contract, no signing →
> Auditor note in the PR body. SSH-signed; branch `fix/keeper-gas-tier-base`, worktree UNDER
> `.claude/worktrees/`; 2 droppable commits. **Exit = push + keeper suite green + compare link; owner opens
> the PR.**

## Requirements
1. **Per-chain gas tiers:** restructure the keeper's priority-fee tiers (NORMAL/ELEVATED/URGENT) to be
   per-chain-keyed with the current values as the mainnet entry (mainnet behavior byte-identical). Add a
   Base (8453) entry derived from the calibration's measured reality (~0.006 gwei live): set defaults with
   headroom but sane ceilings (e.g. NORMAL ≈ 0.02 gwei, ELEVATED/URGENT proportionally; justify the chosen
   values against the calibration numbers in a comment + FEEDBACK). Prefer dynamic sampling
   (eth_maxPriorityFeePerGas / fee history percentile) clamped by the per-chain ceiling if the keeper
   already has the plumbing; otherwise static per-chain constants with a clear revisit note.
2. **Gas-tier SKIP thresholds** (the "NORMAL ≤30gwei" style gates) become per-chain too — a mainnet-scaled
   threshold on Base would never skip; scale them to Base's regime.
3. **Defer-window interaction (calibration rec 3):** where the keeper defers a fill for cost reasons, treat
   "cost above the current-tier-implied floor" as a defer signal consistent with the M-01 transient
   pattern — do NOT mark orders failed on gas-price grounds. Keep this minimal; if it grows, split out.
4. **Tests:** per-chain tier resolution (mainnet unchanged, Base new values), skip/defer thresholds
   per-chain, a regression test asserting Base priority fee ≤ the Base ceiling (never the mainnet 1.5 gwei
   again). Keeper suite green.

## Do NOT
Touch contracts, signing, API, DCA/order logic, retry ladder semantics beyond §3; change mainnet values;
open a PR.

## Files affected (read ONLY these + tests)
The keeper gas config module (executor.js / gas-policy module) + keeper tests,
`docs/Prompts/FIX-KEEPER-GAS-TIER-BASE.md`. Read-only: docs/Reports/FILL-ECONOMICS-CALIBRATION.md.

## Expected output
Branch + compare link. FEEDBACK ≤1 screen: old vs new per-chain table, the derivation of Base values from
the calibration, expected per-fill cost after fix (~$0.016 at current gas), tests. Auditor note: gas-pricing
config only, mainnet byte-identical, no fund-flow logic.
