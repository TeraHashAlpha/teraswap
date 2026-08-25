# Feedback — fix/keeper-env-load-order

## Feedback — KEEPER-ENV-ORDER (6b19093, e155cea)

### Edge case
- chain-verify's boot `contracts` list in `executor.js` `main()` (not in the prompt's
  guard list) also hard-required v2: its unconditional `ORDER_EXECUTOR_ADDRESS (v2)`
  entry would fail boot verification on a v3-only keeper before routing was ever
  reached. Guarded it the same way as `watchedContracts` (commit 2).
- `backfill-execution.mjs` is the directory's second entrypoint (module-scope env
  reads at :21-24) — included in the env.js first-import sweep. `loadEnv` never
  overrides pre-set vars, so its documented "creds from shell env" usage is unchanged.

### Assumption
- "validateConfig ... must throw" was implemented as the pure `checkExecutorAddresses`
  (config-guard.js, signer-guard pattern) + the existing `process.exit(1)` FATAL shape,
  because `executor.js` auto-runs `main()` on import and cannot be imported by a test.

### Test gap
- `event-watcher.js` had zero coverage pre-PR; `env-order.test.mjs` now covers
  `explorerBase` only — the poll/decode/backoff loop is still untested.
