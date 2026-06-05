# TeraSwap — Runbooks Operacionais

**Versão:** 1.0
**Data:** 3 de Abril de 2026
**Autor:** Arquitecto Principal

---

## ÍNDICE

1. Executor Parado / Crash
2. Supabase Indisponível
3. Gas Spike (>100 gwei)
4. API Key Revogada (1inch / 0x)
5. Rate Limiting KV Indisponível
6. Circuit Breaker — Source Permanentemente Aberta
7. Alerta Telegram Não Chega
8. Deploy de Novo Agregador (Novo Selector)
9. Rotação de Secrets
10. Verificação de Saúde Geral

---

## 1. EXECUTOR PARADO / CRASH

**Sintomas:**
- Alerta Telegram: "executor stalled" (last cycle > 120s)
- Alerta Telegram: 3+ consecutive errors
- Ordens pendentes acumulam-se no Supabase sem execução
- `/api/health` mostra executor status offline

**Diagnóstico:**

```bash
# 1. Verificar estado do PM2
pm2 status

# 2. Se o processo não existe ou está "stopped"
pm2 logs teraswap-executor --lines 50

# 3. Verificar se é erro de config (ex: plaintext key em mainnet)
# Procurar: "FATAL: plaintext EXECUTOR_PRIVATE_KEY is not allowed"

# 4. Verificar se é erro de memória
pm2 monit
```

**Resolução:**

```bash
# Cenário A: Crash simples — reiniciar
pm2 restart teraswap-executor

# Cenário B: Não reinicia — verificar logs
pm2 logs teraswap-executor --err --lines 100

# Cenário C: Fora de memória (>256MB)
pm2 restart teraswap-executor
# Se recorrente: investigar memory leak nos logs

# Cenário D: Chave KMS/Vault inacessível
# Verificar conectividade ao provider de secrets
# Verificar que as env vars KMS_KEY_ID ou VAULT_ADDR estão correctas
```

**Verificação pós-resolução:**
```bash
pm2 status                          # Status: online
curl http://localhost:9090/metrics  # Verificar ciclos a incrementar
```

**Impacto:** Ordens Limit/SL/TP/DCA não executam. Instant swaps NÃO são afectados.

---

## 2. SUPABASE INDISPONÍVEL

**Sintomas:**
- Executor falha ao buscar ordens pendentes (log: "Supabase fetch failed")
- Frontend não mostra ordens no dashboard
- `/api/health` com token mostra Supabase connection failed
- `/api/orders` retorna 500

**Diagnóstico:**

```bash
# 1. Verificar status do Supabase
curl https://your-project.supabase.co/rest/v1/ \
  -H "apikey: ${SUPABASE_ANON_KEY}"
# Se timeout ou 5xx: Supabase está em baixo

# 2. Verificar status page oficial
# https://status.supabase.com
```

**Resolução:**

Se Supabase está em baixo globalmente: **esperar**. Não há fallback.

Se é um problema de credenciais:
1. Verificar `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` nas env vars do Vercel
2. Verificar `SUPABASE_URL` nas env vars do executor
3. Regenerar service role key no Supabase Dashboard → Settings → API se comprometida

**Verificação pós-resolução:**
```bash
# Health check com autenticação
curl "https://teraswap.app/api/health?token=YOUR_HEALTH_TOKEN"
# Deve retornar status de Supabase como "ok"
```

**Impacto:** Order engine parado. Analytics não registam. Instant swaps continuam a funcionar (não dependem de Supabase para execução).

---

## 3. GAS SPIKE (>100 GWEI)

**Sintomas:**
- Executor log: "Gas price too high: XXX gwei > 100 gwei, skipping cycle"
- Ordens acumulam-se como "active" sem executar
- Nenhum alerta Telegram (este é comportamento esperado, não um erro)

**Diagnóstico:**

```bash
# Verificar gas price actual
curl -s https://api.etherscan.io/api\?module=gastracker\&action=gasoracle
```

**Resolução:**

**Cenário A: Spike temporário (minutos a horas)**
Esperar. O executor retoma automaticamente quando gas < 100 gwei.

**Cenário B: Gas elevado prolongado (>24h) com ordens SL urgentes**
Avaliação de risco: se utilizadores têm Stop-Loss que precisam de executar:

1. Aumentar temporariamente o cap:
```bash
# No .env.executor
MAX_GAS_PRICE_GWEI=200
```
2. Reiniciar executor: `pm2 restart teraswap-executor`
3. Monitorizar execuções e gas cost
4. Reverter para 100 gwei quando gas normalizar

**Impacto:** Ordens condicionais não executam durante o spike. Stop-Loss pode não proteger o utilizador em crash de mercado com gas alto. Esta limitação está documentada na UI.

---

## 4. API KEY REVOGADA (1INCH / 0X)

**Sintomas:**
- Quotes do 1inch ou 0x retornam 401/403
- Circuit breaker abre para essa source após 3 falhas
- Log: `[circuit-breaker] 1inch: CLOSED → OPEN`
- Meta-quote continua com 10 fontes (degradação graceful)

**Diagnóstico:**

```bash
# Testar API key manualmente
# 1inch
curl -H "Authorization: Bearer ${ONEINCH_API_KEY}" \
  "https://api.1inch.dev/swap/v6.0/1/quote?src=0xEeee...&dst=0xA0b8...&amount=1000000000000000000"

# 0x
curl -H "0x-api-key: YOUR_0X_KEY" \
  "https://api.0x.org/swap/permit2/quote?..."
```

**Resolução:**

1. Gerar nova API key no portal do provider:
   - 1inch: https://portal.1inch.dev
   - 0x: https://dashboard.0x.org
2. Actualizar no Vercel: Settings → Environment Variables → editar `ONEINCH_API_KEY` ou `ZEROX_API_KEY`
3. Redeploy: `vercel --prod` ou trigger via push
4. Circuit breaker recupera automaticamente após cooldown (60s)

**Impacto:** Perda de 1 fonte de liquidez até resolução. Sistema continua operacional com fontes restantes.

---

## 5. RATE LIMITING KV INDISPONÍVEL

**Sintomas:**
- Log: `[RATE-LIMIT] KV unavailable, allowing request: <error>`
- Rate limiting efectivamente desligado (fail-open)
- Possível aumento de carga nas API routes

**Diagnóstico:**

1. Verificar Vercel Dashboard → Storage → KV → status
2. Verificar env vars: `KV_REST_API_URL` e `KV_REST_API_TOKEN` presentes e correctas

**Resolução:**

Se KV está em baixo (Vercel outage): **esperar**. O fail-open garante que o serviço continua funcional.

Se é um problema de config:
1. Verificar que o KV store existe no Vercel Dashboard
2. Regenerar token se expirou
3. Actualizar env vars e redeploy

**Recomendação:** Ligar o log `[RATE-LIMIT] KV unavailable` ao alerta Telegram para visibilidade (não implementado no Sprint actual — registar como melhoria).

**Impacto:** Sem rate limiting durante outage do KV. Risco de abuse mas não de perda de fundos.

---

## 6. CIRCUIT BREAKER — SOURCE PERMANENTEMENTE ABERTA

**Sintomas:**
- Uma source (ex: Odos, KyberSwap) está permanentemente em OPEN
- Log repetido: `[circuit-breaker] odos: HALF_OPEN → OPEN` (teste falha repetidamente)
- Quote results com 1-2 fontes menos que o normal

**Diagnóstico:**

1. Verificar se o API do agregador está realmente em baixo (testar URL manualmente)
2. Verificar se a API mudou endpoints ou requer novo API key
3. Verificar se o adapter tem bug (após refactor)

**Resolução:**

**Se o API está em baixo:** Esperar. O circuit breaker recupera automaticamente quando o API responder.

**Se o API mudou:** Actualizar o adapter em `src/lib/adapters/<source>.ts` e redeploy.

**Se precisa de reset manual:** Redeploy da aplicação reseta todos os circuit breakers (in-memory state).

**Impacto:** Perda temporária de 1 fonte de liquidez. Sem impacto em fundos.

---

## 7. ALERTA TELEGRAM NÃO CHEGA

**Sintomas:**
- Executor tem erros nos logs mas sem mensagem no Telegram
- Heartbeat de 6h não chega

**Diagnóstico:**

```bash
# Testar bot manualmente
curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getMe"
# Deve retornar info do bot

# Testar envio
curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage" \
  -d "chat_id=<TELEGRAM_CHAT_ID>&text=Test"
```

**Resolução:**

1. Verificar `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` nas env vars do executor
2. Verificar que o bot está adicionado ao grupo/chat correcto
3. Verificar que o bot tem permissão para enviar mensagens
4. Se o bot foi revogado: criar novo bot via @BotFather e actualizar token

**Impacto:** Sem alerting. O executor continua a funcionar mas falhas passam despercebidas. Verificar logs manualmente até resolver.

---

## 8. DEPLOY DE NOVO AGREGADOR (NOVO SELECTOR)

**Contexto:** Ao adicionar um novo DEX (ex: Bebop, Hashflow), os function selectors do novo router precisam de ser adicionados à whitelist partilhada. Caso contrário, swaps são bloqueados pelo server-side selector validation [SC-04].

**Procedimento:**

1. Identificar os function selectors do novo router (da documentação do DEX ou do contract ABI)
2. Adicionar ao `src/lib/swap-selectors.ts`:
   ```typescript
   '0xNEWSEL1', // NewDEX - swap
   '0xNEWSEL2', // NewDEX - multiSwap
   ```
3. Criar o adapter em `src/lib/adapters/newdex.ts` implementando `DEXAdapter`
4. Registar no `ADAPTER_REGISTRY` em `src/lib/adapters/index.ts`
5. Se o DEX usa um router diferente no FeeCollector: adicionar à whitelist do contrato (requer timelock 48h)
6. Testar em mainnet fork: `npm run fork`
7. Deploy via PR → CI passa → merge

**Verificação:** Fazer quote com o novo DEX como fonte → confirmar que aparece nos resultados.

---

## 9. ROTAÇÃO DE SECRETS

**Quando rodar:** Após suspeita de compromisso, quando um membro da equipa sai, ou como manutenção periódica (trimestral).

**Secrets a rodar e onde:**

| Secret | Onde está | Como rodar |
|--------|----------|-----------|
| `ONEINCH_API_KEY` | Vercel env vars | Gerar nova em portal.1inch.dev → actualizar no Vercel → redeploy |
| `ZEROX_API_KEY` | Vercel env vars | Gerar nova em dashboard.0x.org → actualizar no Vercel → redeploy |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env vars + executor env | Regenerar no Supabase Dashboard → Settings → API → actualizar em AMBOS os locais → redeploy ambos |
| `SUPABASE_ANON_KEY` | Vercel env vars (NEXT_PUBLIC) | Regenerar no Supabase Dashboard → actualizar → redeploy |
| `KV_REST_API_TOKEN` | Vercel env vars | Regenerar no Vercel Storage → actualizar → redeploy |
| `HEALTH_TOKEN` | Vercel env vars | Gerar novo valor aleatório → actualizar → redeploy |
| `TELEGRAM_BOT_TOKEN` | Executor env | Revogar bot antigo via @BotFather → criar novo → actualizar → restart executor |
| `WALLETCONNECT_PROJECT_ID` | Vercel env vars (NEXT_PUBLIC) | Gerar novo em cloud.walletconnect.com → actualizar → redeploy |
| Executor signing key (KMS/Vault) | KMS ou Vault | Seguir procedimento do provider. Se KMS: rodar key via AWS Console. Se Vault: rodar secret. |

**Ordem recomendada:** Supabase keys primeiro (afecta mais subsistemas), depois API keys, depois tokens auxiliares.

**Verificação:** Após cada rotação, correr health check e fazer um swap de teste.

---

## 10. VERIFICAÇÃO DE SAÚDE GERAL

**Checklist diária (ou pós-deploy):**

```bash
# 1. Health endpoint
curl "https://teraswap.app/api/health?token=YOUR_TOKEN"
# Esperar: todos os subsistemas "ok"

# 2. Quote funcional
curl "https://teraswap.app/api/quote?src=0xEeee...&dst=0xA0b8...&amount=1000000000000000000&srcDecimals=18&dstDecimals=6"
# Esperar: pelo menos 5 fontes com cotações

# 3. Executor (se activo)
curl http://executor-host:9090/metrics
# Verificar: teraswap_executor_consecutive_errors = 0
# Verificar: teraswap_executor_last_cycle_duration_ms < 30000

# 4. Vercel KV
# Fazer 31 requests em 60s ao /api/quote → 31º deve retornar 429

# 5. CI/CD
# Verificar GitHub Actions → último run verde

# 6. Dependabot
# Verificar GitHub → Security → Dependabot alerts → zero high/critical
```

---

## CONTACTOS DE ESCALAÇÃO

| Nível | Quem | Quando |
|-------|------|--------|
| L1 | Alerta Telegram automático | Erros consecutivos, executor stalled |
| L2 | TeraHash (Arquitecto/Founder) | Qualquer bloqueio que o L1 automático não resolve |
| L3 | Suporte Supabase / Vercel / 1inch | Outages de providers externos |

---

*Última actualização: 3 de Abril de 2026*
*Próxima revisão: após activação do executor em mainnet (Sprint 3)*
