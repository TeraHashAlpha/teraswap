# Sprint 26 — Activate FeeCollector V2 + Revert Temporary Bypasses (P162–P164)

> **Date:** 2026-05-22
> **Branch:** `activate/fee-collector-v2` (from `main`)
> **Priority:** P0 — revenue resumes (0.1% fee on all compatible sources)
> **Prerequisite:** Router timelocks executed on-chain (~10:42 UTC, 2026-05-22).
>   Uniswap V3 SwapRouter02 + Odos Router V3 whitelisted on FeeCollector V2.
>   **Do NOT execute this sprint before confirming both timelocks are executed.**

---

## Context

Since Sprint 25D (2026-05-20), ALL 11 sources are in `FEE_INCOMPATIBLE_SOURCES`
as a temporary measure while FeeCollector V2 router timelocks were pending.
This means zero fee revenue — every swap bypasses the FeeCollector.

The timelocks execute 2026-05-22 ~10:42 UTC. After execution:
- FeeCollector V2 (`0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459`) has Uniswap V3
  SwapRouter02 and Odos Router V3 whitelisted.
- V2 accepts any router by default (no whitelist restriction like V1), but the
  timelocked routers needed explicit queue+execute.

This sprint:
1. Reverts the 9 temporary entries from `FEE_INCOMPATIBLE_SOURCES`
2. Switches `NEXT_PUBLIC_FEE_COLLECTOR` on Vercel to V2
3. Reverts `itFeeCollectable = it.skip` back to `it` in tests

After this sprint, fee revenue resumes on 9 of 11 sources. Only `0x` and
`cowswap` remain permanently fee-incompatible (structural reasons).

---

## Sprint status table

| # | Prompt | Description | Status |
|---|--------|------------|--------|
| P162 | Revert FEE_INCOMPATIBLE_SOURCES temporaries | Remove 9 temp entries, keep 0x + cowswap | Pending |
| P163 | Revert itFeeCollectable test skip | `it.skip` → `it`, restore 19 tests | Pending |
| P164 | Switch NEXT_PUBLIC_FEE_COLLECTOR to V2 on Vercel | Ops task — env var change on Vercel dashboard | Pending |

---

## P162 — Revert FEE_INCOMPATIBLE_SOURCES temporary entries

**Status:** Pending

**Context:** Sprint 25D (P153) expanded `FEE_INCOMPATIBLE_SOURCES` from 2 permanent
entries to all 11 sources. The 9 temporary entries were added because:
- 4 confirmed-broken: `uniswapv3`, `odos`, `kyberswap`, `velora` (routers not on
  FeeCollector V1 whitelist)
- 5 precautionary: `1inch`, `openocean`, `sushiswap`, `balancer`, `curve` (not
  individually verified against V1 whitelist)

With FeeCollector V2 live (no whitelist restriction), all 9 can be removed.

**Objective:** Remove the 9 temporary entries from `FEE_INCOMPATIBLE_SOURCES`,
keeping only the 2 permanent entries (`0x`, `cowswap`).

**Requirements:**

1. In `src/lib/constants.ts`, change `FEE_INCOMPATIBLE_SOURCES` (~line 167–174) from:

   ```typescript
   export const FEE_INCOMPATIBLE_SOURCES: AggregatorName[] = [
     // Permanent
     '0x', 'cowswap',
     // Temporary — router timelock 2026-05-22
     'uniswapv3', 'odos', 'kyberswap', 'velora',
     // Temporary (precautionary) — revert with the four above
     '1inch', 'openocean', 'sushiswap', 'balancer', 'curve',
   ]
   ```

   To:

   ```typescript
   // Sources incompatible with FeeCollector proxy routing.
   // These sources cannot route through the FeeCollector contract due to
   // structural mismatches in their swap architecture:
   //   - '0x'      Uses Permit2 pull model (not standard ERC-20 approve).
   //   - 'cowswap' Intent-based (EIP-712 signing, no on-chain tx to wrap).
   // All other sources route through FeeCollector V2 for 0.1% fee collection.
   export const FEE_INCOMPATIBLE_SOURCES: AggregatorName[] = [
     '0x', 'cowswap',
   ]
   ```

2. Remove the large comment block above the array (~lines 133–166) that documents
   the temporary entries, the timelock dates, and the side effects. Replace with
   the clean comment in step 1. The temporary context is no longer relevant — it
   served its purpose and the history is preserved in git.

3. Do NOT touch `FEE_NATIVE_SOURCES` (stays empty) or `DISABLED_SOURCES` (stays empty).

**Files affected:**
- `src/lib/constants.ts` — `FEE_INCOMPATIBLE_SOURCES` array and its comment block

**Expected output:** One commit. `FEE_INCOMPATIBLE_SOURCES` contains only `['0x', 'cowswap']`.
The 9 previously bypassed sources now route through FeeCollector V2 for fee collection.

**Quality criteria:**
- Array contains exactly 2 entries: `'0x'`, `'cowswap'`
- Comment block is clean and explains why these 2 are permanent
- `FEE_NATIVE_SOURCES` unchanged (empty)
- `DISABLED_SOURCES` unchanged (empty)
- TypeScript clean (`npx tsc --noEmit`)
- All tests pass (845 total — 19 previously skipped will be re-enabled in P163)

---

## P163 — Revert itFeeCollectable test skip

**Status:** Pending

**Context:** Sprint 25D (P153) changed 19 tests in `src/app/api/v1/swap/route.test.ts`
from `it(...)` to `itFeeCollectable(...)`, where `itFeeCollectable = it.skip`.
This was necessary because all sources were fee-incompatible, making the /v1/swap
endpoint refuse every request — all happy-path tests would fail.

With P162 reverting the temporary entries, 9 sources are now fee-collectable again.
The tests should pass.

**Objective:** Change `itFeeCollectable` from `it.skip` back to `it`, re-enabling
all 19 skipped tests.

**Requirements:**

1. In `src/app/api/v1/swap/route.test.ts`, change line 118:

   ```typescript
   // Before:
   const itFeeCollectable = it.skip

   // After:
   const itFeeCollectable = it
   ```

2. Update the comment block above (lines 112–117) to reflect the current state:

   ```typescript
   // FeeCollector V2 is live with all routers whitelisted. All fee-collectable
   // sources route through FeeCollector. Tests below use `itFeeCollectable`
   // as an alias for `it` — kept as a semantic marker for tests that depend
   // on FeeCollector routing being active.
   const itFeeCollectable = it
   ```

3. Run the full test suite and confirm all 845 tests pass (826 + 19 previously
   skipped = 845, now all running).

**Do NOT:**
- Change any test logic or assertions — only the skip/unskip
- Remove the `itFeeCollectable` alias — it serves as documentation
- Modify any other test files

**Files affected:**
- `src/app/api/v1/swap/route.test.ts` — line 118 + comment block (lines 112–117)

**Expected output:** One commit. All 845 tests run (0 skipped). The 19 previously
skipped tests now execute and pass.

**Quality criteria:**
- 845 tests pass, 0 skipped, 0 failed
- TypeScript clean
- No test logic changes — only the skip marker removed

---

## P164 — Switch NEXT_PUBLIC_FEE_COLLECTOR to V2 on Vercel (ops task)

**Status:** Pending

**Context:** The env var `NEXT_PUBLIC_FEE_COLLECTOR` on Vercel currently points to
FeeCollector V1 (`0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD`). The code in
`constants.ts` has a hard default to V2 (`0x47f24068...`), so if the env var is
empty or unset, V2 is used. However, if the env var is explicitly set to V1,
V1 takes precedence.

**Objective:** Update the Vercel env var to point to FeeCollector V2, or delete
it entirely (the hard default in code handles it).

**Requirements:**

This is a **manual ops task**, NOT a code change.

1. Go to Vercel dashboard → Settings → Environment Variables
2. Find `NEXT_PUBLIC_FEE_COLLECTOR`
3. Either:
   - **Option A (recommended):** Change value to `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` (V2)
   - **Option B:** Delete the env var entirely — code defaults to V2
4. Redeploy production (or wait for the P162+P163 PR merge to trigger deploy)

**Verify after deploy:**
- Open https://teraswap.app
- Do a swap with a non-0x, non-cowswap source (e.g. Velora, KyberSwap)
- Confirm the tx routes through FeeCollector V2 (`0x47f240...`) on Etherscan
- Confirm the 0.1% fee is collected in the FeeCollector V2 contract

---

## Execution order

1. **Confirm timelocks are executed** — check on-chain before starting
2. **P162** — revert FEE_INCOMPATIBLE_SOURCES (code change)
3. **P163** — revert itFeeCollectable (test change)
4. **P164** — switch Vercel env var (ops task)
5. **Open PR, audit, merge** — standard flow
6. **Verify on production** — swap through FeeCollector V2, confirm fee collection

---

## Do NOT

- Do NOT execute before timelocks are confirmed on-chain
- Do NOT change `FEE_NATIVE_SOURCES` — stays empty
- Do NOT change `DISABLED_SOURCES` — stays empty
- Do NOT modify `validateFeeIntegrity` or the `FEE_NATIVE_SOURCES.includes()` guard
- Do NOT touch FeeCollector contract code or ABI
- Do NOT modify any adapter logic
- Do NOT merge without audit pass (0C/0H)

---

## Post-deploy checklist

1. ✅ Timelocks executed on-chain (both Uniswap V3 + Odos routers)
2. ✅ `NEXT_PUBLIC_FEE_COLLECTOR` set to V2 (or deleted) on Vercel
3. ✅ All 845 tests pass (0 skipped)
4. ✅ Production deploy successful
5. ✅ Test swap via Velora — tx goes through FeeCollector V2 on Etherscan
6. ✅ Test swap via KyberSwap — same verification
7. ✅ Test swap via Uniswap V3 Direct — same verification
8. ✅ Fee recipient (`0x107F6eB7C3866c9cEf5860952066e185e9383ABA`) receives 0.1%
9. ✅ 0x and cowswap swaps still work (bypass FeeCollector as expected)
