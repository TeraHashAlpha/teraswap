# THREAT-MODEL-2026-07-07 — White-hat attack-surface analysis (hand-off to Architect)

> **Type:** offensive/white-hat threat model (read-only; no source/config/contract changed).
> **Method:** multi-agent workflow `wf_71fc0b0e-c90` — 7 domain threat-modelers → per-vector adversarial verification → synthesis. Session-token limits truncated the automated verification twice, so the confirmed/refuted split is partial; the flagship High items were additionally **verified by hand** against the source (line refs below). Journal: `subagents/workflows/wf_71fc0b0e-c90/journal.jsonl`.
> **Scope:** contracts (FeeCollector + OrderExecutor v2), order-signing (EIP-712/Permit2/DCA), API routes, oracle/price, frontend/wallet, keeper/infra, economic/MEV.
> **Baseline:** `origin/main` @ `a717427` (post-#275).

## Verification legend
- **CONFIRMED (adversarial):** survived an independent refutation agent that read the code.
- **CONFIRMED (manual):** verified by hand in this report against the cited source.
- **REFUTED:** an adversarial agent read the code and found it already mitigated / not exploitable — *do not re-chase*.
- **UNVERIFIED:** finder-reported; its verification agent did not run (session limit). Not "clean" — pending.

## Posture summary
No path to **custodial theft of user funds** was found. The contracts are strong: separate admin/executor roles, 48h timelocks, `nonReentrant`, scoped-and-revoked router approvals, on-chain `minimumOutput`, EIP-712 signature verification in `canExecute`, oracle breakers, RLS, signed commits, audit-gate, gitleaks. The adversarial pass **downgraded every High finder-claim it tested** on close reading.

The real soft spots are elsewhere: **(1)** conditional-order (DCA/SL/TP) safety is entirely off-chain because the on-chain floor is neutralised to 1 wei; **(2)** size/oracle gates **fail-open for exotic tokens** (the highest-risk case); **(3)** several **silent downgrades** (Vault→plaintext, Flashbots→public mempool) defeat a "High" control with one log line; **(4)** a **frontend/DNS/supply-chain** compromise is the largest blast radius and is out of reach of the on-chain gates.

## Severity summary (deduplicated)
| Sev | Finding | Verification |
|-----|---------|--------------|
| **HIGH** | P1a — DCA has no on-chain output/price floor (1-wei minOut, routerDataHash=0) | CONFIRMED (manual) |
| **HIGH** | P4 — frontend/DNS/supply-chain compromise → wallet drain via approve()/Permit2 | UNVERIFIED (design-level, holds) |
| **HIGH** | P5a — keeper Vault signer stub silently downgrades to plaintext key + bypasses prod guard | CONFIRMED (manual) |
| **MED** | P1b — sequential per-user nonce FIFO can permanently block a stop-loss (latent: panels unwired) | CONFIRMED (manual) |
| **MED** | P1c — non-DCA orders sign routerDataHash=0 → executeOrder always reverts (latent landmine) | CONFIRMED (manual) |
| **MED** | P2 — high-value >$10k oracle block bypassed for tokens neither DefiLlama nor Chainlink prices | CONFIRMED (adversarial) |
| **MED** | P3a — per-IP rate-limit keyed on spoofable left-most X-Forwarded-For (bypass/DoS) | CONFIRMED (adversarial, sev-adjusted Low; practical Med) |
| **MED** | P3b — quote fan-out amplification (amount not validated, cache-defeatable, per-instance cap) | UNVERIFIED |
| **MED** | P3c — /api/rpc allows debug_*/trace_*/wide eth_getLogs → paid-upstream amplification | CONFIRMED (adversarial, Low) |
| **MED** | P7a — inflated quote up to 3× median shown as "best" (DefiLlama guards only downside) | UNVERIFIED |
| **MED** | P7b — stop-loss minOut anchored to trigger price → won't fill on gap-down | UNVERIFIED |
| **MED** | P7c — correlated-quorum P0 kill-switch has no auto-recovery (self-DoS) | UNVERIFIED |
| **LOW** | P3d — /api/history unauthenticated & unthrottled (scraping + DB DoS) | UNVERIFIED |
| **LOW** | P5b — `teraswap.io` in keeper .env example (domain not owned) | UNVERIFIED |
| **LOW** | P5c — Supabase service-role key plaintext on keeper host (freeze-DoS + disclosure) | UNVERIFIED |
| **LOW** | P5d — CI runs npm lifecycle scripts broadly; bot PR skips full CI | UNVERIFIED |
| **LOW** | P5e — /metrics & /health bind 0.0.0.0; health token via query-string, non-constant-time | UNVERIFIED |
| **LOW** | P6a — setOracleConfig not timelocked (unlike every other privileged action) | CONFIRMED (adversarial) |
| **LOW** | P6b — OrderExecutor sweep → mutable admin, not immutable feeRecipient | CONFIRMED (adversarial) |
| **LOW** | P6c — executeRouterChange lacks extcodesize check (CREATE2/EOA router) | UNVERIFIED |
| **LOW** | P4x — FeeCollector minimumOutput is opt-in (0 disables) + no output custody | UNVERIFIED |
| **LOW** | P6d — service worker persists a one-time compromise (no kill-switch) | CONFIRMED (adversarial) |
| **LOW** | order-signing — full-total ERC-20 allowance not revoked on cancel; orderHash stored unrecomputed (6/15 fields cross-checked); CSP unsafe-inline; SecureStorage false confidentiality; 36h staleness ceiling | UNVERIFIED / mixed |
| **INFO** | platform-fee evasion via 0x/CoW/Bebop (revenue leak, not fund/integrity) | UNVERIFIED |

---

## Prioritized findings & proposed Code-Agent prompts

### P1 — Conditional orders have no on-chain economic backstop  *(flagship)*
Three convergent facts, all verified in source:
- **DCA floor = 1 wei.** `src/components/DCAPanel.tsx:431` signs `minAmountOut='1'`; `contracts/order-engine/TeraSwapOrderExecutor.sol:508-509` computes `minOut = (minAmountOut * executeAmount) / amountIn; if (minOut == 0) minOut = 1;` → 1 wei. DCA also bypasses the routerDataHash commitment (`:420-423`) and `priceFeed=0`. So the on-chain output check (`:528`) is a no-op for DCA; **all** slippage/MEV protection is the 0.5% `KEEPER_SLIPPAGE` embedded in keeper-built calldata, submitted via the **public mempool** whenever `FLASHBOTS_RPC_URL` is unset (silent fallback; Base has no Flashbots). A keeper key compromise, a route-builder bug, or loose `/api/swap` calldata extracts DCA principal down to dust. **HIGH.**
- **Sequential nonce FIFO.** `:460` requires `nonces[owner] == order.nonce` for non-DCA; `:524` advances only on non-DCA success (DCA uses `dcaExecutions[orderHash]`). A never-triggering lower-nonce order permanently blocks a higher-nonce **stop-loss** — a capital-protection failure. **MED, latent** (limit/SL/TP panels unwired at `src/app/page.tsx`).
- **Non-DCA routerDataHash=0.** LimitOrderPanel/ConditionalOrderPanel omit `routerDataHash` → `useOrderEngine.ts:576` defaults ZeroHash → `executeOrder` reverts `RouterDataMismatch` (`:420`). Limit/SL/TP are **structurally unexecutable** as coded. **MED, latent landmine.**

→ **Prompt `SPRINT-ORDER-ONCHAIN-FLOOR`:** before re-wiring limit/SL/TP, design the on-chain model: (a) a real per-chunk output floor derived from a Chainlink read at execution within a signed max-slippage bound (replace the 1-wei clamp with a revert); (b) an **unordered/bitmap nonce** scheme (Permit2-style) so each conditional order is independently executable/invalidatable; (c) resolve routerDataHash (lock route at signing *or* back dynamic calldata with the oracle floor). For DCA already-live: make private-relay submission **mandatory on mainnet/Base** (fail-closed if `FLASHBOTS_RPC_URL` unset, mirroring the existing key guard). Needs an Auditor pass (fund-flow).

### P2 — High-value oracle gate fails open for exotic tokens  *(CONFIRMED)*
`src/app/api/swap/route.ts:252-261` estimates value from the **input token only** via DefiLlama; client `SwapBox.tsx:554-566` via Chainlink+stable+ETH. A token neither prices → estimate `0` → the >$10k block never fires on **either** layer. The post-aToken-incident control is bypassable by choosing an uncovered token (exactly the thin/manipulable ones); `minimumOutput` derives from the (possibly manipulated) quote's own `toAmount`, so it doesn't bound loss from a self-consistent bad quote.
→ **Prompt `CHORE-ORACLE-VALUE-FAILCLOSED`:** value = `max(inputUsd, outputUsd)` across DefiLlama **and** the server Chainlink `computeTokenAmountUsd`; if neither side prices, treat as high-risk (conservative block / size ceiling), never 0.

### P3 — Public API surface: amplification & rate-limit integrity
- **P3a X-Forwarded-For spoofable** (`quote/route.ts:91`, `swap/route.ts:141`, `rpc/route.ts:52`, `body-limit.ts:22`): left-most XFF token is attacker-controlled on Vercel, so every per-IP limit is bypassable (and a victim's bucket is exhaustible; KV keys are pollutable). Underlies P3b/P3c.
- **P3b quote fan-out** (`quote/route.ts:111`; `quote-cache.ts:39`; `api.ts:133`): `amount` never validated and is verbatim in the cache key → each +1 wei is a miss → 1 request ≈ 11 upstream calls (paid keys); the global cap is a per-instance in-memory Map (autoscale defeats it).
- **P3c /api/rpc** (`rpc/route.ts:32-45,83-89`): blacklist blocks only signing methods; `debug_*`/`trace_*`/wide `eth_getLogs` proxy archive-grade queries to the paid upstream.
- **P3d /api/history** (`history/route.ts:10-49`): no auth, no throttle, `count:'exact'` → wallet enumeration + DB-load DoS. The sibling orders/export routes added read-auth/rate-limit; history did not.
→ **Prompt `CHORE-API-HARDENING-2`:** one trusted-IP helper (`x-vercel-forwarded-for`) used everywhere; validate+quantize `amount` and share cache; move the global outbound throttle to KV; cost policy on `/api/rpc` (cap batch, clamp getLogs range, gate debug/trace); rate-limit + offset-cap + drop `count:'exact'` on `/api/history`; also apply `sanitizeUpstreamError` on `/api/quote` and enforce the body cap on bytes read, not Content-Length. No Auditor (no fund flow).

### P4 — Frontend / DNS / supply-chain compromise  *(largest blast radius)*
Every client-side allowlist (`isTrustedSpender`, R1 `validateCallDataRecipient`, SC-04 `KNOWN_SWAP_SELECTORS`) lives in the replaceable bundle; a hijacked build prompts `approve()`/Permit2 that **never touch the contracts**, so on-chain gates don't apply.
→ **Prompt `CHORE-FRONTEND-INTEGRITY`:** DNSSEC + registrar-lock; scoped Vercel deploy tokens + 2FA + protected prod branch; external bundle-hash monitoring; a pre-sign screening layer (simulation) outside the bundle + a hard red interstitial for any spender not in `TRUSTED_SPENDER_ADDRESSES` decoded on every path. **And reduce the on-chain blast radius (P4x):** reject `minimumOutput==0` in FeeCollector and/or have it take custody of tokenOut and re-deliver to `msg.sender` (as OrderExecutor does).

### P5 — Keeper / infra (defense-in-depth)
- **P5a Vault stub (HIGH, manual):** `kms-signer.js:217-223` — the `if (vaultAddr)` branch only logs and **falls through** to `privateKeyToAccount`; `executor.js:253` skips the production plaintext FATAL when `hasVault`. A botched Vault migration runs a plaintext mainnet key with one log line. → Vault branch **must throw**; don't count `VAULT_ADDR` as a managed signer until wired; assert the resolved signer type at startup.
- **P5b `teraswap.io`** in `.env.executor.example:59` — domain the team does not own. *(quick win)* → park it, fix the example to `www.teraswap.app`, add a keeper host-allowlist.
- **P5c Supabase service-role key** plaintext on host → freeze-DoS of DCA + disclosure of all orders/signatures (no theft — on-chain sig check). → scoped role + secrets manager + alert on `frozen` flip without admin action.
- **P5d CI lifecycle scripts** in many jobs; `token-catalog-refresh` bot PR skips full CI with `contents:write`+secrets. → `--ignore-scripts` outside build; bot PR must pass full CI.
- **P5e /metrics & /health** bind `0.0.0.0`; token via query-string, `!==` compare. → bind localhost, token via header + `timingSafeEqual`.
→ **Prompt `CHORE-KEEPER-INFRA-HARDENING`** (bundle P5a–P5e; P5a needs an Auditor note — signer/fund-adjacent).

### P6 — Contract governance (admin-trust + timelock)
- **P6a setOracleConfig not timelocked** (`:869-896`) *(CONFIRMED Low)* → route through the 48h timelock + on-chain `maxStaleness` cap.
- **P6b OrderExecutor sweep → mutable `admin`** (`:776-785`) *(CONFIRMED Low)* → send to the immutable `feeRecipient` like FeeCollector.
- **P6c executeRouterChange lacks extcodesize** *(unverified)* → add the check present in bootstrap.
→ **Prompt `CHORE-EXECUTOR-GOVERNANCE`** (contract changes → Auditor).

### P7 — Price/quorum & MEV (integrity/UX; funds safe, revert)
- **P7a inflated quote** up to 3× median shown as best; DefiLlama guards only downside → griefing reverts + trust erosion. → tighten display outlier band; add an upside oracle bound.
- **P7b stop-loss** minOut anchored to trigger price → won't fill on gap-down. → derive SL floor from the current oracle at execution.
- **P7c correlated-quorum P0** kill-switch has no auto-recovery → self-DoS on a market-wide dislocation. → corroborate with an external oracle before P0; time-box the disable.
- Lower: single-RPC Chainlink trust; 36h staleness ceiling on 24h-heartbeat feeds; MEV off by default + 15% max slippage; fee evasion (revenue). → `CHORE-PRICE-INTEGRITY-2` (no Auditor unless it touches a gate).

---

## Refuted by the adversarial pass — do NOT re-chase
- **SSRF** (11-source fan-out + `/api/rpc`): every outbound host is a hardcoded literal; addresses regex-validated; `chainId` coerced & registry-checked. No request value reaches host/scheme. **Fully defended.**
- **Cross-chain / cross-contract EIP-712 replay:** domain binds `chainId`+`verifyingContract`; distinct per-chain executor addresses; server re-derives domain from an allowlist. **Fully defended.**
- **Clickjacking:** `frame-ancestors 'none'` + `X-Frame-Options: DENY`, doubled at the edge (`vercel.json`). **Closed.**
- **Scam token import:** never marked verified; symbols sanitized; curated catalog guarded on-chain. Inherent permissionless risk, well-signposted.
- ~17 further finder vectors were adjusted to Info/Low or refuted on close reading.

## Already fixed
**NEW2-M-01** (low-quorum demotion steering asymmetry) — closed on `main` via **PR #275** (reference-confirmed demotion). This threat model independently re-surfaced the same class (P7a upside); the demotion path itself is now anchored to an external reference.

## To close 100%
~22 adversarial verifications + synthesis + critique did not run (session-token limits). Resume: `Workflow({scriptPath: '…/teraswap-threat-model-wf_71fc0b0e-c90.js', resumeFromRunId: 'wf_71fc0b0e-c90'})` after the limit resets — completed finders/verifies replay from cache; only the pending ones re-run. The flagship High items (P1a, P1b, P1c, P5a) are already manually verified above and do not depend on that resume.
