## Feedback — feat/ui-v2-mobile-parity (last v2 slice before the full v2 Auditor + production flag)

Owner decision (asked in-session, supersedes the goal text): **Limit and SL/TP stay "Soon" in v2** until a pane exists.
Premise that was false: the goal assumed every tab has a v2 pane. `AppShell` renders the skeleton `TabPane` for `limit`/`sltp`;
v1's LimitOrderPanel / ConditionalOrderPanel have 0 % of their text in v2, and the tab used to turn clickable when v1's `isLimitLive` is true.

### Checklist
- [x] C1 whole-app parity sweep (Swap, Portfolio, DCA, Orders, History, Analytics, landing × chains 1/8453/42161) — `__tests__/parity-sweep.test.tsx`, 41 tests
- [x] C1 TabBar: Limit/SL-TP stay disabled "Soon" regardless of `isLimitLive` (owner answer); `shell.test.tsx` + sweep fail on main
- [x] C1 DCA gate (Ethereum) gets v1's title/description/"Swap Now →" verbatim (owner answer); 3 tests fail on main
- [ ] C2 mobile 375: no horizontal overflow per route (test), bottom sheets, tap ≥ 44 px, sticky CTA, credits in footer, reduced motion
- [ ] C2 Playwright screenshots 375 + 1440 per tab
- [ ] C3 A69b S-1 min-output bigint parity (it.each 1/8453/42161)
- [ ] C3 A69b S-2 confirmGated = `cta.disabled && cta.kind !== 'in-flight'`, shows cta.label
- [ ] C3 A70b S-1 Create-path gate test exercises Create, not only Retry
- [ ] C3 A70b S-2 priceKey stored in the review, review closes when it changes
- [ ] C3 A70b S-3 with ack, the review/409 tier is used, not the cached tier
- [ ] Verify: suite vs main, lint delta 0, tsc, build, v1 module-identical, rpc-budget guards, CodeQL (0 new)

### Evidence (filled in as each lands)
1. Parity (v1 text ⊆ v2, links ⊆ v2): **0 missing / 0 stale allow** on every row below; v1 nodes per tab = Swap 67–77 · Portfolio 21–34 · DCA 44–57 ·
   DCA gate 9 · Orders 29–98 (3 lists) · History 67 (5 links) · Analytics 208 (10 links) · landing 139 (2 links); chains 1 / 8453 / 42161 each.
   Content-map deltas, consolidated (item · tab · why · decision):
   - glyphs ⇅ ⟳ ✎ ⓘ ⚙ × ▸ ↓ ⇄ 🔑 ⚠ · Swap/DCA/Orders/History/modals · v1 prints them as text, v2 draws them aria-hidden beside a named control · owner round 7 item 11
   - 3-sentence unpriced notice · Swap · becomes one line "No reference price — consent required before swapping", full text lives in the consent dialog · owner B3
   - "Start DCA — N buys over D days" · DCA · label is "Review DCA"; buys + duration are summary rows · owner B6a
   - particle-environment clause · landing · v2 has photo backgrounds, no particles · owner 26 Oct 2026
   - amounts / dates / tx-link chain · Orders · numbers via format.ts, links use the ORDER's chain (v1 hard-codes mainnet) · owner B7 rule, remap asserted on its own
   - "&#9660;" · review sheet · v1 bug (unescaped entity), v2 renders the glyph · B4
   - Limit panel, SL/TP panel · Limit, SL/TP · no v2 pane exists; tabs stay "Soon" · owner, this slice (asked in-session)
   - "Coming Soon on <chain>" banner · Swap · only on a chain with no FeeCollector (P223), unreachable on 1/8453/42161 · owner, this slice: record, don't add; pinned to its 2 strings
   - Smart DCA Engine / description / "Swap Now →" · DCA gate · WAS missing, ADDED verbatim in commit 1 · owner, this slice
2. 375/1440 screenshots + overflow test: _pending_
3. Five Lows, test fails on main: _pending_
4. rpc-budget + CodeQL counts: _pending_
5. v1 proof: _pending_
6. Suite / lint / tsc / build / diff --stat / compare link: _pending_
