# CHORE-DCA-RESILIENCE — don't permanently fail a routable DCA on a transient miss + accurate failure reasons

## Context
A routable DCA (WETH→UNI — chunk 1 SUCCEEDED on-chain via Uniswap V4, tx
`0xa6a75b1e44c308253f09af231375817f97abb7f31288bd695c693010c072f670`) was marked **FAILED** after the next
chunk hit a "swap route may have become unavailable" → 3 retries → permanent fail (showed "1 of 3 buys,
FAILED"). For a recurring DCA this is too fragile: a transient miss on one chunk should NOT kill the whole
order — chunk 1 proved the pair routes. Also, the UI shows a generic "route unavailable" reason that may mask
the real cause (e.g. the order EXPIRED before completing, if interval × buys > expiry).

## Objective
Make DCA execution resilient to transient failures (retry on the next scheduled cycle, don't permanently fail
a proven-routable order), and surface ACCURATE failure reasons. Add a creation-time guard so an order can't be
created that expires before it can complete.

## Requirements
1. **Transient vs permanent (keeper):** classify a chunk failure:
   - **Transient** (no swap route this cycle, route-fetch/API hiccup, transient revert, momentary slippage):
     keep the order **ACTIVE**, do NOT mark it failed; retry on the **next scheduled cycle** (with backoff).
     Cap at **N consecutive cycle-failures** (e.g. configurable, sane default) before flagging — and **alert**
     (the #201 Telegram) on repeated transient failures so the owner notices, WITHOUT auto-failing prematurely.
   - **Permanent** (order **expired**, **insufficient balance/allowance**, nonce invalidated, confirmed
     unroutable after the cap): mark FAILED — with the SPECIFIC reason.
2. **Accurate failure reason (keeper + UI):** persist the real terminal reason (`expired` /
   `no_route_after_retries` / `insufficient_balance` / `insufficient_allowance` / `cancelled` / …) and show it
   in the Positions/Orders UI — replace the generic "swap route may have become unavailable" with the actual
   cause (e.g. "Order expired before completing" vs "No route available right now").
3. **Don't lose partial progress:** a partially-executed DCA (e.g. 1 of 3) keeps its completed chunks +
   resumes the remaining on recovery; never re-execute or double-charge a completed chunk.
4. **Creation-time guard (UI):** if `interval × dcaTotal` would exceed the chosen **expiry** (the order can't
   complete all buys before expiring), **warn the user** at creation and suggest a longer expiry / fewer buys /
   shorter interval. Block or strongly warn — don't let a doomed order be signed silently.

## Do NOT
- Don't change the contract or move funds. Don't double-execute a completed chunk. Don't retry forever — cap +
  alert, then fail with reason. Keep mainnet/instant-swap unaffected.

## Files affected (verify on main)
- Keeper `contracts/order-engine/executor/executor.js` (retry/terminal-status logic + the failure-reason
  written to `order_executions`/orders).
- The Positions/Orders UI (accurate reason rendering) + the DCA create form (interval×buys vs expiry guard).

## Expected output
- Branch `chore/dca-resilience` off latest `origin/main`; SSH-signed; CI green; tests (transient→retries next
  cycle + cap+alert; permanent→failed-with-reason; partial-progress preserved; creation guard); FEEDBACK with
  what classifies as transient vs permanent. **Deploy:** keeper `git pull` + `pm2 restart` (+ frontend for the
  reason display + creation guard). Light Auditor optional (touches execution control flow, but no fund-flow
  change).

## Quality criteria
A proven-routable DCA survives a transient chunk miss (retries next cycle, stays active); genuinely-permanent
conditions fail with the SPECIFIC reason shown in the UI; a doomed (expires-before-completing) order is caught
at creation; partial progress preserved; no double-execution.
