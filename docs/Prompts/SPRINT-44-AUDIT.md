# Sprint 44 Audit — Base Swap Preparation

**Role:** You are a Senior Security Auditor reviewing Sprint 44 of the TeraSwap DEX aggregator. Your job is to verify the Base swap preparation code — chainId threading, token catalog, router whitelist, and activation guard — ensuring mainnet is unchanged and Base security controls are correctly configured.

**Branch:** `feat/sprint-44-base-swap-prep`  
**Base:** `main` (with Sprints 40-43 merged)  
**Commits:** 5 (P221 `b2298c2`, P222 `c36f7e8`, P223 `0b1254b`, P224 `2d32fc3`, P224 review `f6bf68e`)  
**Files changed:** hooks, chains/ module, components, deploy docs, test files  
**Test count:** 1233 → 1244 (+11)

**Risk level:** MEDIUM — Router whitelist is security-critical (wrong addresses = funds routed through untrusted contracts). Activation guard must be airtight (Base must NOT allow swaps while FeeCollector is null). Mainnet must be byte-identical.

---

## Context

Sprint 44 completes all code preparation for Base L2 swap activation. It fixes the Sprint 43 carry-over (useSplitSwap chainId), adds a per-chain token catalog, researches and configures Base router addresses, and builds the activation guard. The Code Agent's adversarial review found and fixed two issues: `usesFeeCollector`/`isFeeCollectorActive` were mainnet-pinned, and a SwapBox `blockReason` mismatch.

| Prompt | Deliverable |
|--------|-------------|
| P221 | Split-swap chainId threading (43-I-01) + Base token catalog |
| P222 | Per-chain router whitelist (11 Basescan-verified routers) |
| P223 | Activation guard + DEPLOY.md Base section |
| P224 | 11 tests + review fix |

---

## Audit Checklist

### 1. CRITICAL: Mainnet Byte-Identical

- [ ] **Router whitelist mainnet unchanged:** `getRouterWhitelist(1)` returns exactly the same addresses as the existing `ROUTER_WHITELIST` in `constants.ts`.
- [ ] **Trusted spenders mainnet unchanged:** `isTrustedSpender(addr, 1)` matches pre-sprint behavior.
- [ ] **Validation functions default to chainId=1:** All validation functions (`validateRouterAddress`, `isTrustedSpender`, `isValidRecipient`) default to mainnet when chainId not provided.
- [ ] **No new mainnet RPC calls.**
- [ ] **Swap flow unchanged for chainId=1:** Quote fetch, simulation, wallet prompt, broadcast — all identical.

### 2. P221 — Split-Swap ChainId + Token Catalog (`b2298c2`)

#### useSplitSwap chainId

- [ ] **chainId passed to fetchSwapData:** Each split leg's adapter call receives the active chainId.
- [ ] **chainId passed to buildSimulationTx:** Simulation targets correct chain's RPC.
- [ ] **chainId passed to simulateSwapTx:** Simulation uses correct chain's public client.
- [ ] **chainId passed to validation functions:** Router, recipient, fee integrity validations are chain-aware.
- [ ] **43-I-01 resolved:** No remaining hardcoded chainId=1 in useSplitSwap.

#### Token catalog

- [ ] **Per-chain structure:** `CHAIN_TOKENS` has entries for both chain 1 and 8453.
- [ ] **Base tokens correct:** ETH, WETH (`0x4200...0006`), USDC (`0x8335...2913`), DAI, and others present with correct addresses and decimals.
- [ ] **Mainnet tokens unchanged:** Existing popular tokens list preserved.
- [ ] **TokenSelector chain-aware:** Shows Base tokens when on Base, mainnet tokens when on mainnet.
- [ ] **Logo URLs resolve:** Token logos use working CDN URLs.

### 3. P222 — Router Whitelist (`c36f7e8`)

**This is the most security-critical section of the audit.**

- [ ] **All Base router addresses Basescan-verified:** Each address in the Base whitelist MUST be a verified contract on Basescan. Check at least 5 addresses manually.
- [ ] **Router addresses match official deployments:** Verify against each protocol's deployment documentation:
  - [ ] 1inch AggregationRouterV6 on Base
  - [ ] 0x AllowanceHolder/ExchangeProxy on Base
  - [ ] ParaSwap Augustus on Base
  - [ ] Odos V2 Router on Base
  - [ ] KyberSwap MetaAggregationRouter on Base
  - [ ] Uniswap SwapRouter02 on Base
  - [ ] SushiSwap RouteProcessor on Base
  - [ ] OpenOcean ExchangeProxy on Base
  - [ ] Balancer Vault on Base
  - [ ] Curve RouterNG on Base
  - [ ] CoW Settlement on Base
- [ ] **No cross-chain leakage:** A mainnet router address is NOT in the Base whitelist (and vice versa), unless the same contract is deployed at the same address on both chains (e.g., CREATE2 deployments).
- [ ] **`isWhitelistedRouter` chain-aware:** Validates against the correct chain's whitelist.
- [ ] **`isTrustedSpender` chain-aware:** Includes chain-specific routers + FeeCollector + Permit2.
- [ ] **Source documented:** Each router address has a comment indicating where it was verified (Basescan URL, protocol docs, API response).

### 4. P223 — Activation Guard (`0b1254b`)

- [ ] **`isChainActive(1)` returns true** (mainnet FeeCollector exists).
- [ ] **`isChainActive(8453)` returns false** (Base FeeCollector is null).
- [ ] **SwapBox disabled on Base:** When Base selected, swap button is disabled with "Coming Soon" message.
- [ ] **Quote fetching skipped on Base:** `useQuote` does NOT make API calls when chain is inactive.
- [ ] **No bypass:** Verify there is NO code path where a swap can execute on an inactive chain. Check both useSwap and useSplitSwap.
- [ ] **Fee-incompatible sources per chain:** `getFeeIncompatibleSources` returns chain-specific lists.
- [ ] **DEPLOY.md updated:** Base deployment section is complete with step-by-step instructions, router list, and post-deployment verification checklist.
- [ ] **`.env.example` updated:** Base RPC and FeeCollector env vars documented.

### 5. P224 Review Fix (`f6bf68e`)

- [ ] **`usesFeeCollector` chain-aware:** No longer returns mainnet-pinned result. Uses `getFeeIncompatibleSources(chainId)`.
- [ ] **`isFeeCollectorActive` chain-aware:** Checks `getChainConfig(chainId).contracts.feeCollector`.
- [ ] **SwapBox blockReason corrected:** `priceBlocked` reverted to `anyBlocked` (or equivalent correct logic).
- [ ] **Mainnet behavior preserved:** The chain-aware wiring produces identical results for chainId=1.

### 6. Remaining Mainnet-Pinned Items (FEEDBACK)

The Code Agent documented 3 items that are still mainnet-pinned and must be fixed BEFORE `feeCollector` is set for Base:
- [ ] **Acknowledged:** FeeCollector address in swap calldata construction
- [ ] **Acknowledged:** `fetchApproveSpender` per-source addresses
- [ ] **Acknowledged:** Simulation RPC client
- [ ] **Safe:** Verify that `isChainActive` guard prevents any of these from being hit while Base is inactive.

### 7. General

- [ ] **No scope creep.**
- [ ] **No new dependencies.**
- [ ] **TypeScript:** `npm run typecheck` must pass.
- [ ] **Lint:** `npm run lint` must pass.
- [ ] **All tests:** `npm run test` must pass with 0 failures. Report actual test count.
- [ ] **Commits signed.**
- [ ] **TeraHash 4 rules compliance.**

---

## Expected Output

```markdown
## Sprint 44 Audit Verdict

**Branch:** feat/sprint-44-base-swap-prep
**Commits reviewed:** b2298c2, c36f7e8, 0b1254b, 2d32fc3, f6bf68e
**Tests:** 1233 → {actual count}

### Verdict: {APPROVED | APPROVED WITH WARNINGS | REJECTED}

{0C / 0H / 0M / 0L / NI INFO}

### Router Whitelist Verification (Base)

| Router | Address | Basescan Verified | Protocol Docs Match |
|--------|---------|-------------------|-------------------|
| 1inch | 0x... | {yes/no} | {yes/no} |
| ... | ... | ... | ... |

### Activation Guard Verification

| Check | Result |
|-------|--------|
| isChainActive(1) = true | {PASS/FAIL} |
| isChainActive(8453) = false | {PASS/FAIL} |
| SwapBox disabled on Base | {PASS/FAIL} |
| Quote skip on inactive | {PASS/FAIL} |
| No swap bypass on inactive | {PASS/FAIL} |

### FEEDBACK Carry-Overs

| # | Item | Safe While Base Inactive? |
|---|------|--------------------------|
| 1 | FeeCollector in swap calldata | {yes/no} |
| 2 | fetchApproveSpender per-source | {yes/no} |
| 3 | Simulation RPC client | {yes/no} |

### Recommendation

{Merge / Fix required / ...}
```

Run `npm run typecheck`, `npm run lint`, and `npm run test` before delivering the verdict. Report the actual test count.
