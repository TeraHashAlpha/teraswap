# Incident Report — Vercel April 2026 Security Breach

**Incident ID:** INC-2026-04-19-001
**Date:** 19 April 2026
**Severity:** S1 — Critical (third-party platform compromise, env vars potentially exposed)
**Author:** TeraSwap Architecture Team
**Status:** RESOLVED — all secrets rotated 2026-04-21, all env vars marked Sensitive
**Related artifacts:**
- Vercel official bulletin: https://vercel.com/kb/bulletin/vercel-april-2026-security-incident
- Community playbook: https://github.com/OpenSourceMalware/vercel-april2026-incident-response
- Memory: `.auto-memory/reference_vercel_breach_2026.md`

---

## 1. Summary

Vercel disclosed a security incident on 19 April 2026. An attacker compromised Context.ai (a third-party AI tool used by a Vercel employee), escalated through the employee's Google Workspace account into Vercel's corporate environment, and accessed customer environment variables that were **NOT** marked as "sensitive" (i.e., not encrypted at rest).

Environment variables marked as "sensitive" in Vercel are stored encrypted and there is **no evidence** they were accessed.

A threat actor claiming to be ShinyHunters posted the stolen data on BreachForums, demanding a $2M ransom. The listing alleges access to GitHub tokens, internal deployments, API keys, and employee data (~580 records). BleepingComputer reports that the actual ShinyHunters crew denies involvement — attribution is uncertain.

**TeraSwap exposure: HIGH for non-sensitive vars.** Multiple operational secrets (Telegram bot token, monitor secrets, Supabase service role key, API keys) were stored without the "sensitive" flag and must be assumed compromised.

---

## 2. Timeline

All times UTC unless noted.

| Time | Event |
|---|---|
| **2026-04-19 ~11:04 PST** | Vercel publishes initial IOC (OAuth App ID) |
| **2026-04-19 ~18:01 PST** | Vercel publishes attack origin details + customer recommendations |
| **2026-04-19 ~19:00** | TeraHash receives alert via X (tweet from @veraborning) |
| **2026-04-19 ~19:30** | TeraSwap Architect reviews Vercel dashboard screenshots, classifies env vars |
| **2026-04-20** | Vercel bulletin updated. Community playbook published (OpenSourceMalware/GitHub) |
| **2026-04-20** | TeraSwap: domains removed from Vercel project (teraswap.app + teraswap-seven.vercel.app). Site taken OFFLINE as precaution |
| **2026-04-20** | Secret rotation initiated (this incident) |
| **2026-04-20** | TIER 0 complete: TELEGRAM_BOT_TOKEN revoked + re-issued via BotFather, SUPABASE_SERVICE_ROLE_KEY regenerated |
| **2026-04-20** | TIER 1 complete: MONITOR_SECRET, MONITOR_CRON_SECRET, TELEGRAM_WEBHOOK_SECRET rotated. Cloudflare Worker updated. Telegram webhook re-registered (www.teraswap.app) |
| **2026-04-20** | Site restored: domains reconnected, redeploy with new env vars, Telegram bot + status page verified operational |
| **2026-04-20** | GitHub Actions watchdog: MONITOR_SECRET updated in repo secrets |
| **2026-04-21** | TIER 2 complete: Alchemy RPC key rotated, 1inch API key rotated, 0x API key rotated, WalletConnect Project ID rotated |
| **2026-04-21** | ALL env vars marked as "Sensitive" in Vercel. Incident RESOLVED |

---

## 3. Impact Assessment

### 3.1 Vercel Environment Variables — TeraSwap Classification

**PROTECTED (marked "sensitive" in Vercel — encrypted, no evidence of access):**

| Variable | Risk if leaked | Status |
|---|---|---|
| KV_REST_API_TOKEN | Full KV write access | 🔐 PROTECTED |
| KV_URL | Redis connection string | 🔐 PROTECTED |
| KV_REST_API_READ_ONLY_TOKEN | KV read access | 🔐 PROTECTED |
| KV_REST_API_URL | KV REST endpoint | 🔐 PROTECTED |
| KV_REDIS_URL | Redis TCP string | 🔐 PROTECTED |

**NOT MARKED SENSITIVE — ASSUME COMPROMISED:**

| Variable | Risk if leaked | Rotation priority |
|---|---|---|
| TELEGRAM_BOT_TOKEN | Full bot control — send messages, read history | **TIER 0 — IMMEDIATE** |
| SUPABASE_SERVICE_ROLE_KEY | Full Supabase DB access, bypasses RLS | **TIER 0 — IMMEDIATE** |
| MONITOR_SECRET | Admin API auth (kill-switch, heartbeat) | **TIER 1 — TODAY** |
| MONITOR_CRON_SECRET | Tick endpoint auth | **TIER 1 — TODAY** |
| TELEGRAM_WEBHOOK_SECRET | Webhook signature verification | **TIER 1 — TODAY** |
| NEXT_PUBLIC_1INCH_API_KEY | 1inch rate limit / billing | **TIER 2 — THIS WEEK** |
| NEXT_PUBLIC_0X_API_KEY | 0x rate limit / billing | **TIER 2 — THIS WEEK** |
| NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID | WalletConnect session init | **TIER 2 — THIS WEEK** |
| NEXT_PUBLIC_RPC_URL | Alchemy/Infura RPC | **TIER 2 — THIS WEEK** |
| NEXT_PUBLIC_FALLBACK_RPC_1 | Fallback RPC | **TIER 2 — THIS WEEK** |
| NEXT_PUBLIC_FALLBACK_RPC_2 | Fallback RPC | **TIER 2 — THIS WEEK** |
| TELEGRAM_ADMIN_IDS | Admin user IDs (not secret per se) | **TIER 3 — LOW** |
| TELEGRAM_CHAT_ID | Group chat ID | **TIER 3 — LOW** |
| NEXT_PUBLIC_SENTRY_DSN | Sentry error reporting | **TIER 3 — LOW** |
| NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS | Public contract address | No rotation needed |
| NEXT_PUBLIC_FEE_COLLECTOR | Public contract address | No rotation needed |
| NEXT_PUBLIC_FEE_RECIPIENT | Public wallet address | No rotation needed |
| NEXT_PUBLIC_FEE_PERCENT | Public fee config | No rotation needed |
| SUPABASE_URL | Public Supabase URL | No rotation needed (public by design) |

### 3.2 Smart Contract Risk

**ZERO.** Private keys are NOT stored in Vercel env vars. The executor private key is on the self-hosted keeper only. Contract addresses are public by design.

### 3.3 GitHub Integration Risk

The Vercel GitHub App has read access to the TeraSwap repository. The attacker may have:
- Read source code (assume compromised)
- Accessed GitHub tokens via the Vercel integration

This does NOT grant write access to the repo or ability to push code, but source code should be considered exposed.

### 3.4 User Fund Risk

**ZERO.** TeraSwap never custodies user funds. Swaps are executed via user-signed transactions. The executor only fills limit/stop-loss/DCA orders using the on-chain OrderExecutor contract with pre-approved parameters.

---

## 4. Rotation Checklist

See: `docs/Runbooks/vercel-breach-rotation.md` (created alongside this incident report)

---

## 5. Post-Incident Hardening

| # | Action | Priority |
|---|---|---|
| H-01 | Mark ALL env vars as "sensitive" in Vercel | P0 — ✅ DONE |
| H-02 | Disable "Improve models with this project's data" toggle | P0 — ✅ DONE |
| H-03 | Review Vercel GitHub App scope — restrict to minimum repos | P1 — ✅ DONE (Only select: TeraHashAlpha/teraswap) |
| H-04 | Enable Vercel Deployment Protection (Standard minimum) | P1 — ✅ DONE (Vercel Authentication + Standard Protection) |
| H-05 | Audit Vercel team members and access tokens | P1 — ✅ DONE (Vercel: 1 session token only; GitHub: 3 PATs deleted) |
| H-06 | Review GitHub audit log April 1–present for suspicious activity | P1 — ✅ DONE (all commits verified) |
| H-07 | Inspect `package.json` scripts, lockfile, `vercel.json`, `next.config.js` for tampering | P1 — ✅ DONE (clean) |
| H-08 | Diff current code against last known-good commit (pre-April 1) | P1 — ✅ DONE (clean) |
| H-09 | Rotate GitHub Personal Access Tokens if any exist | P1 — ✅ DONE (all 3 PATs deleted, none active) |
| H-10 | Set up quarterly secret rotation schedule | P2 |

---

## 6. Lessons Learned

**Completed 2026-04-21.**

1. **"Sensitive" flag must be the default, not opt-in.** Vercel does not encrypt env vars at rest unless explicitly marked. Every new env var must be created with this flag. This single setting would have prevented any exposure.
2. **Third-party AI tools with OAuth access are a supply-chain vector.** The breach originated from Context.ai — an employee's AI tool with broad Google Workspace permissions. OAuth scopes must be audited and restricted.
3. **DeFi projects on Vercel face heightened risk.** Frontend poisoning can drain user wallets. TeraSwap's architecture (no private keys in Vercel, no fund custody, calldata validation fail-closed) limited blast radius to operational secrets only.
4. **Telegram webhook URL must use the canonical domain.** The `www.teraswap.app` redirect caused silent webhook failure. Webhook URLs must match the final domain after any 307 redirects.
5. **Secret rotation must update all consumers simultaneously.** GitHub Actions watchdog failed because it still had the old MONITOR_SECRET. A rotation checklist must enumerate all consumers (Vercel, Cloudflare Worker, GitHub Actions, local .env).
6. **Response time: ~24h from disclosure to full rotation.** Site offline within hours, TIER 0/1 rotated same day, TIER 2 completed next day. Acceptable for a non-custodial project with no user fund exposure.
7. **RPC fallbacks should use different providers.** Having 3 RPCs from the same provider (same API key) negates the fallback purpose. Fixed: Alchemy (primary) + Ankr (fallback 1) + PublicNode (fallback 2).
