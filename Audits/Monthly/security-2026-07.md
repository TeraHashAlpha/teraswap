# TeraSwap Monthly Security Report — Julho 2026

**Overall Status:** 🟡
**Checks Performed:** 7/7
**Data da execução:** 2026-07-01 (automatizado)
**Auditor:** Senior Security Auditor (scheduled task)

> **Resumo executivo:** Superfície web sólida — CSP forte, HSTS com preload, `X-Frame-Options: DENY`, certificado válido, sem segredos hardcoded no código-fonte nem no histórico Git. Dois pontos requerem ação: (1) o ficheiro `.env` local contém **segredos de produção reais em plaintext** (incl. `DEPLOYER_PRIVATE_KEY`) — não está no Git, mas é risco em repouso; (2) **4 typo-domains resolvem** e precisam de investigação de phishing.

---

## Automated Results

### 🌐 Typo-Domains

| Domínio | Estado | Resolve para |
|---|---|---|
| teraswap.io | ⚠️ RESOLVES | 54.149.79.189 / 34.216.117.25 |
| tera-swap.app | ✅ Safe | sem DNS |
| teraswap.xyz | ⚠️ RESOLVES | 172.239.49.232 / .27.233 / .193.67 |
| teraswap.net | ✅ Safe | sem DNS |
| teraswap.org | ✅ Safe | sem DNS |
| teraswap.finance | ✅ Safe | sem DNS |
| terraswap.app | ⚠️ RESOLVES | 15.197.148.33 / 3.33.130.190 |
| terasswap.app | ✅ Safe | sem DNS |
| teraswap.com | ⚠️ RESOLVES | 13.248.169.48 / 76.223.54.146 |
| teraswap.exchange | ✅ Safe | sem DNS |

**Action needed:** ✅ **Sim** — investigar 4 domínios que resolvem:

- **terraswap.app** (15.197.x / 3.33.x = AWS Global Accelerator) — provável projeto legítimo do ecossistema Terra ("Terraswap"), não uma clonagem direcionada. Confirmar que não serve conteúdo que imite a marca TeraSwap.
- **teraswap.com** (13.248.x / 76.223.x = AWS/`awsdns`) — típico de domínio parqueado/registador. Verificar se está à venda; considerar aquisição defensiva.
- **teraswap.io** (54.149.x / 34.216.x = AWS EC2 us-west-2) — **prioridade alta**: IP de instância EC2 pode servir uma app real. Abrir no browser (via ambiente isolado) e confirmar que não é um clone de phishing que capta assinaturas de carteira.
- **teraswap.xyz** (172.239.x = Linode/Akamai) — verificar conteúdo servido; `.xyz` é comum em campanhas de phishing cripto.

> **Nota:** nenhum destes é `teraswap.app` (o domínio oficial). A verificação de conteúdo deve ser feita **sem** interagir com prompts de carteira.

### 🔒 Security Headers

Verificado em **`https://www.teraswap.app/`** (o apex `teraswap.app` faz `308 → www`, e a resposta de redirect só transporta HSTS + `X-Content-Type-Options`; os headers completos aplicam-se na app renderizada em `www`).

| Header | Present | Value |
|---|---|---|
| Content-Security-Policy | ✅ | `default-src 'self'`; sem wildcard `*` em `script-src`/`default-src`; `frame-src 'none'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`. `connect-src` restrito à allowlist de agregadores/RPC. |
| Strict-Transport-Security | ✅ | `max-age=15552000; includeSubDomains; preload` |
| X-Frame-Options | ✅ | `DENY` |
| X-Content-Type-Options | ✅ | `nosniff` |
| Referrer-Policy | ✅ (bónus) | `strict-origin-when-cross-origin` |
| Permissions-Policy | ✅ (bónus) | `camera=(), microphone=(), geolocation=(), interest-cohort=()` |

**Avaliação:** 🟢 Excelente. CSP sem wildcards, `script-src` restrito a `'self' 'unsafe-inline'` (worker-src próprio). Único ponto menor: `'unsafe-inline'` em `script-src`/`style-src` — aceitável para Next.js mas idealmente migrar para nonce/hash a médio prazo.

### 📜 SSL Certificate

- **Issuer:** Let's Encrypt (C=US, O=Let's Encrypt, CN=YE1)
- **Subject:** CN = teraswap.app
- **Serial:** 055EF58E5C118A0C4EC48D5D1ED6C8257751
- **Expires:** Sep 11 2026 06:30 GMT (**71 dias** restantes)
- **Status:** ✅ OK (> 30 dias; renovação automática Let's Encrypt esperada ~Ago 2026)

### 🔑 Secrets Scan

- **Source code (`src/`):** ✅ **Clean** — todas as ocorrências de `secret`/`private key` são referências a `process.env.*` (auth de rotas API: `MONITOR_SECRET`, `KILL_SWITCH_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, etc.), comentários, ou texto legal ("your private keys never leave your device"). Os matches de 64-hex são `ZeroHash` (`0x0000…`), `TRANSFER_TOPIC` (keccak) e constantes de teste — **não** são chaves privadas. Padrões `sk-…`/`AKIA…`/`ghp_…`: 0 ocorrências.
- **Ficheiro `.env` (local):** ⚠️ **Contém valores reais, não placeholders** — ver secção 🗄️ abaixo. **[FINDING M-JUL-01]**
- **Git history:** ✅ **No secrets committed** — os únicos ficheiros `*.env*` alguma vez adicionados são:
  - `.env.example` e `contracts/order-engine/executor/.env.executor.example` — templates (placeholders), atualmente tracked ✅
  - `contracts/order-engine/.env.save` — ficheiro vazio (conhecido/aceite) ✅
  - `scripts/gitleaks-fixtures/positive-PRIVATE_KEY.env.fixture` — fixture de teste com chave falsa, allowlisted (commit 2229673, regra `evm-private-key-keyword-proximity`) ✅
  - `.env` **não está tracked** e está coberto por `.gitignore` (`**/.env`, 18 entradas relacionadas). ✅

### 🗄️ Supabase / Infrastructure

- **API connectivity:** ✅ `GET /api/health` → `HTTP 200` (após `308 → www`), body `{"status":"OK","timestamp":"2026-07-01T09:05:27Z"}`. O endpoint sugere `?token=HEALTH_TOKEN` para diagnóstico detalhado (conectividade DB verificável manualmente com o token). Estado da DB **inferido a partir do health da API** — sem token, sem verificação direta de Supabase.

---

## 🔴 Findings (Julho 2026)

### [M-JUL-01] Segredos de produção em plaintext no `.env` local — MEDIUM

O ficheiro `.env` na raiz do repositório contém valores reais (não placeholders), incluindo:

| Variável | Valor (mascarado) | Risco |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | `57d8687d…514` | 🔴 Chave privada do deployer em plaintext |
| `RPC_URL` | `…/v2/7G3n…SoS` (Alchemy key embutida) | 🟠 Abuso da chave Alchemy → custo (PAYG ~$13/mês) |
| `MONITOR_SECRET` | `79134e2d…fa68` | 🟠 Bypass de auth de rotas de monitor |

- **Mitigação já existente:** o ficheiro está gitignored e **nunca foi commitado** (confirmado no histórico) — não há fuga via Git.
- **Risco residual:** segredos sensíveis em repouso na máquina do Arquiteto. A `DEPLOYER_PRIVATE_KEY` controla deploy de contratos; exposição local (malware, backup, screen-share) é o vetor.
- **Alinhamento com roadmap:** coincide com o plano *Key Hardening* já em memória (mover Admin+Treasury → hardware wallet; keeper fica em KMS). Esta finding reforça a prioridade.
- **Recomendação:**
  1. Migrar `DEPLOYER_PRIVATE_KEY` para hardware wallet / KMS; remover do `.env` em plaintext.
  2. **Rotacionar** a chave Alchemy (`RPC_URL`) e o `MONITOR_SECRET` por precaução, e restringir a chave Alchemy por allowlist de domínio/IP no dashboard.
  3. Confirmar que a `DEPLOYER_PRIVATE_KEY` não tem fundos nem privilégios ativos que não sejam recuperáveis via timelock.

> Valores completos **não** são reproduzidos neste relatório por higiene de segurança (o relatório vive no repo).

---

## Manual Checklist (Arquitecto deve executar)

- [ ] Rodar `HEALTH_TOKEN` → Vercel env vars + executor `.env.executor`
- [ ] **[NOVO — M-JUL-01]** Migrar `DEPLOYER_PRIVATE_KEY` para HW/KMS e rotacionar Alchemy key + `MONITOR_SECRET`
- [ ] **[NOVO]** Investigar typo-domains que resolvem (teraswap.io, .xyz, .com; confirmar terraswap.app) — verificar conteúdo sem interagir com prompts de carteira
- [ ] Rever acessos da equipa Vercel → vercel.com/dashboard → Settings → Members
- [ ] Testar hardware wallet → assinar tx de teste com admin wallet
- [ ] Verificar que consegue fazer pause do FeeCollector em < 5 min
- [ ] Rever Supabase RLS policies manualmente (supabase.com/dashboard → SQL Editor)

## Links Rápidos

- Vercel: vercel.com/dashboard
- Supabase: supabase.com/dashboard
- Alchemy: dashboard.alchemy.com

---

*Gerado automaticamente pela scheduled task `teraswap-monthly-security`. Próxima execução: Agosto 2026. Findings de severidade Medium+ devem ser triados para o backlog conforme convenção RICE.*
