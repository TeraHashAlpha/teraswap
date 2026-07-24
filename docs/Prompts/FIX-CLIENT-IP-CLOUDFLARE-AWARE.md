# FIX-CLIENT-IP-CLOUDFLARE-AWARE

Make client-IP extraction Cloudflare-aware **without reopening the P3a spoof hole**.

- **Branch:** `fix/client-ip-cloudflare-aware` (off `origin/main` @ `92eb4d2`), SSH-signed
- **Blast radius:** `trustedClientIp` is the shared IP-trust primitive behind **every** per-IP
  rate limiter — rpc / quote / swap / log, via `kv-rate-limiter`.

---

## Context

teraswap.app now sits behind Cloudflare, so all production traffic enters via CF edges and Vercel
sees a **CF IP, not the real client**. `trustedClientIp` reads `x-vercel-forwarded-for` — the peer
connecting to Vercel — which is now the **CF edge**. Consequences:

- every per-IP bucket is keyed by CF edge, so thousands of unrelated users behind one edge share
  **one** bucket; and
- a real abuser behind CF is **invisible** inside that shared bucket, and cannot be limited
  without collateral damage to everyone on the same edge.

`CF-Connecting-IP` carries the real client, but naively trusting it would hand a
direct-to-origin attacker the ability to nominate their own client IP — precisely the P3a class
this primitive exists to close.

---

## Requirements

1. **New `src/lib/cloudflare-ips.ts`** — Cloudflare's official IPv4+IPv6 CIDR ranges as a
   constant, with a provenance comment (source `https://www.cloudflare.com/ips-v4` + `/ips-v6`,
   dated) and a "refresh periodically" note. Do **not** invent ranges. Export
   `isCloudflareIp(ip): boolean` (CIDR match, v4+v6).
2. **`trusted-ip.ts` CF-aware** — determine the connecting peer (existing `x-vercel-forwarded-for`
   first token, else `x-real-ip`). **IF** that peer `isCloudflareIp()` **AND** a `CF-Connecting-IP`
   header is present **AND** it parses as a valid IP → return it. **ELSE** fall through to the
   existing chain unchanged (`x-vercel-forwarded-for` → `x-real-ip` → right-most XFF → `unknown`).
   Validate before use — no arbitrary strings into the Redis rate-limit key.
3. **Preserve every P3a property on the non-CF path** — a spoofed left-most `x-forwarded-for` stays
   ignored when `x-vercel-forwarded-for` is present. With no CF headers, behaviour is byte-identical.

---

## Do NOT

- Change any rate-limit window/limit, or the downstream limiters.
- Trust `CF-Connecting-IP` when the peer is **not** a Cloudflare IP (the spoof gate).
- Hand-type or invent CF ranges.
- Weaken the non-CF path.
- Open a PR (owner-manual).

---

## Files affected

| File | Change |
|---|---|
| `src/lib/cloudflare-ips.ts` | **new** — published CF ranges, `isCloudflareIp`, `isValidIp` |
| `src/lib/cloudflare-ips.test.ts` | **new** |
| `src/lib/trusted-ip.ts` | CF-gated branch ahead of the unchanged chain |
| `src/lib/trusted-ip.test.ts` | CF path + 2 adversarial suites + byte-identical suite |
| `.github/workflows/ci.yml` | **new** `client-ip-trust-guard` job (these tests had none) |
| `src/lib/kv-rate-limiter.ts` | reference only — not edited |

---

## Expected behaviour change (intended, net-positive)

Each real client gets its own 300/min RPC bucket — **more** headroom for legitimate users — while a
real abuser is isolated to their own bucket and becomes surgically limitable. This replaces today's
shared CF-edge bucket. Not a regression.

---

## Quality criteria

- CF path: peer ∈ CF range + valid `CF-Connecting-IP` → the real client IP.
- Adversarial: `CF-Connecting-IP` set but peer **not** a CF IP → ignored.
- Adversarial: `CF-Connecting-IP` malformed → ignored, no key poisoning, falls back.
- All pre-existing P3a tests still green; no-CF path byte-identical.

---

## Auditor note

This is the **shared IP-trust primitive for every rate limiter**, so the trust boundary deserves
explicit review.

**The CF-trust boundary.** `CF-Connecting-IP` is believed **only** when the connecting peer — taken
from the platform-set headers only, never `x-forwarded-for` — is inside Cloudflare's published
ranges. The security argument is that Cloudflare **overwrites** `CF-Connecting-IP` at its edge, so
a client-supplied value never survives a genuine CF transit; and a request that did not transit CF
has a non-CF peer, so the branch is never reached. Both conditions must hold, and either failing
falls through to the pre-existing chain — degraded (bucket by edge) but never wrong.

**The two adversarial spoof tests** are the ones to read first:

1. *direct-to-Vercel* — `CF-Connecting-IP` present, peer **not** a CF IP → ignored; the attacker
   gets their own IP, and rotating forged values collapses to a single bucket.
2. *malformed* — genuine CF edge, but `CF-Connecting-IP` is garbage (`ratelimit:quote:*`, a
   comma-joined header value, an 8 KB string) → ignored; nothing unvalidated reaches the Redis key.

**Residual, out of scope:** the gate assumes CF is a proxy in front of the Vercel origin. Anyone
who discovers the origin hostname can bypass Cloudflare entirely — they are then correctly rate
limited by their own IP, but they also bypass CF's WAF. Closing that is origin-lockdown work
(Vercel firewall / CF Authenticated Origin Pulls), not this primitive's job.
