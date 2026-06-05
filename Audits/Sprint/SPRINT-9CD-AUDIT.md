# Sprint 9C/9D Joint Audit — On-Chain Chain-Aware + Bebop 12th Source

**Date:** 2026-05-31
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Audit brief:** `Audits/SPRINT-9CD-AUDIT-BRIEF.md`
**Commits reviewed:** `c8ca8b1` (9C on-chain fix), `3d938d4` (P228 Bebop)
**Baseline:** `98e9df0` (debug=sources diagnostic, 1283 tests)
**Files changed:** 28 (+1674/−35 lines)
**Tests:** 1283 → 1307 (+24: 4 shared/RPC, 5 uniswapv3, 4 curve, 11 bebop)
**Signatures:** Both commits SSH-signed (`ssh-ed25519`, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 9C/9D Audit Verdict

**Commits reviewed:** c8ca8b1, 3d938d4
**Tests:** 1283 → 1307 (+24)

### Verdict: APPROVED

0C / 0H / 0M / 0L / 2 INFO

---

## Area A — On-Chain Adapters Chain-Aware (Sprint 9C, `c8ca8b1`)

### A1. Mainnet byte-identical ✅

- **`getRpcUrlForChain(1)` = `getRpcUrl()`:** Test pins exact equality. Server: `process.env.RPC_URL || NEXT_PUBLIC_RPC_URL || llamarpc`. Browser: `/api/rpc` (privacy proxy). No change for mainnet. ✅
- **Uniswap V3 mainnet:** `getUniswapV3Contracts(1)` returns `{ quoterV2: UNISWAP_QUOTER_V2, swapRouter02: UNISWAP_SWAP_ROUTER_02 }` — references canonical constants.ts values (not redefined). Test verifies mainnet Quoter+RPC targets. ✅
- **Curve mainnet:** No changes to the mainnet quote/swap path. chainId check added at the adapter interface only — mainnet path falls through unchanged. Test verifies mainnet CurveRouterNG target. ✅

### A2. No cross-chain RPC leakage ✅

- **`getRpcUrlForChain`:** For `chainId !== DEFAULT_CHAIN_ID`, returns `rpc.primary || rpc.fallbacks[0]` from the chain's registry config. NEVER returns the mainnet RPC. If both are empty, returns `''` → adapter fails fast (no silent mainnet fallback). ✅
- **Uniswap V3:** `getUniswapV3Contracts(chainId)` returns `null` for unconfigured chains → adapter throws `not deployed on chain ${chainId}`. No fallback to mainnet contracts. ✅
- **Curve:** `if ((params.chainId ?? DEFAULT_CHAIN_ID) !== DEFAULT_CHAIN_ID) return null` — zero RPC calls on non-mainnet. Test verifies `fetchSpy.not.toHaveBeenCalled()`. ✅

### A3. Base Uniswap V3 addresses verified ✅

| Contract | Address | Source |
|----------|---------|--------|
| QuoterV2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` | Basescan "Uniswap V3: QuoterV2" + developers.uniswap.org |
| Factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | Basescan "Uniswap V3: Pool Factory" (reference only) |
| SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481` | Basescan + matches `chains/routers.ts` whitelist |

### A4. Test coverage ✅

- `shared.test.ts` (4 tests): mainnet byte-identical, default chainId, Base uses Base RPC, Base fallback (never mainnet).
- `uniswapv3.test.ts` (5 tests): mainnet Quoter+RPC, Base Quoter+RPC (never mainnet), default=mainnet, Base swap Router, mainnet swap Router.
- `curve.test.ts` (4 tests): Base quote null + zero calls, Base swap null + zero calls, mainnet unchanged, default=mainnet.

---

## Area B — Bebop 12th Source (Sprint 9D / P228, `3d938d4`)

### B1. Whitelist gate — FAIL CLOSED ✅

Three independent security checks, all must pass:

1. **`tx.to === settlementAddress`:** Mismatch → throws `tx.to does not match settlementAddress`. Test: rogue tx.to → rejected. ✅
2. **`settlement ∈ getRouterWhitelist(chainId)`:** Not whitelisted → throws `not whitelisted on chain`. Test: rogue settlement → rejected. ✅
3. **`approvalTarget ∈ getRouterWhitelist(chainId)`:** Not whitelisted → throws `not whitelisted on chain`. Test: rogue approvalTarget → rejected. ✅

Both `BEBOP_JAM_SETTLEMENT` and `BEBOP_BALANCE_MANAGER` are in the whitelist for chains 1 and 8453 (via `ROUTER_WHITELIST_BY_CHAIN` + `BEBOP_SPENDERS_BY_CHAIN`). Mainnet `ROUTER_WHITELIST` in api.ts also includes both (test-pinned). ✅

### B2. Secrets server-only ✅

- `BEBOP_API_KEY`: `process.env.BEBOP_API_KEY` — no `NEXT_PUBLIC_` prefix. Next.js excludes from client bundles. ✅
- `BEBOP_SOURCE`: `process.env.BEBOP_SOURCE` — no `NEXT_PUBLIC_` prefix. ✅
- Key sent via `source-auth` header (server-side API route only). Never logged, never returned in response. ✅
- Grep confirms zero occurrences of `NEXT_PUBLIC_BEBOP` in the codebase. ✅

### B3. Fee model ✅

- `bebop` in `FEE_INCOMPATIBLE_SOURCES` → FeeCollector path skipped (mainnet). ✅
- `bebop` in `FEE_INCOMPATIBLE_BY_CHAIN[8453]` → FeeCollector path skipped (Base). ✅
- **Price quote (fetchQuote):** NO fee params → gross output for fair ranking vs other sources. ✅
- **Swap quote (fetchSwapData):** `fee=${FEE_BPS}&fee_recipient=${FEE_RECIPIENT}` → partner fee taken once by Bebop settlement. ✅
- No double fee (not through FeeCollector AND partner fee). No zero fee (FEE_BPS = 10 bps). ✅
- `FEE_RECIPIENT` is env-driven. ✅

### B4. approvalTarget vs settlement ✅

- `fetchApproveSpender('bebop')` → `BEBOP_BALANCE_MANAGER` (`0xC5a350853E4e36b73EB0C24aaA4b8816C9A3579a`). ✅
- NOT the settlement (`0xbeb0b0623f66bE8cE162EbDfA2ec543A522F4ea6`). ✅
- NOT the FeeCollector. ✅
- Test verifies on both chains 1 and 8453. ✅

### B5. Recipient integrity ✅

- `receiver_address: recipient ?? from` — defaults to sender's address. ✅
- Existing `validateCallDataRecipient` runs on all swap sources (including Bebop) in useSwap/useSplitSwap and /api/swap. ✅

### B6. Value/amount parsing ✅

- `BigInt(data.tx.value ?? 0).toString()` — hex `0x0` → `"0"`. ✅
- Test: `expect(r?.tx?.value).toBe('0')`. ✅
- `buyAmount` extracted from `buyTokens[dst].amount` with case-insensitive address match. ✅
- Slippage: `clampSlippage(slippage)` (0.01–15% range). ✅

### B7. Positional array fix ✅

- **Old:** Hardcoded `['1inch', '0x', 'Velora', ...]` indexed by filtered-rejected position → misattributed errors when any source excluded/circuit-open, no 12th slot. ✅
- **New:** `SOURCE_ERROR_LABELS[sourceNames[i]]` keyed by actual source name → correct attribution regardless of order/exclusions. 12 labels. ✅

### B8. Placeholder taker ✅

- Price-only: `BEBOP_PRICE_TAKER = '0x1111...1111'` (non-zero EOA). ✅
- Swap: real `from` address. ✅
- Demo-mode (no key): widened spreads rank poorly → never selected for real swaps. No leak risk. ✅

### B9. No regression ✅

- `ADAPTER_REGISTRY`: 12 entries, `bebop` appended as 12th. Order of first 11 unchanged. ✅
- All other adapter files untouched by the Bebop commit. ✅
- Router whitelist test still pins `getRouterWhitelist(1)` includes Bebop addresses. ✅

### B10. Test coverage ✅

`bebop.test.ts` (11 tests):
- **Adapter tests (7):** chainId 1 URL, chainId 8453 URL, server-only auth header, swap tx mapping + partner-fee params, security: rogue tx.to rejected, security: rogue approvalTarget rejected, security: rogue settlement rejected.
- **Wiring tests (4):** fee-incompatible on both chains, approval spender = Balance Manager on both chains, whitelist includes both settlement + Balance Manager on both chains, registered as 12th in ADAPTER_REGISTRY.

---

## Cross-Cutting Checks ✅

- **Chainlink validation on Bebop swaps:** `validateSwapPrice` runs in the swap API route for ALL sources. Bebop is not exempt. Rule #9 (CLAUDE.md) satisfied. ✅
- **Circuit breaker + timeout:** Bebop goes through the same `withCircuitBreaker` + `withTimeout` wrappers. ✅
- **No new unbounded loops:** Same `Promise.allSettled` fan-out, now 12 instead of 11. ✅
- **FEEDBACK.md:** Both commits documented. 9C: root cause, Base address verification, design notes, cache key edge case (harmless). 9D: fail-closed gate, placeholder taker, gross quote design, error attribution fix, Base FeeCollector override. All items triaged. ✅

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 9CD-I-01 | INFO | `shared.ts` | `feeTierCacheKey` uses the mainnet `CHAIN_ID` constant instead of the active chainId, so the same pair on different chains shares a cache slot. Harmless: both quote and swap paths always re-run `detectUniswapV3FeeTier` (which resolves the correct per-chain Quoter), so the cached tier is advisory and re-validated per chain. Cleanup candidate. |
| 9CD-I-02 | INFO | `bebop.ts` | Placeholder taker (`0x1111...1111`) for price-only quotes may be rejected by Bebop in production, causing Bebop to only appear as a source after wallet connection. Acceptable degradation — swap quotes use the real address. Verify against live API with a real BEBOP_API_KEY. |

---

## Recommendation

**Merge.** Both commits pass all security checks. Mainnet is verified byte-identical across RPC routing, contract addresses, and adapter behavior. Bebop's whitelist gate is airtight (fail-closed on 3 independent checks). Secrets are server-only. Fee model is correct (partner fee once, no FeeCollector double-take). The error attribution fix (positional array → keyed map) is a quality improvement that eliminates a pre-existing misattribution bug.

24 new tests cover the critical paths: no-mainnet-on-Base regression, Base contract address verification, Bebop security gate (3 rejection paths), fee wiring, and spender resolution.
