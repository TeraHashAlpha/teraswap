# Sprint 9Y Audit — Expanded Pinned Token Catalog (Matcha-style)

**Date:** 2026-06-08
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Branch:** `feat/sprint-9y-token-catalog`
**Commits reviewed:** `7d144e0` (catalog data+lib), `c5bdb9e` (UI)
**Files changed:** 12 (+20945/−41 lines)
**New files:** `scripts/generate-token-catalog.mjs`, `scripts/token-lists/uniswap-default-v21.3.0.json` (vendored), `src/lib/chains/token-catalog.generated.ts`, `src/components/icons/ChainIcon.tsx`, `src/components/icons/ChainIcon.test.tsx`, `src/components/ChainSelector.test.tsx`, `src/lib/chains/token-catalog.test.ts`
**Tests:** +229 lines of new test code (token-catalog.test.ts) + 30 lines ChainSelector.test.tsx + 28 lines ChainIcon.test.tsx + 60 lines TokenSelector.test.tsx additions
**Signatures:** Both commits SSH-signed (SSH SIGNATURE header present, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 9Y Audit Verdict

### Verdict: APPROVED

0C / 0H / 0M / 0L / 2 INFO

---

## ⚠️ ADDRESS CORRECTNESS IS SECURITY-SENSITIVE — a wrong address means users swap to a scam/wrong token. Every verification step below is oriented around this non-negotiable rule.

---

## Check 1: Catalog source provenance — pinned vendored Uniswap Labs Default v21.3.0 ✅

The catalog is built from a single vendored snapshot: `scripts/token-lists/uniswap-default-v21.3.0.json` (19716 lines). The file header contains SHA256: `cd72e0124f6777828ab75df0574f45c04e8c3326f1e3418872d23059204affb8`.

**Generator (`scripts/generate-token-catalog.mjs`):**
- Reads the vendored JSON, NOT the live URL
- Filters to `TARGET_CHAINS = [1, 8453]` (mainnet + Base)
- Validates each address via `viem getAddress()` (strict EIP-55 checksumming)
- Validates `chainId` matches the target chain
- Validates `decimals` is an integer in `[0, 36]`
- One manual addition: `BASE_USDT` (address `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2`, 6 decimals) — validated inline with the same `validate()` function
- Deterministic sort: by symbol, then by address
- Output: `src/lib/chains/token-catalog.generated.ts`

**Re-generation verification:** Re-ran `node scripts/generate-token-catalog.mjs` from the vendored source in an isolated sandbox (npm-installed viem). Output is BYTE-IDENTICAL to the committed `token-catalog.generated.ts` — zero diff. No drift, no hand edits. ✅

---

## Check 2: Address spot-check — top majors per chain ✅

### Mainnet (all sourced from Uniswap snapshot → well-known canonical addresses)

| Token | Catalog Address | Decimals | Canonical? |
|-------|----------------|----------|-----------|
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | 18 | ✅ |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 | ✅ |
| USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 | ✅ |
| DAI | `0x6B175474E89094C44Da98b954EedeAC495271d0F` | 18 | ✅ |
| WBTC | `0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599` | 8 | ✅ |
| UNI | `0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984` | 18 | ✅ |
| LINK | `0x514910771AF9Ca656af840dff83E8264EcF986CA` | 18 | ✅ |
| AAVE | `0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9` | 18 | ✅ |
| cbETH | `0xBe9895146f7AF43049ca1c1AE358B0541Ea49704` | 18 | ✅ |
| COMP | `0xc00e94Cb662C3520282E6f5717214004A7f26888` | 18 | ✅ |
| MKR | `0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2` | 18 | ✅ |
| SNX | `0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F` | 18 | ✅ |
| CRV | `0xD533a949740bb3306d119CC777fa900bA034cd52` | 18 | ✅ |

### Base

| Token | Catalog Address | Decimals | Source | Canonical? |
|-------|----------------|----------|--------|-----------|
| WETH | `0x4200000000000000000000000000000000000006` | 18 | Uniswap | ✅ canonical Base precompile |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 | Uniswap | ✅ native USDC (Circle) |
| DAI | `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb` | 18 | Uniswap | ✅ |
| cbETH | `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22` | 18 | Uniswap | ✅ Coinbase staked ETH |
| USDbC | `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` | 6 | Uniswap | ✅ bridged USDC (legacy) |
| USDT | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` | 6 | CoinGecko | ✅ BaseScan-verified: "Bridged Tether USD (USDT)", 583k holders |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 8 | Uniswap | ✅ |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` | 18 | Uniswap | ✅ Aerodrome |
| EURC | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` | 6 | Uniswap | ✅ Circle Euro |
| DEGEN | `0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed` | 18 | Uniswap | ✅ |
| VIRTUAL | `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` | 18 | Uniswap | ✅ |
| MORPHO | `0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842` | 18 | Uniswap | ✅ |

All 13 mainnet and 12 Base addresses confirmed. ✅

---

## Check 3: Pre-existing Base addresses match ✅

The 5 hardcoded addresses from the pre-9Y `BASE_TOKENS` array in `tokens.ts` all match the generated catalog exactly:

| Token | Pre-existing | Generated | Match? |
|-------|-------------|-----------|--------|
| WETH | `0x4200000000000000000000000000000000000006` | `0x4200000000000000000000000000000000000006` | ✅ |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | ✅ |
| DAI | `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb` | `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb` | ✅ |
| cbETH | `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22` | `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22` | ✅ |
| USDbC | `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` | `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` | ✅ |

The pre-existing addresses were derived from Uniswap and block-explorer cross-checks. The generated catalog independently sources the same addresses from the pinned Uniswap snapshot — they agree. ✅

---

## Check 4: Non-Uniswap addition — Base USDT ✅

**Note:** The audit request mentioned "USDbC" as the non-Uniswap addition, but the code correctly has USDT — USDbC IS in the Uniswap list already. The single non-Uniswap entry is:

| Field | Value |
|-------|-------|
| Symbol | USDT |
| Address | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` |
| Decimals | 6 |
| Name | Tether USD |
| Source | CoinGecko Base list |

**BaseScan verification:** Fetched `basescan.org/token/0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` — confirmed "Bridged Tether USD (USDT)", ERC-20, 583,396 holders, $24.2M market cap. This is the canonical L2 Standard Bridged USDT on Base (bridged via the official Base bridge; Tether has no native Base deployment).

**Generator treatment:** The `BASE_USDT` constant is passed through the same `validate()` function as every Uniswap entry — `getAddress()` EIP-55 + chainId 8453 + integer decimals. No special path.

**FEEDBACK correctly flags** this entry for explicit owner confirmation (see 9Y-I-02). ✅

---

## Check 5: Mainnet DEFAULT_TOKENS byte-identical (catalog ADD-only) ✅

```typescript
// from tokens.ts
export const CHAIN_TOKENS: Record<number, ChainToken[]> = {
  1: DEFAULT_TOKENS.map(toChainToken),  // UNCHANGED reference
  // ...
}

// from token-catalog.test.ts
expect(getChainTokenList(MAINNET)).toBe(DEFAULT_TOKENS)  // strict reference equality
```

The mainnet default view is the EXACT `DEFAULT_TOKENS` reference — not a copy, not merged with the catalog. `toBe` (identity check) confirms it. The long-tail catalog extends mainnet ONLY via `getFullCatalog()` and `getSearchCatalog()`, which union `DEFAULT_TOKENS` with the Uniswap long tail. Every existing `DEFAULT_TOKENS` entry is present in the full catalog with identical address, symbol, and decimals (test-pinned). ✅

---

## Check 6: Verified ✓ vs imported ⚠ (9P intact) ✅

`isVerifiedToken` was widened from the suggested set to the FULL pinned catalog:

- **Mainnet:** `findTokenByAddress(address) || MAINNET_CATALOG_ADDR.has(addr)` — existing DEFAULT_TOKENS entries still ✓, plus the Uniswap long tail now also ✓
- **Base:** `BASE_CATALOG_ADDR.has(addr)` — the entire pinned Base catalog is ✓
- **Imports (not in any catalog):** Still ⚠ — `isVerifiedToken` returns false

**Test-pinned:**
- Base long-tail catalog token (ZRX) → ✓ on Base
- Mainnet long-tail catalog token (ACX) → ✓ on mainnet
- Unknown imported address → ⚠ on both chains
- Mainnet USDC → ✓ on mainnet, ✗ on Base (cross-chain isolation, 9P)

**`findChainToken` widened** to match: pasting a long-tail catalog address now resolves to the verified token instead of triggering the import flow. Chain-scoped (a Base address does not resolve on mainnet). ✅

---

## Check 7: FEEDBACK — USDe non-canonical checksum ✅ (pre-existing, out of 9Y scope)

FEEDBACK reports that `DEFAULT_TOKENS.USDe` is stored as `0x4c9EDD5852cd905f23c3acF6C2ff8eca3ce50370`, but the canonical EIP-55 checksum is `0x4c9eDD5852CD905F23c3acF6c2ff8eCA3ce50370`. `isAddress(stored, { strict: true })` returns false.

**Assessment:** The lowercase address IS correct (it IS Ethena USDe) — no funds risk. The strict EIP-55 discrepancy is pre-existing (predates 9Y) and the generated catalog's integrity tests correctly scope `getAddress(addr) === addr` to the NEW generated entries, not DEFAULT_TOKENS. One-line follow-up to re-checksum USDe. See 9Y-I-01. ✅

---

## Check 8: UI changes — no security regressions ✅

### TokenSelector.tsx
- Search now uses `getSearchCatalog(activeChainId)` — the full pinned catalog per chain, chain-scoped
- Results capped at `SEARCH_RESULT_LIMIT = 80` — prevents UI jank on broad queries, shows "first 80 — refine to narrow"
- Lazy: `filtered` computed only when `isSearching` is true
- `disabledAddress` filtering preserved (prevents selecting the other side of the swap)

### ChainSelector.tsx
- Colored dots replaced with inline SVG `ChainIcon` — cosmetic only, no external fetch
- No security-relevant changes

### ChainIcon.tsx (NEW)
- Bundled inline SVGs for Ethereum (periwinkle diamond) and Base (blue bar mark)
- `aria-hidden="true"` — decorative, accessible label from chain name
- Falls back to a neutral ring for unknown chains — never throws

### Test coverage
- `ChainSelector.test.tsx` (30 lines): Verifies bundled logos, no `<img>` external fetch
- `ChainIcon.test.tsx` (28 lines): Verifies inline SVG rendering per chain, fallback
- `TokenSelector.test.tsx` (+60 lines): Long-tail search (ACX on mainnet, ZRX on Base), chain-scoping (AERO not on mainnet), selection callback with real catalog token

---

## Check 9: Scope — no existing gate loosening, no contracts ✅

| Scope area | Changed? |
|-----------|----------|
| Any contract / Solidity | **NO** |
| chainlink.ts / useChainlinkPrice.ts / price-gate.ts | **NO** |
| defillama.ts / sequencer-check.ts | **NO** |
| swap-selectors.ts / calldata-recipient.ts | **NO** |
| depeg-gate.ts (9W) | **NO** |
| post-execution-validator.ts | **NO** |
| API routes | **NO** |
| DEFAULT_TOKENS (src/lib/tokens.ts) | **NO** (unchanged reference) |
| CHAINLINK_FEEDS / FEED_HEARTBEAT_SEC | **NO** |
| CSP headers / security headers | **NO** |

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 9Y-I-01 | INFO | `DEFAULT_TOKENS` | Pre-existing: USDe address `0x4c9EDD5852cd905f23c3acF6C2ff8eca3ce50370` has a non-canonical EIP-55 checksum (`isAddress(strict)` returns false). The lowercase address is correct (Ethena USDe) — no funds risk. Out of 9Y scope (mainnet byte-identical). Recommend a one-line re-checksum follow-up (`getAddress()` the stored value). |
| 9Y-I-02 | INFO | `generate-token-catalog.mjs` | The single non-Uniswap catalog entry — USDT on Base (`0xfde4C96c…`, CoinGecko-sourced) — breaks the single-source provenance of the catalog. BaseScan confirms it is the canonical Bridged Tether USD (583k holders, 6 decimals). FEEDBACK correctly flags for owner confirmation. Not a blocker — the entry passes the same `validate()` pipeline as all Uniswap entries. |

---

## Recommendation

**APPROVED for merge — 0C/0H.** The token catalog is a well-sourced, well-guarded data expansion that:
- Sources 486 tokens from a pinned, vendored Uniswap Labs Default snapshot (deterministic, re-generation verified byte-identical)
- Validates every address via `viem getAddress()` (strict EIP-55) + chainId + integer decimals
- Pins 17 major addresses per chain in test fixtures (CI catches accidental edits)
- Preserves mainnet DEFAULT_TOKENS as the exact reference (byte-identical, `toBe` test)
- Extends the verified ✓ badge to the long tail while keeping imports ⚠ (9P intact)
- Maintains cross-chain isolation (Base addresses don't resolve on mainnet)
- Adds comprehensive test coverage (229 lines for the catalog, 118 lines for UI)
- Touches zero existing security gates, contracts, or oracle infrastructure

The USDe checksum (9Y-I-01) and non-Uniswap USDT provenance (9Y-I-02) are clean follow-ups, not blockers.
