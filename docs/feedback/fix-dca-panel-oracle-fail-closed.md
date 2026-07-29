# Feedback — fix/dca-panel-oracle-fail-closed

## What now blocks creation

`DCAPanel` keeps the full `PriceCheck` from both `useChainlinkPrice` calls and classifies each leg
through the **same** `evaluatePriceGate` the swap flow uses (`evaluateDcaOracleGate` only aggregates
the two legs and carries the failing leg's own message — no second decision, no new threshold,
`price-gate.ts` untouched). `mode: 'block'` on **either** leg blocks: `canCreate`, an in-handler
guard, the DefiLlama fetch effect, and the `signingMin` preview. Blocking states reaching it in
practice: unreadable feed, feed-identity mismatch (ADR-018), `answer <= 0`, `answeredInRound <
roundId`, staleness, and **connected-with-unresolved-chain**. Note the stale / `answeredInRound`
verdicts return a **populated** `chainlinkPrice` alongside `oracleIntegrityFailed`, so before this
the bad number was used directly, not merely missing.

## Premise correction (raises severity)

The prompt states the fix is inert because `v3Enabled` is false everywhere, becoming live "the moment
a chain enables v3". Accurate version: `page.tsx` only renders `DCAPanel` behind `isDcaLive(chainId)`,
which **requires `getOrderExecutorV3(chainId) !== null`** — the *same* condition as `v3Enabled`. So
`v3Enabled` is true on every chain where the panel is reachable at all; the fallback is not a future
branch, it is on the critical path of DCA's first live day. The v2 branch inside `DCAPanel` is the
genuinely dead one (tests only), which is why the gate is armed on `v3Enabled`: on v2 `minAmountOut`
is the literal `'1'` and `priceFeed` is `address(0)`, so the feed reads feed nothing and blocking
there would cost availability on any ETH/USD RPC blip for zero safety.

## How the fallback was proved unreachable

Mutation, not inspection — each guard reverted individually against the new suite (15 tests):
reverting the effect guard → THE TRAP test fails; reverting the `signingMin` guard → the
floor-preview test fails; reverting `canCreate` → the two block tests fail; reverting
`evaluateDcaOracleGate` → 10 fail. All 15 pass intact. The trap test uses the identity-mismatch
verdict specifically because it returns `chainlinkPrice: null`, so the fallback's own trigger
(`chainlinkPriceIn == null`) **is** satisfied — pre-fix it fetched DefiLlama and signed a floor from
it. `APPROX_PRICES` is gated too: it sits behind DefiLlama inside `deriveSigningMinAmountOut` and
needs no live source, so blocking only the fetch would still have rendered a confident floor.

## `depegBlocking` — KEPT

Provably unreachable today, and removal still rejected. Evidence: removing only
`if (depegBlocking) return` leaves `DCAPanel.test.tsx` at 19/19 — nothing pins it, because
`canCreate` duplicates the condition in the same render closure. But removing `!depegBlocking` from
`canCreate` *as well* fails 4 tests including L-1. Its oracle twin is measurably load-bearing: with
`canCreate` reverted but the in-handler guard intact, the forced-click test passes — the guard is
what stops the signature. "Unreachable while `canCreate` happens to agree" is not a durable proof,
and it has two identical siblings (`scheduleFit`, `minChunkGuard`). Removing one of four would read
as an oversight and reopen L-1. Trivial to overrule with the numbers above.

## Test gap (out of scope, needs an owner decision)

`ci.yml` gates DCAPanel by explicit filename and lists **only** `DCAPanel.routability.test.tsx`.
`DCAPanel.oracle-fail-closed.test.tsx` (and `DCAPanel.v3.test.tsx`, already unpinned on main) will
**never run in CI**. Left unedited deliberately — `ci.yml` is outside this PR's stated scope. One-line
fix: append both files to the `dca-resilience-guard` job's `vitest run` list (`ci.yml:186`).

## Edge case found in the existing v3 suite

`DCAPanel.v3.test.tsx` was returning `data: undefined, isLoading: false` for the feed reads, which
`useChainlinkPrice` classifies as UNREADABLE. Those tests were therefore signing v3 DCA orders and
deriving the signed floor from DefiLlama **while the oracle had refused** — the suite encoded the
laundering behaviour as expected. Rebased onto a healthy verified feed; its `useAccount` mock also
lacked `chain`, so `useResolvedChainId()` returned `undefined` (itself an integrity failure). Its
DefiLlama-fallback test now uses the *legitimate* trigger (no feed at all), which doubles as the
regression guard that feedless tokens — the ordinary imported-asset DCA case — are not blocked.
