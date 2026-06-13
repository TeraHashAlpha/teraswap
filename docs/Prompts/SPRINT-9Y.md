# SPRINT-9Y — Expand token catalog (Matcha-style) + token & chain logos

## Goal (owner request, 2026-06-08)
The Base (and mainnet) token selector shows too few tokens. Match the Matcha experience: a curated
"Suggested Tokens" set + a large searchable catalog + import-by-address for the rest, all with logos,
and add chain logos to the chain selector. Ref: https://www.coingecko.com/en/chains/base

## NON-NEGOTIABLE security rule
Token addresses are NEVER hand-typed. Every catalog address comes from an AUTHORITATIVE, pinned
token-list source and is validated (EIP-55 checksum, correct chainId, correct decimals). A wrong
address = users buy a scam/wrong token. Treat addresses like the 9V/9S oracle addresses: sourced +
verifiable, not guessed. Spot-check the top ~15 per chain on the block explorer and put the source +
snapshot version in the commit message.

## Architecture (mirror the existing chain-aware catalog from 9C/9E/9P)
1. **Curated "Suggested Tokens" (~20–30 per chain)** — the majors shown by default (no search). Base:
   ETH, WETH, USDC, USDbC, DAI, cbETH, cbBTC, AERO, EURC, MORPHO, DEGEN, VIRTUAL, USDT (+ a few more
   by Base market cap). Mainnet: the existing DEFAULT_TOKENS majors stay (mainnet byte-identical for
   what's already there). Addresses from the authoritative list below.
2. **Full searchable catalog** — import a PINNED reputable token-list JSON per chain so search finds
   the long tail. Pick ONE source and pin a version/snapshot (do not fetch live at runtime unless you
   add caching + a non-JSON guard like 9X's fetch-json):
   - Base: CoinGecko Base list (`tokens.coingecko.com/base/all.json`) OR the Superchain/Optimism
     official token list (ethereum-optimism.github.io) — choose, justify, pin.
   - Mainnet: the Uniswap default list OR CoinGecko ethereum list — pin.
   Recommend BAKING a pinned snapshot at build (no runtime dep, addresses reviewable) over live fetch.
   If the full list is large, cap the searchable set sensibly (e.g. top-N by market cap / the list's
   curation) to keep bundle size + search snappy.
3. Integrate with existing behaviour: catalog tokens render the 9P verified ✓ on their chain;
   import-by-address keeps the ⚠ unverified warning; search respects `disabledAddress` + active chain
   (9P); the chain-aware import (9P) is unchanged.

## Logos
- Use each token's `logoURI` from the list; keep the existing `onError` generic-icon fallback so a
  missing/broken logo never breaks the row. Prefer the list's logos over the address-keyed 1inch CDN
  if the list provides them (more reliable per chain).
- **Chain selector logos:** add chain icons (Ethereum, Base) next to the chain names in the chain
  dropdown (the Matcha look). Use static, bundled SVGs/PNGs — no external fetch.

## Tests (TDD)
- Suggested set renders per chain; catalog search finds a long-tail token by symbol/name/address on
  each chain; mainnet existing tokens byte-identical.
- Catalog tokens → verified ✓ on their chain; an imported non-catalog address → ⚠ (9P intact).
- Address integrity: every catalog entry is checksummed + has decimals; a fixture test pins the top
  majors' addresses per chain (guards against accidental edits).
- Search perf: filtering the full catalog stays responsive (no UI jank) — note approach.
- Chain selector renders logos; switching chains swaps the catalog (9P).

## Do NOT
- No hand-typed addresses. No safety-gate / FeeCollector / adapter / oracle changes. No contract
  changes. Mainnet existing catalog behaviour byte-identical (only ADD). Keys server-only.
- Branch `feat/sprint-9y-token-catalog`, atomic SSH-signed commits (catalog data vs UI separate), CI
  green, append FEEDBACK. Not a security GATE, but address-correctness is security-sensitive →
  **Auditor light review** of the address source + the pinned majors before prod. Browser visual check
  is an OWNER post-merge step — do everything automatable and STOP (no loop).
