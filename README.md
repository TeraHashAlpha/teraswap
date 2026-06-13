<h1 align="center">TeraSwap</h1>
<p align="center">
  <strong>A security-first DEX meta-aggregator for Ethereum &amp; Base.</strong><br>
  Best-execution routing across 11 liquidity sources, on-chain conditional orders,
  MEV-protected settlement, and gasless approvals.
</p>
<p align="center">
  <img alt="Networks" src="https://img.shields.io/badge/networks-Ethereum%20%2B%20Base-627EEA">
  <img alt="Contracts" src="https://img.shields.io/badge/Solidity-0.8.28-363636?logo=solidity">
  <img alt="Frontend" src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs">
  <img alt="Tests" src="https://img.shields.io/badge/tests-1600%2B%20passing-3fb950">
  <img alt="Oracles" src="https://img.shields.io/badge/Chainlink-29%20feeds-375BD2?logo=chainlink">
</p>

What is TeraSwap?

TeraSwap is a meta-aggregator: instead of routing through a single DEX or a single aggregator, it
queries many liquidity sources in parallel, validates every quote against independent price oracles, and
settles through the venue that gives the user the best net outcome after gas and fees. It runs on
Ethereum Mainnet and Base, and layers on order types and protections that most swap interfaces
don't offer.

The guiding principle is simple: a swap should never execute on bad data, and the user should always
see what they're signing.

Highlights


Best-execution routing across 11 liquidity sources — aggregators (0x, 1inch, ParaSwap/Velora),
AMMs (Uniswap V3, Curve), and intent/RFQ venues (CoW Protocol), among others.
On-chain conditional orders — Limit, Stop-Loss, Take-Profit, and DCA, executed by an audited
on-chain order engine.
MEV protection — sensitive flow can settle through CoW Protocol's batch auctions to neutralise
sandwich and front-running risk.
Gasless approvals via Permit2 — sign once, skip the separate approval transaction.
Oracle-validated quotes — every swap is cross-checked against Chainlink feeds (29 feeds) before it
can execute. No single price source is ever trusted on its own.
Clear signing (ERC-7730) — hardware-wallet users see human-readable swap details instead of raw
calldata.


Architecture

#mermaid-r80f-r1{font-family:"Anthropic Sans",system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:16px;fill:#E5E5E5;}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#mermaid-r80f-r1 .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#mermaid-r80f-r1 .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#mermaid-r80f-r1 .error-icon{fill:#CC785C;}#mermaid-r80f-r1 .error-text{fill:#3387a3;stroke:#3387a3;}#mermaid-r80f-r1 .edge-thickness-normal{stroke-width:1px;}#mermaid-r80f-r1 .edge-thickness-thick{stroke-width:3.5px;}#mermaid-r80f-r1 .edge-pattern-solid{stroke-dasharray:0;}#mermaid-r80f-r1 .edge-thickness-invisible{stroke-width:0;fill:none;}#mermaid-r80f-r1 .edge-pattern-dashed{stroke-dasharray:3;}#mermaid-r80f-r1 .edge-pattern-dotted{stroke-dasharray:2;}#mermaid-r80f-r1 .marker{fill:#A1A1A1;stroke:#A1A1A1;}#mermaid-r80f-r1 .marker.cross{stroke:#A1A1A1;}#mermaid-r80f-r1 svg{font-family:"Anthropic Sans",system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:16px;}#mermaid-r80f-r1 p{margin:0;}#mermaid-r80f-r1 .label{font-family:"Anthropic Sans",system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#E5E5E5;}#mermaid-r80f-r1 .cluster-label text{fill:#3387a3;}#mermaid-r80f-r1 .cluster-label span{color:#3387a3;}#mermaid-r80f-r1 .cluster-label span p{background-color:transparent;}#mermaid-r80f-r1 .label text,#mermaid-r80f-r1 span{fill:#E5E5E5;color:#E5E5E5;}#mermaid-r80f-r1 .node rect,#mermaid-r80f-r1 .node circle,#mermaid-r80f-r1 .node ellipse,#mermaid-r80f-r1 .node polygon,#mermaid-r80f-r1 .node path{fill:transparent;stroke:#A1A1A1;stroke-width:1px;}#mermaid-r80f-r1 .rough-node .label text,#mermaid-r80f-r1 .node .label text,#mermaid-r80f-r1 .image-shape .label,#mermaid-r80f-r1 .icon-shape .label{text-anchor:middle;}#mermaid-r80f-r1 .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#mermaid-r80f-r1 .rough-node .label,#mermaid-r80f-r1 .node .label,#mermaid-r80f-r1 .image-shape .label,#mermaid-r80f-r1 .icon-shape .label{text-align:center;}#mermaid-r80f-r1 .node.clickable{cursor:pointer;}#mermaid-r80f-r1 .root .anchor path{fill:#A1A1A1!important;stroke-width:0;stroke:#A1A1A1;}#mermaid-r80f-r1 .arrowheadPath{fill:#0b0b0b;}#mermaid-r80f-r1 .edgePath .path{stroke:#A1A1A1;stroke-width:1px;}#mermaid-r80f-r1 .flowchart-link{stroke:#A1A1A1;fill:none;}#mermaid-r80f-r1 .edgeLabel{background-color:transparent;text-align:center;}#mermaid-r80f-r1 .edgeLabel p{background-color:transparent;}#mermaid-r80f-r1 .edgeLabel rect{opacity:0.5;background-color:transparent;fill:transparent;}#mermaid-r80f-r1 .labelBkg{background-color:rgba(0, 0, 0, 0.5);}#mermaid-r80f-r1 .cluster rect{fill:#CC785C;stroke:hsl(15, 12.3364485981%, 48.0392156863%);stroke-width:1px;}#mermaid-r80f-r1 .cluster text{fill:#3387a3;}#mermaid-r80f-r1 .cluster span{color:#3387a3;}#mermaid-r80f-r1 div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:"Anthropic Sans",system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:12px;background:#CC785C;border:1px solid hsl(15, 12.3364485981%, 48.0392156863%);border-radius:2px;pointer-events:none;z-index:100;}#mermaid-r80f-r1 .flowchartTitleText{text-anchor:middle;font-size:18px;fill:#E5E5E5;}#mermaid-r80f-r1 rect.text{fill:none;stroke-width:0;}#mermaid-r80f-r1 .icon-shape,#mermaid-r80f-r1 .image-shape{background-color:transparent;text-align:center;}#mermaid-r80f-r1 .icon-shape p,#mermaid-r80f-r1 .image-shape p{background-color:transparent;padding:2px;}#mermaid-r80f-r1 .icon-shape .label rect,#mermaid-r80f-r1 .image-shape .label rect{opacity:0.5;background-color:transparent;fill:transparent;}#mermaid-r80f-r1 .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#mermaid-r80f-r1 .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#mermaid-r80f-r1 .node .neo-node{stroke:#A1A1A1;}#mermaid-r80f-r1 [data-look="neo"].node rect,#mermaid-r80f-r1 [data-look="neo"].cluster rect,#mermaid-r80f-r1 [data-look="neo"].node polygon{stroke:url(#mermaid-r80f-r1-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#mermaid-r80f-r1 [data-look="neo"].node path{stroke:url(#mermaid-r80f-r1-gradient);stroke-width:1px;}#mermaid-r80f-r1 [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#mermaid-r80f-r1 [data-look="neo"].node .neo-line path{stroke:#A1A1A1;filter:none;}#mermaid-r80f-r1 [data-look="neo"].node circle{stroke:url(#mermaid-r80f-r1-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#mermaid-r80f-r1 [data-look="neo"].node circle .state-start{fill:#000000;}#mermaid-r80f-r1 [data-look="neo"].icon-shape .icon{fill:url(#mermaid-r80f-r1-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#mermaid-r80f-r1 [data-look="neo"].icon-shape .icon-neo path{stroke:url(#mermaid-r80f-r1-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#mermaid-r80f-r1 :root{--mermaid-font-family:"Anthropic Sans",system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}quote requestvalidatedUser / WalletNext.js FrontendAPI Routes / VercelRouting EngineAggregators0x · 1inch · ParaSwapAMMsUniswap V3 · CurveIntent / RFQCoW · othersOracle GateChainlink · staleness ·depegSmart ContractsFeeCollectorOrderExecutor v2MonitoringCloudflare Worker ·watchdog · alerts

A request is priced across all sources, every candidate quote passes an oracle gate (Chainlink
validation, per-feed staleness, stablecoin depeg detection, and on L2 a sequencer-uptime check), and only
then is settlement built against whitelisted routers with an on-chain minimumOutput. An independent
monitoring stack watches contract and infra health continuously.

Security

Security is the core of the product, not an afterthought. Among the layers in place:


Mandatory oracle validation — Chainlink price checks gate every swap; large swaps are blocked when
secondary validation is unavailable.
Per-feed staleness & depeg breakers — stale feeds and stablecoin depegs halt affected routes.
L2 sequencer-uptime gate — quotes and swaps are blocked while a chain's sequencer is down.
Router whitelist + function-selector allowlist — settlement can only call vetted contracts and
vetted functions.
Recipient gating & on-chain minimumOutput — slippage and mis-delivery are enforced on-chain.
Timelocked governance — router changes pass through a queued, time-delayed execution path.
Supply-chain hardening — pinned dependencies, release-age delays, secret scanning, and
cryptographically signed commits on every branch.
Continuous monitoring — cron health ticks, an external watchdog, and a kill-switch.


Tech Stack

LayerTechnologiesFrontendNext.js 16, React 18, TypeScript 5.5, Tailwind CSS, Wagmi, Viem, RainbowKit, ZustandBackendNext.js API Routes (Vercel serverless), Upstash Redis, Supabase (PostgreSQL + RLS)ContractsSolidity 0.8.28, Foundry, Chainlink price feedsInfraVercel, Cloudflare (DNS + Worker cron), GitHub Actions CI

Smart Contracts


⚠️ Verify every address on the relevant block explorer before interacting.



ContractNetworkAddressFeeCollector V2Ethereum Mainnet0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459OrderExecutor v2Base0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130

All contracts are MIT-licensed, source-verified, and developed/tested with Foundry (87 contract tests).

Quality


1,600+ automated TypeScript tests plus a Foundry contract suite.
CI gates on lint, typecheck, full test suite, contract tests, build, and secret scanning — every PR.
Recurring internal and external security reviews; findings tracked to closure.


Status

Live on Ethereum Mainnet and Base. Actively developed.

Disclaimer

TeraSwap is software for interacting with decentralised protocols. It is provided as is, without
warranty of any kind. Nothing here is financial advice. Interacting with smart contracts and DeFi
protocols carries risk, including the risk of total loss of funds. Always do your own research and verify
contract addresses independently.


<p align="center"><sub>© 2026 TeraSwap. All rights reserved.</sub></p>
