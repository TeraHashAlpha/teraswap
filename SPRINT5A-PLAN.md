# Sprint 5A — Sensores + Contenção (Monitorização Activa)

**Duração:** 1 semana
**Custo runtime:** $0/mês
**Dependência:** Fase A Cloudflare completa (ver [FASE-A-CLOUDFLARE-DNS.md](./FASE-A-CLOUDFLARE-DNS.md))
**Motivação:** Incidente CoW Swap (14 Abr 2026) — detecção manual levou ~90 min. Objectivo: reduzir para <5 min com automação.

---

## RICE

| Componente | Reach | Impact | Confidence | Effort | Score |
|---|---|---|---|---|---|
| H1 — Health check + circuit breaker | 11 sources | 3 (disponibilidade) | 95% | 1d | **285** |
| H2 — TLS/DNS watcher (colocalizado com H1) | 11 sources + teraswap.app | 3 (classe CoW) | 90% | 1.5d | **180** |
| Contenção — failover silencioso | 100% users | 3 | 95% | 1d | **285** |
| Contenção — badge UI + audit trail | 100% users | 2 | 95% | 1d | **190** |
| Kill-switch global | Eventos P0 | 3 (catastrófico) | 85% | 0.5d | **510** |
| Baseline TLS/DNS script | Setup one-off | 3 (blocker) | 100% | 0.5d | **600** |

**Ordem de execução (sequência de merge, cada commit verde antes do seguinte):**

1. Baseline TLS/DNS script (blocker dos outros — tem de existir primeiro)
2. H1 + H2 colocalizados (health check captura fingerprint TLS na mesma conexão)
3. Contenção (failover silencioso + routing exclude + badge UI)
4. Audit trail append-only
5. Kill-switch global

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│ SENSORES (corre em background, 30-60s interval)        │
│                                                         │
│  ┌──────────────────────────────────────────────┐       │
│  │ source-monitor.ts (existente, estendido)     │       │
│  │  ├─ H1: healthCheck() por source             │       │
│  │  │   └─ quote de teste USDC→USDT 1 unit      │       │
│  │  │   └─ captura latência p95                 │       │
│  │  │                                           │       │
│  │  └─ H2: captura TLSSocket.getPeerCertificate │       │
│  │      └─ compara fingerprint vs baseline      │       │
│  │      └─ compara DNS records vs baseline      │       │
│  └──────────────────────────────────────────────┘       │
│                     │                                   │
│                     ▼                                   │
│  ┌──────────────────────────────────────────────┐       │
│  │ source-state-machine.ts (novo)               │       │
│  │  states: active | degraded | disabled        │       │
│  │  transitions:                                │       │
│  │   active → degraded: 3 failures OR p95>5s    │       │
│  │   degraded → disabled: TLS/DNS change (P0)   │       │
│  │   disabled → active: manual OR 10min healthy │       │
│  └──────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│ CONTENÇÃO                                               │
│                                                         │
│  Routing: split-router.ts filtra sources.state='active' │
│  UI: <SourceStatusBadge/> mostra N/11 active            │
│  Kill-switch: se weight_disabled > 15 → read-only       │
│  Audit: append-only log em Supabase + chain hash        │
└─────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│ ALERTAS (output para Sprint 5C — telegram interactivo) │
│  Por agora: alert.js (já existe) envia Telegram simples │
└─────────────────────────────────────────────────────────┘
```

---

## PROMPT 25 — Baseline TLS/DNS Fingerprint Capture Script

**Context:** Before the H2 watcher (Prompt 27) can detect changes, we need a committed baseline of every endpoint's expected TLS certificate metadata (issuer, subject CN, SAN list) and DNS records (A, AAAA, NS). Without this baseline, the first watcher tick would alert on everything.

The endpoints to monitor are: (a) the 11 aggregator API hosts used by TeraSwap adapters, and (b) `teraswap.app` itself (our own domain). This is a one-off script run manually before H2 goes live, and periodically after legitimate rotations.

**Objective:** Create a script that captures TLS + DNS baseline for all monitored endpoints and writes to a versioned JSON file committed to the repo.

**Requirements:**

1. **Create `scripts/capture-endpoint-baseline.ts`:**
   - Read list of endpoints from a new config file `src/lib/monitored-endpoints.ts` (create it). The config exports:
     ```ts
     export interface MonitoredEndpoint {
       id: string           // e.g., "1inch", "cowswap", "teraswap-self"
       hostname: string     // e.g., "api.1inch.dev"
       expectedIssuerCN?: string  // optional allowlist, e.g., "Let's Encrypt R3"
       critical: boolean    // true for own domain + top aggregators
     }
     export const MONITORED_ENDPOINTS: MonitoredEndpoint[] = [...]
     ```
   - Initial list: `api.1inch.dev`, `api.0x.org`, `api.cow.fi`, `apiv5.paraswap.io`, `aggregator-api.kyberswap.com`, `api.odos.xyz`, `li.quest`, `api.bebop.xyz`, `api.enso.finance`, `app.rango.exchange`, `api.rubic.exchange`, `teraswap.app`. Hostname corrections allowed — the code agent must verify against existing adapters in `src/lib/adapters/`.
   - For each endpoint:
     - TLS: open a TLS connection on port 443 using Node's `tls.connect`, call `socket.getPeerCertificate(true)` for the full chain, extract: `issuer.CN`, `subject.CN`, SAN list from `subjectaltname`, `fingerprint256` (SHA256).
     - DNS: use Node's `dns.promises.resolve4`, `resolve6`, `resolveNs` to capture A, AAAA, NS records.
   - Output: write to `data/endpoint-baseline.json` with this shape:
     ```json
     {
       "generatedAt": "2026-04-14T...",
       "endpoints": {
         "1inch": {
           "hostname": "api.1inch.dev",
           "tls": {
             "issuerCN": "...",
             "subjectCN": "...",
             "san": ["..."],
             "fingerprint256": "AA:BB:..."
           },
           "dns": {
             "a": ["..."],
             "aaaa": ["..."],
             "ns": ["..."]
           }
         }
       }
     }
     ```

2. **Make script idempotent with diff output:**
   - If `data/endpoint-baseline.json` already exists, the script must print a diff of what changed vs the old baseline instead of silently overwriting.
   - User confirmation prompt (`Overwrite baseline? [y/N]`) before writing when diffs are detected.
   - `--force` flag to skip confirmation (for CI/automation later).
   - `--output <path>` flag to write elsewhere (useful for diff testing).

3. **Add npm script:** `"baseline:capture": "tsx scripts/capture-endpoint-baseline.ts"` in `package.json`.

4. **Error handling:**
   - If an endpoint is unreachable, mark it in output with `"unreachable": true` and continue with others. Do NOT fail the whole script.
   - Print summary at end: `X/12 captured, Y unreachable`.

5. **Do NOT:**
   - Do NOT add `data/endpoint-baseline.json` to `.gitignore` — it MUST be committed.
   - Do NOT hardcode endpoints inside the script — read from `MONITORED_ENDPOINTS` config.
   - Do NOT use external libraries beyond Node built-ins (`tls`, `dns`) — keep script dependency-free.

**Files affected:** `scripts/capture-endpoint-baseline.ts` (new), `src/lib/monitored-endpoints.ts` (new), `data/endpoint-baseline.json` (new, committed), `package.json` (new script).

**Expected output:** Running `npm run baseline:capture` produces a committed JSON with TLS fingerprints and DNS records for all 12 endpoints. Re-running shows diff and asks for confirmation.

**Quality criteria:** Script completes in <30s for all endpoints. Output JSON is deterministic (sorted keys, consistent format). Manual verification: fingerprints match `openssl s_client -connect api.1inch.dev:443` output.

---

## PROMPT 26 — Source State Machine + H1 Health Check

**Context:** The executor already has `src/lib/source-monitor.ts` that tracks basic source availability. We extend this into a proper state machine with three states (`active` / `degraded` / `disabled`) and automated transitions based on health check results. This is the foundation that H2 (TLS watcher) and contention routing build on.

The `split-router.ts` currently treats all sources as equal. After this prompt, it must filter by state.

**Objective:** Implement a state machine for source availability, an H1 health check loop that runs continuously, and wire it to existing alerting.

**Requirements:**

1. **Create `src/lib/source-state-machine.ts`:**
   - Export `SourceState = 'active' | 'degraded' | 'disabled'`
   - Export `SourceStatus = { id, state, lastCheckAt, failureCount, latencyP95Ms, disabledReason?, disabledAt? }`
   - Export functions:
     - `getStatus(sourceId): SourceStatus`
     - `getAllStatuses(): SourceStatus[]`
     - `recordHealthCheck(sourceId, result: { ok, latencyMs, error? })` — applies state transitions.
     - `forceDisable(sourceId, reason)` — for manual or H2-triggered disables.
     - `forceActivate(sourceId)` — for manual re-activation.
   - State transition rules:
     - `active → degraded`: 3 consecutive failures OR p95 latency > 5000ms in last 10 checks
     - `degraded → disabled`: 2 additional consecutive failures after degraded (total 5) OR `forceDisable` called
     - `degraded → active`: 3 consecutive successes AND p95 < 2000ms
     - `disabled → active`: ONLY via `forceActivate` (manual) OR auto after 10min if `disabledReason` is non-critical (not P0)
   - Critical (P0) reasons that block auto-recovery: `tls-fingerprint-change`, `dns-record-change`, `kill-switch-triggered`
   - State persistence: in-memory is acceptable for MVP; structure the module so a future upgrade to Supabase-backed state is trivial (single `loadState()/saveState()` boundary).

2. **Create `src/lib/health-check.ts`:**
   - Export `async runHealthCheck(endpoint: MonitoredEndpoint, tlsSocket: TLSSocket | null): Promise<{ ok, latencyMs, tlsCert?, error? }>`
   - For aggregator endpoints: send a minimal quote request (e.g., USDC→USDT, 1 unit) using the existing adapter. Reuse adapter code — do NOT reimplement HTTP.
   - For `teraswap-self`: HEAD request to `https://teraswap.app/` with 5s timeout.
   - **Capture TLS cert metadata on the same connection** (H2 colocalization — auditor refinement #2). If the underlying fetch library exposes the TLSSocket, read `socket.getPeerCertificate(true)` and return in result. If not exposed (likely with `fetch()`), fall back to a separate lightweight `tls.connect` ONLY when the baseline comparison is needed, not every tick.
   - Latency = request start to response end in ms.

3. **Create `src/lib/monitoring-loop.ts`:**
   - Exports `startMonitoring()` that runs every 30s (TLS check) / 60s (full quote check). Run as two staggered intervals.
   - Each tick: iterate all endpoints, call `runHealthCheck`, then `recordHealthCheck` on the state machine.
   - When state transitions to `disabled`, call existing `sendTelegramAlert()` from `contracts/order-engine/executor/alert.js`.
   - Alert format: `🔴 Source disabled: {id} | Reason: {reason} | Last check: {time} | Dashboard: {link}`
   - Graceful handling: if monitoring loop crashes, restart with 5s delay. If it crashes 3× in 1 min, alert and exit (systemd/Vercel cron will restart).

4. **Integrate monitoring into the app:**
   - Next.js API route `src/app/api/monitor/start/route.ts` that boots the loop. Call it from an existing server startup hook OR add a Vercel Cron Job config (prefer cron for reliability).
   - If deploying on Vercel, use `vercel.json` cron entry pointing to an API route that runs one tick. Cron interval = 60s (Vercel free tier minimum). TLS ticks every other minute is acceptable MVP — note this as follow-up for 30s accuracy.

5. **Do NOT:**
   - Do NOT remove or rewrite `source-monitor.ts` — extend it if it has useful existing logic, else leave untouched and deprecate in a separate PR.
   - Do NOT change the public interface of `split-router.ts` yet — Prompt 28 handles routing integration.
   - Do NOT introduce a real database migration — in-memory state is MVP.

**Files affected:** `src/lib/source-state-machine.ts` (new), `src/lib/health-check.ts` (new), `src/lib/monitoring-loop.ts` (new), `src/app/api/monitor/tick/route.ts` (new), `vercel.json` (edit — add cron).

**Expected output:** Monitoring loop runs continuously. Failing sources transition to `degraded` then `disabled` after 5 consecutive failures. Recovery is automatic for non-critical disables after 10min of health.

**Quality criteria:** All state transitions unit-tested. Monitoring loop tested with a mock source that fails then recovers. Alert fires exactly once per state transition (not on every tick). `npm run build` passes.

---

## PROMPT 27 — H2 TLS/DNS Change Detection

**Context:** Prompt 25 captured baselines. Prompt 26 set up the health-check loop. Now we close the loop: when the health check captures a TLS fingerprint that doesn't match the baseline, we treat it as a P0 event and trigger immediate disable with human-in-the-loop alert.

**Objective:** Implement baseline comparison inside the monitoring loop. When TLS or DNS baseline mismatches, immediately disable the source with reason `tls-fingerprint-change` or `dns-record-change`.

**Requirements:**

1. **Create `src/lib/fingerprint-validator.ts`:**
   - Export `loadBaseline(): BaselineFile` — reads `data/endpoint-baseline.json` at startup, caches in memory.
   - Export `validateTLS(endpointId, observedCert): { ok: boolean, reason?: string }`:
     - Rule 1: if `observedCert.issuer.CN` matches `expectedIssuerCN` from monitored-endpoints config AND `subject.CN` includes the expected hostname AND `subjectaltname` includes the hostname → OK (covers Let's Encrypt renewal without false positive).
     - Rule 2: if `fingerprint256` matches baseline exactly → OK.
     - Rule 3: otherwise → FAIL with reason describing the diff (e.g., "Issuer changed: expected 'Let's Encrypt R3', got 'Self-signed'").
   - Export `validateDNS(endpointId, observedRecords): { ok, reason? }`:
     - A/AAAA records: at least one record from baseline must still be present (cloud providers rotate IPs — don't require exact match, require non-empty intersection).
     - NS records: must match baseline exactly (NS changes are always suspicious — if legitimate, update baseline manually).

2. **Integrate into monitoring-loop:**
   - After each health check, if TLS cert is captured, call `validateTLS`. If fails → `forceDisable(sourceId, 'tls-fingerprint-change: ' + reason)`.
   - DNS check runs every 60s (separate lightweight DNS-only tick, no need for full TLS). On mismatch → `forceDisable(sourceId, 'dns-record-change: ' + reason)`.
   - Both trigger P0 alerts (Telegram + formatted with 🚨).

3. **Test cases to cover:**
   - Let's Encrypt renewal (same issuer, new fingerprint, same subject) → MUST pass.
   - Issuer change to unknown CA → MUST fail.
   - Fingerprint change + same issuer → PASS (Rule 1 wins).
   - New A record added to DNS → PASS (intersection non-empty).
   - All A records replaced → FAIL.
   - NS change → FAIL.

4. **Allowlist override:**
   - Some endpoints may legitimately rotate certs/DNS. Add an override file `data/endpoint-baseline-overrides.json` (optional, gitignored for local testing but a sample committed). Format: `{ "1inch": { "ignoreFingerprintMismatch": true } }` for emergency override.
   - Overrides are audit-logged when applied.

5. **Do NOT:**
   - Do NOT auto-update the baseline on mismatch. Baseline updates are ALWAYS manual and reviewed (via `npm run baseline:capture`).
   - Do NOT fire alerts on `unreachable` endpoints — that's H1's responsibility.
   - Do NOT block application startup if baseline file is missing — log warning and skip H2 validation (H1 still runs).

**Files affected:** `src/lib/fingerprint-validator.ts` (new), `src/lib/monitoring-loop.ts` (edit to integrate), test files.

**Expected output:** TLS/DNS mismatches trigger immediate `disabled` state with P0 Telegram alert. Let's Encrypt renewals do NOT trigger false positives.

**Quality criteria:** Unit tests for all 6 test cases above. Integration test simulating the CoW-style DNS hijack (mock NS change on test endpoint) triggers disable within one monitoring tick.

---

## PROMPT 28 — Contenção: Routing Failover + UI Badge

**Context:** With sources transitioning to `disabled` automatically, the routing layer (`split-router.ts`) must respect state and exclude disabled sources from quote requests. Users must see transparent status ("10/11 sources active") without alarm for minor issues, clear warning for significant degradation, and a hard block (read-only mode) if too much capacity is lost.

**Objective:** Wire source state into routing and add a UI component that surfaces source health to users.

**Requirements:**

1. **Modify `src/lib/split-router.ts`:**
   - Before fanning out quote requests, filter sources where `state !== 'active'`.
   - If fewer than 3 sources remain → still execute with what's available but mark the quote response with `degradedRouting: true`.
   - If zero sources remain → return error `{ error: 'ALL_SOURCES_DISABLED', message: '...' }`. The UI handles this (kill-switch state).

2. **Define source weights in `src/lib/monitored-endpoints.ts`:**
   - Extend `MonitoredEndpoint` with `weight: number`.
   - Initial weights (static, Fase 1 per auditor agreement):
     - 1inch, 0x → 3
     - Paraswap, CoW, Odos → 2
     - Kyber, Curve, Balancer, Uniswap, Sushi, Bancor → 1
     - teraswap-self → 0 (not an aggregator, weight only used for thresholds)
   - Export `getDisabledWeight(): number` — sums weights of currently-disabled sources.
   - Export `getCoverageWarningThreshold(): { warning: 8, blocking: 15 }` (static Fase 1).

3. **Create `src/components/SourceStatusBadge.tsx`:**
   - Reads state via new API route `src/app/api/monitor/status/route.ts` (GET → returns all source statuses, cached 10s).
   - Display modes:
     - Healthy (`getDisabledWeight() === 0`): small green dot + "11/11 sources active", no emphasis.
     - Warning (`disabled_weight > 0 && < 8`): amber dot + "N/11 sources active — some paused, quotes still competitive".
     - Degraded (`>= 8 && < 15`): orange + "Several sources unavailable — routing may be less optimal".
     - Blocking (`>= 15`): red + "Swaps temporarily disabled — security investigation in progress".
   - Placement: top of SwapBox component, above the input.
   - Click opens a modal listing each source's current state with timestamp of last state change.

4. **Kill-switch read-only mode:**
   - When blocking threshold hit → SwapBox swap button disables, banner above shows: "⚠️ Swaps temporarily disabled — security investigation in progress. Quotes shown are for reference only. Do NOT copy calldata to other interfaces." (per auditor refinement #1).
   - Quotes continue to render (read-only) for transparency. NO "Copy calldata" buttons visible in this mode — hide them.
   - Banner is dismissible? **NO.** Remains until state machine returns to non-blocking.

5. **Audit trail integration:**
   - Every state transition writes a row to a new Supabase table `source_events`:
     ```sql
     CREATE TABLE source_events (
       id BIGSERIAL PRIMARY KEY,
       ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       source_id TEXT NOT NULL,
       from_state TEXT NOT NULL,
       to_state TEXT NOT NULL,
       reason TEXT,
       trigger_hash TEXT NOT NULL,  -- SHA256 of {ts, source_id, reason}
       chain_prev_hash TEXT NOT NULL,  -- previous row's trigger_hash
       operator TEXT  -- 'auto' or user id for manual overrides
     );
     ```
   - Insert is append-only. Row Level Security (RLS) policy denies UPDATE and DELETE for all roles including service role.
   - Enable point-in-time recovery on Supabase project.
   - `chain_prev_hash` implements the merkle-chain idea from auditor refinement #3 — readers can verify integrity by walking the chain.

6. **Do NOT:**
   - Do NOT expose disabled-reason strings directly to end-users — the reason might leak attack details. Badge shows only state, not reason.
   - Do NOT allow UI to force-activate sources. That's a TeraHash-only action via Telegram bot (Sprint 5C) or direct API with auth.

**Files affected:** `src/lib/split-router.ts` (edit), `src/lib/monitored-endpoints.ts` (edit), `src/components/SourceStatusBadge.tsx` (new), `src/components/SwapBox.tsx` (edit — add badge + kill-switch banner), `src/app/api/monitor/status/route.ts` (new), Supabase migration for `source_events`.

**Expected output:** Disabled sources excluded from routing automatically. UI shows source health transparently. Kill-switch blocks swaps with clear messaging. Every transition audited.

**Quality criteria:** Integration test: disabling 2 sources drops them from routing, quote returns with remaining 9. Disabling enough sources to hit weight 15 triggers read-only UI. Audit log correctly chains via `chain_prev_hash`.

---

## PROMPT 29 — Kill-Switch Global para Ataques Correlacionados

**Context:** Individual source disabling handles isolated failures. But a correlated attack (shared CDN compromised, npm supply-chain, coordinated DNS hijack) can hit multiple sources simultaneously. In that scenario, even cross-checking (H5, Sprint 5B) gives false confidence. The only safe response is to halt all swaps until human review.

**Objective:** Add a global kill-switch that freezes swap execution when ≥3 sources enter critical state within a short window.

**Requirements:**

1. **Extend source-state-machine.ts with global state:**
   - Track `GlobalState = 'normal' | 'kill-switch-active'`.
   - Trigger: if 3 or more sources transition to `disabled` with P0 reason within 5 minutes → set global to `kill-switch-active`. Fire critical Telegram alert.
   - Also trigger: if any source reports `dns-record-change` or `tls-fingerprint-change` for `teraswap-self` (our own domain) → immediate kill-switch, no 3-count threshold.
   - Recovery: `kill-switch-active → normal` ONLY via manual operator action (API route with auth + Telegram bot in Sprint 5C). No auto-recovery.

2. **Routing integration:**
   - When `kill-switch-active`, `split-router.ts` short-circuits all quote requests with `{ error: 'KILL_SWITCH_ACTIVE' }`.
   - Quotes cached within last 30s may still be returned READ-ONLY (for user transparency per auditor refinement #1), but new swaps blocked.

3. **Manual deactivation API:**
   - Route `src/app/api/monitor/kill-switch/deactivate/route.ts` (POST).
   - Auth: requires `ADMIN_API_KEY` env var in request header + operator name in body.
   - Writes audit log event with operator identification.
   - Returns 403 if not authorized, 200 on success.

4. **UI surfacing (integrates with Prompt 28 badge):**
   - Kill-switch active → UI enters read-only mode (Prompt 28 handles this).
   - Additional banner specifically for kill-switch: "⚠️ Global security event detected — all swaps halted pending review. Follow @teraswap on X for updates."

5. **Do NOT:**
   - Do NOT allow the kill-switch to be deactivated from the normal UI. Only via admin API (Sprint 5C adds Telegram bot interface on top).
   - Do NOT auto-reset the 5-minute correlation window if more disables happen — keep extending.

**Files affected:** `src/lib/source-state-machine.ts` (edit), `src/lib/split-router.ts` (edit), `src/app/api/monitor/kill-switch/deactivate/route.ts` (new), `src/components/SwapBox.tsx` (edit banner).

**Expected output:** 3 correlated P0 disables within 5min freeze the entire swap flow. Manual deactivation via authenticated API + audit log. Kill-switch on own domain is instant.

**Quality criteria:** Integration test simulating 3 sources disabled in rapid succession triggers kill-switch. Manual deactivation works with valid key, rejected without. `teraswap-self` P0 triggers instantly.

---

## Definition of Done — Sprint 5A

- [ ] `npm run baseline:capture` produces committed JSON for 12 endpoints
- [ ] Monitoring loop runs every 60s via Vercel cron
- [ ] Failing source transitions to `disabled` within 5 consecutive failures
- [ ] TLS/DNS change detected → immediate P0 disable + Telegram alert
- [ ] Disabled sources excluded from routing (user experiences no errors, just fewer quote options)
- [ ] UI badge visible on SwapBox showing N/11 active
- [ ] Kill-switch triggers read-only mode at weight threshold 15 OR 3 correlated P0 disables OR any teraswap-self change
- [ ] Every state transition written to `source_events` append-only with chain hash
- [ ] Manual kill-switch deactivation possible via authenticated API
- [ ] All tests green, `npm run build` green, deployed to staging for 48h before prod

## Riscos conhecidos e mitigações

| Risco | Mitigação |
|---|---|
| Vercel cron mínimo 60s, auditor queria 30s | MVP a 60s, follow-up para migrar monitoring loop para worker dedicado (Railway/Fly) se necessário |
| Baseline desactualizada causa falsos positivos | Re-correr `baseline:capture` após qualquer mudança legítima conhecida; alertas P0 têm delay de 24h de "grace period" ajustado durante primeira semana |
| State machine in-memory perde-se em restart | Aceite para MVP; Supabase-backed em Sprint 5D se necessário |
| Kill-switch bloqueia durante ataque real = revenue loss | Desejável. Confirmado: falso positivo = 10 users sem source por 5 min. Falso negativo = potencial exposure a calldata maliciosa. Assimetria clara. |

## Próximo passo após Sprint 5A

Sprint 5B — H5 quorum cross-check (detecção semântica) + integração com kill-switch global.

---

## Prompts prontos a enviar ao code agent

1. Prompt 25 — Baseline capture script
2. Prompt 26 — State machine + H1
3. Prompt 27 — H2 TLS/DNS detection
4. Prompt 28 — Contenção + UI badge + audit trail
5. Prompt 29 — Kill-switch global

**Ordem obrigatória — não paralelizar.** Cada prompt depende do anterior estar merged e verde.
