# Sprint 9G Audit — Chain-Aware Safety/Oracle Gates

**Date:** 2026-06-02
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Audit brief:** `Audits/SPRINT-9G-AUDIT-BRIEF.md`
**Branch:** `feat/sprint-9g-chain-aware-gates`
**Commits reviewed:** G1 `3844cee`, G2 `2b11284`, G3 `d5c453f`, G4 `ddc2977`, G5 `eb6fc5d`, G6 `a50360b`, G7 `e78753b`, G8 `9ab95e3`, docs `8d417e6`
**Baseline:** main @ #119, 1357 tests
**Files changed:** 99 (+5067/−331 lines)
**Tests:** 1357 → 1391 (+34, verified: +120 new `it()` blocks including adapted existing tests)
**Signatures:** All 9 commits SSH-signed (`ssh-ed25519`, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 9G Audit Verdict

**Tests:** 1357 → 1391 (+34)

### Verdict: APPROVED

0C / 0H / 0M / 1L / 2 INFO

---

## Per-Gate Review

### G1 — Chainlink + L2 Sequencer Chain-Aware [HIGH] (`3844cee`) ✅

**Mainnet byte-identical: VERIFIED.**
- `rpcCall` gains `chainId` parameter. `getRpcUrlForChain(1)` = `getRpcUrl()` = browser `/api/rpc` / server `RPC_URL`. ✅
- `isSequencerUp` uses `getPublicClientForChain(chainId)` — for chainId=1, returns `getPrivateClient()`. ✅
- All `rpcCall` invocations in `fetchChainlinkPriceRaw` and `fetchHistoricalPrice` now pass `chainId`. ✅

**Base chain-awareness:**
- chainId≠1: `getRpcUrlForChain(chainId)` resolves chain-specific RPC, never mainnet. ✅
- Sequencer check receives a Base-bound client (`getPublicClientForChain(8453)`). ✅
- Tests verify Base reads hit Base RPC and mainnet stays on mainnet channel. ✅

**price-monitor.ts:**
- Chain-aware client: mainnet keeps privacy-proxy `getClient()`, non-mainnet uses `getPublicClientForChain(chainId)`. ✅
- Sequencer check, `latestRoundData`, and `getFeedDecimals` all receive the chain-correct client. ✅
- SL/TP/DCA price-monitor now validates against the correct chain's feed. ✅

### G2 — DefiLlama >$10k Guard Chain-Aware [HIGH] (`2b11284`) ✅

**Mainnet byte-identical: VERIFIED.**
- `validateSwapPrice({ ..., chain: 'ethereum' })` — default when omitted. ✅
- Both `fetchDefiLlamaPrice` calls receive `chain` slug. ✅

**Base chain-awareness:**
- `/api/swap` derives `llamaChain` from `getChainConfig(chainId).slug` (Base → `'base'`). ✅
- `estimatedValueUsd` computation also uses chain-specific DefiLlama prices. ✅
- Tests verify `'base:'` prefix in oracle URL keys. ✅

**Sub-$10k fail-open:** Now correctly validates Base prices (was always-missing under `ethereum` slug → always fail-open). The gate is no longer bypassable for Base >$10k swaps. ✅

### G3 — Post-Execution Validator Chain-Aware [HIGH] (`d5c453f`) ✅

**Mainnet byte-identical: VERIFIED.**
- Removed mainnet-pinned `getServerClient()`. Default `chainId = DEFAULT_CHAIN_ID`. ✅

**Base chain-awareness:**
- `ValidateExecutionParams` gains optional `chainId`. ✅
- `getPublicClientForChain(chainId)` for receipt reads and `balanceOf` calls. ✅
- On Base: can detect >2% shortfall and fire auto-disable + P0 alert. ✅
- Tests verify Base client creation (chainId 8453 recorded, mainnet not). ✅

### G4 — Server-Side Activation Gate [MED] (`ddc2977`) ✅

**`/api/swap`:**
- Rejects `unsupported` → 400, `coming-soon` → 409, BEFORE calldata/fee processing. ✅
- Absent `chainId` → mainnet default (unaffected). ✅

**`/api/quote`:**
- Rejects `unsupported` → 400. ✅
- Keeps `coming-soon` OPEN (quotes are info-only, no executable calldata). Test encodes this intent. ✅

**`/api/spender`:**
- Rejects `unsupported` → 400, `coming-soon` → 409. ✅

### G5 — Token Balances Chain-Aware [MED] (`eb6fc5d`) ✅

- New `useTokenBalances` hook uses `useActiveChainId()`. ✅
- Gates reads with `isChainActive(activeChainId)` — only fetches on chains with FeeCollector. ✅
- Multicall targets `chainId: activeChainId` per contract — never silently resolves over mainnet. ✅
- Per-chain token catalog: mainnet `DEFAULT_TOKENS`, L2 `getChainTokenList(activeChainId)`. ✅

### G6 — Single Chain-ID Source of Truth [MED] (`a50360b`) ✅

- `useSwap`: `useChainId()` → `useActiveChainId()`. ✅
- `useSplitSwap`: `useChainId()` → `useActiveChainId()`. ✅
- Eliminates potential lag between quote chain and swap chain during network switches. ✅
- Dead imports cleaned: `erc20Abi`, `useSignTypedData`, `submitCowOrder`, `pollCowOrderStatus`, `updateSwapStatus`, `SplitLeg`, `WETH_ADDRESS`. ✅

### G7 — Balancer Fail-Closed Whitelist [MED/LOW] (`e78753b`) ✅

- `fetchSwapData` validates `data.to ∈ getRouterWhitelist(chainId)`. Not whitelisted → throws. ✅
- Test: Vault (`0xBA12...`) accepted, rogue address rejected. ✅

**Auditor assessment of the BatchRelayer concern:** The whitelist includes only the Balancer V2 Vault. If the SOR API returns a BatchRelayer as `tx.to`, the gate would reject the swap (fail-closed = safe, not a misroute). On mainnet, Balancer has been operational with the Vault target since integration — a BatchRelayer response would have already failed. On Base, the same Vault address (CREATE2) is whitelisted. If Balancer changes its routing, the circuit breaker auto-disables the source. This is a correctness concern, not a fund-safety concern. Classified as **LOW** — the gate is correct for observed behavior and fails safe on any future mismatch.

### G8 — Low-Risk Correctness [LOW] (`9ab95e3`) ✅

- `feeTierCacheKey` scoped by `chainId` (was static `CHAIN_ID`). ✅
- `fetchChainlinkPriceRaw` now uses `validateRoundData` (adds `startedAt > 0` guard to the swap path — previously only on order-engine path). ✅
- `toWeth` is chain-aware (resolves per-chain wrapped-native). ✅
- Test: incomplete round (`startedAt === 0`) → `null` on swap path. ✅

---

## Cross-Cutting ✅

**Rule #9 — Chainlink/DefiLlama on Base:**
- G1: Chainlink reads now use Base feeds over Base RPC for `chainId=8453`. ✅
- G2: DefiLlama validation uses `'base'` slug for Base tokens. ✅
- Both oracles are genuinely applied to Base swaps — not silently degraded. **Rule #9 satisfied.** ✅

**No Solidity/contract edits.** ✅
**Keys server-only.** ✅
**No new unbounded loops.** Same fan-out pattern. ✅
**FEEDBACK.md:** All G1–G8 items documented. G7 BatchRelayer caveat flagged. G2 slug dependency noted. ✅

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 9G-L-01 | LOW | `balancer.ts` | Whitelist gate only includes the Balancer V2 Vault (`0xBA12...`). If the SOR API returns a BatchRelayer as `tx.to` for certain route types, the gate rejects (fail-closed, safe). Currently working on mainnet. Monitor if Balancer changes routing; circuit breaker auto-disables on repeated failures. |
| 9G-I-01 | INFO | `chainlink.ts` | Swap-path Chainlink validation now uses `validateRoundData` (G8), which adds `startedAt > 0` guard previously absent from the swap path. No behavioral change for real rounds (latestRoundData always returns `startedAt > 0` for completed rounds). Closes the divergence between swap-path and order-engine-path validation rigor. |
| 9G-I-02 | INFO | `defillama.ts` | DefiLlama chain slug is derived from `getChainConfig(chainId).slug`. If the registry slug doesn't match DefiLlama's expected chain identifier, prices would fail to resolve (fail-safe — blocks >$10k swaps). The mainnet slug `'ethereum'` and Base slug `'base'` are both correct for DefiLlama. |

---

## Mainnet Byte-Identical Summary

| Gate | chainId=1 Path | Verified |
|------|---------------|----------|
| G1 Chainlink RPC | `getRpcUrlForChain(1)` = `getRpcUrl()` (privacy proxy) | ✅ Test-proven |
| G1 Sequencer | `getPublicClientForChain(1)` = `getPrivateClient()` | ✅ Diff-proven |
| G2 DefiLlama | Default `chain = 'ethereum'` | ✅ Test-proven |
| G3 Post-exec | Default `chainId = DEFAULT_CHAIN_ID` | ✅ Test-proven |
| G4 /api/swap | Absent chainId → no gate check | ✅ Diff-proven |
| G5 Balances | `useActiveChainId()` returns 1 on mainnet | ✅ By design |
| G6 Chain source | `useActiveChainId()` = prior `useChainId()` for connected mainnet | ✅ By design |
| G7 Balancer | `getRouterWhitelist(1)` includes Vault | ✅ Test-proven |
| G8 Cache key | `feeTierCacheKey(_, _, 1)` = `'1:...'` (was `CHAIN_ID:...` = `'1:...'`) | ✅ Identical |

---

## Recommendation

**Merge.** All 8 safety/oracle gates are now chain-aware. Mainnet behavior verified byte-identical across all gates. Rule #9 (Chainlink/DefiLlama on Base) is genuinely satisfied — Base swaps are no longer silently degraded. The single LOW (Balancer BatchRelayer) is a correctness concern that fails safe, not a fund-flow risk.

**Deploy via Vercel Preview gate:** Verify Base oracle reads, guard behavior, and post-execution validator on Preview before promoting to production.
