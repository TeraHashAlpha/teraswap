# SEC-2 · Wave 4 — Chain-awareness sweep (the #1 historical defect) — entry packet

> **Campaign:** 2026-07-01. **Sprint:** SEC-2 (parallel after W0). **Runner:** Auditor (read-only). **Grounded on:**
> `W0-recon.md` §1/§2. **Source of truth:** T-SAF v1 §5-W4 + §6 INV-5/12 + §9 G5. **Binding:** T-SAF §1 + CLAUDE.md
> #1/#2/#3/#12. **Priority: HIGH** — W0 surfaced the exact landmine this wave owns.

## Why HIGH this campaign
W0 proved on-chain: **mainnet OrderExecutor whitelists AugustusV5=true / V6=false / 1inchV6=true**, while **Base
whitelists Augustus V6**. So router/feed/spender/token selection **must be chain-aware and match each chain's
on-chain reality** — a name-based "V5→V6" change would break mainnet orders. This is the #1 historical defect class
(chain-pinned residue, gate silent-skip, A7 insider/logic drift).

## In-scope (W0-confirmed: 9 chains-registry libs + every chain-scoped read)
`src/lib/chains/{registry,clients,adapter-urls,routers,activation,tokens,uniswap-v3,index,types}.ts` + **every file
that reads a chain-scoped constant** (RPC, etherscan, token/feed/spender, chainId, router) on any Base-reachable path.

## Attacker goal (§5-W4, §9-G5)
Get a Base path to use a **mainnet** client/RPC/feed/spender/token/router → mispriced or misrouted funds; exploit a
`"1" !== 1` chainId coercion at a JSON boundary; build a swap for a chain with no live FeeCollector (G5.4).

## Must-verify invariants (INV-5, INV-12; negative-path first)
1. **No mainnet assumption on any Base-reachable path:** no hard-coded chainId 1, mainnet RPC/client, mainnet
   etherscan, mainnet token/feed/spender/router where the path also runs on Base.
2. **Router selection is chain-correct (the landmine):** `getDefaultRouter`/`getWhitelistedRouters`/`order.router`
   commit ONLY a router whitelisted on THAT chain per W0's on-chain snapshot (Base→Augustus V6; mainnet→V5) — trace
   both chains, prove no cross-chain leak.
3. **Client/RPC chain-aware:** `getRpcUrl`/`getPublicClientForChain` (and every caller) resolve per chainId,
   everywhere — no default-to-mainnet fallback on a Base path.
4. **`"1" !== 1` coercion:** every JSON boundary that reads a chainId coerces numeric vs string consistently
   (the historical class); a string `"8453"` must never fall through to a numeric-1 default.
5. **Activation gate:** a swap/order can't be built for a chain without a live FeeCollector (G5.4).
6. **Resolve the Base OrderExecutor wiring (open from W1-I-03).** W1's literal-grep found no `0x135B…2598` in
   source, yet a 16-day memory says PR #192 wired `ORDER_EXECUTOR_BY_CHAIN[8453]=0x135B` and **DCA is LIVE on Base**
   (so the launch gate's `getOrderExecutor(8453) !== null` MUST hold). **Determine definitively HOW the Base
   OrderExecutor is wired** — env-driven (`NEXT_PUBLIC_*`) vs a computed constant vs genuinely un-wired — and confirm
   `getOrderExecutor(8453)` resolves to the on-chain-verified `0x135B…2598`. If env-driven, name the var + confirm it
   is set (Vercel) and chain-scoped. This is the ground-truth W8 (keeper) also needs. Do NOT assume from memory.
7. **Mainnet byte-identical (INV-12):** non-frozen, feature-off paths unchanged on mainnet — test against W0's
   recorded mainnet bytecode-hash baseline.

## Method & tools (§7.5, W0 env caveats: `cast` absent → viem/node)
Grep-and-trace every chain-scoped constant across the tree; **cross-domain diff** ("fixed here, missed there" — a
fix applied on one path but not its twin); numeric-chainId coercion audit at every JSON boundary; on-chain
re-confirm the per-chain router whitelist (reuse W0 snapshot). `semgrep` taint where a chainId flows to an
RPC/feed/router sink.

## Negative-path battery (each must be refused/correct)
Base request → mainnet RPC/client · Base order committing mainnet-only Augustus V6-on-mainnet (or V5-on-Base) ·
`chainId:"1"` vs `1` mismatch · swap built for a chain without a live FeeCollector.

## Exit criteria
Zero chain-pinned residue on any Base-reachable path; router/feed/spender/token selection chain-aware and matching
the on-chain whitelist per chain; numeric-coercion safe; activation-gated; mainnet byte-identical test-pinned.
Findings → §4 evidence bundle → remediation prompts (RICE).

---

### `/goal` paste for the Auditor (≤4000)
```
Run T-SAF Wave 4 (Chain-awareness sweep) per Audits/Campaign/2026-07-01/
W4-chain-awareness.md + TERASWAP-AUDIT-FRAMEWORK.md §5-W4. READ-ONLY, no code
edits. Ground on W0-recon.md §1/§2 (do NOT re-derive addresses from memory).

Motivating fact (W0, on-chain): mainnet OrderExecutor whitelists
AugustusV5=true/V6=false/1inchV6=true; Base whitelists Augustus V6. Router/feed/
spender/token selection MUST be chain-aware and match each chain's on-chain
reality — a name-based V5->V6 change would break mainnet.

Scope: src/lib/chains/{registry,clients,adapter-urls,routers,activation,tokens,
uniswap-v3,index,types}.ts + EVERY file reading a chain-scoped constant (RPC,
etherscan, token/feed/spender, chainId, router) on a Base-reachable path.

Prove (negative-path FIRST):
1. No mainnet assumption on any Base-reachable path (no hard chainId 1, mainnet
   RPC/client/etherscan/token/feed/spender/router where it also runs on Base).
2. Router selection commits ONLY a router whitelisted on THAT chain (Base V6,
   mainnet V5) per W0 — trace both chains, no cross-chain leak.
3. getRpcUrl/getPublicClientForChain (+ every caller) resolve per chainId, no
   default-to-mainnet on a Base path.
4. "1" !== 1 coercion audited at every JSON boundary; "8453" never falls to a
   numeric-1 default.
5. Activation gate blocks a swap/order for a chain with no live FeeCollector.
6. RESOLVE the Base OrderExecutor wiring (open from W1-I-03): W1's literal-grep
   found no 0x135B in source, but DCA is LIVE on Base so getOrderExecutor(8453)
   must be non-null. Determine HOW it's wired — env-driven (NEXT_PUBLIC_*) vs
   constant vs un-wired — and confirm getOrderExecutor(8453) == the
   on-chain-verified 0x135B…2598 (name the env var if any). Do NOT assume from
   memory.
7. Mainnet byte-identical (INV-12) vs W0's recorded bytecode-hash baseline.

Tools: grep-and-trace chain-scoped constants; cross-domain diff (fixed-here/
missed-there); numeric-coercion audit; semgrep taint (chainId -> RPC/feed/router
sink); on-chain re-confirm per-chain router whitelist via viem/node (cast
absent; reuse W0 snapshot).

Deliver into Audits/Campaign/2026-07-01/W4-chain-awareness.md (report section):
checks-run table, findings (Sev·file:line·disposition + §4 evidence bundle),
negative-path results, coverage fraction of the chains slice, verdict,
remediation-prompt list. SSH-signed commit left for owner if no key in sandbox.
```

---

# RE-BASELINE NOTE + WAVE 4 — REPORT (executed 2026-07-01, Auditor, read-only)

## RE-BASELINE (per W3-H-01)
- **Audited SHA (production):** `origin/main` = **`cb0748de466c50c1749dfea53ad5c0424f6c0bf6`** (HEAD of
  main; Vercel auto-deploys main — no separate deploy SHA pinned in `DEPLOYMENTS.md`).
- Working-tree HEAD `df00d35` (`docs/inc-2026-06-09`) is 261 behind / 0 ahead → **ignored for source
  reads.** All W4 reads + the W1/W2 re-confirmations below are from `git show origin/main:<path>`
  (read-only; the mount can't `checkout`, but `git show origin/main` is exact). Future waves ground on
  `origin/main`.

## W1/W2 re-confirmation deltas (on `origin/main`)
| Prior finding | On `main` | New status |
|---------------|-----------|------------|
| **W1-I-03** — "no Base OrderExecutor wired" | `ORDER_EXECUTOR_BY_CHAIN[8453]=0x135B339902Ea4E0fB4CF059961dc8856bA1D2598` (`order-engine/config.ts:18`); `getOrderExecutor`/`getOrderExecutorDomain` fail-closed (H-05). **On-chain-verified:** code 15475b, `admin=0x9A38…C73C`, `domainSeparator` present (own per-chain EIP-712), `whitelistedRouters` **V6=true / V5=false / 1inch=true**. | **REFUTED on main** — Base OrderExecutor deployed + wired + verified. |
| **W2-L-01** — minOut=0 on malformed `toAmount` | `useSwap.ts:457-461` + `useSplitSwap.ts:355-360` still pass `0n` when `safeBigInt(toAmount)===null`. | **STANDS on main** (real current LOW). |
| W1-I-02 / W1-I-04 / W1-L-01 / W2-M-01 | Deployed bytecode / stale `_flat` file — branch-independent. | Unchanged (corrected in W2). |
| W2 recipient wiring | `api/swap/route.ts:216-217` identical shape, chain-aware `Number(chainId)`, fail-closed. | **Confirmed on main.** |

## WAVE 4 — Verdict: APPROVED — 0C / 0H / 0M / 0L / 2I  (chain-awareness on `main`)
The #1 historical defect class (mainnet residue on a Base path) is **clean on production**. Router
selection is chain-correct and matches the on-chain per-chain whitelists; every client/RPC/feed/spender/
executor resolves per active chain; `chainId` is coerced numerically; mainnet is byte-identical to W0.

## Checks-run (against `origin/main`; negative-path first)
| # | Check | Result |
|---|-------|--------|
| 1 | No mainnet assumption on any Base path | ✅ FeeCollector addr `getChainConfig(chainId).contracts.feeCollector` (`useSwap.ts:321`, P225, throws if unavailable); `fetchApproveSpender` per-chain (P226); clients/feeds/gates per-chain (W3). No hardcoded mainnet on a Base path. |
| 2 | Router selection = a router whitelisted on THAT chain | ✅ **On-chain-decisive:** mainnet OE `0xeFC3` → Augustus **V5**=true/V6=false; Base OE `0x135B` → Augustus **V6**=true/V5=false (mirror). `routers.ts` 8453 block commits Base-appropriate addresses. A name-based "V5→V6 everywhere" would break mainnet — the split is correct. |
| 3 | `getPublicClientForChain` chain-aware | ✅ `clients.ts` `VIEM_CHAINS={1:mainnet,8453:base}`; mainnet→`getPrivateClient` (IP-hiding), else per-chain cached; `getChainConfig` throws on unsupported. |
| 4 | `"1" !== 1` coercion at JSON boundaries | ✅ `Number(chainId)` consistently (`swap:101/125/126`, `quote:256`); `chainId != null` guards; no string/number mismatch reaches a gate. |
| 5 | Activation gate | ✅ `isChainActive` (feeCollector non-null) gates Base swaps; `getOrderExecutorDomain` throws if no executor (fail-closed, H-05). |
| 6 | Base OrderExecutor wiring resolves | ✅ `getOrderExecutor(8453)=0x135B…2598` (literal), `getOrderExecutor(1)`=env-or-`0xeFC3`; both on-chain-verified; null→fail-closed. |
| 7 | Mainnet byte-identical vs W0 | ✅ `getOrderExecutor(1)=0xeFC3`, FeeCollector `0x47f2`, feeds unchanged; Base wiring purely additive. |

## Findings
| ID | Sev | file:line | Disposition | Evidence |
|----|-----|-----------|-------------|----------|
| W4-I-01 | INFO | `src/lib/api.ts:540` (comment) | REPORT | Stale comment: FeeCollector/spender "still mainnet-pinned — must be per-chain before Base." Code is **already** chain-aware (P225 `useSwap.ts:321`, P226 `fetchApproveSpender`). Misleading; fix the comment. |
| W4-I-02 | INFO | `routers.ts` `ROUTER_WHITELIST_BY_CHAIN` + `api.ts` `ROUTER_WHITELIST` + on-chain `whitelistedRouters` | REPORT | Three router allowlists for different paths (frontend swap / client spender set / on-chain order-engine). Chain-scoped + correct today, but a drift risk. Recommend a single per-chain source + a parity test (frontend set ⊆ on-chain executor whitelist per chain). |

## Negative-path battery (each refused)
Augustus V6 on a mainnet order → not in mainnet OE whitelist (V6=false) → `RouterNotWhitelisted` ✅ ·
Augustus V5 on a Base order → not in Base OE whitelist (V5=false) → revert ✅ · swap on a chain with no
FeeCollector → `getChainConfig().contracts.feeCollector` null → throw ✅ · order on a chain with no executor
→ `getOrderExecutorDomain` throws ✅ · `chainId="1"` → `Number()`→1 (no coercion bug) ✅.

## Coverage (chains slice)
- Source-reviewed on `main`: `chains/{registry,clients,adapter-urls,routers,activation,tokens}.ts`,
  `order-engine/config.ts`, `useSwap`/`fetchApproveSpender`.
- On-chain: **Base OrderExecutor `0x135B` fully verified** + reused W0 mainnet snapshot; chain-specific
  whitelist invariant proven on BOTH chains; EIP-712 domain divergence proven (mainnet `0x335a…` vs Base
  `0x020a…`).
- Not run: `forge` cross-chain-replay fork-test (deferred to CI).

## Remediation prompts
1. **W4-I-01 — fix the stale `api.ts:540` comment** (FeeCollector/spender are now chain-aware, P225/P226). Docs-only.
2. **W4-I-02 — single per-chain router-allowlist source + parity test** (frontend swap whitelist ⊆ on-chain OE `whitelistedRouters` per chain). Test/config; no gate change.

## Boundaries
Read-only on `origin/main`; no checkout/writes/sims/deploys; `forge` deferred to CI. Campaign
re-baselined — **W5+ ground on `origin/main` @ `cb0748d`.**
