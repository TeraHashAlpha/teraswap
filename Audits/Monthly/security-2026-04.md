# TeraSwap Relatório Mensal de Segurança — Abril 2026

**Estado Geral:** 🟡
**Verificações Executadas:** 7/7
**Data de Execução:** 2026-04-08 (automatizado)

---

## Resultados Automatizados

### 🌐 Typo-Domains / Phishing

| Domínio | Estado | IP(s) |
|---------|--------|-------|
| teraswap.io | ⚠️ RESOLVE | 54.149.79.189, 34.216.117.25 |
| tera-swap.app | ✅ Sem DNS | — |
| teraswap.xyz | ⚠️ RESOLVE | 76.223.54.146, 13.248.169.48 |
| teraswap.net | ✅ Sem DNS | — |
| teraswap.org | ✅ Sem DNS | — |
| teraswap.finance | ✅ Sem DNS | — |
| terraswap.app | ⚠️ RESOLVE | 3.33.130.190, 15.197.148.33 |
| terasswap.app | ✅ Sem DNS | — |
| teraswap.com | ✅ Sem DNS | — |
| teraswap.exchange | ✅ Sem DNS | — |

**Ação necessária:** Sim — 3 domínios a investigar:

- **teraswap.io** — IPs na AWS (us-west-2). Potencial clone de phishing ou domain squatting. Investigar conteúdo.
- **teraswap.xyz** — IPs AWS Global Accelerator. Investigar se é phishing activo.
- **terraswap.app** — Nota: "TerraSwap" é um DEX legítimo do ecossistema Terra/Luna. Provavelmente não é phishing contra o TeraSwap, mas a semelhança de nome pode causar confusão aos utilizadores. Monitorizar.

### 🔒 Security Headers

| Header | Presente | Valor |
|--------|----------|-------|
| Content-Security-Policy | ✅ | Política completa sem wildcards. `script-src 'self' 'unsafe-inline'`; `frame-src 'none'`; `frame-ancestors 'none'`; `object-src 'none'`. `connect-src` restrito a APIs autorizadas. |
| Strict-Transport-Security | ✅ | `max-age=63072000; includeSubDomains; preload` (~2 anos) |
| X-Frame-Options | ✅ | `DENY` |
| X-Content-Type-Options | ✅ | `nosniff` |

**Estado:** ✅ Todos os headers de segurança presentes e correctamente configurados.

**Nota:** `script-src 'unsafe-inline'` é necessário para Next.js mas representa uma superfície de ataque para XSS. Considerar migração para nonces em versão futura.

### 📜 Certificado SSL

- **Emitente:** Let's Encrypt (R12)
- **Domínio:** `*.teraswap.app` (wildcard)
- **Expira:** 5 Julho 2026 (**~88 dias restantes**)
- **Serial:** `0551CFA4F44E18885F95171A6648A8AF0C7E`
- **Estado:** ✅ Certificado válido com margem confortável. Renovação automática esperada via Vercel.

### 🔑 Secrets Scan

**Código-fonte:** ✅ Limpo

- **Padrões comuns:** Todas as referências encontradas são `process.env.*` (variáveis de ambiente), texto legal sobre private keys, ou validação de ambiente. Zero segredos hardcoded.
- **Chaves privadas Ethereum (64 hex):** Apenas zero-hashes (`0x000...000`) usados como placeholders em DCA/limit orders. Sem chaves reais.
- **API keys (sk-, AKIA, ghp_):** ✅ Nenhuma encontrada.
- **Validação proactiva:** O ficheiro `env-validation.ts` detecta e rejeita `NEXT_PUBLIC_*_API_KEY` — defesa contra exposição acidental de API keys no browser bundle.

**Ficheiro .env:** ⚠️ Contém valores reais (esperado para ambiente local)

O `.env` local contém:
- `DEPLOYER_PRIVATE_KEY` — chave privada real (truncada no output)
- `RPC_URL` — endpoint Alchemy com API key
- `MONITOR_SECRET` — secret hex de 64 caracteres
- Endereços de contratos (públicos, não sensíveis)

**Mitigação:** `.env` está no `.gitignore` (18 entradas cobrindo variantes `.env*`). Ficheiro nunca foi committed ao repositório.

**Histórico Git:** ✅ Limpo

- `.env.example` e `.env.executor.example` — ficheiros de template, sem segredos. ✅
- `contracts/order-engine/.env.save` — era ficheiro vazio (blob `e69de29`), removido no commit `d0f83c2` (security hardening). ✅
- `.env` principal — nunca committed. ✅

### 🗄️ Supabase / Infraestrutura

- **API connectivity:** ✅ `GET /api/health` → HTTP 200
- **Estado inferido:** Supabase e backend operacionais.

---

## Resumo de Riscos

| Risco | Severidade | Estado |
|-------|-----------|--------|
| Domínios typo-squatting activos (teraswap.io, teraswap.xyz) | 🟡 Médio | Investigar conteúdo |
| `script-src 'unsafe-inline'` na CSP | 🟡 Baixo-Médio | Aceite (Next.js requirement) |
| `.env` local com segredos reais | 🟢 Baixo | Gitignored, nunca committed |
| Certificado SSL (88 dias) | 🟢 Info | Renovação automática Vercel |

**Decisão de estado geral: 🟡** — Os domínios typo-squatting que resolvem DNS requerem investigação para determinar se representam phishing activo. Restantes controlos estão sólidos.

---

## Manual Checklist (Arquitecto deve executar)

- [ ] Investigar conteúdo de `teraswap.io` e `teraswap.xyz` — verificar se são phishing clones
- [ ] Rodar HEALTH_TOKEN → Vercel env vars + executor .env.executor
- [ ] Rever acessos da equipa Vercel → vercel.com/dashboard → Settings → Members
- [ ] Testar hardware wallet → assinar tx de teste com admin wallet
- [ ] Verificar que consegue fazer pause do FeeCollector em < 5 min
- [ ] Rever Supabase RLS policies manualmente (supabase.com/dashboard → SQL Editor)

---

## Links Rápidos

- **Vercel:** vercel.com/dashboard
- **Supabase:** supabase.com/dashboard
- **Alchemy:** dashboard.alchemy.com
- **Etherscan (FeeCollector):** etherscan.io/address/0x107F6eB7C3866c9cEf5860952066e185e9383ABA
- **Etherscan (OrderExecutor):** etherscan.io/address/0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130

---

*Relatório gerado automaticamente por Claude Senior Security Auditor.*
*Próxima execução: Maio 2026.*
