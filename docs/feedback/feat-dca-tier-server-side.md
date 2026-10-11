# Feedback — feat/dca-tier-server-side

**Scope.** Reads beyond the goal's list, owner-accepted in-session: `origin/feat/keeper-price-quorum`
`price-sources.js` + `order-floor.js` (READ-ONLY; absent on origin/main). `next.config.js` / `DCAPanel` tests as needed.
**Merge order: 29 (this) before 33 (keeper quorum).** If the keeper branch changes `QUORUM_TOLERANCE_BPS` or
`MAX_PRICE_AGE_SEC` before merge, the pin test fails loudly — by design.

(Evidence 1–6 are filled in by the commits below.)
