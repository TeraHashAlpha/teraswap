# Feedback — fix/keeper-alert-cooldown-and-dca-debug-read

Per-PR feedback (CLAUDE.md § Code Agent Feedback Convention). Append-only within this PR.

## Feedback — T1 (f723c51)

### Edge case
- `LOW_GAS_USD_THRESHOLD` was not in `.env.executor.example` at all (only the `ETH_USD_FEED` comment
  mentioned "< $5"), so "document beside LOW_GAS_USD_THRESHOLD" had nothing to sit beside. Both
  variables are now documented in the `[DCA-OBS]` block.
- The call site used to compare the raw USD number and display `toFixed(2)`. To keep that exact
  boundary (4.996 is a breach even though it renders as "$5.00"), the raw number is passed and the
  alerter formats it; a pre-formatted string (legacy callers/tests) is rendered verbatim. The rule is
  strictly-below: exactly `$5.00` on a `$5` threshold is not a breach (pinned by test).
- `LOW_GAS_ALERT_COOLDOWN_MS=0` is honoured as "no cooldown" (every breach sends — the pre-fix
  behaviour); blank / non-numeric / negative / fractional fall back to the 1 h default.

### Concern
- `alertLowGas` now returns `null` when nothing was sent. The only in-repo caller (executor.js)
  ignores the return value; anything external that awaited a string body should expect `string|null`.

## Feedback — T2 (1a2e4ff)

### Test gap
- `chainlink-debug-read.test.mjs` executes the REAL block sliced from executor.js (AsyncFunction over
  its free identifiers: `publicClient, orderStruct, PRICE_FEED_ABI, log, zeroAddress`). A future free
  identifier added to that block fails the test with a ReferenceError — add it to the parameter list.

## Feedback — verification (this branch)

### Assumption that turned out wrong
- `contracts/order-engine/executor/package.json` has no `test` script, so `npm test` there is not a
  thing; the keeper suite is `node --test` in that directory (exactly what `keeper-tests.yml` runs).
- The 3 `boot-identity` tests that spawn the real executor need the keeper's OWN deps
  (`npm ci --ignore-scripts` in the executor dir): with only the root `node_modules` they fail with
  `ERR_MODULE_NOT_FOUND: @aws-sdk/client-kms` — an environment gap, pre-existing on origin/main, green
  once installed (563/563 before this branch, 581/581 after).
- The root vitest suite does not read `alert.js` / `executor.js` (only `retry-policy.js` and
  `swap-route.js` drift tests), and root eslint ignores `contracts/**`, so the lint baseline measured
  on origin/main (0 errors / 94 warnings) is unchanged by construction.
- `keeper-tests.yml`'s comments still quote historical test counts (18 / 25); left as-is — out of scope.
