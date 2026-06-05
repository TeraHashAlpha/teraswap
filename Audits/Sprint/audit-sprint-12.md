# Auditoria Sprint 12 — 11-L Closure Sweep

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-13
**Scope:** 4 commits — P90 (bce6132), P91 (be8fdf8), P92 (5fdb355), P93 (5ee711c)
**Baseline:** Sprint 11.5 APPROVED (0C/0H/0M/0L, 2026-05-13). 521 tests.
**Testes:** 538/538 passing (+17 novos)

---

## Resumo Executivo

Sprint 12 fecha os 4 findings LOW remanescentes do backlog do Sprint 11: 11-L-01 (bare BigInt sweep em SwapBox/split-router/useSplitRoute), 11-L-02 (cow.ts validator ordering), 11-L-03 (quoteMeta `Record<string, any>` → discriminated union), e 11-L-05 (admin rate limit caps). Não há alterações a contratos, fund flows, ou endpoints existentes. Após este sprint, o backlog do Sprint 11 está a **ZERO**.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 2 INFO**

Sprint limpo. Todas as alterações são correctas, well-tested, e fecham exactamente o que prometem.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | Zero ficheiros em `contracts/` alterados. |
| Fund flows alterados? | **Não** | |
| Novos endpoints? | **Não** | |
| Novos secrets/env vars? | **Não** | |
| Dependências adicionadas? | **Não** | |
| RLS impactado? | **Não** | |
| CI alterado? | **Não** | |
| Testes: 538/538 | **Sim** | +17 (7 split-router, 4 cow, 6 admin api-keys) |
| Build limpo? | **Sim** | |

---

## Findings

### 12-I-01 — safeBigInt fallbacks diferem por contexto (by design)

**Severidade:** INFO
**Ficheiros:** `SwapBox.tsx`, `split-router.ts`, `useSplitRoute.ts`
**Descrição:** Os 19 sites migrados usam fallbacks diferentes consoante o contexto: `"—"` para display, `null` para skip-logic, `0n` para comparações aritméticas, `?? 0n` para sort. Isto é correcto e intencional — um fallback uniforme seria errado — mas a diversidade exige que futuras migrações escolham o fallback consciente e documentem a razão.
**Recomendação:** Aceitar como is. Documentar num comentário inline se surgir um 20º site.

### 12-I-02 — MAX_RATE_LIMIT_PER_DAY (1M) é generoso

**Severidade:** INFO
**Ficheiro:** `src/app/api/admin/api-keys/route.ts` L36
**Descrição:** O cap de 1.000.000 requests/dia é ~694/min sustentado. Para o tier `free` (default 100/dia) isto é 10.000× acima do default. O cap existe como protecção contra typos, não como rate-limit operacional, portanto o valor generoso é aceitável — mas se novos tiers forem adicionados, o cap deve ser reavaliado.
**Recomendação:** Aceitar como is. Reavaliar se/quando se adicionar um tier `enterprise`.

---

## Análise por Prompt

### P90 (bce6132) — safeBigInt sweep: SwapBox, split-router, useSplitRoute [11-L-01]

**Resultado:** PASS

**Verificações:**
- **SwapBox.tsx — 11 sites migrados:**
  - L122-132: MEV promotion — `safeBigInt(rawMeta.best.toAmount)` + null guard → skip MEV suggestion. **Correcto.**
  - L174-178: execution price — null fallback → skip computation. **Correcto.**
  - L271-278: swap success toast — null → `"—"` display. **Correcto.**
  - L377-383: output display — null → `"—"`. **Correcto.**
  - L418-422: exact-out estimation — null → skip. **Correcto.**
  - L775-780: share button — null → hide button. **Correcto.**
  - L854-858: swap preview — null → `"—"`. **Correcto.**
  - Restantes 4 sites em blocos de comparação/sort — `?? 0n`. **Correcto.**
- **split-router.ts — 7 sites migrados:**
  - L32: `safeBigInt(totalAmount)` com null → return empty map. **Correcto** — sem amount, sem routing.
  - L64: `safeBigInt(pct)` com null → skip percentage. **Correcto.**
  - L98, L126, L141, L178: comparações route — `?? 0n`. **Correcto** — 0n é o fallback seguro para < / > comparisons.
  - L247: leg output — `?? 0n`. **Correcto.**
- **useSplitRoute.ts — 1 site:**
  - L51: `safeBigInt(meta.best.toAmount)` com null → outAmount 0. **Correcto.**
- **split-router.test.ts — 7 testes novos:** Cobrem graceful-NaN, invalid-string, zero-amount, 2-way split, single-route, empty-quotes, valid-percentage. **Cobertura adequada.**
- **Verificação residual:** `grep -rn 'BigInt(' SwapBox.tsx split-router.ts useSplitRoute.ts` excluindo safeBigInt — **ZERO resultados.** Sweep completo.

### P91 (be8fdf8) — cow.ts validator ordering [11-L-02]

**Resultado:** PASS

**Verificações:**
- **Ordering fix:** `parseCowOrderParams()` agora executa ANTES de `BigInt(quote.buyAmount)`. Antes, um `buyAmount` malformed (e.g., `"abc"`) causava `SyntaxError` não-tagged. Agora, o validator rejeita-o com um erro descritivo primeiro. **Correcto.**
- **buyAmount validation:** O validator agora inclui check de shape para `buyAmount` como decimal-uint string via regex. **Correcto.**
- **safeBigInt usage:** Após validação, `safeBigInt(quote.buyAmount)` usado para a conversão. Belt-and-suspenders. **Correcto.**
- **Spread ordering:** `cowOrderParams` spread primeiro, `buyAmount` com slippage-adjusted value no final — override correcto. **Correcto.**
- **cow.test.ts — 4 testes novos:** 3 malformed-input tests (buyAmount `"abc"`, missing sellToken, invalid feeAmount) + 1 happy path. O teste crítico: malformed buyAmount produz tagged error, NÃO `SyntaxError`. **Correcto e pinned.**

### P92 (5fdb355) — quoteMeta discriminated union [11-L-03]

**Resultado:** PASS

**Verificações:**
- **types.ts refactor:** `QuoteMeta = CowQuoteMeta | UniswapV3QuoteMeta | GenericQuoteMeta`, discriminado por campo `source`. **Correcto.**
  - `CowQuoteMeta`: `source: 'cow'`, typed fields (quoteId, sellToken, buyToken, etc.)
  - `UniswapV3QuoteMeta`: `source: 'uniswap-v3'`, typed fields (route, sqrtPriceX96, etc.)
  - `GenericQuoteMeta`: `[key: string]: unknown` (NÃO `any`). **Correcto** — `unknown` força narrowing.
- **SwapParams.quoteMeta:** `quoteMeta?: QuoteMeta` substituindo `Record<string, any>`. **Correcto.**
- **Cast removal:** `as Record<string, any>` removido de `api.ts`. **Confirmado** via grep — zero ocorrências remanescentes.
- **uniswapv3.ts narrowing:** Usa discriminador `source` para narrow para `UniswapV3QuoteMeta`. **Correcto.**
- **Zero testes novos:** Refactor puramente type-level. TypeScript compiler é o teste — `tsc --noEmit` clean. **Aceitável.**

### P93 (5ee711c) — Admin rate limit caps [11-L-05]

**Resultado:** PASS

**Verificações:**
- **Constants:** `MAX_RATE_LIMIT_PER_MIN = 10_000`, `MAX_RATE_LIMIT_PER_DAY = 1_000_000`. Definidos como module-level constants, não magic numbers inline. **Correcto.**
- **Cap logic:** A validação existente (`typeof === 'number' && Number.isInteger && > 0`) agora inclui `<= MAX_*`. Quando excedido, o valor cai para o tier default — não rejeita o request. **Correcto** — fail-soft para typos.
- **Warnings array:** Construído condicionalmente. Só incluído no response quando não-vazio (`...(warnings.length > 0 ? { warnings } : {})`). **Correcto** — não polui responses normais.
- **Warning messages:** Textuais, incluem o cap value. Admin vê exactamente o que aconteceu. **Correcto.**
- **Error hygiene:** O catch block existente já foi sanitizado por 11-M-02 (Sprint 11). Sem regressão. **Confirmado.**
- **route.test.ts — 6 testes novos:**
  - Over-cap min (50000 → tier default + warning). **Correcto.**
  - Over-cap day (2000000 → tier default + warning). **Correcto.**
  - Under-cap (100 → aceite as-is, no warning). **Correcto.**
  - Boundary (10000 → aceite as-is, no warning). **Correcto** — `<=` não `<`.
  - Abuse (999999999 → fallback + warning). **Correcto.**
  - Combined (both over-cap → 2 warnings). **Correcto.**

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Zero contract changes | **Confirmado** — `git diff -- contracts/` vazio |
| Zero fund flow changes | **Confirmado** — nenhum adapter fund path alterado |
| Zero novos endpoints | **Confirmado** — nenhum `route.ts` criado |
| Zero novas env vars | **Confirmado** |
| Zero dependências adicionadas | **Confirmado** — `package.json` não alterado |
| Zero bare BigInt() em SwapBox/split-router/useSplitRoute | **Confirmado** — grep retorna zero |
| Zero `Record<string, any>` em types.ts | **Confirmado** — grep retorna zero |
| Zero `as Record<string, any>` em adapters/ e api/ | **Confirmado** — grep retorna zero |
| Sprint 11 backlog at ZERO | **Confirmado** — 11-L-01 ✓, 11-L-02 ✓, 11-L-03 ✓, 11-L-05 ✓ |
| 538 testes passing | **Confirmado** (+17: 7 split-router + 4 cow + 6 admin api-keys) |

---

## Sprint 11 Backlog Status

| Finding | Descrição | Fix Prompt | Status |
|---------|-----------|------------|--------|
| 11-L-01 | Bare BigInt sweep (SwapBox, split-router, useSplitRoute) | P90 (bce6132) | **CLOSED** |
| 11-L-02 | cow.ts validator ordering | P91 (be8fdf8) | **CLOSED** |
| 11-L-03 | quoteMeta `Record<string, any>` → discriminated union | P92 (5fdb355) | **CLOSED** |
| 11-L-05 | Admin rate limit caps | P93 (5ee711c) | **CLOSED** |

**Backlog Sprint 11: 0 open / 4 closed.**

---

## Veredicto Final

| Severidade | Count |
|------------|-------|
| CRITICAL   | 0     |
| HIGH       | 0     |
| MEDIUM     | 0     |
| LOW        | 0     |
| INFO       | 2     |

### APPROVED — 0C / 0H / 0M / 0L

Sprint 12 está limpo para merge. Os 4 findings LOW do Sprint 11 estão todos correctamente fechados. Cada fix é cirúrgico, well-tested, e não introduz side effects. O sweep de bare BigInt é completo (19 sites, zero residuais). O discriminated union elimina `any` do type system dos adapters. O validator ordering no cow.ts previne erros não-tagged. Os rate limit caps protegem contra typos admin sem bloquear operação normal.

Contagem cumulativa de testes: **538** (521 Sprint 11.5 + 17 Sprint 12).

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-13*
