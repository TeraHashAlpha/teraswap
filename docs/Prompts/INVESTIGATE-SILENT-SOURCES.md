# INVESTIGATE-SILENT-SOURCES — why half the aggregators produce no prod quotes (READ-ONLY)

> **Source:** T-SAF W7-L-02 coverage-check report (2026-07-02). The coverage check closed the "add decoders" question
> (no) but found the **real** best-execution gap: several major aggregators return **nothing** in production, thinning
> the actual price competition to a handful of sources. This is lost best-execution = the core value of a
> meta-aggregator degraded. **READ-ONLY: no code changes, no env changes, no on-chain transactions.** Produce a
> findings report + a RICE-ranked fix list. SSH-signed commit of the report only.

## Context (what the coverage check observed)
- **1inch, 0x, Odos, SushiSwap, Bebop returned nothing in 18/18 live samples on BOTH chains.**
- **Odos** had **614 quotes / 17% wins in April** (monitor history) → now silent. Something regressed.
- Suspected **mainnet FeeCollector ↔ Augustus (Velora) whitelist gap** further thins **fee-routed execution** on
  mainnet to effectively **Kyber + UniV3** (winning quotes from non-whitelisted routers can't settle → fall back).
- For contrast, the three quote-only sources we just declined to build decoders for (Balancer/OpenOcean/Curve)
  represent **orders of magnitude less** lost competition than these silent aggregators.

## Objective (READ-ONLY)
For each silent source, on each chain, determine the **root cause** of zero prod quotes, explain the **Odos
regression**, and **confirm or refute** the mainnet FeeCollector↔Augustus whitelist gap with numbers. Output a
classified per-source table + a ranked remediation list. **Change nothing.**

## Requirements
1. **Per source × chain (1inch, 0x, Odos, SushiSwap, Bebop):** classify the cause into one of
   `{disabled/flagged-off, missing-or-invalid-API-key, upstream-error/endpoint-deprecated, code/units-bug (à la
   OpenOcean), rate-limited, chain-unsupported}`. Evidence for each:
   - Is the adapter enabled? (check `DISABLED_SOURCES` + any feature flags/env gating.)
   - Is the required key present + non-empty in the **prod (Vercel) env**, and does the upstream **accept** it?
     Probe each endpoint with one canonical pair per chain and capture the **HTTP status + error body**.
     **Never print, log, or commit the secret key values** — report presence/validity only.
   - Any request-shape bug (units, params, chainId, decimals) like the OpenOcean case.
2. **Odos regression:** it worked in April → identify what changed (key expiry/rotation, endpoint/version change,
   a code change, or params). Give the specific cause if determinable, else the top hypotheses + how to confirm.
3. **Mainnet FeeCollector ↔ Augustus whitelist (read on-chain, view calls only — NO tx):** does the deployed
   mainnet FeeCollector's `whitelistedRouters` include **Augustus V5 (Velora)** and the other routers the frontend
   can emit? If not, **quantify** the impact: over the sampled/monitor quotes, what fraction of *winning* routes
   target a router that is **not** whitelisted on mainnet (i.e. can't settle → forced fallback / worse fill)?
4. **Deliverable:** `Audits/Campaign/2026-07-01/W7-followup-silent-sources.md` — a per-source table
   (source · chain · cause · evidence · fix-type), the Odos root cause, the Augustus-whitelist finding with numbers,
   and a **RICE-ranked** remediation list split into:
   - `config/env` fixes (a key/flag change — cheapest),
   - `code` fixes (a units/param/adapter bug),
   - `on-chain whitelist` changes (**contract — flag for the proper gate; do NOT do it here**, rules #2/#3).

## Do NOT
- No code changes, no env/key changes, no on-chain transactions. **Never print/log/commit any secret API key** — only
  presence/validity. Any whitelist change is a separate **contract-gated** task (check `docs/security/AUDIT-TOTAL.md`
  first) — this prompt only **reports** the gap. Don't re-enable a source here — just diagnose.

## Files / areas (verify on main)
- The adapters for 1inch / 0x / Odos / Sushi / Bebop; `DISABLED_SOURCES` + env/flag gating; the prod env inventory
  (names only); the mainnet FeeCollector `whitelistedRouters` (on-chain view); the monitor history for the April vs
  now comparison.

## Expected output
- Branch `audit/silent-sources-investigation` off latest `origin/main`; SSH-signed; the report committed. **No
  behavior change.** FEEDBACK: the top-3 highest-RICE fixes with their owner/type (env vs code vs contract-gate).

## Quality criteria
Every silent source has a **classified, evidence-backed** root cause; the Odos regression cause (or ranked
hypotheses) is stated; the Augustus-whitelist gap is confirmed/refuted **with a number**; the remediation list is
RICE-ranked and correctly split by change-type; **zero** code/env/on-chain change; **no secrets exposed**.

---

### `/goal` paste for the Code Agent (≤4000)
```
INVESTIGATE-SILENT-SOURCES per docs/Prompts/INVESTIGATE-SILENT-SOURCES.md.
READ-ONLY — no code edits, no env/key changes, no on-chain tx. Branch
audit/silent-sources-investigation off origin/main, SSH-signed; commit the report
only. NEVER print/log/commit any secret API key (report presence/validity only).

Context (T-SAF W7-L-02 coverage check, 2026-07-02): the REAL best-exec gap is that
1inch, 0x, Odos, SushiSwap, Bebop returned NOTHING in 18/18 live samples on BOTH
chains. Odos had 614 quotes/17% wins in April -> now silent. Suspected mainnet
FeeCollector<->Augustus(Velora) whitelist gap further thins fee-routed mainnet
execution to ~Kyber+UniV3.

Do:
1. Per source x chain (1inch/0x/Odos/Sushi/Bebop) classify the cause: {disabled/
   flagged-off, missing-or-invalid-API-key, upstream-error/endpoint-deprecated,
   code/units-bug, rate-limited, chain-unsupported}. Evidence each: adapter
   enabled? (DISABLED_SOURCES + flags); required key present+non-empty in the prod
   Vercel env and accepted by upstream? (probe each endpoint with one canonical
   pair per chain; capture HTTP status + error body — DO NOT reveal key values);
   any request-shape bug (units/params/chainId/decimals) like OpenOcean.
2. Odos regression: worked in April -> find what changed (key expiry/rotation,
   endpoint/version change, code, params). State the cause or ranked hypotheses +
   how to confirm.
3. Mainnet FeeCollector<->Augustus whitelist (on-chain VIEW calls only, NO tx):
   does the deployed mainnet FeeCollector whitelistedRouters include Augustus V5
   (Velora) + the other routers the frontend can emit? If not, QUANTIFY: what
   fraction of winning routes target a non-whitelisted router on mainnet (can't
   settle -> forced fallback)?

Deliver Audits/Campaign/2026-07-01/W7-followup-silent-sources.md: per-source table
(source·chain·cause·evidence·fix-type), Odos root cause, Augustus-whitelist finding
WITH a number, and a RICE-ranked remediation list split into config/env vs code vs
on-chain-whitelist (contract — flag for the proper gate, DO NOT change here; check
docs/security/AUDIT-TOTAL.md first). No code/env/on-chain change. FEEDBACK: top-3
RICE fixes with owner/type.
```
