# Runbook — Vercel Breach Secret Rotation (INC-2026-04-19-001)

**Created:** 2026-04-20
**Status:** IN PROGRESS
**Prerequisite:** Site OFFLINE (domains removed from Vercel project)

---

## Pré-requisitos

- [ ] Site offline (domínios removidos) ✅
- [ ] Toggle "Improve models with this project's data" desligado ✅
- [ ] Este runbook aberto ao lado do browser

---

## TIER 0 — IMEDIATO (próximos 30 minutos)

### 0.1 Telegram Bot Token

O atacante com este token pode: enviar mensagens como o bot, ler histórico do grupo, adicionar webhooks.

1. Abre o Telegram → procura **@BotFather**
2. Envia `/mybots` → selecciona `@teraswap_monitor_bot`
3. Clica **API Token** → **Revoke current token**
4. Copia o novo token
5. No Vercel Dashboard → Settings → Environment Variables:
   - Apaga `TELEGRAM_BOT_TOKEN`
   - Cria novo `TELEGRAM_BOT_TOKEN` com o novo valor
   - **MARCA COMO "Sensitive"** (toggle na criação)
   - Aplica a: Production + Preview
6. Verifica que o webhook antigo ficou inválido (o bot não responde até redeploy)

- [ ] TELEGRAM_BOT_TOKEN rotacionado
- [ ] Marcado como Sensitive

### 0.2 Supabase Service Role Key

Este token bypassa Row Level Security — acesso total à base de dados.

1. Abre **Supabase Dashboard** → selecciona o projecto TeraSwap
2. Vai a **Settings → API**
3. Na secção "Service Role Key", clica **Generate new key** (ou **Regenerate**)
4. ⚠️ A key antiga é invalidada imediatamente
5. Copia a nova key
6. No Vercel Dashboard → Environment Variables:
   - Apaga `SUPABASE_SERVICE_ROLE_KEY`
   - Cria novo com a nova key
   - **MARCA COMO "Sensitive"**
   - Aplica a: Production only
7. Verifica também se tens esta key noutro sítio (scripts locais, etc.)

- [ ] SUPABASE_SERVICE_ROLE_KEY rotacionado
- [ ] Marcado como Sensitive

---

## TIER 1 — HOJE (próximas 2-4 horas)

### 1.1 MONITOR_SECRET

Usado para: autenticação da admin API (kill-switch, heartbeat).

1. Gera novo valor:
   ```bash
   openssl rand -hex 32
   ```
2. No Vercel → Environment Variables:
   - Apaga `MONITOR_SECRET`
   - Cria novo com o valor gerado
   - **MARCA COMO "Sensitive"**
   - Aplica a: Production + Preview
3. Se o Cloudflare Worker usa este secret, actualiza lá também:
   ```bash
   # No directório do worker
   wrangler secret put MONITOR_SECRET
   # Cola o novo valor quando pedido
   ```

- [ ] MONITOR_SECRET rotacionado
- [ ] Marcado como Sensitive
- [ ] Cloudflare Worker actualizado (se aplicável)

### 1.2 MONITOR_CRON_SECRET

Usado para: autenticação do endpoint `/api/monitor/tick` (Cloudflare Worker → Vercel).

1. Gera novo valor:
   ```bash
   openssl rand -hex 32
   ```
2. No Vercel → Environment Variables:
   - Apaga `MONITOR_CRON_SECRET`
   - Cria novo com o valor gerado
   - **MARCA COMO "Sensitive"**
   - Aplica a: Production + Preview
3. **OBRIGATÓRIO:** actualiza o Cloudflare Worker com o mesmo valor:
   ```bash
   wrangler secret put CRON_SECRET
   # Cola o novo valor (deve ser idêntico ao MONITOR_CRON_SECRET)
   ```

- [ ] MONITOR_CRON_SECRET rotacionado
- [ ] Marcado como Sensitive
- [ ] Cloudflare Worker actualizado

### 1.3 TELEGRAM_WEBHOOK_SECRET

Usado para: verificar que os webhooks do Telegram são legítimos.

1. Gera novo valor:
   ```bash
   openssl rand -hex 32
   ```
2. No Vercel → Environment Variables:
   - Apaga `TELEGRAM_WEBHOOK_SECRET`
   - Cria novo com o valor gerado
   - **MARCA COMO "Sensitive"**
3. Após redeploy, o webhook do Telegram precisa ser re-registado com o novo secret (o código deve tratar disto automaticamente no boot, verifica)

- [ ] TELEGRAM_WEBHOOK_SECRET rotacionado
- [ ] Marcado como Sensitive

### 1.4 TELEGRAM_ADMIN_IDS e TELEGRAM_CHAT_ID

Não são secrets per se (são IDs numéricos), mas devem ser marcados como sensitive para não expor quem são os admins.

1. No Vercel → Environment Variables:
   - NÃO precisas mudar os valores
   - **Re-cria ambos MARCADOS COMO "Sensitive"**

- [ ] TELEGRAM_ADMIN_IDS marcado como Sensitive
- [ ] TELEGRAM_CHAT_ID marcado como Sensitive

---

## TIER 2 — ESTA SEMANA (antes de voltar a pôr live)

### 2.1 NEXT_PUBLIC_1INCH_API_KEY

1. Vai a **https://portal.1inch.dev/** → Settings → API Keys
2. Revoga a key actual e gera uma nova
3. Actualiza no Vercel (marca como Sensitive — mesmo sendo NEXT_PUBLIC, o Vercel protege o valor at-rest)

- [ ] 1inch API key rotacionada

### 2.2 NEXT_PUBLIC_0X_API_KEY

1. Vai a **https://dashboard.0x.org/** → API Keys
2. Revoga a key actual e gera uma nova
3. Actualiza no Vercel

- [ ] 0x API key rotacionada

### 2.3 NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID

1. Vai a **https://cloud.walletconnect.com/** → Settings
2. Cria novo Project ID (ou regenera)
3. Actualiza no Vercel

- [ ] WalletConnect Project ID rotacionado

### 2.4 RPC URLs

1. Vai ao teu provider (Alchemy / Infura / outro):
   - Cria novas API keys
   - Actualiza `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_FALLBACK_RPC_1`, `NEXT_PUBLIC_FALLBACK_RPC_2`
2. Apaga as keys antigas no provider após confirmar que as novas funcionam

- [ ] RPC URLs rotacionados (3 keys)

### 2.5 SUPABASE_URL

URL pública por design (contém o project ref). Não precisa de rotação, mas marca como Sensitive no Vercel.

- [ ] SUPABASE_URL marcado como Sensitive

---

## TIER 3 — NÃO PRECISA ROTAÇÃO (mas marcar como Sensitive)

| Variable | Acção |
|---|---|
| NEXT_PUBLIC_SENTRY_DSN | Re-criar marcado como Sensitive |
| NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS | Endereço público, sem acção |
| NEXT_PUBLIC_FEE_COLLECTOR | Endereço público, sem acção |
| NEXT_PUBLIC_FEE_RECIPIENT | Endereço público, sem acção |
| NEXT_PUBLIC_FEE_PERCENT | Config pública, sem acção |

---

## Verificações pós-rotação

### GitHub Audit

- [ ] Vai a **github.com/[org]/[repo]/settings → Security** e verifica:
  - Nenhum deploy key novo adicionado desde 1 Abril
  - Nenhum webhook novo ou modificado
  - Nenhum collaborator adicionado
- [ ] Verifica GitHub Actions: nenhuma run inesperada desde 1 Abril
- [ ] Verifica `package.json` scripts (postinstall, prepare) — sem alterações maliciosas
- [ ] Verifica `package-lock.json` — diff contra último commit known-good
- [ ] Verifica `vercel.json` — sem rewrites/redirects maliciosos
- [ ] Verifica `next.config.js` — sem exfiltração

### Vercel Audit

- [ ] Vai a Vercel Dashboard → **Activity Log** e procura:
  - Deployments que não reconheces
  - Alterações a env vars que não fizeste
  - Novos team members ou access tokens
- [ ] Verifica Vercel integrations — remove qualquer que não reconheças
- [ ] Deployment Protection → activa "Standard" no mínimo

### Supabase Audit

- [ ] Verifica Supabase → **Database → Logs**:
  - Queries incomuns desde 1 Abril
  - Conexões de IPs desconhecidos
- [ ] Verifica se existem novos utilizadores ou roles na DB

---

## Voltar a pôr LIVE

Só após completar TODOS os passos acima:

1. **Verifica que TODAS as env vars têm o flag "Sensitive"** (excepto as que são genuinamente públicas como endereços de contratos)
2. No Vercel → Settings → Domains → **Add Existing**:
   - Adiciona `teraswap.app`
   - Adiciona `teraswap-seven.vercel.app` (ou faz um novo deployment que gera novo subdomain)
3. **Força redeploy** para que o novo build use as novas env vars:
   ```
   Vercel Dashboard → Deployments → último deployment → ⋯ → Redeploy
   ```
4. **Testa:**
   - [ ] Frontend carrega correctamente
   - [ ] `/status` page mostra dados
   - [ ] Telegram bot responde a `/status`
   - [ ] Cloudflare Worker tick chega ao `/api/monitor/tick`
   - [ ] Kill-switch funciona com o novo MONITOR_SECRET
   - [ ] Swap flow funciona end-to-end (testnet ou small amount)
5. **Comunica nos canais** (Telegram group) que o serviço está restabelecido

---

## Hardening permanente

- [ ] Todas as novas env vars criadas com flag "Sensitive" por defeito
- [ ] Vercel GitHub App: restringir a apenas o repo necessário
- [ ] Rotação trimestral de secrets agendada (ver OPS-HYGIENE-REVIEW.md)
- [ ] Considerar migrar secrets para um secret manager externo (Infisical, Doppler) — avaliação futura
