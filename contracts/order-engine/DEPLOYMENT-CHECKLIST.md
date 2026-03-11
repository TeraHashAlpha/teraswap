# TeraSwap Order Engine — Deployment Checklist

> Gerado: 9 Março 2026
> Contrato: `TeraSwapOrderExecutor v2`
> Sepolia actual: `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130`

---

## Security Audit — Estado dos Findings

### Medium Severity (todos implementados ✅)

| Finding | Descrição | Fix | Verificado |
|---------|-----------|-----|------------|
| M-01 | Fee Precision Loss | `MIN_ORDER_AMOUNT = 10_000` + `DCAChunkTooSmall` | ✅ |
| M-02 | DCA Amount Truncation | Última execução recebe remainder | ✅ |
| M-03 | Timelock Race Condition | `TIMELOCK_GRACE = 7 days` + `TimelockExpired` | ✅ |

### Low Severity (aplicados nesta sessão)

| Finding | Descrição | Fix | Estado |
|---------|-----------|-----|--------|
| L-01 | Custom errors inconsistentes | Já usados consistentemente | ✅ N/A |
| L-02 | TimelockExecuted event insuficiente | Adicionado `actionType` + `data` params | ✅ Aplicado |
| L-03 | `price <= 0` ineficiente | Cosmético — aceite como está | ✅ N/A |
| L-04 | Sem validação `dcaTotal == 0` | Adicionado `InvalidDCATotal` / `InvalidDCAInterval` em `canExecute` + `executeOrder` | ✅ Aplicado |
| L-05 | Bootstrap sem validação de contrato | Adicionado `extcodesize` check — rejeita EOAs com `NotAContract` | ✅ Aplicado |

### Informational (documentação adicionada)

| Finding | Descrição | Estado |
|---------|-----------|--------|
| I-01 | EIP-712 domain hardcoded | Documentado no constructor NatSpec | ✅ |
| I-02 | Missing NatSpec em funções internas | Adicionado a `_checkPriceCondition` e `getOrderHash` | ✅ |
| — | Oracle assumptions | Documentado (MAX_STALENESS, 8 decimals, staleness) | ✅ |
| — | Nonce semantics | Documentado (non-DCA vs DCA, mass cancel, upper bound) | ✅ |

### Frontend Features (adicionadas pós-audit)

| Feature | Descrição | Estado |
|---------|-----------|--------|
| Push Notifications | Browser Notification API quando ordens são preenchidas (background tab) | ✅ |
| Notification Banner | Banner dismissível a pedir permissão de notificações | ✅ |
| Audio Chime | Som de confirmação via Web Audio API nos fills | ✅ |
| Dark/Light/System | ThemeContext + ThemeToggle + CSS vars + localStorage | ✅ (já existia) |

### Compilação & Build

- Contrato: ✅ Zero errors (solc 0.8.28, via-IR)
- Frontend (Next.js): ✅ Zero errors
- ABI verificado: novos errors (`InvalidDCATotal`, `InvalidDCAInterval`, `NotAContract`) e evento `TimelockExecuted` actualizado

---

## Passo-a-Passo para Deploy

### 1. Re-deploy do contrato (Sepolia → Mainnet)

O contrato mudou (novos errors, evento L-02, validação L-05), por isso é necessário re-deploy.

```bash
cd contracts/order-engine

# Sepolia
node deploy-sepolia.js

# Mainnet (quando pronto)
node deploy.js
```

Depois de deployar, actualizar:
- `deployment-11155111.json` (ou `deployment-1.json` para mainnet)
- Vercel env: `NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS=<novo_address>`

### 2. Bootstrap do novo contrato

```bash
node bootstrap.js
```

⚠️ **NOTA L-05**: O bootstrap agora rejeita EOAs — só aceita endereços com código (contratos).
Routers a whitelistar: 1inch, 0x, Paraswap, Uniswap Router, etc.
Executors a whitelistar: endereço da wallet do executor keeper.

### 3. Schema SQL no Supabase

Correr `schema.sql` no SQL Editor do Supabase. Inclui:
- Tabela `orders` com todos os campos (incluindo `order_data`, `token_in_decimals`, `token_out_decimals`, `error`)
- Tabela `order_executions` para histórico DCA
- RLS policies (users só vêem as suas próprias orders)
- Rate limiting function (`check_order_rate_limit`)
- Triggers de normalização de wallet addresses

⚠️ Se a tabela `orders` já existir, usar `ALTER TABLE` para adicionar colunas em falta.

### 4. Environment Variables no Vercel

```
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS=<novo_address>
NEXT_PUBLIC_SUPABASE_URL=<url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon_key>
```

### 5. Push do código + Deploy

```bash
git add -A
git commit -m "audit: apply L-02, L-04, L-05, I-01, I-02 security fixes + push notifications + deployment docs"
git push
```

O Vercel faz auto-deploy após push.

### 6. Iniciar o Executor Keeper

```bash
cd contracts/order-engine/executor
cp .env.executor.example .env.executor
```

Preencher `.env.executor`:
```
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<key>
EXECUTOR_PRIVATE_KEY=<key>
SUPABASE_URL=<url>
SUPABASE_SERVICE_ROLE_KEY=<key>
ORDER_EXECUTOR_ADDRESS=<novo_address>
TERASWAP_API_URL=https://teraswap.xyz
CHAIN_ID=11155111
```

Iniciar:
```bash
# Dev
npm start

# Produção (PM2)
pm2 start ecosystem.config.cjs
```

### 7. Verificação Pós-Deploy

- [ ] Health check: `http://localhost:3001/health`
- [ ] Criar uma limit order de teste na UI
- [ ] Verificar que aparece no Supabase (`orders` table)
- [ ] Verificar que o executor detecta a order (`canExecute` = true quando preço atingido)
- [ ] Verificar execução completa (status → `executed`, tx_hash preenchido)
- [ ] Testar DCA order (multiple executions)
- [ ] Testar cancelamento de order
- [ ] Testar push notification (permitir no browser, abrir noutra tab, esperar fill)
- [ ] Testar dark/light mode toggle no header
- [ ] Monitorar primeiras 100 execuções para precision loss (M-01)

### 8. Mainnet Checklist Adicional

- [ ] Migrar executor key para KMS/Vault (não usar plaintext private key)
- [ ] Configurar Flashbots Protect RPC (anti-MEV)
- [ ] Verificar gas price safety cap (`MAX_GAS_PRICE_GWEI`)
- [ ] Fund executor wallet com ETH suficiente para gas
- [ ] Configurar monitoring/alerting no health endpoint
- [ ] Verificar fee recipient address é correcto
- [ ] Considerar multi-sig para admin role

---

## Endereços Importantes

| Item | Endereço |
|------|----------|
| OrderExecutor (Sepolia) | `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` |
| FeeCollector | `0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD` |
| Fee Recipient | `0x107F6eB7C3866c9cEf5860952066e185e9383ABA` |
| COW VaultRelayer | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| COW Settlement | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` |
| WETH (Sepolia) | `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9` |
