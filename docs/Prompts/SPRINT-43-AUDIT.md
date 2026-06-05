# Sprint 43 Audit — Multi-Chain Foundation (Phase 2 Kickoff)

**Role:** You are a Senior Security Auditor reviewing Sprint 43 of the TeraSwap DEX aggregator. Your job is to verify the correctness of the multi-chain abstraction layer, ensuring mainnet behavior is IDENTICAL and the Base foundation is correctly configured.

**Branch:** `feat/sprint-43-multi-chain-foundation`  
**Base:** `main` (with Sprints 40-42 merged)  
**Commits:** 6 (P216 `eb03580`, P217 `5a909b4`, P218 `90bcf79`, P219 `cbbc819`, P220 `ece9944`, P219 review `6a3dd16`)  
**Files changed:** chains/ module (new), adapters, chainlink, wagmi config, UI components, test files  
**Test count:** 1219 → 1233 (+14)

**Risk level:** MEDIUM — large scope (~25 files touched) but purely additive. The critical audit question is: **does mainnet still work EXACTLY as before?** No new chain goes live — Base is "Coming Soon" only.

---

## Context

Sprint 43 builds the multi-chain abstraction layer per ADR-009. It makes the codebase chain-aware without activating Base swaps. All 11 DEX adapters now accept `chainId`. Chainlink feeds are per-chain with a mandatory L2 sequencer uptime check. Wagmi supports Mainnet + Base with a chain selector UI.

The Code Agent's adversarial review (13 agents, 5 dimensions) found and fixed one CRITICAL: `useSwap` was not passing `chainId` through the swap and quote API paths. Fixed in the review commit.

| Prompt | Deliverable |
|--------|-------------|
| P216 | ChainConfig type system + registry (chains/ module) |
| P217 | Adapter URL parameterization (9 adapters + 2 on-chain noted) |
| P218 | Per-chain Chainlink feeds + L2 sequencer uptime check |
| P219 | Wagmi Base config + ChainSelector UI + chain reset |
| P220 | 14 tests |
| P219 review | chainId threading through swap + quote API paths |

---

## Audit Checklist

### 1. CRITICAL: Mainnet Byte-Identical Verification

This is the most important check in this audit. The sprint is purely additive — mainnet behavior must be IDENTICAL to pre-sprint.

- [ ] **Constants backward compat:** `CHAIN_ID`, `FEE_COLLECTOR_ADDRESS`, `PERMIT2_ADDRESS`, and all existing constants in `constants.ts` still export the same values. Verify they re-export from the registry.
- [ ] **Adapter URLs for chainId=1:** Every adapter's URL for mainnet must be character-for-character identical to pre-sprint. Verify at least 5 adapters by comparing old hardcoded URL vs `getAdapterApiUrl(source, 1)`.
- [ ] **Chainlink feeds for chainId=1:** `getChainlinkFeed(tokenAddress, 1)` returns the same feed address as the old `CHAINLINK_FEEDS[tokenAddress]`.
- [ ] **Sequencer check for mainnet:** `isSequencerUp(1, client)` always returns `true` (no sequencer feed on mainnet).
- [ ] **Default chainId:** When no chainId is provided, all functions default to `1` (mainnet).
- [ ] **No new network requests on mainnet:** Mainnet path must NOT make any additional RPC calls (e.g., no sequencer check for chain 1).
- [ ] **Existing tests unchanged:** All 1219 pre-sprint tests pass without modification. No test was changed to accommodate multi-chain.

### 2. P216 — ChainConfig Registry (`eb03580`)

- [ ] **ChainConfig interface complete:** Has chainId, name, slug, nativeCurrency, contracts, rpc, blockExplorer, gasModel, sequencerUptimeFeed, tokens.
- [ ] **Mainnet config populated:** All existing addresses migrated from constants.ts. No values changed.
- [ ] **Base config:** chainId=8453, slug='base', gasModel='op-stack', feeCollector=null, permit2 correct (CREATE2 address), sequencerUptimeFeed populated.
- [ ] **`getChainConfig(chainId)` throws on unsupported chain.**
- [ ] **`getSupportedChainIds()` returns [1, 8453].**
- [ ] **No circular imports:** chains/ module does NOT import from files that import from it.

### 3. P217 — Adapter URLs (`5a909b4`)

- [ ] **`getAdapterApiUrl` exists and covers all adapters.**
- [ ] **Path-segment adapters (5):** 1inch uses `/v6.0/{chainId}`, KyberSwap uses `/{slug}`, CoW uses `/{slug}/api/v1`, OpenOcean uses `/v4/{chainId}`, SushiSwap uses `/swap/v7/{chainId}`.
- [ ] **Param adapters (4):** 0x passes `chainId` as query param, Velora passes `network`, Odos passes `chainId` in body, Balancer passes `chainId`.
- [ ] **On-chain adapters (2):** Uniswap V3 and Curve noted for future per-chain contracts.
- [ ] **getCowApiBase(8453)** returns `https://api.cow.fi/base/api/v1`.
- [ ] **All adapters accept chainId parameter** in their `fetchQuote`/`fetchSwapData` functions.
- [ ] **Fallback to chainId=1** when not provided.

### 4. P218 — Chainlink Multi-Chain + Sequencer (`90bcf79`)

- [ ] **Per-chain feed registry:** `CHAINLINK_FEEDS_BY_CHAIN` has entries for both chain 1 and 8453.
- [ ] **Base ETH/USD feed:** Correct address (`0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` or verified equivalent).
- [ ] **`getChainlinkFeed` accepts chainId:** Optional parameter, defaults to 1.
- [ ] **Sequencer uptime check:**
  - [ ] `isSequencerUp(1, client)` → `true` (no check needed)
  - [ ] Reads sequencer feed when `chainId !== 1` and config has `sequencerUptimeFeed`
  - [ ] `answer === 0` → UP, `answer === 1` → DOWN
  - [ ] Grace period: recently recovered sequencer (< 3600s) treated as down
  - [ ] Result cached (30s or similar) to avoid spam
- [ ] **Integrated into oracle reads:** All Chainlink price fetches check sequencer before reading feed.
- [ ] **Mainnet oracle reads unchanged:** No additional RPC call for sequencer on chain 1.

### 5. P219 — Wagmi + Chain Selector (`cbbc819` + `6a3dd16`)

- [ ] **Wagmi config:** `chains` array includes `[mainnet, base]`. Both have transports configured.
- [ ] **ChainSelector component:** Renders in UI. Shows current chain. Allows switching between Mainnet and Base.
- [ ] **`useActiveChainId` hook:** Returns current chain's ID. Defaults to 1.
- [ ] **Chain switch resets state:** Quote clears, tokens reset to chain defaults, pending swap cleared, error messages cleared.
- [ ] **Base "Coming Soon":** When Base is selected and `feeCollector === null`, swaps are disabled with appropriate messaging.
- [ ] **Review fix (`6a3dd16`):** chainId now threaded through useSwap → swap API and quote API. Verify the fix is complete — no remaining path where chainId=1 is hardcoded in the swap/quote flow.

### 6. P220 — Tests (`ece9944`)

- [ ] **Registry tests (4):** Mainnet config, Base config, unsupported throws, supported IDs.
- [ ] **Adapter URL tests (4):** 1inch path, KyberSwap slug, CoW base, default fallback.
- [ ] **Sequencer tests (4):** Mainnet always up, sequencer up, sequencer down, grace period.
- [ ] **Chainlink multi-chain tests (2):** Base feed resolved, oracle null when sequencer down.
- [ ] **Tests are meaningful:** Not trivially passing. Actually exercise the logic.

### 7. FEEDBACK.md

- [ ] **Per-chain token catalog noted:** FEEDBACK mentions Base needs its token list (addresses/logos/categories) before swaps can work. This is expected — Sprint 44 scope.
- [ ] **Any other feedback items triaged.**

### 8. General

- [ ] **No scope creep:** No features beyond multi-chain foundation.
- [ ] **No new dependencies:** No npm packages added (wagmi/viem already support Base natively).
- [ ] **ADR-009 referenced:** Architecture follows the documented decision.
- [ ] **TypeScript:** `npm run typecheck` must pass.
- [ ] **Lint:** `npm run lint` must pass.
- [ ] **All tests:** `npm run test` must pass with 0 failures. Report actual test count.
- [ ] **Commits signed:** All 6 commits SSH/GPG signed.
- [ ] **TeraHash 4 rules:** Sandbox first ✓, zero user risk ✓, architect gate ✓, no live without confirmation ✓.

---

## Expected Output

```markdown
## Sprint 43 Audit Verdict

**Branch:** feat/sprint-43-multi-chain-foundation
**Commits reviewed:** eb03580, 5a909b4, 90bcf79, cbbc819, ece9944, 6a3dd16
**Tests:** 1219 → {actual count}

### Verdict: {APPROVED | APPROVED WITH WARNINGS | REJECTED}

{0C / 0H / 0M / 0L / NI INFO}

### Mainnet Byte-Identical Verification

| Check | Result |
|-------|--------|
| Constants backward compat | {PASS/FAIL} |
| Adapter URLs for chainId=1 | {PASS/FAIL} |
| Chainlink feeds for chainId=1 | {PASS/FAIL} |
| Sequencer skipped for mainnet | {PASS/FAIL} |
| Default chainId=1 | {PASS/FAIL} |
| No new mainnet RPC calls | {PASS/FAIL} |
| Existing tests unmodified | {PASS/FAIL} |

### Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 43-{severity}-{NN} | {C/H/M/L/INFO} | {file} | {description} |

### FEEDBACK Deviations

| # | Item | Auditor Assessment |
|---|------|-------------------|
| 1 | Per-chain token catalog needed | {Accept / Flag / Fix required} |
| {N} | {any other items} | {Accept / Flag / Fix required} |

### Recommendation

{Merge / Fix required / ...}
```

Run `npm run typecheck`, `npm run lint`, and `npm run test` before delivering the verdict. Report the actual test count.
