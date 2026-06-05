# Auditoria Hotfix UI — MEV Disclaimer

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-14
**Scope:** 1 commit no branch `fix/ui-mev-disclaimer`
**Baseline:** Sprint 16A P109-P114 + Hotfix Quote Flood APPROVED.
**Commit:**
- `a468b78` — fix(ui): soften MEV protection disclaimer [hotfix-ui]
**Ficheiros:** 2 files, +59/−8 lines
**Testes:** 0 novos (alteração puramente visual/UX).

---

## Resumo Executivo

O commit substitui o banner amber de MEV exposure no `QuoteBreakdown.tsx` (borda amarela, ícone ⚠, fundo `amber-500/5`) por um hint subtil no `SwapBox.tsx` — uma linha de texto muted (`text-[12px] text-cream-35`) colocada abaixo do botão de swap. O hint inclui um link "Enable" que activa `setMevProtected(true)` (toggle existente de Force MEV Protection) e um botão "×" que persiste a dismissão via `localStorage` key `teraswap:mev-hint-dismissed`. A leitura do `localStorage` é SSR-safe (dentro de `useEffect`) e gracefully degrades em private mode (`try/catch` em read e write).

A prop `mevExposedBest` permanece no `QuoteBreakdown` para callers existentes — apenas o rendering do banner foi removido.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 1 INFO**

Alteração puramente cosmética. Zero impacto em fund flows, contratos, endpoints, ou lógica de swap.

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
| Dados sensíveis? | **Não** | localStorage key contém apenas `'1'` (flag booleano). |
| Testes novos? | **Não** | Alteração visual — sem lógica testável adicional. |
| XSS risk? | **Não** | Conteúdo estático, sem interpolação de dados do utilizador. |
| SSR safety? | **Sim** | `useEffect` para `localStorage` read. ✓ |

---

## Findings

### UI-I-01 — `MEV_HINT_DISMISSED_KEY` definido dentro do corpo do componente

**Severidade:** INFO
**Ficheiro:** `src/components/SwapBox.tsx` L50
**Descrição:** A constante `MEV_HINT_DISMISSED_KEY = 'teraswap:mev-hint-dismissed'` é definida dentro do corpo de `SwapBox()`. Sendo uma string literal, o JS engine optimiza-a (string interning), mas por convenção, constantes estáticas ficam tipicamente no module scope. Neste caso, o impacto é zero — sem re-alocação, sem efeito no rendering.
**Recomendação:** Aceitar como is. Mover para module scope seria mais idiomático mas não é necessário.

---

## Análise Detalhada

### 1. Remoção do banner amber (`QuoteBreakdown.tsx`)

**Antes:** Bloco condicional `{mevExposedBest && (...)}` renderizava um `div` com:
- `border border-amber-500/20 bg-amber-500/5` — borda e fundo amarelos
- `⚠ This route is not MEV-protected.` — texto alarmista
- Sugestão para habilitar Force MEV Protection

**Depois:** Substituído por comentário explicativo (`[LP-04 / hotfix-ui]`) que documenta a razão da remoção e indica a nova localização do advisory. A prop `mevExposedBest` permanece na interface do componente. ✓

**Verificação:**
- Prop preservada para callers → sem breaking change. ✓
- Banner amber completamente removido (não hidden) → sem render residual. ✓

### 2. Novo hint em `SwapBox.tsx`

**Localização:** L797-831, abaixo do botão de swap, acima do bloco de simulation status.

**Condição de rendering:**
```typescript
{mevExposedBest && !mevHintDismissed && (...)}
```

**Verificação:**
- `mevExposedBest` — reutiliza a mesma flag existente. ✓
- `mevHintDismissed` — novo state, default `false`. ✓
- Double guard: hint só aparece quando há exposure E o utilizador não dismissou. ✓

**Visual:**
- Container: `mt-2 flex items-center justify-center gap-2 text-[12px] text-cream-35` — sem ícone, sem background, sem borda. ✓
- Texto: `"CoW Protocol available for MEV protection."` — informativo, não alarmista. ✓
- Botão "Enable": `font-medium text-cream-65 underline-offset-2` com hover states. ✓
- Botão "×": `text-cream-35` com `aria-label="Dismiss MEV protection hint"`. ✓

### 3. "Enable" — `setMevProtected(true)`

```typescript
onClick={() => setMevProtected(true)}
```

**Verificação:**
- `setMevProtected` é o setter do state `mevProtected` (L49), já existente no componente. ✓
- Este toggle controla o Force MEV Protection que filtra routes para CoW-only. ✓
- Um clique em "Enable" activa a protecção para a sessão corrente. ✓
- O hint desaparece implicitamente porque `mevExposedBest` será `false` quando todas as routes passam por CoW. ✓

### 4. "×" — Dismissal com `localStorage`

```typescript
const dismissMevHint = useCallback(() => {
  setMevHintDismissed(true)
  try {
    localStorage.setItem(MEV_HINT_DISMISSED_KEY, '1')
  } catch {
    // Persisting failed — session-only dismissal is still useful.
  }
}, [])
```

**Verificação:**
- `setMevHintDismissed(true)` → UI update imediato. ✓
- `localStorage.setItem` → persiste entre sessões. ✓
- `try/catch` → graceful em private mode / storage disabled. ✓
- `useCallback(... , [])` → deps estáveis (sem referências externas mutáveis). ✓
- Valor escrito: `'1'` (string) — comparado com `=== '1'` na leitura. ✓

### 5. SSR Safety — `useEffect` para `localStorage` read

```typescript
useEffect(() => {
  try {
    if (localStorage.getItem(MEV_HINT_DISMISSED_KEY) === '1') {
      setMevHintDismissed(true)
    }
  } catch {
    // Storage disabled / private mode — treat as not dismissed.
  }
}, [])
```

**Verificação:**
- `useEffect` com `[]` deps → executa apenas no client, após mount. ✓
- SSR: `localStorage` nunca acedido durante server rendering. ✓
- Private mode: `catch` block silencia `SecurityError`. ✓
- Default `false` → hint visível por um frame antes do `useEffect` correr (flash). Aceitável — o hint é discreto e o flash é imperceptível. ✓
- `localStorage` key não contém dados sensíveis (apenas `'1'`). ✓

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Banner amber removido de `QuoteBreakdown.tsx` | **Confirmado** |
| `mevExposedBest` prop preservada | **Confirmado** |
| Hint posicionado abaixo do swap button | **Confirmado** — L797, após `</button>` L774 |
| Visual: 12px muted text, sem ícone, sem background | **Confirmado** — `text-[12px] text-cream-35` |
| "Enable" chama `setMevProtected(true)` | **Confirmado** |
| "×" persiste dismissal em `localStorage` | **Confirmado** — key `teraswap:mev-hint-dismissed`, value `'1'` |
| SSR-safe: `useEffect` para read | **Confirmado** — `useEffect(... , [])` |
| Private mode: `try/catch` em read e write | **Confirmado** |
| Sem XSS: conteúdo estático | **Confirmado** |
| Sem dados sensíveis no diff | **Confirmado** |
| Zero impacto em fund flows | **Confirmado** |
| `aria-label` no botão "×" | **Confirmado** — `"Dismiss MEV protection hint"` |

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

Alteração puramente cosmética e de UX. O banner amber alarmista foi substituído por um hint subtil e dismissível, sem impacto em segurança, fund flows, ou lógica de negócio. SSR-safe e graceful em private mode.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-14*
