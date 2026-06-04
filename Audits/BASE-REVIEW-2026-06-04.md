# BASE-REVIEW 2026-06-04 — End-to-end review of the Base (8453) swap path

**Scope:** read-only investigation of the full Base swap lifecycle (quote → oracle → approval →
review → sim → send → receipt → history) against the mainnet-hardened codebase. No code edits, no
state-mutating contract calls. Severity is rated **with Base LIVE** (no "coming-soon" discount).
Method: code + test reads, on-chain logic verification, 4 parallel read-only sub-audits, all findings
spot-verified against source. file:line throughout.

**Branch base:** `origin/main @ 43e751a` (post-9P).

---

## 🔴 PHASE 1 — URGENT: every ERC20-input swap on Base reverts (chain-unaware allowance reads)

**Symptom (prod):** on Base, `USDC→ETH` fails pre-swap simulation ("Simulation reverted") on **Velora
AND KyberSwap** — the 9O fallback fires ("velora couldn't execute — switched to …") and the next source
*also* reverts, so every source fails. **ETH-input swaps work.**

### Root cause — CONFIRMED (it is the allowance/pre-flight path, not the spender, not the router whitelist)

Decisive eliminations first:
- **Spender resolution is chain-aware and correct.** `fetchApproveSpender(source, chainId)` returns the
  *chain's* FeeCollector for fee-routed sources (`src/lib/api.ts:540-542`, `getChainConfig(chainId).contracts.feeCollector`).
  So "wrong per-chain spender" is **ruled out**.
- **The Base FeeCollector is deployed and its routers are whitelisted** — because **ETH-input swaps work
  on Base**. `swapETHWithFee` enforces the same `whitelistedRouters[router]` gate as `swapTokenWithFee`
  (`contracts/TeraSwapFeeCollector.sol:191` vs `:258`), so a working ETH→token Velora swap proves the
  Velora router is whitelisted on the Base FeeCollector. A 9O-style router-whitelist gap is **ruled out**.
- **The pre-swap simulation is chain-correct.** `buildSimulationTx`→`simulateSwapTx` uses
  `getPublicClientForChain(chainId)` (`src/lib/swap-simulation.ts:134`), which builds a *Base* client
  for 8453 (`src/lib/chains/clients.ts:23-40`). So the sim faithfully `eth_call`s the Base
  `swapTokenWithFee`, whose `IERC20(token).transferFrom(user,…)` reverts when the user has **not approved
  the Base FeeCollector** → conclusive revert.

What's left is the **allowance/approval reads**, and they are **not chain-pinned**:

1. **`getPrivateClient()` is hard-pinned to mainnet.** `src/lib/rpc.ts:53-65` always builds
   `createPublicClient({ chain: mainnet, … })`, and its browser transport POSTs to `/api/rpc` with **no
   `?chainId=`** (`src/lib/rpc.ts:29`) → the proxy defaults to mainnet. Every browser `getPrivateClient()`
   read resolves against **mainnet RPC regardless of the connected chain.**
2. **The useSwap pre-flight allowance checks use `getPrivateClient()`** — `src/hooks/useSwap.ts:492-499`
   (FeeCollector route) and `:533-540` (direct route). On Base these read the user's **mainnet** allowance.
3. **The approval gate (`useApproval`) reads allowance without pinning `chainId`** —
   `src/hooks/useApproval.ts:52, 63, 74` (`useReadContract` with no `chainId`). It usually follows the
   connected wallet chain, but it is **not pinned to the chain the swap will execute on**, so during the
   connect→switch settle window (ChainSelector calls `useSwitchChain`, `src/components/ChainSelector.tsx:72`)
   it can resolve against the previous chain.

**Causal chain (Base, USDC→ETH):** the approval gate resolves the user as "ready / no approval needed"
(allowance read not reliably pinned to Base) → the user reaches the swap step → the chain-correct sim
runs `swapTokenWithFee` on Base → `transferFrom` reverts (no Base-FeeCollector approval) → conclusive
revert → 9O fallback retries the next fee-routed source, which needs the **same** Base-FeeCollector
approval → every source reverts. ETH-input is immune because `swapETHWithFee` uses `msg.value` (no
`transferFrom`, no allowance). The mainnet path is unaffected because the hard-pinned mainnet client
*matches* the active chain there.

### Severity: **HIGH** (URGENT) — a whole class of swaps (sell any ERC-20) is dead on a live chain. No fund loss / no safety-gate bypass (the on-chain `minimumOutput` and sim still protect funds), which keeps it below Critical.

### Minimal fix (effort: **M**)
1. **Make `getPrivateClient` chain-aware** — accept a `chainId`, append `?chainId=` to the `/api/rpc`
   fetch, and pick the viem chain from the registry (mirror the existing `getRpcUrlForChain` /
   `getPublicClientForChain`, which already do this correctly). **Or**, lower-blast-radius: replace the
   two useSwap pre-flight `getPrivateClient()` calls (`useSwap.ts:492,533`) with
   `getPublicClientForChain(chainId)` (already chain-correct, already imported for the sim).
2. **Pin the approval-gate reads** — pass `chainId: activeChainId` to the three `useReadContract` calls in
   `useApproval.ts` (it already computes `chainId = useActiveChainId()` at `:36`, used only for the spender
   allowlist today) so the gate reflects the chain the swap executes on.

This single root cause (chain-unaware `getPrivateClient`) also drives F-C2/F-C3/F-C7 below.

### Owner runtime confirmation (do NOT loop — wallet step)
After the fix, on Base: USDC→ETH should present the **FeeCollector approval**, and post-approval the sim
should pass and the swap settle. Needs a funded Base wallet + signature — owner post-merge step.

---

## Findings table (Phase 1 + Phase 2 sweep)

| ID | Area | Severity | file:line | One-line | Effort |
|----|------|----------|-----------|----------|--------|
| **P1** | ERC20-input swap | **H 🔴** | rpc.ts:53; useSwap.ts:492,533; useApproval.ts:52,63,74 | Chain-unaware allowance/pre-flight reads → all Base ERC20-input swaps revert | M |
| C2 | Receipt poll | **H** | useSwap.ts:1004 | Fallback receipt poller `getPrivateClient()`=mainnet → Base swap "hangs" to 2-min timeout | S |
| C3 | Receipt poll (split) | **H** | useSplitSwap.ts:81 | Split-leg receipt poll on mainnet → false "Confirmation timeout"/partial | S |
| O1 | Oracle coverage | **H** | chains/chainlink-feeds.ts:19-25 | Base feed map has only WETH; USDC/DAI/cbETH/USDbC missing → "No oracle" + >$10k unverified block | S |
| R1 | Review modal | **H** | useSplitSwap.ts:291,310,319 | Split-swap legs sign via `sendTransactionAsync` with **no** Review modal | M |
| R2 | Review modal | **M** | SwapBox.tsx:1012-1017 | Modal shows live `displayAmountIn`/`meta.best`, not the frozen `pendingSwap` → after a fallback the displayed amounts can describe a different route than the signed calldata | S |
| R3 | Review modal | **M** | useSwap.ts:769; useLimitOrder.ts:239; useConditionalOrder.ts:296 | CoW + Limit/Conditional EIP-712 orders signed with no in-app clear-signing review | M |
| C5 | Explorer links | **M** | constants.ts:356; SwapBox.tsx:943,953; ToastProvider.tsx:182; ActiveApprovals.tsx:69 | Tx links hardcoded `etherscan.io` (+ "View on Etherscan" copy) → dead links on Base; no `explorerTxUrl(hash,chainId)` | M |
| C6 | Analytics | **M** | wallet-activity-tracker.ts:12 + call sites | Wallet-activity events not tagged with `chainId` → Base UX invisible in analytics (swaps Supabase table IS tagged) | S |
| C7 | CoW pre-flight | **M** | useSwap.ts:648,650,672 | CoW pre-flight balance/allowance via `getPrivateClient()`=mainnet; Base CoW exists → false "insufficient" | S |
| O3 | Oracle (orders) | **M** | order-engine/config.ts:82-101 | `getChainlinkFeeds(chainId)` ignores chainId → mainnet feeds for Base conditional orders (verify Base orders are even enabled) | M |
| S1 | Sources/breakers | **M** | circuit-breaker.ts:135-142; api.ts:122 | Circuit breaker + source-state keyed by name only (no chainId) → state leaks across chains; a mainnet failure disables the source on Base | M |
| S3 | Bebop | **M** | adapters/bebop.ts:62; env-validation.ts | `BEBOP_API_KEY` optional & unvalidated → Bebop silently absent on Base with no boot warning | S |
| C8 | Approval reads | **L** | useApproval.ts:52,63,74 | Allowance/nonce reads omit `chainId` (usually connected-chain, fragile in transition) — part of P1 fix | S |
| O2 | Oracle (portfolio) | **L** | api/portfolio/prices/route.ts:88 | DefiLlama portfolio prices hardcoded `'ethereum'` slug → Base holdings show no USD | S |
| S2 | Sources (curve) | **L** | chains/routers.ts:70 vs adapters/curve.ts:307,312 | Curve has a Base router in the whitelist but never quotes off-mainnet (orphan/misleading config) | S |
| S4 | Public API | **L** | api/v1/swap/route.ts:390,445; v1/quote:142 | `/v1/*` mainnet-pinned FeeCollector + chainId≠1 rejected — latent foot-gun if Base is exposed publicly later | M (defer) |
| C9 | Gas display | **I** | useEthGasCost.ts | "Est. gas ~$0.00" is LEGIT (sub-cent L2 gas rounding) — hook is chain-aware; cosmetic: show `<$0.01` | S |
| S5 | Base RPC | **I** | registry.ts:84-85 | If `NEXT_PUBLIC_BASE_RPC_URL` unset, on-chain Base quoting falls back to public `mainnet.base.org` (never to a mainnet RPC) — set a dedicated provider | S |
| + | 9O fallback re-entry | **I (clean)** | useSwap.ts:584-593 | **NOT a bug:** the fallback re-runs the full build → new `pendingSwap` → re-presents Review; no auto-send, no stale-confirmation reuse |
| + | DefiLlama swap guard | **I (clean)** | api/swap/route.ts:222-247 | Chain-aware (`getChainConfig(cid).slug`) — Base price guard resolves correctly |

---

## Parity table — swap lifecycle (Base vs mainnet)

| Step | Chain-aware on Base? | Base test coverage | Notes |
|------|----------------------|--------------------|-------|
| Quote (fetchMetaQuote/adapters) | ✅ chainId threaded; per-source Base URLs | partial | adapter-urls per chain; all 12 sources assessed (see Sources) |
| Compare / rank | ✅ | ✅ | source-agnostic |
| Oracle — Chainlink | ⚠️ **partial** | thin | Base map missing USDC/DAI/cbETH/USDbC (O1) |
| Oracle — DefiLlama guard | ✅ | partial | chain-aware slug (clean) |
| Approval gate (useApproval) | ⚠️ reads not chainId-pinned | thin | P1 / C8 |
| Allowance pre-flight (useSwap) | ❌ **mainnet-pinned** | none | P1 / C4 |
| Review modal | ⚠️ single-swap shows live amounts; **split has none** | thin | R1 / R2 |
| Simulation (buildSimulationTx) | ✅ getPublicClientForChain | ✅ (9O tests) | correct |
| Send (wagmi sendTransaction) | ✅ connected chain | partial | |
| Receipt poll (fallback + split) | ❌ **mainnet-pinned** | none | C2 / C3 |
| History / explorer links | ❌ etherscan hardcoded | none | C5 |
| Analytics (wallet-activity) | ⚠️ untagged by chain (swaps table OK) | none | C6 |

**Thinnest Base test coverage:** the ERC20-input allowance/approval path, per-chain receipt polling, the
Review modal on Base, split-swap signing, and Chainlink feed coverage — all should get Base-specific tests
with the fixes.

---

## Sources on Base (8453)

Quoting is **not** gated per-chain — every adapter runs and self-decides via its Base URL. All 9
fee-routed sources have a Base router in `ROUTER_WHITELIST_BY_CHAIN[8453]` (`src/lib/chains/routers.ts:48-73`);
fee-incompatible set = `['0x','cowswap','bebop']` (`activation.ts:45`, correct). Quote+execute on Base:
1inch, 0x, velora, odos, kyberswap, cowswap, openocean, sushiswap, balancer, uniswapv3. **curve** never
quotes off-mainnet (orphan Base router — S2). **bebop** quotes only if `BEBOP_API_KEY` is set (S3).
Breakers default CLOSED; sushiswap/cowswap are **not** disabled (`DISABLED_SOURCES = {}`), but breaker
state is **global across chains** (S1).

---

## Prioritized fix plan (RICE-ready — Architect triages into sprints)

**P0 — URGENT (ship first, unblocks live Base):**
1. **P1 — chain-pin the allowance/pre-flight reads** (`getPrivateClient`→chain-aware, or swap to
   `getPublicClientForChain(chainId)` in useSwap:492/533; pin `chainId` in useApproval). Fixes all Base
   ERC20-input swaps. Folds in **C2/C3/C7/C8** (same root). Effort M.

**P1 — high-value, low effort:**
2. **O1 — add Base Chainlink feeds** (USDC/DAI/cbETH(/USDbC)). ⚠️ *Verify each proxy on data.chain.link
   before adding* (project rule "NEVER trust single-source price data"; the code comment at
   `chainlink-feeds.ts:22-24` mandates it). Restores oracle ✓ and unblocks the >$10k unverified gate. Effort S.
3. **R1 — split-swap Review modal**; **R2 — drive the single-swap modal's Send/Receive from `pendingSwap`,
   not live quote state.** Effort M / S.
4. **C5 — chain-aware tx explorer links** (`explorerTxUrl(hash, chainId)`; a token equivalent already
   exists at `chains/tokens.ts`). Effort M.

**P2 — correctness/observability:**
5. C6 analytics chainId; S1 per-chain breakers; S3 Bebop env warning; C7 CoW pre-flight (folds into P1);
   R3 CoW/order clear-signing review; O2 portfolio slug; O3 order-engine feeds (if Base orders enabled);
   S2 curve orphan. Effort S–M each.

**P3 — defer / informational:**
6. S4 public `/v1` multi-chain (deferred until Base is exposed publicly); S5 dedicated Base RPC;
   C9 gas `<$0.01` cosmetic.

---

## Notes
- Read-only: no code edited, no state-mutating contract calls. On-chain facts verified by logic
  (ETH-input working ⇒ Base FeeCollector deployed + routers whitelisted) and code reads; the Base
  FeeCollector address (a `NEXT_PUBLIC_BASE_FEE_COLLECTOR` env) was not dumped (a broad prod-env pull was
  correctly blocked) — its on-chain router whitelist can be spot-checked by the owner if desired, but the
  ETH-input-works invariant already rules out a whitelist gap as the Phase-1 cause.
- Candidate Base Chainlink feed addresses exist (gathered during the sweep) but are intentionally NOT
  asserted here as ground truth — verify on data.chain.link before committing (O1).
- Human/wallet runtime confirmations (actual Base swap settlement) are owner-side and were not attempted.
