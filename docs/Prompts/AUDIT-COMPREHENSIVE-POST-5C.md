# Comprehensive Security & Architecture Audit — Post-Sprint 5C

**Date:** 2026-04-15
**Scope:** Full codebase audit — smart contracts, backend, frontend, monitoring stack, infrastructure, CI/CD
**Requested by:** TeraHash (founder/architect)
**Trigger:** All ADR-001 components shipped (H1+H2+H5+H6+kill-switch). 35 prompts executed across Sprints 0–5C. 203+ tests. Production traffic live. Time for a comprehensive external-grade review before Phase 2 multi-chain expansion.

---

## Auditor brief

You are a senior security auditor reviewing a production DeFi application. This is a **comprehensive audit** — not a sprint-scoped review. You must examine the entire codebase with fresh eyes, as if you've never seen it before. Prior sprint audits caught issues incrementally; this audit must find anything that was missed, any cross-cutting concerns that only become visible at system level, and any regressions introduced during rapid Sprint 5A-5C development (9 sprints in 2 days).

**Bias to severity.** DeFi applications handle real funds. A missed vulnerability can result in irreversible financial loss. When in doubt, classify higher.

---

## System overview

**TeraSwap** is an Ethereum meta-aggregator that:
1. Queries 11 DEX aggregator APIs for swap quotes (1inch, 0x/Velora, Odos, KyberSwap, CoW Protocol, OpenOcean, Uniswap V3, SushiSwap, Balancer V2, Curve Finance, ParaSwap)
2. Ranks by output amount, selects best route, executes via user's wallet
3. Supports autonomous order execution: Limit, Stop-Loss, DCA via on-chain contract (TeraSwapOrderExecutor v2)
4. Monitors all 11 sources for availability, TLS/DNS integrity, and quote consistency
5. Provides human-in-the-loop operational control via Telegram bot

**Stack:** Next.js 14 (App Router) on Vercel, Solidity 0.8.28, Supabase (Postgres + Auth + RLS), Vercel KV (Upstash), Cloudflare Worker (scheduler), Capacitor (mobile), GitHub Actions CI/CD.

---

## Audit scope and checklist

### Phase 1 — Smart Contracts

**Files:** `contracts/order-engine/`, `contracts/fee-collector/`

1. **TeraSwapFeeCollector.sol** — fee extraction logic, admin functions, router whitelist
   - [ ] Fee calculation precision (0.1% on all swaps)
   - [ ] Reentrancy on fee collection during swap execution
   - [ ] Admin function access control (owner-only, timelock)
   - [ ] ETH/WETH handling edge cases
   - [ ] Approval/Permit2 interaction safety

2. **TeraSwapOrderExecutor.sol v2** — autonomous order execution
   - [ ] EIP-712 signature verification (domain separator, struct hash)
   - [ ] Order replay protection (nonce invalidation, `cancelledOrders` mapping)
   - [ ] `minAmountOut` enforcement — slippage protection on execution
   - [ ] DCA partial execution tracking — dust remaining after final execution (SC-02 residual)
   - [ ] Timelock on admin functions (48h `TimelockController`)
   - [ ] Gas griefing on `executeOrder()` — can a malicious router consume all gas?
   - [ ] `canExecute()` view function — can it be manipulated to cause executor to skip valid orders?
   - [ ] Router whitelist management — can a compromised router drain funds?

3. **Cross-contract interactions**
   - [ ] FeeCollector ↔ OrderExecutor interaction — can fees be bypassed?
   - [ ] External DEX router calls — calldata validation before forwarding
   - [ ] Flash loan attack vectors on order execution

### Phase 2 — Backend / API Routes

**Files:** `src/app/api/`

4. **Swap API routes** (`/api/quote`, `/api/swap`)
   - [ ] Input validation: token addresses, amounts, slippage bounds
   - [ ] Price manipulation via controlled source responses
   - [ ] Rate limiting effectiveness (Vercel KV implementation)
   - [ ] Error handling — does a failed source leak internal state?
   - [ ] CORS configuration — is the API accessible from unauthorized origins?

5. **Order Engine API** (`/api/orders/`)
   - [ ] EIP-712 signature verification on order creation (server-side recovery)
   - [ ] RLS policies — can user A read/cancel user B's orders?
   - [ ] Rate limiting on order creation
   - [ ] Wallet address validation (checksum + format)
   - [ ] Order status transitions — can an order be executed after cancellation?

6. **Monitoring API** (`/api/monitor/tick`, `/api/monitor/heartbeat`)
   - [ ] Tick endpoint authentication — can external actors trigger ticks?
   - [ ] Heartbeat information disclosure — does it leak operational state?
   - [ ] KV read/write error handling — what happens if Upstash is down?

7. **Kill-switch endpoint** (`/api/admin/kill-switch`)
   - [ ] Bearer token auth via `timingSafeEqual` with SHA-256 pre-hash
   - [ ] Can the kill-switch be bypassed by directly calling source state machine?
   - [ ] Audit trail integrity — can KV entries be overwritten?
   - [ ] What happens if kill-switch is triggered during an in-flight swap?

8. **Telegram webhook** (`/api/telegram/webhook`)
   - [ ] Webhook secret verification (constant-time, SHA-256 pre-hash)
   - [ ] Admin ID verification (numeric comparison, not string)
   - [ ] `/disable` uses non-P0 reason (`operator-disable:`) — verify no P0 bypass path
   - [ ] `/activate` with P0 confirmation gate — can it be bypassed?
   - [ ] `/grace` bounds validation (1-1440 minutes)
   - [ ] Callback query handler — admin check on privileged button actions
   - [ ] Escalation handler — does it correctly bypass grace and dedup?
   - [ ] Input sanitization — can bot commands inject HTML into Telegram responses?
   - [ ] Response truncation at 4096 chars — is it safe or can it break HTML tags?

### Phase 3 — Monitoring Stack (ADR-001)

**Files:** `src/lib/monitoring-loop.ts`, `src/lib/source-state-machine.ts`, `src/lib/quorum-check.ts`, `src/lib/alert-wrapper.ts`, `src/lib/alert-channels/`

9. **H1 — Health checks**
   - [ ] Can a malicious source API response manipulate state transitions?
   - [ ] Timeout handling — does a hanging request block the entire tick?
   - [ ] Latency history manipulation — can artificial latency spikes trigger false disables?
   - [ ] Per-source weighted thresholds (`data/source-thresholds.json`) — are they tamper-proof?

10. **H2 — TLS/DNS fingerprint watcher**
    - [ ] Baseline comparison logic — what if baseline file is corrupted/empty?
    - [ ] Certificate pinning strength — does it check full chain or just leaf?
    - [ ] DNS record comparison — are all record types covered (A, AAAA, NS, CNAME)?
    - [ ] P0 disable on mismatch — is it immediate or can it be delayed?

11. **H5 — Quorum cross-check**
    - [ ] BigInt precision in deviation calculation (`(diff * 10000n) / median`)
    - [ ] Median calculation — is it manipulation-resistant with 11 sources?
    - [ ] Correlated outlier detection — ≥3 triggers kill-switch, is this threshold correct?
    - [ ] Reference pairs (WETH→USDC 5%, USDC→USDT 2%) — are these thresholds appropriate?
    - [ ] What happens when <3 sources return valid quotes?

12. **State machine**
    - [ ] State transition correctness: `active → degraded → disabled → active`
    - [ ] P0 reasons block auto-recovery — verify complete P0 list
    - [ ] `forceDisable()` and `forceActivate()` — side effects, alert emission
    - [ ] Race conditions — concurrent ticks modifying same source state
    - [ ] KV persistence — `beginTick()` per-request cache correctness

13. **Alert system**
    - [ ] Single alert path (I-02 fix verified — no legacy callback)
    - [ ] Dedup logic — can alerts be suppressed when they shouldn't be?
    - [ ] Grace period — can it be exploited to mask real incidents?
    - [ ] HTML escaping in alert payloads — XSS via source IDs or reasons?
    - [ ] Fan-out failure handling — if Telegram fails, do other channels still fire?

### Phase 4 — Frontend Security

**Files:** `src/app/`, `src/components/`, `src/hooks/`, `src/lib/`

14. **Wallet interaction**
    - [ ] Permit2 approval flow — is the education modal sufficient?
    - [ ] Token address display — TokenAddressBadge in all relevant places?
    - [ ] SwapConfirmModal MISSING — user signs directly from SwapBox (known UX gap)
    - [ ] Calldata display — can user verify what they're signing?
    - [ ] EIP-712 typed data — is it human-readable in wallet prompts?

15. **Token handling**
    - [ ] Token list sources — can a malicious token be injected?
    - [ ] CoinGecko category data — is it validated before display?
    - [ ] BOLD token addition — is it correctly configured?
    - [ ] Token address validation in swap inputs

16. **State management**
    - [ ] FE-01 residual: `localStorage` usage — sensitive data exposure?
    - [ ] Are private keys or signatures ever stored client-side?
    - [ ] Session/auth token handling

### Phase 5 — Infrastructure & CI/CD

17. **Vercel deployment**
    - [ ] Environment variable hygiene — are secrets properly scoped (Production/Preview)?
    - [ ] Preview deployments — can they access production KV/Supabase?
    - [ ] Function timeout limits — can monitoring tick exceed Vercel's 10s hobby limit?
    - [ ] Edge vs. serverless function placement

18. **Cloudflare Worker**
    - [ ] Worker secret (`TICK_AUTH_TOKEN`) rotation procedure
    - [ ] Can the Worker be triggered externally (not just by cron)?
    - [ ] Worker → Vercel auth — is the tick endpoint properly authenticated?

19. **GitHub Actions**
    - [ ] Actions pinned to SHA — verify all actions are pinned
    - [ ] Secrets management — are secrets narrowly scoped?
    - [ ] Watchdog cron (`*/5 * * * *`) — what happens if GitHub Actions is down?
    - [ ] Dependabot — 3 PRs with build errors (tailwindcss, typescript, @types/node). Are any security-critical?

20. **Supabase**
    - [ ] RLS policies — comprehensive review for all tables
    - [ ] Service role key exposure — is it server-only?
    - [ ] Point-in-time recovery configured?
    - [ ] Audit trail (merkle chain) — verify chain integrity implementation

21. **Domain & TLS (ADR-002)**
    - [ ] Cloudflare Full(strict) TLS — is origin cert valid and not self-signed?
    - [ ] HSTS preload — verify `max-age`, `includeSubDomains`, `preload` directives
    - [ ] Pending: registrar transfer, DNSSEC, Registry Lock (after 2026-05-03)

### Phase 6 — Cross-cutting Concerns

22. **Dependency supply chain**
    - [ ] `npm audit` — any known vulnerabilities?
    - [ ] `lockfile-lint` — is lockfile integrity enforced?
    - [ ] Critical dependencies: `@vercel/kv`, `wagmi`, `viem`, `@rainbow-me/rainbowkit` — latest secure versions?
    - [ ] Transitive dependency risks

23. **Error handling & logging**
    - [ ] Are errors logged without leaking secrets?
    - [ ] Do API routes return appropriate error codes (not stack traces)?
    - [ ] Is `console.error` the right approach or should structured logging be used?

24. **Data privacy**
    - [ ] IP addresses — privacy proxy claimed, verify implementation
    - [ ] Wallet addresses in Supabase — any PII concerns?
    - [ ] Telegram user IDs in KV audit trail — data retention compliance?

25. **Operational resilience**
    - [ ] What happens if Vercel KV (Upstash) has an outage?
    - [ ] What happens if Cloudflare Worker stops firing?
    - [ ] What happens if Supabase is unreachable?
    - [ ] Is there a single point of failure that takes down the entire system?
    - [ ] Disaster recovery procedures documented?

---

## Output format

Produce a findings table with the following columns:

| # | Severity | Category | Component | Finding | Recommendation | Status |
|---|----------|----------|-----------|---------|----------------|--------|

**Severity levels:**
- **C (Critical):** Direct fund loss risk, authentication bypass, or privilege escalation
- **H (High):** Indirect fund risk, data integrity issues, or severe operational impact
- **M (Medium):** Security best practice violations with meaningful risk
- **L (Low):** Minor issues, cosmetic, documentation gaps
- **I (Informational):** Observations, suggestions, no immediate risk

After the findings table, provide:

1. **Executive summary** — 3-5 sentences on overall security posture
2. **Top 3 risks** — ranked by severity × likelihood
3. **Recommended actions** — prioritized list of fixes, grouped by sprint
4. **Verdict:** APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION

---

## Files to examine

**Priority 1 (security-critical):**
- `contracts/order-engine/TeraSwapOrderExecutor.sol`
- `contracts/fee-collector/TeraSwapFeeCollector.sol`
- `src/app/api/telegram/webhook/route.ts`
- `src/app/api/admin/kill-switch/route.ts`
- `src/app/api/monitor/tick/route.ts`
- `src/lib/source-state-machine.ts`
- `src/lib/monitoring-loop.ts`
- `src/lib/quorum-check.ts`
- `src/lib/alert-wrapper.ts`
- `src/lib/alert-channels/telegram.ts`

**Priority 2 (business logic):**
- `src/app/api/quote/route.ts`
- `src/app/api/swap/route.ts`
- `src/app/api/orders/`
- `src/lib/adapters/` (all 11 adapters)
- `src/lib/p0-reasons.ts`
- `data/source-thresholds.json`
- `data/endpoint-baseline.json`

**Priority 3 (frontend + infra):**
- `src/components/swap/`
- `src/hooks/useOrderEngine.ts`
- `.github/workflows/`
- `wrangler.toml`
- `vercel.json`
- `supabase/migrations/`

---

## Context documents

The auditor should read these before starting:
- `docs/ADR/ADR-001-monitoring-architecture.md` — monitoring design decisions
- `docs/ADR/ADR-002-cloudflare-registrar.md` — domain hardening plan
- `docs/security/SECURITY.md` — security model overview
- `docs/security/AUDIT-TOTAL.md` — cumulative audit findings
- `Audits/Incidents/` — all 4 incident reports
- `ARCHITECT-INDEX.md` — full artifact index
