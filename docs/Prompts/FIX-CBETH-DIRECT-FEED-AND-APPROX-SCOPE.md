# FIX-CBETH-DIRECT-FEED-AND-APPROX-SCOPE

> **Provenance.** No separate Architect packet was authored for this task — the owner briefed it
> directly as a `/goal`. This file is that brief, transcribed verbatim into `docs/Prompts/` so the
> Auditor reviews against a fixed written spec rather than a chat message (convention: every
> implementation PR carries its spec). Nothing here was added, softened, or re-scoped by the Code
> Agent; deviations and additions are recorded in `docs/feedback/fix-cbeth-direct-feed-and-approx-scope.md`.

**Branch:** `fix/cbeth-direct-feed-and-approx-scope` · **Base:** `origin/main`
**Review:** changes which oracle feeds a SIGNED minimum — an AUDITOR reviews it; PR unmerged until 0C/0H.

---

## Context, measured (INC-2026-08-07-001)

A DCA order signed a minimum 1.588x above market because cbETH had no usable price at signing and
the derivation fell through to a hardcoded table. That fall-through is closed (#408): an unpriced
leg now takes the ADR-013 no-feed floor — 2.77% of fair value, safe from "unfillable" but weak as
protection. The real fix is to make the leg priceable.

Base has three cbETH feeds. Today the app prices cbETH by COMPOSITION (`cbETH/ETH x ETH/USD`), and
cbETH is deliberately absent from the direct USD map so the raw ~1.08 answer is never misread as
"$1.08". A direct `CBETH / USD` feed exists and was never adopted (9V-M-01, deferred since June):
`0xd7818272...`, 8 dp, 20-min heartbeat.

## Task 1 — adopt the direct feed as PRIMARY, keep the composition as FALLBACK

Owner's decision: direct first, composed second. Neither alone — if one stalls the other still
prices the leg, and an unpriced leg is what caused the incident.

**Verify the feed on-chain before wiring it.** Do not trust the address above or any doc. Call
`description()`, `decimals()` and `latestRoundData()` on it against Base and report all three. It
must describe as CBETH / USD with 8 decimals and a fresh answer. If any of that disagrees, STOP and
report — a wrong feed address here reproduces the incident exactly.

Then order the resolution: direct -> composed -> the existing cascade. A stale or reverting direct
feed must fall through to the composition, not to "no price".

## Task 2 — stop `APPROX_PRICES` pricing anything that gates

`src/lib/order-engine/usd.ts` still says ETH 3500 and CBETH 3600; the Base ETH/USD feed reads ~1912.
It no longer touches signing, but it still feeds displayed USD and the DCA min-chunk dust guard
(`DCAPanel.tsx` ~:524/:553 via `useOrderEngine.ts` ~:654 — locate by the quoted symbols, the line
numbers are a claim).

Reading HIGH, the dust guard over-values an order and lets chunks through that should be stopped.
Route it to the same live price path signing uses; leave the table for display only, marked
approximate so nobody reads it as a quote.

## Acceptance

1. A test pinning that cbETH on Base resolves to the DIRECT feed, and that a stale/reverting direct
   feed falls through to the composition rather than to null.
2. **A magnitude guard**: the resolved cbETH USD price must be >= ETH/USD and within 2x of it. cbETH
   is worth slightly more than ETH; anything near 1.0 means an ETH-denominated feed was wired into a
   USD slot, which is the original defect's shape. This test must fail if someone does that.
3. Recompute the incident's exact inputs (amountIn 3186645813843290, dcaTotal 3, 300 bps) with cbETH
   priced from the direct feed and report the implied ratio in FEEDBACK. It must land near market
   (~1.13), not 1.853314.

## Do NOT

- Do NOT touch the tier-selection or `hasFeed` logic from #408, and never re-add approx prices to
  the signing inputs.
- Do NOT touch any `.sol`, the contract's on-chain `tokenUsdFeed` config, or the keeper.
- Do NOT hand-type any address into code — derive every one from the existing registry or from
  chain, and say which.
- Do NOT delete files (rule #4). Do NOT run `ssh-add`, touch `.env`, or any server.

## Files

`src/lib/chainlink-feeds.ts`, the `useChainlinkPrice` hook, `src/lib/order-engine/usd.ts`,
`src/components/DCAPanel.tsx`, `src/hooks/useOrderEngine.ts`, plus their tests.

## Output

SSH-signed commits, pushed, compare link. In FEEDBACK: the three on-chain readings, all three
acceptance results, and the recomputed ratio.
