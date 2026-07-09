# SPRINT-46-ARBITRUM-CONFIG — config-only dark launch for Arbitrum One (42161)

> **Source:** `docs/Reports/ARBITRUM-READINESS.md` (chore/arbitrum-readiness, merged to main). This
> sprint is Phase 1 of the proposed slicing (Sprint 46: swaps config). Config-only — no contract
> deploys, no UI activation. `contracts.feeCollector = null` for 42161 keeps the chain fail-closed
> exactly like Base pre-activation (Sprint 44/45 pattern).
> SSH-signed; branch `sprint/46-arbitrum-config` off latest `origin/main` in a dedicated worktree.

## Objective
Register Arbitrum (42161) in every chain-config module the report identified, with every value
sourced from the report (no re-derivation), while keeping the chain completely dark: no quotes
served, no orders/DCA surface — identical to Base's pre-`NEXT_PUBLIC_BASE_FEE_COLLECTOR` state.
**Correction during implementation:** ChainSelector.tsx lists every `getSupportedChainIds()`
entry unconditionally and shows a "Soon" badge for `feeCollector === null` chains — this is
Base's actual pre-activation UI (switchable, badge-flagged, functionally inert downstream), not
a hidden chain. Arbitrum appearing there with "Soon" is the SAME existing pattern, not new UI
activation; see FEEDBACK.

## Scope

1. **gasModel** — add `'arbitrum'` to the `GasModel` union (`src/lib/chains/types.ts`). No new fee
   estimation branch: `useEthGasCost` already computes gas price generically via
   `useEstimateFeesPerGas` (wagmi) and reads the Chainlink feed via `getChainlinkFeed(chainId)`; no
   `'op-stack'` branch exists in the codebase to mirror. Regression: zero behavior change for chains
   1/8453 (existing tests still pass byte-identical).

2. **`CHAIN_CONFIGS[42161]`** (`src/lib/chains/registry.ts`) — from the report: slug `'arbitrum'`,
   `nativeCurrency.wrappedAddress` = Arbitrum WETH, `contracts.feeCollector` = `null` (fail-closed,
   env-driven like Base), `contracts.permit2` (canonical CREATE2), `contracts.cowVaultRelayer`
   (cross-chain deterministic), `rpc.primary` via `NEXT_PUBLIC_ARBITRUM_RPC_URL` (empty default, same
   pattern as Base), `blockExplorer` = arbiscan, `gasModel: 'arbitrum'`, `sequencerUptimeFeed` (report
   address), `tokens` = WETH + **USDC NATIVE only** (USDC.e deliberately excluded from v1 — curation
   decision, mirrors the report's flag). `chainlink-feeds.ts`: 7 core feeds (ETH/USD, BTC/USD,
   USDC/USD, DAI/USD, USDT/USD, WBTC/USD, wstETH/USD) keyed by Arbitrum token address, from the
   report's verified addresses.

3. **Adapters × 42161** — `routers.ts`: `ROUTER_WHITELIST_BY_CHAIN[42161]` for all 12 sources (report
   addresses); inert while `feeCollector` is null (the whitelist is consulted only on an active
   chain's swap path). `constants.ts`: add `42161: 'https://api.cow.fi/arbitrum/api/v1'` to
   `COW_API_URLS`. `uniswap-v3.ts`: `UNISWAP_V3_BY_CHAIN[42161]` (QuoterV2, factory, SwapRouter02,
   report addresses). Curve: already mainnet-only fail-closed (`fetchQuote`/`fetchSwapData` return
   `null` for any `chainId !== DEFAULT_CHAIN_ID`, which already covers 42161 with zero code change);
   documented with the report's Arbitrum router address in the existing TODO comment, mirroring the
   Base note. **Balancer verdict:** already globally disabled via `DISABLED_SOURCES.balancer` (all
   chains, since W7-L-02 / `T-SAF`) — no Arbitrum-specific gate needed; the report's "UNKNOWN" flag is
   resolved by the existing global disable, which already fail-closes Arbitrum along with every other
   chain.

4. **Order-engine isolation** — no gate code changes (`ORDER_EXECUTOR_BY_CHAIN` and
   `isDcaLive`'s `BASE_CHAIN_ID` pin already exclude any chainId not explicitly listed, so 42161 is
   fail-closed today with zero edits). Add regression tests asserting: `getOrderExecutor(42161) ===
   null`, `getOrderExecutorDomain(42161)` throws, `isDcaLive(42161) === false` regardless of the
   launch flag, and `getWhitelistedRouters(42161)` falls back to the mainnet map (existing fallback
   behavior — never a 42161-specific order-engine router set).

5. **Tests + env** — config resolution (`getChainConfig(42161)`), adapter URL/param construction per
   adapter, gasModel branch coverage, `USD_STABLECOINS_BY_CHAIN[42161] = ['USDC']` (native-only),
   sequencer feed presence, dark-launch assertions (42161 absent from any chain-selector list that
   filters on `isChainActive`; `getChainStatus(42161) === 'coming-soon'`). `.env.example`: add
   `NEXT_PUBLIC_ARBITRUM_RPC_URL` and `NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR` (names only, empty values,
   mirroring the Base section).

## Do NOT
- Do NOT deploy contracts. Do NOT activate Arbitrum UI or serve 42161 quotes. Do NOT enable
  orders/DCA on 42161 (v3-deploy-phase work, not this sprint). Do NOT touch v3 sprint files
  (`TeraSwapOrderExecutorV3*`, ADR-013) or keeper executor routing — parallel sessions own them. Do
  NOT change mainnet/Base behavior. Do NOT add USDC.e. Do NOT weaken any fail-closed gate. Do NOT
  print/commit secrets.

## Files affected
- **Read-only (source of truth):** `docs/Reports/ARBITRUM-READINESS.md`, Base `ChainConfig` (pattern
  reference), order-gate modules (`dca-launch.ts`, `order-engine/config.ts` — assert-only, no edits).
- **New/edited:** `src/lib/chains/types.ts`, `registry.ts`, `chainlink-feeds.ts`, `routers.ts`,
  `uniswap-v3.ts`, `stablecoins.ts`, `constants.ts` (`COW_API_URLS`), their `*.test.ts` files,
  `.env.example`, this spec.

## Expected output
Branch `sprint/46-arbitrum-config` (dedicated worktree), SSH-signed, PR open, CI green — push +
report, do NOT watch CI. FEEDBACK ≤1 screen: Balancer verdict, any report value failing
re-validation (escalated, not substituted), dark-launch assertion list. Auditor note only in the PR
body (full pass rides the activation sprint — this sprint carries no fund-flow risk: `feeCollector`
stays null throughout).

## Quality criteria
Every address/feed/slug traces to `docs/Reports/ARBITRUM-READINESS.md` — no re-derived values. Chain
1/8453 tests remain byte-identical. 42161 is provably inert: no chain-selector entry, `isChainActive
(42161) === false`, order/DCA surface fail-closed, zero quotes servable.
