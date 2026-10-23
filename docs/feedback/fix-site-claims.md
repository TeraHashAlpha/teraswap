# Feedback — fix/site-claims (3c4b7fe, 9d020c8, 9c711ff; all SSH-signed, noreply)

Owner rulings in-session: **C2** no "7 items" exist (bare `value: 7` + 2 listed checks) → checks = only what in-list code proves. **C7** DCA title derived from `isDcaLive` (Arbitrum is dark). **Commit 3** may edit the 5 Beta* usage files (import + usage line only).
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
| `ADMIN_TIMELOCK_HOURS` | 48 — **UNVERIFIED**: typed; only DocsPage "On-Chain Admin Timelocks" says so, contract constant not read | owner text |

## 2. Anti-hard-code test (`product-claims.no-hardcode.test.ts`)
On the 4 surfaces at origin/main: **11 failed / 30 passed** (29, "100% gasless", "Zero front-running", "No approval gas fees, ever", "eliminate front-running", CoW-fill, "Ethereum Elite", "every hour", "roughly 30", import check). On this branch: 41/41 pass.

## 3. Before → after
- Hero: `2 VERIFICATION LAYERS`/`29 CHAINLINK ORACLES` → `2 stages · 6 checks`/`<n> CHAINLINK ORACLES · <chain>` · Security bar `7 layers`, count-up from 0 → `6 checks`, final value on SSR
- Features card names 10 incl. OpenOcean+Balancer → 8 labels from registry · Staleness "check every hour" → "Prices older than 60 min are rejected (…per-feed limit)"
- MEV: "Zero front-running, zero sandwich" / "eliminate…entirely" → scoped to CoW routes · "100% gasless" / "No approval gas fees, ever" → "Gasless approvals for permit-capable tokens; one-time on-chain approval otherwise"
- Limit/SL-TP "CoW solvers…zero gas" / "CoW limit order auto-submitted" → OrderExecutor + keeper fill + 48-hour timelock · "Smart DCA Engine" → `DCA (…)` · "Engineered for the Ethereum Elite." → "Built for every EVM trader."
- DCA card "price-aware…Chainlink" → "fixed schedule, keeper-executed" (DocsPage: DCA carries no price condition) · swap/page.tsx "Coming to L2 soon" → "Not available on this network yet"
- Header `beta`, DocsPage "Beta · unaudited" → removed / "Not externally audited"; Beta* usages removed; Footer: `Smart contracts have not been externally audited. Use at your own risk.`

## 4. `grep -ri "beta\|experimental" src/components src/app`
Non-test, excl. deprecated Beta* files: **0**. Test files: 34 lines = 23 dead `vi.mock('…BetaDisclaimer')` (left: tests outside accepted scope) + 11 in the new guard tests / `beta-disclaimer` testid.

## 5. Verify
Suite 4452 (main) → **4520**, 302 files, 0 failed · lint 93 → 93 (delta 0, 0 errors) · tsc clean · 21 files, +646/−79 (`git diff --stat origin/main...HEAD`). One existing test flipped (LimitOrderPanel: disclaimer no longer rendered). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/site-claims — no PR.

## Left open (not in scope, no proof file read)
DocsPage ">8%", ">5%", "3×", "$10,000"; hero "0.1%" fee (`FEE_PERCENT` exists); "Zero data leaks"/"IP never exposed" vs C8 browser-direct logo/DefiLlama calls; `useApproval.ts` lines cited from recon only.
