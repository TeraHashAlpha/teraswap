# Feedback — fix/keeper-retry-cap-survives-restart

Closes the part of INC-2026-08-07-001 that was never asked: order `ef85438b` reverted 516 times
against a structurally unattainable signed minimum while `MAX_CYCLE_FAILURES` (default 8) was
supposed to stop it at eight. The pricing CAUSE was fixed on `fix/signing-min-price-integrity`;
this branch fixes the BOUND. Line numbers below are `origin/main` @ `c26ccdf` before this change.

---

## Task 1 — diagnosis (before any change)

### Q1. Does a repeated on-chain minimum-output revert on a DCA chunk reach `handleExecutionFailure` and increment `orderRetries`?

**Yes.** Traced path, quoting the code:

1. `executor.js:1672` — `txWalletClient.writeContract({ ... functionName: "executeOrder", ... })` is
   called **without a `gas` field**, so viem runs `eth_estimateGas` first. The contract's per-chunk
   floor check reverts there — `TeraSwapOrderExecutorV3.sol:526` `scaledMin = (order.minAmountOut *
   executeAmount) / order.amountIn`, `:541` `floorOut = scaledMin` (max with the oracle floor), `:610`
   `revert InsufficientOutput()`. That is why the incident saw "every attempt died in simulation, nonce
   stayed at 14": the throw happens before any tx is signed.
2. The throw lands in the `catch (err)` at `executor.js:1785`. `extractRevertData(err)` →
   `decodeSwapFailed(revertData)` returns **null** (the revert is the executor's own error, not
   `SwapFailed(bytes)` — the router call succeeded; the post-swap floor check failed) →
   `decodeExecutorMarketRevert(revertData)` matches selector `0xbb2875c3` → `executorErrorName =
   "InsufficientOutput"`, `swapReason = null` (`:1798-1812`).
3. `executor.js:1832`:
   ```js
   if (dbOrder.order_type !== "dca" && isMarketRevert({ swapReason, executorErrorName })) {
   ```
   For a DCA row the first operand is `false`, so the **pinned-route branch is skipped by
   construction** — `pinnedRouteReverts` (`:279`) is never touched for DCA. The other two non-counting
   paths cannot be reached either: the gas-price defer (`:1630`, `if (!gasTier.execute)`) and the
   oracle-floor delay-not-drain (`:1497`) both sit **before** `writeContract` and compare the *built
   quote* against gas tiers / the reference price — the built quote was at market (~1.2e15), so both
   gates passed; neither inspects the *signed* `minAmountOut`, and nothing in the keeper pre-checks
   the signed floor (`minAmountOut` appears only in the ABI and in the struct build at `:1298`).
4. `executor.js:1864` — `await handleExecutionFailure(dbOrder, { err, swapReason }, obsCtx)`.
   Note `executorErrorName` is **not** passed — the handler cannot tell a floor revert from any other
   transient miss.
5. `executor.js:625-634` — `const prev = orderRetries.get(dbOrder.id)` → `planFailureHandling({ ...,
   prevFailures: prev ? prev.count : 0 })`. In `retry-policy.js:232-238`, `classifyFailure` sees the
   text `insufficientoutput()` which matches **none** of `PERMANENT_SIGNATURES` (`:57-82`) → transient
   → `failures = prevFailures + 1` → `nextRetryDecision` (`:138-146`) → `retry` while `failures < 8`,
   `fail` with `no_route_after_retries` + one-shot alert at 8.
6. `executor.js:660` — `orderRetries.set(dbOrder.id, { count: plan.failures, lastAttempt: Date.now() })`.

So the counter **is** incremented on every one of these reverts. The path is the ordinary failure
ladder. The cap was reached — the incident (§1) confirms the order left the active set "via the
retry-cap fail path" — it was just reached far too late.

### Q2. `orderRetries` is an in-memory `Map` (`:275`). With 228 restarts, what happens to the count?

`executor.js:275` — `const orderRetries = new Map()` — module scope, process memory only; the
comment at `:273-274` even says so: *"In-memory only (resets on keeper restart — see FEEDBACK)"*.
Nothing about the count is persisted: the transient-miss patch is `retry-policy.js:176-178`
`buildOrderActivePatch` → `{ status: "active", updated_at }`; the row never learns how many times it
missed. On every restart, therefore:

- `orderRetries.get(id)` is `undefined` → `prevFailures: 0` → the next miss is counted as **1/8**.
- The backoff gate at `:1210-1212` also reads only this Map → no `retryState` → the order is attempted
  on the **first poll after boot** with no backoff, and the backoff ladder restarts at 30 s.

Quantified: the effective cap is `min(8, attempts in one process lifetime)`. Reaching 8 in one
lifetime needs the full backoff ladder — attempts at t=0 and after 30 s, 60 s, 120 s, 240 s, 480 s,
960 s, 1800 s (`backoffMs`, `retry-policy.js:154-158`), i.e. the 8th attempt lands at
**≥ 3690 s ≈ 61.5 min** of uninterrupted uptime (a little more, since each wake is rounded up to the
30 s poll). 516 reverts across 228 restarts is a mean of **2.26 attempts per lifetime**; any lifetime
shorter than ~62 min could never trip the cap. The order only failed when one process finally stayed
up long enough to count to 8 on its own. Had the count survived restarts, the order would have
stopped after attempt 8: **508 of the 516 reverts (98.4 %) were the counter being reset**, not the
cap being too high.

### Verdict

The reverts DO reach the counter → persisting the counter **is** the right fix. The pinned-route
exemption at `:277` was not involved (DCA is excluded from it at `:1832`), so it is left intact and
no separate bound is added there — see Task 2 below for what was bounded and why.
