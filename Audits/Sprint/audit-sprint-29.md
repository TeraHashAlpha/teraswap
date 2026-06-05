# Audit Report — Sprint 29 (Performance Optimization)

| Field | Value |
|---|---|
| **Sprint** | 29 |
| **Branch** | `perf/sprint-29-optimization` |
| **Commits** | 4 (`9f29880`, `da88090`, `92b9cd9`, `2b3d98b`) |
| **Prompts** | P89, P90, P91, P92 |
| **Auditor** | Claude (Senior Security Auditor) |
| **Date** | 2026-05-26 |
| **Verdict** | **APPROVED — 0C / 0H / 0M / 0L / 4 INFO** |

---

## Scope

Performance optimization sprint: self-host Google Fonts, preconnect hints, below-fold lazy loading, viem/wagmi chunk splitting. 7 files changed across 4 commits. Zero production logic — pure build/load optimisation.

### Files in diff

| File | Change | Prompt |
|---|---|---|
| `next.config.js` | Modified | P89, P92 |
| `src/app/globals.css` | Modified | P89 |
| `src/app/layout.tsx` | Modified | P89, P90 |
| `tailwind.config.ts` | Modified | P89 |
| `src/components/LandingPage.tsx` | Modified | P91 |
| `src/components/LandingBelowFold.tsx` | **NEW** | P91 |
| `FEEDBACK.md` | Modified | P92 |

---

## P89 — Self-host Google Fonts (`9f29880`)

### Checklist

| Check | Result |
|---|---|
| `@import url('https://fonts.googleapis.com/...')` removed from `globals.css` | ✅ Line 1 deleted |
| `next/font/google` imports in `layout.tsx` | ✅ `Inter` (400–800) + `JetBrains_Mono` (400–600) |
| CSS variables `--font-inter` / `--font-mono` on `<html>` | ✅ `className={\`dark ${inter.variable} ${jetbrainsMono.variable}\`}` |
| `tailwind.config.ts` fontFamily wired to CSS vars | ✅ `sans: ['var(--font-inter)', ...]`, `mono: ['var(--font-mono)', ...]` |
| `body` font-family uses `var(--font-inter)` | ✅ `globals.css` line 60 |
| `display: 'swap'` on both fonts | ✅ |
| CSP `style-src` — `fonts.googleapis.com` removed | ✅ |
| CSP `font-src` — `fonts.gstatic.com` removed | ✅ |
| CSP `font-src` — `cdn.fontshare.com` retained | ✅ |
| Clash Display `@font-face` block in `globals.css` untouched | ✅ Not in diff |
| Clash Display `<link rel="preload">` in `layout.tsx` untouched | ✅ Still present at line 92–97 |

**Verdict:** Conforme. CSP tightening removes two external origins from the attack surface — security-positive change.

---

## P90 — Preconnect hints (`da88090`)

### Checklist

| Check | Result |
|---|---|
| `<link rel="preconnect" href="https://cdn.fontshare.com" crossOrigin="anonymous" />` | ✅ Line 89 |
| `<link rel="dns-prefetch" href="https://cdn.fontshare.com" />` | ✅ Line 90 |
| Placed before Clash Display `<link rel="preload">` | ✅ Preconnect at 89–90, preload at 92 |
| No excessive preconnect hints | ✅ Only fontshare CDN |
| Existing Clash Display preload untouched | ✅ |

**Verdict:** Conforme. Minimal, correct.

---

## P91 — Below-fold lazy loading (`92b9cd9`)

### Checklist

| Check | Result |
|---|---|
| `LandingBelowFold.tsx` exists (new file) | ✅ 987 lines |
| `dynamic()` import in `LandingPage.tsx` with `ssr: true` | ✅ Line 32 |
| Loading placeholder reserves scroll height | ✅ `minHeight: '200vh'` |
| Hero section remains in `LandingPage.tsx` | ✅ `HeroSection` component at line ~195 |
| `scrollProgressRef` not needed by BelowFold | ✅ Only `useRef` is for `AnimatedCounter` IntersectionObserver — local ref, no cross-component dependency |
| `onLaunchApp` prop threaded correctly | ✅ Passed to `LandingBelowFold` → `ExperienceSection` + `BottomCTASection` |
| All 6 below-fold sections present | ✅ Performance, Differentiation, Security, Experience, Features, BottomCTA |
| `'use client'` directive on new file | ✅ Line 1 |
| Default export present | ✅ `export default function LandingBelowFold` |
| No ParticleNetwork/ScrollSpy changes | ✅ Not in P91 diff |

**Verdict:** Conforme. Clean component boundary — the below-fold chunk is fully self-contained.

---

## P92 — Webpack splitChunks (`2b3d98b`)

### Checklist

| Check | Result |
|---|---|
| `webpack()` config added to `next.config.js` | ✅ Lines 89–114 |
| cacheGroups: `viem` (priority 30) and `wagmi` (priority 25) | ✅ |
| Spread preserves existing splitChunks config | ✅ `...config.optimization.splitChunks` |
| `withSentryConfig` wraps AFTER custom webpack | ✅ `module.exports = withSentryConfig(nextConfig, {...})` at bottom |
| FEEDBACK.md documents 0KB savings / Turbopack limitation | ✅ Detailed entry: Turbopack ignores webpack callback, `--webpack` fails on unrelated issues |
| Viem import audit in FEEDBACK.md | ✅ All imports are named utilities + `{ mainnet }` from `viem/chains`; no heavy sub-modules |
| No runtime behaviour change | ✅ Config is no-op under Turbopack |

**Verdict:** Conforme. O webpack config é inerte sob Turbopack (Next.js 16 default). O FEEDBACK.md documenta correctamente a limitação e recomenda diferimento — alinhado com a nota 5 do Architect.

---

## Cross-cutting checks

| Check | Result |
|---|---|
| New dependencies in `package.json` | ✅ None (diff empty) |
| Production logic files changed | ✅ None — only layout, config, CSS, landing UI |
| Contract / fund-flow changes | ✅ None |
| API route changes | ✅ None |
| Hooks / lib / state management changes | ✅ None |
| Security-sensitive file changes | ✅ CSP tightened (P89) — positive |
| Forbidden file patterns (`.env`, secrets) | ✅ None |

---

## Findings

### 29-I-01 — Duplicated animation constants (INFO)

**Ficheiros:** `LandingPage.tsx`, `LandingBelowFold.tsx`

`easeOutExpo`, `HEADLINE_TEXT_SHADOW`, `BODY_TEXT_SHADOW`, `IS_MOBILE_VIEWPORT`, `PREFERS_REDUCED`, `SplitText`, `AnimatedCounter`, `SectionHeadline` — todos duplicados entre os dois ficheiros.

O Code Agent documenta no header do `LandingBelowFold.tsx` que a duplicação é **intencional** para manter o chunk self-contained e evitar que o dynamic import puxe dependências do parent bundle para o initial bundle.

**Recomendação:** Extrair para um ficheiro partilhado (`landing-shared.ts`) num sprint futuro. O bundler incluirá esse módulo apenas no chunk que o importa primeiro. Risco actual: se um valor for alterado num ficheiro e não no outro, as secções ficam visualmente inconsistentes. Baixa probabilidade dado que são constantes estáticas.

**Severidade:** INFO — decisão de engenharia justificada, com risco de manutenção documentado.

---

### 29-I-02 — P92 webpack config inerte sob Turbopack (INFO)

**Ficheiro:** `next.config.js`

O `webpack()` callback é silenciosamente ignorado pelo Turbopack (Next.js 16 default). Savings medidos: 0 KB. O Architect definiu limiar de 20 KB para justificar a complexidade (nota 5).

O Code Agent recomenda manter como documentação / forward-compat. Sem custo runtime (no-op), sem risco.

**Severidade:** INFO — devidamente documentado no FEEDBACK.md. O Architect pode decidir reverter ou manter.

---

### 29-I-03 — Preconnect ordering é óptimo (INFO)

**Ficheiro:** `layout.tsx`

As tags `<link rel="preconnect">` e `<link rel="dns-prefetch">` para `cdn.fontshare.com` estão posicionadas **antes** do `<link rel="preload">` do Clash Display woff2. Esta é a ordenação correcta — o browser inicia o TLS handshake antes de encontrar o recurso que precisa dele.

**Severidade:** INFO — nota positiva.

---

### 29-I-04 — CSP tightening reduz superfície de ataque (INFO)

**Ficheiro:** `next.config.js`

A remoção de `https://fonts.googleapis.com` do `style-src` e `https://fonts.gstatic.com` do `font-src` elimina duas origens externas da CSP. Isto é uma melhoria de segurança — reduz vectores de exfiltração via CSS injection e limita origens de onde fonts podem ser carregadas.

Nenhuma outra funcionalidade do TeraSwap depende destas origens (verificado: zero referências a `googleapis.com` ou `gstatic.com` no diff completo do branch).

**Severidade:** INFO — melhoria de segurança positiva.

---

## Verdict

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| Low | 0 | — |
| Info | 4 | 29-I-01, 29-I-02, 29-I-03, 29-I-04 |

**APPROVED — 0C / 0H / 0M / 0L / 4 INFO**

Sprint 29 é um sprint de optimização de performance puro — zero alterações a lógica de produção, contratos, ou fluxos de fundos. A CSP é apertada (remoção de 2 origens externas), a separação de código é limpa, e o FEEDBACK.md documenta correctamente a limitação do Turbopack. Seguro para merge.
