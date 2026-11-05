## Feedback — feat/ui-v2-mobile-parity · last v2 slice before the full v2 Auditor + prod flag · DRAFT PR
Premise false → asked, owner answered (supersedes the goal): (1) Limit/SL-TP stay "Soon" in v2 (AppShell mounted the
skeleton; v1's panels were 100 % missing); (2) DCA gate gets v1's teaser copy verbatim; (3) Swap "Coming Soon on
<chain>": record, don't add. Also ruled: (4) A69b/A70b S-1 are test-gap findings (code already correct) → mutation
proof accepted for "fails on main"; (5) S-2 superset formula stays.
Commits b53a043 · bc36226 sweep · 74b99e5 mobile · e177073 Lows; SSH-signed, noreply.
1. Parity `__tests__/parity-sweep.test.tsx` (39 tests): v1 text ⊆ v2, links ⊆ v2 → 0 missing, 0 stale allow, chains
   1/8453/42161: Swap 67–77 v1 nodes, Portfolio 21–34, DCA card 44–57, DCA gate 9, Orders ×3 lists 29–98, History 67
   (+5 links), Analytics 208 (+10), landing 139 (+2). Limit/SL-TP: no pane, so the sweep proves the tabs inert
   (isLimitLive true). Table below.
2. Mobile `__tests__/mobile/` (Playwright, real Chromium vs `next start`, wallet+network mocked), 47 tests all pass:
   375 overflow ×10 routes, tap ≥ 44 px ×10, reduced motion ×10, credits in footer ×10, sticky CTA ×2, sheets ×3, 2
   detector self-tests. On origin/main: tap 10, motion 10, sticky 2 FAIL (overflow, credits, sheets held). Shots
   `docs/feedback/feat-ui-v2-mobile-parity/<route>-{375,1440}.jpg` ×10 routes. Frames m02 m04 m05 m07 m08 m09; DERIVED
   (no frame, as B9): History, Analytics, Limit/SL-TP shells, DCA positions, token sheet.
3. Five Lows — test | on origin/main | proof:
   A69b S-1 minout it.each(1/8453/42161) | passes (no chain branch) | mutation: mainnet-only buy-token compare → 4 FAIL
   A69b S-2 Confirm behind insufficient-balance / wrong-network | FAIL ×2 | fixed (SwapCard.confirmGated)
   A70b S-1 Create PRESSED with a no-key gate (depeg) | passes (old test never pressed Create) | mutation: gates off →
   new FAIL, old green
   A70b S-2 price moves under the wallet prompt, then 409 | FAIL | fixed (PreparedReview.priceKey, DcaCard closes it)
   A70b S-3 ack uses the review's tier, not the cached one | FAIL (consent reopens at unpriced) | fixed (review.info)
4. rpc-budget guards green (3 files, 70 tests with the sweep). CodeQL full security-extended: base 13 → head 13,
   identical rule:file:line, 0 new (1046 → 1051 files scanned).
5. v1 proof: route table identical; 8 static v1 routes first-load JS +0 B raw and gzip (/ = 2 894 881 B both); 0 v2
   markers in v1 chunks.
6. vitest 415 files / 6674 → 416 / 6729 (+55); lint 93 = 93; tsc 0; build ok; diff vs merge-base 44 files +1411 −83,
   only src/ui/v2/** + this folder. origin/main advanced (#658, disjoint; merge-tree clean). Compare
   https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-mobile-parity
Concerns for the Auditor:
- fixed, not sticky: both cards are single-column grids, CTA in the LAST area, so `sticky` has no range;
  `.ts-cta-dock` is fixed ≤ 639 px, ?/♫ ride above.
- A69b S-2 formula = (cta.disabled && kind≠in-flight) || gates.anyBlocked: the owner's alone leaves
  connect/wrong-network a silent no-op.
- A70b S-3: the 409 tier still merges in `due`; only the CACHED tier stops overriding the acknowledged one.
- footer links + header logo are 44 px tall ≤ 639 px (frame m09 is compact): taller footer on a phone. Owner may
  revisit.
- residual: a direct hit on /limit or /sltp still shows the skeleton; the Playwright suite is NOT in e2e.yml (.github
  is outside this slice). Base/Arbitrum reads dial public RPCs from the browser (CSP refuses them without the RPC
  env); only mainnet uses /api/rpc.

### Content-map deltas, consolidated (item · tab · why · decision)
| item | tab | why | decision |
|---|---|---|---|
| glyphs ⇅ ⟳ ✎ ⓘ ⚙ × ▸ ↓ ⇄ 🔑 ⚠ | Swap, DCA, Orders, History, modals | v1 prints them as text; v2 draws them aria-hidden beside a named control | owner, round 7 item 11 |
| 3-sentence unpriced notice | Swap | one line "No reference price — consent required before swapping"; full text in the consent dialog | owner, B3 |
| "Start DCA — N buys over D days" | DCA | label is "Review DCA"; buys and duration are summary rows | owner, B6a |
| particle-environment clause | landing | v2 has photo backgrounds, no particles | owner, 26 Oct 2026 |
| amounts, dates, tx-link chain | Orders | numbers via format.ts; links use the ORDER's chain (v1 hard-codes mainnet); remap asserted on its own | owner, B7 rule |
| "&#9660;" | review sheet | v1 bug (unescaped entity), v2 renders the glyph | B4 |
| Limit panel, SL/TP panel | Limit, SL/TP | no v2 pane exists; tabs stay "Soon" | owner, this slice (asked) |
| "Coming Soon on <chain>" banner | Swap | only on a chain with no FeeCollector (P223); unreachable on 1/8453/42161; pinned to its 2 strings | owner, this slice: record, don't add |
| Smart DCA Engine · description · "Swap Now →" | DCA gate | WAS missing; ADDED verbatim (commit bc36226) | owner, this slice |
| "Recent swaps (N)" list (v1 SwapHistory) | Swap | same shared `useSwapHistory` store, v1's copy; no-box (hairline, not v1's rounded box) | owner, A75 L-1: BUILD |
| Share button ("Share — saved X%" / "Share swap") | Swap | v1's tweet-intent Share (SwapBox.tsx), from the live quote/tokenIn/tokenOut, once the swap succeeds | owner, A75 L-1: BUILD |
| Theme toggle | Header | v2 is dark-only (no light mode); the control has no v2 counterpart | owner, A75 L-1: NOT built |
| Desktop dot-nav (landing `ScrollSpy`) | landing | v1's `lg`-only section dots; v2's scroll narrative (photo sections) replaces the need for a jump-nav | owner, A75 L-1: NOT built |

## Feedback — A75 fixes (PR #660, head 87adf17) — 0C/1H/8L, all fixed
Auditor A75 verdict: blocked 0C/1H. All 9 findings fixed, one commit per id (8912f37 H-1 · fd9ef80 L-1 · cfa5d29
L-2 · e420bb9 L-3 · 353152c L-4 · 1f66458 L-5 · 52c6547 L-6 · dad23ec L-7 · 87adf17 L-8), each commit's test
failing on the commit before it.

1. **H-1** AppShell.tsx's pane ternary fell through to TabPane's permanent empty skeleton for `/limit`, `/sltp`,
   and DCA on a chain neither gated nor live (Arbitrum — OrderExecutorV3 not operational per DEPLOYMENTS.md — or
   the flag unset). Now renders v1's `ComingSoonPanel`, wrapped in a `data-tab-pane` div.
2. **L-1** Recent swaps (RecentSwaps.tsx, same shared `useSwapHistory` store, no-box hairline) and Share
   (quote-model's `buildShareText`, byte-identical tweet text) BUILT per owner ruling; theme toggle and the
   landing dot-nav recorded NOT built. New `shell-surfaces-sweep.test.tsx`: the main sweep renders v1's SwapBox
   alone (never catches a v1 SIBLING), which is exactly how these two went missing with 0 sweep failures — this
   file compares the siblings directly and pins the two NOT-built surfaces have a ruled content-map row.
3. **L-2** `{pane}` wrapped in `SwapErrorBoundary` (v1 copy) — every tab, not only Swap.
4. **L-3** SwapCard's `explorerUrl` now follows `lc.swap.txChainId ?? activeChainId` (v1's own rule), not the
   selected chain alone; DcaCard's `order_filled` toast now names its own chain explicitly. v1's DCAPanel has the
   same omission but falls back to a hard `?? 1` (always Etherscan) rather than the selected chain — a
   pre-existing v1 bug, not touched here (flagged for the Auditor).
5. **L-4** proxy.ts's catch-all used the switch state (`v2`) for every direct `/v2/*` hit — once the switch was
   on, `/v2/swap` passed straight through. A request reaching that branch is necessarily a direct hit (the
   tab-rewrite rule above always returns its own response first), so it is now always a 404 except `_kit`/`_enable`.
6. **L-5** The 6 v2-only tab paths (no v1 page at all) now redirect to `/` with v2 off, instead of falling through
   to Next's generic 404. `V2_ONLY_TAB_PATHS` (tab-paths.ts) derives them from `V2_TAB_PATHS` so they can't drift.
7. **L-6** HelpDrawer rebuilt on `Sheet` (focus trap + restore, neither of which it had). Sheet gained an `edge`
   prop so the drawer keeps its left-hairline identity (round7.test.tsx) against Sheet's top-hairline default.
   HelpFab's "Open help" trigger used to unmount on click, so Sheet's `document.activeElement`-at-mount restore
   target was already dead by the time Sheet mounted — it now stays mounted (inert via aria-hidden/tabIndex -1).
8. **L-7** sw.js's final fetch branch called `respondWith` for every remaining GET, including a cross-origin one
   (Base/Arbitrum's direct public-RPC reads — only mainnet goes through `/api/rpc`); a failed cross-origin fetch
   fell back to `caches.match('/')`, substituting the cached HTML shell for an RPC response. Now scoped to
   same-origin navigations only. New `src/sw.test.ts` loads and evaluates the real shipped file.
9. **L-8** `webServer.cwd` now resolves to the repo root (Playwright's default is the config file's own
   directory — no package.json/.next there). Added a `v2-mobile-parity` job to `.github/workflows/e2e.yml`,
   separate from `category-scroll` since it needs a real build + `next start`, not the isolated file:// harness.

**Verify:** vitest 427 files / 7674 tests, 0 fail. lint 93 = 93 (0 errors, delta 0). tsc 0. `npm run build` ok
(Turbopack; route table unchanged, 8 v1 static routes + the dynamic set). parity-sweep.test.tsx 39/39, 0 missing;
shell-surfaces-sweep.test.tsx 4/4 new. rpc-budget 31/31. CodeQL security-extended (javascript-typescript), base
a91e105 vs head 87adf17: 13 → 13 alerts, identical rule:file:line set, 0 new, 0 fixed (base scanned 1069 files,
head 1075 — the +6 are the new test files this round added). v1 module-identical: the diff touches no
v1-reachable page/component source at all (`git diff --stat a91e105..HEAD` — only src/ui/v2/**, proxy.ts
[middleware, not bundled per-route], public/sw.js [static asset], .github/, docs/, and test files); no byte-diff
build pass was needed to prove it.

**Concern for the Auditor:** L-3's v1-side DCAPanel/ToastProvider omission (hard `?? 1` fallback, always
Etherscan for a Base/Arbitrum DCA fill toast) is real but out of this PR's scope — v2 is now strictly better than
v1 here, not merely at parity.
