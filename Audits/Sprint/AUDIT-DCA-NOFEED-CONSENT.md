# AUDIT — FIX-DCA-NOFEED-CONSENT — PR (`fix/dca-nofeed-consent`)

**Date:** 2026-07-23 · **Auditor:** independent Auditor (read-only) · **Type:** FOCUSED fund-flow-adjacent gate (relaxes the $5 order-acceptance dust guard for no-feed output tokens + adds a consent modal)
**Verdict: APPROVE-TO-MERGE — 0C / 0H (0M / 0L, 2 INFO).** Merge authorized.

**Point 2 (the one that matters most) — server-side enforcement: CONFIRMED.** The relaxed dust guard lives in `/api/orders` POST, **after** ECDSA recovery, independent of the modal. A client POSTing directly (bypassing UI + modal) is still rejected if the order is dust — verified by source read *and* re-run negative tests (input < $5 → 400; both-no-feed → 422; minAmountOut ≤ 0 → 400). The modal is UX-only.

---

## 1. Grounding

| Ref | SHA | Sig |
|---|---|---|
| `origin/fix/dca-nofeed-consent` (tip) | `ea72527d3741cc32b22469b86feeb3bc75ea975b` | SSH ✓ |
| `origin/main` (= merge-base) | `87614e8ffff9604e84a9db1c72b8ed0f57622425` | — |

**1 commit**, SSH-signed, merge-base = main tip ⇒ effective diff = `git diff main...branch` = **8 files, 667+/10−**. Contains both halves of the change: the `/api/orders` guard relaxation (`route.ts` +95) and the consent modal (`NoFeedConsentModal.tsx` new) + `DCAPanel.tsx` wiring. `TeraSwapOrderExecutorV3.sol` is **not in the diff** (adjacency ✓). No keeper, no signing struct, no `chainlink-feeds.ts` change (only *read* by the new modal gate).
**Caveat (I-02):** sandbox can't reach GitHub; audited the owner's locally-fetched `origin/*`. Confirm the GitHub PR head = `ea72527` before merge.

## 2. Checks & per-point verdicts

| Point | Result |
|---|---|
| **1 · Dust safety preserved** | **VERIFIED** (§3) |
| **2 · Server-side enforcement (critical)** | **VERIFIED — guard is server-side, not modal-only** (§4) |
| **3 · Consent not bypassable (UI)** | **VERIFIED** (§5) |
| **4 · On-chain backstop untouched** | **VERIFIED** (§6) |
| **5 · Residual risk bounded + consented** | **VERIFIED** (§7) |

## 3. Point 1 — dust safety preserved (VERIFIED)

Inside the `isV3Order` block (`route.ts`), the no-feed relaxation is reached only when the **output** leg prices to `null` (`minOutUsd === null`) — the exact prior hard-block condition. From there:

- **Non-DCA** (Limit/TP) with an unpriceable output: **still 422 blocked** (`orderTypeEnum !== ORDER_TYPE_DCA` guard) — the P1b surface is untouched, no accidental widening.
- **DCA, no-feed output:** values the **per-chunk INPUT** (`amountIn / dcaTotal`) via DefiLlama + server Chainlink, **min-combine** (`Math.min` of both legs — hardest to pass), using **on-chain `fetchErc20Decimals(tokenIn)`** (never client-supplied). Requires `inputUsd ≥ $5`; below → **400 dust**. Then asserts `BigInt(body.minAmountOut) > 0` → else **400** (never the 1-wei/zero no-op).
- **Both legs no-feed:** `inputUsd === null` → **422 blocked** clearly.
- **Feed-covered output:** the original `else if (minOutUsd < dustFloorUsd)` path is preserved **byte-identical** — no behavior change.

`minAmountOut` is also signature-bound (part of the recovered EIP-712 message), and non-numeric/negative values are rejected upstream at recovery (400) or by the `> 0` check. **No path accepts `minAmountOut ≤ 0` or an unvaluable dust order.** The on-chain `scaledMin == 0 → InvalidMinOutput` revert (`TeraSwapOrderExecutorV3.sol:531`) is the terminal backstop even if the off-chain check were somehow skipped.

## 4. Point 2 — server-side enforcement (CONFIRMED, the critical one)

The input-value dust check and the `minAmountOut > 0` assertion are in the **`/api/orders` POST handler**, positioned **after** `recoverTypedDataAddress` (the block is inside `if (isV3Order) { … }` well below the recovery at `:326-338`). The code is explicit and honest about the trust split:

> *"The frontend is responsible for having shown the no-feed consent modal before this request was ever sent … the API cannot verify 'did the user see the modal' and does not attempt to; it only enforces the bounds."*

So the modal is **UX only**; the real guard is the API. A user hand-crafting a POST that skips the UI still faces: per-chunk `inputUsd ≥ $5`, `minAmountOut > 0`, on-chain `tokenIn` decimals readable, and signature recovery == wallet. **Re-run negative tests confirm this at the route level** (POSTing directly to the handler, no component involved):

- `no-feed output + per-chunk input < $5 → 400` ("no modal-bypassable path")
- `both input AND output no-feed → 422`
- `no-feed output allowed path still rejects a zero-value signed minAmountOut`
- `cannot read tokenIn decimals on-chain → 422 fail-closed`
- `no-feed output + input ≥ $5 (DefiLlama or server Chainlink) → 201`
- `feed-covered output remains completely unaffected`

**If the guard were client-only this would be a HIGH — it is not. Server-side enforcement VERIFIED.**

## 5. Point 3 — consent not bypassable in the UI (VERIFIED)

`handleCreate` (the sign/submit function) has exactly **two callers**: `handleCreateClick` (line 631, only after `!(noFeedOutput && !noFeedConsentGiven)`) and `handleNoFeedAccept` (line 637, only after Accept). The submit button's `onClick` routes through `handleCreateClick` (line 1026) — the old direct `handleCreate` call was replaced. For a no-feed output with consent not yet given, `handleCreateClick` shows the modal and `return`s **without signing**. **Reject** (`handleNoFeedReject`) closes the modal and does nothing — nothing signed, nothing submitted. Consent is per-order (tracked by token address, reset to `null` after each submit), and Reject is the safe default focus (Esc = reject, focus-trapped). No un-gated path to `handleCreate` exists.

## 6. Point 4 — on-chain backstop untouched (VERIFIED)

Diff touches only `route.ts`, `DCAPanel.tsx`, the new modal, tests, and the spec. **No `.sol`, no keeper, no signing-struct change.** For a no-feed pair the contract computes `hasFeed=false ⇒ floorOut = scaledMin` (the user's signed `minAmountOut`, verbatim; `:521-554`), still delivers to `order.owner` (recipient gating), still requires a whitelisted router, and still reverts `InvalidMinOutput` on a zero scaled min. The frontend/API relaxation cannot cause loss beyond the user's own signed, consented minimum.

## 7. Point 5 — residual risk (bounded + consented, VERIFIED)

The **only** new exposure is a worse execution price on a no-feed output token: with no oracle feed, the on-chain `floorOut` is just the user's signed `minAmountOut` (no `max(oracleFloor, …)` uplift, because `oracleFloor` is unavailable for that token). This is:
- **Bounded** — the keeper can never deliver below the signed min (on-chain enforced), and the order isn't dust (input ≥ $5 enforced server-side).
- **Consented** — the plain-language modal is required before signing (UI), and the risk is disclosed ("no live-price referee for this coin").
- **Self-scoped** — it is the user accepting a weaker floor on a token *they* chose; no third party gains, and it cannot touch any other user or the protocol.

No other new exposure exists. This matches the ADR-014-class reasoning: off-chain relaxation, terminal backstop unchanged.

## 8. Tests (re-run by the Auditor)

| Suite | Result |
|---|---|
| `NoFeedConsentModal.test.tsx` + `orders-v3.test.ts` | **33/33 PASS** |
| `DCAPanel.nofeed-consent.test.tsx` + `orders-p1b.test.ts` | **30/30 PASS** |

`orders-v3.test.ts` carries a dedicated `DCA no-feed output relaxation` describe with 7 route-level tests (the server-side matrix in §4). The modal jargon-denylist test (`oracle`/`feed`/`slippage`/`minAmountOut` absent) passes. Method: branch extracted via `git archive` to `/tmp` with symlinked `node_modules`; no repo files modified except this report + the AUDIT-TOTAL append.

## 9. Findings

| ID | Sev | Where | Disposition |
|---|---|---|---|
| I-01 | INFO | `route.ts` no-feed branch | The server asserts `minAmountOut > 0` but **cannot** prove it is "quote-derived" (the spec's phrasing) — a direct POST could sign a 1-wei min with a ≥$5 input. This is **self-harm only**, fully bounded by the user's own signature + consent + the on-chain floor they chose; unverifiable server-side by definition for a no-feed token (that is the whole premise). The code comment states this honestly. No stronger server check is possible; genuine quote-derivation lives client-side. Not a defect — the documented residual. |
| I-02 | INFO | process | Audited against locally-fetched refs; confirm GitHub PR head = `ea72527` before merge. |

**0C / 0H / 0M / 0L → APPROVE-TO-MERGE.** No dust/zero-min order slips through (server-enforced, post-recovery); consent is required and not bypassable in the UI; the on-chain signed-minimum backstop is untouched; the sole new exposure is a consented, bounded, self-scoped worse price on no-feed tokens. No remediation prompt required.

---
*Auditor has no signing key — report + AUDIT-TOTAL append left for the owner's SSH-signed batch (rule #12). Contract line numbers cite `TeraSwapOrderExecutorV3.sol` @ this SHA (byte-identical to main).*
