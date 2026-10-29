# Feedback — feat/ui-v2-dca (B6a: DCA form + review + orders, display only)

Branch off `origin/main` 320cc26, 5 signed commits (C1 `355646b`, C2 `4c01cdb`, C3 `fd6307f`, C4 = CSS fix + this file, C5 = owner answers: v1-only Protection strings, gate from v1 source). Only `src/ui/v2/**` + `docs/feedback/`. No signing, no submission, no wallet (the review's `Create DCA` is a stub handing the acknowledged draft to `onCreate`; B6b wires it).

## Checklist
- [x] C1 form + Protection line · [x] C2 review sheet + consent + Positions · [x] C3 chain gate + sounds + a11y · [x] evidence 1-7

## Premise deltas — v1 won (owner answers recorded below)
1. v1's DCA form state is inline in an unexported `CreateDCAForm` (DCAPanel.tsx), not hooks: `use-dca-form.ts` restates it over v1's own hooks/lib; `dca-card.test` proves the draft equal to v1's `createOrder` config.
2. v1 amount = **"Total to spend"** with **25/50/100 %** (no "per run", no MAX) — kept.
3. **No "Over cap" form state in v1**: the cap is applied per fill by the keeper and disclosed by the consent/hint — not invented as a block. "Below floor" = v1's `formatMinBuyMessage` inline + CTA `Below minimum buy` (new label); `Insufficient balance` (swap's wording) disables only when the balance is KNOWN short (v1 doesn't gate).
4. DCA tiers are `onchain-feed / offchain-price / unpriced`, not `priced / single-source / unpriced` (`{d}`/`{minOut}` don't exist in DCA copy; `{N}` and the cap do). v1 asks consent for **both** weaker tiers — kept; the "amber line" = v1's `floorTierHint` (amber).
5. v1 has no "Protection" row; value = v1's badge labels (`Off-chain check` / `No price source`) only. 409 isn't handled on v1's form (toast): `reopenTier` is pure, B6b feeds it the 409 `requiredTier`.
6. Documented difference: v1 keeps the waiting sound into signing; v2 stops it when the review is ready (nothing to wait for).
7. Not carried: v1's ring/stats/P&L/fills timeline, settlement receipt (**pending B7**), EIP-712 modal (B6b).

## Owner answers (2026-10-29) — applied in the follow-up commit
- 1/3/4/6 accepted; amount = total with 25/50/100 %, NO MAX chip; no Over-cap state.
- 5: every Protection string is v1's own. v1 has no label for `onchain-feed` (FloorTierBadge renders nothing) → v2 shows **no row and no hint** there; "On-chain price feed" (frame copy) removed. Test asserts it is absent. No frame copy anywhere.
- 7: **B6b note — the waiting sound plays from the CTA press until settle, exactly as v1** (`startWaitingSound` at press; stop on order_created / order_error / early exits). B6a stops it when the review is ready only because nothing is signed.
- 8: ring, per-position P&L, fills timeline, settlement receipt → **pending B7** (Orders/History + DCA positions parity), must return before launch.
- 9: gate text/buttons now derive from v1's source: `DCA_CHAINS` named by the registry joined with " and ", shown when `isDcaLaunchEnabled() && !DCA_CHAINS.includes(chain)` (v1 page.tsx `dcaWrongChain`). Reads "DCA runs on Base and Arbitrum One." whatever is live. Tests: v1 ComingSoonPanel's chain ids == `dcaGateChainIds()`, names equal, predicate equal over flag × chain.

## Evidence
1. **Frames** (round7 CHANGELOG → `app/desktop`): 30a ethereum gate, 30b not-connected Base, 31 create, 32 inline warnings, 33 consent modal, 34 EIP-712 (B6b), 35 positions; `app-mobile-src/app/mobile`: m04 create, m05 Ethereum. **Screenshots** `docs/feedback/feat-ui-v2-dca/{desktop-1440,mobile-375}-{1 gate,2 form,3 amount+tier,4 positions}.png` — real `next start`, disconnected, the `/api/dca-floor-cap` answer **mocked by the rig** (unpriced, cap 250); review/consent sheets not screenshotted (need a wallet) — covered by DOM tests.
2. **Parity** (`dca-card.test` §2): v1 create tab ⊆ v2, 0 missing; allow-list = 3 glyphs/`Start DCA — …` (owner's "Review DCA"). Empty state parity in `dca-review.test`.
3. **Draft equality**: 4 control scenarios + both weaker tiers (floorAck stripped, tier equal).
4. **Consent/409/cap/floor**: `dca-review.test` (gate, v1 words with real {N}/symbols/cap, 409 reopen, weaker 409 ignored), `dca-card.test` §4.
5. **Gate + sounds**: `dca-gate-sounds.test` + `shell.test` — v1 sentence/buttons/chain list equal; every action and engine event records the same sounds + toasts as v1:

| action | v1 | v2 |
|---|---|---|
| chip / quick-fill / Custom | playClick | same |
| CTA, weaker tier | playTouchMP3, start, stop (dialog) | same (review) |
| CTA, on-chain feed | playTouchMP3, start | + stop (delta 6) |
| order_created / dca_execution / order_filled / order_cancelled / order_error | stop+confirm / confirm / confirm / cancel / stop+cancel | same + same toasts |
| Cancel / Remove | playClick | same |

6. **Content-map delta** vs v1: + `Below minimum buy` (derived copy, owner-accepted), `Insufficient balance`, `Review DCA` (replaces `Start DCA — N buys over D`), `Create DCA`, review row labels (v1's labels); Summary always visible (`—` when empty); autonomous notice moved under the CTA (text verbatim); chevron/arrow glyphs aria-hidden; sub-tabs underline; **pending B7**: countdown ring, per-position P&L stats, fills timeline, settlement receipt (shown in v1 today; not dropped). Protection row/hint absent for `onchain-feed` (as v1).
7. **Verify**: suite 380 files / 6128 tests green (origin/main 377 / 6068; +60 new); lint 91 = 91, 0 errors; `tsc` clean; `next build` exit 0; rpc-budget guards green (in suite); **v1 module-identical**: `git diff origin/main...HEAD` touches nothing outside `src/ui/v2/**` + `docs/feedback/` (0 files in src/lib, hooks, app, components), `isolation.test` green. Diff: 13 files +2455/−2 before C4. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-dca
