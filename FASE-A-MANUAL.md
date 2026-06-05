# Fase A — Acções Manuais (TeraHash)

Estas acções não requerem prompts para o coder. São configurações manuais que só tu podes fazer.

---

## R4: 2FA Obrigatório (GitHub + Vercel)

### GitHub

1. Ir a [github.com/settings/security](https://github.com/settings/security)
2. Secção **Two-factor authentication** → clicar **Enable**
3. Escolher método:
   - **Recomendado:** Authenticator app (Google Authenticator, Authy, 1Password)
   - Alternativa: Security key (YubiKey)
4. Escanear o QR code com a app
5. Introduzir o código de 6 dígitos para confirmar
6. **Guardar os recovery codes** num local seguro (offline, não no repositório)
7. Verificar: Settings → Security → deve mostrar "Two-factor authentication is enabled"

### Vercel

1. Ir a [vercel.com/account/security](https://vercel.com/account/security)
2. Secção **Two-Factor Authentication** → clicar **Enable**
3. Escanear QR code com a mesma app de autenticação
4. Introduzir código de 6 dígitos
5. **Guardar os backup codes**
6. Se tiveres team members no projecto Vercel:
   - Ir a **Team Settings → General → Security**
   - Activar **Require 2FA for all members**
7. Verificar: Account → Security → deve mostrar "Enabled"

**Tempo estimado:** 5 minutos total

---

## R9: Migração para Gnosis Safe Multisig (2-of-3)

### Pré-requisitos

- 3 wallets disponíveis (hardware wallets recomendadas para pelo menos 2)
- ETH suficiente para gas na wallet admin actual (~0.01 ETH para deploy do Safe + transacções)
- Os endereços dos contratos TeraSwap:
  - **OrderExecutor:** `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130`
  - **FeeCollector:** `0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD`

### Passo 1: Criar o Gnosis Safe

1. Ir a [app.safe.global](https://app.safe.global)
2. Ligar a wallet admin actual
3. Clicar **Create New Safe**
4. **Network:** Escolher a mesma rede dos contratos (Sepolia para teste, Ethereum Mainnet para produção)
5. **Nome:** `TeraSwap Admin`
6. **Owners — adicionar 3 endereços:**
   - Owner 1: A wallet admin actual do TeraSwap (a que está ligada)
   - Owner 2: Segunda wallet (hardware wallet recomendada)
   - Owner 3: Terceira wallet (hardware wallet recomendada)
7. **Threshold:** `2 out of 3` (qualquer combinação de 2 owners pode aprovar)
8. Clicar **Create** — confirmar a transacção na wallet
9. Esperar confirmação (1-2 minutos)
10. **Anotar o endereço do Safe criado** (ex: `0xABC...123`)

### Passo 2: Testar o Safe

Antes de transferir admin dos contratos, testa que o Safe funciona:

1. No Safe UI, ir a **New Transaction → Send tokens**
2. Enviar 0 ETH para ti próprio (transacção de teste)
3. Assinar com Owner 1
4. Pedir ao Owner 2 para ligar ao Safe e confirmar a transacção
5. Verificar que a transacção executa com 2 assinaturas
6. Verificar que 1 assinatura sozinha NÃO executa

### Passo 3: Transferir Admin do OrderExecutor

O OrderExecutor usa timelock — a transferência de admin demora **7 dias** (Prompt 18).

1. No Safe UI, ir a **New Transaction → Transaction Builder**
2. Inserir:
   - **To:** `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` (OrderExecutor)
   - **ABI:** Colar a ABI do OrderExecutor (ou usar o Etherscan verified contract)
   - **Function:** `queueAdminChange`
   - **Parameter `newAdmin`:** O endereço do Safe (anotado no Passo 1)
3. **NÃO uses o Safe para esta chamada** — usa a wallet admin actual directamente
   - Vai ao Etherscan: `https://etherscan.io/address/0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130#writeContract`
   - Liga a wallet admin actual
   - Chama `queueAdminChange(SAFE_ADDRESS)`
   - Confirma a transacção
4. Anotar o **actionId** do evento `TimelockQueued` emitido (ver nos logs da transacção)
5. O event watcher deve enviar um alerta Telegram: `⏳ TimelockQueued — Admin Transfer — Execute window opens in 7 days`

### Passo 4: Esperar 7 Dias

- O timelock de admin transfer é de 7 dias (configurado no Prompt 18)
- Durante estes 7 dias, podes cancelar com `cancelTimelockAction(actionId)` se algo correr mal
- O event watcher vai alertar quando a janela de execução abrir

### Passo 5: Executar a Transferência

Após 7 dias (e antes de 14 dias — grace period):

1. No Etherscan, com a wallet admin actual ligada:
   - Chamar `executeAdminChange(actionId, SAFE_ADDRESS)`
   - `actionId` = o que anotaste no Passo 3
   - `SAFE_ADDRESS` = o endereço do Safe
2. Confirmar a transacção
3. **Verificar:** Chamar `admin()` no contrato — deve retornar o endereço do Safe
4. O event watcher deve enviar: `🔴 CRITICAL — AdminTransferred — new admin: 0xSAFE...`

### Passo 6: Transferir Admin do FeeCollector

**Nota importante:** O FeeCollector actual (`TeraSwapFeeCollector.sol`) **NÃO tem função `transferAdmin`**. O admin é definido no constructor e não pode ser alterado.

**Opções:**
- **Opção A (recomendada):** Deploy de novo FeeCollector com admin = Safe address. Actualizar o frontend (`FEE_COLLECTOR_ADDRESS` em `constants.ts`) e migrar routers whitelisted.
- **Opção B:** Manter o FeeCollector actual até um upgrade mais abrangente no futuro. O risco é mitigado porque:
  - `setRouter()` agora tem timelock de 48h (Prompt 18)
  - `sweep()` requer `whenNotPaused` e fundos vão para `feeRecipient` (imutável)
  - `pause()` é a única acção de risco imediato, mas é uma operação de emergência

**Recomendação do arquitecto:** Opção B por agora. O FeeCollector tem timelock no router e o fee recipient é imutável. O risco residual de `pause()` ser chamado por um atacante é baixo (não drena fundos, apenas para swaps temporariamente). Planear a migração completa para o Sprint 5.

### Passo 7: Validação Final

1. **OrderExecutor:** No Etherscan, chamar `admin()` → deve retornar o endereço do Safe
2. **Teste funcional:** Via Safe UI, criar uma transacção para `queueRouterChange(0x0000...0001, false)` (endereço dummy)
   - Assinar com Owner 1
   - Confirmar com Owner 2
   - Verificar que executa
   - Cancelar a acção queued com `cancelTimelockAction(actionId)` (via Safe, 2 assinaturas)
3. **Teste de rejeição:** Tentar a mesma operação com apenas 1 owner — deve ficar pendente e NÃO executar

### Passo 8: Documentar

- Guardar os 3 endereços dos owners num local seguro
- Guardar o endereço do Safe
- Documentar o procedimento de recovery se um owner perder acesso (os outros 2 podem adicionar novo owner via Safe)

**Tempo estimado:** 30 minutos para criar o Safe + test. 7 dias de espera para o timelock. 10 minutos para executar.

---

## Acções Adicionais Pendentes

### Criar Vercel KV Store

1. Ir ao [Vercel Dashboard](https://vercel.com) → Projecto TeraSwap → **Storage**
2. Clicar **Create Database** → **KV (Redis)**
3. Nome: `teraswap-rate-limit`
4. Região: `iad1` (US East, mais perto dos edge functions)
5. Clicar **Create**
6. O Vercel adiciona automaticamente as env vars (`KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`) ao projecto
7. Redeploy para activar: **Deployments → Redeploy**

### Configurar Vercel Secrets (Deploy Preview)

1. No Vercel Dashboard → Projecto → **Settings → Environment Variables**
2. Adicionar:
   - `VERCEL_TOKEN`: Gerar em [vercel.com/account/tokens](https://vercel.com/account/tokens) → Create Token
   - `VERCEL_ORG_ID`: Settings → General → "Vercel ID" do team/personal account
   - `VERCEL_PROJECT_ID`: Settings → General → "Project ID"
3. Scope: **All environments** (Preview + Production + Development)
4. No GitHub: Settings → Secrets → Actions → adicionar os mesmos 3 secrets
