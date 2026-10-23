# Feedback — fix/site-claims

**Owner rulings (in-session, supersede goal text):** C2 no "7 items" → checks = what in-list code proves (6). C6 premise false (`useApproval.ts:105-117` always plans an exact on-chain approve; no gasless path) → exact-amount copy. C7 DCA title from `isDcaLive` (Arbitrum dark). Commit 3: Beta* usage files editable; LegalPage source list editable; legal numerals excluded. Declaring-line reads accepted for `…V3.sol`, `defillama.ts`, `api.ts`, `adapters/shared.ts`. **Final boundary:** scope stays C1–C7, rest of DocsPage untouched → earlier removals of unproven DocsPage detail were reverted; the 100+ unproven items are ledgered in the appendix for a separate goal.

## 1. Slots — value (Ethereum / Base / Arbitrum One) · proof
- Sources: 8 on all (global; registry exposes only `name,fetchQuote,fetchSwapData`, test-pinned) · adapters/index.ts:15, constants.ts:198
- `2 stages · 6 checks` · constants.ts:321,479,488,496,506; post-execution-validator.ts:78 (declaration sites)
- Chainlink feeds **29 / 9 / 15** · chainlink-feeds.ts:634 · deviation 2%/3%, staleness 60 min · constants.ts:479-480,506
- Mirrored (one typed value, test reads the declaring file): post-exec 2% validator.ts:78 · DefiLlama block 8% defillama.ts:326, gate $10,000 :24 · cross-quote 5%, 3× median api.ts:306,289 · slippage clamp 0.01/15 shared.ts:14 · timelocks 48 h/7 d/7 d TeraSwapOrderExecutorV3.sol:134-139
- Imported: fee 0.1%/10 bps constants.ts:131-132 · quote timeout 10 s :289 · fee tiers :398 · split min split-routing-types.ts:63 · `dcaFeatureTitle()` = `DCA` today (no live chain) · preview amount, copyright year (typed once in product-claims)

## 2. Anti-hard-code test
`product-claims.no-hardcode.test.ts` on origin/main components: **11 failed**; on branch all pass (guards: 29, 0.1%, >8%, >5%, 3×, $10,000, 10-second, 48-hour, 100% gasless, Zero front-running, "never exposed", "gasless approvals", disabled sources in lists, …).

## 3. Before → after (C1–C7)
Hero stats & Security bar → slots, final value on SSR · Features card 10 names → 8 labels · "check every hour" → "older than 60 min are rejected" · MEV "zero/entirely" → CoW routes only · "100% gasless" → exact-amount approvals · Limit/SL-TP "CoW solvers" → OrderExecutor + keeper + 48-hour timelock · "Ethereum Elite" → "Built for every EVM trader." · "Smart DCA Engine" → `DCA (…)` · swap page "Coming to L2 soon" → "Not available on this network yet" · landing privacy/"zero" lines scoped (`PRIVACY_*`: RPC + quotes proxied; logos, DefiLlama, wallet, direct-RPC fallback are not) · DocsPage: numbers slotted (content preserved), disabled sources marked "Disabled", Terms source list derived · Header badge, DocsPage "Beta · unaudited" → gone; Footer: `Smart contracts have not been externally audited. Use at your own risk.`

## 4. `grep -ri "beta\|experimental" src/components src/app`
Non-test, excl. deprecated Beta*: **0**. Tests: 34 lines (23 dead `vi.mock('…BetaDisclaimer')` + guard tests).

## 5. Verify
Suite 4452 (main) → **4621**, 0 failed · lint 93 → 93 · tsc clean · diff stat below · Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/site-claims — no PR.

## Appendix — ledger for a follow-up goal (file:line · claim · what would prove it)
Method: TypeScript-AST extraction of every user-visible string on LandingPage, LandingBelowFold, DocsPage, Header, Footer, SourceToggle, app/page, swap/page; digit-bearing strings minus CSS/ids/standard names (EIP-712, ERC-20, V3…) and LegalPage contract text. Not in scope here, left as is.
| where | claim | proof needed |
|---|---|---|
| src/components/LandingBelowFold.tsx:858 | Large trades auto-split across multiple DEXes to minimize price impact. The optimizer tests dozens of 2-way an | src/lib/split-router*.ts: configs tested (2-way/3-way) |
| src/components/DocsPage.tsx:262 | TeraSwap Protocol v1.0 | version source (package.json / release tag) |
| src/components/DocsPage.tsx:341 | Pathfinder algorithm searching 400+ liquidity sources across DeFi. | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:345 | Dynamic trade routing across 100+ DEXs with auto-compounding. | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:346 | Cross-chain aggregation covering 40+ chains and 1000+ sources. Disabled: ${…}. | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:353 | On-chain concentrated liquidity with auto fee-tier detection across 4 pools. | adapters/uniswapv3.ts fee-tier loop (now UNISWAP_FEE_TIERS length) |
| src/components/DocsPage.tsx:354 | RouteProcessor4 with smart routing across Sushi&apos;s native pools. | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:545 | 300 requests per IP per minute on the RPC proxy to prevent abuse. The swap endpoint is limited to 20 requests  | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:652 | version 2). You place an order by signing it | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:669 | When a keeper executes an order, the contract routes the swap through a whitelisted DEX router (1inch by defau | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:709 | 2% default slippage | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:721 | The order is monitored against a Chainlink feed. When the trigger is reached, the keeper executes it on-chain  | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:756 | 5% default slippage | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:756 | 2% slippage | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:766 | The triggered swap routes through a whitelisted DEX router (1inch by default), with a per-order minimum-output | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:767 | Stop loss orders use 5% default slippage to ensure execution during sharp price drops — speed matters more tha | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:815 | Each buy is sized by cumulative accounting: executeAmount = total × (n+1) / count − total × n / count, with th | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:817 | A pure DCA order carries no price condition (priceFeed = address(0) ⇒ the price check is always true): it runs | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:818 | At each turn the keeper builds a swap at market time and settles it through the single whitelisted DEX router  | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:859 | The engine tests all 2-way and 3-way split configurations across eligible sources. Pre-defined splits (50/50,  | split-router*.ts: split ratio list + 2/3-way |
| src/components/DocsPage.tsx:877 | Split routing activates for trades estimated above $5,000 USD. Below this threshold, single-source routing is  | split-router*.ts: split-eligibility USD threshold |
| src/components/DocsPage.tsx:898 | Total volume, fees collected, unique wallets, and average trade size — filterable by period (24h, 7d, 30d, All | AnalyticsDashboard / api/analytics period options |
| src/components/DocsPage.tsx:902 | 30-day bar chart showing daily trading volume trends and trade frequency. | declaring contract/lib constant or doc source (contracts/order-engine/*.sol, src/lib/order-engine/*, docs/DEPLOYMENTS.md) |
| src/components/DocsPage.tsx:332 | "across three categories" (count of categories typed in prose) | derive from AGGREGATOR_META (isDirect / intentBased) |
| src/components/DocsPage.tsx:341-345,356,364 | vendor blurbs: "Pathfinder", "Professional-grade RFQ… Permit2 pull model", "MEV-aware", "auto-compounding", "CurveRouterNG", "JAM settlement" | adapters/*.ts + vendor docs; or neutral registry-derived cards |
| src/components/DocsPage.tsx:673 | keeper key held in an AWS KMS HSM | keeper/infra code or runbook (not in repo read list) |
| src/components/DocsPage.tsx:652 | EIP-712 domain "version 2" | contracts/order-engine/*.sol domain constructor |
| src/components/DocsPage.tsx:669,766,798 | "1inch by default" router | order-engine config / OrderExecutor whitelist |
| src/components/DocsPage.tsx:691-692 | OrderExecutor addresses (Ethereum, Base) | docs/DEPLOYMENTS.md or CHAIN_CONFIGS |
| src/components/DocsPage.tsx:790 | "DCA ships with launch — not live yet… rolls out first on Base" (stale vs live Base DCA) | isDcaLive / docs/DEPLOYMENTS.md |
| src/components/DocsPage.tsx:932-962 | Roadmap statuses: "Phase 2 — Ships with launch" (Base already live), "expansion (Arbitrum…)" (Arbitrum already live), Phase 1 item list | docs/DEPLOYMENTS.md, ROADMAP.md |
| src/components/DocsPage.tsx:815-818 | DCA arithmetic / "priceFeed = address(0)" semantics | TeraSwapOrderExecutorV3.sol |
| src/components/LandingBelowFold.tsx:858 | "dozens of 2-way and 3-way split configurations" (numeral typed) | split-router*.ts |
