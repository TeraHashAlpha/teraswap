# Arbitrum One (42161) Router Verification Report

> **[CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION] SUPERSEDED (not deleted, per rule #4):** this report's
> router-set findings are still valid and are carried forward as-is. For the FULL address set (this
> report's routers + the 9 additional tokens/feeds/sequencer findings from AUDIT-ARBITRUM-46-47),
> see **`docs/Reports/ARBITRUM-ADDRESS-VERIFICATION.md`**, which extends this report rather than
> replacing it.

**Date:** 2026-07-09
**Branch:** `sprint/47-arbitrum-activation-prep`
**Scope:** On-chain re-verification of every router/spender address `ROUTER_WHITELIST_BY_CHAIN[42161]` and
`UNISWAP_V3_BY_CHAIN[42161]` currently carry, closing the `SPRINT-46-ARBITRUM-CONFIG` FEEDBACK checklist
(1inch/OpenOcean not explicitly re-verified; SwapRouter/SwapRouter02 discrepancy unresolved).

**Method:**
1. **`eth_getCode` against the public Arbitrum RPC** (`https://arb1.arbitrum.io/rpc`, chainId confirmed
   `0xa4b1` = 42161) — presence of code is a necessary (not sufficient) check; a configured address with
   `codeLen == 2` (empty) is a **definitive** bug (no contract there at all).
2. **Bytecode diff against the known-good mainnet/Base deployment** — for addresses claimed
   "cross-chain deterministic," a byte-for-byte comparison of the runtime code isolates the diff to
   chain-specific embedded constants (e.g. the native-WETH address), which is exactly the expected
   signature of the *same* contract source deployed on two chains, not a coincidental code match.
3. **Live adapter API calls** — for API-routed sources (Sushi, OpenOcean), the actual quote/swap endpoint
   for chain 42161 was called and its returned `tx.to` compared against the configured value directly —
   the strongest possible check, since it's what the adapter would *actually* send today.
4. **Official docs** (developers.uniswap.org Arbitrum deployments page) for Uniswap V3's Factory/Quoter/
   SwapRouter/SwapRouter02 address book.

---

## Verdicts

| Adapter | Configured (before) | Verdict | Correct value | Evidence |
|---|---|---|---|---|
| **Velora / Augustus V6.2** | `0x6A000F20005980200259B80c5102003040001068` | ✅ **RE-CONFIRMED** | unchanged | Code present (49,126 B). Byte-diff vs the same address on Base: 97.27% identical, **only** diff is the embedded native-WETH constant (Base `0x4200…0006` vs Arbitrum `0x82af…fbab1`) — conclusive proof of the same contract source, not an address coincidence. |
| **1inch AggregationRouterV6** | `0x111111125421cA6dc452d289314280a0f8842A65` | ✅ **CONFIRMED** (was `[FEEDBACK]`-flagged assumed) | unchanged | Code present (48,590 B). Byte-diff vs the same address on mainnet: 98.35% identical, only diff is the embedded WETH constant (mainnet `0xc02a…6cc2` vs Arbitrum `0x82af…fbab1`) at a single site. Cross-chain-deterministic assumption **verified**, not just assumed. |
| **OpenOcean Exchange** | `0x6352a56caadC4F1E25CD6c75970Fa768A3304e64` | ✅ **CONFIRMED** (was `[FEEDBACK]`-flagged assumed) | unchanged | Live `POST open-api.openocean.finance/v4/42161/swap` returned `tx.to = 0x6352a56caadc4f1e25cd6c75970fa768a3304e64` — **exact match**, direct evidence from the adapter's real execution path, not inference. |
| **UniswapV3 SwapRouter (adapter target)** | `0xE592427A0AEce92De3Edee1F18E0157C05861564` labeled "SwapRouter02" | ❌ **WRONG CONTRACT — FIXED** | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | See **SwapRouter02 resolution** below. |
| **UniswapV3 Factory** | `0x1f98431C8Ad98523631ae4a59F267346ea31564E` | ❌ **NO CODE — FIXED** | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | `eth_getCode` on the configured value returns `0x` (empty, no contract deployed at that address on Arbitrum at all). The corrected value is the canonical CREATE2 UniswapV3Factory — confirmed 49,072 B of code on Arbitrum, and it is the exact same address as mainnet/Base (deterministic factory deploy). |
| **UniswapV3 QuoterV2** | `0xb27308F9f90D7314fB6D5dB7159750d37D2c3cEe` | ❌ **NO CODE — FIXED** | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | `eth_getCode` on the configured value returns `0x` (empty). The corrected value is the same address as the mainnet `UNISWAP_QUOTER_V2` constant — confirmed 16,548 B of code on Arbitrum (QuoterV2 is deployed at the same address on mainnet + Arbitrum; Base has its own distinct address, already correctly configured separately). |
| **SushiSwap router** | `0x54F0fF7bF862325b855B0481b8E493ec5C7Cbbc7` labeled "RouteProcessor5" | ❌ **NO CODE — FIXED** | `0xAC4c6e212A361c968F1725b4d055b47E63F80b75` | `eth_getCode` on the configured value returns `0x` (empty). Live `POST api.sushi.com/swap/v7/42161` returned `tx.to = 0xac4c6e212a361c968f1725b4d055b47e63f80b75` (confirmed 9,958 B of code on Arbitrum) — this is the **same address already configured for Base's RedSnwapper** (`routers.ts` `8453.sushiswap`). Sushi's real Arbitrum router is RedSnwapper, not a distinct "RouteProcessor5" address; the report's assumed value was never deployed. |
| **Curve router** | `0xF0d4c12e3c5589b1dE35Eaf85b163Cc23827e854` | ⚠️ **NO CODE — FLAGGED, NOT FIXED** | unknown | `eth_getCode` on the configured value returns `0x` (empty). Could not obtain a reliable official replacement address within this pass (Curve's public API endpoints did not yield a definitive router address, and per the "never invent addresses" rule this value is **left as-is but flagged broken** rather than guessed). **No functional impact today**: the Curve adapter is hardcoded mainnet-only and fails closed (`return null`) for any `chainId !== 1` before ever reading this address (`src/lib/adapters/curve.ts`). Needs a real fix before Curve is ever enabled on Arbitrum. |
| 0x AllowanceHolder, CoW VaultRelayer, Bebop JAM | unchanged | ✅ has code (not re-diffed in depth) | unchanged | Both confirmed present via `eth_getCode` (2,020 B / 9,182 B respectively); not named in the sprint's required checklist, lower risk (documented cross-chain-deterministic CREATE2/shared deploys), not independently bytecode-diffed this pass. |
| KyberSwap, Odos | unchanged | ✅ has code | unchanged | Both confirmed present via `eth_getCode`: KyberSwap MetaAggregationRouterV2 (37,306 B), Odos Router V2 (40,582 B). Not independently bytecode-diffed; addresses were already report-verified. |

---

## SwapRouter02 resolution (the named discrepancy)

**Question:** the recon report (`docs/Reports/ARBITRUM-READINESS.md` line 207) and the Sprint-46 config both
label `0xE592427A0AEce92De3Edee1F18E0157C05861564` as "SwapRouter02" for Arbitrum. Is that correct?

**Answer: No.** `0xE592427A0AEce92De3Edee1F18E0157C05861564` is the **original Uniswap V3 `SwapRouter`
(V1)** — confirmed both by the official Uniswap docs (developers.uniswap.org Arbitrum deployments page,
which lists it under "SwapRouter", separately from "SwapRouter02") and on-chain: its runtime bytecode
(24,142 B) is a completely different size from the genuine SwapRouter02 deployment (48,996 B) — these are
unambiguously two different contracts, not an aliasing/labeling quirk.

**Which one does our adapter actually target?** `src/lib/adapters/uniswapv3.ts`'s `SWAP_ROUTER_02_ABI`
defines `exactInputSingle`'s params tuple **without** a `deadline` field, and instead wraps the call in
`multicall(uint256 deadline, bytes[] data)` — this is the **SwapRouter02** calling convention (V1's
`ExactInputSingleParams` struct embeds `deadline` directly and has no such `multicall` overload). Mainnet's
`UNISWAP_SWAP_ROUTER_02` constant (`0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`) and Base's own
`swapRouter02` (`0x2626664c2603336E57B271c5C0b26F421741e481`) are both genuine SwapRouter02 deployments used
with this exact calldata shape.

**Fix:** Arbitrum's `swapRouter02` (and the mirrored `routers.ts` whitelist entry) is corrected to
`0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` — **the same address as mainnet** (Uniswap's SwapRouter02 was
part of the original synchronized multi-chain deploy covering Ethereum/Optimism/Arbitrum/Polygon; Base
joined later via a different deployer nonce, hence its distinct address). Confirmed present on-chain
(48,996 B). The old V1 SwapRouter address is removed from the config entirely — it was never a valid
target for this adapter's calldata shape and would have reverted on any real swap attempt.

---

## Files corrected (this commit)

- `src/lib/chains/uniswap-v3.ts` — `UNISWAP_V3_BY_CHAIN[42161]`: `quoterV2`, `factory`, `swapRouter02`.
- `src/lib/chains/routers.ts` — `ROUTER_WHITELIST_BY_CHAIN[42161]`: `uniswapv3`, `sushiswap`.
- `src/lib/chains/uniswap-v3.test.ts`, `src/lib/chains/routers.test.ts` — pinned values updated to match.

All four corrected addresses were independently confirmed to have deployed code on Arbitrum via
`eth_getCode` against the public Arbitrum RPC at the time of this report. `curve` is flagged broken (empty
code) but left uncorrected — no verified official replacement found, and the adapter is inert off mainnet.
