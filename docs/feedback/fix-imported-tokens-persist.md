# Feedback — fix/imported-tokens-persist

- [x] C1 facts · [x] C2 localStorage persistence · [x] C3 catalog-wins + symbol collision · [x] verify

## 1. Facts
**(a)** `src/lib/tokens.ts:780-781` `// Custom token import cache (session-only)` / `let customTokens: Token[] = []` — module memory,
written only by `addCustomToken` (`:787`); no storage anywhere, so reload/new visit = `[]`. Also, the browse list
(`TokenSelector.tsx:56-64`) never merged custom tokens; only search did (`chains/tokens.ts:328`).
**(b)** ETHFI is NOT in `token-catalog.8453.json` (311 tokens). CoinGecko `/coins/list?include_platform=true` has `ether-fi` with
`platforms.base` (`CG_PLATFORM[8453]='base'`, `fetch-sources.ts:25`). Checked per source by script (address read from that entry,
not typed): `tokens.coingecko.com/base` yes; Uniswap, 1inch, Trust Wallet, Superchain no → **1 vote**. Excluded by
`verify.ts:200` `if (votes < cfg.minSources)` → `insufficient-sources` (`config.ts:31` minSources 2); DefiLlama can't rescue it,
its fetch only targets candidates already at >= minSources (`build-chain.ts:200-202`). Volume ~$31.7M, so not the low-liq rule.
**Change:** admit a CoinGecko-only candidate when liquid (24h vol >= $100k floor, or Llama confidence >= 0.9) and guard-clean.
**Impact (CG markets, 2026-10-26):** 2,579 CG-only Base addresses outside the catalog; 189 >= $100k (90 >= $1M) ⇒ ~+188 besides
ETHFI; `maxNewTokensPerChain[8453]=250` (`config.ts:35`) may bind. Pipeline/catalog untouched.

## 2. Storage schema + tests
Key `ts:imported-tokens:v1:<chainId>` → JSON array of `{address (EIP-55), symbol, name, decimals, importedAt}`; nothing else
(no balances/user data). Every access try/catch (`imported-tokens.ts`). Hydrated lazily per chain (`hydrateCustomTokens`), listed in
the browse list under "Imported" with the existing ⚠ badge + Remove; re-validated on picker open over `/api/rpc?chainId=`:
no answer from chain / decimals changed ⇒ kept, shown "Unavailable", unselectable; transport failure ⇒ not flagged (retry next open).
Tests: `imported-tokens.test.ts` (12), `TokenSelector.imported.test.tsx` (13).

## 3. Reload proof
`vi.resetModules()` + fresh React/app, same localStorage ⇒ token listed + selectable on Base, absent on mainnet/Arbitrum (and no RPC
for other chains); corrupt/hostile/throwing storage ⇒ no crash; Remove ⇒ gone from list+storage and after reload. Mutation check:
no-op `hydrateCustomTokens` ⇒ 6 reload tests fail.

## 4. Dedupe tests (`TokenSelector.imported-hygiene.test.tsx`, 7)
Import at a catalog address (lower-cased) not listed, catalog row selected, record kept; pasting a catalog address creates no
import; duplicate records list once; symbol collision (case-insens.) ⇒ md badge + explorer + warning, others unchanged.
Mutation check: dropping the filter/flag fails 3.

## 5. Verify
Suite 326 files/5077 tests pass (origin/main 323/5045); tsc exit 0; lint 93 = 93 (origin/main 93); `git diff --stat origin/main...HEAD`:
10 files, +1004/-34 (no catalog JSON, pipeline, quote/swap/gate). Compare:
https://github.com/TeraHashAlpha/teraswap/compare/main...fix/imported-tokens-persist (no PR; CI not polled).

## Deviations / premises (owner to confirm)
- Goal says re-validate via "getCode/decimals"; `useTokenImport` has no getCode — it uses `eth_call` symbol/name/decimals (empty ⇒ no code).
  Re-validation uses that same path.
- Goal says read the Base ETHFI address "from the user's import"; no record of it is in the allowed files, so it came from CoinGecko's
  list (not verified equal to the user's import).
- Extra reads (in scope once recorded): `TokenAddressBadge.tsx`, `TokenSelector.test.tsx`, `useTokenImport.errors.test.ts`,
  `test-utils/render.tsx`, `hooks/useChainId.ts`. Edited `TokenSelector.test.tsx` (+2 lines: mock gains `probeImportedToken`).
