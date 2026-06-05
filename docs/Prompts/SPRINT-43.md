# Sprint 43 — Multi-Chain Foundation (Phase 2 Kickoff)

**Sprint goal:** Build the multi-chain abstraction layer that enables Base L2 support (and future chains) without modifying existing mainnet behavior. After this sprint, the codebase is chain-aware but mainnet remains the only active chain.  
**Branch:** `feat/sprint-43-multi-chain-foundation` (from `main`)  
**Prerequisite:** Sprint 42 merged. All 27 audit findings closed. ADR-009 accepted.  
**Test count baseline:** 1219 (vitest count after Sprint 42)  
**Architecture:** See `docs/ADR/ADR-009-multi-chain-architecture.md`

---

## Background

TeraSwap is expanding to Base L2 as the first multi-chain step. All 11 DEX aggregator APIs support Base (chainId 8453). Chainlink has price feeds on Base with a mandatory sequencer uptime feed. Base uses the OP Stack gas model (L2 execution + L1 data cost).

This sprint builds the foundation layer. It does NOT deploy contracts, activate Base swaps, or change the user-facing product. It makes the codebase chain-aware so subsequent sprints can add Base with minimal per-sprint risk.

### Research findings (all 11 adapters support Base)

| Adapter | Base API pattern | Change needed |
|---------|-----------------|--------------|
| 1inch | `/v6.0/{chainId}` | Parameterize path segment |
| 0x | `chainId` query param | Add param to request |
| Velora | `network` path param | Parameterize path segment |
| Odos | `chainId` in POST body | Already parameterized, verify |
| KyberSwap | `/{chainSlug}` path | Parameterize path segment |
| CoW | `/{chainSlug}/api/v1` | Already has `getCowApiBase(chainId)` |
| OpenOcean | `/v4/{chainId}` | Parameterize path segment |
| Uniswap V3 | On-chain (contracts) | Per-chain contract addresses |
| SushiSwap | `/swap/v7/{chainId}` | Parameterize path segment |
| Balancer | `chainId` param | Add param to request |
| Curve | On-chain (contracts) | Per-chain contract addresses |

---

## P216 — ChainConfig type system and registry

### Context

The codebase currently hardcodes `CHAIN_ID = 1` in `constants.ts` and uses it throughout. Contract addresses, Chainlink feeds, adapter URLs, and RPC config all assume Ethereum mainnet. To support Base (and future chains), we need a typed configuration registry.

### Objective

Create a `ChainConfig` type and a registry that resolves all chain-specific values.

### Requirements

1. **Create `src/lib/chains/types.ts`** with the `ChainConfig` interface:

   ```typescript
   export interface ChainConfig {
     chainId: number
     name: string
     slug: string                    // API path segment: 'ethereum', 'base'
     nativeCurrency: {
       symbol: string                // 'ETH'
       decimals: number              // 18
       wrappedAddress: `0x${string}` // WETH address on this chain
     }
     contracts: {
       feeCollector: `0x${string}` | null  // null = not deployed yet
       feeCollectorV1?: `0x${string}`      // legacy, mainnet only
       permit2: `0x${string}`
       cowVaultRelayer?: `0x${string}`
     }
     rpc: {
       primary: string
       fallbacks: string[]
     }
     blockExplorer: string
     gasModel: 'eip1559' | 'op-stack'
     sequencerUptimeFeed?: `0x${string}`   // L2 only — Chainlink sequencer check
     tokens: Record<string, `0x${string}`> // symbol → address mapping (USDC, USDT, DAI, WBTC, etc.)
   }
   ```

2. **Create `src/lib/chains/registry.ts`** with:

   ```typescript
   export const CHAIN_CONFIGS: Record<number, ChainConfig> = {
     1: { /* Ethereum mainnet — migrated from existing constants */ },
     8453: { /* Base — new */ },
   }
   
   export function getChainConfig(chainId: number): ChainConfig {
     const config = CHAIN_CONFIGS[chainId]
     if (!config) throw new Error(`Unsupported chain: ${chainId}`)
     return config
   }
   
   export function getSupportedChainIds(): number[] {
     return Object.keys(CHAIN_CONFIGS).map(Number)
   }
   
   export const DEFAULT_CHAIN_ID = 1 // Mainnet default
   ```

3. **Ethereum mainnet config.** Populate from existing constants — move `FEE_COLLECTOR_ADDRESS`, `PERMIT2_ADDRESS`, `COW_VAULT_RELAYER`, etc. into the mainnet `ChainConfig`. The old constants should re-export from the registry for backward compatibility:

   ```typescript
   // In constants.ts — backward compat
   export const CHAIN_ID = DEFAULT_CHAIN_ID
   export const FEE_COLLECTOR_ADDRESS = getChainConfig(1).contracts.feeCollector!
   ```

4. **Base config.** Populate what we know:
   - `chainId: 8453`
   - `name: 'Base'`
   - `slug: 'base'`
   - `nativeCurrency: { symbol: 'ETH', decimals: 18, wrappedAddress: '0x4200000000000000000000000000000000000006' }` (Base WETH)
   - `contracts.feeCollector: null` (not deployed yet)
   - `contracts.permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3'` (same on all chains — CREATE2)
   - `contracts.cowVaultRelayer: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'` (CoW on Base)
   - `rpc.primary: ''` (env var `NEXT_PUBLIC_BASE_RPC_URL`, with empty string default — not active yet)
   - `blockExplorer: 'https://basescan.org'`
   - `gasModel: 'op-stack'`
   - `sequencerUptimeFeed: '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433'`
   - `tokens: { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', WETH: '0x4200000000000000000000000000000000000006', DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', ... }`

5. **Create `src/lib/chains/index.ts`** — barrel export.

### Do NOT

- Do NOT remove or rename existing constants in `constants.ts` — re-export from registry for backward compatibility
- Do NOT change any existing imports across the codebase — other prompts handle migration
- Do NOT activate Base in wagmi config or UI — this prompt is types + data only
- Do NOT add environment variables to `.env` files yet — just define the env var names in config

### Files affected

- `src/lib/chains/types.ts` — **CREATE**
- `src/lib/chains/registry.ts` — **CREATE**
- `src/lib/chains/index.ts` — **CREATE**
- `src/lib/constants.ts` — add re-exports from registry (backward compat)

### Expected output

1 commit: `feat(multi-chain): add ChainConfig type system and registry [P216]`

### Quality criteria

- `getChainConfig(1)` returns full Ethereum mainnet config
- `getChainConfig(8453)` returns Base config with `feeCollector: null`
- `getChainConfig(99999)` throws "Unsupported chain"
- Existing code using `CHAIN_ID`, `FEE_COLLECTOR_ADDRESS`, etc. from `constants.ts` continues to work (re-exports)
- `npm run typecheck` passes
- All existing tests pass

---

## P217 — Adapter URL parameterization

### Context

The 11 DEX adapters in `src/lib/adapters/` hardcode Ethereum mainnet API URLs. To support Base, each adapter must resolve its URL from the chain config.

### Objective

Make all adapters chain-aware by parameterizing their API URLs.

### Requirements

1. **Create `src/lib/chains/adapter-urls.ts`** — a function that resolves adapter API URL per chain:

   ```typescript
   export function getAdapterApiUrl(source: AggregatorName, chainId: number): string
   ```

   Mapping:
   
   | Source | Mainnet (1) | Base (8453) |
   |--------|------------|-------------|
   | 1inch | `https://api.1inch.dev/swap/v6.0/1` | `https://api.1inch.dev/swap/v6.0/8453` |
   | 0x | `https://api.0x.org` (chainId as param) | Same host, `chainId=8453` |
   | Velora | `https://api.paraswap.io/...?network=1` | `...?network=8453` |
   | Odos | `https://api.odos.xyz` (chainId in body) | Same host, `chainId: 8453` in body |
   | KyberSwap | `https://aggregator-api.kyberswap.com/ethereum` | `...com/base` |
   | CoW | Already handled by `getCowApiBase(chainId)` | Verify it maps 8453 → `base` |
   | OpenOcean | `https://open-api.openocean.finance/v4/1` | `.../v4/8453` |
   | SushiSwap | `https://api.sushi.com/swap/v7/1` | `.../v7/8453` |
   | Balancer | `https://api-v3.balancer.fi` (chainId as param) | Same host, `chainId=8453` |
   | Uniswap V3 | On-chain (contract addresses) | Per-chain from `ChainConfig.contracts` |
   | Curve | On-chain (contract addresses) | Per-chain from `ChainConfig.contracts` |

2. **Update each adapter** to accept `chainId` and resolve its URL:

   For adapters that use a URL path pattern (1inch, KyberSwap, CoW, OpenOcean, SushiSwap):
   ```typescript
   // Before:
   const url = 'https://api.1inch.dev/swap/v6.0/1/swap'
   
   // After:
   const url = `${getAdapterApiUrl('1inch', chainId)}/swap`
   ```

   For adapters that use a query/body param (0x, Velora, Odos, Balancer):
   ```typescript
   // Before:
   const body = { chainId: CHAIN_ID, ... }
   
   // After:
   const body = { chainId, ... }
   ```

3. **Update `getCowApiBase`** in `constants.ts` to support `8453`:
   ```typescript
   8453: 'https://api.cow.fi/base/api/v1'
   ```

4. **Pass `chainId` through the adapter call chain.** `fetchMetaQuote` and `fetchSwapData` in `api.ts` already accept `chainId` in params (via `QuoteParams.chainId`). Ensure it propagates to every adapter's `fetchQuote` and `fetchSwapData` calls.

5. **Default to `DEFAULT_CHAIN_ID` (1).** If `chainId` is not provided, fall back to mainnet. This preserves all existing behavior.

### Do NOT

- Do NOT change the adapter response parsing — only URL/param changes
- Do NOT add Base-specific routing logic (e.g., Aerodrome) — that's a future sprint
- Do NOT change rate limiting or error handling
- Do NOT remove any existing adapter functionality

### Files affected

- `src/lib/chains/adapter-urls.ts` — **CREATE**
- `src/lib/adapters/oneinch.ts` — parameterize URL
- `src/lib/adapters/zerox.ts` — add chainId param
- `src/lib/adapters/velora.ts` — parameterize network param
- `src/lib/adapters/odos.ts` — verify chainId passthrough
- `src/lib/adapters/kyberswap.ts` — parameterize path
- `src/lib/adapters/cow.ts` — update getCowApiBase for 8453
- `src/lib/adapters/openocean.ts` — parameterize path
- `src/lib/adapters/sushiswap.ts` — parameterize path
- `src/lib/adapters/balancer.ts` — add chainId param
- `src/lib/adapters/uniswapv3.ts` — note: on-chain, needs per-chain contracts (future sprint)
- `src/lib/adapters/curve.ts` — note: on-chain, needs per-chain contracts (future sprint)
- `src/lib/constants.ts` — update getCowApiBase

### Expected output

1 commit: `feat(multi-chain): parameterize adapter URLs for chain-aware routing [P217]`

### Quality criteria

- All adapters accept `chainId` parameter
- `chainId=1` produces same URLs as before (no behavioral change)
- `chainId=8453` produces correct Base API URLs
- `getCowApiBase(8453)` returns `https://api.cow.fi/base/api/v1`
- `npm run typecheck` passes
- All existing tests pass

---

## P218 — Chainlink multi-chain feeds + sequencer uptime check

### Context

The Chainlink feed registry (`CHAINLINK_FEEDS` in `constants.ts`) maps token addresses to mainnet feed proxy addresses. For Base, we need a per-chain feed map AND a mandatory sequencer uptime check before any oracle read.

### Objective

Make the Chainlink oracle system chain-aware and add L2 sequencer uptime validation.

### Requirements

1. **Create `src/lib/chains/chainlink-feeds.ts`** — per-chain feed registry:

   ```typescript
   export const CHAINLINK_FEEDS_BY_CHAIN: Record<number, Record<string, `0x${string}`>> = {
     1: { /* existing mainnet feeds — moved from constants.ts */ },
     8453: {
       // Base Chainlink feeds (verified from data.chain.link)
       'ETH/USD': '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
       // ... add major pairs available on Base
     },
   }
   
   export function getChainlinkFeed(tokenAddress: string, chainId: number = 1): `0x${string}` | null
   ```

2. **Backward compatibility.** The existing `getChainlinkFeed(tokenAddress)` in `chainlink.ts` must continue to work (defaults to chainId=1). Add chainId as optional parameter.

3. **Sequencer uptime check.** Create a function in `src/lib/chains/sequencer-check.ts`:

   ```typescript
   export async function isSequencerUp(chainId: number, publicClient: PublicClient): Promise<boolean>
   ```

   - For chains without `sequencerUptimeFeed` (mainnet), always return `true`
   - For L2 chains, read the sequencer uptime feed:
     - `answer === 0` → sequencer is UP
     - `answer === 1` → sequencer is DOWN → return `false`
   - **Grace period:** After sequencer comes back up, price feeds may still be stale. Check `startedAt` — if sequencer recovered less than `SEQUENCER_GRACE_PERIOD` (3600 seconds) ago, return `false` (treat as still down).
   - Cache the result for 30 seconds to avoid repeated RPC calls.

4. **Integrate sequencer check into oracle reads.** In `chainlink.ts`, before any `latestRoundData` call, check sequencer status:

   ```typescript
   if (chainId !== 1) { // Only for L2 chains
     const seqUp = await isSequencerUp(chainId, publicClient)
     if (!seqUp) {
       console.warn(`[TeraSwap] Sequencer down or in grace period on chain ${chainId}`)
       return null
     }
   }
   ```

   This applies to: `fetchChainlinkPriceRaw`, `fetchHistoricalPrice`, and `getChainlinkPriceUSD` (price-monitor).

5. **Backward compat for existing CHAINLINK_FEEDS.** The `CHAINLINK_FEEDS` constant in `constants.ts` should re-export from the new per-chain registry:
   ```typescript
   export const CHAINLINK_FEEDS = CHAINLINK_FEEDS_BY_CHAIN[1] ?? {}
   ```

### Do NOT

- Do NOT change the oracle validation logic (staleness, round completeness) — only add chain awareness and sequencer check
- Do NOT remove any existing feeds
- Do NOT change `CHAINLINK_MAX_STALENESS_SEC`
- Do NOT add feeds for tokens that don't have verified Chainlink feeds on Base — better to have no feed (falls through to DefiLlama/fail-safe) than a wrong one

### Files affected

- `src/lib/chains/chainlink-feeds.ts` — **CREATE** (per-chain feed registry)
- `src/lib/chains/sequencer-check.ts` — **CREATE** (L2 sequencer uptime)
- `src/lib/chainlink.ts` — add chainId param + sequencer check
- `src/lib/price-monitor.ts` — pass chainId to oracle reads
- `src/lib/constants.ts` — re-export from per-chain registry

### Expected output

1 commit: `feat(multi-chain): per-chain Chainlink feeds with L2 sequencer uptime check [P218]`

### Quality criteria

- `getChainlinkFeed('0x...WETH', 1)` returns mainnet ETH/USD feed
- `getChainlinkFeed('0x...WETH', 8453)` returns Base ETH/USD feed
- `isSequencerUp(1, client)` always returns `true` (no sequencer on mainnet)
- `isSequencerUp(8453, client)` checks the Base sequencer feed
- Sequencer down → all oracle reads return `null`
- Grace period (3600s after recovery) → oracle reads return `null`
- Existing mainnet oracle behavior unchanged
- `npm run typecheck` passes
- All existing tests pass

---

## P219 — Wagmi multi-chain config + chain selector UI

### Context

`wagmiConfig.ts` configures Wagmi with `[mainnet]` only. The frontend has no chain selector. For multi-chain, we need Wagmi configured for both chains and a UI component for switching.

### Objective

Configure Wagmi for Mainnet + Base and add a chain selector component.

### Requirements

1. **Update `src/lib/wagmiConfig.ts`:**

   ```typescript
   import { mainnet, base } from 'wagmi/chains'
   
   // Add Base to the chains array
   chains: [mainnet, base]
   
   // Add Base transport (using env var or public RPC)
   transports: {
     [mainnet.id]: /* existing mainnet transport */,
     [base.id]: fallback([
       http(process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org'),
     ]),
   }
   ```

2. **Create `src/components/ChainSelector.tsx`:**
   - Dropdown/button that shows current chain (icon + name)
   - Lists supported chains: Ethereum Mainnet, Base
   - Uses wagmi's `useSwitchChain` hook to switch
   - Shows chain icon (Ethereum diamond, Base logo)
   - Compact design — fits in the header/nav area
   - Dark theme, consistent with existing TeraSwap design
   - When chain switches, all chain-dependent state resets (quotes clear, tokens reset to chain defaults)

3. **Create `src/hooks/useChainId.ts`** — a thin wrapper that provides the current chainId:

   ```typescript
   export function useActiveChainId(): number {
     const { chain } = useAccount()
     return chain?.id ?? DEFAULT_CHAIN_ID
   }
   ```

4. **Chain-aware token list.** The token selector must filter by active chain:
   - When on mainnet, show mainnet tokens (existing behavior)
   - When on Base, show Base tokens
   - The popular tokens list should be per-chain
   - Imported custom tokens are chain-specific

5. **Swap state reset on chain switch.** When the user switches chains:
   - Clear current quote
   - Reset selected tokens to chain defaults (ETH + USDC for both chains, but different addresses)
   - Clear any pending swap state
   - Clear error messages

6. **Base NOT active by default.** The chain selector should be present but Base should show a "Coming Soon" indicator if `getChainConfig(8453).contracts.feeCollector === null` (no FeeCollector deployed). Users can switch to Base in wallet but swaps won't be available until FeeCollector is deployed.

### Do NOT

- Do NOT change RainbowKit config beyond adding Base chain support
- Do NOT add bridge functionality — chain switching only
- Do NOT change the swap execution flow — only the chain context
- Do NOT remove mainnet as default chain
- Do NOT add custom Base RPC to `.env` files — use public default for now

### Files affected

- `src/lib/wagmiConfig.ts` — add Base chain + transport
- `src/components/ChainSelector.tsx` — **CREATE**
- `src/hooks/useChainId.ts` — **CREATE**
- `src/components/Header.tsx` (or wherever nav lives) — add ChainSelector
- `src/components/TokenSelector.tsx` — filter by active chain
- `src/hooks/useQuote.ts` — pass chainId from useActiveChainId
- `src/hooks/useSwap.ts` — reset on chain switch

### Expected output

1 commit: `feat(multi-chain): wagmi Base config + chain selector UI [P219]`

### Quality criteria

- Wagmi accepts connections on both Mainnet and Base
- Chain selector shows current chain with icon
- Switching chains resets swap state
- Token selector shows chain-appropriate tokens
- Base shows "Coming Soon" for swaps (no FeeCollector)
- Mainnet behavior completely unchanged when selected
- `npm run typecheck` passes
- All existing tests pass

---

## P220 — Tests

### Context

P216-P219 built the multi-chain foundation. This prompt adds test coverage.

### Requirements

#### ChainConfig tests (in `src/lib/chains/registry.test.ts` — CREATE)

1. **`'returns mainnet config for chainId 1'`** — verify all required fields populated.
2. **`'returns Base config for chainId 8453'`** — verify chainId, slug, sequencerUptimeFeed present, feeCollector null.
3. **`'throws on unsupported chain'`** — `getChainConfig(99999)` throws.
4. **`'getSupportedChainIds includes 1 and 8453'`** — verify both present.

#### Adapter URL tests (in `src/lib/chains/adapter-urls.test.ts` — CREATE)

5. **`'1inch URL includes chainId in path'`** — verify `/8453/` for Base, `/1/` for mainnet.
6. **`'KyberSwap URL uses chain slug'`** — verify `/base/` for Base, `/ethereum/` for mainnet.
7. **`'CoW API base maps 8453 to /base/'`** — verify `getCowApiBase(8453)`.
8. **`'default chainId returns mainnet URL'`** — verify fallback.

#### Sequencer uptime tests (in `src/lib/chains/sequencer-check.test.ts` — CREATE)

9. **`'returns true for mainnet (no sequencer feed)'`** — always up.
10. **`'returns true when sequencer is up'`** — mock answer=0, verify true.
11. **`'returns false when sequencer is down'`** — mock answer=1, verify false.
12. **`'returns false during grace period'`** — mock answer=0 but startedAt within grace period, verify false.

#### Chainlink multi-chain tests (in `src/lib/chainlink.test.ts` — ADD)

13. **`'getChainlinkFeed resolves Base feed address'`** — verify Base ETH/USD feed returned for chainId 8453.
14. **`'oracle read returns null when sequencer down'`** — mock sequencer down, verify price fetch returns null.

### Do NOT

- Do NOT test actual RPC calls — mock at the client level
- Do NOT add external dependencies

### Files affected

- `src/lib/chains/registry.test.ts` — **CREATE** (4 tests)
- `src/lib/chains/adapter-urls.test.ts` — **CREATE** (4 tests)
- `src/lib/chains/sequencer-check.test.ts` — **CREATE** (4 tests)
- `src/lib/chainlink.test.ts` — ADD (2 tests)

### Expected output

1 commit: `test: add multi-chain foundation tests [P220]`

### Quality criteria

- All 14 new tests pass
- All existing tests pass
- `npm run typecheck` passes
- Test count: 1219 + 14 = **~1233**

---

## Sprint Summary

| Prompt | Scope | Files | Deliverable |
|--------|-------|-------|-------------|
| P216 | ChainConfig type + registry | 4 files | Chain abstraction layer |
| P217 | Adapter URL parameterization | 12+ files | All adapters chain-aware |
| P218 | Chainlink multi-chain + sequencer | 5 files | Per-chain feeds + L2 safety |
| P219 | Wagmi + chain selector UI | 7 files | Frontend chain switching |
| P220 | Tests | 4 files | 14 new tests |

**Total estimated scope:** 5 commits, ~25 files, ~14 new tests.

**Test count target:** ~1233

**Risk assessment:** LOW-MEDIUM. This is purely additive infrastructure. No existing behavior changes. Base is configured but not activated (FeeCollector not deployed). The only risk is regression in existing mainnet paths from the refactoring.

**Dependency chain:** P216 first (types). P217 and P218 depend on P216 but are independent of each other. P219 depends on P216. P220 depends on all.

**Post-sprint state:** Codebase is multi-chain aware. Mainnet works exactly as before. Base is configured with "Coming Soon" state. Ready for Sprint 44 (Base FeeCollector deployment + testnet validation).

**TeraHash 4 rules compliance:**
1. ✅ Sandbox first — no deployment, no live changes
2. ✅ Zero user risk — purely additive, mainnet unchanged
3. ✅ Architect gate — Base-specific differences documented in ADR-009
4. ✅ No live without confirmation — Base shows "Coming Soon" until FeeCollector deployed

---

_Sprint 43 establishes the multi-chain foundation. After this sprint, adding a new chain is a config entry + contract deployment, not a codebase rewrite._
