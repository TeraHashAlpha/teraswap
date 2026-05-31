# SPRINT-9C (hotfix) — On-chain adapters must be chain-aware

Follow-up to the `debug=sources` diagnostic (commit `98e9df0`). Implements the root cause
recorded in `FEEDBACK.md`. One atomic, signed commit; record the hash here.

---

## Root cause

`getRpcUrl()` in `src/lib/adapters/shared.ts` (def @85) takes **no `chainId`** and always
returns the **mainnet** RPC. The on-chain adapters call it without chain context:

- `src/lib/adapters/uniswapv3.ts:106`
- `src/lib/adapters/curve.ts:175` and `:238`

So when `chainId=8453` (Base), these adapters `eth_call` **mainnet contracts over the mainnet
RPC** and return a **mainnet-priced quote**. That is why "only Uniswap V3 shows on Base" — the
quote shown is not a Base quote at all. This is a correctness/safety bug, not a missing source.

The HTTP adapters are already chain-aware and hit Base correctly. A chain-aware viem factory
already exists and is reusable: `src/lib/chains/clients.ts` `getPublicClientForChain(chainId)`,
backed by `getChainConfig(chainId).rpc.primary`.

Chain-awareness here means **both** the RPC endpoint **and** the per-chain contract addresses
(Uniswap V3 Quoter/Factory/Router; Curve pools/router).

## Objective

Make `uniswapv3` and `curve` quote on the **requested** chain — or cleanly return nothing —
and **never** hit a mainnet RPC/contract when `chainId !== 1`. Mainnet (chainId 1) behaviour
must remain **byte-identical**.

## Workflow

### 1. Investigate
- Map how `uniswapv3.ts` and `curve.ts` build their JSON-RPC calls and which contract addresses
  they use. Confirm `getRpcUrl()` has no `chainId` and identify the exact mainnet path it returns
  (likely the `/api/rpc` privacy proxy) — that path MUST stay byte-identical.
- Choose the minimal-diff approach: add a chain-aware resolver `getRpcUrlForChain(chainId)`
  — `chainId === 1` → current `getRpcUrl()`; otherwise `getChainConfig(chainId).rpc.primary` —
  and thread `chainId` (default `DEFAULT_CHAIN_ID`) through both adapters.

### 2. Fix `uniswapv3` (quote Base correctly)
- Thread `chainId` into the quote and swap paths.
- Resolve the RPC via `getRpcUrlForChain(chainId)`.
- Resolve Uniswap V3 contracts **per chain**: QuoterV2 + Factory + SwapRouter02. Base SwapRouter02
  is already whitelisted (`0x2626664c2603336E57B271c5C0b26F421741e481`). Add Base QuoterV2 and
  Factory in a small per-chain registry (not inline literals).
- **VERIFY Base addresses on Basescan / Uniswap `base` deployments before committing**, mirroring
  the comment style in `chains/routers.ts`. Candidates to verify:
  - QuoterV2 `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`
  - V3 Factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`

### 3. Fix `curve` (no bogus mainnet quote off-mainnet)
- Curve pools/router are mainnet-only in code. Until Base Curve pools are configured, `curve`
  MUST cleanly return `null` / skip for `chainId !== 1` and issue **zero** RPC calls in that case.
  Adding Base Curve pools is **out of scope** — leave a `TODO` referencing a future sprint.

### 4. Test (TDD, same rigour as the diagnostic)
- `uniswapv3`: `chainId=8453` uses the Base RPC + Base Quoter (mock the RPC); `chainId=1` path is
  byte-identical (existing tests still pass unchanged).
- `curve`: `chainId=8453` returns `null`/skips and makes no mainnet RPC call; `chainId=1` unchanged.
- Regression: a Base meta-quote no longer surfaces a mainnet-priced Uniswap quote.

### 5. Verify & ship
- Re-run `/api/quote?...&chainId=8453&debug=sources`: `uniswapv3` should now reflect **Base**
  pricing (cross-check against a live KyberSwap/OpenOcean Base quote); `curve` absent/clean.
- `typecheck` clean, `lint` 0 errors, full suite green. Append a `FEEDBACK.md` section.
- One atomic, **signed** commit; record the hash in this file.

## Do NOT
- Do NOT change the mainnet (chainId 1) RPC path or its privacy-proxy behaviour — byte-identical.
- Do NOT let `curve` or `uniswapv3` call a mainnet RPC/contract when `chainId !== 1`.
- Do NOT hardcode unverified Base addresses — verify on Basescan first and comment the source.
- Do NOT touch the other 10 adapters or any fee logic.

## Files affected
- `src/lib/adapters/shared.ts` (add `getRpcUrlForChain`)
- `src/lib/adapters/uniswapv3.ts`
- `src/lib/adapters/curve.ts`
- per-chain address registry (new or under `src/lib/chains/`)
- tests under `src/lib/adapters/`

## Acceptance criteria
- On Base, `uniswapv3` returns a genuine Base quote (or none) — never a mainnet-priced one;
  `curve` is cleanly skipped. Mainnet unchanged. CI green, signed commit, `FEEDBACK.md` updated.

---

## Status — Implemented ✅

- Added `getRpcUrlForChain(chainId)` (`shared.ts`) and a per-chain Uniswap V3 registry
  (`src/lib/chains/uniswap-v3.ts`); threaded `chainId` through `uniswapv3` quote/swap; `curve`
  returns `null` + zero RPC for `chainId !== 1`. Mainnet (chainId 1) byte-identical.
- Base addresses verified on Basescan **and** developers.uniswap.org base-deployments (May 2026):
  QuoterV2 `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` ("Uniswap V3: QuoterV2"),
  Factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` ("Uniswap V3: Pool Factory"),
  SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481` ("Uniswap V3: Swap Router02").
- TDD: 13 new tests (`shared`/`uniswapv3`/`curve`). Full suite green (1296). 6-agent adversarial
  review: 0 confirmed findings. See `FEEDBACK.md` for design notes + the curve-on-Base follow-up.
- Commit hash: reported with the atomic signed commit (self-referential, so not inlined here).
