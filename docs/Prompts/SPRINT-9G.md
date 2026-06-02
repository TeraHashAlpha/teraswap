# SPRINT-9G — Chain-aware safety gates (Base is LIVE)

From the full audit `Audits/FULL-AUDIT-2026-06-02.md`. The 12 Medium findings share one root cause:
the **safety/oracle/validation gates were never migrated to be chain-aware** when the multi-chain
layer landed. The audit rated them Medium under a stale "Base is coming-soon" premise — **Base is
now LIVE/activated** (`isChainActive(8453)===true`, real swaps happening), so the oracle/anti-manip/
post-exec gaps are **active reductions in Base swap safety today**. Architect re-rates M04/M06,
M07/M11, M12 as **HIGH**. Decision: **keep Base live + fast-track these fixes** (version A).

The correct primitives already exist and are used by the chain-aware adapters:
`getPublicClientForChain(chainId)` (`src/lib/chains/clients.ts`), `getRpcUrlForChain(chainId)`
(`src/lib/adapters/shared.ts`, never returns mainnet RPC off-mainnet), and per-chain slug via
`getChainConfig(chainId).slug`. Mainnet (chainId 1) MUST stay byte-identical throughout — every
helper has a `chainId===1` path that resolves to today's behaviour.

**These are security/fund-flow gates → implement with TDD, do NOT auto-deploy. Auditor reviews
before merge; ship via the Vercel Preview gate, not straight to main.**

## Workflow (priority order — HIGH first, since Base is live)

### G1 — Chainlink + L2 sequencer chain-aware [HIGH · M04, M06]
- In `src/lib/chainlink.ts` (fetchChainlinkPriceRaw / fetchChainlinkPrice) and
  `src/lib/price-monitor.ts`, replace `getPrivateClient()`/`getClient()`/`getRpcUrl()` with
  `getPublicClientForChain(chainId)` / `getRpcUrlForChain(chainId)` for the non-mainnet branch, so
  `isSequencerUp(chainId, …)` and the feed `readContract` hit the **Base** RPC/feed, not mainnet.
- `chainId===1` keeps using `getPrivateClient()`/`/api/rpc` → mainnet byte-identical.
- Test: a Base feed read + sequencer check target a Base-bound client; mainnet unchanged.

### G2 — DefiLlama >$10k price guard chain-aware [HIGH · M07, M11]
- Add an optional `chain: string` (DefiLlama slug) param to `validateSwapPrice` (`defillama.ts`),
  forwarded to both `fetchDefiLlamaPrice` calls. In `src/app/api/swap/route.ts` derive the slug from
  `getChainConfig(chainId).slug` and pass it to `validateSwapPrice` AND the `estimatedValueUsd`
  `fetchDefiLlamaPrice(src)` (line ~189). Default `'ethereum'` for chainId 1 → mainnet byte-identical.
- Test: a Base >$10k swap actually validates Base prices (not always-block); sub-$10k no longer
  fails-open silently.

### G3 — Post-execution balance validator chain-aware [HIGH · M12]
- `src/lib/post-execution-validator.ts`: thread `chainId` into `validateExecution()` and build the
  client via `getPublicClientForChain(chainId)` instead of the hardcoded mainnet `getServerClient()`.
  Thread chainId from the caller route (`api/monitor/validate-execution/route.ts`).
- Test: a Base tx receipt is looked up over the Base RPC; the auto-disable path can fire on Base.

### G4 — Server-side activation gate [MEDIUM · M03, M05, L06]
- Add a server boundary check in `/api/swap` (and `/api/spender`): if `chainId` is provided and
  `!getSupportedChainIds().includes(chainId) || !isChainActive(chainId)` → reject (400 unsupported /
  409 coming-soon via `getChainStatus`). Mainnet (default) unaffected.
- `/api/quote` is intentionally multi-chain-open (per `route.integration.test.ts`) — do NOT break
  that; at most gate it to **supported** chains, not active ones. Reconcile with the existing test
  rather than blindly blocking.

### G5 — `useTokenBalances` chain-aware [MEDIUM · M08]
- Mirror the SwapBox fix: derive `useActiveChainId()`, gate with `isChainActive` (not strict
  `CHAIN_ID`), iterate `getChainTokenList(activeChainId)`, pass `chainId: activeChainId` to
  `useBalance`/`useReadContracts`. Base balances then render.

### G6 — Single chain-id source of truth [MEDIUM · hooks]
- `useSwap` / `useSplitSwap` use wagmi `useChainId()` while the rest of the pipeline uses
  `useActiveChainId()`. Make the simulate/broadcast chain provably equal to the quote chain — pick
  ONE (prefer `useActiveChainId()`), or document+guard why they must differ. Add a test they agree.

### G7 — Balancer adapter fail-closed whitelist [MEDIUM/LOW]
- `balancer.ts` `fetchSwapData`: before returning `tx`, require
  `getRouterWhitelist(chainId).includes(data.to.toLowerCase())` and throw otherwise — mirror Bebop's
  gate. **Verify the real Balancer V2 tx.to per chain** (Vault vs relayer) before committing.

### G8 — Low-risk correctness [LOW · feeTier cache, Chainlink startedAt]
- `feeTierCacheKey()` → scope by `chainId` not the static `CHAIN_ID`.
- `fetchChainlinkPriceRaw` → delegate to `validateRoundData(...)` so the swap path also enforces the
  `startedAt > 0` incomplete-round guard (consistency with the order-engine path).

## Do NOT
- Do NOT change mainnet (chainId 1) behaviour — byte-identical, test-guarded, every gate.
- Do NOT touch Solidity/contracts. Keys stay server-only.
- Do NOT auto-deploy or merge to main — commit on `feat/sprint-9g-chain-aware-gates`; Auditor
  reviews; ship via Vercel Preview gate after 0C/0H.
- Each fix = atomic GPG/SSH-signed commit, CI green (lint, typecheck, test, audit). Append FEEDBACK.

## Acceptance
- On Base: Chainlink+sequencer validate over the Base RPC; the DefiLlama >$10k guard validates Base
  prices; the post-exec validator works on Base; server rejects inactive chains; Base balances show;
  one chain-id source of truth. Mainnet byte-identical. Full suite green; new per-fix tests.
