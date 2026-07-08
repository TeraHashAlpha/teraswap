# AUDIT-TOTAL.md — TeraSwap Comprehensive Security Audit

> **Date:** 2026-03-19
> **Auditors:** 5 parallel security analysis agents (smart contracts, API/server, frontend/DeFi, dependencies, competitor research)
> **Scope:** Full-stack — Solidity contracts, Next.js API routes, React frontend, DeFi attack vectors, infrastructure, DNS/domain security

---

## EXECUTIVE SUMMARY

TeraSwap was subjected to a comprehensive battle-testing audit modeled after the security practices of major DEX aggregators (1inch, 0x, KyberSwap, CoW Protocol, Uniswap). The audit covered smart contracts, server-side API routes, frontend security, DeFi-specific attack vectors, dependency chain, and infrastructure configuration.

### Overall Security Score: **7.2 / 10**

| Category | Score | Findings |
|----------|-------|----------|
| Smart Contracts | 6.5/10 | 3 Critical, 4 High, 7 Medium |
| API / Server-Side | 6.8/10 | 2 Critical, 5 High, 7 Medium |
| Frontend / DeFi | 8.0/10 | 1 High, 3 Medium, 4 Low |
| Infrastructure | 7.5/10 | 0 Critical, 2 Medium |
| DNS / Domain | 7.0/10 | See dedicated section |

### Key Strengths
- Router address whitelist with default-deny (blocks unknown routers)
- Function selector whitelist on swap calldata
- Multi-oracle price protection (Chainlink + DefiLlama + cross-quote)
- Exact-amount approvals (never infinite, except CoW)
- Privacy proxy hiding user IPs from RPC/DEX APIs
- Comprehensive CSP headers and security headers
- EIP-712 signature verification on orders

### Top Risks Requiring Immediate Action
1. **Timing-safe secret comparison** — health/monitor tokens
2. **Split swap missing calldata validation** — bypasses all swap security
3. **FeeCollector has no router whitelist** — arbitrary contract calls
4. **No rate limiting on quote endpoint** — API key exhaustion vector
5. **DNS hijacking protection** — needs hardening

---

## SECTION 1: SMART CONTRACT FINDINGS

### Critical

#### [SC-CRITICAL-01] FeeCollector: No Router Validation — Arbitrary Contract Calls
**Contract:** `TeraSwapFeeCollector_flat.sol`
**Description:** `swapETHWithFee` and `swapTokenWithFee` accept any `router` address with any `routerData`. No whitelist, no validation. A user can point `router` to the token contract itself and encode `transfer(attacker, netAmount)`.
**Impact:** Self-griefing (user loses own funds), but also means FeeCollector can be used as a pass-through for arbitrary calls with user funds.
**Fix:** Add a router whitelist (admin-managed) matching the OrderExecutor pattern. Validate `router != token && router != address(this)`.
**Status:** The frontend's `validateRouterAddress()` mitigates this for normal users, but direct contract interaction is unprotected.

#### [SC-CRITICAL-02] OrderExecutor: DCA routerDataHash Bypass Applies to Non-DCA Orders
**Contract:** `TeraSwapOrderExecutor.sol:387-389`
**Description:** When `routerDataHash == bytes32(0)`, the check is skipped. There's no enforcement that only DCA orders can use `bytes32(0)`. A LIMIT or STOP_LOSS order with `routerDataHash = 0` lets the executor supply arbitrary calldata.
**Impact:** Malicious/compromised executor can route non-DCA orders through suboptimal paths, extracting MEV up to `minAmountOut`.
**Fix:** `if (order.routerDataHash == bytes32(0) && order.orderType != OrderType.DCA) revert();`

#### [SC-CRITICAL-03] State Update After External Router Call (Mitigated)
**Contract:** `TeraSwapOrderExecutor.sol:452-480`
**Description:** State updates (nonce increment, DCA counter) happen AFTER `router.call(routerData)`. The `nonReentrant` guard prevents direct reentrancy into `executeOrder`, mitigating the risk.
**Impact:** Low in practice due to ReentrancyGuard.
**Status:** Mitigated but CEI ordering should be improved.

### High

| ID | Title | Impact |
|----|-------|--------|
| SC-HIGH-01 | Fee-on-transfer tokens break FeeCollector accounting | Failed/incorrect swaps |
| SC-HIGH-02 | `setExecutor` not timelocked (unlike router changes) | Instant executor compromise if admin key stolen |
| SC-HIGH-03 | No Chainlink price feed whitelist | User can specify fake oracle |
| SC-HIGH-04 | Rebasing tokenOut underflow in balance delta | Order execution DoS |

### Medium

| ID | Title |
|----|-------|
| SC-MED-01 | No ERC-20 refund in swapETHWithFee (tokens stuck) |
| SC-MED-02 | DCA minAmountOut rounds to zero for small amounts |
| SC-MED-03 | Sweep sends to admin not feeRecipient |
| SC-MED-05 | No maximum order expiry enforcement |
| SC-MED-06 | sweep() lacks ReentrancyGuard |
| SC-MED-07 | canExecute() missing checks vs executeOrder() |

### Low

| ID | Title |
|----|-------|
| SC-LOW-01 | Test file has stale hash computation (missing routerDataHash) |
| SC-LOW-02 | OrderExecuted event ABI mismatch with frontend |
| SC-LOW-03 | Zero-fee swaps on amounts < 1000 wei |
| SC-LOW-05 | Pause not reflected in canExecute |
| SC-LOW-09 | Unused error declarations |

---

## SECTION 2: API / SERVER-SIDE FINDINGS

### Critical

#### [API-CRITICAL-01] Non-Timing-Safe Secret Comparison
**Files:** `health/route.ts:18`, `monitor/route.ts:42`
**Description:** Bearer tokens compared with `===` operator. Vulnerable to timing side-channel attacks.
**Impact:** Attacker can brute-force HEALTH_TOKEN and MONITOR_SECRET character-by-character.
**Fix:** Use `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))`.

#### [API-CRITICAL-02] MONITOR_SECRET Likely Unset in Production
**Description:** Not in `.env.example`, not validated by `env-validation.ts`.
**Fix:** Add to `.env.example` and `env-validation.ts`.

### High

| ID | Title | Fix |
|----|-------|-----|
| API-HIGH-01 | Service role key bypasses all RLS | Scope per-route clients |
| API-HIGH-02 | No auth on log endpoints — fake data injection | Add origin check + HMAC |
| API-HIGH-03 | CORS `*` on monitor endpoint | Restrict to app domain |
| API-HIGH-04 | No rate limiting on /api/quote | Add 30/min per IP |
| API-HIGH-05 | Quote POST missing address validation | Add isValidAddress() |

### Medium

| ID | Title |
|----|-------|
| API-MED-01 | In-memory rate limiting ineffective on serverless |
| API-MED-02 | Order status values not validated in query |
| API-MED-03 | PATCH log-swap unscoped update fallback |
| API-MED-04 | Order stats exposes global data without auth |
| API-MED-05 | Error messages leak internal details |
| API-MED-06 | setInterval memory leak in RPC route |
| API-MED-07 | Analytics returns wallet addresses publicly |

---

## SECTION 3: FRONTEND / DEFI FINDINGS

### High

#### [FE-HIGH-01] Split Swap Missing ALL Calldata Security Validations
**File:** `useSplitSwap.ts:155-226`
**Description:** The split swap hook validates router address but is missing:
1. Calldata size validation (>100KB check)
2. Function selector whitelist (KNOWN_SWAP_SELECTORS)
3. Fee integrity validation (validateFeeIntegrity imported but never called)
**Impact:** Compromised aggregator API can inject malicious calldata through a split swap leg, bypassing all security checks.
**Fix:** Copy the ~30 lines of validation from `useSwap.ts:181-216` into the split swap per-leg loop.

### Medium

| ID | Title |
|----|-------|
| FE-MED-01 | Slippage UI allows 49.99% but API caps at 15% |
| FE-MED-02 | CoW Protocol infinite approval (known tradeoff, warned in UI) |
| FE-MED-03 | Split swap partial failure leaves user in inconsistent state |

### Low

| ID | Title |
|----|-------|
| FE-LOW-01 | Spender address from server not client-validated |
| FE-LOW-02 | Race condition between quote refresh and swap execution |
| FE-LOW-03 | No scam token screening on custom import |
| FE-LOW-04 | Deprecated Permit2 domain has hardcoded chainId |

### Positive Findings (Pass)
- No XSS vectors found (no `dangerouslySetInnerHTML`)
- Router whitelist is comprehensive (all 12+ sources)
- Chainlink oracle well-implemented (stale check, deviation thresholds)
- Wallet config appropriate (mainnet only, SSR enabled)
- Fee-on-transfer tokens fail safely (revert at router level)

---

## SECTION 4: DNS / DOMAIN SECURITY

### Attack Vectors & Mitigations

#### DNS Hijacking
**Risk:** Attacker takes over `teraswap.app` DNS records, redirects users to a phishing site with a cloned UI that steals approvals.
**Real-world precedent:** Curve Finance DNS hijack (Aug 2022), BadgerDAO frontend attack (Dec 2021), SpiritSwap DNS attack.

**Current state:** Unknown — depends on domain registrar and DNS provider configuration.

**Recommended mitigations:**

1. **DNSSEC (Domain Name System Security Extensions)**
   - Enable DNSSEC on the `teraswap.app` domain
   - Prevents DNS spoofing/cache poisoning
   - Verify with: `dig +dnssec teraswap.app`
   - Most registrars (Cloudflare, Google Domains, Namecheap) support DNSSEC

2. **Registrar Lock (Transfer Lock)**
   - Enable domain transfer lock at registrar level
   - Prevents unauthorized domain transfers
   - Enable "clientTransferProhibited" status

3. **2FA on Registrar Account**
   - Enable TOTP/hardware key 2FA on the registrar account (Cloudflare, GoDaddy, etc.)
   - This is the #1 vector for DNS hijacks — stolen registrar credentials

4. **CAA Records (Certificate Authority Authorization)**
   - Add DNS CAA records to restrict which CAs can issue certificates for `teraswap.app`
   - Prevents attacker from getting a valid SSL cert from a different CA
   - Example: `teraswap.app. CAA 0 issue "letsencrypt.org"` (or your CA)

5. **HSTS Preload (Already Implemented)**
   - `next.config.js` already has `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
   - Submit to HSTS preload list: https://hstspreload.org/
   - Prevents SSL stripping attacks

6. **Certificate Transparency Monitoring**
   - Set up alerts for new certificates issued for `teraswap.app`
   - Use: https://crt.sh/?q=teraswap.app
   - Or Cloudflare's Certificate Transparency Monitoring
   - Detect unauthorized certificate issuance immediately

7. **Subresource Integrity (SRI)**
   - Add `integrity` attributes to external script/CSS tags
   - Next.js handles this for bundled assets, but verify for any CDN resources
   - Prevents CDN compromise from injecting malicious code

8. **DNS Monitoring**
   - Set up automated monitoring for DNS record changes
   - Alert on any A/CNAME/NS record modifications
   - Tools: Cloudflare notifications, DNStwist for typosquatting detection

9. **Vercel-Specific DNS Hardening**
   - If using Vercel DNS: enable Vercel's DDoS protection
   - Verify Vercel's automatic SSL certificate management
   - Check that custom domain is properly verified in Vercel dashboard

10. **ENS Domain (Optional, Web3-native)**
    - Register `teraswap.eth` as an additional verified identity
    - Display in the UI as proof of authentic domain
    - Users can verify via ENS lookup

#### DNS Attack Response Plan
If DNS is compromised:
1. Immediately revoke all token approvals via Etherscan/revoke.cash
2. Alert users via Twitter/Discord (NOT via the compromised domain)
3. Contact registrar to regain control
4. Rotate all API keys and secrets
5. Publish incident report with IOCs (IP addresses, malicious contract addresses)
6. Deploy fresh SSL certificates after recovery

---

## SECTION 5: COMPETITOR COMPARISON

### How Major Aggregators Were Exploited

| Protocol | Incident | Loss | Root Cause | TeraSwap Status |
|----------|----------|------|------------|----------------|
| KyberSwap | Elastic Pool exploit (Nov 2023) | **$47M** | Tick boundary precision error in concentrated liquidity | N/A — no pools |
| SushiSwap | RouteProcessor2 (Apr 2023) | **$3.3M** | Arbitrary external call → approval drain | **Protected** — router + selector whitelist |
| Curve | Vyper compiler reentrancy (Jul 2023) | **$70M+** | Compiler storage collision broke nonreentrant | N/A — Solidity, not Vyper |
| Curve | DNS hijack (Aug 2022) | **~$573K** | Registrar credential theft | **Needs fix** — Section 4 |
| BadgerDAO | Frontend supply chain (Dec 2021) | **$120M** | Cloudflare API key → injected approvals | **Protected** — CSP headers |
| Paraswap | Augustus V6 access control (Mar 2024) | **$5.7M at risk** | Missing access control on transferFrom | **Protected** — no generic transferFrom |
| 1inch | Clipper function vuln (Mar 2023) | **Patched** | clipperSwap could drain approved tokens | **Protected** — selector validation |
| Balancer | Read-only reentrancy (Jan 2024) | **$1.8M+** | View functions manipulated during callbacks | **Protected** — uses Chainlink, not spot |
| Ledger | Connect Kit npm attack (Dec 2023) | **$600K+** | npm package injected drain modal | **Partial** — CSP mitigates |
| CoW | Solver "Barter" manipulation (2023) | **Ongoing** | Suboptimal routing by malicious solver | N/A — no solver model |

### Historical Loss by Attack Vector

| Rank | Attack Vector | Cumulative Loss | TeraSwap? |
|------|--------------|----------------|-----------|
| 1 | Frontend/supply chain | $120M+ | Partial (CSP yes, DNS needs work) |
| 2 | Compiler bugs | $70M+ | Yes (Solidity 0.8.24) |
| 3 | AMM math errors | $47M | N/A (no pools) |
| 4 | Oracle manipulation | $10-100M | Yes (multi-oracle) |
| 5 | Approval drain | $3-6M/incident | Yes (router whitelist) |
| 6 | MEV/sandwich | Billions cumulative | Partial (CoW toggle) |

### Industry Best Practices vs TeraSwap

| Practice | 1inch | 0x | CoW | TeraSwap |
|----------|-------|-----|------|----------|
| Smart contract audit | 8+ auditors | Trail of Bits, Consensys | Extensive | Self-audited + AI review |
| Router whitelist | Yes | Yes (exchange proxy) | Yes (settlement) | Yes |
| Oracle protection | Limited | None | MEV-protected by design | Chainlink + DefiLlama + cross-quote |
| Approval management | Exact amounts | Exact amounts | Infinite (VaultRelayer) | Exact (except CoW) |
| MEV protection | Fusion mode | None | Native batch auction | CoW toggle + Chainlink deviation |
| Rate limiting | API key based | API key based | Solver competition | In-memory (needs Redis) |
| DNSSEC | Yes | Yes | Unknown | Needs implementation |
| Bug bounty | Immunefi ($1M+) | Immunefi | Immunefi | None |
| Frontend source verification | Open source | Open source | Open source | Open source |
| Transaction simulation | Yes (1inch Fusion) | No | Yes (solver simulates) | No (wallet handles) |

---

## SECTION 6: PRIORITIZED REMEDIATION PLAN

### Phase 1 — Immediate (This Week)

| # | Finding | Effort | Impact |
|---|---------|--------|--------|
| 1 | API-CRITICAL-01: Timing-safe secret comparison | 30 min | Prevents token brute-force |
| 2 | FE-HIGH-01: Split swap calldata validation | 1 hour | Closes largest frontend gap |
| 3 | API-HIGH-04: Rate limit /api/quote | 30 min | Prevents API key exhaustion |
| 4 | API-HIGH-05: Validate addresses in quote POST | 15 min | Consistency fix |
| 5 | API-HIGH-03: Fix CORS on monitor endpoint | 15 min | Prevents cross-origin exfiltration |
| 6 | FE-MED-01: Align slippage UI cap to 15% | 15 min | Prevents user confusion |
| 7 | SC-LOW-02: Fix OrderExecuted event ABI mismatch | 30 min | Fixes broken event decoding |
| 8 | DNS: Enable DNSSEC + registrar 2FA + CAA records | 1 hour | Critical infra protection |

### Phase 2 — Short Term (2 Weeks)

| # | Finding | Effort |
|---|---------|--------|
| 9 | SC-CRITICAL-02: Enforce routerDataHash for non-DCA | Contract upgrade |
| 10 | SC-HIGH-02: Timelock setExecutor | Contract upgrade |
| 11 | API-HIGH-02: Origin check on log endpoints | 1 hour |
| 12 | API-MED-05: Sanitize error messages | 2 hours |
| 13 | API-MED-07: Remove wallet addresses from public analytics | 1 hour |
| 14 | SC-HIGH-01: Balance-delta pattern for FeeCollector | Contract upgrade |
| 15 | Set up Certificate Transparency monitoring | 30 min |
| 16 | Submit domain to HSTS preload list | 15 min |

### Phase 3 — Medium Term (1 Month)

| # | Finding | Effort |
|---|---------|--------|
| 17 | SC-CRITICAL-01: FeeCollector router whitelist | Contract V2 |
| 18 | API-MED-01: Redis-based rate limiting (Upstash) | 4 hours |
| 19 | SC-MED-02: DCA minAmountOut per-execution validation | Contract upgrade |
| 20 | SC-MED-05: Max order expiry enforcement | Contract upgrade |
| 21 | Bug bounty program on Immunefi | Setup + funding |
| 22 | Professional third-party smart contract audit | 2-4 weeks |

---

## APPENDIX: FULL FINDINGS INDEX

| ID | Severity | Category | Title |
|----|----------|----------|-------|
| SC-CRITICAL-01 | Critical | Smart Contract | FeeCollector no router validation |
| SC-CRITICAL-02 | Critical | Smart Contract | DCA routerDataHash bypass for non-DCA |
| SC-CRITICAL-03 | Critical* | Smart Contract | State update after external call (mitigated) |
| SC-HIGH-01 | High | Smart Contract | Fee-on-transfer token accounting |
| SC-HIGH-02 | High | Smart Contract | setExecutor not timelocked |
| SC-HIGH-03 | High | Smart Contract | No Chainlink feed whitelist |
| SC-HIGH-04 | High | Smart Contract | Rebasing token underflow |
| SC-MED-01 | Medium | Smart Contract | No ERC-20 refund in swapETHWithFee |
| SC-MED-02 | Medium | Smart Contract | DCA minAmountOut rounds to zero |
| SC-MED-03 | Medium | Smart Contract | Sweep sends to admin |
| SC-MED-05 | Medium | Smart Contract | No max order expiry |
| SC-MED-06 | Medium | Smart Contract | sweep lacks ReentrancyGuard |
| SC-MED-07 | Medium | Smart Contract | canExecute missing checks |
| SC-LOW-01 | Low | Smart Contract | Test file stale hash |
| SC-LOW-02 | Low | Smart Contract | Event ABI mismatch |
| SC-LOW-03 | Low | Smart Contract | Zero-fee on tiny amounts |
| API-CRITICAL-01 | Critical | API | Non-timing-safe secret comparison |
| API-CRITICAL-02 | Critical | API | MONITOR_SECRET likely unset |
| API-HIGH-01 | High | API | Service role bypasses all RLS |
| API-HIGH-02 | High | API | No auth on log endpoints |
| API-HIGH-03 | High | API | CORS wildcard on monitor |
| API-HIGH-04 | High | API | No rate limit on /api/quote |
| API-HIGH-05 | High | API | Quote POST missing validation |
| API-MED-01 | Medium | API | In-memory rate limiting |
| API-MED-02 | Medium | API | Order status not validated |
| API-MED-03 | Medium | API | Unscoped PATCH fallback |
| API-MED-04 | Medium | API | Global order stats no auth |
| API-MED-05 | Medium | API | Error message info leaks |
| API-MED-06 | Medium | API | setInterval leak in RPC |
| API-MED-07 | Medium | API | Wallet addresses in analytics |
| FE-HIGH-01 | High | Frontend | Split swap missing validations |
| FE-MED-01 | Medium | Frontend | Slippage cap mismatch |
| FE-MED-02 | Medium | Frontend | CoW infinite approval |
| FE-MED-03 | Medium | Frontend | Split swap partial failure UX |
| FE-LOW-01 | Low | Frontend | Spender not client-validated |
| FE-LOW-02 | Low | Frontend | Quote/swap race condition |
| FE-LOW-03 | Low | Frontend | No scam token screening |
| FE-LOW-04 | Low | Frontend | Deprecated Permit2 domain |
| DNS-01 | High | Infrastructure | DNSSEC not enabled |
| DNS-02 | High | Infrastructure | CAA records missing |
| DNS-03 | Medium | Infrastructure | Certificate transparency not monitored |
| DNS-04 | Medium | Infrastructure | HSTS preload not submitted |
| EXT-H-01 | High | External | KV rate limiter fails open (CLOSED `aaa1f19`) |
| EXT-H-02 | High | External | Split swap UI hides non-atomicity / MEV (CLOSED `bbedec0`) |
| EXT-H-03 | High | External | Circuit breaker alert-only on mass disablement (CLOSED `926cd7b`) |
| EXT-H-04 | High | External | FeeCollector lacks on-chain minimumOutput (CLOSED `94cb469`/`8097a86`/`f657a30`) |
| EXT-M-01 | Medium | External | Zero React component/hook test coverage (CLOSED Phase 1 `79f6a81`/`33e93e9`) |
| EXT-M-02 | Medium | External | Circuit breaker state not synced from KV on cold start (CLOSED `527a12f`) |
| EXT-M-03 | Medium | External | Supabase service_role bypasses RLS in fire-and-forget paths (CLOSED `066876d`) |
| EXT-M-04 | Medium | External | Grace-period alert inconsistency across channels (CLOSED `433a16d`) |
| EXT-M-05 | Medium | External | On-chain monitor scans every 5th tick (CLOSED `8b1e9c6`) |
| EXT-L-01 | Low | External | Backlog — pending triage (Sprint 17+) |
| EXT-L-02 | Low | External | Backlog — pending triage (Sprint 17+) |
| EXT-L-04 | Low | External | Backlog — pending triage (Sprint 17+) |

**Total: 5 Critical, 16 High, 23 Medium, 14 Low = 58 findings**
**External analysis subtotal (Section 8): 4 High CLOSED, 5 Medium CLOSED, 3 Low backlog. EXT-L-03 was already mitigated on review (not counted).**

---

## SECTION 7: DEPENDENCY & INFRASTRUCTURE FINDINGS

### High

#### [DEP-HIGH-01] socket.io-parser Vulnerability (Unbounded Binary Attachments)
**Package:** `socket.io-parser` 4.0.0-4.2.5 (GHSA-677m-j7p3-52f9)
**Impact:** Denial of service via crafted binary attachments.
**Fix:** `npm audit fix`

### Medium

#### [DEP-MED-01] .env.production Exists on Disk with Real Addresses
**Description:** `/Users/tiagocruz/Desktop/Claude/dex-aggregator 2/.env.production` contains real wallet addresses. While `.gitignore` should prevent tracking, verify with `git ls-files | grep .env`.
**Fix:** Confirm not tracked. If tracked, remove from git history with `git rm --cached`.

### Low

| ID | Title | Fix |
|----|-------|-----|
| DEP-LOW-01 | `@capacitor/cli` in dependencies instead of devDependencies | Move to devDependencies |
| DEP-LOW-02 | Mobile app loads from remote URL — susceptible to domain compromise | Consider certificate pinning |
| DEP-LOW-03 | `order_executions` no anon SELECT policy — client DCA reads may silently fail | Add policy or route through API |

### Positive Findings (Pass)
- Next.js security headers: comprehensive CSP, HSTS, X-Frame-Options DENY
- Source maps hidden from browser (Sentry only)
- Zero `console.log()` in production code
- `seedDemoData()` double-guarded (tree-shaking + runtime check)
- API keys properly server-only with explicit NEXT_PUBLIC_ guard
- `.gitignore` correctly excludes all `.env` files
- Service Worker correctly never caches API/data requests
- All dependencies from trusted, high-download npm packages

---

## SECTION 8: EXTERNAL ANALYSIS FINDINGS

> **Source:** `Audits/TeraSwap-Technical-Analysis-2026-04-22.pdf` (paid external technical analysis, 2026-04-22)
> **Closure status (2026-05-13):** 4 High CLOSED, 5 Medium CLOSED, 3 Low in backlog.

### High (4 CLOSED)

| ID | Title | Sprint | Commit | Status |
|----|-------|--------|--------|--------|
| EXT-H-01 | KV rate limiter fails open on Upstash outage | 9A | `aaa1f19` | ✅ CLOSED — in-memory fallback added |
| EXT-H-02 | Split swap UI hides non-atomicity / MEV exposure | 9A | `bbedec0` | ✅ CLOSED — explicit warning in SplitRouteVisualizer |
| EXT-H-03 | Circuit breaker alert-only (no halt) on mass disablement | 9A | `926cd7b` | ✅ CLOSED — alert-and-halt with `/cleartrip` admin command |
| EXT-H-04 | FeeCollector cannot enforce minimum output if router misbehaves | 9B | `94cb469` (contract) + `8097a86` (frontend) + `f657a30` (deploy) | ✅ CLOSED — FeeCollector V2 with on-chain `minimumOutput` validation |

### Medium (5 CLOSED)

| ID | Title | Sprint | Commit | Status |
|----|-------|--------|--------|--------|
| EXT-M-01 | Zero integration test coverage on React components/hooks | 16A | `79f6a81` (hooks) + `33e93e9` (components) | ✅ CLOSED — Phase 1: 4 security-critical hooks + 3 components |
| EXT-M-02 | Circuit breaker state not synced from KV on cold start | 16A | `527a12f` | ✅ CLOSED — pre-seed adapter breakers from KV |
| EXT-M-03 | Supabase service_role bypasses RLS for fire-and-forget logging | 16A | `066876d` | ✅ CLOSED — least-privilege INSERT-only logger role |
| EXT-M-04 | Grace-period alert inconsistency across channels | 16A | `433a16d` | ✅ CLOSED — uniform `[GRACE]` tagging across all channels |
| EXT-M-05 | On-chain monitor scans every 5th tick (event lag) | 16A | `8b1e9c6` | ✅ CLOSED — scan on every tick (60s cadence) |

### Low (3 in BACKLOG)

| ID | Title | Target | Status |
|----|-------|--------|--------|
| EXT-L-01 | (Pending triage — see source PDF) | Sprint 17+ | 📋 BACKLOG |
| EXT-L-02 | (Pending triage — see source PDF) | Sprint 17+ | 📋 BACKLOG |
| EXT-L-04 | (Pending triage — see source PDF) | Sprint 17+ | 📋 BACKLOG |

> **Note:** EXT-L-03 (Telegram callback admin validation) was reviewed in Sprint 9A and found to be **already mitigated** by `ADMIN_CALLBACK_ACTIONS` in `src/app/api/telegram/webhook/route.ts:90` — it restricts `activate`/`keep`/`escalate` to admins, while `ack` is intentionally open to all group members.

### Summary

- All HIGH-severity external findings were closed before Sprint 9B mainnet readiness.
- All MEDIUM-severity external findings were closed in Sprint 16A backlog-cleanup sprint.
- LOW-severity items are scheduled for Sprint 17+ technical-debt cleanup; none gate Phase 2 work.
- Detailed remediation context: `docs/Prompts/SPRINT-9A.md`, `docs/Prompts/SPRINT-9B.md`, `docs/Prompts/SPRINT-16A.md`.

---

> This audit was performed using automated analysis agents. A professional third-party audit by a reputable firm (Trail of Bits, OpenZeppelin, Consensys Diligence) is recommended before handling significant TVL.

---

## Full-codebase audit — 2026-06-02 (post-Base-launch)

**Source:** `Audits/FULL-AUDIT-2026-06-02.md` (9 parallel read-only agents). **Raw result:** 0
Critical, 0 High, 12 Medium, 25 Low, 17 Info. No fund-loss / auth-bypass / gate-bypass found.

**Architect re-rating.** The 12 Mediums share one root cause — **safety/oracle gates not made
chain-aware** — and were rated under a stale "Base coming-soon" premise. **Base is LIVE**
(`isChainActive(8453)===true`), so the following are OPEN and re-rated **HIGH** (active on live Base
swaps); remediation = **SPRINT-9G** (`docs/Prompts/SPRINT-9G.md`), version A (Base stays live).
Security gates → Auditor-reviewed, not auto-applied.

| ID | Re-rated | Issue | → |
|----|----------|-------|---|
| M04/M06 | **HIGH** | Chainlink feed + L2 sequencer use mainnet-pinned client → Base oracle validation broken (rule #9) | 9G G1 |
| M07/M11 | **HIGH** | DefiLlama >$10k guard hardcodes `ethereum` → Base sub-$10k fail-open, >$10k over-block | 9G G2 |
| M12 | **HIGH** | Post-exec balance validator mainnet-pinned → dead on Base (no auto-disable) | 9G G3 |
| M03/M05/L06 | MEDIUM | `isChainActive` client-side only — `/api/swap`,`/api/quote`,`/api/spender` no server check | 9G G4 |
| M08 | MEDIUM | `useTokenBalances` not chain-aware → Base balances never render | 9G G5 |
| hooks | MEDIUM | `useSwap`/`useSplitSwap` use wagmi `useChainId()` vs `useActiveChainId()` — two sources of truth | 9G G6 |
| balancer | MED/LOW | Balancer adapter not fail-closed on `tx.to` whitelist (unlike Bebop) | 9G G7 |
| feeTier/startedAt | LOW | feeTier cache key uses static `CHAIN_ID`; swap-path Chainlink omits `startedAt>0` guard | 9G G8 |

**Safe cleanups applied** (branch `chore/full-audit-cleanup`, 3 signed commits, dead code only,
1357 tests green). Remaining 25 Low / 17 Info → backlog (incl. stale DEPLOY.md — FeeCollector +
simulation are in fact already chain-aware).

---

### Sprint 9G Audit (2026-06-02) — Chain-Aware Safety Gates

**Verdict: APPROVED — 0C / 0H / 0M / 1L / 2I.** Report: `Audits/Sprint/SPRINT-9G-AUDIT.md`.
All 8 re-rated findings above (G1–G8) are now **CLOSED**. Mainnet byte-identical verified on every
gate. Rule #9 (Chainlink + DefiLlama on Base) genuinely satisfied. 1391 tests (+34).

| Gate | Finding(s) | Status |
|------|-----------|--------|
| G1 — Chainlink + sequencer | M04, M06 | ✅ CLOSED |
| G2 — DefiLlama >$10k | M07, M11 | ✅ CLOSED |
| G3 — Post-exec validator | M12 | ✅ CLOSED |
| G4 — Server-side gate | M03, M05, L06 | ✅ CLOSED |
| G5 — Token balances | M08 | ✅ CLOSED |
| G6 — Chain-id source | hooks | ✅ CLOSED |
| G7 — Balancer whitelist | balancer | ✅ CLOSED (9G-L-01: BatchRelayer risk, fail-safe) |
| G8 — Cache + startedAt | feeTier/startedAt | ✅ CLOSED |

Deploy via Vercel Preview gate → verify Base oracle/guard/validator → promote.

---

### Sprint 9H Audit (2026-06-02) — Base Execution Fixes

**Verdict: APPROVED — 0C / 0H / 0M / 0L / 1I.** Report: `Audits/Sprint/SPRINT-9H-AUDIT.md`.
Found on 9G Preview. Two fixes: Velora selector allowlist + Bebop fail-soft. 1399 tests (+8).

| Fix | Description | Status |
|-----|------------|--------|
| 9H-1 — Velora selectors | Augustus V6.2 `swapExactAmountInOnCurveV1` (0x1a01c532) + `...V2` (0xe37ed256) added to selector allowlist, recipient gate, and tx-preview decoder. Same trust class as existing ParaSwap methods. Only 2 methods added (no blind widening). | ✅ CLOSED |
| 9H-2 — Bebop fail-soft | Demo-mode (no key) → `fetchQuote` returns null (doesn't rank). Absent settlement → `fetchSwapData` returns null (breaker-neutral). Security gates intact when data present-but-wrong (still throw). | ✅ CLOSED |

**Bundle 9G + 9H → Vercel Preview → verify Velora + Kyber on Base + Bebop no longer wins-then-fails → promote.**

---

### Sprint 9J Audit (2026-06-03) — Swap UX/Reliability

**Verdict: APPROVED — 0C / 0H / 0M / 0L / 2I.** Report: `Audits/Sprint/SPRINT-9J-AUDIT.md`.
Three live fixes. J1 is the security-relevant change (deviation gate). 1443 tests (+45).

| Fix | Risk | Description | Status |
|-----|------|------------|--------|
| J1 — Deviation gate | HIGH (security gate) | Classifies oracle-integrity failures (stale/invalid → HARD block) vs price-impact deviations on healthy oracle (→ informed consent). Extreme deviation >25% ceiling also hard-blocks. Server-side DefiLlama guard and on-chain minimumOutput untouched. All genuine protections verified preserved. | ✅ APPROVED |
| J2 — Swap-build timeout | HIGH/MED | 12s timeout + AbortController + 2× retry on swap-build fetches. Build-only (no double on-chain submit). Error sanitization strips API keys. `/api/swap` always returns JSON. | ✅ APPROVED |
| J3 — Info tooltips | LOW | Accessible `InfoTooltip` component. Opens on click+hover. No XSS (content rendered as text). | ✅ APPROVED |

J1 approved for production. J2/J3 may ship via Preview gate.

---

### ADR-011 Light Review (2026-06-03) — FeeCollector Augustus Whitelist

**Verdict: APPROVED — 0 findings.** ADR: `docs/ADR/ADR-011-feecollector-augustus-whitelist.md`.

Whitelisting ParaSwap/Velora Augustus V6 (`0x6A000F20005980200259B80c5102003040001068`) on mainnet
FeeCollector V2 (`0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459`) via timelocked governance
(`queueRouterChange` → 48h → `executeRouterChange`).

| Check | Result |
|-------|--------|
| Address is the legit Augustus V6 | ✅ Confirmed in `routers.ts` (chains 1+8453), `api.ts` (ROUTER_WHITELIST), 9H selector audit, 9O on-chain decode, Base FeeCollector (already whitelisted) |
| No open AUDIT-TOTAL finding opposes | ✅ SC-CRITICAL-01 (no router validation) was CLOSED by V2 which HAS the whitelist. Adding a known router is the intended use of that control. |
| No selector added (9H concern N/A) | ✅ Augustus `0xe3ead59e` + 9H Curve methods already in the 22-selector allowlist. This is a contract STATE change, not a code change. |
| Default-deny control + 48h timelock intact | ✅ The whitelist remains default-deny. The 48h timelock is the safety buffer. Rollback via `queueRouterChange(Augustus, false)`. |

**This is NOT a redeploy** — it is a governance state change on the existing FeeCollector V2 contract.

---

### Sprint 9R Audit (2026-06-04) — Review Integrity

**Verdict: APPROVED — 0C / 0H / 0M / 0L / 1I.** Report: `Audits/Sprint/SPRINT-9R-AUDIT.md`.
Principle: NO wallet signature without a TeraSwap review of the exact FROZEN calldata.

| Fix | Description | Status |
|-----|------------|--------|
| R2 — Frozen single-swap modal | TransactionPreview renders `pendingSwap.tokenIn`/`tokenOut`/`swapToAmount` (frozen at build-time), not live quote state. | ✅ APPROVED |
| R1 — Two-phase split review | Phase A (execute): build + validate + simulate + freeze `PlannedLeg[]` → `'awaiting-review'`. Phase B (confirmPlan): sign frozen legs 1:1. No `sendTransactionAsync` in Phase A. | ✅ APPROVED |
| Audit remediation | Chain/account switch with review modal open → plan invalidated (reset effects + confirmPlan chainId/address re-check). Phase-B re-entry guard. TokenSelector.onSelect resets split hook. | ✅ APPROVED |

Scope: display/flow-control only — no changes to gates, simulation, FeeCollector routing, adapters, or selectors.

---

### Sprint 9S Light Review (2026-06-05) — Base Oracle Polish

**Verdict: APPROVED — 0C / 0H / 0M / 0L / 0I.** S1 commit `521074a` (+ S2 `c504740`, S3 `f3204ab`).

**S1 — Base Chainlink feeds verified against the official Chainlink reference-data-directory:**

| Token | Feed | proxyAddress in directory | description() | decimals() | Match |
|-------|------|--------------------------|---------------|-----------|-------|
| USDC (0x8335…2913) | USDC/USD | `0x458138Fc0D67027E9A6778ef40a6ffC318c69061` | "USDC / USD" | 8 | ✅ EXACT |
| DAI (0x50c5…B0Cb) | DAI/USD | `0x591e79239a7d679378eC8c847e5038150364C78F` | "DAI / USD" | 8 | ✅ EXACT |

**cbETH + USDbC correctly LEFT UNMAPPED:** cbETH on Base publishes only `cbETH/ETH` (exchange rate,
18 decimals — ETH-denominated, NOT USD). No `cbETH/USD` feed exists in the directory. USDbC has no
Chainlink feed at all. Both fall through to null → multi-source compare + on-chain minimumOutput.
Rule #9 satisfied: no guessing.

**S2 — direction-agnostic oracle verdict:** `evaluatePairOracle` merges input + output checks
symmetrically. No threshold change. Integrity failures propagate from EITHER side. Tests verify
ETH→USDC ≡ USDC→ETH verdict.

**S3 — breakers/links/diagnostics:** chain-aware explorer links, per-chain circuit breakers, Bebop
diagnostic. No gate/staleness/threshold changes.

**No gate/staleness/threshold loosening anywhere in the branch.** Mainnet feed map untouched (test:
Base token addresses → null on chainId 1). All 4 commits SSH-signed.

---

### Sprint 9T Light Review (2026-06-05) — Partner Fees (0x + CoW)

**Verdict: APPROVED — 0C / 0H / 0M / 0L / 0I.** 5 commits (3386c42, 0ad9baa, 408cf27, 674f57c, 7182144). All SSH-signed.

| Check | Result |
|-------|--------|
| FEE_RECIPIENT everywhere (env/constant) | ✅ 0x: `swapFeeRecipient = FEE_RECIPIENT`. CoW: `partnerFee.recipient = FEE_RECIPIENT` + `referrer.address = FEE_RECIPIENT`. Never hardcoded, never a different address. |
| Single FEE_BPS source of truth | ✅ `FEE_BPS = 10` (0.1%) used by FeeCollector (minimumOutput math), Bebop (`fee`), 0x (`swapFeeBps`), CoW (`partnerFee.bps`). Test pins `FEE_BPS === 10`. |
| No-double-charge invariant | ✅ 0x/CoW/Bebop in `FEE_INCOMPATIBLE_SOURCES` → `usesFeeCollector` returns false → partner fee XOR FeeCollector, never both. Invariant test covers all 3 sources on chainId 1. |
| Native-ETH fix (674f57c) | ✅ `swapFeeToken = sellIsNative ? dst : src` — native ETH sentinel is never sent as swapFeeToken. Test: ETH SELL → fee on buy token (USDC); ERC-20 SELL → fee on sell token. |
| CoW fail-soft | ✅ `isAppDataRejection` only matches status 400 + appData/partnerFee in description. Other errors (NoLiquidity, 5xx) throw immediately (no retry). On failsoft: drops partnerFee from appData, retries once. appData⇄appDataHash consistency preserved (CoW echoes the hash; parseCowOrderParams validates it; submitCowOrder signs it). |
| Normalized quotes post-fee | ✅ 0x: `buyAmount` is already post-fee (0x deducts from sell side). CoW: `buyAmount` reflects the partnerFee deduction. Both applied to quote AND swap-build → Compare is fair. |

---

### Sprint 9U Light Review (2026-06-08) — EIP-712 Review Gates

**Verdict: APPROVED — 0C / 0H / 0M / 0L / 1I.** Report: `Audits/Sprint/SPRINT-9U-AUDIT.md`.
4 commits (6c0027b, f7539af, 4dadedc, 3186b48). All SSH-signed. 13 files, +980/−137, +20 tests.
Principle: NO EIP-712 signature without TeraSwap review of the exact FROZEN typed-data payload.

| Fix | Description | Status |
|-----|------------|--------|
| U1 — CoW order review gate | `executeCowSwap` = Phase A (build + freeze `PendingCowOrder` with domain/types/message → `'cow_awaiting_review'`). `confirmCowOrder` = Phase B (signs frozen payload 1:1). No `signTypedDataAsync` in Phase A. CowOrderReviewModal renders exclusively from frozen struct. | ✅ APPROVED |
| U2 — Order Engine review gate | `createOrder` = Phase A (build + freeze `PendingOrderReview` with OnChainOrder + computedHash). `confirmOrder` = Phase B (signs frozen struct 1:1). Covers Limit, DCA, SL/TP via single hook. No `signTypedDataAsync`/`writeContractAsync` in Phase A. OrderReviewModal renders exclusively from frozen struct. | ✅ APPROVED |
| Audit follow-up (3186b48) | Expiry-freshness guard: `confirmCowOrder` rejects if `validTo ≤ now`; `confirmOrder` rejects if `expiry ≤ now`. Prevents signing dead-on-arrival orders. Surfaces `priceFeed`/`routerDataHash` in OrderReviewModal. | ✅ APPROVED |
| Chain/account invalidation | Both hooks: `prevChainIdRef`/`prevAddressRef` reset effects + synchronous confirm-time re-check (9R pattern). Holds independent of React effect timing. | ✅ APPROVED |

Cancel/invalidate signatures un-gated (creation-only per spec) — defensive ops, not a bypass. Acceptable as follow-up.
Scope: display/flow-control only — no EIP-712 domain/types/struct changes, no contract changes, no gate/adapter/selector changes.

---

### Sprint 9V Audit (2026-06-08) — Per-Feed Chainlink Staleness + Composed cbETH/USD

**Verdict: APPROVED — 0C / 0H / 1M (CLOSED `7dd84f0`) / 0L / 2I.** Report: `Audits/Sprint/SPRINT-9V-AUDIT.md`.
⚠️ **SAFETY GATE MODIFICATION** — modifies Chainlink staleness validation (rule #9).
Branch: `feat/sprint-9v-per-feed-staleness`. 3 commits (92c4dbe, 68b1b09, 41c8dba). All SSH-signed. +305/−27 lines, +11 tests.

| Check | Result |
|-------|--------|
| NO LOOSENING — staleness = heartbeat×1.5, shared by raw gate + UI hook | ✅ Single `getFeedStalenessSec(feed, globalFallback)` called by BOTH consumers. 37h USDC/USD → STALE (test-pinned). validateRoundData integrity guards (answer>0, answeredInRound, startedAt) byte-identical. |
| Heartbeats verified vs Chainlink directory | ✅ ETH/USD 1200, USDC/USD 86400, DAI/USD 86400 — all proxy + heartbeat EXACT match. ⚠️ cbETH/ETH heartbeat 86400 CORRECT but proxy address mismatch (see 9V-M-01). |
| Mainnet byte-identical | ✅ No mainnet feeds in FEED_HEARTBEAT_SEC → global fallback preserved (raw=3600, UI=90000). Test-pinned. |
| Composed cbETH/USD = cbETH/ETH × ETH/USD | ✅ Per-leg decimal normalisation (no $1.08 bug). Both legs independently integrity+staleness checked. Either leg fails → null (no partial pricing). updatedAt = min(legs). Sequencer check once before legs. |
| Scope — other safety gates untouched | ✅ Zero changes to deviation thresholds, DefiLlama guard, sequencer check, price-gate, post-exec validator, selectors, calldata-recipient, constants. No contract changes. |

| ID | Severity | Description |
|----|----------|-------------|
| 9V-M-01 | **MEDIUM → CLOSED** | cbETH/ETH proxy `0x806b4Ac0…` confirmed correct via on-chain `cast` (`7dd84f0`). Base has 3 cbETH feeds; audit matched the Exchange-Rate entry (`0x868a…`), not the market feed. Address unchanged; +2 pinning tests. Follow-up: direct CBETH/USD feed discovered (`0xd7818272…`). |
| 9V-I-01 | INFO | V2 composition is raw-path only; UI hook still shows "no oracle" for cbETH on Base. Display inconsistency, not security — swap path has oracle protection. Follow-up: UI-side composed display. |
| 9V-I-02 | INFO | Base ETH/USD tightened 3600→1800s (heartbeat×1.5). More conservative (not loosening). Behaviour delta: 30-60min stale rounds now fail. Safe — feed updates every ≤20min. |

---

### Sprint 9W-oracle Audit (2026-06-08) — cbETH Depeg / Manipulation Circuit-Breaker

**Verdict: APPROVED — 0C / 0H / 0M / 0L / 3I.** Report: `Audits/Sprint/SPRINT-9W-ORACLE-AUDIT.md`.
⚠️ **NEW SAFETY GATE** — adds a depeg circuit-breaker on top of existing oracle infrastructure (rule #9). Does NOT modify any existing gate.
Branch: `feat/sprint-9w-oracle-depeg-breaker`. 4 commits (f08d0cc, 6b4f8b6, 070ead9, 21ba309). All SSH-signed. +534/−17 lines, +20 tests.

| Check | Result |
|-------|--------|
| Swap-price reference unchanged (9V market feed 0x806b…) | ✅ chainlink.ts, useChainlinkPrice.ts, price-gate.ts have ZERO changes. ER feed (0x868a…) read ONLY in useDepegCheck, passed ONLY to evaluateDepeg — never enters pricing. |
| Divergence = \|market−ER\|/ER, thresholds 2%→consent / ≥10%→hard-block | ✅ mode:'block' renders no checkbox ("cannot be overridden"). mode:'consent' requires checkbox. Consent auto-revokes at accepted+0.5%. Resets on every trade-param change (9J pattern). Test-pinned at all boundaries. |
| Fail-open: either leg stale/invalid → 'ok' (no false block) | ✅ priceFromValidRound null→evaluateDepeg→'ok'. Cannot be abused: user cannot make a fresh feed appear stale without RPC compromise (self-griefing). Defense-in-depth: DefiLlama + on-chain minimumOutput bound loss. |
| priceFromValidRound startedAt>0 check | ✅ Stricter than useChainlinkPrice (which omits startedAt). Fail-open direction — can only cause 'ok' (no verdict), never a false block. Conservative and sound. |
| Data-driven registry (EXCHANGE_RATE_PAIRS_BY_CHAIN) | ✅ Only cbETH on Base. Mainnet: no entries. Non-cbETH: returns null → no RPC reads, no friction. Extensible for future LSTs. |
| Scope: no 9J/9V/9S loosening, no contracts, mainnet byte-identical | ✅ Zero changes to chainlink.ts, useChainlinkPrice.ts, price-gate.ts, defillama.ts, sequencer-check.ts, selectors, calldata-recipient, constants (thresholds/deviation). FEED_HEARTBEAT_SEC: +1 additive entry (ER feed). No contract changes. |

| ID | Severity | Description |
|----|----------|-------------|
| 9W-I-01 | INFO | Hook checks tokenIn first, then tokenOut — if both tokens have ER pairs, only one gets checked. Acceptable for current single-entry registry. |
| 9W-I-02 | INFO | priceFromValidRound checks startedAt>0 but useChainlinkPrice does not — minor inconsistency, safe direction (depeg legs stricter). |
| 9W-I-03 | INFO | Breaker is client-side only (matching 9J). A server-side divergence check in /api/swap would strengthen defense against manipulated market feeds reaching the server. Bounded by DefiLlama + minimumOutput. Clean follow-up, not a gate. |

### Sprint 9Y Light Review (2026-06-08) — Expanded Pinned Token Catalog (Matcha-style)

**Verdict: APPROVED — 0C / 0H / 0M / 0L / 2I.** Report: `Audits/Sprint/SPRINT-9Y-AUDIT.md`.
⚠️ **ADDRESS CORRECTNESS** — wrong address = scam token. Catalog sourced from pinned vendored Uniswap Labs Default v21.3.0, validated via viem `getAddress` (EIP-55) + chainId + integer decimals. Re-generation confirmed BYTE-IDENTICAL to committed file.
Branch: `feat/sprint-9y-token-catalog`. 2 commits (7d144e0, c5bdb9e). Both SSH-signed. +20945/−41 lines, 389 mainnet + 97 Base tokens.

| Check | Result |
|-------|--------|
| Catalog source: pinned vendored Uniswap snapshot, generator deterministic | ✅ SHA256 verified. Re-run in sandbox → byte-identical output. No drift, no hand edits. |
| Address spot-check: top 13 mainnet + 12 Base majors | ✅ All canonical. USDT Base verified on BaseScan (583k holders, correct symbol/decimals). |
| Pre-existing 5 Base addresses match catalog | ✅ WETH, USDC, DAI, cbETH, USDbC — all identical between old hardcoded list and generated catalog. |
| Non-Uniswap addition: USDT Base (CoinGecko-sourced) | ✅ `0xfde4C96c…` confirmed canonical Bridged Tether USD on Base. Passes same validate() pipeline. |
| Mainnet DEFAULT_TOKENS byte-identical (ADD-only) | ✅ `getChainTokenList(1) === DEFAULT_TOKENS` (strict identity, test-pinned with `toBe`). Long tail is additive via getFullCatalog. |
| Verified ✓ vs imported ⚠ (9P intact) | ✅ Catalog tokens → ✓ on their chain. Imports → ⚠. Cross-chain isolation preserved. |
| USDe non-canonical checksum (FEEDBACK) | ✅ Pre-existing, out of 9Y scope. One-line follow-up. |
| Scope: no existing gate loosening, no contracts | ✅ Zero changes to oracle, pricing, DeFi, API, or contract code. |

| ID | Severity | Description |
|----|----------|-------------|
| 9Y-I-01 | INFO | Pre-existing: USDe in DEFAULT_TOKENS has non-canonical EIP-55 checksum. Lowercase address is correct (no funds risk). One-line re-checksum follow-up. |
| 9Y-I-02 | INFO | Single non-Uniswap entry (USDT Base, CoinGecko-sourced) breaks single-source provenance. BaseScan-verified correct. FEEDBACK flags for owner confirmation. |

### Sprint 9Z Light Review (2026-06-08) — Mobile WalletConnect (wallet list + session guard + RainbowKit 2.2.10)

**Verdict: APPROVED — 0C / 0H / 0M / 0L / 3I.** Report: `Audits/Sprint/SPRINT-9Z-AUDIT.md`.
⚠️ **AUTH CONTROL** — Part B touches the 1h idle auto-disconnect (WalletSessionGuard). The stale-baseline mount-time expiry check — which killed fresh mobile WC connections — is removed. The 1h idle setTimeout (reset on user interaction) is preserved and test-pinned at the 59m/61m boundary.
Branch: `feat/sprint-9z-mobile-walletconnect` / PR #155. 4 commits (cb5a5cf, b6c49af, d93f644, 4b6f3b2). All SSH-signed. +472/−47 lines, +199 test lines.

| Check | Result |
|-------|--------|
| 1h idle auto-disconnect preserved | ✅ Test-pinned: 59min no disconnect, 61min disconnects. User activity resets timer. Genuine idle still triggers. |
| Fresh connect not killed by stale baseline | ✅ Stale connectedAt (2h old) + new connect → no disconnect. Visibility change during handshake → no disconnect. |
| sessionStorage fail-soft | ✅ Safari private mode (setItem throws) → guard doesn't crash, in-memory timer still governs. Test-pinned. |
| Wallet list: additive only, no trust change | ✅ 6 wallets (rabby/metaMask/coinbase/walletConnect/ledger/injected), all from @rainbow-me/rainbowkit/wallets. Same projectId/metadata (9K). Exact-set test. UA-independent (fixes mobile hiding). |
| RainbowKit 2.2.10 (not 2.2.11) — AGPL avoidance | ✅ 2.2.11 pulls ua-parser-js@2.0.10 (AGPL-3.0). 2.2.10 ships all mobile fixes (2.2.7/2.2.8/2.2.10), stays MIT. ua-parser-js: ^1.0.37 in lockfile (MIT). Rationale documented in FEEDBACK. |
| Single @walletconnect/core preserved | ✅ 1 instance at 2.21.1 (lockfile verified). Overrides pin core/sign-client/universal-provider. Direct @walletconnect/ethereum-provider dep removed (transitive). |
| No wagmi v3, mainnet byte-identical | ✅ wagmi 2.19.5, viem 2.47.4 — both unchanged. No contract/oracle/API changes. |

| ID | Severity | Description |
|----|----------|-------------|
| 9Z-I-01 | INFO | Auth control is now "1h since last connect/interaction" (not absolute cap). Acceptable: reload is activity, no major dApp has absolute cap, genuine idle disconnects. Separate control if hard cap ever needed. |
| 9Z-I-02 | INFO | RainbowKit #2232 (WC multi-instance "No matching key") NOT fixed by 2.2.x — root cause in wagmi WC-connector reconnect. Track at wagmi level. |
| 9Z-I-03 | INFO | AGPL avoidance rationale is in FEEDBACK. Consider a brief ADR if licensing decision needs to survive beyond append-only FEEDBACK. |

### Sprint E-2 Audit (2026-06-11) — L2 Sequencer-Uptime Gate on Quote Path

**Verdict: APPROVED — 0C / 0H / 0M / 0L / 2I.** Report: `Audits/Sprint/SPRINT-E2-AUDIT.md`.
⚠️ **SECURITY GATE (rule #9)** — extends L2 sequencer-uptime protection to the quote path (`fetchMetaQuote`/`/api/quote`). The existing Chainlink price-read gate (P218, `chainlink.ts`) is **UNTOUCHED**.
Branch: `fix/e2-sequencer-quote-gate` / PR #165. 2 commits (9604e43, d8bdaa0). Both SSH-signed. +182/−1 lines, +4 tests.

| Check | Result |
|-------|--------|
| ADDITIVE only — existing price-read sequencer gate (chainlink.ts) untouched | ✅ Zero changes to chainlink.ts, price-gate.ts, defillama.ts, adapters, swap route, constants. New gate is a SECOND consumer of the same `isSequencerUp` function. |
| Gate placement: top of fetchMetaQuote, before cache and rate limiter | ✅ Cached pre-outage quotes cannot be served once the check flips. Refused requests don't consume outbound budget. Covers every caller (fetchMetaQuote is the sole quote entry point). |
| Grace-window logic matches price-read gate exactly | ✅ Both call identical `isSequencerUp(chainId, getPublicClientForChain(chainId))`. Same logic: answer===0n AND sinceStartedSec >= SEQUENCER_GRACE_PERIOD_SEC (3600s). Same fail-safe (RPC error → false). |
| Refusal shape: typed 503 + sequencerDown flag + Retry-After | ✅ `{ error: "…sequencer is down…", sequencerDown: true }`, status 503, `Retry-After: 60`. Client can render calm "quotes paused" UX. |
| Feed address verified on-chain (9V lesson) | ✅ `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` — FEEDBACK documents `cast description()` → "L2 Sequencer Uptime Status Feed". Not a new address, just a new consumer. |
| Mainnet byte-identical | ✅ Gate condition: `chainId != null && chainId !== DEFAULT_CHAIN_ID`. chainId 1 and undefined both skip. Test-pinned (isSequencerUp never called). |
| Negative-path tests | ✅ Down/refuses (SequencerDownError), up/proceeds, mainnet-never-consulted, route maps to 503+Retry-After. |
| No NEXT_PUBLIC_ leak, no contract/adapter changes | ✅ Only new export: `SequencerDownError` (typed Error class). |

| ID | Severity | Description |
|----|----------|-------------|
| E2-I-01 | INFO | Swap-build path (`/api/swap`) has no explicit sequencer refusal. Defense-in-depth: quote gate (upstream) + oracle price-read gate (P218, inline) provide layered coverage. One-liner follow-up recommended, not a blocker. |
| E2-I-02 | INFO | 30s `isSequencerUp` cache bounds detection latency. Same cache the existing price-read gate uses (inherited, not new). Acceptable RPC-cost / detection-speed trade-off. |

**FEEDBACK open questions — Auditor rulings:**
1. **Swap-path explicit gate:** NOT REQUIRED for merge. Quote gate is upstream (no quote → no swap); oracle gate (P218) is inline secondary. Adding it is a clean one-liner follow-up for defense-in-depth.
2. **30s cache latency:** ACCEPTABLE (inherited from existing price-read gate, unchanged).

### Sprint E-3 Audit (2026-06-12) — Portfolio Base Activation (chain-aware data, LIGHT)

**Verdict: APPROVED — 0C / 0H / 0M / 2L-I.** Report: `Audits/Sprint/SPRINT-E3-AUDIT.md`.
Data multi-chain, **not** a security gate. Branch `fix/e3-portfolio-base` / PR #166. 4 functional
commits (`56594a9`, `b061695`, `3d07294`, `3fc4abf`), all SSH-signed. +404/−112, 11 files. No Solidity /
adapter / gate / fee / router / constants changes. Tests independently re-executed in-session: **42/42**.

| Check | Result |
|-------|--------|
| Alchemy endpoint per chain; mainnet pin byte-identical | ✅ `[1]`=eth-mainnet (string-identical to old `ALCHEMY_BASE`), `[8453]`=base-mainnet. Test-pinned. |
| UNMAPPED chain → 400 fail-closed (before any upstream call) | ✅ Both routes 400 pre-fetch; upstream `not.toHaveBeenCalled()` test-pinned. No silent wrong-chain. |
| DefiLlama slug via registry | ✅ On-source: `getChainConfig(1).slug==='ethereum'` (byte-identical), `(8453)==='base'`. |
| chainId threaded end-to-end (usePortfolio + both routes) | ✅ discovery URL, prices URL, `useBalance({chainId})`, curated map + fallback walk all key off one `useActiveChainId()`; `prevChainRef` clears prior-chain tokens synchronously on switch. |
| Internal mainnet-pinned fallback → standalone chain-aware `useTokenBalances` | ✅ Old `chain?.id===CHAIN_ID`/`DEFAULT_TOKENS` gate replaced by `isChainActive(activeChainId)` + active-chain catalog; `enabled=!useAlchemyPath` parks multicall; no ETH double-count. |
| Mainnet byte-identical | ✅ chainId absent → identical URL/map/slug/shape; explicit `chainId=1` treated identically to absent. 20 prior tests unchanged. |
| Base-503 fallback test real | ✅ 8453 + discovery 503 → multicall returns **Base** USDC (`0x833589…`, 6dp, `'5'`); URLs carry `chainId=8453`. |
| 9P cross-chain mislabel guard | ✅ Curation chain-scoped via `getChainTokenList(8453)`; Base USDC `isDefault` from Base list, never mainnet metadata. Test-pinned. |
| No gate/FeeCollector/adapter/contract change; no `NEXT_PUBLIC_` leak | ✅ `ALCHEMY_API_KEY` server-only; portfolio-only diff; zero Solidity/gate touch. |
| Any chain ≠ 1/8453 safe | ✅ `getSupportedChainIds()`={1,8453}=Alchemy map; else 400 → fallback gates `isChainActive=false` → empty, never wrong-chain. |
| All `useTokenBalances` call sites migrated (Map → object) | ✅ TokenSelector + usePortfolio both updated; no stragglers. |

| ID | Severity | Description |
|----|----------|-------------|
| E3-L-01 | LOW | "Supported chains" allowlist defined twice (registry `getSupportedChainIds()` in prices route vs hardcoded `ALCHEMY_BASE_BY_CHAIN` in tokens route). Identical `{1,8453}` today; latent drift if a 3rd chain is added to one but not the other (still fail-closed, read-only). Recommend a shared `PORTFOLIO_SUPPORTED_CHAINS` constant. Non-blocking. |
| E3-I-01 | INFO | `Number(chainIdParam)` accepts hex/scientific forms; harmless (fixed allowlist, read-only path). |
| E3-I-02 | INFO | `ALCHEMY_API_KEY` is one key for both endpoints — deploy checklist: confirm app-scoped (eth-mainnet + base-mainnet). Restricted key → 503 → chain-aware multicall fallback covers it. |

### Sprint E2-I-01 Audit (2026-06-12) — Sequencer gate on the Base swap-build path (LIGHT)

**Verdict: APPROVED — 0C / 0H / 0M / 0L / 2I.** Report: `Audits/Sprint/SPRINT-E2-I01-AUDIT.md`.
⚠️ **SECURITY GATE (rule #9)** — **additive** belt-and-suspenders follow-up to E-2 (PR #167), per
finding E2-I-01. Branch `fix/sequencer-swap-path` / PR #170, commit `3079d67` (SSH-signed). +95/−0, 2
files (`swap/route.ts` +25, `swap/route.test.ts` +70). `sequencer-check.ts` **unchanged**. Tests
re-executed in-session: **24/24**.

| Check | Result |
|-------|--------|
| Strict reuse of `sequencer-check.ts` — no fork of feed/grace/threshold | ✅ Only `route.ts`+`route.test.ts` touched. Route imports `isSequencerUp`/`SequencerDownError`/`getPublicClientForChain` and calls the exact api.ts:107 shape. Feed/grace/cache stay owned by `sequencer-check.ts`. |
| Fail-safe preserved (down/grace/RPC-error → refuse; no fail-open) | ✅ `isSequencerUp` returns false for down/in-grace/RPC-error; route refuses on `!seqUp`. Unknown-chain `true` unreachable (activation gate rejects first; mainnet skipped). |
| Mainnet byte-identical (absent/1 → 0 calls, test-pinned) | ✅ Guard `chainId != null && Number(chainId) !== DEFAULT_CHAIN_ID`. Test asserts absent + `chainId=1` → 200, `isSequencerUp`/`getPublicClientForChain` **not** called. |
| Placement: after activation gate, before rate-limit + upstream | ✅ `route.ts:113`, before `[Audit B-06]` limiter + `fetchSwapFromSource`. Test asserts neither `checkRateLimit` nor `fetchSwapFromSource` called on a down sequencer. |
| 503 `{error,sequencerDown:true}` + `Retry-After:60` identical to quote gate (#167) | ✅ Byte-identical body/status/header; same `SequencerDownError.message` source. Inline-check vs throw-catch style differs but wire output identical (prompt permitted either). |

| ID | Severity | Description |
|----|----------|-------------|
| E2I01-I-01 | INFO | Refusal message ("…quotes are paused…") is generic to the swap-build path; intentionally single-sourced from `SequencerDownError` for one unified "paused" UX. No change recommended. |
| E2I01-I-02 | INFO | Commit `3079d67` already merged to `main` at audit time. `main` ≠ prod and the gate is additive + now 0C/0H; recorded as a process note (rules #2/#3 prefer the Auditor pass before merge), not a code defect. |

### Sprint 201 Audit (2026-06-13) — DCA Observability + User-Safe Manual Freeze

**Verdict: APPROVED — 0C / 0H / 0M / 1L / 6I.** Report: `Audits/Sprint/SPRINT-201-AUDIT.md`.
⚠️ **Gates DCA order execution** (rules #2/#3) — advisory observability (Telegram + 0–20 score) + a
**manual admin-only freeze**. Branch `sprint/dca-observability-freeze` / PR #201, commit `4f9cee3`
(SSH-signed). +2187/−2, 16 files. No Solidity/contract change. Keeper `node:test` re-run in-session:
**18/18** (12 freeze-score + 6 alert; keeper is NOT in CI).

| Check | Result |
|-------|--------|
| User-safety invariant — freeze = delay, not loss | ✅ Frozen DCA returned to `active` (no `executeOrder`, no funds/approvals); new DCA → 403 with `insert` never reached (gate inside `orderType==='dca'`, before insert); cancel route never reads the flag (cancel always allowed); pending DCAs resume post-unfreeze (cumulative tracking untouched). Test-pinned (`orders-freeze.test.ts`). |
| No auto-freeze — single writer | ✅ `setDcaFreezeState` called only from `POST /api/admin/dca-freeze` after Bearer auth; keeper/score/alerts read-only; SQL RLS deny-all to anon, service-role-only writes. 0–20 score is informational, triggers no state change. |
| Bearer admin auth (trade-off 1) | ✅ BLESS. `verifyBearerToken` = SHA-256 + `timingSafeEqual` (constant-time, no length leak), server-only, not logged. `0x9A38` is only the client UI gate. |
| Fail-open reads (trade-off 2) | ✅ BLESS. On-chain `pause()` (DB-independent) is the real fail-safe; `executeOrder` is on-chain-guarded so a keeper running during a DB outage can't lose funds; fail-closed would be a liveness footgun with no security gain. No attack window. |
| Lock-before-skip (3) / outflow over-alert + ETH-USD staleness + in-mem dedup (4) | ✅ BLESS. Delay-not-loss holds; all advisory, never a gate. |
| Unexplained-ETH-outflow detection | ✅ `ownGasSpentWei` accumulated per `executeOrder` (gasUsed×effectiveGasPrice) and subtracted; 0.01 ETH/cycle threshold sane for a Base gas wallet. INFO: per-cycle window can miss a sub-threshold drip-drain (false neg); manual withdrawals over-alert (false pos) — advisory only. |
| Non-blocking + mainnet byte-identical | ✅ `sendTelegramAlert` no-ops when unset + never throws (10s abort); all alert/score/read calls wrapped never-throw + fail-open; not-frozen + Telegram-unset ⇒ no execution change. Secrets server-only, not logged. Dormant pre-activation state safe. |

| ID | Severity | Description |
|----|----------|-------------|
| 201-L-01 | LOW | `setDcaFreezeState` (`dca-freeze.ts:106`) returns success without persisting when Supabase is unconfigured ⇒ admin freeze **falsely reports 200** though nothing was written (inconsistent with the upsert-error→503 path). Trade-off 5 ACCEPT-WITH-HARDENING: make the **write** path fail-closed (throw → 503). Remediation prompt in the report. Not user-exploitable; `pause()` remains the real stop. |
| 201-I-01..06 | INFO | Fail-open reads (keep `pause()` authoritative; optional `FREEZE_FAILCLOSED`); per-cycle outflow false-neg (rolling window future); outflow false-pos on manual withdrawal; Telegram token in URL (only `err.message` logged today); lock-before-skip churn (optional pre-lock `order_type` check); in-memory new-DCA dedup re-alerts after restart. All non-blocking. |

### T-SAF Campaign 2026-07-01 — Wave 1: Smart contracts

**Verdict: APPROVED — 0C / 0H / 0M / 2L / 4I.** Report: `Audits/Campaign/2026-07-01/W1-contracts.md`.
⚠ On-chain trust root (rules #2/#3). Read-only; `forge`/`slither` absent in sandbox → adversarial source
read + live viem verification; **CI `test-contracts` (linux-x64) remains the authoritative executable
gate**. Scope: FeeCollector V1 (`0x4dAE`), V2 (`0x47f2`), OrderExecutor (`0xeFC3`) + Base FeeCollector
(`0xeFC3`), all on-chain-verified this run.

| Check | Result |
|-------|--------|
| Router/selector whitelist chain-aware & on-chain | ✅ `whitelistedRouters` = per-deploy on-chain state; mainnet OE **V5=true/V6=false/1inchV6=true** re-confirmed; unknown router reverts. V2 per-router selector allowlist; OE binds full calldata via `routerDataHash` (non-DCA mandatory, MEDIUM-006). |
| Access control (`admin()`; owner reverts) + timelocks | ✅ all state-changing fns admin-gated; on-chain `admin()`=`0x9A38…C73C` (all 3). OE timelocks admin 7d / router·executor·sweep 48h; sweep dest admin-only. ⚠ FeeCollector V2 `transferAdmin`/`setAllowedSelector` not timelocked → W1-L-01. |
| EIP-712 replay-safe | ✅ OZ domain pins chainId+verifyingContract (no cross-chain replay); nonce/DCA-counter (no double-exec); `ORDER_TYPEHASH` matches struct. |
| On-chain minOutput | OE ✅ enforced (balance-delta, `InsufficientOutput`); **FeeCollector V2 ✗ none** (delegated to router `amountOutMin`) → W1-I-02 packet correction. |
| Fee-once (ETH+ERC20) | ✅ 0.1% once; ERC-20 balance-delta (fee-on-transfer safe); V2 `RouterTookTooMuch` bound. |
| Reentrancy | ✅ `nonReentrant` + CEI on every value-moving path; `_inExecution` guards `receive()`. |
| Recipient binding | ✅ OE force-delivers to `order.owner` on-chain; FeeCollector delegates to routerData (off-chain R1 gate) → W1-I-04 → verified in W2. |

| ID | Sev | Description |
|----|-----|-------------|
| W1-L-01 | LOW | FeeCollector V2 `transferAdmin` (`:385`) + `setAllowedSelector` (`:191`) not timelocked (vs OE 7d/48h). Bounded (transient fees; msg.sender-funded swaps; sweep 48h+feeRecipient). Remediation prompt; contract change ⇒ Auditor re-pass (#2/#3). |
| W1-L-02 | LOW | Single **EOA** admin `0x9A38…C73C` over FeeCollector V1/V2 + OrderExecutor, both chains. Centralization/key-mgmt; mitigated by OE timelocks + Admin→HW plan. Recommend Safe + HW. |
| W1-I-01 | INFO | Legacy FeeCollector V1 (`0x4dAE`) lacks V2 selector allowlist + 48h sweep timelock (instant sweep→feeRecipient). Confirm no active routing/approvals to V1. |
| W1-I-02 | INFO | FeeCollector V2 has **no on-chain minimumOutput** (P68 pending) — slippage delegated to router. W2/W3 must not assume FeeCollector self-checks output. |
| W1-I-03 | INFO | Packet's **Base OrderExecutor `0x135B` not found in source nor on-chain-verified**; no Base `orderExecutor` wired (Base orders gated off). Confirm before W2/W8 depend on it. |
| W1-I-04 | INFO | FeeCollector doesn't bind output recipient on-chain (off-chain R1 gate); verified in W2. |

Refuted first-pass noise: DCA `routerDataHash==0` theft (minOut+owner-delivery+whitelist+nonReentrant);
arbitrary sweep recipient (hardcoded); cross/same-chain replay (domain+nonce); settle reentrancy
(nonReentrant+CEI). Dynamic Foundry/Slither deferred to CI (tools absent in sandbox).

> **W1 correction (per W2, 2026-07-01):** W1 read `TeraSwapFeeCollectorV2_flat.sol`, which is **NOT the
> deployed V2**. On-chain selector proof shows the deployed V2 (`0x47f2` + Base `0xeFC3`) matches
> `contracts/TeraSwapFeeCollector.sol` and **enforces `minimumOutput` on the user's balance delta**.
> Therefore **W1-I-02 is REFUTED**, **W1-I-04 largely resolved**, and **W1-L-01 is moot for the deployed
> contract** (`transferAdmin`/`setAllowedSelector` absent on-chain). See W2 finding W2-M-01.

### T-SAF Campaign 2026-07-01 — Wave 2: Fund-flow integrity

**Verdict: APPROVED — 0C / 0H / 1M / 2L / 2I.** Report: `Audits/Campaign/2026-07-01/W2-fund-flow.md`.
⚠ Fund-flow (rules #2/#3). Money invariant **holds on every FeeCollector-routed source × both chains** and
is **stronger than the packet assumed** — deployed V2 enforces on-chain `minimumOutput` on the user's own
balance delta (selector-verified both chains this run). Read-only; tests re-run: calldata-recipient 26/26
+ partner-fee-invariant 4/4 = **30/30**.

| Check | Result |
|-------|--------|
| Recipient gating (output→user, all adapters, both chains) | ✅ `validateCallDataRecipient` fail-closed (unknown selector / decode error / nested multicall → `valid:false`); per-chain FeeCollector from registry; 6 decode groups cover the executable sources. |
| Router/selector allowlist; unrecognized refused | ✅ SC-04 `isKnownSwapSelector` (server) + R1 `VALIDATED_SELECTORS` + `ROUTER_WHITELIST(_BY_CHAIN)` + on-chain `minimumOutput`; chain-correct routers (W0). |
| `minimumOutput` non-downgradable floor | ✅ On-chain (deployed V2 both chains, balance-delta) + client-derived from user slippage (`useSwap.ts:458`); server can't set it independently; DefiLlama >$10k cross-check. Residual minOut=0-on-malformed → W2-L-01. |
| Fee-once (0.1%, ETH+ERC20) | ✅ Partner XOR FeeCollector (`FEE_INCOMPATIBLE=[0x,cowswap,bebop]`); ERC-20 balance-delta; single `FEE_BPS=10`. |
| FeeCollector routing + partner fees, no bypass | ✅ `fetchApproveSpender` correct per source/chain; no double/skip. |

| ID | Sev | Description |
|----|-----|-------------|
| W2-M-01 | MED | `TeraSwapFeeCollectorV2_flat.sol` ≠ deployed V2 (selector-verified); deployed = `TeraSwapFeeCollector.sol`. Deployment/audit-integrity risk (a re-deploy/review could pick the weaker no-minOutput source; W1 was misled). **Not a live fund-flow defect — does NOT block prod.** Fix: remove/mark stale flat + add `DEPLOYED-SOURCES.md` (addr→source→solc→code-hash). |
| W2-L-01 | LOW | minOut=0 fallback on malformed `toAmount` disables the on-chain output check per-leg (10-L-01 family) → griefing/stranding, not theft (R1 gate still binds recipient). Recommend refuse-on-unusable-quote / non-zero floor. |
| W2-I-01 | INFO | Balancer/OpenOcean/native-Curve selectors absent from SC-04+R1 → fail-closed (refused) on execution → likely quote-only; confirm in W7. |
| W2-I-02 | INFO | Group-F (Odos/Kyber/ParaSwap) recipient not extracted (trusted msg.sender) — now compensated on-chain by deployed V2 `minimumOutput`. |

Negative-paths all refused (recipient=attacker, tampered selector, nested multicall, double-fee,
per-chain router mismatch, minOut downgrade). Full calldata fuzz + `forge` deferred to CI.

### T-SAF Campaign 2026-07-01 — Wave 3: Oracle & safety gates

**Verdict: gates on PRODUCTION (`origin/main`) APPROVED — 0C / 0H.** Report:
`Audits/Campaign/2026-07-01/W3-oracle-gates.md`. ⚠ **Campaign-process finding W3-H-01 (HIGH, grounding —
NOT a product vuln).**

> **W3-H-01 (grounding):** the audited working tree `docs/inc-2026-06-09` is **261 commits behind
> `origin/main` (0 ahead)** and is **missing the E-2 quote + E2-I-01 swap-build sequencer gates that
> production has** (`api.ts:107`, `api/swap:126` on main). W0–W2 *on-chain* findings are branch-independent
> and stand; W1/W2 *frontend/API* conclusions must be re-verified on `main`. **Re-baseline the campaign on
> `main` before continuing.** Not a production vulnerability — `main` carries all gates.

Gate checks (graded against `main`):

| Check | Result on `main` |
|-------|------------------|
| Chain-aware, no silent skip (1 AND 8453) | ✅ chainlink `rpcCall(chainId)`, defillama `chain` slug, `isSequencerUp(chainId)`, price-monitor client-per-chain. |
| Per-feed staleness | ✅ `validateRoundData` fail-closed (answer≤0 / answeredInRound<roundId / startedAt≤0 / age>heartbeat×1.5). |
| Deviating price refused | ✅ DefiLlama >8%-below-fair → 422 (non-overridable); Chainlink integrity + extreme-deviation hard-block; price-impact→consent (9J, rule-#9-safe). |
| Depeg | ✅ market-vs-ER ≥block → block; leg integrity fail-closed, verdict fail-open (INV-8). |
| DefiLlama >$10k fail-closed / <$10k fail-open | ✅ `HIGH_VALUE_THRESHOLD_USD=10_000`; unavailable/low-conf/error & >$10k → block; <$10k → fail-open. |
| Sequencer on quote AND swap-build | ✅ on `main` (4 call sites: quote/swap-build/price-read/monitor); fail-safe down/grace/RPC-err→refuse. **✗ on audited branch → W3-H-01.** |
| Feeds on-chain-verified | ✅ cbETH market agg `0x53fD…`/ER agg `0x4c78…` (v6, match code — closes W0 gap); sequencer `0xBCF8` identity only via latestRoundData (W3-I-01). |

| ID | Sev | Description |
|----|-----|-------------|
| W3-H-01 | HIGH (process) | Campaign audited a branch 261 commits behind `main`, missing prod sequencer gates. **Not a prod vuln.** Re-baseline on `main`; re-verify W1/W2 frontend-API items. |
| W3-I-01 | INFO | Base sequencer feed `0xBCF8` has no `description()`/`aggregator()` (revert) — identity only via `latestRoundData` (answer 0=up, verified). |
| W3-I-02 | INFO | J1 client price-gate consent for price-impact is rule-#9-safe (server DefiLlama −8% + on-chain minimumOutput unchanged). |

**Campaign note:** W4+ must run against `origin/main`. On-chain-decisive findings (W0/W1/W2 feeds,
contract bytecode, deployed minimumOutput) are branch-independent and remain valid.

### T-SAF Campaign 2026-07-01 — RE-BASELINE + Wave 4: Chain-awareness

**Re-baselined onto production:** audited SHA = `origin/main` **`cb0748de466c50c1749dfea53ad5c0424f6c0bf6`**
(working-tree `docs/inc-2026-06-09` @ df00d35 is 261 behind → ignored; reads via `git show origin/main`).

**W1/W2 re-confirmation on main:**
- **W1-I-03 REFUTED on main** — Base OrderExecutor **wired + on-chain-verified**:
  `ORDER_EXECUTOR_BY_CHAIN[8453]=0x135B339902Ea4E0fB4CF059961dc8856bA1D2598` (code 15475b, `admin=0x9A38…C73C`,
  own per-chain `domainSeparator`, `whitelistedRouters` **V6=true/V5=false/1inch=true** — mirror of mainnet).
- **W2-L-01 STANDS on main** (`useSwap.ts:457-461` minOut=0 on malformed toAmount).
- W1-I-02/I-04/L-01 + W2-M-01 branch-independent (deployed bytecode) — unchanged.

**Wave 4 verdict: APPROVED — 0C / 0H / 0M / 0L / 2I.** Report: `Audits/Campaign/2026-07-01/W4-chain-awareness.md`.
The #1 defect class (mainnet residue on a Base path) is **clean on production.**

| Check | Result on `main` |
|-------|------------------|
| No mainnet assumption on Base paths | ✅ FeeCollector `getChainConfig(chainId).contracts.feeCollector` (P225, fail-closed), spender per-chain (P226), clients/feeds per-chain. |
| Router selection = whitelisted on THAT chain | ✅ on-chain: mainnet OE Augustus V5(true)/V6(false); Base OE V6(true)/V5(false) — mirror; `routers.ts` 8453 Base-correct. |
| `getPublicClientForChain` chain-aware | ✅ `VIEM_CHAINS={1:mainnet,8453:base}`; mainnet→IP-hiding client; unsupported→throw. |
| `"1"!==1` coercion | ✅ `Number(chainId)` at all API boundaries; no mismatch reaches a gate. |
| Activation gate + Base OE wiring | ✅ `isChainActive` gates; `getOrderExecutor(8453)=0x135B`, `(1)=0xeFC3`; null→fail-closed (H-05). |
| Mainnet byte-identical vs W0 | ✅ mainnet OE/FeeCollector/feeds unchanged; Base wiring additive. |

| ID | Sev | Description |
|----|-----|-------------|
| W4-I-01 | INFO | Stale `api.ts:540` comment says FeeCollector "still mainnet-pinned" — code is already chain-aware (P225/P226). Fix comment. |
| W4-I-02 | INFO | Three router allowlists (frontend swap / spender set / on-chain OE) — chain-scoped + correct, drift risk. Recommend single per-chain source + parity test (frontend ⊆ on-chain OE whitelist per chain). |

Negative-paths refused: V6-on-mainnet-order / V5-on-Base-order → `RouterNotWhitelisted`; no-FeeCollector chain
→ throw; no-executor chain → `getOrderExecutorDomain` throws; `chainId="1"`→1. `forge` cross-chain-replay deferred to CI.

### T-SAF Campaign 2026-07-01 — Wave 5: Signing-trust (on `origin/main` @ cb0748d)

**Verdict: APPROVED — 0C / 0H / 0M / 0L / 2I.** Report: `Audits/Campaign/2026-07-01/W5-signing-trust.md`.
Every wallet/keeper signature is over a **reviewed frozen payload**; *sent == signed* is explicit; replay
blocked; admin Bearer constant-time + unlogged; approvals exact-amount.

| Check | Result on `main` |
|-------|------------------|
| Review-gate on EVERY signing path; signed==reviewed | ✅ swap `confirmSwap` sends frozen `pendingSwap` (set after `validateRouterAddress`+R1 `validateCallDataRecipient`); CoW signs "EXACT frozen payload (no rebuild)"+9U freshness; order create one `signedChainId` const (sent==signed); cancel signs frozen nonce/reviewed rows. RPC proxy blocks all signing methods. |
| Nonce → no same-chain replay | ✅ `order.nonce` single-use / DCA counter; `invalidateNonces` mass-cancel. |
| Domain pins chainId+verifyingContract → no cross-chain replay | ✅ `getOrderExecutorDomain(chainId)` fail-closed; **on-chain re-confirmed distinct** domainSeparators: mainnet OE `0x335a0ec4…` vs Base OE `0x020a73f6…`. |
| Admin Bearer constant-time, server-only, unlogged | ✅ `auth.ts:25` SHA-256+`timingSafeEqual`; no secret logged. |
| Recipient binding output→owner | ✅ client R1 before freeze + server R1 + OrderExecutor on-chain delivery to `order.owner`. |
| Approvals | ✅ `useOrderApproval` exact-amount, **never max-uint**, fail-closed on null/wrong spender. |

| ID | Sev | Description |
|----|-----|-------------|
| W5-I-01 | INFO | Cancel EIP-712 `{id,action}` has no nonce/expiry — not exploitable (owner-signed, rowId-scoped, idempotent; on-chain void still nonce-based). |
| W5-I-02 | INFO | `useSwap:341` `?? FEE_COLLECTOR_ADDRESS` mainnet fallback — safe (guarded by `:321` throw), defensive nit to remove. |

Negative-paths refused: modified payload (frozen-then-sign), same/cross-chain replay (nonce + distinct
domains), chain-switch mid-review (review cleared), forged Bearer, timing side-channel, recipient=attacker,
expired CoW order, infinite approval. Live-signature/real-device deferred (human-only).

### T-SAF Campaign 2026-07-01 — Wave 6: Backend/API (31+ routes) (on `origin/main` @ cb0748d)

**Verdict: APPROVED — 0C / 0H / 2M / 1L / 2I.** Report: `Audits/Campaign/2026-07-01/W6-backend-api.md`.
No auth bypass, no server-secret leak, no cross-user *mutation*, no HTML errors. Three backlog items are
info-leak/DoS-class (no fund loss / no gate bypass) → don't block prod.

| Check | Result on `main` |
|-------|------------------|
| Input validation | ✅ address/amount(`safeBigInt`)/slippage/chainId per route → 400 JSON. |
| Authz | ✅ admin/monitor/dca-freeze `verifyBearerToken` (503/401); telegram/webhook constant-time secret; `v1/*` mainnet-only (400 non-1). |
| Rate-limit before upstream | ✅ swap/quote/v1/portfolio/rpc/analytics; ⚠ absent on log-*/orders (W6-M-02). |
| Errors JSON never HTML | ✅ try/catch → NextResponse.json/jsonError; `sanitizeUpstreamError`. |
| No `NEXT_PUBLIC_` secret | ✅ only anon key (public); service-role server-only; nothing logged. |
| RLS user isolation | ✅ **writes** signature-gated (recover==wallet + order.wallet, 401/403); ⚠ **reads** public-by-wallet-param (W6-M-01). |
| Oversized body | ⚠ cap only on swap; others → Vercel ~4MB default (W6-L-01). |
| chainId coercion / DefiLlama >$10k | ✅ `Number(chainId)`; swap 422 block (W3). |

| ID | Sev | Description |
|----|-----|-------------|
| W6-M-01 | MED | Unauthenticated `GET /api/orders?wallet=` (+history/analytics-personal) exposes a wallet's data incl. **pending order strategy** by address (service-role + unauth wallet param). Documented for analytics (13B-L-02); pending-order case is more sensitive. No fund loss; writes signature-gated. |
| W6-M-02 | MED | `log-*` unauth + un-rate-limited → unbounded Supabase inserts (spam/poisoning/cost); `orders` POST un-rate-limited. Add per-IP checkRateLimit. |
| W6-L-01 | LOW | Body-size cap only on `swap`; others rely on platform default. Add shared guard. |
| W6-I-01/02 | INFO | Public-by-address read model is documented design; log-* silently-succeed on error (telemetry). |

RLS red-team: cross-user order **cancel/create DENIED** (recover==wallet + order.wallet, 401/403); cross-user
**read ALLOWED by design** (W6-M-01). Negative-paths refused: unauth admin→401, bad JSON→400, non-mainnet
v1→400, DefiLlama+>$10k→422, forged webhook secret→reject. `semgrep`+per-route fuzz deferred to CI.

### T-SAF Campaign 2026-07-01 — Wave 7: Aggregation adapters (12 sources) (on `origin/main` @ cb0748d)

**Verdict: APPROVED — 0C / 0H / 0M / 2L / 2I.** Report: `Audits/Campaign/2026-07-01/W7-adapters.md`.
**No source can break the W2 money invariant** — every build result passes the source-agnostic fail-closed
gates in `api/swap` (`isKnownSwapSelector:199` + `validateCallDataRecipient:217`), regardless of source or
retry/fallback. Per-chain URLs correct; 0.1% fee once (partner XOR FeeCollector).

| Check | Result on `main` |
|-------|------------------|
| Recipient gated per source (both chains) | ✅ adapters set `recipient ?? from`; R1 validates built calldata; Group-F msg.sender-trust compensated on-chain by deployed `minimumOutput` (W2). |
| Selector/router allowlist; unrecognized refused | ✅ SC-04+R1 fail-closed. Balancer/OpenOcean/native-Curve selectors NOT allowlisted → SC-04 blocks execution (quote-only); Balancer also rejects non-whitelisted `data.to` (9G-G7). |
| Per-chain base URLs | ✅ `getAdapterApiUrl(source,chainId)` per-chain (path/query/slug); Curve mainnet-only (null on Base); 0x per-chain endpoint. No Base quote hits a mainnet endpoint. |
| Fee-once (partner XOR FeeCollector) | ✅ 0x `swapFeeBps`, CoW `partnerFee`, Bebop `fee` = FEE_BPS; others → FeeCollector; XOR (W2 4/4). ⚠ CoW fail-soft can zero it (W7-L-01). |
| Retry/9O fallback safe | ✅ `withSwapBuildRetry` (transient-only); gates run on the final result regardless of source/fallback. |

| ID | Sev | Description |
|----|-----|-------------|
| W7-L-01 | LOW | CoW partner-fee fail-soft retries fee-free on a partnerFee-schema rejection → 0.1% **zeroed** for that order (revenue loss, not user harm; not doubled). Add a metric/alert. |
| W7-L-02 | LOW | Balancer/OpenOcean/native-Curve build txs but selectors aren't allowlisted → SC-04 blocks execution (safe/fail-closed); confirm quote-only or add recipient-extraction decoders. Cross-ref W2-I-01. |
| W7-I-01/02 | INFO | Native Curve redundant (Curve liquidity settleable via Velora-Augustus); source-agnostic gate placement is the load-bearing A2 invariant. |

Negative-paths refused: recipient=attacker→R1 400, unknown selector→SC-04 400, double-fee→XOR-impossible,
Balancer non-whitelisted `data.to`→9G-G7 throw, mainnet-URL-on-Base→per-chain resolver, retry drop-guard→gates
on final result. Hostile-fixture execution deferred to CI (R1 26/26 + partner-fee 4/4 unit-tested, W2).

### T-SAF Campaign 2026-07-01 — Wave 8: Keeper / order-engine (A5) (on `origin/main` @ cb0748d)

**Verdict: APPROVED — 0C / 0H / 0M / 0L / 2I.** Report: `Audits/Campaign/2026-07-01/W8-keeper.md`.
Keeper (KMS) compromise **bounded on-chain**; freeze delay-not-loss + single admin writer; **plaintext-key
Base gap FIXED on main**. Keeper `node --test`: **127/127**.

| Check | Result on `main` |
|-------|------------------|
| Keeper compromise bounded on-chain | ✅ keeper calls `executeOrder(orderStruct, userSig, routerData)` (`:1191`); contract forces owner-recipient + on-chain minimumOutput + whitelisted router (V5/V6). Can't misroute via the contract. |
| Signs only reviewed payload | ✅ orderStruct+signature from Supabase order (user-signed); no re-target. |
| Freeze delay-not-loss + single writer | ✅ keeper reads fail-open, skips DCA (leaves active), 403 new orders; **never writes circuit_breaker** (single admin writer, no auto-freeze); pause() nuclear. |
| #246 retry idempotent / #248 defer≠settle | ✅ retry left-active + on-chain nonce/interval prevent double-exec; deviation-guard DEFERS (not a settle); record-execution confirmed-only idempotent. |
| Fail-open reads vs pause() | ✅ correct split (201 ruling). |
| Outflow detection | ✅ own-gas subtracted, 0.01 ETH threshold, non-blocking alert. |
| Plaintext-key guard covers 1 AND 8453 | ✅ **FIXED**: `TESTNET_CHAIN_IDS` allowlist {Sepolia, Base-Sepolia}; Base 8453 → FATAL without KMS/Vault (unless explicit override). |
| Observability non-blocking; secrets unlogged; cron authed | ✅ never-throw; only env-var *names* logged; Worker POSTs monitor/tick with `Bearer MONITOR_CRON_SECRET`. |

| ID | Sev | Description |
|----|-----|-------------|
| W8-I-01 | INFO | `ALLOW_PLAINTEXT_KEY` escape hatch bypasses the prod plaintext-key refusal — never set in prod (ops; complete KMS/HW hardening). |
| W8-I-02 | INFO | Outflow per-cycle (sub-threshold slow-drain evades; manual-withdrawal over-alerts) — advisory; rolling-window future. |

Negative-paths bounded: misroute via executeOrder impossible (owner-delivery), forged order → sig-recover
revert, re-exec → nonce/interval revert, keeper-writes-freeze → no path, plaintext-key-on-Base → FATAL,
drifted DCA → deferred, unauth monitor/tick → 401. No remediation required (clean wave).

### T-SAF Campaign 2026-07-01 — Wave 9: Wallet/frontend/session (A3) (on `origin/main` @ cb0748d)

**Verdict: APPROVED — 0C / 0H / 0M / 1L / 2I.** Report: `Audits/Campaign/2026-07-01/W9-frontend-session.md`.
Single WC core + pinned qr + wagmi v2 (ADR-008); no `dangerouslySetInnerHTML`; AES-256-GCM secure storage;
min-output binds client+server+on-chain.

| Check | Result on `main` |
|-------|------------------|
| Single WC core / pinned qr / no wagmi-v3; session | ✅ lockfile: one `@walletconnect/core@2.21.1` (overrides), `qr@0.5.5`, wagmi 2.19.5 (v2); single config (no double-init); WalletSessionGuard 9Z-test-locked (1h idle, no premature disconnect). |
| COOP/COEP headers | ✅ COOP `same-origin-allow-popups` + CORP + CSP + HSTS + X-Frame; COEP intentionally omitted (breaks wallet embeds, W9-I-01). |
| Secure storage AES-256-GCM (FE-01) | ✅ PBKDF2 wallet-derived key, stores `{iv,ct}` (order/trade metadata only, never keys); plain-localStorage = non-sensitive prefs. ⚠ plaintext fallback when key unavailable (W9-L-01). |
| Min-output/slippage client+server+on-chain | ✅ server slippage 0–15 (400 else); client can only tighten; minOut→0 still caught by DefiLlama −8% + router amountOutMin (no bad-price settle). |
| Review modal = frozen payload | ✅ (W5) frozen-then-sign, no rebuild. |
| XSS | ✅ no `dangerouslySetInnerHTML`; user strings React-escaped; `window.open` = fixed twitter base + encodeURIComponent + noopener; logoURI img-src safe; Telegram esc() server-side. |

| ID | Sev | Description |
|----|-----|-------------|
| W9-L-01 | LOW | `secure-storage.ts:184` falls back to **plaintext** when the wallet-derived key is unavailable (crypto-absent / pre-derivation write). Prod (HTTPS + connected wallet) shouldn't fire it; a race/pre-connect write of order metadata would be plaintext (no keys/seeds ever stored). Buffer/refuse sensitive writes until key init. |
| W9-I-01/02 | INFO | COEP intentionally omitted (dApp posture); client minOut=0 edge compensated by DefiLlama −8% + router amountOutMin (W2-L-01 cross-ref). |

Negative-paths refused: dup WC core/wagmi-v3 → pinned; session double-init → single config; sensitive
plaintext → AES-GCM (except W9-L-01 fallback); slippage>15 → 400; minOut→0 → server/router bind; XSS →
React-escaped + no raw sink. Live browser/real-device deferred (human-only).

### T-SAF Campaign 2026-07-01 — Wave 10: Supply chain / secrets / infra / CI (A6) (on `origin/main` @ cb0748d)

**Verdict: APPROVED — 0C / 0H / 0M / 1L / 2I.** Report: `Audits/Campaign/2026-07-01/W10-supply-chain.md`.
Critical wallet deps single-instance; overrides pin all risky advisories (empty allowlist, 0 high/critical);
no `NEXT_PUBLIC_` secret; CI gate suite present + blocking; headers sane; Worker cron Bearer-authed.

| Check | Result on `main` |
|-------|------------------|
| Single-instance critical deps | ✅ @walletconnect/core 1@2.21.1, @coinbase/wallet-sdk 1@4.3.6, qr 1@0.5.5; ⚠ viem 2 (app 2.47.4 + WC-utils 2.23.2 transitive) → W10-L-01 bundle-only. |
| Overrides pin advisories; allowlist not masking | ✅ form-data/vite/ws/undici/hono pinned; `audit-allowlist.json` empty → audit-gate fails any unallowed high/critical; `.npmrc min-release-age=7` (lockfile-lint). |
| No `NEXT_PUBLIC_` secret; not logged | ✅ only anon key + public addresses; server secrets server-only. |
| CI gates present AND blocking | ✅ test-contracts (continue-on-error REMOVED, forge test); 8 guard jobs (audit-gate/catalog-address/fee-usd/dca-resilience/oracle-advisory/token-catalog/minimum-output/deployed-sources) + lockfile-lint + keeper-tests(127/127) + gitleaks (bare-hex EVM-key rule) + codeql. Only advisory-moderate step is continue-on-error. |
| Signatures (#12) | ✅ main commits signed (SSH authored + PGP web-flow merges). |
| Headers sane | ✅ CSP (img-src blob:+token CDNs, scoped connect-src, frame-ancestors none), COOP/CORP/HSTS/X-Frame; no wildcard defeat; COEP intentionally omitted. |
| Worker cron authed | ✅ Bearer MONITOR_CRON_SECRET; unauth tick → 401. |

| ID | Sev | Description |
|----|-----|-------------|
| W10-L-01 | LOW | viem resolves to 2 instances (app 2.47.4 + `@walletconnect/utils` transitive 2.23.2) — bundle bloat, not a runtime bug; forcing one version risks breaking WC. Optional dedupe + WC-modal smoke test. |
| W10-I-01/02 | INFO | Executor sub-package separate (viem 2.47.10, aws-kms); strong single-file CI guard strategy. |

> **CORRECTION (per W10):** two prior campaign findings are **REMEDIATED on `main`** —
> **W2-L-01** (`useSwap:458` `deriveMinimumOutput` throws `UnusableQuoteError` → refuse, not minOut=0;
> `minimum-output-guard`) and **W2-M-01** (`docs/security/DEPLOYED-SOURCES.md` canonical map + `deployed-sources-guard`
> + deprecated flat). My W4/RB.1 note ("W2-L-01 stands on main") is corrected — it is fixed.

### T-SAF Campaign 2026-07-01 — Wave 11: Synthesis + CAMPAIGN VERDICT (on `origin/main` @ cb0748d)

**CAMPAIGN VERDICT: APPROVED — 0 Critical / 0 High (product).** Master report:
`Audits/Campaign/2026-07-01/MASTER-REPORT.md`. Full attack surface (3 contracts, 31+ routes, 15 gate/oracle
libs, registry, 12 adapters, keeper, wallet/frontend, supply-chain/CI) on ETH mainnet + Base.

- **No C/H product finding across all 11 waves.** The one HIGH (W3-H-01) was process/grounding — the campaign
  initially read a branch 261 commits behind prod; resolved by re-baselining every wave onto `origin/main`.
- **Cross-wave chain analysis: NO chain reaches user funds.** Every off-chain compromise (API/source/client/
  keeper/dep) terminates at the on-chain guards (recipient=owner ∧ on-chain minimumOutput ∧ chain-correct
  whitelisted router) — the proven terminal backstop. Only intentional asymmetry: order reads public / writes
  signature-gated (W6-M-01, privacy, no funds).
- **Coverage: §2 inventory = 100%** (each slice owned by a wave, no orphan); **§9 G1–G10 exercised-and-refuted**.
- **On-main remediations during the campaign:** W2-L-01, W2-M-01 (PR #254), W8 plaintext-key Base gap; W1-I-02/I-03
  refuted; W1-L-01 superseded.
- **Open backlog: 2 MED + 6 LOW + INFO** (off-chain info-leak/DoS/reliability/hygiene), RICE-planned in the
  master report. **Zero pending contract-source remediation.**

Per-wave verdicts (all APPROVED): W1 2L/4I · W2 1M/2L/2I (M+1L now fixed) · W3 gates 0C/0H (+W3-H-01 process) ·
W4 2I · W5 2I · W6 2M/1L/2I · W7 2L/2I · W8 0/2I · W9 1L/2I · W10 1L/2I. RICE plan: auto-fixable (W6-M-02,
W9-L-01, W6-L-01, W4-I-02, W7-L-01, W4-I-01, W5-I-02, W10-L-01) · product-decision (W6-M-01, W7-L-02) ·
governance (W1-L-02 admin→Safe/HW, W8-I-01).

### AUDIT NEW-2 — Low-quorum demotion / execution-selection (PR #272, 2026-07-02)

**Verdict: APPROVED — cleared to merge. 0C / 0H; flagged gap = MEDIUM (NEW2-M-01), bounds HOLD.** Report:
`Audits/Sprint/AUDIT-NEW2-QUORUM-EXECUTION-AUDIT.md`. Branch `chore/quorum-lowconfidence-fix` (UNMERGED),
audited SHA `8514b68` (SSH-signed). Per the verdict rule, a flagged M with bounds holding + a remediation
prompt does NOT block merge.

- **NEW2-M-01 (MEDIUM, confirmed):** `applyLowQuorumSanity` (n=2) demotes the winner on a >500 bps pairwise
  spread but can't tell which side lies → a low-ball source >5% under an honest winner forces the honest quote
  demoted + the attacker's low quote presented (test `(a) FLAGGED GAP:186`). **Griefing / price-degradation,
  NOT theft** (on-chain minimumOutput binds the fill; no funds to attacker).
- **Bounds HOLD — no fund-loss path:** residual = ONLY oracle-less AND DefiLlama-less pairs, exactly 2
  responders, capped <$10k (`UNVERIFIED_SWAP_BLOCK_USD`), minOut-bound, `lowConfidence`-cued. Chainlink consent
  (≥3% block, 25% ceiling) + DefiLlama 422 catch feeded/DefiLlama pairs; SC-04+R1+minimumOutput terminal.
- **This PR improves the state:** renders the previously-dead `lowConfidence` cue (React-escaped, non-alarmist),
  corrects the "display-only" mischaracterization (names the gates), adds honest adversarial tests (deterministic;
  NEW-1 flake reconciled via tie-stability). Composes with #248 (keeper-side, no conflict) / #18 (consent gate) /
  #261 (executable-sources + SC-04 → quote-only can't be executable winner).
- **Recommendation: Option 2** (external-reference-confirmed demotion + flag-without-reorder fallback for
  oracle-less+DefiLlama-less) — concurs with the Architect; remediation prompt handed to the Code Agent.
  Options 1 (loses mis-scale catch) / 3 (leaves the gap) rejected.

### AUDIT NEW-2 M-01 RE-CONFIRM — reference-confirmed demotion (PR #275, 2026-07-02) — **NEW2-M-01 CLOSED**

**Verdict: NEW2-M-01 CLOSED — 0C / 0H. PR #275 APPROVED to merge.** Report:
`Audits/Sprint/AUDIT-NEW2-M01-RECONFIRM-AUDIT.md`. Branch `chore/quorum-reference-confirmed-demotion`, audited
SHA `0b6264d` (SSH-signed). #275 implements the agreed Option 2 correctly.

- **Gap CLOSED (all regimes, test-proven):** referenced pair + attacker >5% under an honest winner + reference
  confirms winner → **winner KEPT, lowConfidence false** (the former `(a) FLAGGED GAP` test now asserts the
  attack defeated); mis-scaled-high winner deviating from ref → **still demoted** (mis-scale preserved);
  no-reference pair → **flag-without-reorder** (honest winner keeps the slot). Band trip resolves the reference
  **lazily** (integrity-gated Chainlink via `validateRoundData`, else DefiLlama; same-methodology only → can't be
  stale-wrong or gamed).
- **Item A (double-defect: winner >band above ref AND runner-up >band below):** shipped demotes to the too-low
  runner-up (flagged) — **ACCEPTED as bounded** (the reference gate that flagged it blocks the fill at execution:
  Chainlink ≥3%/25% or DefiLlama 422 + on-chain minimumOutput → no fund loss). Optional defense-in-depth prompt
  **NEW2-L-01** (confirm runner-up sane before presenting; else flag-without-reorder) — **non-blocking**.
- **Item B (ref-confirmed → lowConfidence false):** **CORRECT/SAFE — ACCEPTED** (oracle-cross-validated is
  strictly stronger; 1-responder/no-reference/demotion/both-below all still flag).
- Gates terminal (SC-04/R1/minimumOutput untouched); composes with #248/#18/#261; deterministic; no new gaming.

**Net:** NEW2-M-01 **CLOSED**. Open follow-up: NEW2-L-01 (optional item-A hardening, LOW, non-blocking).

### AUDIT P1a — On-chain floor: Phase-0 keeper mitigation + ADR-013 (PR #279, 2026-07-08)

**PART A verdict: APPROVED — 0C / 0H. PR #279 (Phase 0) may merge. PART B: ADR-013 APPROVED-TO-IMPLEMENT.**
Report: `Audits/Sprint/AUDIT-P1A-ONCHAIN-FLOOR-AUDIT.md`. Branch `sprint/order-onchain-floor`, audited SHA
`b764b1a` (SSH-signed). Addresses threat-model P1a (HIGH — DCA had no on-chain floor: 1-wei minOut +
routerDataHash=0). Keeper `node --test`: **28/28**.

| Check | Result |
|-------|--------|
| DCA fill < ref×(1−300bps) → REJECTED (delay, not force) | ✅ `order-floor.js decideFloor`; env-clamped [50,2000]; reject = skip+retry+page (no-op, funds stay). Chainlink ETH-leg else DefiLlama (5s cap). |
| Silent public-mempool fallback removed | ✅ `submission-policy.js`: mainnet relay-required-else-**refuse** (fail-closed); explicit `ALLOW_PUBLIC_MEMPOOL` only. |
| Base = sequencer-private (sound) | ✅ single sequencer, private mempool → third-party sandwich absent; residual (sequencer/cross-domain) covered by the oracle floor. Corrects the threat model's overstated "Base sandwichable". |
| Phase 0 can't worsen safety | ✅ off-chain only; SC-04/R1/on-chain minimumOutput untouched; rejected fill = no-op; no ALLOW_PLAINTEXT_KEY change. |

**Fail-open adjudication:** on reference failure (no Chainlink AND no DefiLlama) the fill is flagged-not-rejected
(fail-OPEN). **ACCEPTED for Phase 0** — fail-closed would strand permanently-oracle-less DCAs + halt DCA on
transient outages; residual is bounded (only exploitable with a concurrent keeper/route compromise; interim;
ADR-013 §1 no-feed signed-absolute-min closes it on-chain). Refinement = **P1A-M-01 (MED, non-blocking)**:
distinguish transient-outage-of-a-feeded-pair (→ delay) from genuinely no-feed (→ flag) + USD cap on fail-open fills.

**ADR-013 (design, no code):** APPROVED-TO-IMPLEMENT. §1 signed `maxSlippageBps` (keeper-un-griefable) + Chainlink
read at execution + REVERT (no 1-wei clamp, no dust) + no-feed signed-absolute-min; §2 routerDataHash (DCA bound by
oracle floor, non-DCA real hash → closes P1c); §3 Permit2 bitmap nonce (closes P1b); deploy plan = v3 + mandatory
Auditor pass + 48h timelock + dual-run migration + runbook. **Design notes for the v3 sprint (not blockers):**
N1 feed-staleness stranding-recovery, N2 no-feed absolute-min UX derivation, N3 clamp `maxSlippageBps` on-chain,
N4 decimals-safe fair-value math. INFO P1A-I-01: Phase-0 comments say ADR-011; the ADR is ADR-013.
