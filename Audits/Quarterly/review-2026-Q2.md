# 🔴 TeraSwap QUARTERLY Security Review — Q2 2026

**Overall Status:** 🟡
**Data:** 2026-04-08
**Auditor:** Security Bot (Automated) — revisão pelo Senior Security Auditor obrigatória

---

## Automated Results

### 🌐 Infraestrutura

| Check | Status | Detalhes |
|-------|--------|----------|
| Site (teraswap.app) | ✅ | HTTP 200, 0.313s |
| API (/api/health) | ✅ | HTTP 200, 0.313s |
| SSL | ✅ | Expira 2026-07-05, Let's Encrypt R12, CN=*.teraswap.app (wildcard) |

**Notas SSL:** Certificado válido por ~88 dias. Renovação automática via Let's Encrypt expectável antes da expiração. Próximo check: confirmar renovação antes de Julho.

---

### 🌐 Typo-Domains

| Domínio | Status | IPs |
|---------|--------|-----|
| teraswap.io | ⚠️ RESOLVE | 54.149.79.189, 34.216.117.25 |
| teraswap.xyz | ⚠️ RESOLVE | 76.223.54.146, 13.248.169.48 |
| teraswap.net | ✅ Safe | — |
| teraswap.org | ✅ Safe | — |
| teraswap.finance | ✅ Safe | — |
| teraswap.com | ✅ Safe | — |
| teraswap.exchange | ✅ Safe | — |
| tera-swap.app | ✅ Safe | — |
| terraswap.app | ⚠️ RESOLVE | 3.33.130.190, 15.197.148.33 |
| terasswap.app | ✅ Safe | — |
| teraswap.dev | ✅ Safe | — |
| teraswap.defi | ✅ Safe | — |
| teraswap.trade | ✅ Safe | — |
| teraswap.swap | ✅ Safe | — |

**Análise:**
- **teraswap.io** e **teraswap.xyz** — IPs AWS (us-west-2). Podem ser registos legítimos de terceiros ou potenciais phishing. **Acção recomendada:** verificar conteúdo destes domínios manualmente e considerar registar defensivamente.
- **terraswap.app** — Projecto conhecido (Terra ecosystem). Não é ameaça directa mas utilizadores podem confundir. Risco aceite.

---

### 🔒 Security Headers

| Header | Valor | Status |
|--------|-------|--------|
| Content-Security-Policy | Presente, completa | ✅ |
| X-Frame-Options | DENY | ✅ |
| Strict-Transport-Security | max-age=63072000; includeSubDomains; preload | ✅ |
| X-Content-Type-Options | nosniff | ✅ |
| Referrer-Policy | strict-origin-when-cross-origin | ✅ |
| Permissions-Policy | camera=(), microphone=(), geolocation=(), interest-cohort=() | ✅ |

**Análise CSP detalhada:**
- `default-src 'self'` ✅ — restritivo
- `script-src 'self' 'unsafe-inline'` ⚠️ — `unsafe-inline` presente. Risco mitigado por não permitir origens externas, mas idealmente migrar para nonces/hashes no futuro (V2).
- `frame-src 'none'` e `frame-ancestors 'none'` ✅ — proteção anti-clickjacking completa
- `object-src 'none'` ✅
- `connect-src` — lista extensa mas todas origens legítimas (DEX APIs, RPC, WalletConnect, Supabase, Sentry). Sem wildcards globais ✅.
- **Ausente:** `upgrade-insecure-requests` — considerar adicionar (baixa prioridade).

---

### 📦 Dependências

#### npm audit
```
found 0 vulnerabilities ✅
```

#### Auditoria de Licenças

| Licença | Count | Status |
|---------|-------|--------|
| MIT | 777 | ✅ Permissiva |
| Apache-2.0 | 94 | ✅ Permissiva |
| ISC | 51 | ✅ Permissiva |
| BSD-3-Clause | 13 | ✅ Permissiva |
| BlueOak-1.0.0 | 10 | ✅ Permissiva |
| BSD-2-Clause | 10 | ✅ Permissiva |
| MPL-2.0 | 5 | ⚠️ Copyleft fraco (ficheiro-a-ficheiro) |
| 0BSD | 3 | ✅ Permissiva |
| FSL-1.1-MIT | 2 | ✅ Functional Source |
| **LGPL-3.0-or-later** | 1 | ⚠️ Copyleft fraco |
| **LGPL-3.0-only** | 1 | ⚠️ Copyleft fraco |
| **UNKNOWN** | 1 | ⚠️ Verificar manualmente |
| **UNLICENSED** | 1 | ⚠️ Verificar manualmente |
| Custom (MetaMask) | 3 | ⚠️ Verificar termos |
| Python-2.0 | 1 | ✅ Permissiva |
| Unlicense / CC0 / Public Domain | 3 | ✅ Permissiva |
| CC-BY-4.0 | 1 | ✅ (atribuição requerida) |

**Análise:**
- ✅ **Sem GPL-3.0 ou AGPL** — não há licenças copyleft fortes.
- ⚠️ **LGPL-3.0** (2 pacotes) — copyleft fraco, aceitável para dependências npm (linkagem dinâmica). Sem acção necessária.
- ⚠️ **MPL-2.0** (5 pacotes) — copyleft ficheiro-a-ficheiro, aceitável se não modificar ficheiros fonte desses pacotes.
- ⚠️ **UNKNOWN + UNLICENSED** (2 pacotes) — **acção recomendada:** identificar estes pacotes e verificar licenças manualmente com `npx license-checker --unknown`.
- ⚠️ **Custom (MetaMask)** — termos MetaMask SDK, verificar compatibilidade comercial.

---

### 🔑 Secrets & Higiene

#### Scan de Código-Fonte

| Padrão | Resultado | Status |
|--------|-----------|--------|
| Ethereum private keys (0x + 64 hex) | 4 matches — todos `0x0000...0000` (ZeroHash para DCA/CoW) | ✅ Falsos positivos |
| JWTs / Supabase keys | 0 matches | ✅ Limpo |
| AWS / API keys (AKIA, sk-, ghp_) | 0 matches | ✅ Limpo |
| Mnemonics / seed phrases | 3 matches — texto legal em LegalPage.tsx ("never ask for your private keys") | ✅ Falsos positivos |
| Padrões secret/password/private_key | 9 matches — referências env (`process.env.MONITOR_SECRET`), texto legal, safeCompare, type definitions | ✅ Falsos positivos |

**Resultado:** ✅ Nenhum segredo hardcoded detectado no código-fonte.

#### Git History

| Check | Resultado | Status |
|-------|-----------|--------|
| Ficheiros .env* adicionados | .env.save aparece em 3 commits iniciais (v1.0, v2, DCA fix) | ⚠️ Verificado |
| Ficheiros secret/credential/key.json | 0 matches | ✅ Limpo |

**Nota:** Os commits que referenciam `.env*` são de commits gerais onde o padrão `.env.save` foi incluído no diff filter. O ficheiro nunca conteve dados sensíveis (empty blob conhecido). ✅ Aceite.

#### .gitignore

| Padrão Requerido | Presente | Status |
|-----------------|----------|--------|
| .env | ✅ | OK |
| .env.* | ✅ | OK |
| .env.local | ✅ | OK |
| .env.executor | ✅ | OK |
| .env.save | ✅ | OK |
| **/.env | ✅ | OK |
| **/.env.* | ✅ | OK |
| *.pem | ❌ | ⚠️ Ausente |
| *.key | ❌ | ⚠️ Ausente |
| credentials.json | ❌ | ⚠️ Ausente |

**Acção recomendada:** Adicionar `*.pem`, `*.key`, e `credentials.json` ao `.gitignore` como medida preventiva.

---

### 🏗️ Build

| Check | Resultado | Status |
|-------|-----------|--------|
| `npm run build` | ⚠️ EPERM no ambiente sandbox | ⚠️ Inconclusivo |

**Nota:** O build falhou com `EPERM: operation not permitted, unlink .next/BUILD_ID` — isto é uma limitação do ambiente sandbox (permissões de escrita no filesystem montado), **não** um problema real do projecto. O build deve ser verificado localmente ou via CI/CD (GitHub Actions).

**Recomendação:** Verificar último deploy Vercel e confirmar que o build passou no CI.

---

### ⚙️ Solidity Compiler

| Item | Detalhe |
|------|---------|
| Versão TeraSwap | 0.8.24 |
| Bug SOL-2026-1 (TransientStorageClearingHelperCollision) | ❌ **Não afecta** — introduzido em 0.8.28, corrigido em 0.8.34 |
| CVE-2026-22557 | Verificar se afecta 0.8.24 — referenciado no NVD, detalhes insuficientes na pesquisa |
| Versão mais recente Solidity | Verificar releases em github.com/ethereum/solidity/releases |

**Análise:** A versão 0.8.24 permanece segura relativamente ao bug conhecido de transient storage (0.8.28-0.8.33). No entanto, a versão tem ~2 anos e não recebe patches de segurança. **Acção recomendada (V2):** planear migração para versão estável recente quando houver recompilação de contratos.

**Nota importante:** Foi identificado CVE-2026-22557 no NVD. O arquitecto deve verificar manualmente se este CVE afecta a versão 0.8.24 consultando https://nvd.nist.gov/vuln/detail/CVE-2026-22557.

---

## 🔑 KEY ROTATION — Obrigatório (Arquitecto deve executar TODOS)

- [ ] 1inch API Key → portal.1inch.dev → gerar nova → actualizar `ONEINCH_API_KEY` no Vercel
- [ ] 0x API Key → dashboard.0x.org → gerar nova → actualizar `ZEROX_API_KEY` no Vercel
- [ ] Alchemy RPC → dashboard.alchemy.com → rodar → actualizar `NEXT_PUBLIC_RPC_URL` no Vercel + `RPC_URL` no executor
- [ ] Supabase Service Role → supabase.com/dashboard → Settings → API → actualizar `SUPABASE_SERVICE_ROLE_KEY` no Vercel + executor
- [ ] HEALTH_TOKEN → gerar nova string aleatória 32+ chars → Vercel + executor
- [ ] MONITOR_SECRET → gerar nova string aleatória 32+ chars → Vercel + executor
- [ ] **Após TODAS as rotações:** redeploy Vercel + reiniciar executor + testar um swap completo

⚠️ **Deadline recomendada:** completar rotações até 2026-04-22 (2 semanas).

---

## 📋 REVIEW TASKS — Manual (Arquitecto)

- [ ] Admin wallet está num hardware wallet?
- [ ] Consegue fazer pause do FeeCollector em < 5 min? (testar)
- [ ] Consegue fazer pause do OrderExecutor em < 5 min? (testar)
- [ ] Rever GitHub audit log → github.com/settings/security-log (acessos não autorizados?)
- [ ] Rever Vercel team access → Members (remover quem não precisa)
- [ ] Rever Supabase RLS policies → SQL Editor → verificar que anon não acede ordens de outros
- [ ] O TeraSwap_Security_Guide.pdf ainda está actualizado?
- [ ] Rever se há dependências com licenças incompatíveis (ver secção Licenças acima)
- [ ] Verificar conteúdo de teraswap.io e teraswap.xyz (potencial phishing)
- [ ] Adicionar `*.pem`, `*.key`, `credentials.json` ao .gitignore
- [ ] Identificar pacotes UNKNOWN e UNLICENSED com `npx license-checker --unknown`
- [ ] Verificar CVE-2026-22557 no NVD (afecta 0.8.24?)
- [ ] Confirmar build passa no Vercel/GitHub Actions (sandbox inconclusivo)

---

## 📊 Resumo de Findings

| Severidade | Count | Descrição |
|-----------|-------|-----------|
| 🔴 Critical | 0 | — |
| 🟠 High | 0 | — |
| 🟡 Medium | 3 | Typo-domains resolvem (2), CVE-2026-22557 por verificar (1) |
| 🔵 Low | 4 | .gitignore incompleto, UNKNOWN/UNLICENSED licenças, CSP unsafe-inline, Solidity 0.8.24 aging |
| ℹ️ Info | 2 | Build inconclusivo (sandbox), CSP sem upgrade-insecure-requests |

---

## Links Rápidos

- Vercel: https://vercel.com/dashboard
- Supabase: https://supabase.com/dashboard
- Alchemy: https://dashboard.alchemy.com
- 1inch: https://portal.1inch.dev
- 0x: https://dashboard.0x.org
- GitHub Security: https://github.com/settings/security-log
- Solidity Releases: https://github.com/ethereum/solidity/releases
- NVD CVE-2026-22557: https://nvd.nist.gov/vuln/detail/CVE-2026-22557
- Solidity Known Bugs: https://docs.soliditylang.org/en/latest/bugs.html

---

*Relatório gerado automaticamente em 2026-04-08. Revisão humana obrigatória antes de executar qualquer acção.*
