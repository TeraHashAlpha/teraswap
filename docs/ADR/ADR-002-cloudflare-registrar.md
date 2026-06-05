# ADR-002 — Domain Registrar & DNS Hardening Strategy

**Status:** Accepted (partially executed — Phase 1: DNS-only via Cloudflare; Phase 2: full registrar transfer pending May 2026)
**Date:** 2026-04-14 (updated 2026-04-15)
**Deciders:** TeraHash (founder), TeraSwap Architect, Security Auditor
**Informed by:** [INC-2026-04-14-001 CoW DNS hijack](../../Audits/Incidents/2026-04-14-cowswap-dns-hijack.md)

---

## Context

The CoW Swap DNS hijack (14 April 2026) demonstrated that DNS/registrar compromise is a realistic P0 attack vector for DeFi frontends. CoW was attacked at the registrar level: attacker gained control of DNS records for `swap.cow.fi` and served a malicious frontend that stole signatures.

At the time of the incident, `teraswap.app` was hosted on a standard retail registrar with only default protections (email-based 2FA, no registry lock, no DNSSEC enforcement). The same attack vector that hit CoW is available against TeraSwap today.

**We need to decide how to harden `teraswap.app` against registrar-level attacks, and we need to do it before we grow the user base.**

---

## Decision

Migrate `teraswap.app` to **Cloudflare Registrar** and layer the following controls:

1. **Cloudflare Registrar** (~$10/yr at-cost for `.app` TLD)
2. **Registry Lock** on the `.app` registry (enabled via Cloudflare support ticket — free for Cloudflare Registrar customers)
3. **DNSSEC** signed and published at the registry
4. **Hardware 2FA (YubiKey)** mandatory on the Cloudflare account owning the domain — TeraHash already owns one YubiKey (used for GitHub + Vercel); a second (backup) will be purchased within 1 week
5. **Account-level lockdown:** login IP allowlist via Cloudflare Access if feasible; email-change cooldown; no API token with zone:edit permissions checked into any repo or CI

**Estimated annual runtime cost: ~$20/yr** (domain renewal; everything else is free on the Cloudflare Registrar tier).

Execution is manual and tracked in [FASE-A-CLOUDFLARE-DNS.md](../../FASE-A-CLOUDFLARE-DNS.md). TeraHash handles the migration personally.

---

## Execution status (updated 2026-04-15)

The original plan assumed immediate registrar transfer. On 2026-04-15 we discovered that Vercel Registrar imposes the **ICANN 60-day transfer lock** — the domain was registered on 2026-03-04, so transfer out is blocked until **2026-05-03**.

**Adopted: Phase 1 (DNS-only) + Phase 2 (registrar transfer in May).**

### Phase 1 — Cloudflare DNS-only (completed 2026-04-15)

| Step | Status |
|---|---|
| Add `teraswap.app` as site on Cloudflare (Free plan) | ✅ |
| Import DNS records (6 A, 3 CAA, 1 CNAME) | ✅ |
| Change nameservers in Vercel Registrar to `fonzie.ns.cloudflare.com` + `meera.ns.cloudflare.com` | ✅ |
| Cloudflare activation confirmed (email received 2026-04-15 09:11) | ✅ |
| SSL/TLS mode set to **Full (strict)** | ✅ |
| HSTS enabled (6 months, include subdomains, preload, no-sniff) | ✅ |
| Always Use HTTPS + Minimum TLS 1.2 | ✅ |
| AI bot blocking enabled | ✅ |
| DNSSEC enabled in Cloudflare (DS record generated) | ⚠️ DS record cannot be added — Vercel Registrar has no DNSSEC UI |
| Revoke temporary `CLOUDFLARE_API_TOKEN` | ✅ |

**What Phase 1 gives us:**
- ✅ Cloudflare proxy (WAF, DDoS protection, caching)
- ✅ Full (strict) TLS end-to-end
- ✅ HSTS with preload
- ✅ Worker routes on `teraswap.app` zone (unblocks Prompt 27.8)
- ✅ Baseline capture against Cloudflare-resolved DNS
- ❌ DNSSEC (DS record needs registrar support — Vercel lacks UI)
- ❌ Registry Lock (requires Cloudflare Registrar)

### Phase 2 — Full registrar transfer (scheduled after 2026-05-03)

| Step | Status |
|---|---|
| ICANN 60-day lock expires | ⏳ 2026-05-03 |
| Obtain auth code from Vercel (Domains → ⋯ → Transfer Out) | ⏳ |
| Initiate transfer to Cloudflare Registrar | ⏳ |
| DNSSEC auto-managed by Cloudflare Registrar | ⏳ |
| Request Registry Lock via Cloudflare support | ⏳ |
| Buy backup YubiKey | ⏳ |

---

## Alternatives considered

### Alternative A — MarkMonitor (enterprise brand protection registrar) — *rejected*

MarkMonitor is the registrar used by large brands (Google, Facebook, most Fortune 500) specifically because it offers premium controls: dedicated account manager, out-of-band phone verification for any change, SLA-backed incident response, hardened registry lock.

**Why rejected:**
- Cost: **$3,000–5,000/yr minimum**. At current TeraSwap volume, this is 150–250× the Cloudflare option.
- Most of the delta is non-technical (dedicated account manager, legal services, SLAs). The technical controls we actually need (registry lock, DNSSEC, hardware 2FA) are available on Cloudflare.
- At our scale, an attacker targeting `teraswap.app` specifically (vs a $1B-volume DEX frontend) is lower-probability. The marginal security of MarkMonitor is not yet worth 150× the cost.

**Reconsider when:** TeraSwap monthly swap volume exceeds $1B, OR when we hold custodial assets, OR if we suffer a targeted attack that Cloudflare controls did not block. Budget line is pre-approved at that point.

### Alternative B — CSC Global / Com Laude (mid-tier enterprise registrars) — *rejected*

Similar enterprise tier to MarkMonitor, usually $1,500–3,000/yr. Same reasoning: cost/benefit doesn't justify at current scale.

### Alternative C — Stay on current retail registrar, add Registry Lock if available — *rejected*

Lowest-effort option. However the current registrar does not offer Registry Lock at our tier, and its 2FA implementation is SMS-capable (SIM-swap risk). Staying means accepting known weak controls on a known-attacked vector.

### Alternative D — Google Domains / Squarespace Domains — *rejected*

Google Domains was shut down / transferred to Squarespace in 2023–2024. Squarespace Domains does not offer registry lock on `.app`. No meaningful improvement over current registrar.

### Alternative E — Self-hosted DNS with multi-registrar redundancy — *rejected*

Theoretically allows near-zero trust in any single registrar, but operational complexity is high (key management, multi-signed DNSSEC across registrars, propagation testing). Effort: weeks. Benefit over Cloudflare + Registry Lock: marginal for our threat model. Rejected as over-engineering for Phase 1.

---

## Rationale

Cloudflare Registrar captures ~95% of the technical protections offered by MarkMonitor at ~1% of the cost:

- **Registry Lock** is the single most impactful control. It makes DNS/ownership changes require out-of-band verification at the registry level (not just the registrar), defeating the exact attack class that hit CoW. Cloudflare provides this free via support ticket for `.app` (operated by Google Registry / CharlestonRoad), which supports registry-level locks.
- **DNSSEC** protects against DNS cache poisoning and strengthens the authenticity chain from registry → recursive resolvers. Cloudflare handles DS record publishing automatically.
- **Hardware 2FA** closes the account-takeover vector (phishing, SIM-swap, credential stuffing). TeraHash already uses YubiKey for GitHub and Vercel; reusing it for Cloudflare means zero hardware cost and consolidated key management.
- **At-cost domain pricing** (~$10/yr for `.app`) vs 2–5× markup at retail registrars.

The 5% of MarkMonitor value we lose is mostly procedural (dedicated analyst, legal takedown services, formal SLAs). None of those are load-bearing for TeraSwap's current threat model or user base.

---

## Consequences

### Positive

- **Registrar-level attack surface closed** for the dominant attack class (account takeover → DNS rewrite → frontend swap). Registry Lock requires out-of-band process at the registry.
- **Hardware 2FA only** — no SMS, no recoverable-email fallback (after proper account hardening).
- **Cost stays at $20/yr.** Fits the $0/month operational envelope the project runs on.
- **Consolidated security surface** — one YubiKey secures GitHub, Vercel, and now Cloudflare. Fewer keys to rotate, lose, or compromise.
- **DNSSEC** hardens the DNS resolution path for users on validating resolvers (Cloudflare 1.1.1.1, Google 8.8.8.8, many ISPs).
- **Observable baseline** — once migrated, Cloudflare provides audit logs and email alerts on any registrar-level change. Feeds into H2 monitor (ADR-001).

### Negative

- **TeraHash is single-point-of-failure for YubiKey access.** Mitigated by buying a second YubiKey as immediate backup (Action L-03 in incident report) and enrolling both in every protected account before disabling SMS/backup codes.
- **Cloudflare account compromise = single point of failure for the domain.** Mitigated by hardware 2FA + Registry Lock (which requires registry out-of-band verification, so even a compromised Cloudflare account cannot rewrite DNS without additional signal).
- **Migration window carries risk.** During the registrar transfer, DNS could propagate inconsistently. Mitigated by: (a) pre-staging DNS records in Cloudflare before initiating transfer, (b) scheduling transfer during low-traffic window, (c) monitoring resolver propagation via `dig +trace` from multiple vantage points. Details in FASE-A-CLOUDFLARE-DNS.md.
- **Registry Lock slows legitimate changes.** Adding a new subdomain or rotating a record requires Cloudflare support request + out-of-band verification. Accepted: domain changes are rare (target: <1/quarter) and the friction is the point.
- **No dedicated incident response SLA.** Cloudflare support is shared-tier. Mitigated by: (a) low change rate, (b) our own monitoring stack (H2 in ADR-001) will alert us to drift within minutes regardless of Cloudflare's response time.

### Neutral / Follow-ups

- Baseline capture (`npm run baseline:capture`) must run **after** migration completes, not before — otherwise H2 will flag every post-migration record as a hijack.
- Document internal emergency recovery procedure (what TeraHash does if the YubiKey is lost while the backup is also unavailable). Template included in FASE-A-CLOUDFLARE-DNS.md.
- Revisit this decision annually, and **immediately** if any of the triggers for Alternative A fire (see above).

---

## Migration triggers for upgrading to MarkMonitor (future)

We will revisit this ADR and consider migrating to a brand-protection registrar when **any** of the following becomes true:

1. Monthly swap volume through TeraSwap sustains above **$1B**.
2. TeraSwap holds any custodial user assets (currently non-custodial — users hold their own keys).
3. We suffer a domain-level targeted attack that Cloudflare controls did not fully block.
4. Legal/compliance requirement (e.g., institutional counterparty due-diligence) mandates an enterprise registrar.
5. Annual operational budget exceeds $50k/yr, making the $3–5k/yr MarkMonitor cost a <10% line item.

Until one of these fires, Cloudflare Registrar + Registry Lock + DNSSEC + YubiKey is the stable configuration.

---

## References

- Incident: [2026-04-14-cowswap-dns-hijack.md](../../Audits/Incidents/2026-04-14-cowswap-dns-hijack.md)
- Related ADR: [ADR-001-monitoring-architecture.md](./ADR-001-monitoring-architecture.md) (H2 TLS/DNS watcher depends on stable post-migration baseline)
- Manual execution plan: [FASE-A-CLOUDFLARE-DNS.md](../../FASE-A-CLOUDFLARE-DNS.md)
- Cloudflare Registrar docs: https://developers.cloudflare.com/registrar/
- `.app` TLD registry lock: managed by Google Registry / CharlestonRoad Registry Inc.
