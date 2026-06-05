# Auditoria Sprint 11.5 — DX + Security Hygiene

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-13
**Scope:** 7 commits — P83 (758fe0c), P84 (4cf8a70), P85 (d39e1ee), P86 (c85812f), P87 (ff559d3), P88 (81c7679), P89 (5aef72f)
**Baseline:** Sprint 11 APPROVED (0C/0H/0M, 2026-05-12). 504 tests.
**Testes:** 521/521 passing (+17 novos)

---

## Resumo Executivo

Sprint 11.5 é um sprint de higiene — zero features user-facing, zero alterações a contratos, zero alterações a fund flows. Endereça 3 CodeQL findings com code fixes (P84-P86), documenta 7 false positives (P87), adiciona supply chain hardening ao .npmrc (P83), cria 4 skill files para o Code Agent (P88), e formaliza a feedback convention no CLAUDE.md (P89).

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 3 INFO**

Sprint limpo. Todas as alterações são correctas e well-tested.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | `git diff -- contracts/` vazio. Confirmado. |
| Fund flows alterados? | **Não** | |
| Novos endpoints? | **Não** | |
| Novos secrets/env vars? | **Não** | |
| Dependências adicionadas? | **Não** | |
| RLS impactado? | **Não** | |
| CI alterado? | **Sim** | lockfile-lint + .npmrc verification step. Defence-in-depth. |
| Testes: 521/521 | Sim | +17 (7 TokenAddressBadge, 10 sanitizeTokenField) |
| Build limpo? | Sim | |

---

## Findings

### 11.5-I-01 — CI comment diz "7d" mas .npmrc tem "7"
**Severidade:** INFO
**Ficheiro:** `.github/workflows/ci.yml` L16
**Descrição:** O comentário de segurança diz `min-release-age=7d` mas o .npmrc tem `min-release-age=7`. O commit message explica correctamente que npm espera um Number (dias), não uma duration string. O comentário deve ser actualizado para consistência.
**Recomendação:** Corrigir `7d` → `7` no comentário. Não bloqueante.

### 11.5-I-02 — P85 sanitizer residual contém conteúdo executável como texto
**Severidade:** INFO
**Ficheiro:** `src/hooks/useTokenImport.ts` L119-122
**Descrição:** Após strip de `<>`, `<script>alert(1)</script>` torna-se `scriptalert(1)/script`. Este residual é texto inerte porque React escapa automaticamente em JSX (não usa `dangerouslySetInnerHTML`). No entanto, o texto "scriptalert(1)/script" pode aparecer como token name visível ao utilizador, o que é confuso mas não exploitável.
**Impacto:** Puramente cosmético. A defesa funciona — angle brackets removidos, XSS impossível.
**Recomendação:** Aceitar como is. Tokens maliciosos com nomes como "scriptalert(1)/script" são distinguíveis por inspecção visual.

### 11.5-I-03 — Skill files referenciam padrões Sprint 11 como canónicos
**Severidade:** INFO
**Ficheiros:** `.claude/skills/*.md`
**Descrição:** Os 4 skill files referenciam findings e padrões do Sprint 11 (11-M-01, 11-M-02, CQL-05) como exemplos canónicos. Estes vão tornar-se stale se os padrões evoluírem. Não é um problema de segurança — os skills são documentação, não código executável.
**Recomendação:** Actualizar periodicamente (e.g., a cada 5 sprints) para reflectir padrões actuais.

---

## Análise por Prompt

### P83 (758fe0c) — .npmrc supply chain hardening
**Resultado:** PASS

**Verificações:**
- `.npmrc` tem `registry=https://registry.npmjs.org/` — **pin presente.** Previne redirect via `.npmrc` injection.
- `.npmrc` tem `min-release-age=7` — **presente.** npm 11+ recusa packages publicados há menos de 7 dias. Mitigação contra zero-day supply chain (e.g., Mini Shai-Hulud).
- CI step `Verify .npmrc hardening` usa dois `grep -q` para ambas as directives, com `exit 1` se ausentes — **correcto.** Se alguém remover as linhas, o build falha.
- lockfile-lint já existia no step anterior — continua funcional.

**Nota:** O commit message documenta que o architect prompt especificou `7d` (duration string) mas npm espera um Number. O Code Agent corrigiu para `7` e registou em FEEDBACK.md. Bom uso da feedback convention.

### P84 (4cf8a70) — TokenAddressBadge href injection guard
**Resultado:** PASS

**Verificações:**
- `isAddress` importado de `viem` — **correcto.** Runtime validation, não apenas TypeScript compile-time.
- Guard aplicado: `showExplorerLink && isAddress(address) &&` — **correcto.** Link só renderiza para endereços Ethereum válidos.
- 7 testes cobrem: checksummed pass, lowercase pass, non-address reject, `javascript:` scheme reject, path traversal reject, empty reject, short hex reject — **cobertura completa.**
- O fix é minimal e cirúrgico — apenas adiciona o guard, não altera a estrutura do componente.

### P85 (d39e1ee) — sanitizeTokenField angle bracket strip
**Resultado:** PASS

**Verificações:**
- Regex antigo `/<[^>]*>/g` substituído por `/[<>]/g` — **estritamente mais forte.** A abordagem anterior falhava em tags sem closing bracket (`<img src=x onerror=alert(1)`) e em construções nested (`<<script>>`). A nova abordagem remove todos os angle brackets independentemente da estrutura.
- Função exportada para testing — **correcto.**
- 10 testes cobrem: complete tags, malformed unclosed, nested/encoded, legitimate names, empty input, oversize truncation, non-ASCII strip, whitespace trim — **cobertura completa.**
- Output residual (`scriptalert(1)/script`) é texto inerte via React JSX escaping — **safe.**

### P86 (c85812f) — Webhook secret redaction
**Resultado:** PASS

**Verificações:**
- Antigo: `${WEBHOOK_SECRET.slice(0, 4)}...${WEBHOOK_SECRET.slice(-4)}` — leak de 8 chars.
- Novo: `[${WEBHOOK_SECRET.length} chars, set]` — **zero chars expostos.** Confirma presença da env var sem leak.
- Alteração de 1 linha, cirúrgica — **correcto.**

### P87 (ff559d3) — CodeQL false positive annotations
**Resultado:** PASS

**Verificações (7 anotações, uma por uma):**

| # | Ficheiro:Linha | Query ID | Classificação | Correcto? |
|---|----------------|----------|---------------|-----------|
| 1 | `fingerprint-validator.ts:221` | js/disabling-certificate-pinning | FALSE POSITIVE | **Sim** — `rejectUnauthorized:false` é necessário para capturar fingerprints TLS de certs untrusted. Função de segurança, não bypass. |
| 2 | `capture-endpoint-baseline.ts:53` | js/disabling-certificate-pinning | FALSE POSITIVE | **Sim** — mesmo pattern. Dev-only script para baseline capture. |
| 3 | `source-state-machine.ts:189` | js/code-injection | FALSE POSITIVE | **Sim** — `id` é um `SourceId` constante interno do enum SOURCES, never user input. |
| 4 | `source-state-machine.ts:245` | js/code-injection | FALSE POSITIVE | **Sim** — `status.id` mesmo pattern. Internal state machine id. |
| 5 | `swap/route.ts:130` | js/type-confusion | FALSE POSITIVE | **Sim** — `source?: unknown` é intencional. Validado via `KNOWN_SOURCES.has()` antes de uso. |
| 6 | `swap/route.ts:178` | js/code-injection | FALSE POSITIVE | **Sim** — `KNOWN_SOURCES` é `Set<string>` hardcoded, not user input. O join é de constantes. |
| 7 | `api-auth.ts:93` | js/insufficient-key-size | ACCEPTED RISK | **Sim** — SHA-256 em API keys de 256-bit é industry standard (Stripe, GitHub, AWS). bcrypt adicionaria latência sem ganho de segurança porque API keys têm alta entropia, ao contrário de passwords. |

**Contagem:** Exactamente 7 anotações. Todas correctas e bem justificadas.

### P88 (81c7679) — Agent Skills
**Resultado:** PASS

**Verificações:**
- 4 ficheiros: `api-route.md` (54L), `adapter.md` (50L), `security-fix.md` (46L), `supabase-migration.md` (54L) — **todos < 150 linhas.**
- Zero secrets embebidos — apenas referências a patterns e file paths. Confirmado via grep.
- Referências a paths actuais: `src/app/api/**`, `src/lib/sources/`, `src/lib/api-auth.ts`, `supabase/` — todos existentes e correctos.
- `supabase-migration.md` referencia o padrão RLS canónico de 11-M-01 — correcto e útil para futuras migrations.
- `security-fix.md` referencia as error hygiene conventions de 11-M-02/03 e CQL-05 — correcto.

### P89 (5aef72f) — CLAUDE.md feedback convention
**Resultado:** PASS

**Verificações:**
- Secção inserida entre "Do NOT" e "Current state" — **posição correcta**, mantém heading depth (`##`).
- Secções existentes não alteradas — confirmado via diff (apenas adição).
- Formato grep-friendly: `## Feedback — P{number} ({commit hash})` — **pode ser extraído via** `grep '## Feedback'` para sweep de sprint.
- FEEDBACK.md é append-only, não criado se vazio — **correcto**, evita commits vazios.
- Já utilizado por P83 (commit documenta que `min-release-age=7d` → `7` foi registado em FEEDBACK.md) — **validação real do pattern.**

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Zero contract changes | **Confirmado** — `git diff -- contracts/` vazio |
| Zero fund flow changes | **Confirmado** — nenhum ficheiro em `src/lib/adapters/`, `src/hooks/useSwap.ts`, ou `src/app/api/swap/` alterado |
| Zero novos endpoints | **Confirmado** — nenhum `route.ts` criado |
| Zero novas env vars | **Confirmado** |
| Zero dependências adicionadas | **Confirmado** — `package.json` não alterado |
| TypeScript limpo | **Confirmado** por commit messages (`tsc --noEmit exit 0`) |
| 521 testes passing | **Confirmado** (+17: 7 TokenAddressBadge + 10 sanitizeTokenField) |

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

Sprint 11.5 está limpo para merge. Os 3 CodeQL fixes são correctos e well-tested. Os 7 false positive annotations são todos justificados e verificados contra o código actual. A supply chain hardening (.npmrc + CI verification) é uma adição sólida. Os skill files e a feedback convention formalizam patterns que já funcionavam informalmente.

Nota especial: a qualidade do sprint é elevada — 7 commits, todos cirúrgicos, zero side effects, zero regressões, +17 testes. O workflow `/goal` + feedback convention está a produzir resultados consistentes.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-13*
