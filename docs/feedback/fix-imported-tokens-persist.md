# Feedback — fix/imported-tokens-persist

## Checklist
- [x] C1 facts (a)(b)
- [x] C2 localStorage persistence + tests
- [ ] C3 selector hygiene (catalog-wins dedupe, symbol-collision badge) + tests
- [ ] Verify: suite vs origin/main, lint delta, tsc, diff --stat, compare link

## 1. Facts
**(a) Why imports vanish.** `src/lib/tokens.ts:780-781`: `// ── Custom token import cache (session-only)` /
`let customTokens: Token[] = []` — a module-level array, written only by `addCustomToken` (`:788`, called from
`useTokenImport.ts:118`). No sessionStorage/localStorage anywhere: any reload or new visit resets it to `[]`.
Second gap: the selector's browse list (`TokenSelector.tsx:56-64`, `catalog`) is `DEFAULT_TOKENS`/`getChainTokenList`
and never includes custom tokens; only the search path merges them (`:92` → `getSearchCatalog`, `chains/tokens.ts:328-337`).
So even in-session, an imported token is findable only by searching for it.

**(b) ETHFI on Base.** NOT in `token-catalog.8453.json` (311 tokens, no ETHFI/ether.fi). CoinGecko `/coins/list?include_platform=true`
(the pipeline's own platform source) has `ether-fi` with `platforms.base` set (`CG_PLATFORM[8453]='base'`, `fetch-sources.ts:25`),
so it IS a CoinGecko candidate. Address checked against each source's Base list, read by script from that platform entry, never typed:
`tokens.coingecko.com/base/all.json` yes; Uniswap, 1inch v1.2, Trust Wallet, Superchain: no. = **1 external vote**.
Excluding rule: `scripts/token-catalog/lib/verify.ts:200` `if (votes < cfg.minSources)` → `insufficient-sources`
(`config.ts:31` `minSources: 2`). DefiLlama cannot rescue it: market/identity fetch only targets candidates already at
`>= minSources` (`build-chain.ts:200-202`). Its 24h volume (~$31.7M, CG markets) is far above `liquidityFloorUsd` (`config.ts:33`),
so the low-liquidity 3-vote rule is not the cause.
**Change that would include it:** let a CoinGecko-only candidate qualify when it is liquid (24h volume >= `liquidityFloorUsd`
$100k, or DefiLlama price confidence >= 0.9) and still passes the on-chain guard — a rule exception at `verify.ts:200`.
**Impact (estimate, CG volumes fetched 2026-10-26):** 2,579 CG-only Base addresses are outside the catalog; **189** clear $100k
(90 clear $1M), incl. ETHFI, i.e. ~+188 others. Note `maxNewTokensPerChain[8453]=250` (`config.ts:35`) could then bind.
**Caveat / premise:** the goal says to read the Base address from the user's import; no record of it exists in the allowed
files (the import was lost on reload), so the address came from CoinGecko's platform list instead. Not verified equal to
the user's import. Pipeline and catalog untouched.
