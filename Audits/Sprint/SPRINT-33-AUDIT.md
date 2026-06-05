# Audit Report — Sprint 33 (Security-Critical Test Coverage + CodeQL Triage)

| Field | Value |
|---|---|
| **Sprint** | 33 |
| **Branch** | `test/sprint-33-security-coverage` (merged to main) |
| **Commits** | 4 (`a18b89d`, `76658da`, `bc8a667`, `bc1aec5`) |
| **Prompts** | P175–P178 |
| **Auditor** | Claude (Senior Security Auditor) |
| **Date** | 2026-05-27 |
| **Verdict** | **APPROVED — 0C / 0H / 0M / 0L / 3 INFO** |

---

## Scope

Security-critical test coverage sprint: 94 new unit tests across 3 test files covering `validation.ts` (51), `simulation.ts` (25), and `api-auth.ts` (18). Plus CodeQL inline suppression comments (7 suppressions, 0 functional code changes). 9 files changed, +850 lines.

### Files in diff

| File | Change | Prompt |
|---|---|---|
| `src/lib/validation.test.ts` | **NEW** | P175 |
| `src/lib/simulation.test.ts` | **NEW** | P176 |
| `src/lib/api-auth.test.ts` | **NEW** | P177 |
| `src/lib/api-auth.ts` | Modified (comment only) | P178 |
| `src/lib/fingerprint-validator.ts` | Modified (comment only) | P178 |
| `src/lib/monitoring-loop.test.ts` | Modified (comment only) | P178 |
| `src/app/api/monitor/validate-execution/route.ts` | Modified (comment only) | P178 |
| `src/app/api/swap/route.ts` | Modified (comment only) | P178 |
| `scripts/capture-endpoint-baseline.ts` | Modified (comment only) | P178 |

---

## P175 — validation.test.ts (`a18b89d`) — 51 tests

### Coverage matrix

| Function | Tests | Happy path | Boundary | Invalid/Type | Verdict |
|---|---|---|---|---|---|
| `isValidAddress` | 11 | ✅ lowercase, uppercase, EIP-55 | ✅ 39/41 chars | ✅ null, undefined, number, object, non-hex, missing 0x, 0X prefix | Complete |
| `isValidTxHash` | 8 | ✅ 64 hex, mixed-case | ✅ 63/65 chars | ✅ null, undefined, number, non-hex, missing 0x | Complete |
| `isValidAmount` | 11 | ✅ '1', '0.5', '1000000', '0.000001' | ✅ '0' rejected | ✅ negatives, NaN, Infinity, empty, non-string types, whitespace-padded | Complete |
| `cap` | 6 | ✅ under max, at max | ✅ over max truncates | ✅ null, undefined, number, object, array, empty | Complete |
| `isAllowedOrigin` | 9 | ✅ production, www, localhost, 127.0.0.1 | ✅ localhost without port | ✅ null, empty, evil.com, look-alike subdomain, http:// on production | Complete |
| `safeCompare` | 6 | ✅ equal strings, empty strings | ✅ different lengths | ✅ null, undefined, number casts, unicode | Complete |

### Security-relevant observations

- **`isAllowedOrigin` look-alike test** (`teraswap.app.evil.com` → false): Confirms the origin check uses exact match against `'https://teraswap.app'`, not substring match. Critical for CORS protection.
- **`safeCompare` non-string guard**: Tests that passing non-string types returns `false` immediately (without throwing), confirming the runtime guard handles miscalled code gracefully.
- **`isValidAmount` whitespace test**: Documents that `' 1 '` is accepted (because `Number(' 1 ')` === 1). The test explicitly pins this as the current contract with a comment explaining the rationale. Not a security issue — amounts are validated further downstream.

**Verdict:** Conforme. Todas as 6 funções com cobertura completa.

---

## P176 — simulation.test.ts (`76658da`) — 25 tests

### Coverage matrix — `parseSimulationError`

| Branch | Test(s) | Verdict |
|---|---|---|
| `RouterNotWhitelisted` by name | ✅ | |
| `RouterNotWhitelisted` by selector | ✅ | |
| `InsufficientOutput` by name | ✅ | |
| `InsufficientOutput` by selector | ✅ | |
| `SwapFailed` by name | ✅ | |
| `SwapFailed` by selector | ✅ | |
| `ZeroAmount` by name | ✅ | |
| `ZeroAmount` by selector | ✅ | |
| `insufficient funds` (generic) | ✅ | |
| `STF` | ✅ | |
| `TRANSFER_FROM_FAILED` | ✅ | |
| `Too little received` | ✅ | |
| `INSUFFICIENT_OUTPUT` | ✅ | |
| `execution reverted` (fallback) | ✅ | |
| Unrecognised Error → `{ success: true }` | ✅ | |
| Non-Error inputs (string, null, undefined) | ✅ | |
| **Priority: FeeCollector > generic** | ✅ 2 tests | |

All 9 if-branches + the default return are covered.

### Coverage — `buildFeeCollectorSwapArgs`

| Path | Test | Verdict |
|---|---|---|
| `routeViaFeeCollector: true` → FC as `from`, user as `recipient` | ✅ | |
| `routeViaFeeCollector: false` → user as `from`, undefined `recipient` | ✅ | |

### Coverage — `FEE_COLLECTOR_ERROR_SELECTORS`

| Check | Verdict |
|---|---|
| Exactly 4 keys (RouterNotWhitelisted, InsufficientOutput, SwapFailed, ZeroAmount) | ✅ |
| Each selector matches `0x[0-9a-f]{8}` | ✅ |
| All 4 selectors are distinct | ✅ |

### Security-relevant observations

- **Priority test**: Verifica que quando uma mensagem contém tanto `SwapFailed` como `execution reverted`, o parser retorna a mensagem FeeCollector-specific (não a genérica). Isto é crítico porque a mensagem genérica diz "try a different route" enquanto a FeeCollector-specific diz "DEX router call failed" — a mensagem correcta ajuda o utilizador a diagnosticar.
- **Unrecognised → `{ success: true }`**: Confirma o design intencional de fail-open na simulação (best-effort). A simulação não deve bloquear swaps por erros que não consegue classificar — o utilizador pode prosseguir e a transacção on-chain será a validação final.

**Verdict:** Conforme. Cobertura completa de todos os branches.

---

## P177 — api-auth.test.ts (`bc8a667`) — 18 tests

### Coverage matrix — `verifyApiKey`

| Branch | Status | Test(s) | Verdict |
|---|---|---|---|
| Missing X-API-Key header → 401 | ✅ | 1 test | |
| Empty/whitespace header → 401 | ✅ | 1 test | |
| `getSupabase()` returns null → 503 | ✅ | 1 test | |
| Supabase lookup returns error → 503 | ✅ | 1 test | |
| Supabase lookup throws → 503 | ✅ | 1 test | |
| Key not found → 401 unified | ✅ | 1 test | |
| Key revoked (`is_active: false`) → 401 unified | ✅ | 1 test | |
| Key expired → 401 unified | ✅ | 1 test | |
| Per-minute rate limit → 429 + Retry-After | ✅ | 1 test | |
| Per-day rate limit → 429 + Retry-After | ✅ | 1 test | |
| Success path → ok: true with keyId, keyName, tier, headers | ✅ | 1 test | |
| Tier 'pro' → 'pro' | ✅ | 1 test | |
| Tier 'enterprise' → 'enterprise' | ✅ | 1 test | |
| Unknown tier → 'free' default | ✅ | 1 test | |
| bumpUsage fire-and-forget | ✅ | 1 test (via `setImmediate` flush) | |
| `HASH_RE` defensive check | — | Not covered | See 33-I-01 |

### Coverage — `hashApiKey`

| Check | Test | Verdict |
|---|---|---|
| 64-char lowercase hex output | ✅ | |
| Deterministic | ✅ | |
| Different inputs → different hashes | ✅ | |
| Known SHA-256 digest of empty string | ✅ | |

### Security-critical verifications

**11-M-03 Unified rejection message:**
```
const UNIFIED = 'Invalid or inactive API key.'
// Tested for: not-found, revoked, expired — all assert result.error === UNIFIED
```
✅ All 3 rejection states return the **identical** string. An attacker querying with different hashes cannot distinguish "key doesn't exist" from "key is revoked" from "key is expired". Compliant with 11-M-03.

**Mock fidelity:**
O mock Supabase client replica a chain `.from().select().eq().maybeSingle()` e `.from().update().eq()` — matching a interface real do `@supabase/supabase-js`. O `mockRequest` replica `req.headers.get(name)` — matching a interface de `NextRequest`. Os mocks não enfraquecem as propriedades de segurança testadas:

- O mock **não** bypassa o hash lookup — `verifyApiKey` ainda chama `hashApiKey(raw)` e faz o `.eq('key_hash', keyHash)` lookup.
- O rate limiter mock retorna shaped results (`{ allowed, remaining, resetAt }`) que matcham a interface de `checkRateLimit`.
- O `beforeEach(vi.clearAllMocks)` garante isolation entre testes.

**Per-minute short-circuit:**
O teste de rate limit per-minute verifica que `mockCheckRateLimit` é chamado exactamente 1 vez — confirmando que a day window **não** é consultada quando a minute window rejeita (saves 1 KV round-trip, per design).

**Verdict:** Conforme. Cobertura abrangente da state machine de autenticação.

---

## P178 — CodeQL inline suppressions (`bc1aec5`) — 7 comments

### Suppression inventory

| # | File | Rule | Justification | Verified |
|---|---|---|---|---|
| 1 | `src/lib/fingerprint-validator.ts` | `js/disabling-certificate-validation` | TLS fingerprinting requires `rejectUnauthorized: false` to capture certs. The connection is not used for data exchange; the captured fingerprint is matched against a pinned set. | ✅ Genuíno false positive |
| 2 | `scripts/capture-endpoint-baseline.ts` | `js/disabling-certificate-validation` | Dev-only baseline script, same pattern as fingerprint-validator. Captures TLS state for comparison. Never runs in production. | ✅ Genuíno false positive |
| 3 | `src/lib/api-auth.ts` | `js/insufficient-key-size` | SHA-256 for high-entropy 256-bit API keys (not passwords). Industry standard (Stripe, GitHub, AWS). bcrypt/scrypt add latency without security gain for high-entropy inputs. | ✅ Genuíno false positive |
| 4 | `src/app/api/monitor/validate-execution/route.ts:97` | `js/log-injection` | Server-side log. `txHash` validated by `isValidTxHash()` (hex only); `error.message` is Supabase client error. Neither rendered to browser. | ✅ Genuíno false positive |
| 5 | `src/app/api/monitor/validate-execution/route.ts:145` | `js/log-injection` | Server-side log. `result.source` is closed-set enum (AggregatorName); `result.txHash` validated at request boundary; `result.reason` is internal. | ✅ Genuíno false positive |
| 6 | `src/app/api/swap/route.ts:172` | `js/log-injection` | Server-side log. `source` checked against AGGREGATOR_APIS allowlist. Closed-set, no newline injection possible. | ✅ Genuíno false positive |
| 7 | `src/lib/monitoring-loop.test.ts:365` | `js/incomplete-url-substring-sanitization` | Test assertion filtering fetch spy calls. A false-positive match would over-count, not under-count — direction is safe. | ✅ Genuíno false positive |

### Format verification

| Check | Result |
|---|---|
| All use rule-specific format `// codeql[js/rule-id]` | ✅ |
| Zero blanket `// codeql-disable` comments | ✅ |
| 7 total suppressions across 6 files | ✅ |
| Zero functional code changes (diff is comments only) | ✅ Confirmed — old multi-line comments replaced with single-line `codeql[...]` format |

### Suppressions NOT applied (correctly)

O checklist mencionou 2 "missing-origin-check" findings em scripts deletados. Confirmado que **não** foram suprimidos — estes devem auto-resolver quando o CodeQL workflow re-scans o branch sem esses ficheiros.

**Verdict:** Conforme. Todas as 7 supressões são false positives genuínos com justificações tecnicamente correctas.

---

## Cross-cutting checks

| Check | Result |
|---|---|
| No changes to swap-flow / TokenSelector | ✅ |
| No changes to contracts / fund flows | ✅ |
| No new npm dependencies | ✅ |
| No hardcoded secrets in test files | ✅ — test uses fixture strings like `'tsk_abc'`, `'h'.repeat(64)` |
| Mocks do not weaken security properties | ✅ — verified per P177 analysis |
| Test files don't execute production code with side effects | ✅ — all imports are pure functions or properly mocked modules |
| P178 has zero functional code changes | ✅ — only comment replacements |

---

## Findings

### 33-I-01 — `HASH_RE` defensive branch untested in api-auth (INFO)

**Ficheiro:** `src/lib/api-auth.ts:165`, `src/lib/api-auth.test.ts`

A branch `if (!HASH_RE.test(keyHash))` (line 165 de api-auth.ts) não é coberta por testes. Esta branch é **unreachable** em condições normais — `createHash('sha256').update(x).digest('hex')` sempre retorna 64 chars hex. A branch existe como defensive belt contra uma implementação de digest transformada.

Testar esta branch exigiria mock de `createHash` para retornar um digest mal-formado, o que testaria o mock mais do que o código. Aceitável não testar.

**Severidade:** INFO — branch defensivo unreachable, ausência de teste é aceitável.

---

### 33-I-02 — `isValidAmount(' 1 ')` retorna true (INFO)

**Ficheiro:** `src/lib/validation.ts:27`, `src/lib/validation.test.ts:137`

O teste documenta explicitamente que `isValidAmount(' 1 ')` retorna `true` porque `Number(' 1 ')` === 1. O test comment diz: "if we ever want strict-numeric, tighten the function — for now this test pins the existing contract."

Não é um risco de segurança — amounts são validados por downstream logic (BigNumber parsing, on-chain execution). Mas é um comportamento worth knowing para quem mantenha a função.

**Severidade:** INFO — comportamento documentado e pinned.

---

### 33-I-03 — Excelente qualidade de testes de segurança (INFO)

**Observação positiva:**

Os testes de P177 demonstram maturidade de security testing acima da média:

1. **Unified rejection message**: Os 3 estados de rejeição (not-found, revoked, expired) usam a mesma constante `UNIFIED` e assert contra `toBe()` (strict equality), não `toContain()`. Isto garante que qualquer mudança acidental à mensagem de erro falha o teste imediatamente.

2. **Rate limit short-circuit**: O teste verifica que o mock de rate limit é chamado exactamente 1 vez quando a minute window rejeita — confirmando a optimização de não consultar a day window desnecessariamente.

3. **Fire-and-forget verification**: O `bumpUsage` test usa `setImmediate` para flush da microtask queue antes de assertar que `updateSpy` foi chamado — técnica correcta para testar side-effects async fire-and-forget.

4. **Priority ordering em P176**: Testa que FeeCollector errors ganham sobre generic reverts quando ambos patterns estão presentes na mesma mensagem — cobre um edge case real de parsing.

**Severidade:** INFO — nota de reconhecimento.

---

## Verdict

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| Low | 0 | — |
| Info | 3 | 33-I-01, 33-I-02, 33-I-03 |

**APPROVED — 0C / 0H / 0M / 0L / 3 INFO**

Sprint 33 adiciona 94 testes de segurança cobrindo 3 módulos críticos (validation, simulation, api-auth) com cobertura completa de branches. A compliance com 11-M-03 (unified rejection message) está explicitamente testada e verified. Os 7 CodeQL suppressions são todos false positives genuínos com justificações tecnicamente correctas no formato rule-specific. Zero alterações funcionais a código de produção. Seguro para produção.

### Test count

| File | Tests | Source file |
|---|---|---|
| `validation.test.ts` | 51 | `validation.ts` (57 lines) |
| `simulation.test.ts` | 25 | `simulation.ts` (93 lines) |
| `api-auth.test.ts` | 18 | `api-auth.ts` (~294 lines) |
| **Total new** | **94** | |
| **Running total** | **1108** | (1014 existing + 94 new) |
