# ADR-001 — Monitoring & Incident Response Architecture

**Status:** Accepted
**Date:** 2026-04-14
**Deciders:** TeraSwap Architect, Security Auditor
**Informed by:** [INC-2026-04-14-001 CoW DNS hijack incident](../../Audits/Incidents/2026-04-14-cowswap-dns-hijack.md)

---

## Context

The CoW Swap DNS hijack incident (14 April 2026) exposed that TeraSwap's detection of ecosystem-level security incidents was entirely manual. Team members learned of the attack via personal X/Twitter feeds approximately 46 minutes after the attack began. Preventive action followed another 30 min later. Total response time: ~90 minutes.

For a production DEX aggregator integrating 11 external liquidity sources, this response time is unacceptable. A compromised aggregator API could drain funds through malicious calldata within minutes. We need automation.

Six hypotheses were evaluated for automated detection and response.

---

## Decision

Adopt a **layered defense architecture** with four components, implemented across Sprints 5A-5C:

### Adopted

1. **H1 — Active health checks per source** (Sprint 5A) — lightweight probe request to each aggregator every 60s. Tracks availability and latency. Auto-transitions source state: `active → degraded → disabled` based on consecutive failures or p95 latency thresholds.

2. **H2 — TLS/DNS fingerprint watcher** (Sprint 5A) — compares observed TLS cert (issuer, subject, SAN, fingerprint) and DNS records (A, AAAA, NS) against a committed baseline. Mismatch triggers immediate P0 disable. Co-located with H1 to avoid duplicate connections.

3. **H5 — Cross-check quorum** (Sprint 5B) — compares quote responses from all active sources. Outliers >5% from median (for liquid pairs) or >15% (for illiquid) flagged. ≥3 outliers in one cycle triggers kill-switch.

4. **H6 — Telegram bot with human-in-the-loop** (Sprint 5C) — receives alerts from H1/H2/H5, presents operator with action buttons `[Reactivate] [Keep Disabled] [Escalate]`. Primary channel Telegram, secondary Email (Resend free), tertiary Discord (private ops server).

### Cross-cutting: Containment layer (Sprint 5A)

Independent of detection, a containment layer ensures user experience degrades gracefully:

- Silent failover: routing excludes `state != 'active'` sources transparently
- UI badge showing `N/11 sources active` — transparency without alarm
- Weighted thresholds (1inch/0x=3, Paraswap/CoW/Odos=2, rest=1): `disabled_weight > 8 → warning`, `> 15 → read-only kill-switch`
- Kill-switch triggers: (a) weighted threshold exceeded, (b) ≥3 correlated P0 disables in 5min, (c) any change on `teraswap.app` (our own domain)
- Audit trail: append-only Supabase table with merkle-chain hashes (each row hashes prev row's trigger_hash)

### Rejected

5. **H3 — External security feed automation** — rejected for Phase 1. Twitter API costs $200/mo and free-tier alternatives (Nitter, RSS) are fragile. 95% of value is achievable by team manually following 3-5 key accounts. Reconsider in Phase 2 when DEX has meaningful revenue.

6. **H4 — Statistical anomaly detection** — rejected indefinitely. Baselines for DeFi pair behavior are unstable (volumes swing 10×, liquidity migrates). Effort: 10+ days with questionable ROI. H5 quorum captures 80% of the value at 20% of the effort. Re-evaluate only if H1+H2+H5 prove insufficient.

---

## Consequences

### Positive

- **Target detection time reduced from ~90 min to <5 min** for the class of attack observed in the CoW incident.
- **Three independent layers** (availability / cryptographic identity / semantic consistency) — defense in depth.
- **$0/month runtime cost** — all components use free tiers or existing infrastructure. No new subscriptions required.
- **Human-in-the-loop preserved** — automation proposes, operator confirms. Reduces false-positive operational risk.
- **Correlated attack defense** — kill-switch global handles the hardest case (supply chain compromise hitting multiple sources simultaneously).
- **Audit trail is forensically credible** — merkle chain hash makes post-hoc tampering detectable even if Supabase credentials are compromised.

### Negative

- **Vercel cron minimum is 60s.** Auditor preferred 30s TLS check. Accepted trade-off for MVP; can migrate monitoring loop to dedicated worker (Railway/Fly) if 30s granularity proves necessary.
- **In-memory state for source state machine.** Lost on deploy or restart. Acceptable because the next tick re-populates state from health checks. Supabase-backed persistence is a follow-up (ADR boundary preserved in code).
- **Static source weights (Phase 1).** Doesn't reflect real-time volume coverage. Phase 2 replaces with weekly batch of actual volume data from top-100 pairs.
- **Kill-switch UX is intentionally restrictive.** False positives mean users see "Swaps temporarily disabled — security investigation" banner. Accepted: cost of false positive (5-15 min UX interruption) vs false negative (exposure to malicious calldata) is asymmetric; bias to disable is correct.

### Neutral / Follow-ups tracked

- H3 deferred → manual feed monitoring via team members' personal accounts for now.
- SMS notification tier deferred until project generates meaningful revenue.
- On-chain audit trail anchor (~$1/day gas) deferred to Sprint 5D (optional); implement only if external legal/compliance review requires irrefutable records.

---

## Auditor refinements incorporated

Five refinements proposed by the Security Auditor were all integrated:

1. **Kill-switch read-only UX** — when kill-switch active, quotes remain visible (transparency) but swap button is disabled with explicit banner: "⚠️ Swaps temporarily disabled — security investigation in progress. Quotes shown are for reference only. Do NOT copy calldata to other interfaces."

2. **H2 co-located with H1** — TLS cert captured on the same connection as the health check request, eliminating duplicate connections that could trigger WAF rate limits. For endpoints where `fetch()` doesn't expose TLSSocket, dedicated `tls.connect` runs only when baseline comparison is needed.

3. **Audit trail merkle chain** — each `source_events` row includes `chain_prev_hash = previous row's trigger_hash`. Tampering requires forging the entire chain. Combined with Supabase point-in-time recovery and append-only RLS, creates a credible forensic record.

4. **Discord fallback in private ops server** — `teraswap-ops` Discord server, 2-3 trusted members, hardware 2FA mandatory. Never the public user server.

5. **TLS/DNS baseline committed to repo before H2 goes live** — `data/endpoint-baseline.json` populated via `npm run baseline:capture` script, output reviewed and committed. First tick without baseline would alert on everything.

---

## Alternatives considered

### Alternative A — Full managed security stack (rejected)

Use a third-party web3 security monitoring service (e.g., Blockaid, Forta, Hypernative). Would replace much of Sprint 5A-C.

**Rejected because:** subscription cost $500-5000/month, vendor lock-in, most of their value is directed at smart contract monitoring (which we have via on-chain event watcher already), and we lose the architectural flexibility needed for DEX-aggregator-specific semantics (cross-source quorum, per-aggregator TLS).

Reconsider if we ever have $10k+/month security budget and want to offload ops.

### Alternative B — Pure manual response + better team coverage (rejected)

Keep detection manual but add 24/7 on-call rotation and better Twitter monitoring discipline.

**Rejected because:** does not scale, requires additional headcount, human response time cannot match automated response for P0 events, and team members outside EU timezone don't exist yet.

### Alternative C — Only implement H1, defer H2+H5+H6 (rejected)

Start with just availability monitoring. Add cryptographic and semantic layers later.

**Rejected because:** H1 alone would NOT have caught the CoW incident — the frontend compromise did not produce 5xx errors. H2 is the layer that catches DNS hijacks specifically. Sequencing without H2 in Sprint 5A leaves the known threat class uncovered.

---

## References

- Incident report: [2026-04-14-cowswap-dns-hijack.md](../../Audits/Incidents/2026-04-14-cowswap-dns-hijack.md)
- Execution plan: [SPRINT5A-PLAN.md](../../SPRINT5A-PLAN.md)
- Related ADR: [ADR-002-cloudflare-registrar.md](./ADR-002-cloudflare-registrar.md)
- Manual domain hardening: [FASE-A-CLOUDFLARE-DNS.md](../../FASE-A-CLOUDFLARE-DNS.md)
