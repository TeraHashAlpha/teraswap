# Review Sprint 3 — Focused Security Review

**Reviewer:** Senior Security Auditor (Claude)
**Data:** 2026-04-05
**Scope:** 3 commits (`a443c2a`, `7251a9c`, `a9ec510`)
**Foco:** Migração EIP-712 ethers→viem (segurança crítica)

---

## 1. CRITICAL — Migração EIP-712 Signature Verification (`a443c2a`)

### 1.1 Produção: `src/app/api/orders/route.ts`

**Migração correcta.** Usou `recoverTypedDataAddress` (retorna address) em vez de `verifyTypedData` (retorna boolean). A armadilha mais perigosa desta migração foi evitada.

**Verificações positivas:**
- `primaryType: 'Order' as const` — presente e correcto
- EIP-712 domain inalterado (`TeraSwapOrderExecutor`, version `2`, chainId + verifyingContract dinâmicos)
- ORDER_TYPES inalterado — mesmos campos, mesma ordem
- Comparação `.toLowerCase()` mantida — case-insensitive como antes
- `zeroHash` substitui `ethers.ZeroHash` — valor idêntico (`0x000...000`)
- `await` adicionado correctamente (viem `recoverTypedDataAddress` é async, ethers `verifyTypedData` era sync)

**⚠️ FINDING [M-01] — Falta validação de formato de assinatura**
**Severidade: MÉDIA | Ficheiro: `src/app/api/orders/route.ts` linha 153**

```typescript
signature: body.signature as `0x${string}`,
```

O `as` cast confia que `body.signature` é uma hex string válida de 65 bytes (130 hex chars + `0x` prefix = 132 chars). Se o frontend enviar uma assinatura malformada (e.g., string vazia, hex inválido, comprimento errado), viem vai lançar um erro genérico em vez de uma mensagem clara.

**Recomendação:** Adicionar validação explícita antes do `recoverTypedDataAddress`:
```typescript
if (typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) {
  return NextResponse.json({ error: 'Invalid signature format' }, { status: 400 })
}
```

**Estado:** Não é uma vulnerabilidade (o catch block trata o erro), mas é uma regressão de qualidade de erro. O ethers `verifyTypedData` tinha parsing de assinatura mais tolerante internamente.

---

### 1.2 Referência: `contracts/order-engine/api/orders.ts`

**Migração correcta.** Mesmas alterações que produção, com uma adição importante:

**✅ POSITIVO:** `verifyOrderSignature` convertido de sync para `async` correctamente, e o call site (`const sigValid = await verifyOrderSignature(body)`) também actualizado. Boa atenção ao detalhe — se o `await` faltasse, o resultado seria sempre truthy (a Promise não-resolvida), e QUALQUER assinatura seria aceite.

**Mesmo finding M-01** aplica-se aqui (cast directo sem validação).

---

### 1.3 KMS Signer: `contracts/order-engine/executor/kms-signer.js`

**Reescrita estrutural de class para factory function.** A migração é correcta na abordagem geral (`AbstractSigner` → `toAccount()`), mas encontrei problemas:

**⚠️ FINDING [H-01] — signTransaction reconstrói assinatura de forma potencialmente incorrecta**
**Severidade: ALTA | Ficheiro: `kms-signer.js`, função `signTransaction` no `toAccount()`**

```javascript
async signTransaction(transaction, { serializer } = {}) {
  const serialized = (serializer || serializeTransaction)(transaction)
  const hash = keccak256(serialized)
  const signature = await kmsSign(hash)
  const sigBytes = hexToBytes(signature)
  const r = bytesToHex(sigBytes.slice(0, 32))
  const s = bytesToHex(sigBytes.slice(32, 64))
  const v = sigBytes[64]
  const yParity = v === 27 ? 0 : 1
  return (serializer || serializeTransaction)(transaction, { r, s, yParity })
}
```

**Problema 1: Hash da transacção.** Em EIP-1559 (type 2), o hash de assinatura é `keccak256(0x02 || rlp([chainId, nonce, ...]))`, não `keccak256(serializeTransaction(...))`. A função `serializeTransaction` do viem sem assinatura produz `0x02 || rlp(...)` — o que significa que `keccak256` disso inclui o prefix `0x02` no hash. Isto é **correcto** para EIP-1559, mas pode falhar para legacy transactions (type 0) onde o hash é diferente.

**Na prática:** O executor só envia EIP-1559 transactions (post-merge Ethereum), então o risco imediato é baixo. Mas se alguém usar este signer em L2s com legacy transactions, vai produzir assinaturas inválidas silenciosamente.

**Problema 2: Parsing do `v` byte.** A assinatura retornada por `kmsSign` é construída como `0x${r}${s}${1b|1c}` (raw concat). O parse assume posição fixa: byte 64 = v. Isto funciona para este formato específico, mas é frágil — se `kmsSign` mudar o formato de retorno, o parse parte silenciosamente.

**Recomendação:** Usar `parseSignature` do viem para parsing robusto, e `signatureToHex`/`serializeSignature` para reconstrução. Alternativamente, retornar `{ r, s, yParity }` directamente de `kmsSign` em vez de concatenar e re-parsear.

---

**⚠️ FINDING [L-01] — Import morto: `privateKeyToAccount` no kms-signer.js**
**Severidade: BAIXA | Ficheiro: `kms-signer.js` linha 11**

```javascript
import { privateKeyToAccount } from "viem/accounts"
```

Este import é usado em `createExecutorAccount()` para o fallback de plaintext key, mas já está importado na mesma linha que `toAccount` e `publicKeyToAddress`. Confirmei que é usado — falso alarme, não é import morto. O import está correcto.

**Nota:** Revisitei e confirmei que `privateKeyToAccount` é de facto usado na função `createExecutorAccount()` (fallback para plaintext key). Não é finding.

---

**⚠️ FINDING [L-02] — `recoverAddress` pode ter v normalization issues**
**Severidade: BAIXA | Ficheiro: `kms-signer.js`, função `kmsSign`**

```javascript
for (let v = 27n; v <= 28n; v++) {
  const yParity = v === 27n ? 0 : 1
  const signature = `0x${r.slice(2)}${s.slice(2)}${yParity === 0 ? "1b" : "1c"}`
  const recovered = await recoverAddress({ hash: digestHex, signature })
```

O recovery loop testa v=27 e v=28, o que é correcto para determinar a recovery parameter de ECDSA. No entanto, a assinatura é construída com raw bytes `1b`/`1c` (hex de 27/28) no sufixo. viem `recoverAddress` aceita este formato (65-byte compact signature), mas o formato é implícito e depende de um detalhe de implementação do viem.

**Estado:** Funcional, mas frágil. Se viem mudar o parsing de compact signatures, isto parte.

**Recomendação:** Usar os named params explícitos se/quando viem os disponibilizar, ou pelo menos documentar o formato esperado com um comment.

---

### 1.4 Resposta à Key Question

> Does viem `recoverTypedDataAddress()` produce identical results to `ethers.verifyTypedData()` for all edge cases?

**Sim, para assinaturas EIP-712 bem formadas.** Ambas usam `ecrecover` internamente com o mesmo digest (`hashTypedData`). A diferença é apenas na interface:
- ethers: sync, retorna address
- viem: async, retorna checksummed address

**Edge cases:**

| Caso | ethers.verifyTypedData | viem.recoverTypedDataAddress | Resultado |
|---|---|---|---|
| Assinatura válida (v=27/28) | ✅ Address | ✅ Same address | Idêntico |
| v=0/1 (EIP-155 style) | ✅ Normaliza para 27/28 | ✅ Normaliza para 27/28 | Idêntico |
| Assinatura zero (65 zero bytes) | ⚠️ Retorna address != wallet → mismatch | ⚠️ Retorna address != wallet → mismatch | Comportamento equivalente (ambos recuperam um address arbitrário) |
| Hex inválido / comprimento errado | ❌ Throw | ❌ Throw | Ambos apanhados pelo catch |
| Signature malleability (s > n/2) | ⚠️ Recupera address diferente | ⚠️ Recupera address diferente | Equivalente — mas nenhum dos dois rejeita explicitamente |

**NOTA sobre malleability:** Nenhuma das duas bibliotecas faz canonicalization de `s` (rejeitar `s > secp256k1.n / 2`). Isto é aceitável porque o contrato on-chain (OpenZeppelin ECDSA) faz esta validação. O servidor API aceita ambas as formas e o contrato rejeita a não-canónica. Não é uma regressão.

---

## 2. LOW RISK — Dead Code Removal (`7251a9c`)

**✅ LIMPO.** Três ficheiros eliminados:
- `src/lib/dca-types.ts` (135 linhas)
- `src/lib/dca-engine.ts` (622 linhas)
- `src/hooks/useDCAEngine.ts` (154 linhas)

**Verificação de dangling imports:** `grep -rn "dca-engine\|dca-types\|useDCAEngine" src/` retorna zero resultados. Nenhum barrel export (`index.ts`) referenciava estes módulos.

**Nenhum finding.** Execução limpa do prompt.

---

## 3. INFORMATIONAL — Dynamic Gas Strategy (`a9ec510`)

### 3.1 Correctness

**⚠️ FINDING [M-02] — Take-profit classification usa orderType errado**
**Severidade: MÉDIA | Ficheiro: `executor.js`, função `classifyOrderUrgency`**

```javascript
// Take-profit: orderType 1 + condition 0 (ABOVE) — opportunity, not emergency
if (Number(orderStruct.orderType) === 1 && Number(orderStruct.condition) === 0) {
  return "ELEVATED"
}
```

O comment do prompt original dizia `orderType: 2` = Take-Profit, mas a implementação usa `orderType: 1` (que é Stop-Loss). Isto significa que **stop-losses com condition ABOVE** (que tecnicamente não existem no fluxo normal) seriam classificados como ELEVATED em vez de NORMAL.

Combinado com o check anterior:
```javascript
if (Number(orderStruct.orderType) === 1 && Number(orderStruct.condition) === 1) {
  return "URGENT"  // SL com condition BELOW = URGENT (correcto)
}
```

O resultado é que `orderType 1 + condition 0` = ELEVATED e `orderType 1 + condition 1` = URGENT. Isto trata orderType 1 como dois tipos distintos baseado na condition, o que pode ser intencional se o contrato não distinguir SL de TP por orderType.

**Recomendação:** Verificar o enum no contrato Solidity. Se `orderType 2` existe para TP, corrigir a condition. Se SL e TP partilham `orderType 1` e se distinguem por condition (0=ABOVE=TP, 1=BELOW=SL), o código está correcto mas o comment está errado.

---

**⚠️ FINDING [L-03] — `baseFee * BigInt(Math.ceil(...)) / 1n` divisão supérflua**
**Severidade: BAIXA | Ficheiro: `executor.js`, função `resolveGasTier`**

```javascript
maxFeePerGas: baseFee * BigInt(Math.ceil(BASEFEE_MULT_URGENT)) / 1n + priority,
```

A divisão `/ 1n` é um no-op (dividir por 1). Parece ser resíduo de uma tentativa de lidar com multiplicadores fraccionários (e.g., 2.5). No entanto, `BigInt(Math.ceil(2.5))` = `3n`, não `2.5n` — o `Math.ceil` trunca o multiplicador para inteiro, perdendo a granularidade.

**Impacto:** Para `BASEFEE_MULT_ELEVATED = 2.5`, o cálculo usa `3n` em vez de `2.5x`. Isto resulta em `maxFeePerGas` ~20% mais alto que o pretendido no tier ELEVATED.

**Recomendação:** Para multiplicadores fraccionários com BigInt, escalar por 10:
```javascript
maxFeePerGas: baseFee * BigInt(Math.round(BASEFEE_MULT_ELEVATED * 10)) / 10n + priority
```

---

**⚠️ FINDING [L-04] — Gas price + getBlock chamados POR ORDEM, não por ciclo**
**Severidade: BAIXA | Ficheiro: `executor.js`, dentro do loop `for`**

O `Promise.all([getGasPrice(), getBlock()])` está dentro do loop `for (const dbOrder of orders)`. Com `MAX_BATCH = 5`, isto faz até 5 chamadas RPC extras por ciclo (10 calls — 5 getGasPrice + 5 getBlock).

**Impacto:** Latência adicional de ~100-500ms por ordem. Para 5 ordens, até 2.5s extras por ciclo.

**Contraargumento:** O gas pode mudar entre ordens (blocos novos), então re-verificar é defensivo. É uma trade-off latência vs accuracy.

**Recomendação:** Considerar cache de ~12s (1 bloco) para a baseFee:
```javascript
let cachedGas = null
let cachedAt = 0
if (Date.now() - cachedAt > 12_000) { /* refresh */ }
```

Mas isto é optimização, não bug. Funcional como está.

---

### 3.2 Retrocompatibilidade

**Parcialmente correcta.** Sem env vars, os defaults são NORMAL=30, ELEVATED=80, URGENT=100.

Comportamento anterior: qualquer ordem executa até 100 gwei.
Comportamento novo sem env vars: ordens NORMAL só executam até 30 gwei (não 100).

**Isto é uma mudança de comportamento**, não retrocompatibilidade pura. Limit orders que antes executavam a 50 gwei agora seriam saltadas. O comment no código diz "Defaults maintain previous behavior" — **isto não é verdade** para ordens NORMAL no range 31-80 gwei.

Se a intenção é retrocompatibilidade exacta, o default de `GAS_TIER_NORMAL` deveria ser `100`. Se a intenção é melhorar o comportamento por default (o que parece ser o caso), o comment deveria reflectir isso.

---

### 3.3 Prometheus Metrics

**Correctas.** Dois novos metrics:
- `teraswap_executor_gas_skips_total{tier}` — counter com labels, formato válido
- `teraswap_executor_current_gas_gwei` — gauge com `.toFixed(2)`, formato válido

**Nota:** `NORMAL` tier não emite skip metrics (ordens NORMAL no tier NORMAL executam sempre). Se gas > NORMAL mas < ELEVATED, ordens NORMAL são skipped com tier label `"ELEVATED"`. Semanticamente correcto.

---

## Resumo de Findings

| ID | Severidade | Commit | Ficheiro | Descrição |
|---|---|---|---|---|
| H-01 | **ALTA** | a443c2a | kms-signer.js | signTransaction hash pode falhar para legacy txs; parsing de assinatura frágil |
| M-01 | MÉDIA | a443c2a | route.ts + orders.ts | Falta validação de formato de assinatura antes do cast `as 0x${string}` |
| M-02 | MÉDIA | a9ec510 | executor.js | Take-profit classification pode usar orderType errado (1 vs 2) |
| L-02 | BAIXA | a443c2a | kms-signer.js | Formato de compact signature no recovery loop é implícito/frágil |
| L-03 | BAIXA | a9ec510 | executor.js | Math.ceil trunca multiplicadores fraccionários; `/ 1n` é no-op |
| L-04 | BAIXA | a9ec510 | executor.js | getGasPrice + getBlock por ordem (não por ciclo) — latência extra |
| INFO | — | a9ec510 | executor.js | Defaults não são 100% retrocompatíveis (NORMAL=30 vs anterior 100) |

**Findings que NÃO se confirmaram:**
- Signature malleability: não é regressão (contrato on-chain valida)
- Import morto de `privateKeyToAccount`: confirmado que é usado
- v=0/1 normalization: viem normaliza correctamente

---

## Acções Recomendadas

**Imediato (antes de mainnet):**
1. [H-01] Testar `signTransaction` do KMS signer com uma transacção real em testnet. Se o executor só usa EIP-1559, documentar essa constraint. Se precisar de legacy, corrigir o hash.
2. [M-02] Confirmar o enum `orderType` no contrato Solidity e corrigir a classificação se necessário.

**Próximo sprint:**
3. [M-01] Adicionar regex de validação de assinatura (132 hex chars) nas routes de ordens.
4. [L-03] Corrigir o cálculo de multiplicadores fraccionários para BigInt.
5. Actualizar comment de retrocompatibilidade no gas strategy (NORMAL default é 30, não 100).
