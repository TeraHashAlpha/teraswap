## Feedback — fix/token-sync-cron-landing

**Chain-list source:** `GUARD_CHAINS` (verdicts.ts) and `PIPELINE_CONFIG.chains` (config.ts)
now both derive from `getSupportedChainIds()` (src/lib/chains/registry.ts) — the same source
`catalog-address-guard.test.ts`'s own registry-drift assertion checks. The cron's chain matrix
reads the same list via a new `scripts/token-catalog/list-chains.ts` CLI, so no third copy.

**Merge test:** `writeTrustFixture()` now merges per chain instead of overwriting the whole
`catalog-guard.trust.json`. Proven in `verdicts.test.ts` (5 tests): a chain-8453-scoped write
leaves a chain-42161 fixture byte-identical (sha256 hash of the untouched rows, plus a raw
substring check).

**Five drift decisions (dated 2026-09-12, evidence in commit `061b8d2`):**
| Token | Chain | Decision | Why |
|---|---|---|---|
| sUSD | 1 | REMOVE | CoinGecko delisted entirely; on-chain totalSupply()==0 |
| MV | 1 | REMOVE | Not on CG; zero DEX pairs any chain; no DefiLlama price |
| KITE | 1 | KEEP (exempt) | CG's own API maps this address as kite-2's Avalanche/BSC contract (multichain deploy, curation gap) |
| IDRISS | 8453 | KEEP (exempt) | $304k Aerodrome liquidity + DefiLlama confidence 0.94 clear our own bars |
| KAT "Katana" | 8453 | REMOVE | Ticker collision — real KAT lives only on its own L2; this is a ~$3.4k-liquidity unrelated token |

No blanket exemption — each was independently checked (CoinGecko search/coin API, on-chain
getCode/symbol/decimals/totalSupply, DexScreener, DefiLlama).

**Third, independent bug found during Task 4 dry-run (commit `58f0a05`):** `build.ts` has
emitted `schemaVersion: 2` since `fix/token-search-ranking-squatting` merged, but
`token-catalog-json.test.ts` still asserted `1` — this alone would fail every regen's gate,
regardless of the other two fixes. Fixed the assertion + bumped the 3 committed catalogs'
`schemaVersion` field only (addresses unchanged, verified below).

**Dry-run table (live sources, 2026-09-12, per-chain isolated runs):**
| Chain | Gate result | Counts (committed → live) |
|---|---|---|
| 1 (mainnet) | FAIL — size guard ONLY (1238 > 1000); all other guards (trusted-list/duplicate/decimals/identity) pass | 842 → 1238 (+399/-3/~839) |
| 8453 (Base) | PASS | 259 → 284 (+26/-1/~258) |
| 42161 (Arbitrum) | PASS | 227 → 387–447 (source-count varies run to run; both passed) |

Not committed (per instructions — address sets changed / organic growth, not field-only).

**Address-set hashes (sha256 of sorted lowercase address array, first 16 hex chars):**
| Chain | Before (committed) | After (live dry-run) |
|---|---|---|
| 1 | `1347558b33e91e2d` (842) | `1e0433f986c98319` (1238) |
| 8453 | `7fcad7309e17f5b7` (259) | `d828e1fff1f2d3d2` (284) |
| 42161 | `31b5cd20d65f06aa` (227) | `fddb48f850624af7` (447) |

All three changed (real growth) — none committed.

**Alert path:** No workflow in this repo currently posts to Telegram directly from CI (the
app's `alert-wrapper`/`TELEGRAM_BOT_TOKEN` path is server-side, DB-backed, not invocable from a
stateless matrix job). Followed the existing CI-alerting *pattern* instead
(`monitoring-watchdog.yml`'s webhook-on-failure): a failing chain's job opens (or comments on)
a GitHub issue titled `[token-catalog-guard] chain <id> is failing the gate`, with the first
`[fatal]`/`AssertionError` line + full log + run link — via `gh issue`, no new secret needed.

**Edge case not in the prompt:** the schemaVersion mismatch above.
**Security concern found + fixed in-flight:** the per-chain PR-body diff summary embeds token
*symbols* sourced from external token lists (CoinGecko/Uniswap/1inch — attacker-choosable
strings). Initially spliced via `${{ steps.diff.outputs.summary }}` directly into a `run:`
block; moved through an `env:` var instead before pushing, since a symbol like `"; curl evil #`
would otherwise execute as shell code in the Actions runner.

---

## Feedback — CI-red follow-up (commits `8c1a36f`, `0b78121`)

**CodeQL fix:** `verdicts.test.ts`'s `tmpFixture()` built a temp path by hand under
`os.tmpdir()` (pid + `Math.random()` — guessable, racy). Replaced with
`fs.mkdtempSync(path.join(os.tmpdir(), 'ts-verdicts-'))` (0o700 dir) + `fs.chmodSync(file,
0o600)` after each write. Cleanup is `fs.rmSync(dir, {recursive:true,force:true})` in the
existing `afterEach`.

**Diagnosis table** (`fetchSwapFromSource.test.ts` T1-sim-failed, `zerox-breaker-fanout.test.ts`
T4, plus a **3rd failure not in the original ask**: `fetchSwapFromSource.test.ts`'s "a
successful build..." test):

| Test | Alone / branch | Alone / origin/main (c1e298c) | Full CI-command run |
|---|---|---|---|
| All 3 | ✓ pass, ~4.3–4.9s each | ✓ pass, ~4.3–4.9s each (identical) | ✗ fail, ~5003ms timeout (identical on both branch and main) |

**Root cause (production code, untouched):** `withCircuitBreaker` → `ensureInitialized()` →
`initFromKV()` → `source-state-machine.getAllStatuses()` → a real, unconfigured
`@upstash/redis` client. Its SDK retries 5× with exponential backoff
(`node_modules/@upstash/redis`: `Math.exp(retryCount)*50ms` ≈ 50+136+370+1005+2730 ≈ 4291ms —
matches the observed durations exactly). Both files call `vi.resetModules()` per test, so
every test re-pays this real round trip. Under full-suite CPU contention it tips past vitest's
5000ms default timeout; the abandoned promise resolves later in the background and calls
`recordQuoteBuildAttempt` into the *next* test's mock — that's the "expected 1, got 2".
**Classification: (ii) pre-existing flake**, byte-identical on origin/main, predates this PR
(circuit-breaker's KV pre-seed is P112/M-02).

**Fix:** mocked `@/lib/source-state-machine`'s `getAllStatuses` to resolve `[]` in both files —
behaviorally identical to today's real KV-unavailable fallback, just instant. Real breaker
logic (429 opens it, fan-out filters, stays OPEN) still exercised unmocked. 9 tests: 1ms–493ms
now (was up to 5003ms).

`git diff --stat origin/main -- src/lib/api.ts src/lib/adapters/circuit-breaker.ts` → **empty**.

**Suite summary (exact CI command, `CI=true npx vitest run --reporter=verbose --reporter=json
--outputFile=...`):** `Test Files 279 passed (279)` / `Tests 3971 passed (3971)`. Lint: 94
warnings/0 errors (baseline). Typecheck: clean. HEAD: `0b78121`.
