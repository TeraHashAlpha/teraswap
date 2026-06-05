# Audit Report — Sprint 36 (Quote Rate Limit Relief)

| Field | Value |
|---|---|
| **Sprint** | 36 |
| **Branch** | `perf/sprint-36-quote-ratelimit-relief` |
| **Commits** | 4 (`30f5168`, `71c9b9a`, `41c0c77`, `e061c1b`) |
| **Prompts** | P187–P190 |
| **Auditor** | Claude (Senior Security Auditor) |
| **Date** | 2026-05-28 |
| **Verdict** | **APPROVED — 0C / 0H / 0M / 0L / 3 INFO** |

---

## Scope

Quote rate limit relief: raise outbound rate limit constants (quoteLimiter 3→6/10s, globalLimiter 30→120/60s), add 3s TTL in-memory quote cache with integration into `fetchMetaQuote()`, 14 new tests, and ADR index gap fix. 7 files changed (excluding lockfile), +422 lines. Zero contract/fund-flow changes.

### Files in diff

| File | Change | Prompt |
|---|---|---|
| `src/lib/rate-limiter.ts` | Modified (2 constants + comments) | P187 |
| `src/lib/quote-cache.ts` | **NEW** (78 lines) | P188 |
| `src/lib/api.ts` | Modified (+17/-2 lines) | P188 |
| `__tests__/lib/quote-cache.test.ts` | **NEW** (114 lines, 8 tests) | P189 |
| `__tests__/lib/rate-limiter.test.ts` | **NEW** (73 lines, 6 tests) | P189 |
| `vitest.config.ts` | Modified (include pattern) | P189 |
| `ARCHITECT-INDEX.md` | **NEW** (138 lines, replaces Sprint 35 version) | P190 |

---

## P187 — Raise outbound rate limits (`30f5168`)

### Checklist

| Check | Result |
|---|---|
| `quoteLimiter`: `maxRequests: 6, windowMs: 10_000` | ✅ Was 3/10s, now 6/10s |
| `globalLimiter`: `maxRequests: 120, windowMs: 60_000` | ✅ Was 30/60s, now 120/60s |
| `priceLimiter` UNCHANGED: `maxRequests: 10, windowMs: 30_000` | ✅ Verified — not in diff |
| `kv-rate-limiter.ts` UNTOUCHED (incoming IP limits) | ✅ Zero diff |
| Comments updated to reflect new values | ✅ P187 reference in comments |
| No other files changed | ✅ Only `rate-limiter.ts` in P187 commit |

### Security assessment

Os limites alterados são **outbound** (chamadas que o TeraSwap faz a APIs externas), NÃO **inbound** (protecção contra abuso por IP). A distinção é crítica:

- **Inbound** (`kv-rate-limiter.ts`): 30/min para quote, 20/min para swap, 300/min para RPC — **inalterados**.
- **Outbound** (`rate-limiter.ts`): auto-imposto para não sobrecarregar upstream APIs.

As novas capacidades outbound são conservadoras face aos limites reais das APIs upstream:
- 6/10s per-adapter = 36/min. 1inch permite 100/min, 0x permite 120/min. Margem de 2.8–3.3x.
- 120/min global suporta ~10 full multi-source quotes/min (10 × 11 = 110). Adequado para uso normal + auto-refresh.

O circuit breaker (`[CB-01]`) permanece activo como protecção adicional contra upstream failures.

**Verdict:** Conforme.

---

## P188 — Server-side quote cache (`71c9b9a`)

### `src/lib/quote-cache.ts` — New module (78 lines)

| Check | Result |
|---|---|
| `TTL_MS = 3_000` (3 seconds) | ✅ |
| `MAX_ENTRIES = 200` (bounded) | ✅ |
| Cache key includes `src` (lowercase) | ✅ |
| Cache key includes `dst` (lowercase) | ✅ |
| Cache key includes `amount` | ✅ |
| Cache key includes `srcDecimals` | ✅ (beyond spec — better) |
| Cache key includes `dstDecimals` | ✅ (beyond spec — better) |
| Cache key includes `excludeSources` (sorted, lowercase) | ✅ `[...excludeSources].map(s => s.toLowerCase()).sort().join(',')` |
| `getQuote()` returns `undefined` on miss | ✅ |
| `getQuote()` returns `undefined` on TTL expiry | ✅ `entry.expiresAt <= Date.now()` — deletes and returns undefined |
| `setQuote()` evicts oldest when at max size | ✅ `cache.keys().next().value` — FIFO via Map insertion order |
| In-memory only (no Redis/KV) | ✅ Plain `Map<string, Entry>` |
| No user-specific data in cache key | ✅ Key is pair+amount+decimals+excludes only |
| `clearQuoteCache()` for tests | ✅ |
| `quoteCacheSize()` for tests | ✅ |
| Constants exported for tests | ✅ `QUOTE_CACHE_TTL_MS`, `QUOTE_CACHE_MAX_ENTRIES` |

### `src/lib/api.ts` — Integration

| Check | Result |
|---|---|
| Cache check happens BEFORE `globalLimiter.allow()` | ✅ Lines 47-49 (cache), then line 52 (rate limit) |
| Cache hit returns immediately (zero upstream calls, no rate limit burn) | ✅ `if (cached) return cached` |
| Cache set on outlier-detection branch (filtered.length > 0) | ✅ Line 194 |
| Cache set on fallback branch (no outlier detection) | ✅ Line 205 |
| Error responses NOT cached (quotes.length === 0 → throws) | ✅ Lines 118-131 throw before any `setCachedQuote` |
| Rate limit error NOT cached (throws before `setCachedQuote`) | ✅ Line 53 throws before cache set |
| `cacheKey` computed with all params including `excludeSources` | ✅ Line 47 passes full parameter set |

### Security-critical analysis

**1. Cache key collision safety:**

A chave `${src}|${dst}|${amount}|${srcDecimals}|${dstDecimals}|${exclude}` inclui todos os parâmetros que afectam o resultado. Duas queries com o mesmo par mas `excludeSources` diferentes produzem keys diferentes:
- `0xeee...|0xa0b...|1000|18|6|` (sem exclusões)
- `0xeee...|0xa0b...|1000|18|6|cow` (CoW excluído)

A inclusão de `srcDecimals` e `dstDecimals` vai além do sprint packet — correctamente, porque decimals diferentes produzem amounts diferentes nas respostas upstream.

**2. Nenhum dado user-specific na cache:**

A cache é keyed por par+amount+decimals+excludes. Não inclui IP, session, ou qualquer identificador de utilizador. Isto é correcto: quotes são idênticos para todos os utilizadores (o preço de mercado ETH→USDC é o mesmo para todos). Nenhum dado PII é cacheado.

**3. TTL garante freshness:**

3 segundos é conservador para DeFi (block time ~12s). O `expiresAt = Date.now() + TTL_MS` é avaliado em cada `getQuote()` — entries expiradas são deletadas imediatamente no access.

**4. Memory bound:**

`MAX_ENTRIES = 200` com entries de ~2-5 KB = 400 KB-1 MB máximo. Negligível para uma Lambda com 1 GB+ de heap. A eviction é FIFO via `Map.keys().next().value` — O(1), mais eficiente que o scan LRU do rate limiter.

**5. Cache antes do rate limiter:**

O sprint packet inicialmente pediu cache DEPOIS do rate limiter, depois corrigiu para ANTES. A implementação segue a correcção: cache hit = zero tokens consumidos do rate limiter. Isto é o comportamento correcto — cache hits não devem penalizar o budget de outbound requests.

**Verdict:** Conforme. Implementação sólida com protecções correctas.

---

## P189 — Tests (`41c0c77`) — 14 new tests

### `__tests__/lib/quote-cache.test.ts` — 8 tests

| Test | Coverage | Verdict |
|---|---|---|
| Cache hit returns result | ✅ `toBe(result)` — reference equality | |
| Cache miss returns undefined | ✅ | |
| TTL expiry (advance by TTL+1ms) | ✅ `vi.advanceTimersByTime(QUOTE_CACHE_TTL_MS + 1)` | |
| Within TTL window (advance by TTL-1ms) | ✅ | |
| Stable key with sorted excludeSources | ✅ Tests `['CoW', '0x']` === `['0x', 'CoW']` === `['0X', 'cow']` | |
| Different keys are independent | ✅ Different amounts, verify separate retrieval | |
| clearQuoteCache drops all | ✅ Size check before and after | |
| Max size eviction | ✅ Insert 200, verify size, insert 201st, verify oldest evicted | |

**Observação positiva:** O teste de `excludeSources` sorting (line 83-89) verifica case-insensitivity e order-independence com 3 variações — cobre o edge case onde o frontend envia sources em ordem diferente.

### `__tests__/lib/rate-limiter.test.ts` — 6 tests

| Test | Coverage | Verdict |
|---|---|---|
| quoteLimiter allows 6, blocks 7th | ✅ Asserts NEW value (6), not old (3) | |
| globalLimiter allows 120, blocks 121st | ✅ Asserts NEW value (120), not old (30) | |
| Window reset after windowMs | ✅ `vi.advanceTimersByTime(1001)` | |
| Per-key isolation | ✅ Key 'a' exhausted, key 'b' still available | |
| remaining() accuracy | ✅ `maxRequests: 3`, allow 1, remaining returns 2 | |
| reset() clears all | ✅ Exhaust both keys, reset, both available | |

### `vitest.config.ts` change

A `include` pattern foi expandida de `['src/**/*.test.ts', 'src/**/*.test.tsx']` para incluir `'__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'`. Isto é necessário porque os novos testes estão em `__tests__/` (fora de `src/`).

| Check | Result |
|---|---|
| Existing `src/**/*.test.ts` pattern preserved | ✅ |
| New `__tests__/**/*.test.ts` pattern added | ✅ |
| No other vitest config changes | ✅ |

**Verdict:** Conforme. Cobertura completa dos paths de segurança.

---

## P190 — ADR index fix (`e061c1b`)

### Checklist

| Check | Result |
|---|---|
| ADR-006 row added with Markdown link | ✅ `[ADR-006](docs/ADR/ADR-006-positive-slippage-sharing.md)` |
| ADR-007 row added with Markdown link | ✅ `[ADR-007](docs/ADR/ADR-007-morpho-vault-curator.md)` |
| ADR-008 row now has Markdown link | ✅ `[ADR-008](docs/ADR/ADR-008-wagmi-v3-migration.md)` — was plain text |
| No gaps from ADR-005 to ADR-008 | ✅ Contiguous: 005, 006, 007, 008 |
| No ADR files modified | ✅ Zero diff in `docs/ADR/` |
| ADR-006 description includes status date | ✅ `Proposed (2026-05-12)` |
| ADR-007 description includes status date | ✅ `Proposed (2026-05-18)` |

**Note:** P190 creates a fresh `ARCHITECT-INDEX.md` (138 lines) rather than editing the Sprint 35 version (136 lines). Both branches create this file as NEW (it didn't exist on `main` before Sprint 35). The Sprint 36 version incorporates the ADR-006/007 additions and ADR-008 link fix.

**Verdict:** Conforme. 35-I-03 finding fechado.

---

## Negative checks

| Check | Result |
|---|---|
| `kv-rate-limiter.ts` UNTOUCHED | ✅ Zero diff — incoming IP limits preserved |
| `priceLimiter` UNCHANGED (10/30s) | ✅ Not in diff |
| No frontend code changes (useQuote, SwapBox, etc.) | ✅ Zero frontend diff |
| No Redis/KV used for cache | ✅ In-memory `Map` only |
| No ADR files modified | ✅ Zero diff in `docs/ADR/` |
| No contract/fund-flow changes | ✅ |
| No new npm dependencies | ✅ |
| No `package.json` changes | ✅ |
| No hardcoded secrets | ✅ |
| No new `NEXT_PUBLIC_` env vars | ✅ |
| No changes to swap execution paths | ✅ Cache only affects quote fetching |

## Security-specific verification

| Check | Result |
|---|---|
| Cache does NOT serve stale data across different excludeSources | ✅ `excludeSources` included in key, sorted + lowercased for stability |
| Cache does NOT serve data beyond TTL | ✅ `entry.expiresAt <= Date.now()` checked on every `getQuote()` call |
| Cache does NOT leak user-specific data | ✅ Key is pair+amount+decimals+excludes only — no IP, session, or user ID |
| Error responses NOT cached | ✅ `quotes.length === 0` throws before `setCachedQuote` |
| Rate limit errors NOT cached | ✅ `globalLimiter.allow()` throws before `setCachedQuote` |
| Incoming IP rate limits unchanged | ✅ `kv-rate-limiter.ts` has zero diff |

---

## Findings

### 36-I-01 — Cache eviction is FIFO, not TTL-aware on overflow (INFO)

**Ficheiro:** `src/lib/quote-cache.ts:64-66`

Quando o cache atinge `MAX_ENTRIES` e um novo entry é inserido, a eviction usa `cache.keys().next().value` — o entry mais antigo por ordem de inserção (FIFO via `Map` insertion order), independentemente de quanto tempo falta para expirar.

Cenário teórico: com `MAX_ENTRIES = 200` e TTL de 3s, se o sistema receber >200 quotes distintos em <3s (66+ quotes/s), entries com TTL válido podem ser evicted prematuramente.

**Risco real:** Negligível. A 120 req/min global limit, o throughput máximo é 2 req/s. Atingir 200 cache entries distintas simultâneas requer 200 combinações únicas de par+amount em <3s — irreal em uso normal. E se acontecer, a consequência é apenas um cache miss (re-fetch ao upstream), não perda de dados.

**Comparação:** O sprint packet original sugeria uma eviction com TTL-aware pruning seguida de oldest-first. A implementação simplificou para FIFO puro, que é correcta dado o constraint de MAX_ENTRIES=200 × TTL=3s.

**Severidade:** INFO — simplificação aceitável.

---

### 36-I-02 — Test directory convention change (`__tests__/` vs `src/`) (INFO)

**Ficheiro:** `vitest.config.ts`

Os novos testes estão em `__tests__/lib/` em vez de ao lado dos source files em `src/lib/`. Isto diverge da convenção existente (testes em `src/**/*.test.ts` como `src/lib/validation.test.ts`, `src/lib/api-auth.test.ts`, etc.).

A alteração ao `vitest.config.ts` include pattern garante que ambas as localizações são detectadas, mas cria duas convenções de organização de testes no projecto.

**Recomendação:** Decidir uma convenção (colocalização em `src/` ou separação em `__tests__/`) e aplicar consistentemente. A funcionalidade não é afectada.

**Severidade:** INFO — inconsistência organizacional, sem impacto de segurança.

---

### 36-I-03 — Excelente design de cache key com parâmetros extras (INFO)

**Ficheiro:** `src/lib/quote-cache.ts:37-49`

**Observação positiva:** A cache key inclui `srcDecimals` e `dstDecimals` além do que o sprint packet especificava (`src:dst:amount`). Isto é defense-in-depth correcta: o mesmo par ETH→USDC com `dstDecimals=6` vs `dstDecimals=18` produz resultados diferentes nos upstream APIs. Sem estes campos na key, o cache serviria dados incorrectos para tokens com decimals não-standard.

Adicionalmente, o `excludeSources` sorting com case-insensitivity (`[...excludeSources].map(s => s.toLowerCase()).sort().join(',')`) garante que `['CoW', '0x']` e `['0x', 'cow']` produzem a mesma key — eliminando uma classe inteira de cache misses desnecessários.

**Severidade:** INFO — nota de reconhecimento.

---

## Verdict

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| Low | 0 | — |
| Info | 3 | 36-I-01, 36-I-02, 36-I-03 |

**APPROVED — 0C / 0H / 0M / 0L / 3 INFO**

Sprint 36 alivia o rate limiting de quotes sem comprometer segurança. Os limites inbound (IP-based, `kv-rate-limiter.ts`) estão **inalterados** — apenas os limites outbound auto-impostos foram relaxados para matchar a capacidade real das APIs upstream. A quote cache é in-memory, bounded (200 entries), com TTL de 3s, keyed por todos os parâmetros relevantes incluindo `excludeSources` e decimals. Erros nunca são cacheados. Nenhum dado user-specific é incluído na cache key. Os 14 novos testes cobrem TTL expiry, max size eviction, key stability, e os novos valores dos rate limiters. Zero alterações a contratos, fund flows, frontend, ou limites inbound. Seguro para produção.

### Test count

| File | Tests | Source file |
|---|---|---|
| `quote-cache.test.ts` | 8 | `quote-cache.ts` (78 lines) |
| `rate-limiter.test.ts` | 6 | `rate-limiter.ts` (existing) |
| **Total new** | **14** | |
| **Running total** | **1122** | (1108 baseline + 14 new) |
