# Incident Report — CoW Swap DNS Hijack (Ecosystem)

**Incident ID:** INC-2026-04-14-001
**Date:** 14 April 2026
**Severity:** Medium (ecosystem-level, TeraSwap exposure: zero)
**Author:** TeraSwap Architecture Team
**Status:** Resolved
**Related artifacts:**
- External communication: [TeraSwap_CoWIncident_Response.md](../../TeraSwap_CoWIncident_Response.md)
- Reference memory: `.auto-memory/reference_defi_hacks_cowswap_frontend.md`
- Architecture response: [ADR-001-monitoring-architecture.md](../../docs/ADR/ADR-001-monitoring-architecture.md)
- Domain hardening plan: [FASE-A-CLOUDFLARE-DNS.md](../../FASE-A-CLOUDFLARE-DNS.md)

---

## 1. Summary

CoW Protocol suffered a DNS hijack on their frontend domain `swap.cow.fi` starting at 14:54 UTC on 14 April 2026. The backend API (`api.cow.fi`) was confirmed NOT compromised. TeraSwap integrates CoW through the backend API only — no user interaction with `swap.cow.fi` occurs through TeraSwap.

**TeraSwap exposure: zero.** Funds, signatures, user data — all unaffected.

This incident triggered two internal responses: (a) preventive disabling of `cowswap` as a source, and (b) architectural decisions to accelerate monitoring and domain hardening.

---

## 2. Timeline

All times UTC. Times marked `~` are approximate based on public observation.

| Time | Event |
|---|---|
| **~14:54** | DNS hijack begins on `swap.cow.fi`. Attacker redirects domain to malicious frontend |
| **~15:10** | First public reports on X (formerly Twitter) about CoW frontend showing unusual behaviour |
| **~15:30** | CoW Protocol acknowledges investigation via official channels |
| **~15:40** | TeraSwap Architect + Auditor observe incident via manual feed monitoring (personal X accounts) |
| **~15:45** | Internal risk assessment initiated. Decision: TeraSwap uses `api.cow.fi`, not `swap.cow.fi` — exposure theoretically zero, but preventive disable warranted |
| **~16:00** | CoW disables `api.cow.fi` preventively (even though not compromised) |
| **~16:15** | TeraSwap decision: disable `cowswap` source in routing until CoW publishes post-mortem. External comms drafted (tweet thread + banner) |
| **~16:30** | CoW DAO publishes official communication confirming: (a) DNS hijack at 14:54 UTC, (b) backend/APIs not impacted, (c) APIs paused preventively |
| **~17:00** | TeraSwap comms doc finalized: `TeraSwap_CoWIncident_Response.md` |
| **~18:00** | Retrospective begins. Gaps identified in detection speed — TeraSwap awareness came ~90 min after incident began, all via manual channels |
| **~19:00** | Architecture decision recorded in Sprint 5 plan: implement H1+H2+H5+H6 monitoring stack to reduce detection time from ~90 min to <5 min |

---

## 3. Technical details of the attack

Based on public information from CoW DAO post-incident communication:

- **Attack class:** DNS hijacking at registrar level. Attacker gained control over DNS records for `swap.cow.fi` (and possibly the parent `cow.fi`).
- **Likely vector:** registrar account takeover (credential compromise, SIM swap, or social engineering). Exact vector not publicly confirmed at time of writing.
- **Scope of compromise:**
  - ✅ Compromised: `swap.cow.fi` (frontend domain) — served malicious HTML/JS
  - ❌ NOT compromised: `api.cow.fi` (backend), `cow.fi` root, backend infrastructure, smart contracts
- **User impact:** any user who connected wallet + signed transaction on compromised frontend could have signed malicious calldata. Victim count / loss amount not publicly disclosed.

**Why TeraSwap was not exposed:**

TeraSwap integrates CoW via server-to-server HTTPS calls to `api.cow.fi` from our backend. Our frontend (`teraswap.app`) never redirects users to `swap.cow.fi` and never requests signatures targeting CoW's frontend. The compromised domain is outside TeraSwap's attack surface.

---

## 4. TeraSwap response actions

### 4.1 Immediate (within 90 min of detection)

1. **Preventive source disable** — `cowswap` removed from active routing pool. User-facing: routing quality unaffected (10 other sources continue). Backend: no code change required thanks to existing source-preferences mechanism.
2. **External communication drafted** — tweet thread (6 posts) + website banner + Discord/Telegram messaging. Doc: `TeraSwap_CoWIncident_Response.md`.
3. **Validation of existing defense-in-depth** — confirmed that even if TeraSwap HAD been interacting with a compromised aggregator API, three protections would have blocked malicious calldata:
   - Calldata recipient validation (14/18 selectors)
   - Selector whitelist
   - Price guard via DefiLlama oracle

### 4.2 Architectural decisions (within 6h of detection)

The incident exposed that **detection was 100% manual** (via personal X account feeds of team members). This is unacceptable for a production DEX. Two architectural tracks initiated:

**Track A — Detection automation (Sprint 5A-C):**
- Approved stack: H1 (health check) + H2 (TLS/DNS watcher) + H5 (quorum, 5B) + H6 (Telegram bot, 5C) + kill-switch global
- Rejected: H3 (Twitter API automation, $200/mo — not worth it for current scale), H4 (statistical anomaly detection, effort too high for ROI)
- Target detection time: <5 min (vs ~90 min observed today)
- Full ADR: [ADR-001-monitoring-architecture.md](../../docs/ADR/ADR-001-monitoring-architecture.md)

**Track B — Domain hardening (Fase A):**
- Migrate `teraswap.app` from current registrar to Cloudflare Registrar
- Activate Registry Lock + DNSSEC + hardware 2FA (YubiKey)
- Rejected: MarkMonitor enterprise tier ($3-5K/year) — not justified at current scale
- Full ADR: [ADR-002-cloudflare-registrar.md](../../docs/ADR/ADR-002-cloudflare-registrar.md)
- Manual execution plan: [FASE-A-CLOUDFLARE-DNS.md](../../FASE-A-CLOUDFLARE-DNS.md)

### 4.3 Reactivation criteria for `cowswap` source

Before re-enabling CoW Protocol as a routing source, the following must ALL be satisfied:

1. CoW DAO publishes official post-mortem with root cause
2. CoW confirms DNS records stabilized for minimum 24h post-resolution
3. Manual verification that `api.cow.fi` responds with valid TLS cert from a trusted issuer
4. No mention in the post-mortem of secondary compromise (keys, credentials, backend infrastructure)
5. Smoke test in staging environment before production re-enable

If any criterion fails, source remains disabled indefinitely and we operate on 10 sources permanently.

---

## 5. Lessons learned

### 5.1 What worked

- **Server-to-server integration architecture** protected us from a frontend compromise. Validated the defense-in-depth design (no single point of user-facing contact with third-party domains).
- **Independent routing across 11 sources** meant disabling one had zero user impact.
- **Existing calldata validation, price guard, selector whitelist** provided three independent layers that would have caught malicious quotes even without the preventive disable.
- **Fast decision-making** — preventive disable within ~90 min despite manual detection. "Bias to disable" principle correctly applied.

### 5.2 What failed

- **Detection was entirely manual.** Depended on team members monitoring X feeds. If the incident had happened at 3am local time, detection window could have been hours instead of 90 min.
- **No automated alerting for ecosystem-level incidents.** We had no feed monitoring, no TLS/DNS watcher, no cross-check quorum.
- **Our own domain (`teraswap.app`) had no specific protection beyond standard registrar defaults.** Had we been the target instead of CoW, we might have been hit.
- **No documented runbook for "aggregator compromise" incidents.** Decision-making was ad-hoc. Next incident might involve a less clear-cut source or a team member less experienced with the context.

### 5.3 Actions committed

| # | Action | Owner | Deadline | Tracking |
|---|---|---|---|---|
| L-01 | Implement H1+H2 monitoring stack (auto-detection) | Code agent | +1 week | Sprint 5A, Prompts 25-29 |
| L-02 | Migrate `teraswap.app` to Cloudflare Registrar + Registry Lock + DNSSEC | TeraHash | +2 weeks | FASE-A-CLOUDFLARE-DNS.md |
| L-03 | Buy second YubiKey (backup) | TeraHash | +1 week | FASE-A-CLOUDFLARE-DNS.md Step 1 |
| L-04 | Implement H5 quorum cross-check | Code agent | +2 weeks | Sprint 5B (planned) |
| L-05 | Implement H6 Telegram bot interactive (human-in-the-loop) | Code agent | +3 weeks | Sprint 5C (planned) |
| L-06 | Create runbook "Aggregator compromise response" | Architect | +2 weeks | This doc informs it |
| L-07 | Document reactivation criteria checklist per source | Architect | +2 weeks | See §4.3 |

---

## 6. Metrics

| Metric | Value |
|---|---|
| Time from attack begin (14:54) to first team awareness | ~46 min |
| Time from team awareness to preventive disable | ~30 min |
| **Total time from attack to containment** | **~90 min** |
| Time from disable to official CoW confirmation | ~30 min |
| TeraSwap user financial loss | **€0** |
| TeraSwap user data exposure | **None** |
| Sources disabled | 1 of 11 (cowswap) |
| Routing impact | None observed |
| External communications published | 1 (tweet thread + banner doc, not yet posted at time of writing) |

**Target for next incident of this class:** total time from attack to containment < 5 min (automated detection + decision).

---

## 7. References

### External
- CoW DAO official communication on incident (14 Apr 2026, ~16:30 UTC)
- Public X/Twitter observations (aggregated)

### Internal
- `TeraSwap_CoWIncident_Response.md` — external communications (tweet thread, banner, Discord post)
- `.auto-memory/reference_defi_hacks_cowswap_frontend.md` — quick reference memory
- `docs/ADR/ADR-001-monitoring-architecture.md` — decision record for detection automation
- `docs/ADR/ADR-002-cloudflare-registrar.md` — decision record for domain hardening
- `FASE-A-CLOUDFLARE-DNS.md` — step-by-step domain migration manual
- `SPRINT5A-PLAN.md` — execution plan for monitoring implementation
