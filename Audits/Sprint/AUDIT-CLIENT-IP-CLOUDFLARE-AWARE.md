# AUDIT-CLIENT-IP-CLOUDFLARE-AWARE — PR #347 (`fix/client-ip-cloudflare-aware`)

## VERDICT: 0C / 0H / 0M / 0L — **CLEARED TO MERGE.**
Audited `origin/main`-based branch tip `ed7655b` (3 SSH-signed commits; merge-base = main `92eb4d2`; diff = 7 files, primitive + tests + CI gate + docs only). The shared IP-trust primitive holds as a security boundary; the P3a spoof hole stays closed.

**1 · Spoof gate (critical) — VERIFIED CLOSED.** `trusted-ip.ts:48-58`: `CF-Connecting-IP` is trusted only when `peer = (x-vercel-forwarded-for firstToken) || x-real-ip` — **platform-set headers only, never `x-forwarded-for`** — satisfies `isCloudflareIp(peer)` AND `isValidIp(cfIp)`. A direct-to-Vercel attacker's `peer` is their own platform-stamped IP (not a CF range) → gate fails → falls through to their real IP. They cannot nominate a client IP, exhaust a victim bucket, or rotate keys. Rests only on Vercel's existing strip-and-set guarantee (same assumption as the pre-fix P3a fix — no new trust). Adversarial tests confirm: direct-attacker ignored, victim-bucket exhaustion blocked, rotation collapses to one bucket (`trusted-ip.test.ts:125-150`).

**2 · CF range integrity — VERIFIED against the live source.** `cloudflare-ips.ts:26-49` matches Cloudflare's published set **exactly** — I fetched `cloudflare.com/ips-v4` (15 CIDRs) + `/ips-v6` (7 CIDRs) today: verbatim, in-order, zero drift. IPv4 mask + IPv6 group-straddling prefix match are correct (the `/15` and `/29` boundaries are off-by-one-tested at `cloudflare-ips.test.ts:54,84`); IPv4-mapped IPv6 peers resolve to their embedded v4 (no v6 representation gap); `/0` rejected (no internet-wide wildcard). Provenance comment + fail-safe refresh path present: a missing range → `false` → fallback to pre-fix bucketing, **never** a trusted spoof.

**3 · Key-safety — VERIFIED.** `CF-Connecting-IP` is `trim()`-ed then `isValidIp()`-gated before it can become a Redis key (`trusted-ip.ts:52-55`). `isValidIp` is strict — rejects empty/hostname/`ip:port`/CIDR/CRLF-padded/8 KB garbage/leading-zero octets (`cloudflare-ips.test.ts:134-160`). Malformed header from a genuine CF edge falls back to the edge IP, never the garbage — the P3a poisoning vector cannot reopen.

**4 · Non-CF path — BYTE-IDENTICAL.** Below the CF branch the chain is unchanged: `vercelFirst → x-real-ip → RIGHT-most XFF → 'unknown'`. Left-most XFF still never trusted; with no CF in front the branch is skipped entirely. Preserved-property tests pass (`trusted-ip.test.ts:27,44`).

**5 · No scope creep — CONFIRMED.** `kv-rate-limiter.ts` is **not in the diff** (windows/limits/key shape untouched; it consumes the primitive unchanged). The only other change is a CI job (`ci.yml:282`) that gates the two test files — additive, appropriate for a trust primitive.

### Findings: none (0C/0H/0M/0L). Tests re-run by Auditor: **51/51 pass** (`trusted-ip` + `cloudflare-ips`).
### INFO (non-blocking):
- **I-1 — range freshness is operational, not a vuln:** the list is correct today; if CF adds a range later, the design fails SAFE (degraded bucketing, never a spoof). The documented periodic re-copy is the right control; consider a low-priority scheduled reminder.
- **I-2 — process:** audited the locally-fetched branch (sandbox can't reach GitHub); confirm the GitHub PR #347 head = `ed7655b` before merge.

*Read-only; nothing edited or merged. CF ranges verified against the live cloudflare.com source. Append to AUDIT-TOTAL + commit left for the owner's SSH-signed batch.*
