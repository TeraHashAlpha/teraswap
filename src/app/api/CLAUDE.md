# src/app/api — API routes and proxies

Scoped to `src/app/api/`. Root rules in `/CLAUDE.md` still apply. 45 `route.ts` files (counted 2026-11-11). The worked example for
everything below is `src/app/api/rpc/route.ts`; its header (`:13-56`) says why each guard exists.

## Rate limiting
- New and touched routes limit with `checkRateLimitWithin(key, limit, windowMs, cost?)` (`src/lib/kv-rate-limiter.ts:266-291`). It waits at
  most `RATE_LIMIT_GATE_TIMEOUT_MS` = 1 s (`:258`), then decides by the in-memory fallback — half the limit, per instance: "degraded,
  never unlimited" (`:262-263`). Used today by `/api/quote`, `/api/rpc` and `src/lib/cow-proxy.ts`.
- Not yet universal: 18 call sites in `src/app/api` (22 in `src/`) still call plain `checkRateLimit`, which on a hung Redis waited ~4.3 s
  per request (measured by the A76 audit, `kv-rate-limiter.ts:255-257`). Do not copy that pattern into a new route.
- Every KV/Redis wait in a request path has a deadline: `checkRateLimitWithin`, or `withTimeout` (`src/lib/adapters/shared`) as the quote
  route's kill-switch read does. Pinned for quote by `src/app/api/quote/route.hung-kv.test.ts` and `route.limiter.test.ts`.
- Cost per JSON-RPC call, not per HTTP request: `rpcRateLimitUnits` (`rpc/route.ts:103-108`, `rpc/route.rate-units.test.ts`).

## Keys and logs
- A per-client bucket name comes from `clientIpKey(req)` (`src/lib/client-ip-key.ts:115-117`) or `clientIp(req)`, which returns the same hash
  (`src/lib/body-limit.ts:27-29`). Never put `trustedClientIp(req)` or a raw address in a key, a stored row or a log line (`client-ip-key.ts:110-114`).
- The hash is HMAC-SHA256 under a daily key derived from `RATE_LIMIT_SALT` (32+ chars, server env — `client-ip-key.ts:8-14, 39-41`); IPv6
  clients are keyed by their /64 (`:26-31`). Trust of the underlying IP: `src/lib/trusted-ip.ts`, pinned by CI job `client-ip-trust-guard`
  (`ci.yml:304-322`).

## Errors and upstream hosts
- An error body never contains an upstream URL: provider keys live in RPC URL paths. `/api/rpc` returns fixed messages
  (`rpc/route.ts:78-81`) and a refusal names the chain, not the caller's method (`:189-190`).
- A proxy's upstream is fixed server-side. `/api/rpc` resolves it only via `serverRpcUrl(chainId)` (`:199-200`), after the chain id was
  validated against the registry (`:150-161`) — the request never supplies a host. `src/lib/cow-proxy.ts` was not audited against this
  rule in this pass; read it before changing it.
- The browser must never see provider URLs or keys: CI job `third-party-hosts` builds with marker values and fails if one reaches a
  client chunk (`.github/workflows/e2e.yml:92-129`).

## Gates fail closed
- Body cap first: `bodySizeGuard(req, max)` → 413 (`rpc/route.ts:84-86`; CI job `api-hardening-guard`, `ci.yml:345-364`).
- Unknown chain → 400 (`rpc/route.ts:155-161`). Method not on the chain's read allow-list → 403 and nothing is forwarded (`:189-196`).
  A KV outage degrades the limiter, it never lifts it (`kv-rate-limiter.ts:234-249`).
- One documented exception: the chain-identity guard blocks only a proven `mismatch`; an unreachable upstream falls through, because an
  outage proves nothing about identity (`rpc/route.ts:206-208`). Do not change that direction without the owner.
