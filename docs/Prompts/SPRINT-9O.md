# SPRINT-9O — Velora EkuboV3 route reverts via FeeCollector (mainnet)

## Symptom (prod, confirmed)
On mainnet, an ETH→USDC swap whose best route is **Velora → EkuboV3** fails pre-swap simulation with
"Simulation reverted: swap would fail on-chain". Balance is sufficient (0.0032 ETH, swapping 0.001).
Picking a DIFFERENT source (Uniswap V3, KyberSwap) executes fine. Velora on **Base** works (even ~$1).
So: specific to the Velora EkuboV3 route on mainnet, routed through the FeeCollector.

## What we know
- Velora (ParaSwap) is NOT fee-incompatible → it routes via the FeeCollector (`swapETHWithFee`).
- `src/lib/swap-selectors.ts` KNOWN_SWAP_SELECTORS has Augustus V6.2 methods `0xe3ead59e`
  (swapExactAmountIn) + the 9H Curve methods `0x1a01c532`, `0xe37ed256` — but **nothing for Ekubo**.
- The error is on-chain `execution reverted` (reached the chain via /api/rpc — `parseSimulationError`
  only emits this for `execution reverted`), NOT the client-side "Unknown swap function selector"
  guard we saw on Base in 9H. So the revert originates on-chain, not at the client allowlist.

## Part A — Investigate (decode before fixing)
1. Reproduce and capture the failing simulation tx: the inner Augustus calldata `to`, the 4-byte
   selector, and the FeeCollector-wrapped calldata. Identify the EkuboV3 Augustus V6.2 method name +
   selector (verify against the live Augustus `0x6a00…1068`, same as 9H).
2. Determine WHERE the revert originates — this decides the fix and its weight:
   a. The on-chain **FeeCollector contract's own selector/validation** rejects it → contract-level.
   b. **Augustus reverts** because the Ekubo method is msg.sender-bound / incompatible with being
      called by the FeeCollector (custody-then-forward) → route-level.
   c. A recipient/funds-source mismatch in the FeeCollector-wrapped calldata for this method.

## Part B — Mitigation (robust, ship regardless): no route should "win then fail"
Independent of the Ekubo root cause: when the BEST route fails the pre-swap FeeCollector simulation
with a conclusive revert, it must NOT stay selected and block the user. Auto-fall back to the next
source that simulates OK (or clearly demote it and surface the working alternative). Uniswap/Kyber
already work here — the user shouldn't have to manually re-pick. Add tests. (This is swap-selection
resilience, not a security gate, but keep the on-chain minimumOutput protection intact.)

## Part C — Proper fix (conditional on Part A)
- If EkuboV3 is a safe Augustus method that delivers to msg.sender and the on-chain FeeCollector
  already accepts it: add its selector to KNOWN_SWAP_SELECTORS **with the recipient-gate decoder
  correctly parsing the beneficiary** (the 9H audit's primary concern — allowlisting a selector whose
  recipient the decoder mis-parses = output-redirect risk). SECURITY change → Auditor review.
- If the on-chain **FeeCollector contract** rejects the selector (case A.a): STOP — this needs a
  contract change (allowlist update) which is a separate contract sprint with full audit + redeploy
  (CLAUDE.md rules #2/#3). Do NOT touch contracts here; report and escalate.
- If the Ekubo Augustus method is fundamentally incompatible with the FeeCollector (A.b): route
  Velora-Ekubo **direct (no fee, like fee-incompatible sources)** or exclude it from winning — your
  call with rationale; document the fee/UX trade-off.

## Human-boundary note (do NOT loop)
The final "a real Velora-Ekubo / fallback swap executes end-to-end in a wallet" check is an OWNER
post-merge step (needs a funded wallet + human signature). It is NOT an agent acceptance criterion —
do everything automatable (decode, unit/integration tests, Part B fallback tests, build), then STOP
and hand off; do not loop waiting on a human wallet action.

## Do NOT / quality
- No contract edits in this sprint (escalate if the contract is the blocker). Mainnet/Base
  byte-identical except the intended selection/allowlist behaviour. Keys server-only.
- TDD, branch `feat/sprint-9o-velora-ekubo-feecollector`, atomic SSH-signed commits, CI green, append
  FEEDBACK. Any selector-allowlist change → Auditor before prod; Part B alone may ship behind Preview.

## Separate, not in scope (noted)
- `eth.merkle.io` CORS flood = wagmi mainnet transport `fallback([http('/api/rpc'), http(undefined)],
  {rank:true})` background-pinging viem's default public RPC (CORS-blocked from the browser). Cosmetic
  + possible stray read failures, NOT the cause of this revert. Own follow-up.
- Service-worker `sw.js` error: "Failed to execute 'put' on 'Cache': Partial response (206)
  unsupported" — minor SW caching bug. Own follow-up.
