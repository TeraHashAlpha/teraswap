# SPRINT-9P — Chain-aware token import + verified badge (Base) [URGENT]

## Symptoms (prod, Base only — mainnet fine)
1. Importing a valid Base ERC-20 by address (e.g. `0x6c240dda6b5c336df09a4d011139beaaa1ea2aa2`, listed
   on CoinGecko) fails with "Not a valid ERC-20 token".
2. EVERY token in the Base catalog (WETH `0x4200…0006`, USDC, DAI, cbETH, USDbC) shows the amber ⚠
   "Imported token — verify the address before trading" badge instead of the verified ✓.

## Root causes (confirmed in code)
1. `src/hooks/useTokenImport.ts` line ~34: `const rpcUrl = '/api/rpc'` — hardcoded MAINNET proxy; the
   `eth_call`s for `symbol()/name()/decimals()` run on mainnet regardless of the active chain. A Base
   address doesn't exist on mainnet → `0x` → "Not a valid ERC-20 token". `/api/rpc`
   (`src/app/api/rpc/route.ts`) has no chainId support at all.
2. `src/components/TokenAddressBadge.tsx` line 33: `verified = isVerified ?? !!findTokenByAddress(address)`
   — `findTokenByAddress` searches the MAINNET `DEFAULT_TOKENS` (+ custom), so no Base address ever
   verifies. The whole Base catalog is falsely flagged.
3. Latent: the custom-token store (`addCustomToken`/`getAllTokens`/`findTokenByAddress` in
   `src/lib/tokens.ts`) has NO chain dimension — an import on one chain pollutes lookups on the other,
   and the same address can be DIFFERENT tokens on different chains (cross-chain collision). Note the
   early-return `findTokenByAddress(checksumAddr)` in useTokenImport line ~28 — on Base it can return a
   mainnet token for a colliding address.

## Fix
### P1 — Chain-aware import
- Extend `/api/rpc` to accept a `chainId` (validate: supported chains only, 1|8453 via the registry;
  DEFAULT 1 when absent so existing callers are byte-identical). Server-side, proxy to that chain's RPC
  via the existing `getRpcUrlForChain(chainId)` (never mainnet-off-mainnet). Keep all existing method
  allowlist/rate-limit behaviour.
- `useTokenImport`: use `useActiveChainId()`; run the eth_calls against the active chain; tag the
  imported `Token` with its `chainId`; keep the F-03 sanitization (XSS) exactly as is.
- Make the custom-token store chain-scoped: imported tokens only appear/resolve on their chain (and
  the import early-return must be chain-scoped). Mainnet behaviour byte-identical for mainnet-only use.

### P2 — Chain-aware verified badge
- `TokenAddressBadge` auto-detect must verify against the ACTIVE chain's catalog: mainnet →
  `findTokenByAddress` (unchanged); Base → `getChainToken(address, 8453)` (src/lib/chains/tokens.ts).
  Result: Base catalog tokens show verified ✓; genuinely imported tokens keep the ⚠.
- Check `showExplorerLink`: the explorer URL must be chain-aware too (etherscan.io vs basescan.org) —
  fix if hardcoded.

## Tests (TDD)
- Import a (mocked) Base ERC-20 on Base → succeeds; same address absent on mainnet does not break it.
- Import on mainnet → byte-identical behaviour (chainId default path).
- Cross-chain collision: address X = token A on mainnet catalog, imported as token B on Base — each
  chain resolves its own; no leakage.
- Badge: Base catalog tokens verified ✓ on Base; unknown address ⚠; mainnet badge behaviour unchanged.
- /api/rpc: invalid/unsupported chainId rejected; absent chainId = mainnet (existing tests stay green).

## Do NOT
- Do NOT touch safety gates, FeeCollector paths, adapters, or the 9O fallback. No contract edits.
- Do NOT weaken the F-03 sanitize or the import warning UX (the "anyone can create a token" caution
  stays — it's correct for genuine imports).
- Mainnet byte-identical (test-guarded). Keys server-only.
- Branch `feat/sprint-9p-chain-aware-tokens`, atomic SSH-signed commits, CI green, append FEEDBACK.
  Not a security gate → no Auditor; Preview-test before prod. Human runtime check (actually importing
  the real Base token in a browser) is an OWNER post-merge step — do everything automatable and STOP.
