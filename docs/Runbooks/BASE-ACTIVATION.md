# Base L2 Activation — Complete Runbook

**Author:** Architect  
**Date:** 2026-05-30  
**Status:** Ready for execution  
**Prerequisites:** Sprints 39-44 merged. All 27 audit findings closed. Multi-chain foundation + Base swap prep complete.

---

## Overview

Three phases, in strict order. Each phase has a gate — do NOT proceed until the gate passes.

```
Phase A: Testnet Deploy + Validate (Base Sepolia)
    ↓ Gate: end-to-end swap works on testnet
Phase B: Activation Code (Sprint 45) + Audit
    ↓ Gate: Sprint 45 APPROVED 0C/0H
Phase C: Mainnet Deploy + Go Live (Base)
    ↓ Gate: post-deploy verification checklist passes
```

---

## Phase A — Testnet Deploy (Base Sepolia)

### A.1 — Fund admin wallet on Base Sepolia

```
Network: Base Sepolia (chainId 84532)
RPC: https://sepolia.base.org
Faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet (or bridge testnet ETH)
```

Get ~0.1 Base Sepolia ETH for deployment gas.

### A.2 — Deploy FeeCollector on Base Sepolia

1. Open [Remix](https://remix.ethereum.org)
2. Create file `TeraSwapFeeCollector.sol` → paste contract code from `contracts/TeraSwapFeeCollector.sol`
3. Compile: Solidity 0.8.28, optimizer ON (200 runs), via_ir ON
4. Deploy tab → Environment: "Injected Provider" (MetaMask on Base Sepolia)
5. Constructor args:
   - `_feeRecipient`: `0x107F6eB7C3866c9cEf5860952066e185e9383ABA` (same as mainnet)
   - `_admin`: your admin wallet address
6. Deploy → confirm in MetaMask
7. **Save the deployed address** → `BASE_SEPOLIA_FEE_COLLECTOR=0x...`

### A.3 — Bootstrap routers on Base Sepolia

Call `bootstrapRouters` with the Base router whitelist. In Remix:

1. Select the deployed contract
2. Call `bootstrapRouters` with array of addresses:

```
["0x111111125421cA6dc452d289314280a0f8842A65","0x0000000000001fF3684f28c67538d4D072C22734","0x6A000F20005980200259B80c5102003040001068","0x19cEeAd7105607Cd444F5ad10dd51356436095a1","0x6131B5fae19EA4f9D964eAc0408E4408b66337b5","0xC92E8bdf79f0507f65a392b0ab4667716BFE0110","0x6352a56caadC4F1E25CD6c75970Fa768A3304e64","0xAC4c6e212A361c968F1725b4d055b47E63F80b75","0xBA12222222228d8Ba445958a75a0704d566BF2C8","0x2626664c2603336E57B271c5C0b26F421741e481","0x4f37A9d177470499A2dD084621020b023fcffc1F"]
```

**NOTA:** Verifica que estes endereços existem no Base Sepolia. Alguns routers podem não estar deployed no testnet. Se um endereço não existir no testnet, remove-o do array — o testnet é para validar o flow, não a whitelist exacta.

### A.4 — Verify on testnet Basescan

```
https://sepolia.basescan.org/address/0x<DEPLOYED_ADDRESS>#code
```

Verify contract code. Use Basescan's verification tool ou `forge verify-contract`.

### A.5 — Post-deploy verification checklist (testnet)

Call these read functions no Remix (ou Basescan):

| Function | Expected |
|----------|----------|
| `feeRecipient()` | `0x107F6eB7C3866c9cEf5860952066e185e9383ABA` |
| `admin()` | Your admin wallet |
| `FEE_BPS()` | `10` |
| `paused()` | `false` |
| `whitelistedRouters(0x111111125421cA6dc452d289314280a0f8842A65)` | `true` (1inch) |

Se tudo OK → **Gate A passa**.

### A.6 — (Opcional) Testar swap end-to-end no testnet

Para testar um swap real no testnet:
1. Configurar localmente `NEXT_PUBLIC_BASE_RPC_URL=https://sepolia.base.org`
2. Temporariamente definir `feeCollector: '0x<TESTNET_ADDRESS>'` no Base config
3. Executar `npm run dev` e tentar um swap com tokens testnet

Se os routers não existirem no testnet, este passo pode ser skipped — a validação real acontece na mainnet com o activation guard.

---

## Phase B — Activation Code (Sprint 45)

### B.1 — Sprint 45 scope

O Sprint 45 corrige os **3 items mainnet-pinned** que impedem swaps reais no Base:

1. **FeeCollector address em swap calldata** — `useSwap.ts`, `useSplitSwap.ts`, `buildSimulationTx` usam `FEE_COLLECTOR_ADDRESS` hardcoded. Devem resolver via `getChainConfig(chainId).contracts.feeCollector`.

2. **`fetchApproveSpender` per-chain** — `api.ts` retorna spender addresses hardcoded para mainnet. Deve usar `ROUTER_WHITELIST_BY_CHAIN[chainId]`.

3. **Simulation RPC client per-chain** — `simulateSwapTx` usa `getPrivateClient()` (mainnet). Deve usar um client para a chain activa.

### B.2 — Goal do Sprint 45 (dar ao Code Agent)

```
Workflow: implement Sprint 45 — Base swap activation wiring. Read docs/Prompts/SPRINT-45.md for the full spec. Branch: feat/sprint-45-base-activation from main. 3 prompts, 3 commits:

P225 — FeeCollector address per-chain: In useSwap.ts, useSplitSwap.ts, and swap-simulation.ts (buildSimulationTx), replace FEE_COLLECTOR_ADDRESS constant with getChainConfig(chainId).contracts.feeCollector. Pass chainId through the entire calldata construction chain. The FeeCollector ABI encoding must use the correct per-chain address. Commit: feat(base): resolve FeeCollector address per-chain in swap calldata [P225]

P226 — fetchApproveSpender + simulation client per-chain: (a) In api.ts, make fetchApproveSpender chain-aware — resolve spender from ROUTER_WHITELIST_BY_CHAIN[chainId] instead of hardcoded mainnet addresses. (b) In simulateSwapTx (swap-simulation.ts), create/use a per-chain public client instead of always getPrivateClient() (mainnet). Use getChainConfig(chainId).rpc to resolve the RPC URL. Commit: feat(base): per-chain spender resolution + simulation client [P226]

P227 — Tests (6 new): verify FeeCollector address resolves per-chain in calldata, verify fetchApproveSpender returns Base routers for chainId=8453, verify simulation client targets correct chain RPC, verify mainnet calldata unchanged. Commit: test: add Base activation wiring tests [P227]

CRITICAL: mainnet behavior must be IDENTICAL. All changes resolve via chainId — chainId=1 produces same values as before. npm run typecheck must pass after each commit.
```

### B.3 — Auditar Sprint 45

Goal do auditor: verificar que:
1. FeeCollector address correcto per-chain no calldata
2. Spender resolution correcto per-chain
3. Simulation client aponta para o RPC correcto
4. Mainnet byte-identical
5. Base path funciona quando feeCollector != null

### B.4 — Merge Sprint 45

Após APPROVED 0C/0H → merge. **Gate B passa.**

---

## Phase C — Mainnet Deploy (Base)

### C.1 — Fund admin wallet on Base mainnet

```
Network: Base (chainId 8453)
RPC: https://mainnet.base.org (ou Alchemy/QuickNode)
```

Obter ~0.01 ETH no Base (bridge via Coinbase, Base Bridge, ou comprar directamente).

### C.2 — Deploy FeeCollector on Base mainnet

Mesmo processo que A.2, mas no **Base mainnet**:

1. Remix → MetaMask no Base mainnet
2. Constructor: `_feeRecipient` = `0x107F6eB7C3866c9cEf5860952066e185e9383ABA`, `_admin` = admin wallet
3. Deploy → confirmar
4. **Save: `BASE_MAINNET_FEE_COLLECTOR=0x...`**

Custo estimado: ~$0.10-0.50 (Base gas é muito barato)

### C.3 — Bootstrap routers on Base mainnet

Call `bootstrapRouters` com o array COMPLETO (mesmo da secção A.3, mas agora todos os endereços existem no Base mainnet — verificados no Basescan durante Sprint 44).

### C.4 — Verify on Basescan

```
https://basescan.org/address/0x<DEPLOYED_ADDRESS>#code
```

### C.5 — Post-deploy verification checklist (mainnet)

| Function | Expected |
|----------|----------|
| `feeRecipient()` | `0x107F6eB7C3866c9cEf5860952066e185e9383ABA` |
| `admin()` | Your admin wallet |
| `FEE_BPS()` | `10` |
| `paused()` | `false` |
| `whitelistedRouters(1inch)` | `true` |
| `whitelistedRouters(0x)` | `true` |
| `whitelistedRouters(Odos)` | `true` |
| `whitelistedRouters(Uniswap)` | `true` |
| `whitelistedRouters(SushiSwap)` | `true` |

### C.6 — Update config + deploy

1. **Update `src/lib/chains/registry.ts`:**
   ```typescript
   // In CHAIN_CONFIGS[8453].contracts:
   feeCollector: '0x<BASE_MAINNET_FEE_COLLECTOR>'
   ```

2. **Set environment variables (Vercel):**
   ```
   NEXT_PUBLIC_BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<KEY>
   NEXT_PUBLIC_BASE_FEE_COLLECTOR=0x<BASE_MAINNET_FEE_COLLECTOR>
   ```

   > **⚠️ ALCHEMY_API_KEY app scope** [CHORE-POLISH-3 P4 / E3-I-02]: o
   > `ALCHEMY_API_KEY` (server-only, já configurado para o portfolio mainnet)
   > serve TAMBÉM o discovery Base — no dashboard Alchemy a app da key tem de
   > ter **eth-mainnet E base-mainnet** ativados. Uma key só-mainnet degrada
   > silenciosamente o discovery Base para 503 (o fallback multicall cobre,
   > mas com pior UX). Verificar: `curl -s -X POST
   > https://base-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY -H 'content-type:
   > application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'`
   > tem de devolver um result (não um erro de auth/network-not-enabled).

3. **Commit + push:**
   ```bash
   git add src/lib/chains/registry.ts
   git commit -m "feat(base): activate Base L2 swaps — FeeCollector deployed"
   git push origin main
   ```

4. **Vercel auto-deploys** on push to main.

### C.7 — Smoke test (LIVE)

1. Abrir TeraSwap no browser
2. Switch para Base no chain selector
3. Verificar que "Coming Soon" desapareceu
4. Tentar swap: ETH → USDC (valor pequeno, ~$5-10)
5. Verificar quote (vem de múltiplos adapters)
6. Executar swap → confirmar no wallet
7. Verificar no Basescan que a tx foi bem sucedida
8. Verificar que o fee (0.1%) foi cobrado para o `feeRecipient`

### C.8 — Monitor

Primeiras 24h:
- Verificar Sentry para erros novos
- Verificar Basescan para txs do FeeCollector
- Verificar fee revenue a fluir
- Verificar que swaps mainnet continuam normais

**Gate C passa → Base L2 LIVE** 🎉

---

## Rollback

Se algo correr mal em qualquer fase:

**Phase A (testnet):** Sem impacto. Ignorar e investigar.

**Phase B (code):** Revert o Sprint 45 PR. Mainnet não é afectado (só código, não deploy).

**Phase C (live):**
1. **Imediato:** Chamar `pause()` no FeeCollector Base via Remix/Etherscan
2. **Desactivar na UI:** Reverter `feeCollector` para `null` no registry.ts, push
3. **Investigar:** Verificar txs no Basescan, confirmar nenhum fundo perdido
4. **Corrigir:** Fix + audit + re-deploy

O FeeCollector tem `pause()` de emergência e `sweep()` (para admin) — mesmos mecanismos que no mainnet.

---

_Este runbook cobre a activação completa do Base L2. Todas as decisões arquitecturais, código preparatório, e verificações de segurança estão concluídos nos Sprints 42-44. O risco é LOW — o contrato é o mesmo que está live no mainnet, apenas numa chain diferente._
