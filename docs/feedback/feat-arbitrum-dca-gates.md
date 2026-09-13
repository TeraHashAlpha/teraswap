# Feedback — feat/arbitrum-dca-gates

**Merge precondition (one line):** NOT mergeable until (1) the two queued `setTokenUsdFeed` actions on the Arbitrum V3 execute (readyAt 2026-09-13T14:51:45Z WETH / 14:52:54Z USDC, verified on-chain), (2) the owner attests the `teraswap-keeper-arbitrum` process is running (repo cannot prove it), and (3) the **third gate below** is opened in a follow-up — without it this PR makes nothing reachable.

### Assumption that turned out wrong — DCA on Arbitrum is dark by THREE code decisions, not two
`useOrderEngine.confirmOrder` (:757) and `confirmCancel` (:1073) refuse when `getOrderExecutor(chainId)` — the **v2** executor — is null, and the CancelOrder EIP-712 domain is `getOrderExecutorDomain` (v2) on the client (:1109/:1184) **and** in `api/orders/[id]/route.ts:112`. Base has a v2 executor so none of it ever fired; Arbitrum is v3-only (`ORDER_EXECUTOR_BY_CHAIN` has no 42161 entry). Found by the positive panel test: after the approval, the flow stops with "Conditional orders are not yet available on chain 42161." Deliberately NOT patched here — fixing `confirmOrder` alone would mint orders the UI can neither sign a cancel for nor cancel on-chain (the INC-2026-08-26-001 class). Pinned as current truth in `DCAPanel.arbitrum-gates.test.tsx` › "THE THIRD GATE (not opened here)…". Follow-up: version-aware guards via `resolveSigningExecutor`, a v3 CancelOrder domain on both sides, and a nonce source for v3-only chains (today the nonce comes from the v2 `nonces()` read — disabled on Arbitrum ⇒ 0; harmless on-chain for DCA, which never consumes the bitmap, but not a design).

### Task 1 — INC-2026-08-26-001 re-enable criteria (config.ts:99-114 codifies §9.1; §11.7/§12.3 add the rest)
| Criterion | Status | Evidence |
|---|---|---|
| 1. V3 deployed + verified, row in DEPLOYMENTS.md | **MET** | `docs/DEPLOYMENTS.md:17`; re-read 2026-09-11 on arb1 + publicnode: 18,247 B, keccak `0x363faecf…e0426d` (= INC §11.2), `ORDER_TYPEHASH()` == Base V3 (positive), `TIMELOCK_DELAY()` reverts, `ORDER_TYPEHASH()` on FeeCollector sibling `0xeFC3…f130` reverts (negatives), `bootstrapped()` true, `paused()` false. Explorer source-verification not checkable via RPC — byte-proof is the DEPLOYED-SOURCES standard. |
| 2. A keeper instance polls 42161 (§6, §11.7.9, §12.3.11) | **MET (repo) / UNVERIFIED (host)** | PR #494 (`fb6eaca`): `teraswap-keeper-arbitrum` pm2 app, `EC2-EXECUTOR-HOST.md` §Second process, boot gate `whitelistedExecutors(signer)`; on-chain `whitelistedExecutors(0x5f47…39ab)` = **true** on both RPCs. DEPLOYMENTS.md keeper registry still says "polling today? No" (written 2026-08-27). Owner attests at merge. |
| 3. Env slot + Production var (§2 containment) | slot MET / var = go-live ops step | `config.ts:74`; var re-scoped to Development per §2; setting it for Production is the last step by design (env can disable, never enable — pinned in `orders-v3-eligibility-integration` + `page.arbitrum-dark`). |
| 4. Router whitelist decision (§11.7.7, ADR-020 (d)/B1) | **MET for the signing map** | Order map = on-chain ∩ keeper builder = the audited two (Task 3); surplus stays on-chain, unreachable. Pruning via timelock remains an owner decision. |
| 5. Oracle floor feeds executed (§11.7.9, B2) | **NOT MET — becomes MET at execute** | `tokenUsdFeeds(WETH/USDC)` = zero struct on both RPCs; `TimelockQueued` ×2 at 2026-09-11T14:51:45Z/14:52:54Z, actionHash == `setTokenUsdFeed(WETH, 0x639F…a612, 18, 3596)` / `(USDC, 0x5083…4aD3, 6, 596)`. Until then #484 refuses every Arbitrum DCA (pinned). |
| 6. RPC chain identity (§12.1) / browser Chainlink path (§9.3) | **MET** | PR #426 + `f241636` (INC §12.3.12). |
| 7. Dark test repaired (§9.2) | **MET** | `page.arbitrum-dark.test.tsx` now names every var per case; flipped deliberately here (see below). |

### Task 3 — `ROUTERS_BY_CHAIN[42161]` (full table in ADR-020 §Amendment)
`augustusV6` `0x6A00…1068` (velora) and `uniswapV3` `0x68b3…fc45` (SwapRouter02): `whitelistedRouters` **true/true** on arb1 + publicnode, code 24,562 / 24,497 B, keeper `ROUTER_SOURCE` velora / uniswapv3, **served in production on 42161** (FeeCollector `SwapWithFee` ×1 / ×2, event-derived). Negative control WETH false/false; curve false/false + no code. **Reported, not added:** 1inch (whitelisted, keeper maps it, `/api/swap` serveability on 42161 unrecorded — Base's exact exclusion), kyberswap (whitelisted + served, but no keeper source), 0x/cowswap/sushiswap/bebop (no keeper source), odos/balancer/openocean (disabled).

### Task 2 — panel-state tests (`src/components/DCAPanel.arbitrum-gates.test.tsx`, real config, env slot = address extracted from DEPLOYMENTS.md, sentinel 42)
- "registry EMPTY (the on-chain state until the queued feeds execute) ⇒ the no-registered-price-source block, no approval, no signature"
- "registered=true for BOTH legs (the post-execute state) ⇒ the #484 guard PASSES: no block, the review modal mounts and the real Approve sends the approval to the DEPLOYMENTS.md executor"
Arbitrum Limit pin: `router-map-fail-closed.test.ts` › "flag ON + Arbitrum v3 env SET ⇒ … isLimitLive(42161) is false; Base … true", and `orders-p1b.test.ts` › "a non-DCA v3 order cannot be created off the Limit/TP chain" (API).

### Concern — server-side Limit/TP gap, closed here (`api/orders/route.ts` after the SL gate)
`isLimitLive` is client-only; the eligibility list is shared with DCA, so widening it opened non-DCA v3 creation on 42161 to a hand-crafted POST (the keeper would then fill against an unconfigured `oracleConfigs` floor — `_checkPriceCondition` falls back to `MAX_STALENESS`). Added `isV3Order && !DCA && chainId !== LIMIT_TP_CHAIN_ID ⇒ 400`; Base byte-identical. `orders-p1b.test.ts` fixture moved from "v3 simulated on chain 1" to Base (8453) because of it — 13 cases re-pinned, assertions unchanged.

### Task 4 — surviving `8453` literals in the DCA path (code, not comments)
`dca-launch.ts:19 BASE_CHAIN_ID` (legacy export, not consulted by `isDcaLive`) · `dca-launch.ts:32 DCA_CHAINS=[8453, 42161]` ✓ · `config.ts:18/69/120/307/315`, `registry.ts:58/173`, `routers.ts:57/136`, `clients.ts:29` (chain-keyed table keys, 42161 rows present where relevant) · `limit-launch.ts:25 LIMIT_TP_CHAIN_ID` (the deliberate Limit pin, untouched, now mirrored server-side). Confirmed: `api/orders/route.ts:299-305` fail-closes on a null executor (pinned by the env-UNSET integration case); `isChainActive(42161)` = `NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR || null` (`registry.ts:118`, `activation.ts:16`).

### Pinning tests changed deliberately (each inverted on purpose, none deleted)
`config.test.ts` allowlist `[8453]→[8453,42161]`, "env does NOT wire 42161"→"env wires 42161 because the list allows it", unwired-chain example 42161→10 · `router-map-fail-closed.test.ts` 42161 UNKNOWN→KNOWN + snapshots · `dca-launch.arbitrum-activation.test.ts` all-set ⇒ true + per-var falsification · `page.arbitrum-dark.test.tsx` Production shape ⇒ opens, v3-unset ⇒ teaser · `orders-v3-eligibility-integration.test.ts` split into env-set / env-unset / mainnet · `DCAPanel.router-fail-closed`, `LimitOrderPanel`, `ConditionalOrderPanel` no-set fixture 42161→10 (+ Arbitrum positive control in the DCA one).

### Edge case — `route-source.ts` has no row for `0x68b3…fc45` (badge falls back to "Aggregated"; audit I-3, cosmetic, not changed).

## Feedback — the third gate (8487d2b)

**Merge precondition (3) above is MET by this commit.** (1) and (2) are unchanged: the queued feeds execute 2026-09-13T14:53Z; the owner attests the `teraswap-keeper-arbitrum` process at merge.

### Assumption that turned out wrong — "add v3 support" was the wrong framing; Base DCA never touches v2 as a contract
| Base DCA step | v2 / v3 | file:line |
|---|---|---|
| Approve spender (pre-sign) | v3 | `useOrderApproval.ts:30-41` → `resolveSigningExecutor` (`config.ts:171`) |
| Struct build (`signV3`) | v3 | `useOrderEngine.ts:710` |
| **confirmOrder precondition** | **v2 — vestigial** | `useOrderEngine.ts:757` (pre-commit) |
| EIP-712 signing domain | v3, version "3" | `useOrderEngine.ts:824` → `config.ts:180-193` |
| Order nonce source | v2 `nonces()` read (a counter v3 never advances) | `useOrderEngine.ts:479-484, 568-576` |
| API create: executor + domain | v3 | `api/orders/route.ts:299, 308` |
| Keeper fill target | v3 (`order_data.maxSlippageBps`) | `executor.js:1427-1441` `resolveExecutorRouting` |
| cancelOrder Phase A guard | v3 | `useOrderEngine.ts:982-989` |
| **confirmCancel precondition** | **v2 — vestigial** | `useOrderEngine.ts:1073` (pre-commit) |
| On-chain `cancelOrder` target + ABI | v3 | `useOrderEngine.ts:1091-1098` → `V3.sol:636` (owner-only, `getOrderHash` :1149, same contract as the :449 verifier) |
| **CancelOrder ownership proof — client** | **v2 domain** (off-chain namespace) | `useOrderEngine.ts:1109, 1184` (pre-commit) |
| **CancelOrder ownership proof — API** | **v2 domain** | `api/orders/[id]/route.ts:112` (pre-commit) |

So the rule implemented is **"nothing requires v2 any more"**: an order's executor (guard, signing domain, cancel target) is resolved from the order's own version via `resolveSigningExecutor`; the chain-level ownership-proof domain is `getCancelOrderDomain` = v2's where v2 exists (Mainnet/Base byte-identical), else v3's (Arbitrum), else throw — one helper, both sides. Domain identity between signing and cancel on 42161 is pinned by an equal `hashTypedData` digest over the signed message and the cancelled struct under the same `{name, "3", 42161, <Arbitrum V3>}`.

### Concern — cross-chain cancel is reachable, and this commit widens where (pre-existing, NOT fixed here)
`orders` state is per-wallet, not per-chain (`fetchUserOrders(address)`; `AutonomousOrder.chainId` is display-only, `useOrderEngine.ts:294`). Single cancel freezes with the ACTIVE `chainId` and never compares it to `order.chainId` (`:1017`); `cancelAllOrders` walks every active order regardless of chain (`:1027-1029`); `OrderDashboard.tsx` lists all of them. A Base order cancelled while connected to Arbitrum therefore sends its struct to the Arbitrum V3 (`msg.sender == owner` passes, an irrelevant hash is marked), proves under the Arbitrum domain, and the Supabase row flips to `cancelled` while the Base order stays valid on-chain — DB/chain divergence, no fund loss (only the whitelisted keeper executes, and it reads `status`). This already held for Base↔mainnet v2; the v2 precondition happened to block it on Arbitrum, and this commit removes that accident. Not changed: a new gate (`p.order.chainId !== p.chainId ⇒ refuse` in `confirmCancel`, plus a chain filter in `cancelAllOrders`) alters Base behaviour and was out of scope. Recommend a follow-up before Arbitrum go-live; RICE-wise it is small (two guards + two pins).

### Edge case — nonce source on a v3-only chain (unchanged, reported)
With v2 null the `nonces()` read is disabled (`address: undefined, enabled: false` — pinned) so `currentNonce` is `undefined ⇒ 0n` and the session-local counter takes over (`:568-576`). That is the SAME sequence a Base wallet with no v2 history sees (v2 `nonces()` reads 0 there, and v3 orders never advance it). DCA never consumes the bitmap (`V3.sol:377`), and the nonce only disambiguates `getOrderHash`, which `expiry` (per-second) already does across sessions. A proper v3 nonce source is a design decision, not this gate.

### Test gap closed — the four "v3 on chain N" fixtures simulated the domain but not the resolver
`useOrderEngine.v3`, `DCAPanel.v3`, `DCAPanel.chain-availability`, `DCAPanel.oracle-fail-closed` mock `getOrderExecutorV3` + `getOrderExecutorV3Domain` on the barrel; the guard now goes through `resolveSigningExecutor`, which (like the domain fn) calls config's own lookup, so those v3 orders were refused before signing until the resolver was simulated the same way (6 lines each, same shape as `config.ts:171`). The real-config suites needed nothing. Tests added: `useOrderEngine.v3-only-chain.test.ts` (13), `orders-cancel.arbitrum-v3-only.test.ts` (6); flipped: `DCAPanel.arbitrum-gates` › "THE THIRD GATE (opened)…"; re-pinned: `orders-cancel.test.ts` › "a chain with NEITHER executor…". Mutation-checked in both directions (restoring the v2 precondition / v2 proof domain fails exactly the Arbitrum pins; Base and mainnet pins hold).

## Feedback — cross-chain cancel guard (this commit)

**The rule, in two sentences:** Cancel (on-chain call, ownership-proof domain, API PATCH) now resolves its executor and domain from `order.chainId`/`order.chain_id`, never the wallet's active chain; a mismatch requests a wagmi chain switch and, on failure or a stale post-switch closure, refuses by name instead of ever falling through to the active chain (`useOrderEngine.ts` `cancelOrder`/`confirmCancel`, `api/orders/[id]/route.ts` PATCH). Server-side the atomic UPDATE now also gates on `.eq('chain_id', chainId)`, so a client that declares the wrong chain (bug or otherwise) can never flip a row it didn't recover an ownership proof for under that row's real chain — the probe fallback reports it as a distinct 400, not a 409.

**`cancelAllOrders` choice:** cancel only the ACTIVE chain's group; list every other-chain order as `skippedOrders` (surfaced in the review modal). Chosen over a switch-per-group sequence because a chain switch already clears the whole frozen `pendingCancel` (the pre-existing 9R defense reset effect) — a mid-sequence switch would destroy the very plan carrying the remaining groups, so there is no safe way to run multiple chains through one confirm with this architecture.

**Nonce on 42161:** unchanged from the prior report, now with a dedicated test. v2's `nonces()` read stays disabled (no v3-only-chain executor to read from) so `currentNonce` is `0n` and the session-local high-water mark (`localNonceRef`) issues 0n, 1n, … — the same sequence a fresh Base wallet sees. V3's `UnorderedNonceInvalidation`/bitmap is NOT read here; it isn't needed because the contract skips the bitmap check entirely for `OrderType.DCA`, gating on `dcaExecutions`/`cancelledOrders` instead — by contract design, not omission.

**Tests:** `useOrderEngine.v3-only-chain.test.ts` — `'nonce source on 42161…'`, and a new `describe('[fix/cross-chain-order-cancel] cancel follows the ORDER chain, never the wallet chain')` (4 cases: refused switch, successful-switch-requires-second-click, Base-on-Base pinned unchanged, mixed-chain `cancelAllOrders`). `orders-cancel.test.ts` — 2 new cases (wrong-chain proof → 400 never cancels; matching chain → unaffected). `OrderDashboard.test.tsx` / new UI cases for the chain badge + mismatch label.

**Base-only user:** nothing visible changes — same chain on every order, `chainMismatch` is always false, badge renders quietly, button text and behavior are byte-identical to before.
