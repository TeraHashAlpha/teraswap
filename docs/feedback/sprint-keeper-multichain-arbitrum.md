# Feedback — SPRINT-KEEPER-MULTICHAIN-ARBITRUM

## Per-commit include / exclude

| # | Commit | Included | Deliberately excluded |
|---|---|---|---|
| 1 | `feat(keeper): add Arbitrum One (42161) gas tiers` | `gas-tier.js` 42161 branch + `_ARBITRUM` env overrides; 17 new tests | 1/8453 branches untouched |
| 2 | `feat(keeper): classify Arbitrum One (42161) as sequencer-private` | `submission-policy.js` 42161 → `sequencer-private`; 9 new tests | executor.js touch is a **comment only** |
| 3 | `feat(keeper): wire 42161 chain plumbing + pin the dark state` | DefiLlama slug, Arbitrum WETH, per-chain ETH/USD default, SwapRouter02 row, new `arbitrum-plumbing.test.mjs` (24) | order query / RPC client / Augustus row — already correct, **confirmed by test, not changed** |

Gas-tier values chosen (all **PENDING real-fill calibration** — no Arbitrum fills exist yet, so
unlike Base's these come from Nitro's published fee mechanics, not measurement):

| | NORMAL | ELEVATED | URGENT |
|---|---|---|---|
| threshold (gwei) | 0.1 | 0.5 | 1.0 |
| priority fee (gwei) | 0.001 | 0.005 | 0.01 |
| baseFee multiplier | 2 | 2.5 | 3 |

Thresholds sit 10× above the ArbOS 0.01 gwei base-fee floor (quiet market always resolves NORMAL)
but stay sub-gwei so the ELEVATED/URGENT/SKIP gates genuinely trigger. Priority fees are ~0 because
Nitro's sequencer is FCFS — a tip buys no inclusion — but strictly > 0 so a node rejecting a
literal-zero tip cannot defer a fill.

**1/8453 byte-identical — confirmed.** No mainnet or Base value changed in any of the three
commits. Pinned by explicit regression tests: full `deepEqual` snapshots of both gas-tier configs,
a `deepEqual` on Base's entire submission decision (including its unchanged reason string), the
mainnet fail-closed/relay decisions, the untouched DefiLlama slug line, the absence of any 1/8453
per-chain feed entry, and all three pre-existing `ROUTER_SOURCE` rows. Suite: **289 pass / 0 fail**
(240 before this sprint).

## Scope — file outside the prompt's list

- The prompt scoped reads to `gas-tier.js`, `submission-policy.js`, `executor.js` and the manifest,
  but requirement 3 names **routing (Augustus V6.2 + SwapRouter02)**, and the committed-router →
  `/api/swap` source map lives in **`swap-route.js`**. Adding Arbitrum's SwapRouter02 row there is
  the only way requirement 3's routing clause is implementable, so `swap-route.js` is included.
  Augustus V6.2 needed no row — Velora deploys it at the same address on Arbitrum as on Base and
  the map is keyed by (globally unique) address, so the existing entry already covers it (asserted
  to appear exactly once, so nobody "fixes" it by duplicating).

## Edge cases

- **`ETH_USD_FEED` defaulted to a mainnet-only address on every chain.** Chainlink deploys each feed
  at a different address per chain, so on Arbitrum the historical default reads a codeless address:
  `readEthUsd` returns null and the ETH leg silently loses its Chainlink-first price. Fixed with a
  per-chain default map containing **only** 42161 — chains 1 and 8453 keep the unchanged mainnet
  default, and an explicit `ETH_USD_FEED` still wins everywhere.
- **Same bug is still live on Base (8453).** A Base keeper reading the mainnet ETH/USD feed gets
  `null` unless the operator sets `ETH_USD_FEED`, which silently costs the ETH leg its
  Chainlink-first price and drops it to DefiLlama. Left alone deliberately (changing Base's default
  is out of this sprint's scope), but it wants its own chore. **Ops check worth doing now:** confirm
  the live Base keeper's `.env.executor` actually sets `ETH_USD_FEED`.
- **`ARBITRUM_ADDRESS_MANIFEST` `USDT` is `USD₮0`.** The manifest's on-chain `symbol()` for the
  USDT key is Tether's LayerZero omnichain token, not classic USDT. Irrelevant to this sprint (the
  keeper never reads symbols) but relevant to whoever wires the Arbitrum token catalog.
- **A 42161 keeper still cannot boot without `ORDER_EXECUTOR_ADDRESS` (v2).** `validateConfig()`
  hard-requires it, and no v2 executor exists on Arbitrum. The dark state proven here is the
  per-order path; the instance itself is not startable until Phase B deploys an executor. That is
  fine for a sprint that ships dark, but Phase B's runbook must cover it.
- **The pre-existing "unknown chain → mainnet fallback" gas-tier test used 42161 as its example.**
  It now uses Optimism (10); the assertion itself is unchanged.

## Test gap

- `executor.js` cannot be imported by a unit test (it calls `main()` at module load), so its
  constants are asserted against the file's **source text** in `arbitrum-plumbing.test.mjs`. That is
  strong enough to pin the addresses to the manifest and to catch a drifted literal, but it is
  brittle to reformatting. The durable fix is extracting the chain-config constants into a pure
  module the way `gas-tier.js` / `order-floor.js` / `swap-route.js` already were — worth a chore.

## Concern

- `submission-policy.js` classifying 42161 as `sequencer-private` is a **security-relevant
  judgement**, flagged for the Phase-B pre-deploy Auditor. It rests on Arbitrum One today having a
  single trusted sequencer with no public pending-tx gossip and FCFS ordering. A move to a
  decentralised sequencer, or a Timeboost-style express-lane auction, would reintroduce a
  reordering surface and this classification would need re-deriving.
