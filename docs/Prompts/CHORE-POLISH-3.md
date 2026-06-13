# CHORE-POLISH-3 — post-audit follow-ups (4 non-gate items)

Each item = its OWN atomic SSH-signed commit. Branch `chore/polish-3` off latest origin/main. CI green
(test-contracts is a real gate — keep it green), append FEEDBACK. None is a security gate.

## P1 — E-1 label fix + OrderExecutor drift-test (NOT an address change)
On-chain verification (owner ran it) PROVED the order-engine config is correct: the mainnet OrderExecutor
(`0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130`) whitelists 1inch / 0x / **paraswap V5 (0xDEF171Fe…) = true**
/ uniswap-SwapRouter-V1; **Augustus V6 (0x6A00…) = FALSE**. So:
- Fix ONLY the LABEL in `src/lib/order-engine/config.ts`: `paraswap` entry "Paraswap Augustus v6" →
  "Paraswap Augustus v5" (the address 0xDEF171Fe… is V5 and is CORRECT — it matches the OrderExecutor's
  whitelist). **Do NOT change any address.** (Changing V5→V6 would BREAK orders — V6 is not whitelisted
  on the OrderExecutor.) Optionally relabel uniswapV3 to reflect SwapRouter (V1) if helpful.
- Update/align the drift-guard test so it compares the order-engine MAINNET_ROUTERS against the
  **OrderExecutor's** whitelist semantics (a static fixture documenting the 4 verified-whitelisted
  addresses + a comment that Augustus V6 is intentionally NOT in the OrderExecutor set — it's the
  FeeCollector/swap path's router, a different contract). Document the FeeCollector-vs-OrderExecutor
  router-set distinction inline.

## P2 — Shared PORTFOLIO_SUPPORTED_CHAINS constant (E3-L-01)
The portfolio "supported chains" allowlist is defined twice — `prices/route.ts` via
`getSupportedChainIds()` and `tokens/route.ts` via the hardcoded `ALCHEMY_BASE_BY_CHAIN` map keys
({1,8453}). Introduce ONE shared source (e.g. `PORTFOLIO_SUPPORTED_CHAINS` derived from the registry or
a single constant) used by BOTH routes, so a future chain can't be added to one but not the other.
Behaviour identical today ({1,8453}); add a test pinning both routes to the same set.

## P3 — Base RPC fallbacks in getPublicClientForChain (clients.ts)
`getPublicClientForChain(chainId)` for non-mainnet builds a single `http(config.rpc.primary || undefined)`
transport — the registry's Base FALLBACK RPCs are defined but never used, so a degraded Base primary
makes ALL Base reads (quotes/portfolio/monitor) fail. Build a `fallback([primary, ...fallbacks])`
transport for Base from the registry's configured fallbacks (mirror wagmiConfig's pattern). Mainnet path
(getPrivateClient / the /api/rpc privacy proxy) is UNCHANGED — do not touch it. Add a test: primary Base
RPC fails → the fallback is used.

## P4 — ALCHEMY_API_KEY app-scope (E3-I-02)
The single `ALCHEMY_API_KEY` now serves BOTH eth-mainnet and base-mainnet (portfolio Base depends on it).
Add a clear note to the deploy/env checklist (and/or an env-validation warning) that the key must be
app-scoped to cover BOTH networks — a mainnet-only-scoped key silently degrades Base discovery to 503
(the chain-aware multicall fallback covers it, but with worse UX). No behaviour change; documentation +
optional startup warning only.

## Do NOT
- No address changes (P1 is label-only), no gate/FeeCollector/adapter/contract/Solidity changes, no
  change to the mainnet RPC privacy proxy. Mainnet byte-identical (test-guarded). Keys server-only.
- 4 atomic SSH-signed commits (P1…P4), CI green, append FEEDBACK. No Auditor needed (flag in FEEDBACK
  if P3's fallback wiring surfaces anything about the mainnet path).
