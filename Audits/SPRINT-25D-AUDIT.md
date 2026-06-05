# Auditoria Sprint 25D — RPC Blacklist + FeeCollector Full Bypass

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-20
**Scope:** 2 commits no branch `fix/quote-routing-and-sim`
**Baseline:** Sprint 25C merged via PR #76 (commit `5b086c8`). 843 TS tests passing.
**Commits:**
- `c627f82` — fix(rpc): flip /api/rpc from whitelist to blacklist of write/sign methods [P152]
- `9740394` — fix(fee): bypass FeeCollector for all sources until router whitelist timelock [P153]

**Ficheiros:** 3 files, +96/−57 lines (net +39)
**Testes:** 0 novos, 19 skipped (itFeeCollectable = it.skip). 824 running + 19 skipped = 843 total.

---

## Resumo Executivo

Sprint 25D resolve duas questões residuais pós-25C:

1. **P152 — `/api/rpc` whitelist → blacklist:** A whitelist de 18 métodos read-only (introduzida em P142, expandida em P149) não cobria todos os métodos que wagmi/viem invocam — resultando em 403 persistentes em produção. Solução: inverter a lógica para blacklist de 12 métodos write/sign, permitindo tudo o resto. O propósito do proxy é privacidade (esconder IP) e bloquear submissão de transações — não policiar leituras.

2. **P153 — `FEE_INCOMPATIBLE_SOURCES` expansion para 11 entries:** Velora (Augustus V6) revertia com `RouterNotWhitelisted` no FeeCollector V1, mesma causa que uniswapv3/odos/kyberswap. Em vez de corrigir source-by-source, a abordagem precautória adiciona TODAS as sources (excepto as 2 permanentes) como temporárias. Revenue impact aceite — working swaps > fee collection. 19 tests do `/v1/swap` que requerem fee-collectable winner são skipped via `itFeeCollectable = it.skip` com marcador `REVERT 2026-05-22`.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 3 INFO**

Nenhum contrato alterado. Nenhum fund flow alterado. Alterações são data-only (blacklist set, constant array) e test markers.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | |
| Fund flows alterados? | **Não** | Fee bypass = revenue forgone, não fund loss |
| ABI alterado? | **Não** | |
| Novos endpoints? | **Não** | |
| Novos secrets/env vars? | **Não** | |
| Dependências adicionadas? | **Não** | |
| Dados sensíveis expostos? | **Não** | |
| Auth bypass? | **Não** | Rate limiting preservado |
| Write methods exposed? | **Não** | 12 write/sign methods bloqueados (ver análise) |
| FEEDBACK.md alterado? | **Não** | Nenhuma entrada de P152/P153 |

---

## Findings

### 25D-I-01 — Blacklist não inclui `eth_submitWork`, `eth_submitHashrate`, `miner_*`, `admin_*`, `debug_traceTransaction`

**Severidade:** INFO
**Ficheiro:** `src/app/api/rpc/route.ts` L30-42
**Descrição:** A blocklist cobre os 12 métodos write/sign standard do Ethereum JSON-RPC. Métodos como `eth_submitWork`, `eth_submitHashrate` (PoW mining, obsoletos pós-Merge), `miner_*`, `admin_*` (node admin), e `debug_traceTransaction` (pode ser state-heavy mas não state-mutating) não estão bloqueados. Threat model: estes métodos são já rejeitados por RPCs públicos (Alchemy, LlamaRPC) — o upstream nunca os executaria. O proxy apenas faz forwarding; se o upstream rejeita, o caller recebe o erro do upstream. O risco de amplificação (DoS via debug_traceTransaction pesado) é mitigado pelo rate limiter existente.
**Recomendação:** Aceitar como is. Os RPCs públicos upstream são a linha de defesa para estes métodos. Se TeraSwap migrar para um RPC node próprio com admin API exposta, revisitar a blocklist.

### 25D-I-02 — `uniswap` key existe em `AGGREGATOR_APIS` mas ausente de `FEE_INCOMPATIBLE_SOURCES`

**Severidade:** INFO
**Ficheiro:** `src/lib/constants.ts`
**Descrição:** O `AGGREGATOR_APIS` tem 13 keys. O `FEE_INCOMPATIBLE_SOURCES` tem 11 entries. As 2 ausentes são `uniswap` e `teraswap_order_engine`. Verificação: `uniswap` não tem adapter em `ADAPTER_REGISTRY` (apenas `uniswapv3` existe) — é uma key legacy/alias que nunca produz quotes. `teraswap_order_engine` é autónomo (executor, não user-initiated swap). Nenhum dos dois passa pelo FeeCollector path. A omissão é correcta.
**Recomendação:** Aceitar como is. Para clareza, considerar documentar no comment block que `uniswap` (legacy, no adapter) e `teraswap_order_engine` (autonomous) são intencionalmente excluídos.

### 25D-I-03 — `/v1/swap` endpoint efectivamente non-functional durante janela timelock

**Severidade:** INFO
**Ficheiro:** `src/app/api/v1/swap/route.test.ts`, `src/lib/constants.ts`
**Descrição:** Com todas as 11 sources fee-incompatible, o endpoint `/v1/swap` (programmatic API que requer FeeCollector routing) não pode pin nem auto-select nenhuma source — retorna 400 para qualquer chamada. Isto é documentado no comment block e coberto pelos 19 tests skipped. O frontend não é afectado (usa direct mode). O trade-off é aceite pelo Architect: working swaps > fee collection.
**Recomendação:** Aceitar como is. A janela é curta (2026-05-20 → 2026-05-22). O marcador `REVERT 2026-05-22` garante que o revert é tracked. Após timelock + switch para V2, reverter as 9 entries temporárias e o `itFeeCollectable` alias.

---

## Análise Detalhada

### P152 — `/api/rpc` Whitelist → Blacklist

**BLOCKED_METHODS completeness (12 methods):**

| Method | Category | Status |
|--------|----------|--------|
| `eth_sendRawTransaction` | TX submission | ✓ Bloqueado |
| `eth_sendTransaction` | TX submission | ✓ Bloqueado |
| `eth_sign` | Signing (deprecated) | ✓ Bloqueado |
| `eth_signTransaction` | Signing | ✓ Bloqueado |
| `eth_signTypedData` | EIP-712 signing | ✓ Bloqueado |
| `eth_signTypedData_v3` | EIP-712 v3 | ✓ Bloqueado |
| `eth_signTypedData_v4` | EIP-712 v4 | ✓ Bloqueado |
| `personal_sign` | Message signing | ✓ Bloqueado |
| `wallet_addEthereumChain` | Chain management | ✓ Bloqueado |
| `wallet_switchEthereumChain` | Chain switching | ✓ Bloqueado |
| `wallet_requestPermissions` | Permissions | ✓ Bloqueado |
| `wallet_watchAsset` | Token adds | ✓ Bloqueado |

**Omissions verified safe:**
- `eth_submitWork`, `eth_submitHashrate`: PoW — irrelevant pós-Merge, upstream rejects. ✓
- `miner_*`, `admin_*`: Node admin — upstream public RPCs reject. ✓
- `debug_traceTransaction`: Read-only (heavy but not state-mutating), rate-limited. ✓
- `wallet_getPermissions`: Read-only (queries permissions, doesn't grant). ✓

**Validation logic flip:**
- Antes: `if (!ALLOWED_METHODS.has(rpcReq.method))` → reject unknown. ✓
- Agora: `if (BLOCKED_METHODS.has(rpcReq.method))` → reject blocked. ✓
- Default: allow. ✓

**Rate limiting preservado:**
- `checkRateLimit` chamado ANTES da validação de método (L51-64). ✓
- `rpc:${ip}` key, `RPC_RATE_LIMIT.limit`, `RPC_RATE_LIMIT.windowMs` — inalterados. ✓

**Batch support preservado:**
- `Array.isArray(body) ? body : [body]` — inalterado. ✓
- Loop `for (const rpcReq of requests)` — valida cada request no batch. ✓

**Error response format (JSON-RPC 2.0):**
- 403: `{ jsonrpc: '2.0', id, error: { code: -32601, message } }` — ✓
- 400: `{ jsonrpc: '2.0', id, error: { code: -32600, message } }` — ✓
- 429: `{ jsonrpc: '2.0', id: null, error: { code: -32000, message } }` — ✓
- 500: `{ jsonrpc: '2.0', id: null, error: { code: -32603, message } }` — ✓

**Injection risk:**
- `rpcReq.method` é plain string, passado ao `BLOCKED_METHODS.has()` (Set lookup, O(1)). ✓
- Forwarded como `JSON.stringify` no body para upstream — no injection vector. ✓
- `method` nunca é interpolado em URL, shell command, ou template. ✓

**Nenhum outro ficheiro modificado neste commit.** ✓

### P153 — FEE_INCOMPATIBLE_SOURCES Expansion

**11 entries verificadas contra `AggregatorName` type:**

| Entry | Category | In AGGREGATOR_APIS? | In ADAPTER_REGISTRY? |
|-------|----------|---------------------|---------------------|
| `'0x'` | Permanent | ✓ | ✓ (zerox) |
| `'cowswap'` | Permanent | ✓ | ✓ (cow) |
| `'uniswapv3'` | Temp (confirmed) | ✓ | ✓ |
| `'odos'` | Temp (confirmed) | ✓ | ✓ |
| `'kyberswap'` | Temp (confirmed) | ✓ | ✓ |
| `'velora'` | Temp (confirmed) | ✓ | ✓ |
| `'1inch'` | Temp (precautionary) | ✓ | ✓ (oneinch) |
| `'openocean'` | Temp (precautionary) | ✓ | ✓ |
| `'sushiswap'` | Temp (precautionary) | ✓ | ✓ |
| `'balancer'` | Temp (precautionary) | ✓ | ✓ |
| `'curve'` | Temp (precautionary) | ✓ | ✓ |

Todos os 11 são keys válidas de `AggregatorName`. TypeScript rejectaria typos (o array é tipado `AggregatorName[]`). ✓

**Keys correctamente AUSENTES:**
- `uniswap`: Key legacy sem adapter — nunca produz quotes. ✓
- `teraswap_order_engine`: Autónomo (executor), não routed through FeeCollector. ✓

**`usesFeeCollector()` verificação:**
```typescript
export function usesFeeCollector(source: AggregatorName): boolean {
  return isFeeCollectorActive() && !FEE_INCOMPATIBLE_SOURCES.includes(source)
}
```
- Com 11 entries cobrindo todas as sources com adapter, `usesFeeCollector()` retorna `false` para todas. ✓
- `isFeeCollectorActive()` é irrelevante — o `includes` check já bloqueia. ✓

**Router addresses nos comentários:**
- SwapRouter02: `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` — Uniswap canonical. ✓
- Odos Router V3: `0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559` — Odos canonical. ✓
- KyberSwap MetaAggregationRouterV2: `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` — KyberSwap canonical. ✓
- ParaSwap Augustus V6: `0x6A000F20005980200259B80c5102003040001068` — ParaSwap canonical. ✓

**Comment tiers correctamente documentados:**
- Permanent (2): structural mismatch. ✓
- Temporary — confirmed broken (4): router NOT on V1 whitelist. ✓
- Temporary — precautionary (5): not individually verified. ✓
- Side effect documented: `/v1/swap` non-functional. ✓
- Revert date: 2026-05-22. ✓

### P153 — Test Skips

**`itFeeCollectable = it.skip` pattern:**
- `it.skip` é API válida do Vitest. ✓
- Alias declarado uma vez (L111), usado 19 vezes. ✓
- Revert marker: `REVERT 2026-05-22`. ✓

**Test count verification:**
- 19 tests usam `itFeeCollectable(` — skipped. ✓
- 19 tests usam `it(` — running. ✓ (validação, auth, CORS, halt, error surfacing)
- Total: 19 running + 19 skipped = 38 test cases neste ficheiro. ✓

**Tests skipped são correctos — todos requerem fee-collectable winner:**
- ERC-20 → ERC-20 happy path, rate-limit headers, native-ETH, netAmount, non-fee-collectable rejection, adapter no tx data, router validation, rate-limit error, upstream failure, auto-pick best, skip-incompatible, gasless fields, recipient threading, calldata tamper, unknown selector. ✓

**Tests running são correctos — NOT fee-dependent:**
- CORS OPTIONS, missing/invalid fields (400), halt check (503), address validation, slippage bounds, token validation, etc. ✓

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Apenas 3 ficheiros alterados (P152+P153) | **Confirmado** — `route.ts` (rpc), `constants.ts`, `route.test.ts` (v1/swap) |
| Zero ficheiros inesperados | **Confirmado** |
| Zero secrets ou env vars alterados | **Confirmado** |
| FEEDBACK.md não modificado em P152/P153 | **Confirmado** |
| Rate limiting inalterado | **Confirmado** — `checkRateLimit` com mesma key/limit/window |
| Batch support inalterado | **Confirmado** — `Array.isArray` path preservado |
| JSON-RPC error format correcto | **Confirmado** — codes -32601, -32600, -32000, -32603 |
| 12 write/sign methods bloqueados | **Confirmado** — listagem completa verificada |
| 11 entries em FEE_INCOMPATIBLE_SOURCES | **Confirmado** — todas válidas AggregatorName |
| `teraswap_order_engine` correctamente ausente | **Confirmado** — autónomo, não user-swap |
| `uniswap` correctamente ausente | **Confirmado** — legacy key, sem adapter |
| `itFeeCollectable = it.skip` é Vitest válido | **Confirmado** |
| 19 tests skipped + 19 running = 38 total | **Confirmado** |
| Revert markers `2026-05-22` presentes | **Confirmado** — constants.ts + route.test.ts |
| Spec compliance (SPRINT-25D.md) | **Confirmado** — ambos prompts implementados conforme spec |

---

## Spec Compliance

| Requirement | Status |
|-------------|--------|
| P152: Replace ALLOWED_METHODS with BLOCKED_METHODS | ✓ |
| P152: 12 specific write/sign methods blocked | ✓ |
| P152: Update JSDoc | ✓ |
| P152: Keep rate limiting | ✓ |
| P152: One commit, only route.ts | ✓ |
| P153: Add velora to FEE_INCOMPATIBLE_SOURCES | ✓ |
| P153: Precautionary expansion to all sources | ✓ (opted for full expansion per spec option) |
| P153: Document permanent vs temporary tiers | ✓ |
| P153: Router addresses in comments | ✓ |
| P153: One commit | ✓ |

Zero spec deviations.

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

Sprint 25D resolve os dois problemas residuais pós-25C de forma limpa e documentada. O flip whitelist→blacklist elimina o whack-a-mole de métodos RPC, bloqueando apenas os 12 métodos write/sign necessários. A expansão precautória de `FEE_INCOMPATIBLE_SOURCES` garante que nenhuma source sofre `RouterNotWhitelisted` durante a janela timelock. Revenue impact aceite e documentado. Os 19 tests skipped têm marcador temporal claro para revert. Zero impacto em contratos, fund flows, ou segurança.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-20*
