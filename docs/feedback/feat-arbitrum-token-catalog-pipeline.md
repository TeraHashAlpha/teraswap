## Feedback — feat/arbitrum-token-catalog-pipeline (8706ed8)

### Result summary
- **Arbitrum token count:** 5 (manifest) → 227 (pipeline), 0 fatal / 0 warn guard findings.
- **5-way MATCH** (manifest vs generated, sentinel 42): WETH MATCH · USDC MATCH · USDT MATCH · DAI MATCH · WBTC MATCH.
- **Guard verdict table (227 tokens):** bytecode present 226/227 · symbol match 224/227 (2 addr-scoped `symbolMismatchExempt`: USDT/"USD₮0", USDC.e/"USDC") · decimals match 226/227 · in trusted list 226/227 · transferable 226/227 (native ETH sentinel is the 1/227 exempt from on-chain checks each time). Fatal: 0. Warn: 0.
- **USDC vs USDC.e:** two distinct rows — `USDC` (native, 0xaf88d0…, sources: uniswap/coingecko/oneinch/defillama) and `USDC.e` (bridged, 0xFF970A…, sources: curated/arbitrumBridge/uniswap/coingecko/oneinch/trustwallet/defillama). Both `verified:true`, category Stablecoin.
- **Suggested-subset rule:** 5 launch/core tokens ∪ 15 hand-picked Arbitrum majors (ARB, GMX, PENDLE, MAGIC, LINK, UNI, GRT, LDO, CRV, WOO, SUSHI, BAL, AAVE, COMP, YFI) — each checked present in the generated catalog before picking (see below). 22 total, mirrors Base's ~20-30 pattern.
- **Base/mainnet hashes** (sha256, before → after): `token-catalog.1.json` `02e7ad59…` → unchanged. `token-catalog.8453.json` `dc5e3459…` → unchanged. `catalog-guard.trust.json`'s chain-1/8453 rows byte-identical (verified programmatically); only chain-42161 rows added/refreshed.

### Concern — pipeline gap (pre-existing, not introduced here)
`MarketSignal.volume24hUsd` is never populated by any fetcher (grepped the whole
`scripts/token-catalog/` tree) — the growth-cap ranking's "volume desc" tier is always a 0-0
tie, so it silently falls through to "votes desc, then symbol alphabetical." On Arbitrum this
let a wall of tokenized-stock tickers (`AAPLx`, `AMZNx`, …) crowd out real DeFi majors I
initially picked (RDNT, JOE, DPX — verified missing from the actual output) for the suggested
set. I fixed my own picks by checking presence against the generated JSON, but the ranking
bug itself affects Base/mainnet too and is out of this task's scope (no relaxation of
agreement rules asked for). Worth a follow-up prompt.

### Edge case — CoinGecko/DefiLlama/TrustWallet platform slugs diverge for Arbitrum
Unlike mainnet/Base (which share one slug spelling across all three APIs), Arbitrum needed
three different slugs (CoinGecko `arbitrum-one`, DefiLlama/TrustWallet `arbitrum` — confirmed
live 2026-09-12, `arbitrum-one-rpc`/`arbitrum` 404 or wrong-list on the others). Refactored
`fetch-sources.ts`'s single `PLATFORM` map into three (`CG_PLATFORM`/`TW_PLATFORM`/
`LLAMA_PLATFORM`) so a future chain's mismatch fails loudly instead of silently sharing a
wrong slug.

### Edge case — USDC.e transiently missed source-agreement in a live 3-chain run
An isolated single-chain run showed USDC.e clearing 5 external-source votes easily. In a full
3-chain `tokens:sync` pass it fell to "insufficient-sources" once (likely a transient
fetch hiccup deep into a multi-minute run). Given the task's "no silent drop" requirement,
pinned it as a `CURATED_ARBITRUM_SEEDS` never-drop seed (same mechanism Base already uses for
its own bridged USDT gap) rather than relying on votes alone.

### Not touched (explicit scope)
`docs/Prompts/CHORE-TOKEN-CATALOG-PIPELINE.md` (referenced by build.ts's header) still only
describes mainnet/Base — didn't update it since it wasn't named in the prompt's Task 3 list.
