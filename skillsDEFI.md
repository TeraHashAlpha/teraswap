# TeraSwap — Skills DeFi Reference

> Documento de referência completo do projecto TeraSwap.
> Usar como contexto sempre que retomar trabalho neste projecto.
> **Última actualização:** 28 Fev 2026

---

## 1. Visão Geral

**TeraSwap** é um DEX meta-aggregator na Ethereum mainnet construído com Next.js 14 (App Router), TypeScript, wagmi v2, viem, e RainbowKit. A UI segue o branding TeraHelps (cream-on-black) com particle network background animado.

O meta-aggregator consulta **11 fontes de liquidez** em paralelo (7 aggregator APIs + 4 DEX directos on-chain), compara preços com **gas-aware ranking** e **detecção estatística de outliers** (mediana verdadeira), e executa via a fonte que oferece o melhor output líquido. Inclui proteção MEV via CoW Protocol, Chainlink price feeds para validação, sistema Permit2/EIP-2612 para approvals gasless, auto fee tier detection para Uniswap V3, slippage safety clamp em todas as sources, EIP-712 chainId dinâmico, sistema de Active Approvals com revoke, **Smart DCA engine** com buying windows price-aware via Chainlink historical prices, e **Limit Orders** via CoW Protocol (zero gas, partially fillable, expiry configurável).

---

## 2. Stack Técnica

| Camada | Tecnologia |
|---|---|
| Framework | Next.js 14 (App Router, TypeScript) |
| Blockchain | wagmi v2 + viem (Ethereum mainnet) |
| Wallet | RainbowKit + WalletConnect (Reown) |
| Styling | Tailwind CSS (cream-on-black custom theme) |
| State | Zustand (approval tracking, swap history) |
| Price Feeds | Chainlink on-chain oracles |
| Approvals | Permit2 + EIP-2612 + exact approve fallback |
| Deploy | Vercel (vercel.json configurado) |
| RPC | Alchemy (eth-mainnet) |

---

## 3. Arquitectura de Ficheiros

```
dex-aggregator/
├── src/
│   ├── app/
│   │   ├── layout.tsx          # RainbowKit + wagmi providers, global styles
│   │   ├── page.tsx            # Landing ↔ Swap routing (useState)
│   │   ├── admin/page.tsx      # ★ Private admin route (/admin?key=SECRET) — Bloomberg monitor
│   │   └── globals.css         # Tailwind + custom cream theme variables
│   ├── components/
│   │   ├── ParticleNetwork.tsx  # Canvas animated background (TeraHelps style)
│   │   ├── LandingPage.tsx      # Hero + CTA "Launch App" + Features (12 cards incl. 11 sources, MEV, DCA, limits, SL/TP, split, analytics, approvals)
│   │   ├── DocsPage.tsx         # Full docs: architecture, 11 sources, smart routing (7 steps), limit orders, security, roadmap
│   │   ├── Header.tsx           # Logo + wallet connect button
│   │   ├── Footer.tsx           # Links + branding
│   │   ├── SwapBox.tsx          # Main swap interface (input/output/quote/execute)
│   │   ├── SwapButton.tsx       # Smart button (connect/approve/swap/CoW states)
│   │   ├── QuoteBreakdown.tsx   # Quote details + MEV/Direct badges + source comparison
│   │   ├── TokenSelector.tsx    # Token picker dropdown
│   │   ├── SlippageModal.tsx    # Slippage settings popup (clamped 0.01%-49.99%)
│   │   ├── SwapHistory.tsx      # Local swap history (localStorage)
│   │   ├── DCAPanel.tsx         # ★ DCA UI (create form, positions list, smart window status)
│   │   ├── LimitOrderPanel.tsx  # ★ Limit Orders UI (create form, active/history orders, cancel)
│   │   ├── ConditionalOrderPanel.tsx # ★ Stop Loss / Take Profit UI (SL/TP create + order cards)
│   │   ├── SplitRouteVisualizer.tsx # ★ Split route UI (allocation bar, leg details, toggle)
│   │   ├── AnalyticsDashboard.tsx # ★ Public analytics (volume, best routes, activity, trends)
│   │   ├── AdminMonitor.tsx     # ★ Private admin monitor v2 (Blockscout-style, 6 tabs, SVG charts, period filter)
│   │   ├── ActiveApprovals.tsx  # ★ Revoke UI — shows residual approvals with revoke buttons
│   │   ├── ToastProvider.tsx    # ★ Context-based toast system (loading/success/error/warning/info)
│   │   ├── Skeleton.tsx         # ★ Reusable skeleton loaders (SwapBoxSkeleton, QuoteBreakdownSkeleton)
│   │   ├── HelpButton.tsx       # ★ Floating "?" help button (bottom-right, animated spring)
│   │   ├── HelpDrawer.tsx       # ★ Slide-in FAQ panel (6 sections accordion, forced dark theme)
│   │   ├── CountdownGate.tsx    # Countdown overlay (disabled, kept for future use)
│   │   ├── WalletHistory.tsx    # ★ (Session 13) Etherscan API wallet history, last 25 txs, method parsing
│   │   └── TokenImportModal.tsx # ★ (Session 13) Custom token import form (paste address, auto-detect)
│   ├── hooks/
│   │   ├── useQuote.ts          # Meta-quote polling (15s refresh, debounced input)
│   │   ├── useSwap.ts           # Execute swap (standard tx OR CoW EIP-712 signing, dynamic chainId)
│   │   ├── useApproval.ts       # Permit2/EIP-2612/exact approve strategy
│   │   ├── useActiveApprovals.ts# ★ Zustand store — tracks approvals made via TeraSwap
│   │   ├── useDCAEngine.ts      # ★ DCA React hook — bridges dca-engine to component state
│   │   ├── useLimitOrder.ts     # ★ Limit order hook — create, sign, poll, cancel orders via CoW
│   │   ├── useConditionalOrder.ts # ★ SL/TP hook — Chainlink monitoring + auto CoW submission
│   │   ├── useSplitRoute.ts     # ★ Split route hook — analyzes multi-DEX splits for large trades
│   │   ├── useAnalytics.ts      # ★ Analytics hook — dashboard data + trackTrade bridge
│   │   ├── useChainlinkPrice.ts # On-chain price deviation check
│   │   ├── useEthGasCost.ts     # ★ ETH/USD + gas price hook (Chainlink + EIP-1559) for gas estimates
│   │   ├── useDebounce.ts       # Input debounce (500ms)
│   │   ├── useSwapHistory.ts    # localStorage swap records
│   │   ├── useTokenImport.ts    # ★ (Session 13) RPC ERC20 metadata fetcher (symbol, name, decimals)
│   │   └── useWalletHistory.ts  # ★ (Session 13) Etherscan API integration for wallet transaction history
│   └── lib/
│       ├── api.ts               # ALL 11 adapters + gas-aware sorting + outlier detection + slippage clamp + meta-orchestrator
│       ├── constants.ts         # Addresses, APIs, AGGREGATOR_META (11 sources), fee config, contracts
│       ├── tokens.ts            # Token list (ETH, WETH, USDC, USDT, DAI, WBTC, LINK, UNI)
│       ├── approvals.ts         # Permit2 ABI, EIP-2612 detection, approval planning
│       ├── chainlink.ts         # Chainlink price feed logic + fetchHistoricalPrice (binary search rounds)
│       ├── dca-types.ts         # ★ DCA TypeScript interfaces (DCAPosition, SmartWindowSnapshot, etc.)
│       ├── dca-engine.ts        # ★ DCA engine (smart window algorithm, localStorage persistence, events)
│       ├── limit-order-types.ts # ★ Limit order interfaces (LimitOrder, LimitOrderConfig, events)
│       ├── limit-order-api.ts   # ★ Limit order CoW API (submit, poll, cancel, price fetch)
│       ├── conditional-order-types.ts # ★ SL/TP types (ConditionalOrder, trigger direction, events)
│       ├── price-monitor.ts     # ★ Chainlink oracle price polling + trigger detection
│       ├── split-routing-types.ts # ★ Split route types, configs, eligible sources
│       ├── split-router.ts      # ★ Split routing optimizer engine (2-way, 3-way combos)
│       ├── analytics-types.ts   # ★ TradeEvent, WalletProfile, DashboardData, PeriodMetrics
│       ├── analytics-tracker.ts # ★ Event recording (localStorage) + dashboard aggregation engine
│       ├── sybil-detector.ts   # ★ Wash trading detection (6 heuristics + wallet clustering)
│       ├── sounds.ts            # Web Audio synthesized sounds (click, quote, swap, DCA buy, limit placed, error)
│       ├── format.ts            # ★ Thousand separator formatting (espaço a cada milhar)
│       ├── rate-limiter.ts      # ★ Sliding-window per-key rate limiter (globalLimiter, quoteLimiter, priceLimiter)
│       ├── source-monitor.ts    # ★ Per-aggregator health tracking (latency, success rate, degradation)
│       ├── help-content.ts      # ★ FAQ data (6 sections: Getting Started, Swaps, DCA, Limits, SL/TP, Security)
│       └── wagmiConfig.ts       # wagmi config (custom RPC + fallback RPC transport with rank:true)
├── scripts/
│   ├── fork-test.sh             # Anvil mainnet fork script
│   ├── deal-tokens.sh           # Fund test wallet with ERC20s from whale addresses
│   └── check-fee.sh             # Verify FEE_RECIPIENT balances
├── docs/
│   ├── E2E-FORK-TEST.md         # Comprehensive E2E test checklist (5 scenarios)
│   └── DEPLOY-GUIDE.md          # ★ Vercel + Supabase deploy step-by-step
├── skillsDEFI.md                # ← Este ficheiro (referência do projecto)
├── .env.local                   # API keys (1inch, 0x, Alchemy, WalletConnect, fee recipient)
├── vercel.json                  # Deploy config + security headers
├── tsconfig.json                # ES2020 target (BigInt support)
└── package.json                 # Scripts: dev, build, dev:fork, typecheck, fork, deal, check:fee
```

---

## 4. Fontes de Liquidez Integradas (11 fontes)

### 4.1 Aggregators API-based (7 fontes)

| # | Source Key | Label | API Base | Key Necessária | Modelo | MEV Protected |
|---|---|---|---|---|---|---|
| 1 | `1inch` | 1inch | `api.1inch.dev/swap/v6.0/1` | Sim (Bearer token) | AMM routing | Não |
| 2 | `0x` | 0x (Matcha) | `api.0x.org` | Sim (0x-api-key, v2) | Permit2 + AMM | Não |
| 3 | `velora` | Velora | `api.paraswap.io` | Não (partner: teraswap) | AMM + RFQ (v6.2) | Não |
| 4 | `odos` | Odos | `api.odos.xyz` | Não | Smart Router (**v3**) | Não |
| 5 | `kyberswap` | KyberSwap | `aggregator-api.kyberswap.com/ethereum` | Não (x-client-id) | AMM + PMM | Não |
| 6 | `cowswap` | CoW Protocol | `api.cow.fi/mainnet/api/v1` | Não | Intent-based + batch | **Sim** |
| 7 | `openocean` | OpenOcean | `open-api.openocean.finance/v4/1` | Não | AMM routing | Não |

### 4.2 DEX Directos On-Chain (4 fontes)

| # | Source Key | Label | Contratos / API | Modelo | Fee Handling |
|---|---|---|---|---|---|
| 8 | `uniswapv3` | Uniswap V3 | QuoterV2 + SwapRouter02 | Direct AMM (auto fee tier) | Fee deduzida do amountIn |
| 9 | `sushiswap` | SushiSwap | `production.sushi.com/swap/v5` | RouteProcessor | API-based routing |
| 10 | `balancer` | Balancer V2 | `api.balancer.fi/sor` | Smart Order Router | API-based routing |
| 11 | `curve` | Curve Finance | CurveRouterNG on-chain | Direct AMM (pool registry) | On-chain `get_dy` / `exchange` |

### 4.3 AGGREGATOR_META (em constants.ts)

```typescript
export const AGGREGATOR_META = {
  '1inch':     { label: '1inch',          mevProtected: false, intentBased: false, isDirect: false },
  '0x':        { label: '0x (Matcha)',     mevProtected: false, intentBased: false, isDirect: false },
  velora:      { label: 'Velora',          mevProtected: false, intentBased: false, isDirect: false },
  odos:        { label: 'Odos',            mevProtected: false, intentBased: false, isDirect: false },
  kyberswap:   { label: 'KyberSwap',       mevProtected: false, intentBased: false, isDirect: false },
  cowswap:     { label: 'CoW Protocol',    mevProtected: true,  intentBased: true,  isDirect: false, estimatedTime: 30 },
  uniswapv3:   { label: 'Uniswap V3',     mevProtected: false, intentBased: false, isDirect: true  },
  openocean:   { label: 'OpenOcean',       mevProtected: false, intentBased: false, isDirect: false },
  sushiswap:   { label: 'SushiSwap',       mevProtected: false, intentBased: false, isDirect: false },
  balancer:    { label: 'Balancer V2',     mevProtected: false, intentBased: false, isDirect: false },
  curve:       { label: 'Curve Finance',   mevProtected: false, intentBased: false, isDirect: true  },
} as const
```

### 4.4 Detalhes de cada adapter

**1inch** — `fetch1inchQuote()` / `fetch1inchSwap()`
- Endpoint: `/quote` e `/swap`
- Auth: `Authorization: Bearer {key}`
- Fee: `fee` param + `referrerAddress`
- Response: `data.toAmount`, `data.protocols`, `data.tx`

**0x** — `fetch0xQuote()` / `fetch0xSwap()`
- Endpoint: `/swap/permit2/quote` (API v2)
- Auth: `0x-api-key` + `0x-version: v2` headers
- Slippage: `slippageBps` (basis points)
- Spender: Permit2 contract (`0x000000000022D473030F116dDEE9F6B43aC78BA3`)
- Response: `data.buyAmount`, `data.route.fills`, `data.transaction`

**Velora (ex-ParaSwap)** — `fetchVeloraQuote()` / `fetchVeloraSwap()`
- Endpoint: `/prices` (com `version=6.2`) + `POST /transactions/{chainId}`
- Fee: `partner=teraswap` + `partnerFeeBps` + `partnerAddress`
- Slippage: bps no body do POST
- Spender: TokenTransferProxy (via `/adapters/contracts`)
- Two-step: price route → build tx

**Odos** — `fetchOdosQuote()` / `fetchOdosSwap()`
- Endpoint: `POST /sor/quote/v3` + `POST /sor/assemble` **(migrado para v3)**
- Body v3: inclui `simple: false`, `disableRFQs: false`
- Multi-token capable (inputTokens/outputTokens arrays)
- Response: `data.outAmounts[0]`, `data.pathId`, `data.gasEstimate`
- Spender: **Router V3 hardcoded** (`0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05`)

**KyberSwap** — `fetchKyberSwapQuote()` / `fetchKyberSwapSwap()`
- Endpoint: `/api/v1/routes` + `POST /api/v1/route/build`
- Auth: `x-client-id: teraswap`
- Native ETH → WETH conversion automática
- Slippage: `slippageTolerance` em bps
- Spender: `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`

**CoW Protocol** — `fetchCowSwapQuote()` / `fetchCowSwapOrder()`
- **Fluxo intent-based (diferente dos outros):**
  1. `POST /quote` — obter quote + order params
  2. User assina EIP-712 (domain: "Gnosis Protocol v2", contract: GPv2Settlement)
  3. `POST /orders` — submeter ordem assinada ao orderbook
  4. `GET /orders/{uid}` — polling até fulfillment (~30s)
  5. `GET /trades?orderUid={uid}` — obter txHash do settlement
- Gasless para o user (solver paga gas)
- MEV protected (batch auctions eliminam frontrunning)
- Spender: GPv2VaultRelayer (`0xC92E8bdf79f0507f65a392b0ab4667716BFE0110`)
- Settlement: GPv2Settlement (`0x9008D19f58AAbD9eD0D60971565AA8510560ab41`)
- **⚠️ Deixa infinite allowance** no VaultRelayer → tracked pelo sistema Active Approvals

**Uniswap V3 Direct** — `fetchUniswapV3Quote()` / `fetchUniswapV3Swap()`
- **Fluxo on-chain directo (sem API externa):**
  1. Deduz platform fee (0.1%) do `amountIn` → `netAmount`
  2. `detectUniswapV3FeeTier()` — testa 4 fee tiers em paralelo via `eth_call` ao QuoterV2
  3. Selecciona bestFee por `amountOut` com gas tie-breaker
  4. Cache em memória (Map, TTL 45 min) — evita re-detecção no swap
  5. Constrói calldata: `exactInputSingle` → `multicall(deadline, [data])`
  6. Tx enviada ao SwapRouter02
- **NormalizedQuote.meta** popula `uniswapV3Fee`, `uniswapV3Candidates[]`, `uniswapV3Reason`
- **Fee tiers**: `[100, 500, 3000, 10000]` → `[0.01%, 0.05%, 0.3%, 1%]`
- ABIs inline em `api.ts` (QuoterV2 `quoteExactInputSingle` + SwapRouter02 `exactInputSingle`/`multicall`)
- Usa `viem` (`encodeFunctionData`, `decodeFunctionResult`) — não ethers.js
- Spender: SwapRouter02 (`0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`)
- Quoter: QuoterV2 (`0x61fFE014bA17989E743c5F6cB21bF9697530B21e`)
- Suporta ETH nativo (envia `netAmount` como `msg.value`)

---

## 5. Contratos Importantes

```typescript
// Approvals / Permit
PERMIT2_ADDRESS        = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

// CoW Protocol
COW_VAULT_RELAYER      = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'
COW_SETTLEMENT         = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'

// Odos
ODOS_ROUTER_V3         = '0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05'

// Chainlink
CHAINLINK_ETH_USD      = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'

// Tokens
WETH_ADDRESS           = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
NATIVE_ETH             = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

// Uniswap V3
UNISWAP_SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
UNISWAP_QUOTER_V2      = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
UNISWAP_FEE_TIERS      = [100, 500, 3000, 10000] // 0.01%, 0.05%, 0.3%, 1%
```

---

## 6. Sistema de Approvals

Prioridade: Permit2 > EIP-2612 > Exact approve

1. **Permit2** — Se o token já tem allowance para o contrato Permit2, assinamos off-chain (gasless).
2. **EIP-2612** — Se o token suporta `permit()` nativo (detectado via `nonces()` + `DOMAIN_SEPARATOR()`), assinamos off-chain.
3. **Exact approve** — Fallback: approve on-chain pelo valor exacto (nunca unlimited). ~46k gas extra.

### Spender por source:

| Source | Spender Contract |
|---|---|
| 1inch | Dinâmico (via `/approve/spender`) |
| 0x | Permit2 (`0x000...BA3`) |
| Velora | TokenTransferProxy (via `/adapters/contracts`) |
| Odos | Router V3 (`0x0D05...0D05`) — hardcoded |
| KyberSwap | `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` |
| CoW Protocol | GPv2VaultRelayer (`0xC92E...0110`) — ⚠️ infinite allowance |
| Uniswap V3 | SwapRouter02 (`0x68b3...Fc45`) |

### Análise de Segurança por Source:

| Source | Método | Residual Allowance | Revoke Necessário? |
|---|---|---|---|
| 1inch, 0x, Velora, Odos, KyberSwap | Permit2 signature | Nenhuma (assinatura expira) | Não |
| Uniswap V3 | Exact approve | ~0 (valor exacto) | Não |
| CoW Protocol | Token → VaultRelayer | **Infinite** (persiste) | **Sim** |

---

## 7. Active Approvals System (★ Novo)

### Arquitectura

```
useSwap (success) → useActiveApprovals.addApproval() → ActiveApprovals.tsx (UI)
                                                          ↓
                                              useWriteContract(approve(spender, 0n))
                                                          ↓
                                              markRevoked(id) — remove da lista
```

### Hook: `useActiveApprovals.ts`

Zustand store com:
- `ApprovalRecord { id, tokenAddress, tokenSymbol, spenderAddress, spenderLabel, source, method, timestamp, active, needsRevoke }`
- `addApproval()` — chamado no SwapBox após swap success (especialmente cowswap)
- `markRevoked(id)` — após confirmação on-chain do revoke
- `getActionable()` — filtra `active && needsRevoke`

### Componente: `ActiveApprovals.tsx`

- Aparece abaixo do SwapBox quando existem approvals actionáveis
- Cada linha: token symbol → spender label, método, timestamp
- Botão "Revoke" → envia `approve(spender, 0n)` via `useWriteContract`
- Estados: Revoking… → Confirming… → ✓ Revoked (com link Etherscan)
- Botão "Retry" em caso de erro

### CoW Protocol Warning

Após swap via CoW Protocol, aparece aviso amarelo no SwapBox:
- Explica que VaultRelayer mantém infinite allowance
- Menciona que é auditado mas revoke remove acesso residual
- Link para revoke.cash como alternativa
- Botão "Dismiss" para fechar

---

## 8. Number Formatting (★ Novo)

### Utility: `format.ts`

```typescript
formatWithSeparator("111111")     → "111 111"       // espaço como separador
formatWithSeparator("1234567.89") → "1 234 567.89"
stripSeparator("111 111.5")      → "111111.5"       // para cálculos
formatDisplay(1234567, 4)         → "1 234 567.0000" // display values
```

### Aplicado em:
- **SwapBox**: input (type="text" com formatação ao digitar), output display, balance
- **QuoteBreakdown**: rate, gas estimate, platform fee, min output, savings, comparison table
- Input usa `stripSeparator()` para extrair valor numérico limpo para cálculos

---

## 9. Uniswap V3 Auto Fee Tier Detection

### Fluxo

```
detectUniswapV3FeeTier({ tokenIn, tokenOut, amountIn })
  → Promise.allSettled(4 tiers em paralelo via QuoterV2 eth_call)
  → filter pools com liquidez (ok: true)
  → se 1 pool: reason = 'single_pool'
  → se >1 pool: sort by amountOut desc, tie-break by gasEstimate asc → reason = 'best_net_output'
  → return { bestFee, candidates[], reason }
```

### Cache

- In-memory Map: key = `chainId:tokenIn:tokenOut`, TTL = 45 min
- `getCachedFeeTier()` / `setCachedFeeTier()` / `invalidateCachedFeeTier()`
- Quote → cache bestFee + popula `NormalizedQuote.meta`
- Swap → usa `cachedFee` param (evita re-detecção)

### NormalizedQuote.meta

```typescript
meta?: {
  uniswapV3Fee?: number            // bestFee (ex: 3000)
  uniswapV3Candidates?: Array<{    // all 4 tiers
    fee: number, ok: boolean,
    amountOut?: string, gasEstimate?: number, error?: string
  }>
  uniswapV3Reason?: string         // 'single_pool' | 'best_net_output'
}
```

### UI (QuoteBreakdown)

- Row "Pool fee tier" com percentagem + razão
- Chips coloridos para os 4 tiers (laranja = seleccionado, strikethrough = N/A)
- Badge de fee tier na comparison table

---

## 10. Meta-Aggregator Orchestrator

```
fetchMetaQuote(src, dst, amount) →
  Promise.allSettled([
    fetch1inchQuote(),        // 5s timeout each
    fetch0xQuote(),
    fetchVeloraQuote(),
    fetchOdosQuote(),           // ← v3
    fetchKyberSwapQuote(),
    fetchCowSwapQuote(),
    fetchUniswapV3Quote(),    // on-chain direct, auto fee tier
    fetchOpenOceanQuote(),
    fetchSushiSwapQuote(),
    fetchBalancerQuote(),
    fetchCurveQuote(),        // on-chain via CurveRouterNG
  ])
  → filter fulfilled & toAmount válido & > 0  (try/catch para BigInt safety)
  → ★ gas-aware sort: ranked by toAmount desc, tiebreak by gasUsd asc
  → ★ outlier detection: true statistical median, remove quotes > 3× median
  → ★ all slippage calculations use clampSlippage() [0.01%, 49.99%]
  → return { best, all[], fetchedAt }
```

Refresh automático a cada 15s. Input debounced a 500ms.

### 10.1 Gas-Aware Sorting

Quotes são ordenadas por `toAmount` descendente. Quando dois quotes têm output semelhante, o que tiver menor `gasUsd` ganha. CoW Protocol (gasless para o user, `gasUsd: 0`) beneficia naturalmente.

### 10.2 Outlier Detection (True Median)

O array de amounts é copiado e ordenado ascendentemente. Para arrays com comprimento par, a mediana é a média dos dois valores centrais. Qualquer quote com output > 3× a mediana é removida. Isto protege contra pools manipulados.

### 10.3 Slippage Safety Clamp

`clampSlippage(s)` garante que slippage está sempre em `[0.01, 49.99]`. Aplicado em:
- Todos os `slippageFactor` BigInt (CoW, Uniswap V3, Curve)
- Conversões para bps (0x, Velora, KyberSwap)
- Conversões para percentagem (SushiSwap, Balancer)
- UI: SlippageModal input limitado a `max="49.99"`

---

## 11. Swap Execution Flow

### Standard (1inch, 0x, Velora, Odos, KyberSwap, Uniswap V3)
```
1. fetchSwapFromSource(source, ...) → NormalizedQuote com tx{}
2. sendTransaction({ to, data, value, gas })
3. useWaitForTransactionReceipt(hash)
4. Success → addRecord to SwapHistory
5. Se source tem residual allowance → addApproval()
```

### CoW Protocol (Intent-based)
```
1. fetchSwapFromSource('cowswap', ...) → NormalizedQuote com cowOrderParams{}
2. signTypedDataAsync(EIP-712 order) → signature
3. submitCowOrder(orderParams, signature) → orderUid
4. pollCowOrderStatus(orderUid, 120s) → { status, txHash }
5. Success → addRecord to SwapHistory
6. addApproval({ spender: VaultRelayer, method: 'infinite', needsRevoke: true })
7. Show CoW warning (infinite allowance)
```

---

## 12. UI/UX Features

- **Particle Network background** — Canvas animado com partículas cream/gold conectadas
- **Landing page** → "Launch App" → Swap interface (client-side routing via useState)
- **Thousand separators** — Espaço a cada 3 dígitos em todos os números (input, output, balance, breakdown)
- **Quote comparison table** — Mostra todas as sources com output e badges:
  - "MEV Protected" (verde esmeralda) — CoW Protocol
  - "Intent-Based" (azul) — CoW Protocol
  - "Gasless" (roxo) — CoW Protocol
  - "Direct" (laranja) — Uniswap V3
- **Uniswap V3 fee tier display** — Pool fee tier row + candidate chips + comparison badge
- **CoW-specific UX:**
  - Info box: "Execution time: ~30s — Solvers compete in batch auctions..."
  - Gas: "Free (solver-paid)"
  - Button states: "Sign order in wallet..." → "Waiting for solver..."
  - **Post-swap warning**: Aviso de infinite allowance + link para revoke
- **Active Approvals section** — Mini-widget abaixo do SwapBox com revoke buttons
- **Chainlink price validation** — Warning (2% deviation) / Block (5% deviation)
- **Slippage modal** — Preset + custom slippage
- **Swap history** — localStorage, últimos swaps com link Etherscan
- **Platform fee** — 0.1% mostrada no breakdown

---

## 13. E2E Fork Testing (Anvil)

Setup completo para testes locais com Anvil (Foundry):

- `scripts/fork-test.sh` — Anvil com `--block-time 2`, `--auto-impersonate`, `--steps-tracing`
- `scripts/deal-tokens.sh` — Fund test wallet com 100 ETH, 100K USDC, 100K DAI, 2 WBTC, 50K USDT, 50 WETH
- `scripts/check-fee.sh` — Verificar balances do FEE_RECIPIENT
- `wagmiConfig.ts` — `IS_FORK` detection (localhost RPC)
- `docs/E2E-FORK-TEST.md` — 5 cenários de teste (ETH→USDC, USDC→ETH, fee check, WBTC→USDC, multi-source)

**Status:** Setup completo, testes deferidos para depois.

---

## 14. Configuração (.env.local)

```env
NEXT_PUBLIC_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/{alchemy_key}
NEXT_PUBLIC_1INCH_API_KEY={1inch_bearer_token}       # KYC verificado
NEXT_PUBLIC_0X_API_KEY={0x_api_key}
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID={wc_project_id}
NEXT_PUBLIC_FEE_RECIPIENT=0x107F6eB7C3866c9cEf5860952066e185e9383ABA
NEXT_PUBLIC_FEE_PERCENT=0.1
```

---

## 15. Scripts

```bash
npm run dev           # Next.js dev server
npm run dev:fork      # Dev com Anvil fork (RPC=localhost:8545)
npm run build         # Production build
npm run typecheck     # tsc --noEmit
npm run fork          # Iniciar Anvil mainnet fork
npm run deal          # Fund test wallet com tokens (requer Anvil running)
npm run check:fee     # Verificar FEE_RECIPIENT balances
```

---

## 16. Tokens Suportados

ETH, WETH, USDC, USDT, DAI, WBTC, LINK, UNI — definidos em `src/lib/tokens.ts` com address, symbol, decimals, e logoURI.

---

## 17. Decisões Técnicas & Notas

- **ES2020 target** no tsconfig para suporte BigInt (`0n`)
- **0x API v2** requer header `0x-version: v2` e usa Permit2 em vez de Exchange Proxy
- **ParaSwap → Velora** rebrand (abril 2025): API mantém-se em `api.paraswap.io` mas com `version=6.2`
- **CoW EIP-712 domain**: `{ name: "Gnosis Protocol", version: "v2", chainId: useChainId(), verifyingContract: GPv2Settlement }` — chainId dinâmico via wagmi `useChainId()`
- **KyberSwap** converte NATIVE_ETH → WETH internamente
- **1inch** requer KYC no portal.1inch.dev antes de obter API key
- **Build SIGBUS** na VM — funciona normalmente na máquina local e no Vercel
- **Fee model misto**:
  - Aggregators (1inch, 0x, Velora, Odos, KyberSwap): fee via parâmetros nativos da API
  - CoW Protocol: fee via referrer metadata no appData
  - **Uniswap V3 Direct**: fee deduzida do `amountIn` antes de enviar ao router
- **Uniswap V3 all-in-one**: ABIs, quote, swap, fee tier detection, cache — tudo inline em `api.ts`
- **Uniswap V3 usa `viem`** (`encodeFunctionData`, `decodeFunctionResult`) — não ethers.js
- **BigInt safety**: `fetchMetaQuote` filter e sort têm try/catch para proteger contra `toAmount: undefined`
- **Odos v3 migration**: `/sor/quote/v2` → `/sor/quote/v3`, campos `simple: false`, `disableRFQs: false`, router hardcoded
- **Approval security model**: Apenas CoW Protocol deixa residual allowance significativa → tracked pelo Active Approvals
- **Number input**: `type="text"` (não `type="number"`) para permitir espaços como thousand separators

---

## 18. Smart DCA Engine (★ Novo)

### Arquitectura

```
DCAPanel.tsx (UI)
  → useDCAEngine.ts (React hook, wallet callbacks)
    → dca-engine.ts (core engine, localStorage, event emitter)
      → fetchMetaQuote() (all 11 sources for each buy)
      → fetchChainlinkPriceRaw() / fetchHistoricalPrice() (24h price context)
```

### Smart Window Algorithm

1. Window abre **10% antes** do tempo agendado (`WINDOW_OPEN_RATIO = 0.10`)
2. Fetch preço actual via Chainlink (`fetchChainlinkPriceRaw()`)
3. Fetch preço ~24h atrás via binary search em Chainlink rounds (`fetchHistoricalPrice()`)
4. **Decisão:**
   - Se preço actual < preço ontem → **comprar imediatamente**
   - Se preço actual > preço ontem → esperar por queda de **0.3%** (`DIP_THRESHOLD_PERCENT = 0.003`) do preço de abertura da window
   - Se window expirar sem queda → **executar na mesma** (forced buy)
5. Cada compra vai buscar quotes a todas as 11 sources via `fetchMetaQuote()`
6. Requer assinatura do wallet (browser aberto)

### Intervalos Suportados

`4h`, `8h`, `12h`, `1d`, `3d`, `7d`

### Persistência

- Posições guardadas em `localStorage` (key: `teraswap_dca_positions`)
- Global tick a cada 30s verifica se alguma window deve abrir
- Smart window monitoring a cada 10s durante window aberta

### UI (DCAPanel.tsx)

- Tabs: "New DCA" / "Positions"
- Create form: token selection, amount, parts (3/5/7/10/14/30), interval, slippage
- Position cards: progress bar, pause/resume/cancel, countdown to next execution
- Smart window status: gold-bordered card com preço actual vs ontem, dip threshold
- Sons: `playDCABuy()` on success, `playError()` on failure

### Roadmap DCA

- **Phase 1 (Live):** Client-side engine, browser must be open, wallet signature per buy
- **Phase 2 (Planned):** Own smart contracts com Chainlink Automation para execução autónoma

---

## 19. Limit Orders via CoW Protocol (★ Novo)

### Arquitectura

O sistema de limit orders reutiliza a infra-estrutura CoW Protocol já integrada (EIP-712 signing, orderbook API), mas com parâmetros específicos para ordens limite:

- **`partiallyFillable: true`** — permite fills parciais ao longo de múltiplos batches
- **`feeAmount: 0`** — zero gas para o user (solver paga)
- **`kind: 'sell'`** — user define quanto quer vender e a que preço mínimo
- **`buyAmount`** — calculado via `sellAmount × targetPrice` (ajustado por decimals)
- **`validTo`** — Unix timestamp (seconds) baseado no expiry escolhido pelo user

### Ficheiros

| Ficheiro | Responsabilidade |
|---|---|
| `limit-order-types.ts` | Tipos: LimitOrder, LimitOrderConfig, LimitOrderEvent, expiry presets |
| `limit-order-api.ts` | API: buildLimitOrderParams, submitLimitOrder, fetchLimitOrderStatus, cancelLimitOrder, fetchCurrentPrice |
| `useLimitOrder.ts` | Hook React: create → sign → submit → poll, localStorage persistence, cancel/remove |
| `LimitOrderPanel.tsx` | UI: CreateLimitForm (TokenSelector, target price, expiry, partial fill) + OrdersList (active/history) |

### Flow

1. User selecciona token pair + amount + target price + expiry
2. `buildLimitOrderParams()` calcula buyAmount e validTo
3. `signTypedDataAsync()` com EIP-712 domain (Gnosis Protocol v2)
4. `submitLimitOrder()` envia ordem assinada ao CoW orderbook
5. `fetchLimitOrderStatus()` poll a cada 10s para detectar fills
6. Quando `status === 'fulfilled'` → `playApproval()` + mostra txHash

### Presets de Expiry

| Label | Segundos |
|---|---|
| 1 hour | 3 600 |
| 24 hours | 86 400 |
| 7 days | 604 800 |
| 30 days | 2 592 000 |
| 90 days | 7 776 000 |

### Sound

`playLimitPlaced()` — rising arpeggio (A4→C#5→E5) + sub confirmation pulse (80→50Hz) + echo tail (triangle 659→440Hz).

---

## 20. Stop Loss / Take Profit — Arquitectura (★ Novo)

### Conceito
Conditional orders que monitorizam preço via Chainlink oracles e auto-submetem limit orders CoW Protocol quando o trigger dispara. Executado inteiramente client-side (browser), sem smart contracts adicionais.

### Ficheiros
| Ficheiro | Responsabilidade |
|---|---|
| `conditional-order-types.ts` | Tipos: `ConditionalOrder`, `ConditionalOrderConfig`, `ConditionalOrderStatus`, `TriggerDirection` |
| `price-monitor.ts` | Leitura Chainlink `latestRoundData()` via viem + fallback CoW quote (token→USDC) |
| `useConditionalOrder.ts` | Hook lifecycle: create → monitor → trigger → sign → submit → poll fill |
| `ConditionalOrderPanel.tsx` | UI: SL/TP toggle, trigger price input, % presets, active/history cards |

### Fluxo
```
1. User define trigger price (USD) + limit order config
2. useConditionalOrder inicia polling Chainlink (5s interval)
3. price-monitor.ts lê AggregatorV3.latestRoundData() on-chain
4. isTriggerMet() compara currentPrice vs triggerPrice (above/below)
5. Quando trigger dispara → handleTrigger():
   a. buildLimitOrderParams() (reusa limit-order-api.ts)
   b. signTypedDataAsync() (EIP-712, wagmi)
   c. submitLimitOrder() (CoW API)
6. Order polling (10s) via fetchLimitOrderStatus()
7. Status: monitoring → triggered → submitted → filled/expired/cancelled
```

### Price Monitor — Dual Strategy
- **Primary**: Chainlink feeds (CHAINLINK_FEEDS map em constants.ts) — 8+ decimals, on-chain, sem API key
- **Fallback**: CoW quote (token→USDC) — para tokens sem feed Chainlink
- Cache de `decimals()` por feed para minimizar RPC calls

### Stop Loss vs Take Profit
| Tipo | TriggerDirection | Cenário |
|---|---|---|
| Stop Loss | `below` | ETH @ $3000, trigger $2500 → sell ETH se cair |
| Take Profit | `above` | ETH @ $3000, trigger $4000 → sell ETH se subir |

### Presets (%)
- Stop Loss: -5%, -10%, -15%, -20% (red badges)
- Take Profit: +10%, +25%, +50%, +100% (green badges)

### Persistência
`localStorage` com key `teraswap_conditional_orders` — sobrevive refresh, auto-retoma monitoring.

### Sounds
`playTriggerAlert()` — sweep descendente (880→440 Hz) + double pulse (660 Hz triangle) + sub bass (60→30 Hz). Dispara em `price_triggered` event.

---

## 21. Split Routing — Arquitectura (★ Novo)

### Conceito
Para trades grandes (>$5k USD estimado), dividir o volume entre múltiplos DEXes reduz price impact.
O optimizer testa dezenas de configurações de split (2-way e 3-way) e compara com o melhor single-source.

### Ficheiros
| Ficheiro | Responsabilidade |
|---|---|
| `split-routing-types.ts` | Tipos: `SplitLeg`, `SplitRoute`, `SplitQuoteResult`. Configs: 2-way (50/50, 60/40, 70/30, 80/20), 3-way (50/30/20, etc.) |
| `split-router.ts` | Engine: `fetchSplitQuotes()` busca quotes a sub-amounts, `findBestSplit()` testa todas as combinações |
| `useSplitRoute.ts` | Hook React: gere análise assíncrona, auto-enable se recomendado, toggle on/off |
| `SplitRouteVisualizer.tsx` | UI: barra visual com alocações por cor, detalhes por leg, comparação single vs split, toggle |

### Fluxo
```
1. useQuote retorna MetaQuoteResult com quotes de 11 sources a 100% do volume
2. useSplitRoute estima trade USD (via stablecoin heuristic)
3. Se trade > $5k → fetchSplitQuotes() busca quotes a 20/30/40/50/60/70/80% em paralelo
4. findBestSplit() testa:
   - 2-way: todas as combinações (sources × splits 50/50, 60/40, 70/30, 80/20)
   - 3-way: todas as combinações (sources × splits 50/30/20, 40/40/20, 60/25/15, 34/33/33)
5. Compara totalOutput vs bestSingle — se melhoria ≥ 10 bps → splitRecommended = true
6. UI mostra SplitRouteVisualizer com barra colorida, toggle, e comparação
```

### Elegibilidade
CoW Protocol excluído do split (intent-based, não suporta sub-amounts parciais).
10 sources elegíveis: 1inch, 0x, Velora, Odos, KyberSwap, OpenOcean, SushiSwap, Uniswap V3, Balancer, Curve.

### Limiares
- `SPLIT_MIN_USD = 5_000` — abaixo disto, single-source sempre
- `SPLIT_MIN_PERCENT = 10` — cada leg precisa ≥10% do volume
- `SPLIT_MIN_IMPROVEMENT_BPS = 10` — melhoria mínima 0.1% para recomendar split
- `SPLIT_MAX_LEGS = 3` — máximo 3 sources por split

---

## 22. Analytics — Arquitectura (★ Novo)

### Separação público / privado
O analytics está dividido em duas camadas completamente separadas:

#### A) Dashboard Público (`AnalyticsDashboard.tsx` — tab "Analytics")
Métricas de performance visíveis para qualquer user:
- **Protocol Volume**: volume total + trade count
- **Users**: unique wallets
- **Best Routes**: top 3 aggregadores por win rate
- **Popular Pairs**: ranking dos pares mais negociados
- **Volume Trend**: bar chart 30 dias
- **Recent Activity**: feed das últimas trades (sem endereços detalhados)

**Sem acesso a:** fees, revenue, wallet leaderboard, export, dados internos.

#### B) Admin Monitor v2 (`AdminMonitor.tsx` — rota `/admin?key=SECRET`)
Blockscout-inspired stats dashboard privado. Design com rounded cards, SVG charts, e navegação por tabs. Acessível apenas via URL secreto. Sem botão ou link no site.

**6 Tabs de categorias:**

| Tab | Conteúdo |
|---|---|
| **Overview** | 6 KPI stat cards, Daily Volume/Trades/Fees/Wallets sparklines + bar charts (30d SVG), Source donut chart, Hourly heatmap (pequenos quadrados horizontais) |
| **Revenue** | Total Fees/Volume/Avg Fee/Fee Rate por período, Daily Revenue chart 30d, Revenue por Aggregator (barras), Revenue por Par (barras), Source Economics table |
| **Sybil** | 4 KPI cards (Total/Clean/Suspicious/Sybil), Donut distribution, Score heatmap grid, Flagged wallets table, Flag details expandidos, Wallet clusters |
| **Wallets** | Wallets/Trades/Volume por período, Top wallets por volume (barras), Cohort table + sparkline, Whale alerts (>$10k), Top pairs grid |
| **Activity** | Trade type distribution (Swap/DCA/Limit/SL-TP), Live trade feed (50 trades) com badges coloridos |
| **Tools** | Seed demo data (350 trades), Clear all, 4 exports (wallet snapshot, airdrop eligible, sybil report, full dump), System info |

**Componentes visuais reutilizáveis:**
- `StatCard` — Blockscout-style card com label, value, sub-text, cor, chart slot
- `Sparkline` — SVG line chart com fill opcional
- `MiniBarChart` — SVG bar chart com labels
- `DonutChart` — SVG pie/donut com legenda
- `HeatmapGrid` — Grid de quadrados 18x18px com hover zoom, tooltip, legenda de intensidade

**Period filter global:** ALL / 24H / 7D / 30D filtra trades em TODOS os tabs (via `filterByPeriod()` com cutoff timestamp)

### Sybil Detector (`sybil-detector.ts`)
6 heurísticas independentes, cada uma com peso 0-25:

| Heurística | O que detecta | Peso máx |
|---|---|---|
| `circular_trades` | A→B depois B→A dentro de 1h | 25 |
| `repeated_amounts` | Mesmo montante exacto repetido (≥40% dos trades) | 20 |
| `timestamp_clustering` | Intervalos entre trades muito uniformes (bot) | 20 |
| `volume_inflation` | Muitos trades minúsculos (<$10) para inflar count | 20 |
| `single_source` | 100% trades via único aggregador (anormal em meta-agg) | 10 |
| `burst_activity` | Toda actividade em <2h (farming antes de snapshot) | 15 |

Verdicts: `clean` (score <30), `suspicious` (30-59), `likely_sybil` (≥60)

Cluster detection adicional: wallets que co-ocorrem em janelas de 5min ≥3 vezes com ≥50% overlap.

### Ficheiros
| Ficheiro | Responsabilidade |
|---|---|
| `analytics-types.ts` | TradeEvent, WalletProfile, DashboardData, PeriodMetrics, SourceMetrics |
| `analytics-tracker.ts` | `trackTrade()` → localStorage; `computeDashboard()` agrega; `exportWalletSnapshot()` |
| `sybil-detector.ts` | `scoreWallet()`, `scoreAllWallets()`, `detectWalletClusters()` |
| `useAnalytics.ts` | Hook React: `{ dashboard, loading, track, refresh, exportSnapshot }`, auto-refresh 30s |
| `AnalyticsDashboard.tsx` | Dashboard público (volume, routes, pairs, activity) |
| `AdminMonitor.tsx` | Bloomberg monitor privado (revenue, sybil, cohorts, whales, exports) |
| `admin/page.tsx` | Rota `/admin?key=SECRET` com gate de acesso |

### Data flow + tracking
1. Cada swap/DCA/limit/SL-TP chama `trackTrade()` no sucesso
2. Evento gravado em `localStorage` (key: `teraswap_analytics_events`)
3. `computeDashboard()` agrega por período, source, hora, par, carteira
4. `scoreAllWallets()` corre 6 heurísticas por wallet
5. `detectWalletClusters()` analisa co-ocorrências temporais

### Preparado para Supabase
- Estrutura de dados flat (TradeEvent) pronta para tabela SQL
- Quando em Supabase, o admin monitor funciona 24/7 independente do PC
- Migração: substituir `localStorage` por `fetch('/api/analytics')` sem alterar tipos

---

## 23. Bugs Conhecidos & Fixes

| Bug | Causa | Fix |
|---|---|---|
| "Cannot convert undefined to a BigInt" | Aggregator devolve `toAmount: undefined` em caso de erro parcial | try/catch no filter e sort de `fetchMetaQuote` |
| PromiseFulfilledResult type error | TypeScript não inferia o tipo correcto com `.filter()` type predicate | Cast explícito: `as PromiseFulfilledResult<T>[]` |
| Build SIGBUS na VM | Memória insuficiente na VM de desenvolvimento | Build funciona no Mac local e Vercel |
| CurveRouterNG tuple types | `as const` ABI enforça strict fixed-length tuples | Type aliases explícitos: `CurveRoute`, `CurveSwapParams`, `CurvePools` |
| Outlier median incorrecta | Array ordenado desc, medianIdx apontava para "middle" na ordem errada | Copiar array, sort asc, avg dos dois centrais se par |
| Slippage negativo possível | `(1 - slippage/100)` negativo se slippage ≥ 100 | `clampSlippage()` limita a [0.01, 49.99] |
| CoW chainId hardcoded | EIP-712 domain tinha `chainId: 1` fixo | `useChainId()` do wagmi para chain dinâmico |

---

## 24. Próximos Passos

### Curto prazo (Phase 2 — Next)
- [ ] **Supabase migration** — persistir TradeEvents em base de dados para monitoring 24/7 sem PC
- [ ] Deploy Vercel + Supabase (guide em `docs/DEPLOY-GUIDE.md`)
- [ ] Investigar porque 1inch, 0x, Odos e CoW não retornam quotes em certos pares
- [ ] Adicionar mais tokens à lista
- [ ] Executar E2E fork tests (setup já pronto)
- [ ] **Private RPC** — integrar Flashbots Protect / MEV Blocker como RPC endpoint (txs invisíveis na mempool)

### Médio prazo
- [ ] Own DCA smart contracts (Chainlink Automation para execução autónoma sem browser)
- [ ] Trailing stop loss (auto-adjust trigger as price rises)
- [ ] Bebop RFQ (12ª source, bom para large trades)
- [ ] Fee collection smart contract (para FEE_RECIPIENT)
- [ ] Base network support
- [ ] Multi-hop Curve routing
- [ ] Persistir Active Approvals em localStorage

### Longo prazo (Phase 3)
- [ ] Multi-chain expansion (Arbitrum, Optimism, Base)
- [ ] Cross-chain swaps via LI.FI
- [ ] Uniswap V4 Hooks (pools customizados)
- [ ] **TeraShield — Premium Privacy Mode** (feature paga, taxa extra por swap privado)
  - Private RPC (Flashbots Protect) como base gratuita
  - Stealth Addresses (ERC-5564/ERC-6538) — endereços efémeros one-time
  - Railgun shielded swaps — zkSNARK privacy com provas de não-inclusão em sanções
  - Modelo de monetização: fee % sobre swaps privados (a definir)
- [ ] Governance token
- [ ] DAO treasury management

### ✅ Concluído
- [x] OpenOcean (8ª source)
- [x] SushiSwap (9ª source)
- [x] Balancer V2 (10ª source)
- [x] Curve Finance (11ª source, on-chain via CurveRouterNG)
- [x] Smart DCA com price-aware buying windows
- [x] Gas-aware quote ranking
- [x] Statistical outlier detection (true median)
- [x] Slippage safety clamp across all sources
- [x] Dynamic multi-chain EIP-712 signing
- [x] Limit Orders via CoW Protocol (zero gas, partially fillable, expiry configurável)
- [x] Limit Order price UX overhaul (stablecoin-aware inversion, % presets, swap tokens, order intent)
- [x] Stop Loss / Take Profit (Chainlink oracle polling → auto CoW limit order submission)
- [x] Split Routing (multi-DEX trade optimization, 2-way + 3-way combos, $5k+ threshold)
- [x] Analytics Dashboard + Wallet Tracker (volumes, fees, source ranking, heatmap, wallet export)
- [x] Separação público/privado (dashboard público simplificado + admin monitor privado)
- [x] Sybil/wash trading detector (6 heurísticas + wallet clustering)
- [x] Admin Monitor v2 — redesign Blockscout-style (6 tabs, SVG charts, heatmap quadrados, period filter global)
- [x] Seed data generator (350 trades: 85% regular, 5% whale, 10% sybil)
- [x] Deploy guide (Vercel + Supabase)

---

## 25. Custom Token Import & Wallet History (★ Session 13)

### Custom Token Import

**Componente:** `TokenImportModal.tsx`

Permite ao user colar qualquer endereço ERC-20 para auto-detectar:
- **Symbol** — via `symbol()` (fallback: 4 primeiros chars do address)
- **Name** — via `name()`
- **Decimals** — via `decimals()` (fallback: 18)

**Flow:**
```
TokenImportModal (input form)
  → useTokenImport({ address })
    → viem readContract(ERC20ABI.symbol, .name, .decimals) via RPC
    → returns { symbol, name, decimals, address }
    → TokenSelector adiciona à lista temporária
    → localStorage `teraswap_imported_tokens`
```

Validação: address tem 42 chars, começa com `0x`, é checksum válido via `getAddress()`.

### useTokenImport Hook

```typescript
const { token, loading, error } = useTokenImport(address)
// token: { address, symbol, name, decimals, logoURI?: undefined }
// Reutiliza wagmi useReadContract com fallbacks
```

Caching em localStorage para evitar re-fetches. Timeout 5s se RPC falhar.

### Wallet History Component

**Componente:** `WalletHistory.tsx`

Mostra as **últimas 25 transações** da wallet conectada via **Etherscan API**:

Campos exibidos:
- Timestamp (converted to local timezone)
- Method name (parsed from function selector `0x...`)
- To/From (truncated)
- Value (ETH)
- Status (Success / Failed / Pending)
- Link Etherscan

**useWalletHistory Hook:**
```typescript
const { txs, loading, error, refetch } = useWalletHistory(address)
// Queries Etherscan API: /api?module=account&action=txlist&address=...&sort=desc&limit=25
// Caches em localStorage (TTL: 5 min)
// Fallback: empty array if API quota exceeded
```

Method parsing:
- Se `input === '0x'` → Transfer / Swap / Approve signature (heurística)
- Se `to === WETH` e `input` contém `deposit` → "Wrap ETH"
- Lookup via `4byte.directory` para method names (fallback: "Contract Interaction")

**Integração:** Tab "History" na page.tsx (6 tabs total).

---

## 26. Auto-Slippage (★ Session 13)

### Smart Slippage Calculation

Baseado em análise do par de tokens (stablecoin vs major vs memecoin):

```typescript
calculateAutoSlippage(tokenIn, tokenOut): number
  → isStable(tokenIn) && isStable(tokenOut) → 0.1%  (USDC↔DAI)
  → isMajor(one) && isStable(other)         → 0.3%  (ETH↔USDC, UNI↔DAI)
  → isMajor(tokenIn) && isMajor(tokenOut)   → 0.5%  (ETH↔WBTC, UNI↔LINK)
  → otherwise (memecoin / exotic)           → 2.0%  (PEPE↔SHIB)
```

**Tokens "Major":** ETH, WBTC, UNI, LINK, AAVE, CRV, SUSHI, BAL, LDO
**Tokens "Stable":** USDC, USDT, DAI, USDe, FRAX

**Aplicação:**
- Detectado automaticamente quando user selecciona par
- Slippage modal mostra "Auto: 0.3%" com ajuste manual permitido
- Valor salvo em `localStorage` por pair key para memória

---

## 27. Mobile Responsive Improvements (★ Session 13)

### Hamburger Menu

Header responsivo:
- **Desktop (≥768px):** nav inline, wallet button visível
- **Mobile (<768px):** hamburger icon (≡), collapsible nav drawer

**Componente:** Updated `Header.tsx` com media queries.

### No-Scrollbar Tabs

Mode selector (7 tabs) com:
```css
.tabs-container {
  overflow-x: auto;
  scrollbar-width: none;  /* Firefox */
  -ms-overflow-style: none;  /* IE/Edge */
}
.tabs-container::-webkit-scrollbar { display: none; }  /* Chrome */
```

Tabs draggable em mobile, snap-to-edge behavior.

### Spacing Optimizations

- Padding reduzido em mobile (12px → 8px)
- SwapBox width clamped a min 280px (max 100vw)
- QuoteBreakdown stacked em mobile (flex-col)
- Token amounts font-size reduzido de 24px → 18px em mobile

### Light Mode Header Support

**CSS Variable:** `--header-bg-light` (novo)

```css
header {
  background-color: var(--header-bg-dark, #0a0a0a);
  @media (prefers-color-scheme: light) {
    background-color: var(--header-bg-light, #f0f0f0);
  }
}
```

---

## 28. Mode Selector — 7 Tabs (★ Session 13)

Expandido para:

| Tab | Route | Features |
|-----|-------|----------|
| Swap | `/` | Meta-aggregator core, MEV toggle, split routing, quotes |
| DCA | `/dca` | Dollar-cost averaging, smart windows, buying history |
| Limit | `/limit` | Limit orders via CoW, target price, expiry, order list |
| SL·TP | `/sltp` | Stop loss / take profit, Chainlink monitoring, conditional triggers |
| History | `/history` | Wallet transaction history via Etherscan API, 25 recent txs |
| Analytics | `/analytics` | Public dashboard: volumes, best routes, pairs, activity |
| **Removed** | — | Docs (moved to footer link), Landing (separate route) |

**Page routing:** `useState<'landing' | 'swap' | 'docs' | 'privacy' | 'terms'>` mantém-se, mas tab selector apenas gerir `swap` subtabs.

---

## 29. Histórico de Implementação (Cont.)

| Data | Milestone |
|---|---|
| Sessão 1 | Setup Next.js + wagmi + RainbowKit, branding cream-on-black, ParticleNetwork, LandingPage |
| Sessão 1 | 1inch + 0x + ParaSwap + Odos integrados, meta-orchestrator, QuoteBreakdown, SwapButton |
| Sessão 2 | Fee recipient configurado, DEX study (8 candidatos analisados) |
| Sessão 2 | Velora (ParaSwap v6.2), KyberSwap, CoW Protocol integrados |
| Sessão 2 | CoW EIP-712 signing flow + polling + UI states (cow_signing, cow_pending) |
| Sessão 2 | 1inch KYC verificado + API key configurada |
| Sessão 2 | Uniswap V3 research + implementação como 7ª source |
| Sessão 3 | Uniswap V3 refactored: tudo inline em api.ts, source `uniswapv3`, fee deduzida, viem |
| Sessão 3 | Fix BigInt undefined crash no fetchMetaQuote |
| Sessão 3 | **Primeiro teste bem sucedido**: 3 fontes (Velora, KyberSwap, Uniswap V3) |
| Sessão 4 | ★ Uniswap V3 auto fee tier detection + in-memory cache (45 min TTL) |
| Sessão 4 | ★ E2E Anvil fork testing setup (scripts + docs + wagmi IS_FORK) |
| Sessão 4 | ★ Odos v2 → v3 migration (endpoint, body fields, router hardcoded) |
| Sessão 4 | ★ Approval security analysis → Active Approvals system |
| Sessão 4 | ★ Active Approvals UI com revoke (CoW VaultRelayer) |
| Sessão 4 | ★ CoW Protocol post-swap warning (infinite allowance) |
| Sessão 4 | ★ Thousand separators (espaço) em todo o site |
| Sessão 5 | ★ Theme system (dark/light/neon), legal pages (Terms, Privacy, Disclaimer) |
| Sessão 5 | ★ Sound engine (Web Audio API): click, quote, swap success, approval, error |
| Sessão 5 | ★ DocsPage completa com arquitectura, 10 sources, routing, security, roadmap |
| Sessão 6 | ★ OpenOcean (8ª source), SushiSwap (9ª), Balancer V2 (10ª) integrados |
| Sessão 6 | ★ Curve Finance (11ª source) via CurveRouterNG on-chain (6 pools) |
| Sessão 6 | ★ Smart DCA engine com price-aware buying windows (Chainlink historical prices) |
| Sessão 6 | ★ DCA Panel UI (create form, positions, smart window status, playDCABuy sound) |
| Sessão 6 | ★ Gas-aware quote ranking (gasUsd tiebreak) |
| Sessão 6 | ★ True statistical median no outlier filter |
| Sessão 6 | ★ Slippage safety clamp [0.01%, 49.99%] em todas as 11 sources |
| Sessão 6 | ★ CoW EIP-712 chainId dinâmico via wagmi useChainId() |
| Sessão 6 | ★ LandingPage features expandidas (6 cards), DocsPage routing expandido (7 steps) |
| Sessão 7 | ★ Análise competitiva profunda (1inch, CowSwap, Jupiter, LlamaSwap, Odos, Matcha) |
| Sessão 7 | ★ Limit Orders via CoW Protocol (limit-order-types.ts, limit-order-api.ts, useLimitOrder.ts, LimitOrderPanel.tsx) |
| Sessão 7 | ★ page.tsx: 3 tabs (Swap / DCA / Limit) |
| Sessão 7 | ★ playLimitPlaced() sound (rising arpeggio A4→C#5→E5 + sub pulse + echo tail) |
| Sessão 7 | ★ DocsPage: secção Limit Orders (5 steps), roadmap actualizado |
| Sessão 7 | ★ LandingPage: 7 feature cards (inclui Limit Orders) |
| Sessão 8 | ★ Limit Order price UX: stablecoin-aware inversion (auto-detect USDC/USDT/DAI pairs) |
| Sessão 8 | ★ Price direction toggle (⇄), swap tokens (⇅), percentage buttons (-10/-5/+5/+10%) |
| Sessão 8 | ★ Order intent badge ("Buy below" / "Take profit"), formatPrice() smart decimals |
| Sessão 8 | ★ Fix: displayPriceInput separado de targetPrice para evitar reformatting ao escrever |
| Sessão 8 | ★ conditional-order-types.ts: tipos SL/TP, ConditionalOrder, ConditionalOrderConfig |
| Sessão 8 | ★ price-monitor.ts: Chainlink AggregatorV3 polling + CoW quote fallback |
| Sessão 8 | ★ useConditionalOrder.ts: monitor → trigger → sign EIP-712 → submit CoW → poll fill |
| Sessão 8 | ★ ConditionalOrderPanel.tsx: SL/TP UI (red/green toggle, % presets, progress bar, tx link) |
| Sessão 8 | ★ page.tsx: 4 tabs (Swap / DCA / Limit / SL·TP) |
| Sessão 8 | ★ playTriggerAlert() sound (descending sweep 880→440Hz + double pulse + sub bass) |
| Sessão 8 | ★ DocsPage: secção SL/TP (4 steps), roadmap actualizado |
| Sessão 8 | ★ LandingPage: 8 feature cards (inclui SL/TP) |
| Sessão 8 | ★ split-routing-types.ts: tipos SplitLeg, SplitRoute, SplitQuoteResult, configs 2-way + 3-way |
| Sessão 8 | ★ split-router.ts: optimizer engine (fetchSplitQuotes, findBestSplit, permute3) |
| Sessão 8 | ★ useSplitRoute.ts: hook com análise assíncrona, auto-enable, USD threshold $5k |
| Sessão 8 | ★ SplitRouteVisualizer.tsx: barra colorida por source, leg details, toggle, comparação single vs split |
| Sessão 8 | ★ SwapBox.tsx: integração SplitRouteVisualizer abaixo do QuoteBreakdown |
| Sessão 8 | ★ DocsPage: secção Split Routing (4 steps), roadmap actualizado |
| Sessão 8 | ★ LandingPage: 9 feature cards (inclui Split Routing) |
| Sessão 9 | ★ analytics-types.ts: TradeEvent, WalletProfile, DashboardData, PeriodMetrics, SourceMetrics |
| Sessão 9 | ★ analytics-tracker.ts: trackTrade(), computeDashboard(), exportWalletSnapshot(), localStorage |
| Sessão 9 | ★ useAnalytics.ts: hook React com auto-refresh 30s, bridge tracker → components |
| Sessão 9 | ★ AnalyticsDashboard.tsx: Period selector, MetricCards, SourceRanking, HourlyHeatmap, DailyVolumeChart, TopPairs, WalletLeaderboard, RecentTrades |
| Sessão 9 | ★ SwapBox.tsx: trackTrade({ type: 'swap' }) no sucesso |
| Sessão 9 | ★ LimitOrderPanel.tsx: trackTrade({ type: 'limit_fill' }) no order_filled |
| Sessão 9 | ★ ConditionalOrderPanel.tsx: trackTrade({ type: 'sltp_trigger' }) no order_filled |
| Sessão 9 | ★ DCAPanel.tsx: trackTrade({ type: 'dca_buy' }) no execution_success |
| Sessão 9 | ★ page.tsx: 5 tabs (Swap / DCA / Limit / SL·TP / Analytics) |
| Sessão 9 | ★ DocsPage: secção Analytics Dashboard (5 steps), roadmap actualizado |
| Sessão 9 | ★ LandingPage: 10 feature cards (inclui Analytics Dashboard) |
| Sessão 9 | ★ Separação público/privado: AnalyticsDashboard simplificado (só performance para user) |
| Sessão 9 | ★ sybil-detector.ts: 6 heurísticas (circular, repeated amounts, timestamp clustering, volume inflation, single source, burst) |
| Sessão 9 | ★ sybil-detector.ts: detectWalletClusters() — co-ocorrências em janelas de 5min |
| Sessão 9 | ★ AdminMonitor.tsx: Bloomberg-style (KPI strip, revenue, source economics, sybil scanner, whale alerts, cohorts, live feed, exports) |
| Sessão 9 | ★ admin/page.tsx: rota /admin?key=SECRET com gate de acesso (404 fake sem key) |
| Sessão 9 | ★ seedDemoData(350): gerador de dados demo (85% regular, 5% whale, 10% sybil patterns) |
| Sessão 9 | ★ clearAnalytics() + seed/clear buttons no admin |
| Sessão 9 | ★ Deploy guide: docs/DEPLOY-GUIDE.md (Vercel + Supabase step-by-step) |
| Sessão 10 | ★ AdminMonitor v2: redesign completo Blockscout-style com 6 tabs (Overview, Revenue, Sybil, Wallets, Activity, Tools) |
| Sessão 10 | ★ Componentes SVG: StatCard, Sparkline, MiniBarChart, DonutChart, HeatmapGrid (quadrados 18x18px horizontais) |
| Sessão 10 | ★ Period filter global: ALL/24H/7D/30D filtra trades em TODOS os tabs via filterByPeriod() |
| Sessão 10 | ★ Sticky header com tab navigation + period selector |
| Sessão 10 | ★ Overview tab: 6 KPI cards, daily charts (volume/trades/fees/wallets), source donut, heatmap |
| Sessão 10 | ★ Revenue tab: period KPIs dinâmicos, daily revenue chart, revenue por aggregator/par, source economics filtrada |
| Sessão 10 | ★ Sybil tab: distribution donut, score heatmap grid, flagged wallets table, flag details, clusters |
| Sessão 10 | ★ Wallets tab: top wallets barras, cohort table + sparkline, whale alerts, top pairs grid |
| Sessão 10 | ★ Activity tab: type distribution cards, live feed 50 trades com badges |
| Sessão 10 | ★ Tools tab: seed/clear demo, 4 export buttons em card layout, system info |
| Sessão 10 | ★ LandingPage: 12 feature cards (adicionado 11 Sources, Active Approvals Manager) |
| Sessão 10 | ★ DocsPage roadmap: Phase 1 expandida (18 items), Phase 2 actualizada (Supabase, Bebop, trailing SL), Phase 3 refinada |
| Sessão 10 | ★ skillsDEFI.md: Section 22 actualizada (Admin Monitor v2), Section 24 reestruturada, histórico Sessão 10 |
| Sessão 11 | ★ ToastProvider.tsx: sistema de toasts context-based (loading→success/error transitions, Framer Motion) |
| Sessão 11 | ★ Toast wiring: SwapBox (swap/approval/quote toasts), DCAPanel, LimitOrderPanel, ConditionalOrderPanel |
| Sessão 11 | ★ Price impact warnings: amber >3%, red >5% banner in SwapBox + deviation row in QuoteBreakdown |
| Sessão 11 | ★ Skeleton.tsx: reusable loaders (SwapBoxSkeleton, QuoteBreakdownSkeleton) |
| Sessão 11 | ★ Share button: Twitter/X intent after swap success with savings % calculation |
| Sessão 11 | ★ rate-limiter.ts: sliding-window per-key throttle (globalLimiter 30/min, quoteLimiter 3/10s, priceLimiter 10/30s) |
| Sessão 11 | ★ wagmiConfig.ts: fallback RPC transport com rank:true (FALLBACK_RPC_1, FALLBACK_RPC_2) |
| Sessão 11 | ★ source-monitor.ts: per-aggregator health tracking (success rate, latency, consecutive failures) |
| Sessão 11 | ★ api.ts: wired rate limiter (static import) + source monitor (recordSourcePing after allSettled) |
| Sessão 12 | ★ Countdown removido: isBeforeLaunch() e CountdownGate rendering removidos, LAUNCH_DATE cleared |
| Sessão 12 | ★ HelpButton.tsx + HelpDrawer.tsx: floating "?" + slide-in FAQ panel (6 sections, accordion, forced dark) |
| Sessão 12 | ★ help-content.ts: FAQ data organizado por categoria (Getting Started, Swaps, DCA, Limits, SL/TP, Security) |
| Sessão 12 | ★ HelpDrawer: inline styles para contraste forçado (independente do tema), link X actualizado para @TeraHash |
| Sessão 12 | ★ useEthGasCost.ts: hook ETH/USD (Chainlink) + gas price (EIP-1559) para estimativas de gas |
| Sessão 12 | ★ QuoteBreakdown: gas em ETH + USD (~0.004 ETH ($12.50)), platform fee em USD via Chainlink |
| Sessão 12 | ★ MEV Protection toggle: switch no SwapBox que filtra quotes para sources mevProtected (CoW only) |
| Sessão 12 | ★ MEV toggle: warning quando CowSwap indisponível, tooltip explicativo, visual inline styles |
| Sessão 13 | ★ Custom Token Import: paste ERC-20 address → auto-detect symbol/name/decimals via RPC |
| Sessão 13 | ★ useTokenImport hook: on-chain calls (ERC20 ABI) para token metadata |
| Sessão 13 | ★ WalletHistory component: Etherscan API integration, últimas 25 txs, parsed method names |
| Sessão 13 | ★ Auto-slippage: smart calculation baseado em token pair (stable-stable 0.1%, major-stable 0.3%, major-major 0.5%, memecoin 2.0%) |
| Sessão 13 | ★ Mobile responsive polish: hamburger menu, no-scrollbar tabs, spacing optimizations |
| Sessão 13 | ★ Header: CSS var para light mode support (--header-bg-light/dark) |
| Sessão 13 | ★ Mode selector expandido: 7 tabs (Swap, DCA, Limit, SL/TP, History, Analytics) |
