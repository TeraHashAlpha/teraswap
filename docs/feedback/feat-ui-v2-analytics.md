# Feedback — feat/ui-v2-analytics (B9: v2 Analytics tab)

Frames (round7/app): desktop `desktop/50-analytics.png`. Mobile: NONE exists (m02–m09 = Swap/DCA/Portfolio/Orders/wallet/help);
375 derived from `mobile/m06`, `m07`, `mobile-sheet-1/2` per owner answer. Docs read: CHANGELOG.md, FUNCTIONAL-CONTAINERS.md.

## Owner answers (2026-11-04, supersede the goal text)
- Scope = **A + B**: A = v1 tab `AnalyticsDashboard`; B = v1 `/analytics` page (`PublicProtocolStats` + wallet `PersonalDashboard`),
  because v2 rewrites `/analytics` to this tab and B would vanish. B has no frame (round7 language, in the delta below).
- 375 layout: derive from m06/m07 (no mobile Analytics frame).

## Premise deltas (recorded, not blocking)
- "Aggregates cached 24 h": false in code. `/api/analytics` s-maxage=30, `/api/stats` 60, `/personal` 5 min; v1's `useAnalytics`
  polls every 30 s with a bare setInterval (no visibility pause; HTTP, not RPC). Reused unchanged ⇒ v2 = v1; nothing added.
- v1 reads `/api/stats` twice (page + tab); v2 reads it once for both blocks (same URL, once on mount, no polling).
- v1 charts use no chart library (div bars) ⇒ none added. `PersonalDashboard`'s "Connect a wallet" card is unreachable on
  `/analytics` (page gates on isConnected) ⇒ not rebuilt; the shell's Connect button owns that.

## Checklist
- [x] C1 tab: every v1 section, same order/values/states · parity v1 ⊆ v2 (0 missing) · figure equality ×4 periods
- [ ] C2 charts + a11y + 375 + keyboard + reduced-motion
- [ ] C3 rpc-budget Analytics scenario (visible + hidden)
- [ ] Verify: suite vs main · lint Δ0 · tsc · build · v1 module-identical · CodeQL full suite · diff only src/ui/v2 + feedback

## Content-map delta — frame-only extras NOT built (decide later)
- Eyebrow "PROTOCOL ANALYTICS · PUBLIC" + `{HEADLINE SLOT}` (frame says the text is the owner's call, round-2 A3).
- "per trade" sub-line under Avg Trade (v1 has none) · "WIN RATE" / "TRADES" column captions.
- Volume Trend: y-axis $ scale + gridlines, a mid-date label, latest bar in cream (v1: first/last date only, tooltip per bar).
- Popular Pairs: frame ranks bars by trade COUNT; v1 prints VOLUME (F4 fix) with trades in the tooltip ⇒ v1 kept, no bars.
- Recent Activity: TYPE/PAIR/ROUTE/AGE/TX header row, tx hash text, "DCA BUY" chip (v1: type word + pair + source + age + ↗).
- Gasless figures appear twice on one page (tab "Gasless Adoption" + page "Protocol performance") because both v1 surfaces are kept.
