# TeraSwap — Operational Hygiene Review

**Date:** 2026-04-16
**Author:** Architect
**Purpose:** Identify and prioritize all "educational project" vestiges that need professionalization before public launch. Organized by category with RICE scores.

---

## Context

TeraSwap started as an educational project and has evolved into a production-grade DeFi meta-aggregator with 11 liquidity sources, smart contracts handling real funds, and a full monitoring stack. Several infrastructure decisions were made during the educational phase that now represent operational risk or unprofessional posture. This document catalogs them all.

**Constraint:** Cloudflare Registrar transfer blocked until 2026-05-03 (ICANN 60-day lock). Some items depend on this.

---

## 1. Identity & Account Separation

### OPS-01 — Create dedicated project email
**RICE:** R=10, I=9, C=10, E=2 → **45.0** | Priority: **P0**

**Current state:** All platforms (Vercel, GitHub, Supabase, Sentry, WalletConnect, etc.) are linked to a personal Gmail (`t.joaocruz@gmail.com`) that has years of other service associations.

**Risk:** Personal email compromise (via any of dozens of linked services) gives attacker password reset access to ALL TeraSwap infrastructure. Single point of failure.

**Recommendation:**
- Create `ops@teraswap.app` as the project email. Since Cloudflare Registrar isn't available yet, two options:
  - **Option A (now):** Create a new Google Workspace account (`ops@teraswap.app`) — costs ~€6/month. Professional, immediate, and independent of Cloudflare.
  - **Option B (after 2026-05-03):** Use Cloudflare Email Routing (free) to forward `ops@teraswap.app` → personal Gmail. Less isolation but free. Still requires a real mailbox for services that send verification codes.
  - **Option C (now, free):** Create a separate free Gmail (`teraswap.ops@gmail.com`) as a stopgap. Migrate to `ops@teraswap.app` later.
- Architect recommends **Option A** if budget allows, **Option C** as stopgap.
- Enable hardware 2FA (YubiKey) on the new account immediately.

**Migration order (by blast radius):**
1. GitHub (org owner) — highest risk, controls code + CI secrets
2. Vercel — controls deployment + env vars with all secrets
3. Supabase — controls database + service role key
4. Cloudflare — controls DNS + Worker + future registrar
5. Sentry — controls error data
6. WalletConnect — controls wallet connection project
7. Telegram Bot — controls monitoring alerts
8. All others

---

### OPS-02 — GitHub organization + team structure
**RICE:** R=8, I=8, C=9, E=3 → **19.2** | Priority: **P1**

**Current state:** Repository likely under personal GitHub account (`TeraHashAlpha`). Single owner, no org structure.

**Risk:** Personal account compromise = full code access. No separation between personal repos and TeraSwap. No audit trail for team access if collaborators are added later.

**Recommendation:**
- Create a GitHub Organization (e.g., `teraswap-app` or `teraswap-protocol`)
- Transfer the repository to the org
- Personal account becomes org owner with 2FA mandatory
- Set branch protection on `main`: require PR reviews, require CI pass, no force push
- Future team members get scoped roles (maintain, write) not admin

---

### OPS-03 — Wallet separation (hot/cold/ops)
**RICE:** R=10, I=10, C=8, E=4 → **20.0** | Priority: **P1**

**Current state:** Fee recipient wallet (`0x107F6eB7C3866c9cEf5860952066e185e9383ABA`) — unknown if this is a personal wallet, a dedicated wallet, or a multisig.

**Risk:** If the fee recipient is a personal hot wallet (MetaMask), private key compromise drains all collected fees. If the same wallet is used for contract admin operations AND fee collection, a single compromise gives both fund access and contract control.

**Recommendation:**
- **Fee collection wallet:** Dedicated EOA or Gnosis Safe (already in pending actions as R9: 2-of-3 multisig)
- **Contract admin wallet:** Separate from fee wallet. Ideally a hardware wallet (Ledger/Trezor) used only for admin operations. Long term: Gnosis Safe multisig.
- **Executor wallet (keeper):** Separate from both. Funded with minimal ETH for gas. If compromised, can only execute orders (not drain funds, due to contract protections).
- **Personal wallet:** Never used for any TeraSwap operations.
- Document which wallet is which in a non-public ops runbook.

---

## 2. Secrets & Credentials

### OPS-04 — Rotate all secrets post-educational phase
**RICE:** R=10, I=9, C=10, E=3 → **30.0** | Priority: **P0**

**Current state:** Many secrets (API keys, tokens) were created during the educational phase and may have been exposed in: terminal history, local `.env` files, screenshots shared in conversations, Git history (if `.env` was ever committed).

**Risk:** Stale or leaked credentials provide unauthorized access.

**Recommendation — rotate ALL of the following:**

| Secret | Service | Rotation method |
|--------|---------|----------------|
| `ONEINCH_API_KEY` | 1inch Developer Portal | Regenerate in dashboard |
| `ZEROX_API_KEY` | 0x Dashboard | Regenerate |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API | Regenerate (invalidates old key) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API | Regenerate (update frontend) |
| `KV_REST_API_TOKEN` | Vercel KV / Upstash dashboard | Regenerate |
| `TELEGRAM_BOT_TOKEN` | BotFather `/revoke` | Revoke + generate new |
| `TELEGRAM_WEBHOOK_SECRET` | Manual (`openssl rand -hex 32`) | Regenerate + re-register webhook |
| `KILL_SWITCH_SECRET` | Manual | Regenerate |
| `MONITOR_CRON_SECRET` | Manual | Regenerate + update Cloudflare Worker |
| `HEALTH_TOKEN` | Manual | Regenerate |
| `VERCEL_TOKEN` | Vercel → Settings → Tokens | Regenerate + update GitHub secrets |
| `WATCHDOG_ALERT_WEBHOOK` | Depends on provider | Regenerate |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect Cloud | Low risk (public), but review project settings |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry | Low risk (public), but review project settings |

**Execution:** Do this in a single maintenance window. Update Vercel env vars, Cloudflare Worker secrets, and GitHub Actions secrets in one pass. Redeploy. Verify monitoring still works via `/status` in Telegram.

---

### OPS-05 — Remove deprecated public API keys
**RICE:** R=8, I=7, C=10, E=1 → **56.0** | Priority: **P0**

**Current state:** `.env` files still reference `NEXT_PUBLIC_0X_API_KEY` and `NEXT_PUBLIC_1INCH_API_KEY` (marked deprecated). These were browser-exposed API keys — anyone who loaded the frontend could extract them.

**Risk:** If the old public keys are still active, third parties can abuse them (rate limit exhaustion, cost attribution to your account).

**Recommendation:**
- Verify the old public keys are revoked (not just unused in code, but actually disabled at 1inch/0x dashboards)
- Remove the deprecated env vars from `.env.example`, `.env.local`, `.env.production`
- Grep codebase for any remaining references

---

### OPS-06 — Git history audit for leaked secrets
**RICE:** R=7, I=9, C=6, E=2 → **18.9** | Priority: **P1**

**Current state:** Unknown if `.env` files or secrets were ever committed to Git during the educational phase.

**Risk:** Anyone with repo access (or if repo was ever public) can extract historical secrets from Git.

**Recommendation:**
- Run: `git log --all --diff-filter=A -- '*.env*' '.env*'` to check if env files were ever committed
- Run: `git log --all -p | grep -i "api_key\|secret\|token\|password"` (careful with output)
- If secrets were committed: rotation (OPS-04) covers the immediate risk. Consider `git filter-branch` or BFG Repo-Cleaner only if the repo will be made public.
- If repo stays private: rotation is sufficient.

---

## 3. Platform Hardening

### OPS-07 — 2FA mandatory on all platforms
**RICE:** R=10, I=10, C=10, E=2 → **50.0** | Priority: **P0**

**Current state:** Listed as pending manual action (R4). Unknown current status.

**Risk:** Password-only access to Vercel, GitHub, or Supabase = one phishing email away from full compromise.

**Recommendation:**
- Enable hardware 2FA (YubiKey) on: GitHub, Vercel, Supabase, Cloudflare, Google (email account)
- For platforms that don't support hardware keys: TOTP via a dedicated authenticator app (not SMS)
- Record backup codes in a physical secure location (not in a digital note)
- The pending second YubiKey purchase is important — without a backup, losing the YubiKey locks you out

**Checklist:**
- [ ] GitHub: 2FA → hardware key
- [ ] Vercel: 2FA → hardware key or TOTP
- [ ] Supabase: 2FA
- [ ] Cloudflare: 2FA → hardware key
- [ ] Google (project email): 2FA → hardware key
- [ ] WalletConnect Cloud: 2FA
- [ ] Sentry: 2FA
- [ ] Buy second YubiKey (backup)

---

### OPS-08 — Vercel environment scoping
**RICE:** R=8, I=8, C=9, E=2 → **28.8** | Priority: **P1**

**Current state:** Environment variables on Vercel are set to "All Environments" (visible in screenshot). This means Preview deployments have access to production secrets.

**Risk:** A malicious PR (if collaborators are added) or a Dependabot preview build could exfiltrate production secrets (Supabase service role, KV tokens, Telegram bot token).

**Recommendation:**
- Scope production-only secrets to "Production" environment only:
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`
  - `KILL_SWITCH_SECRET`
  - `MONITOR_CRON_SECRET`
  - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ADMIN_IDS`, `TELEGRAM_CHAT_ID`
  - `ONEINCH_API_KEY`, `ZEROX_API_KEY`
- Keep in "All Environments" only: public vars (`NEXT_PUBLIC_*`), and dev/preview safe vars
- Create separate Supabase project for preview/dev if needed

---

### OPS-09 — Supabase RLS + access audit
**RICE:** R=7, I=8, C=7, E=3 → **13.1** | Priority: **P2**

**Current state:** Supabase has RLS policies (implemented in Sprint 1). Service role key is server-only. But no recent audit of RLS policies against current schema.

**Recommendation:**
- Review all tables: `swaps`, `quotes`, `orders`, `order_executions`
- Verify: anon key can only read own wallet's data (wallet address match)
- Verify: service role key is never exposed to frontend (`SUPABASE_SERVICE_ROLE_KEY` not prefixed with `NEXT_PUBLIC_`)
- Verify: point-in-time recovery is enabled (Settings → Database → Backups)
- Document RLS policy summary in ops runbook

---

## 4. Domain & DNS

### OPS-10 — Complete Cloudflare migration (blocked until 2026-05-03)
**RICE:** R=9, I=9, C=8, E=5 → **13.0** | Priority: **P2** (blocked)

**Current state:** Phase 1 complete (DNS-only, Full strict TLS, HSTS preload, Worker routes). Phase 2 blocked by ICANN 60-day lock.

**Pending after 2026-05-03:**
- [ ] Transfer registrar from Vercel → Cloudflare Registrar
- [ ] Enable DNSSEC (DS record at registrar)
- [ ] Enable Registry Lock (requires Cloudflare Business plan for `.app` TLD — verify pricing)
- [ ] Setup Cloudflare Email Routing (`ops@teraswap.app` → project Gmail)

**No action until 2026-05-03.** Calendar reminder already set.

---

## 5. Monitoring & Observability

### OPS-11 — Sentry DSN review
**RICE:** R=6, I=5, C=8, E=1 → **24.0** | Priority: **P1**

**Current state:** Sentry DSN is `NEXT_PUBLIC_SENTRY_DSN` — exposed in frontend. This is normal (Sentry DSNs are designed to be public), but the Sentry project settings should be locked down.

**Recommendation:**
- Review Sentry project: ensure rate limiting is configured (prevent abuse)
- Verify: no sensitive data in error payloads (wallet addresses OK, private keys never)
- Set allowed domains to `teraswap.app` only (prevent cross-origin error injection)
- Review team access — should only be project email, not personal

---

### OPS-12 — Log retention & structured logging
**RICE:** R=5, I=6, C=7, E=5 → **4.2** | Priority: **P3**

**Current state:** Vercel Hobby tier retains function logs for 1 hour. `console.log/error` is the logging mechanism. Telegram group messages serve as the primary audit trail.

**Recommendation (deferred to post-launch):**
- Vercel Pro ($20/mo) gives 3-day log retention + log drains to external service
- Or: Structured logging to Supabase `monitoring_events` table (free, queryable, permanent)
- The monitoring dashboard (Sprint 6D) should read from this table
- Not urgent while the Telegram group serves as audit log

---

## 6. Legal & Compliance

### OPS-13 — Terms of Service + Privacy Policy
**RICE:** R=9, I=7, C=6, E=4 → **9.5** | Priority: **P2**

**Current state:** No ToS or Privacy Policy on the site. Required before public launch for any service that handles wallet addresses (PII under some jurisdictions).

**Recommendation:**
- Draft ToS covering: no custody of funds, no guarantees on quote accuracy, user assumes smart contract risk, dispute resolution
- Draft Privacy Policy covering: wallet addresses collected (Supabase), IP addresses (privacy proxy claim — verify), analytics data, Sentry error data
- Link from footer of `teraswap.app`
- Consider jurisdiction (Portugal/EU — GDPR applies to wallet addresses if linkable to natural persons)

---

### OPS-14 — License file
**RICE:** R=5, I=4, C=9, E=1 → **18.0** | Priority: **P1**

**Current state:** Unknown if repository has a LICENSE file. Educational projects often skip this.

**Recommendation:**
- If staying closed-source: add `UNLICENSED` or `BUSL-1.1` (Business Source License, used by Uniswap)
- If going open-source: choose appropriate license (MIT for maximum adoption, GPL for copyleft)
- Decide before any public release or team additions

---

## 7. Development Practices

### OPS-15 — Branch protection rules
**RICE:** R=7, I=7, C=9, E=1 → **44.1** | Priority: **P0**

**Current state:** `main` branch has direct push (all commits in this session were pushed directly to main).

**Risk:** A typo or bad commit goes straight to production. No review gate. Vercel auto-deploys from main.

**Recommendation:**
- Enable branch protection on `main`:
  - [ ] Require PR for all changes (no direct push)
  - [ ] Require CI status checks to pass before merge
  - [ ] Require at least 1 approval (even if self-approved for solo dev)
  - [ ] No force push
  - [ ] No deletion
- Create a `develop` or feature branch workflow
- Exception: emergency hotfixes can bypass via admin override (documented in runbook)

---

### OPS-16 — Pre-existing test failures
**RICE:** R=6, I=6, C=8, E=3 → **9.6** | Priority: **P2**

**Current state:** Sprint 6A auditor noted 8 pre-existing test failures. These are not regressions but accumulated tech debt.

**Recommendation:**
- Investigate and fix before adding more features
- Add to Sprint 6C or create a dedicated Sprint 6A.5 for test debt
- CI should block merges on test failures (requires branch protection from OPS-15)

---

## Priority Summary

| Priority | Items | Action window |
|----------|-------|--------------|
| **P0** (do now) | OPS-01 (project email), OPS-04 (rotate secrets), OPS-05 (remove deprecated keys), OPS-07 (2FA everywhere), OPS-15 (branch protection) | This week |
| **P1** (do before launch) | OPS-02 (GitHub org), OPS-03 (wallet separation), OPS-06 (git history), OPS-08 (Vercel scoping), OPS-11 (Sentry), OPS-14 (license) | Before mainnet |
| **P2** (do at milestone) | OPS-09 (Supabase audit), OPS-10 (Cloudflare — blocked), OPS-13 (ToS/Privacy), OPS-16 (test failures) | Before public launch |
| **P3** (nice to have) | OPS-12 (structured logging) | Post-launch |

---

## Execution suggestion

**Week of 2026-04-16 (parallel with Sprint 6B):**
1. OPS-01: Create project email (Option A or C)
2. OPS-07: Enable 2FA on all platforms (with existing YubiKey)
3. OPS-05: Verify deprecated API keys are revoked
4. OPS-15: Enable branch protection on `main`

**Week of 2026-04-22 (parallel with Sprint 6C):**
5. OPS-04: Secret rotation window (single maintenance pass)
6. OPS-08: Scope Vercel env vars to Production
7. OPS-06: Git history audit
8. OPS-02: Create GitHub org + transfer repo

**Before mainnet:**
9. OPS-03: Wallet separation + Gnosis Safe setup
10. OPS-14: License decision
11. OPS-11: Sentry lockdown

**After 2026-05-03:**
12. OPS-10: Cloudflare Registrar transfer + DNSSEC + email routing
13. OPS-13: ToS + Privacy Policy

---

## See also

- `FASE-A-CLOUDFLARE-DNS.md` — Cloudflare migration runbook
- `FASE-A-MANUAL.md` — broader hardening actions
- Pending manual actions in project memory
- Sprint 6B: API auth hardening (complements this document)
