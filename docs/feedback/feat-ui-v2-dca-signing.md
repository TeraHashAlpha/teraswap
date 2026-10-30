# feat/ui-v2-dca-signing — feedback (B6b)

Off origin/main `d8d658c`. Signed, noreply, no PR. Diff only `src/ui/v2/dca/**` + this file/folder. C1 `057b62a` create · C2 `ff1e6c0` cancel · C3 `4a4bae7` a11y/edge · C4 `39cbfc8` evidence · C5 owner answers. **AUDITOR REQUIRED before merge (signs orders).** Tests run v1's DCAPanel and the v2 card on a fake engine with v1's observable contract; nothing is connected, signed or sent. Checklist: C1 ✓ C2 ✓ C3 ✓ evidence 1-6 ✓ premises asked ✓.

**False premises → asked; owner answers (2026-10-30) applied:**
1. v1's create is two-phase: `createOrder` only freezes (DCAPanel.tsx:993); sign + POST are `confirmOrder` behind OrderReviewModal's approval gate. → **Keep it**: review → createOrder → sign sheet (frame 34) → confirmOrder.
2. The 409's `requiredTier` never reaches the UI (v1's client throws `json.error`, supabase.ts:150). → **Accept parsing the server's sentence** (`requiredTierFromError`); a lib follow-up carries the field.
3. v1 clears the amount at the freeze (DCAPanel.tsx:994). → **Clear when the sign sheet closes** (same end state; the draft-key guard holds while a sheet is up).
4. No sign/POST boundary in v1 (`isSubmitting` spans both) → one `Signing order...` step. `Retry` had no v1 word → **v1's `Start DCA — N buys over D`** (DCAPanel.tsx:1524, from the frozen struct); `View positions` stays.
**Findings:** (a) v1 hands `confirmOrder` the click event (ignored); v2 calls it bare. (b) v2's one sheet outlives v1's modal, so the allowance read idles after the sign press (`tokenIn` undefined). (c) `createOrder`'s MIN_ORDER guard errors without freezing → the failure sheet (v1: toast). (d) Silent abandons (chain/account reset, `creatingRef`, expired review) disarm the attempt — a later poll event is never its outcome. (e) B6a's one sound difference closed: the loop runs into the EIP-712 review on the on-chain tier and restarts after a consent (:825); v2 still stops it on a cancelled review (B5 rule).

## Evidence (`feat-ui-v2-dca-signing/`)
**1. Call sites** (v1 → v2)
| v1 | v2 |
|---|---|
| `DCAPanel.tsx:1209` consent → `handleCreate(t)` · `:825` `startWaitingSound()` · `:993` `onSubmit(config)` | `use-dca-lifecycle.ts:111-113` start iff a consent was given · `engine.createOrder(config)` |
| `:255` `onConfirm={confirmOrder} onCancel={clearPendingOrder}` (`OrderReviewModal.tsx:171/:182`) | `DcaCard.tsx:555/:558` → `use-dca-lifecycle.ts:130` `confirmOrder()` · `:136` `clearPendingOrder()` |
| `OrderReviewModal.tsx:62` `useOrderApproval(o.tokenIn, o.amountIn, chainId, isV3)` · `:158` approve | `DcaSignSheet.tsx:42` same four arguments · `:70` `approval.approve()` |
| `:295-296` `onCancel={cancelOrder} onCancelAll={cancelAllOrders}` · `DCADashboard.tsx:67` | `DcaCard.tsx:532-533` same · `DcaOrdersList.tsx:129/:172` |
| `:257` `onConfirm={confirmCancel} onCancel={clearPendingCancel}` | `DcaCard.tsx:565` same |
| `:895` consent opens → `stopWaitingSound()` | `use-dca-form.ts:356` `if (consentTier(info)) stopWaitingSound()` |
**2. Arg equality** (`dca-signing.test` 15 · `dca-cancel.test` 7; sequences `toEqual` v1): standard / offchain+consent / unpriced+consent → `[createOrder(cfg), confirmOrder()]`, equal cfg, approval args, sounds, toasts, 1 POST · approval-first: `approve()`×1 then the same · unticked consent → no call · 409 → review reopens (consent focused), `createOrder #2 = #1 + floorAck.unpriced` · rejection → **0 POST**, stop+cancel, text verbatim, retry re-sends the same object · API error → `confirmOrder`×1 under repeated press/Esc/Cancel · wrong network → `switchChain({chainId})`, no call · cancel `[cancelOrder('a1'), confirmCancel()]` = v1, Keep/Esc → `clearPendingCancel`, Cancel All `[cancelAllOrders(), confirmCancel()]`, no status flip before the event, no v2 fetch.
**3. Screenshots** (fixture props, real AppShell, no wallet): `34-frame-vs-v2.webp` frozen · `34-v2-signing-created-failed.webp` · `41-frame-vs-v2.webp` cancel · `41-v2-cancel-all.webp` · `m-v2-frozen-created-failed-cancel.webp` (375).
**4. Sounds** (v1 = v2 unless marked)
| moment | sounds | toast |
|---|---|---|
| form press, on-chain tier | touch · start (runs on into the EIP-712 review) | — |
| weaker tier → consent → Create | touch · start · stop · start (:825) | — |
| Approve / Confirm & Sign press | — | — |
| order_created / order_error / order_cancelled | stop·confirm / stop·cancel / cancel | `DCA order placed` / `DCA order failed` (`…temporarily paused`) / `DCA order cancelled` |
| review Cancel / Esc / draft change | **v2 stop** (v1 none) | — |
**5. a11y + edge** (`dca-a11y-edge.test` 20): one dialog frozen→signing→created (busy = `aria-disabled`, keeps focus; the outcome focuses the primary) · Tab trap · `aria-live` timeline · Esc/Cancel/backdrop dead while creating/signing, live on idle review (focus → CTA) / frozen (= `clearPendingOrder`) / created / failed · draft change (amount, buys, interval) closes the review, drops a frozen order, consent does not carry · double press → one call · silent abandon disarms · reduced-motion scan.
**6. Verify:** suite base 387/6179 → head 390/6221, 0 failed (`tests.txt`) · `eslint .` 93 = 93, 0 errors · tsc 0 · `next build` 0 (head, base) · rpc-budget guards green (in suite) · **v1 proof** (`v1-proof.txt`): diff 16 files, 1895 ins, 59 del (code + this file; images aside), only `src/ui/v2/dca/` + feedback; `isolation.test` green; route table 14 = 14; 0 v2-marked chunks in the 10 v1 routes; `/` and `/swap` **−99 B (−0.0036 %)**, other v1 routes 0 Δ; v2 routes +22 772 B. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-dca-signing

## Content-map delta (v1 → v2)
0 v1 strings lost: the sign sheet carries every OrderReviewModal row / note / button (`Approve {sym}` · `Confirm in wallet…` · `Approving…` · `Confirm & Sign Order` · `Cancel`), the cancel sheet every OrderCancelReviewModal string for both plan shapes (parity tests). **v2-only (goal word):** `View positions`. **Moved, v1's words:** the toasts' `DCA order placed` / `Your DCA is live — …` and `DCA order failed` / `DCA temporarily paused` + description also head the created / failed sheet; `Signing order...` (v1 form CTA while submitting) and `DCA order placed` as timeline steps; `Start DCA — N buys over D` (v1 form CTA) as the retry; `New DCA` (v1 tab) closes the outcome sheet. **Frame copy not used (v1 wins):** 34's `Every 1 day × 10 buys` + `86400 s interval` (v1 `86400s × 10 buys`), its Chainlink feed address (v1 DCA signs address(0)), its `1 APPROVE → 2 SIGN` dots (a timeline of v1 labels); 41's `CANCEL ORDER` (v1 `Confirm — Cancel Order`). **Not carried:** nothing new (the B7 list — ring, P&L, fills timeline, receipt — unchanged).
