# Feedback — feat/ui-v2-analytics (B9 v2 Analytics) · C1 3b6cd09 · C2 a1dc335 · C3 1d8d6b4 · all items done
Owner answers 04 Nov (supersede goal): scope A+B (tab = AnalyticsDashboard; + /analytics page = PublicProtocolStats,
  My Analytics);
375 derived from m06/m07. Premise deltas: caches are 30 s/60 s/5 min, not 24 h; v1 charts are plain divs (no library
  to reuse).
## Evidence
1 Frames (round7/app): desktop/50-analytics.png; mobile NONE (m06, m07, mobile-sheet-1/2 used). Shots in
  docs/feedback/feat-ui-v2-analytics/: analytics-desktop · analytics-375 · analytics-375-visitor (.webp). 375: no
  overflow, 0 errors.
2 Parity (analytics.test.tsx: v1 AnalyticsDashboard+PublicProtocolStats+PersonalDashboard vs v2): 0 missing text, 0
  missing
  hrefs, 0 stale allow, over ready/loading/failed/empty/personal states (>120 v1 text nodes, order pinned).
3 Figures: 4 periods walked in both, KPI values equal; routes, pairs, trend, ages, gasless, protocol, My Analytics
  asserted.
4 rpc-budget `an` (wallet on Analytics): v1 = v2 = mount 4, steady 2/min, hidden 0, return 4 (budget <= 6); guards
  31/31.
  HTTP identical: /api/analytics 2/min visible and 2/min hidden (v1's own hook, reused unchanged).
5 CodeQL full security-extended: main 13 -> branch 13, identical file:line list, 0 new.
6 v1 proof: 0 v1 files changed; / /swap /docs chunk bytes identical, /analytics +140 B (0.007%), 0 v2 markers in v1
  chunks,
  route table identical. Suite 411/6572 -> 413/6622 green; lint 93=93; tsc 0; build ok; diff 16 files, all src/ui/v2 +
  this.
  Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-analytics
## Concerns
- v1 useAnalytics polls /api/analytics every 30 s even in a hidden tab (HTTP, not RPC); fixing it needs src/hooks (out
  of scope).
- sounds-parity.test.tsx timed out once on a cold transform cache (5 s); green 3/3 warm and in the full run.
- /api/stats is read once for both blocks (v1 reads it twice); PersonalDashboard's Connect card is unreachable on
  /analytics.
## Content-map delta: frame-only extras NOT built (decide later)
- Eyebrow "PROTOCOL ANALYTICS · PUBLIC" + {HEADLINE SLOT}; "per trade" under Avg Trade; WIN RATE / TRADES column
  captions.
- Volume Trend: y-axis $ scale, gridlines, mid date, latest bar cream (v1: first/last date + tooltip only).
- Popular Pairs: frame ranks by trade COUNT with bars; v1 prints VOLUME (F4 fix), kept, no bars.
- Recent Activity: TYPE/PAIR/ROUTE/AGE/TX header row, tx hash text, DCA BUY chip (v1: word, pair, source, age, arrow).
- Gasless figures appear twice (tab Gasless Adoption + page Protocol performance): both v1 surfaces kept.
