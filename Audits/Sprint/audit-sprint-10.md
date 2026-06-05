# Auditoria Sprint 10 — P69–P74

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-11
**Scope:** 6 commits — P69 (6196b87), P70 (362df83), P71 (8220b3b), P72 (06da23a), P73 (c73fa8d), P74 (afc42ae)
**Baseline:** Sprint 9B APPROVED (0C/0H/0M, 3 INFO)
**Testes:** 427/427 passing (TS + Foundry)

---

## Resumo Executivo

Sprint 10 introduz smart MEV routing, surplus display com analytics, ERC-7730 clear signing para Ledger, fix do topic hash V1/V2 (9B-I-01), runbook de signed commits (CVE-2026-3854), e secção MEV na DocsPage.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM**

Todas as alterações são defensivamente construídas. Os findings são LOW/INFO e adequados para backlog (Sprint 11+).

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | Não | Sprint 10 é 100% frontend/infra |
| Fund flows alterados? | Não | Routing logic é display-only, não altera calldata |
| Novos endpoints? | Não | `log-swap` PATCH recebe 2 campos opcionais novos |
| Novos secrets/env vars? | Não | |
| Dependências adicionadas? | Não | |
| RLS/auth impactado? | Não | `swaps` RLS activo (schema.sql L115), colunas MEV são nullable |
| CI verde? | Sim | 427/427 |
| Signed commits? | Sim | P69 activa branch protection |

---

## Findings

### 10-L-01 — BigInt() em render path sem try/catch (P70/P71)
**Severidade:** LOW
**Ficheiros:** `QuoteBreakdown.tsx` L54, L65, L343
**Descrição:** `BigInt(q.toAmount)` é chamado dentro de render. Se uma quote contiver `toAmount` malformado (e.g., string vazia ou não-numérica), o componente inteiro crasha. O parent `SwapBox` guarda contra `meta` nulo mas não valida o formato de `toAmount`.
**Impacto:** UI crash localizado, sem perda de fundos. O swap não é executado.
**Recomendação:** Wrap em try/catch ou validar `toAmount` antes de `BigInt()`. Sprint 11 backlog.

### 10-L-02 — Number() precision loss em estimativa MEV (P71)
**Severidade:** LOW
**Ficheiro:** `mev-savings.ts` L62
**Descrição:** `Number((surplusWei * 10_000n) / median)` pode perder precisão se o resultado exceder `Number.MAX_SAFE_INTEGER` (2^53). Teoricamente possível com tokens de supply elevado (e.g., SHIB).
**Impacto:** Percentagem de MEV savings ligeiramente imprecisa no display. Puramente cosmético.
**Recomendação:** Aceitar como limitação conhecida. Documentar no código.

### 10-L-03 — Test gap: V1 FeeCollector em scanContractEvents (P74)
**Severidade:** LOW
**Ficheiro:** `on-chain-monitor.test.ts` L250-258
**Descrição:** Os testes de `scanContractEvents` e `runOnChainScan` apenas mockam 2 das 3 chamadas `getLogs`. A terceira (V1 FeeCollector) retorna `[]` silenciosamente. Os testes unitários de classificação cobrem V1, mas não há teste end-to-end de V1 logs a fluir pelo pipeline completo.
**Impacto:** Um bug no merge de V1 logs poderia passar despercebido.
**Recomendação:** Adicionar teste que mocka 3 `getLogs` com V1 log incluído. Sprint 11 backlog.

### 10-L-04 — Silent catch em maybeElevateFeeEvent (pré-existente, relevante para P74)
**Severidade:** LOW
**Ficheiro:** `on-chain-monitor.ts` L191-193
**Descrição:** O catch block engole erros sem logging. Um log malformado que cause parsing error mantém o evento em 'info' em vez de elevar para 'warning', potencialmente falhando um alerta de fee elevado.
**Impacto:** Alerta de fee > 1 ETH pode ser silenciado. Não afecta fundos.
**Recomendação:** Adicionar `console.warn` no catch. Sprint 11 backlog.

### 10-I-01 — ADR-006 listado como "proposed" mas política já enforced
**Severidade:** INFO
**Ficheiro:** `SIGNED-COMMITS.md` L207
**Descrição:** O runbook referencia ADR-006 como "proposed", mas CLAUDE.md rule 12 já enforce signed commits. Inconsistência documental.
**Recomendação:** Promover ADR-006 para "Accepted".

### 10-I-02 — Break-glass re-enable não automatizado
**Severidade:** INFO
**Ficheiro:** `SIGNED-COMMITS.md` L192-199
**Descrição:** O procedimento break-glass desactiva temporariamente signed commits com window "< 60 segundos", mas depende de disciplina humana para re-activar. Sem mecanismo automático de re-enable ou alerta se ficar desactivado.
**Recomendação:** Considerar GitHub Action que verifica branch protection settings periodicamente. Phase 2/backlog.

### 10-I-03 — DocsPage: claim sobre conditional orders via CoW
**Severidade:** INFO
**Ficheiro:** `DocsPage.tsx` L427-432
**Descrição:** A documentação afirma que limit orders, stop-loss e take-profit "executam por este path por defeito" (CoW). Deve ser verificado contra o order engine para confirmar que não existe fallback para execução pública.
**Recomendação:** Verificar OrderExecutor code path para conditional orders. Se houver fallback, actualizar documentação.

---

## Análise por Prompt

### P69 — CLAUDE.md + SIGNED-COMMITS.md (6196b87)
**Ficheiros:** CLAUDE.md, docs/Runbooks/SIGNED-COMMITS.md
**Avaliação:** Runbook bem estruturado — SSH signing (recomendado) + GPG, verificação, troubleshooting, break-glass com incident report obrigatório. Branch protection com 16 regras, admin bypass OFF. Motivado pelo CVE-2026-3854 (Wiz RCE). Nenhum problema de segurança.
**Resultado:** PASS

### P70 — Smart MEV routing (362df83)
**Ficheiros:** SwapBox.tsx, QuoteBreakdown.tsx, constants.ts
**Avaliação:** Lógica de auto-prefer CoW quando dentro de 0.3% do best price. BigInt arithmetic correcta — guards contra division-by-zero (`bestAmount > 0n && cowAmount > 0n`), threshold convertido via `Math.round` antes de `BigInt()`. `clampSlippage` verificado: clamp [0.01, 15], impossível produzir slippageFactor ≤ 0. UI-only — não altera calldata nem fund flows.
**Resultado:** PASS

### P71 — MEV surplus display + analytics (8220b3b)
**Ficheiros:** mev-savings.ts, useSwap.ts, cow.ts, analytics.ts, log-swap/route.ts, improvements.sql
**Avaliação:** Estimativa pre-swap via mediana BigInt de quotes não-CoW. Surplus actual via `executedBuyAmount` da CoW trades API, com try/catch e clamp a 0n. Campos `mev_savings_estimate` e `mev_savings_actual` como `NUMERIC(78,0)` (cabe uint256). Supabase parameterizado — zero SQL injection risk. `swaps` RLS activo (schema.sql L115). Analytics fire-and-forget, never blocks swap. Findings 10-L-01 e 10-L-02 são cosméticos.
**Resultado:** PASS

### P72 — ERC-7730 clear signing (06da23a)
**Ficheiros:** docs/erc7730/teraswap-feecollector-v2.json
**Avaliação:** JSON schema v1 conforme spec. `routerData` correctamente em `excluded` (opaque bytes, não representável no Secure Screen). `minimumOutput` formatado como `tokenAmount` com `tokenPath: "tokenOut"` — correcto. Deployment address matches V2 (`0x47f2...7459`). `nativeCurrencyAddress` uses zero-address convention. ABI inclui `InsufficientOutput` error (H-04). Sem problemas.
**Resultado:** PASS

### P73 — DocsPage MEV section (c73fa8d)
**Ficheiros:** DocsPage.tsx
**Avaliação:** Documentação honesta — disclosure explícito de que swaps on-chain directos (Uniswap V3, Curve, Balancer, SushiSwap) NÃO são MEV-protected. "We don't claim zero MEV" é a postura correcta. Sem `dangerouslySetInnerHTML`, sem XSS vectors. Finding 10-I-03 é documental.
**Resultado:** PASS

### P74 — On-chain monitor V1/V2 topic fix (afc42ae)
**Ficheiros:** on-chain-monitor.ts, on-chain-monitor.test.ts
**Avaliação:** Fix correcto para 9B-I-01. V2 `SwapWithFee` (7 params) e V1 `SwapWithFeeV1` (5 params) agora têm topic hashes distintos. Teste confirma `TOPICS.SwapWithFee !== TOPICS.SwapWithFeeV1`. V1 logs merged com V2 e processados por `classifyFeeCollectorEvent`. Data layout compatibility confirmada (V1/V2 primeiros 3 slots idênticos para fee elevation). Finding 10-L-03 é test gap, não bug.
**Resultado:** PASS

---

## Padrões de Segurança Positivos Observados

1. **BigInt arithmetic** em todo o pipeline de MEV savings — sem floating-point para cálculos de tokens
2. **Pre-swap simulation** via `eth_call` antes do wallet prompt
3. **Receiver validation** tanto no standard swap (calldata) como no CoW flow (order params)
4. **Router + selector whitelisting** + calldata size bounds (10B–100KB)
5. **Fee integrity validation** (blocking em produção)
6. **Chainlink oracle deviation blocking** multi-tier
7. **CoW order `validTo` capped** a 30 minutos
8. **Supabase parameterised queries** — zero raw SQL
9. **Fire-and-forget analytics** — nunca bloqueia o swap flow
10. **`_inSwap` guard** no `receive()` — previne ETH deposits acidentais
11. **`clampSlippage` [0.01, 15]** — impossível produzir minBuyAmount ≤ 0

---

## Residuais Conhecidos (backlog)

| ID | Sev | Origem | Descrição | Target |
|----|-----|--------|-----------|--------|
| 10-L-01 | LOW | P70/P71 | BigInt() render crash | Sprint 11 |
| 10-L-02 | LOW | P71 | Number() precision loss | Documentar |
| 10-L-03 | LOW | P74 | V1 e2e test gap | Sprint 11 |
| 10-L-04 | LOW | P74 | Silent catch em fee elevation | Sprint 11 |
| SC-02 | LOW | Sprint 6 | DCA dust acumulação | Phase 2 |
| FE-01 | LOW | Sprint 7 | localStorage → Web Crypto V2 | Phase 2 |
| cow.ts:133 | LOW | Pré-existente | `orderParams: any` type safety | Sprint 11 |

---

## Veredicto Final

| Severidade | Count |
|------------|-------|
| CRITICAL   | 0     |
| HIGH       | 0     |
| MEDIUM     | 0     |
| LOW        | 4     |
| INFO       | 3     |

### APPROVED — 0C / 0H / 0M

Sprint 10 está limpo para merge. Os 4 LOW são cosméticos ou test gaps sem impacto em fundos. Os 3 INFO são melhorias documentais.

**Preocupações para Sprint 11 (Public API):**
1. **10-L-01** deve ser resolvido antes de public API — se a API expõe quotes a third parties, `toAmount` malformado de sources externas torna-se mais provável.
2. **cow.ts `orderParams: any`** — com public API, type safety no CoW submission payload torna-se mais crítico para prevenir field omission.
3. **`amountInUsd` client-controlled** (route.ts L97) — se public API permite submissão de swaps, o monitoring bypass torna-se um vector real. Server-side USD computation recomendado.
4. **Alert loss on double failure** (on-chain-monitor) — com mais tráfego via public API, a probabilidade de perder um alerta crítico aumenta. Considerar retry queue.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-11*
