# feat/ui-v2-landing — notes (appendix to ../feat-ui-v2-landing.md)

## Evidence 6 — slot table (number → slot; none typed). Values are today's real ones on Ethereum.
| Where | Shown | Slot (`src/config/product-claims.ts` unless noted) |
|---|---|---|
| Hero stat 1 · security bar 1 · "8 Liquidity Sources" · "all 8 sources" · "N DEX sources" | 8 | `INTEGRATED_DEX_SOURCE_COUNT` |
| H1 "Eight routes." · subhead · performance copy | eight | `INTEGRATED_DEX_SOURCE_COUNT_WORDS(_CAP)` |
| Hero stat 2 | 6 | `VERIFICATION_CHECKS.length` (via `landing/slots.ts heroStats`) |
| Hero stat 2 label "· 2 STAGES" | 2 | `VERIFICATION_STAGES.length` |
| Security bar 2 | 6 | `VERIFICATION_CHECK_COUNT` (same list as the hero → hero and bar can no longer disagree, pack §6.2) |
| Hero stat 3 · security bar 3 · pre-swap card | 29 | `chainlinkFeedCountFor(useQuoteChainId())`; label name = `chainNameFor(chainId)` |
| Preview amount in / quote out | 0.5 / live | `LANDING_PREVIEW_AMOUNT_IN` / `useQuote` → `formatDisplay` |
| Preview fee · footer fee | 0.1% | `PLATFORM_FEE_LABEL` |
| Chain chips · performance copy · bottom line | Ethereum, Base, and Arbitrum One | `SWAP_CHAIN_LIST_LABEL` |
| Chip 4 · bottom line | Proxied RPC & quotes | `PRIVACY_BADGE` |
| Source graph nodes · features card | adapter names / labels | `INTEGRATED_DEX_SOURCE_NAMES` / `INTEGRATED_DEX_SOURCE_LABELS` |
| "Deviations above N% blocked" · pre-swap card warn/block | PRICE_DEVIATION_* | `PRICE_DEVIATION_BLOCK_PCT` / `_WARN_PCT` |
| Staleness sentence | CHAINLINK_STALENESS_CLAIM | `CHAINLINK_STALENESS_CLAIM` |
| Post-swap card shortfall | POST_EXECUTION_SHORTFALL_WARN_PCT | same name |
| Outlier "3× the median" · "48-hour timelock" | | `OUTLIER_MEDIAN_MULTIPLE` · `ADMIN_TIMELOCK_HOURS` |
| DCA card title | DCA (Base) | `dcaFeatureTitle()` (names the chains whose executor is live) |
| Roadmap membership | Limit, SL/TP | `isOrderTypeLive(...)` (v1's rule) |
| Footer © year | | `COPYRIGHT_YEAR` |
| "01 02 03" | list index | `String(i+1).padStart(2,'0')` |
| "P0 alert", "2-way and 3-way" | verbatim v1 sentences | not numbers of the product; the only numerals in the test's verbatim set |
`landing.test.tsx` mocks the claims with distinct values (11/13/3/0.7%, feeds 31/17/5), and asserts that every numeral on the page is a mocked slot or in that verbatim set; the real defaults (8, 29, 0.1%, "Eight") must be absent.

## Content-map delta (D5), i.e. where the page differs from pack 10 — all copy is v1's post-#587 copy
- Hero stats: pack "8 / 2 layers / 29" → **8 / 6 checks · 2 stages / 29** with v1's labels (the "2 vs 7" disagreement is gone: one list). Fact chip "IP-PROTECTED" → **"Proxied RPC & quotes"** (v1 now says that).
- Demo card: pack's static "DEMO QUOTE" → v1's **live preview** (same `useQuote`; "Compared N DEX sources" only after a quote resolves). SELL/RECEIVE labels and the ■ slot markers are design annotations, not shipped.
- §3 card 3 "Active MEV Protection" → **"MEV Protection on CoW Routes"** (v1). Eyebrows reuse nav words (Performance, Why TeraSwap, Security, Experience, Features, Roadmap, Docs).
- §4 bar is the pack's 4 cells; v1 had 3 (cell "Liquidity sources" repeats the hero slot; no new claim).
- §5 Permit2 card ({100%} / 24 hours / spender) **not shipped**: unsourced figures (pack marks them slot/"needs qualifying"); the right panel holds v1's "Launch the full app →". **Owner removal (asked):** the clause "with a dynamic animated particle environment that responds to your every move" (v2 has no particle network) — the only parity allow-list entry.
- §6 headline = v1's current "Built for every EVM trader." (pack's "{Engineered for…}" slot); no feature icons (decorative).
- §7 Roadmap: v1's rule (`isOrderTypeLive`): DCA sits in the grid while live, in Roadmap if not. §9 Docs: pack's sentence "How routing, oracle checks… in detail." **not shipped** (new copy; owner to supply or approve); H2 "Read the docs." + `/docs` + v1's link text.
- Header: nav + Launch app only (pack 10a); v1's landing header also had the chain selector + Connect — **not on the v2 landing**, so the per-chain hero figures stay on the selected chain (Ethereum default) until the app is launched. Mobile gets v1's ☰ menu (m01 shows none).
- Source-graph names are the registry names (lower-case, as v1 shows them), not the pack's display names.

## Owner answers (asked; supersede the goal text)
1. (d) DCA gate: **truthful, per live chain.** The gate already existed and passes per-chain tests; the skeleton on Preview is `isDcaLive` = false there: it needs `NEXT_PUBLIC_DCA_ENABLED=true` **and** `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE` (+ `NEXT_PUBLIC_BASE_FEE_COLLECTOR`) in the Preview env.
2. (c) Subtitle "Change" on all three networks (Base's "Swap · DCA" removed).
3. Particle-environment clause: **drop it, allow-list it** (verbatim answer: "Drop the clause, allow-list it (Recommended)").

## Read-scope deviations (agent, logged)
Beyond the goal's list I read: `src/app/page.tsx` (to quote v1's landing-vs-app split), `src/components/Header.tsx` (nav destinations), `src/hooks/useChainId.ts`, `src/lib/chains/{activation,registry}.ts` + `src/lib/order-engine/config.ts` (greps, why the DCA gate was off), `src/lib/wagmiConfig.ts` + `.env.example` (env names for the local run), `tailwind.v2.config.ts`. `next dev` rewrote tracked `AGENTS.md` (reverted, never committed).
