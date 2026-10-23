# Feedback — fix/site-claims (3c4b7fe, 9d020c8, 9c711ff + follow-up; all SSH-signed, noreply)

Owner rulings in-session: **C2** no "7 items" exist (bare `value: 7` + 2 listed checks) → checks = only what in-list code proves. **C7** DCA title derived from `isDcaLive` (Arbitrum is dark). **Commit 3** may edit the 5 Beta* usage files (import + usage line only). **Follow-up (stop-hook):** owner accepted reads of the declaring lines only (`contracts/order-engine/…V3.sol`, `defillama.ts`, `api.ts`, `adapters/shared.ts`) to slot the remaining typed numbers.
- [x] C1–C4 · [x] C5–C7 · [x] beta out + footer line · [x] verify · [x] evidence

## 1. Slots (`product-claims.ts`) — value · proof
| slot | Ethereum / Base / Arbitrum One | proof |
|---|---|---|
| `integratedSourcesFor(id)` | 8 on all (1inch,0x,velora,kyberswap,cowswap,uniswapv3,sushiswap,curve) — **global**: registry entries expose only `name,fetchQuote,fetchSwapData`, test pins it | adapters/index.ts:15, constants.ts:198 |
| `VERIFICATION_SUMMARY` | `2 stages · 6 checks` (all) | constants.ts:321,479,488,496,506; post-execution-validator.ts:78 (declaration sites) |
| `chainlinkFeedCountFor(id)` | 29 / 9 / 15 (`listConfiguredFeedTokens`, direct+composed) | chainlink-feeds.ts:634 |
| deviation warn/block · staleness | 2% / 3% · 60 min | constants.ts:479-480, :506 |
| post-exec shortfall | 2% (typed slot, drift-guarded: validator const is private, server-only) | validator.ts:78; "P0 + auto-disable" = :343-356 `handleCritical` |
| `dcaFeatureTitle()` | `DCA` today (no chain `isDcaLive`) → `DCA (Base, Arbitrum One)` when wired | app/page.tsx comments, dca-launch `isDcaLive` |
| `ADMIN_TIMELOCK_HOURS` / grace / admin-transfer | 48 h / 7 d / 7 d (mirrored, test reads the .sol) | TeraSwapOrderExecutorV3.sol:134-139 |
| `DEFILLAMA_BLOCK_DEVIATION` · `DEFILLAMA_HIGH_VALUE_USD` | 8% · $10,000 (mirrored) | defillama.ts:326, :24 |
| `CROSS_QUOTE_WARN_THRESHOLD` · `OUTLIER_MEDIAN_MULTIPLE` | 5% · 3× (mirrored) | api.ts:306, :289 |
| `SLIPPAGE_CLAMP_MIN/MAX_PCT` | 0.01 / 15 (mirrored) | adapters/shared.ts:14 |
| `PLATFORM_FEE_LABEL/BPS` · `QUOTE_TIMEOUT_SEC` · fee tiers · split min | 0.1% / 10 · 10 s · 4 tiers · 0.1% (imported) | constants.ts:131-132,289,398; split-routing-types.ts:63 |
Every "mirrored" slot is one typed number + `MIRRORED_CONSTANTS` (file+regex); a test reads each file and fails on drift (not imported: private/function-local, or the module is `vi.mock`ed by ~20 tests).

## 2. Anti-hard-code test (`product-claims.no-hardcode.test.ts`)
On the 4 surfaces at origin/main: **11 failed / 30 passed** (29, "0.1%", ">8%", ">5%", "3×", "$10,000", "10-second", "48-hour", "100% gasless", "Zero front-running", "No approval gas fees, ever", "eliminate front-running", CoW-fill, "Ethereum Elite", "every hour", "roughly 30", import check). On this branch: all pass (the follow-up patterns caught 3 spots I had missed in DocsPage: fee table, SL/TP prose).

## 3. Before → after
- Hero: `2 VERIFICATION LAYERS`/`29 CHAINLINK ORACLES` → `2 stages · 6 checks`/`<n> CHAINLINK ORACLES · <chain>` · Security bar `7 layers`, count-up from 0 → `6 checks`, final value on SSR
- Features card names 10 incl. OpenOcean+Balancer → 8 labels from registry · Staleness "check every hour" → "Prices older than 60 min are rejected (…per-feed limit)"
- MEV: "Zero front-running, zero sandwich" / "eliminate…entirely" → scoped to CoW routes · "100% gasless" / "No approval gas fees, ever" → "Gasless approvals for permit-capable tokens; one-time on-chain approval otherwise"
- Limit/SL-TP "CoW solvers…zero gas" / "CoW limit order auto-submitted" → OrderExecutor + keeper fill + 48-hour timelock · "Smart DCA Engine" → `DCA (…)` · "Engineered for the Ethereum Elite." → "Built for every EVM trader."
- DCA card "price-aware…Chainlink" → "fixed schedule, keeper-executed" (DocsPage: DCA carries no price condition) · swap/page.tsx "Coming to L2 soon" → "Not available on this network yet"
- DocsPage typed numbers (fee, >8%, >5%, 3×, $10,000, 10 s, 48 h/7 d, fee tiers, slippage clamp, split 0.1%) → slots · vendor "400+/100+/40+/1000+", "30-day", SL/TP "5%/2% slippage", limit "2% default" → reworded without figures (no proof line found)
- Header `beta`, DocsPage "Beta · unaudited" → removed / "Not externally audited"; Beta* usages removed; Footer: `Smart contracts have not been externally audited. Use at your own risk.`

## 4. `grep -ri "beta\|experimental" src/components src/app`
Non-test, excl. deprecated Beta* files: **0**. Test files: 34 lines = 23 dead `vi.mock('…BetaDisclaimer')` (left: tests outside accepted scope) + 11 in the new guard tests / `beta-disclaimer` testid.

## 5. Verify
Suite 4452 (main) → **4587**, 302 files, 0 failed · lint 93 → 93 (delta 0, 0 errors) · tsc clean · 21 files, +813/−101 (`git diff --stat origin/main...HEAD`). One existing test flipped (LimitOrderPanel: disclaimer no longer rendered). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/site-claims — no PR.

## Left open
Prose-only figures with no proof line: "100% through a single DEX" (illustrative), SL/TP slippage ordering ("wider" vs take profit) is design intent, not code-proven. "Zero data leaks"/"IP never exposed" vs C8 browser-direct logo/DefiLlama calls (not in this goal). `useApproval.ts` lines cited from recon only.
