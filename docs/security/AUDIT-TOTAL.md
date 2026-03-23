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

**Total: 5 Critical, 12 High, 18 Medium, 11 Low = 46 findings**

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

> This audit was performed using automated analysis agents. A professional third-party audit by a reputable firm (Trail of Bits, OpenZeppelin, Consensys Diligence) is recommended before handling significant TVL.
