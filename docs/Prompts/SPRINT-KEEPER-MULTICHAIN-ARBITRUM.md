# SPRINT-KEEPER-MULTICHAIN-ARBITRUM

Teach the self-hosted keeper (`executor.js`) to serve **Arbitrum One (42161)** as a second
`CHAIN_ID` instance. Ships **DARK** — no Arbitrum executor is deployed yet.

- **Branch:** `sprint/keeper-multichain-arbitrum` (off `origin/main`, SSH-signed)
- **Phase:** A (keeper readiness). Phase B = the Arbitrum executor deploy, which carries the full
  0C/0H Auditor gate.

---

## Context

`executor.js` is already `CHAIN_ID`-parameterized: orders are filtered by `chain_id`, the RPC
client is built from `CHAIN_ID` + `RPC_URL`, and the oracle floor reads Chainlink feeds (the 42161
feeds landed in `CHORE-47B`). The only genuine gaps are **gas tiers** and **submission
classification** for 42161.

When `ORDER_EXECUTOR_V3_ADDRESS` is unset for a chain, `executor.js` already routes a v3-signed
order to a **submission-blocked** path (`resolveExecutorRouting` → `ok:false` → skipped, flagged,
left `active`). That IS the intended dark state for 42161 until the deploy.

Mainnet (1) and Base (8453) behaviour MUST stay **byte-identical**.

---

## Objective

Make a `CHAIN_ID=42161` keeper instance correct-by-construction *before* the executor exists, so
Phase B is a deploy + env flip rather than a code change.

---

## Requirements (one commit each)

1. **`gas-tier.js`** — add a 42161 case with conservative Arbitrum Nitro tiers (priority fee ~0;
   `maxFeePerGas = baseFee × buffer` across NORMAL/ELEVATED/URGENT), keeping the "defer never fails
   an order" semantics identical to Base. Document the values as **PENDING real-fill calibration**,
   mirroring the Base calibration note. Do NOT alter the 1/8453 branches.
2. **`submission-policy.js`** — classify 42161 as an L2 with a **private sequencer mempool** →
   submit normally, same class as Base/OP-stack. NEVER a public-mempool path (no MEV exposure).
   Add 42161 explicitly; 1/8453 unchanged.
3. **Chain-plumbing + dark-safety** — confirm `CHAIN_ID=42161` flows correctly through the order
   query, RPC client, oracle floor and routing (Augustus V6.2 + SwapRouter02). Pull the 42161
   router addresses **ONLY** from `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json` — never hand-typed.
   With `ORDER_EXECUTOR_V3_ADDRESS` unset for 42161 the submission-blocked path must hold (prove
   with a test). No behaviour change for 1/8453.

---

## Do NOT

- Deploy anything, or flip any env var.
- Touch `OrderExecutorV3` or any Solidity.
- Change mainnet/Base gas tiers or submission behaviour.
- Touch `DCAPanel`/frontend/config gate (`SPRINT-48` already did the gate).
- Hand-type any hex address.
- Open a PR (owner-manual).

---

## Files affected

| File | Change |
|---|---|
| `contracts/order-engine/executor/gas-tier.js` | 42161 tier config |
| `contracts/order-engine/executor/submission-policy.js` | 42161 → `sequencer-private` |
| `contracts/order-engine/executor/executor.js` | DefiLlama slug, ETH-priced WETH, per-chain ETH/USD feed default, comments |
| `contracts/order-engine/executor/swap-route.js` | Arbitrum SwapRouter02 → `uniswapv3` |
| `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json` | read-only (address source of truth) |

Tests: `gas-tier.test.mjs`, `submission-policy.test.mjs`, new `arbitrum-plumbing.test.mjs`.

---

## Expected output

Branch pushed and SSH-signed, keeper suite green, compare link reported, feedback recorded.
CI runs when the **owner** opens the PR.

---

## Quality criteria

- 42161 gas tiers resolve NORMAL at the ArbOS 0.01 gwei floor and SKIP at mainnet-scale prices.
- 42161 never classifies as public-mempool under any relay/override combination.
- Dark state proven: 42161 + unset executor ⇒ submission-blocked, order left `active`, never failed.
- Every Arbitrum address in the keeper is pinned to the manifest by a test.
- Chains 1 and 8453 byte-identical, asserted by explicit regression tests.

---

## Auditor note

Keeper-side, fund-flow-adjacent, **no contract or gate change**, ships dark. This merges on
**CI-green + an Auditor NOTE**, not a blocking 0C/0H gate. Two items are explicitly deferred to the
**Phase-B pre-deploy Auditor**:

1. **The `submission-policy.js` classification.** Arbitrum One is treated as `sequencer-private`
   (one trusted sequencer, no public pending-tx gossip, FCFS ordering, no Flashbots-equivalent
   relay). The residual — sequencer-level and cross-domain MEV — is the oracle-bounded floor's job
   (`order-floor.js`), exactly as on Base. Re-confirm this holds at deploy time, particularly
   against any Arbitrum decentralised-sequencer / Timeboost-style ordering change.
2. **The gas-tier values.** Unlike Base's (measured from two real fills in
   `FILL-ECONOMICS-CALIBRATION.md`), these are derived from Nitro's published fee mechanics — there
   are zero real Arbitrum fills to calibrate against. Re-derive from the first real fills.

The full 0C/0H Auditor gate rides the Arbitrum executor **DEPLOY (Phase B)**.
