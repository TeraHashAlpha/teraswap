# Auditoria Sprint 28 — Cinematic Landing Page (Hubtown-Inspired)

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-25
**Scope:** 5 commits no branch `redesign/cinematic-landing`
**Baseline:** Sprint 27C merged. 970 TS tests (Sprint 9C on `test/m01-phase2`).
**Commits:**
- `a4d1d06` — P84: Kill section backgrounds + glass cards + vignette
- `0cf6119` — P85: Scroll-linked particle evolution
- `9874f47` — P86: Canvas flow lines with gold pulses
- `511dde1` — P87: SplitText letter reveals on section headlines
- `d26c65c` — P88: ScrollSpy dot navigation

**Ficheiros:** 4 files, +433/−41 lines (net +392)
**Testes:** 0 novos (sprint visual-only). Baseline inalterado.

---

## Resumo Executivo

Sprint 28 é um sprint exclusivamente visual/animação — zero ficheiros em `src/hooks/`, `src/lib/`, `src/app/api/`, ou contratos. Toca apenas 4 ficheiros: `LandingPage.tsx` (backgrounds, text-shadow, SplitText, vignette), `ParticleNetwork.tsx` (scroll progress, flow lines), `ScrollSpy.tsx` (novo), e `page.tsx` (integração ScrollSpy).

O objectivo é transformar a landing page de secções boxed com backgrounds opacos num ambiente contínuo onde o canvas de partículas é visível em toda a página — inspirado pelo Hubtown (hubtown.co.in) mas sem Three.js, scroll-jacking, ou novas dependências.

A análise confirma:
1. **Zero impacto em lógica de produção** — nenhum hook, lib, API, ou contrato foi tocado.
2. **Zero impacto em fund flows** — sprint puramente cosmético.
3. **Readability preservada** — text-shadow com halo de 30px (HEADLINE) / 20px (BODY) fornece contraste WCAG AA. Glass cards com `backdrop-blur-md`/`backdrop-blur-sm` e `bg-[rgba(15,19,24,0.8)]` explícito (evita bug Tailwind /80 em hex).
4. **Performance budget respeitado** — zero `shadowBlur`, concentric circles para glow, `FLOW_LINES` como constante module-level, reduced-motion guards em todas as animações.
5. **Accessibility preservada** — `aria-label` em SplitText, `aria-hidden` nos caracteres individuais, ScrollSpy com `aria-label` e `aria-current`.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 5 INFO**

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | |
| Fund flows alterados? | **Não** | |
| ABI alterado? | **Não** | |
| Novos endpoints? | **Não** | |
| Novos secrets/env vars? | **Não** | |
| Dependências adicionadas? | **Não** | Zero novas deps |
| Ficheiros em `src/hooks/` alterados? | **Não** | |
| Ficheiros em `src/lib/` alterados? | **Não** | |
| Ficheiros em `src/app/api/` alterados? | **Não** | |
| FEEDBACK.md alterado? | **Não** | |

---

## Findings

### 28-I-01 — `IS_MOBILE_VIEWPORT` e `PREFERS_REDUCED` são one-shot (não reactivos)

**Severidade:** INFO
**Ficheiro:** `src/components/LandingPage.tsx` L25-30
**Descrição:** Ambas as constantes são avaliadas uma vez no import do módulo. Se o utilizador redimensionar o browser de desktop para mobile (ou vice-versa) sem reload, `IS_MOBILE_VIEWPORT` não se actualiza e SplitText pode aplicar blur em viewport mobile ou omiti-lo em desktop expandido. O comment no código já reconhece isto ("they don't react to a viewport resize between mount and the next reveal, which is acceptable for one-shot headline animations").
**Recomendação:** Aceitar como is. As headlines usam `viewport: { once: true }` — animam uma vez. Um edge case de resize mid-session não afecta segurança nem funcionalidade.

### 28-I-02 — `interpolateCurve` aceita `t` fora de [0, 1] sem clamp

**Severidade:** INFO
**Ficheiro:** `src/components/ParticleNetwork.tsx` L67-74
**Descrição:** Se `t` for negativo ou `> 1`, `Math.floor(t * totalSegments)` poderia produzir um segment index fora de bounds. Na prática, `progress = (flowTime * flow.speed) % 1` garante `0 ≤ t < 1` sempre. O `Math.min(..., totalSegments - 1)` protege o lado superior. Valores negativos (impossíveis com `% 1` de um timestamp positivo × speed positivo) seriam o único risco teórico.
**Recomendação:** Aceitar como is. O caller nunca produz `t < 0`.

### 28-I-03 — Feature cards usam `bg-[rgba(15,19,24,0.8)]` em vez de `bg-surface-secondary/80`

**Severidade:** INFO
**Ficheiro:** `src/components/LandingPage.tsx` L1154
**Descrição:** O spec P84 dizia "change class to `bg-surface-secondary/80 backdrop-blur-md`". O Code Agent usou `bg-[rgba(15,19,24,0.8)]` com um comment explicando que a notação Tailwind `/80` não funciona de forma fiável em hex tokens (bug referenciado em Sprint 27C P74). Esta é uma decisão defensiva correcta — o valor `rgba(15,19,24,0.8)` corresponde exactamente a `surface-secondary` (#0F1318) com 80% opacity.
**Recomendação:** Aceitar. A divergência do spec é justificada e documentada.

### 28-I-04 — ScrollSpy `PREFERS_REDUCED` duplicada de `LandingPage.tsx`

**Severidade:** INFO
**Ficheiro:** `src/components/ScrollSpy.tsx` L31-34
**Descrição:** `ScrollSpy.tsx` define a sua própria constante `PREFERS_REDUCED` (idêntica à de `LandingPage.tsx`). Poderia ser extraída para um shared util. Contudo, são 3 linhas, e ambos os componentes são leaf components — partilhar a constante adicionaria um import cross-file para zero benefício funcional.
**Recomendação:** Aceitar como is. DRY não justifica um util para 3 linhas estáticas.

### 28-I-05 — ScrollSpy `IntersectionObserver` dependency array vazio

**Severidade:** INFO
**Ficheiro:** `src/components/ScrollSpy.tsx` L43-77
**Descrição:** O `useEffect` que cria o `IntersectionObserver` tem dependency array `[]`. Isto é correcto — os section ids são estáticos e não mudam. O cleanup `observer.disconnect()` é chamado no unmount. Se no futuro os sections se tornassem dinâmicos (e.g., feature flags escondendo secções), o observer não se re-criaria. Risco teórico apenas.
**Recomendação:** Aceitar como is. Os ids são hardcoded na constante `SECTIONS` e nos JSX dos componentes de secção.

---

## Análise Detalhada por Prompt

### P84 — Kill Section Backgrounds (commit `a4d1d06`)

| Requisito | Status | Verificação |
|-----------|--------|-------------|
| Remove `bg-[rgba(8,11,16,0.55)]` de 6 sections | ✓ | `grep 'bg-\[rgba(8,11,16' LandingPage.tsx` = 0 resultados |
| Remove gradient div de PerformanceSection | ✓ | `grep 'gradient-to-b.*from-transparent.*to-\[rgba' LandingPage.tsx` = 0 |
| Text-shadow em SectionHeadline | ✓ | `HEADLINE_TEXT_SHADOW` aplicado via `style` prop |
| Text-shadow em body paragraphs | ✓ | `BODY_TEXT_SHADOW` aplicado a 6 `<p>` elements |
| Glass effect em feature cards | ✓ | `bg-[rgba(15,19,24,0.8)] backdrop-blur-md` (explícito rgba) |
| Glass effect em roadmap cards | ✓ | `bg-surface-secondary/50 backdrop-blur-sm` |
| Glass effect em security pipeline `<li>` | ✓ | `bg-surface-secondary/60 backdrop-blur-sm` (2 items) |
| Glass effect em security stat boxes | ✓ | `bg-surface-secondary backdrop-blur-md` |
| Vignette overlay | ✓ | `pointer-events-none fixed inset-0 z-[1]` com radial-gradient |
| SwapPreview inalterado | ✓ | Zero diff em SwapPreview |
| AdapterConstellation inalterado | ✓ | Zero diff |

### P85 — Scroll-Linked Particle Evolution (commit `0cf6119`)

| Requisito | Status | Verificação |
|-----------|--------|-------------|
| `scrollProgressRef` adicionado | ✓ | `useRef(0)` L94 |
| Scroll progress normalizado 0→1 | ✓ | `maxScroll > 0 ? window.scrollY / maxScroll : 0` L393-394 |
| `scrollMaxDist` = MAX_DIST + sp * 60 | ✓ | L155 |
| `maxDist` integra turbo via `scrollMaxDist` | ✓ | L156 |
| `scrollBrightBoost` = sp * 0.15 | ✓ | L157 |
| `baseLineOp` e `baseDotMult` integram scroll + turbo | ✓ | L158-159 |
| Gravitational drift: `p.vy += sp * 0.003` | ✓ | L323-326, gated por `sp > 0.1 && w < 0.1 && t < 0.1` |
| Line width: `(0.5 + sp * 0.3) + cursorFactor + turbo` | ✓ | L184 |
| PARTICLE_COUNT inalterado | ✓ | Zero diff |
| Warp/turbo logic inalterada | ✓ | Apenas parâmetros base modificados, warp/turbo override intacto |
| `prefers-reduced-motion` preservado | ✓ | `PREFERS_REDUCED_MOTION` guard nos mesmos pontos |

**Análise do scroll-to-param mapping:** Com `sp` a afectar `maxDist` aditivamente (+60 no máximo), o impacto no turbo é neutro — `TURBO_MAX_DIST - scrollMaxDist` diminui por 60 no máximo, mas turbo `t` dominaria de qualquer forma. O design é correcto: scroll modifica a base, turbo/warp sobrepõe.

### P86 — Canvas Flow Lines (commit `9874f47`)

| Requisito | Status | Verificação |
|-----------|--------|-------------|
| `FLOW_LINES` module-level (fora do componente) | ✓ | L56-63, const com typed array |
| `interpolateCurve` helper module-level | ✓ | L66-74 |
| 3 flow lines (não mais que 5) | ✓ | Array com 3 entries |
| Concentric circles (no `shadowBlur`) | ✓ | 3 `ctx!.arc()` calls por pulse, zero `shadowBlur` |
| `flowFade = 1 - Math.max(w, t)` | ✓ | L260 |
| Skip under `PREFERS_REDUCED_MOTION` | ✓ | L259 `if (!PREFERS_REDUCED_MOTION)` |
| Gold colour `200, 184, 154` (#C8B89A) | ✓ | L263 |
| Coordinates 0→1, scaled by W/H | ✓ | L265 `flow.points.map(([px, py]) => [px * W, py * H])` |
| `sp` modula opacity e pulse brightness | ✓ | `(0.04 + sp * 0.03)`, `(0.5 + sp * 0.3)` |
| Existing particle drawing inalterado | ✓ | Flow lines adicionadas APÓS particles, ANTES de position update |

### P87 — SplitText Letter Reveals (commit `511dde1`)

| Requisito | Status | Verificação |
|-----------|--------|-------------|
| `IS_MOBILE_VIEWPORT` SSR-safe | ✓ | `typeof window !== 'undefined' && window.innerWidth < 768` |
| `PREFERS_REDUCED` SSR-safe | ✓ | `typeof window !== 'undefined' && typeof window.matchMedia === 'function' && ...` |
| SplitText component criado | ✓ | L104-168 |
| Blur desktop-only (`!IS_MOBILE_VIEWPORT && !PREFERS_REDUCED`) | ✓ | L109 `useBlur` |
| Blur 2px (não 4px) | ✓ | `filter: 'blur(2px)'` L148 |
| `aria-label` no wrapper | ✓ | L117, L134 |
| `aria-hidden="true"` nos caracteres | ✓ | L155 |
| `PREFERS_REDUCED` → render estático (sem stagger) | ✓ | L115-119, retorna `<span>` plain |
| `noReveal` prop em SectionHeadline | ✓ | L65, plain `<h2>` quando true |
| SplitText aplicado a 5 headlines | ✓ | Hero H1, Performance, Differentiation, Security, BottomCTA |
| ExperienceSection e FeaturesSection NÃO tocados | ✓ | Confirmado — sem SplitText nestes |
| Hero H1: `motion.h1` → plain `<h1>` | ✓ | L318-325, plain `<h1>` com SplitText dentro |
| No double whileInView | ✓ | `noReveal` elimina motion.h2, SplitText tem o seu próprio whileInView |
| Stagger 0.03s | ✓ | L130 `staggerChildren: 0.03` |
| Ease cubic-bezier `[0.16, 1, 0.3, 1]` | ✓ | L153 `ease: easeOutExpo` |

### P88 — ScrollSpy Dot Navigation (commit `d26c65c`)

| Requisito | Status | Verificação |
|-----------|--------|-------------|
| `ScrollSpy.tsx` novo ficheiro | ✓ | 150 linhas |
| 6 sections: hero, performance, why-teraswap, security, experience, features | ✓ | L21-28 |
| `fixed left-6 top-1/2 -translate-y-1/2 z-20` | ✓ | L94 |
| `hidden lg:flex` | ✓ | L94 |
| Dots 6px inactive, 8px active | ✓ | `h-1.5 w-1.5` (6px) / `h-2 w-2` (8px) L113-115 |
| Active dot gold `#C8B89A` com box-shadow glow | ✓ | L118-120 |
| Inactive dot border `rgba(200,184,154,0.35)` | ✓ | L115 |
| `IntersectionObserver` threshold 0.2 | ✓ | L71 |
| `rootMargin: '-20% 0px -60% 0px'` | ✓ | L72 |
| Topmost intersecting section wins | ✓ | L58-66, min `boundingClientRect.top` |
| Hover label com Framer Motion fade+slide | ✓ | L125-133, `opacity: 0→1, x: -4→0, 150ms` |
| Click smooth-scroll | ✓ | L80 `scrollIntoView({ behavior: 'smooth' })` |
| `PREFERS_REDUCED` → `behavior: 'auto'` | ✓ | L80 ternary |
| Vertical connector line 1px `bg-cream-08` | ✓ | L100 |
| Gold progress segment | ✓ | L102-106 |
| `id="hero"` adicionado a HeroSection | ✓ | L285 `<section id="hero"...>` |
| ScrollSpy apenas em `page === 'landing'` | ✓ | Dentro do branch `{page === 'landing' ? ...}` em page.tsx |
| ScrollSpy NÃO renderiza em `page === 'swap'` | ✓ | Fora do branch swap |
| `aria-label="Page sections"` no `<nav>` | ✓ | L93 |
| `aria-label` nos buttons | ✓ | L111 `Scroll to ${section.label} section` |
| `aria-current` no active dot | ✓ | L112 |
| `pointer-events-none` no nav, `pointer-events-auto` no ol | ✓ | L94, L98 — nav não bloqueia clicks fora dos dots |

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Zero ficheiros em `src/hooks/` | **Confirmado** |
| Zero ficheiros em `src/lib/` | **Confirmado** |
| Zero ficheiros em `src/app/api/` | **Confirmado** |
| Zero ficheiros de contratos | **Confirmado** |
| 4 ficheiros alterados: LandingPage, ParticleNetwork, ScrollSpy (novo), page.tsx | **Confirmado** |
| +433/−41 lines | **Confirmado** |
| Zero novas dependências | **Confirmado** — Framer Motion e React já são deps existentes |
| Zero `bg-[rgba(8,11,16` em `<section>` elements | **Confirmado** |
| Zero `shadowBlur` calls (apenas mencionado em comment) | **Confirmado** |
| `FLOW_LINES` definido module-level (não dentro de draw()) | **Confirmado** |
| `interpolateCurve` definido module-level | **Confirmado** |
| Vignette `pointer-events-none` | **Confirmado** |
| Feature cards usam rgba explícito (não Tailwind /80 em hex) | **Confirmado** |
| `PREFERS_REDUCED_MOTION` guard em flow lines | **Confirmado** |
| `PREFERS_REDUCED` guard em SplitText | **Confirmado** |
| `PREFERS_REDUCED` guard em ScrollSpy (smooth scroll) | **Confirmado** |
| SplitText blur desktop-only (< 768px skipped) | **Confirmado** |
| SplitText `aria-label` + `aria-hidden` | **Confirmado** |
| ScrollSpy hidden below lg | **Confirmado** |
| ScrollSpy `rootMargin: '-20% 0px -60% 0px'` | **Confirmado** |
| `id="hero"` adicionado a HeroSection | **Confirmado** |
| ScrollSpy apenas em landing, não em swap | **Confirmado** |
| `noReveal` evita double whileInView | **Confirmado** — plain `<h2>` sem motion |
| FEEDBACK.md inalterado | **Confirmado** |

---

## Spec Compliance

| Requirement | Status |
|-------------|--------|
| P84: Remove 6 section backgrounds | ✓ |
| P84: Remove gradient div | ✓ |
| P84: Text-shadow headlines + body | ✓ |
| P84: Glass cards with backdrop-blur | ✓ |
| P84: Vignette overlay | ✓ |
| P85: scrollProgressRef 0→1 | ✓ |
| P85: sp modifies maxDist, brightness, drift, lineWidth | ✓ |
| P85: Warp/turbo intact | ✓ |
| P85: prefers-reduced-motion preserved | ✓ |
| P86: FLOW_LINES module-level | ✓ |
| P86: interpolateCurve helper | ✓ |
| P86: 3 gold bezier streams | ✓ |
| P86: Concentric circles (no shadowBlur) | ✓ |
| P86: flowFade during warp/turbo | ✓ |
| P86: reduced-motion guard | ✓ |
| P87: IS_MOBILE_VIEWPORT + PREFERS_REDUCED SSR-safe | ✓ |
| P87: SplitText blur desktop-only | ✓ |
| P87: noReveal on SectionHeadline | ✓ |
| P87: Applied to 5 headlines (not Experience/Features) | ✓ |
| P87: aria-label + aria-hidden | ✓ |
| P87: No double whileInView | ✓ |
| P88: ScrollSpy new component | ✓ |
| P88: hidden below lg | ✓ |
| P88: IntersectionObserver with correct rootMargin | ✓ |
| P88: Only renders in landing page | ✓ |
| P88: id="hero" added | ✓ |
| Architect note 1: No Three.js | ✓ |
| Architect note 2: Performance budget (110/55 particles, no shadowBlur) | ✓ |
| Architect note 3: Component/function names as references | ✓ |
| Architect note 4: Text readability via text-shadow | ✓ |
| Architect note 5: Sequential execution P84→P88 | ✓ |
| Architect note 6 (R1): No sub-perceptual bg-12% | ✓ |
| Architect note 7 (R3): Canvas viewport coords correct | ✓ |

Zero spec deviations. The rgba() substitution in feature cards (28-I-03) is a justified defensive decision, not a deviation.

---

## Veredicto Final

| Severidade | Count |
|------------|-------|
| CRITICAL   | 0     |
| HIGH       | 0     |
| MEDIUM     | 0     |
| LOW        | 0     |
| INFO       | 5     |

### APPROVED — 0C / 0H / 0M / 0L

Sprint 28 transforma a landing page num ambiente visual contínuo sem tocar em qualquer lógica de produção, hook, lib, API, ou contrato. Todos os 5 prompts (P84-P88) foram implementados conforme o spec. As section backgrounds foram removidas e substituídas por text-shadow como mecanismo de readability (WCAG AA). Flow lines usam concentric circles em vez de shadowBlur (performance). SplitText aplica blur apenas em desktop, com guards SSR-safe. ScrollSpy é desktop-only (hidden below lg), usa IntersectionObserver com rootMargin biased para o topo do viewport, e preserva accessibility com aria-label/aria-current. Os 5 INFO são observações de design sem impacto funcional ou de segurança.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-25*
