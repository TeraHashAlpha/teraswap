# Mobile tab-bar — before/after (iPhone SE 375 / iPhone 14 390 / Pixel 7 412)

Real Chromium device-viewport captures of the in-app **Swap** view.

- `before/` — the old `flex-1` tab bar: 6 tabs squished (~41px tall, 11px labels), the row overshot
  the viewport (~11px), and the last tab ("Analytics") was clipped/dimmed and unreachable.
- `after/` — `<ModeTabs>`: the row genuinely scrolls (≥44px tabs, ≥12px labels), the bar fits the
  viewport, the last tab is reachable, and dynamic edge-fades show the scroll affordance.

Reproduce the deterministic assertions: `npm run test:e2e:mobile` (15 tests, 3 viewports).
