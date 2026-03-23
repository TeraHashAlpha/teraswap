# TeraSwap — DEX Meta-Aggregator

> **Version:** 0.1.0 · **Network:** Ethereum Mainnet (Chain ID 1) · **Status:** Live
> **Stack:** Next.js 14 · React 18 · TypeScript · Viem · Wagmi · RainbowKit · Framer Motion

---

## What is TeraSwap?

TeraSwap is a client-side **meta-aggregator** for decentralized exchanges on Ethereum. It queries **11 independent liquidity sources** simultaneously, compares the results, and routes each swap through whichever source offers the best net output — accounting for gas costs, slippage, and pool fees.

Every swap is validated against **Chainlink price oracles** (22 token feeds) and an **outlier detection system** filters manipulated or bogus quotes before they can be selected.

---

## Project Structure

```
src/
├── app/
│   ├── layout.tsx          # Root layout with RainbowKit/Wagmi providers
│   ├── page.tsx            # Main page router (landing | swap | docs)
│   └── providers.tsx       # Wagmi + RainbowKit + React Query config
│
├── components/
│   ├── Header.tsx          # Fixed header with nav, wallet connect, network indicator
│   ├── Footer.tsx          # Footer with Docs link, fee info, live block number
│   ├── LandingPage.tsx     # 6-section animated landing page (687 lines)
│   ├── DocsPage.tsx        # Interactive documentation/whitepaper (456 lines)
│   ├── SwapBox.tsx         # Main swap interface (token selectors, amount input)
│   ├── SwapButton.tsx      # Swap execution button with state management
│   ├── QuoteBreakdown.tsx  # Quote comparison, route display, fee breakdown
│   ├── TokenSelector.tsx   # Token search/select modal
│   ├── SlippageModal.tsx   # Slippage tolerance settings
│   ├── SwapHistory.tsx     # Transaction history (localStorage)
│   ├── ActiveApprovals.tsx # Active token approval tracker
│   ├── DCAPanel.tsx        # DCA (Dollar-Cost Averaging) interface
│   ├── LimitOrderPanel.tsx # Limit orders via CoW Protocol
│   ├── ConditionalOrderPanel.tsx # Stop-Loss / Take-Profit orders
│   ├── SplitRouteVisualizer.tsx  # Multi-DEX split route display
│   ├── AnalyticsDashboard.tsx    # Public analytics (volume, routes, activity)
│   ├── ToastProvider.tsx   # Context-based toast notification system
│   ├── Skeleton.tsx        # Reusable skeleton loading components
│   ├── HelpButton.tsx      # Floating help button (bottom-right)
│   ├── HelpDrawer.tsx      # Slide-in FAQ panel with accordion
│   ├── ParticleNetwork.tsx # Canvas particle network with cursor proximity glow
│   ├── TokenImportModal.tsx # ★ Custom ERC-20 address import modal with auto-detect
│   └── WalletHistory.tsx   # ★ Etherscan API wallet transaction history display
│
├── hooks/
│   ├── useQuote.ts         # Auto-refreshing quote fetcher (15s interval)
│   ├── useSwap.ts          # Swap execution with wallet interaction
│   ├── useApproval.ts      # Token approval flow (ERC-20 / Permit2 / EIP-2612)
│   ├── useChainlinkPrice.ts# Real-time Chainlink oracle price fetching
│   ├── useEthGasCost.ts    # ETH/USD + gas price for gas estimates in ETH/USD
│   ├── useActiveApprovals.ts# Track live approval statuses
│   ├── useDCAEngine.ts     # DCA engine React bridge
│   ├── useLimitOrder.ts    # Limit order lifecycle (create, sign, poll, cancel)
│   ├── useConditionalOrder.ts # SL/TP Chainlink monitoring + auto submission
│   ├── useSplitRoute.ts    # Multi-DEX split route analysis
│   ├── useAnalytics.ts     # Dashboard data aggregation
│   ├── useSwapHistory.ts   # Persist swap history to localStorage
│   ├── useDebounce.ts      # Input debouncing utility
│   ├── useTokenImport.ts   # ★ Custom ERC-20 token metadata fetcher (symbol/name/decimals)
│   └── useWalletHistory.ts # ★ Etherscan API wallet transaction history
│
└── lib/
    ├── api.ts              # Meta-aggregator core — 10 source adapters (1507 lines)
    ├── constants.ts         # Chain config, API endpoints, contract addresses, Chainlink feeds
    ├── tokens.ts           # Token list with addresses, decimals, symbols
    ├── chainlink.ts        # Chainlink ABI + price deviation checker
    ├── uniswap.ts          # Uniswap V3 Quoter/Router ABI + fee tier detection
    ├── approvals.ts        # Permit2, EIP-2612, standard ERC-20 approval logic
    ├── format.ts           # Number formatting utilities
    ├── rate-limiter.ts     # Sliding-window rate limiter (global, quote, price)
    ├── source-monitor.ts   # Per-aggregator health tracking
    ├── help-content.ts     # FAQ content data (6 sections)
    ├── analytics-tracker.ts# Trade event recording + dashboard aggregation
    ├── analytics-types.ts  # Analytics TypeScript interfaces
    ├── dca-engine.ts       # DCA execution engine with smart windows
    ├── dca-types.ts        # DCA TypeScript interfaces
    ├── limit-order-api.ts  # CoW Protocol limit order API
    ├── limit-order-types.ts# Limit order interfaces
    ├── conditional-order-types.ts # SL/TP order types
    ├── price-monitor.ts    # Chainlink price polling + trigger detection
    ├── split-routing-types.ts # Split route types + configs
    ├── split-router.ts     # Split routing optimizer engine
    ├── sybil-detector.ts   # Wash trading detection (6 heuristics)
    ├── sounds.ts           # Web Audio synthesized sounds
    └── wagmiConfig.ts      # Wagmi chain + fallback RPC transport
```

**Total:** ~12,000+ lines of TypeScript/TSX across 55+ files.

---

## Liquidity Sources (11)

### API Aggregators (7)

| Source | API Base | Key Required | Description |
|--------|----------|:---:|-------------|
| **1inch** | `api.1inch.dev/swap/v6.0/1` | Yes | Pathfinder algorithm, 400+ pools |
| **0x / Matcha** | `api.0x.org` | Yes | Professional RFQ, Permit2 native |
| **Velora (ParaSwap)** | `api.paraswap.io` | No | Multi-path routing, MEV-aware |
| **Odos** | `api.odos.xyz` | No | Smart order routing, multi-hop |
| **KyberSwap** | `aggregator-api.kyberswap.com` | No | Dynamic routing, 100+ DEXs |
| **OpenOcean** | `open-api.openocean.finance/v4/1` | No | 40+ chains, 1000+ sources |

### Direct Protocols (4)

| Source | Type | Description |
|--------|------|-------------|
| **Uniswap V3** | On-chain | Concentrated liquidity, auto fee-tier detection (0.01/0.05/0.3/1%) |
| **SushiSwap** | API | RouteProcessor4 with native pool routing |
| **Balancer** | SOR API | Smart Order Router for weighted/stable/boosted pools |
| **Curve Finance** | On-chain | CurveRouterNG, pool registry, get_dy/exchange |

### Intent-Based (1)

| Source | Type | Description |
|--------|------|-------------|
| **CoW Protocol** | Batch Auction | Off-chain orders, solver competition, full MEV protection, gasless |

---

## Core Architecture

### Meta-Aggregator Flow

```
User Input → fetchMetaQuote()
                 ├── fetch1inchQuote()       ─┐
                 ├── fetch0xQuote()           │
                 ├── fetchVeloraQuote()       │
                 ├── fetchOdosQuote()         │ All 10 sources
                 ├── fetchKyberSwapQuote()    │ queried in parallel
                 ├── fetchCowSwapQuote()      │ with 5s timeout each
                 ├── fetchUniswapV3Quote()    │
                 ├── fetchOpenOceanQuote()    │
                 ├── fetchSushiSwapQuote()    │
                 └── fetchBalancerQuote()     ─┘
                          │
                    Promise.allSettled()
                          │
                    Filter valid quotes (toAmount > 0)
                          │
                    Sort by toAmount descending
                          │
                    Outlier Detection (>3x median removed)
                          │
                    Return { best, all[], fetchedAt }
```

### Quote Lifecycle

1. **User types amount** → debounced (500ms)
2. **useQuote hook** calls `fetchMetaQuote()` with token addresses + amount in wei
3. **10 parallel requests** fire with independent 5s timeouts
4. **Normalization** — each adapter maps its API response to `NormalizedQuote`
5. **Outlier filter** — quotes >3x the median are excluded from "best" selection
6. **Chainlink validation** — `useChainlinkPrice` compares rate vs oracle (2% warn / 5% block)
7. **UI renders** comparison table with best highlighted
8. **Auto-refresh** every 15 seconds

### Swap Execution

1. **Approval check** — `useApproval` determines if token needs approval
   - **EIP-2612 Permit**: off-chain signature (gasless)
   - **Permit2**: single approval + off-chain permit
   - **Standard ERC-20**: on-chain `approve()` tx
2. **fetchSwapFromSource()** — fetches calldata from winning source
3. **Wallet sends tx** — via wagmi `writeContract` / `sendTransaction`
4. **CoW Protocol special path** — signs off-chain order instead of on-chain tx

---

## Security Layers

### 1. Chainlink Oracle Validation

- **22 token price feeds** on Ethereum mainnet (USDC, USDT, DAI, USDe, WBTC, LINK, UNI, AAVE, COMP, MKR, SNX, CRV, YFI, BAL, SUSHI, LDO, APE, MATIC, ENS, 1INCH, FXS, RPL, SHIB, PEPE)
- ETH/USD base feed at `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`
- **Warning threshold**: 2% deviation from oracle price
- **Block threshold**: 5% deviation — swap blocked
- Graceful fallback when oracle unavailable (native `title` tooltip on "Rate" label)

### 2. Outlier Detection

Protects against manipulated pools returning absurd quotes:
- After sorting all quotes by `toAmount`, calculate the median
- Any quote >3x the median is excluded from "best" selection
- Still shown in the comparison list for transparency
- Catches scenarios like OpenOcean routing through low-liquidity PancakeV3 pools

### 3. MEV Protection

- **CoW Protocol**: batch auction execution — solvers compete, no sandwich attacks
- **MEV Protection toggle**: user can force all swaps through CoW Protocol
- Visual badges on quote sources (`AGGREGATOR_META.mevProtected`)

### 3b. Rate Limiting & Source Monitoring

- **Global rate limiter**: sliding-window, 30 requests/min for meta quotes
- **Source health monitoring**: per-aggregator tracking (latency, success rate, consecutive failures)
- **Degradation detection**: sources with 5+ consecutive failures flagged as degraded
- **Fallback RPC**: wagmi `fallback()` transport with `rank: true` for latency-based provider selection

### 4. Approval Safety

- **No infinite approvals** — each approval scoped to exact amount
- **Permit2** support for gasless off-chain signatures
- **EIP-2612** detection for native permit support
- `ActiveApprovals` component tracks live approval statuses

### 5. Error Handling

- `friendlyError()` maps raw API/network errors to user-readable messages
- `parseWagmiError()` handles 8 wallet error patterns (user rejected, gas too low, nonce, timeout, etc.)
- Distinguishes all-timeout vs all-network vs individual source failures

---

## Uniswap V3 Integration (Direct On-Chain)

The Uniswap V3 adapter is unique — it talks directly to mainnet contracts:

- **QuoterV2** (`0x61fFE014bA17989E743c5F6cB21bF9697530B21e`) — for price quotes
- **SwapRouter02** (`0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`) — for execution

### Auto Fee-Tier Detection

Tests all 4 Uniswap V3 fee tiers in parallel:

| Tier | Fee | Use Case |
|------|-----|----------|
| 100 | 0.01% | Stablecoin pairs |
| 500 | 0.05% | Most common |
| 3000 | 0.3% | Standard volatility |
| 10000 | 1% | Exotic pairs |

Results are cached per token pair with TTL expiry. The UI shows all tested tiers with the winner highlighted.

---

## Custom Token Import

Users can paste any ERC-20 contract address to auto-detect token metadata:

**Features:**
- **One-click detection**: Symbol, Name, Decimals fetched via RPC
- **Persistent list**: Imported tokens saved to `localStorage`
- **Address validation**: Checksum verification via `getAddress()`
- **Fallback safety**: Symbol defaults to first 4 chars of address if fetch fails

**Flow:** TokenImportModal → useTokenImport hook (viem readContract) → TokenSelector list

**New Files:**
- `src/components/TokenImportModal.tsx`
- `src/hooks/useTokenImport.ts`

---

## Wallet History

Displays the last 25 transactions from connected wallet via Etherscan API.

**Features:**
- **Transaction details**: Timestamp, method, to/from, value, status
- **Method parsing**: Attempts to decode function selectors (e.g., "Swap", "Transfer", "Approve")
- **Etherscan links**: Click to view on block explorer
- **Caching**: 5-min localStorage cache to avoid API quota exhaustion
- **Fallback**: Graceful degradation if API limit exceeded

**New Files:**
- `src/components/WalletHistory.tsx`
- `src/hooks/useWalletHistory.ts`

**Integration:** New "History" tab in Mode Selector (see below)

---

## Auto-Slippage

Smart slippage calculation based on token pair classification.

**Algorithm:**
| Token Pair | Auto-Slippage |
|------------|---|
| Stablecoin ↔ Stablecoin (USDC↔DAI) | 0.1% |
| Major ↔ Stablecoin (ETH↔USDC) | 0.3% |
| Major ↔ Major (ETH↔WBTC) | 0.5% |
| Memecoin / Exotic pairs | 2.0% |

**Classification:**
- **Stablecoins**: USDC, USDT, DAI, USDe, FRAX
- **Major tokens**: ETH, WBTC, UNI, LINK, AAVE, CRV, SUSHI, BAL, LDO

**UX:** Auto-slippage appears in SlippageModal with user override option.

---

## Frontend

### Routing

The app uses `useState<'landing' | 'swap' | 'docs' | 'privacy' | 'terms'>` for page routing (no Next.js file-based routing beyond the single page).

### Mode Selector (7 tabs)

Tab navigation within swap interface:

| # | Tab | Features |
|---|-----|----------|
| 1 | **Swap** | Meta-aggregator core, 11 liquidity sources, MEV protection toggle, split routing, quote comparison |
| 2 | **DCA** | Dollar-Cost Averaging, smart windows (price-aware), position tracking |
| 3 | **Limit** | Limit Orders via CoW Protocol (gasless, partially fillable, expiry options) |
| 4 | **SL·TP** | Stop Loss / Take Profit conditional orders with Chainlink monitoring |
| 5 | **History** | Wallet transaction history via Etherscan API (last 25 txs, method parsing) |
| 6 | **Analytics** | Public analytics dashboard (volumes, best routes, popular pairs, activity trends) |
| 7 | **Docs** | Interactive documentation (whitepaper-style, sticky nav, flow diagrams) |

### Landing Page (6 sections)

1. **Hero** — animated headline, trust badge, "Launch App" CTA
2. **Performance** — animated counters, liquidity source diagram
3. **Security** — shield animation, security feature cards
4. **Experience** — mock swap UI, feature highlights
5. **Features** — 4-card grid (MEV, Gasless, Chainlink, History)
6. **Bottom CTA** — pulsing glow, final call to action

### Docs Page (7 sections)

Interactive documentation with sticky sidebar navigation:
1. Overview — protocol description + tags
2. Architecture — animated flow diagram
3. Liquidity Sources — categorized cards for all 10 sources
4. Smart Routing — 5-step numbered process
5. Security — 6 security feature cards
6. Fee Structure — transparent fee table
7. Roadmap — 3-phase timeline (Live / Next / Planned)

### ParticleNetwork Background

Canvas-based particle network with:
- 80 floating particles with velocity + boundary bounce
- Connection lines between nearby particles (< 160px)
- **Cursor proximity brightness**: connections within 250px of cursor glow brighter (0.08 → 0.35 opacity)
- Mouse-to-particle interaction lines
- Gentle mouse repulsion (particles drift away from cursor)
- Particle glow halos near cursor

### Quote Breakdown UI

Displays for the winning quote:
- Source label with best-via indicator + MEV/Direct badges
- Savings vs second-best quote
- Route path
- Uniswap V3 fee tier (with ⓘ tooltip explaining tiers)
- Price impact warning (amber >3%, red >5%) via Chainlink deviation
- Slippage setting (editable)
- Gas estimate in ETH + USD (~0.004 ETH ($12.50)) via Chainlink + EIP-1559
- Platform fee with USD equivalent via Chainlink
- Approval method (Permit2 / EIP-2612 / Standard)
- Minimum output guarantee
- Comparison table for all source quotes

### MEV Protection Toggle

- Toggle switch in SwapBox between Receive and Quote Breakdown
- When ON: filters quotes to MEV-protected sources only (CoW Protocol)
- Warning banner when no MEV-safe quote available
- Tooltip explaining batch auctions and sandwich attack protection

### Help Center

- Floating "?" button (bottom-right, visible on all pages except landing)
- Slide-in drawer with 6 FAQ sections (Getting Started, Swaps, DCA, Limit Orders, SL/TP, Security)
- Accordion navigation with Framer Motion animations
- Forced dark theme via inline styles (works regardless of context)
- External link to X (@TeraHash)

### Toast Notifications

- Context-based system via `useToast()` hook
- 5 types: loading, success, error, warning, info
- Loading → success/error transitions via `useRef` ID tracking
- Wired into: SwapBox, DCAPanel, LimitOrderPanel, ConditionalOrderPanel

---

## Fee Structure

| Fee | Amount | Details |
|-----|--------|---------|
| Platform fee | 0.1% | Deducted from input before swap. Configurable via `NEXT_PUBLIC_FEE_PERCENT`. |
| Pool fees | Variable | Charged by DEX (e.g. 0.01–1% for Uniswap V3). TeraSwap picks cheapest. |
| Gas | Variable | Network gas in ETH. CoW swaps are gasless for user. |
| Hidden fees | None | No spread markup, referral fees, or withdrawal fees. |

Fee recipient address: configurable via `NEXT_PUBLIC_FEE_RECIPIENT`.

---

## Contracts & Addresses

| Contract | Address | Purpose |
|----------|---------|---------|
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Gasless approvals |
| CoW Vault Relayer | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` | CoW token approval target |
| CoW Settlement | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | Order settlement |
| Odos Router V3 | `0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559` | Odos swap execution |
| Uniswap SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | Uniswap V3 swaps |
| Uniswap QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | Uniswap V3 quotes |
| OpenOcean Proxy | `0x6352a56caadC4F1E25CD6c75970Fa768A3304e64` | OpenOcean approval target |
| SushiSwap RP4 | `0x46B3fDF7b5CDe91Ac049936bF0bDb12c5d22202e` | SushiSwap approval target |
| Balancer Vault V2 | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` | Balancer approval target |
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | Wrapped ETH |
| Chainlink ETH/USD | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` | ETH price oracle |

---

## Environment Variables

```env
# Required
NEXT_PUBLIC_1INCH_API_KEY=       # 1inch API key
NEXT_PUBLIC_0X_API_KEY=          # 0x/Matcha API key

# Optional
NEXT_PUBLIC_FEE_PERCENT=0.1      # Platform fee percentage
NEXT_PUBLIC_FEE_RECIPIENT=0x...  # Fee recipient address
NEXT_PUBLIC_RPC_URL=             # Custom RPC (default: public Ethereum)
NEXT_PUBLIC_FALLBACK_RPC_1=      # Fallback RPC #1 (e.g. Ankr)
NEXT_PUBLIC_FALLBACK_RPC_2=      # Fallback RPC #2 (e.g. PublicNode)
NEXT_PUBLIC_LAUNCH_DATE=         # Countdown gate (empty = live, ISO date = countdown)
```

---

## Scripts

```bash
npm run dev          # Start development server
npm run dev:fork     # Dev with local Anvil fork
npm run build        # Production build
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
npm run fork         # Start Anvil mainnet fork
npm run deal         # Deal test tokens to dev wallet
npm run check:fee    # Verify fee configuration
```

---

## Dependencies

### Core
- **Next.js 14** — React framework with App Router
- **React 18** — UI library
- **TypeScript** — type safety
- **Viem** — Ethereum interactions (encoding, decoding, addresses)
- **Wagmi** — React hooks for wallets and contracts
- **RainbowKit** — Wallet connect UI

### UI
- **Framer Motion** — animations and transitions
- **Tailwind CSS** — utility-first styling
- **tsparticles** — particle effects (legacy, replaced by custom canvas)

### State
- **Zustand** — lightweight state management
- **TanStack React Query** — server state + caching (via Wagmi)

---

## Roadmap

### Phase 1 — Live ✅
- Meta-aggregator with 11 liquidity sources (incl. Curve Finance on-chain)
- Chainlink oracle validation (22 feeds)
- MEV protection via CoW Protocol + user toggle
- Permit2 gasless approvals + EIP-2612
- Outlier detection for manipulated quotes
- Smart DCA engine with price-aware buying windows
- Limit Orders via CoW Protocol (gasless, partially fillable)
- Stop-Loss / Take-Profit conditional orders
- Split Routing optimizer (2-way, 3-way multi-DEX splits)
- Analytics Dashboard (public) + Admin Monitor (private, Bloomberg-style)
- Toast notification system (loading/success/error transitions)
- Help Center (floating button + FAQ drawer)
- Gas estimates in ETH + USD, platform fee in USD
- Rate limiting + source health monitoring + fallback RPC
- Interactive docs/whitepaper page
- Animated landing page with particle network background
- Custom Token Import (paste ERC-20 address, auto-detect metadata)
- Wallet History (Etherscan API, last 25 transactions, method parsing)
- Auto-Slippage (smart calculation based on token pair classification)
- Mobile responsive design (hamburger menu, no-scrollbar tabs)
- Mode Selector expanded to 7 tabs (Swap, DCA, Limit, SL/TP, History, Analytics, Docs)

### Phase 2 — Next
- Base network support (multi-chain)
- Supabase analytics persistence
- Bebop/Paraswap RFQ integration
- Trailing stop-loss

### Phase 3 — Planned
- Multi-chain expansion (Arbitrum, Optimism, Polygon)
- Cross-chain swaps
- Governance token
- DAO treasury management

---

*Built with precision. Verified by Chainlink. Protected from MEV.*
