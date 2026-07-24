# FIX-KEEPER-ETH-USD-FEED-CHAINAWARE

Make the keeper's ETH/USD Chainlink aggregator **chain-aware and fail-closed**, replacing a
hardcoded mainnet default that silently degraded the DCA oracle-floor reference on every other
chain.

- **Branch:** `fix/keeper-eth-usd-feed-chainaware` (off `origin/main` @ `b9442c3`, after #345 —
  both touch `executor.js`), SSH-signed
- **Severity:** latent trap. **Prod is safe today** — Base's `.env.executor` sets `ETH_USD_FEED`
  and #345 added a 42161 code default. This closes the hole before a new chain, or a Base keeper
  redeployed from a fresh env file, falls into it.

---

## Context

`executor.js` resolved `ETH_USD_FEED` as `process.env.ETH_USD_FEED || <per-chain> || "0x5f4e…8419"`
— the **mainnet** aggregator as the universal tail. That is not merely a freeze/low-gas-alert
concern: `readEthUsd` feeds `fetchReferencePriceUsd`, which is the **ETH leg of the DCA Phase-0
oracle floor** (`order-floor.js`) — i.e. fund-flow-adjacent.

On any chain not in the per-chain map, with `ETH_USD_FEED` unset, the keeper read a **codeless
address**: `readEthUsd` returned null and the ETH leg lost its Chainlink-first price, degrading to
DefiLlama with no signal that anything was wrong.

---

## Objective

Resolve the aggregator for `CHAIN_ID` from the app's source of truth, and **never** hand a chain
another chain's feed.

---

## Requirement

Replace the hardcoded mainnet default with chain-aware resolution. When `ETH_USD_FEED` is unset,
resolve the ETH/USD aggregator for `CHAIN_ID` from `src/lib/chains/chainlink-feeds.ts`
(8453/42161 ETH-USD entries; mainnet via `constants.ts` `CHAINLINK_ETH_USD`). **Fail-closed**: no
feed for the chain → keep the existing fail-open reference fallback + a clear log, **never a wrong
address**. An explicit `ETH_USD_FEED` still overrides (unchanged). Behaviour with the env **set**
stays byte-identical on 1/8453.

---

## Do NOT

- Change the reference-price / floor logic.
- Touch `fetchReferencePriceUsd`'s fallback semantics.
- Hand-type hex.
- Alter mainnet behaviour when the env is set.
- Open a PR (owner-manual).

---

## Files affected

| File | Change |
|---|---|
| `contracts/order-engine/executor/eth-usd-feed.js` | **new** — pure chain-aware resolution |
| `contracts/order-engine/executor/executor.js` | wire the resolution; `readEthUsd` guard; boot log |
| `contracts/order-engine/executor/eth-usd-feed.test.mjs` | **new** — drift guard + resolution tests |
| `contracts/order-engine/executor/arbitrum-plumbing.test.mjs` | repoint 3 assertions from the removed const to the module |
| `src/lib/chains/chainlink-feeds.ts`, `src/lib/constants.ts` | read-only source of truth |

---

## Expected output

Branch pushed and SSH-signed, keeper suite green, compare link reported, feedback ≤1 screen. CI
runs when the **owner** opens the PR.

---

## Quality criteria

- Base/Arbitrum with the env unset resolve their OWN aggregator, not mainnet's.
- An unknown chain resolves `null` — the Chainlink read is skipped entirely, never attempted
  against a foreign address.
- An explicit `ETH_USD_FEED` is passed through verbatim on every chain.
- Mainnet with the env unset resolves the same literal as before the fix.
- A drift guard parses the app's TypeScript and fails if the keeper's mirror diverges.

---

## Auditor note

Keeper-side, **feeds the DCA floor reference** → Auditor NOTE, not a blocking gate (prod behaviour
with the env set is byte-identical). Two things for the Auditor to eyeball, and for the **Phase-B
pre-deploy Auditor** to re-confirm because this touches the reference price:

1. **The resolution.** `env → chain default → null`, mirroring the app's `chainlink-feeds.ts` via a
   drift-guarded copy (the keeper is a standalone Node package and cannot import the app's TS).
   The drift guard parses the TS and fails on any divergence — verified by deliberately corrupting
   one address.
2. **Fail-closed when no feed.** An unknown chain disables the Chainlink read rather than reading a
   foreign address. `fetchReferencePriceUsd`'s fallback is untouched: a null ETH read still falls
   through to DefiLlama, and an ETH-leg miss is still classified TRANSIENT, so the fill is
   delayed/flagged — never filled unbounded, and never priced off another chain's oracle.
