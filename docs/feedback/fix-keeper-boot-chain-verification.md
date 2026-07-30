# Feedback — fix/keeper-boot-chain-verification

### The Auditor found a production fail-open, not just a bad test
The gate's timeout timer was `.unref()`'d. The gate runs before the health server, the monitor and
the poll interval exist, so when an RPC accepts the connection then goes silent it is the ONLY thing
on the event loop: Node drains it and the process dies with a bare "unsettled top-level await" —
exit without ever printing the refusal. Reproduced in isolation (exit 13, no output). Fixed by
ref'ing the timer; pinned by a subprocess test that runs the gate with nothing else alive, because
no in-process test can catch it (the runner's own handle masks it). My "376/0/0" was real for Node
25.6.1 and worthless as evidence — the suite's completion depended on the runner, not the code.

### Identity method — verified on-chain for v2, NOT for v3
`ORDER_TYPEHASH()` (v2 `TeraSwapOrderExecutor.sol:107`, v3 `…V3.sol:120`). Both live v2 deployments
(mainnet `0xeFC3…f130`, Base `0x135B…2598`) return `0x4c8bd2ee…f11c9be5`, matching the source-derived
pin. **No live v3 address exists in this repo (env-only), so the v3 pin
`0xfc939b74…7204cbc0` is source-derived only.** If a deployed v3 predates the current source, that
keeper now refuses to boot. Ops must read `ORDER_TYPEHASH()` off the deployed v3 and confirm before
the next Base keeper restart.

### What a per-chain address table in the keeper would require (not done, per constraint)
1. A committed `ORDER_EXECUTOR_BY_CHAIN` mirroring `src/lib/order-engine/config.ts` plus a drift
   test pinning the two, and a precedence rule when the env var disagrees (fail-closed is the only
   safe answer).
2. An ops migration: `ORDER_EXECUTOR_ADDRESS` stops being the source of truth for every existing
   deployment (pm2 units, `.env.executor`, runbooks), and a chain with no entry must refuse rather
   than fall back to the env — i.e. it changes the ops config contract, not just code.

### Test-surface facts
`node --test` auto-discovers `*.test.mjs`, so this file joins `keeper-tests` CI with no workflow
edit. The keeper suite is NOT part of `npx vitest run` — separate runner, separate job; a green
vitest number says nothing about these 80 tests.

### Could not reproduce the 2 pre-existing failures
389/0/0 exit 0 here, both with root-hoisted viem 2.55.2 and after `npm ci` in
`contracts/order-engine/executor` (viem 2.47.10, the CI config). Left untouched as instructed;
the Auditor's environment differs in something I cannot see from here.

### Defects my own tests found in my error paths
`JSON.stringify` throws on a BigInt (a malformed `ORDER_TYPEHASH` of `1n` turned a refusal into a
`TypeError`), and `errText` leaked the keyed RPC URL for any non-viem error. Both fixed
(`describeValue`, `redactUrls`).
