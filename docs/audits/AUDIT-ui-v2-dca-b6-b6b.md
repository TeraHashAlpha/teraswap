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

---

## A70b — re-check of the A70 fixes (2026-10-31)

| Pass | Date | Commit audited | Suite | Result |
|---|---|---|---|---|
| A70b | 2026-10-31 | `fix/ui-v2-dca-audit-fixes` head `e17fd87`, which already contained origin/main `8c1683c` (no merge needed). Later merged unchanged as PR #633 (main `0a642a9`; `src/ui/v2/dca/**` identical to `e17fd87`) | 395 files / 6281 tests passed | 0C / 0H / 0M / 3L — **approved** |

**How the pass ran:** read-only, in a fresh detached worktree at `e17fd87`, with `npm ci` and the full suite run once. The owner approved the result on 2026-10-31. Line numbers below are at `e17fd87`.

**What changed:** 11 files, all under `src/ui/v2/dca/**` or `docs/feedback/`. No v1, `src/lib` or `src/hooks` file changed.

### Prior findings

| Prior | Status | Evidence | Proving test (`dca-signing.test.tsx`) |
|---|---|---|---|
| M-1 | closed | `use-dca-lifecycle.ts:98-136`: `run()` calls the form's `prepare()` again and hands `createOrder` the draft it just built (`:129`). Create (`:147-154`) and Retry (`:161-168`) both go through it, and the hook no longer stores a draft or an acknowledgement. `use-dca-form.ts:304-305` re-runs the gates. With an `ack` it skips the server tier request, as v1 does (`:350`, v1 `DCAPanel.tsx:890`), runs `deriveSigningMinAmountOut` again (`:355`) and builds a fresh `floorAck` (`:380`). `DcaReviewSheet.tsx:90-93` hands over only the ticked tier; `DcaCard.tsx:551,564` pass `form.prepare`. | `:357` a gate (depeg) closes before Retry → no second `createOrder`. `:415` the price moves 2500 → 2600, and Retry signs a `minAmountOut` equal (as bigint) to v1's derivation and to v1's own `createOrder` config. `:437` Retry returns to the review with the box unticked; the old acknowledgement is not reused. `:383` the tier moves before Create → consent reopens unticked, no `createOrder`. |
| M-1, frozen order (owner-accepted design) | holds | The sign sheet shows the engine's `pendingOrder`, or the copy taken at the Sign press (`use-dca-lifecycle.ts:79,173`). The engine signs `p.order` exactly as frozen (`useOrderEngine.ts:753,795-798`). A price-only change never drops a frozen order (`use-dca-lifecycle.ts:212-213`). Any later Retry calls `prepare()` again. | `:407` a price change while frozen → the sign sheet stays, one `createOrder`. `:399` a price change closes the review. |
| L-1 | closed | `dca-model.ts:227-232`: an error that starts `Acknowledgement required` but does not parse reopens consent at `unpriced`; any other error stays a plain failure. Wired at `use-dca-lifecycle.ts:61`. The start-of-string match is safe because the API client throws the raw `json.error` (`src/lib/order-engine/supabase.ts:152`) and the engine only truncates it at 120 characters (`useOrderEngine.ts:984`). The optional second half of the A70 fix, carrying `requiredTier` through the API client, is not in this branch and remains the library follow-up. | `:504` pure matrix. `:516` an unparsed sentence → `unpriced`, fresh acknowledgement, no Retry. `:538` any other 409 → plain failure, and Retry asks for consent again. |
| L-2 | closed (the docs option, owner-accepted) | `docs/feedback/feat-ui-v2-dca.md:39` and `docs/feedback/feat-ui-v2-dca-signing.md:23` now list `Connect wallet` and `Switch to {chain}`. | n/a |

### Regression sweep (A70 sections A, B and C)

- **A — Order equality.** `buildDcaDraft` is unchanged (`dca-model.ts:87-105`). `floorAck` is now built inside `prepare()`, with v1's shape and position (`DCAPanel.tsx:903,990`). The two-phase flow (`createOrder`, then the sign sheet, then `confirmOrder`) is unchanged, and nonce, expiry, owner and typed data still come from v1's engine.
- **B — Gates and consent.** `prepare()` runs the gates in v1's order (`DCAPanel.tsx:795-965`). The $250 cap ceiling, the consent copy and `reopenTier` are unchanged. The 409 parser is unchanged; L-1 only adds the fallback.
- **C — Signing hygiene.** `sign` and `cancelSign` are unchanged. `setCreating(true)` runs before the first `await` (`use-dca-lifecycle.ts:101`), so a double press is still ignored. Retry produces a new frozen order and needs a new Sign press, so an API error never resubmits on its own.
- **Scope:** nothing changed outside the three findings.

### New findings

**[S-1] L — `src/ui/v2/dca/dca-signing.test.tsx:371-377`**
- **Issue:** the test "Create, a gate closed since the review opened (oracle)" never presses Create. Setting the oracle price to `null` also changes the price key, so the review closes (`DcaCard.tsx:466`) before the `if (create)` click.
- **Failure path:** a regression that skipped the gates on Create would still pass. Only Retry's gate path (`:357`) is proven by a test.
- **Fix:** flip a gate that is not part of any key (depeg `mode: 'block'`) while the review is open, assert the review is still open, then press Create unconditionally and assert that `createOrder` was never called.

**[S-2] L — `src/ui/v2/dca/DcaCard.tsx:461-466`, `:416`**
- **Issue:** a price change while the order is being created, is frozen, or is being signed is absorbed without closing anything: the key moves on and `reset` does nothing in those phases. A review that reopens afterwards (a 409 at `use-dca-lifecycle.ts:61`, or a tier change at `:119`) prints the floor of the old draft.
- **Failure path:** the order freezes at 2500, the price moves to 2600 while the wallet prompt is open, and the server answers 409. The review now shows the floor derived at 2500. Create then calls `prepare()` again and freezes the 2600 floor, and the EIP-712 sheet shows the correct value, so the wrong floor is never signed.
- **Fix:** store the `priceKey` on `PreparedReview`, and close or rebuild the review whenever it differs from `form.priceKey`.

**[S-3] L — `src/ui/v2/dca/use-dca-lifecycle.ts:117`, `src/ui/v2/dca/use-dca-form.ts:349-350`**
- **Issue:** with an acknowledgement, Create checks it against the tier cached when the pair was selected (`pairFloor`). v1 never consults that cached tier: it uses the acknowledged tier as it is (`DCAPanel.tsx:890`, `tier = ack`).
- **Failure path:** the tier lookup at selection fails, so the cached tier is `unpriced` (any lookup failure classifies as `unpriced`). Review asks the server again and gets `offchain-price`. The user ticks the box and presses Create, and consent reopens at `unpriced` with the stricter copy and cap. It never asks for less than the server requires, but the feedback file's "v1 parity" claim for this path is not accurate.
- **Fix:** with an acknowledgement, compute the required tier from the review the user actually ticked plus any 409 tier, or trust the acknowledgement as v1 does.

### A70b verdict

`VERDICT: 0C/0H → approved` — M-1, L-1 and L-2 closed; 3L (S-1, S-2, S-3) as follow-ups.
