# FIX-P1B-M01-KEEPER-LIVENESS — route the executor's own InsufficientOutput through the pinned-route-revert handler

> **Source:** AUDIT-P1B-LIMIT-TP-V3 §14, finding M-01 (MEDIUM, non-blocking, recommended before the
> P1b go-live smoke). **This fix gates flipping `NEXT_PUBLIC_LIMIT_ENABLED`.**

## Bug
For a triggered non-DCA v3 order, the *common* dislocation revert at trigger is the executor's own
`InsufficientOutput()` (router call succeeds; output lands below `max(oracleFloor, minAmountOut)`)
— not a router `SwapFailed`. `executor.js`'s pinned-route-revert handler (~:1730) gated on
`swapReason` truthiness alone, which is only ever set by `decodeSwapFailed` (a `SwapFailed(bytes)`
unwrap). `InsufficientOutput` never wraps as `SwapFailed`, so it fell through to
`handleExecutionFailure` and was marked `failed`/`no_route_after_retries` after
`MAX_CYCLE_FAILURES` cycles — defeating the sprint's own liveness invariant (stay-active-until-
expiry) in the common case, not an edge case.

## Fix
- `revert-decode.js`: `decodeExecutorMarketRevert(data)` — matches the executor's own no-arg
  custom-error selectors `InsufficientOutput()` (`0xbb2875c3`) and `PriceConditionNotMet()`
  (`0x3bef7afd`, reachable if the price crosses back between `canExecute`'s pre-check and the tx
  landing). Deliberately excludes every permanent-cause executor error (`OrderExpired`,
  `RouterNotWhitelisted`, `InsufficientBalance`/`Allowance`, `InvalidNonce`,
  `RouterDataMismatch`/`Required`, `OrderCancelledError`) — those keep falling through to the
  existing failure-ladder classification unchanged.
- `pinned-route.js`: `isMarketRevert({ swapReason, executorErrorName })` — true for a `SwapFailed`
  reason OR one of the two market executor errors above; false otherwise. This is the single
  predicate `executor.js` now branches the pinned-route handler on, replacing bare
  `swapReason` truthiness.
- `executor.js`: the catch block now also runs `decodeExecutorMarketRevert` (only when
  `decodeSwapFailed` misses) and branches on `isMarketRevert(...)` instead of `swapReason`. No
  change to the DCA path, the retry ladder, gas tiers, or Phase-0 submission policy.

## Do NOT
Touch the contract, signing, calldata, the API, or DCA execution logic; change fund flow.

## Tests
`revert-decode.test.mjs` (+8): selector constants, decode InsufficientOutput/PriceConditionNotMet,
case-insensitivity, null for `SwapFailed`'s own selector, null for a permanent-cause error, null for
non-hex/absent/unrelated data. `pinned-route.test.mjs` (+6): `isMarketRevert` true for SwapFailed
and both market executor errors, false for every permanent-cause name, false when nothing decoded,
swapReason takes precedence. Full keeper suite (`node --test`) green: 214/214.
