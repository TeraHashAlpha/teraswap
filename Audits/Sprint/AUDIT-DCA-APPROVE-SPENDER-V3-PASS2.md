# AUDIT — BUG-DCA-APPROVE-SPENDER-V3 (Pass 2) — PR `fix/dca-approve-spender-v3`

**Date:** 2026-07-21 · **Auditor:** independent Auditor (read-only) · **Type:** single-PR gate, fund-flow-adjacent (wallet ERC-20 approvals for the order engine)
**Verdict: APPROVE-TO-MERGE — 0C / 0H / 0M / 0L (3 INFO).** Merge authorized.

Prior pass (2026-07-20, `Audits/Sprint/AUDIT-DCA-APPROVE-SPENDER-V3.md`): CANNOT APPROVE — branch was empty. This pass supersedes it: the implementation now exists and is audited below.

---

## 1. Audited refs & signatures

| Ref | SHA | Signature |
|---|---|---|
| `origin/fix/dca-approve-spender-v3` (tip) | `4a4efed4352fa6ed97079084f09f899d815392d8` (merge of main) | SSH ✓ |
| Fix commit | `630af32eed248fff7e83fbcd52d31267a43fa387` | SSH ✓ |
| Failing-test commit | `09fee45d4c9f5b556e2d1de981148ab08a933ef7` | SSH ✓ |
| `origin/main` (merge-base = tip of main) | `8e7af6f7f87491e05e15d4a56f8b88c936ee21d9` | — |

Merge-base of the branch and `origin/main` **is** `8e7af6f` (main's tip), so the effective PR diff is exactly the two authored commits + a content-clean merge. `git diff 8e7af6f..4a4efed` = **7 files, 232 insertions, 8 deletions** — identical to the three-dot diff; the merge-from-main commit brings **nothing** extra into the audited surface.

**Grounding caveat (I-03):** the audit sandbox cannot reach GitHub (`git fetch` → proxy 403); refs audited are the owner's locally-fetched `origin/*` (fetched 2026-07-21, tips as above). **Owner must confirm the GitHub PR head = `4a4efed` before merging.**

## 2. Scope read (only the listed files)

PR diff; `src/hooks/useOrderApproval.ts` (+ `useOrderApproval.v3.test.ts`, `useOrderApproval.test.ts`); `src/lib/order-engine/config.ts` + `index.ts`; `src/components/OrderReviewModal.tsx` (+ test) and panel wiring (DCAPanel / LimitOrderPanel / ConditionalOrderPanel render sites); `src/hooks/useOrderEngine.ts` signing path (createOrder struct build ~L678, confirmOrder ~L770–900); `src/lib/trusted-addresses.ts` + `src/hooks/useApproval.ts` + `/api/spender` (scoping claim); `docs/Prompts/BUG-DCA-APPROVE-SPENDER-V3.md`.

## 3. Checks

| # | Check | Result |
|---|---|---|
| 1 | Single-source invariant (approve spender ≡ signing executor) | **PASS** (see §4) |
| 2 | Predicate parity approve-time vs sign-time, incl. edges | **PASS** (see §5) |
| 3 | TRUSTED_SPENDER_ADDRESSES scoping claim + trust boundary | **PASS — claim verified correct** (see §6) |
| 4 | Approval safety UX (exact amount, wrong-spender recovery, dark state) | **PASS** (see §7) |
| 5 | Tests: failing-test-first genuine; invariant tests re-run | **PASS** — pre-fix 5/7 FAIL with the bug's exact signature; fix 30/30 PASS (see §8) |
| 6 | Adjacency: no keeper/contract/tx-construction/SC-04/R1 code touched | **PASS** — 7 files, all frontend order-engine + spec doc |
| 7 | On-chain address verification | **PASS** (see §9) |
| 8 | Commit signatures | **PASS** — 3/3 SSH-signed |

## 4. The invariant — can any call site still diverge?

**Explicit statement: no call path that produces an order signature can approve a different executor than it signs against, by construction, at this SHA.**

Evidence chain:

- `config.ts:96` — `resolveSigningExecutor(chainId, isV3Order) = isV3Order ? getOrderExecutorV3(chainId) : getOrderExecutor(chainId)`. Pure registry lookup; registry is env/const only (`ORDER_EXECUTOR_BY_CHAIN`, `ORDER_EXECUTOR_V3_BY_CHAIN` — `config.ts:12,62`; env `|| null` so empty string fail-closes).
- `useOrderApproval.ts:76` — `const spender = resolveSigningExecutor(chainId, isV3Order)`. The old direct `getOrderExecutor(chainId)` at this line is gone. This hook is the **only** approval path in the order engine, and `OrderReviewModal.tsx:65` is its **only** non-test consumer (grep across `src/**`).
- All three panels (DCA `:164`, Limit `:110`, SL/TP `:100`) render the shared `OrderReviewModal` with `order={pendingOrder}` and `onConfirm={confirmOrder}` — the approve predicate and the sign predicate evaluate on **the same frozen in-memory object** (`pendingOrder.order`). Parity is by object identity, not by re-derivation from parallel state.
- Exhaustive hunt for residual direct executor lookups on the branch (`git grep getOrderExecutor\(|getOrderExecutorV3\(`): remaining call sites are `useOrderEngine.ts:398/403` (registry loads feeding the domain builders and execute/cancel paths), `DCAPanel.tsx:350` (`v3Enabled` availability gate), `dca-launch.ts:46` + `on-chain-monitor.ts:324` (availability/monitoring, no approvals), `api/orders/route.ts:234` (server-side signature verification — same ternary, not an approval), and the domain builders in `config.ts` itself. **None is an approval path.** No approval or signing call site bypasses the shared resolution.

**Residual (INFO I-01):** `confirmOrder` does not literally call `resolveSigningExecutor` — it derives `isV3Order = order.maxSlippageBps !== undefined` (`useOrderEngine.ts:791`) and selects `getOrderExecutorV3Domain`/`getOrderExecutorDomain`, whose `verifyingContract` comes from the **same** registry functions `resolveSigningExecutor` wraps. So today the pairing is exact: same predicate expression, same frozen object, same registry lookup. A future edit that changes the predicate at only one of the two sites would reintroduce the class; both sites carry loud `[BUG-DCA-APPROVE-SPENDER-V3]` pinning comments and the modal test asserts the 4th arg for both v2 and v3 shapes. Optional hardening prompt in §11 (non-blocking).

## 5. Predicate parity — edges

- **`maxSlippageBps = 0`:** `0 !== undefined` → v3 at approve **and** sign. Parity holds (and 0 is only reachable if DCAPanel ever offered it; default is `DEFAULT_MAX_SLIPPAGE_BPS`).
- **Dark chain / env unset:** `createOrder` only embeds `maxSlippageBps` in the frozen struct when `signV3 = config.maxSlippageBps !== undefined && orderExecutorV3 !== null` (`useOrderEngine.ts:678`) — a frozen order **cannot** carry the field on a chain with no v3 executor. If it somehow did, approve fail-closes (`resolveSigningExecutor → null` ⇒ `needsApproval=false`, no Approve button) and sign fail-closes (`getOrderExecutorV3Domain` throws). No fund path.
- **Rehydrated/older drafts:** `pendingOrder` is in-memory only (`setPendingOrder`), consumed within the session — no serialization between freeze, approve, and sign. Supabase-loaded orders never reach `useOrderApproval`.
- **Limit/SL-TP shapes:** neither panel sets `maxSlippageBps` (grep: only DCAPanel, gated at `:557–587` on the v3 derivation) → frozen struct lacks the field → predicate false at both sites → v2 spender, v2 domain. Parity.
- **DCAPanel config gating:** `maxSlippageBpsForConfig` only set inside the `v3Enabled` branch with a real derived floor — consistent with the `signV3` gate downstream.

## 6. Allowlist claim — verified CORRECT

The agent's "N/A" claim is accurate, and the trust boundaries are properly disjoint:

- `TRUSTED_SPENDER_ADDRESSES` (`trusted-addresses.ts:29`, [FULL-H-02]) guards the **instant-swap** surface, where the spender is **API-fed** (`/api/spender` response → `SwapBox.tsx:197` and `useApproval.ts:198` both reject non-allowlisted spenders). That guard exists precisely because that spender crosses a network trust boundary.
- The order-engine approval spender **never** comes from a request: `useOrderApproval` → `resolveSigningExecutor` → registry constants or null. There is **no code path** by which user/API input reaches the order-engine spender. The OrderExecutor is intentionally NOT in `TRUSTED_SPENDER_ADDRESSES` (documented, `useOrderApproval.ts:17–21`), so no allowlist extension is needed — extending it would have *widened* the instant-swap surface for no benefit. The trust-boundary test (`useOrderApproval.v3.test.ts` "spender trust boundary" describe) pins registry-only resolution across 5 chain/mode combinations.

## 7. Approval safety UX

- **Exact amount:** `approve(spender, amountIn)` — never max-uint (`useOrderApproval.ts:141`, guarded `amountIn <= 0n` refuse). Unchanged by this PR.
- **Wrong-spender recovery (the owner's live state — v2 allowance 100e18, v3 order):** the allowance read is keyed `[address, spender]` with spender = the **resolved** executor, so the stale v2 allowance is invisible to a v3 order's gate → `needsApproval=true` → normal exact approve to v3. `justApproved` is spender-scoped (lowercase compare) so the v2 receipt can't green-light the v3 gate. No migration code needed — confirmed by construction.
- **Dark state:** `isV3Order` defaults `false` → `resolveSigningExecutor(chainId, false)` ≡ `getOrderExecutor(chainId)` — byte-identical v2 spender. The full pre-existing v2 suite (13/13) passes unmodified; the only modal test change is asserting the explicit 4th arg.

## 8. Tests (re-run by the Auditor, branch extracted to /tmp, vitest 4.1.7)

| Run | Result |
|---|---|
| Fix tip: `useOrderApproval.v3.test.ts` | **7/7 PASS** |
| Fix tip: `useOrderApproval.test.ts` (v2 regression) | **13/13 PASS** |
| Fix tip: `OrderReviewModal.test.tsx` | **10/10 PASS** |
| Pre-fix (`09fee45`, test-only commit): `useOrderApproval.v3.test.ts` | **5/7 FAIL** — spender resolved `0x135B…2598` (v2) where `0x686b…60a0` (v3) expected; mainnet fail-closed-null violated (`0xeFC3…f130` where null expected). Exactly the on-chain-proven bug. |

Failing-test-first is genuine: commit order `09fee45` → `630af32`, and the failures are behavioral (wrong spender), not compile errors. **INFO I-02:** the v3 test necessarily mocks `resolveSigningExecutor` itself (config's internal call isn't patchable via the re-export — documented in the test); the real function is a one-line ternary verified by source read, and the pre-fix failing run proves the hook consumes the module export for real.

## 9. On-chain verification (read 2026-07-21, mainnet publicnode / Base mainnet.base.org)

| Contract | Address | Code | admin() |
|---|---|---|---|
| Mainnet OrderExecutor v2 (`ORDER_EXECUTOR_BY_CHAIN[1]`) | `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` | 13 244 B ✓ | `0x9a38…c73c` ✓ |
| Base OrderExecutor v2 (`ORDER_EXECUTOR_BY_CHAIN[8453]`) | `0x135B339902Ea4E0fB4CF059961dc8856bA1D2598` | 15 475 B ✓ | `0x9a38…c73c` ✓ |
| Base OrderExecutor **v3** (env `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE`; test constant) | `0x686b4f812291F4De238E59ED00BA6dD6129e60a0` | 18 247 B ✓ | `0x9a38…c73c` ✓ |

All three live, all admin = the known ops EOA (W1-L-02 hardening still in backlog, unchanged). The only address literal in the diff is the test mock constant, which matches the real deployed OE_V3.

## 10. Findings

| ID | Sev | Where | Disposition |
|---|---|---|---|
| I-01 | INFO | `useOrderEngine.ts:791` | Sign path re-derives the predicate + uses domain builders instead of literally calling `resolveSigningExecutor`. Identical today (same expression, same frozen object, same registry); pinned by comments + tests. Optional hardening prompt §11. |
| I-02 | INFO | `useOrderApproval.v3.test.ts` | Test mocks `resolveSigningExecutor` (necessary; documented). Real function source-verified; pre-fix failing run proves real consumption. No action. |
| I-03 | INFO | process | Audited against locally-fetched refs (sandbox cannot reach GitHub). Owner: confirm PR head = `4a4efed` on GitHub before merge. |

**0C / 0H / 0M / 0L → APPROVE-TO-MERGE.** No gate weakened; no contract, keeper, tx-construction, SC-04, or R1 code touched; fail-closed behavior strengthened (v3 spender now fail-closes to null on unwired chains instead of silently approving v2).

## 11. Optional hardening prompt (non-blocking, backlog)

> **Context:** BUG-DCA-APPROVE-SPENDER-V3 fixed approve/sign executor divergence by routing the approval spender through `resolveSigningExecutor` (config.ts). The sign path (`useOrderEngine.ts` confirmOrder ~L791) still derives `isV3Order = order.maxSlippageBps !== undefined` locally and picks the domain via `getOrderExecutorV3Domain`/`getOrderExecutorDomain` — correct today, but the predicate exists in 3 places (config resolver docstring contract, OrderReviewModal:65, confirmOrder:791) plus createOrder's `signV3` (:678).
> **Objective:** make predicate divergence impossible by construction: export a single `isV3Order(order: Pick<OnChainOrder,'maxSlippageBps'>): boolean` helper from `src/lib/order-engine` and use it at OrderReviewModal:65, confirmOrder:791, computeOrderHash:117, and the cancel path (:946, :982); in confirmOrder, assert `domain.verifyingContract === resolveSigningExecutor(signedChainId, isV3Order(order))` (throw on mismatch — fail-closed, unreachable today).
> **Do NOT:** change any signing bytes, domain values, or approval amounts; touch keeper/contracts; alter the v2 default-false behavior.
> **Files:** `src/lib/order-engine/{config,index,types}.ts`, `src/hooks/useOrderEngine.ts`, `src/components/OrderReviewModal.tsx`, existing tests.
> **Tests:** existing 30 stay green byte-identical; add one test that the assertion throws when the pairing is artificially broken (mock).
> **Quality:** tsc + eslint + full vitest green; one atomic SSH-signed commit.

RICE: low reach (defect class already pinned by comments+tests), low effort — rank alongside W10-L-01 tier.

---
*Report written by the Auditor (no signing key — commit left for the owner's SSH-signed batch). Pre-fix/fix test runs executed from `git archive` extractions in /tmp with symlinked node_modules; no repo files modified except this report + the AUDIT-TOTAL append.*
