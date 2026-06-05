# Auditoria Sprint 16A — P112 (M-02) + P114 (M-03)

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-14
**Scope:** 2 commits no branch `fix/sprint-16a-hardening`
**Baseline:** Sprint 16A P109-P111+P113 APPROVED.
**Commits:**
- `527a12f` — P112: Circuit breaker KV pre-seed on cold start (M-02)
- `066876d` — P114: Supabase least-privilege logger role (M-03)
**Ficheiros:** 12 files, +552/−12 lines
**Testes:** ~623 TS (grep-counted). 8 novos (circuit-breaker) + 7 novos (supabase).

---

## Resumo Executivo

P112 resolve M-02: em cold start (Vercel Lambda), os circuit breakers iniciavam CLOSED e precisavam de ~3 failures (~90s) para detectar uma source já marcada como disabled/degraded no KV. Agora, `initFromKV()` lê o estado persistido de todas as sources via `getAllStatuses()` e pre-abre os breakers para sources não-activas. A init é lazy (primeira chamada a `withCircuitBreaker`), idempotente (shared promise), e fail-safe (KV down → CLOSED default + warn).

P114 resolve M-03: todas as paths de logging fire-and-forget (swaps INSERT, quotes INSERT, security_events, wallet_activity, usage_events) usavam o service-role key, que tem full read/write/delete em todas as tabelas. Agora usam `getSupabaseLogger()`, que cria um client com `SUPABASE_LOGGER_KEY` bound a `logger_role` — uma role PostgreSQL com INSERT-only nas 5 tabelas de logging. O `log-swap PATCH` (UPDATE de swap pendente) mantém o service-role key. Fallback gracioso: quando `SUPABASE_LOGGER_KEY` não está configurado, usa o service-role com warn once.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 3 INFO**

Findings externos M-02 e M-03 correctamente fechados.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | |
| Fund flows alterados? | **Não** | |
| ABI alterado? | **Não** | |
| Novos endpoints? | **Não** | |
| Novos secrets/env vars? | **Sim** | `SUPABASE_LOGGER_KEY` — INSERT-only role key. Documentado em `.env.example`. |
| Dependências adicionadas? | **Não** | |
| Dados sensíveis? | **Não** | Key values em `.env.example` são placeholders (`your-logger-role-key`). |
| Testes: +15 novos | **Sim** | 8 circuit-breaker + 7 supabase. |
| Migration SQL? | **Sim** | `supabase/migrations/20260514_logger_role.sql` — idempotent. |

---

## Findings

### 16A-I-05 — `forceOpen` sets `lastFailureAt = Date.now()` — cooldown timer starts immediately

**Severidade:** INFO
**Ficheiro:** `src/lib/adapters/circuit-breaker.ts` L106
**Descrição:** `forceOpen()` sets `lastFailureAt = Date.now()`, o que inicia o cooldown timer imediatamente. Após `cooldownMs` (default provavelmente 30-60s), o breaker transita para HALF_OPEN e permite um probe request. Isto é semanticamente correcto — queremos que uma source disabled no KV eventualmente seja re-probada. Se o objectivo fosse manter OPEN indefinidamente (até manual re-enable), o `lastFailureAt` deveria ser `Infinity`. No entanto, o source-state-machine já gere re-enables via o monitoring tick, e o HALF_OPEN probe é uma forma saudável de auto-recovery.
**Recomendação:** Nenhuma acção necessária. Comportamento desejado.

### 16A-I-06 — Sequence GRANT cobre todos os public sequences, incluindo non-logging tables

**Severidade:** INFO
**Ficheiro:** `supabase/migrations/20260514_logger_role.sql` L52-62
**Descrição:** O DO block concede `USAGE, SELECT ON SEQUENCE` a **todas** as sequences no schema `public`, incluindo sequences de tabelas não-logging (e.g., `orders_id_seq`, `api_keys_id_seq`). Isto é defensivo (comment: "avoids surprises if a column is later switched") e não constitui data leakage — sequences contêm apenas contadores inteiros, não dados de tabela. `SELECT` numa sequence retorna apenas o último valor do counter. O `logger_role` ainda não pode INSERT/SELECT/UPDATE/DELETE nas tabelas `orders` ou `api_keys`.
**Recomendação:** Aceitar como is. Para máximo rigour, a grant poderia filtrar sequences por tabela-owner, mas o risco é nulo.

### 16A-I-07 — `_resetSupabaseClients` e `resetAllCircuitBreakers` expostos sem prefixo `_`

**Severidade:** INFO
**Ficheiros:** `src/lib/supabase.ts` L93, `src/lib/adapters/circuit-breaker.ts` L153
**Descrição:** `_resetSupabaseClients` tem prefixo `_` (test-only convention) mas `resetAllCircuitBreakers` não — é uma API pública existente pre-P112. Inconsistência estilística menor. Ambas são usadas apenas em testes (verificado via grep).
**Recomendação:** Nenhuma acção necessária. Renomear `resetAllCircuitBreakers` quebraria imports existentes.

---

## Análise Detalhada — P112 (M-02)

### 1. `initFromKV()` — Pre-seed logic

```typescript
export async function initFromKV(): Promise<void> {
  const { getAllStatuses } = await import('@/lib/source-state-machine')
  const statuses = await getAllStatuses()
  for (const status of statuses) {
    if (status.state === 'active') continue
    const cb = getCircuitBreaker(status.id)
    cb.forceOpen(`kv state=${status.state}`)
  }
}
```

**Verificação:**
- Dynamic import evita circular dependency (`circuit-breaker → source-state-machine → monitoring-loop → circuit-breaker`). ✓
- Sources `active` são ignoradas — breaker criado on-demand com default CLOSED na primeira chamada. ✓
- Sources `disabled` e `degraded` → `forceOpen()`. ✓
- KV failure → `catch` → `console.warn` + silently proceed. Breakers ficam CLOSED (default). **Hot path nunca bloqueia.** ✓

### 2. `ensureInitialized()` — Shared promise

```typescript
let initPromise: Promise<void> | null = null
function ensureInitialized(): Promise<void> {
  if (!initPromise) { initPromise = initFromKV() }
  return initPromise
}
```

**Verificação:**
- Lazy: primeira chamada cria a promise. ✓
- Idempotente: chamadas subsequentes retornam a mesma promise. ✓
- Concurrent callers: `Promise.all([withCB('a', ...), withCB('b', ...), withCB('c', ...)])` — todos awaiting a mesma promise → 1 KV read. Testado explicitamente. ✓
- `resetAllCircuitBreakers()` sets `initPromise = null` — permite re-seed em testes. ✓

### 3. `forceOpen()` — CircuitBreaker method

```typescript
forceOpen(reason: string): void {
  this.state = 'OPEN'
  this.consecutiveFailures = this.config.failureThreshold
  this.lastFailureAt = Date.now()
  console.warn(`[CB] ${this.name}: pre-seeded OPEN from KV (${reason})`)
}
```

**Verificação:**
- `consecutiveFailures` set ao threshold → diagnostic info correcta. ✓
- `lastFailureAt = Date.now()` → cooldown timer inicia (HALF_OPEN probe após `cooldownMs`). ✓
- Console warn para ops visibility. ✓

### 4. `withCircuitBreaker` — Pre-seed await

```typescript
export async function withCircuitBreaker<T>(...): Promise<T> {
  await ensureInitialized()  // [P112] — one KV read on cold start
  const cb = getCircuitBreaker(name, config)
  if (cb.isOpen()) { throw ... }
  ...
}
```

**Verificação:**
- Pre-seed await antes do OPEN check garante que cold-start requests vêem o estado persistido. ✓
- Em warm path: `initPromise` já resolved → `await` é no-op (microtask). ✓
- KV down: `initFromKV` catches → promise resolved (never rejected) → `ensureInitialized` returns normally → hot path proceeds com CLOSED defaults. ✓

### 5. Testes P112

| Teste | Verifica | Status |
|-------|----------|--------|
| `pre-seeds breakers to OPEN for disabled` | cowswap disabled → OPEN, 1inch active → CLOSED | ✓ |
| `pre-seeds degraded to OPEN` | balancer degraded → OPEN | ✓ |
| `defaults all to CLOSED on KV failure` | getAllStatuses throws → CLOSED + warn | ✓ |
| `hot path proceeds when KV down` | withCircuitBreaker returns 'ok' + CLOSED | ✓ |
| `OPEN-pre-seeded blocks requests` | withCircuitBreaker rejects for disabled cowswap | ✓ |
| `lazy + idempotent (1 KV read)` | 3 calls → 1 getAllStatuses call | ✓ |
| `shared init promise` | 3 concurrent calls → 1 getAllStatuses call | ✓ |
| `reset clears init cache` | After reset, initFromKV called again | ✓ |

**8 testes.** Cobertura adequada.

---

## Análise Detalhada — P114 (M-03)

### 1. Migration SQL — `logger_role`

**Ficheiro:** `supabase/migrations/20260514_logger_role.sql`

| Check | Status |
|-------|--------|
| `CREATE ROLE logger_role NOLOGIN` (idempotent via `IF NOT EXISTS`) | ✓ |
| `GRANT INSERT ON swaps, quotes, security_events, usage_events, wallet_activity` | ✓ — 5 tabelas |
| **No SELECT on tables** | ✓ — apenas INSERT |
| **No UPDATE on tables** | ✓ |
| **No DELETE on tables** | ✓ |
| `GRANT USAGE, SELECT ON SEQUENCE` (all public sequences) | ✓ — necessário para `nextval()` em serial columns |
| No access to `orders`, `order_executions`, `api_keys`, `trade_events` | ✓ — documentado explicitamente no negative-space comment |
| Idempotent | ✓ — re-running is safe |
| Verification query provided | ✓ — `\du logger_role` + `information_schema.role_table_grants` |

**Avaliação de segurança:** O `logger_role` pode:
- INSERT em 5 tabelas de logging. ✓ (necessário)
- USAGE/SELECT em sequences (counters only — no data leakage). ✓
- **NÃO PODE:** SELECT/UPDATE/DELETE em nenhuma tabela. **NÃO PODE** aceder a `orders`, `api_keys`, `trade_events`, ou qualquer outra tabela fora das 5.

**Blast radius de key leak:** Se `SUPABASE_LOGGER_KEY` for comprometido, o atacante pode apenas inserir rows nas 5 tabelas de logging — sem read, sem modify, sem delete. Comparado com o service-role key (full access a tudo), isto é uma redução massiva de blast radius. ✓

### 2. `getSupabaseLogger()` — Dual client factory

```typescript
export function getSupabaseLogger(): SupabaseClient | null {
  if (_loggerClient) return _loggerClient
  const url = process.env.SUPABASE_URL
  const loggerKey = process.env.SUPABASE_LOGGER_KEY
  if (!url) return null
  if (loggerKey) {
    _loggerClient = createClient(url, loggerKey, { auth: { persistSession: false } })
    return _loggerClient
  }
  // Fallback to service-role + warn once
  if (!_loggerFallbackWarned) {
    console.warn('[supabase] SUPABASE_LOGGER_KEY not set — ...')
    _loggerFallbackWarned = true
  }
  return getSupabase()
}
```

**Verificação:**
- Singleton: `_loggerClient` cached. ✓
- `persistSession: false`: server-side only, no session storage. ✓
- Fallback: quando `SUPABASE_LOGGER_KEY` unset, retorna `getSupabase()` (service-role). ✓
- Warn once: `_loggerFallbackWarned` flag. ✓
- `null` when `SUPABASE_URL` missing: same guard as `getSupabase()`. ✓

### 3. Callers rewired

| Caller | Before | After | Operation | Correct? |
|--------|--------|-------|-----------|----------|
| `security-tracker.ts` L44 | `getSupabase()` | `getSupabaseLogger()` | INSERT security_events | ✓ |
| `wallet-activity-server.ts` L37 | `getSupabase()` | `getSupabaseLogger()` | INSERT wallet_activity | ✓ |
| `log-quote/route.ts` POST L16 | `getSupabase()` | `getSupabaseLogger()` | INSERT quotes | ✓ |
| `log-activity/route.ts` POST L37 | `getSupabase()` | `getSupabaseLogger()` | INSERT usage_events | ✓ |
| `log-swap/route.ts` POST L22 | `getSupabase()` | `getSupabaseLogger()` | INSERT swaps | ✓ |
| `log-swap/route.ts` PATCH L197 | `getSupabase()` | `getSupabase()` (unchanged) | UPDATE swaps | ✓ — logger has no UPDATE |

### 4. `.env.example` documentation

`SUPABASE_LOGGER_KEY` documented with provisioning instructions (Dashboard → Settings → API → Generate new key). ✓

### 5. Test mock update (`log-swap.route.test.ts`)

Mock now exports both `getSupabase` and `getSupabaseLogger` (both pointing to the same mock chain). ✓

### 6. Testes P114

| Teste | Verifica | Status |
|-------|----------|--------|
| `getSupabase creates client with service-role key` | createClient args | ✓ |
| `getSupabase returns null when URL missing` | null + no createClient | ✓ |
| `getSupabaseLogger uses LOGGER_KEY when set` | createClient with logger key | ✓ |
| `falls back to service-role when LOGGER_KEY unset` | same singleton + warn once | ✓ |
| `caches each client as singleton` | 1 createClient call for 2 gets | ✓ |
| `keeps two clients independent` | 2 createClient calls with different keys | ✓ |
| `getSupabaseLogger null when URL missing` | null | ✓ |

**7 testes.** Cobertura adequada.

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| `initFromKV()` reads source-state-machine, OPEN for disabled/degraded | **Confirmado** |
| `ensureInitialized()` shared promise — 1 KV read for concurrent callers | **Confirmado** — tested |
| KV failure → warn + CLOSED default, never blocks | **Confirmado** |
| `resetAllCircuitBreakers()` clears `initPromise` | **Confirmado** |
| Dynamic import avoids circular dependency | **Confirmado** |
| 8 circuit-breaker tests | **Confirmado** |
| Migration creates `logger_role` NOLOGIN with INSERT-only on 5 tables | **Confirmado** |
| `getSupabaseLogger()` uses `SUPABASE_LOGGER_KEY` with warn-once fallback | **Confirmado** |
| 5 fire-and-forget callers rewired to `getSupabaseLogger()` | **Confirmado** |
| `log-swap` PATCH stays on service-role | **Confirmado** — L197 |
| `.env.example` documents `SUPABASE_LOGGER_KEY` | **Confirmado** |
| `logger_role` cannot SELECT/UPDATE/DELETE any table | **Confirmado** — migration + negative-space doc |
| Sequence GRANT is USAGE+SELECT only (counter values, no data) | **Confirmado** |
| 7 supabase client tests | **Confirmado** |
| No sensitive data in diff | **Confirmado** |

---

## Veredicto Final

| Severidade | Count |
|------------|-------|
| CRITICAL   | 0     |
| HIGH       | 0     |
| MEDIUM     | 0     |
| LOW        | 0     |
| INFO       | 3     |

### APPROVED — 0C / 0H / 0M / 0L

P112 fecha correctamente M-02 (circuit breaker KV sync) com pre-seed lazy, idempotente, e fail-safe. P114 fecha correctamente M-03 (Supabase least-privilege) com `logger_role` INSERT-only nas 5 tabelas de logging, dual client factory com fallback gracioso, e o PATCH path correctamente preservado no service-role.

Findings externos fechados: **M-02** ✓, **M-03** ✓.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-14*
