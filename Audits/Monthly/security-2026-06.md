# TeraSwap Monthly Security Report — Junho 2026

**Data de execução:** 2026-06-01 (run automático agendado)
**Overall Status:** 🟡
**Checks Performed:** 7/7

> Resumo executivo: a superfície pública (headers, TLS, código-fonte, histórico git) está limpa. Há **dois pontos a tratar**: (1) o ficheiro local `.env` na raiz do repositório contém **segredos reais de produção** (chave privada do deployer, chave Alchemy, MONITOR_SECRET) — não está em git e tem permissões `0600`, mas é material vivo em texto simples na workstation; (2) **4 typo-domains resolvem** e devem ser investigados quanto a clones/phishing.

---

## Automated Results

### 🌐 Typo-Domains

| Domínio | Estado | Resolve para |
|---------|--------|--------------|
| teraswap.io | ⚠️ RESOLVE | 34.216.117.25, 54.149.79.189 |
| tera-swap.app | ✅ Seguro | sem DNS |
| teraswap.xyz | ⚠️ RESOLVE | 160.251.64.80 |
| teraswap.net | ✅ Seguro | sem DNS |
| teraswap.org | ✅ Seguro | sem DNS |
| teraswap.finance | ✅ Seguro | sem DNS |
| terraswap.app | ⚠️ RESOLVE | 3.33.130.190, 15.197.148.33 |
| terasswap.app | ✅ Seguro | sem DNS |
| teraswap.com | ⚠️ RESOLVE | 76.223.54.146, 13.248.169.48 |
| teraswap.exchange | ✅ Seguro | sem DNS |

**Action needed:** Sim — investigar 4 domínios: `teraswap.io`, `teraswap.xyz`, `terraswap.app`, `teraswap.com`. Confirmar se algum serve um clone de phishing do frontend ou drainer de wallets. `terraswap.app` aponta para IPs AWS/Fastly (3.33.130.190 / 15.197.148.33) e `teraswap.com` para IPs AWS Global Accelerator — verificar conteúdo servido e, se hostil, acionar takedown. (Nota: `terraswap` é também o nome de um projeto Terra/Cosmos legítimo e não relacionado — confirmar antes de classificar como malicioso.)

### 🔒 Security Headers

O apex `teraswap.app` faz **307 redirect → `www.teraswap.app`**; os headers de segurança completos são servidos no destino `www`. Valores verificados em `https://www.teraswap.app/`:

| Header | Present | Value |
|--------|---------|-------|
| Content-Security-Policy | ✅ | `default-src 'self'`; sem wildcard `*` em `script-src`/`default-src`; `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, allowlist explícita em `connect-src` |
| Strict-Transport-Security | ✅ | `max-age=15552000; includeSubDomains; preload` |
| X-Frame-Options | ✅ | `DENY` |
| X-Content-Type-Options | ✅ | `nosniff` |
| Referrer-Policy | ✅ | `strict-origin-when-cross-origin` |
| Permissions-Policy | ✅ | `camera=(), microphone=(), geolocation=(), interest-cohort=()` |

**Notas (informativo, sem ação urgente):**
- `script-src` inclui `'unsafe-inline'` — sem wildcard, mas idealmente migrar para nonces/hashes numa hardening futura.
- A resposta 307 do apex não carrega CSP/X-Frame-Options (só HSTS + X-Content-Type-Options). Aceitável porque é apenas um redirect sem corpo HTML renderizável, mas pode adicionar-se CSP também ao redirect por defesa em profundidade.

### 📜 SSL Certificate

- **Subject:** CN = teraswap.app
- **Issuer:** Let's Encrypt (C=US, O=Let's Encrypt, CN=E7)
- **Expira:** 14 Jul 2026 07:15:32 GMT (**~43 dias restantes**)
- **Serial:** 051054DD2F818788472FC69E1838E1CB965C
- **Status:** ✅ (> 30 dias; renovação Let's Encrypt deve ser automática — confirmar que o auto-renew está ativo)

### 🔑 Secrets Scan

- **Código-fonte:** ✅ Limpo. Todos os matches em `src/` são referências a `process.env.*`, comentários de auditoria, texto legal ("private keys never leave your device") ou constantes de teste / zero-hashes (`0x0000…`, `TRANSFER_TOPIC`). Nenhum segredo hardcoded. Padrões de chave API (sk-/AKIA/ghp_) e chaves privadas ETH (64-hex reais): 0 ocorrências.
- **Ficheiro `.env`:** ⚠️ **Contém valores REAIS de produção, não apenas placeholders.** Detetadas as seguintes chaves sensíveis (valores mascarados neste relatório):
  - `DEPLOYER_PRIVATE_KEY=57d868…` — **chave privada do deployer em texto simples**
  - `RPC_URL=https://eth-mainnet.g.alchemy.com/v2/7G3nJd…` — chave Alchemy embutida
  - `MONITOR_SECRET=9f05c3…` — segredo de monitorização (64-hex)
  - (também `FEE_RECIPIENT`, `ADMIN_ADDRESS`, `EXECUTOR_ADDRESS`, `NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS` — endereços públicos on-chain, não sensíveis)
- **Histórico git:** ✅ Sem segredos commitados. Ficheiros `*.env*` alguma vez adicionados: `.env.example`, `contracts/order-engine/executor/.env.executor.example` (exemplos) e `contracts/order-engine/.env.save` (blob vazio `e69de29` — conhecido e aceitável). O `.env` real **não está em git** (`git check-ignore` confirma; `git ls-files` não o encontra) e tem permissões `-rw------- (0600)`.

**Avaliação do `.env`:** o risco está contido (gitignored + 0600, nunca commitado), mas manter a **chave privada do deployer e a chave Alchemy em texto simples** na workstation é um risco de exfiltração local. Recomendação: mover material crítico para hardware wallet / gestor de segredos e remover do `.env` em disco; se houver qualquer suspeita de exposição, **rodar a chave Alchemy e o MONITOR_SECRET** e transferir ownership/roles do deployer.

### 🗄️ Supabase / Infrastructure

- **API connectivity:** ✅ `https://teraswap.app/api/health` → 307 → `https://www.teraswap.app/api/health` → **HTTP 200**. Conectividade da API confirmada; estado da DB inferido a partir do health da API (o endpoint respondeu OK).

---

## Resumo de Findings

| # | Severidade | Finding | Ação |
|---|-----------|---------|------|
| 1 | 🟡 Médio | `.env` local contém segredos reais de produção (deployer key, Alchemy key, MONITOR_SECRET) em texto simples | Mover para gestor de segredos / hardware wallet; rodar se houver suspeita |
| 2 | 🟡 Médio | 4 typo-domains resolvem (`teraswap.io`, `.xyz`, `terraswap.app`, `teraswap.com`) | Investigar conteúdo servido; takedown se clone/phishing |
| 3 | 🔵 Info | CSP usa `'unsafe-inline'` em `script-src`; apex 307 sem CSP | Hardening futuro (nonces/hashes) |
| 4 | 🔵 Info | Cert TLS renova em ~43 dias | Confirmar auto-renew Let's Encrypt |

---

## Manual Checklist (Arquitecto deve executar)

- [ ] Rodar HEALTH_TOKEN → Vercel env vars + executor `.env.executor`
- [ ] Rever acessos da equipa Vercel → vercel.com/dashboard → Settings → Members
- [ ] Testar hardware wallet → assinar tx de teste com admin wallet
- [ ] Verificar que consegue fazer pause do FeeCollector em < 5 min
- [ ] Rever Supabase RLS policies manualmente (supabase.com/dashboard → SQL Editor)
- [ ] **[NOVO]** Investigar typo-domains que resolvem (`teraswap.io`, `teraswap.xyz`, `terraswap.app`, `teraswap.com`) — confirmar se servem clones
- [ ] **[NOVO]** Mover `DEPLOYER_PRIVATE_KEY` / chave Alchemy do `.env` em disco para gestor de segredos; ponderar rotação

## Links Rápidos

- Vercel: vercel.com/dashboard
- Supabase: supabase.com/dashboard
- Alchemy: dashboard.alchemy.com
