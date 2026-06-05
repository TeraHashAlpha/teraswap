# Auditoria Hotfix — Quote Flood Prevention

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-14
**Scope:** 3 commits no branch `fix/hotfix-quote-flood`
**Baseline:** main branch merged (Sprints 13A, 13B, 14, 15).
**Commits:**
- `afcde6e` — Fix 1: Stop request flood from `doFetch` identity churn
- `a1fac6a` — Fix 2: Dedupe quote-error toasts to stop tray flood
- `bad1084` — Fix 3: Exponential backoff on `/api/quote` 429 responses
**Ficheiros:** `src/hooks/useQuote.ts` (+154/−13), `src/components/SwapBox.tsx` (+32), `src/components/ToastProvider.tsx` (+19)
**Testes:** Nenhum teste novo (frontend hooks sem test coverage — finding existente M-01/Sprint 16A). ~608 TS (grep-counted).

---

## Resumo Executivo

Este hotfix resolve um bug de produção onde o hook `useQuote` dispara ~11 requests `/api/quote` em ~10 s, inundando o backend com pedidos e o toast tray com mensagens de erro idênticas. O root cause é a instabilidade da identidade de `doFetch` — `useEthGasCost().estimate` é recriada a cada tick do wagmi (captura `ethPrice` + `gasPriceWei` voláteis), e como era dependência do `useCallback`, cada render recriava `doFetch`, destruía e recriava o `setInterval`, e chamava `doFetch()` synchronously na re-entry do `useEffect`.

A correção é em 3 camadas:
1. **Estabilidade do `doFetch`**: `estimateGasCost` movida para ref; `excludeSources` estabilizada via `.join(',')` string; `inFlightRef` como guard belt-and-suspenders.
2. **Toast dedup**: `dedupKey: 'quote-error'` substitui toasts anteriores em vez de empilhar; `lastQuoteErrorRef` short-circuits strings idênticas antes de chegar ao provider.
3. **429 backoff**: `QuoteApiError` com HTTP status; 429 → intervalo dobra (30s→60s→120s cap); primeiro success restaura 15s.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 1 LOW / 2 INFO**

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
| Dados sensíveis? | **Não** | |
| Testes novos? | **Não** | Nenhum teste adicionado — see HF-L-01. |
| `npx tsc --noEmit` clean? | **Sim** | Inferido do diff (tipos correctos). |

---

## Findings

### HF-L-01 — Nenhum teste para o backoff + doFetch estabilidade

**Severidade:** LOW
**Ficheiros:** `src/hooks/useQuote.ts`
**Descrição:** O hotfix introduz lógica material — exponential backoff, in-flight guard, estimateGasCost ref, doFetchRef → rearmPollTimer indirection — sem testes unitários. Os 3 mecanismos interagem entre si (backoff chama `rearmPollTimer` que lê `doFetchRef.current`) e uma regressão subtil (e.g. `doFetchRef` não actualizado, backoff stuck a 120s) seria silenciosa.

O finding M-01 da análise externa já está no backlog (Sprint 16A P115 — frontend integration tests), e o `useQuote` hook é um dos 4 hooks priorizados. No entanto, o backoff é lógica nova que não estava no scope original do M-01.

**Recomendação:** Quando P115 for implementado, incluir testes específicos para:
1. `doFetch` não re-dispara quando `estimateGasCost` muda (ref isolation)
2. `inFlightRef` previne fetches concorrentes
3. 429 → `currentIntervalMsRef` dobra (30s→60s→120s→120s cap)
4. Primeiro success após backoff → intervalo restaura a 15s
5. Non-429 error durante backoff → backoff cleared

**Impacto:** Sem impacto de segurança directo (não toca em fund flows), mas risco de regressão silenciosa é real.

### HF-I-01 — `rearmPollTimer` referencia `doFetchRef` antes da sua declaração

**Severidade:** INFO
**Ficheiro:** `src/hooks/useQuote.ts` L135-142
**Descrição:** `rearmPollTimer` (L135) usa `doFetchRef.current?.()` mas `doFetchRef` é declarado em L240 (após `doFetch`). Isto funciona correctamente porque:
1. `rearmPollTimer` é um `useCallback` — o corpo só executa quando chamado, não na declaração.
2. `doFetchRef` é um `useRef(doFetch)` e `useRef` retorna um objecto estável — por altura da primeira chamada a `rearmPollTimer` (dentro de `doFetch`'s catch block, que requer pelo menos uma invocação), o ref já está inicializado.
3. JavaScript hoisting não se aplica a `const` no nível de escopo de função React.

No entanto, a ordem de declaração é confusa para leitores. O `// Reads from doFetchRef` comment mitiga parcialmente.

**Recomendação:** Aceitar como is. A correcção seria mover `doFetchRef` para antes de `rearmPollTimer`, mas isso requereria reestruturar a inicialização (chicken-and-egg: `doFetchRef` inicializa com `doFetch`, que depende de `rearmPollTimer`). O ref indirection é um padrão React standard para evitar closure staleness.

### HF-I-02 — Backoff máximo de 120s pode servir quotes stale

**Severidade:** INFO
**Ficheiro:** `src/hooks/useQuote.ts` L59 (`MAX_BACKOFF_MS = 120_000`)
**Descrição:** Durante backoff máximo, o user vê a última quote por até 2 minutos antes de uma tentativa de refresh. Em mercados voláteis, uma quote de 2 min pode ter slippage significativo. No entanto:
1. O `minimumOutput` no FeeCollector V2 protege contra slippage on-chain — se a quote está stale e o preço moveu, a transacção reverte.
2. O countdown no UI mostra o intervalo actual (120s), sinalizando visualmente ao user que o refresh está atrasado.
3. O user pode sempre clicar refetch manualmente (`refetch: doFetch`).
4. O backoff só dispara em 429 — se o backend está rate-limiting, enviar mais requests pioraria a situação.
5. A alternativa (continuar a 15s durante 429) causa o loop original.

**Recomendação:** Aceitar 120s como ceiling. O `minimumOutput` on-chain é a verdadeira protecção de segurança — a quote é apenas UX.

---

## Análise Detalhada — Fix 1 (`afcde6e`)

### 1. `estimateGasCostRef` — Estabilidade do doFetch

**Root cause:** `useEthGasCost().estimate` é recriada em cada render (captura `ethPrice`, `gasPriceWei` do wagmi). Como era dep de `useCallback(doFetch, [..., estimateGasCost])`, cada wagmi tick → novo `doFetch` → novo `setInterval` → novo `doFetch()` call na re-entry do `useEffect`.

**Fix:**
```typescript
const estimateGasCostRef = useRef(estimateGasCost)
useEffect(() => { estimateGasCostRef.current = estimateGasCost }, [estimateGasCost])
```
`doFetch` lê `estimateGasCostRef.current` em vez de capturar `estimateGasCost` directamente. A função é sempre a mais recente (ref actualizado via effect), mas `doFetch` não a tem no dep array.

**Verificação:**
- `estimateGasCost` removido dos deps de `doFetch`. ✓
- `estimateGasCostRef.current` usado em L181 (`refGas = bestNonCow ? estimateGasCostRef.current(bestNonCow.estimatedGas) : null`). ✓
- O ref update effect (L103-105) garante que o ref nunca é stale por mais de um render cycle. ✓

### 2. `inFlightRef` — Concurrent fetch guard

**Guard:** `if (inFlightRef.current) return` antes de qualquer work (L150). Set `true` antes do fetch, `false` no `finally` (L232).

**Verificação:**
- Colocado **antes** de `setLoading(true)` — um re-entry durante loading simplesmente retorna. ✓
- Reset no `finally` — garante que falhas não deixam o guard stuck. ✓
- Não interfere com o `rearmPollTimer` — o `setInterval` continua a tentar, e o guard rejeita se o anterior ainda está em voo. ✓

### 3. `excludeKey` — Estabilidade da dep array

**Fix:** `const excludeKey = excludeSources?.join(',') ?? ''` (L129). Usado nos deps de `doFetch` em vez de `excludeSources?.join(',')` inline.

**Verificação:**
- O join é computado uma vez por render, armazenado em `const`. ✓
- String comparison é estável — não depende de array identity. ✓
- `excludeSources?.join(',')` inline no dep array (antes) era computado pelo React como expressão, potencialmente re-avaliado. O `const` é mais limpo. ✓

### 4. Cleanup do `setInterval`

**Fix:** Cleanup function agora nullifica os refs após `clearInterval`:
```typescript
if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
```

**Verificação:** Sem `null` assignment, um ref apontando para um timer cleared poderia ser re-cleared sem efeito, mas não causaria bug. A null assignment é defensive best practice. ✓

---

## Análise Detalhada — Fix 2 (`a1fac6a`)

### 1. `lastQuoteErrorRef` — Client-side dedup

**SwapBox (L229-399):**
```typescript
if (!quoteError) { lastQuoteErrorRef.current = null; return }
if (quoteError === lastQuoteErrorRef.current) return
lastQuoteErrorRef.current = quoteError
toast({ ..., dedupKey: 'quote-error' })
```

**Verificação:**
- Idênticas strings consecutivas → short-circuited antes do toast call. ✓
- Quando `quoteError` clears (null), ref reseta — próximo erro genuíno re-surfaces. ✓
- O `toast` está nos deps do `useEffect` (`[quoteError, toast]`). `toast` é `useCallback` estável (deps: `[dismiss]`). ✓

### 2. `dedupKey` no ToastProvider

**ToastProvider (L60-76):**
```typescript
if (t.dedupKey) {
  base = prev.filter(existing => {
    if (existing.dedupKey !== t.dedupKey) return true
    clearTimeout(timers.current[existing.id])
    delete timers.current[existing.id]
    return false
  })
}
```

**Verificação:**
- Filtra toasts com o mesmo `dedupKey` antes de append. ✓
- Limpa o dismiss timer do toast removido para evitar callbacks stale. ✓
- `delete timers.current[existing.id]` — cleanup do objecto de timers. ✓
- Se `dedupKey` não é fornecido, o comportamento é idêntico ao anterior (sem filtragem). ✓
- `dedupKey` é opcional no `Toast` interface. ✓

### 3. XSS / Injection

O `dedupKey` é um literal estático `'quote-error'` — não vem de user input. Não há risco de injection via `dedupKey`. ✓

---

## Análise Detalhada — Fix 3 (`bad1084`)

### 1. `QuoteApiError`

```typescript
class QuoteApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.name = 'QuoteApiError'; this.status = status }
}
```

**Verificação:**
- `fetchQuoteViaApi` agora throws `QuoteApiError` em vez de `Error` para responses não-OK. ✓
- `res.status` é propagado. ✓
- A detection em `doFetch` usa `err instanceof QuoteApiError && err.status === 429`. ✓

### 2. Backoff progression

| Consecutive 429s | `currentIntervalMsRef` | Cálculo |
|------------------|------------------------|---------|
| 0 (normal) | 15_000 | `QUOTE_REFRESH_MS` |
| 1 | 30_000 | `min(120_000, 15_000 * 2)` |
| 2 | 60_000 | `min(120_000, 30_000 * 2)` |
| 3 | 120_000 | `min(120_000, 60_000 * 2)` |
| 4+ | 120_000 | `min(120_000, 120_000 * 2)` — cap |

✓ Progressão correcta. MAX_BACKOFF_MS = 120s é o ceiling.

### 3. `setError(null)` guard durante backoff

```typescript
if (!inBackoffRef.current) { setError(null) }
```

**Sem o guard:** `setError(null)` (top of doFetch) → fetch → 429 → `setError('Rate limit…')` → next tick → `setError(null)` → fetch → 429 → `setError('Rate limit…')` — o `quoteError` oscila entre null e string, cada transição dispara um toast no SwapBox.

**Com o guard:** Durante backoff, o error persiste. O toast dedup (Fix 2) é a segunda barreira. ✓

### 4. Recovery — primeiro success após backoff

```typescript
if (inBackoffRef.current) {
  inBackoffRef.current = false
  currentIntervalMsRef.current = QUOTE_REFRESH_MS  // 15s
  setError(null)
  rearmPollTimer()
}
```

**Verificação:**
- Backoff flag cleared. ✓
- Intervalo restaurado a 15s. ✓
- `setError(null)` chamado explicitamente (porque foi skipped no top do doFetch). ✓
- Timer rearmado com o novo intervalo. ✓

### 5. Non-429 errors durante backoff

```typescript
} else if (inBackoffRef.current) {
  inBackoffRef.current = false
  currentIntervalMsRef.current = QUOTE_REFRESH_MS
  rearmPollTimer()
}
```

**Verificação:** Se um erro não-429 ocorre durante backoff (e.g., network timeout), o backoff é cleared e o intervalo volta a 15s. Isto evita que o user fique stuck a 120s se o rate limit já levantou mas há outro problema transitório. ✓

### 6. Non-429 errors sem backoff prévio

O bloco `if (isRateLimit)` não entra → o `else if (inBackoffRef.current)` também não entra (flag é false) → nenhuma alteração ao intervalo. O timer continua a 15s. ✓

### 7. Reset de backoff ao desactivar

```typescript
if (!enabled) {
  setMeta(null)
  inBackoffRef.current = false
  currentIntervalMsRef.current = QUOTE_REFRESH_MS
  return
}
```

**Verificação:** Wallet disconnect ou route change → backoff cleared, intervalo normalizado. Re-enable começa limpo. ✓

### 8. `rearmPollTimer` e `doFetchRef` interaction

**Fluxo:**
1. `doFetch` detect 429 → chama `rearmPollTimer()`
2. `rearmPollTimer` clears existing interval, creates new com `doFetchRef.current?.()`
3. `doFetchRef` é actualizado via `useEffect(() => { doFetchRef.current = doFetch }, [doFetch])`

**Potential issue:** Se `doFetch` é recriado (dep change) entre o `rearmPollTimer()` call e o próximo tick do timer, o timer usará o `doFetchRef.current` que aponta para o novo `doFetch`. Isto é correcto — é o propósito do ref.

**Edge case:** Na mount, `doFetchRef` é `useRef(doFetch)` — inicializado com a primeira versão. O effect que actualiza `doFetchRef.current` corre assíncronamente (após render commit). Se `rearmPollTimer` fosse chamado durante a primeira render, o ref teria a versão inicial do doFetch. Isto é seguro — a primeira render nunca entra no backoff path (nenhum 429 ainda). ✓

### 9. Stale quote security assessment

**Max stale window:** 120s (backoff cap).

**Protecções on-chain:**
- FeeCollector V2 `minimumOutput` valida `IERC20(tokenOut).balanceOf(msg.sender)` before/after router call. Se o preço moveu significativamente, a transacção reverte com `InsufficientOutput`.
- Chainlink price feed validation para ordens condicionais (MAX_STALENESS = 3600s — muito mais permissivo que 120s).

**UX:**
- Countdown no UI mostra o intervalo actual (e.g., "120s").
- O user pode clicar refetch manualmente a qualquer momento.

**Conclusão:** 120s de stale quotes é aceitável. A protecção real contra slippage é o `minimumOutput` on-chain, não a frescura da quote. ✓

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| `doFetch` deps: `[tokenIn, tokenOut, debouncedAmount, address, excludeKey, rearmPollTimer]` | **Confirmado** — `estimateGasCost` removido |
| `estimateGasCostRef` actualizado em cada render | **Confirmado** — effect sync |
| `inFlightRef` guard + finally reset | **Confirmado** |
| `excludeKey` stable string | **Confirmado** — `.join(',')` |
| `lastQuoteErrorRef` reset quando error clears | **Confirmado** — `if (!quoteError) ref = null` |
| `dedupKey: 'quote-error'` no toast | **Confirmado** |
| ToastProvider filtra + cleanup timer de toasts com mesmo dedupKey | **Confirmado** |
| `QuoteApiError` com HTTP status | **Confirmado** |
| 429 → backoff 30s→60s→120s | **Confirmado** — arithmetic verified |
| `setError(null)` skipped durante backoff | **Confirmado** |
| First success → 15s + `setError(null)` + rearm | **Confirmado** |
| Non-429 error → backoff cleared | **Confirmado** |
| Disable → backoff reset | **Confirmado** |
| Max stale quote = 120s → `minimumOutput` on-chain protects | **Confirmado** |
| Nenhum dado sensível | **Confirmado** |
| Nenhum teste adicionado | **Confirmado** — finding HF-L-01 |

---

## Veredicto Final

| Severidade | Count |
|------------|-------|
| CRITICAL   | 0     |
| HIGH       | 0     |
| MEDIUM     | 0     |
| LOW        | 1     |
| INFO       | 2     |

### APPROVED — 0C / 0H / 0M / 1L

O hotfix resolve correctamente o request flood (root cause: `estimateGasCost` identity churn), o toast flood (dedup + ref short-circuit), e implementa backoff exponencial para 429s com recovery automática. A protecção on-chain via `minimumOutput` mitiga o risco de quotes stale durante backoff.

**HF-L-01 (nenhum teste)** é classified como LOW porque a lógica de backoff é material e a interacção `rearmPollTimer ↔ doFetchRef` é não-trivial. A recomendação é incluir cobertura no Sprint 16A P115 (M-01 frontend integration tests).

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-14*
