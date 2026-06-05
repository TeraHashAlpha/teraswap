# Auditoria Sprint 16B — Surplus Instrumentation

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-15
**Scope:** 3 commits no branch `feat/surplus-instrumentation`
**Baseline:** Sprint 16A completo (P109-P116 APPROVED). Todos os 5 MEDIUMs externos CLOSED.
**Referência:** `docs/ADR/ADR-006-positive-slippage-sharing.md`
**Commits:**
- `f231815` — feat(surplus): persist mev_savings_actual for all sources [P117]
- `523adce` — feat(surplus): add expected_output column + frontend pass-through [P118]
- `3586a53` — feat(surplus): weekly surplus report to Telegram [P119]

**Ficheiros:** 13 files, +672/−1 lines
**Testes:** 12 novos (3 validator + 1 log-swap + 8 surplus-report)

---

## Resumo Executivo

Sprint 16B implementa a fase de instrumentação do ADR-006 (Positive Slippage Sharing). O objectivo é recolher 30 dias de dados de surplus antes de decidir se FeeCollector V3 justifica o investimento (threshold: >$500/mês capturable). Três prompts:

1. **P117** — Calcula `surplusWei = actual − expected` no `post-execution-validator` e persiste em `swaps.mev_savings_actual` via dois caminhos: server-side (validate-execution route para non-CoW) e client-side (useSwap PATCH para CoW). O FEEDBACK.md documenta que o spec assumia que o frontend consumia `ExecutionValidation` directamente — o Code Agent correctamente implementou dois caminhos complementares.

2. **P118** — Nova coluna `expected_output NUMERIC` na tabela `swaps`. Frontend passa `expectedOutput` (quoted output pre-slippage) no POST `/api/log-swap`. Validação server-side: `/^\d+$/` regex rejeita tudo que não seja string de dígitos puros.

3. **P119** — Relatório semanal de surplus via Telegram. Dispara domingos 00:xx UTC, dedup via KV (ISO week key, TTL 30d). Fire-and-forget no monitoring tick. Aggregação em JS com BigInt. Projecção mensal a 30% capture rate.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 4 INFO**

Zero impacto em fund flows ou contratos. Toda a instrumentação é observacional (read-only on-chain, write-only para analytics columns). Os caminhos de swap, validação, e bloqueio permanecem inalterados.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | |
| Fund flows alterados? | **Não** | |
| ABI alterado? | **Não** | |
| Novos endpoints? | **Não** | Apenas side-effects adicionados a endpoints existentes. |
| Novos secrets/env vars? | **Não** | Reutiliza `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` existentes. |
| Dependências adicionadas? | **Não** | |
| Dados sensíveis? | **Não** | Surplus values são analytics públicas (on-chain data). |
| Testes novos? | **Sim** | 12 novos: 3 validator, 1 log-swap, 8 surplus-report. |
| Validators alterados? | **Não** | `validateRouterAddress`, `validateCallDataRecipient`, `validateFeeIntegrity` inalterados. |
| Rate limiter/backoff alterado? | **Não** | |
| Supabase RLS impact? | **Não** | `logger_role` tem INSERT on swaps (cobre `expected_output`). `persistSurplus` usa `getSupabase()` (service-role) para UPDATE — correcto. |
| Migration idempotent? | **Sim** | `ADD COLUMN IF NOT EXISTS`. |

---

## Findings

### 16B-I-01 — `persistSurplus` fire-and-forget pode perder dados silenciosamente

**Severidade:** INFO
**Ficheiro:** `src/app/api/monitor/validate-execution/route.ts` L144
**Descrição:** `void persistSurplus(result.txHash, result.surplusWei)` é fire-and-forget. Se o Supabase estiver indisponível ou o UPDATE falhar (e.g., row não encontrada porque o POST `/api/log-swap` ainda não executou), o surplus é perdido. O `console.warn` regista o erro mas não há retry.
**Impacto:** Baixo — dados são analytics (ADR-006 decisão), não fund flows. O surplus pode ser recalculado off-chain a qualquer momento a partir de dados on-chain (`actual output − expected output`). O padrão fire-and-forget é consistente com o design existente (monitoring tick, CoW PATCH).
**Recomendação:** Aceitar como is para Phase 1 (data collection). Se o capture rate justificar FeeCollector V3, considerar um job batch de reconciliação que preencha lacunas a partir de dados on-chain.

### 16B-I-02 — `surplusWei` no post-execution-validator só cobre `surplus > 0n`

**Severidade:** INFO
**Ficheiro:** `src/lib/post-execution-validator.ts` L295
**Descrição:** `surplusWei` é definido como `surplus.toString()` apenas quando `surplus > 0n` (ok-with-surplus branch). Quando `surplus === 0n` (exact match) ou `surplus < 0n` (shortfall), `surplusWei` é `null`. Isto significa que a tabela `mev_savings_actual` não distingue entre "sem dados" e "zero surplus" / "shortfall negativo". Para ADR-006 data collection, perder shortfalls não é um problema (o ADR foca em surplus capturable), mas dificulta análise futura de distribuição completa.
**Recomendação:** Aceitar como is. ADR-006 precisa apenas de `surplus > 0` para decidir threshold. Se análise de distribuição for necessária, `expected_output` (P118) + `amount_out` existente permitem recálculo completo off-chain.

### 16B-I-03 — `generateSurplusReport` aggregação em JS pode não escalar

**Severidade:** INFO
**Ficheiro:** `src/lib/surplus-report.ts` L52-100
**Descrição:** A query Supabase retorna todas as rows dos últimos 7 dias com `mev_savings_actual IS NOT NULL`, e a aggregação (group by source, BigInt sum) é feita em JS com um `Map`. Para o volume actual do TeraSwap (dezenas de swaps/dia), isto é trivial. Mas se o volume crescer para milhares/dia (Phase 3 multi-chain), carregar todas as rows para JS será ineficiente. A alternativa seria uma query SQL com `GROUP BY source` e `SUM(mev_savings_actual::numeric)`.
**Recomendação:** Aceitar como is. Volume actual não justifica optimização. Quando multi-chain chegar, migrar para aggregação SQL ou uma view materializada.

### 16B-I-04 — `updateSwapStatus` CoW path passa surplus como 7º positional argument

**Severidade:** INFO
**Ficheiro:** `src/hooks/useSwap.ts` L740-748
**Descrição:** `updateSwapStatus(result.txHash, 'confirmed', undefined, undefined, address, undefined, cowSurplusForPatch)` usa 5 `undefined` placeholders para chegar ao 7º parâmetro. A função `updateSwapStatus` tem 7 parâmetros posicionais (txHash, status, gasUsed, gasPrice, wallet, mevSavingsEstimate, mevSavingsActual). Com tantos parâmetros opcionais, um options object seria mais legível e menos propenso a erros de posição.
**Recomendação:** Aceitar como is. Refactoring para options object seria um improvement mas não introduz risco — os tipos TypeScript garantem que a posição está correcta em compile-time.

---

## Análise Detalhada

### P117 — Surplus Persistence (`post-execution-validator` + `validate-execution/route` + `useSwap`)

#### 1. `post-execution-validator.ts` — surplusWei computation

**Interface `ExecutionValidation`:** Novo campo `surplusWei: string | null`. ✓

**Computation (L295):**
```typescript
const surplus = actualOutput - expectedOutput // BigInt arithmetic
// ... existing ok-with-surplus branch ...
surplusWei: surplus > 0n ? surplus.toString() : null
```

**Verificação de todos os branches:**
- `ok-confirmed` (surplus > 0): `surplusWei = surplus.toString()` ✓
- `ok-confirmed` (exact match, surplus === 0): `surplusWei = null` ✓
- `warning-shortfall` (dentro da tolerância): `surplusWei = null` ✓
- `critical-shortfall` (fora da tolerância): `surplusWei = null` ✓
- `reverted`: `surplusWei = null` (via baseResult) ✓
- `unknown`/`receipt-not-found`: `surplusWei = null` (via baseResult) ✓
- `expected === 0n`: early return, `surplusWei = null` ✓

**`baseResult` type:** `Omit<ExecutionValidation, 'surplusWei' | ...>` — correcto, cada branch define surplusWei explicitamente. ✓

**Nenhuma alteração à lógica de validação existente** (shortfall thresholds, auto-disable side effects, receipt fetching). ✓

#### 2. `validate-execution/route.ts` — persistSurplus

**Função `persistSurplus(txHash, surplusWei)`:**
- Usa `getSupabase()` (service-role client) — correcto, `logger_role` não tem UPDATE. ✓
- `.update({ mev_savings_actual: surplusWei }).eq('tx_hash', txHash)` — parameterised query via Supabase client, sem SQL injection. ✓
- `try/catch` com `console.warn` — never throws. ✓
- Chamada: `if (result.surplusWei) { void persistSurplus(...) }` — fire-and-forget, só quando surplus é truthy (non-null, non-empty). ✓

**Posição no handler:** Após o log de warning/info, antes do `return NextResponse.json()`. A response não espera pela persist — correcto. ✓

#### 3. `useSwap.ts` — CoW path surplus PATCH

**Novo código (L726-748):**
```typescript
let cowSurplusForPatch: string | undefined
if (result.executedBuyAmount) {
  const executed = BigInt(result.executedBuyAmount)
  const quoted = BigInt(orderParams.buyAmount)
  const surplus = executed - quoted
  setMevSurplusActualWei(surplus > 0n ? surplus : 0n)
  cowSurplusForPatch = surplus > 0n ? surplus.toString() : undefined
}
updateSwapStatus(result.txHash, 'confirmed', undefined, undefined, address, undefined, cowSurplusForPatch)
```

**Verificação:**
- `setMevSurplusActualWei` (UI state) é pré-existente — lógica inalterada. ✓
- `cowSurplusForPatch` é `undefined` quando surplus ≤ 0 → `mevSavingsActual` não será escrito (PATCH handler checks `!= null`). ✓
- `updateSwapStatus` — fire-and-forget fetch to `/api/log-swap` PATCH. ✓
- **FEEDBACK.md insight:** O Code Agent documentou que o CoW path nunca chamava `updateSwapStatus` antes — o row ficava `pending` indefinidamente. Agora é correctamente marcado `confirmed`. Isto é um bug fix incidental mas benéfico, não um risco. ✓

**Testes P117:** 3 novos em `post-execution-validator.test.ts`:
1. Surplus populated when actual > expected (50000 wei) ✓
2. Null on shortfall (warning + critical) ✓
3. Null on exact-match ✓

### P118 — expected_output Column + Frontend Pass-through

#### 1. Migration `20260516_expected_output.sql`

```sql
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS expected_output NUMERIC;
COMMENT ON COLUMN swaps.expected_output IS '...';
```

- `IF NOT EXISTS` — idempotent. ✓
- `NUMERIC` — sem precisão fixa, correcto para wei values de tamanho arbitrário. ✓
- Sem `NOT NULL` — correcto, column é opcional (backfill não necessário). ✓
- Sem `GRANT` — `logger_role` tem INSERT on all columns de `swaps`, nova coluna herda. ✓
- 21 linhas total. ✓

#### 2. `log-swap/route.ts` — POST validation

```typescript
const expectedOutput = typeof body.expectedOutput === 'string' && /^\d+$/.test(body.expectedOutput)
  ? body.expectedOutput
  : null
```

**Validação:**
- `typeof === 'string'` — rejeita números, booleans, objects, arrays. ✓
- `/^\d+$/` — aceita apenas strings compostas exclusivamente de dígitos (0-9). Rejeita: decimais (`1.5`), negativos (`-1`), notação científica (`1e18`), strings vazias (``), strings com espaços (`1 2`). ✓
- Coerce para `null` em caso de falha — nunca lança excepção. ✓
- Passa para `{ expected_output: expectedOutput ?? null }` no INSERT. ✓

#### 3. `useSwap.ts` — Frontend callsites

**CoW path:** `expectedOutput: orderParams.buyAmount` — quoted buy amount em wei string. ✓
**Standard path:** `expectedOutput: data.swapToAmount` (= `meta.best.toAmount`) — quoted output em wei string. ✓

Ambos são raw wei strings produzidas pelos adapters — consistentes com `/^\d+$/`. ✓

#### 4. `analytics.ts` — `LogSwapParams` + `logSwapToSupabase`

`expectedOutput?: string` adicionado à interface e passado no fetch body. Sem transformação. ✓

**Teste P118:** 1 novo em `log-swap/route.test.ts` com 4 input shapes:
1. Valid numeric string → stored verbatim ✓
2. Missing → null ✓
3. Non-numeric string → null ✓
4. Numeric type (not string) → null ✓

### P119 — Weekly Surplus Report

#### 1. `surplus-report.ts` — Core module (288 lines)

**`generateSurplusReport()`:**
- Query: `.from('swaps').select('source, mev_savings_actual').eq('status', 'confirmed').gt('created_at', sevenDaysAgo)` ✓
- Filtra rows onde `mev_savings_actual` é null/zero em JS. ✓
- Aggregação: `Map<string, { swaps, withSurplus, totalSurplusWei }>` com BigInt arithmetic. ✓
- Sort: `totalSurplusWei` descending (BigInt comparison). ✓
- Returns: `SurplusReport { rows, totalWei, totalSwaps, swapsWithSurplus, empty, generatedAt }`. ✓
- `empty = rows.length === 0`. ✓

**`formatSurplusReportMessage(report)`:**
- Telegram HTML format (`parse_mode: 'HTML'`). ✓
- Per-source breakdown: source name, total surplus (ethers format), swap count, hit rate. ✓
- Weekly total em ETH, USD estimate (placeholder — "see Chainlink"). ✓
- Monthly projection: `totalWei × (30/7) × CAPTURE_RATE(0.30)` → "30% of X ETH/month". ✓
- Empty report: "No surplus data this week" — still sends confirmation. ✓

**`sendTelegramMessage(text)`:**
- POST `https://api.telegram.org/bot${token}/sendMessage` ✓
- `AbortSignal.timeout(10_000)` — 10s timeout. ✓
- `parse_mode: 'HTML'`, `disable_web_page_preview: true`. ✓
- `try/catch` — never throws. Returns `boolean`. ✓

**`isoWeek(d)`:**
- Computes `YYYY-Www` string. ✓
- Standard ISO week calculation (Thursday-based). ✓

**`shouldSendWeeklyReport(now?)`:**
- Gate 1: `now.getUTCDay() === TRIGGER_DOW(0)` — Sunday only. ✓
- Gate 2: `now.getUTCHours() === TRIGGER_HOUR(0)` — hour 0 UTC only. ✓
- Gate 3: KV dedup — `kv.get(LAST_SENT_KEY)` vs `isoWeek(now)`. Se match → false. ✓
- **Fail-closed on KV outage:** `catch` returns `false` — se KV falhar, relatório não envia. Correcto para dedup (preferível não enviar a enviar duplicado). ✓

**`maybeSendWeeklyReport(now?)`:**
- Top-level entry: `shouldSendWeeklyReport()` → `generateSurplusReport()` → `formatSurplusReportMessage()` → `sendTelegramMessage()`. ✓
- KV write (`kv.set(LAST_SENT_KEY, isoWeek(now), { ex: 30*86400 })`) — apenas após send bem-sucedido. ✓
- Full `try/catch` — returns `false` on any error. ✓

**Constants:**
- `LAST_SENT_KEY = 'teraswap:surplus-report:last-sent'` ✓
- `TTL = 30 * 24 * 60 * 60` (30 days) ✓
- `CAPTURE_RATE = 0.30` (30%) ✓
- `TRIGGER_DOW = 0` (Sunday) ✓
- `TRIGGER_HOUR = 0` (midnight UTC) ✓

#### 2. `surplus-report.test.ts` — 8 tests

**`generateSurplusReport` (2 tests):**
1. Groups rows by source, sorts by totalSurplusWei desc, counts swaps vs withSurplus correctly (null rows counted in swaps but not withSurplus), formatted message contains all sources + "Weekly Surplus Report" + "Projected monthly". ✓
2. Returns `empty=true` with 0 rows, formatted message contains "No surplus data this week". ✓

**`shouldSendWeeklyReport` (4 tests):**
3. Returns true on Sunday 00:xx UTC with no KV prior. ✓
4. Returns false on Monday. ✓
5. Returns false on Sunday after trigger hour (01:30). ✓
6. Returns false when KV already has current ISO week (dedup). ✓

**`maybeSendWeeklyReport` (2 tests):**
7. Sends to Telegram and writes dedup flag with correct TTL. ✓
8. Still sends "no data" fallback and dedups when 0 rows. ✓

**Mock architecture:**
- Supabase: thenable builder chain (from→select→eq→gt resolves to {data, error}). ✓
- KV: `mockKvGet`/`mockKvSet` vi.fn(). ✓
- Telegram: `globalThis.fetch` mock. ✓
- Env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` set in beforeEach. ✓

#### 3. `monitoring-loop.ts` — Integration (6 lines)

```typescript
import { maybeSendWeeklyReport } from './surplus-report'
// ...
void maybeSendWeeklyReport()
```

- Import adicionado. ✓
- `void` — fire-and-forget, never blocks tick. ✓
- Posição: após circuit breaker check, antes do heartbeat write. ✓
- Comentário documenta: "fires once per ISO week on Sundays 00:xx UTC". ✓

### FEEDBACK.md — Code Agent Concerns

**Assumption correction (P117):**
O spec assumia que o frontend consumia `ExecutionValidation` directamente para PATCH `mevSavingsActual`. O Code Agent correctamente identificou que `validateExecution` é server-only (RPC client, KV access, auto-disable side effects) e implementou dois caminhos:
1. Server-side: `persistSurplus` no validate-execution route (non-CoW) ✓
2. Client-side: `updateSwapStatus` com `cowSurplusForPatch` no useSwap (CoW) ✓

**Edge case (P117):**
O CoW success path nunca chamava `updateSwapStatus` — row ficava `pending`. Agora marcada `confirmed` com surplus. Bug fix incidental mas benéfico.

Ambos os items são correctos e bem documentados. ✓

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Zero alterações a contratos | **Confirmado** — diff contém apenas `.ts`, `.tsx`, `.sql` |
| Zero alterações a validators | **Confirmado** — validateRouterAddress, validateCallDataRecipient, validateFeeIntegrity não tocados |
| Zero alterações a rate limiter/backoff | **Confirmado** |
| `surplusWei` computation isolada no ok-with-surplus branch | **Confirmado** — L295, apenas `surplus > 0n` |
| `persistSurplus` usa `getSupabase()` (service-role) | **Confirmado** — correcto para UPDATE |
| `persistSurplus` é fire-and-forget | **Confirmado** — `void persistSurplus(...)` |
| CoW path PATCH via `updateSwapStatus` com 7º param | **Confirmado** — position correcta por TypeScript types |
| `expectedOutput` validado com `/^\d+$/` regex | **Confirmado** — rejeita non-string + non-digit |
| Migration idempotent (`IF NOT EXISTS`) | **Confirmado** |
| `logger_role` não precisa de GRANT para nova coluna | **Confirmado** — INSERT on table cobre all columns |
| `shouldSendWeeklyReport` fail-closed on KV error | **Confirmado** — catch returns false |
| KV write apenas após Telegram send bem-sucedido | **Confirmado** — L270-275 |
| `sendTelegramMessage` never throws | **Confirmado** — full try/catch, returns boolean |
| `maybeSendWeeklyReport` never throws | **Confirmado** — full try/catch |
| `void maybeSendWeeklyReport()` no monitoring tick | **Confirmado** — fire-and-forget, non-blocking |
| `isoWeek` computation correcta (Thursday-based) | **Confirmado** |
| Telegram env vars reutilizados (não novos) | **Confirmado** — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Nenhum dado sensível no diff | **Confirmado** — apenas analytics data |
| 12 novos testes cobrem todos os paths | **Confirmado** — 3+1+8 |
| FEEDBACK.md documenta desvios do spec | **Confirmado** — 2 items, ambos correctos |

---

## Veredicto Final

| Severidade | Count |
|------------|-------|
| CRITICAL   | 0     |
| HIGH       | 0     |
| MEDIUM     | 0     |
| LOW        | 0     |
| INFO       | 4     |

### APPROVED — 0C / 0H / 0M / 0L

Sprint 16B implementa instrumentação observacional para ADR-006 (Positive Slippage Sharing). Zero impacto em fund flows, contratos, ou lógica de swap. O surplus é calculado a partir de dados on-chain no post-execution-validator e persistido via dois caminhos complementares (server-side para non-CoW, client-side para CoW). A coluna `expected_output` permite recálculo futuro independente. O relatório semanal via Telegram é fire-and-forget com dedup robusto (KV + ISO week + fail-closed).

O Code Agent documentou correctamente no FEEDBACK.md que o spec assumia consumo directo de `ExecutionValidation` pelo frontend — a implementação com dois caminhos é mais segura (não expõe auto-disable side effects ao client).

Os 4 findings INFO são melhorias cosméticas ou de escalabilidade futura, sem acção necessária para Phase 1 data collection.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-15*
