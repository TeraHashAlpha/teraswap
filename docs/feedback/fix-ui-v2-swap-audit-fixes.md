# Feedback — fix/ui-v2-swap-audit-fixes (A69 @ 320cc26: 0C/1H/2M/3L)

Scope: only `src/ui/v2/**` + this file. Hooks / lib / api / v1 components untouched. No PR (Auditor re-check A69b follows).

## Checklist
- [x] C1 H-1 min output = decoded calldata floor (direct route)
- [x] C2 M-1 re-snapshot `confirmedModel` on the executing press
- [ ] C3 M-2 hook-argument equality v1 vs v2 (6 scenarios)
- [ ] C4 L-1 Confirm gated · L-2 CoW Cancel resets review · L-3 Permit2 not stacked
- [ ] Evidence 1–5 below · push · compare link

## Scope / premise notes (owner answers supersede the goal text)
- Owner accepted `src/ui/v2/modals/**` as in-scope reads/edits (review-model.ts, Permit2Sheet, CoW/Split sheets) — asked in-session.
- Goal names this file `feat-ui-v2-swap-audit-fixes.md`; the repo convention is `<branch>.md` → `fix-ui-v2-swap-audit-fixes.md`. Typo assumed; `git mv` if wrong.
- H-1 "guarded on `preview.tokenOut`" implemented as v1's `formatDecodedAmount` guard (decoded buy token ≠ the token being bought → no row; absent → trusted, as v1). Needed `ReviewPending.tokenOutAddress`.
- H-1 "while `pending`, show the skeleton" read as: the hook is working (`confirmBusy`) and nothing is frozen yet. Pre-Confirm the sheet therefore has NO minimum-output row (owner: never a UI-computed fallback).

## Findings along the way
- v1 ignores `amountOutMinLabel` ("router minimum (before router fees)") that the decoder sets for Uniswap-style routers; v2 copies v1, so the label is not shown either (parity; possible v1 follow-up).

## Evidence
(filled per commit)
