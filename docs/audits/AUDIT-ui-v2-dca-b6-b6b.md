# AUDIT — ui-v2 DCA B6 (form + review) / B6b (create, sign, cancel)

| Pass | Date | Commit audited | Suite | Result |
|---|---|---|---|---|
| A70 | 2026-10-31 | origin/main `9096dc5` = PR #630 merge (tree `2644fc4`, identical to PR head `3813ab9`); PR #624 (B6) already in main | 395 files / 6271 tests passed | 0C / 0H / 1M / 2L — **approved** |

**Final verdict: `VERDICT: 0C/0H → approved`** (A70). The owner approved the result on 2026-10-31.

**How the pass ran:**
- Read-only, in a fresh detached worktree, with `npm ci` and the full suite run once.
- Severity uses C / H / M / L.
- The owner's rule for this audit: any value the v2 UI computes, instead of taking it from v1's draft, counts as at least H.

**Scope:**
- **v2:** `src/ui/v2/dca/**` with its tests, plus `src/ui/v2/modals/{Sheet,TokenSheet,ConsentSheet}.tsx`.
- **v1 counterparts:** `DCAPanel.tsx` (which contains `CreateDCAForm`), `OrderReviewModal.tsx`, `OrderCancelReviewModal.tsx`, `components/dca/*`, `useOrderEngine.ts` and `useOrderApproval.ts`.
- **Libraries and API:** `src/lib/order-engine/**`, the stand-in for the brief's `src/lib/orders/**`, which does not exist; it holds `createOrderInSupabase`. Also `api/orders/route.ts`, `api/dca-floor-cap/route.ts` and ADR-024.
- **Out of scope:** swap, landing and shell. Two shell files were read only to confirm the chain gate.
- **v1 untouched:** `git diff e097477 9096dc5` over every v1 order-path file is empty, so B6 and B6b changed no v1 code.

## Premise answers (owner, 2026-10-31)

1. **PR #630 was already merged** (`9096dc5`, 2026-10-30 20:18Z). The pass therefore audits origin/main at that merge commit; no virtual merge was needed.
2. **The brief said "DCA signs minOut = 1 wei (P1a)".** On v3 chains, which are the only chains where the DCA tab mounts (`isDcaLive` requires a v3 executor), v1 signs a derived floor from `deriveSigningMinAmountOut` (`DCAPanel.tsx:928-938`). `'1'` appears only on v1's non-v3 path (`:942`). **Owner: judge against v1 as-is.** Check A requires v2's minOut to equal v1's derived value.
3. **The brief said "the 409 parse fails CLOSED to `unpriced`".** In fact, a server sentence the parser does not recognise becomes a plain `failed` outcome. No order is created, because the server already refused. **Owner: rate this by what it actually does** (see L-1).

---

## Findings

**[M-1] `src/ui/v2/dca/use-dca-lifecycle.ts:153-155`, `src/ui/v2/dca/DcaReviewSheet.tsx:89-92`, `src/ui/v2/dca/use-dca-form.ts:285-363`**
- **Issue:** v2 builds v1's draft once, in `prepare()`, when the review opens. Two buttons later hand that cached draft to `createOrder`: Create after consent, and Retry on the failed sheet.
  - The draft carries the `minAmountOut` and `priceInUsd` from prepare time.
  - Retry also reuses the previous attempt's `floorAck`, including its old `acknowledgedAt`.
  - None of v1's guards run again.
  - `dca-signing.test.tsx:308` asserts that Retry re-sends the very same object.
- **What v1 does:** confirming consent re-runs the whole `handleCreate(ack)` (`DCAPanel.tsx:1209` → `:794-993`): `canCreate` (paused, depeg, oracle, schedule fit, submit block), the route check, a fresh `deriveSigningMinAmountOut` and the economic floor. v1 also clears the amount right after the freeze (`:994`), so after any failure the user has to press Start again. That is a full `handleCreate()` with a fresh tier request and fresh consent.
  - The draft key (`DcaCard.tsx:455`) leaves out the price inputs and the pair tier, so its comment "one key over everything `prepare()` reads into the draft" is not accurate.
- **Failure path:** the wallet rejects (`Signature rejected in wallet.`), or the order expires before signing, and the failed sheet stays open. Meanwhile the depeg check flips to block, the Chainlink integrity check fails, or the freeze-403 pause latches. The user presses Retry, `createOrder` receives the old config, and Confirm signs a floor derived before the gate closed, under the earlier consent. v1 would refuse.
- **What still protects the user:**
  - The server requires an acknowledgement at least as strong as its own tier (`floorAckCovers`).
  - The server rejects consent older than 24 hours, and enforces the pause and the dust floor.
  - The keeper's price quorum checks every fill (ADR-024).
- **What is not protected:**
  - The client-only depeg and oracle gates.
  - A stale signed floor. That is the INC-2026-08-07-001 class: an order that can never fill.
- **Fix:**
  - Have Create and Retry call `prepare()` again (v1's `handleCreate(ack)`) and pass its fresh draft to `createOrder`.
  - Retry should return to the review with consent unticked.
  - Replace the same-object assertion with one that requires a fresh draft and a fresh consent.

**[L-1] `src/ui/v2/dca/dca-model.ts:215-219`**
- **Issue:** `requiredTierFromError` returns `null` for a 409 sentence it cannot match. The outcome becomes `failed`, and Retry re-sends the same acknowledgement, which is too weak.
- **Failure path:** if the server's wording in `api/orders/route.ts:551` changes, every 409 becomes a failure sheet. Each Retry costs another wallet signature and another 409, in a loop. No order is created at any point.
- **Fix:** treat any error starting with `Acknowledgement required` whose tier cannot be parsed as `unpriced`, and reopen consent for it. Also carry `requiredTier` through the API client (the library follow-up already noted in `docs/feedback/feat-ui-v2-dca-signing.md`).

**[L-2] `src/ui/v2/dca/dca-model.ts:150-151`**
- **Issue:** two form button states exist only in v2 and are not listed in either content-map delta (`docs/feedback/feat-ui-v2-dca.md:39`, `docs/feedback/feat-ui-v2-dca-signing.md:23`):
  - `Connect wallet`. v1 renders RainbowKit's `ConnectButton`.
  - `Switch to {chain}`. v1's DCA form has no wrong-network state; the string itself is v1's `MissionControlCard` button.
- **Failure path:** two invented strings ship without being recorded as invented.
- **Fix:** add both to the content-map delta.

---

## Verified OK

- **A — Order equality.**
  - `buildDcaDraft` (`dca-model.ts:87-105`) matches v1's config (`DCAPanel.tsx:972-991`) field for field.
  - `prepare()` (`use-dca-form.ts:286-362`) uses v1's library calls in v1's order (`DCAPanel.tsx:795-990`). That includes `deriveSigningMinAmountOut` on v3 (`:336` = `:929`), which follows premise answer 2.
  - It is two-phase, as in v1: `createOrder(config)` (`use-dca-lifecycle.ts:113`), then the sign sheet renders the engine's `pendingOrder`, then `confirmOrder()` (`:130`).
  - Nonce, expiry, owner and the EIP-712 typed data all come from v1's engine (`useOrderEngine.ts:713-753`, `:856-896`). There is no separate recipient field: the owner receives.
  - The tests deep-compare v1 and v2 with real harness prices (`dca-harness.tsx:90-91`), so `minAmountOut` is actually compared (`dca-signing.test.tsx:143-215`).
- **B — Gates and consent.**
  - **Tier:** asked of the server afresh at `prepare()` (`use-dca-form.ts:331`).
  - **Consent:**
    - Shown for both weaker tiers (`DcaReviewSheet.tsx:71-73,120`).
    - Create stays disabled until the box is ticked (`:80,131`).
    - The box starts unticked (`:75`), and nothing is stored in browser storage.
  - **Cap:** formatted by v1's `floorConsentCopy`, clamped at the $250 ceiling (`DcaFloorConsentDialog.tsx:43-44`). A null cap shows the ceiling, as in v1 (`DCAPanel.tsx:1203-1209`).
  - **409:** reopens consent for the server's tier, never a weaker one (`use-dca-lifecycle.ts:61-66`, `dca-model.ts:196-200`, `dca-signing.test.tsx:344-375`).
  - **Ethereum gate:**
    - `AppShell.tsx:39` mounts the card only when `isDcaLive(chainId)` (`dca-launch.ts:59-65`).
    - `chainId` comes from `useQuoteChainId`, which is the wallet chain when connected.
    - `/v2/[tab]` passes no children.
- **C — Signing hygiene.**
  - **No raw wallet access:** no `window.ethereum`, key material or browser storage in `src/ui/v2/dca`. The only signer is the engine's `signTypedDataAsync`.
  - **Double presses:** `use-dca-lifecycle.ts:105,127`, the engine's `creatingRef` mutex (`useOrderEngine.ts:793-794`) and the sheet's `aria-disabled` busy state (`DcaSignSheet.tsx:147`).
  - **Cancel / Esc while frozen:** calls `clearPendingOrder`, and nothing is posted (`dca-a11y-edge.test.tsx:197`).
  - **API error:** exactly one `confirmOrder` (`dca-signing.test.tsx:315-335`).
  - **Wallet rejection:** stops the waiting sound and plays the cancel sound (`DcaCard.tsx:494-496`).
  - **Draft change under the sheet:** resets and closes it (`DcaCard.tsx:455-463`, `dca-a11y-edge.test.tsx:236-265`).
  - **Chain change:** remounts the card (`key={chainId}`), which resets the engine.
- **D — Cancel path.**
  - The same engine calls as v1: `DcaCard.tsx:445,532-534,565` matches `DCAPanel.tsx:181-186,257,295-297`.
  - Nothing is removed optimistically (`dca-cancel.test.tsx:178`).
  - The cancel sheet carries every string of `OrderCancelReviewModal`, for both plan shapes.
- **E — Chain-awareness.**
  - The only address in v2 is v1's zero-address `priceFeed` (`dca-model.ts:97`). No executor address is hard-coded.
  - Approval uses the frozen chain (`DcaSignSheet.tsx:42` = `OrderReviewModal.tsx:62`).
  - Floor and cap requests use the card's chain (`use-dca-form.ts:142,331`).
  - Explorer links use `order.chainId ?? 1` (`DcaOrdersList.tsx:73,122` = `DCAOrderCard.tsx:126`).
- **F — Display.**
  - Amounts go through `fmtToken` / `fmtAmount` on bigints (`DcaCard.tsx:421,427-428`, `DcaSignSheet.tsx:49,94-95`).
  - The Protection row and tier labels are v1's `FLOOR_TIER_BADGE` and `floorTierHint` (`dca-model.ts:171-182`).
  - `Below minimum buy` (`feat-ui-v2-dca.md:11,39`) and `View positions` (`feat-ui-v2-dca-signing.md:23`) are listed in the delta. The only unlisted strings are L-2.
- **G — Tests.**
  - Equality is a deep equal that masks only `acknowledgedAt` (`dca-signing.test.tsx:100-106`).
  - An unticked box reaches no hook (`:221-229`).
  - v2 builds no typed data, so the fake engine cannot hide a wrong field.
  - The gap is Retry, which is pinned to the cached object; M-1's fix covers it.

## Verdict

`VERDICT: 0C/0H → approved` — with 1M (M-1) and 2L (L-1, L-2) as follow-ups.
