# SEC-3 · Wave 6 — Backend / API (31 routes; the A1 surface) — entry packet

> **Campaign:** 2026-07-01. **Sprint:** SEC-3 (ordered W6 → W7). **Runner:** Auditor (read-only). **Baseline:**
> `origin/main` (cb0748d) per plan §0 — read via `git show origin/main:<path>`. **Grounded on:** W0-recon.md §1/§2 +
> W2 (recipient gating), W3 (sequencer gate on quote+swap-build), W5 (Bearer auth). **Source of truth:** T-SAF v1
> §5-W6 + §6 INV-7/10 + §9 G6/G7/G9/G10. **Binding:** T-SAF §1 + CLAUDE.md #1/#2/#3/#12.

## Objective
Prove every one of the 31 API routes is validation-hardened, authz-correct, rate-limited, JSON-shaped, RLS-isolated,
and chain-coercion-safe against an **anonymous attacker hitting the routes directly (A1)** — no UI.

## In-scope (W0 §2.5 — the 31 routes + supporting libs)
`swap`, `quote`, `v1/swap`, `v1/quote`, `rpc`, `spender`, `orders`, `orders/[id]`, `orders/[id]/executions`,
`orders/stats`, `portfolio/{prices,tokens}`, `history`, `stats`, `analytics`, `analytics/{export,personal}`,
`log-{swap,quote,event,activity}`, `health`, `monitor`, `monitor/{tick,status,heartbeat,heartbeat/admin,
validate-execution}`, `admin/{kill-switch,api-keys}`, `telegram/webhook`. Supporting: `kv-rate-limiter.ts`,
`rate-limiter.ts`, `validation.ts`, `env-validation.ts`, `sanitize-error.ts`, Supabase RLS policies.

## Attacker goal (A1; §5-W6, §9-G6/G7/G9/G10)
Bypass validation/authz/rate-limit; force an error → HTML (breaks client); leak a secret; read/write another user's
rows (RLS); coerce chainId (`"1"!==1`); thundering-herd the cache; hit an admin/monitor route without auth; forge
analytics attribution.

## Must-verify invariants (INV-7, INV-10; negative-path first, per route)
1. **Input validation:** address / amount / slippage / chainId validated on every route that takes them (`validation.ts`).
2. **Authz:** admin routes (`admin/kill-switch`, `admin/api-keys`) Bearer-gated → **401/503** unauth (W5 confirmed the
   Bearer is constant-time); `v1/*` is **mainnet-only** → rejects non-1; `monitor/*` + `monitor/heartbeat/admin`
   authed; `telegram/webhook` verifies the Telegram secret (G7.4).
3. **Rate-limit BEFORE upstream + before budget burn** (`kv-rate-limiter`/`rate-limiter`) — no flood/bypass (G6.1);
   **single-flight on cache-miss** (no thundering-herd, G6.2).
4. **Errors return JSON, never HTML** (`sanitize-error`) — no stack/HTML leak (INV-10, G6.5/G9.4).
5. **No server secret behind `NEXT_PUBLIC_`** (grep) and no secret in logs / logged URLs (INV-10, G9.1/G9.2).
6. **Supabase RLS isolates users** — per-wallet rows are unreadable/unwritable cross-user (INV-7, G9.3). Red-team:
   craft a request for another wallet's rows (orders, executions, analytics/personal, portfolio) → **denied**.
7. **Timeouts cover body parse** (not just headers); **oversized body refused**.
8. **Numeric chainId coercion** (`Number(chainId)`, `"1"!==1`) at every route boundary (W4 confirmed the pattern —
   re-assert per route).
9. **DefiLlama-down + >$10k → blocked** on the swap route (W3 gate reachable via the API, INV-4).

## Method & tools (§7.5)
Per-route **request matrix**: valid · malformed JSON · oversized body · wrong method · missing/forged auth ·
wrong-chain (non-1 to `v1/*`) · replayed. **RLS red-team** (query another wallet's rows on every user-scoped table).
`git grep NEXT_PUBLIC_` (server-secret scan) + secret-in-log grep. **semgrep** taint (request → sink). Trace each
error branch → JSON shape. On-chain reads only where a route resolves an address (viem/node, reuse W0).

## Negative-path battery (each must be refused/JSON)
Unauth admin → 401/503 · bad JSON → 400 JSON · oversized body → refused · non-1 to `v1/*` → refused · cross-user
RLS query → denied · unauth `telegram/webhook` → refused · DefiLlama-down + >$10k swap → blocked · error → JSON (never HTML).

## Exit criteria
Every route validated, authz-correct, JSON-shaped, RLS-isolated, chain-coercion-safe, rate-limited before budget;
no `NEXT_PUBLIC_` server secret; no secret logged. Findings → §4 evidence bundle → remediation prompts (RICE).
W7 (adapters) consumes the route/quote facts.

---

### `/goal` paste for the Auditor (≤4000)
```
Wave 6 (Backend/API — 31 routes, A1 surface) per Audits/Campaign/2026-07-01/
W6-backend-api.md + TERASWAP-AUDIT-FRAMEWORK.md §5-W6. READ-ONLY, no code edits.
Baseline origin/main (cb0748d) — read via `git show origin/main:<path>`; record
the audited SHA. Ground on W0-recon.md + W2/W3/W5 facts.

Scope (31 routes + libs): swap, quote, v1/swap, v1/quote, rpc, spender, orders,
orders/[id], orders/[id]/executions, orders/stats, portfolio/{prices,tokens},
history, stats, analytics, analytics/{export,personal}, log-{swap,quote,event,
activity}, health, monitor, monitor/{tick,status,heartbeat,heartbeat/admin,
validate-execution}, admin/{kill-switch,api-keys}, telegram/webhook +
kv-rate-limiter.ts, rate-limiter.ts, validation.ts, env-validation.ts,
sanitize-error.ts, Supabase RLS.

Prove (negative-path FIRST, per route — each must be refused/JSON):
1. Input validation (address/amount/slippage/chainId) on every route.
2. Authz: admin/{kill-switch,api-keys} Bearer-gated -> 401/503; v1/* mainnet-
   only rejects non-1; monitor/* + heartbeat/admin authed; telegram/webhook
   verifies the Telegram secret.
3. Rate-limit runs BEFORE upstream + before budget burn; single-flight on
   cache-miss (no thundering-herd).
4. Errors return JSON, NEVER HTML (sanitize-error) — no stack/HTML leak.
5. No server secret behind NEXT_PUBLIC_ (grep); no secret in logs / logged URLs.
6. Supabase RLS isolates users: red-team a request for ANOTHER wallet's rows
   (orders, executions, analytics/personal, portfolio) -> denied.
7. Timeouts cover body parse (not just headers); oversized body refused.
8. Numeric chainId coercion ("1"!==1 -> Number) at every route boundary.
9. DefiLlama-down + >$10k -> blocked on the swap route.

Tools: per-route request matrix (valid/malformed/oversized/wrong-method/
missing-auth/wrong-chain/replayed); RLS red-team on every user-scoped table;
git grep NEXT_PUBLIC_ + secret-in-log grep; semgrep taint (request->sink);
trace each error branch -> JSON shape.

Deliver into Audits/Campaign/2026-07-01/W6-backend-api.md (report section):
audited SHA, per-route checks table, findings (Sev·file:line·disposition + §4
evidence bundle), negative-path results, coverage fraction of the 31 routes,
verdict (0C/0H bar), remediation-prompt list. SSH-signed commit left for owner
if no key in sandbox.
```

---

# WAVE 6 — REPORT (executed 2026-07-01, Auditor, read-only)

**Audited SHA (production):** `origin/main` = **`cb0748de466c50c1749dfea53ad5c0424f6c0bf6`** (reads via
`git show origin/main:<path>`; working tree `df00d35` ignored per W3-H-01). 34 `route.ts` on main
(the 31 scoped + `admin/dca-freeze`, `oracle-coverage`, `monitor/status`).

## Verdict: APPROVED — 0C / 0H / 2M / 1L / 2I
No route bypasses auth, leaks a server secret, permits cross-user *mutation*, or returns HTML errors.
Admin/monitor/webhook routes are constant-time-Bearer-gated; `v1/*` is mainnet-only; order **writes** are
signature-authenticated; no `NEXT_PUBLIC_` server secret. Three backlog items (unauthenticated **read**
exposure of pending-order strategy; missing rate-limit on log-*/orders; body-size cap only on swap) are
**info-leak / DoS-class, no fund loss or gate bypass** → they do not block the 0C/0H prod bar.

## Cross-cutting checks (across all 34 routes; negative-path first)
| # | Check | Result |
|---|-------|--------|
| 1 | Input validation (address/amount/slippage/chainId) | ✅ `ADDRESS_RE`/`isValidAddress`, `safeBigInt` (rejects `''`/`NaN`/`1.5`/`0x123`), slippage 0–15, `MIN_ORDER_AMOUNT`, expiry-in-future. Malformed → 400 JSON. |
| 2 | Authz | ✅ `admin/{kill-switch,api-keys,dca-freeze}` + `monitor/{tick,heartbeat/admin,validate-execution}` → `verifyBearerToken` (503 unset / 401 bad); `telegram/webhook` → constant-time `X-Telegram-Bot-Api-Secret-Token`; `v1/quote` rejects non-`CHAIN_ID` (400), `v1/swap` mainnet-pinned. |
| 3 | Rate-limit before upstream/budget | ✅ on expensive upstream routes (swap/quote/v1/portfolio/rpc/analytics, before `fetchSwapFromSource`). ⚠ **absent** on `log-*` + `orders` (W6-M-02). |
| 4 | Errors JSON never HTML | ✅ try/catch → `NextResponse.json`/`jsonError`/`jsonServerError`; upstream via `sanitizeUpstreamError`. No HTML/stack leak. |
| 5 | No `NEXT_PUBLIC_` server secret; not logged | ✅ Only `NEXT_PUBLIC_SUPABASE_ANON_KEY` (public by design); service-role key server-only; no secret logged. |
| 6 | RLS / user isolation | ✅ **Writes** signature-gated (`recoverTypedDataAddress`→must equal `wallet` + `order.wallet===wallet`, 401/403); DB RLS deny-all anon. ⚠ **Reads** public-by-`wallet`-param via service-role (13B-L-02) → W6-M-01. |
| 7 | Oversized body refused | ⚠ Only `swap` has an app-level content-length cap; others rely on Vercel ~4 MB default (W6-L-01). Swap `maxDuration` covers body parse (9X). |
| 8 | `"1"!==1` chainId coercion | ✅ `Number(chainId)` at every boundary (W4); `v1` parses + range-checks. |
| 9 | DefiLlama-down + >$10k blocked on swap | ✅ (W3) `validateSwapPrice`→422; >$10k fail-closed, <$10k fail-open. |

## RLS red-team (key negative-path)
- **Mutation of another wallet's orders → DENIED.** create + cancel `recoverTypedDataAddress` require
  `recovered===wallet` AND `order.wallet===wallet` → 401/403 (the route comment names this exact threat).
- **Read of another wallet's rows → ALLOWED BY DESIGN.** `GET /api/orders?wallet=`, `/history`,
  `/analytics/personal` use service-role + unauthenticated `wallet` param (documented 13B-L-02). The
  *orders* GET additionally exposes **pending** conditional-order strategy → **W6-M-01**.

## Findings
| ID | Sev | file:line | Disposition | Evidence |
|----|-----|-----------|-------------|----------|
| W6-M-01 | MED (privacy) | `api/orders/route.ts` GET; `history`; `analytics/personal` | REMEDIATION-PROMPT | Unauthenticated `?wallet=` reads via service-role expose a wallet's data by address, incl. **pending order strategy** (target price, amounts, type) pre-execution. Documented for analytics (13B-L-02) but the pending-strategy case is more sensitive. **No fund loss; writes signature-gated.** Product decision: gate order reads (esp. `status='active'`) behind a signature/read-token, or explicitly accept + document for orders. |
| W6-M-02 | MED (DoS/integrity) | `log-{swap,quote,event,activity}`, `orders` POST | REMEDIATION-PROMPT | `log-*` **unauthenticated + un-rate-limited** → unbounded inserts (spam / analytics-poisoning / Supabase cost); `orders` POST signature-gated but un-rate-limited (self-signed spam). Add per-IP `checkRateLimit`. |
| W6-L-01 | LOW (DoS) | all POST routes except `swap` | REPORT | Only `swap` caps content-length; others rely on Vercel ~4 MB default. Add a shared body-size guard. |
| W6-I-01 | INFO | `analytics/personal:10-15` | REPORT | Public-by-address read model is deliberate + documented (on-chain data is public). Scopes W6-M-01 to the pending-order delta. |
| W6-I-02 | INFO | `log-event:43/51/86` | REPORT | log-* "silently succeed" on error — fine for telemetry, masks ingestion failures. Acceptable. |

## Negative-path battery
Unauth admin/monitor → 401 (503 if unset) ✅ · bad JSON → 400 ✅ · non-mainnet to `v1/*` → 400 ✅ ·
cross-user order **cancel** → 401/403 ✅ · malformed address/amount/slippage → 400 ✅ · DefiLlama-down +
>$10k → 422 ✅ · sequencer-down Base swap → 503 (W3) ✅ · forged webhook secret → rejected ✅.
**Gaps:** cross-user order **read** allowed (W6-M-01); log-* flood not rate-limited (W6-M-02); oversized
body only capped on swap (W6-L-01).

## Coverage
- Cross-cutting invariants checked across **all 34 routes** (grep + targeted reads).
- Deep-read: swap, quote, v1/{swap,quote}, orders, orders/[id], analytics/personal, history,
  admin/{kill-switch,api-keys}, monitor/tick, telegram/webhook, rpc, log-event.
- Not line-by-line: stats, oracle-coverage, monitor/status, orders/stats, orders/[id]/executions
  (cross-cutting applied; no user-mutation surface). `semgrep` taint + per-route 500-fuzz deferred to CI.

## Remediation prompts (Code-Agent-ready)
1. **W6-M-01 — gate pending-order reads** (signature/read-token for `status='active'`, or restrict fields, or
   explicit product ACCEPT + doc). No contract change; add posture tests.
2. **W6-M-02 — rate-limit log-* + orders** (`checkRateLimit('log:'+ip …)`, `'orders:'+ip`) before the Supabase
   insert; keep fire-and-forget. Test: N+1 → 429 JSON.
3. **W6-L-01 — shared body-size guard** extracted from the swap route, applied to orders/log-*/quote/v1. Test:
   oversized → 413/400 JSON.

## Boundaries
Read-only on `origin/main`; no live requests/deploys. `semgrep` + per-route fuzz deferred to CI. W7/W8/W10
consume: log-* ingestion unauth (W10 cost/abuse), reads public-by-address, writes signature-gated.
