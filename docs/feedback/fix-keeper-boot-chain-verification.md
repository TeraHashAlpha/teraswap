# Feedback — fix/keeper-boot-chain-verification

### Identity method — it exists, and it was verified live
`ORDER_TYPEHASH()` (bytes32 public constant, v2 `TeraSwapOrderExecutor.sol:107`, v3
`TeraSwapOrderExecutorV3.sol:120`). Nothing invented. Read on-chain during implementation: BOTH live
v2 deployments — mainnet `0xeFC3…f130` and Base `0x135B…2598` — return
`0x4c8bd2ee…f11c9be5`, exactly the source-derived expectation now pinned in `chain-verify.test.mjs`.
It is the right identity read because its pre-image is the SAME field list the keeper's
`ORDER_EXECUTOR_ABI` tuple encodes: a disagreement means the keeper's calldata is already malformed
for that contract, so the gate can never be over-strict against a correctly-configured keeper.

### Scope taken slightly wider than the prompt — flagging it
The prompt scoped checks to `ORDER_EXECUTOR_ADDRESS`. `ORDER_EXECUTOR_V3_ADDRESS` receives the
identical treatment when set, because the keeper submits fund-moving calldata to it too and the hole
is the same. Residual risk: **no live v3 address exists in this repo (env-only), so the v3 expectation
was derived from the audited source and NOT re-read on-chain like v2's.** If any deployed v3 predates
the current source, that keeper will refuse to boot. Ops should read `ORDER_TYPEHASH()` off the
deployed v3 and confirm it equals `0xfc939b74…7204cbc0` before the next Base keeper restart.

### What a per-chain address table in the keeper would require (not done, per constraint)
1. A committed `ORDER_EXECUTOR_BY_CHAIN` in the keeper mirroring `src/lib/order-engine/config.ts`,
   plus a drift test pinning the two — and a decision on precedence when the env var disagrees
   with the table (fail-closed on disagreement is the only safe answer).
2. An ops migration: `ORDER_EXECUTOR_ADDRESS` stops being the source of truth for every existing
   deployment (pm2 units, `.env.executor`, runbooks), and a chain with no table entry must refuse to
   boot rather than fall back to the env — i.e. it changes the ops config contract, not just code.

### Test gap found while working
`node --test` auto-discovers `*.test.mjs`, so `chain-verify.test.mjs` joins the `keeper-tests` CI job
with no workflow edit. But the keeper suite is NOT part of `npx vitest run` — it is a separate runner
and a separate job, so a green vitest number says nothing about these 67 tests.

### Defect the tests found in my own error path
`JSON.stringify` throws on a BigInt, so a malformed `ORDER_TYPEHASH` of `1n` turned the refusal into
a `TypeError` from inside the code whose job is to refuse clearly. Fixed with `describeValue()`.
