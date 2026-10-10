# feat/dca-floor-tiers-consent — FEEDBACK

Owner decision 2026-10-11: DCA for ANY token; hard block -> informed consent; server classifies + records.

## Checklist
- [ ] C1 classifier `src/lib/order-engine/dca-floor-tier.ts` (+ cap constant)
- [ ] C2 API: server tier, `floorAck` required/recorded, migration (nullable cols)
- [ ] C3 UI: confirmation step replaces hard block, tier badge
- [ ] C4 tests
- [ ] Verify: suite vs origin/main (84da8a3), lint delta 0, tsc, diff --stat

## Premise notes
- DCAPanel native->WETH is at DCAPanel.tsx:866 (not 379-380; those lines are tokenOut `resolveSignableToken`).
- The cap in order-floor.js:188 is a DEFAULT; the keeper env `DCA_FAIL_OPEN_MAX_USD` can override it, so UI text states the default.
- The route already allows a no-feed DCA output (FIX-DCA-NOFEED-CONSENT, route.ts ~L540); only the browser blocked.
