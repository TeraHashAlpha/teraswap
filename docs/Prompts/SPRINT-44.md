# Sprint 44 — Base Swap Preparation

**Sprint goal:** Complete all remaining code changes needed before Base L2 swap activation. Fix Sprint 43 carry-overs, build the per-chain token catalog, add Base router whitelist config, and prepare the activation guard. After this sprint, Base is ready for FeeCollector deployment (manual step by TeraHash).  
**Branch:** `feat/sprint-44-base-swap-prep` (from `main`)  
**Prerequisite:** Sprint 43 merged. Multi-chain foundation in place.  
**Test count baseline:** 1233 (vitest count after Sprint 43)  
**TeraHash 4 rules:** This sprint is code-only, no deployment, no live changes.

---

## Background

Sprint 43 built the multi-chain foundation. The audit confirmed mainnet byte-identical behavior and identified two carry-overs:

- **43-I-01:** `useSplitSwap.ts` doesn't thread `chainId` yet
- **FEEDBACK:** Per-chain token catalog needed before Base swaps work

Additionally, the FeeCollector deployment on Base requires:
- Known router addresses on Base for the whitelist
- Updated deployment guide for Base
- Activation guard that enables swaps only when FeeCollector address is configured

This sprint completes all code work. The actual FeeCollector deployment (Base Sepolia testnet first, then Base mainnet) is a manual step by TeraHash after this sprint.

---

## P221 — Carry-over fixes (useSplitSwap chainId + token catalog)

### Context

1. `useSplitSwap.ts` is the only swap path that doesn't thread `chainId` through to adapters (43-I-01). The single-swap path was fixed in Sprint 43's review commit (`6a3dd16`).

2. The token selector needs a per-chain token catalog — popular tokens with addresses, symbols, decimals, and logo URLs for Base.

### Objective

Thread `chainId` through `useSplitSwap` and build a per-chain token catalog.

### Requirements

#### Part A — useSplitSwap chainId threading

1. **Pass `chainId` to split-swap quote/swap calls.** `useSplitSwap` calls `fetchSwapData` for each leg. Ensure `chainId` from `useActiveChainId()` is passed through the entire chain:
   - `useSplitSwap` → `fetchSwapData(source, params)` → adapter → API URL resolution
   
2. **Pass `chainId` to `buildSimulationTx` and `simulateSwapTx`.** The P207 split-swap simulation (Sprint 41) uses the shared helper. Ensure chainId reaches the simulation for correct RPC target.

3. **Pass `chainId` to validation functions.** `validateRouterAddress`, `isValidRecipient`, etc. may need chain context for per-chain router/contract whitelist (use `getChainConfig(chainId).contracts`).

#### Part B — Per-chain token catalog

4. **Create `src/lib/chains/tokens.ts`** — per-chain popular token lists:

   ```typescript
   export interface ChainToken {
     address: `0x${string}`
     symbol: string
     name: string
     decimals: number
     logoURI: string
     popular?: boolean  // Show in the default/popular tokens list
   }
   
   export const CHAIN_TOKENS: Record<number, ChainToken[]> = {
     1: [ /* existing mainnet tokens — extract from current token list */ ],
     8453: [
       { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', symbol: 'ETH', name: 'Ethereum', decimals: 18, logoURI: '...', popular: true },
       { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoURI: '...', popular: true },
       { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: '...', popular: true },
       { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18, logoURI: '...', popular: true },
       { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', decimals: 18, logoURI: '...' },
       { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC', name: 'USD Base Coin (Bridged)', decimals: 6, logoURI: '...' },
       // Add ~10-15 popular Base tokens
     ],
   }
   
   export function getPopularTokens(chainId: number): ChainToken[]
   export function getChainToken(address: string, chainId: number): ChainToken | null
   ```

5. **Integrate with TokenSelector.** The token selector component should use `getPopularTokens(chainId)` instead of the hardcoded mainnet list. Custom imported tokens are stored per-chain in localStorage.

6. **Logo URLs.** Use the 1inch token logo CDN (`https://tokens.1inch.io/{address}.png`) which supports Base tokens. Fallback to a generic token icon.

### Do NOT

- Do NOT change the split-swap execution flow — only add chainId passthrough
- Do NOT change the token import mechanism — only the default/popular list
- Do NOT add new tokens to the mainnet list — only build the Base list
- Do NOT remove any existing token data

### Files affected

- `src/hooks/useSplitSwap.ts` — thread chainId through all calls
- `src/lib/chains/tokens.ts` — **CREATE** (per-chain token catalog)
- `src/components/TokenSelector.tsx` — use per-chain popular tokens
- `src/lib/swap-simulation.ts` — accept chainId parameter

### Expected output

1 commit: `feat(base): thread chainId through split-swap + add per-chain token catalog [P221]`

### Quality criteria

- `useSplitSwap` passes `chainId` to all adapter and simulation calls
- `getPopularTokens(8453)` returns Base tokens with correct addresses
- `getPopularTokens(1)` returns existing mainnet tokens (unchanged)
- Token selector shows Base tokens when on Base chain
- `npm run typecheck` passes
- All existing tests pass

---

## P222 — Base router whitelist configuration

### Context

The FeeCollector's `bootstrapRouters()` needs a list of DEX router addresses on Base. Each aggregator API tells us which router contract to call. These addresses are different from mainnet.

### Objective

Research and document all Base DEX router addresses for the FeeCollector whitelist. Create a per-chain router config.

### Requirements

1. **Create `src/lib/chains/routers.ts`** — per-chain router whitelist:

   ```typescript
   export const ROUTER_WHITELIST_BY_CHAIN: Record<number, Record<string, `0x${string}`>> = {
     1: {
       // Existing mainnet routers — extract from ROUTER_WHITELIST in constants.ts
       '1inch': '0x...',
       '0x': '0x...',
       // ...
     },
     8453: {
       // Base router addresses — verified from each aggregator's API/docs
       '1inch': '0x111111125421cA6dc452d289314280a0f8842A65', // AggregationRouterV6 on Base
       '0x': '0xDef1C0ded9bec7F1a1670819833240f027b25EfF',   // ExchangeProxy on Base
       // ... research each adapter's router on Base
     },
   }
   
   export function getRouterWhitelist(chainId: number): `0x${string}`[]
   export function isWhitelistedRouter(address: string, chainId: number): boolean
   ```

2. **Research Base router addresses.** For each of the 11 adapters, determine the router contract address on Base. Methods:
   - Call each adapter's `/spender` or equivalent endpoint with chainId=8453
   - Check each protocol's documentation/deployment page
   - Verify on Basescan that the addresses are legitimate contracts
   
   Document the source of each address as a comment in the code.

3. **Update `validateRouterAddress`.** Make it chain-aware:
   ```typescript
   export function validateRouterAddress(address: string, chainId: number = 1): boolean {
     return isWhitelistedRouter(address, chainId)
   }
   ```

4. **Update `TRUSTED_SPENDER_ADDRESSES`.** Make it chain-aware (per Sprint 40's P203 spender allowlist). Each chain has its own set of trusted spender addresses (routers + FeeCollector + Permit2).

5. **Backward compatibility.** The existing `ROUTER_WHITELIST` and `TRUSTED_SPENDER_ADDRESSES` in `constants.ts` should continue to work for mainnet (re-export or delegate to chainId=1).

### Do NOT

- Do NOT deploy any contracts — this is config preparation only
- Do NOT guess router addresses — only use verified sources (API responses, official docs, Basescan verification)
- Do NOT change the mainnet router whitelist
- Do NOT change the FeeCollector contract

### Files affected

- `src/lib/chains/routers.ts` — **CREATE** (per-chain router whitelist)
- `src/lib/calldata-recipient.ts` — make `validateRouterAddress` chain-aware
- `src/hooks/useApproval.ts` — make `isTrustedSpender` chain-aware
- `src/components/SwapBox.tsx` — pass chainId to spender validation
- `src/lib/constants.ts` — backward compat re-exports

### Expected output

1 commit: `feat(base): per-chain router whitelist + chain-aware validation [P222]`

### Quality criteria

- `getRouterWhitelist(8453)` returns verified Base router addresses
- `getRouterWhitelist(1)` returns existing mainnet routers (unchanged)
- `validateRouterAddress(addr, 8453)` checks against Base whitelist
- `isTrustedSpender(addr, 8453)` includes Base routers + Permit2
- Each Base router address has a comment documenting its source
- `npm run typecheck` passes
- All existing tests pass

---

## P223 — Swap activation guard + deployment preparation

### Context

Base currently shows "Coming Soon" because `feeCollector === null` in the ChainConfig. When the FeeCollector is deployed on Base, the config needs to be updated and swaps enabled. This prompt creates the activation guard logic and updates the deployment documentation.

### Objective

Build the activation guard that safely enables swaps per chain, and prepare deployment docs for Base.

### Requirements

1. **Activation guard.** Create `src/lib/chains/activation.ts`:

   ```typescript
   export function isChainActive(chainId: number): boolean {
     const config = getChainConfig(chainId)
     return config.contracts.feeCollector !== null
   }
   
   export function getChainStatus(chainId: number): 'active' | 'coming-soon' | 'unsupported' {
     try {
       const config = getChainConfig(chainId)
       if (config.contracts.feeCollector === null) return 'coming-soon'
       return 'active'
     } catch {
       return 'unsupported'
     }
   }
   ```

2. **SwapBox integration.** When `isChainActive(chainId) === false`:
   - Disable the swap button
   - Show "Coming Soon on {chainName}" message
   - Hide/disable the quote fetching (don't waste API calls)
   - Keep the token selector and amount input functional (users can browse)

3. **Quote gate.** In `useQuote.ts`, skip fetching when chain is not active:
   ```typescript
   if (!isChainActive(chainId)) return // No quotes for inactive chains
   ```

4. **FEE_INCOMPATIBLE sources per chain.** The mainnet has `FEE_INCOMPATIBLE_SOURCES = ['0x', 'cowswap']` (sources that can't route through FeeCollector). On Base, this may be different. Make it per-chain:
   ```typescript
   export function getFeeIncompatibleSources(chainId: number): string[]
   ```

5. **Update `contracts/DEPLOY.md`** — add Base deployment section:
   ```markdown
   ## Base Deployment
   
   ### Prerequisites
   - Base ETH for gas (~0.001 ETH on Base)
   - Admin wallet with Base ETH
   - Basescan API key for verification
   
   ### Steps
   1. Deploy on Base Sepolia (testnet) first
   2. Bootstrap routers with Base whitelist
   3. Verify on testnet Basescan
   4. Test end-to-end swap flow on testnet
   5. Deploy on Base mainnet
   6. Bootstrap routers
   7. Verify on Basescan
   8. Update ChainConfig: set contracts.feeCollector
   9. Set NEXT_PUBLIC_BASE_RPC_URL in environment
   
   ### Router Whitelist (Base)
   [List from P222's routers.ts]
   
   ### Post-Deployment Verification
   - `whitelistedRouters(routerAddress)` returns true for each listed router
   - `feeRecipient()` matches expected address
   - `admin()` matches expected admin wallet
   - `FEE_BPS()` returns 10 (0.1%)
   ```

6. **Environment variable documentation.** Add to `.env.example`:
   ```
   # Base L2 (Phase 2)
   NEXT_PUBLIC_BASE_RPC_URL=         # Base mainnet RPC (Alchemy/QuickNode)
   NEXT_PUBLIC_BASE_FEE_COLLECTOR=   # FeeCollector address on Base (set after deployment)
   ```

### Do NOT

- Do NOT deploy any contracts — only prepare docs and code
- Do NOT set any Base addresses in production config — leave as null/empty until deployment
- Do NOT change mainnet activation status
- Do NOT add a "deploy" button or automated deployment

### Files affected

- `src/lib/chains/activation.ts` — **CREATE**
- `src/components/SwapBox.tsx` — activation guard UI
- `src/hooks/useQuote.ts` — skip quote on inactive chain
- `src/lib/constants.ts` — per-chain fee-incompatible sources
- `contracts/DEPLOY.md` — add Base deployment section
- `.env.example` — add Base env vars

### Expected output

1 commit: `feat(base): swap activation guard + Base deployment preparation [P223]`

### Quality criteria

- `isChainActive(1)` returns `true` (mainnet has FeeCollector)
- `isChainActive(8453)` returns `false` (Base FeeCollector not deployed)
- SwapBox shows "Coming Soon on Base" when on Base
- Quote fetching skipped on inactive chains
- `contracts/DEPLOY.md` has complete Base deployment guide
- `.env.example` has Base variables documented
- `npm run typecheck` passes
- All existing tests pass

---

## P224 — Tests

### Context

P221-P223 added split-swap chainId threading, token catalog, router whitelist, and activation guard. This prompt adds test coverage.

### Requirements

#### Split-swap chainId tests (in `src/hooks/useSplitSwap.test.ts` — ADD)

1. **`'passes chainId to adapter calls'`** — mock adapter, verify chainId is forwarded.

#### Token catalog tests (in `src/lib/chains/tokens.test.ts` — CREATE)

2. **`'returns Base popular tokens for chainId 8453'`** — verify ETH, USDC, WETH present with correct addresses.
3. **`'returns mainnet tokens for chainId 1'`** — verify existing tokens unchanged.
4. **`'getChainToken returns null for unknown address'`** — verify graceful fallback.

#### Router whitelist tests (in `src/lib/chains/routers.test.ts` — CREATE)

5. **`'Base whitelist contains at least 5 routers'`** — verify populated.
6. **`'mainnet whitelist matches existing ROUTER_WHITELIST'`** — verify backward compat.
7. **`'isWhitelistedRouter validates per chain'`** — Base router not valid on mainnet and vice versa.

#### Activation guard tests (in `src/lib/chains/activation.test.ts` — CREATE)

8. **`'mainnet is active'`** — `isChainActive(1)` returns true.
9. **`'Base is coming-soon'`** — `isChainActive(8453)` returns false (feeCollector null).
10. **`'getChainStatus returns correct status'`** — test all three states.
11. **`'unsupported chain returns unsupported'`** — `getChainStatus(99999)`.

### Do NOT

- Do NOT test actual API calls — mock at appropriate level
- Do NOT add external dependencies

### Files affected

- `src/hooks/useSplitSwap.test.ts` — ADD (1 test)
- `src/lib/chains/tokens.test.ts` — **CREATE** (3 tests)
- `src/lib/chains/routers.test.ts` — **CREATE** (3 tests)
- `src/lib/chains/activation.test.ts` — **CREATE** (4 tests)

### Expected output

1 commit: `test: add Base swap preparation tests [P224]`

### Quality criteria

- All 11 new tests pass
- All existing tests pass
- `npm run typecheck` passes
- Test count: 1233 + 11 = **~1244**

---

## Sprint Summary

| Prompt | Scope | Files | Deliverable |
|--------|-------|-------|-------------|
| P221 | Split-swap chainId + token catalog | 4 files | 43-I-01 closed + Base tokens |
| P222 | Router whitelist per chain | 5 files | Base router addresses + chain-aware validation |
| P223 | Activation guard + deploy docs | 6 files | Coming Soon logic + DEPLOY.md update |
| P224 | Tests | 4 files | 11 new tests |

**Total estimated scope:** 4 commits, ~16 files, ~11 new tests.

**Test count target:** ~1244

**Risk assessment:** LOW. All changes are additive. Base remains "Coming Soon" — no live activation. The router address research (P222) requires verification against official sources.

**Dependency chain:** P221 and P222 are independent. P223 depends on P222 (references router whitelist in deploy docs). P224 depends on all.

**Post-sprint state:** All code changes complete for Base swap activation. TeraHash can deploy FeeCollector on Base Sepolia → test → deploy on Base mainnet → update config → swaps go live.

**Next steps after Sprint 44 (manual by TeraHash):**
1. Deploy FeeCollector on Base Sepolia (testnet)
2. Bootstrap with router whitelist from P222
3. Test end-to-end swap on testnet
4. Deploy FeeCollector on Base mainnet
5. Update ChainConfig with deployed address
6. Set Base RPC URL
7. Audit + go live

---

_Sprint 44 completes all code preparation for Base swaps. After this sprint, the only remaining step is FeeCollector deployment (manual) and configuration._
