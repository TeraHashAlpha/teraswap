## fix/log-routes-bounded-input — long tables (companion of `fix-log-routes-bounded-input.md`)

### E2. The audit's SEC-3 scenario, before and after (same rig, unchanged, on both trees)
Rig (not committed): the real `POST /api/log-quote` and `GET /api/monitor`, a recording database, the counting fake
Upstash store (`src/test-utils/fake-upstash-kv.ts`), alert fan-out stubbed and counted. 68 requests of 300 invented
names (the last 200), none responded; then monitor runs, the rows leaving the monitor's window after run 1. Node 22.23.5.

| Measure | origin/main 4a4129ef | head |
|---|---|---|
| bytes of the single 300-name request | 4,923 | 4,923 |
| its status | 200 | 200 |
| `security_events` inserts from that one request | **300** | **0** |
| inserts over the 68 requests | 20,300 | 0 |
| invented names stored in quote rows | 20,300 | 0 |
| monitor run 1: KV commands | **121,801** (= the audit's figure) | **2** |
| monitor run 1: known-sources set size | **20,300** | **0** |
| monitor run 2 (rows aged out): KV commands | 60,901 | 2 |
| monitor run 2: alerts, all carrying an invented name | **20,300** | **0** |
| monitor runs 3 to 5: KV commands each, set size | 60,901, 20,300 (never pruned) | 2, 0 |

Deploy day (head only): the fixed monitor over the store exactly as the old code left it (20,300 names in the set, a
known-quoting flag each, 68 polluted rows):

| Measure | head |
|---|---|
| stated bound `SOURCE_HEALTH_MAX_KV_COMMANDS` (3 + 9 × 12) | 111 |
| KV commands per run, max | 3 (SMISMEMBER, SRANDMEMBER, SREM) |
| invented names left after runs 1 to 5 | 19,800 · 19,300 · 18,800 · 18,300 · 17,800 |
| runs until none is left (stated bound: ceil(20,300 / (500 − 12)) = 42) | 41 |
| KV commands over all 41 runs | 123 |
| alerts / alerts with an invented name | 0 / 0 |

### E3. Every route that uses `src/lib/body-limit.ts`
19 route files call `bodySizeGuard` (21 handlers); `dca-floor-cap/route.ts` imports `clientIp` only (GET, no body).
Test: `src/app/api/body-limit.routes.test.ts`, chunked body over the route's cap, no Content-Length, auth supplied.

| Handler | Reads a body | Over-cap chunked body → | Edited here | Test name |
|---|---|---|---|---|
| POST admin/api-keys | yes | 413 | yes | `POST /api/admin/api-keys` |
| POST admin/dca-freeze | yes | 413 | yes | `POST /api/admin/dca-freeze` |
| POST admin/kill-switch | yes | 413 | yes | `POST /api/admin/kill-switch` |
| POST admin/ui-version | yes | 413 | yes | `POST /api/admin/ui-version` |
| POST cow/orders (16 KB cap) | yes | 413 | yes (+ `cow-proxy.ts` readRequestJson) | `POST /api/cow/orders` |
| DELETE cow/orders (16 KB cap) | yes | 413 | yes | `DELETE /api/cow/orders` |
| POST cow/quote (16 KB cap) | yes | 413 | yes | `POST /api/cow/quote` |
| POST log-activity | yes | 413, CORS headers kept | yes | `POST /api/log-activity` |
| POST log-quote | yes | 413 | yes | `POST /api/log-quote`; Step 0 (b) |
| POST monitor/validate-execution | yes | 413 | yes | `POST /api/monitor/validate-execution` |
| POST quote | yes | 413 | yes | `POST /api/quote` |
| POST rpc (256 KB cap) | yes | 413 | yes | `POST /api/rpc` |
| POST telegram/webhook | yes | 413 | yes | `POST /api/telegram/webhook` |
| POST v1/swap | yes | 413 | yes | `POST /api/v1/swap` |
| POST orders | yes | own 500 "Request body too large…", nothing written | no (Do-NOT) | `POST /api/orders answers its own 500 …` |
| PATCH orders/[id] | yes | throws BodyTooLargeError (Next: 500), before any DB call | no (Do-NOT) | `PATCH /api/orders/[id] throws …` |
| POST log-swap | yes | own 200 `{ ok: false }`, nothing written | no (Do-NOT) | `POST /api/log-swap answers its own 200 …` |
| PATCH log-swap | yes | own 200 `{ ok: true }`, nothing updated | no (Do-NOT) | `PATCH /api/log-swap answers its own 200 …` |
| POST log-event | no | 204, 0 bytes taken | no | `POST /api/log-event` |
| POST monitor/alerts | no | 401 (no secret), 0 bytes taken | no | `POST /api/monitor/alerts (no secret configured)` |
| POST monitor/tick | no | 503 (no secret), 0 bytes taken | no | `POST /api/monitor/tick (no secret configured)` |

Each of the 14 edited handlers took more than its cap and at most one 1 KB chunk past it; no handler wrote to the database or fetched upstream.

### E4. Mutation proof (scratch worktree at b0c8df9f, Node 22.23.5; one mutant at a time; 9 test files, 100 tests)
Runner: `mutate.mjs` (session scratchpad). Test files: route.step0, route.sec3 (log-quote), monitor route.sec3, source-health-monitor.sec3, source-health-monitor, body-limit.sec8, body-limit, body-limit.routes, log-routes.hardening.

| Mutant | Change | Result |
|---|---|---|
| M1 registry filter removed | `isAdapterSourceName` accepts any string | KILLED, 13 of 100 fail |
| M2 cap removed from the reader | `if (received > maxBytes)` → `if (false)` | KILLED, 25 of 100 fail |
| M3 de-duplication removed | `registrySourceNames` keeps repeats | KILLED, 3 of 100 fail |
| M4 prune reads through the parsing client | `kvRaw.srandmember` → `kv.srandmember` | KILLED, 2 of 100 fail |
| M5 monitor route reads stored arrays unfiltered | `registrySourceNames(q.sources_queried)` → the raw array | KILLED, 3 of 100 fail |
| M6 log-quote overflow not mapped to 413 | the `bodyTooLargeFrom` lines removed from the catch | KILLED, 2 of 100 fail |

**M1 registry filter removed**, failing tests:
- src/lib/source-health-monitor.sec3.test.ts > recordQuoteDisplayDrop issues no command for a name outside the registry
- src/lib/source-health-monitor.sec3.test.ts > checkSourceHealthAlerts with invented names that would have met every detector reads, writes and alerts on registry sources only, within the command bound
- src/lib/source-health-monitor.sec3.test.ts > checkSourceHealthAlerts with invented names that would have met every detector issues the same number of commands whether the set holds 0 or 5,000 invented names
- src/lib/source-health-monitor.sec3.test.ts > pruneUnregisteredKnownSources removes at most KNOWN_SOURCES_PRUNE_SAMPLE names per run, in two commands, never a registry name
- src/lib/source-health-monitor.sec3.test.ts > pruneUnregisteredKnownSources removes members whose text the parsing client would change ("true", "\"x\"", " 7", "{\"a\": 1}")
- src/app/api/monitor/route.sec3.test.ts > GET /api/monitor over 20,000 invented names (SEC-3) stays under the stated command bound on every run and prunes the set to zero, faster than the stated rate
- src/app/api/monitor/route.sec3.test.ts > GET /api/monitor over 20,000 invented names (SEC-3) reports, records and alerts on registry sources only
- src/app/api/monitor/route.sec3.test.ts > GET /api/monitor over 20,000 invented names (SEC-3) a silent registry source still alerts (its known-quoting flag and set membership are read)
- src/app/api/log-quote/route.sec3.test.ts > property (seeded): invented, repeated and non-string source names seed 1: <= one failure event per registry source, registry names only, status as before
- src/app/api/log-quote/route.sec3.test.ts > property (seeded): invented, repeated and non-string source names seed 42: <= one failure event per registry source, registry names only, status as before
- src/app/api/log-quote/route.sec3.test.ts > property (seeded): invented, repeated and non-string source names seed 20261117: <= one failure event per registry source, registry names only, status as before
- src/app/api/log-quote/route.sec3.test.ts > size bounds (owner answer 2026-11-17): past the bound or the wrong type = absent keeps allQuotes entries for registry names only, values up to 80 characters, never touching a prototype
- src/app/api/log-quote/route.sec3.test.ts > size bounds (owner answer 2026-11-17): past the bound or the wrong type = absent stores null for a non-object allQuotes, 0 for a non-numeric responseTimeMs, null for an invented bestSource

**M2 cap removed from the reader**, failing tests:
- src/lib/body-limit.sec8.test.ts > bodySizeGuard: reads stop at the cap whatever the headers say chunked, no Content-Length, 778 KB: the read fails with BodyTooLargeError after at most one chunk past the cap
- src/lib/body-limit.sec8.test.ts > bodySizeGuard: reads stop at the cap whatever the headers say no Content-Length, plain body over the cap: json() fails with BodyTooLargeError
- src/lib/body-limit.sec8.test.ts > bodySizeGuard: reads stop at the cap whatever the headers say Content-Length smaller than the body: the header is not believed
- src/lib/body-limit.sec8.test.ts > bodySizeGuard: reads stop at the cap whatever the headers say one byte over the cap: refused
- src/lib/body-limit.sec8.test.ts > bodySizeGuard: reads stop at the cap whatever the headers say one byte over the cap in a single chunk: refused
- src/lib/body-limit.sec8.test.ts > bodySizeGuard: reads stop at the cap whatever the headers say reading req.body directly stops at the cap too
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/admin/api-keys
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/admin/dca-freeze
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/admin/kill-switch
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/admin/ui-version
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/cow/orders
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 DELETE /api/cow/orders
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/cow/quote
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/log-activity
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/log-quote
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/monitor/validate-execution
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/quote
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/rpc
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/telegram/webhook
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/v1/swap
- src/app/api/body-limit.routes.test.ts > routes outside this branch (orders/**, log-swap): the read stops at the cap and nothing is written POST /api/orders answers its own 500 with the size error
- src/app/api/body-limit.routes.test.ts > routes outside this branch (orders/**, log-swap): the read stops at the cap and nothing is written PATCH /api/orders/[id] throws BodyTooLargeError (Next answers 500), before any database call
- src/app/api/body-limit.routes.test.ts > routes outside this branch (orders/**, log-swap): the read stops at the cap and nothing is written POST /api/log-swap answers its own 200 { ok: false } and logs nothing
- src/app/api/body-limit.routes.test.ts > routes outside this branch (orders/**, log-swap): the read stops at the cap and nothing is written PATCH /api/log-swap answers its own 200 { ok: true } and updates nothing
- src/app/api/log-quote/route.step0.test.ts > Step 0 (b), SEC-8: chunked body over the cap, no Content-Length answers 413, stores nothing and stops reading at the cap

**M3 de-duplication removed**, failing tests:
- src/app/api/log-quote/route.sec3.test.ts > property (seeded): invented, repeated and non-string source names seed 1: <= one failure event per registry source, registry names only, status as before
- src/app/api/log-quote/route.sec3.test.ts > property (seeded): invented, repeated and non-string source names seed 42: <= one failure event per registry source, registry names only, status as before
- src/app/api/log-quote/route.sec3.test.ts > property (seeded): invented, repeated and non-string source names seed 20261117: <= one failure event per registry source, registry names only, status as before

**M4 prune reads through the parsing client**, failing tests:
- src/lib/source-health-monitor.sec3.test.ts > pruneUnregisteredKnownSources removes members whose text the parsing client would change ("true", "\"x\"", " 7", "{\"a\": 1}")
- src/app/api/monitor/route.sec3.test.ts > GET /api/monitor over 20,000 invented names (SEC-3) stays under the stated command bound on every run and prunes the set to zero, faster than the stated rate

**M5 monitor route reads stored arrays unfiltered**, failing tests:
- src/app/api/monitor/route.sec3.test.ts > GET /api/monitor over 20,000 invented names (SEC-3) stays under the stated command bound on every run and prunes the set to zero, faster than the stated rate
- src/app/api/monitor/route.sec3.test.ts > GET /api/monitor over 20,000 invented names (SEC-3) reports, records and alerts on registry sources only
- src/app/api/monitor/route.sec3.test.ts > GET /api/monitor over 20,000 invented names (SEC-3) a silent registry source still alerts (its known-quoting flag and set membership are read)

**M6 log-quote overflow not mapped to 413**, failing tests:
- src/app/api/body-limit.routes.test.ts > routes this branch edits: a chunked over-cap body answers 413 POST /api/log-quote
- src/app/api/log-quote/route.step0.test.ts > Step 0 (b), SEC-8: chunked body over the cap, no Content-Length answers 413, stores nothing and stops reading at the cap

Not killed by Step 0 (a) alone under M1: the per-request cap at the registry size still holds the event count at 12; the property test (stored arrays registry-only) and the monitor tests catch it.
M5 plus the test added in 8d4ee961 (`stored row naming an Object.prototype key`): all 4 cases fail under M5, pass on head.
