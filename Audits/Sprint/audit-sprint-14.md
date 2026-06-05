# Auditoria Sprint 14 — 13A-L Fixes + Recipient/Payment Flow

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-14
**Scope:** 4 commits — P103 (bf09b69), P104 (4d10e30), P101 (23088b2), P102 (5ffcfd4)
**Baseline:** Sprint 13A APPROVED (0C/0H/0M/2L, 2026-05-13). 550 tests.
**Testes:** 582/582 passing (+32 novos)

---

## Resumo Executivo

Sprint 14 tem dois objectivos: fechar os 2 LOWs do Sprint 13A (gasless stats RPC + gas_savings_usd server-side) e adicionar suporte a recipient/payment flow ao Public API. Os 2 LOWs estão correctamente fechados. No entanto, a feature recipient tem um **conflito fatal com o FeeCollector V2 on-chain** que bloqueia o deploy.

O FeeCollector V2 (H-04) valida `minimumOutput` contra `IERC20(tokenOut).balanceOf(msg.sender)` — o balanço do CALLER, não do recipient. Quando `recipient ≠ sender`, o router envia output para o recipient, o balanço de msg.sender permanece inalterado, e o contrato faz revert com `InsufficientOutput(0, minimumOutput)`. Todos os swaps com recipient ≠ sender via v1/swap produzirão calldata que **reverte on-chain**, desperdiçando gas do utilizador.

**Veredicto: NOT APPROVED — 0 CRITICAL / 1 HIGH / 0 MEDIUM / 0 LOW / 2 INFO**

O HIGH bloqueia merge. Os 2 LOWs do Sprint 13A estão correctamente fechados e não são afectados.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | Zero ficheiros em `contracts/` alterados — MAS conflito com contrato deployed. |
| Fund flows alterados? | **Sim** | Recipient ≠ sender redireciona output para terceiro. |
| Novos endpoints? | **Não** | Campos adicionados a v1/quote e v1/swap existentes. |
| Novos secrets/env vars? | **Não** | |
| Dependências adicionadas? | **Não** | |
| RLS impactado? | **Não** | |
| CI alterado? | **Não** | |
| Testes: 582/582 | **Sim** | +32 (7 log-swap clamp, 14 recipient adapter, 3 v1/quote recipient, 8 v1/swap recipient) |
| Build limpo? | **Sim** | |

---

## Findings

### 14-H-01 — Recipient ≠ sender causes on-chain revert via FeeCollector V2 minimumOutput check

**Severidade:** HIGH
**Ficheiros:** `src/app/api/v1/swap/route.ts`, `contracts/TeraSwapFeeCollector.sol` L251-298
**Descrição:**

O FeeCollector V2 deployed (`0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459`) implementa o H-04 minimumOutput check medindo o balance delta de `msg.sender` (o caller que submete a transacção):

```
// L251-254 — Snapshot ANTES
uint256 ethBefore = msg.sender.balance;
uint256 tokenOutBefore = tokenOut != address(0)
    ? IERC20(tokenOut).balanceOf(msg.sender) : 0;

// L290-298 — Validação DEPOIS
uint256 actualOutput;
if (tokenOut == address(0)) {
    actualOutput = msg.sender.balance - ethBefore;
} else {
    actualOutput = IERC20(tokenOut).balanceOf(msg.sender) - tokenOutBefore;
}
if (minimumOutput > 0 && actualOutput < minimumOutput) {
    revert InsufficientOutput(actualOutput, minimumOutput);
}
```

Quando o adapter calldata envia output para `recipient ≠ msg.sender`:
1. Router executa o swap e envia tokenOut para recipient
2. `msg.sender.balance` de tokenOut permanece inalterado
3. `actualOutput = 0`
4. `0 < minimumOutput` → **REVERT `InsufficientOutput(0, minimumOutput)`**

Todos os v1/swap que usam FeeCollector (ou seja, todos excepto CoW/0x, que são `FEE_INCOMPATIBLE_SOURCES`) com `recipient ≠ sender` produzem calldata que **reverte on-chain**. O API consumer recebe um 200 com tx data válido, mas a transacção falha quando submetida à blockchain, desperdiçando gas.

**Impacto:**
- API consumers que usam `recipient` em v1/swap perdem gas em transacções que revertem
- Experiência de API quebrada — o server retorna calldata inválido
- Pode causar perda de confiança na API se integrators experimentam reverts

**Nota:** v1/quote com `recipient` é seguro (apenas echo, sem calldata). A feature recipient nos adapters (P101) está correctamente implementada — o problema é a interacção com o FeeCollector wrapper que P102 aplica depois.

**Recomendação — Fix imediato (Sprint 14 fix):**
Em `parseBody()` ou imediatamente antes de `fetchSwapFromSource`, quando `recipient !== sender`, retornar:
```
return jsonError(400,
  'recipient must equal sender for FeeCollector-routed swaps. '
  + 'Use /v1/quote with recipient for intent-based (gasless) flows.')
```
Isto bloqueia o path inválido server-side sem desperdiçar gas. A feature adapter threading (P101) permanece — será activada quando o FeeCollector V3 suportar recipient nativo.

**Recomendação — FeeCollector V3 (futuro):**
Adicionar um parâmetro `recipient` ao FeeCollector e alterar o H-04 check para:
```solidity
actualOutput = IERC20(tokenOut).balanceOf(recipient) - recipientBefore;
```
Isto requer um novo deploy de contrato + audit completo — NOT in scope for Sprint 14.

### 14-I-01 — V2 flat file in repo is stale (pre-H-04)

**Severidade:** INFO
**Ficheiro:** `contracts/TeraSwapFeeCollectorV2_flat.sol`
**Descrição:** O ficheiro flat contém uma versão do V2 SEM os parâmetros `tokenOut` e `minimumOutput` — anterior ao H-04 fix. O contrato deployed em `0x47f2...7459` TEM estes parâmetros (confirmado pela ABI em `src/lib/constants.ts` L151-177 e pelo source em `contracts/TeraSwapFeeCollector.sol`). O ficheiro flat não reflecte o estado deployed.
**Recomendação:** Regenerar o flat file com `forge flatten contracts/TeraSwapFeeCollector.sol > contracts/TeraSwapFeeCollectorV2_flat.sol`. Não bloqueante.

### 14-I-02 — Adapter recipient tests don't cover CoW/UniswapV3/Curve (mock-only)

**Severidade:** INFO
**Ficheiro:** `src/lib/adapters/recipient.test.ts`
**Descrição:** O test file cobre 7 dos 11 adapters: balancer, kyberswap, velora, sushiswap, 1inch, odos, openocean. Faltam CoW, UniswapV3, e Curve (que têm implementação mais complexa — CoW via order body, UniswapV3 via ABI encoding, Curve via contract args). Também falta 0x (que é `FEE_INCOMPATIBLE_SOURCES` mas tem o warning log). Os testes existentes são mock-based e verificam que o adapter passa o recipient correcto ao upstream API, o que é suficiente para detectar regressões.
**Recomendação:** Adicionar testes para CoW, UniswapV3, e Curve recipient threading num sprint futuro. Não bloqueante.

---

## Análise por Prompt

### P103 (bf09b69) — gasless_stats() Supabase RPC [13A-L-01 fix]

**Resultado:** PASS

**Verificações:**
- **SQL function:** `CREATE OR REPLACE FUNCTION gasless_stats() RETURNS TABLE(total_gasless bigint, total_gas_saved numeric)`. **Correcto.**
- **Query:** `SELECT COUNT(*), COALESCE(SUM(gas_savings_usd), 0) FROM swaps WHERE is_gasless = true AND (status = 'confirmed' OR (status = 'pending' AND tx_hash IS NOT NULL))`. **Reproduz exactamente a lógica anterior** (confirmed + pending-with-tx). COALESCE previne NULL quando zero rows. **Correcto.**
- **Volatility:** `STABLE` — a função lê dados mas nunca escreve, e o resultado depende dos dados na tabela (não é IMMUTABLE). STABLE permite ao planner reutilizar o resultado dentro de um statement. **Correcto.**
- **Route integration:** `supabase.rpc('gasless_stats')` retorna single row. Fallback `Array.isArray(gaslessRpc) ? gaslessRpc[0] : gaslessRpc` lida com ambos os formatos de resposta do Supabase client. **Correcto.**
- **Response shape:** Inalterado — `totalGaslessSwaps`, `totalGasSavedUsd`, `gaslessRatio`, `avgGasSavingsPerSwap` mantêm os mesmos nomes e tipos. **Non-breaking.**
- **13A-L-01 status:** **CLOSED.** O O(N) `.reduce()` foi substituído por single-row RPC. Memory consumption constante.

### P104 (4d10e30) — gas_savings_usd server-side derivation [13A-L-02 fix]

**Resultado:** PASS

**Verificações:**
- **Rename:** `gasSavingsUsd` → `bestNonCowGasUsd` em analytics.ts, useSwap.ts, SwapBox.tsx. **Semântica correcta** — o campo é agora a gas USD do best non-CoW, não a "savings" computada pelo engine.
- **Server-side derivation:** `/api/log-swap` L124-133: `gas_savings_usd = source === 'cowswap' && Number.isFinite(Number(bestNonCowGasUsd)) ? Math.max(0, Math.min(Number(bestNonCowGasUsd), 500)) : 0`. **Correcto.**
  - Clamp de $10K → $500. **Adequado** — no single swap saves >$500 gas at current mainnet prices.
  - `Number.isFinite` guard contra NaN/Infinity. **Correcto.**
  - Non-CoW swaps → 0. **Correcto.**
- **Legacy field:** O destructuring extrai `bestNonCowGasUsd` do body. Se um client antigo envia `gasSavingsUsd`, esse campo é ignorado (não destructured, não usado). **Backwards-compatible.** Teste L134-137 confirma.
- **SwapBox change:** L172-173: `bestNonCowGasUsd = meta?.all.find((q) => q.source !== 'cowswap')?.gasUsd`. Agora extrai directamente o adapter gasUsd do best non-CoW quote. **Correcto** — valor bruto, não engine-computed.
- **7 testes novos:** Clamp 9999→500, negative→0, normal passthrough, boundary (500 OK, 500.01→500), NaN→0, non-CoW→0, legacy gasSavingsUsd ignored. **Cobertura completa.**
- **13A-L-02 status:** **CLOSED.** O servidor agora controla o valor derivado. Clamp mais apertado.

### P101 (23088b2) — Recipient threading through adapter layer

**Resultado:** PASS (adapter implementation correcta — o HIGH é na interacção FeeCollector, não aqui)

**Verificações — 11 adapters:**

| Adapter | Support | Mecanismo | Verificado |
|---------|---------|-----------|------------|
| balancer | Nativo | `receiver: recipient ?? from` no POST body | ✓ |
| cow | Nativo | `receiver: recipient ?? from` no /quote body | ✓ |
| curve | Nativo | `(recipient ?? from) as Address` no args[] do contract call | ✓ |
| kyberswap | Nativo | `recipient: recipient ?? from` no build POST | ✓ |
| odos | Nativo | `assembleBody.receiver = recipient` (conditional, only when ≠ from) | ✓ |
| 1inch | Nativo | `qs.set('destReceiver', recipient)` (conditional) | ✓ |
| sushiswap | Nativo | `to: recipient ?? from` no query param | ✓ |
| uniswapv3 | Nativo | `recipient: (recipient ?? from) as Address` no ABI args | ✓ |
| velora | Nativo | `receiver: recipient ?? from` no POST body | ✓ |
| openocean | Fallback | `console.warn()` quando recipient ≠ from. API não suporta split. | ✓ |
| 0x | Fallback | `console.warn()` quando recipient ≠ from. Permit2 model. | ✓ |

- **types.ts:** `recipient?: string` adicionado a `SwapParams`. Optional, default undefined. **Non-breaking.**
- **api.ts:** `fetchSwapFromSource` aceita `recipient` como 11º arg positional. **Correcto.**
- **Fallback sources (openocean, 0x):** Log warning e usam `from` como destino. **Correcto** — ambos já são `FEE_INCOMPATIBLE_SOURCES`, portanto nunca chegam a v1/swap.
- **14 testes novos:** 2 por adapter (recipient provided / omitted), + 2 para openocean warning. **Cobertura adequada.**

### P102 (5ffcfd4) — Public API recipient fields

**Resultado:** FAIL (14-H-01 — FeeCollector incompatibility)

**Verificações v1/quote (PASS):**
- `recipient` aceite via query param. Validado com `isValidAddress`. Echoed em `meta.recipient` (null quando omitido). **Correcto.**
- Meta-quote não é afectada por recipient — é apenas informacional. **Safe.**
- 3 testes: echo, null-when-omitted, 400 on invalid. **Correcto.**

**Verificações v1/swap (FAIL):**
- **Input validation:** `isValidAddress(recipient)` + zero address rejection. **Correcto.**
- **Adapter threading:** `expectedRecipient = parsed.recipient ?? parsed.sender` passado como 11º arg a `fetchSwapFromSource`. **Correcto** ao nível do adapter.
- **Calldata recipient check:** `validateCallDataRecipient(swapData.tx.data, expectedRecipient)` compara o recipient no calldata contra o expected. Bloqueio em mismatch real, warning em selector desconhecido. **Lógica correcta em isolamento.**
- **Response:** `sender` e `recipient` sempre presentes. **Non-breaking.**
- **PROBLEMA:** O adapter produz calldata com `recipient` no slot correcto. Depois, `buildFeeCollectorTx` wraps esse calldata no FeeCollector V2 call. O contrato on-chain (L251-298) faz snapshot de `IERC20(tokenOut).balanceOf(msg.sender)` ANTES do router call e valida delta DEPOIS. Quando recipient ≠ msg.sender, o output vai para recipient, delta do sender = 0, contrato reverte. **VER 14-H-01.**
- **8 testes:** Todos passam porque mocam `fetchSwapFromSource` e não exercitam o FeeCollector on-chain. O teste de calldata mismatch (L530-573) prova que o validator funciona, mas não detecta o revert on-chain.

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Zero contract changes | **Confirmado** — MAS conflito com contrato deployed (14-H-01) |
| 13A-L-01 CLOSED | **Confirmado** — gasless_stats() RPC substitui O(N) reduce |
| 13A-L-02 CLOSED | **Confirmado** — gas_savings_usd derivado server-side, clamp $500 |
| All 11 adapters updated | **Confirmado** — 9 native, 2 fallback (openocean, 0x) |
| v1/quote recipient safe | **Confirmado** — informational echo only |
| v1/swap recipient UNSAFE | **BLOQUEADO** — FeeCollector V2 minimumOutput check on msg.sender |
| Backwards compatibility | **Confirmado** — todos os campos novos são opcionais |
| Zero novas env vars | **Confirmado** |
| 582 testes passing | **Confirmado** (+32 novos) |

---

## Review Focus Responses

1. **13A-L-01 resolution:** Sim. `gasless_stats()` reproduz exactamente a lógica anterior (confirmed + pending-with-tx). `STABLE` é o volatility class correcto — lê dados, não escreve, resultado depende do state. COUNT + SUM num single round-trip.

2. **13A-L-02 resolution:** Sim. $500 cap é adequado (max gas cost de um swap Ethereum mainnet é ~$100 em gas extremo). Legacy field `gasSavingsUsd` é aceite mas ignorado — backwards-compatible, sem inflation path.

3. **P101 recipient threading:** Sim, todos os 11 adapters actualizados. openocean e 0x (que não suportam split sender/receiver) fazem fallback para `from` com warning. Ambos são `FEE_INCOMPATIBLE_SOURCES` e nunca chegam a v1/swap.

4. **P102 security — validateCallDataRecipient com recipient:** A lógica de validação está correcta. O problema não é no validator — é no FeeCollector V2 on-chain que verifica `msg.sender`'s balance, não `recipient`'s. **Ver 14-H-01.**

5. **P102 FeeCollector interaction:** **SIM, afecta.** A fee é colectada do INPUT (correcto, não é afectada). MAS o minimumOutput check (H-04) mede o balance delta de `msg.sender` para `tokenOut`. Quando recipient ≠ sender, o output vai para recipient, sender's delta = 0, contrato reverte. **14-H-01.**

6. **Backwards compatibility:** Sim para v1/quote (echo only). v1/swap é backwards-compatible quando recipient é omitido (default = sender). O problema existe apenas quando recipient ≠ sender.

---

## Veredicto Final

| Severidade | Count |
|------------|-------|
| CRITICAL   | 0     |
| HIGH       | 1     |
| MEDIUM     | 0     |
| LOW        | 0     |
| INFO       | 2     |

### NOT APPROVED — 1 HIGH (14-H-01)

Sprint 14 tem 1 HIGH que bloqueia merge: a feature recipient em v1/swap produz calldata que reverte on-chain devido ao FeeCollector V2's minimumOutput check contra `msg.sender.balanceOf(tokenOut)`. Os 2 LOWs do Sprint 13A estão correctamente fechados.

---

## Fix Prompt

### 14-FIX-01 — Block recipient ≠ sender on v1/swap (FeeCollector incompatibility)

**Context:** FeeCollector V2 (`0x47f2...7459`) validates minimumOutput against `msg.sender`'s balance delta for `tokenOut` (H-04 check, `contracts/TeraSwapFeeCollector.sol` L251-298). When `recipient ≠ sender`, the router sends output to recipient, msg.sender's balance delta is 0, and the contract reverts with `InsufficientOutput(0, minimumOutput)`. All v1/swap sources route through FeeCollector (CoW and 0x are `FEE_INCOMPATIBLE_SOURCES`).

**Objective:** Block `recipient ≠ sender` on v1/swap at the server level, before any adapter call or gas is consumed. Keep all other P101/P102 changes intact — they'll be activated when FeeCollector V3 ships.

**Requirements:**
1. In `src/app/api/v1/swap/route.ts`, after `parseBody()` succeeds and before `autoSelectSource` or `fetchSwapFromSource`, add:
   ```typescript
   if (parsed.recipient && parsed.recipient.toLowerCase() !== parsed.sender.toLowerCase()) {
     return jsonError(400,
       'recipient must equal sender for on-chain swaps routed through FeeCollector. '
       + 'For payment flows with a different recipient, use /v1/quote to get a gasless (CoW) quote '
       + 'and submit the intent order off-chain — CoW Protocol supports split sender/receiver natively.',
       auth.rateLimitHeaders,
     )
   }
   ```
2. Keep `recipient` in `ParsedSwapRequest` and all adapter threading (P101). Keep `validateCallDataRecipient` against `expectedRecipient`. Keep `sender` and `recipient` on the response. These are correct and will be useful when FeeCollector V3 lands.
3. Add 1 test: `recipient ≠ sender returns 400 with FeeCollector explanation`.
4. Update the JSDoc on the `recipient` field in `SwapRequestBody` to document the restriction.

**Do NOT:**
- Remove P101 adapter threading or P102 v1/quote recipient support.
- Remove `validateCallDataRecipient` — it's still useful as a defence-in-depth layer.
- Change v1/quote behavior — recipient on v1/quote is safe (informational echo).

**Files affected:** `src/app/api/v1/swap/route.ts`, `src/app/api/v1/swap/route.test.ts`
**Expected output:** 1 commit, 583 tests passing (+1). Build clean.
**Quality criteria:** `npx tsc --noEmit` clean. All existing 582 tests pass. New test confirms 400 on recipient ≠ sender with descriptive error pointing to CoW alternative.

---

## Re-Audit — 14-FIX-01 Verification (commit 0e88013)

**Data:** 2026-05-14
**Scope:** 1 commit — 0e88013 (14-FIX-01: block recipient ≠ sender on v1/swap)
**Baseline:** Sprint 14 NOT APPROVED (0C/1H/0M/0L/2I). 582 tests.
**Testes:** 583/583 passing (+1 novo)

### Fix Analysis

**Ficheiro:** `src/app/api/v1/swap/route.ts` — `parseBody()`

O fix adiciona um guard em `parseBody()`, imediatamente após a validação de zero-address do recipient:

```
if (recipient.toLowerCase() !== sender.toLowerCase()) {
  return jsonError(400,
    'recipient must equal sender for FeeCollector-routed swaps. '
    + 'Use /v1/quote with recipient for intent-based (gasless) flows.')
}
```

**Verificações:**

1. **Posição do guard:** Dentro de `parseBody()`, antes de qualquer chamada a `autoSelectSource`, `fetchSwapFromSource`, ou consumo de rate-limit tokens. O request é rejeitado no parsing, antes de qualquer trabalho computacional ou de rede. **Correcto.**

2. **Cobertura completa:** `parseBody()` é o único entry point para todos os v1/swap requests. Não existe bypass — qualquer request com `recipient ≠ sender` é bloqueado aqui. **Correcto.**

3. **Case-insensitive comparison:** `.toLowerCase()` em ambos os lados. Ethereum addresses são case-insensitive (EIP-55 checksum é cosmético). **Correcto.**

4. **Mensagem de erro:** Descritiva, aponta para a alternativa (v1/quote + CoW para payment flows). Não revela detalhes internos do contrato. **Correcto.**

5. **P101 adapter threading preservado:** Todos os 11 adapters mantêm o recipient threading. `validateCallDataRecipient` mantido como defence-in-depth. Prontos para FeeCollector V3. **Confirmado.**

6. **v1/quote inalterado:** Recipient echo em v1/quote continua funcional — é apenas informacional, sem calldata. **Confirmado.**

7. **Backwards compatibility:** Quando `recipient` é omitido, effective recipient = sender (default existente). Guard não dispara. Todos os API consumers existentes não são afectados. **Confirmado.**

### Test Verification

**Ficheiro:** `src/app/api/v1/swap/route.test.ts`

- **Novo teste:** `'400 with FIX-01 message when recipient ≠ sender'` — verifica status 400, mensagem contém `/recipient must equal sender/i` e `/FeeCollector/i`, e confirma que `mockFetchSwapFromSource` **não foi chamado** (fix actua antes de qualquer adapter call). **Correcto e suficiente.**
- **Testes existentes actualizados:** Tests que previamente usavam `RECIPIENT ≠ SENDER` agora usam `SENDER` ou esperam 400. Calldata tamper test actualizado para não passar recipient explícito (effective = sender), verificando que o inner calldata mismatch continua a ser detectado. **Sem regressões.**
- **583 testes passing** (+1). Typecheck clean.

### 14-H-01 Status

| Aspecto | Antes (14-H-01) | Depois (0e88013) |
|---------|-----------------|------------------|
| v1/swap com recipient ≠ sender | 200 com calldata inválido → revert on-chain | 400 antes de qualquer adapter call |
| Gas desperdiçado | Sim (tx submetida e revertida) | Não (bloqueado server-side) |
| Adapter threading (P101) | Activo mas inutilizável | Preservado, bloqueado por guard, pronto para V3 |
| v1/quote recipient | Safe (echo) | Inalterado |

**14-H-01: CLOSED.** Nenhum v1/swap calldata pode alcançar o FeeCollector com `recipient ≠ sender`. O guard em `parseBody()` é o primeiro check após input validation, antes de qualquer trabalho computacional.

### Remaining Findings

| Finding | Severidade | Status |
|---------|------------|--------|
| 14-H-01 | HIGH | **CLOSED** (0e88013) |
| 14-I-01 | INFO | OPEN — V2 flat file stale (non-blocking) |
| 14-I-02 | INFO | OPEN — CoW/UniV3/Curve adapter recipient tests missing (non-blocking) |

---

## Veredicto Final (Revisto)

| Severidade | Count |
|------------|-------|
| CRITICAL   | 0     |
| HIGH       | 0     |
| MEDIUM     | 0     |
| LOW        | 0     |
| INFO       | 2     |

### APPROVED — 0C / 0H / 0M / 0L (após 14-FIX-01)

Sprint 14 está limpo para merge. Os 2 LOWs do Sprint 13A estão fechados (gasless_stats RPC + gas_savings_usd server-side). A feature recipient está correctamente implementada nos 11 adapters e no v1/quote. O v1/swap bloqueia recipient ≠ sender server-side com mensagem descritiva, prevenindo calldata inválido e gas desperdiçado. O adapter threading permanece pronto para activação quando o FeeCollector V3 suportar recipient nativo.

Contagem cumulativa de testes: **583** (550 Sprint 13A + 32 Sprint 14 + 1 fix).

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-14*
*Re-audit addendum: 14-FIX-01 verification — 2026-05-14*
