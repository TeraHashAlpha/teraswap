# Sprint 45 Audit — Base Swap Activation Wiring

**Date:** 2026-05-31
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Branch:** `feat/sprint-45-base-activation`
**Base:** Sprint 44 HEAD (`f6bf68e`)
**Commits reviewed:** `cc4032e` (P225), `7763a06` (P226), `f5af513` (P227), `b15edae` (P227 review)
**Files changed:** 27 (+1026/−67 lines)
**Tests:** +8 (3 swap-simulation, 2 api-spender, 3 clients)
**Signatures:** All 4 commits SSH-signed (`ssh-ed25519`, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 45 Audit Verdict

**Branch:** feat/sprint-45-base-activation
**Commits reviewed:** cc4032e, 7763a06, f5af513, b15edae
**Tests:** 1244 → 1252 (+8)

### Verdict: APPROVED

0C / 0H / 0M / 0L / 1 INFO

---

### Mainnet Byte-Identical Verification

| Check | Result |
|-------|--------|
| FeeCollector address (calldata) | **PASS** — `getChainConfig(1).contracts.feeCollector === FEE_COLLECTOR_ADDRESS` (registry references constants.ts). All calldata encoding produces identical bytes. |
| Recipient validation | **PASS** — `chainId === DEFAULT_CHAIN_ID` branch uses exact `FEE_COLLECTOR_ADDRESS` + `FEE_COLLECTOR_V1_ADDRESS`. |
| fetchApproveSpender | **PASS** — `chainId === DEFAULT_CHAIN_ID` branch hits existing per-source switch. `usesFeeCollector(source, 1)` → `FEE_COLLECTOR_ADDRESS`. |
| Simulation client | **PASS** — `getPublicClientForChain(1)` returns `getPrivateClient()` (existing privacy-preserving client). Not cached (per-call, matching prior behavior). |
| /api/spender request | **PASS** — SwapBox appends `&chainId=` ONLY for non-mainnet. Mainnet request URL unchanged. |
| Default chainId=1 | **PASS** — All functions default `chainId: number = DEFAULT_CHAIN_ID`. |
| No remaining mainnet-pinned surfaces | **PASS** — All 3 Sprint 44 carry-overs resolved. |

---

## Detailed Review

### 1. P225 — FeeCollector Per-Chain in Swap Calldata (`cc4032e`) ✅

**`buildSimulationTx` (`swap-simulation.ts`):**
- Resolves `feeCollectorAddress` via `getChainConfig(chainId ?? DEFAULT_CHAIN_ID).contracts.feeCollector`. ✅
- Null guard: `if (routeViaFeeCollector && !feeCollectorAddress) throw` with clear error message. ✅
- Uses `feeCollectorAddress!` for `to` field (non-null guaranteed by guard). ✅
- Removed `FEE_COLLECTOR_ADDRESS` import. Kept `FEE_COLLECTOR_ABI`. ✅

**`useSwap.ts`:**
- Resolves `feeCollectorAddress` via `getChainConfig(chainId).contracts.feeCollector`. ✅
- Null guard before any FeeCollector operation. ✅
- `pendingTxTo = feeCollectorAddress!` for both native ETH and ERC-20 FeeCollector paths. ✅
- Allowance check: `args: [address, feeCollectorAddress!]` — correct. ✅
- `buildFeeCollectorSwapArgs(routeViaFeeCollector, address, feeCollectorAddress ?? FEE_COLLECTOR_ADDRESS)` — fallback is a type-safety artifact, never hit (null guard throws first when `routeViaFeeCollector === true`; when `false`, the third arg is unused). ✅

**`useSplitSwap.ts`:**
- Per-leg: `const feeCollectorAddress = getChainConfig(chainId).contracts.feeCollector`. ✅
- Null guard: `if (!feeCollectorAddress) throw`. ✅
- `sendTransactionAsync({ to: feeCollectorAddress, ... })` for both native and token paths. ✅
- `FEE_COLLECTOR_ADDRESS` import removed. ✅

**`calldata-recipient.ts`:**
- `validateCallDataRecipient`, `validateCallDataRecipientInner`, `decodeMulticallRecipient`, `isValidRecipient` — all accept `chainId = DEFAULT_CHAIN_ID`. ✅
- Mainnet branch: exact `FEE_COLLECTOR_ADDRESS` + `FEE_COLLECTOR_V1_ADDRESS` in valid set. ✅
- Non-mainnet: resolves from `getChainConfig(chainId)`. ✅
- Callers (`useSwap`, `useSplitSwap`, `/api/swap`) pass chainId. ✅

### 2. P226 — fetchApproveSpender + Simulation Client (`7763a06`) ✅

**`fetchApproveSpender(source, chainId)` (`api.ts`):**
- chainId 1: `usesFeeCollector(source, 1)` → returns `getChainConfig(1).contracts.feeCollector` (=== `FEE_COLLECTOR_ADDRESS`). Non-fee sources: existing per-source switch (Permit2, 1inch, 0x, etc.). Byte-identical. ✅
- Non-mainnet: `ROUTER_WHITELIST_BY_CHAIN[chainId][source]`. Throws if not configured. ✅
- FeeCollector fallthrough: if `usesFeeCollector` is true but `feeCollector` is null (e.g., Base before deployment), falls through to per-chain router whitelist. ✅

**`/api/spender/route.ts`:**
- Reads `chainId` from query param, passes to `fetchApproveSpender`. Default absent → mainnet. ✅

**`SwapBox.tsx`:**
- `fetch(\`/api/spender?source=${source}${activeChainId !== 1 ? \`&chainId=${activeChainId}\` : ''}\`)` — mainnet URL unchanged. ✅

**`getPublicClientForChain(chainId)` (`chains/clients.ts`):**
- chainId 1: returns `getPrivateClient()` (privacy-preserving, per-call). ✅
- Non-mainnet: `createPublicClient({ chain, transport: http(rpc) })`, cached per chainId. ✅
- `_clearClientCache()` for tests. ✅
- `VIEM_CHAINS` map: `{ 1: mainnet, 8453: base }`. ✅

**`simulateSwapTx` (`swap-simulation.ts`):**
- Uses `getPublicClientForChain(params.chainId ?? DEFAULT_CHAIN_ID)`. ✅

### 3. P227 — Tests (`f5af513`) ✅

**swap-simulation.test.ts (3 tests):**
1. Mainnet FeeCollector: `buildSimulationTx({ chainId: 1 }).to === FEE_COLLECTOR_ADDRESS`. ✅
2. Base FeeCollector: mocked config → correct address used. ✅
3. Null throws: mocked null FeeCollector + routeViaFeeCollector → throws `/FeeCollector/i`. ✅

**api.test.ts (2 tests):**
1. Mainnet: `fetchApproveSpender('0x', 1)` = Permit2, `fetchApproveSpender('1inch', 1)` = FeeCollector. ✅
2. Base: `fetchApproveSpender('1inch', 8453)` = 1inch router, `fetchApproveSpender('0x', 8453)` = AllowanceHolder. ✅

**clients.test.ts (3 tests):**
1. `getPublicClientForChain(1).chain?.id === 1`. ✅
2. `getPublicClientForChain(8453).chain?.id === 8453`. ✅
3. Caching: `getPublicClientForChain(8453) === getPublicClientForChain(8453)` (same object). ✅

### 4. P227 Review — useSwap chainId Threading Fix (`b15edae`) ✅

- **Gap:** `useSwap`'s `buildSimulationTx` call didn't pass `chainId`. NOT a mainnet regression (defaults to 1), but on Base the simulation would target the wrong FeeCollector + RPC. ✅
- **Fix:** `chainId` now passed in the `buildSimulationTx` params (line 418). Single-line fix. ✅
- **End-to-end verified:** Both `useSwap` and `useSplitSwap` now thread `chainId` to `buildSimulationTx` and `simulateSwapTx`. ✅

### 5. FEEDBACK.md ✅

- Branch stacking acknowledged (Sprint 44 HEAD). ✅
- P225 test fix: Sprint 44's [P221] chainId test adapted for FeeCollector null guard. ✅
- P226 spender resolution: mainnet switch preserved, non-mainnet from router whitelist. ✅
- P227 review: 6 duplicate findings → single useSwap chainId fix. All other surfaces correct. ✅

### 6. Sprint 44 Carry-Over Resolution ✅

| # | Item | Status |
|---|------|--------|
| 1 | FeeCollector address in swap calldata | **RESOLVED** — `getChainConfig(chainId).contracts.feeCollector` in useSwap, useSplitSwap, buildSimulationTx, calldata-recipient. |
| 2 | fetchApproveSpender per-source | **RESOLVED** — `ROUTER_WHITELIST_BY_CHAIN[chainId]` for non-mainnet, existing switch for mainnet. |
| 3 | Simulation RPC client | **RESOLVED** — `getPublicClientForChain(chainId)` returns per-chain client (mainnet = getPrivateClient). |

**No remaining mainnet-pinned surfaces in the swap/approval/simulation path.**

### 7. General ✅

- **No scope creep:** 27 files — swap hooks, simulation, api, calldata-recipient, chains module, tests, FEEDBACK.md. All activation wiring. ✅
- **No new dependencies.** ✅
- **All 4 commits SSH-signed.** ✅
- **+8 tests confirmed.** ✅
- **TeraHash 4 rules:** Sandbox first (Base still "Coming Soon" until FeeCollector deployed), zero user risk (activation guard intact), architect gate (ADR-009), no live without confirmation. ✅

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 45-I-01 | INFO | Sprint summary | All 3 Sprint 44 mainnet-pinned carry-overs are fully resolved. The codebase is ready for Base FeeCollector deployment. Setting `contracts.feeCollector` in the Base ChainConfig enables real Base swaps with correct per-chain calldata, spender resolution, and simulation targeting. |

---

## Recommendation

**Merge.** This is the final code sprint before Base activation. All fund-critical paths (swap calldata, approval spender, simulation client) now correctly resolve per-chain while producing byte-identical results for mainnet. The adversarial review caught and fixed the useSwap simulation chainId gap before this audit. No remaining mainnet-pinned surfaces.

Post-merge: TeraHash deploys FeeCollector on Base mainnet, updates the ChainConfig, and Base swaps are live per `docs/Runbooks/BASE-ACTIVATION.md`.
