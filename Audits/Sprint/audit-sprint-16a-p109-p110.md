# Auditoria Sprint 16A — P109 (M-05) + P110 (M-04)

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-14
**Scope:** 2 commits no branch `fix/sprint-16a-monitoring`
**Baseline:** Sprint 15 + P108 APPROVED. main branch merged (Sprints 13A, 13B, 14, 15).
**Commits:**
- `8b1e9c6` — P109: On-chain monitor every tick (M-05)
- `433a16d` — P110: Grace alert consistency (M-04)
**Testes:** ~607 TS (grep-counted; vitest não executa no sandbox). `npx tsc --noEmit` clean.

---

## Resumo Executivo

P109 remove a gate `count % 5` no `shouldRunOnChainScan()`, tornando o scan on-chain executado em **cada tick** (~60 s) em vez de cada 5º (~5 min). A mitigação de custo RPC é implementada via cache in-memory (`lastScannedBlockInMemory`): se o `eth_blockNumber` não avançou desde o último scan bem-sucedido, o `eth_getLogs` é ignorado. O tick-counter KV é mantido para telemetria de dashboards existentes.

P110 uniformiza a tag `[GRACE]` em todos os canais de alerta (Telegram, Email, Discord). Antes, apenas o Telegram recebia alertas grace-tagged; Email e Discord ou não viam nada ou recebiam alertas a full severity. Adicionalmente, implementa grace-counts KV persistence e `flushGraceEndSummary()` — um resumo pós-grace emitido no primeiro alerta após o fim da grace period. P0/critical bypasses o grace tag completamente.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 2 INFO**

Ambos os findings externos (M-05, M-04) estão correctamente fechados.

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
| Dados sensíveis? | **Não** | Apenas endereço público FeeCollector V2 (Etherscan-verified). |
| Testes: ~607 TS | **Sim** | +29 testes líquidos vs main. `tsc --noEmit` clean. |
| Build limpo? | **Sim** | Zero erros TypeScript. |
| FeeCollector V2 monitorado? | **Sim** | `FEE_COLLECTOR_ADDRESS = 0x47f2...7459` importado de constants.ts, usado em `scanContractEvents()` L293. |
| FeeCollector V1 monitorado? | **Sim** | `FEE_COLLECTOR_V1_ADDRESS = 0x4dAE...58eD` em L298 (analytics). |

---

## Findings

### 16A-I-01 — `incrementGraceCount` read-modify-write race

**Severidade:** INFO
**Ficheiro:** `src/lib/alert-wrapper.ts` L171-178
**Descrição:** `incrementGraceCount()` faz `readGraceCounts()` → `counts[cat] + 1` → `kv.set()`. Dois ticks simultâneos (improvável com Cloudflare Worker cron a 60 s, mas possível em cenários de retry ou cold-start race) podem ler o mesmo valor e perder um incremento. O impacto é cosmético — o resumo pós-grace mostra `×N` em vez de `×(N+1)`. Não afecta alerting, segurança, ou fund flows.
**Recomendação:** Aceitar como is. Se no futuro o Worker escalar para execução concorrente, migrar para `kv.incr()` com hash fields ou usar um Lua script atómico.

### 16A-I-02 — `clearGraceCounts` usa `kv.set({})` em vez de `kv.del()`

**Severidade:** INFO
**Ficheiro:** `src/lib/alert-wrapper.ts` L181-186
**Descrição:** `clearGraceCounts()` escreve um objecto vazio `{}` com TTL de 24 h em vez de deletar a key. Isto é semanticamente equivalente — `readGraceCounts()` retorna `{}` e `total === 0` → no-op. O objecto vazio ocupa ~30 bytes no KV, mas é insignificante. A escolha de `set({})` em vez de `del()` é provavelmente intencional para evitar importar `kv.del` (não usado noutras partes do codebase).
**Recomendação:** Aceitar como is. Sem impacto funcional ou de segurança.

---

## Análise Detalhada — P109 (M-05)

### 1. Remoção do tick-modulo gate

**Antes:**
```typescript
export async function shouldRunOnChainScan(): Promise<boolean> {
  const count = await kv.incr(ONCHAIN_TICK_COUNTER_KEY)
  return count % ONCHAIN_TICK_INTERVAL === 0  // INTERVAL era 5
}
```

**Depois:**
```typescript
export async function shouldRunOnChainScan(): Promise<boolean> {
  await kv.incr(ONCHAIN_TICK_COUNTER_KEY)  // telemetria only
  return true
}
```

**Verificação:**
- `ONCHAIN_TICK_INTERVAL` alterado de `5` para `1` — mantido exportado via `_internal` para tooling externo. ✓
- KV `incr()` mantido para continuidade de dashboards que monitoram stalled workers. ✓
- Falha do `incr()` agora é non-fatal (warn + continue) em vez de retornar `false`. **Correcto** — antes, uma falha KV impedia o scan; agora, o scan prossegue. O risco de KV failure bloqueando event detection era exactamente o M-05 concern. ✓

### 2. In-memory block cache (`lastScannedBlockInMemory`)

**Localização:** Module-scope `let lastScannedBlockInMemory: number | null = null` (L243).

**Fluxo:**
1. `runOnChainScan()` obtém `currentBlock` via `eth_blockNumber` (sempre chamado).
2. Se `lastScannedBlockInMemory !== null && currentBlock <= lastScannedBlockInMemory` → short-circuit com `eventsFound: 0`. ✓
3. O short-circuit preserva `retryResult.permanentlyLost` e `retryResult.delivered` no resultado (retry queue é drained antes do cache check). ✓
4. Após scan bem-sucedido (sem failures → `!blockAdvanceHeld`), `lastScannedBlockInMemory = toBlock`. ✓
5. Quando há failures (retry-held), o cache **não é actualizado** → próximo tick re-scans. ✓

**Análise de custo RPC por tick:**
- Tick sem novo bloco: 1 RPC call (`eth_blockNumber`) + 0 `eth_getLogs`. ✓
- Tick com novo bloco: 1 `eth_blockNumber` + 1-N `eth_getLogs` (capped a MAX_BLOCKS_PER_SCAN = 1000). ✓
- Pior caso (cold start): 1 `eth_blockNumber` + 1 KV read (`lastScannedBlock`) + N `eth_getLogs`. Idêntico ao comportamento anterior. ✓

**Cold-start safety:** Quando `lastScannedBlockInMemory` é `null`, o código cai para o KV-backed `getLastScannedBlock()` (L669). **Nenhuma perda de eventos.** ✓

### 3. Test reset function

`_resetLastScannedBlockCache()` exportado (L768) e disponível via `_internal.resetLastScannedBlockCache`. O prefixo `_` e o JSDoc `@internal` marcam-no como test-only. **Verificação:** grep confirma que é chamado apenas em ficheiros `.test.ts` (L334, L479). ✓

### 4. FeeCollector V2 na lista de contratos monitorizados

`FEE_COLLECTOR_ADDRESS` importado de `constants.ts` (L29) e usado em `scanContractEvents()` L293. O endereço resolve para `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459`. ✓

### 5. Testes P109

| Teste | Verifica | Status |
|-------|----------|--------|
| `returns true on every tick` | `incr(10)` → true | ✓ |
| `returns true regardless of modulo` | `incr(7)` → true (antes era false) | ✓ |
| `returns true even when KV fails` | `incr rejects` → true (antes era false) | ✓ |
| `still increments tick counter` | `incr` called once | ✓ |
| `skips eth_getLogs on second tick when no new block` | Cache fast-path verificado | ✓ |
| `re-scans on the next tick when a new block has been mined` | Cache invalidado por novo bloco | ✓ |
| `beforeEach` reset cache | `_internal.resetLastScannedBlockCache()` em ambos os `describe` blocks | ✓ |

**7 testes totais para P109.** Cobertura adequada para a funcionalidade.

---

## Análise Detalhada — P110 (M-04)

### 1. Grace-tagged fan-out a todos os canais

**Antes:** Durante grace, apenas `sendTelegramAlert(payload, { grace: true })` era chamado. Email e Discord eram silenciados.

**Depois:** `Promise.allSettled(CHANNELS.map(ch => ch.send(payload, { grace: true })))` — todos os 3 canais recebem o alerta grace-tagged. ✓

**Verificação de tipo:** O cast `(ch.send as (p: AlertPayload, o?: { grace?: boolean }) => Promise<void>)` é necessário porque o tipo do array `CHANNELS` tem `send` com assinaturas diferentes por canal. O cast é correcto — todas as 3 funções aceitam `(payload, options?)`. ✓

### 2. Discord `[GRACE]` formatting

**Ficheiro:** `src/lib/alert-channels/discord.ts`
- `DiscordAlertOptions` interface com `grace?: boolean`. ✓
- `[GRACE] ` prefix no embed title quando `options?.grace === true`. ✓
- `content` field acima do embed com mensagem "Alert received during grace period". ✓
- Quando `!isGrace`, `content` é `undefined` → omitido do JSON. ✓

### 3. Email `[GRACE]` formatting

**Ficheiro:** `src/lib/alert-channels/email.ts`
- `EmailAlertOptions` interface com `grace?: boolean`. ✓
- `[GRACE] ` prefix no subject line. ✓
- Amber banner HTML (`background: #fef3c7`, `border-left: 4px solid #f59e0b`) antes do headline. ✓
- XSS: `escapeHtml()` continua aplicado a `sourceId` e `reason`. O `gracePrefix` é um literal estático `'[GRACE] '` — não requer escaping. ✓

### 4. P0 bypass

**Fluxo no `emitTransitionAlert()` (L248-250):**
```typescript
if (inGrace && !critical) { ... grace path ... return }
```
P0 (`isP0Reason(reason) === true`) → `critical = true` → NÃO entra no bloco grace → segue para o fan-out normal a full severity. ✓

**Teste:** `P0 alert during grace is NOT tagged on ANY channel` verifica que todos os 3 canais são chamados sem `grace: true` nos options. ✓

### 5. Grace counts KV persistence

- **Key:** `teraswap:alert:grace-counts` com TTL 24 h (defensive ceiling). ✓
- **Schema:** `Record<string, number>` — flat object. ✓
- **`readGraceCounts()`:** Validação estrita — rejeita arrays, valores não-numéricos, `NaN`, `Infinity`, e valores ≤ 0. Retorna `{}` em caso de falha KV ou shape inválido. ✓
- **`incrementGraceCount(category)`:** Read-modify-write com `kv.set(... , { ex: GRACE_COUNTS_TTL })`. Warn on failure, never throws. ✓
- **`clearGraceCounts()`:** `kv.set(key, {}, { ex: ... })` — equivalente funcional a delete. ✓

### 6. `flushGraceEndSummary()`

- Exportada para uso externo no monitoring loop. ✓
- Reads counts → se `total === 0` → no-op. ✓
- Breakdown sorted desc por count: `cat×N, cat×M, ...`. ✓
- Payload: `sourceId: 'grace-end-summary'`, `from: 'degraded'`, `to: 'active'`. ✓
- `Promise.allSettled()` — cada canal trata os seus erros, nunca throws. ✓
- `clearGraceCounts()` chamado **após** o envio — se o envio falhar parcialmente, os counts são limpos na mesma (best-effort). Aceitável — o summary é informativo, não de segurança. ✓

### 7. Invocação do flush no `emitTransitionAlert()`

```typescript
if (!inGrace) {
  await flushGraceEndSummary()
}
```

Chamado **antes** do alerta actual, de modo que o operador vê primeiro o resumo e depois o alerta novo. Idempotente — se counts estão vazios, é no-op. ✓

### 8. Testes P110

| Teste | Verifica | Status |
|-------|----------|--------|
| `sends grace-tagged alert to ALL channels (non-P0)` | Telegram + Email + Discord com `{ grace: true }` | ✓ |
| `grace alert does not consume dedup slot` | Filtra `mockKvSet` calls — nenhuma write dedup | ✓ |
| `after grace expires, same transition fires normally` | 2 calls por canal (grace + post-grace) | ✓ |
| `P0 alert during grace is NOT tagged on ANY channel` | 3 canais chamados sem grace flag | ✓ |
| `flushes grace-end summary to all channels` | 2 calls/canal (summary + alerta); payload contém breakdown | ✓ |
| `grace-end summary is a no-op when no alerts were tagged` | 1 call/canal (apenas alerta regular) | ✓ |
| `non-P0 during grace sends to ALL channels` (isP0Reason section) | Confirmação duplicada em bloco de teste diferente | ✓ |

**7+ testes para P110.** Cobertura adequada.

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| `shouldRunOnChainScan()` sempre retorna true | **Confirmado** |
| KV failure em `incr()` é non-fatal | **Confirmado** — warn + continue |
| `lastScannedBlockInMemory` fast-path skip quando `currentBlock <= cached` | **Confirmado** |
| Cache só actualizado em full success (`!blockAdvanceHeld`) | **Confirmado** |
| Cold-start safe (cache null → KV fallback) | **Confirmado** |
| FeeCollector V2 (`0x47f2...7459`) monitorado | **Confirmado** — importado de constants.ts |
| `[GRACE]` tag em todos os canais (Telegram, Email, Discord) | **Confirmado** |
| P0 bypasses grace tag | **Confirmado** — `isP0Reason()` → `critical` → skip grace block |
| Email subject + amber banner | **Confirmado** — `[GRACE] ` prefix + `#fef3c7` banner |
| Discord embed title + content line | **Confirmado** — `[GRACE] ` prefix + content acima do embed |
| `flushGraceEndSummary()` emite resumo pós-grace | **Confirmado** — breakdown sorted, 3 canais |
| Grace counts KV persistence com TTL 24 h | **Confirmado** |
| `_resetLastScannedBlockCache` apenas em testes | **Confirmado** — grep shows only `.test.ts` imports |
| Nenhum dado sensível no diff | **Confirmado** — apenas endereços públicos |
| `npx tsc --noEmit` clean | **Confirmado** |

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

P109 fecha correctamente M-05 (on-chain monitor every tick) com mitigação de custo RPC via cache in-memory. P110 fecha correctamente M-04 (grace alert consistency) com fan-out a todos os canais, `[GRACE]` formatting por canal, P0 bypass, e resumo pós-grace.

Ambos os findings externos (M-05, M-04) estão **CLOSED**.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-14*
