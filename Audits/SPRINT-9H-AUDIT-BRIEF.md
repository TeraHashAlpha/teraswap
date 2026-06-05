# TeraSwap — SPRINT-9H Audit Brief (Auditor agent prompt)

**Scope:** Two Base swap-execution fixes found on the 9G Preview (NOT 9G regressions). 9H-1 **widens
the calldata function-selector allowlist** (a security control) → primary audit focus. 9H-2 is a
Bebop fail-soft (low risk). Classify findings **C/H/M/L**. **0C/0H = APPROVED.** Produce Code Agent
remediation prompts — **do NOT edit code directly.**

**Branch:** `feat/sprint-9h-base-exec-fixes` (not merged/deployed).
**Commits (signed):** 9H-1 `5e86e1f` · 9H-2 `fa73eb4` · docs `95265b3`.
**Baseline:** Tests 1391 → **1399**, typecheck 0, lint 0, mainnet byte-identical (claimed).
**Specs:** the SPRINT-9H FEEDBACK section + `Audits/FULL-AUDIT-2026-06-02.md`.
**Note:** an uncommitted `docs/security/AUDIT-TOTAL.md` edit in the tree is the Auditor's *9G*
verdict (not 9H) — out of scope here; owner commits it separately.

---

## 9H-1 — Velora selectors added [PRIMARY · `5e86e1f`]
Two ParaSwap/Augustus **V6.2** selectors were added so a Base swap routed through a Curve pool
passes our calldata validation:
- `0x1a01c532` → `swapExactAmountInOnCurveV1` (the reported "Unknown swap function selector" failure)
- `0xe37ed256` → `swapExactAmountInOnCurveV2`
Added to **three** registries: the **allowlist**, the **fail-closed recipient gate**, and the
**tx-preview decoder**.

**Audit questions (this is the trust-critical part):**
1. **Selector correctness:** do `0x1a01c532` / `0xe37ed256` actually equal
   `keccak4(swapExactAmountInOnCurveV1(...))` / `...V2(...)` of the **live Augustus V6.2** ABI?
   (The Code Agent verified 3 ways — codeslaw ABI + openchain.xyz + `viem.toFunctionSelector`;
   re-derive independently and confirm against the on-chain Augustus on mainnet **and** Base.)
2. **Recipient gate not bypassed (the real risk):** for these two methods, does the recipient/
   beneficiary argument get **correctly decoded** and validated by the fail-closed recipient gate?
   A new selector that's allowlisted but whose recipient arg the decoder mis-parses (or treats as
   absent) could let output route to an attacker. Confirm the decoded recipient == the user for
   these methods, with a test that a tampered recipient is rejected.
3. **No blind widening:** were ONLY these two methods added (not a broad family)? Non-Curve V6.2
   methods must NOT have been added. Mainnet selector set otherwise unchanged (the V1/V2 Curve
   methods now resolve on mainnet too — confirm that's intended/safe, not a behavioural change to
   existing mainnet swaps).
4. Tests cover: the two selectors pass the allowlist, the recipient gate decodes+validates them,
   and an unknown selector still throws.

## 9H-2 — Bebop fail-soft [LOW · `fa73eb4`]
In demo-mode (no `BEBOP_API_KEY`) Bebop priced, won Best, then hard-failed at swap. Now: `fetchQuote`
returns `null` when it can't execute (so it doesn't rank); `fetchSwapData` returns `null`
(breaker-neutral) when settlement fields are absent instead of throwing.
**Questions:** (1) the **security gates stay fail-closed** when settlement data IS present but
`tx.to !== settlement` or addr ∉ whitelist (the P228 gate must still throw, not soften). (2) The
firm path (key present) is intact. (3) `null` is breaker-neutral (no false breaker trips), matching
the 9F no-route convention.

## Cross-cutting
- No contract/fee/9G-gate edits; keys server-only; mainnet byte-identical (verify via diff/tests).
- `FEEDBACK.md` triaged.

## Deliverable
Findings table + a Code Agent remediation prompt per C/H. **APPROVED only at 0C/0H.** On approval:
update `docs/security/AUDIT-TOTAL.md`, then bundle 9G + 9H → Vercel **Preview** → verify
Velora + Kyber execute on Base (and Bebop no longer wins-then-fails) → promote.
