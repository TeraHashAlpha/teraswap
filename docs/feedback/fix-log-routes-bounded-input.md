## Feedback — fix/log-routes-bounded-input (SEC-3 High, SEC-8 Medium; audit of 2026-11-17 on origin/main 4a4129ef)

Tables (E2 to E4 in full): [`fix-log-routes-bounded-input.tables.md`](fix-log-routes-bounded-input.tables.md).
Commits: 9b4039c8 feedback start · adc845ff log-quote · 51550bf5 monitor/source-health · b0c8df9f body-limit + Step 0 ·
8d4ee961 prototype-name test · 91a5327e and this edit (docs only; the last is the branch head).

### Owner answers (asked once, 2026-11-17; they supersede the goal text)
1. **Body cap:** `bodySizeGuard` stays synchronous (same signature, header check kept) and installs a byte-capped reader;
   routes I may edit answer 413; `orders/route.ts`, `orders/[id]/route.ts`, `log-swap/route.ts` untouched (their reads
   stop at the cap too, they answer their own error); routes that never read a body unchanged.
2. **Size bounds:** symbols ≤ 32 chars; tokenIn, tokenOut, wallet ≤ 64; amounts ≤ 80; allQuotes registry keys only,
   values ≤ 80; responseTimeMs finite or 0. Past the bound or wrong type = absent (dropped required field → 400).
3. **Test mock:** `smismember` + `kvRaw` stubs in `source-health-monitor.test.ts`'s kv mock; no assertion changed.
4. **Red verify outside the diff (asked 2026-11-18):** "Hold, verify once more": wait for the other sessions' runs to
   end, run agent-verify --codeql once more on a quiet machine, push only if green. Done: E5, third run.

### Checklist
- [x] Step 0 (a) (b) fail on origin/main, pass on head · [x] change 1: one list `ADAPTER_SOURCE_NAMES` (derived from
  `ADAPTER_REGISTRY`, 12), `registrySourceNames`, `lib/log-quote-input.ts` · [x] change 2: failures drawn from the
  de-duplicated registry names (≤ 12) · [x] change 3: monitor reads arrays via `registrySourceNames`; one `SMISMEMBER`
  over the 12 names; prune = `SRANDMEMBER 500` (raw text, `kvRaw`) + one `SREM` per run; a sample holds ≤ 12 registry
  names and nothing outside the registry can enter, so each run removes ≥ min(left, 488): 20,300 → 0 in ≤ 42 runs
  (measured 41); bound per run `SOURCE_HEALTH_MAX_KV_COMMANDS` = 3 + 9 × 12 = 111 (alert fan-out excluded) ·
  [x] change 4: findings filtered to registry names before any alert · [x] change 5: `BodyTooLargeError` → 413

### E1. Step 0 on origin/main 4a4129ef (`src/app/api/log-quote/route.step0.test.ts`, Node 22.23.5)
`× one request with 300 invented names causes at most one failure event per registry source` → `expected 300 to be
less than or equal to 12` · `× answers 413, stores nothing and stops reading at the cap` → `expected { status: 200,
quotesStored: 1 } to deeply equal { status: 413, quotesStored: +0 }` · `Tests 2 failed (2)`. Head: 2 passed.

### E2. Auditor's request, before → after (same rig on both trees)
One 4,923-byte request: **300 → 0** inserts. After 68 such requests, monitor run: **121,801 → 2** KV commands, set
**20,300 → 0**; rows aged out: **20,300 → 0** alerts naming an invented name. Deploy day on the old store: ≤ 3 per run.
**Also closed (found here):** on origin/main one stored row naming `__proto__` made `/api/monitor` answer 500 and set
`Object.prototype.quotes = NaN`; `constructor` → 500. Head: 200, pinned by 8d4ee961.

### E3. Routes using body-limit
19 files, 21 handlers, one test each in `src/app/api/body-limit.routes.test.ts`: 14 edited → 413; orders POST,
orders/[id] PATCH, log-swap POST/PATCH stop at the cap, write nothing; log-event, monitor/alerts, monitor/tick read 0 bytes.

### E4. Seeds, mutation proof
Seeds 1, 42, 20261117 × 60 cases (0 to 5,000 entries; > 4,000 reached); fake SRANDMEMBER seed 7. Six mutants, all
killed: **registry filter removed: 13 fail** (property ×3, monitor ×3, source-health ×5, bounds ×2); **cap removed from
the reader: 25 fail** (body-limit ×6, routes ×18, Step 0 (b)); dedupe 3, raw-client prune 2, unfiltered monitor 3,
no 413 mapping 2. Every failing test name: tables E4.

### E5. Verify (Node 22.23.5, CI's version)
- `agent-verify.sh --codeql` @ **b0c8df9f**: PASS · suite 10,914 / 0 failed · lint-delta +0/+0 · tsc 0 · build ok ·
  parity 123 · rpc-budget 36 · CodeQL 13 = 13, 0 new.
- @ **8d4ee961** (+4 tests only): FAIL on suite only, 31 of 10,918, 13 files, **none in this diff**: 30 timeouts
  (28 × 5 s, 60 s, 120 s) + 1 late call from a timed-out test, load average 86 to 91 with two other sessions' `--keeper --codeql` runs. Lint
  +0/+0, tsc 0, build, parity, rpc-budget, CodeQL 13 = 13 PASS. Not re-run to make it green.
- @ **91a5327e** (= 8d4ee961 + docs), owner answer 4, started 01:55 at load 2.1, no other verify running: **PASS** ·
  suite 10,918 / 0 failed · lint-delta +0/+0 · tsc 0 · build ok · parity 123 · rpc-budget 36 · CodeQL 13 = 13, 0 new
  (base origin/main 02487c98). Head after this file: docs only. diff --stat origin/main...HEAD: 30 files, +1,751 −67.
- `gen-claude-state --check`: current. main moved to 02487c98 (#707, #708, #710): no file overlap, `merge-tree` clean;
  the merged result was not run. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/log-routes-bounded-input
- **Not verified:** a live Upstash (SMISMEMBER, SRANDMEMBER count, SREM, `automaticDeserialization: false` ran on a fake
  modelled on @upstash/redis 1.39.0); a chunked body through a real server or Vercel (vitest NextRequest streams only);
  production's set, `quotes` and `security_events` contents; Node 26 suite; keeper (untouched).

### Concerns
- `orders-v3-eligibility-integration.test.ts` (main's, Do-NOT tree) calls `arb1.arbitrum.io`/`mainnet.base.org` under
  fake timers: 2.2 s on Node 22, 5.1 s timeout on Node 26, on origin/main too.
- `monitor/route.usage-not-collected.test.ts` spends 4.3 of its 5 s in Upstash retries; the prune runs alongside the check.
- Pre-fix rows keep invented names in `quotes`/`security_events` (now ignored); old per-name KV keys expire (6 h to 7 d).
- `req.clone()` would read around the cap; no route calls it.

### E6. Secret Scanning on PR #713 (generic-api-key, `body-limit.routes.test.ts:71`, b0c8df9f)
1. **gitleaks 8.30.1, the workflow's range** (`--no-merges --first-parent 64da340a^..7db1bbcc`, `--redact`): before `7 commits scanned … leaks found: 1`
   (fingerprint `b0c8df9f…:src/app/api/body-limit.routes.test.ts:generic-api-key:71`); after the change `7 commits scanned … no leaks found`, and the staged diff alone `no leaks found`.
2. **Tests:** `body-limit.routes.test.ts` 21 passed before, 21 passed after; `SECRET` is now `` `tsbl-${randomUUID()}` ``, no assertion touched. Literal was 44 characters (goal text said 48).
3. **Head:** the PR head the check failed on is 7db1bbcc (local was 1 merge behind, fast-forwarded, no rebase); the commit carrying this block sits directly on it and its SHA is in the run report, a commit cannot name itself.
- **Never a credential:** the value was written by this branch's own first commit of the file (b0c8df9f, `git log -S`), as a test constant; it is only passed to `vi.stubEnv` for six env names inside that test and was never read from an env, vault or provider. Old fingerprint added to `.gitleaksignore` (history is not rewritten).
