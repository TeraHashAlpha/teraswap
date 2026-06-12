# AUDIT — E-2 sequencer-uptime gate on the quote path (fix/e2-sequencer-quote-gate)

**Scope:** commits `9604e43` (gate) + `d8bdaa0` (FEEDBACK) vs base `6d0a3e1`, plus in-audit remediation commits `b55d89b` + `d52d072`. **Method:** 4 parallel adversarial auditors (bypass / fail-safe & availability /
mainnet regression / spec-completeness), 129 verified tool calls, every finding code-verified.
**Machine-side FULL audit — human Auditor sign-off required before prod (gate change).**

## Verdict: APPROVED-WITH-NOTES — 0C / 0H after in-PR remediation

| Auditor | Verdict | C | H | M | L |
|---|---|---|---|---|---|
| Bypass | APPROVED-WITH-NOTES | 0 | 0 | 1 | 3 |
| Fail-safe & availability | APPROVED-WITH-NOTES | 0 | 1→**RESOLVED** | 2 | 1 |
| Mainnet regression | APPROVED-WITH-NOTES | 0 | 0 | 0 | 4 |
| Spec-completeness | APPROVED-WITH-NOTES | 0 | 0 | 2 | 2 |

## Findings & dispositions

### H-1 (RESOLVED in-PR) — thundering herd on sequencer-check cache miss
`sequencer-check.ts`: concurrent quote requests during a 30s-TTL cache miss each paid an RPC read
(no in-flight dedup) — worst at TTL expiry under load and during outage transitions.
**Fix (this PR):** single-flight per chainId — concurrent callers share one in-flight
`latestRoundData` read; verdict semantics unchanged (TDD: N concurrent callers → exactly 1
`readContract`). Commit `b55d89b` (TDD: 25 concurrent → 1 read; failure path deduped).

### L (RESOLVED in-PR) — POST raw chainId defeats the strict mainnet short-circuit
`handleQuotePost` passed the raw JSON `chainId` (string-typed when sent as `"1"`/`"8453"`) into
`fetchMetaQuote`, where `"1" !== 1` consults the gate on a notionally-mainnet request (no-op verdict,
but violates the byte-identical property) and string `"8453"` relies on JS coercion. **Fix (this
PR):** numeric coercion at the POST boundary (mirrors GET); POST 503 mapping test added.
Commit `d52d072` (string chainId → number; non-integer → 400; POST 503 mapping test added).

### M (ESCALATED — remediation prompt, separate review) — Base RPC fallback unused
`chains/clients.ts` builds the Base client from `rpc.primary` only; `registry.ts` defines
`rpc.fallbacks` that are never consulted. A degraded primary RPC fail-safes the gate to REFUSE,
blocking all Base quotes (availability cost). Changing client construction affects EVERY Base RPC
consumer → out of E-2 scope. **Prompt:** wire `fallback([http(primary), ...fallbacks])` in
`getPublicClientForChain`, test per-chain, verify no behavioral change for existing consumers.

### M (OPEN — FULL-Auditor design question, documented in FEEDBACK/PR) — swap-build path
`/api/swap` has no explicit `SequencerDownError` refusal; defense-in-depth today = the client can't
build a swap without a (now-gated) quote + the swap route's oracle validation reads the same
sequencer-gated feed. Decide: accept layered defense, or add the same one-line gate to the swap route.

### Accepted/noted (no action)
- 30s verdict cache ⇒ ≤30s stale-serve window on a down transition — inherited from the P218
  price-read gate (same cache/TTL, previously accepted). Monitoring note: alert on sequencer-feed
  RPC latency + refusal spikes.
- Admin `debug=sources` probes adapters without the gate — intentional ground-truth diagnostics,
  bearer-gated (DEBUG_QUOTE_TOKEN), read-only; the parallel pipeline probe DOES surface the gate state.
- `/api/v1/*` mainnet-only by explicit 400 → structurally immune.
- No client-side quote persistence (in-memory hook state only) → no stale-quote revival vector.
- Recovery detection lag ≤30s + 1h grace — standard, documented.

### Verified properties (evidence in audit transcripts)
- Mainnet byte-identical: gate short-circuits before any await/client/cache for chainId 1/omitted
  (test-pinned both; zero perf delta).
- P218 price-read gate and ALL other gates (DefiLlama, depeg, staleness, circuit-breaker,
  rate-limits, quote cache) untouched by the diff.
- Fail-safe direction REFUSE on: sequencer down, 1h recovery grace, RPC error.
- On-chain feed verification: `cast description()` = "L2 Sequencer Uptime Status Feed"
  (`0xBCF85224fc0756B9Fa45aA7892530B47e10b6433`, decimals 0, live answer 0=up).
- Both commits SSH-signed; suite green; no contract/adapter changes.

## For the human Auditor (sign-off checklist)
1. Confirm the REFUSE-on-RPC-error availability trade-off (M above mitigates via fallback prompt).
2. Rule on the swap-build design question (M-OPEN).
3. Approve the monitoring notes (sequencer-feed latency, refusal-rate alert) for the ops backlog.
