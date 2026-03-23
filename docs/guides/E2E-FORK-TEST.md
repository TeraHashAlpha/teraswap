# TeraSwap — E2E Fork Test Guide

## 1. Setup (uma vez)

### 1.1 Instalar Foundry
```bash
curl -L https://foundry.paradigm.xyz | bash
# Fecha e reabre o terminal, depois:
foundryup
```
Verifica: `anvil --version` e `cast --version`

### 1.2 Dar permissões aos scripts
```bash
chmod +x scripts/fork-test.sh scripts/deal-tokens.sh scripts/check-fee.sh
```

---

## 2. Lançar o ambiente (3 terminais)

### Terminal 1 — Anvil Fork
```bash
npm run fork
```
Isto lança o Anvil a fazer fork da mainnet Ethereum no bloco mais recente.
Vai mostrar 10 contas com 10000 ETH cada. Copia a **Account 0** e a sua **private key**.

Conta padrão:
```
Address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
PK:      0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

### Terminal 2 — Next.js (modo fork)
```bash
npm run dev:fork
```
Isto arranca o Next.js com `NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545`.
O Wagmi/Viem vai ligar-se automaticamente ao Anvil em vez do Alchemy.

### Terminal 3 — Financiar carteira
```bash
npm run deal -- 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```
Isto envia 100K USDC, 100K DAI, 2 WBTC, 50K USDT e 50 WETH para a conta.

Para usar o **teu endereço MetaMask** em vez da conta Anvil:
```bash
npm run deal -- 0xTEU_ENDERECO_METAMASK
```

### MetaMask — Configurar rede
1. Settings > Networks > Add Network
2. Nome: `Anvil Fork`
3. RPC URL: `http://127.0.0.1:8545`
4. Chain ID: `1`
5. Symbol: `ETH`

**OU** importar a private key da conta Anvil 0 (mais simples para testes).

---

## 3. Cenários de Teste

### Cenário A: ETH → USDC (Uniswap V3 Direct)

**Objetivo**: Validar o novo código do Uniswap V3 com auto fee tier detection.

```
1. Abre http://localhost:3000
2. Conecta wallet (conta Anvil 0 ou MetaMask)
3. Seleciona: ETH → USDC
4. Amount: 1 ETH
5. Espera pelas quotes (15s max)
```

**O que verificar:**
- [ ] Quote do "Uniswap V3 Direct" aparece na lista de sources
- [ ] O fee tier é mostrado (ex: "0.3% pool") na secção de detalhes
- [ ] Os 4 candidates (0.01%, 0.05%, 0.3%, 1%) aparecem como chips
- [ ] O amountOut é razoável (~2000+ USDC por 1 ETH)
- [ ] Clica "Swap"
- [ ] MetaMask pede confirmação → Confirma
- [ ] A transação é submetida e confirmada no fork

**Debug — ver trace no Anvil:**
No terminal 1, procura o log da tx. Deve aparecer:
- `quoteExactInputSingle` (phase de quote)
- `multicall` → `exactInputSingle` (phase de execução)

Verifica que o `amountIn` no `exactInputSingle` = 1 ETH - 0.1% fee:
```
1 ETH = 1000000000000000000 wei
0.1% fee = 1000000000000000 wei
Net amountIn = 999000000000000000 wei
```

### Cenário B: USDC → ETH (Testar Approvals)

**Objetivo**: Validar que o approval flow funciona para ERC20 → ETH.

```
1. Seleciona: USDC → ETH
2. Amount: 1000 USDC
3. Espera pelas quotes
```

**O que verificar:**
- [ ] A UI mostra que é necessário "Approve" antes do swap
- [ ] Para Uniswap V3: approve ao SwapRouter02 (`0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`)
- [ ] Para 0x: approve ao Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`)
- [ ] Clica "Approve" → MetaMask confirma → Approval bem sucedido
- [ ] Clica "Swap" → Transação confirmada
- [ ] Saldo de USDC diminuiu ~1000, saldo de ETH aumentou

### Cenário C: Verificar Fee de 0.1%

**Objetivo**: Confirmar que a fee do TeraSwap está a ser cobrada.

**Método 1 — Para Uniswap V3 (fee deduzida do amountIn):**

Antes do swap, no terminal 3:
```bash
# Saldo ETH do teu endereço ANTES do swap
cast balance 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url http://127.0.0.1:8545
```

Depois do swap ETH → USDC:
```bash
# A diferença deve ser 1.001 ETH (1 ETH swap + ~0.001 ETH fee + gas)
cast balance 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url http://127.0.0.1:8545
```

**Método 2 — Nos logs do Anvil:**

Quando a tx do `exactInputSingle` executa, o Anvil mostra os params.
Confirma que:
- `amountIn` = montante original × 0.999 (fee já deduzida)
- Se o original for 1 ETH → amountIn ao router = 0.999 ETH

**Método 3 — Script automático:**
```bash
npm run check:fee
```
Mostra os saldos do FEE_RECIPIENT para todos os tokens.

**Nota importante**: Para o Uniswap V3 Direct, a fee NÃO vai para o `FEE_RECIPIENT` via transfer.
A fee é deduzida do `amountIn` — o user envia menos ao router.
O "lucro" fica implícito (o user pagou 1 ETH mas só 0.999 ETH foi para o swap).
Para os aggregators (1inch, 0x, Velora), a fee é cobrada pela própria API.

### Cenário D: WBTC → USDC (Token com 8 decimals)

**Objetivo**: Verificar que tokens com decimals diferentes (8, 6) funcionam.

```
1. Seleciona: WBTC → USDC
2. Amount: 0.1 WBTC
3. Verifica que o amountOut é razoável (~6000-7000 USDC)
4. Executa o swap
```

- [ ] Quote bem sucedida
- [ ] Uniswap V3 auto-detecta o fee tier (provavelmente 0.3%)
- [ ] Swap executa sem erros de BigInt ou overflow

### Cenário E: Multi-source comparison

**Objetivo**: Verificar que o meta-aggregator compara todas as sources.

```
1. ETH → USDC, 10 ETH
2. Espera pelas quotes
3. Verifica a secção "Compare (X sources)"
```

- [ ] Pelo menos 2-3 sources respondem
- [ ] Uniswap V3 Direct sempre responde (on-chain, não depende de APIs)
- [ ] A melhor quote está marcada com checkmark
- [ ] Os amountOut são diferentes entre sources (como esperado)

---

## 4. Problemas Conhecidos com APIs no Fork

### Porque é que 1inch / 0x / Odos podem falhar?

As APIs externas (1inch, 0x, Odos, KyberSwap, CoW) fazem as suas **próprias** queries
à mainnet real. Quando tu submetes a tx no fork, estas APIs podem:

1. **Verificar saldo on-chain real** — a tua conta Anvil tem saldo no fork,
   mas na mainnet real NÃO tem os tokens. APIs que validam saldo rejeitam.

2. **Nonce mismatch** — o nonce da conta no fork diverge do nonce real.

3. **Quote stale** — a quote da API é para o estado real da mainnet,
   mas o fork pode estar alguns blocos atrasado.

### Como contornar:

| Source | Funciona no Fork? | Notas |
|--------|-------------------|-------|
| **Uniswap V3** | SIM (100%) | Direto on-chain, sem API externa |
| **1inch** | Quote SIM, Swap TALVEZ | A API valida o from address; swap pode falhar se validar saldo |
| **0x** | Quote SIM, Swap TALVEZ | Permit2 pode complicar no fork |
| **Velora** | Quote SIM, Swap TALVEZ | POST /transactions valida on-chain |
| **Odos** | Quote SIM, Swap PARCIAL | O assemble step pode rejeitar |
| **KyberSwap** | Quote SIM, Swap TALVEZ | Route build pode falhar |
| **CoW Protocol** | NAO | Intent-based; requer solver real |

**Conclusão**: O Uniswap V3 Direct é o **único** que funciona 100% no fork
porque é 100% on-chain. Para os outros, as **quotes funcionam** (para comparar
preços), mas os **swaps** podem falhar. Isto é esperado e NÃO é um bug.

### Erros comuns e o que significam:

```
"execution reverted"
→ O calldata da API foi construído para o estado real da mainnet.
  No fork, o estado pode ter divergido. Aumenta slippage ou testa outro par.

"insufficient funds for transfer"
→ A API verificou saldo na mainnet real. O teu endereço tem saldo
  apenas no fork. Usa Uniswap V3 Direct para testar.

"nonce too high" / "nonce too low"
→ O nonce no fork divergiu. Faz reset da conta no MetaMask:
  Settings > Advanced > Clear activity tab data

"UNPREDICTABLE_GAS_LIMIT"
→ O estimateGas falhou. Isto acontece quando a tx vai reverter.
  Geralmente é porque os dados de calldata estão desatualizados.
```

### Dica: Forçar o Uniswap V3 no UI

Se quiseres testar especificamente o Uniswap V3 sem interferência das APIs:

1. Na secção "Compare", verifica que "Uniswap V3 Direct" aparece
2. Se outra source ganhar, é esperado — significa que o aggregator
   encontrou melhor preço. O meta-aggregator está a funcionar!

Para isolar APENAS o Uniswap V3, podes temporariamente comentar as
outras sources no `fetchMetaQuote` de `api.ts` (só para debug).

---

## 5. Debug avançado

### Ver todas as txs do fork:
```bash
# Últimos blocos
cast block-number --rpc-url http://127.0.0.1:8545

# Ver tx específica
cast tx <TX_HASH> --rpc-url http://127.0.0.1:8545

# Decode calldata (para ver os params do swap)
cast 4byte-decode <CALLDATA>
```

### Ver saldo de qualquer token:
```bash
cast call 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  "balanceOf(address)(uint256)" \
  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  --rpc-url http://127.0.0.1:8545
```

### Reiniciar o fork (estado limpo):
```bash
# Ctrl+C no terminal do Anvil, depois:
npm run fork
npm run deal -- 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

### Se o MetaMask fica "stuck":
Settings > Advanced > Clear activity tab data
(Isto faz reset dos nonces cached)
