# SEC-5 · Wave 11 — Synthesis, cross-wave attack chains & remediation plan — entry packet

> **Campaign:** 2026-07-01. **Sprint:** SEC-5 (consumes W0–W10). **Runner:** Auditor (read-only). **Baseline:**
> `origin/main` (cb0748d, verified-signature commits). **Source of truth:** T-SAF v1 §5-W11 + §9 (attack tree) + §10
> (cross-wave composition). **Binding:** T-SAF §1 + CLAUDE.md #1/#2/#3/#12. **Deliverables:**
> `Audits/Campaign/2026-07-01/MASTER-REPORT.md` + a verdict block appended to `docs/security/AUDIT-TOTAL.md`.

## Objective
Consolidate every wave's findings, hunt **cross-wave attack chains**, confirm **§2 coverage = 100%** and every §9
G-leaf is exercised-and-refuted or filed, RICE-rank the remaining backlog, and publish the master report.

## Consolidated finding inventory (dedupe + current status — verify each against main)
- **Campaign verdict so far: 0C / 0H product.** The only HIGH was **W3-H-01 (process — stale audited branch)**,
  RESOLVED by the re-baseline to `origin/main` + plan §0 baseline-pinning.
- **Already remediated on main (verify):** W2-M-01 + W2-L-01 (**PR #254** — `DEPLOYED-SOURCES.md` + `deployed-sources-guard`
  + flat deprecated + `deriveMinimumOutput`/`minimum-output-guard`); W8 plaintext-key L2 gap (TESTNET_CHAIN_IDS
  allowlist); W1-I-02 + W1-I-03 REFUTED (deployed FeeCollector HAS minOutput; Base OE IS wired); W1-L-01 SUPERSEDED
  (flat-only fns, not deployed).
- **Open backlog (all M/L/I, non-blocking) — carry into the RICE plan:**
  W4-I-01/I-02 (stale comment + router-allowlist parity → `AUDIT-W4-router-allowlist-parity.md`),
  W6-M-01/M-02/L-01 (order-read gate + rate-limit + body caps → `AUDIT-W6-api-hardening.md`, in progress),
  W7-L-01/L-02 (CoW fee-zeroing alert + quote-only source UX), W5-I-02 (fee-collector fallback nit),
  W8-I-01/I-02 (ALLOW_PLAINTEXT_KEY hygiene + per-cycle outflow), W9-L-01/I-01 (secure-storage plaintext fallback +
  COEP-omitted), W10-L-01 (viem 2 instances / bundle bloat), W1-L-02 (admin EOA centralization → being addressed by
  the Phase-4 HW-wallet migration).

## Method (§7.5 + §10)
1. **Dedupe + consolidate** all W1–W10 findings into one table (Sev · id · `file:line` · disposition · current
   status: FIXED-on-main / REMEDIATION-PROMPT / REFUTED / REPORT).
2. **Cross-wave attack-chain hunt (§10):** compose findings across waves into multi-step attacks and confirm each is
   refuted. Specifically test the "protection here, missing there" pattern and the flagship chain: can any
   **off-chain** finding (W6 read-leak, W7 source quirk, W9 client downgrade, W10 dep) be chained to **fund loss**?
   Prove the **on-chain guards (W1/W2: recipient=owner + on-chain minimumOutput + chain-correct router whitelist)**
   are the terminal backstop that makes every off-chain finding non-fund-affecting — i.e. **no chain reaches funds**.
3. **Coverage attestation:** map the §2 inventory (W0 denominator) → each item owned + covered; confirm **every §9
   G-leaf (G1..G10)** is exercised-and-refuted (with the wave/evidence) or has a filed finding + prompt. Report the
   covered fraction = **100%**.
4. **RICE-rank** the open backlog → split **auto-fixable / needs-contract-sprint / needs-human**; note which already
   have remediation prompts.

## Deliverables
- **`Audits/Campaign/2026-07-01/MASTER-REPORT.md`:** exec summary; the consolidated finding table; C/H/M/L/I counts;
  the cross-wave chain analysis (no fund-reaching chain); the RICE remediation plan; the §2 coverage attestation
  (=100%); the campaign verdict.
- **`docs/security/AUDIT-TOTAL.md`:** append the T-SAF 2026-07-01 campaign verdict block (waves, counts, the
  W3-H-01 process fix, the on-chain-backstop conclusion).

## Exit criteria
Master report published; every C/H (none) has a remediation prompt; the cross-wave analysis shows **no chain reaches
funds**; §2 coverage = 100% and every §9 G-leaf accounted for; the backlog is RICE-ranked; AUDIT-TOTAL updated.

---

### `/goal` paste for the Auditor (≤4000)
```
Wave 11 (Synthesis, cross-wave chains & remediation plan) per Audits/Campaign/
2026-07-01/W11-synthesis.md + TERASWAP-AUDIT-FRAMEWORK.md §5-W11 + §9/§10.
READ-ONLY, no code edits. Baseline origin/main (cb0748d). Consume all W0-W10
reports in Audits/Campaign/2026-07-01/.

1. DEDUPE + CONSOLIDATE all W1-W10 findings into one table: Sev · id · file:line
   · disposition · current status (FIXED-on-main / REMEDIATION-PROMPT / REFUTED
   / REPORT). Verify the "already remediated" set against main (W2-M-01/L-01 via
   #254; W8 plaintext L2 gap; W1-I-02/I-03 refuted; W1-L-01 superseded).
2. CROSS-WAVE ATTACK-CHAIN HUNT (§10): compose findings across waves into
   multi-step attacks; confirm each refuted. Flagship test: can ANY off-chain
   finding (W6 order-read leak, W7 source quirk, W9 client downgrade, W10 dep)
   chain to FUND LOSS? Prove the on-chain guards (W1/W2: recipient=owner +
   on-chain minimumOutput + chain-correct router whitelist) are the terminal
   backstop -> NO chain reaches funds. Hunt the "protection here / missing
   there" pattern.
3. COVERAGE: map §2 inventory (W0 denominator) -> every item owned+covered;
   confirm every §9 G-leaf (G1..G10) is exercised-and-refuted (wave+evidence) or
   filed. Report covered fraction = 100%.
4. RICE-rank the open backlog (W4-I-01/I-02, W6-M-01/M-02/L-01, W7-L-01/L-02,
   W5-I-02, W8-I-01/I-02, W9-L-01/I-01, W10-L-01, W1-L-02) -> split auto-fixable
   / needs-contract-sprint / needs-human; note which have prompts.

Deliver: Audits/Campaign/2026-07-01/MASTER-REPORT.md (exec summary, consolidated
finding table, C/H/M/L/I counts, cross-wave chain analysis = no fund-reaching
chain, RICE plan, §2 coverage=100%, campaign verdict) + append the campaign
verdict block to docs/security/AUDIT-TOTAL.md. SSH-signed commit left for owner
if no key in sandbox.
```
