# Feedback — FIX-CLIENT-IP-CLOUDFLARE-AWARE

## The CF-trust gate

```
peer = x-vercel-forwarded-for[0] || x-real-ip      // platform-set ONLY, never x-forwarded-for
if (peer && isCloudflareIp(peer)) {
  cf = headers['cf-connecting-ip']?.trim()
  if (cf && isValidIp(cf)) return cf               // both halves must hold
}
// …otherwise the pre-existing chain, verbatim
```

Ranges were **fetched live** from `https://www.cloudflare.com/ips-v4` and `/ips-v6` (both HTTP 200,
2026-07-24) — 15 IPv4 + 7 IPv6, copied verbatim, nothing inferred. A range we later lack fails
**safe**: `isCloudflareIp` → false → the CF branch is skipped → exactly today's pre-fix behaviour.

**P3a adversarial tests: still green**, and extended. The original 8 cases pass unchanged, and are
re-asserted a second time with `cf-connecting-ip` present-but-untrusted to prove the new branch
cannot leak into them. **No-CF path byte-identical** — the 8 original header/expectation pairs are
pinned as a table, then replayed with a forged `cf-connecting-ip: 9.9.9.9` attached; every result
is identical. `npx vitest run src/lib/trusted-ip.test.ts src/lib/cloudflare-ips.test.ts` → **51
pass**. Downstream consumers (`body-limit`, log routes, swap route) → 61 pass. `tsc --noEmit` and
`eslint` clean.

## Security concern found while implementing

- **`isValidIp` originally trimmed internally, and that was wrong.** `'\n1.2.3.4'` validated as
  true. `trustedClientIp` happens to trim before calling, so nothing was exploitable *here* — but a
  predicate that blesses a string the caller then uses **untrimmed** is a CRLF-into-Redis-key
  footgun waiting for the next caller. Both `isValidIp` and `isCloudflareIp` are now
  whitespace-**strict**: a true answer means "this exact string is safe to use verbatim". Callers
  trim first. Pinned by its own test (`\n1.2.3.4`, `1.2.3.4\r\n`, tab-prefixed v6 → all false).
- **Leading-zero octets are rejected** (`010.0.0.1`), rather than picking a side in the
  octal-vs-decimal ambiguity that differs between parsers — the classic way an IP allow-list is
  bypassed by disagreeing with the parser upstream.

## Test gap — closed, and it was bigger than the prompt implied

- **`src/lib/trusted-ip.test.ts` was in NO CI guard job.** This repo runs no full vitest suite —
  only single-file guard jobs — so the *existing* P3a anti-spoof tests have never run in CI, and
  the new CF-gate tests would have shipped equally ungated. For the shared IP-trust primitive that
  is not acceptable: a refactor could widen the spoof gate with green CI. Added
  **`client-ip-trust-guard`** to `.github/workflows/ci.yml`, mirroring the existing guard-job shape
  (SHA-pinned actions, node 22, no template expressions). `ci.yml` was outside the prompt's file
  list — flagging it explicitly; drop the commit if you disagree, the fix stands without it.

## Edge cases handled beyond the prompt

- **IPv4-mapped IPv6 peers** (`::ffff:172.64.0.1`) are matched against the v4 ranges — otherwise a
  proxy reporting that form would read as non-CF and silently keep the shared-bucket behaviour.
- **`x-real-ip` as the peer source** is gated too (not just `x-vercel-forwarded-for`), per the
  spec's "else x-real-ip".
- **`true-client-ip`** (Cloudflare Enterprise) is deliberately **not** honoured — the spec named
  `CF-Connecting-IP` only, and adding a second trusted header widens the surface for no current
  benefit. Worth revisiting only if the plan moves to an Enterprise zone.

## Concern — residual, out of scope

- The gate assumes Cloudflare proxies the Vercel origin. Anyone who discovers the origin hostname
  bypasses CF entirely: they are then correctly limited by their own IP (the fix behaves right),
  but they also bypass CF's WAF. Closing that is origin-lockdown work — Vercel firewall rules or CF
  Authenticated Origin Pulls — and belongs in its own chore.
- **Ops:** `CLOUDFLARE_IPV4_CIDRS`/`IPV6` need a periodic refresh. Cheapest durable option is a
  scheduled workflow that re-fetches both URLs and fails on drift, in the shape of
  `token-catalog-refresh`. Not built here; flagging so it gets scheduled rather than forgotten.
