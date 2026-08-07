# Feedback — fix/keeper-boot-gate-optional-v2

## Feedback — A6-KEEPER-BOOT-GATE-OPTIONAL-V2 (af86717…1f6ab0b)

### Req. 3 — changed call sites (grep-verified; pre-change line numbers)
- `executor.js:325` — `validateConfig`: v2 removed from the hard-required map; explicit
  neither-configured FATAL naming both variables.
- `executor.js:1260` — routing input `v2Address: CONTRACT_ADDRESS`: new skip+flag block for a
  v2 order on a v3-only keeper (the v3-unset `submission-blocked` block itself is untouched).
- `executor.js:2041` — startup banner: `Contract (v2):` now prints "not configured", v3 style.
- `executor.js:2075` — `watchedContracts`: v2 entry only pushed when the address exists.
- (doc only) `executor.js:35` — header REQUIRED ENV VARS states the at-least-one rule.
- NOT changed: `:196` (definition) and the gate entry (that is req. 1, commit af86717).

### "Neither configured" exit
Exits in `validateConfig` — FATAL naming both variables, `process.exit(1)`, zero RPC calls
(pinned by the test asserting the RPC double saw nothing); the `gateContracts.length === 0`
check in `main()` (req. 2) remains as an independent backstop should validateConfig drift.

### Concern — overlap with fix/keeper-env-load-order
Commit `e155cea` on that branch implements the same v2-optional scope differently (a
`config-guard.js` module + a guard inside `executor-routing.js`, incl. a v2≡v3 equality
check this branch does not add). Merging both as-is conflicts in `executor.js`. That commit
was built droppable for exactly this separation — recommend dropping `e155cea` there and
letting A6 own this scope; its v2≡v3 must-differ check is worth re-adding here later.
