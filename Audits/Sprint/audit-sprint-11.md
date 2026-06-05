# Auditoria Sprint 11 — Public API v1 + Auditor Pre-requisites

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-12
**Scope:** 7 commits — P75 (ba18c18), P76 (0abdfdd), P77 (4cad7ee), P78 (2107b27), P81 (9384959), P79 (d847564), P80 (9b9ba7d)
**Baseline:** Sprint 10 APPROVED (0C/0H/0M, 4L, 3I)
**Testes:** 504/504 passing (was 452 at Sprint 10 close; +52 novos testes)

---

## Resumo Executivo

Sprint 11 fecha os 4 LOW findings do Sprint 10 audit (P75-P78), depois constrói a primeira superfície pública de API do TeraSwap: infra de API keys com tiers (P81), `/api/v1/quote` (P79), e `/api/v1/swap` (P80). Este é o sprint mais significativo para a postura de segurança desde o Sprint 9B (FeeCollector V2 deploy), porque expõe pela primeira vez lógica interna a consumidores não-confiáveis.

**Veredicto: NOT APPROVED — 0 CRITICAL / 0 HIGH / 4 MEDIUM / 5 LOW / 2 INFO**

Os 4 MEDIUM devem ser resolvidos antes do deploy público. Nenhum é exploitável para perda de fundos, mas em conjunto criam superfície de ataque desnecessária num endpoint público de DeFi.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | Não | |
| Fund flows alterados? | Não | v1/swap produz tx unsigned — user assina e envia |
| Novos endpoints? | **Sim** | `/api/v1/quote` (GET), `/api/v1/swap` (POST), `/api/admin/api-keys` (POST/GET/DELETE) |
| Novos secrets/env vars? | **Sim** | `ADMIN_API_KEYS_SECRET` |
| Dependências adicionadas? | Não | |
| RLS impactado? | **Sim** | `api_keys` table sem RLS — ver 11-M-01 |
| CI verde? | Sim | 504/504 |
| Signed commits? | Sim | |

---

## Findings

### 11-M-01 — api_keys table sem Row-Level Security
**Severidade:** MEDIUM
**Ficheiro:** `supabase/api-keys.sql`
**Descrição:** A table `api_keys` não tem `ENABLE ROW LEVEL SECURITY` nem policies. Todas as outras tables do TeraSwap (swaps, quotes, orders, order_executions, security_events, usage_events, wallet_activity) têm RLS activo. `getSupabase()` usa `SUPABASE_SERVICE_ROLE_KEY` (confirmado em `src/lib/supabase.ts` L13), que bypassa RLS — por isso não há exposição imediata. No entanto:

1. Se um futuro developer usar o anon key por engano, toda a table fica exposta
2. Key hashes + metadata acessíveis = DoS via soft-delete em massa, ou inserção de keys fraudulentos
3. Inconsistência com o padrão do projecto (todas as outras tables protegidas)

**Impacto:** Nenhum imediato (service role bypass). Defence-in-depth gap.
**Recomendação:** Adicionar `ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;` + policy `USING (false)` para anon, `USING (true)` para service_role. Prompt para Code Agent.

### 11-M-02 — Error message leakage nos endpoints públicos
**Severidade:** MEDIUM
**Ficheiros:** `v1/quote/route.ts` L139-146, `v1/swap/route.ts` L379-385, L405-407
**Descrição:** Os catch blocks nos endpoints públicos encaminham `err.message` directamente para o cliente via 502 responses. Mensagens internas de adaptadores (rate limiter internal state, upstream API URLs, adapter names, router validation details) ficam visíveis para consumidores públicos. Exemplos de leakage:

- `"Router not whitelisted: 0x1234... is not in the allowlist for uniswapV3"` — revela a whitelist logic
- `"Adapter '${source}' did not return transaction data."` — confirma adapter architecture
- `"Internal: source 'X' resolved to a non-fee-collectable path"` — sinaliza code path inesperado

**Impacto:** Reconnaissance — atacante mapeia arquitectura interna, identifica adaptadores, e descobre error handling paths.
**Recomendação:** Sanitizar todas as respostas 502/500 para mensagens genéricas. Manter `err.message` apenas em `console.error` server-side. Prompt para Code Agent.

### 11-M-03 — Key state enumeration via error messages distintos
**Severidade:** MEDIUM
**Ficheiro:** `src/lib/api-auth.ts` L204-211
**Descrição:** As respostas de auth distinguem entre três estados:
- `"Invalid API key."` (key não existe)
- `"API key has been revoked."` (key existe, desactivada)
- `"API key has expired."` (key existe, expirada)

Isto permite a um atacante confirmar que um key hash existe na base de dados e determinar o seu estado, facilitando enumeração e timing de ataques.

**Impacto:** Information disclosure. Atacante pode confirmar existência de keys e distinguir entre keys activas que falham por rate limit vs keys revogadas.
**Recomendação:** Todas as respostas 401 devem retornar a mesma mensagem: `"Invalid or inactive API key."`. Distinguir apenas no server log. Prompt para Code Agent.

### 11-M-04 — Bare BigInt() em buildFeeCollectorTx (v1/swap)
**Severidade:** MEDIUM
**Ficheiro:** `v1/swap/route.ts` L269
**Descrição:** `const quotedOutput = BigInt(args.swapData.toAmount)` é um bare `BigInt()` em adapter-returned data, inconsistente com o padrão `safeBigInt()` estabelecido por P75. O mesmo route usa `safeBigInt()` em `autoSelectSource` (L232) mas bare `BigInt()` em `buildFeeCollectorTx` (L269). Se o adaptador retornar `toAmount` malformado, `BigInt()` lança `SyntaxError` que é apanhado pelo try/catch em L397-408 e produz 502 — não crasha o processo, mas o error message interno leaks via M-02.

**Impacto:** Crash defensivo (502) + info leak. Não é perda de fundos — o tx unsigned nunca é produzido.
**Recomendação:** Substituir por `safeBigInt()` + null check com 502 genérico. Prompt para Code Agent.

---

### 11-L-01 — Bare BigInt() residuais em SwapBox.tsx (9 call-sites)
**Severidade:** LOW
**Ficheiros:** `SwapBox.tsx` L124, L125, L175, L269, L272, L370, L406, L760-761, L835
**Descrição:** P75 migrou 6 ficheiros para `safeBigInt()` mas SwapBox.tsx ficou fora de scope com 9 bare `BigInt()` calls. No contexto frontend-only (meta.best vem dos adaptadores já filtrados), o risco é crash do componente — não perda de fundos. Mas a inconsistência viola o princípio "defence-in-depth everywhere" e o P75 commit nota explicitamente este gap.
**Impacto:** UI crash localizado se toAmount malformado.
**Recomendação:** Sweep de SwapBox.tsx + split-router.ts + useSplitRoute.ts para `safeBigInt()`. Sprint 12 backlog.

### 11-L-02 — Bare BigInt() em cow.ts L193 antes do validator
**Severidade:** LOW
**Ficheiro:** `src/lib/adapters/cow.ts` L193
**Descrição:** `BigInt(quote.buyAmount)` é chamado antes de `parseCowOrderParams` (L201). Se a CoW API retornar `buyAmount` não-numérico, o throw acontece antes da validação poder rejeitar graciosamente. O adapter-level catch apanha isto e remove CoW da ronda — degradação, não crash.
**Impacto:** Degradação funcional (CoW cai da ronda). Não exploitável.
**Recomendação:** Mover `parseCowOrderParams` para antes do `BigInt(quote.buyAmount)`, ou usar `safeBigInt()`. Sprint 12 backlog.

### 11-L-03 — quoteMeta: Record<string, any> residual em types.ts
**Severidade:** LOW
**Ficheiro:** `src/lib/adapters/types.ts` L119
**Descrição:** P76 corrigiu `cowOrderParams` para `CowOrderParams` tipado, mas `quoteMeta` mantém `Record<string, any>`. Qualquer adaptador pode injectar dados não-tipados que fluem sem validação pela pipeline.
**Impacto:** Type-safety gap. Não exploitável directamente.
**Recomendação:** Tipar `quoteMeta` com union de interfaces por adaptador. Sprint 12 backlog.

### 11-L-04 — Admin route leaks env var names
**Severidade:** LOW
**Ficheiro:** `src/app/api/admin/api-keys/route.ts` L47
**Descrição:** `supabaseUnavailable()` retorna `"Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."` que revela infra details e env var names a quem acede o admin endpoint.
**Impacto:** Information disclosure (requer bearer token para aceder).
**Recomendação:** Substituir por mensagem genérica: `"Service unavailable."`. Prompt para Code Agent.

### 11-L-05 — Admin rate limit overrides sem upper bound
**Severidade:** LOW
**Ficheiro:** `src/app/api/admin/api-keys/route.ts` L121-128
**Descrição:** Admin pode definir `rateLimitPerMin: 999999999` sem cap superior. Apenas `> 0` é validado.
**Impacto:** Risco operacional — admin pode acidentalmente criar key "unlimited".
**Recomendação:** Cap a `10000/min` e `1000000/day` com override flag explícito para exceções. Sprint 12 backlog.

---

### 11-I-01 — Unknown tier defaults to 'free'
**Severidade:** INFO
**Ficheiro:** `src/lib/api-auth.ts` L267
**Descrição:** Um `tier` corrupto na DB opera silenciosamente em free-tier limits em vez de ser rejeitado.
**Recomendação:** Considerar rejeitar tiers desconhecidos com 500 em vez de fallback silencioso.

### 11-I-02 — Bare BigInt() no computeMinimumOutput
**Severidade:** INFO
**Ficheiro:** `v1/swap/route.ts` L117
**Descrição:** `BigInt(Math.max(0, Math.round(slippagePercent * 100)))` é safe porque o input é range-validated [0, 50], mas é inconsistente com o padrão `safeBigInt()`.
**Recomendação:** Aceitar como is — input é garantidamente safe.

---

## Closure Validation — Sprint 10 LOWs

| Finding | Commit | Status | Notas |
|---------|--------|--------|-------|
| 10-L-01 (BigInt render crash) | ba18c18 | **CLOSED** | `safeBigInt()` com 25 testes. Migração de 6 ficheiros. `null` handling contextual por ficheiro. Gap residual em SwapBox.tsx → 11-L-01. |
| 10-L-02 (orderParams: any) | 0abdfdd | **CLOSED** | `CowOrderParams` interface + `parseCowOrderParams` runtime validator com regex. 452/452. |
| 10-L-03 (client amountInUsd) | 4cad7ee | **CLOSED** | Server-side USD via `computeTokenAmountUsd` (Chainlink + ERC-20 decimals). Client demovido a fallback com metadata tracking. Drift telemetry >5%. |
| 10-L-04 (alert loss) | 2107b27 | **CLOSED** | KV-backed retry queue (3 attempts, cap 256). Block advancement gated. `alerts_lost_total` metric. 6 novos testes. 458/458. |

Todos os 4 LOWs estão correctamente encerrados. P75-P78 demonstram qualidade de implementação elevada.

---

## Análise por Prompt

### P75 (ba18c18) — safeBigInt [10-L-01]
**Resultado:** PASS
7 ficheiros, 300 insertions, 25 testes novos. Utility robusta com regex + try/catch belt. Migração contextual — `QuoteBreakdown` degrada para `'—'`, `useSwap` degrada para `minimumOutput = 0n`. Scope parcial documentado no commit — SwapBox.tsx, api.ts, quorum-check.ts, split-router.ts, useSplitRoute.ts ficaram fora. Os dois últimos não têm try/catch → 11-L-01.

### P76 (0abdfdd) — CowOrderParams [10-L-02]
**Resultado:** PASS
2 ficheiros, 162 insertions. Interface estrita com `0x${string}` para addresses. Runtime validator com regex, enum membership, e positivity checks. Fail-closed — `null` → thrown error → source cai da ronda. `submitCowOrder` agora tipado. Zero `any` no flow CoW (excepto `quoteMeta` residual → 11-L-03).

### P77 (4cad7ee) — Server-side USD [10-L-03]
**Resultado:** PASS
2 ficheiros, 139 insertions. `fetchErc20Decimals` com guard 1..30. `computeTokenAmountUsd` com BigInt precision. Parallel calls com `.catch(() => null)`. Fallback explícito com metadata source tracking. Drift telemetry. Não bloqueia response. Design impecável.

### P78 (2107b27) — Alert retry queue [10-L-04]
**Resultado:** PASS
2 ficheiros, 508 insertions. Arquitectura sólida: dispatch → tracking → enqueue → gated advancement. KV-backed retry com dedup por (txHash, eventName, blockNumber). Cap 256 entries. `alerts_lost_total` monotónico. 6 testes cobrindo os cenários críticos (failure holds block, retry delivery, max attempts drop, dedup). Suite 452→458.

### P81 (9384959) — API Key Infrastructure [LP-08]
**Resultado:** PASS com findings (11-M-01, 11-L-04, 11-L-05)
4 ficheiros, 634 insertions. SHA-256 hashing (nunca plaintext), `tsk_` prefix + 256-bit entropy, tier-based rate limiting via sliding-window KV existente. Admin CRUD com bearer token auth. Soft-delete preserva audit trail. Key_hash excluído do GET response. Missing: RLS (11-M-01), admin error leaks infra (11-L-04), no rate limit upper bound (11-L-05). Sem testes — flagged para P79 (confirmed: test harness built in P79).

### P79 (d847564) — /api/v1/quote [LP-09]
**Resultado:** PASS com findings (11-M-02 parcial, 11-M-03 parcial)
2 ficheiros, 490 insertions, 20 testes. Pipeline: halt → auth → validate → fetchMetaQuote → response. Input validation completa: `isValidAddress` + `safeBigInt` + range checks. CORS universal com preflight. `Cache-Control: no-store`. `mevProtected` derivado de AGGREGATOR_META. Error message leakage em catch blocks (11-M-02). 20 testes cobrem preflight, auth, validation, happy path, e upstream errors.

### P80 (9b9ba7d) — /api/v1/swap [LP-10]
**Resultado:** PASS com findings (11-M-02, 11-M-04)
2 ficheiros, 888 insertions, 26 testes. Pipeline: halt → auth → parse → source resolution → fetchSwap @ net amount → buildFeeCollectorTx → response. **FeeCollector V2 enforcement triple-checked:** parseBody rejects fee-incompatible, autoSelectSource filters them, usesFeeCollector assertion. Bare BigInt em L269 (11-M-04). Error leakage (11-M-02). `routedVia: 'fee-collector-v2'` para caller verification. 26 testes cobrem validation, auth, ERC-20 + ETH paths, router validation, auto source selection, e error surfacing.

---

## Padrões de Segurança Positivos

1. **FeeCollector V2 enforcement triplo** — 3 gates independentes impedem bypass para router directo
2. **Pipeline order consistente** — halt → auth → validate em ambos endpoints
3. **safeBigInt adoption** — 10-L-01 correctamente encerrado com 25 testes
4. **SHA-256 key hashing** — plaintext nunca armazenado, retornado apenas uma vez
5. **Fail-closed on auth backend down** — 503, não fallback para unauth'd access
6. **Rate limiting per-key** — KV sliding window, não per-IP (correcto para API keys)
7. **Cache-Control: no-store** — quotes e swap data nunca cached
8. **CORS com Vary: Origin** — correcto para CDN/proxy compatibility
9. **Server-side USD** — monitoring thresholds não manipuláveis por client
10. **Alert retry queue** — alerts críticos nunca silenciosamente perdidos

---

## Residuais (backlog)

| ID | Sev | Sprint | Descrição | Target |
|----|-----|--------|-----------|--------|
| 11-L-01 | LOW | 11 | 9 bare BigInt() em SwapBox.tsx | Sprint 12 |
| 11-L-02 | LOW | 11 | cow.ts BigInt antes de validator | Sprint 12 |
| 11-L-03 | LOW | 11 | quoteMeta: Record<string, any> | Sprint 12 |
| 11-L-05 | LOW | 11 | Admin rate limit sem upper bound | Sprint 12 |
| SC-02 | LOW | Sprint 6 | DCA dust acumulação | Phase 2 |
| FE-01 | LOW | Sprint 7 | localStorage → Web Crypto V2 | Phase 2 |

---

## Prompts para Code Agent (bloqueiam aprovação)

### Prompt 11-FIX-01 — api_keys RLS (11-M-01)
```
Context: supabase/api-keys.sql lacks RLS. Every other TeraSwap table has RLS.
Objective: Add RLS to api_keys table.
Requirements:
  - ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
  - Policy: deny all for anon role, allow all for service_role
  - Match the pattern used in schema.sql (L110-120)
Do NOT: Change any column types, indexes, or existing queries.
Files affected: supabase/api-keys.sql
Expected output: 1 atomic commit.
Quality criteria: api_keys has RLS enabled with restrictive default.
```

### Prompt 11-FIX-02 — Sanitise public API error messages (11-M-02)
```
Context: /api/v1/quote and /api/v1/swap forward internal err.message to clients via 502/500.
Objective: Replace all public-facing error messages with generic versions.
Requirements:
  - 502 responses: "Upstream service error. Please retry."
  - 500 responses: "Internal error."
  - Keep err.message in console.error for server-side debugging
  - Do NOT change 400/401/429 messages (those are caller-facing by design)
  - Also fix admin route L47: replace infra details with "Service unavailable."
Do NOT: Change any validation logic, status codes, or non-error responses.
Files affected: src/app/api/v1/quote/route.ts, src/app/api/v1/swap/route.ts, src/app/api/admin/api-keys/route.ts
Expected output: 1 atomic commit.
Quality criteria: grep -r 'err.message\|err instanceof' in v1/ routes shows no direct forwarding to NextResponse.json.
```

### Prompt 11-FIX-03 — Unify auth rejection messages (11-M-03)
```
Context: api-auth.ts returns distinct error messages for invalid/revoked/expired keys, enabling key state enumeration.
Objective: Unify all 401 rejection messages.
Requirements:
  - All three 401 paths (L205, L208-209, L210-211) return the same message: "Invalid or inactive API key."
  - Preserve distinct console.warn/error for server-side debugging (e.g., "[api-auth] rejected: revoked key <hash-prefix>")
  - Status code remains 401 for all three
Do NOT: Change the 429 or 503 responses. Do NOT change the rate limit logic.
Files affected: src/lib/api-auth.ts
Expected output: 1 atomic commit.
Quality criteria: All 401 responses return identical JSON body.
```

### Prompt 11-FIX-04 — safeBigInt in buildFeeCollectorTx (11-M-04)
```
Context: v1/swap/route.ts L269 uses bare BigInt() on adapter-returned toAmount, inconsistent with safeBigInt() used at L232.
Objective: Replace bare BigInt with safeBigInt + null guard.
Requirements:
  - L269: const quotedOutput = safeBigInt(args.swapData.toAmount)
  - If null: throw new Error('Adapter returned non-numeric toAmount.') (caught by existing try/catch at L397)
  - Import safeBigInt if not already imported
Do NOT: Change any other BigInt() calls in this file. Do NOT change the error handling wrapper.
Files affected: src/app/api/v1/swap/route.ts
Expected output: 1 atomic commit.
Quality criteria: Zero bare BigInt(*.toAmount) calls in v1/ routes.
```

---

## Veredicto Final

| Severidade | Count | Bloqueante? |
|------------|-------|-------------|
| CRITICAL   | 0     | — |
| HIGH       | 0     | — |
| MEDIUM     | 4     | **Sim** |
| LOW        | 5     | Não |
| INFO       | 2     | Não |

### NOT APPROVED — 0C / 0H / 4M

Os 4 MEDIUM são resolúveis com os 4 prompts acima. Estimativa: ~30 minutos de trabalho do Code Agent. Após re-submissão com os fixes, espero 0C/0H/0M e aprovação.

**Nota positiva:** A qualidade geral do Sprint 11 é elevada. O encerramento dos 4 LOWs do Sprint 10 é exemplar, o pipeline de auth é sólido, e o FeeCollector V2 enforcement triplo é uma decision de design que demonstra maturidade. Os 4 MEDIUM são gaps de hardening, não falhas fundamentais.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-12*
