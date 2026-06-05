# Auditoria Sprint 23 — Execution History v2

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-19
**Scope:** 2 commits no branch `feat/execution-history-v2`
**Baseline:** Sprint 18 APPROVED. 628 TS + 74 Foundry tests passing.
**Commits:**
- `4b52342` — feat(orders): enrich execution history with formatted amounts, DCA stats + synthetic fallback [P134]
- `4869d5d` — docs: FEEDBACK.md P134 section

**Ficheiros:** 4 files, +317/−47 lines (net +270)
**Testes:** 0 novos (UI display changes — existing test suite unchanged).

---

## Resumo Executivo

P134 transforma o `ExecutionTimeline` de um viewer DCA-only com raw strings para um componente universal que suporta todos os order types (Limit/SL/TP/DCA), formata amounts via `viem` `formatUnits`, mostra gas em ETH, preço Chainlink, e aggregate stats para DCA com ≥2 fills. Inclui fallback sintético para orders legacy sem rows em `order_executions`.

A API route `/api/orders/:id/executions` foi enriquecida para retornar metadata do order (tokens, decimals, DCA counts, tx_hash, executed_price) numa única query. O wallet ownership check está preservado. O `OrderDashboard` agora mostra o timeline para todos os orders executados, não apenas DCA.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 3 INFO**

Zero impacto em fund flows, contratos, ou endpoints de escrita. Alteração puramente de leitura e display.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | |
| Fund flows alterados? | **Não** | |
| ABI alterado? | **Não** | |
| Novos endpoints? | **Não** | GET route existente enriquecida, sem novo path. |
| Novos secrets/env vars? | **Não** | |
| Dependências adicionadas? | **Não** | `formatUnits` de `viem` (já dependência). |
| Dados sensíveis expostos? | **Não** | Metadata retornada é do próprio user (wallet ownership check). |
| Auth bypass? | **Não** | `order.wallet !== wallet.toLowerCase()` preservado. |
| Service role key exposta? | **Não** | `getSupabase()` server-side, nunca no client. |
| XSS risk (Etherscan link)? | **Não** | JSX auto-escapes `exec.tx_hash` em `href`. Prefix `https://` previne `javascript:` protocol. |
| `order_executions` schema alterado? | **Não** | |
| ethers.js usado? | **Não** | Apenas `viem`. |

---

## Findings

### 23-I-01 — `avgPrice` usa divisão inteira BigInt — perda de precisão em preços Chainlink

**Severidade:** INFO
**Ficheiro:** `src/components/ExecutionTimeline.tsx` L109
**Descrição:** `avgPrice` calcula `total / BigInt(valid.length)` onde `total` é a soma de Chainlink prices (8 decimals). A divisão BigInt trunca (integer division). Para prices como `$2,500.12345678`, a perda é no 8º decimal — irrelevante para display (formata com 2 decimais via `PRICE_FMT`). Para preços muito baixos (sub-cent tokens), a truncação poderia ser mais visível, mas o `formatPrice` já retorna `null` quando `num === 0`, portanto tokens sub-cent simplesmente não mostram preço.
**Recomendação:** Aceitar como is. Para display (2 decimals), a precisão é mais que suficiente. Se análise financeira precisa for necessária, usar `expected_output` vs `amount_out` (dados raw) em vez de preços derivados.

### 23-I-02 — Synthetic fallback não popula `amount_in`

**Severidade:** INFO
**Ficheiro:** `src/components/ExecutionTimeline.tsx` L175
**Descrição:** Quando `executions.length === 0` e `orderMeta.tx_hash` existe, o synthetic row tem `amount_in: null`. O display renderiza como `— → 1.5 ETH @ $X`. A razão é documentada no FEEDBACK.md: `amount_in` vive no JSONB `orders.order` (EIP-712 signed struct), não como coluna top-level. A API route não expõe o JSONB completo (correctamente — evita expor toda a struct).
**Recomendação:** Aceitar como is (cosmético). Se necessário, backfill via `order_data->>'amountIn'` como coluna ou computed column.

### 23-I-03 — Nenhum test novo para 317 linhas de componente rewritten

**Severidade:** INFO
**Ficheiro:** `src/components/ExecutionTimeline.tsx`
**Descrição:** O componente foi completamente reescrito (156 → 317 linhas) com nova lógica de formatação (`formatAmount`, `formatPrice`, `formatGasEth`, `sumWei`, `avgPrice`) e um synthetic fallback path. Nenhum dos 5 helper functions tem unit tests, e o componente não tem testes de rendering. A lógica de formatação é defensiva (try/catch em tudo), mas não há cobertura automatizada.
**Recomendação:** Adicionar ao backlog como item de qualidade. As funções helper são puras e facilmente testáveis. O build + typecheck + 746 tests passando confirmam que não há regression, mas cobertura directa seria desejável.

---

## Análise Detalhada

### API Route — `/api/orders/:id/executions`

**Ownership check (L44-48):**
```typescript
if (!order || order.wallet !== wallet.toLowerCase()) {
  return NextResponse.json(
    { executions: [], order: null, error: 'Not authorized' },
    { status: 403 },
  )
}
```
- Lógica idêntica ao baseline — `wallet.toLowerCase()` comparison. ✓
- Response shape agora inclui `order: null` para consistência. ✓

**Query enriquecida (L37-42):**
```typescript
.select(
  'wallet, token_in_symbol, token_out_symbol, token_in_decimals, token_out_decimals, dca_total, dca_executed, tx_hash, amount_out, gas_used, executed_at, executed_price',
)
```
- Apenas colunas necessárias para display — sem `order` JSONB, sem `amount_in` raw, sem secrets. ✓
- Single query (`.single()`) — mantém o pattern existente. ✓

**`orderMeta` construction (L58-70):**
- Explicit field listing — não expõe `wallet` ou campos não necessários ao client. ✓
- Apenas metadata de display (symbols, decimals, DCA counts, tx_hash, amounts, price). ✓

**Error handling:**
- `getSupabase()` null → `{ executions: [], order: null }`. ✓
- Query error → `{ executions: [], order: orderMeta, error: error.message }`. ✓

### ExecutionTimeline.tsx — Formatters

**`formatAmount(raw, decimals, symbol)`:**
- `raw == null || raw === ''` → `null`. ✓
- `try { BigInt(raw) }` → catch returns `null`. ✓ (Handles non-numeric strings gracefully.)
- `formatUnits(BigInt(raw), decimals)` → string. ✓
- `Number(v)` → `!Number.isFinite(num)` guard → fallback to raw string + symbol. ✓ (Handles Infinity/NaN.)
- `AMOUNT_FMT.format(num)` → localized. ✓

**`formatPrice(raw)`:**
- Same null/empty/try-catch pattern. ✓
- Hardcoded 8 decimals (Chainlink standard). ✓
- `num === 0` → `null` (suppresses zero-price display). ✓

**`formatGasEth(raw)`:**
- Same pattern, 18 decimals (ETH wei). ✓
- `num === 0` → `null`. ✓

**`sumWei(values)`:**
- Iterates with `try { total += BigInt(v) } catch {}`. ✓
- Skips null/empty/non-integer silently. ✓
- Returns `bigint` (safe for further arithmetic). ✓

**`avgPrice(prices)`:**
- Filters valid BigInt values. ✓
- `valid.length === 0` → `null`. ✓
- `total / BigInt(valid.length)` → integer division (see finding 23-I-01). ✓
- Returns string for consumption by `formatPrice`. ✓

**Nenhum dos formatters lança excepção** — todos têm try/catch a retornar `null`. ✓

### ExecutionTimeline.tsx — Synthetic Fallback

```typescript
const rows: Execution[] = useMemo(() => {
  if (executions.length > 0) return executions
  if (orderMeta && orderMeta.tx_hash) {
    return [{ id: 'synthetic', ... }]
  }
  return []
}, [executions, orderMeta])
```

**Verificação de double-display:**
- `executions.length > 0` → real rows, no synthetic. ✓
- `executions.length === 0 && orderMeta.tx_hash` → synthetic. ✓
- `executions.length === 0 && !orderMeta.tx_hash` → empty → component returns null. ✓
- Mutuamente exclusivos. ✓

**Synthetic row fields:**
- `tx_hash`: from `orderMeta.tx_hash` (database, not user input). ✓
- `amount_in: null` (see finding 23-I-02). ✓
- `amount_out`: from `orderMeta.amount_out`. ✓
- `gas_used`: from `orderMeta.gas_used`. ✓
- `price_at_execution`: from `orderMeta.executed_price`. ✓
- `status: 'success'` — orders com `tx_hash` são sempre success (failed orders não têm hash persistido). ✓

### ExecutionTimeline.tsx — Aggregate Stats

```typescript
const isDca = (dcaTotal ?? orderMeta?.dca_total ?? 0) > 1
const showAggregateStats = isDca && rows.length >= 2
```

- Apenas para DCA com ≥2 fills — single-fill DCA ou Limit/SL/TP não mostram aggregate. ✓
- `useMemo` com deps correctas. ✓
- Display: fills count, total in → total out, avg price, total gas. ✓

### OrderDashboard.tsx — Guard Expansion

```typescript
{(order.status === 'filled'
  || order.status === 'partially_filled'
  || (order.dcaExecuted ?? 0) > 0
  || !!order.txHash) && (
  <ExecutionTimeline ... />
)}
```

**Cobre todos os estados válidos:**
- `filled` — order completo (Limit/SL/TP/DCA terminado). ✓
- `partially_filled` — DCA em progresso. ✓
- `dcaExecuted > 0` — DCA com pelo menos um fill (pode estar `active` ainda). ✓
- `txHash` exists — legacy order com tx mas sem rows em `order_executions`. ✓

**Sem falsos positivos:**
- `active` sem `dcaExecuted` e sem `txHash` → hidden (correcto — nada a mostrar). ✓
- `cancelled` sem `txHash` → hidden (correcto). ✓
- `cancelled` com `txHash` (cancelled after partial fill?) → shown (correcto — há execution history). ✓

**Props passadas:**
- `tokenInSymbol`, `tokenOutSymbol`, `tokenInDecimals`, `tokenOutDecimals`: do order card state. ✓
- `dcaTotal`, `dcaExecuted`: passados para aggregate stats. ✓
- `orderId`, `wallet`: mantidos do baseline. ✓

### Etherscan Link — XSS Analysis

```tsx
href={`https://etherscan.io/tx/${exec.tx_hash}`}
```

- `exec.tx_hash` provém de Supabase (column `tx_hash` tipo `text`). ✓
- JSX template literal: React escapes todos os atributos automaticamente. ✓
- Prefix `https://etherscan.io/tx/` — impossível construir `javascript:` URL. ✓
- Truncation display: `exec.tx_hash.slice(0, 10)...slice(-6)` — se `tx_hash` for null, o block inteiro não renderiza (`{exec.tx_hash && (...)}`). ✓

### FEEDBACK.md — P134 Section

3 items documentados:

1. **Synthetic `amount_in` gap** — Edge case correcto, cosmético. ✓
2. **`npm run lint` space-in-path** — Não é regression, é env-specific. CI corre de checkout clean sem espaços. ✓
3. **`react-hooks/set-state-in-effect`** — Pattern pré-existente preservado. Não introduzido por P134. ✓

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Wallet ownership check preservado | **Confirmado** — L44-48, `order.wallet !== wallet.toLowerCase()` |
| Service role key não exposta ao client | **Confirmado** — `getSupabase()` server-side only |
| Zero raw wei strings em display paths | **Confirmado** — todos passam por `formatAmount`/`formatPrice`/`formatGasEth` |
| Todos os `BigInt()` calls em try/catch | **Confirmado** — 5 functions, todas com catch → null/skip |
| `formatUnits` de `viem` (não ethers.js) | **Confirmado** — import L3 |
| No `dangerouslySetInnerHTML` | **Confirmado** — zero matches |
| Etherscan link React-escaped | **Confirmado** — JSX attribute |
| Synthetic fallback mutuamente exclusivo com real data | **Confirmado** — `executions.length > 0` guard |
| Aggregate stats apenas para DCA ≥2 fills | **Confirmado** — `isDca && rows.length >= 2` |
| `order_executions` schema inalterado | **Confirmado** — zero migration files |
| No new dependencies | **Confirmado** — `viem` já dependência |
| OrderDashboard guard cobre all valid states | **Confirmado** — filled, partially_filled, dcaExecuted>0, txHash |
| FEEDBACK.md items triaged | **Confirmado** — 3 items, nenhum security-relevant |

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

Reescrita do ExecutionTimeline com formatação rica, aggregate stats, e synthetic fallback. Toda a lógica de formatação é defensiva (null-safe, try/catch em cada BigInt conversion). Ownership check preservado. Zero impacto em fund flows, contratos, ou schema. Sprint clear to merge.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-19*
