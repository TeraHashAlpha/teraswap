# 🔴 TeraSwap QUARTERLY Security Review — Q3 2026

**Overall Status:** 🟡 AMARELO
**Date:** 2026-07-01
**Auditor:** Security Bot (Automated) — revisão pelo Senior Security Auditor obrigatória

> **Nota de âmbito:** execução automática (scheduled task), sem utilizador presente. Todas as
> decisões de implementação foram tomadas autonomamente. Ficheiro nomeado como `review-2026-Q3.md`
> por ser o snapshot do trimestre corrente (Q3 arranca a 2026-07-01); segue a cadência do
> `review-2026-Q2.md` já presente na pasta.

---

## Resumo Executivo

Postura geral sólida — infraestrutura, cabeçalhos de segurança, segredos e licenças estão todos
verdes. O estado é **AMARELO** (não verde) por quatro motivos, nenhum deles Crítico:

1. **4 typo-domains resolvem** (`teraswap.io`, `teraswap.xyz`, `teraswap.com`, `terraswap.app`) — requer verificação manual de phishing.
2. **npm audit: 5 vulnerabilidades High** — todas transitivas/dev-tooling (baseline conhecido), mas o lembrete de converter allowlist→overrides (form-data/vite) está **em atraso** (previsto ~22-Jun).
3. **Discrepância de versão do compilador Solidity** — a premissa "0.8.24" está desactualizada. O bytecode é compilado com **0.8.28 + viaIR**, que cai dentro do intervalo afectado pelo bug de transient storage de Fev-2026. **Mitigado** (contratos não usam transient storage), mas a premissa deve ser corrigida e endurecida.
4. **Build não verificável neste ambiente** (EPERM no `.next` montado) — validado por `typecheck` e `lint` limpos como proxy.

---

## Automated Results

### 🌐 Infrastructure

| Check | Status | Details |
|-------|--------|---------|
| Site | ✅ | HTTP 308 → **200** (redirect para `www.teraswap.app`), ~0.59s |
| API | ✅ | HTTP 308 → **200**, `/api/health` = `{"status":"OK"}`, ~0.64s |
| SSL | ✅ | Expira **11-Set-2026 06:30 GMT** (~72 dias), Let's Encrypt (intermédio `YE1`), CN=`teraswap.app`, serial `055EF58E5C118A0C4EC48D5D1ED6C8257751` |

Sem observações. O redirect apex→www é 308 (permanente) e resolve para 200 — comportamento esperado do Vercel. Certificado renova automaticamente.

### 🌐 Typo-Domains

| Domínio | Status | Resolve para |
|---------|--------|--------------|
| teraswap.io | ⚠️ RESOLVE | `54.149.79.189`, `34.216.117.25` (AWS) |
| teraswap.xyz | ⚠️ RESOLVE | `172.239.49.232`, `172.234.27.233`, `172.239.193.67` (Akamai/Linode) |
| teraswap.com | ⚠️ RESOLVE | `13.248.169.48`, `76.223.54.146` (AWS Global Accelerator — típico de parking/registrar) |
| terraswap.app | ⚠️ RESOLVE | `15.197.148.33`, `3.33.130.190` (AWS — típico de parking/registrar) |
| teraswap.net | ✅ Safe | — |
| teraswap.org | ✅ Safe | — |
| teraswap.finance | ✅ Safe | — |
| teraswap.exchange | ✅ Safe | — |
| tera-swap.app | ✅ Safe | — |
| terasswap.app | ✅ Safe | — |
| teraswap.dev | ✅ Safe | — |
| teraswap.defi | ✅ Safe | — |
| teraswap.trade | ✅ Safe | — |
| teraswap.swap | ✅ Safe | — |

**Acção:** verificar manualmente se algum dos 4 que resolvem serve uma clonagem/phishing do TeraSwap. `terraswap.app` (duplo-r) e `teraswap.io/.com/.xyz` são as variações de maior risco. IPs de AWS Global Accelerator (`teraswap.com`, `terraswap.app`) sugerem parking de registrar, mas confirmar visualmente (via Chrome, nunca clicar links diretamente). Considerar registo defensivo dos ainda livres de maior risco (`.io`, `.xyz`) se em orçamento.

### 🔒 Security Headers

| Header | Valor | Avaliação |
|--------|-------|-----------|
| Strict-Transport-Security | `max-age=15552000; includeSubDomains; preload` | ✅ (180d, preload) |
| X-Content-Type-Options | `nosniff` | ✅ |
| X-Frame-Options | `DENY` | ✅ |
| Referrer-Policy | `strict-origin-when-cross-origin` | ✅ |
| Permissions-Policy | `camera=(), microphone=(), geolocation=(), interest-cohort=()` | ✅ |
| Content-Security-Policy | `default-src 'self'; script-src 'self' 'unsafe-inline'; …` | ✅ **sem wildcards** em `script-src`/`default-src` |

**CSP:** `default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `connect-src` com allowlist explícita (1inch, 0x, paraswap, odos, kyberswap, cow, openocean, sushi, balancer, RPCs, WalletConnect, Supabase, Sentry). Sem `*` em script/default. **Observação menor (não bloqueante):** `script-src` e `style-src` incluem `'unsafe-inline'` — aceitável para a stack actual, mas a melhoria ideal a prazo é migrar para nonces/hashes. Sem alteração de severidade.

### 📦 Dependencies

**npm audit:** 35 vulnerabilidades — **1 low, 29 moderate, 5 high**.

As 5 **High**:

| Pacote | Natureza | Origem |
|--------|----------|--------|
| `form-data` | CRLF injection em nomes de campo multipart | transitiva (build/tooling) |
| `hono` | múltiplas (bypass IP, injeção Set-Cookie, JWT scheme, path traversal, CORS) | transitiva |
| `undici` | múltiplas (bypass validação TLS via SOCKS5, injeção header, DoS WebSocket) | transitiva (dev-only) |
| `vite` | `server.fs.deny` bypass (Windows), launch-editor NTLM | dev-tooling |
| `ws` | uninitialized memory disclosure, DoS por fragmentos | transitiva |

Todas provêm de `@reown/appkit` + `@walletconnect/*` (transitivas via `@wagmi/connectors`) e de tooling de build (vite/undici). Corresponde ao **baseline conhecido** (Dependabot 27 alerts, zero risco de produção — todas WalletConnect transitivas; gate de CI via `audit-gate.mjs` + allowlist). Nenhuma nova exposição de produção introduzida este trimestre.

⚠️ **Item em atraso:** o lembrete de converter `form-data`/`vite` de allowlist → `overrides` no `package.json` (previsto ~22-Jun-2026, ref. advisory WC/Reown / PR #195) está **vencido**. Recomenda-se executar antes do fecho do próximo sprint. `hono` e `ws` merecem confirmação de que continuam sem caminho para runtime de produção.

**License audit:** ~1000+ dependências, esmagadoramente permissivas — MIT (829), Apache-2.0 (86), ISC (52), BSD-3/2 (24), BlueOak (12), MPL-2.0 (7). **Sem GPL-3.0 nem AGPL.** ✅

Flags analisadas (nenhuma bloqueante):

| Licença | Pacote | Avaliação |
|---------|--------|-----------|
| LGPL-3.0-or-later | `@img/sharp-libvips-darwin-arm64` | Binário nativo pré-compilado (libvips), linkado dinamicamente, dep. opcional darwin-arm64 (não enviado ao browser). LGPL com linking dinâmico = compatível. Baixo. |
| UNKNOWN | `@metamask/sdk-install-modal-web` | Pacote MetaMask sem metadata de licença; MIT a montante. Baixo. |
| UNLICENSED | `teraswap@0.1.0` | O **próprio** `package.json` do projeto (correcto para app proprietária/privada). Sem problema. |
| Custom (URLs MetaMask), Python-2.0 (`argparse`) | vários | Permissivas conhecidas. OK. |

Sem copyleft incompatível no bundle web distribuído. ✅

### 🔑 Secrets & Hygiene

- **Source code scan:** ✅ Limpo. O regex de chave-privada EVM (`0x[64hex]`) só apanhou **placeholders ZeroHash** (`0x000…`), constantes keccak (`TRANSFER_TOPIC`) e hashes de teste. Sem JWTs/chaves Supabase, sem chaves AWS/GitHub/OpenAI, sem mnemónicas (apenas texto da LegalPage e comentários do `secure-storage.ts` que afirmam nunca guardar chaves). Todos os matches de "secret/password" são leituras `process.env.*_SECRET` + comentários.
- **Git history:** ✅ Ficheiros `*.env*` alguma vez adicionados = `.env.example`, `contracts/order-engine/.env.save` (blob vazio `e69de29` — conhecido/aceitável), `.env.executor.example`, `scripts/gitleaks-fixtures/positive-PRIVATE_KEY.env.fixture` (**chave falsa**, allowlisted na remediação de INC-2026-06-09-001). Sem ficheiros `*secret*`/`*credential*`/`*key.json` adicionados. Nota conhecida: `docs/guides/E2E-FORK-TEST.md` contém a chave pública do Anvil/Hardhat account #0 (chave de teste pública, já flagged para revisão do Arquitecto — não é segredo).
- **.gitignore:** ✅ **Completo**. Padrões obrigatórios presentes: `.env`, `.env.*`, `.env.local`, `.env.executor`, `.env.save`, `*.pem`, `*.key`, `credentials.json` — além de cobertura extensa (deployer JSON, gelato, capacitor, workers, caches, vendored ERC-7730, foundry stray).

### 🏗️ Build

⚠️ **Não verificável neste ambiente sandbox.** `next build` falhou com `EPERM: operation not permitted, unlink '.next/BUILD_ID'` (diretório `.next` montado, não gravável pela sandbox) + binário nativo `next-swc` arm64 ausente (fallback para WASM). Ambos são **artefactos de ambiente, não defeitos de código.**

Validação por proxy (não tocam no `.next`):

| Verificação | Resultado |
|-------------|-----------|
| `tsc --noEmit` (typecheck) | ✅ **0 erros** |
| `eslint src` (lint) | ✅ **0 erros**, 112 warnings (todos `no-unused-vars` de estilo, não bloqueantes) |

**Conclusão:** o código compila limpo. Recomenda-se confirmar o `next build` completo no ambiente de CI/local do Arquitecto (onde o `.next` é gravável).

### ⚙️ Solidity Compiler

- **Versão declarada (premissa da task/CLAUDE.md):** 0.8.24
- **Versão real de compilação:** **0.8.28** — `contracts/foundry.toml` e `contracts/order-engine/foundry.toml` ambos com `solc_version = "0.8.28"` e **`via_ir = true`**. O pragma-fonte é flutuante (`^0.8.24`, `^0.8.20`), pelo que o bytecode implantado foi produzido pelo **0.8.28**.
- **CVE / advisory relevante:** "TransientStorageClearingHelperCollision" (reportado por Hexens, 11-Fev-2026), severidade **High**, afecta **0.8.28–0.8.33** em modo **viaIR** com EVM cancun+, quando um contrato limpa **simultaneamente** uma variável de storage persistente E uma transient do mesmo tipo (colisão de helpers Yul → opcode errado `sstore`/`tstore`).
- **Condições no TeraSwap:**
  - Versão 0.8.28 → **dentro do intervalo afectado** ⚠️
  - viaIR → **activo** (condição de gatilho) ⚠️
  - Uso de transient storage (`tstore`/`tload`/`transient`) nos contratos de produção → **NENHUM** (grep vazio) ✅
- **Veredicto:** os contratos **não são exploráveis** por este bug — mas **não pela razão indicada na premissa** (versão 0.8.24), e sim porque **não usam transient storage**. A premissa "0.8.24" está desactualizada e deve ser corrigida.
- **Novos advisories:** nenhum outro CVE novo a afectar a toolchain foi encontrado.

**Recomendações (endurecimento, não urgente):**
1. Corrigir a premissa "0.8.24" em `CLAUDE.md`, na task do scheduler e na documentação de segurança — a realidade é **0.8.28**.
2. Defence-in-depth: fixar `solc_version` numa release **fora** do intervalo afectado (≥ 0.8.34) ou substituir o pragma flutuante `^0.8.24` por um pragma fixo, e adicionar um guard de CI que falhe se transient storage for introduzido enquanto num compilador afectado.
3. Se qualquer redeploy de contrato ocorrer este trimestre, reconfirmar a versão de compilação antes do deploy (regra "NEVER deploy without audit pass").

---

## 🔑 KEY ROTATION — Obrigatório (Arquitecto deve executar TODOS)
- [ ] 1inch API Key → portal.1inch.dev → gerar nova → actualizar `ONEINCH_API_KEY` no Vercel
- [ ] 0x API Key → dashboard.0x.org → gerar nova → actualizar `ZEROX_API_KEY` no Vercel
- [ ] Alchemy RPC → dashboard.alchemy.com → rodar → actualizar `NEXT_PUBLIC_RPC_URL` no Vercel + `RPC_URL` no executor
- [ ] Supabase Service Role → supabase.com/dashboard → Settings → API → actualizar `SUPABASE_SERVICE_ROLE_KEY` no Vercel + executor
- [ ] `HEALTH_TOKEN` → gerar nova string aleatória 32+ chars → Vercel + executor
- [ ] `MONITOR_SECRET` → gerar nova string aleatória 32+ chars → Vercel + executor
- [ ] Após TODAS as rotações: redeploy Vercel + reiniciar executor + testar um swap completo

## 📋 REVIEW TASKS — Manual (Arquitecto)
- [ ] Admin wallet está num hardware wallet? (ref. plano de key-hardening: Admin+Treasury → HW; keeper permanece em KMS)
- [ ] Consegue fazer pause do FeeCollector em < 5 min? (testar)
- [ ] Consegue fazer pause do OrderExecutor em < 5 min? (testar)
- [ ] Rever GitHub audit log → github.com/settings/security-log (acessos não autorizados?)
- [ ] Rever Vercel team access → Members (remover quem não precisa)
- [ ] Rever Supabase RLS policies → SQL Editor → verificar que `anon` não acede a ordens de outros
- [ ] O `TeraSwap_Security_Guide.pdf` ainda está actualizado?
- [ ] Rever dependências com licenças potencialmente incompatíveis (ver secção acima — nenhuma bloqueante encontrada)
- [ ] **[NOVO] Verificar os 4 typo-domains que resolvem** (teraswap.io/.xyz/.com, terraswap.app) — confirmar que não servem phishing
- [ ] **[NOVO] Converter allowlist→overrides** para `form-data`/`vite` (item vencido ~22-Jun)
- [ ] **[NOVO] Corrigir premissa de versão Solidity** (0.8.24 → **0.8.28**) na doc + considerar pin ≥ 0.8.34

## Links Rápidos
- Vercel: vercel.com/dashboard
- Supabase: supabase.com/dashboard
- Alchemy: dashboard.alchemy.com
- 1inch: portal.1inch.dev
- 0x: dashboard.0x.org
- GitHub Security: github.com/settings/security-log
- Solidity Releases: github.com/ethereum/solidity/releases
- Solidity Security Alerts: soliditylang.org/blog/category/security-alerts/
- Lista de bugs conhecidos: docs.soliditylang.org/en/latest/bugs.html

---

*Gerado automaticamente pelo Security Bot em 2026-07-01. Findings acima requerem validação humana antes de qualquer acção sobre contratos ou fund flows (regra: consultar `docs/security/AUDIT-TOTAL.md` primeiro).*
