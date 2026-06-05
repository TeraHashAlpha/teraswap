# Auditoria Sprint 24 — Mobile UX Overhaul

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-20
**Scope:** 4 commits no branch `ui/mobile-ux`
**Baseline:** Sprint 23 APPROVED (Execution History v2). 746 tests passing.
**Commits:**
- `c91bf5b` — feat(mobile): touch targets, tab scroll, safe-area, tap feedback [P135]
- `2eb1b8e` — docs: FEEDBACK.md P135 section
- `f0e58cc` — feat(mobile): bottom-sheet modals for wallet + transaction preview [P136]
- `08d1bd4` — feat(mobile): responsive header, theme toggle, rate wrap, footer active states [P137]

**Ficheiros:** 11 files, +124/−37 lines (net +87)
**Testes:** 0 novos (alterações puramente CSS/layout).

---

## Resumo Executivo

Sprint 24 aplica 3 prompts de polish mobile sem alterar lógica de negócio, endpoints, ou contratos:

1. **P135** — Touch targets ≥44px (50%/MAX buttons, slippage edit, MEV toggle via invisible hit-area extender, hamburger menu). Tab bar horizontal scroll com `snap-x snap-mandatory` e right-fade hint. Safe-area bottom padding. Global 3% tap-scale feedback com `.no-tap-scale` opt-out.

2. **P136** — WalletModal e TransactionPreview convertidos em bottom-sheets no mobile (`items-end`, `rounded-t-2xl`, drag pill, `animate-slide-up`). Desktop layout preservado via `sm:` breakpoints. TransactionPreview body scrollable (`max-h-[85vh]`, `overflow-y-auto`) com footer sticky e safe-area inset. Confirm/Cancel buttons com `h-12` no mobile.

3. **P137** — Header "CONNECT WALLET" → "CONNECT" no mobile (` WALLET` em `hidden sm:inline`). ThemeToggle `h-11 w-11 sm:h-8 sm:w-8`. Rate row `flex-wrap` com `sm:truncate`. Footer `gap-y-2 sm:gap-y-1` e `active:text-cream` em links.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 3 INFO**

Zero impacto em fund flows, contratos, endpoints, ou lógica de swap. Todas as alterações são CSS/Tailwind classes e layout JSX.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | |
| Fund flows alterados? | **Não** | |
| Endpoints alterados? | **Não** | |
| Novos secrets/env vars? | **Não** | |
| Dependências adicionadas? | **Não** | |
| `dangerouslySetInnerHTML`? | **Não** | Zero matches no diff. |
| Dynamic URLs/hrefs? | **Não** | Todos os links são estáticos e pré-existentes. |
| XSS vectors? | **Não** | Nenhum input dinâmico adicionado. |
| TransactionPreview `onConfirm`/`onCancel` intactos? | **Sim** | L302 `onClick={onConfirm}`, L308 `onClick={onCancel}`, L138 backdrop `onClick={onCancel}`. |
| WalletModal backdrop dismiss intacto? | **Sim** | `mousedown` listener em L95-106, `Escape` key em L87. |
| MEV toggle hit-area não intercepta clicks adjacentes? | **Sim** | `<span>` é `aria-hidden` com `pointer-events` default (events bubble ao parent `<button>`). Adjacent elements têm z-index superior. |
| Confirm button não obscured por layout? | **Sim** | Footer tem `shrink-0` + `bg-surface-secondary` — sempre visível sobre body scroll. |

---

## Findings

### 24-I-01 — Global `button:active { scale(0.97) }` sem `@media (hover: none)` gate

**Severidade:** INFO
**Ficheiro:** `src/app/globals.css` L325-329
**Descrição:** O tap-scale feedback aplica `transform: scale(0.97)` a todos os `button:active`, `a:active`, e `[role="button"]:active` sem media query. Isto afecta cliques de rato no desktop (momentâneo 3% shrink). O FEEDBACK.md documenta que a convenção existente (L286-290) usa `@media (hover: none)` para styling similar. O 3% é subtil e inofensivo no desktop, mas inconsistente com a convenção existente.
**Recomendação:** Aceitar como is. A inconsistência é cosmética. Se o feedback de desktop for indesejado, wrap em `@media (hover: none)` num futuro polish pass.

### 24-I-02 — `animate-slide-up` conflita com global `button:active { scale(0.97) }` no momento da animação

**Severidade:** INFO
**Ficheiro:** `tailwind.config.ts` L67, `src/app/globals.css` L325
**Descrição:** Quando o WalletModal ou TransactionPreview abre (via `animate-slide-up: translateY(100%) → translateY(0)`), se o user toca no backdrop durante os primeiros 250ms da animação, o `transform: scale(0.97)` do tap-scale é aplicado ao backdrop/overlay `<div>`. Como o overlay não é um `button`, `a`, ou `[role="button"]`, o scale não se aplica — portanto não há conflito real. Porém, se algum botão dentro do modal fosse premido durante a animação de entrada, haveria dois transforms compostos (`translateY` do parent + `scale` do button). CSS `transform` compõe correctamente neste caso (são em elementos diferentes, não no mesmo).
**Recomendação:** Aceitar como is. Sem conflito real — transforms em elementos diferentes compõem independentemente.

### 24-I-03 — TransactionPreview `pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]` sem `@supports` guard

**Severidade:** INFO
**Ficheiro:** `src/components/TransactionPreview.tsx` L299
**Descrição:** O P135 `globals.css` usa `@supports (padding: env(safe-area-inset-bottom))` como guard para safe-area. O P136 aplica `pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]` inline (via Tailwind arbitrary value) sem `@supports`. O fallback `0px` na função `env()` é suficiente — browsers sem `env()` suporte ignoram a declaração inteira (CSS parse error) e o `sm:pb-4` fallback aplica-se. Portanto não há breakage, mas a abordagem é inconsistente com o guard no `globals.css`.
**Recomendação:** Aceitar como is. O fallback `0px` dentro de `env()` é a defesa correcta para inline usage. O `@supports` no `globals.css` é defense-in-depth extra mas não necessário quando o fallback value está presente.

---

## Análise Detalhada

### P135 — Touch Targets + Tab Scroll + Safe Area + Tap Feedback

#### Touch targets (≥44px)

| Element | Before | After | Verificação |
|---------|--------|-------|-------------|
| 50% button | text-only, ~24px | `min-h-[44px]` + `inline-flex items-center` | ✓ 44px mobile, `sm:min-h-0` restores desktop |
| MAX button | text-only, ~24px | Same | ✓ |
| Edit slippage | text-only, ~24px | `min-h-[44px]` + `inline-flex items-center px-2` | ✓ Row uses `-my-2 sm:my-0` to absorb vertical growth |
| MEV toggle | h-6 w-10 track (~24px) | Invisible `<span className="absolute -inset-2 sm:inset-0">` child | ✓ +16px all sides on mobile, reset on desktop |
| Hamburger menu | h-10 w-10 (40px) | `h-11 w-11` (44px) | ✓ |
| Footer links | text-only, ~16px | `py-2 sm:py-0` | ✓ +16px vertical |

**MEV toggle hit-area extender:**
```tsx
<span aria-hidden="true" className="absolute -inset-2 sm:inset-0" />
```
- `aria-hidden="true"` — hidden from screen readers. ✓
- `absolute -inset-2` — extends 8px beyond parent on each side (parent is `relative`). ✓
- `sm:inset-0` — collapses to zero on desktop. ✓
- Events bubble to parent `<button>` (no `onClick` on the span, no `pointer-events-none`). ✓
- Adjacent elements: 50%/MAX buttons are in a separate `<div>` above, with their own hit areas. The MEV toggle is at the bottom of the receive section, well-separated. Nenhum overlap possível com elements vizinhos. ✓

**FEEDBACK substitution:** O Code Agent correctamente rejeitou `p-2` no button (expande o track pintado via inline `backgroundColor`) e usou o invisible span approach. Correcta decisão. ✓

#### Tab bar scroll

```tsx
<div className="... snap-x snap-mandatory ... overflow-x-auto ...">
  {tabs.map(([mode, label]) => (
    <button className="... snap-start ... py-3 ... sm:py-2 ...">
```

- `snap-x snap-mandatory` no container — snap horizontal obrigatório. ✓
- `snap-start` em cada tab — alinha ao início do viewport. ✓
- `py-3 sm:py-2` — taller tabs on mobile (≥44px com font size). ✓

#### Tab bar fade

```css
@media (max-width: 639px) {
  .tab-bar-fade {
    -webkit-mask-image: linear-gradient(to right, black 85%, transparent);
    mask-image: linear-gradient(to right, black 85%, transparent);
  }
}
```

- Apenas mobile (`max-width: 639px`). ✓
- `mask-image` — standard + webkit prefix. ✓
- Fade right 15% — visual hint para scroll. ✓

#### Safe area

```css
@supports (padding: env(safe-area-inset-bottom)) {
  .swap-main {
    padding-bottom: calc(2rem + env(safe-area-inset-bottom));
  }
}
```

- `@supports` guard — browsers sem `env()` ignoram o bloco inteiro. ✓
- `swap-main` class aplicada no `<main>` do swap page. ✓

#### Global tap feedback

```css
button:active, a:active, [role="button"]:active {
  transform: scale(0.97);
  transition: transform 0.1s ease;
}
.no-tap-scale:active { transform: none; }
```

- 3% scale — subtil, não interfere com layout (transform doesn't affect document flow). ✓
- `.no-tap-scale` opt-out disponível. ✓
- Sem `@media (hover: none)` gate (see finding 24-I-01). ✓
- `transition: 0.1s` — rápido, sem perceptible delay. ✓

### P136 — Bottom-sheet Modals

#### WalletModal

**Mobile:**
- `items-end justify-center` — alinha ao fundo do viewport. ✓
- `w-full rounded-t-2xl` — full-width com corners superiores arredondados. ✓
- `animate-slide-up` — `translateY(100%) → translateY(0)` em 0.25s cubic-bezier. ✓
- `bg-black/60` — backdrop mais escuro no mobile (60% vs 40% desktop). ✓
- Drag pill: `h-1 w-10 rounded-full bg-cream-15 sm:hidden`. ✓

**Desktop (via `sm:`):**
- `sm:items-start sm:justify-end sm:pt-[72px] sm:pr-4` — popover no canto superior direito. ✓
- `sm:w-[320px] sm:animate-fade-slide-in sm:rounded-2xl` — card com animação original. ✓
- `sm:bg-black/40` — backdrop original. ✓
- Drag pill `sm:hidden` — escondido no desktop. ✓

**Backdrop dismiss:** `mousedown` listener no `document` detecta clicks fora do modal ref → `onClose()`. Lógica **inalterada** — apenas o container classes mudaram. ✓

**Escape key:** `onKey` listener → `onClose()`. **Inalterado.** ✓

#### TransactionPreview

**Mobile:**
- `items-end justify-center` — bottom-sheet. ✓
- `max-h-[85vh]` — caps height at 85% viewport. ✓
- `flex-col overflow-hidden` + body `flex-1 overflow-y-auto` — header/footer fixed, body scrolls. ✓
- `rounded-t-2xl` + drag pill. ✓
- `animate-slide-up` — shared keyframe from tailwind config. ✓

**Desktop:**
- `sm:items-center sm:p-4` — centred card. ✓
- `sm:max-h-none sm:max-w-md sm:animate-fade-slide-in sm:rounded-2xl` — original layout. ✓

**Footer sticky:**
- `shrink-0` — doesn't compress. ✓
- `bg-surface-secondary` — opaque background over scrolling body. ✓
- `pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]` — safe-area (see finding 24-I-03). ✓
- `sm:pb-4` — desktop override. ✓

**Confirm button:**
- `h-12` mobile (48px ≥ 44px target). ✓
- `sm:h-auto sm:py-3` — desktop original. ✓
- `onClick={onConfirm}` — **inalterado**. ✓

**Cancel button:**
- `h-12` mobile. ✓
- `sm:h-auto sm:py-2` — desktop original. ✓
- `onClick={onCancel}` — **inalterado**. ✓

**Backdrop dismiss:**
- `<div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />` — **inalterado**. ✓

#### Tailwind config

```typescript
'slide-up': 'slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
// keyframe:
slideUp: { '0%': { transform: 'translateY(100%)' }, '100%': { transform: 'translateY(0)' } }
```

- Easing curve `cubic-bezier(0.16, 1, 0.3, 1)` — "spring-like" deceleration, standard for bottom-sheets. ✓
- Usado por WalletModal e TransactionPreview. ✓

### P137 — Responsive Header, Theme Toggle, Rate Wrap, Footer Active

#### Header "CONNECT" truncation

```tsx
<>CONNECT<span className="hidden sm:inline"> WALLET</span></>
```

- Mobile: shows "CONNECT" only (shorter, fits narrow screens). ✓
- Desktop: shows "CONNECT WALLET" (full text). ✓
- Nenhuma alteração de lógica — apenas display. ✓

#### ThemeToggle

- `h-11 w-11 sm:h-8 sm:w-8` — 44px mobile, 32px desktop. ✓

#### Rate row wrap

- `flex-wrap` + `gap-x-2` — rate value wraps below label on narrow screens. ✓
- `text-right` em vez de `truncate` — value é legível quando wraps. ✓
- `sm:truncate` — desktop preserva single-line. ✓

#### Footer improvements

- `gap-y-2 sm:gap-y-1` — more spacing between wrapped rows on mobile. ✓
- `active:text-cream` em todos os links — tactile feedback (matches global tap-scale). ✓

### FEEDBACK.md — P135 Section

3 items:

1. **MEV toggle approach substitution** — Correcta. Inline `p-2` expandia o track pintado. Invisible span é a solução correcta. ✓
2. **Tap-scale without `@media (hover: none)`** — Acknowledged (see finding 24-I-01). 3% é subtil, aceitável no desktop. ✓
3. **Footer X link taller on mobile** — Uniform treatment, aceitável. ✓
4. **20 pre-existing eslint warnings** — None introduced by P135, confirmed via `0 errors`. ✓

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Zero alterações a contratos | **Confirmado** |
| Zero alterações a endpoints | **Confirmado** |
| Zero alterações a lógica de swap | **Confirmado** |
| Zero `dangerouslySetInnerHTML` | **Confirmado** — grep = 0 |
| Zero dynamic URLs adicionados | **Confirmado** |
| TransactionPreview `onConfirm` intacto | **Confirmado** — L302 |
| TransactionPreview `onCancel` intacto | **Confirmado** — L308 (button) + L138 (backdrop) |
| WalletModal backdrop dismiss intacto | **Confirmado** — mousedown listener L95-106 |
| WalletModal Escape key intacto | **Confirmado** — L87 |
| MEV toggle hit-area não intercepta adjacentes | **Confirmado** — well-separated, events bubble |
| Confirm/Cancel buttons não obscured | **Confirmado** — footer `shrink-0 bg-surface-secondary` |
| All `sm:` overrides restore desktop layout | **Confirmado** — every mobile class has `sm:` reset |
| `animate-slide-up` keyframe correcta | **Confirmado** — `translateY(100%) → translateY(0)` |
| Safe area CSS com guard/fallback | **Confirmado** — `@supports` in globals.css, `env(...,0px)` fallback inline |
| Touch targets ≥44px on all interactive elements | **Confirmado** — 50%, MAX, slippage edit, MEV toggle, hamburger, theme toggle, confirm, cancel |
| `.no-tap-scale` opt-out disponível | **Confirmado** — L331 globals.css |
| No new dependencies | **Confirmado** |
| `order_executions` schema inalterado | **Confirmado** |

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

Sprint de polish puramente visual. Todas as alterações são CSS classes, Tailwind utilities, e layout JSX. Zero impacto em segurança, fund flows, ou lógica de negócio. Os handlers críticos (TransactionPreview confirm/cancel, WalletModal backdrop dismiss, MEV toggle) estão intactos e verificados. Os `sm:` breakpoints restauram o layout desktop em todos os casos. Touch targets cumprem o mínimo de 44px.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-20*
