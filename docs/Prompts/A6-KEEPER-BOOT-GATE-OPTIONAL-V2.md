# A6-KEEPER-BOOT-GATE-OPTIONAL-V2 — boot gate must not require a v2 executor

> Architect spec, committed with the implementation branch
> `fix/keeper-boot-gate-optional-v2` (off `origin/main`, dedicated worktree, no PR —
> compare link reported). Deliberately separate from the env load-order fix
> (`fix/keeper-env-load-order`): relaxing a gate and refactoring boot must not share
> a diff.

## Context

`contracts/order-engine/executor/executor.js` calls `verifyChainBinding()` at the top
of `main()` as a boot gate. The v2 entry in its `contracts` array was UNCONDITIONAL
while the v3 entry is a conditional spread on `V3_CONTRACT_ADDRESS`. TeraSwap is
deploying the keeper to Arbitrum (chain 42161), where there is NO v2 OrderExecutor —
only v3. With the gate as written, an Arbitrum keeper must either set a bogus
`ORDER_EXECUTOR_ADDRESS` or fail to boot forever. Hard blocker for the Arbitrum
bring-up.

## Requirements (one commit each)

1. Make the v2 entry conditional, exactly mirroring the v3 spread. The gate must
   remain fail-closed for whichever addresses ARE configured — present-but-wrong,
   unreachable, or wrong-`ORDER_TYPEHASH` addresses still exit non-zero. Do not
   weaken any check inside `chain-verify.js`.
2. Refuse to boot when NEITHER address is configured: explicit error naming both
   variables, `process.exit(1)` BEFORE any RPC call, as a distinct named failure.
3. Sweep `executor.js` for every site treating `ORDER_EXECUTOR_ADDRESS` as mandatory
   (starting with `validateConfig`) and make each optional under one rule: required
   only if `ORDER_EXECUTOR_V3_ADDRESS` is absent. List the changed call sites in
   FEEDBACK.
4. Tests, extending the existing files (no parallel suite): v3-only boots the gate
   with one contract entry; v2-only unchanged; both → two entries; neither →
   non-zero exit with the named error. Behaviour, not log strings alone.

## Do NOT

- Touch `loadEnv()` / `process.cwd()` / import ordering (separate PR by design).
- Edit `.env.executor`, `.env.executor.example`, `ecosystem.config.cjs`, or any
  Arbitrum config.
- Change `chain-verify.js` logic (read-only).
- Touch the v3-unset `submission-blocked` path around `executor.js:1251`.
- Run `npm audit fix`; bypass npm min-release-age; run `ssh-add`; create a PR.

## Quality criteria

This is a boot gate on a keeper that signs and pays gas. The guarded failure mode is
a keeper that boots against the wrong chain because presence was mistaken for
identity. Every relaxation must be justified by an address being ABSENT, never by a
check being inconvenient.

## Implementation record

- Req 1 `af86717`: v2 gate entry → conditional spread on `CONTRACT_ADDRESS`,
  byte-level mirror of the v3 spread. `chain-verify.js` untouched.
- Req 2 `ebcf36f`: contracts array hoisted to `gateContracts`; empty ⇒
  `console.error` naming `ORDER_EXECUTOR_ADDRESS` + `ORDER_EXECUTOR_V3_ADDRESS` and
  `process.exit(1)`, before `verifyChainBinding` and thus before any RPC.
- Req 3 `0165c11`: `validateConfig` (v2 out of the required map + explicit
  neither-check naming both vars), routing input guard (v2 order on a v3-only keeper
  ⇒ skip + flag, never the v3 address), banner "not configured" line, conditional
  `watchedContracts` entry, header doc.
- Req 4 `1f6ab0b`: `bootExecutor` harness parameterized (v2/v3 env, per-address
  identity answers, per-call target capture); five behavioural cases including the
  fail-closed-survived proof (v3-only + wrong identity still refuses).
