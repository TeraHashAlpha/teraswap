# feat/ui-v2-swap-modals — feedback (B4)

Off origin/main `9e7aefa` (B3 merged). Dedicated worktree, real `npm ci`. No PR (owner opens it). SSH-signed, noreply. Code diff only under `src/ui/v2/**`; v1 components/hooks/lib/api untouched. Display only — no wallet action is sent (B5 wires Confirm → sign).
- [x] C1 `730c638` slippage (22) + token selector (23/m02) · [x] C2 Permit2 (25) + review (26/m03) + split/CoW (27) · [x] C3 route label + gas · [x] evidence 1–7 (final commit)

## Premises (recorded; owner answered in-session)
- **No `SwapReview*` exists.** Frame 26/m03 "Review Transaction" is v1 `TransactionPreview.tsx`; frame 27 is `SplitReviewModal.tsx` + `CowOrderReviewModal.tsx`. Owner: **add those three to read-only scope**, and the review sheet shows **frame 26's fields + the goal's extras** (slippage / fee / gas / tier line from the quote object).
- Also read for C3 (needed to find the "~0 ETH" cause, not in the list): `src/hooks/useEthGasCost.ts` — see C3.
- **Frame copy ≠ v1 copy** in 23 (chip "All", re-worded import notice), 25 ("How Permit2 approvals work", "TeraSwap uses Permit2…") and 27 (CoW box). Goal says v1 verbatim → v1 wins; frame structure/layout is kept, frame wording is not.
- **Environment event (not mine):** at ~13:04 the whole of `~/ts-worktrees/*` (this worktree and every sibling, incl. other branches' worktrees) was deleted by something outside this session while I worked. Branch refs and pushed commits are intact (`git for-each-ref`), but any uncommitted work in those worktrees is gone. I rebuilt this worktree and re-created the lost files from context; commits are pushed as they land.

## Findings so far
- v1 `SlippageModal`: an empty custom field + OK sets **0.01 %** (`Number('')`→0→clamped up). v2 disables OK / Enter on an empty field; the 0.01–15 clamp is otherwise identical (bounds unchanged, tested against v1's calls).
- v1 modals each hand-roll (or lack) focus handling; v2 has one `modals/Sheet` (trap, Esc, restore focus, bottom sheet ≤ 600 px) tested once.
- v1 `TransactionPreview` prints "Raw calldata (N bytes)" as `calldata.length / 2` **including the `0x`** → one byte too many (65 for 64). Copied as-is for parity; a v1 Low.
- v1 `format.ts` `fmtToken` goes through a float for bigints past 2^53 (a 30-digit amount prints with wrong low digits). The review/min-output display inherits it; the signed floor is `deriveMinimumOutput` (exact) — display only. Tested at 14 digits.
- B4 has no frozen tx: the review sheet renders the quote half from the card; Recipient / Validation / Selector / Raw calldata (v1's decoder) appear when B5 passes `pending`. Parity vs v1's TransactionPreview is run with `pending` supplied.
- **C3 cause of "~0 ETH" (Ethereum):** the KyberSwap adapter sets `estimatedGas: route.gasUsd ? 0 : route.gas` and puts the cost in `gasUsd`. Units 0 → `useEthGasCost.estimate(0)` = `{eth:0, usd:0}` (not null) → the `usd > 0` branch fails → `fmtGas(0)` = "0" → "~0 ETH". USD was never absent; it sat in `quote.gasUsd`, which nothing read. v1's QuoteBreakdown has the same shape (`gasEstimate?.(best.estimatedGas)`), so v1 shows the same line for a Kyber best — not touched here. Reproduced from the adapter's output shape (no live Kyber call).
- Route labels: allow-list `route-names.ts` (Velora's table + Dexalot); anything else → the source's own name; consecutive fallbacks read once.

## Auditor note — review / consent content
- Consent block = v1's OWN exports (`UNPRICED_CONSENT_HEADING`, `unpricedConsentCopy`, `UNPRICED_CONSENT_CHECKBOX`) with `{N}`/`{d}`/`{minOut}` computed as SwapBox does (integer-exact spread; `deriveMinimumOutput`). Gates Confirm; a 409 (`ackRequired`) voids a prior tick and `reviewOpen` reopens a cancelled sheet. Tier / ack / 409 / min output / Permit2 decision / slippage bounds unchanged.
- The displayed "Minimum output" is the bigint floor (display), the "ENFORCED ON-CHAIN" badge appears only when a frozen `pending.minimumOutput` via the FeeCollector is passed (B5). Confirm is a stub (`onConfirm` no-op in the card); nothing is signed or sent.
- CTA "Review swap" now opens the sheet (display only). Split / CoW sheets have no call site in the card yet (they need `useSplitSwap` / `useSwap` frozen plans): wired by props, tested, screenshotted via a temporary harness page (not committed).

## Evidence (files in `feat-ui-v2-swap-modals/`)
1. `{22,23,25,26,27-split,27-cow,m02,m03}-frame-vs-v2.webp` (round7 left, v2 right) + `26b-b4` (what B4 really shows: no calldata rows), `26c-unpriced`, `26d-single`. Captured from a temporary `/v2/modal-harness` page with fixture data (ETH→USDC 1 ETH; frame values differ), deleted before commit. 26/m03 use a garbage calldata so Validation shows v1's "Unknown selector" warning, not frame's "Validated". m02 = the token sheet on a phone (frame m02 is the quote page).
2. `tests.txt` § parity: Permit2, Split, CoW, TransactionPreview vs v1 on the same props — 0 missing strings (allow-list: decorative 🔑 ✓ ✗ ! ⚠ glyphs, v1's literal `&#9660;`); slippage = same copy + same call sequence; token list = same rows as v1's TokenSelector for browse + 3 searches.
3. `tests.txt` § consent/409 (review-sheet.test.tsx).  4. § route label + gas (quote-model.test.ts: 25-row route table, 12-row gas table).  5. § a11y (Sheet: trap both ways, Esc, restore focus, backdrop; every sheet: Cancel focus, Esc; token sheet: arrows/Home/End).
6. **Content-map delta (v1 → v2):** 0 v1 strings lost in the modals. Not carried over from the frames (not v1 copy): chip "All", "Pasted addresses are imported as "Imported"…", "How Permit2 approvals work", "Solvers compete in a batch auction…", "LEG 1 · VELORA" (v1: "Leg 1: Velora"). New v2-only words: "Imported" badge (v1's `category`), "Explorer" link on a colliding symbol (v1 had the badge's explorer link), "Native asset" kept. v1 differences: empty custom slippage no longer sets 0.01 %; Permit2 / consent / review Confirm is the one solid CTA and Cancel a text button (v1: outlined pills).
7. **v1 proof:** `v1-proof.txt` — route table identical (54), **0 v2-marked chunks in any v1 route**; v1 route chunk bytes: 8 of 10 unchanged, `/` −305 B, `/swap` +152 B (Turbopack regrouping, B1's module-identical standard); v2 routes +60 KB (the modals). 0 files outside `src/ui/v2/**` + feedback changed. Baseline origin/main `9e7aefa`: **362 files / 5805 tests → 368 / 5933** (all pass); eslint **93 = 93** warnings (0 in src/ui/v2); tsc 0; `next build` 0 both. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-swap-modals

## Concerns / open
- `~/ts-worktrees` wipe (see Premises): owner may want to check who/what cleans that directory.
- Test gap: split/CoW/Permit2 are unreachable from the card until B5; connected-wallet screenshots not taken (harness, not a real wallet). `next dev` rewrites `AGENTS.md` (reverted).
- Review sheet is taller than a 900 px viewport once calldata rows are present: it scrolls inside (title stays visible, `preventScroll` on open).
