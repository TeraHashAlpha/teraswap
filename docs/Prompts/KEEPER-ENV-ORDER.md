# KEEPER-ENV-ORDER — two startup-ordering defects in the self-hosted keeper

> Architect spec, committed with the implementation PR (branch `fix/keeper-env-load-order`).
> One PR, two droppable commits. Branch off `origin/main` in a dedicated worktree.

## Context

Measured in production (keeper on Base, `CHAIN_ID=8453`): `executor.js` loads env by
hand — `loadEnv(join(process.cwd(), ".env.executor"))` in the module body (~line 170),
after the import block. Any first-party module that reads `process.env` at module top
level is therefore evaluated BEFORE `loadEnv` runs and silently keeps its default.
Proof inside a single file: `alert.js:14` `const CHAIN_ID = process.env.CHAIN_ID || "1"`
produced `"1"` on a keeper whose CHAIN_ID is 8453, while `alert.js:55-56` (same file,
read inside `sendTelegramAlert`) produced the correct values in the same process. Live
Telegram alerts are stamped `Chain: 1`. A second keeper (Arbitrum, 42161) lands on the
same host this week, so a wrong Chain label makes the two indistinguishable.

## Objective

Fix both defects in one PR with two independently droppable commits.

## Requirements

### Commit 1 — deterministic env load order

1. New module `executor/env.js`: its module body performs the `.env.executor` load from
   `process.cwd()`. Move the existing `loadEnv` function there; keep the current
   `"WARNING: Could not load ..."` `console.warn` on failure. Export nothing that
   callers must call.
2. Make the import of `./env.js` the FIRST import statement in `executor.js` and in
   every other entrypoint in that directory. Remove the `loadEnv` call from
   `executor.js`'s body.
3. Sweep first-party module-level `process.env` reads and make each one correct:
   `alert.js:14` and `event-watcher.js:54` (both `CHAIN_ID || "1"`),
   `retry-policy.js:36/44/48`, `deviation-guard.js:49/57`. Either they now resolve via
   step 2, or convert them to lazy reads. Reads already inside functions
   (`kms-signer.js`, `order-floor.js`, `gas-tier.js`, `monitor.js:200`) must keep working.
4. `event-watcher.js:56-58` selects `ETHERSCAN_BASE` from CHAIN_ID and only knows
   `"1"`/`"11155111"`. Add 8453 (basescan.org) and 42161 (arbiscan.io); an unknown
   chain must not silently fall back to etherscan.io.
5. Do not rename or reformat any variable in `.env.executor`.

### Commit 2 — ORDER_EXECUTOR_ADDRESS optional when V3 is configured

6. `validateConfig()` must require AT LEAST ONE of `ORDER_EXECUTOR_ADDRESS` /
   `ORDER_EXECUTOR_V3_ADDRESS` and fail closed with a clear message when both are
   absent. Today the v2 address is mandatory, which blocks a chain that only has v3
   deployed.
7. Guard the v2 paths on `CONTRACT_ADDRESS` being non-empty: the routing decision's
   `v2Address` (~`executor.js:1242`) and the `watchedContracts` entry
   (~`executor.js:2009`). `v2Address` must NEVER equal `v3Address` — that equality
   defeats the anti-mis-routing guard at `executor-routing.js:37`.
8. Startup banner prints "not configured" for whichever address is absent, same style
   as the existing v3 line.

### Tests (required, both commits)

- A module that reads CHAIN_ID at module scope sees the `.env.executor` value, not `"1"`.
- validateConfig: only-v2, only-v3, neither (must throw), both.
- Routing with `CONTRACT_ADDRESS` empty: v3 orders execute, v2 orders are skipped and
  flagged, never mis-routed.

## Do NOT

- Touch retry-policy's cap/quarantine behaviour, `alert.js`'s missing `res.ok` check,
  or the `FLASHBOTS_RPC` vs `FLASHBOTS_RPC_URL` name mismatch — all three are a
  separate PR.
- Change signer, KMS, or gas-tier logic. Never `ALLOW_PLAINTEXT_KEY`. No secrets in
  code or tests.

## Files affected

`contracts/order-engine/executor/{env.js (new), executor.js, alert.js,
event-watcher.js, retry-policy.js, deviation-guard.js, backfill-execution.mjs,
executor-routing.js, config-guard.js (new)}` + tests in the same directory.

## Expected output

SSH-signed commits, dedicated worktree, `git push -u origin <branch>` (no PR opened —
compare link reported), spec committed as `docs/Prompts/KEEPER-ENV-ORDER.md` in the
same PR. FEEDBACK ≤ 1 screen.

## Quality criteria

- Full executor suite green (`node --test` in the executor directory).
- Each fix commit droppable on its own.
- No CI polling: push + report, don't watch.

## Implementation record

- Commit 1: `6b19093` — env.js first-import contract, lazy alert/event-watcher reads,
  explorer map (1/11155111/8453/42161, unknown ⇒ raw hash), `env-order.test.mjs`.
- Commit 2: `e155cea` — `config-guard.js` (at-least-one + must-differ),
  symmetric v2 routing guard, v2-gated chain-verify/watcher/banner,
  `config-guard.test.mjs` + routing matrix additions.
