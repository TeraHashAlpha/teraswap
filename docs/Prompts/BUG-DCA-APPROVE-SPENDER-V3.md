# BUG-DCA-APPROVE-SPENDER-V3 — DCA approve targets the v2 executor while the order is signed for v3 (CUTOVER BLOCKER)

> **Source:** v3 Base cutover smoke, 2026-07-20 (owner + Architect live diagnosis). A real v3 DCA order
> (ETHFI→cbBTC, Base) was created and signed for v3 (`order_data.maxSlippageBps` present, keeper resolves
> `executor=v3`), but the keeper skips every cycle with **"Insufficient allowance"**. On-chain proof:
> `ETHFI.allowance(owner → OE_V3 0x686b…60a0) = 0` while `allowance(owner → OE_V2 0x135B…2598) = 100e18` —
> **the approval flow sent the funds approval to the v2 executor while the signature targets v3.**
> Consequence: EVERY new v3 DCA order on Base is unfillable → P1a cutover cannot close until fixed.
> The keeper is CORRECT (it checks the executor the order routes to) — the bug is the frontend approve
> spender resolution. **Fund-flow-adjacent surface (wallet approvals / spender): Auditor pass required on
> the PR (Opus, focused) — PR stays UNMERGED until 0C/0H.** SSH-signed; branch
> `fix/dca-approve-spender-v3` off `origin/main`, dedicated worktree; 3 droppable commits.
> **Exit = push + local suite green + compare link (CI runs when the owner opens the PR).**

## Requirements (per-commit)

### 1. Failing test FIRST
With v3 enabled for 8453 (`NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE` set) the DCA approve flow must
resolve `spender == getOrderExecutorV3(8453)`. Current main resolves the v2 executor → test FAILS on main
(prove in FEEDBACK). Likely home: `src/hooks/useOrderApproval.ts` (+ DCAPanel wiring).

### 2. Root cause + fix — single source of truth
- Identify where the approve spender resolves (v2 map `ORDER_EXECUTOR_BY_CHAIN` vs the v3-aware resolution
  used for SIGNING in DCAPanel/PR #299). State the exact mechanism in FEEDBACK.
- Fix so the approve spender and the signing executor come from ONE shared resolution (the same function
  the signing path uses): when `v3Enabled` → v3 executor; else v2. Divergence must be impossible by
  construction — no second lookup.
- **Spender allowlist (Sprint-40 guard):** verify the v3 executor is accepted by the approval spender
  allowlist via the registry/env (never hardcoded hex); if the allowlist lacks it, extend it from the same
  registry source, with a test.
- Wrong-spender recovery UX: for a user who already approved v2 for a v3 order (the owner's current state),
  the panel's allowance check against the CORRECT spender returns 0 → it must re-prompt approve normally
  (confirm this path works; no special migration code).

### 3. Tests (invariant-grade)
- INVARIANT: for any chain/mode, `approveSpender === signingExecutor` (v2 mode and v3 mode, 8453; mainnet
  unaffected/null). A future executor change that breaks the pairing must fail tests.
- Approve flow resolves v3 when env set, v2 when unset (dark = byte-identical).
- Spender-allowlist accepts the v3 executor (from registry), rejects arbitrary spenders (guard intact).
- Full suite + tsc + eslint green.

## Do NOT
Touch the keeper (it is correct), contracts, routing/quote logic, chains registry values, v2 signing path;
add deps; open a PR; hand-type hex (executor addresses flow from the existing registry/env resolution).

## Files affected (read ONLY these + tests)
`src/hooks/useOrderApproval.ts`, `src/components/DCAPanel.tsx` (wiring only), the spender-allowlist
guard module + its tests, existing order-engine config (`src/lib/order-engine/config.ts` read/extend),
`docs/Prompts/BUG-DCA-APPROVE-SPENDER-V3.md` (commit this spec).

## Expected output
Branch pushed + compare link. FEEDBACK ≤1 screen: the divergent-lookup mechanism (exact line), the unified
resolution, allowlist status, test names. **Flag for a focused Auditor pass (fund-flow surface) — the owner
merges only after 0C/0H.**

## Quality criteria
Failing-test-first; spender/signing single-source by construction; allowlist intact + covering v3; dark
state byte-identical; keeper untouched.
