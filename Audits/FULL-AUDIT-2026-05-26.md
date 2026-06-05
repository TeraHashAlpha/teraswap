# TeraSwap — Full Project Audit

## Date: 2026-05-26
## Scope: Pre-Phase 2 comprehensive review
## Branch reviewed: `main` at `8bcf5c8` (post Sprint 30 merge)
## Auditor: Claude Code (read-only, multi-agent assisted)

---

## Executive Summary

TeraSwap is in a **healthy production state** with strong security fundamentals, mature CI/CD discipline, and a clean architectural separation between layers. The codebase compiles cleanly (`npx tsc --noEmit` 0 errors), tests are green (989/989, 0 skipped), `npm run lint` exits 0 with 142 pre-existing warnings, and the production build succeeds under Turbopack. Sprints 26 (FeeCollector V2 activation), 29 (performance optimization), and 30 (operational backlog cleanup) have all merged through the PR + audit gate, with every leaf commit GPG/SSH-signed.

The dominant risk vector is **dependency staleness**: 22 moderate `npm audit` advisories are all transitive (`uuid`, `ws`) through the `wagmi → @rainbow-me/rainbowkit → @metamask/sdk` chain, and resolving them requires a disruptive wagmi 2 → 3 major bump. Seven other major-version bumps are pending (React 18→19, TypeScript 5→6, Tailwind 3→4, zustand 4→5, eslint 9→10, @tsparticles 3→4, @types/node 20→25). None are urgent for production stability, but the cumulative migration cost compounds — these should be staged across Phase 2 sprints rather than deferred indefinitely.

Three structural findings warrant action before new features: (1) **test coverage** of `src/lib/` sits at ~30% with all 13 aggregator adapters and the order-engine Supabase layer untested, despite handling the highest-risk swap construction paths; (2) two **god-modules** are approaching unmanageable size — `useSwap.ts` (1101 LOC) and `AdminMonitor.tsx` (1106 LOC); (3) **observability gaps** in the CI pipeline — no CodeQL or secrets scanning, and `forge coverage` is not run for the Solidity layer. The application code itself contains no Critical/High exploitable bugs in this audit's scope — security findings are all configuration tightening, race condition mitigations, or defense-in-depth improvements.

---

## Security Findings

Severity is normalized per audit conventions (Critical = fund loss or auth bypass; High = data exposure or privilege escalation; Medium = misconfiguration or denial-of-service; Low/Info = defense in depth).

| ID | Severity | File:Line | Description | Recommendation |
|----|----------|-----------|-------------|----------------|
| SEC-01 | Medium | `src/lib/supabase.ts:77-85` | Supabase logger fallback race: `_loggerFallbackWarned` flag is non-atomic; under concurrent cold starts multiple paths can fall back to the service-role client before the logger client initializes. No fund flow impact; observability noise + over-privileged write window. | Initialize the logger client eagerly at module load; use a one-shot `Promise` to gate access. Alternatively, fail-loudly when `SUPABASE_LOGGER_KEY` is unset in production (covered by P168 ops task). |
| SEC-02 | Medium | `src/app/api/telegram/webhook/route.ts:76,164,582` | Timestamp + module-level counter is used to generate audit-trail KV keys (`${prefix}${Date.now()}:${++auditSeq}`). Under multi-instance Vercel autoscale, two callbacks in the same millisecond on different processes will produce identical keys, overwriting each other's audit row. | Append `crypto.randomUUID()` or a per-process nonce to the key. Audit row loss is the only impact, but it defeats forensic replay. |
| SEC-03 | Medium | `src/app/api/admin/kill-switch/route.ts:36-59` | In-memory rate limiter for the emergency kill-switch route is a module-level `Map` without an explicit size cap. The setInterval cleanup defers eviction; under sustained probing from random source IPs the map grows monotonically until process restart. Route is auth-gated, so the blast radius is restricted to authenticated callers. | Add a hard `MAX_MAP_SIZE` with LRU eviction, or migrate to Upstash KV for distributed enforcement. Document the constraint inline. |
| SEC-04 | Medium | `src/lib/calldata-recipient.ts:340-346` | Nested multicall recursion stops at depth=0 and bails on a second-level multicall with a "skipping" log. A malicious adapter could wrap `swap()` inside `multicall(multicall(swap))` so the inner recipient never reaches the validator. Risk is partially mitigated by the router whitelist (only known-good aggregators reach this code path), but the validator should not silently fail-open. | Increase `depth` to 2, OR reject any multicall with `depth > 0` and log a security event. Add unit tests for the depth-1 nested case. |
| SEC-05 | Medium | `src/app/api/admin/api-keys/route.ts:132-145` | Hard cap on rate limits silently downgrades over-cap requests instead of rejecting them. An admin setting `rateLimitPerMin: 999999999` receives a warning but the key is created with the capped value — easy to misread as "request honored". | Return 400 + require an explicit `?force=true` query param to apply caps, or reject outright. Visible failure beats silent downgrade for compliance audit trails. |
| SEC-06 | Medium | `next.config.js:28` (dev only) | `script-src` includes `'unsafe-inline'` in development to satisfy Next.js HMR. Production correctly excludes it. The dev/prod parity gap means a compromised dev environment cannot reproduce prod CSP enforcement. | Document the dev relaxation explicitly in SECURITY.md. Add a CI assertion that `'unsafe-inline'` only appears under `NODE_ENV === 'development'`. Consider nonce-based CSP as a future Next.js feature lands. |
| SEC-07 | Low | `src/app/api/v1/swap/route.ts:199-207` | The `recipient` parameter is silently rejected on `/v1/swap` when `recipient !== sender` because FeeCollector V2's balance-delta check only measures `msg.sender`. The 400 error is correct but the API surface dead-ends external integrators with no migration path until V3. | Document the V2 limitation in the public API reference. Surface the constraint in `/v1/quote` so callers learn early instead of at swap time. |
| SEC-08 | Low | `src/app/api/log-activity/route.ts:87` | Fire-and-forget Supabase insert wraps `.catch(() => {})`. If the logger-role key is revoked or RLS blocks the insert, the operator gets no signal until they notice missing rows. | Replace with `.catch(err => console.warn('[log-activity] insert failed:', err))`. Rate-limit log noise if it becomes excessive. |
| SEC-09 | Low | `src/lib/env-validation.ts:96-110` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` has no `pattern` validation despite being a JWT-shaped string. A truncated copy/paste from the Supabase dashboard would deploy successfully and fail mysteriously at runtime. | Add `pattern: /^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/`. |
| SEC-10 | Low | `src/app/api/rpc/route.ts:29-42` | The RPC method gate is a blocklist (`BLOCKED_METHODS`). A new wallet-signing JSON-RPC method introduced by an Ethereum/wallet vendor could slip through until the blocklist is updated. | Migrate to an allowlist of read-only methods (`eth_call`, `eth_getBlockByNumber`, `eth_getTransactionReceipt`, `eth_chainId`, etc.). Higher maintenance burden, but fail-closed by default. |
| SEC-11 | Low | `src/app/api/monitor/route.ts:41-49` | `safeCompare(key, secret)` requires exact equality; leading/trailing whitespace from `curl` headers silently 401s without explanation. UX issue, not a security one. | Trim Bearer tokens after the `Bearer ` prefix. |
| SEC-12 | Info | `src/app/api/telegram/webhook/route.ts:372-430,542-570` | Distinct error responses for "not authorized" vs "source not found" theoretically allow an attacker in the Telegram group to enumerate source IDs by trial. **In practice** source IDs (`1inch`, `velora`, `cowswap`, etc.) are public in every `/quote` response, so the enumeration value is zero. Flag for review, not a real risk. | Optionally normalize to a single "unknown command" message for consistency. No urgency. |

**No Critical or High findings**. No raw-HTML React injection APIs used anywhere in the codebase. No hardcoded API keys or secrets in source. All hardcoded `0x…` addresses are defensible zero-address constants (`0x0…`), the Permit2 max-allowance sentinel (`0xffff…ffff`), or clearly-fake analytics seed data (`src/lib/analytics-seed.ts`).

---

## Code Quality Findings

| ID | Category | File:Line | Description | Recommendation |
|----|----------|-----------|-------------|----------------|
| CQ-01 | Architecture | `src/components/AdminMonitor.tsx` (1106 LOC) | God-component spanning stats aggregation, sybil detection UI, revenue analytics, wallet clustering, activity table, and seed tools. Single-responsibility violation. | Refactor into 5–6 sub-components plus a `src/lib/admin-analytics.ts` helper. Schedule across 2 sprints to avoid disruption. |
| CQ-02 | Architecture | `src/hooks/useSwap.ts` (1101 LOC) | Mega-hook combining swap simulation, fee validation, CoW order flow, transaction polling, and error recovery. Touches the highest-risk path. | Split into `useSwapSimulation`, `useSwapExecution`, `useSwapPolling`; keep `useSwap` as a thin orchestrator. Test each sub-hook independently. |
| CQ-03 | Architecture | `src/components/LandingBelowFold.tsx` (987 LOC) | Long file by necessity (multiple landing-page sections), but the inline framer-motion variants and per-section helpers could move to a shared module. | Extract animation variants to `src/lib/landing-animations.ts`. Acceptable to keep section components inline since they're tightly coupled. |
| CQ-04 | Architecture | `src/components/SwapBox.tsx` (911 LOC) | Approaching threshold. Currently healthy — keep an eye on it. | Defer refactor until it crosses 1000 LOC or accumulates new responsibilities. |
| CQ-05 | Architecture | (positive) | No circular dependencies. Layer boundaries cleanly enforced (`lib/` is a leaf; `hooks/` consumes `lib/`; `components/` consumes both; `app/` orchestrates). Wagmi/viem isolated to `src/lib/rpc.ts` and the hooks layer. | Maintain. Document the layering rule in CONTRIBUTING.md so it survives team growth. |
| CQ-06 | TypeScript | Counts across `src/` (non-test) | 20× `: any`, 3× `as unknown` casts, 0× `@ts-ignore` / `@ts-expect-error`, 61× `Record<string, unknown>`. The `any` uses are intentional and documented (request body shaping with downstream runtime guards); the `unknown` casts are at Supabase serialization edges; the `Record<string, unknown>` clusters are API-boundary types. | Acceptable for now. Schedule a "type narrowing" sprint to convert 10–15 `Record<string, unknown>` instances in `src/lib/analytics.ts` to concrete `TradeEvent` / `DashboardData` shapes. |
| CQ-07 | Tech debt | `src/lib/tokens.ts:138` | TODO: 1inch token logo CDN returns 403 for some addresses; fallback to local `/public/tokens/bold.png` not implemented. | Implement fallback in `fetchTokenLogo()`. Wraps an existing 5-line function; <1h work. |
| CQ-08 | Tech debt | `src/lib/constants.ts:300-301` | TODO: rETH and wstETH Chainlink feeds are ETH-denominated, not USD; `evaluateDeviation()` will mis-compare against USD execution prices. Currently these tokens aren't price-validated. | Block deviation evaluation for these feeds until USD conversion logic is added in `chainlink.ts`. ~50 LOC plus test fixtures. |
| CQ-09 | Error handling | `src/lib/limit-order-api.ts`, `src/lib/cow.ts` (3 sites) | `.catch(() => ({}))` around `JSON.parse` of error responses silently masks API protocol drift. | Add `console.warn` before returning the empty object so operational anomalies surface in logs. |
| CQ-10 | Error handling | `src/hooks/usePersonalAnalytics.ts` | `await res.json().catch(() => ({}))` swallows parse + network errors. Hook callers cannot distinguish "no data" from "fetch failed". | Log via `console.error` and return a typed `{ events: [] }` sentinel so the calling component can render an empty-state instead of perpetual loading. |
| CQ-11 | Error handling | (positive) | All 29 API routes return the same `{ error: string }` shape with appropriate status codes. Stack traces never leak to clients. 21 silent `catch {}` blocks audited — all but the 4 above are legitimate (`localStorage` access, UI animation cleanup). | Maintain pattern. Consider an ESLint rule (`@typescript-eslint/no-empty-function`) to prevent regression. |
| CQ-12 | Performance | `src/components/` framer-motion | 8 components import framer-motion directly. Only `LandingPage` and below-fold sections are dynamic-imported. | Acceptable — the remaining users (`ScrollSpy`, `HelpButton`, `NotificationBanner`, etc.) are small and stay client-side anyway. |
| CQ-13 | Performance | `src/lib/tokens.ts` (764 LOC) | Large embedded token list ships in the initial bundle. | Defer until token catalog grows past ~15k entries; current scale doesn't need lazy load. |
| CQ-14 | Documentation | (positive) | Most modules have detailed header docstrings citing prompt IDs (LP-10, P97, P140, etc.) and architecture decisions. Exceptional discipline. | Maintain. Consider adding a `docs/ARCHITECTURE.md` that summarises the layering rules and pointer-to-source-of-truth comments for new contributors. |

---

## Frontend/UX Findings

| ID | Category | File:Line | Description | Recommendation |
|----|----------|-----------|-------------|----------------|
| FE-01 | A11y | `src/components/TokenSelector.tsx:203,247,351` | Token logo `<img>` tags use `alt=""` (decorative) despite serving an identifying role for the token. | Use `alt="USDC logo"` (token symbol). Critical for screen-reader users selecting tokens. |
| FE-02 | A11y | `src/components/TransactionPreview.tsx:138`, `SlippageModal.tsx:66`, `SourceToggle.tsx:35` | Backdrop `<div>` elements have `onClick` close handlers but no `onKeyDown` / `role="button"` / `tabIndex`. Keyboard users cannot dismiss these overlays. | Either upgrade to `<button>` or add `role="button"`, `tabIndex={0}`, and Space/Enter handlers. Pair with a focus-trap inside the modal. |
| FE-03 | A11y | `src/components/TokenSelector.tsx:225` | The close "×" button uses HTML entity `&#10005;` with no `aria-label`. | Add `aria-label="Close"` to the button. |
| FE-04 | A11y | `src/components/TransactionPreview.tsx:292` | `text-cream-35` (alpha 0.35) on `bg-surface` in the raw-calldata block — fails WCAG AA. | Bump to `text-cream-50` or `text-cream-65`. |
| FE-05 | A11y | (positive) | No `<img>` without `alt`. No `onClick` on `<div>` for primary interactive elements (modals only). Semantic landmarks (`<main>`, `<nav>`, `<header>`, `<footer>`) are present. No raw-HTML React injection anywhere. | Maintain. |
| FE-06 | Responsiveness | Multiple | Several components use `max-w-[calc(100vw-2rem)]` to prevent mobile overflow; works but duplicates viewport math. | Extract to a Tailwind utility (`w-screen-safe` or similar) in `tailwind.config.ts`. |
| FE-07 | Responsiveness | `src/components/SwapBox.tsx:522-523`, `QuoteBreakdown.tsx:355` | Touch targets ("50%", "MAX") are `min-h-[44px]` on mobile but `min-h-0` on `sm:` — asymmetric. Compliant per WCAG, but inconsistent visual rhythm. | Keep 44px minimum across breakpoints, or document the rationale. |
| FE-08 | Loading & Error | `src/components/SlippageModal.tsx`, `Permit2EducationModal.tsx` | Have `role="dialog"` but lack `aria-modal="true"` and `aria-label` (`TransactionPreview` has both). Inconsistent. | Standardize: every modal should have both attributes. |
| FE-09 | Loading & Error | `src/components/AdminMonitor.tsx:1002` | Dashboard refresh updates a large table with no `aria-live` region. Screen-reader users miss the update. | Add `role="status" aria-live="polite"` to the dynamic section. |
| FE-10 | Asset | `src/components/TokenSelector.tsx:203,247`, `WalletModal.tsx:141` | Token logos and ENS avatars have no `onError` fallback. Broken image URL → empty box. | Render a fallback (token symbol initials, wallet address badge) in the error path. |
| FE-11 | Styling | `src/components/LandingBelowFold.tsx` (~9 sites), `TokenSelector.tsx` (6 sites), `AdminMonitor.tsx` (5 sites) | Inline `style={{ color: '#C8B89A' }}` and `className="bg-[#080B10]"` repeated where `cream-gold`, `surface`, `surface-secondary` design tokens exist. | Replace arbitrary values with token classes. Tightens the design system and reduces drift risk if palette changes. |
| FE-12 | Image opt | (positive) | The landing page uses `next/font/google` for Inter + JetBrains Mono (Sprint 29 P89), preconnects fontshare for Clash Display (P90), and dynamically imports below-fold sections (P91). FCP/LCP wins are real. | Maintain. After deploy, re-run PageSpeed Insights to confirm mobile ≥ 65. |

---

## Infrastructure Findings

| ID | Category | Description | Recommendation |
|----|----------|-------------|----------------|
| INF-01 | CI | Three GitHub Actions workflows: `ci.yml` (lint/typecheck/audit/lockfile-lint/test/build), `security-audit.yml` (weekly + on push/PR), `monitoring-watchdog.yml` (5-min cron, healthcheck). All actions are commit-SHA-pinned, not just version-tagged. Excellent supply-chain hygiene. | Maintain. |
| INF-02 | CI | No CodeQL workflow. JS/TS SAST coverage is delegated to ESLint only. | Add `codeql-analysis.yml` (free for public repos; reasonable rate-limit for private). Cost: 5–10 min per PR. |
| INF-03 | CI | No secrets scanning (`gitleaks` / `truffleHog` / GitHub Advanced Security secret scanning). Env-var discipline is strong in code, but a one-shot pre-commit gate is cheap insurance. | Add `gitleaks` as a pre-commit hook + GitHub Action. |
| INF-04 | CI | `lockfile-lint` enforces npm registry + HTTPS + integrity hashes + `.npmrc min-release-age=7d` (refuses packages published < 7 days). Strong defense against supply-chain attacks. | Maintain. |
| INF-05 | CI | `npm audit` gates on `--audit-level=high` (current state: 22 moderate, 0 high/critical) so the gate is currently passing despite the 22 advisories. Moderate-level breakage is intentional given they're transitive in `wagmi`. | Document the rationale in `docs/security/AUDIT-TOTAL.md`. Re-evaluate after wagmi 3 migration. |
| INF-06 | CSP | `next.config.js` defines 9 security headers + CSP. `vercel.json` mirrors all except CSP (which uses dev-only `unsafe-eval`). Manual sync between the two files is fragile. | Add a CI assertion that the two header lists stay in sync (excluding CSP). Or extract headers to a shared `lib/security-headers.ts` consumed by both. |
| INF-07 | Contracts | `forge test` runs in CI but `forge coverage` does not. Coverage is unknown. | Add `forge coverage --report summary` to CI. Even if slow (~30s), it surfaces uncovered branches in fund-flow contracts. |
| INF-08 | Contracts | No `CONTRACTS.md` documenting deployed addresses, audit dates, and verification proofs. Information is scattered across `docs/ADR/`, `docs/security/`, and incident reports. | Create `docs/CONTRACTS.md` listing FeeCollector V1/V2, OrderExecutor v2 addresses with Etherscan links and audit references. |
| INF-09 | Env vars | `.env.example` is comprehensive (~72 vars across 7 categories) but drifts from actual code reads: `ODOS_API_KEY`, `ADMIN_API_KEYS_SECRET`, `EXECUTOR_VALIDATION_SECRET`, `MONITOR_SECRET` are read in code but missing from `.env.example`. `FLASHBOTS_RPC_URL` and `NEXT_PUBLIC_LAUNCH_DATE` are declared but unread. | Sync the file in a small documentation-only commit. |
| INF-10 | Commit signing | 9/9 leaf commits in `main..HEAD~50` are GPG/SSH-signed (`G`). Merge commits show `N` locally because `gpg` is not installed on this machine — GitHub itself validated and signed those merge commits at PR-merge time (visible on github.com). | Install `gpg` locally if you want to verify offline. The remote-side signing chain is intact. |
| INF-11 | Webpack | `next.config.js` declares `webpack()` with `splitChunks.cacheGroups` for viem and wagmi. Next.js 16 defaults to Turbopack, which silently ignores this config. Documented in code and FEEDBACK.md (Sprint 29 P92). | Acceptable; activates on `next build --webpack` if/when the project falls back to webpack. |

---

## Dependency Report

### npm audit summary

**22 moderate-severity advisories, 0 high, 0 critical.** All transitive through the wallet stack:

| Advisory | Severity | Package | Root path |
|----------|----------|---------|-----------|
| GHSA-w5hq-g745-h8pq | Moderate | `uuid <11.1.1` (missing buffer bounds check in v3/v5/v6) | `@rainbow-me/rainbowkit → @wagmi/connectors → @metamask/sdk → @metamask/* → uuid` |
| GHSA-58qx-3vcg-4xpx | Moderate | `ws 8.0.0-8.20.0` (uninitialized memory disclosure) | `wagmi → @walletconnect/* → ws` and `viem → ws` |

**Minimum bump that clears both:** `wagmi@3.x` + `viem@2.50.4+`. The wagmi bump is a major migration (connector API rewrite, `useContractRead`/`useContractWrite` removed). The viem bump is a patch — safe to ship independently.

**Extraneous packages in `node_modules` not declared in `package.json`:**
- `@emnapi/core@1.10.0`
- `@emnapi/runtime@1.10.0`
- `@emnapi/wasi-threads@1.2.1`
- `@tybys/wasm-util@0.10.1`

These look like leftovers from a build-tool install. Worth a `rm -rf node_modules && npm ci` to confirm they don't survive a clean install. If they reappear, identify the parent dep.

### Outdated packages

| Package | Current | Latest | Type | Migration cost |
|---------|---------|--------|------|----------------|
| **wagmi** | 2.19.5 | 3.6.15 | prod | Disruptive (connector API, hook removals) — **clears the vuln chain** |
| **react / react-dom** | 18.3.0 | 19.2.6 | prod | Moderate (automatic batching, hydration semantics) |
| **@types/react / @types/react-dom** | 18.3.0 | 19.2.x | dev | Pair with React 19 |
| **typescript** | 5.9.3 | 6.0.3 | dev | Moderate (TS 6 stricter modes, ECMAScript 2024) |
| **tailwindcss** | 3.4.19 | 4.3.0 | dev | Moderate (CSS generation refactor; config migration) |
| **zustand** | 4.5.7 | 5.0.13 | prod | Trivial (TS improvements; API stable) |
| **eslint** | 9.39.4 | 10.4.0 | dev | Trivial (flat config already in use) |
| **@types/node** | 20.19.41 | 25.9.1 | dev | Trivial; already bumped within 20.x in Sprint 30 |
| **@tsparticles/react / @tsparticles/slim** | 3.x | 4.0.5 | prod | Moderate (coordinate both) |
| **viem** | 2.47.4 | 2.50.4 | prod | Patch — clears `ws` advisory |
| **@supabase/supabase-js** | 2.99.1 | 2.106.0 | prod | Patch |
| **@tanstack/react-query** | 5.50.1 | 5.100.11 | prod | Patch |
| **framer-motion** | 12.36.0 | 12.39.0 | prod | Patch |
| **@upstash/redis** | 1.37.0 | 1.38.0 | prod | Patch |
| **@capacitor/browser / cli / core / ios** | 8.0.2 / 8.2.0 | 8.0.3 / 8.3.4 | prod | Patch |
| **@rainbow-me/rainbowkit** | 2.1.0 | 2.2.11 | prod | Minor (within range that depends on metamask-sdk; doesn't clear vuln chain on its own) |

### Dependency removal candidates

- **axios** override (`package.json:overrides`) — no `import axios` anywhere in `src/`. Likely a stale transitive constraint. Drop the override; re-run `npm install`; verify nothing breaks.
- Confirm the 4 extraneous WASM packages don't reappear after a clean install.

---

## Test Coverage Gaps

**989 tests passing, 0 skipped.** Coverage is excellent in API routes and core monitoring logic but uneven across `src/lib/`.

| Layer | Files | Tested | Untested | % | Priority |
|-------|-------|--------|----------|---|----------|
| `src/lib/adapters/` | 13 | 0 | 13 | 0% | **P1** — every aggregator quote/swap path |
| `src/lib/order-engine/` | 5 | 0 | 5 | 0% | **P1** — Supabase CRUD + real-time subscription |
| `src/lib/alert-channels/` | 3 | 0 | 3 | 0% | P2 — monitoring side-channels |
| `src/lib/` (other) | 68 | 6 | 62 | 9% | **P0** — `api-auth.ts`, `simulation.ts`, `validation.ts`, `rpc.ts` |
| `src/hooks/` | 31 | 26 | 5 | 84% | P2 — `usePersonalAnalytics`, `useSwapHistory`, `useActiveApprovals`, `useOrderNotifications`, `useAnalytics` |
| `src/components/` | 54 | 10 | 44 | 19% | P3 — focus on `SwapBox`, `LimitOrderPanel`, `ConditionalOrderPanel`, `OrderDashboard` |
| `src/app/api/` | 29 | 17 | 12 | 59% | P1 — gap-fill remaining routes |
| **Total** | **253** | **65** | **188** | **~26%** | — |

**Highest-leverage additions:**
1. `src/lib/api-auth.ts` — handles API key SHA-256 hashing + per-tier rate-limit accounting. Security-critical, untested.
2. `src/lib/simulation.ts` — pre-swap tx simulation that gates user funds. Untested.
3. `src/lib/validation.ts` — address/hash regex + `safeBigInt`. Untested directly (covered indirectly by route tests).
4. `src/lib/adapters/*.ts` — 13 files, each interacting with an external aggregator API. Mock fixtures + happy path + error response = ~8–12h per adapter.
5. `src/lib/order-engine/supabase.ts` — order CRUD + subscriptions for the limit/DCA/SL/TP engines. Mocked Supabase client should suffice.

---

## Recommendations (Prioritised)

### Critical (do before Phase 2)

1. **Resolve the wagmi 2 → 3 migration plan.** Even if execution slips into Phase 2, scope the work now: cost-class assessment, breaking-change inventory, test plan. This unblocks both moderate npm advisories and the React 19 / TypeScript 6 chain. Pair with `viem 2.47 → 2.50` (patch) to clear the `ws` advisory immediately.
2. **Add unit tests for `src/lib/api-auth.ts`, `src/lib/simulation.ts`, `src/lib/validation.ts`.** Three files, all security-critical, zero direct test coverage. Estimated 3–5 eng days.
3. **Recreate `SUPABASE_LOGGER_KEY`** on Vercel (Sprint 30 P168 — manual ops task). Currently the service-role key is used as fallback, which violates least-privilege (M-03 in the existing audit backlog).

### High (do in next 2 sprints)

4. **Refactor `src/hooks/useSwap.ts` (1101 LOC) into three sub-hooks.** This is the highest-risk component in the codebase — splitting it improves both testability and reviewability. Stage across Phase 2.
5. **Add CodeQL workflow** for JS/TS SAST. Catches taint flows and logic bugs ESLint misses.
6. **Add secrets scanning** (`gitleaks` pre-commit + GitHub Action).
7. **Add `forge coverage` to CI.** Even if it's slow, it gives visibility into the Solidity test surface.
8. **Resolve SEC-04 (nested multicall depth).** Either increase `depth` limit to 2 or reject `depth > 0` outright. Add a unit test for the regression.
9. **Fix `.env.example` drift** (INF-09). Documentation-only, ~30 min.

### Medium (backlog)

10. **Test adapter layer** (`src/lib/adapters/*.ts`, 13 files). Build a shared adapter test harness with mocked fetch fixtures. Estimated 2–3 sprints.
11. **Test `src/lib/order-engine/supabase.ts`** with a mocked Supabase client.
12. **Resolve constants.ts Chainlink TODOs** (rETH + wstETH ETH-denominated feeds need USD conversion).
13. **Implement 1inch token-logo 403 fallback** (`src/lib/tokens.ts:138`).
14. **Address frontend a11y backlog** (FE-01 through FE-04, FE-08, FE-10) — quick wins, ~4–6h total.
15. **Replace hardcoded hex values with Tailwind tokens** in LandingBelowFold, TokenSelector, AdminMonitor (FE-11).
16. **Stage React 18 → 19 / TS 5 → 6 / Tailwind 3 → 4 / zustand 4 → 5** as a single "framework refresh" sprint after wagmi 3.
17. **Drop the unused `axios` override** and the 4 extraneous WASM packages.

### Low / Info (nice to have)

18. **Refactor `AdminMonitor.tsx`** (1106 LOC) — internal tool, lowest user-facing risk.
19. **Migrate `api/rpc` blocklist → allowlist** (SEC-10) — more maintenance burden, but fail-closed.
20. **Add `aria-live` regions** to dynamic tables (FE-09).
21. **Document the dev-only `unsafe-inline` CSP relaxation** (SEC-06) and add CI assertion that it never appears in prod.
22. **Create `docs/CONTRACTS.md`** listing deployed addresses, audit dates, and verification proofs.

---

## Positive Observations

- **Strong security fundamentals.** Comprehensive CSP with 9 hardening headers, frame-ancestors: none, restrictive Permissions-Policy. No raw-HTML React injection APIs in use. No hardcoded API keys or secrets. Server-only vs `NEXT_PUBLIC_` separation is consistently respected. Constant-time API-key comparisons via SHA-256 + `timingSafeEqual`. Comprehensive router whitelist + decoded-recipient validation at the calldata layer.
- **Mature CI/CD.** All GitHub Actions pinned to commit SHAs (not just version tags). `lockfile-lint` validates npm registry, HTTPS, integrity hashes. `.npmrc min-release-age=7d` blocks zero-day supply-chain attacks. Three workflows cover lint/typecheck/audit/build/contracts in parallel.
- **Commit discipline.** Every leaf commit GPG/SSH-signed. Conventional sprint-prompt naming (`[P89]`, `[P162]`, etc.) gives clean traceability from architecture spec → commit → audit.
- **Documentation culture.** Module-level docstrings reference prompt IDs (LP-10, P97, P140). FEEDBACK.md captures Code Agent caveats per prompt. ADRs are versioned and never deleted. Sprint packets live under `docs/Prompts/`.
- **Architectural cleanliness.** Clear `app/ → components/ → hooks/ → lib/` layering with no circular dependencies. Wagmi/viem isolated to `src/lib/rpc.ts` and the hooks layer. Constants centralized.
- **Test discipline.** 989 tests passing, 0 skipped. The recent Sprint 26 P163 re-enabled 19 fee-collectable tests that had been deliberately skipped during the FeeCollector V2 timelock window — execution was on schedule.
- **Performance focus.** Sprint 29 (P89-P92) eliminated render-blocking Google Fonts (~2100ms mobile savings), added preconnect hints, lazy-loaded below-fold sections, and audited viem tree-shaking. Real shipping wins, not theatre.
- **Operational hygiene.** Three CI workflows + Cloudflare Worker cron heartbeat + GitHub Actions watchdog + Telegram alerts + Sentry. Multi-channel coverage with documented runbooks.
- **Zero `@ts-ignore` or `@ts-expect-error` in `src/`.** Type safety is taken seriously.

---

## Appendix A — `npm audit` raw output (excerpt)

```
# npm audit report

uuid  <11.1.1
Severity: moderate
uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided
- https://github.com/advisories/GHSA-w5hq-g745-h8pq
fix available via `npm audit fix --force`
Will install wagmi@3.6.15, which is a breaking change
  @metamask/sdk  *
    @wagmi/connectors  <=0.0.0-wc-links-20240926225814 || 4.0.0-alpha.0 - 4.0.0-rc.3 || 4.0.1 - 7.2.1
      wagmi  <=0.0.0-wc-links-20240926225814 || 2.0.0-alpha.0 - 2.0.0-rc.3 || 2.0.1 - 3.5.0

ws  8.0.0 - 8.20.0
Severity: moderate
…

22 moderate severity vulnerabilities
```

## Appendix B — `npm outdated` raw output

```
Package                  Current    Wanted    Latest
@capacitor/browser         8.0.2     8.0.2     8.0.3
@capacitor/cli             8.2.0     8.2.0     8.3.4
@capacitor/core            8.2.0     8.2.0     8.3.4
@capacitor/ios             8.2.0     8.2.0     8.3.4
@rainbow-me/rainbowkit     2.1.0     2.1.0    2.2.11
@supabase/supabase-js     2.99.1    2.99.1   2.106.0
@tanstack/react-query     5.50.1    5.50.1  5.100.11
@tsparticles/react         3.0.0     3.0.0     4.0.5
@tsparticles/slim          3.9.1     3.9.1     4.0.5
@types/node             20.19.41  20.19.41    25.9.1
@types/react              18.3.0    18.3.0   19.2.15
@types/react-dom          18.3.0    18.3.0    19.2.3
@upstash/redis            1.37.0    1.37.0    1.38.0
eslint                    9.39.4    9.39.4    10.4.0
framer-motion            12.36.0   12.36.0   12.39.0
react                     18.3.0    18.3.0    19.2.6
react-dom                 18.3.0    18.3.0    19.2.6
tailwindcss               3.4.19    3.4.19     4.3.0
typescript                 5.9.3     5.9.3     6.0.3
viem                      2.47.4    2.47.4    2.50.4
wagmi                     2.19.5    2.19.5    3.6.15
zustand                    4.5.7     4.5.7    5.0.13
```

## Appendix C — Audit methodology

Four parallel exploration agents were dispatched against read-only views of the working tree at `main` (`8bcf5c8`):

1. **Security audit** — API routes, fund-flow logic, secrets, raw-HTML React injection surface, Supabase RLS reliance, CSP/headers.
2. **Code quality & architecture** — module structure, dead code, TODO comments, TS strictness, error handling, performance, test coverage.
3. **Frontend/UX** — accessibility, responsiveness, loading/error states, image optimization, styling consistency.
4. **Dependency & infrastructure** — dep inventory, vuln map, outdated packages, CI workflows, Next.js/Vercel config, Foundry hygiene, env vars.

Manual checks complemented the agents: `git log --pretty="%h %G? %s" -50`, `npm audit`, `npm outdated --long`, CI workflow file inspection, top-level grep for raw-HTML injection APIs and hardcoded addresses. Severities have been normalized by the assembler relative to the agents' raw findings where the agents over-classified (e.g., a logger-init race classified as "Critical" was downgraded to Medium because it doesn't affect fund flows or auth).

No source files were modified, no commits were created, no branches were created. This report is the sole artifact produced.
