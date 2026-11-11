# Feedback: fix/ui-v2-walkthrough-polish
- [x] C1 mute all sound  - [x] C2 landing boundaries  - [x] C3 no em dash  - [x] verify (full run on final head)

## 1. Mute
`src/lib/sounds.ts`: one `soundEnabled` (default on). Off: MP3 players, 10 synths, waiting + background start return before any
`Audio`/`AudioContext`; `toggleBackgroundMusic()` also stops music and a waiting loop. No caller changed. v1 `BackgroundMusic` and v2
`MusicToggle` read "Mute sound"/"Unmute sound" (v1 got `data-v1-sound-toggle`: the v2 hide rule keyed on the old label). Tests:
`src/lib/sounds.mute.test.tsx` (table over every export, loop stop, on again, v1 button), `src/ui/v2/shell/sound-mute.test.tsx` (v2).

## 2. Landing
Cause: hero, Performance, Why, CTA were `ts-v2-opaque` bands with a static still and no `data-ts-narrative`; they covered the photo
stack, so their boundaries were hard cuts. Fix: all 9 sections are narrative sections, photos are stack layers (same files, veil,
900 ms, no new timing), `.ts-v2-rv` reveal, stack starts on the hero photo; a short last section (docs) never reached the 40 % line
at 1440x900 and stayed invisible, so it counts once wholly in view. Frames `~/ts-worktrees/ui-v2-walkthrough-polish-frames/b{1,2,8}-*`
(layer opacity out/in at +150/+450 ms): 1440 b1 .83/.17 .02/.98, b2 .80/.20 .01/.99, b8 .87/.13 .02/.98; 375 b1 .94/.06 .15/.85,
b2 .94/.06 .17/.83, b8 .96/.04 .27/.73. Test: every `main > section` has the hook, none opaque; contrast re-run for 9 sections.

## 3. Em dash: string nodes before -> after, 484 in 107 files -> 0 (`*` = 1 left: console log, or exempt privacy note)
39: DocsPage DocsTabV2 | 24: SwapBox | 22: DcaCard | 21: DCAPanel* | 13: QuoteBreakdown | 12: LandingBelowFold Sections | 11:
ConditionalOrderPanel LimitOrderPanel SettlementReceiptModal ReceiptSheet | 10: QuotePanel | 9: GateNotices | 8: OrderCancelReviewModal
SwapButton useSwap* DcaCancelSheet positions-model | 7: useSplitSwap quote-model | 6: SplitReviewModal failed-reason SwapCard | 5:
useOrderEngine constants* minimum-output DcaSignSheet SplitReviewSheet ExecutionPanel gates | 4: OrderReviewModal DCAFillsTimeline
depeg-gate help-content order-engine/config review-model | 3: page AdminMonitor CowOrderReviewModal PortfolioTab TokenSelector
DCAPositionStats api fetch-json simulation TokenSheet lifecycle-view | 2: app/layout ExecutionTimeline OrderDashboard Permit2EducationModal
SwapUnpricedConsentDialog TokenAddressBadge DcaFloorConsentDialog product-claims* adapters/shared canonical-route dca-custom
CowOrderReviewSheet Permit2Sheet ExecutionHistory OrdersTab cta | 1: the other 41 files (docs/status layouts, enable-form, BetaBanner,
DigitRoller, WalletModal, WalletSessionGuard*, format, wagmiConfig, read-auth, HistoryTab, AccountPanel, use-dca-form, ...). All after 0.
10 samples: "Swap blocked — oracle data unsafe." -> "Swap blocked: oracle data unsafe." | "paused — your existing ones keep running" ->
"paused. Your existing ones keep running" | "routing — you get whichever" -> "routing. You get whichever" | "Every other route —
APIs (Curve) — is a public-mempool tx" -> "route, APIs (Curve), is" | "exchange rate — likely a depeg" -> "rate, likely a
depeg" | "instead — it checks each buy" -> "instead. It checks each buy" | "TeraSwap — The Gold Standard" -> "TeraSwap: The Gold
Standard" | "Aggregation value: —" -> "...: n/a" | `${a} – ${b}` -> `${a} to ${b}` | "then sign — no infinite approvals" -> "then sign: no".
Empty value = `n/a` (owner may pick another word); spaced range "to"; never a hyphen. Guard
`src/ui/v2/__tests__/no-em-dash.guard.test.tsx`: AST scan + claims/help values + renders of v1 /docs, v2 /v2/docs (3 chains), v2 landing
(found DISABLED_SOURCES reasons on Docs, fixed). ONE exemption `PRIVACY_TERMS_EXEMPT` (privacy/terms pages, layouts, `PRIVACY_*`
claims); comment names `fix/privacy-no-usage-tracking` as the branch that removes it. Left on purpose: 4 `console.*`, API routes/monitors/
alerts (no API change), calldata/post-execution validator reasons (gates). Other routes: AST net only, not rendered.

## Further reads: NarrativeStack, PhotoCredit/Footer, DocsPage, lib/constants.ts, agent-verify.sh, claims + state scripts.

## 4. Verify, `agent-verify.sh --codeql` on head 0583c0f (base 0062400); later commits are docs-only
suite 10368 pass/0 fail | lint +0/+0 (60/60) | tsc 0 | build ok | parity 111 | rpc-budget 33 | CodeQL 13 vs 13, 0 new | state check ok
Diff 296 files, +2267/-1567. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/ui-v2-walkthrough-polish (no PR)
