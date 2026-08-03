# CHORE-ORACLE-LESS-ADVISORY — neutral creation-time note for tokens without a price oracle (+ assess per-fill guardrail)

## Context
A read-only investigation (order `5449dea0`, ETHFI on Base) confirmed that sub-$10k DCA/swaps into
**oracle-less tokens** execute with **no independent price cross-check**:
- The keeper's Chainlink read is **debug-only** (`executor.js` ~967) — `priceFeed=address(0)` returns `0x`, logged, ignored.
- On-chain `_checkPriceCondition` returns `(true,"")` for DCA (`priceFeed==address(0)`) → **no on-chain price gate**;
  `minAmountOut = 1 wei`.
- The server `/api/swap` guard is **DefiLlama-based and fails OPEN below $10k** (blocks only `>$10k` when unpriceable,
  or `>8%` deviation when priceable).

Net: for a normal DCA chunk into a token with no Chainlink feed AND no DefiLlama coverage, **per-fill safety rests
solely on the aggregator route's own quoted slippage**. The order still fills correctly — this is about **informed
consent at creation**, not a functional bug. There is currently **no creation-time signal** to the user.

## Objective
At order creation, when the target token lacks **independent price-oracle coverage** (no Chainlink feed AND no
DefiLlama price on the active chain), surface a **neutral, factual note** so the user makes an informed choice.
Separately, **assess** (do not implement) a per-fill guardrail for oracle-less tokens.

## Requirements
1. **Oracle-coverage detection (dynamic, not hardcoded):** for the target token on the active chain, determine
   whether an independent price oracle exists — a **Chainlink feed** (reuse the existing feed registry / the
   frontend `price-gate.ts` map) **OR** **DefiLlama coverage** (a lightweight price probe). Reuse existing endpoints
   where possible (the routability pre-check `checkRoute → /api/quote` already runs in `DCAPanel`). Debounce/cache
   so token switches don't spam requests.
2. **P1 — creation-time note (NEUTRAL styling — this is the key constraint):** when the token has **no** oracle
   coverage, render an informational line in the DCA/order create form.
   - **STYLING (must):** plain/neutral text with **bold** emphasis only. **NO** warning/danger colours (no red, no
     amber/yellow), **NO** alert or warning icon, **NO** banner/callout box that reads as a hazard. It must look
     like a normal factual heads-up, not a warning — it must not discourage the user or imply danger.
   - **Copy (owner may tweak):** "**{TOKEN} has no price oracle** — fills use the best available DEX route, so the
     execution price depends on on-chain liquidity." Concise, one line, neutral tone.
   - Accessible (`aria`), responsive (mobile), placed inline near the token selection / review area.
3. **Never block submission** on this — it is informational only. The order stays fully creatable; no gating.
4. **P2 — ASSESS ONLY (FEEDBACK, no execution change in this PR):** document the current per-fill protection for
   oracle-less tokens (keeper route-build slippage + on-chain `minAmountOut=1 wei`) and **propose** in FEEDBACK
   whether a tighter default slippage / cross-source route sanity check / lower chunk cap is warranted for
   oracle-less tokens — **with the trade-off** (too tight → failed fills). Do **NOT** change execution/keeper/
   on-chain safety here; that needs Architect + Auditor review.

## Do NOT
- Do NOT use warning/danger colours or icons, or any styling that reads as a hazard (owner directive: neutral, bold only).
- Do NOT block, gate, or add friction to submission. Do NOT change keeper execution or on-chain logic.
- Do NOT hardcode the oracle-less token list — detect dynamically. Do NOT add heavy new dependencies.

## Files affected (verify on main)
- The DCA/order create form (`DCAPanel`) + the routability pre-check path.
- A small oracle-coverage helper (Chainlink feed map + a DefiLlama price probe) — reuse `price-gate.ts` / the feed
  registry + `defillama.ts`; a tiny API route only if a server-side check is cleaner.

## Expected output
- Branch `chore/oracle-less-advisory` off latest `origin/main`; SSH-signed (committer = the GitHub noreply email);
  CI green.
- The neutral note renders for oracle-less tokens (e.g. **ETHFI on Base**) and is **absent** for oracle-covered
  tokens (e.g. WETH / USDC). Before/after screenshots showing the **neutral styling** (no alert colours/icons).
- FEEDBACK with: the detection logic, and the **P2 assessment** (per-fill guardrail proposal + trade-off).
- No formal Auditor (UI/advisory, no fund-flow change), but document the detection logic.

## Quality criteria
A neutral, **bold-only** informational note appears at creation for tokens with no Chainlink AND no DefiLlama
coverage; zero alarming/coloured styling; submission never blocked; detection is dynamic and reuses existing
checks; P2 is assessed in FEEDBACK, not implemented.
