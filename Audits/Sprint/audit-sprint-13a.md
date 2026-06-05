# Auditoria Sprint 13A — Gasless Swaps

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-13
**Scope:** 4 commits — P94 (2b3d0b6), P95 (cf22a09), P96 (ed2eeac), P97 (1f03684)
**Baseline:** Sprint 12 APPROVED (0C/0H/0M/0L, 2026-05-13). 538 tests.
**Testes:** 550/550 passing (+12 novos)

---

## Resumo Executivo

Sprint 13A introduz a primeira feature user-facing desde o Sprint 11 (Public API): detecção e promoção de gasless swaps via CoW Protocol. Inclui um motor de recomendação puro (P94), UX de promoção em 3 componentes (P95), tracking em Supabase com migration backwards-compatible (P96), e exposição nos endpoints públicos v1/quote e v1/swap (P97).

Nenhum contrato é alterado. Nenhum fund flow é alterado — a decisão gasless é uma sugestão de routing, não uma mudança no pipeline de execução. O motor reutiliza `safeBigInt` e o mecanismo Force MEV Protection existente.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 2 LOW / 2 INFO**

Os 2 LOW são melhorias de performance e integridade de dados agregados — não bloqueiam deploy mas devem ser endereçados no Sprint 13B.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | Zero ficheiros em `contracts/` alterados. |
| Fund flows alterados? | **Não** | Gasless é sugestão de routing, não alteração ao pipeline. |
| Novos endpoints? | **Não** | Campos adicionados a v1/quote e v1/swap existentes. |
| Novos secrets/env vars? | **Não** | |
| Dependências adicionadas? | **Não** | |
| RLS impactado? | **Não** | Colunas adicionadas a `swaps` (RLS já activo). |
| CI alterado? | **Não** | |
| Migration backwards-compatible? | **Sim** | `DEFAULT false/0`, `IF NOT EXISTS`, idempotent backfill. |
| Testes: 550/550 | **Sim** | +12 (9 gasless-engine, 2 v1/quote, 3 v1/swap — nota: 2 existentes em v1/swap cobrem gasless rejection path) |
| Build limpo? | **Sim** | |

---

## Findings

### 13A-L-01 — `/api/stats` fetches all gasless rows to sum client-side

**Severidade:** LOW
**Ficheiro:** `src/app/api/stats/route.ts` L63-72
**Descrição:** O comentário a L53 diz "Use SQL aggregates" mas L63-72 faz `.select('gas_savings_usd')` sem `head: true`, puxando todos os rows gasless para somar em Node via `.reduce()`. O `COUNT(*)` a L57-61 usa `head: true` correctamente (single round-trip), mas o SUM não. À medida que a tabela `swaps` crescer, esta query vai:
- Transferir N rows × 1 coluna (overhead de rede + parsing)
- Consumir memória no serverless handler proporcional ao número de swaps gasless
- Aumentar latência do endpoint `/api/stats`

**Impacto:** Performance. Não é um bug de segurança, mas num serverless com 128MB default pode causar OOM a longo prazo.
**Recomendação:** Usar Supabase RPC com `SELECT SUM(gas_savings_usd) FROM swaps WHERE is_gasless = true AND (status = 'confirmed' OR (status = 'pending' AND tx_hash IS NOT NULL))`. Alternativa: criar uma view materializada.

### 13A-L-02 — `gas_savings_usd` é client-provided e apenas clamped

**Severidade:** LOW
**Ficheiro:** `src/app/api/log-swap/route.ts` L128-133
**Descrição:** O campo `gas_savings_usd` é enviado pelo client e clamped a `[0, 10000]` no server. O `is_gasless` é correctamente derivado server-side de `source === 'cowswap'` (não trust no client). No entanto, `gas_savings_usd` depende do client — um client malicioso pode enviar `gasSavingsUsd: 9999` em cada CoW swap, inflacionando os totais agregados que aparecem no dashboard ("Total Gas Saved") e no `/api/stats`.

**Mitigação existente:** O clamp a $10K previne valores extremos. O campo só é aceite para `source === 'cowswap'` (L128), o que requer um swap real.

**Impacto:** Integridade de dados agregados. Os totais de "gas savings" no dashboard e API stats são advisory (não financeiros), mas se publicados externamente podem ser inflacionados.

**Recomendação:** Validar server-side contra o gas price corrente (via Chainlink ETH/USD feed já disponível) × estimated gas do best non-CoW route. Alternativamente, derivar `gas_savings_usd` inteiramente server-side na `/api/log-swap` usando o adapter gasUsd do meta-quote cached.

### 13A-I-01 — BigInt→Number precision loss em percentage calc

**Severidade:** INFO
**Ficheiro:** `src/lib/gasless-engine.ts` L108-109
**Descrição:** `Number(cowAmt - nonCowAmt) / Number(nonCowAmt)` converte BigInt para Number para calcular percentagem. Para amounts > 2^53 wei (~9007 ETH, ~$22M ao preço actual), a subtração perde precisão. O resultado é usado apenas para a recommendation flag (threshold de 50 bps), não para fund amounts, portanto o impacto é uma possível recomendação incorrecta em swaps muito grandes.
**Recomendação:** Aceitar como is. Swaps >$22M são raros e a recommendation é advisory. Se necessário no futuro, computar `(cowAmt * 10000n) / nonCowAmt` inteiramente em BigInt.

### 13A-I-02 — "Use Gasless Route" é um toggle sticky

**Severidade:** INFO
**Ficheiro:** `src/components/SwapBox.tsx` L621
**Descrição:** `onUseGasless={() => setMevProtected(true)}` activa o Force MEV Protection toggle, que persiste para swaps subsequentes (mesmo após mudar tokens). O comportamento é idêntico a clicar manualmente no toggle — o estado é visível na UI e o utilizador pode desactivá-lo. Não é um bug, mas um utilizador que clicou "Use Gasless Route" pode não perceber que o MEV toggle ficou activo para swaps futuros.
**Recomendação:** Aceitar como is. O toggle é visível. Opcionalmente, adicionar um toast "MEV Protection enabled — you can toggle it off anytime" quando activado via gasless CTA.

---

## Análise por Prompt

### P94 (2b3d0b6) — Gasless recommendation engine [gasless-engine.ts]

**Resultado:** PASS

**Verificações:**
- **Pure function:** `analyzeGasless(quotes, estimatedGasUsd)` — zero side effects, zero imports de estado global. Callable de hooks, API routes, e testes. **Correcto.**
- **safeBigInt usage:** Todos os `toAmount` convertidos via `safeBigInt()`, com null guards que retornam `EMPTY` ou skip. **Correcto.** Zero bare `BigInt()`.
- **Thresholds:**
  - `GASLESS_PRICE_THRESHOLD_BPS = 50` (0.5%) — CoW é recomendado quando está até 50 bps abaixo do melhor non-CoW. **Razoável** — o CoW solver spread típico é 20-50 bps, e o gas saving compensa o gap.
  - `GASLESS_MIN_SAVINGS_USD = 0.5` — abaixo deste valor, a poupança não é publicitada. **Razoável** — previne claims de "$0.02 gas savings" que seriam noise.
- **Net-positive logic:** Quando CoW está abaixo do best non-CoW mas dentro do threshold, recomenda se gas savings ≥ $0.50. A lógica NÃO tenta comparar USD-value do gap contra gas savings (seria impreciso sem preço do token de output). Em vez disso, usa o threshold como proxy conservativo. **Correcto e honesto.**
- **Edge cases cobertos:** CoW-only (recommended, "only route"), no CoW (unavailable), malformed toAmount (unavailable), zero gas estimate (fallback to adapter gasUsd). **9 testes, cobertura completa.**
- **EMPTY constant:** Spread com `{ ...EMPTY }` para evitar mutação. **Correcto.**
- **Exported constants:** `GASLESS_PRICE_THRESHOLD_BPS` e `GASLESS_MIN_SAVINGS_USD` são importados pelos testes para validar boundary conditions. **Bom para manutenção.**

**Integração em useQuote:**
- `estimateGasCost` vem de `useEthGasCost` (hook existente) para usar preço ETH fresco.
- `refGasUsd` = caller estimate ?? adapter gasUsd ?? 0. Fallback chain correcta.
- `estimateGasCost` adicionado ao dependency array do `useEffect`. **Correcto** — evita stale gas estimates.

### P95 (cf22a09) — Gasless UX overlay

**Resultado:** PASS

**Verificações:**
- **QuoteBreakdown — 2 layouts:**
  - CTA card (`showGaslessCard`): renderiza quando `gasless.recommended && !bestIsIntent` (i.e., CoW recomendado mas não seleccionado). Inclui botão "Use Gasless Route" com `onUseGasless` callback. **Correcto.**
  - Confirmation banner (`showGaslessConfirm`): renderiza quando `gasless.recommended && bestIsIntent` (i.e., CoW já seleccionado). Mostra "You're using the gasless route" com savings. **Correcto.**
  - Mutuamente exclusivos (`!bestIsIntent` vs `bestIsIntent`). **Correcto.**
- **"Use Gasless Route" mecanismo:**
  - `onUseGasless={() => setMevProtected(true)}` reutiliza o Force MEV Protection toggle. Quando `mevProtected=true`, SwapBox L103-104 filtra quotes para sources com `mevProtected: true` no `AGGREGATOR_META` — que é CoW. **Correcto e cirúrgico.**
  - Não introduz novo estado, não bypassa validações existentes, não altera o swap pipeline. **Zero side effects de segurança.**
- **TransactionPreview:**
  - Gasless chip: `source === 'cowswap'` hardcoded. **Correcto** — CoW é o único source gasless.
  - Gas fee line: `$0.00 (paid by solver)`. **Factualmente correcto** para CoW Protocol.
- **SwapBox nudge:** Botão abaixo do swap button que faz `scrollIntoView` para o QuoteBreakdown card. Puro UI. **Zero risco.**
- **Savings display:** `gasSavingsUsd.toFixed(2)` — consistente com a engine. Só mostra quando `>= 0.5`. **Correcto.**
- **Accessibility:** `role="region"`, `aria-label` no CTA card, `role="status"` no confirmation banner. **Bom.**

### P96 (ed2eeac) — Supabase tracking + dashboard

**Resultado:** PASS (com 2 LOWs)

**Verificações:**
- **Migration (`20260513_swaps_gasless.sql`):**
  - `ADD COLUMN IF NOT EXISTS` — idempotente. **Correcto.**
  - `is_gasless BOOLEAN NOT NULL DEFAULT false` — backwards-compatible, rows existentes ficam `false`. **Correcto.**
  - `gas_savings_usd NUMERIC(12,4) NOT NULL DEFAULT 0` — tipo correcto para USD amounts, 4 casas decimais. **Correcto.**
  - Partial index `idx_swaps_is_gasless WHERE is_gasless = true` — óptimo para o COUNT query do stats. **Correcto.**
  - Backfill: `UPDATE swaps SET is_gasless = true WHERE source = 'cowswap' AND is_gasless = false` — idempotente, safe para re-run. Gas savings históricos ficam 0 (não podem ser reconstruídos). **Correcto e honesto.**
  - RLS não alterado — a tabela `swaps` já tem RLS activo. Colunas novas herdam as policies existentes. **Confirmado.**

- **`is_gasless` derivation (review focus #3):**
  - Server-side em `/api/log-swap/route.ts` L128: `is_gasless: source === 'cowswap'`. **Server-authoritative.** O campo `source` vem do server swap pipeline, não do client. Um client não pode claim `source: 'cowswap'` sem ter realmente submitting uma CoW order (que requer assinatura EIP-712). **Não spoofável.**

- **`gas_savings_usd` clamping:**
  - L130-133: `Math.max(0, Math.min(Number(gasSavingsUsd), 10_000))`. Só aceite quando `source === 'cowswap'`. **Clamp correcto** mas valor é client-provided (ver 13A-L-02).

- **`/api/stats` gasless metrics:**
  - COUNT usa `head: true` — single round-trip. **Correcto.**
  - SUM fetches all rows (ver 13A-L-01).
  - `gaslessRatio` com divisão-por-zero guard. **Correcto.**
  - `totalGasSavedUsd.toFixed(2)` com `Number()` wrap. **Correcto.**
  - Gasless block sempre presente no response (zero-valued quando sem swaps). **Bom para API stability.**

- **AnalyticsDashboard:**
  - `fetch('/api/stats')` fire-and-forget, failure leaves section hidden. **Correcto — graceful degradation.**
  - `alive` flag para cancel em cleanup. **Correcto.**
  - Gasless section só renderiza quando `totalGaslessSwaps > 0`. **Correcto.**

- **useSwap integration:**
  - Parâmetro `gaslessSavingsUsd` adicionado. Passado apenas para CoW swaps (L711). Fallback `?? 0`. **Correcto.**

### P97 (1f03684) — Public API gasless fields

**Resultado:** PASS

**Verificações:**
- **v1/quote `gasless` block (review focus #4):**
  - `analyzeGasless(quotes, referenceGasUsd)` chamado server-side com `bestNonCow?.gasUsd ?? 0` como referência. Server não tem ETH price live, mas adapter gasUsd é suficiente para hints. **Aceitável.**
  - Campos: `available`, `recommended`, `gasSavingsUsd` (rounded), `priceDifferencePercent`, `reason`. **Sempre presentes, nunca undefined.** Confirmado via teste "gasless.available=false when no CoW quote". **Correcto.**
  - `gasSavingsUsd: Number(gaslessAnalysis.gasSavingsUsd.toFixed(2))` — rounding consistente. **Correcto.**

- **v1/swap fields (review focus #4):**
  - `gasless: false` — hardcoded. **Correcto** — v1/swap é tx-data flow, nunca intent. CoW swaps usam /v1/quote → off-chain order.
  - `gaslessAlternative`: computed from `cachedMeta` quando auto-select ran, `{ available: false }` quando source é caller-pinned. **Correcto** — não trigger segunda sweep.

- **Backwards compatibility (review focus #4):**
  - Novos campos apenas (`gasless`, `gaslessAlternative`). Nenhum campo existente removido ou renomeado. **Non-breaking.**
  - `gasless` block sempre presente em v1/quote (teste confirma). **Non-breaking.**
  - `gaslessAlternative` sempre presente em v1/swap (teste confirma). **Non-breaking.**

- **`autoSelectSource` return type:**
  - Extendido para `{ source, quotedOutput, meta }`. O `meta` é passado para `buildGaslessAlternative`. **Clean refactor, zero impacto no caller existente.**

- **`buildGaslessAlternative` helper:**
  - Null-safe: `if (!meta)` → `available: false`. **Correcto.**
  - Reutiliza `analyzeGasless` — lógica não duplicada. **Correcto.**

- **Testes:**
  - v1/quote: no-CoW → available=false, competitive CoW → recommended=true. **2 testes, coverage adequada.**
  - v1/swap: CoW exists → gasless=false + alt.available=true, pinned source → alt.available=false, cowswap rejected → 400. **3 testes, coverage adequada.**
  - O teste "cowswap rejected" confirma que `source: 'cowswap'` é barrado pelo fee-collector guard existente — não se pode forçar `gasless: true` via v1/swap. **Correcto.**

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Zero contract changes | **Confirmado** |
| Zero fund flow changes | **Confirmado** — gasless é routing suggestion, não pipeline change |
| Zero breaking API changes | **Confirmado** — novos campos apenas, sempre presentes |
| Migration backwards-compatible | **Confirmado** — DEFAULT values, IF NOT EXISTS, idempotent backfill |
| `is_gasless` server-authoritative | **Confirmado** — derivado de `source === 'cowswap'`, não client |
| RLS inalterado | **Confirmado** — novas colunas herdam policies existentes na tabela `swaps` |
| safeBigInt usado (zero bare BigInt) | **Confirmado** — gasless-engine.ts usa safeBigInt em todos os toAmount |
| 550 testes passing | **Confirmado** (+12: 9 gasless-engine + 2 v1/quote + 3 v1/swap — nota: 2 dos v1/swap pre-existentes cobrem o cowswap rejection path) |

---

## Review Focus Responses

1. **P94 thresholds — 0.5% (50 bps) correcto?** Sim. O spread típico do CoW solver é 20-50 bps. 50 bps é o limite superior — acima disto o gap é grande demais para compensar com gas savings. O check net-positive (gas savings ≥ $0.50 AND within threshold) é sound — não promete savings quando o gap é maior que o threshold.

2. **P96 migration safety?** `DEFAULT false/0`, `IF NOT EXISTS`, backfill idempotente. Seguro para deploy sem downtime. RLS herda policies existentes.

3. **P96 `is_gasless` spoofable?** Não. Derivado server-side de `source === 'cowswap'`. Um client não controla este campo — é determinado pelo swap pipeline. Submeter uma CoW order requer assinatura EIP-712 do utilizador, validação pelo solver, e settlement on-chain.

4. **P97 backwards compatibility?** Confirmado. Novos campos apenas (`gasless`, `gaslessAlternative`), sempre presentes (zero-valued quando N/A), nenhum campo existente alterado.

5. **P95 "Use Gasless Route" side effects?** O botão activa `setMevProtected(true)`, que é o mesmo toggle visível na UI. Funciona correctamente — CoW é filtrado como preferred source. O estado persiste (sticky toggle) mas é visível e desactivável pelo utilizador (ver 13A-I-02).

---

## Veredicto Final

| Severidade | Count |
|------------|-------|
| CRITICAL   | 0     |
| HIGH       | 0     |
| MEDIUM     | 0     |
| LOW        | 2     |
| INFO       | 2     |

### APPROVED — 0C / 0H / 0M / 2L

Sprint 13A está limpo para merge. A feature gasless é bem arquitectada — motor puro sem side effects, UX que reutiliza mecanismos existentes (Force MEV Protection), tracking server-authoritative, e API backwards-compatible. Os 2 LOWs são melhorias incrementais que devem ser endereçados no Sprint 13B:

- **13A-L-01:** Migrar SUM de gas_savings_usd para SQL aggregate (Supabase RPC ou view).
- **13A-L-02:** Derivar gas_savings_usd server-side usando adapter gasUsd em vez de confiar no client.

Contagem cumulativa de testes: **550** (538 Sprint 12 + 12 Sprint 13A).

---

## Fix Prompts (Sprint 13B backlog)

### 13A-FIX-01 — Replace client-side SUM with Supabase RPC

**Context:** `/api/stats` fetches all gasless rows to Node to compute `totalGasSavedUsd`. This is O(N) memory and network.

**Objective:** Replace the JS reduce with a Supabase RPC call that runs `SUM(gas_savings_usd)` server-side.

**Requirements:**
1. Create a Supabase migration that adds a SQL function:
   ```sql
   CREATE OR REPLACE FUNCTION gasless_stats()
   RETURNS TABLE(total_gasless bigint, total_gas_saved numeric) AS $$
     SELECT
       COUNT(*),
       COALESCE(SUM(gas_savings_usd), 0)
     FROM swaps
     WHERE is_gasless = true
       AND (status = 'confirmed' OR (status = 'pending' AND tx_hash IS NOT NULL))
   $$ LANGUAGE sql STABLE;
   ```
2. In `src/app/api/stats/route.ts`, replace L57-72 with a single `.rpc('gasless_stats')` call.
3. Remove the `gaslessSumRows` variable and `.reduce()` loop.
4. Keep the existing `totalGaslessSwaps`, `totalGasSavedUsd`, `gaslessRatio`, `avgGasSavingsPerSwap` shape unchanged.

**Do NOT:**
- Change the response shape of `/api/stats`.
- Remove the `idx_swaps_is_gasless` index.

**Files affected:** `supabase/migrations/20260513_gasless_stats_rpc.sql` (new), `src/app/api/stats/route.ts`
**Expected output:** 1 commit. Tests unaffected (stats route has no unit tests — endpoint is integration-tested via the dashboard).
**Quality criteria:** `npx tsc --noEmit` clean. `npm run test` all passing. `SELECT gasless_stats()` returns correct values in SQL Editor.

### 13A-FIX-02 — Derive gas_savings_usd server-side

**Context:** `gas_savings_usd` is currently client-provided (clamped to [0, 10000]). A malicious CoW swap client can inflate aggregate savings figures.

**Objective:** Compute `gas_savings_usd` server-side in `/api/log-swap` using the adapter's `gasUsd` from the best non-CoW route, removing trust in the client value.

**Requirements:**
1. In `src/app/api/log-swap/route.ts`, when `source === 'cowswap'`:
   - Accept a new optional field `bestNonCowGasUsd` from the client (advisory, for logging).
   - Derive `gas_savings_usd` as `Math.max(0, Math.min(Number(bestNonCowGasUsd ?? 0), 500))` — tighter cap at $500 (no single swap saves >$500 in gas at current Ethereum prices).
   - Alternatively: if a server-side gas estimate is available from the meta-quote cache, use it instead.
2. In `src/hooks/useSwap.ts` and `src/lib/analytics.ts`, rename `gasSavingsUsd` to `bestNonCowGasUsd` and pass the raw adapter value (not the engine's recommendation).
3. Update the clamping to [0, 500] (down from 10000).

**Do NOT:**
- Remove the clamp entirely.
- Change the `is_gasless` derivation (already correct).
- Change the migration schema.

**Files affected:** `src/app/api/log-swap/route.ts`, `src/hooks/useSwap.ts`, `src/lib/analytics.ts`
**Expected output:** 1 commit. Existing tests should pass. Add 1 test in log-swap.test.ts that verifies over-cap value is clamped to 500.
**Quality criteria:** `npx tsc --noEmit` clean. All tests passing.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-13*
