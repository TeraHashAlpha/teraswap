# Sprint 5B — Quorum Cross-Check (H5)

**Sprint window:** 2026-04-15 → 2026-04-22
**Sprint goal:** ship H5 quorum cross-check from ADR-001 — periodic quote comparison across active sources to detect manipulated quotes, compromised APIs, and correlated failures.
**Owner:** TeraHash (founder/architect) + code agent
**Status as of 2026-04-15:** COMPLETE (3/3 prompts shipped, auditor approved).

---

## Sprint status table

| # | Prompt | Commit | Auditor verdict | Follow-up |
|---|---|---|---|---|
| 30 | H5 quorum module + reference pair fetcher | — | **1H + 2M + 3L + 2I** | Prompt 30.1 |
| 30.1 | Auditor fixes (precision, P0, incr, naming, trust doc) | `2a14075` | All 7 fixed, auditor verified | — |
| 31 | Wire H5 into monitoring loop + correlated kill-switch | `66208f4` | 🟢 APPROVED (0C/0H, 2I) | — |

---

## Architecture context

ADR-001 § H5: "compares quote responses from all active sources. Outliers >5% from median (for liquid pairs) or >15% (for illiquid) flagged. ≥3 outliers in one cycle triggers kill-switch."

The quote route (`/api/quote`) already computes `crossQuoteDeviation` and `crossQuoteWarning` per user request. But that's reactive — protects individual users. H5 is proactive: runs in the monitoring tick on a reference pair, detects systemic source compromise before users are affected.

**Key difference from H1/H2:**
- H1: "is the source reachable?" (availability)
- H2: "is the source authentic?" (identity)
- H5: "is the source honest?" (semantic integrity)

A compromised aggregator API could return reachable, valid-TLS responses but with manipulated calldata or inflated quotes to drain funds. H5 catches this.

---

## Prompt 30 — H5 quorum cross-check module

**Status:** Pending.

**Context:** the monitoring stack (H1 + H2) runs every 60s and verifies availability + identity of each aggregator. What it cannot detect is a source returning manipulated quotes — the API responds OK, TLS is valid, but the quote directs funds to an attacker's contract. H5 adds a semantic layer: periodically fetch quotes from all active sources for a well-known reference pair, compare them, and flag outliers.

The existing `fetchMetaQuote()` in `src/lib/api.ts` already fetches quotes in parallel and computes `crossQuoteDeviation`. We do NOT want to duplicate that logic. Instead, H5 should call `fetchMetaQuote()` internally with a reference pair, then apply stricter quorum analysis on the result.

**Objective:** create `src/lib/quorum-check.ts` that implements the H5 quorum cross-check.

**Requirements:**

1. **Reference pairs** — define 2 reference pairs for quorum validation:
   - Primary: WETH → USDC, amount = 1 ETH (high-liquidity, well-priced by all sources)
   - Secondary: USDC → USDT, amount = 10,000 USDC (stablecoin pair, expected deviation ≈ 0)
   - Config: `QUORUM_REFERENCE_PAIRS` constant array in the module. Each entry: `{ fromToken, toToken, amount, label, maxDeviationPercent }`.

2. **Quorum analysis function** — `runQuorumCheck(): Promise<QuorumCheckResult>`:
   - For each reference pair:
     a. Call `fetchMetaQuote(from, to, amount)` (reuse existing adapter fan-out)
     b. Collect all `NormalizedQuote` results from `result.all`
     c. Compute median output amount (use `toAmount` normalized to same decimals)
     d. For each source, compute deviation from median: `abs(sourceAmount - median) / median`
     e. Flag sources where deviation > pair's `maxDeviationPercent` (default: 5% for WETH/USDC, 2% for USDC/USDT)
     f. Track which sources are flagged and their deviation
   - Aggregate across pairs: a source flagged on BOTH pairs = high confidence outlier
   - Return: `QuorumCheckResult { timestamp, pairs: PairResult[], outliers: OutlierInfo[], correlatedOutlierCount: number }`

3. **Outlier classification:**
   - `warning`: deviation > threshold on 1 pair only → log, do not act
   - `flagged`: deviation > threshold on 2/2 pairs → emit `quorum-deviation` alert, transition source to `degraded` if currently `active`
   - `correlated`: ≥3 sources flagged simultaneously → trigger `quorum-kill-switch` via `forceDisable()` on all flagged sources + emit P0 alert

4. **Threshold config** — extend `data/source-thresholds.json`:
   ```json
   {
     "defaults": {
       "...existing...",
       "quorumMaxDeviationPercent": 5,
       "quorumStableMaxDeviationPercent": 2
     },
     "overrides": {
       "cowswap": { "quorumMaxDeviationPercent": 8 }
     }
   }
   ```
   CoW Protocol may have higher deviation due to batch auction mechanics — allow per-source override.

5. **Types** — export `QuorumCheckResult`, `PairResult`, `OutlierInfo` from the module. Include `sourceId`, `deviationPercent`, `medianAmount`, `sourceAmount`, `classification` in `OutlierInfo`.

6. **No network duplication** — H5 runs AFTER H1 in the monitoring tick. If a source is already `disabled` or `degraded`, exclude it from quorum (only compare `active` sources). Minimum 3 active sources required to form a valid quorum — if <3, skip quorum check and log reason.

**Files affected:**
- `src/lib/quorum-check.ts` (new)
- `data/source-thresholds.json` (extend with quorum fields)
- `src/lib/source-state-machine.ts` (add `quorum-deviation` as valid disable reason — NOT P0, allows auto-recovery)

**Do NOT:**
- Do NOT duplicate the adapter fan-out logic. Call `fetchMetaQuote()` and consume its output.
- Do NOT run quorum on every monitoring tick — it fetches real quotes from external APIs and counts against rate limits. Run every 5th tick (every 5 min). Use KV counter `teraswap:monitor:quorumTickCounter` to track.
- Do NOT block the monitoring loop on quorum failure. If `fetchMetaQuote()` throws, log and skip quorum for that tick.
- Do NOT add `quorum-deviation` to P0 reasons. Quote deviations can be transient (slippage, batch timing). Auto-recovery should be allowed after 10 min.
- Do NOT modify `fetchMetaQuote()` itself. H5 is a consumer, not a modifier.

**Quality criteria:**
- Unit tests: mock `fetchMetaQuote()` returning known quotes, verify median calculation, deviation flagging, correlated detection.
- Test: <3 active sources → quorum skipped gracefully.
- Test: single-pair flag → warning only (no state transition).
- Test: dual-pair flag → degraded transition + alert.
- Test: ≥3 correlated → all flagged sources force-disabled.
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 31 — Wire H5 into monitoring loop + correlated kill-switch

**Status:** Pending.

**Context:** Prompt 30 creates the quorum module. This prompt wires it into the existing monitoring tick, adds quorum results to the heartbeat response, and implements the correlated kill-switch trigger from ADR-001 § containment layer.

**Objective:** integrate `runQuorumCheck()` into the monitoring loop as a post-H1/H2 phase, add quorum data to heartbeat, and implement the correlated P0 kill-switch.

**Requirements:**

1. **Monitoring loop integration** (`src/lib/monitoring-loop.ts`):
   - After H1 health checks and H2 TLS/DNS validation, add H5 phase:
     ```
     Phase 1: beginTick()
     Phase 2: H1 health checks (parallel)
     Phase 3: H2 TLS/DNS validation
     Phase 4: H5 quorum check (every 5th tick only)
     Phase 5: Auto-recovery
     Phase 6: Heartbeat write
     ```
   - On 5th-tick boundary: call `runQuorumCheck()`. Pass the current active source list (post-H1/H2 transitions) so quorum only runs on still-active sources.
   - On non-quorum ticks: skip H5, set `quorumResult: null` in the tick result.
   - Add quorum results to `MonitoringTickResult`:
     ```typescript
     quorum?: {
       ran: boolean
       outliers: OutlierInfo[]
       correlatedKillSwitch: boolean
       skippedReason?: string  // e.g., "fewer-than-3-active-sources"
     }
     ```

2. **Heartbeat extension** (`src/app/api/monitor/heartbeat/route.ts`):
   - Add to heartbeat response:
     ```json
     {
       "...existing...",
       "lastQuorumCheck": "2026-04-15T12:05:33Z",
       "quorumOutliers": 0,
       "quorumHealthy": true
     }
   - Read from KV: `teraswap:monitor:lastQuorumResult` (JSON, written by quorum module after each run).

3. **Correlated kill-switch** (ADR-001 § containment):
   - When `runQuorumCheck()` returns `correlatedOutlierCount >= 3`:
     a. Call `forceDisable()` on each flagged source with reason `quorum-correlated-anomaly` (P0-level for this specific case — add to P0 reasons)
     b. Emit a single aggregated alert: "⚠️ QUORUM KILL-SWITCH: {N} sources disabled — correlated quote anomaly detected. Sources: {list}. Manual investigation required."
     c. Write to KV audit trail: `teraswap:quorum:killswitch:{timestamp}` with full `QuorumCheckResult`
   - The `quorum-correlated-anomaly` reason IS P0 because correlated manipulation across 3+ sources suggests a systemic attack. Individual `quorum-deviation` (single source) is NOT P0.

4. **Alert integration:**
   - Individual outlier (flagged on 2/2 pairs): use existing `emitTransitionAlert()` with reason `quorum-deviation`
   - Correlated kill-switch: use `emitTransitionAlert()` for each source, PLUS a separate summary alert via direct call to all channels (bypass dedup for this — it's a one-time event per kill-switch trigger)

5. **Watchdog update** (`.github/workflows/monitoring-watchdog.yml`):
   - Add quorum health to the watchdog check: if `quorumHealthy === false` in heartbeat, include in alert payload (but don't change the page threshold — watchdog pages on tick age, not quorum state).

6. **Dashboard link** — the existing alert template has a `Dashboard` link. For quorum alerts, link to `https://teraswap.app/api/monitor/heartbeat` (read-only, shows quorum status).

**Files affected:**
- `src/lib/monitoring-loop.ts` (add H5 phase)
- `src/app/api/monitor/heartbeat/route.ts` (extend response)
- `src/lib/p0-reasons.ts` (add `quorum-correlated-anomaly`)
- `src/lib/quorum-check.ts` (add KV write for last result + audit trail)
- `.github/workflows/monitoring-watchdog.yml` (minor: log quorum status)

**Do NOT:**
- Do NOT run quorum on every tick. Respect the 5-tick cadence from Prompt 30.
- Do NOT change the tick route auth or scheduling. H5 piggybacks on the existing tick.
- Do NOT make the heartbeat response slower — quorum data comes from KV (cached), not live computation.
- Do NOT auto-recover from `quorum-correlated-anomaly`. It requires manual `forceActivate()` after investigation.

**Quality criteria:**
- Integration test: mock monitoring loop with quorum on 5th tick, verify it runs.
- Test: correlated kill-switch triggers forceDisable on all flagged sources.
- Test: heartbeat includes quorum data.
- Test: non-quorum ticks skip H5 cleanly.
- Test: watchdog workflow syntax valid (`actionlint` or manual check).
- All existing monitoring tests still pass (no regression).
- `npm run build` passes.

---

## Prompt 30.1 — Auditor fixes for H5 quorum module

**Status:** Pending.

**Context:** Auditor reviewed Prompt 30 and found 1H + 2M + 3L + 2I. Architect decisions inline. This prompt fixes all actionable findings.

**Objective:** apply auditor corrections to `src/lib/quorum-check.ts` and related files.

**Fixes required (all mandatory):**

1. **#1 (H) — BigInt precision loss in deviation calculation.** Replace `Number(diff) / Number(median)` with BigInt-safe basis-point arithmetic:
   ```typescript
   const deviationBps = (diff * 10000n) / median  // basis points, entirely in BigInt
   const deviationPercent = Number(deviationBps) / 100  // safe: deviationBps < 10000 for realistic deviations
   ```
   Also add a guard for `median === 0n` → skip that pair (log warning, don't divide by zero).

2. **#2 (M) — Add `quorum-correlated-anomaly` to P0 reasons.** Architect decision: correlated ≥3 source anomaly IS P0. Auto-recovery must be blocked — requires manual `forceActivate()`.
   - In `src/lib/p0-reasons.ts`: add `'quorum-correlated-anomaly'` to `P0_REASONS` array.
   - Verify that the reason string used in `forceDisable()` call matches exactly (use `startsWith` pattern already established).
   - Individual `quorum-deviation` (single source, 2/2 pairs) remains NOT P0 — auto-recovery allowed.

3. **#3 (M) — Document API call budget.** Add a JSDoc comment block at the top of `quorum-check.ts` documenting the total API call budget:
   ```
   /**
    * API call budget per quorum cycle (every 5 ticks / 5 min):
    * - 2 reference pairs × N active sources = ~22 calls (if all 11 active)
    * - Combined with H1 (11 calls/min): peak burst = ~33 calls in 1 min
    * - Known rate-limit-sensitive adapters: 1inch (free tier), KyberSwap
    * - If rate-limit cascading observed, consider staggering quorum
    *   to non-H1-tick minutes or caching H1 quotes for reuse.
    */
   ```

4. **#4 (L) — Document trust model for small quorums.** Add inline comment at the minimum-sources check:
   ```typescript
   // Trust model: quorum assumes majority of active sources are honest.
   // With 3 sources, an attacker controlling 2 can invert the median and
   // flag the honest source as an outlier. With 5+, needs to control 3.
   // Minimum of 3 is acceptable for MVP (simultaneous compromise of 2
   // independent aggregator APIs is high-difficulty). Revisit if source
   // count drops below 5 sustained.
   ```

5. **#5 (L) — Replace `'quorum-system'` synthetic sourceId.** Instead of emitting a single alert with `sourceId='quorum-system'`, iterate over all flagged sources and emit one alert per source with their real `sourceId`. The reason string should include context: `'quorum-correlated-anomaly: deviation {X}% on {pairLabel}'`. Remove the synthetic sourceId entirely.

6. **#6 (L) — Use atomic `kv.incr()` for tick counter.** Replace the `get` + `set` pattern in `shouldRunQuorum()` with:
   ```typescript
   const count = await kv.incr(QUORUM_TICK_COUNTER_KEY)
   return count % 5 === 0
   ```
   This is atomic and eliminates the race condition between concurrent lambda invocations.

7. **#7 (I) — Add precision loss regression test.** Add a test case with amounts exceeding `Number.MAX_SAFE_INTEGER`:
   ```typescript
   it('handles BigInt amounts above Number.MAX_SAFE_INTEGER without precision loss', () => {
     const amounts = [2n**53n + 1n, 2n**53n + 100n, 2n**53n + 50n]
     // verify median and deviation calculation produce correct results
   })
   ```

**Files affected:**
- `src/lib/quorum-check.ts` (fixes #1, #3, #4, #5, #6, #7)
- `src/lib/p0-reasons.ts` (fix #2)
- Test file for quorum-check (fix #7)

**Do NOT:**
- Do NOT change `quorum-deviation` (single source) to P0. Only `quorum-correlated-anomaly` (≥3 sources) is P0.
- Do NOT add rate-limit staggering logic — just document the budget (fix #3). Staggering is deferred.
- Do NOT change the 5-tick cadence or reference pair config.

**Quality criteria:**
- All existing quorum tests still pass.
- New precision test passes with `2n**53n + 1n` amounts.
- `kv.incr()` used instead of `get` + `set` (verify in code review).
- `quorum-correlated-anomaly` appears in `P0_REASONS` array.
- No synthetic sourceId in alert calls.
- `npm run build` passes. `npm run lint` clean.

---

## Auditor review — Prompt 30

**Scope:** review `src/lib/quorum-check.ts`, changes to `data/source-thresholds.json`, and changes to `src/lib/source-state-machine.ts`.

**Checklist:**
1. Median calculation is correct (handles even/odd array lengths, handles bigint amounts without precision loss)
2. Deviation calculation uses absolute value and handles zero median (division by zero guard)
3. Reference pair amounts are reasonable (not dust amounts that return zero quotes)
4. Per-source threshold override works correctly (falls back to default)
5. Quorum skipped gracefully when <3 active sources (no false positives)
6. `quorum-deviation` is NOT in P0 reasons (allows auto-recovery)
7. No duplicate network calls — confirms H5 calls `fetchMetaQuote()` not individual adapters
8. 5-tick cadence enforcement is reliable (doesn't drift, handles KV counter failures)
9. Types are exported and well-documented
10. Tests cover: normal quorum (no outliers), single outlier, dual-pair flag, correlated trigger, <3 sources skip

**Expected output:** findings table with severity (C/H/M/L/I) and recommendation per finding. Verdict: APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION.

---

## Auditor review — Prompt 31

**Scope:** review changes to `src/lib/monitoring-loop.ts`, `src/app/api/monitor/heartbeat/route.ts`, `src/lib/p0-reasons.ts`, `src/lib/quorum-check.ts` (KV additions), `.github/workflows/monitoring-watchdog.yml`.

**Checklist:**
1. H5 phase runs AFTER H1/H2 — quorum only runs on post-transition source list (not stale state)
2. Non-quorum ticks skip H5 entirely (no partial execution)
3. Quorum failure (fetchMetaQuote throws) doesn't crash the monitoring loop
4. `quorum-correlated-anomaly` IS in P0 reasons (blocks auto-recovery — requires manual forceActivate)
5. Correlated kill-switch calls forceDisable on ALL flagged sources (not just the first 3)
6. Summary alert bypasses dedup correctly (one-time per kill-switch event)
7. Heartbeat reads from KV cache, not live quorum (response time unaffected)
8. KV audit trail entries are permanent (no TTL) and indexed
9. Watchdog workflow change doesn't break existing page logic
10. MonitoringTickResult type extension is backwards-compatible (quorum field is optional)
11. All existing tests still pass (no regression in H1/H2/alert/kill-switch tests)

**Expected output:** findings table with severity (C/H/M/L/I) and recommendation per finding. Verdict: APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION.

---

## See also

- ADR-001 § H5 — the decision behind quorum cross-check
- Sprint 5A (`docs/Prompts/SPRINT-5A.md`) — prerequisite: H1 + H2 + alerts + kill-switch
- `src/lib/api.ts` → `fetchMetaQuote()` — existing quote aggregation that H5 consumes
- `src/lib/monitoring-loop.ts` — tick structure where H5 integrates
- `data/source-thresholds.json` — threshold config extended for quorum
