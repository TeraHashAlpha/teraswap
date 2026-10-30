# AUDIT — ui-v2 swap B3 (card) / B4 (modals) / B5 (lifecycle)

| Pass | Date | Commit audited | Suite | Result |
|---|---|---|---|---|
| A69 | 2026-10-29 | origin/main `320cc26` (PRs #618, #619, #620 merged) | 377 files / 6068 tests passed | 0C / 1H / 2M / 3L — **blocked** |
| A69b | 2026-10-30 | origin/main `a5a986c` = PR #625 merge `e097477` + PR #624 (DCA; no in-scope file changed) | 383 files / 6147 tests passed | 0C / 0H / 0M / 2L — **approved** |

**Final verdict: `VERDICT: 0C/0H → approved`** (A69b). The owner approved the result on 2026-10-30.

Both passes were read-only. Each ran in a fresh detached worktree with `npm ci` and the full suite run once. Severity uses C / H / M / L. The owner's rule for this audit: any place v2 computes or reshapes a number that v1 takes straight from the hook counts as at least H.

Scope: `src/ui/v2/swap/**` and `src/ui/v2/modals/**` with their tests, plus the v1 counterparts (`SwapBox`, `SwapButton`, `TransactionPreview`, `Permit2*`, `useSwap`, `useSplitSwap`, `useApproval`). Landing, shell and DCA are outside this audit.

---

## A69b — re-check after PR #625 (`fix/ui-v2-swap-audit-fixes`)

Line references are at `a5a986c`. For every in-scope file this is identical to `e097477`: `git diff e097477 a5a986c` over the scope is empty. The fix commits were `63d68ac` (H-1), `7aec52b` (M-1), `d321920` (M-2), `8197ca6` (L-1, L-2, L-3) and `147f943` / `9ef2fdf` (feedback). The main merge `8b9b140` changed no in-scope source.

### Prior findings

| Prior | Status | Evidence | Test that proves it |
|---|---|---|---|
| H-1 | closed | `ReviewSheet.tsx:108-114,147-161` uses the same precedence as v1 `TransactionPreview.tsx:113,198-213`: the FeeCollector-enforced minimum first, else the router floor decoded from the frozen calldata, else no row. The decode goes through `decodedMinimumOutput` (`review-model.ts:126`), which keeps v1's `formatDecodedAmount` checks: buy-token match, and no row for zero or non-integer values. A skeleton shows while the hook is still preparing (`:114`). Nothing in the review path reads `ReviewModel.minOutput` any more; the only other `minOutput` reader is the quote panel's own estimate (`QuotePanel.tsx:296`). SwapCard passes the same frozen inputs v1 passes (`SwapCard.tsx:654-661` = `SwapBox.tsx:1253-1268`). | `review-sheet.minout.test.tsx` "v1 == v2 on the same frozen preview — the SAME bigint reaches the formatter" and 9 more. It compares bigints through a `fmtToken` spy and fails on the old code, but it covers chain 1 only (see S-1). |
| M-1 | closed | `use-swap-lifecycle.ts:128` calls `onExecute` synchronously, just before `run`. Only the press that actually executes reaches it: not the approval press, not the consent-gated one. `SwapCard.tsx:429-431` re-freezes the sheet's model there. It reads the same render's `meta` and `slippage` the hook receives (`SwapCard.tsx:263-276`, `:341`, `:372`). The success toast, history row and summary read the quote frozen in `run` (`use-swap-lifecycle.ts:89`, `:164-201`). | `executing-press.lifecycle.test.tsx:110` (approval first) and `:139` (after a 409). Its sheet checks (`2 399.0000 USDC`, KyberSwap) fail on the old first-press-only freeze. |
| M-2 | closed | Each scenario deep-equals v1 and v2 through `v2Out()`. That object holds the last-render arguments of `useSwap`, `useSplitSwap`, `useApproval` and `useSplitRoute`, plus every `execute`, `approve` and `confirm*` call. Scenarios: standard `:165`, approval-first `:178`, unpriced without ack `:233`, unpriced with ack `:250`, CoW `:277`, CoW with ack `:303`, split priced `:321`, split unpriced `:340`, 409 single `:384`, 409 split `:408`. Dropping `unpricedAck` breaks every equality that carries it. | `confirm-path.lifecycle.test.tsx` |
| L-1 | closed | Confirm is a real `disabled` when the review is open and a block lands or the quote disappears (`SwapCard.tsx:396`, `:666-668`, `ReviewSheet.tsx:235-241`). Its label is v1's copy: `gates.ts:117-127` matches `SwapButton.tsx:69-85` verbatim. The `!meta` guard (`use-swap-lifecycle.ts:115`) returns before the waiting sound starts. `blockReason` is set exactly when `anyBlocked` is (`gates.ts:73-89`, where `isExtremeBlock ⊂ oracleIntegrityBlocked`). | `review-guards.lifecycle.test.tsx:85, 98, 106, 123, 131` |
| L-2 | closed | The CoW order sheet's Cancel now calls `onReviewCancel` (`SwapCard.tsx:693`), which clears the review request and the frozen model, then calls `lc.cancel()`. This matches v1's `onCancel={resetSwap}`. | `review-guards.lifecycle.test.tsx:152` |
| L-3 | closed | The single review stays closed while `needsPermit2Education` is set (`SwapCard.tsx:383`), and the explainer renders at `:645`, so the two are never stacked. This is v1's order: `SwapBox.tsx:1242` (explainer) before `:1252` (preview). | `review-guards.lifecycle.test.tsx:176` |

### Regression sweep (A69 sections A, B, D)

- **A — fund-flow arguments: unchanged from v1.**
  - `run` at `use-swap-lifecycle.ts:90-97` makes the same calls as v1. `split.execute(bestSplit[, { unpricedAck: true }])` and `swap.execute(meta.best.source, orderExecutableFallbacks(meta, meta.best.source, activeChainId)[, { unpricedAck: true }])` match `SwapBox.tsx:698-703` and `:742-745`.
  - The hook calls are unchanged. `useSwap(tokenIn, tokenOut, amountIn, slippage, quoteToAmountBySource, bestNonCowGasUsd)`, `useSplitRoute(…)` and `useSplitSwap(…)` at `use-swap-lifecycle.ts:61-63`, plus `useApproval(tokenIn, amountIn, spender)` at `SwapCard.tsx:220`, match `SwapBox.tsx:258, 276, 315, 328`.
  - The fix added only the `onExecute` callback and the `!meta` guard. Neither changes an argument.
- **B — gates, consent and 409: unchanged.**
  - `confirm` checks run in this order: chain active, then `anyBlocked`, then `!meta` (new), then the waiting sound, approval, unpriced consent, `onExecute` (new), `run`. v1's order is `SwapBox.tsx:674-705`.
  - The new guard only makes things stricter, and it covers states where v1's button is already disabled ("No quotes available").
  - Consent and 409 handling (`ReviewSheet.tsx:82-97`, `review-model` `reviewOpen`) were not touched.
- **D — display integrity: holds.**
  - The minimum output is the raw bigint formatted through `fmtToken` (`ReviewSheet.tsx:109,113`).
  - No new address is rendered: `tokenOutAddress` is only compared, never displayed.
  - Tier and consent copy were not touched.
  - The new Confirm labels are v1 `SwapButton` strings verbatim.
- **Outside the six items:** nothing. The fix commits touched only `src/ui/v2/**` and their feedback file, and every hunk maps to one of the six items. The `audit-allowlist.json` change in the branch range came from the main merge (PR #626), not from the fix commits.

### New findings

**[S-1] L — `src/ui/v2/modals/review-sheet.minout.test.tsx:54`**
- **Issue:** the bigint parity test for direct routes builds only chain 1 (mainnet ETH/USDC fixtures, `chainId: 1`, decoder stubbed). No v2 test drives the minimum-output row on Base (8453) or Arbitrum One (42161), so the requested 1 / 8453 / 42161 matrix for direct (0x) routes is not covered.
- **Failure path:** the code path has no chain branch (`ReviewPending` has no chain id, and the inputs equal v1's per chain). A future chain-specific divergence would go unnoticed, for example a buy-token address mismatch on Base or Arbitrum One that hides the row while v1 shows it.
- **Fix:** run the test once per chain (`it.each([1, 8453, 42161])`) with each chain's buy token and 0x router address.

**[S-2] L — `src/ui/v2/swap/SwapCard.tsx:396`**
- **Issue:** `confirmGated` only fires when the CTA kind is `'blocked'`. `ctaFor` (`cta.ts:57-63`) ranks connect, wrong-network and insufficient-balance ahead of `'blocked'`, so in those states a gate block is hidden.
- **Failure path:** the review is open, the user's balance drops below the amount through an external transfer, and a depeg block is also active. Confirm stays enabled as "Confirm & Sign", and pressing it silently does nothing (`use-swap-lifecycle.ts:114` returns). Nothing executes and no waiting loop starts, so it fails closed, but it is the silent no-op L-1 set out to remove.
- **Fix:** gate on `cta.disabled && cta.kind !== 'in-flight'` and use `cta.label` (v1 `SwapButton`'s first-match copy), or gate on `gates.anyBlocked || !meta` directly.

### Verdict

`VERDICT: 0C/0H → approved` (0C / 0H / 0M / 2L). S-1 and S-2 do not block.

---

## A69 — original audit at `320cc26` (verbatim)

Premise notes from the A69 pass:
- `src/components/SwapReview*.tsx` and `SplitRouteView.tsx`, both named in the A69 goal, do not exist.
- The B4 modals live in `src/ui/v2/modals/**`.
- The auditor read the real v1 counterparts instead. These are the counterparts the B4 feedback records the owner as already accepting: `TransactionPreview`, `SplitReviewModal`, `CowOrderReviewModal`, `SwapUnpricedConsentDialog`, `lib/minimum-output`, `lib/price-gate`, `shell/toasts` and `shell/format-address`, plus greps of `calldata-decoder` and `chains/activation`.

```
AUDIT — ui-v2 swap B3 (card) / B4 (modals) / B5 (lifecycle)
Commit: origin/main 320cc26 (PRs #618, #619, #620 merged). Fresh worktree, npm ci.
Suite:  377 files / 6068 tests passed (vitest, 43 s).

FINDINGS
[H-1] src/ui/v2/modals/ReviewSheet.tsx:147 (:103-104) — on a direct route (not via FeeCollector:
  0x on chains 1/8453/42161, constants.ts:189, activation.ts:39-45) the signing review's
  "Minimum output" row shows model.minOutput = deriveMinimumOutput(quote.toAmount, slippage),
  a UI computation, instead of the router floor decoded from the FROZEN calldata
  (preview.amountOutMin) that v1 TransactionPreview.tsx:113,208-213 shows.
  Failure path: 0x best → Confirm → /api/swap → pendingSwap; the row shows quote×(1−s) while
  the calldata encodes 0x's minAmountOut; off by up to slippage+0.5 % (quote-vs-swap tolerance),
  more when the snapshot is stale (M-1). review-sheet.test.tsx:112-159 only compares with v1 on
  routeViaFeeCollector:true; the direct case (:157-158) asserts nothing about the number.
  Fix: when `pending` is present and !routeViaFeeCollector render preview.amountOutMin via
  fmtToken(…, decimalsOut) guarded on preview.tokenOut (as v1), else no row; add tokenOut
  address to ReviewPending; add the direct-route parity case.

[M-1] src/ui/v2/swap/SwapCard.tsx:413 — confirmedModel is snapshotted on the FIRST Confirm press
  and never refreshed on the press that executes; run() (use-swap-lifecycle.ts:89-97) uses the
  live meta. Path: ERC-20 sell needing approval → "Approve & Swap" → approval tx (15–60 s) →
  quote polls → "Confirm & Sign" → the hook executes the live quote while the sheet keeps the
  first-press Rate / Route / Est. gas / Receive (until pendingSwap lands) / direct Min output /
  consent {N}/{d}/{minOut} / tier (so needsConsent can disagree with a.unpricedPair). Same after
  a 409 round-trip. Toast/history are consistent with execution (lc.confirmed, :84-89,159-163).
  Fix: setConfirmedModel(liveModel) on every press that reaches run (approval.isReady), or
  snapshot inside lc.confirm next to setConfirmed.

[M-2] src/ui/v2/swap/lifecycle/confirm-path.lifecycle.test.tsx:41-46 — the mocks
  useSwap/useSplitSwap/useApproval/useSplitRoute discard their arguments, so the hook-CALL
  arguments (slippage, quoteToAmountBySource, bestNonCowGasUsd, spender, isChainOkForQuote,
  chainId) are never compared v1 vs v2; only execute/approve/confirm*/reset calls are. A wrong
  slippage or an empty quoteToAmountBySource would pass the suite.
  Fix: record the args (as swap-card.test.tsx:29-34 does for useQuote) and deep-equal them per
  scenario.

[L-1] SwapCard.tsx:384,407-415 + ReviewSheet.tsx:221-229 — the sheet's Confirm ignores
  gates.anyBlocked and meta===null: a poll that escalates to a hard block (or nulls the quote)
  after the sheet opened leaves Confirm enabled; the press is a silent no-op
  (use-swap-lifecycle.ts:111) and with meta null startWaitingSound() (:112) loops until Cancel.
  v1's button is disabled there. Fix: fold blockReason/!meta into confirmButtonState and return
  before startWaitingSound when nothing can run.
[L-2] SwapCard.tsx:379,674 — cancelling the CoW order sheet (lc.cancel → swap.reset) leaves
  reviewRequested true, so the single review sheet reopens; v1 returns to the form.
  Fix: use onReviewCancel for the CoW sheet.
[L-3] SwapCard.tsx:628-631 — Permit2Sheet is an earlier sibling at the same z-index
  (modals.css:3): it would render UNDER the review sheet with two Esc handlers if
  needsPermit2Education fired during a review. Unreachable today (useApproval.ts:110-116 only
  plans 'exact'; same dead path in v1). Fix: mount after ReviewSheet or hide the review meanwhile.

VERIFIED OK
A Fund flow: use-swap-lifecycle.ts:57-63 = SwapBox.tsx:263-276,315,328 (same args to useSwap /
  useSplitRoute / useSplitSwap); SwapCard.tsx:198-220 = SwapBox:230-258 (/api/spender,
  isTrustedSpender, useApproval(tokenIn, amountIn, spender)); execute calls :89-97 =
  SwapBox:699-703 / 743-745 (ack only as {unpricedAck:true}, else two args; same fallbacks);
  confirmSwap/confirmCowOrder/confirmPlan SwapCard:410/674/671 = SwapBox:1269/1280/1294;
  calldata, minimumOutput, recipient only from pendingSwap (SwapCard:637-643, review-model:130-145);
  CoW sheet renders the frozen order.message (CowOrderReviewSheet:49-70); slippage derived
  (SwapCard:157-158 = SwapBox:168-172), SlippageSheet same calls/order (slippage-sheet.test:53-63,
  125-160); Permit2 decision stays inside useApproval (unchanged).
B Gates: gates.ts:49-89 = SwapBox:599-667 (same evaluators, constants, precedence :75-89 = :1105);
  consent per trade key, re-armed past tolerance (use-swap-gates.ts:51-53,77-84; gates.ts:57,63);
  confirm refuses when blocked (lifecycle:110-111); CTA disabled (cta.ts:63-66); consent is
  useState(false), never persisted, Confirm real-disabled (ReviewSheet:78,108,223;
  ConsentSheet:16,28); 409 → unticked, focused, reopens (ReviewSheet:80-92, review-model:116-118);
  ack only after a tick (ReviewSheet:229 → lifecycle:124 → :91/:96); Esc/backdrop only cancel
  (Sheet.tsx:58-63,97); server 409 unchanged (api/swap/route.ts:328-340). Tests
  confirm-path:207-246,341-391; review-sheet:223-272; a11y-edge:126-132,145-162.
C Stale state: tradeKey closes the sheet and resets both hooks (SwapCard:281-292); hooks
  self-reset on chain/account (useSwap:281-313, useSplitSwap:233-251); success/toast/history from
  the quote frozen at run (lifecycle:84-89,159-223); #604 identity + amount gate
  (SwapCard:171-181, quote-model:255-262). Tests frozen-amounts:85-125, a11y-edge:187-222,
  swap-card:354-387.
D Display: bigint floor (quote-model:175, review-model:42) vs v1 float (QuoteBreakdown:147);
  route allow-list, never 0x (route-names.ts, quote-model:36-55; quote-model.test:12-32,139-188);
  single-source tier verbatim (TierNotice:17 = QuoteBreakdown:221-222); unpriced panel line is
  the owner's B3 one-liner, not v1's paragraph (content-parity.swap.test:180-197 allow-listed);
  consent copy is v1's exports (parts.tsx:4,35-42); "You saved" only CoW realised surplus
  (lifecycle-view:83-98 = SwapBox:388-403); wrong network → switchChain({chainId: CHAIN_ID})
  (SwapCard:404 = SwapButton:63); explorer = order chain (SwapCard:388-394; execution.test:129-137).
E Chain: activeChainId threaded to quote / split / tier / spender / allow-list / remap /
  auto-slippage / stablecoin / USD estimate / verified-token / explorer / feeMode / executable
  (SwapCard:149-243, use-swap-gates:70, quote-model:162-163,233, TokenSheet:25,47); quote pinned
  by identity (SwapCard:171-174); useSwap/useSplitSwap/useApproval read useActiveChainId
  internally; toast carries chainId (lifecycle:180).
F Leakage: src/ui/v2 non-test grep: 0 dangerouslySetInnerHTML/innerHTML, 0 NEXT_PUBLIC_,
  process.env only in server gate files outside swap; network calls = v1's set (/api/spender
  SwapCard:202; useQuote, useSwapPriceTier, useSplitRoute, useTokenImport, useImportedTokens);
  imports via v1 useTokenImport (getAddress :46, sanitizeTokenField :103-104), per-chain store
  (token-sheet.test:216-257), symbol/name as text nodes (TokenSheet:85-88), explorer href from
  chain config (:47); same storage keys as v1 (SwapCard:59, QuotePanel:12, Permit2Sheet:9).
G Tests: confirm-path deep-equals the recorded call arrays (:150,163,203,218,235,262,288,306,325)
  incl. [0][2] toEqual({unpricedAck:true}) (:229,282,316,354,386) and "no 3rd arg" (:144,244) —
  dropping the ack fails five tests; block labels vs v1 SwapButton (gates.test:95-108). Gap = M-2.

VERDICT: blocked — 0C/1H
```

**Resolution:** all six A69 findings were fixed in PR #625 (`fix/ui-v2-swap-audit-fixes`, merge `e097477`). The A69b re-check above confirms them closed.
