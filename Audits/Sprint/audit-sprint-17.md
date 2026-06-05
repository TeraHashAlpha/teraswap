# Auditoria Sprint 17 — Hardening

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-18
**Scope:** 4 commits no branch `feat/sprint-17-hardening`
**Baseline:** Sprint 16B APPROVED (surplus instrumentation). Todos os 5 MEDIUMs externos CLOSED. 16B-I-04 open.
**Commits:**
- `c0dbd61` — feat(hardening): add Dependabot config for npm + Actions updates [P120]
- `abe54f2` — feat(hardening): source allow-list guard at /api/swap entry [P121]
- `34d190b` — feat(hardening): refactor updateSwapStatus to options object [P122]
- `6f0760b` — feat(hardening): document executor production operations runbook [P123]

**Ficheiros:** 8 files, +437/−56 lines (net +381)
**Testes:** 2 novos (P121 source guard)

---

## Resumo Executivo

Sprint 17 fecha 4 items de backlog sem introduzir features novas ou alterar contratos:

1. **P120 (B1)** — Re-habilita Dependabot com configuração segura: weekly schedule, majors ignorados, dev deps agrupados, 5-PR cap. GitHub Actions também coberto.

2. **P121 (B5)** — Source allow-list guard no `/api/swap` entry point. Rejeita sources desconhecidos com 400 `INVALID_SOURCE` **antes** de rate-limit deduction, upstream fetch, ou qualquer side-effect. Usa `AGGREGATOR_APIS` como single source of truth. O rate-limiter foi movido para após o body parse + source guard (reordenação correcta).

3. **P122 (16B-I-04)** — Refactora `updateSwapStatus` de 7 parâmetros posicionais para `UpdateSwapStatusParams` interface. 6 call sites convertidos. Zero `undefined` placeholders restantes. PATCH body construction idêntico — puro signature refactor.

4. **P123 (B7)** — Runbook de operações do executor: 6 secções (arquitectura, env vars, deploy, monitoring, incident response, key rotation). Cross-references `executor-compromise.md`. Zero secrets no doc.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 3 INFO**

Zero impacto em fund flows, contratos, ou lógica de swap. P121 é a única alteração com impacto funcional (rejeita sources inválidos mais cedo) e melhora a postura de segurança.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | |
| Fund flows alterados? | **Não** | |
| ABI alterado? | **Não** | |
| Novos endpoints? | **Não** | |
| Novos secrets/env vars? | **Não** | |
| Dependências adicionadas? | **Não** | |
| Dados sensíveis no diff? | **Não** | Runbook referencia secrets por nome, não por valor. |
| Testes novos? | **Sim** | 2 novos (P121 source guard). |
| Validators alterados? | **Não** | validateRouterAddress, validateCallDataRecipient, validateFeeIntegrity inalterados. |
| Rate limiter alterado? | **Reordenado** | Movido para DEPOIS do source guard. Lógica interna inalterada. |
| PATCH body construction alterada? | **Não** | P122 refactora apenas a assinatura; destructuring preserva o body idêntico. |

---

## Findings

### 17-I-01 — Dependabot `ignore` majors pode mascarar security patches

**Severidade:** INFO
**Ficheiro:** `.github/dependabot.yml` L16-17
**Descrição:** A regra `ignore: dependency-name: "*", update-types: ["version-update:semver-major"]` suprime todos os PRs de major bumps. Se uma security fix for publicada como major-only (raro mas possível — e.g., breaking change necessário para corrigir a vulnerabilidade), o PR não será criado automaticamente. O `npm audit` no CI continuará a reportar o advisory, mas não haverá PR de Dependabot para o resolver.
**Recomendação:** Aceitar como is. A política é correcta para estabilidade — majors requerem review manual. O `npm audit` no CI é a safety net. Adicionalmente, o Dependabot cria security PRs (`security-updates`) independentemente da configuração de `version-updates`, portanto a maioria dos patches de segurança será coberta.

### 17-I-02 — `/api/swap` route ainda não tem cobertura unit completa

**Severidade:** INFO
**Ficheiro:** `src/app/api/swap/route.test.ts`
**Descrição:** O P121 adiciona 2 testes (valid source + invalid source), mas o Code Agent documenta no FEEDBACK.md que o resto da route (price guard, R1 recipient check, SC-04 selector check) não tem unit tests. A route tinha coverage apenas via testes manuais e integração. Os 2 novos testes cobrem o guard novo, mas a cobertura total da route permanece parcial.
**Recomendação:** Adicionar ao backlog como item de qualidade (não segurança). Os validators individuais (`validateCallDataRecipient`, `isKnownSwapSelector`, `validateSwapPrice`) têm testes próprios — o risco residual é na integração desses validators dentro do handler.

### 17-I-03 — Runbook inclui SQL `UPDATE` directo na tabela `orders`

**Severidade:** INFO
**Ficheiro:** `docs/Runbooks/EXECUTOR-OPERATIONS.md` §5
**Descrição:** A opção B de pausa sugere `UPDATE orders SET status = 'paused' WHERE status = 'active'` directamente em Supabase. Isto bypassa RLS (assume acesso service-role) e não tem audit trail automático. Para o executor (que já usa service-role), isto é consistente. O risco é operacional: um typo no SQL pode afectar orders não pretendidas.
**Recomendação:** Aceitar como is — é um runbook para operadores com acesso admin. Considerar adicionar um `WHERE` mais restritivo (e.g., `AND created_at > now() - interval '7 days'`) como exemplo defensivo no futuro.

---

## Análise Detalhada

### P120 — Dependabot Configuration (`c0dbd61`)

**Ficheiro:** `.github/dependabot.yml` (30 linhas, novo)

**npm ecosystem:**
- `interval: "weekly"`, `day: "monday"` — uma vez por semana, início de sprint. ✓
- `open-pull-requests-limit: 5` — previne inundação de PRs. ✓ (Consistent com `feedback_vercel_deploys` — batch PRs para reduzir builds.)
- `labels: ["dependencies"]` — categorização automática. ✓
- `ignore: "*" majors` — suprime breaking changes. ✓ (See finding 17-I-01.)
- `groups: dev-dependencies: dependency-type: "development"` — agrupa minor/patch de dev deps num único PR. ✓

**GitHub Actions ecosystem:**
- `interval: "weekly"` — mantém Actions actualizados. ✓
- `labels: ["ci"]` — categorização. ✓
- Sem ignore de majors — correcto, Actions majors são tipicamente breaking mas security-relevant (Actions executam com repo permissions). ✓

**Verificação:**
- YAML only — zero code changes. ✓
- `version: 2` — current Dependabot schema. ✓
- Sem `registries` block — não há registries privados. ✓
- Re-habilita Dependabot que foi desabilitado em `c65a0ea` (Sprint 16A infrastructure). ✓

### P121 — Source Allow-list Guard (`abe54f2`)

**Ficheiros:** `src/app/api/swap/route.ts` (61 lines changed), `src/app/api/swap/route.test.ts` (105 lines, novo)

#### Route changes

**Nova constante (module scope):**
```typescript
const ALLOWED_SOURCES: Set<string> = new Set(Object.keys(AGGREGATOR_APIS))
```
- `AGGREGATOR_APIS` é o mapa canónico de sources em `constants.ts`. ✓
- `Set` para O(1) lookup. ✓
- Module scope — computado uma vez no import, não por request. ✓

**Guard (L66-71):**
```typescript
if (typeof source !== 'string' || !ALLOWED_SOURCES.has(source)) {
  return NextResponse.json(
    { error: 'Unknown aggregator source', code: 'INVALID_SOURCE' },
    { status: 400 },
  )
}
```

**Verificação da cadeia de execução:**

| Step | Before P121 | After P121 |
|------|------------|------------|
| 1 | Circuit breaker | Circuit breaker (unchanged) |
| 2 | **Rate limit** | Content-length check |
| 3 | Content-length check | Body parse |
| 4 | Body parse | Required fields check |
| 5 | Required fields check | **Source allow-list** ← NEW |
| 6 | Address/slippage validation | **Rate limit** ← MOVED DOWN |
| 7 | Source → upstream fetch | Address/slippage validation |
| 8 | — | Source → upstream fetch |

**Análise de segurança — CRÍTICA:**

A reordenação move o rate-limiter de antes do body parse para DEPOIS do source guard. Isto significa:
- ✓ Sources inválidos NÃO consomem rate-limit budget (correcto — previne DoS via requests inválidos que drenam o bucket)
- ✓ Rate-limit continua a proteger upstream fetches (corre antes de `fetchSwapFromSource`)
- ✓ Circuit breaker permanece como primeiro check (mais prioritário que rate-limit)
- ✓ Body parse e required-fields check correm antes do source guard — correcto, precisam do `source` field para validar

**Potencial bypass path:** Nenhum encontrado. O guard é o primeiro check funcional após body parse e required-fields. Não há path que chegue a `fetchSwapFromSource` ou `checkRateLimit` sem passar pelo guard.

**Type safety:** `typeof source !== 'string'` — defence-in-depth contra body manipulation (JSON permite qualquer tipo). Se `source` for um array, number, ou object, é rejeitado antes do `Set.has()`. ✓

#### Tests (2 novos)

**Test 1 — Valid source proceeds:**
- Source `1inch`, mock `fetchSwapFromSource` retorna dados válidos.
- Asserts: 200 status, `fetchSwapFromSource` called once with `'1inch'`, `checkRateLimit` called once.
- ✓ Confirma que o happy path funciona com o guard activo.

**Test 2 — Invalid source → 400:**
- Source `'evil-router'`.
- Asserts: 400 status, `body.code === 'INVALID_SOURCE'`, `checkRateLimit` NOT called, `fetchSwapFromSource` NOT called.
- ✓ Confirma que o guard short-circuits antes de side-effects.

**Mock architecture:**
- `isSystemHalted` → false (circuit breaker off). ✓
- `checkRateLimit` → allowed (never called for invalid source). ✓
- `fetchSwapFromSource` → mocked (never called for invalid source). ✓
- `isKnownSwapSelector` → true (bypass selector check). ✓
- `validateCallDataRecipient` → valid (bypass recipient check). ✓
- `validateSwapPrice` → null (bypass price guard). ✓

### P122 — updateSwapStatus Refactor (`34d190b`)

**Ficheiros:** `src/lib/analytics.ts` (34 lines changed), `src/hooks/useSwap.ts` (23 lines changed), `src/components/SwapBox.tsx` (14 lines changed)

#### Interface

```typescript
export interface UpdateSwapStatusParams {
  txHash: string
  status: 'confirmed' | 'failed'
  gasUsed?: string
  gasPrice?: string
  wallet?: string
  mevSavingsEstimate?: string
  mevSavingsActual?: string
}
```

**Verificação contra a assinatura anterior:**
- `txHash: string` — era param 1. ✓
- `status: 'confirmed' | 'failed'` — era param 2. ✓
- `gasUsed?: string` — era param 3. ✓
- `gasPrice?: string` — era param 4. ✓
- `wallet?: string` — era param 5. ✓
- `mevSavingsEstimate?: string` — era param 6. ✓
- `mevSavingsActual?: string` — era param 7. ✓

Todos os 7 campos preservados, mesmos tipos, mesma opcionalidade. ✓

#### Function body

```typescript
export function updateSwapStatus(params: UpdateSwapStatusParams): void {
  const { txHash, status, gasUsed, gasPrice, wallet, mevSavingsEstimate, mevSavingsActual } = params
  // ... fetch PATCH unchanged ...
}
```

**Destructuring preserva nomes idênticos** — o `body: JSON.stringify({ txHash, status, gasUsed, gasPrice, wallet, mevSavingsEstimate, mevSavingsActual })` é byte-for-byte idêntico ao anterior. ✓

#### Call sites (6 total)

| Location | Before | After |
|----------|--------|-------|
| `useSwap.ts` L746 (CoW confirmed) | `updateSwapStatus(result.txHash, 'confirmed', undefined, undefined, address, undefined, cowSurplusForPatch)` | `updateSwapStatus({ txHash: result.txHash, status: 'confirmed', wallet: address, mevSavingsActual: cowSurplusForPatch })` |
| `useSwap.ts` L875 (wagmi confirmed) | `updateSwapStatus(swapHash, 'confirmed', undefined, undefined, address)` | `updateSwapStatus({ txHash: swapHash, status: 'confirmed', wallet: address })` |
| `useSwap.ts` L928 (fallback confirmed) | `updateSwapStatus(swapHash, 'confirmed', undefined, undefined, address)` | `updateSwapStatus({ txHash: swapHash, status: 'confirmed', wallet: address })` |
| `useSwap.ts` L939 (fallback failed) | `updateSwapStatus(swapHash, 'failed', undefined, undefined, address)` | `updateSwapStatus({ txHash: swapHash, status: 'failed', wallet: address })` |
| `useSwap.ts` L994 (sendError) | `updateSwapStatus(swapHash, 'failed', undefined, undefined, address)` | `updateSwapStatus({ txHash: swapHash, status: 'failed', wallet: address })` |
| `SwapBox.tsx` L309 (MEV telemetry) | `updateSwapStatus(txHash, 'confirmed', undefined, undefined, address, mevEstimate?..., realisedSurplusWei?...)` | `updateSwapStatus({ txHash, status: 'confirmed', wallet: address, mevSavingsEstimate: ..., mevSavingsActual: ... })` |

**Verificação completude:**
- `git grep 'updateSwapStatus(' | grep 'undefined'` — zero matches no branch. ✓
- 6 call sites: 5 em `useSwap.ts`, 1 em `SwapBox.tsx`. ✓
- Todos usam object syntax `updateSwapStatus({ ... })`. ✓
- `undefined` values (gasUsed, gasPrice) são simplesmente omitidos no object — correcto, PATCH handler checks `!= null` por campo. ✓

**Closes 16B-I-04.** ✓

### P123 — Executor Operations Runbook (`6f0760b`)

**Ficheiros:** `docs/Runbooks/EXECUTOR-OPERATIONS.md` (182 linhas, novo), `FEEDBACK.md` (+34 linhas)

#### Runbook review

**§1 Architecture Overview:**
- Diagrama correcto: Supabase → RPC → Contract → Supabase. ✓
- Tunables referenciados com line numbers do source. ✓
- "Executor SHOULD NOT be running in production yet" — correcto, `order_executions` vazio. ✓

**§2 Environment Variables:**
- 10 variables listadas com tipo (config/secret), required flag, e purpose. ✓
- `EXECUTOR_PRIVATE_KEY`: documentado como hard-fail on mainnet (commit `539bd02`). KMS/Vault required. ✓
- `RPC_URL` tratado como secret (embeds API key). ✓
- Nenhum valor de secret no documento — apenas nomes e descrições. ✓

**§3 Deployment:**
- PM2 setup, startup, save, restart commands. ✓
- Single instance enforced (múltiplas instâncias race condition documentado). ✓
- Auto-restart policy: `max_restarts: 50`, `max_memory_restart: 256M`. ✓
- Log rotation via `pm2-logrotate` mencionado como recommendation. ✓

**§4 Monitoring & Alerting:**
- Mapeia signals para alert paths existentes (P47 on-chain monitor, P45 post-execution, Telegram). ✓
- "Where to look first" checklist. ✓
- Gas-cap hit e failure streak documentados como manual audit (não alertados automaticamente). ✓

**§5 Incident Response:**
- Cross-references `executor-compromise.md` imediatamente. ✓
- Routine restart procedure. ✓
- Pause options: PM2 stop (Option A) e SQL pause (Option B). ✓ (See finding 17-I-03 re: direct SQL.)
- Resume procedure com gas price verification. ✓

**§6 Key Rotation:**
- 48h timelock documented. ✓
- 10-step procedure from KMS generation through de-whitelist. ✓
- "Do NOT skip the test-execution step" — critical warning. ✓
- References `proposeExecutor`, `executeExecutorChange` contract functions. ✓

**Verificação de segurança:**
- Zero secrets, API keys, ou addresses reais no documento. ✓
- Placeholder addresses/values usados onde necessário. ✓
- Cross-reference para `executor-compromise.md` em 3 locais (intro, §5, §6). ✓

#### FEEDBACK.md (P121 + P122)

**P121 feedback:**
- Edge case: rate-limit reordering documented — spec said guard before rate-limit, but existing code ran rate-limit before body parse. Correctly reordered. ✓
- Test gap: no pre-existing tests for `/api/swap` route. P121 adds source guard tests; rest of route not unit-tested. ✓ (See finding 17-I-02.)

**P122 feedback:**
- Edge case: 6 call sites converted, worst offender (CoW PATCH with 5 `undefined`s) eliminated. Verified via `git grep`. ✓
- Concern: no direct tests for `updateSwapStatus`. Acceptable — pure signature refactor, PATCH endpoint has integration coverage. ✓

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Zero alterações a contratos | **Confirmado** — diff contém apenas `.yml`, `.ts`, `.tsx`, `.md` |
| Zero alterações a validators | **Confirmado** — validateRouterAddress, validateCallDataRecipient, validateFeeIntegrity não tocados |
| Rate limiter lógica inalterada | **Confirmado** — apenas reposicionado após source guard |
| `ALLOWED_SOURCES` usa `AGGREGATOR_APIS` keys | **Confirmado** — `Object.keys(AGGREGATOR_APIS)` |
| Source guard rejeita antes de rate-limit | **Confirmado** — test asserts `checkRateLimit` not called |
| Source guard rejeita antes de upstream fetch | **Confirmado** — test asserts `fetchSwapFromSource` not called |
| `typeof source !== 'string'` defence-in-depth | **Confirmado** — protege contra body manipulation |
| `updateSwapStatus` PATCH body idêntico | **Confirmado** — destructuring preserva nomes, `JSON.stringify` output byte-identical |
| 6 call sites convertidos para object syntax | **Confirmado** — 5 useSwap + 1 SwapBox |
| Zero `undefined` placeholders restantes | **Confirmado** — `git grep 'updateSwapStatus(' \| grep 'undefined'` = 0 |
| 16B-I-04 CLOSED | **Confirmado** |
| Runbook zero secrets | **Confirmado** — nomes de variáveis, não valores |
| Runbook cross-references executor-compromise.md | **Confirmado** — 3 locais |
| Dependabot majors ignored | **Confirmado** — `ignore: "*" semver-major` |
| Dependabot GitHub Actions sem major ignore | **Confirmado** — correcto para security |
| FEEDBACK.md items correctos | **Confirmado** — 4 items, todos válidos |

---

## Backlog Item Status

| Item | Status | Closed by |
|------|--------|-----------|
| B1 (Dependabot re-enable) | **CLOSED** | P120 (`c0dbd61`) |
| B5 (Source allow-list guard) | **CLOSED** | P121 (`abe54f2`) |
| B7 (Executor runbook) | **CLOSED** | P123 (`6f0760b`) |
| 16B-I-04 (positional args) | **CLOSED** | P122 (`34d190b`) |

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

Sprint 17 é um hardening sprint limpo. A alteração mais significativa (P121 source allow-list) melhora a postura de segurança ao rejeitar sources desconhecidos antes de qualquer side-effect, incluindo rate-limit deduction. A reordenação do rate-limiter é correcta e documentada. O refactor P122 elimina uma code smell identificada em 16B-I-04 sem alterar comportamento. O runbook P123 é completo e não contém secrets.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-18*
