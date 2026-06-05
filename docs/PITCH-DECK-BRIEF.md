# TeraSwap — Investor Pitch Deck Brief

> **For:** Design team
> **Deliverable:** 30-slide pitch deck, 16:9 widescreen
> **Versions:** English first, then Portuguese translation (same deck, translated)
> **Tone:** Technical but accessible. We're speaking to crypto-literate investors who may not be developers. Lead with the problem, prove with the tech, close with the opportunity.
> **Brand:** Dark theme (#080B10 background), gold accent (#D4A843 / cream-gold), clean typography. Reference: https://teraswap.app

---

## Slide Structure

### SECTION 1 — HOOK (Slides 1-3)

**Slide 1 — Title**
- TeraSwap logo (large, centered)
- Tagline: "The Gold Standard of DeFi Trading"
- Subtitle: "Ethereum Meta-Aggregator · 11 Liquidity Sources · Autonomous Execution"
- Minimal. Let the brand breathe.

**Slide 2 — The Problem**
- DeFi traders lose money on every swap they don't optimize.
- Key stats to visualize:
  - Average user checks 1-2 DEX sources (misses 9+)
  - MEV bots extract ~$500M/year from Ethereum users
  - 78% of DeFi users don't use limit orders because the UX is too complex
  - No single aggregator combines best-rate routing + MEV protection + autonomous orders
- Visual: fragmented DEX landscape diagram — user in the middle, overwhelmed by choices

**Slide 3 — The Solution (One Sentence)**
- "TeraSwap queries 11 liquidity sources simultaneously, protects every swap from MEV extraction, and executes conditional orders autonomously — no browser required."
- Visual: clean before/after. Left: chaotic multi-tab DeFi experience. Right: single TeraSwap interface.

---

### SECTION 2 — PRODUCT (Slides 4-10)

**Slide 4 — How It Works (Architecture Overview)**
- Simplified 3-layer diagram:
  - Top: User (wallet) → TeraSwap Interface
  - Middle: Meta-Aggregation Engine (11 sources queried in parallel)
  - Bottom: Smart Contracts (FeeCollector + OrderExecutor) → Blockchain
- Keep it visual, not text-heavy. The architecture diagram from the docs can be simplified.

**Slide 5 — Meta-Aggregation Engine**
- 11 liquidity sources: 1inch, 0x, Velora (ParaSwap), Odos, KyberSwap, CoW Protocol, OpenOcean, Uniswap V3, SushiSwap, Balancer V2, Curve Finance
- Show logos in a grid
- Key point: "We don't compete with DEXes — we make them compete for the user."
- Stat: parallel queries with 10s timeout, best rate wins

**Slide 6 — MEV Protection**
- What is MEV? (1-2 sentences for non-technical investors)
- Our approach: CoW Protocol batch auctions + Chainlink oracle validation + Flashbots Protect relay
- "Every swap is validated against real-time oracle prices. Suspicious deviations are blocked automatically."
- Visual: shield/protection metaphor with the three layers

**Slide 7 — Autonomous Order Engine**
- Order types: Limit Orders, Stop-Loss, Take-Profit, DCA
- Key differentiator: "No browser tab needed. Our self-hosted executor monitors conditions 24/7 and executes on-chain when conditions are met."
- EIP-712 signed orders — user signs once, executor handles the rest
- Visual: timeline showing order lifecycle (sign → monitor → execute → notify)

**Slide 8 — Gasless Approvals**
- Permit2 / EIP-2612 off-chain signing
- "Users approve tokens without paying gas. One signature, not one transaction."
- This matters for UX — reduces friction for first-time users

**Slide 9 — Privacy & Security**
- Privacy proxy: user IP hidden from all 11 external APIs
- Multi-oracle price validation (Chainlink + DefiLlama)
- Smart contract audited: all 13 findings closed (4H/5M/4L → 0C/0H open)
- Secret scanning, signed commits, branch protection, 6-job CI pipeline
- Visual: security layers diagram

**Slide 10 — Product Screenshots**
- 3-4 high-quality screenshots:
  - Swap interface with quote breakdown
  - Order Engine (limit order being placed)
  - Analytics dashboard showing volume trends
  - Mobile view (Capacitor)
- Use actual app screenshots from teraswap.app

---

### SECTION 3 — TECHNOLOGY (Slides 11-15)

**Slide 11 — Tech Stack Overview**
- Frontend: Next.js 16, React 18, TypeScript, Tailwind
- Web3: Wagmi, Viem, RainbowKit (modern stack, no legacy ethers.js)
- Contracts: Solidity 0.8.28, Foundry (gas-optimized)
- Backend: Vercel serverless, Supabase (PostgreSQL + real-time)
- Monitoring: Sentry, Cloudflare Worker cron, Telegram alerts, on-chain event watcher
- Visual: tech logo grid with layer labels

**Slide 12 — Smart Contracts**
- Two contracts deployed on Ethereum Mainnet:
  - TeraSwapFeeCollector V2 — handles fee collection with minimumOutput validation
  - TeraSwapOrderExecutor v2 — autonomous order execution with Chainlink validation
- 48-hour timelock on admin functions
- Verified on Etherscan
- Built with OpenZeppelin 5.0+

**Slide 13 — Security Track Record**
- 30+ sprints, each individually audited (0C/0H required to merge)
- 989 tests (970 TypeScript + 19 Foundry), 0 skipped
- External security analysis: 4 High, 5 Medium, 4 Low — ALL 13 CLOSED
- CI: 6 automated jobs + CodeQL + Dependabot + secret scanning
- Monitoring: 5-layer health check (Cloudflare cron → API → contract → executor → alerts)
- Visual: timeline of security milestones

**Slide 14 — Split Routing Innovation**
- For large trades: automatically splits across multiple DEXes
- Tests combinations (2-way/3-way at 25/50/75% splits)
- Only executes if improvement > 50 basis points
- "Large traders get institutional-grade execution through a retail interface."

**Slide 15 — Development Velocity**
- 30 sprints completed in ~8 weeks
- Solo architect + AI-powered development pipeline (Claude Code Agent + Auditor)
- Every commit GPG-signed, every sprint audited
- 989 tests, 0 technical debt compromises on security
- This proves: small team, high output, production-grade quality

---

### SECTION 4 — MARKET (Slides 16-20)

**Slide 16 — Market Size (TAM/SAM/SOM)**
- TAM: Total DEX trading volume on Ethereum (~$500B/year, source: DeFi Llama / The Block)
- SAM: Aggregator-routed volume (~$180B/year, ~36% of DEX volume)
- SOM: Realistic year-1 target — $50M monthly volume (0.03% of SAM)
- Revenue at 0.1% fee on SOM: ~$600K/year
- Visual: concentric circles (TAM → SAM → SOM) with dollar values

**Slide 17 — Competitive Landscape**
- Comparison matrix (TeraSwap vs. competitors):

| Feature | TeraSwap | 1inch | CoW Swap | Paraswap | 0x/Matcha |
|---------|----------|-------|----------|----------|-----------|
| Liquidity sources | 11 | 5-8 | 1 (batch) | 5-6 | 3-4 |
| MEV protection | ✅ (3-layer) | Partial | ✅ (native) | ❌ | ❌ |
| Autonomous orders | ✅ (4 types) | ❌ | ❌ | ❌ | ❌ |
| Gasless approvals | ✅ | ✅ | ✅ | ❌ | ✅ |
| Privacy proxy | ✅ | ❌ | ❌ | ❌ | ❌ |
| Split routing | ✅ | ✅ | ❌ | ✅ | ❌ |
| Open fee model | 0.1% | 0-3% | Free* | 0-2% | Free* |
| Multi-chain | Phase 2 | ✅ | ❌ | ✅ | ✅ |

- Note: "Free*" means fee is embedded in routing or MEV capture
- Visual: feature matrix with check/cross icons

**Slide 18 — Competitive Moat**
- 3 defensibility pillars:
  1. **Aggregation breadth** — 11 sources (most in class) means consistently better rates
  2. **Security-first architecture** — audited sprint-by-sprint, not post-launch. 989 tests. This compounds.
  3. **Autonomous execution** — limit/SL/DCA without browser = stickiness. Users set and forget.
- "We're not the first aggregator. We're the most thorough."

**Slide 19 — Growth Strategy**
- Phase 1 ✅: Ethereum mainnet (LIVE)
- Phase 2: Multi-chain (Arbitrum → Base → Polygon) — 10x addressable market
- Phase 3: Advanced trading (TWAP, trailing stops, portfolio rebalancing)
- Phase 4: Protocol (governance token, fee-sharing, public API, referral program)
- Visual: phased roadmap timeline

**Slide 20 — Go-to-Market**
- Crypto Twitter / DeFi community (organic — already started)
- Integration partnerships (wallet integrations, portfolio trackers)
- Whale outreach (split routing is a whale feature)
- Content marketing: security transparency as differentiator
- "We publish our audit reports. No other aggregator does this."

---

### SECTION 5 — BUSINESS MODEL (Slides 21-24)

**Slide 21 — Revenue Model**
- 0.1% protocol fee on every swap through FeeCollector V2
- Applied after routing optimization — user still gets best rate
- Fee collected on-chain, transparent, verifiable
- Future revenue streams:
  - Affiliate fees from 0x/CoW Protocol
  - Positive slippage sharing (ADR-006, data collection in progress)
  - Public API subscriptions (Phase 4)
  - Premium features (advanced order types, priority execution)

**Slide 22 — Unit Economics**
- Cost per swap: ~$0 (Vercel serverless, Supabase free tier, Cloudflare free)
- Revenue per swap: 0.1% of swap value
- Example: $10K swap → $10 fee → ~$0 marginal cost
- Infrastructure costs scale with volume but stay minimal due to serverless architecture
- Break-even: ~$5K/month volume covers all infrastructure

**Slide 23 — Financial Projections (Conservative)**
- Year 1: $50M monthly volume → $600K annual revenue
- Year 2: Multi-chain launch → $200M monthly → $2.4M annual revenue
- Year 3: Advanced features + API → $500M monthly → $6M annual revenue
- Note: these are conservative. 1inch processes $2B+/month.
- Visual: revenue growth chart (bar chart, 3 years)

**Slide 24 — Use of Funds**
- Pie chart with allocation:
  - 40% — Engineering (multi-chain, advanced features, mobile)
  - 25% — Security (formal verification, bug bounties, ongoing audits)
  - 20% — Growth (marketing, partnerships, community)
  - 10% — Operations (infrastructure, legal, compliance)
  - 5% — Reserve

---

### SECTION 6 — TEAM & CLOSE (Slides 25-30)

**Slide 25 — Team**
- Founder: TeraHash (solo founder, architect)
  - Full-stack architect, DeFi native
  - Built TeraSwap from zero to production in 8 weeks
  - Security-obsessed: every sprint audited, every commit signed
- AI-augmented development: Claude Code Agent + automated auditor
- "One person with the right tools can outship a team of 10."
- Note for design: placeholder for team photo/avatar

**Slide 26 — Development Methodology**
- Unique approach: Architect → Code Agent → Auditor pipeline
- Every feature goes through: Design → Prompt → Implement → Audit → Merge
- 0C/0H policy: no critical or high findings allowed in any sprint
- This is a competitive advantage: speed of a solo dev, quality of an enterprise team

**Slide 27 — Traction & Milestones**
- Timeline of key milestones:
  - Phase 1 complete (Autonomous Order Engine)
  - 30 sprints, all approved
  - 989 tests passing
  - 2 smart contracts on mainnet (verified)
  - 11 liquidity sources integrated
  - All 13 external security findings closed
  - FeeCollector V2 live with real volume
  - ERC-7730 clear signing submitted to Ethereum registry
- Visual: milestone timeline

**Slide 28 — What We're Raising**
- [PLACEHOLDER — fill in raise amount and terms]
- Suggested structure: "Raising $X at $Y valuation for Z months of runway"
- Key message: "This isn't a whitepaper. This is a live, audited, revenue-generating protocol."

**Slide 29 — Vision**
- "DeFi trading should be as safe and efficient as traditional finance — but permissionless."
- Long-term vision: TeraSwap as the execution layer for all on-chain trading
- From aggregator → to trading protocol → to infrastructure
- Visual: expanding circles from current state to vision

**Slide 30 — Contact & Links**
- Website: https://teraswap.app
- GitHub: [private — available under NDA]
- Twitter/X: @TeraHash
- Email: [contact email]
- Etherscan (FeeCollector V2): `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459`
- "Every line of code is audited. Every transaction is verifiable."

---

## Design Notes

**Color palette:**
- Primary background: #080B10 (deep dark blue)
- Accent: #D4A843 (cream-gold — used for CTAs, highlights, active states)
- Text: #F5F0E8 (cream white) for headings, #A09B90 (muted cream) for body
- Success: #4ADE80, Error: #EF4444, Info: #60A5FA

**Typography:**
- Headings: Clash Display (or Inter Bold as fallback)
- Body: Inter
- Code/technical: JetBrains Mono

**Visual style:**
- Dark, cinematic feel (reference: teraswap.app landing page)
- Particle network effects as subtle backgrounds (not distracting)
- Gold accents on key metrics and CTAs
- Minimal text per slide — let visuals carry
- Data visualizations in gold/cream on dark background

**Logo & assets:**
- TeraSwap logo (SVG available in `/public/`)
- DEX source logos (1inch, 0x, CoW, etc.) for the aggregation slide
- Screenshots from live app
- Architecture diagrams (simplify from docs)

**Slide dimensions:** 16:9 (1920×1080)

**File format:** Figma source + exported PDF + PPTX

---

## Key Numbers for Reference

| Metric | Value |
|--------|-------|
| Liquidity sources | 11 |
| Test count | 989 (970 TS + 19 Foundry) |
| Sprints completed | 30 |
| External findings closed | 13/13 (4H + 5M + 4L) |
| Open critical/high findings | 0 |
| Smart contracts on mainnet | 2 (FeeCollector V2 + OrderExecutor v2) |
| Protocol fee | 0.1% |
| Order types | 4 (Limit, Stop-Loss, Take-Profit, DCA) |
| CI jobs | 6 + CodeQL + Dependabot |
| Chainlink oracle feeds | 29 |
| EIP standards used | EIP-712, EIP-2612, EIP-1559, ERC-7730 |
| Admin timelock | 48 hours |
| Development time | ~8 weeks (Phase 1) |

---

## Portuguese Version

After the English deck is approved, create an identical Portuguese (PT-PT) translation. Key translation notes:

- "Meta-Aggregator" → "Meta-Agregador"
- "Autonomous Order Engine" → "Motor de Ordens Autónomo"
- "Gasless Approvals" → "Aprovações sem Gas"
- "Split Routing" → "Routing Dividido"
- "MEV Protection" → "Proteção contra MEV"
- Keep technical terms in English where standard in crypto (DeFi, MEV, EIP, DEX, etc.)
- Use PT-PT (not BR-PT): "utilizador" not "usuário", "telemóvel" not "celular"
- Financial projections in USD (universal for crypto investors)
