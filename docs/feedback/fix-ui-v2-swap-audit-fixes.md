# Feedback — fix/ui-v2-swap-audit-fixes (A69 @ 320cc26: 0C/1H/2M/3L → all six fixed)

Only `src/ui/v2/**` + this file; hooks/lib/api/v1 untouched. 4 signed commits (code head `8197ca6`). No PR — Auditor re-check A69b follows.
Owner answers: `src/ui/v2/modals/**` in read/edit scope. Goal's `feat-…` file name read as typo → `fix-ui-v2-swap-audit-fixes.md` (`git mv` if wrong).

## 1. Per finding (fails-on-old = new tests run against origin/main sources)
| id | old file:line | change | test (file) | origin/main |
|---|---|---|---|---|
| H-1 | ReviewSheet.tsx:147 | min row = enforced ?? decoded `amountOutMin` (v1 guard), skeleton while hook works, else no row; `minOutput` deprecated | `modals/review-sheet.minout` (10) | 9 fail; FeeCollector-enforced passes (unchanged by design) |
| M-1 | SwapCard.tsx:413 | `lc.confirm(c, onExecute)` re-freezes at the press that reaches `run` (v1: `useSwap.ts:733` `setPendingSwap`) | `lifecycle/executing-press` (2) | 2/2 fail |
| M-2 | confirm-path…:41-46 | mocks record ctor args; v1==v2 `toEqual` covers calls + args; split-409 retry got its v1 run | `lifecycle/confirm-path` (14) | test-only → mutation proof, §4 |
| L-1 | SwapCard.tsx:384,407-415, ReviewSheet.tsx:221-229 | Confirm disabled with the CTA's v1 block copy (blocked / no quote); `confirm()` returns before `startWaitingSound` with no quote | `lifecycle/review-guards` L-1 (5) | 4 fail; in-flight-label control passes |
| L-2 | SwapCard.tsx:674 | CoW Cancel → `onReviewCancel` (clears request + model) | `review-guards` L-2 (1) | fails (review reopens) |
| L-3 | SwapCard.tsx:628-631 | review yields while `needsPermit2Education` (v1 order `SwapBox.tsx:1242` explainer → `:1252` preview) | `review-guards` L-3 (1) | fails (2 stacked dialogs) |

## 2. Direct-route parity (same frozen preview → v1 `TransactionPreview` and v2 `ReviewSheet`; `fmtToken` spy)
`amountOutMin=2480221147n`, tokenOut=USDC: v1 → `[{v:2480221147n,d:6}]`, v2 → identical (`toEqual`, bigint) → row "Minimum output 2 480.2211 USDC".
Also equal: 1-wei-off value, token mismatch / `0` / non-integer (no row both). FeeCollector: v2 → `[{v:2400000000n,d:6}]` + "Enforced on-chain". Old v2: spy `[]` (UI string).

## 3. Frozen snapshot (M-1)
Approval-first: press 1 sheet `2 487.6842 USDC` → requote (kyberswap best, `2 399.0000`) → press 2: `execute('kyberswap', …)`; sheet `2 399.0000`, source KyberSwap,
`useSwap` per-source map `kyberswap:'2399000000'`; toast `1 ETH → 2 399.0000 USDC`; history `amountOut '2399.0000'`. 409 round-trip: 2nd `execute('kyberswap', fb, {unpricedAck:true})`, sheet `2 399.0000`.
Old: sheet stays `2 487.6842`. Note: toast/history/success already used the executing-press quote (`lifecycle.confirmed` is set in `run`); the stale half was the sheet's model.

## 4. Arg-equality matrix (v1 object == v2, `toEqual`; hooks = last-render args of useSwap/useSplitSwap/useApproval/useSplitRoute + all calls)
standard ✓ · approval-first (approve×1, no execute) ✓ · unpriced no-ack (0 calls) ✓ · unpriced+ack `execute(src, fb, {unpricedAck:true})` ✓ · CoW and CoW+ack ✓ ·
split priced / unpriced `execute(bestSplit, {unpricedAck:true})` ✓ · 409 retry single ✓ + split ✓. Mutations: drop `unpricedAck` → 3 fail (old file also 3);
`useSwap(…, slippage+1)` → **11 fail new, 0 old** (the blind spot). `hookArgs()` asserts args were recorded.

## 5. Verify
- v1 proof: import closure of the 58 non-v2 app entries = 324 files; changed sources (ReviewSheet, review-model, SwapCard, use-swap-lifecycle) in it: **0** (all 4 in the v2 closure).
- Suite origin/main 377 files / 6068 → branch 380 / 6087 (+3 files, +19 tests), 0 fail · lint 93 = 93 · tsc 0 · `next build` exit 0 · rpc-budget guards 22/22.
- `git diff --stat origin/main...`: 11 files, +693/−39, all under `src/ui/v2/**` + this file. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/ui-v2-swap-audit-fixes

## Concerns / follow-ups
- A recoverable gate (price-impact / depeg consent) landing while the review is open disables Confirm with the consent copy, but its checkbox sits behind the sheet → user must Cancel to tick.
- Before the first Confirm the sheet has no min-output row (per instruction); the quote panel keeps its estimate. Permit2 yielding unmounts the review → a ticked unpriced consent resets (safe side).
- v1 ignores the decoder's `amountOutMinLabel` ("router minimum (before router fees)"); v2 copies v1.
