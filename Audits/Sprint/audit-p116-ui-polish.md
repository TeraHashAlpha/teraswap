# Auditoria P116 — QA UI Polish

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-14
**Scope:** 1 commit no branch `fix/ui-polish-p116`
**Baseline:** Sprint 16A completo (P109-P115 APPROVED).
**Commit:**
- `eddc952` — fix(ui): P116 — 5 QA polish fixes for swap UI
**Ficheiros:** 4 files, +57/−77 lines (net −20)
**Testes:** 0 novos (alterações puramente visuais/UX). Testes existentes não afectados.

---

## Resumo Executivo

P116 resolve 5 problemas de UX identificados em QA manual:

1. **Scroll bleed-through** — `overscroll-behavior: none` em `html` e `body` + `window.scrollTo(0, 0)` na transição landing↔swap.
2. **Limit Orders / Stop Loss removidos** — `SwapMode` type reduzido de 7 para 5 membros (`limit` e `sltp` removidos). Tabs no nav, entries no `COMING_SOON_META`, e o respectivo `COMING_SOON_MODES` set entry eliminados.
3. **Exact Out mode removido** — State `exactOut`/`displayAmountOut`, o `useEffect` de estimação input-from-output, o toggle button, e os conditional renders em Sell/Receive foram eliminados. O input Sell é agora sempre um `<input>` e o Receive é sempre um `<span>` read-only.
4. **Chainlink warning delay** — Banners de `priceBlocked` (warn e danger) agora gated em `hasAmount && meta && !quoteLoading`, prevenindo flash do warning ao seleccionar token antes de ter quote fresco.
5. **SourceToggle close button** — Novo botão "×" (`&#10005;`) no header do dropdown com `aria-label="Close liquidity sources panel"`.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 2 INFO**

Zero impacto em segurança. Lógica de `priceBlocked`, `anyBlocked`, e `SwapButton.priceBlocked` prop inalterada — apenas a condição de rendering dos banners foi refinada.

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
| Testes novos? | **Não** | Alterações puramente visuais. |
| `priceBlocked` lógica alterada? | **Não** | Variável e flow para SwapButton inalterados. |
| Validators alterados? | **Não** | Zero alterações a validateRouterAddress, validateCallDataRecipient, validateFeeIntegrity. |
| Rate limiter/backoff alterado? | **Não** | |

---

## Findings

### P116-I-01 — `SwapMode` type removal pode quebrar deep links ou bookmarks futuros

**Severidade:** INFO
**Ficheiro:** `src/app/page.tsx` L22
**Descrição:** `SwapMode` foi reduzido de `'instant' | 'dca' | 'limit' | 'sltp' | 'orders' | 'history' | 'analytics'` para `'instant' | 'dca' | 'orders' | 'history' | 'analytics'`. Actualmente o `SwapMode` é state in-memory (não URL-driven), portanto não há deep links a quebrar. Se no futuro o routing for URL-based (e.g., `/swap/limit`), URLs antigos dariam 404. Risco actual: zero — `SwapMode` nunca esteve na URL.
**Recomendação:** Aceitar como is. Quando Limit Orders regressarem (Phase 2/3), o type será re-expandido.

### P116-I-02 — `overscroll-behavior: none` em `html` e `body` é redundante

**Severidade:** INFO
**Ficheiro:** `src/app/globals.css` L60-61, L68
**Descrição:** `overscroll-behavior: none` está aplicado tanto em `html` como em `body`. A propriedade é inherited e apenas necessária no viewport root (`html`). Aplicar em ambos é inofensivo mas redundante. `overflow-x: hidden` também está em ambos (pré-existente em `body`, novo em `html`) — mesma situação.
**Recomendação:** Aceitar como is. Redundância defensiva, sem impacto em performance ou rendering.

---

## Análise Detalhada

### 1. Scroll bleed-through (`globals.css` + `page.tsx`)

**`globals.css`:**
- `html { overflow-x: hidden; overscroll-behavior: none; }` — previne bounce/rubber-band scroll no iOS/Chrome. ✓
- `body { overscroll-behavior: none; }` — redundante mas inofensivo. ✓

**`page.tsx`:**
```typescript
useEffect(() => {
  if (typeof window !== 'undefined') window.scrollTo(0, 0)
}, [page])
```
- SSR-safe: `typeof window` guard. ✓
- Executa em cada transição `page` (landing↔swap). ✓
- `window.scrollTo(0, 0)` — reset imediato, sem smooth scroll (correcto para transição de página, não scroll manual). ✓

### 2. Limit Orders / Stop Loss removidos (`page.tsx`)

**Type:**
```typescript
// Antes: 'instant' | 'dca' | 'limit' | 'sltp' | 'orders' | 'history' | 'analytics'
// Depois: 'instant' | 'dca' | 'orders' | 'history' | 'analytics'
```

**`COMING_SOON_MODES`:** Reduzido de `['dca', 'limit', 'sltp']` para `['dca']`. ✓

**`COMING_SOON_META`:** Entradas `limit` e `sltp` removidas. Apenas `dca` mantido. ✓

**Nav tabs:** `['limit', 'Limit']` e `['sltp', 'SL / TP']` removidos do array de tabs. ✓

**Verificação completude:**
- Grep por `limit` no ficheiro pós-patch: zero matches. ✓
- Grep por `sltp` no ficheiro pós-patch: zero matches. ✓
- Features completamente removidas, não greyed out. ✓

### 3. Exact Out mode removido (`SwapBox.tsx`)

**State removido:**
- `const [exactOut, setExactOut] = useState(false)` — eliminado. ✓
- `const [displayAmountOut, setDisplayAmountOut] = useState('')` — eliminado. ✓

**useEffect removido:**
- O bloco que estimava input amount a partir do output via ratio (`currentIn / currentOut * desiredOut`) foi eliminado. ✓
- Este era o mecanismo que causava rate limits — cada keystroke no output field triggava re-fetch do quote, multiplicado pelo debounce timing. ✓

**UI removido:**
- Toggle button "EXACT OUT / EXACT IN" no header do Receive section — eliminado. ✓
- Conditional render no Sell section (`exactOut ? <span>~estimate</span> : <input>`) — simplificado para sempre `<input>`. ✓
- Conditional render no Receive section (`exactOut ? <input> : <span>~output</span>`) — simplificado para sempre `<span>` read-only. ✓

**Verificação completude:**
- Grep por `exactOut` no ficheiro pós-patch: zero matches. ✓
- Grep por `displayAmountOut` no ficheiro pós-patch: zero matches. ✓

**Impacto em segurança:** Zero. O Exact Out path usava a mesma pipeline de quote/swap — não tinha validators ou security logic própria. A remoção elimina um surface de input desnecessário.

### 4. Chainlink warning delay (`SwapBox.tsx`)

**Antes:**
```tsx
{priceBlocked && priceCheck.level === 'warn' && !priceCheck.oracleUnavailable && (
```

**Depois:**
```tsx
{priceBlocked && priceCheck.level === 'warn' && !priceCheck.oracleUnavailable && hasAmount && meta && !quoteLoading && (
```

Três condições adicionadas: `hasAmount`, `meta` (quote presente), `!quoteLoading`.

**Mesma alteração no bloco `danger`:**
```tsx
// Antes: {priceBlocked && priceCheck.level === 'danger' && (
// Depois: {priceBlocked && priceCheck.level === 'danger' && hasAmount && meta && !quoteLoading && (
```

**Análise de segurança — CRÍTICA:**

A variável `priceBlocked` é computada em L448:
```typescript
const priceBlocked = (priceCheck.level === 'danger' || priceCheck.level === 'warn') && !priceCheck.oracleUnavailable
```
Esta lógica é **inalterada**. ✓

A variável `anyBlocked` (L465):
```typescript
const anyBlocked = priceBlocked || oracleBlocked
```
Também **inalterada**. ✓

O `SwapButton` recebe `priceBlocked={anyBlocked}` (L740) — **inalterado**. ✓

**Conclusão:** O swap continua bloqueado pela lógica do `SwapButton` quando `priceBlocked` ou `oracleBlocked` é true. As condições adicionais (`hasAmount && meta && !quoteLoading`) afectam apenas a **visibilidade do banner informativo**, não o bloqueio do botão. Isto é correcto — o banner é informativo, o bloqueio é feito pelo botão.

**Cenário de timing:**
1. User selects token com desvio oracle. `priceCheck.level = 'warn'`.
2. `priceBlocked = true` → botão disabled. ✓ (antes E depois do fix)
3. Banner: antes aparecia imediatamente (potencialmente com dados stale). Depois: só aparece quando `meta` tem quote fresco. ✓
4. O botão está disabled durante todo o período — sem janela de bypass. ✓

### 5. SourceToggle close button (`SourceToggle.tsx`)

**Novo botão:**
```tsx
<button
  onClick={() => setOpen(false)}
  aria-label="Close liquidity sources panel"
  className="flex h-5 w-5 items-center justify-center rounded text-cream-35 transition hover:bg-cream-08 hover:text-cream"
>
  <span className="text-[11px] leading-none">&#10005;</span>
</button>
```

**Verificação:**
- `setOpen(false)` — usa o mesmo state local que controla o dropdown. ✓
- `aria-label` presente para acessibilidade. ✓
- `&#10005;` (✕) — cross mark unicode. ✓
- Posicionado no header do dropdown, junto ao "Select all / Deselect all". ✓
- O layout foi reestruturado: header agora tem `<span>` (label) + `<div>` (select-all button + close button) com `gap-2`. ✓
- A lógica de toggle all/none é **inalterada** — apenas movida para dentro do novo `<div>` wrapper. ✓

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Zero alterações a código de contratos | **Confirmado** — diff contém apenas `.css`, `.tsx` |
| Zero alterações a validators | **Confirmado** — validateRouterAddress, validateCallDataRecipient, validateFeeIntegrity não tocados |
| Zero alterações a rate limiter/backoff | **Confirmado** |
| `priceBlocked` variável inalterada | **Confirmado** — L448 |
| `anyBlocked` variável inalterada | **Confirmado** — L465 |
| `SwapButton.priceBlocked` prop inalterada | **Confirmado** — L740 |
| Banners warn/danger gated em `hasAmount && meta && !quoteLoading` | **Confirmado** — apenas visibilidade, não bloqueio |
| Swap button disabled quando `priceBlocked=true` independente do banner | **Confirmado** |
| `exactOut` completamente removido | **Confirmado** — zero grep matches |
| `displayAmountOut` completamente removido | **Confirmado** — zero grep matches |
| `limit` completamente removido de page.tsx | **Confirmado** — zero grep matches |
| `sltp` completamente removido de page.tsx | **Confirmado** — zero grep matches |
| SourceToggle close button usa `setOpen(false)` | **Confirmado** |
| SourceToggle toggle-all logic inalterada | **Confirmado** — apenas re-wrapped em `<div>` |
| `window.scrollTo` é SSR-safe | **Confirmado** — `typeof window` guard |
| Nenhum dado sensível no diff | **Confirmado** |

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

Cinco fixes de UX puramente cosméticos. A análise mais importante é a verificação de que o Chainlink PriceCheck delay (fix #4) não abre nenhuma janela de bypass — o botão de swap continua disabled via `anyBlocked` independentemente da visibilidade do banner. As remoções de Limit Orders e Exact Out são limpas e completas.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-14*
