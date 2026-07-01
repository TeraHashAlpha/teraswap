# CHORE-TOKEN-CATALOG-PIPELINE — Cross-verified multi-source token catalog build

**Status:** Implemented (this branch)
**Branch:** `chore/token-catalog-pipeline`
**Depends on:** SPRINT-9Y (pinned generated catalog), CHORE-CATALOG-ADDRESS-GUARD (#209), CHORE-CATALOG-CLEANUP, CHORE-CATALOG-COLLISIONS-DECIMALS

---

## Context

The token catalog is static and effectively single-source:

- `src/lib/tokens.ts` — `DEFAULT_TOKENS`, ~86 hand-curated mainnet tokens (categories, local/proxied logos).
- `scripts/generate-token-catalog.mjs` — bakes `src/lib/chains/token-catalog.generated.ts` from ONE
  vendored snapshot (Uniswap Labs Default v21.3.0) + one hand-added Base USDT + curated
  REMOVALS/REMAPS/DECIMALS_OVERRIDES from past audits.
- `src/lib/chains/tokens.ts` — serves it via `getChainTokenList`/`getFullCatalog`/`getSearchCatalog`.

Two live trust gaps:

1. **The green "verified" badge is fake.** `isVerifiedToken` is *membership-derived* — verified means
   "is in the catalog". On mainnet it even inherits the session import cache (`findTokenByAddress` over
   `getAllTokens()`), so a **manually imported mainnet token flips to ✓** after import. No per-token
   `verified` field exists; `sources` provenance is not persisted.
2. **No cross-verification.** One stale/poisoned list entry (wrong address for a symbol) becomes catalog
   truth. The catalog-address-guard (#209) catches dead/untrusted addresses after the fact, but nothing
   requires independent source agreement at build time.

Dormant scaffolding: `scripts/sync-token-categories.ts` (`npm run tokens:sync`) is a no-op stub;
`scripts/token-category-overrides.ts` is unused. The `/api/token-logo` route + bundled
`public/tokens/*.png` already give a CSP-safe logo story (`img-src 'self'` covers both).

## Objective

Implement `tokens:sync` as a real **build-time** pipeline that produces a cross-verified, per-chain,
**committed** generated catalog consumed behind `getChainTokenList`/`getFullCatalog`, and make the
verified badge **real**: `verified: true` + `sources: [...]` persisted per token, read by
`isVerifiedToken`. Runtime reads the STATIC generated catalog — **no live cross-referencing at runtime**.

## Requirements

1. **Build script** — `npm run tokens:sync` → `tsx scripts/token-catalog/build.ts`. Per chain
   (mainnet 1 + Base 8453): fetch → normalize → cross-verify → on-chain validate → write
   `src/config/generated/token-catalog.<chainId>.json` (committed, deterministic: EIP-55 addresses,
   codepoint sort by lowercase symbol then address, no timestamps in the payload).
2. **Sources** (each normalized to `{chainId, address(EIP-55), symbol, decimals, name, logoURI?}`;
   a source being down must NOT nuke the build — log + continue):
   - `uniswap` — live `https://tokens.uniswap.org`, falling back to the vendored snapshot
     `scripts/token-lists/uniswap-default-v21.3.0.json` (still counts as uniswap; fallback logged).
   - `superchain` — `ethereum-optimism.github.io/optimism.tokenlist.json` (Base 8453 entries).
   - `coingecko` — `tokens.coingecko.com/{ethereum,base}/all.json` (same lists the guard + logo route use).
   - `oneinch` — `tokens.1inch.io/v1.2/{1,8453}` (fallback v1.1).
   - `trustwallet` — `raw.githubusercontent.com/trustwallet/assets/.../blockchains/{ethereum,base}/tokenlist.json`.
   - `defillama` — `coins.llama.fi/prices/current` (batched): identity vote when its symbol/decimals
     agree, plus the price-confidence market signal.
   - Market data: CoinGecko 24h volume when resolvable (optional `COINGECKO_API_KEY`), DefiLlama
     price+confidence otherwise.
3. **Inclusion + `verified: true` only if ALL of:**
   - (a) **≥ `minSources` (2) distinct sources agree on the SAME `(chainId, checksummed address)`** —
     bumped to `lowLiqMinSources` (3) when the token's market signal is below the liquidity floor
     (`liquidityFloorUsd` 24h-volume, or DefiLlama confidence < `defillamaConfidenceMin` when volume
     is unknown). New (non-seed) tokens must additionally count `coingecko` among their sources — this
     keeps the catalog-address-guard `trusted-list` gate green by construction.
   - (b) **On-chain validation**: `symbol()` matches consensus case-insensitively (bytes32 symbols
     handled) and `decimals()` matches exactly. The stored address is the EIP-55 checksum (fixes the
     lowercase-storage casing bug class).
   - Persist `verified: true` + `sources: [...]` per token in the JSON.
4. **Anti-spoofing (critical):** key by **checksummed ADDRESS**, never by symbol. Sources giving
   DIFFERENT addresses for the same symbol are NEVER merged — each address stands alone on its own
   agreement count. If more than one address for the same `(chainId, symbol)` qualifies, keep the one
   with the highest canonical priority (`curated seed > superchain > uniswap > coingecko > oneinch >
   trustwallet > defillama`; tie → more sources → higher volume) and reject the rest, logged as a
   conflict (also keeps the duplicate-symbol guard green). Canonical/bridged preference (Superchain /
   official) is expressed through that priority order.
5. **Core-token allowlist:** fee/routing-critical tokens are ALWAYS included, pinned by address in
   config — mainnet: native ETH, WETH, USDC, USDT, DAI, WBTC; Base: native ETH, WETH, USDC, USDbC,
   DAI, cbETH, AERO (fee-usd fallback path). Cores are still on-chain-validated: a core failing
   on-chain validation FAILS the build (fund-critical). A source outage can never drop a core.
   **Current-catalog seeds** (`DEFAULT_TOKENS` + the previous generated catalog, minus ported curated
   REMOVALS) are never silently dropped: a seed that fails cross-verification stays in the catalog
   with honest `verified: false` and is FLAGGED in the build report + FEEDBACK.
6. **Insertion:** `src/lib/chains/token-catalog.generated.ts` becomes a thin shim re-exporting the
   JSONs (existing `GENERATED_TOKEN_CATALOG` consumers keep working). `Token`/`ChainToken` gain
   `verified?: boolean` + `sources?: string[]`. `isVerifiedToken` reads the REAL field — catalog
   membership no longer implies ✓, and session imports are NEVER verified (fixes the mainnet import
   quirk). Categories: existing `DEFAULT_TOKENS` categories by address → `token-category-overrides.ts`
   → heuristic → `Other`.
7. **Routability stays a USE-TIME check** (existing `checkRoute` at order/swap time). The build does
   NOT call aggregators per token; the liquidity floor is the build-time tradability proxy.
8. **Config (documented, in `scripts/token-catalog/lib/config.ts`):** `minSources=2`,
   `lowLiqMinSources=3`, `liquidityFloorUsd`, `defillamaConfidenceMin`, `maxNewTokensPerChain`
   (growth cap — dropped tokens are LOGGED, no silent truncation), source list + priorities, core
   allowlist, RPC endpoints (`GUARD_RPC_1`/`GUARD_RPC_8453` env, same as the guard). Regeneration:
   scheduled GitHub workflow (`token-catalog-refresh.yml`) runs `tokens:sync` + `guard:refresh` and
   opens a PR (activates once merged to main). P1 = script + first generated catalog + app wiring.

## Do NOT

- NO live cross-referencing at runtime — runtime reads the committed JSON only.
- NEVER merge disagreeing-address same-symbol tokens.
- NEVER overload catalog membership as "verified".
- NEVER drop core tokens on a source outage; NEVER silently drop current tokens (flag in FEEDBACK).
- Do NOT change swap/execution/routing logic.
- Do NOT add a logo CDN host without adding it to `next.config.js` CSP `img-src` (this change adds
  none: logos remain `public/tokens/*` or `/api/token-logo` — both `'self'`).
- Do NOT delete superseded files (`sync-token-categories.ts`, `generate-token-catalog.mjs`) — mark
  superseded.

## Files affected

- `docs/Prompts/CHORE-TOKEN-CATALOG-PIPELINE.md` (this spec)
- `scripts/token-catalog/` — `build.ts` + `lib/{config,types,sources,verify,onchain,category}.ts` + tests
- `src/config/generated/token-catalog.{1,8453}.json` — generated, committed
- `src/lib/chains/token-catalog.generated.ts` — shim over the JSONs
- `src/lib/tokens.ts`, `src/lib/chains/tokens.ts` — `verified`/`sources` fields, real `isVerifiedToken`
- `src/lib/chains/catalog-guard.trust.json` — refreshed for the expanded catalog
- `scripts/sync-token-categories.ts` — superseded marker; `package.json` `tokens:sync` repointed
- `vitest.config.ts` — include `scripts/token-catalog/**/*.test.ts`
- `.github/workflows/ci.yml` — pipeline guard job; `.github/workflows/token-catalog-refresh.yml`
- `FEEDBACK.md` — per-source reliability, seeds failing verification, persistence/scheduling decision

## Expected output

Branch `chore/token-catalog-pipeline` off main, SSH-signed commits, CI green. Committed per-chain
generated catalog; the app shows the expanded catalog with a REAL verified badge; all core tokens
present; `npm run tokens:sync` reproduces the catalog deterministically from the same source data.

## Quality criteria

- Tests: cross-verify (2 vs 3-for-low-liquidity), on-chain symbol/decimals match + mismatch rejection,
  same-symbol address-conflict rejection, allowlist force-include under total source outage,
  source-outage-tolerant build (one source down ⇒ build succeeds, logged).
- `catalog-address-guard` stays green over the expanded catalog (trust fixture refreshed).
- Existing suites pass with the new verified semantics (tests encoding the old membership quirk updated).
- 0C/0H against `docs/security/AUDIT-TOTAL.md`; no fund-flow/swap logic touched.
