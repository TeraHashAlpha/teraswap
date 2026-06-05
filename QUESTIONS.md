# TeraSwap — Comprehensive Audit

**Date:** 2026-05-28
**Model:** Claude Opus 4.8 (1M context)
**Scope:** Full codebase review — smart-contract integration, API routes, frontend, hooks/state, infrastructure, test coverage
**Baseline:** `npm run typecheck` ✅ exit 0 · `npm run lint` ✅ exit 0 (146 warnings, 0 errors) · `npm run test` ✅ **1173 tests passing** (70 files)
**Method:** 5 parallel audit passes (contract-integration, API, frontend, hooks, infra/tests). Every finding below was verified against actual source; the four highest-severity items were independently re-verified by the lead auditor.

> **Headline:** No new **Critical** findings. The prior internal/external critical and high findings (timing-safe secrets, rate limiting, split-swap calldata validation, FeeCollector V2 `minimumOutput`) are **confirmed fixed**. The most actionable new issues are: (1) order cancellation has no ownership proof; (2) the approval spender is trusted from the server without a client allowlist; (3) the FE-01 `SecureStorage` utility ships but is wired to nothing, so order data is still plaintext/XOR; (4) the conditional-order (SL/TP/DCA) oracle path has no staleness check, contradicting Do-NOT rule #9.

---

## Critical (C) — Must fix before any further deployment

**None identified in this pass.**

The fund-flow defenses are strong and layered: router whitelist + function-selector whitelist + calldata-size bound + recipient validation + fee integrity, enforced on **both** the single (`useSwap.ts:283-353`) and split (`useSplitSwap.ts:181-209`) paths and re-enforced server-side (`api/swap/route.ts:141-168`). On-chain `minimumOutput` is derived from the **fresh** quote, not a stale one. The two issues with theoretical fund impact (FULL-H-02 spender trust, FULL-M-01 recipient over-permissiveness) require a server/MITM compromise and are bounded by exact-amount approvals and the contract-level `minimumOutput` revert — High/Medium, not Critical.

---

## High (H) — Fix within 1 sprint

### FULL-H-01 — Order cancellation has no signature / ownership proof (cross-user cancel)
- **File:** `src/app/api/orders/[id]/route.ts:46-93` (auth at 54-59, 64-69)
- **Description:** `PATCH /api/orders/:id` authorizes a cancel solely on a `wallet` value taken from the request **body** matching the order's `wallet` column. There is no EIP-712 signature, SIWE session, or any cryptographic proof the caller controls that wallet. Wallet addresses are public, and order IDs are obtainable via `GET /api/orders?wallet=` (also gated only by the public address). `POST /api/orders` correctly recovers the signer via `recoverTypedDataAddress` (`orders/route.ts:152-159`) — the PATCH path does not.
- **Impact:** Any party can cancel any victim's **active** Limit/SL/TP/DCA order by POSTing the victim's address + order id. An attacker can cancel a stop-loss immediately before an adverse price move, or grief continuously. No funds are stolen (status → `cancelled`), but it defeats the protective intent of conditional orders — a real financial-harm/DoS vector for a DEX.
- **Recommendation:** Require a signed "CancelOrder" EIP-712 message (or SIWE session) and recover the signer, comparing to the order owner — mirror the existing `POST` signature flow.
- **Known?:** **NEW / previously untracked.** Inline comments show a prior fix closed a TOCTOU race + a GET data-leak, but the missing-signature gap on PATCH was not caught.

### FULL-H-02 — Approval spender trusted from `/api/spender` without client-side allowlist
- **File:** `src/components/SwapBox.tsx:127-133` (sets `spender` from API response) → `src/hooks/useApproval.ts:158-205` (`approve()` → `writeExactApprove({ args: [spenderAddress, rawAmount] })`)
- **Description:** The ERC-20 allowance **spender** is taken verbatim from the `/api/spender` JSON response with no validation against a known set of router/spender addresses. The swap *target* router is whitelisted (`validateRouterAddress`) and the calldata recipient is checked, but the approval spender is not. `fetchApproveSpender` returns only trusted constants server-side, so a strict client allowlist is low-friction.
- **Impact:** If `/api/spender` (or its upstream) is compromised or MITM'd, the user signs `approve(attacker, amount)` to an arbitrary address; the attacker can `transferFrom` up to that amount. Bounded to the current swap input (approvals are now exact, not infinite — verified `useApproval.ts:191-195`), but that can still be the full trade size.
- **Recommendation:** Before `setSpender`, validate the returned address against the trusted set (router whitelist + `FEE_COLLECTOR_ADDRESS` + `PERMIT2_ADDRESS` + `COW_VAULT_RELAYER`). Reject + surface an error on mismatch.
- **Known?:** Prior **FE-LOW-01**, **STILL-OPEN**. Re-rated **High** — this is the literal allowance-grant target for a funds-handling app; the prior Low rating understated it.

### FULL-H-03 — FE-01 `SecureStorage` is dead code; sensitive order data still plaintext / reversible XOR
- **File:** `src/lib/secure-storage.ts` (entire 261-line module — `initSecureStorage`/`secureSet`/`secureGet`/`secureRemove`); zero importers (verified `grep` returns matches only inside the file itself). Consumers still on legacy storage: `src/hooks/useOrderEngine.ts:90-142` (XOR, static key `'TeraSwap_2026_v3'`), `src/hooks/useLimitOrder.ts:33-38` (plaintext JSON), `src/hooks/useConditionalOrder.ts:41-46` (plaintext JSON).
- **Description:** The AES-256-GCM utility from commit P199 (478c3e2) exists but is referenced **nowhere**. The FE-01 migration ("localStorage → Web Crypto V2") is therefore **0% wired in code**, despite being staged. Order persistence in `useOrderEngine` stores the EIP-712 **`signature`** + `orderHash` under repeating-key XOR (the code itself comments "Not cryptographic"); the limit/conditional hooks store full order objects in cleartext.
- **Impact:** Any XSS payload, malicious browser extension, or shared-machine user can read (and from `useOrderEngine`, trivially de-XOR) the wallet's full trading strategy and the order **signatures** that authorize on-chain execution. Replay is bounded by nonce/expiry, but it is sensitive data effectively at the pre-P199 protection level.
- **Recommendation:** Wire `initSecureStorage(address)` into the wallet-connect lifecycle and migrate `useOrderEngine`/`useLimitOrder`/`useConditionalOrder` to `secureSet`/`secureGet`. Add round-trip + tamper tests (see TEST-MED-01). Until wired, do not treat XOR as a security boundary.
- **Known?:** **FE-01** (CLAUDE.md tech debt). The *new* fact is that the remediation ships but is unused — the migration has not begun in consumer code.

### FULL-H-04 — Conditional-order (SL/TP/DCA) oracle read has no staleness / round / negative-answer check
- **File:** `src/lib/price-monitor.ts:64-76` (`getChainlinkPriceUSD` destructures only `answer`, ignores `updatedAt`, `roundId`, `answeredInRound`, `startedAt`)
- **Description:** The swap-path oracle (`src/lib/chainlink.ts:175-182`) correctly checks `answer<=0`, `answeredInRound < roundId`, and age > `CHAINLINK_MAX_STALENESS_SEC`. The **conditional-order** path (`price-monitor.ts`, used by SL/TP/DCA trigger evaluation) does none of these — it returns `Number(answer)/10**decimals` from a possibly stale or frozen round, with no negative-answer guard at the read. `isTriggerMet` rejects `currentPrice <= 0` (price-monitor.ts:134), so a negative is caught for *triggering*, but a **stale-but-positive** round is treated as live and the raw value is also stored on the order (`useConditionalOrder.ts:113`).
- **Impact:** A stale Chainlink round can fire (or fail to fire) a stop-loss/take-profit/DCA execution at the wrong price → mistimed execution of a real swap. Directly contradicts CLAUDE.md Do-NOT #9 ("Chainlink validation is mandatory for all swaps").
- **Recommendation:** Apply the same gates as `chainlink.ts`: require `answer > 0`, `updatedAt` within feed heartbeat, `answeredInRound >= roundId`; return `null` on failure so the CoW-quote fallback engages.
- **Known?:** **NEW.** Related in spirit to SC-HIGH-03 (no on-chain feed whitelist) but a distinct client-path gap.

---

## Medium (M) — Fix within 2-3 sprints

### FULL-M-01 — `isValidRecipient` accepts the FeeCollector address on *every* route, including direct (non-fee) routes
- **File:** `src/lib/calldata-recipient.ts:118-128`; used at `useSwap.ts:306`, `useSplitSwap.ts:198`, `api/swap/route.ts:157`
- **Description:** The recipient validator accepts the user wallet **or** `FEE_COLLECTOR_ADDRESS` **or** `FEE_COLLECTOR_V1_ADDRESS` for all swaps, regardless of whether the swap actually routes through the FeeCollector. On a direct route, calldata directing output to the FeeCollector would pass validation though the user never routed through it.
- **Impact:** A compromised aggregator response on a direct source could redirect output to the FeeCollector and pass the check; tokens would not reach the user directly. Mitigated in practice (direct sources mostly use msg.sender/implicit-recipient selectors; FeeCollector V2 has the `minimumOutput`/balance-delta guard), but the validator is over-permissive.
- **Recommendation:** Parameterize allowed recipients by route type — include `FEE_COLLECTOR_ADDRESS` only when `routeViaFeeCollector === true`; gate the V1 address to the specific historical/retry path it was added for.
- **Known?:** NEW.

### FULL-M-02 — Split-swap legs are broadcast with no pre-swap simulation
- **File:** `src/hooks/useSplitSwap.ts:211-279` (sends each leg via `sendTransactionAsync`); contrast `useSwap.ts:390-444` (single swap runs `eth_call` simulation first)
- **Description:** The single-swap path simulates via `eth_call` before prompting the wallet; the split path signs/broadcasts each leg blind.
- **Impact:** Legs that would revert (stale routing, FeeCollector `InsufficientOutput`) are still broadcast → wasted gas + mid-sequence `partial` failures. On-chain `minimumOutput` still protects funds.
- **Recommendation:** Run the same per-leg `eth_call` pre-simulation (at minimum for FeeCollector-routed legs).
- **Known?:** NEW (adjacent to the now-fixed FE-HIGH-01).

### FULL-M-03 — Chainlink historical (DCA) reads skip round-completeness and staleness checks
- **File:** `src/lib/chainlink.ts:247-261` (`fetchHistoricalPrice` / `getRoundData` destructures `[, answer, , updatedAt]` only)
- **Description:** The live reader checks round/staleness; the historical reader (used by DCA) does not check `answeredInRound`/`startedAt`, and neither path checks an aggregator min/max bound (a feed pinned at its circuit-breaker floor passes `answer>0`). Note rETH/wstETH feeds are TODO-disabled (`constants.ts:300-301`) so those tokens have no oracle deviation guard (fall through to oracle-unavailable, the safer default).
- **Impact:** DCA price decisions may use incomplete/stale historical rounds; tokens at feed extremes can pass the deviation guard with a manipulated price.
- **Recommendation:** Apply `answeredInRound >= roundId`, `startedAt > 0`, and staleness checks to `getRoundData`; document the LSD-feed gap.
- **Known?:** NEW.

### FULL-M-04 — No swap-state reset on account switch / disconnect; stale `pendingSwap` remains confirmable
- **File:** `src/hooks/useSwap.ts:193` (no `useEffect` keyed on `address`), `confirmSwap` (`useSwap.ts:874-920`, guards only `!address`); `src/components/SwapBox.tsx:101,399-410` (resets on token/amount change, not on account change)
- **Description:** On account switch/disconnect mid-flow, a frozen `pendingSwap` whose calldata/recipient was bound to account A is not invalidated; `confirmSwap` guards on `!address` falsy, not on the address having changed. Quote polling (`useQuote.ts:138-145`) and CoW status polls keep running across the switch.
- **Impact:** After an account switch, a stale `pendingSwap` built for account A can still be confirmed under account B → confusing/incorrect wallet prompt. The tx is signed by whichever wallet is active (no silent send to A), but the state inconsistency is real.
- **Recommendation:** `useEffect(() => reset(), [address])` in `useSwap`; clear/invalidate `pendingSwap` when `address` differs from the address captured at `execute` time; gate `confirmSwap` on address-equality.
- **Known?:** NEW.

### FULL-M-05 — `useConditionalOrder` poll captures a stale order snapshot outside the interval
- **File:** `src/hooks/useConditionalOrder.ts:126-174` (snapshot built at 128-130, closed over inside `setInterval` at 137; effect re-runs only on `submittedCount` change)
- **Description:** `pollOrders` reads `ordersRef.current` once at effect setup and closes over that array; the interval only re-creates when the *count* changes. If a different order transitions into `submitted` without changing the count (one fills as another submits), the interval keeps polling the old set and never picks up the new `orderUid`. `useLimitOrder.pollAll` (line 75) correctly re-reads the ref *inside* the callback.
- **Impact:** A submitted SL/TP order can be polled with a stale list and never have its fill/expiry status updated → appears stuck in `submitted` though it filled on CoW; `executedAt`/`txHash` never populate. No fund loss.
- **Recommendation:** Move the `ordersRef.current.filter(...)` read inside `pollOrders`; keep count only as the effect gate.
- **Known?:** NEW.

### FULL-M-06 — `createOrder` nonce can collide across orders signed in the same nonce window
- **File:** `src/hooks/useOrderEngine.ts:332-490` (nonce from `currentNonce` read at 338; no `refetch` forced after create; dep array line 490)
- **Description:** `nonce` is derived from the on-chain `nonces(user)` read, which only refreshes when wagmi re-reads. Two orders created in quick succession read the same `currentNonce` and produce two orders sharing a nonce (distinct hashes, same nonce). Depending on the executor's nonce/replay semantics, the second may be unexecutable.
- **Impact:** Second-and-later orders in the same window can be silently un-executable → "stuck" orders that never fill. Not fund loss (signature-based; funds stay in wallet).
- **Recommendation:** Track a local session nonce (`max(currentNonce, lastUsedLocal+1)`) or force `refetch` of `nonces` after each create and block concurrent creates. Verify against the OrderExecutor v2 nonce model (per CLAUDE.md rule 2, check AUDIT-TOTAL.md before fund-flow changes).
- **Known?:** NEW — flag for triage.

### FULL-M-07 — `useConditionalOrder.createOrder` does not validate trigger direction vs current price (immediate-fire footgun)
- **File:** `src/hooks/useConditionalOrder.ts:271-296`; trigger semantics `src/lib/price-monitor.ts:128-138`
- **Description:** `isTriggerMet` is correct at the boundary (inclusive `>=`/`<=`, rejects `<=0`). But `createOrder` accepts `triggerDirection`/`triggerPrice` with no sanity check that the trigger sits on the correct side of the current price. An order whose condition is already satisfied at creation fires on the first poll tick (~5s) instead of being rejected.
- **Impact:** A mis-configured (or maliciously suggested) trigger executes a real swap almost immediately rather than being flagged. No precision loss; the immediate-fire edge is the risk.
- **Recommendation:** At creation, validate trigger vs current price for the chosen direction; warn/reject already-satisfied configs; optionally require ≥1 confirmation cycle.
- **Known?:** NEW.

### FULL-M-08 — Order signatures persisted via reversible XOR, mislabeled as a security control
- **File:** `src/hooks/useOrderEngine.ts:90-114,138` (`obfuscate`, static `OBFUSCATION_KEY`, comment `[F-02] Obfuscate sensitive data`)
- **Description:** EIP-712 `signature` + `orderHash` are stored under repeating-key XOR with a key shipped in the JS bundle — trivially reversible, not encryption.
- **Impact:** Any local/XSS actor recovers valid order signatures + strategy. (Subset of FULL-H-03; listed separately because it is mislabeled as protection.)
- **Recommendation:** Migrate to `SecureStorage` (AES-GCM under a wallet-derived key).
- **Known?:** **FE-01.**

### FULL-M-09 — Limit & conditional orders persisted as plaintext JSON (no obfuscation at all)
- **File:** `src/hooks/useLimitOrder.ts:33-38` (`teraswap:limit:orders`), `src/hooks/useConditionalOrder.ts:41-46`
- **Description:** Both hooks write full order objects to localStorage in cleartext (not even the XOR that `useOrderEngine` applies). These store target prices, amounts, pairs, CoW `orderUid`s, SL/DCA configs. (No raw signature here — CoW orders are server-submitted and only `orderUid` is kept — so this is strategy/privacy leakage rather than key compromise.)
- **Impact:** Browser extension / XSS / shared-machine user reads the wallet's full strategy.
- **Recommendation:** Route through `SecureStorage` (the FE-01 target).
- **Known?:** **FE-01.**

---

## Low (L) — Backlog

| ID | File | Issue |
|----|------|-------|
| FULL-L-01 | `src/hooks/useQuote.ts:147-238` | No `AbortController`: the in-flight guard *drops* a new fetch when tokens/amount change mid-request rather than aborting+superseding; new pair's quote delayed up to one poll interval, and a stale resolve can briefly show old-pair data. Recommend abort + fetch-id tagging (as `usePortfolio` does). |
| FULL-L-02 | `quote/route.ts:78-81,128-131`, `swap/route.ts:256-259`, `spender/route.ts:23-26`, `orders/route.ts:230,236,272` | Raw `err.message` (incl. Supabase `error.message`) returned in response body. The `/v1/*` routes were hardened; these in-app routes still leak internal/upstream detail. Residual of **API-MED-05** (PARTIAL). |
| FULL-L-03 | `src/app/api/orders/stats/route.ts:18-77` | `wallet` param optional; when omitted returns **global** aggregate counts (total/active/executed/cancelled/expired + 24h) with no auth. Aggregate-only, no addresses. Prior **API-MED-04**, STILL-OPEN. |
| FULL-L-04 | `src/components/SwapBox.tsx:296-308,857` | CoW path records `method:'infinite'` + `needsRevoke:true` and shows an "infinite allowance" warning, but approvals are now **exact** (`useApproval.ts:191-195`). Misleads users into chasing an unneeded revoke. Documentation drift from the FE-MED-02 fix. |
| FULL-L-05 | `src/hooks/useSwap.ts:56-73` | `simulateSwapTx` returns `{success:true}` on any non-parseable error (fail-open). A flaky RPC silently disables the only client-side revert guard. On-chain `minimumOutput` still protects funds. |
| FULL-L-06 | `src/hooks/useSwap.ts:230-863,874-921` | Post-`await` `setState`/`setStatus` calls in `executeStandardSwap`/`executeCowSwap`/`confirmSwap` are not `mountedRef`-guarded; the CoW `pollCowOrderStatus` (up to 120s) has no unmount abort. React 18 no-op warning + wasted network; no fund loss. |
| FULL-L-07 | `src/app/api/log-*` (log-event/log-activity/log-swap) | Still **no HMAC/auth** — only CORS origin restriction (browser-only, trivially bypassed by direct POST). Server-side validation/USD-recompute strongly reduces fake-data impact, but the no-auth gap (prior **API-HIGH-02**) is PARTIAL. |
| FULL-L-08 | `src/app/api/{swap,quote,rpc,portfolio}/route.ts` (e.g. `swap/route.ts:84`) | Rate-limit key uses `x-forwarded-for.split(',')[0]` (client-spoofable leftmost IP). Safe on Vercel (platform overwrites the header) but spoofable if ever fronted by an appending proxy. Document the Vercel dependency or use `x-real-ip`. |

---

## Informational (INFO) — Design observations

- **INFO-01 — Dead deprecated EIP-712 domains.** `PERMIT2_DOMAIN` (`src/lib/approvals.ts:52-56`) and `ORDER_EXECUTOR_DOMAIN` (`src/lib/order-engine/config.ts:27-32`) are `@deprecated` hardcoded-chainId domains, still imported (`useApproval.ts:5`) but used in **no live signature** — the permit2/eip2612 branches in `useApproval` are unreachable (`planApproval` always forces `exact`, lines 100-109). Maintenance hazard; remove the dead imports/branches. (Confirms **FE-LOW-04** is effectively FIXED.)
- **INFO-02 — Fee-integrity validator inert in production.** `validateFeeIntegrity` runs only for `source ∈ FEE_NATIVE_SOURCES`, which is `[]` (`constants.ts:131`), so it never fires today (documented at `useSwap.ts:338-342`). The function is genuinely tested; auto-re-arms if a partner-fee source is added. Don't mistake it for active coverage.
- **INFO-03 — `confirmSwap` try/catch is largely dead.** `sendTransaction` (wagmi v2 mutation) doesn't throw on async send failure — that surfaces via the `sendError` effect (`useSwap.ts:1041-1061`). The try/catch at 908-918 gives false comfort; use `sendTransactionAsync`+await or drop it.
- **INFO-04 — Read API "wallet = public key" model.** `GET /api/orders/:id`, `/executions`, `/history`, `/analytics/personal`, `/analytics/export` treat the public wallet address as the sole authenticator (explicitly documented at `analytics/personal/route.ts:11-19`, tagged `[13B-L-02]`). Accepted design — it aggregates on-chain-public data. Revisit (gate behind SIWE) only if non-on-chain PII ever lands in those tables. Rate limits (personal 10/min, export 5/hr) are the only abuse control.
- **INFO-05 — npm audit: 0 high/critical, 22 moderate** — all transitive via `@reown/appkit*`/`@walletconnect` (uuid GHSA-w5hq-g745-h8pq, ws GHSA-58qx-3vcg-4xpx). socket.io-parser is patched (4.2.6). Track for upstream bumps.
- **INFO-06 — `<img src={token.logoURI}>`** (`TokenSelector.tsx:203,247,350`, `PortfolioTab.tsx:73-79`) renders an external URL. For imported tokens `logoURI` is hardcoded to the 1inch CDN (`useTokenImport.ts:75`), not attacker-controlled metadata; `<img src>` is not a script sink. Worst case is a broken image / CDN IP-leak, already `onError`-handled. No action required.

---

## Test Coverage Gaps

> 1173 tests pass and the security-critical tests I read are **genuine, not trivial** — `kv-rate-limiter.test.ts` (fail-closed math, window reset, recovery), `swap-validations.test.ts` (real `validateRouterAddress`/`validateFeeIntegrity`/`validateCallDataRecipient`, 55 assertions), `calldata-recipient.test.ts` (38), `validation.test.ts` (71), `swap/route.test.ts` (price-guard 422 + high-value block wiring). The gaps below are where fund-safety logic runs **unit-untested**.

- **TEST-H-01 — `src/lib/chainlink.ts:177-179` (oracle staleness) has zero unit coverage.** The `answeredInRound < roundId → null` and `age > CHAINLINK_MAX_STALENESS_SEC → null` gates have no `chainlink.test.ts`. `useChainlinkPrice.test.ts` tests a *display* hook that re-implements decoding, not this server path. A flipped operator here would let stale prices through undetected. **Add return-null path tests (stale round, age>max, decode failure).**
- **TEST-H-02 — `src/lib/defillama.ts` `validateSwapPrice` (deviation/threshold math) untested.** This is the core anti-manipulation control for the >$10k block. `swap/route.test.ts:58-60` **mocks** `validateSwapPrice` entirely, so it only verifies the 422 wiring, never the deviation arithmetic or the high-value boundary. **Add `defillama.test.ts` across WARN/BLOCK boundaries + the high-value fail-closed path.**
- **TEST-M-01 — `src/lib/secure-storage.ts` shipped with zero tests and unwired.** Untested crypto (key derivation, IV, GCM tag verification) is high-risk, and the benefit isn't realized until callers migrate (see FULL-H-03). **Add encrypt/decrypt round-trip + tamper-detection tests, then migrate consumers.**
- **TEST-M-02 — `src/lib/price-monitor.ts` `getChainlinkPriceUSD` untested** — the SL/TP/DCA oracle read with the missing staleness gates (FULL-H-04) has no tests. Add once the staleness checks are added.
- **TEST-L-01 — `src/lib/sybil-detector.ts` (`scoreWallet:183`, `detectWalletClusters:232`) untested** — feeds the admin security dashboard (`AdminMonitor.tsx`); advisory/admin-only, low risk, but no coverage.
- **Note (acceptable mocking, not a gap):** `useSwap.test.ts` mocks the validators — fine layering because each validator has its own real-logic test. `swap/route.test.ts` mocking `validateSwapPrice` is the gap (TEST-H-02), since no other test exercises that function's internals.

---

## Architecture Observations

1. **Calldata defense-in-depth is the strongest part of the system.** Router whitelist + selector whitelist + size bound + recipient check + fee integrity, enforced client- and server-side, and now correctly **mirrored onto the split-swap path** (the prior FE-HIGH-01 gap is closed). On-chain `minimumOutput` derived from the fresh quote is the final backstop.
2. **No SIWE / session layer.** Order *creation* is signature-authenticated (EIP-712, recovered server-side), but order *cancellation* is not (FULL-H-01), and all read endpoints use the public address as the authenticator (INFO-04). A small SIWE/typed-message layer would close both consistently.
3. **Supabase access is uniformly service-role for CRUD** (`orders/route.ts:41`, `orders/[id]`, `orders/stats`, …), bypassing RLS by design. The least-privilege INSERT-only logger role (EXT-M-03) covers the fire-and-forget logging paths only; CRUD remains service-role. Prior **API-HIGH-01** is PARTIAL/accepted — acceptable given server-side validation, but worth a documented RLS strategy.
4. **FE-01 is staged but not started.** The encryption primitive exists and is plausibly correct, but nothing uses it; sensitive order data (incl. execution signatures) is still plaintext/XOR. This is the single biggest "looks-done-but-isn't" risk in the tree.
5. **Two oracle code paths with divergent rigor.** `chainlink.ts` (swap path) validates round/staleness; `price-monitor.ts` (conditional-order path) does not (FULL-H-04). Consolidating both onto one validated reader would remove the divergence and the test gap at once.
6. **Recommendation stands (from AUDIT-TOTAL.md):** a professional third-party smart-contract audit (Trail of Bits / OpenZeppelin / Consensys Diligence) before handling significant TVL. This review covers integration/app layers, not the deployed Solidity itself.

---

## Prior-Findings Verification Summary

Confirmed **FIXED** against current code: API-CRITICAL-01 (timing-safe `safeCompare`/`verifyBearerToken` everywhere), API-CRITICAL-02 (secrets fail-closed: tick/heartbeat/validate-execution 503 when unset), API-HIGH-03 (monitor CORS now origin-restricted), API-HIGH-04 (quote rate-limited 30/min), API-HIGH-05 (quote POST address validation), API-MED-03 (log-swap PATCH now scoped), API-MED-06 (no setInterval leak; RPC uses KV), API-MED-07 (analytics truncates wallets), FE-HIGH-01 (split-swap calldata validation), FE-MED-01 (slippage UI capped at 15%), FE-LOW-04 (dynamic Permit2 domain), EXT-H-01 (KV limiter now fails **closed** to 50% in-memory), EXT-M-03 (INSERT-only logger role), DEP-HIGH-01 (socket.io-parser 4.2.6).

Still **OPEN** (carried into findings above): FE-LOW-01→FULL-H-02, FE-LOW-02→FULL-L-01, API-HIGH-02→FULL-L-07 (partial), API-MED-04→FULL-L-03, API-MED-05→FULL-L-02 (partial), API-HIGH-01 (partial/accepted), FE-01→FULL-H-03/M-08/M-09. DEP-MED-01: `.env.production` still on disk (secrets now blank; only public addresses remain), gitignored and untracked — low residual.

**New finding counts this pass:** 0 Critical · 4 High · 9 Medium · 8 Low · 6 Info · 5 Test gaps.
