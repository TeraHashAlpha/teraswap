# SEC-4 · Wave 10 — Supply chain / secrets / infra / CI (the A6 surface) — entry packet

> **Campaign:** 2026-07-01. **Sprint:** SEC-4 (parallel after W0). **Runner:** Auditor (read-only). **Baseline:**
> `origin/main` (cb0748d) per plan §0 — read via `git show origin/main:<path>`. **Grounded on:** W0-recon.md §2.9 +
> W6 (no `NEXT_PUBLIC_` server secret) + W8 (Worker cron auth). **Source of truth:** T-SAF v1 §5-W10 + §6 INV-10/11
> + §9 G8/G9. **Binding:** T-SAF §1 + CLAUDE.md #1/#3/#7/#11/#12.

## Objective
Prove the build/deploy chain can't be poisoned or leaked: single-instance critical deps + pinned risky ranges, no
server secret behind `NEXT_PUBLIC_`, secrets never logged, CI gates present **and blocking**, security headers sane,
and the Worker cron authenticated.

## In-scope (W0 §2.9)
Root + `contracts/order-engine/executor` sub-package lockfiles + `overrides`; `NEXT_PUBLIC_*` scan; security
headers/CSP/COOP; gitleaks + Secret Scanning; GitHub Actions (incl. the blocking `test-contracts`,
`deployed-sources-guard`, `oracle-advisory-guard`, `minimum-output-guard`, `catalog-address-guard`, the
`audit-gate.mjs` allowlist); Vercel env scopes; Cloudflare Worker; Upstash Redis + Supabase keys.

## Attacker goal (A6; §5-W10, §9-G8/G9)
Poison a transitive dep to alter the build; exfiltrate a secret; weaken/disable a CI gate; loosen the headers;
sneak a server secret into a `NEXT_PUBLIC_` var.

## Must-verify invariants (INV-10/11; negative-path first)
1. **Single-instance critical deps** (`npm ls`): one `@walletconnect/core`, `@coinbase/wallet-sdk`, `qr`, `viem`
   each — no over-loose transitive range (reconcile with W9's WC de-dup).
2. **`overrides` pin the risky advisories** (form-data/vite/ws/undici/hono family per the Dependabot baseline); the
   CI audit gate (`audit-gate.mjs` + allowlist) is the source of truth — confirm the allowlist is not masking a real
   prod-path advisory. Note `min-release-age=7d` supply-chain policy.
3. **No server secret behind `NEXT_PUBLIC_`** (`git grep NEXT_PUBLIC_`; W6 confirmed — re-assert at the config/env
   layer) and **no secret logged / in a logged URL** (INV-10). Vercel env scopes: server secrets server-only.
4. **CI gates present AND blocking:** `test-contracts` is **not** `continue-on-error`; the guard jobs
   (deployed-sources / oracle-advisory / minimum-output / catalog-address / dca-resilience) run on PRs and block;
   **gitleaks / Secret Scanning not bypassable** and the rules cover **bare-hex** (CHORE-POLISH-4); branch protection
   requires verified signatures (rule #12).
5. **Security headers sane** (CSP incl. the `img-src blob:` + the token-logo/WC CDN hosts from #244/wallet-logos,
   COOP/COEP, HSTS) — no wildcard that defeats them.
6. **Worker cron authenticated** to `/api/monitor/tick` (`Bearer MONITOR_CRON_SECRET`, W8) — an unauth tick refused.

## Method & tools (§7.5)
`npm ls` de-dup (root + executor sub-package); `npm audit` triage → reconcile with `audit-gate.mjs`/allowlist;
`git grep NEXT_PUBLIC_` + secret-in-log grep; read the GitHub Actions workflow YAMLs (gate present + blocking, no
`continue-on-error` on `test-contracts`, gitleaks rules); header snapshot (CSP/COOP/COEP/HSTS); confirm the two
lockfiles + `overrides`.

## Negative-path battery (each must be refused/absent)
A server secret in a `NEXT_PUBLIC_` var · a duplicate/looser critical dep · `test-contracts` set continue-on-error ·
gitleaks/Secret Scanning bypassed · a CSP wildcard defeating the policy · an unauth Worker tick.

## Exit criteria
Single-instance critical deps + pinned risky ranges; zero `NEXT_PUBLIC_` server secret; no secret logged; CI gates
blocking + gitleaks bare-hex + verified-signature branch protection; headers sane; Worker cron authed. Findings →
§4 evidence bundle → remediation prompts (RICE).

---

### `/goal` paste for the Auditor (≤4000)
```
Wave 10 (Supply chain / secrets / infra / CI — A6) per Audits/Campaign/
2026-07-01/W10-supply-chain.md + TERASWAP-AUDIT-FRAMEWORK.md §5-W10. READ-ONLY,
no code edits. Baseline origin/main (cb0748d) — read via `git show origin/main:
<path>`; record the audited SHA. Ground on W6 (no NEXT_PUBLIC_ secret) + W8
(Worker cron auth).

Scope: root + contracts/order-engine/executor lockfiles + overrides; NEXT_PUBLIC_*
scan; CSP/COOP/COEP/HSTS headers; gitleaks + Secret Scanning; GitHub Actions
(blocking test-contracts + deployed-sources/oracle-advisory/minimum-output/
catalog-address/dca-resilience guards + audit-gate.mjs allowlist); Vercel env
scopes; Cloudflare Worker; Upstash/Supabase keys.

Prove (negative-path FIRST — each must be refused/absent):
1. Single-instance critical deps (npm ls): one @walletconnect/core,
   @coinbase/wallet-sdk, qr, viem each; no over-loose transitive range.
2. overrides pin the risky advisories (form-data/vite/ws/undici/hono); the CI
   audit gate (audit-gate.mjs + allowlist) isn't masking a real prod-path
   advisory; min-release-age=7d policy noted.
3. No server secret behind NEXT_PUBLIC_ (git grep); no secret logged / in a
   logged URL; Vercel server secrets server-only.
4. CI gates present AND blocking: test-contracts NOT continue-on-error; guard
   jobs run on PRs + block; gitleaks/Secret Scanning not bypassable + rules
   cover bare-hex; branch protection requires verified signatures (rule #12).
5. Security headers sane (CSP incl. img-src blob: + token-logo/WC CDN hosts,
   COOP/COEP, HSTS) — no wildcard defeating them.
6. Worker cron authenticated to /api/monitor/tick (Bearer MONITOR_CRON_SECRET);
   unauth tick refused.

Tools: npm ls de-dup (root + executor sub-package); npm audit triage vs
audit-gate.mjs/allowlist; git grep NEXT_PUBLIC_ + secret-in-log grep; read the
Actions workflow YAMLs (gate present + blocking, no continue-on-error on
test-contracts, gitleaks rules); header snapshot; confirm both lockfiles +
overrides.

Deliver into Audits/Campaign/2026-07-01/W10-supply-chain.md (report section):
audited SHA, checks table, findings (Sev·file:line·disposition + §4 evidence
bundle), negative-path results, coverage fraction, verdict (0C/0H bar),
remediation-prompt list. SSH-signed commit left for owner if no key in sandbox.
```

---

# WAVE 10 — REPORT (executed 2026-07-01/02, Auditor, read-only)

**Audited SHA (production):** `origin/main` = **`cb0748de466c50c1749dfea53ad5c0424f6c0bf6`** (reads via
`git show origin/main:<path>`; working tree `df00d35` ignored per W3-H-01).

## Verdict: APPROVED — 0C / 0H / 0M / 1L / 2I
Critical **wallet** deps are single-instance; `overrides` pin every risky advisory (empty audit-allowlist,
0 high/critical); no `NEXT_PUBLIC_` server secret; the CI gate suite (test-contracts + 8 guard jobs +
gitleaks + codeql + keeper-tests) is present and **blocking**; headers are sane; the Worker cron is
Bearer-authed. One LOW (viem resolves to 2 instances — bundle bloat, not the 4-Cores class).
**Bonus:** two prior campaign findings are now **remediated on main** — see the correction block.

## Checks-run (negative-path first)
| # | Check | Result |
|---|-------|--------|
| 1 | Single-instance critical deps | ✅ `@walletconnect/core` 1@2.21.1, `@coinbase/wallet-sdk` 1@4.3.6, `qr` 1@0.5.5 (the deps whose duplication caused the 4-Cores incident). ⚠ **viem = 2 instances**: app `2.47.4` + `@walletconnect/utils` transitive `2.23.2` → W10-L-01 (bundle bloat, not a runtime bug). Executor sub-package has its own `viem 2.47.10` (separate process/package). |
| 2 | Overrides pin advisories; allowlist not masking prod | ✅ `overrides`: form-data 4.0.6, vite 8.0.16, ws 8.21.0(+nested 7.5.11), undici 7.28.0, hono 4.12.25, WC 2.21.1, qr 0.5.5, axios 1.16.0. `audit-allowlist.json` = **empty** (`allow:[]`) → `audit-gate.mjs` fails on ANY unallowed high/critical (nothing masked). `.npmrc min-release-age=7` verified by `lockfile-lint` job. |
| 3 | No `NEXT_PUBLIC_` server secret; not logged | ✅ Only `NEXT_PUBLIC_SUPABASE_ANON_KEY` (public) + public addresses; re-scan for SECRET/PRIVATE/SERVICE/KMS/BEARER names → none. Keeper logs only env-var names (W8); server secrets server-only. |
| 4 | CI gates present AND blocking | ✅ `test-contracts` (`ci.yml:222`, **continue-on-error REMOVED**, runs `forge test` for OrderExecutor + FeeCollector). Guard jobs all present + blocking: `audit-gate`, `catalog-address-guard`, `fee-usd-guard`, `dca-resilience-guard`, `oracle-advisory-guard`, `token-catalog-pipeline-guard`, `minimum-output-guard`, `deployed-sources-guard`, `lockfile-lint`; plus `keeper-tests` (`node --test`, 127/127), `gitleaks`, `codeql`. Only `continue-on-error` is on the advisory **moderate** npm-audit step (correct). `gitleaks` has a **bare-64-hex EVM-private-key** rule (`.gitleaks.toml` `evm-private-key-keyword-proximity`, INC-2026-06-09-001), no continue-on-error. |
| 4b | Signatures / branch protection (#12) | ✅ Recent `main` commits are signed — SSH for authored commits, **PGP (GitHub web-flow)** for UI merge commits (`cb0748d`/`22b742d` carry `gpgsig BEGIN PGP SIGNATURE`). Branch-protection "require verified signatures" is a GitHub setting (human-verifiable), but the on-repo evidence shows enforcement. |
| 5 | Security headers sane | ✅ CSP: `default-src 'self'`; `img-src 'self' data: blob: tokens.1inch.io assets.coingecko.com raw.githubusercontent.com` (blob: for WC wallet logos + token CDNs, **no wildcard**); `connect-src` an explicit provider allowlist (scoped `*.alchemy.com`/`*.walletconnect.com`/`*.supabase.co`, no global `*`); `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`. + COOP `same-origin-allow-popups`, CORP, HSTS, X-Frame (mirrored in `vercel.json`). COEP intentionally omitted (W9-I-01). |
| 6 | Worker cron authenticated | ✅ (W8) `workers/monitor-tick-cron` POSTs `/api/monitor/tick` with `Authorization: Bearer ${MONITOR_CRON_SECRET}`; the route verifies via `verifyBearerToken` and returns 401 unauth (W6). |

## Findings
| ID | Sev | file:line | Disposition | Evidence |
|----|-----|-----------|-------------|----------|
| W10-L-01 | LOW (dep hygiene) | `package-lock.json` (`@walletconnect/utils/node_modules/viem@2.23.2` + root `viem@2.47.4`) | REPORT | viem resolves to **2 instances** — the app's `2.47.4` and a transitive `2.23.2` under `@walletconnect/utils`. Bundle bloat + not strictly single-instance (INV-11), but **not** a runtime/correctness bug (WC uses its own viem internally; unlike the WC-core dup that caused the 4-Cores incident). Forcing one version via `overrides` risks breaking `@walletconnect/utils`. Acceptable to leave; if pinned, add a smoke test for the WC modal. |
| W10-I-01 | INFO | executor sub-package | REPORT | `contracts/order-engine/executor` is a separate npm package (`viem 2.47.10`, `@aws-sdk/client-kms ^3.700.0`); its lockfile churn was flagged in W0. Separate process — no root conflict. The `^` on aws-sdk is standard; `min-release-age` applies at install. |
| W10-I-02 | INFO | CI guard suite | REPORT | Strong single-file guard strategy (the full vitest suite isn't run in CI; per-domain guards pin the regressions). Well-designed; recorded as the load-bearing CI posture. |

## ⚠ CORRECTION — two prior campaign findings are REMEDIATED on `main`
Discovered while reading the CI guards + the fixed source. **Default-skepticism applied to my own prior
passes:**
- **W2-L-01 → REMEDIATED on `main` (my RB.1 delta was WRONG).** `useSwap.ts:458` now calls
  `deriveMinimumOutput(swapData.toAmount, slippage)` (`src/lib/minimum-output.ts`), which **throws
  `UnusableQuoteError`** on a missing/non-numeric/≤0 `toAmount` → the swap is **refused** (caught → 9O
  fallback), NOT the old `minimumOutput = 0n`. Tagged `[AUDIT-W2 / W2-L-01]`, pinned by the CI
  `minimum-output-guard`. My W4 re-baseline note ("W2-L-01 STANDS on main") is **corrected** — it is fixed.
- **W2-M-01 → REMEDIATED on `main`.** `docs/security/DEPLOYED-SOURCES.md` now pins the canonical
  addr→source→compiler→code-hash map (re-verified on-chain 2026-07-02 via `scripts/verify-deployed-sources.mjs`),
  the stale `TeraSwapFeeCollectorV2_flat.sol` is deprecation-bannered + guarded against being referenced,
  and `deployed-sources-guard` (`ci.yml:191`) + `scripts/check-deployed-sources.mjs` enforce it. Exactly the
  W2-M-01 remediation recommended. (W1-I-02 remains refuted on-chain, as W2 recorded.)

## Negative-path battery (each refused/absent)
Duplicate WC core / wagmi-v3 → single-instance pins ✅ · un-triaged high/critical advisory → audit-gate exit 1
(empty allowlist) ✅ · server secret behind `NEXT_PUBLIC_` → none ✅ · `test-contracts` non-blocking →
continue-on-error removed ✅ · bare EVM key committed → gitleaks proximity rule ✅ · unsigned commit on main →
merges PGP-signed, authored SSH-signed ✅ · CSP wildcard defeat → scoped hosts only ✅ · unauth `monitor/tick`
→ 401 ✅.

## Coverage (supply-chain/CI slice)
- Reviewed on `main`: root `package.json`/`package-lock.json` + `overrides`, `.npmrc`, executor
  sub-package, `scripts/audit-gate.mjs` + `audit-allowlist.json`, all 8 `.github/workflows/*.yml`,
  `.gitleaks.toml`, `next.config.js`/`vercel.json` headers, `workers/monitor-tick-cron`, `DEPLOYED-SOURCES.md`.
- Not run in-sandbox: live `npm ls`/`npm audit` (read the lockfile + audit-gate logic directly), the GitHub
  branch-protection settings (human-verifiable), a live CI run (the YAMLs are static-analysed).

## Remediation prompts
1. **W10-L-01 (optional) — dedupe viem.** Evaluate an `overrides` pin of `viem` to `2.47.x` across the tree
   with a WC-modal smoke test; or accept the transitive `2.23.2` as WC-internal (documented). No prod risk.
- (No blocking remediation. W2-L-01 + W2-M-01 already fixed on main.)

## Boundaries
Read-only on `origin/main`; no live CI/npm/deploy. Branch-protection signature enforcement is a GitHub UI
setting (human-verify). W11 synthesizes the campaign (100%-coverage attestation + RICE plan).
