# feat/ui-v2-swap-lifecycle — feedback (B5)

Off origin/main `a61d9d6`. Signed, noreply, no PR. Diff only `src/ui/v2/**` + this file/folder. C1 `a6cbe52` Confirm → real hook path · C2 `47bf2bc` pending/success/failure/wrong-network/toasts/sounds · C3 `4e91bb1` a11y + edge · this edit = evidence.
**AUDITOR-NOTE:** wires the real sign/send path — review with B6 before the v2 flag reaches production. Tests mock wallet/RPC; no wallet connected, no transaction sent.

**Premises that did not hold (owner answered; answers supersede the goal):** (1) no `TransactionStatus*` in v1 — 28a/b/c built from SwapButton labels + toasts; (2) v1's `anyBlocked` gates live in SwapBox handlers → **mirrored incl. consent checkboxes**; (3) split unreachable → **`useSplitRoute` + v1 toggle copy wired**; (4) no v1 "quote updated" notice → **v1 behaviour: trade key changes → review closes, hooks reset**.
**Extra read-only v1 reads:** `SwapUnpricedConsentDialog`, `SplitRouteVisualizer`, `useSplitRoute`, `useDepegCheck`, `lib/{price-gate,chainlink,swap-usd-estimate,executable-sources,mev-savings}`. Screenshots: temporary uncommitted harness (real B5 components in the real `AppShell`, fixture props, left card static) — not the live hooks.

**Findings:** (a) 409 equality test caught `{unpricedAck}` being gated on the client tier (fixed C1). (b) v1 leaves the `waiting` loop running after a cancelled review and after an approval error; v2 stops it (rows below). (c) v1 overwrites the loading-toast id on `cow_signing→cow_pending`, leaving the first sticky; v2 dismisses it. (d) v2 success/history/toast use the quote — and the USD price behind the "you saved" line — frozen at Confirm; v1 reads the live `meta` at settle (`SwapBox.tsx:372-411`), so it is NOT frozen: identical unless a re-quote/price tick lands mid-flight, which v2 now never shows (`frozen-amounts.lifecycle.test.tsx`, 3 tests, fail against the live read). (e) 9O fallback shown from `fallbackNotice`; the failed timeline step is inferred from the last in-flight status (display only). (f) Mobile: the ♫ fab overlaps Cancel in the bottom sheet (shell fab placement, not B5). (g) v1's blocked-handler `trackWalletActivity` is unreachable (button disabled) — guard mirrored, tracking not.

## Evidence (`feat-ui-v2-swap-lifecycle/`)
**1. Call sites** (v1 `SwapBox.tsx` → v2 `swap/lifecycle/use-swap-lifecycle.ts`)
| v1 | v2 |
|---|---|
| `:699` `executeSplitSwap(splitResult.bestSplit)` / `:743` `…, { unpricedAck: true }` | `:89-90` same two calls |
| `:703` `executeSwap(best, orderExecutableFallbacks(meta, best, chain))` / `:745` `…, { unpricedAck: true }` | `:93-95` same, ack only when consent produced it |
| `:692-693` `startWaitingSound(); if (!approvalReady) { await approve(); return }` | `:110-113` same order |
| `:696` unpriced & no ack → stop sound, open dialog, return | `:117-119` same (review sheet / consent sheet) |
| `:1269` `onConfirm={confirmSwap}` · `:1281` `confirmCowOrder` · `:1294` `confirmSplitPlan` | `SwapCard.tsx:410`, `:674`, `:671` |
| `:1270/1281/1295` `onCancel={reset…}`; `:751-752` consent cancel resets the raising hook | `use-swap-lifecycle.ts:128-` `cancel` |
**2.** `swap/lifecycle/confirm-path.lifecycle.test.tsx` (14): v1's SwapBox and v2's card on the same mocked hooks; args/order/count equal for standard, approval-first, unpriced no-ack (no call), ack (`{unpricedAck:true}`), CoW (`execute('cowswap')` + `confirmCowOrder`; ack), split (`execute(bestSplit[,ack])`, 2 legs), 409 single + split (reopens unticked, Cancel resets raising hook). `gates.lifecycle.test.tsx` (16) incl. v1 `SwapButton` label parity for all 7 block reasons.
**3.** `{28a,28b,28c,29,05,m03,m03-success}-frame-vs-v2.webp` (round7 frame left, v2 right; 05 shows the 3-toast cap by design).
**4. Sounds** (`sounds-toasts-parity.lifecycle.test.tsx`, v1 and v2 driven through identical statuses → equal sounds + toasts)
| moment | sounds (v1 = v2) | toast |
|---|---|---|
| Swap/Approve pressed | touch · `startWaitingSound` (v2: touch also on "Review swap"; loop starts once) | — |
| broadcast / CoW sign / submitted | — | loading `Transaction pending...` / `Signing CoW order...` / `CoW order submitted — …` |
| success | `stopWaitingSound` · `playSwapConfirmMP3` | `Swap confirmed!` + tx (chain-aware) |
| failure / rejection | `stopWaitingSound` · `playCancelOrderMP3` | `Swap failed` |
| split ok / partial / error | stop · confirm / cancel / cancel | `Split swap complete!` / `…partially complete` / `…failed` |
| **re-quote / price tick after Confirm** | v1 live `meta` at settle · **v2 frozen at Confirm** (sheet, toast, history `amountOut`, savings line) | `Swap confirmed!` shows the confirmed amount |
| **approval error** | v1 none · **v2 stop** | `Approval failed` |
| **review cancelled** | v1 none · **v2 stop** | — |
**5.** `a11y-edge.lifecycle.test.tsx` (19): focus stays in the one dialog through approving→simulating→frozen (busy Confirm is `aria-disabled`), 409 focuses the consent, Esc/Cancel/backdrop dead while approving/preparing/simulating and live when idle/frozen/error, stale-trade auto-close (amount, chain, frozen review; no resurrection), focus handed to Execution, `aria-live` timeline, reduced-motion CSS scan.
**7.** Suite base 368 files/5933 tests → head **375/6046**; `eslint .` 93 = 93 (0 errors); tsc 0; `next build` 0 both. v1: route table 55 = 55, **0 v2-marked chunks in v1 routes**, v1 routes unchanged except `/` and `/swap` first-load (`route-bundle-stats`, uncompressed JS) **+1 302 B = +0.0492 % (base 2 648 301 B) / +0.0494 % (base 2 634 693 B)**, inside the ≤ 0.05 % rule; not CtaButton (`src/ui/v2/swap/`, no v1 importer): the same +1 302 B is already there at C1 `a6cbe52` and at C3 `4e91bb1`, i.e. before the CtaButton commit — it is Turbopack re-partitioning the shared v1 hook chunks once the v2 chunk graph imports `useSwap`/`useSplitSwap`/`useSplitRoute`, which the goal requires; no v2 code in v1 chunks (0 v2 markers in the 9 v1 routes); module-identical: no file outside `src/ui/v2/**` + feedback changed (`git diff --stat`: 40 files, +3 152/−66). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-swap-lifecycle

## Content-map delta (v1 → v2)
0 v1 strings lost on the covered states. **Not carried:** Share button (`Share — saved X%` / `Share swap`, not in frame 28b or the goal); `🛡` glyph on the server-guard banner; v1 `fixed` centred modals (→ sheets). **Frame copy not used (v1 wins):** loading title `Executing swap…` (v1 `Transaction pending...`), `Sent/Received/Via` rows (v1 arrow line `1 ETH → 2 487.6842 USDC`), `You saved ~X vs second best` (v1: CoW realised-surplus line only), `Transaction reverted / No funds left…` (v1 error text), `Wrong network` toast + `Switch to Base` (v1: no toast, label `Switch to Ethereum` = SwapButton's). **v2-only:** `Execution` eyebrow, `New swap` and `View on explorer ↗` (goal-specified; v1 `View on Etherscan ↗`), explorer name per chain (`Transaction sent — track on Arbiscan ↗`), consent sheet wrapper (v1 strings). **Changed:** CTA states render as status-colour text (one filled shape per screen); Confirm label follows the hooks (`Approve & Swap` … `Confirm & Sign`).

## Follow-up before push (owner, 2026-10-28)
1. **Receive amounts** — v1 is *not* frozen (`SwapBox.tsx:372-411` reads live `meta`, `tokenOutPriceCheck.chainlinkPrice` at the settle render); the owner's invariant ("a re-quote mid-flight never changes what is shown as executed") is what v2 implements, now also for the USD price in the savings line. Test: quote 2 487.6842 → 2 399 after Confirm → sheet, toast, history row keep 2 487.6842; Chainlink 2490 → 1 → savings line keeps `$12 450`. Parity row added above. A v1 fix (freeze at Confirm) is a separate v1 goal if wanted.
2. **First-load** — numbers and bisect in evidence 7; CtaButton did not cause it, unavoidable while v2 imports v1's hooks.
3. **unpricedAck gated on client tier in v1?** **No.** `confirmUnpricedSwap` passes `{ unpricedAck: true }` unconditionally (`SwapBox.tsx:743` split, `:745` single/CoW); the tier only gates *asking* for consent (`:696`, `:725`), and the dialog also opens on the hook's 409 (`:672`). The bug was v2-only (a `a.unpricedPair && …` guard I wrote). No v1 edit needed.
