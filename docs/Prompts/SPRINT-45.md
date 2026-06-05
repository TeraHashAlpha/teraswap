# Sprint 45 — Base Swap Activation Wiring

**Sprint goal:** Fix the 3 remaining mainnet-pinned items that prevent Base L2 swaps from functioning correctly. After this sprint, setting `contracts.feeCollector` in the Base ChainConfig enables real swaps on Base.  
**Branch:** `feat/sprint-45-base-activation` (from `main`)  
**Prerequisite:** Sprint 44 merged. FeeCollector deployed on Base Sepolia (testnet validation done by TeraHash).  
**Test count baseline:** 1244 (vitest count after Sprint 44)  
**Runbook:** See `docs/Runbooks/BASE-ACTIVATION.md` for the full activation sequence.

---

## Background

Sprints 43-44 made the codebase multi-chain aware, but three code paths still resolve to mainnet constants instead of the active chain's configuration:

1. **FeeCollector address in swap calldata** — `useSwap.ts`, `useSplitSwap.ts`, and `buildSimulationTx` use the `FEE_COLLECTOR_ADDRESS` constant (mainnet) when encoding FeeCollector calls. On Base, this would route swaps to the mainnet FeeCollector (unreachable from Base), causing reverts.

2. **`fetchApproveSpender` hardcoded** — `api.ts` returns mainnet spender addresses. On Base, users would approve the wrong contract.

3. **Simulation RPC client** — `simulateSwapTx` uses `getPrivateClient()` which always targets mainnet. Simulations on Base would run against mainnet state (wrong token balances, wrong contracts).

The `isChainActive` guard currently prevents these from being hit (Base is "Coming Soon"), but they MUST be fixed before the guard is lifted.

---

## P225 — FeeCollector address per-chain in swap calldata

### Context

`buildSimulationTx` in `swap-simulation.ts` and the FeeCollector calldata construction in `useSwap.ts`/`useSplitSwap.ts` use `FEE_COLLECTOR_ADDRESS` from `constants.ts`. This is the mainnet FeeCollector (`0x47f24068...`). On Base, a different FeeCollector will be deployed at a different address.

### Objective

Replace all uses of `FEE_COLLECTOR_ADDRESS` in the swap execution path with `getChainConfig(chainId).contracts.feeCollector`.

### Requirements

1. **`buildSimulationTx` in `swap-simulation.ts`:** The `SimulationParams` already has `chainId` (added in Sprint 44). Use it to resolve the FeeCollector address:

   ```typescript
   const feeCollectorAddress = getChainConfig(params.chainId ?? 1).contracts.feeCollector
   if (params.routeViaFeeCollector && !feeCollectorAddress) {
     throw new Error(`No FeeCollector deployed on chain ${params.chainId}`)
   }
   ```

   Use `feeCollectorAddress` instead of `FEE_COLLECTOR_ADDRESS` when encoding the `swap` function call and setting the `to` field.

2. **`useSwap.ts` — swap execution flow.** Wherever `FEE_COLLECTOR_ADDRESS` appears in the swap calldata construction (building the `to` address for the FeeCollector call), replace with chain-resolved address. The `chainId` is available via `useActiveChainId()`.

3. **`useSplitSwap.ts` — per-leg calldata.** Same change as useSwap: resolve FeeCollector address per-chain for each leg.

4. **`isValidRecipient` chain-awareness.** The recipient validator should include the chain-specific FeeCollector in the valid set (it may already be chain-aware from Sprint 44 — verify and fix if not).

5. **Guard against null.** If `contracts.feeCollector` is `null` (chain not activated), the swap should not reach this code (the activation guard prevents it). But add a defensive check anyway — throw a clear error rather than encoding a call to `0x0000...0000`.

### Do NOT

- Do NOT change the FeeCollector ABI or encoding logic — only the address resolution
- Do NOT change the mainnet FeeCollector address
- Do NOT remove the `FEE_COLLECTOR_ADDRESS` constant — keep for backward compat
- Do NOT change fee percentage or fee logic

### Files affected

- `src/lib/swap-simulation.ts` — resolve FeeCollector address per-chain
- `src/hooks/useSwap.ts` — resolve FeeCollector address per-chain
- `src/hooks/useSplitSwap.ts` — resolve FeeCollector address per-chain
- `src/lib/calldata-recipient.ts` — verify chain-aware recipient validation

### Expected output

1 commit: `feat(base): resolve FeeCollector address per-chain in swap calldata [P225]`

### Quality criteria

- `buildSimulationTx` with `chainId=1` uses mainnet FeeCollector (unchanged)
- `buildSimulationTx` with `chainId=8453` uses Base FeeCollector (from ChainConfig)
- `buildSimulationTx` with `chainId=8453` and `feeCollector=null` throws clear error
- FeeCollector ABI encoding is identical (only address changes)
- `npm run typecheck` passes
- All existing tests pass

---

## P226 — fetchApproveSpender + simulation client per-chain

### Context

Two more mainnet-pinned surfaces:

1. `fetchApproveSpender` in `api.ts` returns the spender address for a given source. These are hardcoded mainnet router addresses. On Base, users would approve the wrong contract (mainnet router unreachable from Base).

2. `simulateSwapTx` in `swap-simulation.ts` uses `getPrivateClient()` or equivalent to create a viem PublicClient for `eth_call`. This always targets the mainnet RPC. On Base, simulations would run against mainnet state.

### Objective

Make both chain-aware.

### Requirements

#### Part A — fetchApproveSpender per-chain

1. **Accept `chainId` parameter** in `fetchApproveSpender`:

   ```typescript
   export function fetchApproveSpender(source: string, chainId: number = 1): string
   ```

2. **Resolve from per-chain router whitelist:**

   ```typescript
   import { ROUTER_WHITELIST_BY_CHAIN } from '@/lib/chains/routers'
   
   const routers = ROUTER_WHITELIST_BY_CHAIN[chainId]
   if (!routers) throw new Error(`No routers for chain ${chainId}`)
   
   // Map source to its router address on this chain
   const spender = routers[sourceToRouterKey(source)]
   ```

3. **Source-to-router mapping.** Some sources have a specific spender that differs from the router (e.g., 0x uses AllowanceHolder, CoW uses VaultRelayer). Maintain this mapping per-chain. Where the spender IS the router, use the router address.

4. **Caller updates.** All callers of `fetchApproveSpender` must pass `chainId`. Check `SwapBox.tsx`, `useApproval.ts`, and any API routes.

#### Part B — Simulation client per-chain

5. **Create a per-chain public client factory** in `src/lib/chains/clients.ts`:

   ```typescript
   import { createPublicClient, http } from 'viem'
   import { mainnet, base } from 'viem/chains'
   
   const CHAIN_MAP = { 1: mainnet, 8453: base }
   
   export function getPublicClientForChain(chainId: number): PublicClient {
     const chain = CHAIN_MAP[chainId]
     const config = getChainConfig(chainId)
     return createPublicClient({
       chain,
       transport: http(config.rpc.primary || undefined), // undefined = default public RPC
     })
   }
   ```

6. **Update `simulateSwapTx`** to use `getPublicClientForChain(chainId)` instead of the mainnet-only client.

7. **Cache clients.** Don't create a new client per simulation — cache per chainId (simple Map or module-level variable).

### Do NOT

- Do NOT change the spender logic for mainnet — only add chain resolution
- Do NOT change the simulation logic (eth_call parameters) — only the target client
- Do NOT add new RPC dependencies — use existing env vars
- Do NOT remove `getPrivateClient` — keep for mainnet backward compat

### Files affected

- `src/lib/api.ts` — make `fetchApproveSpender` chain-aware
- `src/lib/swap-simulation.ts` — use per-chain simulation client
- `src/lib/chains/clients.ts` — **CREATE** (per-chain client factory)
- `src/components/SwapBox.tsx` — pass chainId to fetchApproveSpender
- `src/hooks/useApproval.ts` — pass chainId to spender resolution

### Expected output

1 commit: `feat(base): per-chain spender resolution + simulation client [P226]`

### Quality criteria

- `fetchApproveSpender('1inch', 1)` returns mainnet 1inch router (unchanged)
- `fetchApproveSpender('1inch', 8453)` returns Base 1inch router
- `simulateSwapTx` with `chainId=1` targets mainnet RPC (unchanged)
- `simulateSwapTx` with `chainId=8453` targets Base RPC
- Clients are cached (same object returned for same chainId)
- `npm run typecheck` passes
- All existing tests pass

---

## P227 — Tests

### Context

P225-P226 completed the Base activation wiring. This prompt adds test coverage to verify per-chain resolution is correct and mainnet is unchanged.

### Requirements

#### FeeCollector address tests (in `src/lib/swap-simulation.test.ts` — ADD or CREATE)

1. **`'buildSimulationTx uses mainnet FeeCollector for chainId=1'`** — verify the `to` field in the simulation tx matches the mainnet FeeCollector address.
2. **`'buildSimulationTx uses Base FeeCollector for chainId=8453'`** — mock Base config with a FeeCollector address, verify it's used.
3. **`'buildSimulationTx throws when FeeCollector is null'`** — mock chain with feeCollector=null + routeViaFeeCollector=true, verify error.

#### Spender resolution tests (in `src/lib/api.test.ts` — ADD)

4. **`'fetchApproveSpender returns mainnet address for chainId=1'`** — verify unchanged.
5. **`'fetchApproveSpender returns Base address for chainId=8453'`** — verify Base router returned.

#### Simulation client tests (in `src/lib/chains/clients.test.ts` — CREATE)

6. **`'getPublicClientForChain returns mainnet client for chainId=1'`** — verify chain property.
7. **`'getPublicClientForChain returns Base client for chainId=8453'`** — verify chain property.
8. **`'clients are cached'`** — call twice, verify same object.

### Do NOT

- Do NOT test actual RPC calls — mock at client level
- Do NOT add external dependencies

### Files affected

- `src/lib/swap-simulation.test.ts` — ADD or CREATE (3 tests)
- `src/lib/api.test.ts` — ADD (2 tests)
- `src/lib/chains/clients.test.ts` — **CREATE** (3 tests)

### Expected output

1 commit: `test: add Base activation wiring tests [P227]`

### Quality criteria

- All 8 new tests pass
- All existing tests pass
- `npm run typecheck` passes
- Test count: 1244 + 8 = **~1252**

---

## Sprint Summary

| Prompt | Scope | Files | Deliverable |
|--------|-------|-------|-------------|
| P225 | FeeCollector per-chain in calldata | 4 files | Swap calldata uses correct chain address |
| P226 | Spender + simulation client per-chain | 5 files | Approvals + simulation target correct chain |
| P227 | Tests | 3 files | 8 new tests |

**Total estimated scope:** 3 commits, ~10 files, ~8 new tests.

**Test count target:** ~1252

**Risk assessment:** MEDIUM. P225 touches the swap calldata construction (fund-critical path). P226 changes spender resolution (approval-critical). Both must produce byte-identical results for chainId=1.

**Dependency chain:** P225 and P226 are independent (different surfaces). P227 depends on both.

**Post-sprint state:** ALL per-chain wiring complete. Setting `contracts.feeCollector` in the Base ChainConfig enables real Base swaps. Ready for Phase C (Base mainnet deployment) per `docs/Runbooks/BASE-ACTIVATION.md`.

---

_Sprint 45 is the final code sprint before Base goes live. After merge, TeraHash deploys FeeCollector on Base mainnet, updates the config, and Base swaps are active._
