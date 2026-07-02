# AUDIT-W6-api-hardening — gate active-order reads + rate-limit unauth writes + body caps (W6-M-01/M-02/L-01)

> **Source:** T-SAF campaign 2026-07-01, Wave 6 (Backend/API APPROVED 0C/0H on production `cb0748d`). All three are
> **info-leak / DoS class — no fund loss, no gate bypass** → non-blocking backlog. App/API only, no contract/deploy.
> SSH-signed (noreply committer). **W6-M-01 needs an owner UX decision (below).**

## Context
Wave 6 found the API sound (auth, RLS-on-writes, no HTML errors, no `NEXT_PUBLIC_` secret). Three hardening gaps:
- **W6-M-01 (MED, privacy / strategy-leak):** `GET /api/orders?wallet=<addr>` (+ history, analytics-personal) reads
  via **service-role with an UNAUTHENTICATED `wallet` param** → anyone can read a wallet's data by address. For
  analytics/history this is documented ("wallet = public key"), but `GET /api/orders` exposes **pending conditional-
  order strategy** (targetPrice / amounts / type) **before execution** → a **front-running / strategy-copy** vector
  for a conditional-orders product. Order **writes** are already signature-gated; **reads of active orders are not.**
- **W6-M-02 (MED, DoS/integrity):** `log-*` routes are **unauthenticated + un-rate-limited** → unbounded Supabase
  inserts (spam / poisoning / cost). `POST /api/orders` has **no rate-limit** either.
- **W6-L-01 (LOW):** only `/api/swap` caps content-length; other routes rely on Vercel's ~4MB default.

## Objective
Stop the public-by-address exposure of **active/pending conditional-order strategy**, and bound unauthenticated
write/log abuse — without breaking the app's own reads.

## Requirements
### Part A — W6-M-01: gate active-order reads (⚠ owner UX decision)
1. **Require proof-of-wallet-ownership** to read a wallet's **active/pending conditional orders** (`GET /api/orders`
   and any endpoint returning unexecuted targetPrice/amount/type). Reuse the existing signature-verify
   (`recoverTypedDataAddress`, same as the write path). **Recommended UX:** a **per-session read-token** minted from
   ONE lightweight signature (SIWE-style), so the user signs once per session, not per read — avoids per-view
   friction. Server verifies `recovered === wallet` before returning that wallet's active orders.
2. **Scope:** gate **active/pending order strategy** reads. Analytics/history/executed-order reads may stay
   documented-public OR be gated too — **owner decides** (leave a clear config/flag + a FEEDBACK note stating the
   chosen boundary). Do NOT break the frontend's own order list (it holds the connected wallet + can sign).
3. If the owner instead chooses **accept + document**, then only add an explicit, prominent doc note that pending
   order strategy is publicly queryable by address (and skip the gate) — but the recommendation is to gate.

### Part B — W6-M-02: rate-limit unauthenticated writes
4. Add per-IP `checkRateLimit` (reuse `kv-rate-limiter`/`rate-limiter`) to all `log-*` routes and `POST /api/orders`,
   BEFORE the Supabase insert. Sane limits; 429 JSON on exceed. Consider a lightweight auth/nonce on `log-*` if
   feasible, but rate-limit is the floor.

### Part C — W6-L-01: content-length caps
5. Apply the swap route's content-length cap pattern to the other POST/body routes (a shared helper) so none relies
   solely on the Vercel default. Oversized → 413 JSON.

## Do NOT
- Don't break the app's own order/history reads. Don't change contract/on-chain logic or deploy. Don't loosen the
  existing write-side signature auth or RLS. Don't log the read-token/secret. Keep errors JSON (never HTML).

## Files affected (verify on main)
- `api/orders` (GET gate + POST rate-limit), the read-token/session helper (new, reusing the signature-verify),
  `api/history` + `analytics/personal` (per the owner's boundary), all `log-*` routes (rate-limit), a shared
  content-length helper + the non-swap body routes, `kv-rate-limiter.ts`/`rate-limiter.ts`.

## Expected output
- Branch off latest `origin/main`; SSH-signed; CI green. Active/pending order reads require proof-of-ownership
  (per the owner's chosen boundary); `log-*` + `POST /api/orders` are rate-limited; body caps on all body routes.
  Tests: unauth active-order read → refused; valid signature/token → own orders returned; log spam → 429; oversized
  → 413. FEEDBACK states the chosen M-01 boundary + the limits.

## Quality criteria
Pending conditional-order strategy is no longer publicly readable by address (or is explicitly owner-accepted +
documented); unauthenticated log/order writes are rate-limited; all body routes have a size cap; the app's own
reads/writes still work; JSON errors preserved; no contract/deploy change.

---

## Implementation notes (Code Agent, 2026-07-02, branch `audit/w6-api-hardening`)
**Owner decision applied: W6-M-01 = GATE** (per-session read-token). TDD (red → green), 49 new/updated assertions.

- **Part A — the read token is the signature itself (stateless).** `src/lib/order-engine/read-auth.ts`: the client
  signs ONE SIWE-style EIP-712 message per session (`OrdersReadAccess { wallet, purpose, issuedAt }`, domain
  `TeraSwap Orders v1`); the server (`verifyOrdersReadAccess`) re-derives the message from the query wallet
  (lowercased both sides — casing-proof) and requires `recoverTypedDataAddress === wallet`, `issuedAt` within a 24 h
  TTL and ≤5 min future skew. No server secret, no KV state, nothing to rotate; the token can only READ the signer's
  own orders. Gate wiring: `GET /api/orders` refuses (401 `READ_AUTH_REQUIRED`) any read whose statuses include a
  non-terminal order — no `status` param and unknown statuses are protected (default-deny); `GET /api/orders/[id]`
  applies the same proof when the fetched row is live. **Boundary (owner):** terminal statuses
  (`executed/cancelled/expired/failed`), `/history`, `analytics/personal` and `orders/[id]/executions` stay
  documented-public. Client: `fetchUserOrders`/`fetchActiveOrders` attach cached headers and throw
  `ReadAuthRequiredError` on 401; `useOrderEngine` catches it, calls `ensureOrdersReadAuth` (sessionStorage cache +
  in-flight dedupe + session denial memory → exactly one wallet prompt), retries once, and exposes
  `readAuthDenied`/`requestOrdersReadAuth` (OrderDashboard shows a "Sign to view" banner on rejection). The keeper
  is unaffected — it reads Supabase directly, never `GET /api/orders`.
- **Part B —** `POST /api/orders` → `checkRateLimit('orders:'+ip, 10/min)` (complements the existing per-wallet DB
  limit) and all four `log-*` routes (incl. log-swap PATCH) → ONE shared budget `checkRateLimit('log:'+ip, 120/min)`,
  both BEFORE body parse/Supabase work; 429 JSON + `X-RateLimit-Reset`. KV-down degrades to the existing in-memory
  50% fallback.
- **Part C —** `src/lib/body-limit.ts` (`bodySizeGuard`, default 10 KB = swap's cap; `clientIp` helper) applied to
  every body handler: orders (POST + [id] PATCH), log-* (POST + PATCH), quote, v1/swap, rpc (256 KB — large eth_call
  simulations pass), monitor/tick, monitor/validate-execution, telegram/webhook, admin/{api-keys,dca-freeze,
  kill-switch}. Oversized → 413 JSON.
- **Tests/CI:** new `read-auth.test.ts`, `body-limit.test.ts`, `orders/route.hardening.test.ts`,
  `log-routes.hardening.test.ts`; log-swap's suite gained the limiter stub (the real KV client stalls in tests).
  All gated by the new `api-hardening-guard` job (the full vitest suite doesn't run in CI).
