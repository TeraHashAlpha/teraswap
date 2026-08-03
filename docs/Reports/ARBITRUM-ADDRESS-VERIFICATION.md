# Arbitrum One (42161) Address Verification Report — FULL SET

**Date:** 2026-07-10
**Branch:** `sprint/47-arbitrum-activation-prep`
**Source:** AUDIT-ARBITRUM-46-47 verdict — BLOCK (3 HIGH) on PR #303. Nine recon-sourced
`CHAIN_CONFIGS[42161]` addresses (3 tokens, the sequencer feed, all 5 Chainlink price feeds) had **zero
on-chain code** — hand-transcribed hex drift (each corrupted value shares a prefix with, but diverges from,
the genuine address).

This report **extends** `docs/Reports/ARBITRUM-ROUTER-VERIFICATION.md` (superseded-not-deleted, per rule #4)
to cover every `CHAIN_CONFIGS[42161]` address, not just routers/adapters.

---

## Method — THE METHOD IS THE DELIVERABLE

Root cause was systemic (hand-transcription), so the fix is a **script**, not just 9 edits:
`scripts/verify-arbitrum-addresses.mjs`.

1. **Two independent Arbitrum RPCs** (`arb1.arbitrum.io/rpc`, `arbitrum-one-rpc.publicnode.com`) — `chainId`
   asserted `0xa4b1` (42161) on **both** before any other read; a single lying/misrouted RPC can never pass.
2. **Tokens:** `eth_getCode` non-empty on both RPCs + `symbol()`/`decimals()` match the expected values.
3. **Chainlink price feeds:** `eth_getCode` non-empty + `description()` exactly matches the claimed pair +
   `decimals() === 8` + `latestRoundData()` fresh (within 48h, generous vs. any of these feeds' heartbeats)
   and `answer > 0`.
4. **The L2 sequencer-uptime feed:** `eth_getCode` non-empty + `description()` mentions "Sequencer" +
   `decimals() === 0` + `latestRoundData()` uptime semantics (`answer ∈ {0,1}`, `startedAt` a sane past
   timestamp).
5. **Routers/other contracts** (already deep-verified in `ARBITRUM-ROUTER-VERIFICATION.md`): a lighter
   `eth_getCode`-presence check — this report's job for these is to **manifest** them (pin against silent
   drift), not re-litigate their verification.
6. **The script emits the exact address strings** to `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json`. Config
   values are **copied from that output**, never retyped by hand — the failure mode this remediation exists
   to close structurally.

Official sources consulted per category:
- **Tokens:** cross-referenced against 2–4 independent public token lists (1inch's `tokens.1inch.io`,
  LI.FI's token API, Uniswap's default token list / Trust Wallet's `assets` repo) **and** GeckoTerminal's
  live top-volume pool data (the strongest signal — it reflects what real swaps on Arbitrum actually use
  today, not a curated list's editorial choices).
- **Chainlink feeds + sequencer:** Chainlink's official reference-data directory
  (`reference-data-directory.vercel.app/feeds-ethereum-mainnet-arbitrum-1.json`), which lists **multiple**
  proxy addresses per pair (production, deprecating, "-svr"/"-shared-svr" variants); the canonical entry is
  the one with an **ENS-registered path** (e.g. `eth-usd`, not `eth-usd-svr`) — confirmed this
  disambiguation rule holds for all 5 pairs before trusting it.

---

## The 9-row old → new table

| # | Address | Old (recon, zero on-chain code) | New (verified) | Proof |
|---|---|---|---|---|
| 1 | Token: USDT | `0xFd086b2F39B6b86fEe29f27E8f6be40e7F2E7D2b` | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | Both RPCs: code present, `decimals()===6`. On-chain `symbol()` reads `"USD₮0"` (Tether's newer LayerZero omnichain standard) — confirmed via GeckoTerminal's live top-volume "USDT" pools on Arbitrum as the dominant USDT-pegged token by trading volume today; matches 1inch's list (labeled "USDT0") and Trust Wallet's list (labeled "USDT"/"Tether USD" — same address, differing display name). Config key stays `USDT` for cross-chain continuity. |
| 2 | Token: DAI | `0xda10009754f1dF9137293aed5d6DD0dB0Bb075e9` | `0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1` | Both RPCs: code present, `symbol()==="DAI"`, `decimals()===18`. Matches 1inch, LI.FI, Uniswap's default list, and GeckoTerminal's top DAI/USDT pool. |
| 3 | Token: WBTC | `0x2F2a2440D2f12C0cDdE18Fe9AEf0cc0d6cF3FC30` | `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` | Both RPCs: code present, `symbol()==="WBTC"`, `decimals()===8`. Matches 1inch, LI.FI, Uniswap's default list, and GeckoTerminal's top WBTC pools (WBTC/WETH, WBTC/USDT, WBTC/USDC). |
| 4 | Sequencer uptime feed | `0xFdB631f5eE196f5C5AA41F952B0282f59B2Eff9E` | `0xFdB631F5EE196F0ed6FAa767959853A9F217697D` | Both RPCs: code present (19,144 B), `description()==="L2 Sequencer Uptime Status Feed"`, `decimals()===0`, `latestRoundData()` returns `answer=0` (up) with a sane `startedAt`. Resolved from Chainlink's official docs. |
| 5 | Feed: ETH/USD | `0x639Fe6ab55C921f74e7fac19EEcf32fd97d80027` | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` | Both RPCs: `description()==="ETH / USD"`, `decimals()===8`, fresh (`updatedAt` ~29s old at verification time), `answer>0`. ENS path `eth-usd` (canonical; two "-svr" sibling entries excluded). |
| 6 | Feed: USDC/USD | `0x50834F3e0744f40f628f86e6388f2a4f9a81147f` | `0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3` | Same checks; fresh (~29s old). ENS path `usdc-usd`. **Note:** this feed was NOT in the original "9 broken" framing (recon implied only DAI/USDT/WBTC + sequencer + a generic "feeds" bucket) — re-checked ALL 5 feeds independently before trusting that framing, and found ETH/USD and USDC/USD were ALSO zero-code. Corrected here as findings #5 and #6 of this table. |
| 7 | Feed: DAI/USD | `0xc5C8E77B397E3A2B92f72841640bc7F7eF440DA7` | `0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB` | Same checks; fresh (~2.7h old, within its 86400s heartbeat). ENS path `dai-usd` (a sibling `dai-usd-svr`, explicitly marked `feedCategory: "deprecating"` and stale at ~20h old, was excluded). |
| 8 | Feed: USDT/USD | `0x3f3f5dF88dC9F13eAFAa42Efb9A3c236f4B3E305` | `0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7` | Same checks; the most actively updated of the three USDT/USD candidates (~155s old vs. ~5.8h/~5.7h for the other two). ENS path `usdt-usd`. |
| 9 | Feed: WBTC/USD | `0xd0C7101eACbB49F3Debb3C340BB2F48c36e341c5` | `0xd0C7101eACbB49F3deCcCc166d238410D6D46d57` | Same checks; fresh (~35s old), the only WBTC/USD candidate found. ENS path `wbtc-usd`. |

**Every "new" address in this table was confirmed on BOTH `arb1.arbitrum.io/rpc` and
`arbitrum-one-rpc.publicnode.com`** (chainId `0xa4b1` asserted on both) at block `0x1cbdac6b` /
`0x1cbdac6f` respectively (see `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json` for the exact per-RPC
results, decoded field values, and generation timestamp).

**Corrected heartbeats** (from Chainlink's official reference-data directory, replacing the untrusted
recon report's rounded ~1h/~24h estimates): ETH/USD 1755s, USDC/USD 255s, DAI/USD 86400s, USDT/USD 255s,
WBTC/USD 86400s.

---

## Full address set (routers carried from #303 + the 9 fixes above)

| Category | Key | Address | Status |
|---|---|---|---|
| Token | WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | Unchanged — already correct |
| Token | USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | Unchanged — already correct (native USDC) |
| Token | USDT | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | **Corrected** (row 1 above) |
| Token | DAI | `0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1` | **Corrected** (row 2 above) |
| Token | WBTC | `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` | **Corrected** (row 3 above) |
| Sequencer | sequencerUptimeFeed | `0xFdB631F5EE196F0ed6FAa767959853A9F217697D` | **Corrected** (row 4 above) |
| Feed | ETH/USD | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` | **Corrected** (row 5 above) |
| Feed | USDC/USD | `0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3` | **Corrected** (row 6 above) |
| Feed | DAI/USD | `0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB` | **Corrected** (row 7 above) |
| Feed | USDT/USD | `0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7` | **Corrected** (row 8 above) |
| Feed | WBTC/USD | `0xd0C7101eACbB49F3deCcCc166d238410D6D46d57` | **Corrected** (row 9 above) |
| Contract | Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Unchanged — cross-chain CREATE2 deterministic |
| Contract | CoW VaultRelayer | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` | Unchanged — cross-chain deterministic |
| Router | 1inch | `0x111111125421cA6dc452d289314280a0f8842A65` | Unchanged — re-confirmed in #303 |
| Router | 0x | `0x0000000000001fF3684f28c67538d4D072C22734` | Unchanged — report-verified |
| Router | Velora (Augustus V6.2) | `0x6A000F20005980200259B80c5102003040001068` | Unchanged — re-confirmed in #303 |
| Router | Odos | `0x19cEeAd7105607Cd444F5ad10dd51356436095a1` | Unchanged — report-verified |
| Router | KyberSwap | `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` | Unchanged — report-verified |
| Router | OpenOcean | `0x6352a56caadC4F1E25CD6c75970Fa768A3304e64` | Unchanged — re-confirmed in #303 |
| Router | SushiSwap | `0xAC4c6e212A361c968F1725b4d055b47E63F80b75` | Fixed in #303 (RedSnwapper, not the recon's undeployed "RouteProcessor5") |
| Router | Balancer | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` | Unchanged — canonical CREATE2 |
| Router | UniswapV3 (SwapRouter02) | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | Fixed in #303 (was the V1 SwapRouter) |
| Contract | UniswapV3 Factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | Fixed in #303 |
| Contract | UniswapV3 QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | Fixed in #303 |

**24 entries total** — matches `docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json`'s entry count and the CI-safe
regression guard (`src/lib/chains/arbitrum-manifest.test.ts`), which asserts `CHAIN_CONFIGS[42161] ===
manifest` for every one of them.

**Not in this manifest (flagged, not fixed):**
- **Curve router** (`routers.ts` `42161.curve`) — also resolves to empty on-chain code, per
  `ARBITRUM-ROUTER-VERIFICATION.md`. No verified official replacement found (never invent addresses). Zero
  functional impact — the Curve adapter is mainnet-only fail-closed today.
- **wstETH** — named in `docs/Reports/ARBITRUM-READINESS.md`'s token list and in this sprint's own spec,
  but `CHAIN_CONFIGS[42161].tokens` has no `wstETH` field in the current codebase. Nothing to manifest;
  adding a new token field is out of scope for a remediation sprint (would be new surface, not a fix).

---

## Controls (why this shouldn't recur)

1. **`scripts/verify-arbitrum-addresses.mjs`** is the durable, re-runnable verification tool — re-run it
   before any future edit to a `CHAIN_CONFIGS[42161]` address, and copy the corrected value straight from
   its printed output (or the manifest it writes) rather than retyping hex.
2. **`src/lib/chains/arbitrum-manifest.test.ts`** fails CI if the live config ever drifts from the last
   verified manifest for ANY of the 24 addresses — not just routers.
3. **Two-RPC + chainId assertion** in the script defends against a single compromised/misconfigured RPC
   endpoint silently validating a wrong address.
4. **`docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md`** now requires a fresh manifest-verification run to
   pass before any deploy pre-flight step proceeds (see that runbook's updated Step 1).
