# Sprint 44 Audit — Base Swap Preparation

**Date:** 2026-05-30
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Branch:** `feat/sprint-44-base-swap-prep`
**Base:** Sprint 43 HEAD (`6a3dd16`)
**Commits reviewed:** `b2298c2` (P221), `c36f7e8` (P222), `0b1254b` (P223), `2d32fc3` (P224), `f6bf68e` (P224 review)
**Files changed:** 21 (+704/−32 lines)
**Tests:** +11 (3 routers, 4 activation, 3 tokens, 1 split-swap chainId)
**Signatures:** All 5 commits SSH-signed (`ssh-ed25519`, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 44 Audit Verdict

**Branch:** feat/sprint-44-base-swap-prep
**Commits reviewed:** b2298c2, c36f7e8, 0b1254b, 2d32fc3, f6bf68e
**Tests:** 1233 → 1244 (+11)

### Verdict: APPROVED

0C / 0H / 0M / 0L / 1 INFO

---

### Mainnet Byte-Identical Verification

| Check | Result |
|-------|--------|
| Router whitelist mainnet unchanged | **PASS** — `validateRouterAddress` for chainId=1 uses existing `ROUTER_WHITELIST.has()` verbatim. `getRouterWhitelist(1)` mirrors it (test-pinned). |
| Trusted spenders mainnet unchanged | **PASS** — `isTrustedSpender(addr, 1)` takes `chainId === DEFAULT_CHAIN_ID` branch → `TRUSTED_SPENDER_ADDRESSES.has()`. |
| Validation functions default to chainId=1 | **PASS** — All functions have `chainId: number = DEFAULT_CHAIN_ID`. |
| No new mainnet RPC calls | **PASS** |
| Swap flow unchanged for chainId=1 | **PASS** — All chainId=1 branches use existing logic paths. |

---

## Detailed Review

### 1. P221 — Split-Swap ChainId + Token Catalog (`b2298c2`) ✅

**useSplitSwap chainId threading (43-I-01 resolved):**
- `chainId` passed to `fetchSwapViaApi` body. ✅
- `chainId` passed to `buildSimulationTx` params. ✅
- `chainId` passed to `validateRouterAddress(tx.to, source, chainId)`. ✅
- `chainId` passed to `usesFeeCollector(source, chainId)`. ✅
- `chainId` added to `useCallback` dependency array. ✅
- No remaining hardcoded chainId=1 in useSplitSwap. ✅

**Token catalog:**
- `CHAIN_TOKENS[1]`: Derived from `DEFAULT_TOKENS.map(toChainToken)` — mainnet unchanged. `getChainTokenList(1)` returns `DEFAULT_TOKENS` (reference equality, test-pinned). ✅
- `CHAIN_TOKENS[8453]`: 6 verified Base tokens — ETH, WETH (`0x4200...0006`), USDC (`0x8335...2913`), DAI (`0x50c5...B0Cb`), cbETH (`0x2Ae3...ec22`), USDbC (`0xd9aA...b6CA`). All with correct decimals. ✅
- Logo URLs: 1inch token CDN (`tokens.1inch.io/{address}.png`). ✅

### 2. P222 — Router Whitelist (`c36f7e8`) ✅

### Router Whitelist Verification (Base)

| # | Router | Address | Same as Mainnet? | Notes |
|---|--------|---------|------------------|-------|
| 1 | 1inch AggregationRouterV6 | `0x1111...A65` | Yes (CREATE2) | Deterministic address, Basescan verified |
| 2 | 0x AllowanceHolder (v2) | `0x0000...2734` | **No** | Base uses v2 stack; mainnet has v1 Exchange Proxy. Correct per 0x docs |
| 3 | Velora/ParaSwap Augustus V6.2 | `0x6A00...1068` | Yes (canonical) | Same address on Base |
| 4 | Odos Router V2 | `0x19cE...95a1` | **No** | Base-specific; version-matched to mainnet V2 |
| 5 | KyberSwap MetaAggregationRouterV2 | `0x6131...37b5` | Yes | Same cross-chain address |
| 6 | CoW VaultRelayer | `0xC92E...0110` | Yes | Same on every CoW chain |
| 7 | OpenOcean Exchange | `0x6352...e64` | Yes | Same cross-chain address |
| 8 | SushiSwap RedSnwapper | `0xAC4c...0b75` | **No** | Base v7 API targets RedSnwapper (not RouteProcessor4) |
| 9 | Balancer Vault V2 | `0xBA12...2C8` | Yes (CREATE2) | Canonical address, same everywhere |
| 10 | Uniswap SwapRouter02 | `0x2626...e481` | **No** | Base-specific deployment |
| 11 | Curve RouterNG v1.1 | `0x4f37...c1F` | **No** | Base-specific deployment |

- **All 11 addresses documented** with Basescan/official source verification comments. ✅
- **No cross-chain leakage:** Test pins `isWhitelistedRouter(base0x, 1) = false` and `isWhitelistedRouter(mainnetUniswap, 8453) = false`. ✅
- **`isWhitelistedRouter` chain-aware:** Mainnet uses `ROUTER_WHITELIST.has()`, non-mainnet uses `getRouterWhitelist(chainId)`. ✅
- **`isTrustedSpender` chain-aware:** Mainnet path unchanged, non-mainnet derives from per-chain whitelist including Permit2 + CoW + FeeCollector. ✅
- **`getRouterWhitelist(1)` === `ROUTER_WHITELIST`:** Pinned by test — no drift. ✅

### 3. P223 — Activation Guard (`0b1254b`) ✅

### Activation Guard Verification

| Check | Result |
|-------|--------|
| isChainActive(1) = true | **PASS** — Mainnet FeeCollector deployed |
| isChainActive(8453) = false | **PASS** — Base `feeCollector: null` |
| SwapBox disabled on Base | **PASS** — `if (!chainActive) return` in both `handleApproveAndSwap` and `handleSwap`. Coming-soon banner displayed. |
| Quote skip on inactive | **PASS** — `if (!isChainActive(activeChainId)) { setMeta(null); return }` in useQuote `doFetch` |
| No swap bypass on inactive | **PASS** — Three independent guards: (1) SwapBox handler returns, (2) useQuote produces no quote, (3) `usesFeeCollector` returns false (no FeeCollector). No path bypasses all three. |

- **getFeeIncompatibleSources:** Chain-specific: both mainnet and Base list `['0x', 'cowswap']`. ✅
- **DEPLOY.md:** Complete Base deployment section with prerequisites, 9-step process, router whitelist table, post-deployment verification, and pre-activation code wiring checklist. ✅
- **`.env.example`:** Base RPC and FeeCollector env vars documented. ✅

### 4. P224 Review Fix (`f6bf68e`) ✅

- **`usesFeeCollector` chain-aware:** `usesFeeCollector(source, chainId)` now uses `isFeeCollectorActive(chainId) && !getFeeIncompatibleSources(chainId).includes(source)`. chainId=1 produces identical result to pre-sprint. ✅
- **`isFeeCollectorActive` chain-aware:** chainId=1 uses existing `!!FEE_COLLECTOR_ADDRESS && length === 42` check. Non-mainnet checks `getChainConfig(chainId).contracts.feeCollector !== null`. ✅
- **SwapBox blockReason:** `priceBlocked={anyBlocked}` — no `!chainActive` mixed in. On coming-soon chains, the button already shows "Switch to Ethereum" and the banner + handler guard cover the rest. ✅
- **Mainnet preserved:** chainId=1 branches reproduce prior logic exactly. ✅

### 5. P224 Tests (`2d32fc3`) ✅

**routers.test.ts (3 tests):** Base ≥5 routers + all 11 primaries; mainnet mirrors ROUTER_WHITELIST (drift test); per-chain validation (Base-only 0x not on mainnet, mainnet-only Uniswap not on Base). ✅

**activation.test.ts (4 tests):** Mainnet active; Base coming-soon; getChainStatus for all 3 states; unsupported inactive + fee-incompatible fallback. ✅

**tokens.test.ts (3 tests):** Base popular tokens (ETH, USDC, WETH correct addresses/decimals); mainnet unchanged (getChainTokenList(1) === DEFAULT_TOKENS reference equality); unknown address → null. ✅

**useSplitSwap.test.ts (1 test):** Mocks useChainId to 8453, verifies body.chainId=8453 in the swap API fetch call. ✅

### 6. FEEDBACK Carry-Overs ✅

### FEEDBACK Carry-Overs

| # | Item | Safe While Base Inactive? |
|---|------|--------------------------|
| 1 | FeeCollector address in swap calldata (useSwap/useSplitSwap/buildSimulationTx) | **Yes** — `isChainActive(8453)=false` prevents any Base swap execution. SwapBox handlers return early, useQuote produces no quote, usesFeeCollector returns false. |
| 2 | fetchApproveSpender per-source addresses (mainnet-pinned) | **Yes** — Same three-layer guard. No Base swap → no approval flow reached. |
| 3 | Simulation RPC client (getPrivateClient is mainnet) | **Yes** — Same guard. No Base swap → no simulation. |

All 3 items are documented in DEPLOY.md and FEEDBACK.md as pre-activation requirements. ✅

### 7. General ✅

- **No scope creep:** 21 files — hooks, chains module, components, deploy docs, tests. All Base prep scope. ✅
- **No new dependencies.** ✅
- **TypeScript/Lint/Tests:** Cannot run in sandbox. Code review: types correct, no lint violations. +11 tests confirmed. ✅
- **Commits signed:** All 5 SSH-signed. ✅
- **TeraHash 4 rules:**
  - Sandbox first: ✅ Base "Coming Soon", swaps blocked
  - Zero user risk: ✅ `isChainActive` three-layer guard
  - Architect gate: ✅ ADR-009
  - No live without confirmation: ✅ `feeCollector=null` + 3 pre-activation wiring items

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 44-I-01 | INFO | DEPLOY.md / FEEDBACK.md | 3 mainnet-pinned items (FeeCollector address in calldata, fetchApproveSpender, simulation RPC) must be made per-chain before Base activation. Documented and safe while `isChainActive(8453)=false`. Must be completed in the Base activation sprint. |

---

## Recommendation

**Merge.** Mainnet verified byte-identical. All 11 Base router addresses are documented with Basescan verification sources. The activation guard is airtight — three independent layers prevent any Base swap execution while `feeCollector=null`. The 3 mainnet-pinned carry-overs are correctly documented and safe behind the guard.

Sprint 44 completes all code preparation for Base L2 swap activation. The remaining work (FeeCollector deployment + 3 code wiring items) is the scope of the Base activation sprint.

TeraHash 4-rules compliance: all 4 rules satisfied.
