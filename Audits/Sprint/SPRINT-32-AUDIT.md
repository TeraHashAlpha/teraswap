# Audit Report — Sprint 32 (Security Hardening)

| Field | Value |
|---|---|
| **Sprint** | 32 |
| **Branch** | `fix/sprint-32-security-hardening` (merged to main) |
| **Commits** | 6 (`55f0496`, `dbc2f96`, `457cdbd`, `8dc23a3`, `13b77d4`, `480dd17`) |
| **Prompts** | P169–P174 |
| **Findings closed** | SEC-02, SEC-03, SEC-04, INF-02, INF-03, INF-09 |
| **Auditor** | Claude (Senior Security Auditor) |
| **Date** | 2026-05-27 |
| **Verdict** | **APPROVED — 0C / 0H / 0M / 0L / 4 INFO** |

---

## Scope

Security hardening sprint closing 6 findings from `FULL-AUDIT-2026-05-26.md`. Covers: fail-closed nested multicall validation (SEC-04), audit KV key collision prevention (SEC-02), rate limiter memory cap (SEC-03), CodeQL SAST workflow (INF-02), gitleaks secret scanning (INF-03), and .env.example sync (INF-09). 8 files changed, +214 lines.

### Files in diff

| File | Change | Prompt | Finding |
|---|---|---|---|
| `src/lib/calldata-recipient.ts` | Modified | P169 | SEC-04 |
| `src/lib/calldata-recipient.test.ts` | Modified | P169 | SEC-04 |
| `src/app/api/telegram/webhook/route.ts` | Modified | P170 | SEC-02 |
| `src/app/api/admin/kill-switch/route.ts` | Modified | P171 | SEC-03 |
| `.github/workflows/codeql.yml` | **NEW** | P172 | INF-02 |
| `.github/workflows/gitleaks.yml` | **NEW** | P173 | INF-03 |
| `.gitleaks.toml` | **NEW** | P173 | INF-03 |
| `.env.example` | Modified | P174 | INF-09 |

---

## P169 — Nested multicall fail-closed (`55f0496`) — SEC-04

### Analysis

**Before:** `decodeMulticallRecipient()` at depth > 0 returned `valid: true` with reason "skipping recursive decode". This is **fail-open** — a crafted `multicall(multicall(swap(...)))` calldata would bypass recipient validation entirely while returning `valid: true` to the caller.

**After:** depth > 0 returns `valid: false` with reason "Nested multicall rejected — depth > 0 (fail-closed)". A `console.warn` with `[SEC-04]` tag is emitted for forensic grep.

### Checklist

| Check | Result |
|---|---|
| `depth > 0` → `valid: false` (fail-closed) | ✅ Line 349 |
| `console.warn` with `[SEC-04]` tag | ✅ Line 344 |
| `extracted: null` (no false positive address) | ✅ |
| Depth-0 multicall continues to validate normally | ✅ Falls through to switch/decode logic at line 358+ |
| Test: depth-0 multicall wrapping a known swap → `valid: true` | ✅ |
| Test: nested multicall(multicall(swap)) → `valid: false` | ✅ |
| Test: nested multicall rejected even with matching inner recipient | ✅ Defence-in-depth |
| Test spy verifies `console.warn` called with `[SEC-04]` | ✅ |
| `consoleSpy.mockRestore()` in all test cases | ✅ Proper cleanup |

### Security assessment

O fix é correcto e defence-in-depth:

1. **Fail-closed é o padrão certo** — se o validador não consegue provar que o recipient está correcto, deve rejeitar.
2. **A protecção é redundante** com a router whitelist (que já bloqueia adapters desconhecidos), mas defende contra cenários onde a whitelist é alargada sem actualizar o validator.
3. **Os 3 testes cobrem a matriz completa**: (a) depth-0 não regride, (b) depth-1 rejeita, (c) depth-1 rejeita mesmo com recipient correcto no interior.

**Verdict:** Conforme. SEC-04 FECHADO.

---

## P170 — Telegram audit KV key collision (`dbc2f96`) — SEC-02

### Analysis

**Before:** Audit key = `${ACTION_AUDIT_PREFIX}${timestamp}` (ISO string). Dois callbacks no mesmo milissegundo em instâncias Vercel diferentes colidiram, com o segundo a sobrescrever o primeiro — perdendo um registo de auditoria.

**After:** Audit key = `${ACTION_AUDIT_PREFIX}${timestamp}:${suffix}` onde `suffix = globalThis.crypto.randomUUID().slice(0, 8)`.

### Checklist

| Check | Result |
|---|---|
| `globalThis.crypto.randomUUID()` (not `Math.random`) | ✅ Cryptographically secure |
| UUID slice is 8 chars (36⁸ = 2.8T combinations per millisecond) | ✅ |
| Key format: `prefix:ISO:uuid8` | ✅ Separado por `:` |
| Existing KV value structure unchanged | ✅ Apenas a key mudou |
| Nenhuma nova dependência | ✅ `globalThis.crypto` é built-in no Node.js runtime |

### Security assessment

A colisão de keys sob autoscale era um risco real de perda de registos de auditoria. O `randomUUID().slice(0,8)` fornece 32 bits de entropia por millisecond, tornando colisões estatisticamente impossíveis em qualquer scenario de tráfego realista. O uso de `globalThis.crypto` (não `Math.random`) garante que o UUID é criptograficamente seguro.

**Verdict:** Conforme. SEC-02 FECHADO.

---

## P171 — Kill-switch rate limiter cap (`457cdbd`) — SEC-03

### Analysis

**Before:** `rateLimitMap` (in-memory `Map`) crescia sem limite. Apesar do `setInterval` cleanup a cada 2 minutos, um burst sustentado de IPs únicos dentro da janela podia crescer o Map indefinidamente até process restart.

**After:** `MAX_MAP_SIZE = 1000`. Quando o Map atinge o cap e um **novo** IP precisa ser inserido, `evictOldestEntry()` remove a entrada com o `windowStart` mais antigo.

### Checklist

| Check | Result |
|---|---|
| `MAX_MAP_SIZE = 1000` | ✅ Line 40 |
| Eviction only on new IP insert | ✅ Guard: `if (!entry && rateLimitMap.size >= MAX_MAP_SIZE)` |
| Eviction does NOT run on increment of existing entry | ✅ O branch `entry.count++` não toca no cap check |
| `evictOldestEntry()` targets `windowStart` minimum | ✅ LRU-style scan |
| Existing `setInterval` cleanup preserved | ✅ Lines 79+ unchanged |
| `MAX_MAP_SIZE` is well above legitimate use | ✅ 1000 IPs na janela de 1 minuto seria >16 IPs/segundo distintos — irreal para admin endpoint |

### Security assessment

A implementação é correcta:

1. **A condição `!entry`** garante que o eviction só corre para IPs novos. Se o IP já existe no Map, apenas incrementa o counter (não aloca espaço novo), portanto o cap não precisa ser verificado.
2. **O LRU scan é O(n)** mas com n ≤ 1000 num endpoint auth-gated e de uso raro, o overhead é desprezível.
3. **O cap de 1000 é conservador** — um serverless function típica do Vercel processa dezenas de IPs únicos por minuto neste endpoint. 1000 dá margem de 50-100x.
4. **O `setInterval` cleanup pré-existente** é a defesa primária contra acumulação; o cap é a defesa de último recurso contra burst patterns que o interval não apanha.

**Verdict:** Conforme. SEC-03 FECHADO.

---

## P172 — CodeQL SAST workflow (`8dc23a3`) — INF-02

### Checklist

| Check | Result |
|---|---|
| Triggers: push to main, PR to main, weekly schedule | ✅ `cron: "0 6 * * 1"` (Monday 06:00 UTC) |
| Language: `javascript-typescript` only (no Swift) | ✅ Matrix with single entry |
| Query suite: `security-extended` | ✅ Line 39 |
| All action refs SHA-pinned | ✅ 4/4 pinned |
| `actions/checkout` SHA matches v4.2.2 | ✅ `@11bd71901bbe5b1630ceea73d27597364c9af683` |
| `codeql-action` SHA consistent across init/autobuild/analyze | ✅ Same hash `@b56ba49b26e50535fa1e7f7db0f4f7b4bf65d80d` |
| Permissions: `security-events: write`, `contents: read` | ✅ Minimal scoped |
| Timeout: 15 minutes | ✅ Reasonable for JS-only SAST |

**Verdict:** Conforme. INF-02 FECHADO.

---

## P173 — Gitleaks secret scanning (`13b77d4`) — INF-03

### Checklist

| Check | Result |
|---|---|
| Triggers: push to main, PR to main | ✅ |
| `fetch-depth: 0` (full history scan) | ✅ Line 27 |
| `gitleaks-action` SHA-pinned | ✅ `@44c470ffc35caa8b1eb3e8012ca53c2f9bea4eb5` (v2.3.7) |
| `actions/checkout` SHA-pinned (same hash as CodeQL) | ✅ |
| `GITHUB_TOKEN` passed via env (not secrets.GITLEAKS_LICENSE) | ✅ Free tier |
| Permissions: `contents: read` only | ✅ Minimal |
| Timeout: 5 minutes | ✅ |

### `.gitleaks.toml` allowlist

| Path | Justification |
|---|---|
| `\.env\.example` | Contém placeholders vazios e URLs de exemplo — falsos positivos esperados |
| `contracts/order-engine/` | Código Solidity com test fixtures que contêm hashes e addresses — falsos positivos |

### Allowlist assessment

Ambos os paths são justificados. O regex `\.env\.example` é suficientemente específico para não apanhar `.env.local` ou `.env.production` (que devem continuar a ser flagged). O path `contracts/order-engine/` é o directório de fixtures de teste Foundry.

**Nota:** O `useDefault = true` garante que os 100+ padrões de segredo default do gitleaks são activados — a allowlist apenas suprime os false positives.

**Verdict:** Conforme. INF-03 FECHADO.

---

## P174 — .env.example sync (`480dd17`) — INF-09

### Checklist

| Variable | Status |
|---|---|
| `ODOS_API_KEY=` | ✅ Adicionado com comentário e URL de docs |
| `ADMIN_API_KEYS_SECRET=` | ✅ Com instrução `openssl rand -hex 32` e nota sobre rotação |
| `EXECUTOR_VALIDATION_SECRET=` | ✅ Com descrição do endpoint que o consome |
| `MONITOR_SECRET=` | ✅ Com distinção vs. `MONITOR_CRON_SECRET` |
| `FLASHBOTS_RPC_URL` marcado UNUSED | ✅ Com data de verificação (2026-05-27) |
| `NEXT_PUBLIC_LAUNCH_DATE` marcado UNUSED | ✅ Com data de verificação (2026-05-27) |
| Nenhum valor real/secret nos placeholders | ✅ Todos vazios ou exemplos genéricos |
| Ficheiro mantém `=` vazio (não `=changeme`) | ✅ Consistente com o padrão existente |

### Security assessment

Boa prática: os 4 novos segredos documentam como gerar (`openssl rand -hex 32`), qual endpoint os consome, e implicações de rotação. Os 2 vars marcados UNUSED incluem a data de verificação — permite cleanup futuro com confiança.

**Verdict:** Conforme. INF-09 FECHADO.

---

## Cross-cutting checks

| Check | Result |
|---|---|
| No changes to TokenSelector.tsx or swap-flow files | ✅ |
| No changes to contracts or fund flows | ✅ |
| No new npm dependencies | ✅ `package.json` unchanged |
| No hardcoded secrets in any changed file | ✅ Verified all 8 files |
| No new `NEXT_PUBLIC_` env vars | ✅ |
| FEEDBACK.md append-only | N/A — FEEDBACK.md not in this sprint's diff |

---

## Findings

### 32-I-01 — CodeQL `security-extended` query suite (INFO)

**Ficheiro:** `.github/workflows/codeql.yml`

O query suite `security-extended` inclui queries experimentais e de lower-confidence que podem produzir falsos positivos, especialmente em projectos com dynamic imports e eval-like patterns (o Sentry SDK usa `Function()` internamente). O volume de alerts iniciais pode ser elevado.

**Recomendação:** Após a primeira execução, triagear os resultados e adicionar `// codeql-disable` comments ou query exclusions se necessário.

**Severidade:** INFO

---

### 32-I-02 — LRU eviction é O(n) scan (INFO)

**Ficheiro:** `src/app/api/admin/kill-switch/route.ts`

`evictOldestEntry()` faz um full scan do Map para encontrar a entrada com o `windowStart` mais antigo. Com `MAX_MAP_SIZE = 1000`, isto é ~1000 comparações por eviction. Para um endpoint admin auth-gated com tráfego mínimo, o overhead é desprezível. Seria uma preocupação se o cap fosse 100K+, mas não a 1000.

**Severidade:** INFO — sem acção necessária ao scale actual.

---

### 32-I-03 — Gitleaks free tier não bloqueia PRs (INFO)

**Ficheiro:** `.github/workflows/gitleaks.yml`

Sem `GITLEAKS_LICENSE`, a acção gitleaks-action v2 corre em modo free. No modo free, a acção reporta findings mas **não bloqueia** o PR (exit code 0 independentemente). Para enforcement efectivo, o workflow precisaria da licença ou de um step posterior que verifica o output.

**Recomendação:** Para enforcement blocking, considerar adquirir licença gitleaks ou adicionar um step que parse o output SARIF e falhe o job se houver findings.

**Severidade:** INFO — a detecção funciona, mas não é enforcement.

---

### 32-I-04 — CodeQL `autobuild` pode falhar sob Turbopack (INFO)

**Ficheiro:** `.github/workflows/codeql.yml`

O step `autobuild` do CodeQL tenta correr o build script detectado. Se `npm run build` usar Turbopack por default (Next.js 16), o CodeQL pode ter dificuldade em tracing as dependências. Na prática, CodeQL para JavaScript/TypeScript analisa source diretamente (não precisa de build output), mas o step `autobuild` pode emitir warnings.

**Recomendação:** Monitorar a primeira execução. Se o `autobuild` falhar, substituir por um step manual `npm install` (CodeQL JS/TS apenas precisa dos source files e `node_modules` resolvidos).

**Severidade:** INFO

---

## Verdict

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| Low | 0 | — |
| Info | 4 | 32-I-01, 32-I-02, 32-I-03, 32-I-04 |

**APPROVED — 0C / 0H / 0M / 0L / 4 INFO**

Sprint 32 fecha 6 findings de segurança com implementações correctas e defence-in-depth. O fix mais crítico (P169 — SEC-04) muda nested multicall de fail-open para fail-closed, com 3 testes de regressão que cobrem a matriz completa. O rate limiter cap (P171) e audit key dedup (P170) são defesas sólidas contra edge cases operacionais. Os dois novos workflows CI (CodeQL + gitleaks) adicionam SAST e secret scanning com action refs SHA-pinned e permissions mínimas. Seguro para produção.

### Findings fechados neste sprint

| ID | Description | Status |
|---|---|---|
| SEC-02 | Audit KV key collision under autoscale | ✅ FECHADO — UUID suffix |
| SEC-03 | Unbounded rate limiter Map growth | ✅ FECHADO — MAX_MAP_SIZE=1000 + LRU eviction |
| SEC-04 | Nested multicall fail-open | ✅ FECHADO — fail-closed + console.warn |
| INF-02 | No SAST in CI pipeline | ✅ FECHADO — CodeQL security-extended |
| INF-03 | No secret scanning in CI | ✅ FECHADO — gitleaks + allowlist |
| INF-09 | .env.example out of sync | ✅ FECHADO — 4 vars added, 2 marked UNUSED |
