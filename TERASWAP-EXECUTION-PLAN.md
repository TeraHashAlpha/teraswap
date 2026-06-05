# TeraSwap — Plano de Execução Arquitectural

**Documento:** Análise Arquitectural + Plano de Sprints + Instruções para Agentes
**Projecto:** TeraSwap (dex-aggregator 2)
**Data:** 2 de Abril de 2026
**Autor:** Arquitecto Principal
**Versão:** 2.0 — Revisão pós-auditoria de segurança

---

## CHANGELOG v2.0

- Sprint 0 reduzido: findings M-01 (MIN_ORDER_AMOUNT), M-03 (TIMELOCK_GRACE), L-01 (NonceTooHigh), L-04 (DCAChunkTooSmall) e API-03 (tokenIn≠tokenOut) já estão implementados no contrato e API actuais. Confirmado contra codebase.
- EX-01 (plaintext key hard-fail) corrigido em commit `539bd02`. Questão operacional adicionada.
- Prompts 1-3 (fixes de contrato) substituídos por: server-side selector validation, Dependabot setup, DefiLlama blocking upgrade.
- Secção 8 adicionada: Parecer Arquitectural sobre Auditoria.
- RICE recalculada com findings já resolvidos removidos e novos itens adicionados.

---

## 1. CONTEXTO DO PROJECTO

### Resumo

O TeraSwap é um **meta-agregador DEX** (Decentralized Exchange) que opera sobre Ethereum Mainnet. Agrega liquidez de 11 fontes (1inch, 0x, Velora/ParaSwap, Odos, KyberSwap, CoW Protocol, Uniswap V3, OpenOcean, SushiSwap, Balancer V2, Curve Finance) e oferece execução autónoma de ordens condicionais (Limit Orders, Stop-Loss, Take-Profit, DCA) através de um motor on-chain com validação Chainlink.

### Objectivo Principal

Ser a interface de trading mais eficiente para utilizadores DeFi em Ethereum, maximizando output por swap via meta-agregação, e oferecendo trading autónomo sem necessidade de browser aberto.

### Tipo de Sistema

- **dApp Web3** (Next.js 16 + React 18 + Wagmi/RainbowKit)
- **Smart Contracts** (Solidity 0.8.28 — TeraSwapOrderExecutor v2 + TeraSwapFeeCollector)
- **Backend Serverless** (Next.js API Routes em Vercel)
- **Off-chain Executor** (Node.js self-hosted via PM2)
- **Base de Dados** (Supabase/PostgreSQL com subscriptions real-time)
- **Mobile** (Capacitor — iOS/Android, scaffolding presente)

### Estado Actual

- **Phase 1 (Autonomous Order Engine):** ✅ Completa
- **Phase 2 (Multi-Chain):** Não iniciada
- **Phase 3 (Advanced Trading):** Parcialmente conceptualizada
- **Phase 4 (Protocol & Community):** Conceptual

### Stack Técnica

| Camada | Tecnologia |
|--------|-----------|
| Frontend | Next.js 16.1.6, React 18.3.0, TypeScript 5.5.2, Tailwind CSS 3.4 |
| Web3 | Wagmi 2.19.5, Viem 2.47.4, Ethers 6.16.0, RainbowKit 2.1.0 |
| State | Zustand 4.5, React Query 5.50, Custom Hooks |
| Contracts | Solidity 0.8.28, OpenZeppelin 5.0+, Foundry + Hardhat |
| Backend | Next.js API Routes (Vercel Serverless) |
| Database | Supabase (PostgreSQL + RLS + Real-time) |
| Monitoring | Sentry 10.43, Custom Admin Dashboard |
| Mobile | Capacitor 8.2 (iOS/Android) |
| Executor | Node.js + PM2 (self-hosted) |

---

## 2. LEITURA ARQUITECTURAL

### 2.1 Componentes do Sistema

```
┌─────────────────────────────────────────────────────────────┐
│                      FRONTEND (Next.js)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ SwapBox  │  │  DCA     │  │  Limit   │  │  SL/TP    │  │
│  │ (Instant)│  │  Panel   │  │  Panel   │  │  Panel    │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘  │
│       │              │             │               │        │
│  ┌────┴──────────────┴─────────────┴───────────────┴────┐   │
│  │              Custom Hooks Layer                       │   │
│  │  useQuote / useSwap / useApproval / useOrderEngine   │   │
│  │  useSplitSwap / useDCAEngine / useChainlinkPrice     │   │
│  └──────────────────────┬───────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────┘
                          │
┌─────────────────────────┼───────────────────────────────────┐
│                   API ROUTES (Vercel)                        │
│  /api/quote  /api/swap  /api/orders  /api/monitor           │
│  /api/spender  /api/health  /api/rpc  /api/log-*            │
└──────────┬──────────────┬───────────────────┬───────────────┘
           │              │                   │
    ┌──────┴──────┐  ┌───┴────────┐   ┌──────┴──────┐
    │ 11 DEX APIs │  │  Supabase  │   │  Chainlink  │
    │ (Liquidity) │  │ (Orders DB)│   │  (Oracles)  │
    └─────────────┘  └──────┬─────┘   └─────────────┘
                            │
                    ┌───────┴──────────┐
                    │  Self-Hosted     │
                    │  Executor (PM2)  │
                    └───────┬──────────┘
                            │
              ┌─────────────┴──────────────┐
              │  SMART CONTRACTS (Mainnet)  │
              │  TeraSwapOrderExecutor v2   │
              │  TeraSwapFeeCollector       │
              └────────────────────────────┘
```

### 2.2 Interacções entre Componentes

**Fluxo Instant Swap:**
Frontend → `/api/quote` (paralelo a 11 fontes, timeout 10s) → melhor cotação apresentada → utilizador confirma → `/api/swap` (calldata) → simulação eth_call → FeeCollector contract (deduz 0.1%) → Router DEX → tokens chegam ao utilizador.

**Fluxo Order Engine (Limit/SL/DCA):**
Frontend → EIP-712 signing (wagmi) → Supabase insert → Executor (poll 30s) → `canExecute()` view → `executeOrder()` on-chain → Chainlink validation → Router DEX → tokens ao utilizador → Supabase update → Frontend subscription notifica.

**Fluxo Split Routing:**
`fetchMetaQuote()` → `findBestSplit()` (testa combinações 2-way/3-way a 25/50/75%) → se ganho > 50 bps → executa multi-leg via `useSplitSwap`.

### 2.3 Dependências Externas Críticas

| Dependência | Risco de Falha | Mitigação Actual |
|-------------|---------------|-----------------|
| RPCs Ethereum (Alchemy/Ankr/PublicNode) | Médio | Fallback chain com 3 providers |
| 1inch API | Médio | Timeout 10s + exclusão automática |
| 0x API | Médio | Timeout 10s + exclusão automática |
| Chainlink Oracles | Baixo | Staleness check 300s, incomplete round check |
| Supabase | Médio | Sem fallback — ponto único de falha para orders |
| Vercel Serverless | Baixo | Cold starts afectam rate limiting (in-memory) |
| CoW Protocol API | Baixo | Opcional, MEV-protection source |
| WalletConnect | Baixo | Fallback para injected wallets |

### 2.4 Pressupostos e Lacunas Identificadas

**Pressupostos:**
1. Ethereum Mainnet como chain única é suficiente para MVP — válido para Phase 1, bloqueante para crescimento.
2. Rate limiting in-memory é aceitável — falso em produção com Vercel serverless (reset em cold starts).
3. Self-hosted executor é fiável — risco operacional significativo (single point of failure).
4. 0.1% fee é competitivo — validar contra 1inch Fusion, CoW native, 0x Matcha que não cobram fee.
5. Supabase RLS é suficiente para segurança de dados — precisa de validação formal.

**Lacunas:**
1. Sem CI/CD pipeline — deploys manuais.
2. Sem testes de integração frontend — apenas unit tests de contratos.
3. Sem monitoring de uptime do executor — apenas health endpoint básico.
4. Sem fallback para Supabase — se cair, o order engine para.
5. Rate limiting não persiste — cada cold start reseta contadores.
6. Mobile app incompleta — scaffolding Capacitor presente, sem funcionalidade real.
7. Sem RLS nos analytics tables — todos os utilizadores vêem todos os trades.
8. DCA browser-based ainda presente — contraditório com o order engine autónomo.
9. Sem estratégia de upgrade para contratos (imutáveis, sem proxy pattern).
10. Sem disaster recovery plan para o executor ou Supabase.
11. **[NOVO v2.0]** Sem dependency scanning automatizado (Dependabot/Renovabot).
12. **[NOVO v2.0]** Validação de function selector apenas client-side — servidor e contrato não validam.
13. **[NOVO v2.0]** DefiLlama price guard é non-blocking — swaps de alto valor passam sem segunda validação se DefiLlama indisponível.
14. **[NOVO v2.0]** Questão operacional: config actual do executor (`.env.executor`) tem CHAIN_ID=1 + plaintext key + sem KMS — hard-fail impede arranque. Config real de produção não documentada.

---

## 3. MAPA DE RISCO (Revisão v2.0)

### 3.1 Riscos Técnicos

| # | Risco | Prob. | Impacto | Severidade | Estado |
|---|-------|-------|---------|-----------|--------|
| T1 | Rate limiting in-memory reseta em cold starts | Alta | Médio | **ALTO** | ABERTO |
| T2 | `api.ts` com 2090 linhas — monólito difícil de manter | Média | Médio | MÉDIO | ABERTO |
| T3 | Ethers 6 + Viem coexistem — duplicação | Média | Baixo | BAIXO | ABERTO |
| T4 | DCA engine dual (browser + on-chain) | Média | Médio | MÉDIO | ABERTO |
| T5 | Sem testes de integração E2E | Alta | Alto | **ALTO** | ABERTO |
| T6 | 11 APIs sem circuit breaker | Média | Médio | MÉDIO | ABERTO |
| T7 | localStorage obfuscation XOR (não criptográfica) | Baixa | Médio | MÉDIO | ACEITE |

### 3.2 Riscos de Segurança (Revisão pós-auditoria)

| # | Risco | Prob. | Impacto | Severidade | Estado |
|---|-------|-------|---------|-----------|--------|
| S1 | ~~M-01 precision loss~~ | — | — | — | ✅ RESOLVIDO (MIN_ORDER_AMOUNT) |
| S2 | ~~M-03 Timelock sem deadline~~ | — | — | — | ✅ RESOLVIDO (TIMELOCK_GRACE) |
| S3 | Router comprometido + calldata arbitrária | Muito Baixa | Crítico | MÉDIO | MITIGADO (3 camadas) |
| S4 | Supabase RLS incompleto nos analytics tables | Média | Alto | **ALTO** | ABERTO |
| S5 | ~~EX-01 Plaintext key em mainnet~~ | — | — | — | ✅ RESOLVIDO (hard-fail 539bd02) |
| S6 | Sem WAF/DDoS nas API routes | Média | Médio | MÉDIO | ABERTO |
| S7 | **[NOVO]** Selector validation client-side only | Média | Alto | **ALTO** | ABERTO |
| S8 | **[NOVO]** DefiLlama non-blocking para high-value | Média | Alto | **ALTO** | ABERTO |
| S9 | **[NOVO]** Sem dependency scanning contínuo | Alta | Médio | MÉDIO | ABERTO |

### 3.3 Riscos Operacionais

| # | Risco | Prob. | Impacto | Severidade | Estado |
|---|-------|-------|---------|-----------|--------|
| O1 | Executor PM2 sem alerting | Média | Crítico | **CRÍTICO** | ABERTO |
| O2 | Supabase downtime = order engine parado | Baixa | Crítico | **ALTO** | ABERTO |
| O3 | Gas spike (>100 gwei cap fixo) bloqueia executor | Média | Alto | **ALTO** | ABERTO |
| O4 | Sem deploy pipeline (CI/CD) | Alta | Médio | **ALTO** | ABERTO |
| O5 | Sem runbooks para incident response | Alta | Médio | MÉDIO | ABERTO |
| O6 | **[NOVO]** Config produção do executor não documentada | Alta | Alto | **ALTO** | ABERTO |

### 3.4 Riscos de Produto

| # | Risco | Prob. | Impacto | Severidade |
|---|-------|-------|---------|-----------|
| P1 | Fee 0.1% vs competidores a 0% | Alta | Alto | **ALTO** |
| P2 | Apenas Ethereum Mainnet | Alta | Alto | **ALTO** |
| P3 | UX de orders incompleta (Phase 1.5) | Média | Médio | MÉDIO |
| P4 | Mobile app não funcional | Baixa | Baixo | BAIXO |

### 3.5 Riscos de Execução

| # | Risco | Prob. | Impacto | Severidade |
|---|-------|-------|---------|-----------|
| E1 | Scope creep Phase 2 sem estabilizar Phase 1 | Alta | Alto | **ALTO** |
| E2 | Dívida técnica acumulada | Alta | Médio | **ALTO** |
| E3 | Sem equipa definida — single developer | Alta | Crítico | **CRÍTICO** |

---

## 4. PRIORIZAÇÃO RICE (Revisão v2.0)

**Escala:** Reach (1-10), Impact (0.25-3), Confidence (0-100%), Effort (person-weeks)
**Score = (Reach × Impact × Confidence) / Effort**

> **Status (2026-05-18):** 16 de 18 items fechados. B16 e B18 diferidos para Phase 2/3.

| # | Bloco | Score | Estado |
|---|-------|-------|--------|
| B1 | Server-side selector validation no /api/swap | 43.2 | ✅ CLOSED (Sprint 0) |
| B2 | Rate limiting persistente (Upstash Redis) | 16.2 | ✅ CLOSED (Sprint 1/8) |
| B3 | Executor monitoring + alerting (Telegram) | 18.9 | ✅ CLOSED (Sprint 1) |
| B4 | Supabase RLS audit nos analytics tables | 20.4 | ✅ CLOSED (Sprint 0) |
| B5 | Documentar config produção do executor | 60.8 | ✅ CLOSED (Sprint 0) |
| B6 | CI/CD pipeline (GitHub Actions) | 12.7 | ✅ CLOSED (Sprint 1) |
| B7 | Dependabot + dependency scanning | 27.0 | ✅ CLOSED (Sprint 0) |
| B8 | DefiLlama blocking para swaps > $10k | 9.6 | ✅ CLOSED (Sprint 1) |
| B9 | E2E test suite (swap + order flows) | 5.4 | ✅ CLOSED (Sprint 19B + 22) |
| B10 | Refactor api.ts — modular adapter pattern | 3.6 | ✅ CLOSED (api.ts at 371 lines) |
| B11 | Order management UI polish (Phase 1.5) | 6.3 | ✅ CLOSED (OrderDashboard.tsx) |
| B12 | Circuit breaker para DEX APIs | 5.6 | ✅ CLOSED (Sprint 9A) |
| B13 | Incident response runbooks | 10.8 | ✅ CLOSED (docs/Runbooks/) |
| B14 | Remover DCA browser-based | 4.5 | ✅ CLOSED (dead code removed) |
| B15 | Remover ethers.js (consolidar em viem) | 1.9 | ✅ CLOSED (zero ethers imports) |
| B16 | Arbitrum support (Phase 2 — first L2) | 2.7 | ⏳ DEFERRED — Phase 2 |
| B17 | Gas strategy dinâmica no executor | 5.6 | ✅ CLOSED (3-tier EIP-1559) |
| B18 | Executor multi-signer ou keeper network | 1.9 | ⏳ DEFERRED — Phase 3 |

---

## 5. PLANEAMENTO POR SPRINTS (Revisão v2.0)

### Sprint 0 — Hardening & Documentação (0.5 semanas) ✅

**Objectivo:** Resolver gaps de segurança não cobertos pelo contrato actual e documentar estado operacional.
**Estado:** COMPLETO — todos os entregáveis implementados.

**Entregáveis:**
1. **Documentar config produção do executor** — confirmar se usa KMS/Vault, qual a config real (não a do `.env.executor` local), documentar processo de deploy
2. **Server-side selector validation** — adicionar whitelist de function selectors no `/api/swap` (replicar `KNOWN_SWAP_SELECTORS` do frontend)
3. **Supabase RLS audit** — verificar e corrigir policies nos tables de analytics/swaps. Testar com role anon.
4. **Dependabot setup** — `.github/dependabot.yml` para npm + GitHub Actions
5. **Minimum amountIn na API** — adicionar validação de `>= 10_000` no endpoint `/api/orders` (match com contrato)

**Dependências:** Nenhuma — este sprint bloqueia todos os outros.

**Critérios de Aceitação:**
- Documento de config do executor existe e é verificável
- `/api/swap` rejeita calldata com selectors desconhecidos (teste: enviar selector `0xdeadbeef` → 400)
- Supabase: role anon não lê trades de outros wallets (teste manual)
- Dependabot PR aparece no GitHub em < 24h após merge
- `/api/orders` rejeita `amountIn < 10_000` com erro claro

**Riscos:**
- Supabase RLS pode requerer alteração de queries existentes se analytics depender de acesso global
- Selector whitelist pode bloquear novos routers/selectors se não for extensível

---

### Sprint 1 — Infra & Observabilidade (1.5 semanas) ✅

**Objectivo:** Garantir que o sistema é monitorável, alertável e deployable de forma repetível.
**Estado:** COMPLETO — Upstash Redis, CI/CD, Telegram alerting, DefiLlama blocking, all live.

**Entregáveis:**
1. Executor monitoring: métricas (orders checked, executed, failed, gas spent) + alerting (Telegram bot)
2. Rate limiting persistente: migrar de in-memory Map para Vercel KV ou Upstash Redis
3. CI/CD pipeline: GitHub Actions com lint → typecheck → contract tests → build → deploy preview
4. Health endpoint melhorado: incluir executor status, last execution timestamp, queue depth
5. **[NOVO]** DefiLlama validation upgrade: tornar blocking para swaps com valor estimado > $10,000 USD

**Dependências:** Sprint 0 concluído.

**Critérios de Aceitação:**
- Alerta Telegram chega em < 2 minutos se executor parar
- Rate limiting sobrevive a cold starts (teste: 31 requests em 60s → 31º retorna 429)
- Pipeline CI passa em < 5 minutos
- Health endpoint retorna JSON com status de cada subsistema
- Swap de >$10k com DefiLlama indisponível → transacção bloqueada com mensagem "Price validation unavailable for high-value swaps"

**Riscos:**
- Vercel KV tem cold start próprio (~100ms)
- DefiLlama blocking pode causar falsos positivos se o serviço estiver lento

---

### Sprint 2 — Qualidade & Resiliência (2 semanas) ✅

**Objectivo:** Reduzir dívida técnica crítica e aumentar resiliência contra falhas externas.
**Estado:** COMPLETO — circuit breaker, api.ts refactored (371 lines), runbooks, test coverage at 796.

**Entregáveis:**
1. Circuit breaker para cada DEX adapter: após 3 falhas consecutivas, source excluída por 60s com retry exponential
2. E2E test suite: minimum viable — swap ETH→USDC flow, order creation + cancellation, quote comparison
3. Incident response runbooks: playbooks para "executor down", "Supabase unreachable", "gas spike", "API key revoked"
4. Refactor parcial de `api.ts`: extrair cada adapter para ficheiro individual (`adapters/oneinch.ts`, etc.)

**Dependências:** Sprint 1 (CI/CD para correr testes automaticamente).

**Critérios de Aceitação:**
- Circuit breaker testado: simular timeout de 1inch → sistema continua com 10 fontes
- E2E tests passam em mainnet fork (`npm run fork`)
- Runbooks revistos por segundo par de olhos
- `api.ts` reduzido para < 500 linhas (orchestration only)

**Riscos:**
- E2E tests em mainnet fork podem ser flaky
- Refactor de api.ts requer testes prévios (executar B9 antes de B10)

---

### Sprint 3 — Product Polish (1.5 semanas) ✅

**Objectivo:** Completar Phase 1.5 e remover código legado.
**Estado:** COMPLETO — OrderDashboard live, DCA browser removed, ethers.js removed, gas strategy 3-tier.

**Entregáveis:**
1. Order management UI: listar ordens activas, cancelar, ver histórico de execuções DCA
2. Consolidar DCA: remover DCA browser-based, toda DCA via order engine autónomo
3. Remover ethers.js: substituir todas as referências por viem
4. Gas strategy dinâmica no executor: EIP-1559 base fee + priority fee adaptativo

**Dependências:** Sprint 0 (contrato estável), Sprint 2 (testes E2E para validar remoções).

**Critérios de Aceitação:**
- Order dashboard mostra estado real-time de todas as ordens do utilizador
- Cancellation on-chain funciona com confirmação visual
- Zero referências a `ethers` no `package.json`
- Executor executa em gas price > 100 gwei quando condições justificam

**Riscos:**
- Remoção de ethers pode quebrar integrações não mapeadas
- DCA consolidation afecta utilizadores com DCA browser-based activo

---

### Sprint 4 — Multi-Chain Foundation (3 semanas)

**Objectivo:** Preparar a arquitectura para Arbitrum como primeiro L2 (Phase 2 kickoff).

**Entregáveis:**
1. Chain abstraction layer: `ChainConfig` com RPCs, contratos, token lists, Chainlink feeds per chain
2. Deploy FeeCollector + OrderExecutor em Arbitrum
3. Adapter updates: verificar quais dos 11 adapters suportam Arbitrum
4. Frontend chain selector: dropdown/switch com Wagmi multi-chain config
5. Executor multi-chain: instância por chain ou loop multi-chain

**Dependências:** Sprint 3 concluído (codebase limpa).

**Critérios de Aceitação:**
- Swap ETH→USDC funciona em Arbitrum com pelo menos 5 fontes
- Order engine funciona em Arbitrum
- Chain switching na UI preserva estado
- Gas costs ~10x mais baixos que mainnet

**Riscos:**
- Nem todos os aggregators suportam Arbitrum
- Chainlink feeds em Arbitrum têm endereços diferentes
- Bridge integration fica fora deste sprint

---

## 6. INSTRUÇÕES PARA O AUDITOR DE SEGURANÇA (Revisão v2.0)

### Sprint 0 — Security Checklist

**Scope:** Supabase RLS, API routes, server-side validation. Smart contract NÃO requer re-auditoria (findings M-01, M-03 confirmados como resolvidos).

**Supabase Audit:**

1. **RLS policies em TODAS as tables:** `orders` (user sees own only), `order_executions` (via order ownership join), `swaps` / analytics (verificar acesso anon). Teste: autenticar como wallet A, tentar ler ordens de wallet B → resultado vazio.

2. **Service role key isolation:** Confirmar que `SUPABASE_SERVICE_ROLE_KEY` nunca aparece em variáveis `NEXT_PUBLIC_*` ou no bundle client-side.

**API Security:**

3. **Server-side selector validation (NOVO):** Após implementação, verificar que `/api/swap` rejeita calldata com selectors fora da whitelist. Testar com selector legítimo (0x12aa3caf = 1inch) → passa. Testar com selector aleatório → rejeita 400.

4. **Minimum amountIn na API:** Confirmar que `/api/orders` rejeita `amountIn < 10_000` com error code claro.

5. **Rate limiting bypass:** Testar com múltiplos IPs após migração para Redis — confirmar persistência cross-cold-start.

6. **Input validation abrangente:** Slippage clamping (0.01%-15%), address format validation, request size limit (10KB).

### Sprint 1 — Audit Points

7. **DefiLlama blocking threshold:** Verificar que swaps > $10k com DefiLlama indisponível são bloqueados. Verificar que o threshold não é bypassável via manipulação de `estimatedValueUsd`.

8. **Redis/KV security:** Confirmar connection string server-only. Confirmar que dados de rate limit não leakam na response.

9. **Health endpoint auth:** Confirmar `HEALTH_TOKEN` é obrigatório e não adivinhável.

### Sprint 2 — Audit Points

10. **Circuit breaker behaviour:** Verificar que sources excluídas não retornam dados stale. Verificar re-inclusão após cooldown.

11. **Adapter isolation:** Após refactor, verificar que cada adapter sanitiza response data. Sem cross-adapter data leakage.

### Sprint 4 — Audit Points

12. **Cross-chain signature replay:** Verificar EIP-712 domain separator inclui chainId correcto por deployment. Signature para mainnet NÃO funciona em Arbitrum.

13. **Arbitrum-specific:** L2 sequencer downtime handling, gas estimation com L1 data cost, Chainlink sequencer uptime feed.

---

## 7. INSTRUÇÕES PARA O CRIADOR DE PROMPTS (CLAUDE CODE AGENTS) — Revisão v2.0

Prompts 1-3 originais (fixes de contrato) estão **OBSOLETOS** — os fixes já existem no contrato actual. Substituídos por novos prompts abaixo.

---

### PROMPT 1 — Sprint 0: Server-Side Function Selector Validation

**Context:** The frontend (`useSwap.ts`) validates swap calldata function selectors against a whitelist (`KNOWN_SWAP_SELECTORS`). However, this validation is client-side only. If anyone interacts with the API directly (bypassing the frontend), arbitrary calldata passes through to the FeeCollector contract and then to whitelisted routers. The smart contract validates `routerDataHash` for orders (signed by user), but instant swaps via FeeCollector have no selector validation.

**Objective:** Add server-side function selector validation to `/api/swap/route.ts`.

**Requirements:**
- Create `src/lib/swap-selectors.ts` as shared module:
  - Export `KNOWN_SWAP_SELECTORS: Set<string>` — same set as in `useSwap.ts` (18 selectors for 1inch, 0x, Paraswap, Odos, KyberSwap, Uniswap V3, Uniswap V2, Sushi)
  - Export `isKnownSwapSelector(calldata: string): boolean` — extracts first 4 bytes (10 hex chars with 0x prefix), checks against set
  - Export `getSelector(calldata: string): string` — utility to extract selector from calldata
- In `/api/swap/route.ts`, after receiving swap calldata from aggregator API:
  - Extract function selector from `tx.data`
  - If selector not in `KNOWN_SWAP_SELECTORS`: return `400 { error: "Unknown swap function selector", selector: "0x..." }`
  - Log rejected selectors to console.warn for monitoring
  - Add comment: `// [SC-04] Server-side defense-in-depth — mirrors frontend KNOWN_SWAP_SELECTORS`
- Update `useSwap.ts` to import from shared module instead of defining its own set
- Update `useSplitSwap.ts` to import from shared module

**Files affected:** New `src/lib/swap-selectors.ts`, update `src/app/api/swap/route.ts`, update `src/hooks/useSwap.ts`, update `src/hooks/useSplitSwap.ts`

**Expected output:** Shared selector whitelist used by both frontend and backend. API rejects unknown selectors.

**Quality criteria:** Selector validation in API mirrors frontend exactly. No behavioral change for legitimate swaps. Unknown selectors logged and rejected with 400.

---

### PROMPT 2 — Sprint 0: Dependabot + Dependency Scanning

**Context:** TeraSwap has 461 npm dependencies. A one-time `npm audit fix` was done (commit `9f3d047`), but there is no automated dependency scanning. This is a supply chain risk — the Ledger Connect Kit incident (December 2023) showed that a single compromised dependency can drain user funds from any dApp that loads it.

**Objective:** Set up automated dependency scanning via GitHub Dependabot and a scheduled npm audit check.

**Requirements:**
- Create `.github/dependabot.yml`:
  - Package ecosystem: npm
  - Directory: "/"
  - Schedule: weekly (Monday)
  - Open max 10 PRs at a time
  - Target branch: main
  - Ignore: major version bumps for `next`, `react`, `wagmi` (these need manual migration)
  - Labels: ["dependencies", "security"]
- Create `.github/workflows/security-audit.yml`:
  - Trigger: schedule (weekly, Mondays at 08:00 UTC) + push to main
  - Job: run `npm audit --audit-level=high`
  - If vulnerabilities found with severity >= high: fail the workflow
  - If vulnerabilities found with severity moderate: warn but pass
  - Cache node_modules for speed
  - Node version: 20.x
- Update `.github/workflows/ci.yml` (if it exists) to include `npm audit --audit-level=high` as a CI step

**Files affected:** New `.github/dependabot.yml`, new `.github/workflows/security-audit.yml`, optionally update CI workflow

**Expected output:** Automated weekly dependency PRs + audit checks. High severity vulns block CI.

**Quality criteria:** Dependabot creates PRs within 24h of enabling. Audit workflow runs in < 2 minutes. High severity vulns fail the build.

---

### PROMPT 3 — Sprint 0: API-Side Minimum Order Amount Validation

**Context:** The smart contract enforces `MIN_ORDER_AMOUNT = 10_000` via `OrderTooSmall()` revert. However, the API endpoint `/api/orders` only validates `amountIn > 0`. This means orders between 1 and 9,999 wei are accepted by the API, stored in Supabase, and only fail when the executor tries to execute them on-chain — wasting gas and creating ghost orders in the database.

**Objective:** Add `MIN_ORDER_AMOUNT` validation to the orders API to reject sub-minimum orders before they reach Supabase.

**Requirements:**
- In `/api/orders/route.ts` POST handler:
  - Add constant: `const MIN_ORDER_AMOUNT = BigInt(10_000)` — must match smart contract
  - After parsing `amountIn`, validate: `if (BigInt(body.amountIn) < MIN_ORDER_AMOUNT)` → return `400 { error: "Order amount below minimum (10,000 wei)", minimum: "10000" }`
  - For DCA orders, also validate per-chunk: `if (BigInt(body.amountIn) / BigInt(body.dcaTotal) < MIN_ORDER_AMOUNT)` → return `400 { error: "DCA chunk below minimum" }`
  - Add comment: `// [API-02] Mirror contract MIN_ORDER_AMOUNT to fail-fast before Supabase insert`
- Add the same validation to any other endpoint that creates orders (check if there's a batch endpoint or alternative creation path)

**Files affected:** Update `src/app/api/orders/route.ts`

**Expected output:** Orders with `amountIn < 10,000` rejected at API level with clear error message.

**Quality criteria:** Error response includes the minimum value. DCA chunk validation prevents per-execution underflow. No change to existing valid order creation flow.

---

### PROMPT 4 — Sprint 1: Persistent Rate Limiting

**Context:** API routes (`src/app/api/quote/route.ts`, `src/app/api/swap/route.ts`) use an in-memory `Map<string, number[]>` for rate limiting. On Vercel Serverless, cold starts reset this map, making rate limiting ineffective.

**Objective:** Replace in-memory rate limiting with Vercel KV (Redis-compatible).

**Requirements:**
- Install `@vercel/kv` package
- Create `src/lib/rate-limiter.ts` with:
  - `checkRateLimit(key: string, limit: number, windowMs: number): Promise<{allowed: boolean, remaining: number, resetAt: number}>`
  - Uses sorted sets: `ZADD` with timestamp scores, `ZRANGEBYSCORE` to count within window, `ZREMRANGEBYSCORE` to clean up
  - Fallback: if KV unavailable, log warning and ALLOW request (fail-open for availability)
- Update `/api/quote/route.ts` and `/api/swap/route.ts` to use new rate limiter
- Remove the old in-memory rate limiting code
- Add env vars: `KV_REST_API_URL`, `KV_REST_API_TOKEN`
- Add `X-RateLimit-Remaining` and `X-RateLimit-Reset` response headers

**Files affected:** New `src/lib/rate-limiter.ts`, update `src/app/api/quote/route.ts`, update `src/app/api/swap/route.ts`, update `.env.example`

**Expected output:** Rate limiter that persists across cold starts. Fail-open if Redis unreachable.

**Quality criteria:** Rate limit of 30 req/min on quote survives cold start. Response includes rate limit headers. Fail-open if Redis down.

---

### PROMPT 5 — Sprint 1: Executor Monitoring & Alerting

**Context:** The self-hosted executor (`contracts/order-engine/executor/`) runs via PM2 and polls Supabase every 30 seconds. There is no alerting if it stops.

**Objective:** Add monitoring metrics and Telegram alerting.

**Requirements:**
- Create `contracts/order-engine/executor/monitor.ts`:
  - Track metrics: `ordersChecked`, `ordersExecuted`, `ordersFailed`, `gasSpent`, `lastCycleTime`, `consecutiveErrors`
  - Expose metrics via simple HTTP endpoint (port 9090, `/metrics` for Prometheus-compatible format)
  - If `consecutiveErrors >= 3`: send Telegram alert via bot API
  - If `lastCycleTime` exceeds 120s: send Telegram alert ("executor stalled")
  - Heartbeat: send "alive" message every 6 hours
- Add env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- Update PM2 config to expose port 9090
- Create `contracts/order-engine/executor/alert.ts` with `sendTelegramAlert(message: string)` helper

**Files affected:** New `monitor.ts`, new `alert.ts`, update `ecosystem.config.cjs`, update `.env.executor.example`

**Expected output:** Monitoring system that alerts within 2 minutes of executor failure. Prometheus-compatible metrics endpoint.

**Quality criteria:** Alert fires on 3+ consecutive errors. Heartbeat every 6h. Telegram message includes executor hostname, error details, timestamp.

---

### PROMPT 6 — Sprint 1: DefiLlama Blocking for High-Value Swaps

**Context:** The swap API uses DefiLlama as a secondary price oracle to validate swap execution prices. Currently it's non-blocking — if DefiLlama is unavailable, the swap proceeds with only Chainlink validation. For high-value swaps (>$10k), this creates a window where price manipulation could succeed if Chainlink is also within its staleness window.

**Objective:** Make DefiLlama validation blocking for swaps above a USD threshold.

**Requirements:**
- In `src/lib/defillama.ts`:
  - Add constant: `const HIGH_VALUE_THRESHOLD_USD = 10_000`
  - Modify `validateSwapPrice()` to accept `estimatedValueUsd: number` parameter
  - If `estimatedValueUsd > HIGH_VALUE_THRESHOLD_USD` AND DefiLlama is unreachable/errors:
    - Return `{ blocked: true, reason: "Price validation unavailable for high-value swap" }`
  - If `estimatedValueUsd <= HIGH_VALUE_THRESHOLD_USD` AND DefiLlama is unreachable:
    - Return `{ blocked: false }` (current fail-open behaviour preserved for small swaps)
  - If DefiLlama responds with deviation > 8%: block regardless of value
- In `/api/swap/route.ts`:
  - Estimate swap value in USD (use quote's toAmount + token price from the quote response, or Chainlink)
  - Pass `estimatedValueUsd` to `validateSwapPrice()`
  - If `blocked: true`: return `400 { error: reason }`
- Add comment: `// [INT-01] DefiLlama blocking for high-value swaps — defense against oracle manipulation window`

**Files affected:** Update `src/lib/defillama.ts`, update `src/app/api/swap/route.ts`

**Expected output:** High-value swaps are blocked when secondary oracle is unavailable. Small swaps retain current fail-open behaviour.

**Quality criteria:** Threshold configurable via constant. No impact on small swaps. Clear error message for blocked swaps. Estimation logic documented.

---

### PROMPT 7 — Sprint 1: CI/CD Pipeline

**Context:** TeraSwap has no automated deployment pipeline. Deploys are manual.

**Objective:** Create GitHub Actions CI/CD pipeline.

**Requirements:**
- Create `.github/workflows/ci.yml`:
  - Trigger: push to `main`, pull requests to `main`
  - Jobs (parallel where possible):
    1. `lint`: `npm run lint`
    2. `typecheck`: `npm run typecheck`
    3. `audit`: `npm audit --audit-level=high`
    4. `test-contracts`: `cd contracts/order-engine && forge test`
    5. `build`: `npm run build` (depends on lint + typecheck + audit passing)
  - Cache: node_modules + foundry
  - Node version: 20.x
  - Foundry: `foundry-rs/foundry-toolchain@v1`
- Create `.github/workflows/deploy-preview.yml`:
  - Trigger: pull requests
  - Job: deploy Vercel preview via `vercel --prebuilt`
  - Comment PR with preview URL
- Do NOT create production deploy workflow (manual for now)

**Files affected:** New `.github/workflows/ci.yml`, new `.github/workflows/deploy-preview.yml`

**Expected output:** Two workflow files. CI runs in < 5 minutes.

**Quality criteria:** All 5 CI jobs pass on current codebase. Caching reduces subsequent runs to < 3 minutes.

---

### PROMPT 8 — Sprint 2: DEX Adapter Refactor

**Context:** `src/lib/api.ts` is a 2090-line monolith containing all 11 DEX adapter implementations mixed with orchestration logic.

**Objective:** Extract each adapter into its own module following the adapter pattern.

**Requirements:**
- Create `src/lib/adapters/` directory
- Create interface `src/lib/adapters/types.ts`:
  ```typescript
  interface DEXAdapter {
    name: AggregatorName
    fetchQuote(params: QuoteParams): Promise<NormalizedQuote | null>
    fetchSwapData(params: SwapParams): Promise<NormalizedQuote | null>
    isAvailable(): boolean
    supportedChains: number[]
  }
  ```
- Extract each adapter: `oneinch.ts`, `zerox.ts`, `velora.ts`, `odos.ts`, `kyberswap.ts`, `cow.ts`, `uniswapv3.ts`, `openocean.ts`, `sushiswap.ts`, `balancer.ts`, `curve.ts`
- Each adapter implements `DEXAdapter` interface
- Keep `api.ts` as orchestration only: `fetchMetaQuote()` iterates over adapter registry
- `api.ts` should be < 500 lines after refactor
- All existing behaviour must be preserved — pure structural refactor

**Files affected:** `src/lib/api.ts` (reduce), new `src/lib/adapters/*.ts` (11 files + types + index)

**Expected output:** 13 new files in `adapters/`, reduced `api.ts`.

**Quality criteria:** Zero behavioral change. Each adapter independently testable. api.ts under 500 lines.

---

### PROMPT 9 — Sprint 2: Circuit Breaker

**Context:** The meta-aggregation engine calls 11 DEX APIs in parallel. If an API is down, it returns timeout errors but doesn't prevent repeated calls.

**Objective:** Implement a circuit breaker per DEX adapter.

**Requirements:**
- Create `src/lib/adapters/circuit-breaker.ts`:
  - States: CLOSED (normal), OPEN (blocking), HALF_OPEN (testing)
  - Config per adapter: `failureThreshold=3`, `cooldownMs=60000`, `halfOpenMaxAttempts=1`
  - CLOSED → OPEN: after `failureThreshold` consecutive failures
  - OPEN → HALF_OPEN: after `cooldownMs` elapsed
  - HALF_OPEN → CLOSED: if test request succeeds
  - HALF_OPEN → OPEN: if test request fails
- Wrap each adapter's `fetchQuote()` and `fetchSwapData()` with circuit breaker
- Skip adapters with OPEN circuit in orchestration
- Log state transitions

**Files affected:** New `src/lib/adapters/circuit-breaker.ts`, update `src/lib/api.ts`

**Expected output:** Circuit breaker that prevents hammering failed APIs. Automatic recovery.

**Quality criteria:** After 3 failures, source excluded for 60s. After cooldown, one test request. Logging shows state transitions.

---

### PROMPT 10 — Sprint 3: Order Management Dashboard

**Context:** The order engine is functional but the frontend lacks a proper order management UI.

**Objective:** Build a comprehensive order dashboard component.

**Requirements:**
- Create/enhance `src/components/OrderDashboard.tsx`:
  - Tab layout: "Active" | "Completed" | "Cancelled"
  - Each order card: type (Limit/SL/TP/DCA), token pair, target price, current price (live Chainlink), status, creation date, expiry countdown
  - DCA orders: progress bar (executionsCompleted / dcaTotal) + execution history timeline
  - "Cancel" button per active order → calls `invalidateNonces()` or per-order cancellation
  - Real-time updates via Supabase subscription
  - Empty states, loading skeletons
- Use existing hooks: `useOrderEngine`, `useChainlinkPrice`
- Style with Tailwind, dark theme (surface colors, cream accents)
- Responsive for mobile

**Files affected:** `src/components/OrderDashboard.tsx`, possibly `src/hooks/useOrderEngine.ts`

**Expected output:** Full order management dashboard. Production-ready.

**Quality criteria:** Orders update real-time. Cancel works on-chain. DCA progress visible. Mobile responsive. Matches design language.

---

### PROMPT 11 — Sprint 3: Consolidate DCA (Remove Browser-Based Engine)

**Context:** The project has TWO DCA implementations:
1. **Browser-based** — `src/lib/dca-engine.ts` (622 lines) + `src/lib/dca-types.ts` (135 lines) + `src/hooks/useDCAEngine.ts` (154 lines). This is a client-side state machine that uses localStorage (`teraswap:dca:positions`), a global 30s tick timer, and "smart window" price monitoring. It requires the browser to remain open.
2. **Autonomous (order engine)** — `src/components/DCAPanel.tsx` already uses `useOrderEngine()` hook, NOT `useDCAEngine()`. DCA orders are signed via EIP-712, stored in Supabase, and executed on-chain by the self-hosted keeper. No browser required.

The browser-based engine is **dead code** — `DCAPanel.tsx` does not import it. It was an earlier approach superseded by the autonomous order engine.

**Objective:** Remove the browser-based DCA engine entirely. Ensure no remaining references.

**Requirements:**
- DELETE `src/lib/dca-engine.ts` (622 lines — browser state machine, localStorage, tick timer)
- DELETE `src/lib/dca-types.ts` (135 lines — types exclusive to browser engine: DCAPosition, DCAExecution, WindowStatus, ExecutionReason)
- DELETE `src/hooks/useDCAEngine.ts` (154 lines — React hook wrapping the browser engine)
- SEARCH the entire codebase for any remaining imports or references to:
  - `dca-engine` or `DCAEngine`
  - `useDCAEngine`
  - `dca-types` or `DCAPosition` or `DCAExecution` or `WindowStatus` or `ExecutionReason`
  - `DCA_STORAGE_KEY` or `teraswap:dca:positions`
  - `WINDOW_OPEN_RATIO` or `DIP_THRESHOLD_PERCENT`
- If any file imports from the deleted modules, update it to remove the import. If the import was the only usage, remove the entire reference.
- Do NOT touch: `src/components/DCAPanel.tsx`, `src/hooks/useOrderEngine.ts`, `src/lib/order-engine/*`, `contracts/order-engine/*` — these are the autonomous engine and must remain intact.
- Verify `DCAPanel.tsx` still works by checking its imports resolve correctly after cleanup.

**Files affected:** DELETE 3 files (`dca-engine.ts`, `dca-types.ts`, `useDCAEngine.ts`). Possibly update files with stale imports.

**Expected output:** 3 files deleted (~911 lines removed). Zero dangling imports. Autonomous DCA pipeline untouched.

**Quality criteria:** `npm run build` passes. `grep -r "dca-engine\|useDCAEngine\|dca-types" src/` returns zero results. `DCAPanel.tsx` imports only from `useOrderEngine` and `order-engine/*`.

---

### PROMPT 12 — Sprint 3: Remove ethers.js (Consolidate to viem)

**Context:** The project depends on both `ethers@6.16.0` and `viem@^2.47.4`. The frontend already uses viem exclusively (via wagmi). However, the backend scripts and executor still use ethers. Since viem provides equivalent functionality for everything used, ethers is a redundant 400KB+ dependency.

**Objective:** Replace all ethers.js usage with viem equivalents and remove the ethers dependency.

**Requirements:**

**Phase 1 — API Routes (highest priority, production code):**
- `src/app/api/orders/route.ts`:
  - Replace `ethers.verifyTypedData(domain, ORDER_TYPES, message, signature)` → `import { verifyTypedData } from 'viem'` using `verifyTypedData({ address, domain, primaryType: 'Order', types: ORDER_TYPES, message, signature })`
  - Replace `ethers.ZeroHash` → `import { zeroHash } from 'viem'`
  - Remove `import { ethers } from 'ethers'`

**Phase 2 — Order Engine API reference:**
- `contracts/order-engine/api/orders.ts`:
  - Same `verifyTypedData` migration as Phase 1

**Phase 3 — Executor and scripts (Node.js, non-bundled):**
- `contracts/order-engine/executor/executor.js`:
  - Replace `ethers.JsonRpcProvider` → `createPublicClient({ transport: http(RPC_URL) })` from viem
  - Replace `ethers.Wallet(PRIVATE_KEY, provider)` → `privateKeyToAccount(PRIVATE_KEY)` from `viem/accounts` + `createWalletClient({ account, transport: http(RPC_URL) })`
  - Replace `ethers.Contract(address, abi, wallet)` → `getContract({ address, abi, client: walletClient })` from viem
  - Replace `ethers.parseUnits(str, "gwei")` → `parseGwei(str)` from viem
  - Replace `ethers.formatUnits(val, "gwei")` → `formatGwei(val)` from viem
  - Replace `ethers.formatEther(val)` → `formatEther(val)` from viem
  - All transaction calls adapt to viem's contract write pattern

- `contracts/order-engine/executor/kms-signer.js`:
  - Replace `ethers.AbstractSigner` extension → viem custom account via `toAccount({ address, signMessage, signTransaction, signTypedData })`
  - Replace `ethers.computeAddress(publicKeyHex)` → derive address from public key using `publicKeyToAddress` from viem
  - Replace `ethers.hashMessage` → `hashMessage` from viem
  - Replace `ethers.TypedDataEncoder.hash` → `hashTypedData` from viem
  - Replace `ethers.recoverAddress` → `recoverAddress` from viem
  - Replace `ethers.Signature.from()` → viem uses hex string signatures directly
  - Replace `ethers.getBytes()` → `toBytes()` from viem

- `contracts/order-engine/deploy.js` and `contracts/order-engine/deploy-sepolia.js`:
  - Replace provider/wallet/ContractFactory pattern → viem publicClient + walletClient + `deployContract()`

- `contracts/order-engine/bootstrap.js`:
  - Replace provider/wallet/Contract pattern → viem clients

- `contracts/order-engine/test-run.js`:
  - Replace all ethers test utilities with viem equivalents
  - Replace `ethers.ZeroAddress` → `zeroAddress` from viem
  - Replace `ethers.ZeroHash` → `zeroHash` from viem

- `contracts/order-engine/gelato/web3Function.ts`:
  - Replace `ethers.Contract` → `getContract` from viem
  - Replace `executor.interface.encodeFunctionData()` → `encodeFunctionData` from viem

**Phase 4 — Cleanup:**
- Run `npm uninstall ethers`
- Verify `package.json` no longer contains ethers
- Run `grep -r "from ['\"]ethers['\"]" .` to confirm zero remaining imports
- Run `grep -r "@ethersproject" .` to confirm zero remaining imports
- Run `npm run build` to verify no compilation errors

**Files affected:** ~9 files modified. `package.json` updated (ethers removed).

**Expected output:** Zero ethers imports anywhere in the project. One less heavy dependency. All functionality preserved using viem.

**Quality criteria:** `npm run build` passes. `grep -r "ethers" src/ contracts/` returns zero code imports (comments acceptable). `package-lock.json` does not contain ethers. Executor starts without errors. EIP-712 signature verification still works.

---

### PROMPT 13 — Sprint 3: Dynamic Gas Strategy for Executor

**Context:** The executor (`contracts/order-engine/executor/executor.js`) has a hardcoded gas cap:
```javascript
const MAX_GAS_PRICE_GWEI = 100  // line 87
```
At line ~431, if network gas exceeds 100 gwei, the executor skips the ENTIRE cycle (all orders). No transactions pass explicit gas parameters — ethers.js defaults are used. This is a binary gate: either process everything or nothing.

**Objective:** Replace the fixed cap with a configurable, tiered gas strategy that adapts to network conditions and order urgency.

**Requirements:**

1. **Environment-based configuration** (in `.env.executor.example` and `ecosystem.config.cjs`):
   ```
   GAS_MAX_GWEI=100           # absolute maximum, never exceed
   GAS_TARGET_GWEI=30         # preferred max for non-urgent orders
   GAS_URGENT_GWEI=80         # max for orders expiring within URGENT_WINDOW
   GAS_URGENT_WINDOW_S=3600   # orders expiring in <1h are "urgent"
   ```

2. **Tiered execution logic** (replace binary gate at lines 431-439):
   - Fetch current gas via `provider.getFeeData()`
   - If gas > `GAS_MAX_GWEI`: skip entire cycle (existing behaviour, but configurable)
   - If gas > `GAS_URGENT_GWEI`: only execute orders expiring within `GAS_URGENT_WINDOW_S`
   - If gas > `GAS_TARGET_GWEI`: execute urgent orders + DCA orders past due (dcaInterval elapsed > 2x)
   - If gas ≤ `GAS_TARGET_GWEI`: execute all eligible orders (current normal behaviour)

3. **Explicit gas parameters on transactions** (update executeOrder call ~line 443):
   - Use EIP-1559 fields: `maxFeePerGas` and `maxPriorityFeePerGas`
   - `maxFeePerGas` = min(currentBaseFee * 1.25 + priorityFee, maxGweiForTier)
   - `maxPriorityFeePerGas` = min(feeData.maxPriorityFeePerGas, parseGwei("2"))
   - This prevents overpaying during gas spikes

4. **Enhanced logging**:
   - Log gas tier decision per cycle: `[GAS] baseFee=X gwei | tier=NORMAL|ELEVATED|URGENT_ONLY|SKIP | eligible=N orders`
   - Log per-order: `[GAS] order ${id} | maxFee=${X} gwei | priority=${Y} gwei`

5. **Monitoring extension** (update `monitor.js`):
   - New metric: `teraswap_executor_gas_skipped_cycles_total` — count of cycles skipped due to gas
   - New metric: `teraswap_executor_gas_tier` — gauge with current tier label (0=normal, 1=elevated, 2=urgent_only, 3=skip)

6. **Backward compatibility**: If no GAS_* env vars are set, fall back to current behaviour (MAX_GAS_PRICE_GWEI = 100, binary gate). Existing `.env.executor` files continue to work without changes.

**Files affected:** `executor.js` (gas logic + tx params), `monitor.js` (2 new metrics), `.env.executor.example` (4 new vars), `ecosystem.config.cjs` (document new vars)

**Expected output:** Executor adapts to gas conditions instead of binary skip. Urgent orders execute at higher gas. Non-urgent orders wait for cheaper gas.

**Quality criteria:** Default behaviour unchanged if env vars absent. Urgent orders (expiry < 1h) execute up to 80 gwei. Normal orders wait for ≤30 gwei. Absolute cap at 100 gwei (configurable). Prometheus metrics expose gas tier. Logs show tier decisions.

---

### PROMPT 14 — Sprint 3: Micro-Fixes (Audit Sprint 3 Response)

**Context:** Security audit of Sprint 3 commits identified 3 minor issues requiring fixes. Two are comment corrections, one is defensive hardening.

**Requirements:**

1. **Signature format validation** (`src/app/api/orders/route.ts`):
   - Before the existing `!body.signature` truthiness check, add explicit format validation:
   - Signature must match regex `/^0x[0-9a-fA-F]{130}$/` (65 bytes = 130 hex chars + 0x prefix)
   - If invalid format, return 400 with `{ error: 'Invalid signature format' }`
   - This goes BEFORE the `recoverTypedDataAddress` call

2. **Fix "Take-profit" comment** (`contracts/order-engine/executor/executor.js`):
   - Find the comment that says: `// Take-profit: orderType 1 + condition 0 (ABOVE)`
   - Replace with: `// Stop-Loss with ABOVE condition (functionally a take-profit) — opportunity, not emergency`

3. **Fix retrocompat comment** (`contracts/order-engine/executor/executor.js`):
   - Find the comment that says defaults maintain previous behavior (or similar near the GAS_TIER config block around line 100)
   - Replace with: `// Defaults preserve 100 gwei ceiling but add tiered filtering: NORMAL ≤30, ELEVATED ≤80, URGENT ≤100. Orders below ceiling but above their tier threshold may be deferred — this is intentional.`

**Files affected:** `src/app/api/orders/route.ts` (1 validation block added), `contracts/order-engine/executor/executor.js` (2 comments corrected)

**Expected output:** 3 surgical changes, no logic changes beyond the signature regex.

**Quality criteria:** `npm run build` passes. Invalid signatures rejected with 400 before reaching viem. Comments accurately describe behavior.

---

## SPRINT 4 — Eixo A: Segurança (Recomendações do Auditor)

Sprint 4 endereça as recomendações de segurança R1-R12 do relatório consolidado de auditoria, priorizadas por RICE. R2 (exact approvals) confirmado como já implementado — sai do scope.

**Fase A (Manual — TeraHash):** R3 (`ignore-scripts`), R4 (2FA), R9 (multisig migration)
**Fase B (Prompts):** R7 (lockfile-lint), R1 (recipient validation), R6+R8 (monitoring), R12 (progressive timelock)
**Fase C:** Auditoria focada nos Prompts 16 + 18

---

### PROMPT 15 — Sprint 4: Lockfile Integrity & Version Pinning (R7)

**Context:** The project uses `npm ci` in all CI workflows but without `--ignore-scripts`, allowing arbitrary postinstall scripts from compromised packages to execute. Additionally, 15 dependencies use caret ranges (`^`) instead of exact versions, and there's no lockfile integrity checking. The Ledger Connect Kit hack (2023) exploited exactly this vector — a compromised npm account published malicious versions that ran wallet-draining code via postinstall scripts.

**Objective:** Harden the npm supply chain: add `ignore-scripts` to `.npmrc`, add lockfile-lint to CI, and pin security-critical dependencies to exact versions.

**Requirements:**

1. **`.npmrc`** — add `ignore-scripts=true` on a new line (keep existing `legacy-peer-deps=true`):
   ```
   legacy-peer-deps=true
   ignore-scripts=true
   ```

2. **Pin security-critical dependencies** in `package.json` — remove caret (`^`) for:
   - `viem` — crypto library, signature verification, ABI encoding
   - `wagmi` — wallet interaction, transaction signing
   - `@supabase/supabase-js` — database with RLS, auth tokens
   - `@vercel/kv` — rate limiting store
   - `@sentry/nextjs` — error reporting with source maps
   - Keep caret for non-critical deps: `framer-motion`, `@capacitor/*`, `next`, `postcss`
   - For each dep being pinned: replace `"^X.Y.Z"` with `"X.Y.Z"` (use the version already in package-lock.json)

3. **Install lockfile-lint** as devDependency:
   ```bash
   npm install --save-dev lockfile-lint
   ```

4. **Add lockfile-lint check to CI** (`.github/workflows/ci.yml`) — new job `lockfile` running in parallel with lint/typecheck/audit:
   ```yaml
   lockfile:
     runs-on: ubuntu-latest
     steps:
       - uses: actions/checkout@v4
       - name: Validate lockfile integrity
         run: npx lockfile-lint --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity
   ```

5. **Verify `ignore-scripts` doesn't break the build**:
   - Run `npm ci` locally — if any package needs postinstall (e.g., `@sentry/cli`, `esbuild`), add explicit allow in `.npmrc`:
     ```
     ; Allow specific lifecycle scripts
     ; @sentry/cli:install=true
     ```
   - Run `npm run build` to confirm nothing breaks

**Files affected:** `.npmrc` (1 line added), `package.json` (5 deps pinned), `.github/workflows/ci.yml` (1 new job), `package-lock.json` (regenerated)

**Expected output:** Lockfile integrity validated in CI. Security-critical deps pinned. Postinstall scripts blocked by default.

**Quality criteria:** `npm ci` succeeds with `ignore-scripts=true`. `npm run build` passes. lockfile-lint job passes in CI. `grep '"\\^"' package.json` returns zero matches for viem, wagmi, supabase, vercel/kv, sentry.

---

### PROMPT 16 — Sprint 4: Recipient Validation in Swap Calldata (R1)

**Context:** The TeraSwap API (`/api/swap/route.ts`) validates the 4-byte function selector of router calldata (SC-04), but does NOT validate the recipient parameter embedded in the calldata. If an external aggregator API is compromised or returns tampered calldata, the swap could send tokens to an attacker-controlled address instead of the user. The 1inch hack (March 2025, $5M) exploited this exact vector: calldata parameters were corrupted to redirect swap output to the attacker.

The adapters correctly set recipient=from when building API requests, but there's no downstream verification that the returned calldata actually contains the correct recipient.

**Objective:** Add recipient extraction and validation for all 18 whitelisted swap selectors. Reject calldata where the decoded recipient doesn't match the user's address.

**Requirements:**

1. **Create `src/lib/calldata-validator.ts`** — a module that decodes recipient from calldata:
   ```typescript
   export function extractRecipient(calldata: string, selector: string): string | null
   ```
   - For each whitelisted selector, define the ABI parameter offset where `recipient` (or `to`, `receiver`, `dest`) lives
   - Selector → recipient extraction map:
     - `0x12aa3caf` (1inch swap): ABI decode, param index 2 is `desc.dstReceiver` — this is a struct, decode as tuple and extract offset
     - `0xe449022e` (1inch unoswapTo): param 0 is recipient
     - `0x0502b1c5`, `0x2e95b6c8` (1inch uniswapV3): recipient embedded in path, skip validation (return null)
     - `0xd9627aa4` (0x sellToUniswap): no explicit recipient (goes to msg.sender), return null
     - `0x415565b0` (0x transformERC20): no explicit recipient (goes to msg.sender), return null
     - `0x3598d8ab`, `0xa94e78ef`, `0x46c67b6d` (Paraswap): beneficiary in struct, decode tuple
     - `0x83800a8e` (Odos swap): param 1 is executor, param 3 is `pathDefinition` — recipient is the caller via msg.sender, return null
     - `0xe21fd0e9` (KyberSwap): recipient set in API, verify in decoded params
     - `0xac9650d8`, `0x5ae401dc` (Uniswap multicall): decode inner calls, extract recipient from first swap call
     - `0x04e45aaf` (Uniswap exactInputSingle): param index 0 is struct with `recipient` field
     - `0xb858183f` (Uniswap exactInput): param index 0 is struct with `recipient` field
     - `0x472b43f3` (Uniswap V2 swapExactTokensForTokens): param 2 is `to`
     - `0x38ed1739` (SushiSwap swapExactTokensForTokens): param 3 is `to`
     - `0x7ff36ab5` (swapExactETHForTokens): param 1 is `to`
     - `0x18cbafe5` (swapExactTokensForETH): param 3 is `to`
   - Use `import { decodeFunctionData } from 'viem'` for ABI decoding
   - Return `null` for selectors where recipient cannot be extracted (msg.sender-based) — these are safe because msg.sender IS the FeeCollector/OrderExecutor
   - Return lowercase address string for selectors where recipient is extractable

2. **Create `src/lib/calldata-validator.test.ts`** — unit tests:
   - Test at least 5 selectors with known good calldata (encode with viem, then verify extraction)
   - Test that unknown selector returns null
   - Test that corrupted calldata returns null (not throws)

3. **Integrate in `/api/swap/route.ts`** — after the SC-04 selector check:
   ```typescript
   // [R1] Validate recipient in calldata matches sender
   const recipient = extractRecipient(result.tx.data, selector)
   if (recipient && recipient.toLowerCase() !== from.toLowerCase()) {
     console.warn('[R1] Recipient mismatch:', { expected: from, found: recipient, source })
     return NextResponse.json(
       { error: 'Calldata recipient does not match sender', tag: '[R1]' },
       { status: 400 }
     )
   }
   ```

4. **Integrate in `src/hooks/useSwap.ts`** — client-side defense-in-depth:
   - After the existing `isKnownSwapSelector` check, add recipient validation
   - If mismatch, throw error (prevents wallet prompt)

5. **Do NOT modify smart contracts** — this is API/frontend layer only. The OrderExecutor already sends output to `order.owner` regardless of calldata recipient (defense-in-depth).

**Files affected:** New `src/lib/calldata-validator.ts`, new `src/lib/calldata-validator.test.ts`, update `src/app/api/swap/route.ts`, update `src/hooks/useSwap.ts`

**Expected output:** Calldata recipient validated for ~12 of 18 selectors. Remaining 6 are msg.sender-based (inherently safe). Tampered calldata rejected with 400.

**Quality criteria:** `npm run build` passes. Unit tests cover 5+ selectors. API rejects calldata with wrong recipient. Selectors where extraction is impossible return null (no false positives). No behavioral change for legitimate swaps.

---

### PROMPT 17 — Sprint 4: On-Chain Event Monitoring & Price Guard Alerts (R6 + R8)

**Context:** The TeraSwapOrderExecutor emits events for all admin actions (`TimelockQueued`, `TimelockExecuted`, `TimelockCancelled`, `AdminTransferred`, `RouterWhitelisted`, `Paused`, `Unpaused`, `SweepQueued`), but nothing monitors them. The Drift Protocol hack ($285M, April 2026) succeeded because admin changes went undetected. Additionally, the DefiLlama price guard can block high-value swaps, but consecutive blocks (suggesting oracle manipulation or market anomaly) don't trigger any alert.

The executor already has a Telegram alerting module (`contracts/order-engine/executor/alert.js`) and a monitoring class (`contracts/order-engine/executor/monitor.js`). We extend this infrastructure.

**Objective:** Add an on-chain event watcher that monitors admin events and sends Telegram alerts. Add consecutive price-guard-block detection to the API.

**Requirements:**

1. **Create `contracts/order-engine/executor/event-watcher.js`** — standalone module:
   - Uses viem's `watchContractEvent` (or polling `getContractEvents` every 30s) on the OrderExecutor contract
   - Monitors events: `TimelockQueued`, `TimelockExecuted`, `TimelockCancelled`, `AdminTransferred`, `RouterWhitelisted`, `Paused`, `Unpaused`, `SweepQueued`
   - On any event detection: call `sendTelegramAlert()` with formatted message including:
     - Event name
     - Decoded parameters (actionId, router address, new admin, etc.)
     - Block number and transaction hash
     - Etherscan link
   - `TimelockQueued` alerts should include the `readyAt` timestamp formatted as human-readable date + "Execute window opens in X hours"
   - `AdminTransferred` and `Paused` should be marked as 🔴 CRITICAL in the alert
   - Config via env vars: `ORDER_EXECUTOR_ADDRESS` (already exists), `RPC_URL` (already exists)
   - Exports a `startEventWatcher(client)` function that takes a viem publicClient
   - Graceful error handling: if RPC disconnects, retry with exponential backoff (max 5 retries, then alert and continue)

2. **Integrate event watcher into executor** (`contracts/order-engine/executor/executor.js`):
   - Import and call `startEventWatcher(publicClient)` during executor initialization
   - The watcher runs in parallel with the order execution loop (non-blocking)

3. **Add price guard consecutive block detection** (`src/lib/defillama.ts`):
   - Track consecutive price guard blocks in-memory (Map<tokenPair, { count, firstBlockAt }>)
   - After 3 consecutive blocks for the same token pair within 10 minutes:
     - Log `[PRICE-GUARD] Consecutive blocks detected: ${tokenPair}, count: ${count}`
     - If Vercel KV is available, increment a counter: `price-guard:consecutive:${tokenPair}`
   - Reset counter on successful (non-blocked) validation for that pair

4. **Create alert endpoint** (`src/app/api/internal/alerts/route.ts`):
   - POST endpoint accepting `{ type: 'price-guard-consecutive', tokenPair, count, firstBlockAt }`
   - Protected by `Authorization: Bearer ${INTERNAL_ALERT_SECRET}` header
   - Forwards to Telegram via the same bot token (env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)
   - Rate limited: max 1 alert per token pair per 10 minutes

5. **Prometheus metrics** (update `monitor.js`):
   - New counter: `teraswap_executor_admin_events_total{event_type}` — counts each admin event seen
   - New gauge: `teraswap_executor_last_admin_event_timestamp` — Unix timestamp of most recent admin event

**Files affected:** New `contracts/order-engine/executor/event-watcher.js`, update `executor.js` (import + init), update `src/lib/defillama.ts` (consecutive tracking), new `src/app/api/internal/alerts/route.ts`, update `monitor.js` (2 metrics), update `.env.executor.example` (no new vars needed, uses existing)

**Expected output:** All admin events trigger Telegram alerts within 30s. Consecutive price guard blocks (≥3) logged and alerted. Prometheus tracks admin event counts.

**Quality criteria:** `npm run build` passes. Event watcher starts without errors when executor boots. TimelockQueued alert includes human-readable execute window. AdminTransferred marked as CRITICAL. Price guard consecutive counter resets on success. Alert endpoint rate-limited.

---

### PROMPT 18 — Sprint 4: Progressive Timelock & FeeCollector Admin Hardening (R12)

**Context:** The TeraSwapOrderExecutor has a flat 48h timelock for all admin actions (router changes, admin transfer, sweeps). The TeraSwapFeeCollector has NO timelock at all — `setRouter()`, `pause()`, `unpause()`, and `sweep()` are all immediate. The Drift Protocol hack ($285M) showed that admin transfer and security-critical operations need longer timelocks than routine changes.

**Objective:** Implement progressive timelock in the OrderExecutor (different delays per action type) and add basic timelock to the FeeCollector's router management.

**Requirements:**

1. **TeraSwapOrderExecutor — Progressive Timelock:**
   - Replace single `TIMELOCK_DELAY = 48 hours` with action-specific delays:
     ```solidity
     uint256 public constant TIMELOCK_ADMIN_TRANSFER = 7 days;   // R12: highest-impact action
     uint256 public constant TIMELOCK_ROUTER_CHANGE = 48 hours;  // Existing behavior preserved
     uint256 public constant TIMELOCK_SWEEP = 48 hours;          // Existing behavior preserved
     ```
   - Update `queueAdminChange()` to use `TIMELOCK_ADMIN_TRANSFER` instead of `TIMELOCK_DELAY`
   - Update `queueRouterChange()` to use `TIMELOCK_ROUTER_CHANGE`
   - Update `queueSweep()` to use `TIMELOCK_SWEEP`
   - Keep `TIMELOCK_GRACE = 7 days` unchanged
   - Add new constant visibility: `function getTimelockDelays() external pure returns (uint256 adminTransfer, uint256 routerChange, uint256 sweep)`

2. **TeraSwapFeeCollector — Add Router Timelock:**
   - Add timelock mechanism for `setRouter()`:
     ```solidity
     uint256 public constant TIMELOCK_DELAY = 48 hours;
     uint256 public constant TIMELOCK_GRACE = 7 days;

     struct TimelockAction {
         bytes32 actionHash;
         uint256 readyAt;
         bool exists;
     }

     mapping(bytes32 => TimelockAction) public timelockActions;

     event TimelockQueued(bytes32 indexed actionId, bytes32 actionHash, uint256 readyAt);
     event TimelockExecuted(bytes32 indexed actionId);
     event TimelockCancelled(bytes32 indexed actionId);
     ```
   - Replace immediate `setRouter()` with `queueRouterChange()` + `executeRouterChange()`
   - Keep `pause()` and `unpause()` as immediate (emergency functions must not be timelocked)
   - Keep `sweep()` as immediate but add requirement: `require(paused, "Must pause before sweep")` — this is already the case, confirm and document

3. **Update Foundry tests:**
   - Test that admin transfer now requires 7 days (not 48h)
   - Test that router change still works at 48h
   - Test that admin transfer at 48h reverts with `TimelockNotReady`
   - Test FeeCollector router timelock: queue → wait → execute flow
   - Test FeeCollector router timelock: execute before delay reverts
   - Test FeeCollector pause/unpause remain immediate

4. **Update deployment scripts** if they reference `TIMELOCK_DELAY`:
   - Check `deploy.js`, `deploy-sepolia.js`, `bootstrap.js` for hardcoded timelock references
   - The bootstrap function should still work (it's one-time, pre-timelock)

**Files affected:** `contracts/order-engine/TeraSwapOrderExecutor.sol` (constants + queue functions), `contracts/TeraSwapFeeCollector.sol` (add timelock mechanism), Foundry test files, possibly deploy scripts

**Expected output:** Admin transfer requires 7-day wait. Router changes require 48h. FeeCollector router changes now timelocked. Emergency pause remains immediate.

**Quality criteria:** All existing Foundry tests pass. New tests cover progressive delays. `forge test -vvv` shows 7-day admin transfer and 48h router change. FeeCollector timelock queue/execute/cancel works correctly. No breaking changes to existing signed orders (EIP-712 domain unchanged).

---

### FASE A — Acções Manuais (TeraHash)

#### R3: ignore-scripts no .npmrc
Já incluído no Prompt 15. O coder trata disto.

#### R4: 2FA Obrigatório
1. **GitHub:** Settings → Password and authentication → Two-factor authentication → Enable
2. **Vercel:** Settings → Security → Enforce 2FA for all team members

#### R9: Migração para Gnosis Safe Multisig (2-of-3)

**Pré-requisitos:** 2 wallets adicionais de confiança (hardware wallets recomendadas). A admin wallet actual do TeraSwap será uma das 3.

**Passo-a-passo:**

1. Ir a [app.safe.global](https://app.safe.global) → Create New Safe
2. Network: Ethereum Mainnet (ou Sepolia para teste primeiro)
3. Adicionar 3 owners:
   - Owner 1: Admin wallet actual do TeraSwap
   - Owner 2: Segunda wallet (hardware wallet recomendada)
   - Owner 3: Terceira wallet (hardware wallet recomendada)
4. Threshold: 2 of 3 (qualquer 2 precisam de assinar)
5. Deploy o Safe (custa gas)
6. Anotar o endereço do Safe criado

**Transferir Admin do OrderExecutor:**
7. Com a admin wallet actual, chamar `queueAdminChange(SAFE_ADDRESS)` no contrato
8. Esperar 48h (ou 7 dias se o Prompt 18 já estiver deployed)
9. Chamar `executeAdminChange(actionId, SAFE_ADDRESS)`
10. Verificar: `admin()` retorna o endereço do Safe

**Transferir Admin do FeeCollector:**
11. O FeeCollector actual não tem `transferAdmin` — este é um gap. Se o Prompt 18 adicionar timelock ao FeeCollector, poderá também adicionar admin transfer. Caso contrário, o admin do FeeCollector fica como está até upgrade.

**Validação:**
12. Via Safe UI, testar: queue router change → confirmar com 2 wallets → executar
13. Verificar que operações com 1 assinatura são rejeitadas

---

## 8. PARECER ARQUITECTURAL — AUDITORIA DE SEGURANÇA (v2.0)

### 8.1 Contexto

O Auditor de Segurança produziu um relatório com 15 findings. O Coder respondeu classificando 5 como falso positivo, 2 como corrigidos, e o resto como mitigado/aceite. O Arquitecto verificou cada claim contra o codebase actual.

### 8.2 Veredicto por Finding

| ID | Auditor Disse | Coder Disse | Arquitecto Confirma | Notas |
|----|-------------|------------|-------------------|-------|
| OPS-01 | CRÍTICO (.env no repo) | Falso positivo | ✅ **Coder correcto** | `.env` nunca no git. 14 padrões no `.gitignore`. Auditor confundiu ficheiro local com tracked. |
| EX-01 | CRÍTICO (plaintext key) | Corrigido (539bd02) | ✅ **Coder correcto** | Hard-fail implementado. MAS: `.env.executor` local tem config incompatível — questão operacional. |
| SC-04 | ALTO (calldata arbitrária) | Mitigado 3 camadas | ⚠️ **Parcial** | routerDataHash + timelock + frontend selectors existem. MAS selectors são client-side only — gap real. |
| INT-01 | ALTO (oracle manipulation) | Parcialmente mitigado | ⚠️ **Coder oversells** | DefiLlama é non-blocking. Cross-quote median é informacional. minAmountOut é a protecção real. |
| API-01 | ALTO (rate limiting) | Aceite para testnet | ✅ **Concordância** | Redis antes de mainnet. |
| SC-01 | MÉDIO (fee precision) | Mitigado (MIN_ORDER_AMOUNT) | ✅ **Coder correcto** | Root cause (rounding) não eliminada, mas contornada eficazmente. |
| SC-02 | MÉDIO (DCA truncation) | Known issue | ✅ **Aceitável** | Dust loss ≈ $0.00002/1000 ordens. DCAChunkTooSmall validation existe. |
| SC-03 | MÉDIO (timelock deadline) | Falso positivo | ✅ **Coder correcto** | TIMELOCK_GRACE = 7 days implementado. Auditor não viu o código. |
| API-02 | MÉDIO (sem min amount) | Parcial | ⚠️ **Gap real** | Contrato tem MIN_ORDER_AMOUNT, mas API aceita 1-9999 → ghost orders. |
| SC-05 | BAIXO (nonce sem bound) | Falso positivo | ✅ **Coder correcto** | NonceTooHigh (+1000) implementado. |
| API-03 | BAIXO (tokenIn==tokenOut) | Falso positivo | ✅ **Coder correcto** | Validação existe linha 85-87 de orders/route.ts. |
| FE-01 | BAIXO (localStorage) | Aceite | ✅ **Aceitável** | Web Crypto API em V2. |
| FE-02 | BAIXO (supply chain) | Mitigado (npm audit) | ⚠️ **Incompleto** | Fix pontual, sem automação contínua (sem Dependabot). |
| EX-02 | BAIXO (gas cap) | Documentado | ✅ **Aceitável** | Configurável via env var. |

### 8.3 O que Ninguém Viu

1. **Selector validation é client-side only** — o `/api/swap` e o FeeCollector não validam function selectors. Para instant swaps (não orders), não há routerDataHash.
2. **DefiLlama fail-open para qualquer valor** — swaps de $100k passam sem segunda validação se DefiLlama estiver em baixo.
3. **Sem Dependabot** — o `npm audit fix` foi manual. Sem automação.
4. **Config do executor inconsistente** — `.env.executor` local tem CHAIN_ID=1 + plaintext key + sem KMS. Com o hard-fail novo, esta config não arranca. A config real de produção não está documentada.
5. **API aceita ordens sub-minimum** — gap entre API validation (>0) e contract validation (>=10,000).

### 8.4 Classificação Final

**APPROVED WITH WARNINGS** — concordo com a classificação revista do coder.

**Condições pré-mainnet obrigatórias:**
1. Server-side selector validation implementada (Sprint 0)
2. Rate limiting persistente (Sprint 1)
3. Dependabot/scanning contínuo (Sprint 0)
4. Config do executor documentada e verificável (Sprint 0)
5. API minimum amount alinhado com contrato (Sprint 0)

**Condições recomendadas:**
6. DefiLlama blocking para high-value swaps (Sprint 1)
7. Supabase RLS nos analytics tables (Sprint 0)

---

## APÊNDICE A — Glossário de Decisões Arquitecturais

| Decisão | Justificação | Alternativa Rejeitada | Razão |
|---------|-------------|----------------------|-------|
| Híbrido on-chain/off-chain para orders | Gasless order creation, custo zero até execução | Fully on-chain (Seaport-style) | Gas proibitivo para criação de ordens |
| Self-hosted executor vs Gelato | Gelato Web3 Functions descontinuado (Março 2026) | Chainlink Automation | Custo por execução mais elevado |
| Supabase vs custom backend | Rapidez de desenvolvimento + real-time built-in | PostgreSQL + WebSockets custom | Overhead de infra para equipa pequena |
| 11 fontes de liquidez | Maximizar output por swap | Single source (ex: só 1inch) | Não garante melhor preço |
| FeeCollector proxy pattern | Controlo de fee sem modificar routers | Wrapper around each router | Multiplicação de contratos |
| Imutabilidade contratual (sem proxy) | Simplicidade + segurança (no DELEGATECALL risks) | UUPS/Transparent Proxy | Complexidade + attack surface |

## APÊNDICE B — Matriz de Dependências entre Sprints

```
Sprint 0 (Hardening, 0.5 sem)
    │
    ├──→ Sprint 1 (Infra, 1.5 sem) ──→ Sprint 2 (Quality, 2 sem) ──→ Sprint 3 (Polish, 1.5 sem)
    │                                                                        │
    │                                                                        └──→ Sprint 4 (Multi-Chain, 3 sem)
    │
    └──→ Sprint 1 pode iniciar parcialmente em paralelo (CI/CD + monitoring
         não dependem de Sprint 0, apenas rate limiting depende)
```

**Parallelizable:**
- Sprint 0 (all items) — independent, can be done in any order
- Sprint 1 CI/CD + Sprint 1 monitoring (different areas)
- Sprint 2 E2E tests + Sprint 2 runbooks (different skills)
- Sprint 3 UI polish + Sprint 3 gas strategy (frontend vs executor)

**Strictly Sequential:**
- Sprint 0 → Sprint 1 rate limiting (needs stable deploy first)
- Sprint 2 refactor → Sprint 2 circuit breaker (needs adapter pattern first)
- Sprint 3 → Sprint 4 (clean codebase before multi-chain)

---

*Documento gerado por Arquitecto Principal — TeraSwap Project.*
*v2.0 — Revisão pós-auditoria de segurança, 2 de Abril de 2026.*
*Próxima revisão: após conclusão de Sprint 0.*
