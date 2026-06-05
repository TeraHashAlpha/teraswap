# Auditoria Sprint 25F — Fee Integrity False-Positive Fix

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-20
**Scope:** 1 commit no branch `fix/fee-integrity-false-positive`
**Baseline:** Sprints 25C–25E merged via PR #77. 824 running + 19 skipped = 843 TS tests.
**Commit:**
- `0143839` — fix(swap): gate fee integrity check on FEE_NATIVE_SOURCES, not routeViaFeeCollector [P156]

**PR:** #78
**Ficheiros:** 3 files, +117/−28 lines (net +89)
**Testes:** 2 novos (regression + invariant pin). Total: 826 running + 19 skipped = 845.

---

## Resumo Executivo

O guard M-01 de fee integrity no `useSwap.ts` usava `!routeViaFeeCollector` para decidir quando correr `validateFeeIntegrity`. Após Sprint 25D expandir `FEE_INCOMPATIBLE_SOURCES` para todas as 11 sources, `routeViaFeeCollector` é `false` para cada swap — o que significava que o check corria sempre, produzindo falsos positivos em routes com volatilidade normal (~2% no swap output vs quote output).

P156 substitui o guard por `FEE_NATIVE_SOURCES.includes(source)` — o check só corre para sources que aplicam fee via API (partner-fee model). Como `FEE_NATIVE_SOURCES = []`, o check é inerte para todas as sources actuais. Adicionar uma source à lista automaticamente re-arma o check.

A função `validateFeeIntegrity()` em `api.ts` é inalterada. As constantes `FEE_NATIVE_SOURCES` e `FEE_INCOMPATIBLE_SOURCES` são inalteradas. O diff é puramente guard logic + tests.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 1 INFO**

Zero impacto em contratos ou fund flows. Pure client-side guard change.

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
| `validateFeeIntegrity()` alterada? | **Não** | Zero diff em `api.ts` |
| `FEE_NATIVE_SOURCES` alterada? | **Não** | Zero diff em `constants.ts` |
| `FEE_INCOMPATIBLE_SOURCES` alterada? | **Não** | Zero diff em `constants.ts` |
| FEEDBACK.md alterado? | **Não** | |

---

## Findings

### 25F-I-01 — Check inerte pode ser esquecido ao adicionar partner-fee source

**Severidade:** INFO
**Ficheiro:** `src/hooks/useSwap.ts` L343
**Descrição:** Com `FEE_NATIVE_SOURCES = []`, o guard `FEE_NATIVE_SOURCES.includes(source)` é sempre `false` — o check nunca corre. Quando uma source for adicionada a `FEE_NATIVE_SOURCES` (e.g., re-enablement de partner-fee mode), o check automaticamente re-arma. O risco é que o dev que adiciona a source não teste o fee integrity path. Mitigação: o test em `swap-validations.test.ts` pin (`FEE_NATIVE_SOURCES is empty today`) falharia se a lista mudar sem que a cobertura acompanhe — mas isto é um guardrail indirecto.
**Recomendação:** Aceitar como is. O pin test (`expect(FEE_NATIVE_SOURCES).toEqual([])`) garante que qualquer mudança na lista obriga revisão do test file. O comment block de 25 linhas no `useSwap.ts` documenta o 3-mode model com clareza suficiente para guiar o dev futuro.

---

## Análise Detalhada

### useSwap.ts — Guard Change

**Antes:**
```typescript
if (quoteToAmount && !routeViaFeeCollector) {
  const feeCheck = validateFeeIntegrity(...)
```

**Depois:**
```typescript
const usesPartnerFee = FEE_NATIVE_SOURCES.includes(source)
if (quoteToAmount && usesPartnerFee) {
  const feeCheck = validateFeeIntegrity(...)
```

**Análise dos 3 modos:**

| Modo | Condição antes | Condição depois | Correcto? |
|------|---------------|-----------------|-----------|
| 1. FeeCollector routing | `routeViaFeeCollector=true` → skip | `usesPartnerFee=false` → skip | ✓ FeeCollector source nunca está em FEE_NATIVE_SOURCES |
| 2. Partner fee (API) | `routeViaFeeCollector=false` → run | `usesPartnerFee=true` → run | ✓ Correcto — é o caso para o qual o check foi desenhado |
| 3. No fee (incompatible) | `routeViaFeeCollector=false` → **run (BUG)** | `usesPartnerFee=false` → skip | ✓ Fix — era aqui o falso positivo |

**Import adicionado:**
- `FEE_NATIVE_SOURCES` de `@/lib/constants`. ✓
- `WETH_ADDRESS` e `type AggregatorName` já importados. ✓

**Comment block (25 linhas):**
- Documenta 3 modos com exemplos. ✓
- Explica porquê o guard anterior falhava. ✓
- Documenta que o check é inerte com `FEE_NATIVE_SOURCES = []`. ✓
- Documenta auto-rearm. ✓

**`validateFeeIntegrity` call inalterado:**
- Mesmos argumentos: `quoteToAmount, swapData.toAmount, source`. ✓
- Mesma lógica de bloqueio: `if (!feeCheck.valid)` → throw. ✓

### swap-validations.test.ts — 3-Case Refactor

**Tests A4b refactored (6 tests → 6 tests, 2 novos conceitos):**

| Test | Assertion | Status |
|------|-----------|--------|
| FeeCollector route + non-partner → SKIPS | `ran=false, valid=true` | ✓ |
| Source in FEE_NATIVE_SOURCES → RUNS | `ran=true, valid=true` (990000 vs 1000000) | ✓ |
| Source in FEE_NATIVE_SOURCES + suspicious → FAILS | `ran=true, valid=false` (1100000 vs 1000000) | ✓ |
| Source NOT in FEE_NATIVE_SOURCES → SKIPS **(novo — regression)** | `ran=false, valid=true` (1025000 vs 1000000, +2.5%) | ✓ |
| quoteToAmount=null → SKIPS | `ran=false` | ✓ |
| FEE_NATIVE_SOURCES is empty **(novo — invariant pin)** | `expect([]).toEqual([])` | ✓ |

**`runFeeIntegrityCallSite` helper refactored:**
- Antes: `routeViaFeeCollector: boolean`. ✓
- Agora: `usesPartnerFee: boolean`. ✓
- Lógica: `if (args.quoteToAmount && args.usesPartnerFee)` — espelha o guard de produção. ✓

**Regression test (caso 3 — o false-positive):**
- `source: 'kyberswap'`, `swapToAmount: '1025000'` (+2.5% vs quote 1000000). ✓
- Antes (guard antigo): correria e falharia (>2% tolerance). Agora: skip. ✓

**Invariant pin:**
- `expect(FEE_NATIVE_SOURCES).toEqual([])` — importa a constante real. ✓
- Se alguém adicionar uma source, este test falha → obriga revisão. ✓

### useSwap.test.ts — Mock de FEE_NATIVE_SOURCES

```typescript
vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<typeof import('@/lib/constants')>('@/lib/constants')
  return {
    ...actual,
    FEE_NATIVE_SOURCES: ['1inch'],
  }
})
```

**Análise:**
- `vi.importActual` preserva todas as exports reais. ✓
- Apenas `FEE_NATIVE_SOURCES` é overridden com `['1inch']`. ✓
- O test existente "blocks the swap when validateFeeIntegrity fails" usa source `'1inch'` — com o mock, `FEE_NATIVE_SOURCES.includes('1inch')` = `true` → o guard corre → o test exerce o validator wiring. ✓
- Sem o mock, `FEE_NATIVE_SOURCES = []` → guard skip → test nunca exerceria o validator. ✓
- Comment explica a razão do mock e referencia o invariant pin no outro test file. ✓

**Posição do mock:**
- Declarado ANTES dos imports que usam `@/lib/constants` (vitest hoists `vi.mock`). ✓

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Apenas 3 ficheiros alterados | **Confirmado** — `useSwap.ts`, `swap-validations.test.ts`, `useSwap.test.ts` |
| Zero ficheiros inesperados | **Confirmado** |
| `validateFeeIntegrity()` em `api.ts` inalterada | **Confirmado** — zero diff em `api.ts` |
| `FEE_NATIVE_SOURCES` em `constants.ts` inalterada | **Confirmado** — zero diff em `constants.ts` |
| `FEE_INCOMPATIBLE_SOURCES` inalterada | **Confirmado** — zero diff |
| Zero secrets ou env vars alterados | **Confirmado** |
| FEEDBACK.md não modificado | **Confirmado** |
| Guard mirrors production logic in test helper | **Confirmado** — `runFeeIntegrityCallSite` usa `usesPartnerFee` |
| Mock preserva todas as exports excepto `FEE_NATIVE_SOURCES` | **Confirmado** — `vi.importActual` + spread |
| Regression test cobre o false-positive shape | **Confirmado** — kyberswap, +2.5% |
| Invariant pin cobre `FEE_NATIVE_SOURCES = []` | **Confirmado** — `expect([]).toEqual([])` |
| 826 running + 19 skipped = 845 total | **Confirmado** — 2 tests novos vs baseline 843 |
| Spec compliance (SPRINT-25F.md) | **Confirmado** |

---

## Spec Compliance

| Requirement | Status |
|-------------|--------|
| Guard: `FEE_NATIVE_SOURCES.includes(source)` | ✓ |
| `FEE_NATIVE_SOURCES` imported from constants | ✓ |
| `validateFeeIntegrity` body untouched | ✓ |
| `FEE_NATIVE_SOURCES` constant untouched | ✓ |
| `FEE_INCOMPATIBLE_SOURCES` untouched | ✓ |
| Tests cover 3 modes: FeeCollector, partner-fee, incompatible | ✓ |
| 826 pass + 19 skip = 845 total | ✓ |

Zero spec deviations.

---

## Veredicto Final

| Severidade | Count |
|------------|-------|
| CRITICAL   | 0     |
| HIGH       | 0     |
| MEDIUM     | 0     |
| LOW        | 0     |
| INFO       | 1     |

### APPROVED — 0C / 0H / 0M / 0L

P156 resolve cirurgicamente o falso positivo de fee integrity causado pela expansão de `FEE_INCOMPATIBLE_SOURCES` no Sprint 25D. O novo guard `FEE_NATIVE_SOURCES.includes(source)` restringe correctamente o check ao único modo onde faz sentido (partner-fee via API). O check é inerte com a lista vazia e auto-rearms ao adicionar sources. O regression test documenta o shape exacto do falso positivo (+2.5% swap output em kyberswap). O invariant pin garante que mudanças na lista obrigam revisão. Zero impacto em contratos, fund flows, ou `validateFeeIntegrity()`.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-20*
