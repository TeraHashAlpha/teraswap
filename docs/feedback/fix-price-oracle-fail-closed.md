# Feedback — FIX-PRICE-ORACLE-FAIL-CLOSED

## The requirement as written would have made sub-$10k swaps WEAKER, not stronger

Requirement 2 says UNAVAILABLE "must surface as `oracleUnavailable:true` so both gates engage". Taken
literally and alone, that is a downgrade — and the trap is worth recording:

`evaluatePriceGate` tested `oracleUnavailable` **before** `oracleIntegrityFailed` and returned `'ok'`
for it (deliberately: a no-feed token defers to the tiered USD gate rather than being double-blocked).
So setting only `oracleUnavailable` on a read failure yields `mode:'ok'` → the deviation gate does
**not** fire → only the tiered gate remains → a $50 swap on an unreadable oracle sails through. Today
that same swap is *also* unblocked, so it would not be a regression — but it would be a fix that does
not fix, while reading as though it did.

Implemented instead: UNREADABLE sets **three** flags — `oracleUnavailable` (tiered USD gate),
`oracleIntegrityFailed` (deviation gate, HARD block at every trade size), `oracleReadFailed` (new,
purely to keep copy honest) — and `evaluatePriceGate` is reordered to test integrity first. That
reorder is a no-op for the pre-existing no-feed case, which never sets `oracleIntegrityFailed`.

## Two supporting files had to change or the fix would not have held

Neither is scope creep; without them "both gates engage" is simply false:

- **`price-gate.ts`** — the ordering above.
- **`chainlink.ts` `evaluatePairOracle`** — its missing-feed branch **hardcoded
  `oracleIntegrityFailed: false`**, which would have discarded an unreadable leg's hard-block signal
  the moment it reached the pair verdict, reopening the hole one layer up. It also pushed every
  `oracleUnavailable` leg into `oracleMissingSymbols`, which drives copy naming the token as having
  "no Chainlink oracle" — false during an outage.

## Deliberate refinement: disconnected ≠ unverifiable

Requirement 3 says chain-undefined → UNAVAILABLE. Applied literally that makes **every disconnected
visitor** land on a red "Swap blocked — oracle data unsafe" banner, since `useResolvedChainId()` is
undefined when no wallet is connected. Followed the merged `useDepegCheck` precedent instead:
connected-but-unresolved → UNREADABLE (blocking); disconnected → neutral. There is no swap to guard
and no chain to guard it on.

## Defects found by pre-commit adversarial review and fixed

A 4-lens review with 2 independent verifiers per finding was run against the working tree. The
important one was a **regression I introduced**:

**OB-1 — a transient refetch blip would have hard-blocked the entire app.** I placed
`if (round.isError || dec.isError) → UNREADABLE` *before* inspecting the data. TanStack **retains the
last successful `data` when a refetch errors** (`query.js:315-324` — the `error` reducer leaves `data`
untouched), and the `refetchInterval: 30_000` I added makes that state routinely reachable: any RPC
blip surviving 3 retries flips `status` to `error` while a fresh, in-heartbeat round sits in cache.
Verified end-to-end by a verifier driving a real `QueryObserver`: `{status:'error', isError:true,
hasData:true, dataAgeSec:0}` → hard block at every trade size. Worse, `decimals()` is immutable and
still re-polled, so an error on it alone blocked on a value we already hold and that can never change.

Fixed by keying the gate on **"do we have a usable round?"** rather than "did the last fetch error?".
Retained data is judged by the pre-existing per-feed staleness ceiling, which is self-correcting: if
the outage outlives heartbeat×1.5 the round ages out and the integrity branch blocks anyway. Both
directions are now pinned (`[OB-1]` tests: fresh cached round → passes; stale cached round → blocks).

Also fixed from the review: the integrity banner painted on an **empty form** — and permanently for a
wallet on an unsupported chain, where the chain never resolves (`SwapBox.tsx:864`, now gated on
`hasAmount && meta` like every sibling banner; the *block* is unaffected, only the banner paint); and
the `QuoteBreakdown` **Rate tooltip** still asserted "No Chainlink oracle for X" during a read failure.

## Per-consumer behaviour

| Consumer | Effect of UNREADABLE |
|---|---|
| `evaluatePriceGate` (deviation gate) | `mode:'block'`, reason `oracle-integrity` — **hard block, every trade size**, no click-through |
| SwapBox tiered >$10k gate (`oracleBlocked`) | engages via `oracleUnavailable` (redundant here — the deviation gate already blocks at all sizes) |
| SwapBox `anyBlocked` → `handleSwap` / `handleApproveAndSwap` | both early-return; button disabled |
| SwapBox integrity banner | renders the honest "oracle data unsafe" copy carrying the hook's own message; now gated on a live quote |
| SwapBox no-feed banner | suppressed (`!priceGateBlocked`), so the false "this token has no Chainlink price feed" never shows |
| `QuoteBreakdown` notice + Rate tooltip | dedicated "could not be read" copy via `oracleReadFailed` |
| `evaluatePairOracle` | propagates integrity + readFailed; excludes read-failed legs from `oracleMissingSymbols` |
| `estimateSwapUsd` | `chainlinkPrice` is null → may set `valueUnverifiable`; correct, and moot given the hard block |
| `DCAPanel` (reads `.chainlinkPrice` only) | unchanged — null during an outage, exactly as when a feed is missing; no new block on order creation |

**Staleness source:** unchanged and still `getFeedStalenessSec` (`chains/chainlink-feeds.ts:138`),
shared with the raw gate and `useDepegCheck`. No new threshold introduced.

## Existing tests whose expectations changed (none deleted)

- `src/hooks/useChainlinkPrice.test.ts` — the wagmi mock now returns the full observer shape and
  provides `useAccount`; `./useChainId` mock switched `useActiveChainId` → `useResolvedChainId`. All
  15 pre-existing cases kept and still pass unmodified.
- Two cases I had *added earlier in this same change* were corrected once OB-1 surfaced (they pinned
  the over-blocking policy): the decimals-error case now uses `errored(undefined)` (no cached value),
  and the read-error case is retitled "with NO usable round". No pre-existing test was weakened.

**Mutation-verified (5/5):** removing the fail-closed fallback → 7 fail; dropping the dual-signal
memory → 3; reverting the `evaluatePriceGate` order → 1; re-hardcoding `oracleIntegrityFailed:false`
→ 1; making a no-feed token integrity-fail (Invariant A) → 1.

## Left open, deliberately

- **`SwapButton` blockReason** reuses `'oracle-stale'`, so the *button* reads "Oracle data unsafe"
  during a read failure. Defensible (the price genuinely is unverified) and the banner beside it
  carries the precise reason; adding a variant means touching `SwapButton`, out of scope here.
- **A no-feed leg paired with an integrity-failed leg now hard-blocks** where it previously did not
  (`evaluatePairOracle` no longer discards the signal). Rated INFO by both verifiers and arguably a
  correctness improvement — a broken oracle on either side should block — but it is a behaviour
  change beyond the literal brief, so it is flagged rather than buried.
