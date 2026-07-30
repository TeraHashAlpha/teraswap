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

---

# Feedback — audit follow-up (L-1 + L-2), rebased onto `origin/main` @ `0a8b812`

## Rebase (PR #370 + #371)

Textually clean — **zero conflicts**. The branch touches 4 files, `origin/main` touched 9, and the
two sets are disjoint. But #370 landed a **semantic** conflict that no merge could have flagged:
`useChainlinkPrice` now resolves feeds through `resolveFeed` (`@/lib/chains/chainlink-feeds`) instead
of `getChainlinkFeed` (`@/lib/chainlink`), so **both** suites' `vi.mock('@/lib/chainlink', …
getChainlinkFeed)` stub went inert. Consequences, both found by running the suite rather than reading
it:

- `oracle-fail-closed`'s CONTRAST test went **red** (`mockGetChainlinkFeed → null` no longer produced
  a feedless leg, so DefiLlama was never consulted).
- `v3`'s no-DefiLlama-coverage test stayed **green but vacuous** — its stated premise ("the token has
  no Chainlink feed at all") silently stopped holding, and it was in fact exercising the healthy-feed
  path. This is the more dangerous of the two: it is the regression guard for *not* blocking feedless
  tokens, and it had quietly stopped guarding anything.

No assertion was weakened or deleted to resolve either. Both keep their exact assertions; only the
*mechanism* that produces the feedless state was repaired — `oracle-fail-closed` now buys a token
genuinely absent from every registry (real resolver decides), `v3` stubs `resolveFeed` itself with a
**real-implementation default**. The v3 test additionally now asserts
`expect(mockFetchDefiLlamaPrice).toHaveBeenCalled()`, so its premise is self-verifying and cannot go
vacuous the same way again. The dead `@/lib/chainlink` stub was removed from both files.

## L-2 — a composed feed IS a feed

`noFeedOutput` called `getChainlinkFeed`, which only knows **direct** token/USD entries. Post-ADR-018
a token may resolve **composed**, and Base cbETH is exactly that (no direct cbETH/USD by design — a
cbETH/ETH feed in the USD-keyed map would read ~1.08 as "$1.08"). So cbETH fired the "this token has
no Chainlink price feed" consent modal while `useChainlinkPrice` was pricing it from a verified
cbETH/ETH × ETH/USD pair **that the signing floor was derived from** — the panel warning about a
missing feed and the floor being oracle-derived, simultaneously.

Now routed through `resolveFeed` — the hook's own resolver, so the two cannot disagree. Extracted as
exported `outputHasNoResolvableFeed` for the same reason `evaluateDcaOracleGate` is exported: the
decision is unit-testable at the predicate, not only through the DOM. **The safe direction is not
inverted and is in fact stricter**: `resolveFeed` returns null both when nothing is configured *and*
when a configured leg has no declared `FEED_EXPECTATIONS` identity (fails closed), so an unresolvable
token still reaches the consent modal. No threshold, source, or fallback added.

4 new tests. Both discriminating ones verified red-before / green-after by reverting only the
resolver: `outputHasNoResolvableFeed is false for Base cbETH…` and `so buying cbETH goes straight to
review…`.

## L-1 — the in-handler guard is shadowed, and no single-line mutation can kill it

The audit's diagnosis (jsdom suppresses the click on a disabled button) is real but not the binding
one. The deeper reason is structural: **`handleCreate` opens with `if (!canCreate …) return`
(`DCAPanel.tsx:652`) and `canCreate` (`:649`) already contains `!oracleBlocked`.** Therefore
`oracleBlocked === true` ⟹ `canCreate === false` ⟹ `:652` returns ⟹ **`:668` is never evaluated with
`oracleBlocked` true, in production as well as under test.** The same shadowing applies to its three
siblings (`scheduleFit` `:656`, `minChunkGuard` `:659`, `depegBlocking` `:663`).

The guard is **KEPT**, as instructed. What was fixed is the test, which previously proved less than it
claimed: the forced click reached `handleCreateClick`, whose own `if (!canCreate) return` stopped it —
so it pinned `canCreate`, never the in-handler guard.

The new test drives the **only** caller that reaches `handleCreate` without a `canCreate` check of its
own: `handleNoFeedAccept` (`:786`). The scenario is production-reachable rather than contrived — a
feedless output token opens the consent modal while the spend feed is healthy, the spend feed degrades
mid-session (these reads re-poll), and the user accepts a modal opened under the earlier verdict.
Nothing in the modal tells them the oracle moved. A NON-VACUITY companion proves the same accept path
*does* sign while the oracle stays verified.

Isolating the guard's value, since the plain mutation cannot:

| variant | result |
|---|---|
| `:652` shadow lifted, `:668` kept | 21 passed — the guard alone holds the line |
| `:652` shadow lifted **and** `:668` removed | **RED** — `accepting the consent modal after the spend feed degrades signs nothing` |

So `:668` is demonstrably load-bearing the moment the shadow is not there, and the new test is what
pins it. **This is reported as a gap, not rounded up to a pass.** Closing it properly means changing
the gate topology (`:652` re-checking the aggregate `canCreate` is what makes all four in-handler
guards dead) — out of scope for a two-Low fix, and narrowing `:652` naively would *weaken* it, since
`canCreate` also carries `isConnected` / `isSubmitting` / `paused` / `checkingRoute`, none of which
have their own in-handler guard. Needs an owner decision.

## Mutation proof — four gated consumers, each reverted individually

Suites: `DCAPanel.oracle-fail-closed.test.tsx` + `DCAPanel.v3.test.tsx` (25 tests, all passing intact).

| guard | line | suite when removed | failing test |
|---|---|---|---|
| `canCreate` | `:649` | **RED** (2 failed) | `oracleIntegrityFailed (feed identity mismatch) blocks creation…` + `oracleReadFailed (feed configured but unreadable) blocks creation…` |
| in-handler | `:668` | **GREEN — reported gap** | none — shadowed by `:652`, see above |
| DefiLlama effect | `:481` | **RED** (1 failed) | `THE TRAP — DefiLlama is never consulted after a Chainlink integrity failure` |
| `signingMin` preview | `:508` | **RED** (1 failed) | `and no floor is even PREVIEWED from the APPROX_PRICES tier while the oracle is unverified` |

## Fail-open not laundered back in by the rebase

`expect(mockFetchDefiLlamaPrice).not.toHaveBeenCalled()` is still asserted in THE TRAP, and is
**non-vacuous** two independent ways: the CONTRAST test in the same file drives that exact mock to
`toHaveBeenCalled()`, and reverting only the effect guard turns THE TRAP red (row 3 above) — an
assertion that could not fire would do neither.

## Scope

`ci.yml` still enumerates DCAPanel suites by filename (see the earlier section) — untouched here, and
in the do-not-touch list for this task. Also untouched: `price-gate.ts`, `chainlink.ts`,
`chains/chainlink-feeds.ts`, `price-monitor.ts`. No new thresholds, fallback paths, or oracle sources.
