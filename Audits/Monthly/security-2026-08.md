# TeraSwap Monthly Security Report — Agosto 2026

**Overall Status:** 🟡
**Checks Performed:** 7/7
**Data da execução:** 2026-08-01 (automatizado)
**Auditor:** Senior Security Auditor (scheduled task)

> **Resumo executivo:** Superfície web mantém-se sólida — CSP restritiva sem wildcards, HSTS com `preload`, `X-Frame-Options: DENY`, certificado válido, zero segredos hardcoded no código-fonte e histórico Git limpo. A superfície de typo-domains **melhorou** face a Julho (4 → 3 a resolver; `teraswap.xyz` deixou de resolver e `teraswap.io` passou a domínio parqueado sem TLS). O ponto crítico continua **por resolver**: o ficheiro `.env` local contém segredos de produção reais em plaintext (`DEPLOYER_PRIVATE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, chave Alchemy, `MONITOR_SECRET`) — **M-JUL-01 permanece aberto e é agora reclassificado como HIGH** por ter transitado um ciclo mensal sem remediação.

---

## Automated Results

### 🌐 Typo-Domains

| Domínio | Estado | Resolve para | Δ vs Julho |
|---|---|---|---|
| teraswap.io | ⚠️ RESOLVES | 52.38.196.63 / 44.233.250.75 | IPs mudaram |
| tera-swap.app | ✅ Safe | sem DNS | = |
| teraswap.xyz | ✅ Safe | sem DNS | ✅ **melhorou** (resolvia) |
| teraswap.net | ✅ Safe | sem DNS | = |
| teraswap.org | ✅ Safe | sem DNS | = |
| teraswap.finance | ✅ Safe | sem DNS | = |
| terraswap.app | ⚠️ RESOLVES | 15.197.148.33 / 3.33.130.190 | = |
| terasswap.app | ✅ Safe | sem DNS | = |
| teraswap.com | ⚠️ RESOLVES | 76.223.54.146 / 13.248.169.48 | = |
| teraswap.exchange | ✅ Safe | sem DNS | = |

**Action needed:** 🟡 **Parcial** — 3 resolvem, nenhum classificado como clone de phishing ativo nesta execução.

Triagem desta execução (verificação passiva: NS, certificado TLS, status HTTP e metadados da página — **sem** interação com prompts de carteira):

- **teraswap.io** — NS `launch1/2.spaceship.net` (registador Spaceship). O handshake TLS **falha** e o pedido HTTPS devolve `000` (sem resposta). Perfil de **domínio parqueado/registado sem serviço**. Risco atual: baixo. ⚠️ Vigiar: o registo mudou de infra desde Julho (EC2 → Spaceship), o que indica registo ativo por terceiro.
- **teraswap.com** — NS `ns1/ns2.afternic.com`, certificado GoDaddy DV, redirect para `forsale.godaddy.com`. **Confirmado: está à venda por USD 150.000.** Não é phishing. Aquisição defensiva a este preço **não é recomendável** (custo desproporcional ao risco); a mitigação eficaz é o registo defensivo dos TLDs baratos ainda livres.
- **terraswap.app** — NS `ns05/ns06.domaincontrol.com` (GoDaddy), certificado DV próprio, HTTP 200 mas o corpo servido é uma SPA vazia sem conteúdo estático (apenas `meta-viewport`). Consistente com o projeto **Terraswap** do ecossistema Terra — marca distinta, não direcionada. Risco: baixo. Sem imitação visível da marca TeraSwap na resposta inicial.

> **Recomendação (RICE baixo, custo baixo):** registar defensivamente `tera-swap.app`, `teraswap.xyz` e `terasswap.app` (typos de maior probabilidade, todos livres) em vez de perseguir `teraswap.com`.

### 🔒 Security Headers

Verificado no host canónico **`https://www.teraswap.app`**. (O apex `teraswap.app` faz `308 → www` e a resposta de redirect não transporta CSP — verificar o apex produz resultado vazio e enganador.)

| Header | Present | Value |
|--------|---------|-------|
| Content-Security-Policy | ✅ | `default-src 'self'` · `script-src 'self' 'unsafe-inline'` · `frame-ancestors 'none'` · `object-src 'none'` · `base-uri 'self'` · `form-action 'self'` — **sem wildcard (`*`) em `script-src` ou `default-src`** |
| Strict-Transport-Security | ✅ | `max-age=15552000; includeSubDomains; preload` |
| X-Frame-Options | ✅ | `DENY` |
| X-Content-Type-Options | ✅ | `nosniff` |
| Referrer-Policy | ✅ (bónus) | `strict-origin-when-cross-origin` |
| Permissions-Policy | ✅ (bónus) | `camera=(), microphone=(), geolocation=(), interest-cohort=()` |

**Notas:**

- `connect-src` está explicitamente enumerado (11 fontes de liquidez + RPCs + Supabase + Sentry + WalletConnect) — boa prática, mas contém wildcards de subdomínio (`https://*.infura.io`, `https://*.alchemy.com`, `https://*.supabase.co`, `wss://*.walletconnect.com`). Aceitável: são domínios de fornecedores sob controlo do próprio fornecedor, não wildcards globais.
- 🟨 **Observação recorrente (L):** `script-src` inclui `'unsafe-inline'`. É o padrão do Next.js sem nonce/hash por request. Não é um finding novo; permanece como dívida técnica de baixa prioridade (mitigar via nonce middleware se/quando houver folga).

### 📜 SSL Certificate

- **Subject:** `CN = teraswap.app`
- **Issuer:** Let's Encrypt (`C = US, O = Let's Encrypt, CN = YE1`)
- **Expira:** 11 Set 2026 06:30:37 GMT — **41 dias restantes**
- **Serial:** `055EF58E5C118A0C4EC48D5D1ED6C8257751`
- **Status:** ✅ Válido, > 30 dias. Renovação automática gerida pela Vercel; sem ação necessária.

### 🔑 Secrets Scan

**Código-fonte (`src/`):** ✅ **Limpo**

| Padrão | Matches | Veredicto |
|---|---|---|
| `NEXT_PUBLIC_*KEY` / `private key` / `secret` / `password` / `mnemonic` / `eyJ…` | 58 | ✅ **Zero segredos reais.** Todos são (a) leituras `process.env.*` seguidas de guard fail-closed (`MONITOR_SECRET`, `MONITOR_CRON_SECRET`, `KILL_SWITCH_SECRET`, `DCA_FREEZE_SECRET`, `EXECUTOR_VALIDATION_SECRET`, `ADMIN_API_KEYS_SECRET`, `TELEGRAM_WEBHOOK_SECRET`), (b) comentários de auditoria (`[N-02]`, `[API-C-01]`), ou (c) copy de UI legal/docs sobre chaves privadas do utilizador. |
| Chave privada EVM (64 hex) | 21 | ✅ Nenhuma é segredo. Composição: chave pública Anvil/Hardhat conta #0 (`0xac09…ff80`, valor publicado e já com `gitleaks:allow` documentado), chaves throwaway `0x1111…`, `ZeroHash` (`routerDataHash` para DCA, ref. `[C-01]`) e tx hashes em fixtures de teste. |
| `sk-…` / `AKIA…` / `ghp_…` | 0 | ✅ Nenhuma ocorrência. |

**Positivo:** todos os endpoints admin/monitor auditados seguem o padrão fail-closed correto — `if (!secret) return 503` seguido de `verifyBearerToken` / `safeCompare` em tempo constante. Nenhuma regressão face a Julho.

**Ficheiro `.env` local:** ⚠️ **Contém valores de produção reais** — ver §Findings.

**Histórico Git:** ✅ **Limpo.** Apenas 4 ficheiros `*.env*` alguma vez adicionados:

| Ficheiro | Commit | Veredicto |
|---|---|---|
| `.env.example` | `bdb8042` (2026-03-03) | ✅ Placeholders |
| `contracts/order-engine/executor/.env.executor.example` | `eee33fc` (2026-03-11) | ✅ Placeholders |
| `contracts/order-engine/.env.save` | `c22794c` (2026-03-13) | ✅ **Blob `e69de29…` = ficheiro vazio** (verificado por `git ls-tree`, não por inspeção visual). Conhecido e aceitável; removido em `d0f83c2`. |
| `scripts/gitleaks-fixtures/positive-PRIVATE_KEY.env.fixture` | `2229673` (2026-06-13) | ✅ Fixture intencional da regra gitleaks `evm-private-key-keyword-proximity` (chave fictícia, allowlisted por valor). |

`.gitignore` cobre `.env` com **18 padrões** distintos, incluindo `.env`, `.env.*`, `**/.env*`, `.env.save`, `.env.executor` e os caminhos específicos de `contracts/order-engine/`. Ficheiros `*.env*` atualmente tracked: apenas os 2 `.example` + a fixture. ✅

### 🗄️ Supabase / Infraestrutura

- **API connectivity:** ✅ `HTTP 200` em `https://www.teraswap.app/api/health` → `{"status":"OK","timestamp":"2026-08-01T09:08:57Z"}`
- **DB connectivity:** ⚠️ **Inferida.** O endpoint público devolve apenas o estado agregado e sugere `?token=HEALTH_TOKEN` para diagnóstico detalhado. O `HEALTH_TOKEN` não está disponível a esta scheduled task por design. Conectividade Supabase não verificada diretamente — permanece no checklist manual.
- **Executor:** parado intencionalmente até à implementação L2 (contexto conhecido, não é um finding).

---

## Findings

### 🔴 M-JUL-01 (reclassificado **HIGH**) — segredos de produção em plaintext no `.env` local

**Estado:** ABERTO — transitou de Julho sem remediação (mtime do ficheiro inalterado desde 2026-07-07).

O ficheiro `.env` na raiz do repositório contém **valores de produção reais**, não placeholders:

| Variável | Natureza | Impacto se comprometida |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | Chave privada EVM | Controlo de deploy; verificar privilégios residuais |
| `SUPABASE_SERVICE_ROLE_KEY` | JWT `service_role` | **Bypass total de RLS** — leitura/escrita irrestrita na base de dados |
| `RPC_URL` | Endpoint Alchemy com API key embutida | Abuso de quota, DoS de custos |
| `MONITOR_SECRET` | Bearer de endpoints de monitorização | Acesso a diagnóstico/tick |

**Mitigações já em vigor:** ficheiro **não** está no Git (18 padrões no `.gitignore`, histórico verificado limpo) e as permissões são `600` (apenas o dono lê). O risco é **em repouso, na máquina do Arquiteto** — não há exposição de rede nem de repositório.

**Agravante nova face a Julho:** o `SUPABASE_SERVICE_ROLE_KEY` presente é um JWT de `service_role` com validade longa. É a credencial de maior alcance do ficheiro (contorna todas as políticas RLS) e não estava explicitamente destacada no relatório anterior.

**Remediação recomendada (ordem):**

1. **Rotacionar `SUPABASE_SERVICE_ROLE_KEY`** (Supabase Dashboard → Settings → API → roll key) e atualizar nas env vars da Vercel. *Maior alcance, rotação mais barata → primeiro.*
2. **Rotacionar a Alchemy API key** e restringir por allowlist de domínio/IP.
3. **Rotacionar `MONITOR_SECRET`** → Vercel env vars + `.env.executor`.
4. **Migrar `DEPLOYER_PRIVATE_KEY` para HW wallet ou KMS** (alinhado com [`project_key_hardening`] — Admin+Treasury → HW, keeper mantém-se em KMS). Confirmar antes que a chave não detém fundos nem privilégios não recuperáveis por timelock.
5. Após 1–4, o `.env` local deve conter apenas referências/placeholders; segredos vivem em Vercel env vars / KMS.

> ⚠️ **Higiene:** os valores completos **não** são reproduzidos neste relatório — o relatório é commitado no repositório. A verificação foi feita por padrão e por nome de variável, nunca por transcrição de hex.

### 🟨 L-AGO-01 — `'unsafe-inline'` em `script-src`

Dívida técnica conhecida do Next.js sem nonce por request. Sem exploração prática identificada (`frame-ancestors 'none'`, `object-src 'none'` e `base-uri 'self'` limitam o vetor). Backlog, prioridade baixa.

### 🟨 L-AGO-02 — `teraswap.io` mudou de infraestrutura

Registo migrou de EC2 (Julho) para NS Spaceship sem serviço TLS (Agosto). Não serve conteúdo atualmente, mas a mudança confirma titularidade ativa por terceiro. **Ação:** re-verificar na execução de Setembro; se voltar a servir HTTP com TLS válido, escalar para investigação de phishing.

---

## Manual Checklist (Arquitecto deve executar)

- [ ] 🔴 **[M-JUL-01 — HIGH, 2.º ciclo]** Rotacionar `SUPABASE_SERVICE_ROLE_KEY` → Supabase Dashboard + Vercel env vars
- [ ] 🔴 **[M-JUL-01]** Rotacionar Alchemy API key + `MONITOR_SECRET`; migrar `DEPLOYER_PRIVATE_KEY` → HW/KMS
- [ ] Rodar `HEALTH_TOKEN` → Vercel env vars + executor `.env.executor`
- [ ] **[NOVO]** Registo defensivo de `tera-swap.app`, `teraswap.xyz`, `terasswap.app` (livres, custo baixo). **Não** adquirir `teraswap.com` (USD 150k — desproporcionado)
- [ ] **[L-AGO-02]** Re-verificar `teraswap.io` em Setembro; escalar se passar a servir conteúdo
- [ ] Rever acessos da equipa Vercel → vercel.com/dashboard → Settings → Members
- [ ] Testar hardware wallet → assinar tx de teste com admin wallet
- [ ] Verificar que consegue fazer pause do FeeCollector em < 5 min
- [ ] Rever Supabase RLS policies manualmente (supabase.com/dashboard → SQL Editor)
- [ ] Confirmar prazo GitHub 2FA (2026-08-23) — ver [`project_key_hardening`]

## Links Rápidos

- Vercel: vercel.com/dashboard
- Supabase: supabase.com/dashboard
- Alchemy: dashboard.alchemy.com

---

*Gerado automaticamente pela scheduled task `teraswap-monthly-security`. Próxima execução: Setembro 2026. Findings de severidade Medium+ devem ser triados para o backlog conforme convenção RICE. Verificações feitas na branch `main` @ `33a2e74`.*

---

## ⚠️ PERSIST — falhou (não commitado automaticamente)

`node scripts/commit-audit-report.mjs` foi executado como último passo e **falhou**. Sem retry, sem stash, sem force (conforme spec). O relatório existe apenas como ficheiro untracked em `Audits/Monthly/`; **o Arquiteto tem de o commitar manualmente** para `audits/cadence`.

**Erro (fatal):**

```
git -C <tmp>/audit-cadence-uFDrFe commit -m "docs(audits): cadence report(s) health-2026-07-31.md, health-2026-08-01.md, security-2026-08.md [auto]"
fatal: either user.signingkey or gpg.ssh.defaultKeyCommand needs to be configured
```

**Warnings não-fatais que precederam (ruído de permissões, não a causa):**

```
warning: unable to unlink '.git/objects/b3/tmp_obj_4ONGs7': Operation not permitted
warning: unable to unlink '.git/objects/3b/tmp_obj_Qle8Q7': Operation not permitted
warning: unable to unlink '.git/objects/2c/tmp_obj_yGFqT7': Operation not permitted
warning: unable to unlink '.git/objects/0c/tmp_obj_myE6W6': Operation not permitted
```

**Causa provável:** o ambiente sandbox onde a scheduled task corre não tem `user.signingkey` configurado, e a regra #12 do `CLAUDE.md` (todo o commit tem de ser assinado) é aplicada localmente pelo git. A chave de assinatura vive na máquina do Arquiteto, fora do sandbox. **Não foi tentado qualquer acesso a keychain ou credential helper** (regra #13).

**Estado verificado após a falha (read-only):** branch continua `main` @ `33a2e74`, working tree limpo exceto os ficheiros de auditoria untracked (`Audits/Daily/health-2026-07-31.md`, `Audits/Daily/health-2026-08-01.md`, `Audits/Monthly/security-2026-08.md`). Nada foi staged nem alterado no branch de trabalho. ✅

**Ação manual sugerida:** commitar os 3 relatórios em `audits/cadence` a partir de uma sessão com chave de assinatura disponível.

### 🟨 L-AGO-03 (novo, hygiene) — acumulação de worktrees órfãos

`git worktree list` reporta **~30 worktrees `audit-cadence-*` em estado `locked`** de execuções anteriores da cadência de auditoria (sessões sandbox já terminadas), mais ~12 worktrees `prunable` de sprints antigos em `/private/tmp` e `.claude/worktrees/`. Não é risco de segurança, mas polui o estado do repositório e sugere que o `commit-audit-report.mjs` deixa worktrees temporários por limpar quando o commit falha. **Ação:** `git worktree prune` (manual, fora desta task) e considerar `try/finally` de limpeza no script.

