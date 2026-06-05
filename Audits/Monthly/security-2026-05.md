# TeraSwap Monthly Security Report — Maio 2026

**Overall Status:** 🟡  
**Checks Performed:** 7/7  
**Data:** 2026-05-01  
**Executado por:** Auditor Automatizado (Scheduled Task)

---

## Automated Results

### 1. Typo-Domains / Phishing Detection

| Domínio | Status | IPs |
|---------|--------|-----|
| teraswap.io | ⚠️ RESOLVE | 54.149.79.189, 34.216.117.25 |
| tera-swap.app | ✅ Sem DNS | — |
| teraswap.xyz | ⚠️ RESOLVE | 76.223.54.146, 13.248.169.48 |
| teraswap.net | ✅ Sem DNS | — |
| teraswap.org | ✅ Sem DNS | — |
| teraswap.finance | ✅ Sem DNS | — |
| terraswap.app | ⚠️ RESOLVE | 15.197.148.33, 3.33.130.190 |
| terasswap.app | ✅ Sem DNS | — |
| teraswap.com | ⚠️ RESOLVE | 13.248.169.48, 76.223.54.146 |
| teraswap.exchange | ✅ Sem DNS | — |

**Análise:**
- **teraswap.io** — Resolve para AWS (us-west-2). Necessita investigação manual para verificar se é um site legítimo ou clone.
- **teraswap.xyz** — Mesmo IP que teraswap.com (Global Accelerator). Provavelmente o mesmo operador.
- **terraswap.app** — Note o duplo "r". Resolve para AWS Global Accelerator. Pode ser o projeto Terra/LUNA legacy (TerraSwap DEX) e não um clone nosso, mas deve ser verificado.
- **teraswap.com** — Resolve para AWS Global Accelerator. Necessita investigação.

**Action needed:** Sim — investigar teraswap.io, teraswap.xyz e teraswap.com manualmente. Verificar se apresentam conteúdo que imita TeraSwap.app.

---

### 2. Security Headers

| Header | Presente | Valor |
|--------|----------|-------|
| Content-Security-Policy | ❌ | Não presente na resposta |
| Strict-Transport-Security | ✅ | `max-age=15552000; includeSubDomains; preload` |
| X-Frame-Options | ❌ | Não presente na resposta |
| X-Content-Type-Options | ✅ | `nosniff` |

**Análise:**
- **CSP ausente na resposta HTTP** — o header Content-Security-Policy não foi retornado pelo servidor. Pode estar configurado via `<meta>` tag no HTML ou pode ter sido removido. **Verificar configuração no `next.config.js` e confirmar que está a ser emitido em produção.** Severidade: MEDIUM.
- **X-Frame-Options ausente** — Sem proteção contra clickjacking via header HTTP. Pode estar coberto pelo CSP `frame-ancestors` se este existir no HTML. **Verificar.** Severidade: MEDIUM.
- **HSTS** — Presente e bem configurado com `preload` e `includeSubDomains`. ✅
- **X-Content-Type-Options** — Presente com `nosniff`. ✅

---

### 3. SSL Certificate

| Campo | Valor |
|-------|-------|
| Subject | CN = teraswap.app |
| Issuer | Let's Encrypt E7 |
| Expira | 14 Jul 2026 (73 dias restantes) |
| Serial | 051054DD2F818788472FC69E1838E1CB965C |

**Status:** ✅ Certificado válido com margem confortável. Let's Encrypt renova automaticamente aos 30 dias.

---

### 4. Secrets Scan

**Source code (src/):**
- ✅ **Sem secrets hardcoded.** Todas as 30 correspondências são referências a `process.env.*` (padrão correto) ou texto legal em `LegalPage.tsx` que menciona "private keys" no contexto de user education.
- ✅ **Sem chaves privadas Ethereum.** Os 6 matches são zero-hashes (`0x0000...0000`) usados como valores default para `routerDataHash` e `appDataHash` — padrão seguro.
- ✅ **Sem API keys** em formatos sk-, AKIA, ghp_ encontrados.

**Ficheiro .env (local, NÃO tracked):**
- ⚠️ **Contém secrets reais:** `DEPLOYER_PRIVATE_KEY` (parcial), `RPC_URL` com API key Alchemy, `MONITOR_SECRET`. O ficheiro está correctamente excluído do git (18 entradas no .gitignore), mas **os valores reais estão no disco local.**
- ⚠️ **`.env.local` contém credenciais Upstash Redis** (KV_REST_API_TOKEN, KV_URL), API keys (0x), e tokens (HEALTH_TOKEN, MONITOR_CRON_SECRET). Também excluído do git.
- ✅ **`.env.production` contém apenas placeholders** — valores sensíveis estão vazios. Seguro.

**Git history:**
- ✅ **Nenhum ficheiro `.env` com secrets foi commitado.** Apenas `.env.example` e `.env.executor.example` estão tracked — ambos são templates sem valores reais.

---

### 5. .env File Audit

| Verificação | Resultado |
|-------------|-----------|
| .env no .gitignore | ✅ 18 entradas cobrindo todas as variações |
| .env tracked no git | ✅ Não — apenas .env.example tracked |
| .env.local tracked | ✅ Não |
| .env.production tracked | ✅ Não |
| Secrets reais em disco | ⚠️ Sim (.env e .env.local contêm valores reais) |

**Nota:** Ter secrets em ficheiros locais é prática normal para desenvolvimento, desde que estejam gitignored. A configuração actual está correcta.

---

### 6. Git History — env Files

| Commit | Ficheiro | Conteúdo |
|--------|----------|----------|
| bdb8042 (v1.0 initial) | .env.example | Template sem valores |
| eee33fc (v2 deploy) | .env.example | Template actualizado |
| c22794c (DCA fix) | — | Sem alterações .env |

**Status:** ✅ Nenhum secret commitado no histórico git. O `.env.save` mencionado em registos anteriores não aparece no histórico actual — pode ter sido removido via `git filter-branch` ou `BFG`.

---

### 7. Supabase / Infrastructure

| Endpoint | Status |
|----------|--------|
| `GET /api/health` | ✅ HTTP 200 |
| Response | `{"status":"OK","timestamp":"2026-05-01T09:06:29.488Z"}` |
| Diagnostics | Disponível com `?token=HEALTH_TOKEN` |

**Status:** ✅ API operacional. Supabase connectivity inferida do status OK.

---

## Resumo de Findings

| # | Severidade | Finding | Acção |
|---|-----------|---------|-------|
| MSR-2026-05-01 | MEDIUM | CSP header não presente na resposta HTTP | Verificar next.config.js e confirmar emissão em produção |
| MSR-2026-05-02 | MEDIUM | X-Frame-Options ausente na resposta HTTP | Verificar se frame-ancestors está no CSP ou adicionar header |
| MSR-2026-05-03 | LOW | 4 typo-domains resolvem DNS | Investigar manualmente se apresentam conteúdo clone |

---

## Manual Checklist (Arquitecto deve executar)

- [ ] Verificar CSP — abrir teraswap.app no browser → DevTools → Network → verificar se CSP está presente no response header ou como `<meta>` tag
- [ ] Investigar typo-domains — visitar teraswap.io, teraswap.xyz, teraswap.com no browser e verificar conteúdo
- [ ] Rodar HEALTH_TOKEN → confirmar nos Vercel env vars + executor .env.executor
- [ ] Rever acessos da equipa Vercel → vercel.com/dashboard → Settings → Members
- [ ] Testar hardware wallet → assinar tx de teste com admin wallet
- [ ] Verificar que consegue fazer pause do FeeCollector em < 5 min
- [ ] Rever Supabase RLS policies manualmente (supabase.com/dashboard → SQL Editor)
- [ ] Verificar npm audit → `npm audit` no projecto (último relatório: 1H/13M)
- [ ] Confirmar rotação de secrets desde o incidente Vercel (ref: memory RESOLVED 2026-04-21)

---

## Links Rápidos

- Vercel: vercel.com/dashboard
- Supabase: supabase.com/dashboard
- Alchemy: dashboard.alchemy.com
- Etherscan FeeCollector: etherscan.io/address/0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD
- Etherscan OrderExecutor: etherscan.io/address/0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130

---

*Relatório gerado automaticamente em 2026-05-01. Próximo scan: 2026-06-01.*
