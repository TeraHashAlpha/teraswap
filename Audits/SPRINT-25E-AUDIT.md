# Auditoria Sprint 25E — RPC Rate Limit + 1inch Error Context

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-20
**Scope:** 2 commits no branch `fix/quote-routing-and-sim`
**Baseline:** Sprint 25D APPROVED. 824 running + 19 skipped = 843 TS tests.
**Commits:**
- `cfba711` — fix(rpc): raise RPC_RATE_LIMIT from 60 to 300/min for wallet polling [P154]
- `74ed2e1` — fix(oneinch): include upstream description in non-2xx error messages [P155]

**Ficheiros:** 2 files, +24/−3 lines (net +21)
**Testes:** 0 novos, 0 alterados.

---

## Resumo Executivo

Sprint 25E resolve dois problemas operacionais pós-25D:

1. **P154 — RPC rate limit 60→300/min:** Wallet extensions (MetaMask, Rainbow) consomem ~30-50 req/min com background polling (block headers, balances, gas, token prices), esgotando os 60 req/min quase imediatamente e causando 429s que bloqueavam `eth_call` de simulação — surfacing como falsos positivos "swap would fail on-chain". Com a blacklist (25D) a bloquear todos os write/sign methods, o proxy é read-only e 300/min é estruturalmente seguro. Fallback degraded mode: `ceil(300/2) = 150`.

2. **P155 — 1inch error body context:** O adapter 1inch atirava `"1inch 403"` sem contexto, impossibilitando diagnóstico. Agora lê o body JSON de erro (`description ?? error`), produzindo `"1inch 403: Cannot estimate. Try again later."`. O classifier `friendlyError()` em `shared.ts` opera por substring matching na mensagem inteira — o pattern é aditivo (mais contexto nunca quebra matches existentes) e pode activar matches mais específicos (e.g., `insufficient liquidity`).

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 2 INFO**

Zero impacto em contratos, fund flows, ou autenticação. Alterações são config (rate limit) e error reporting (adapter).

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
| Dados sensíveis expostos? | **Não** | Error body de 1inch pode conter detalhes técnicos — vai para server logs via Sentry, não para o user |
| Auth bypass? | **Não** | Rate limiting preservado (mesmo mecanismo, limite mais alto) |
| SWAP/QUOTE limits alterados? | **Não** | SWAP=20, QUOTE=30 inalterados |
| FEEDBACK.md alterado? | **Não** | |

---

## Findings

### 25E-I-01 — 300 req/min/IP pode exceder LlamaRPC free tier se sustentado

**Severidade:** INFO
**Ficheiro:** `src/lib/kv-rate-limiter.ts` L35
**Descrição:** LlamaRPC free tier é ~300k req/dia. 300/min sustentado = 432k/dia — excederia o tier. Na prática, o tráfego real é muito inferior: um único utilizador com wallet extension consome ~50-70 req/min em picos (polling + app + simulation), e o rate limit é per-IP (não agregado). O upstream RPC tem os seus próprios limites e rejecta requests excedentes com erro, que o proxy propaga. Não há amplificação de custo — apenas degradação de experiência para o utilizador individual.
**Recomendação:** Aceitar como is. Monitorar custos RPC via dashboard existente. Se o tráfego crescer (multi-user), considerar: (a) Alchemy com tier pago, (b) request batching no proxy, ou (c) cache de `eth_getBlockByNumber("latest")` com 2s TTL para deduplicate wallet polling.

### 25E-I-02 — Error body de 1inch incluído na mensagem de erro pode conter HTML ou strings longas

**Severidade:** INFO
**Ficheiro:** `src/lib/adapters/oneinch.ts` L16-22, L52-58
**Descrição:** `errBody?.description || errBody?.error` é extraído do JSON de erro da 1inch API e concatenado na mensagem de erro: `"1inch 403: ${detail}"`. Se a 1inch API retornar um body com `description` muito longo ou com HTML, a mensagem de erro pode ser extensa. Impacto: (a) o `friendlyError()` em `shared.ts` faz substring matching no `lower` — strings longas não quebram mas tornam o match mais lento (marginal). (b) O fallback em `friendlyError` L66 trunca a `msg.slice(0, 80)` — mas apenas quando nenhum match específico activa. (c) Server logs (Sentry) recebem a mensagem completa — nenhum risco para o user. (d) XSS não aplicável — a mensagem vai para `Error.message`, não para innerHTML.
**Recomendação:** Aceitar como is. Para defesa em profundidade, considerar `detail.slice(0, 200)` no template literal para garantir truncagem antes do throw. Baixa prioridade — 1inch v6 API retorna descriptions curtas (~20-80 chars) na prática.

---

## Análise Detalhada

### P154 — RPC_RATE_LIMIT 60 → 300/min

**Alteração:**
```typescript
// Antes:
export const RPC_RATE_LIMIT = { limit: 60, windowMs: 60_000 }
// Depois:
export const RPC_RATE_LIMIT = { limit: 300, windowMs: 60_000 }
```

**Verificações:**

| Check | Status |
|-------|--------|
| SWAP_RATE_LIMIT (20/min) inalterado | ✓ L26 |
| QUOTE_RATE_LIMIT (30/min) inalterado | ✓ L27 |
| windowMs (60_000) inalterado | ✓ |
| Sliding-window logic (sorted sets) inalterada | ✓ Zero diff fora do valor |
| Fallback `Math.ceil(limit / 2)` → `ceil(300/2) = 150` | ✓ L81 |
| KV pipeline + expire inalterados | ✓ |
| Nenhum outro ficheiro modificado | ✓ |

**Threat model — 300/min read-only proxy:**
- **Abuse:** Atacante pode fazer 300 blockchain reads/min. Cada read retorna dados públicos (balances, blocks, tx receipts). Sem writes, sem signing, sem state mutation. Impacto: custo RPC marginal, zero risco de segurança. ✓
- **Amplificação:** Proxy forward 1:1 para upstream. Sem batch amplification (batch request ainda contém N requests individuais, cada um conta para o rate limit). ✓
- **DDoS:** Rate limiter per-IP via Vercel KV (sliding window). Atacante com múltiplos IPs pode amplificar, mas isto é true para qualquer rate limiter — Vercel/Cloudflare WAF é a defesa nesse caso. ✓

**Comment rationale adequado:**
- Documenta wallet polling (30-50 req/min). ✓
- Documenta app traffic (10-20 req/min). ✓
- Documenta fallback (150/min). ✓
- Referencia blacklist do 25D. ✓

### P155 — 1inch Error Body Context

**Pattern (fetchQuote, L16-22):**
```typescript
if (!res.ok) {
  let detail = ''
  try {
    const errBody = await res.json()
    detail = errBody?.description || errBody?.error || ''
  } catch { /* non-JSON error body — ignore */ }
  throw new Error(`1inch ${res.status}${detail ? `: ${detail}` : ''}`)
}
```

**Pattern (fetchSwapData, L52-58):** Idêntico, com prefixo `1inch swap`. ✓

**Verificações:**

| Check | Status |
|-------|--------|
| Ambos call sites (fetchQuote + fetchSwapData) têm o mesmo pattern | ✓ |
| `res.json()` em try-catch — non-JSON bodies não crasham | ✓ |
| Status code é PRIMEIRO na mensagem (`1inch 403: detail`) | ✓ |
| `friendlyError()` em shared.ts NOT modificada | ✓ |
| Nenhum outro adapter modificado | ✓ (diff contém apenas oneinch.ts) |
| Happy path inalterado — `parseJsonOrThrow` só corre se `res.ok` | ✓ |

**Interação com `friendlyError()`:**

A função opera por substring matching em `lower = msg.toLowerCase()`:

| Match | Antes (P155) | Depois (P155) | Compatível? |
|-------|-------------|---------------|-------------|
| `'429'` | `"1inch 429"` → match | `"1inch 429: rate limit exceeded"` → match | ✓ |
| `'403'` | `"1inch 403"` → match | `"1inch 403: cannot estimate"` → match | ✓ |
| `'insufficient' + 'liquidity'` | Nunca matchava (sem detail) | `"1inch 400: insufficient liquidity"` → match L60 (ANTES de L58) | ✓ Melhoria — message mais específica |
| `'no route'` | Nunca matchava | `"1inch 400: no route found"` → match L62 | ✓ Melhoria |
| Fallback | `msg.slice(0, 80)` | Idem — `detail` incluído na mensagem | ✓ |

A ordem dos checks em `friendlyError` é correcta — matches mais específicos (insufficient liquidity, no route) precedem matches genéricos (403, 429). O detail aditivo nunca impede um match existente e pode activar matches mais específicos. ✓

**Segurança — upstream error body injection:**
- `detail` é string de 1inch API (trusted third-party). ✓
- Vai para `Error.message` → server logs (Sentry). ✓
- `friendlyError()` retorna mensagens predefinidas para matches — detail não chega ao user nesses casos. ✓
- Fallback `msg.slice(0, 80)` trunca para 80 chars — detail excessivo é cortado. ✓
- Sem innerHTML, sem template literal rendering no DOM — XSS não aplicável. ✓

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Apenas 2 ficheiros alterados | **Confirmado** — `kv-rate-limiter.ts`, `oneinch.ts` |
| Zero ficheiros inesperados | **Confirmado** |
| Zero secrets ou env vars alterados | **Confirmado** |
| FEEDBACK.md não modificado | **Confirmado** |
| SWAP_RATE_LIMIT = 20/min | **Confirmado** — L26 inalterado |
| QUOTE_RATE_LIMIT = 30/min | **Confirmado** — L27 inalterado |
| Sliding-window logic inalterada | **Confirmado** — diff é apenas valor + comment |
| Fallback = ceil(300/2) = 150 | **Confirmado** — L81 `Math.ceil(limit / 2)` |
| `friendlyError()` NOT modificada | **Confirmado** — zero diff em shared.ts |
| Both error paths (quote + swap) have try-catch | **Confirmado** |
| Status code precedes detail in message | **Confirmado** — `1inch ${res.status}${detail...}` |
| Happy-path `parseJsonOrThrow` unchanged | **Confirmado** — only enters on `res.ok` |
| Spec compliance (SPRINT-25E.md) | **Confirmado** — ambos prompts implementados conforme spec |

---

## Spec Compliance

| Requirement | Status |
|-------------|--------|
| P154: RPC_RATE_LIMIT 60 → 300 | ✓ |
| P154: Comment with rationale | ✓ |
| P154: SWAP and QUOTE unchanged | ✓ |
| P154: One commit, one file | ✓ |
| P155: fetchQuote error body context | ✓ |
| P155: fetchSwapData error body context | ✓ |
| P155: try-catch for non-JSON bodies | ✓ |
| P155: Status code still first in message | ✓ |
| P155: One commit, one file | ✓ |

Zero spec deviations.

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

Sprint 25E resolve dois problemas operacionais de forma cirúrgica. O rate limit 300/min é defensível dado que o proxy é read-only (blacklist 25D). O error body context melhora diagnóstico sem alterar o fluxo de classificação existente — `friendlyError()` continua a produzir mensagens predefinidas para matches conhecidos, e o detail aditivo pode activar matches mais específicos. Zero impacto em contratos, fund flows, ou segurança.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-20*
