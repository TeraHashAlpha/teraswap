# FIX-DCA-NOFEED-ALLOW-WITH-CONSENT — no-oracle-feed tokens: ALLOW via a plain-language Accept/Reject consent modal

> **Source:** owner decision 2026-07-23 (refined). A DCA to a no-price-feed output token (e.g. ETHFI) is
> currently REJECTED: "minAmountOut is below the $5 minimum ($0.0000)". Root cause: the $5 pre-flight values
> `minAmountOut` in USD, but a no-feed OUTPUT can't be USD-valued → $0 → block (panel resets = the "clears
> on approve" seen). **Owner decision: no-feed tokens are ALLOWED, gated by an EXPLICIT CONSENT MODAL** —
> a top-of-screen popup that explains, in plain language "as if for a child" (NO technical terms), the
> difference between buying WITH an oracle price feed vs WITHOUT, and requires the user to click **Accept**
> or **Reject** (Reject cancels the order). The v3 contract already supports no-feed pairs (scaled
> signed-min); on-chain guards (recipient==owner + signed minimumOutput + router whitelist) remain the
> unchanged terminal backstop. This relaxes ONLY a frontend/API pre-flight + adds informed consent.
> **Fund-flow-adjacent (relaxes an order-acceptance guard) → FOCUSED Auditor pass before merge (0C/0H).**
> SSH-signed; branch `fix/dca-nofeed-consent`, worktree UNDER `.claude/worktrees/`; 3 droppable commits.
> **Exit = push + suite green + compare link; owner opens the PR.**

## Requirements
1. **Relax the $5 guard for no-feed OUTPUT tokens — value the INPUT instead** (dust safety preserved):
   - Feed-covered output: behavior UNCHANGED (value minAmountOut in USD, require ≥ the $5 floor).
   - No-feed output: value the per-chunk INPUT (WETH/USDC, feed-covered), require INPUT ≥ $5 so the order
     is never dust; assert the signed minAmountOut is a REAL quote-derived value > 0 (never 1 wei/zero).
   - Both input+output no-feed (rare): keep BLOCKING with a clear message (can't assess).
2. **Consent modal (the core of this change):** when the output token has no feed, on attempting to place
   the DCA, show a **centered top-of-screen modal** (reuse the app's existing modal/overlay pattern) BEFORE
   signing. Requirements:
   - **Plain language, zero jargon** — no "oracle", "feed", "minAmountOut", "slippage". Explain like to a
     child, using a simple metaphor. Copy DIRECTION (agent may refine, keep this simplicity + honesty):
     Title: "Quick heads-up about {SYMBOL}"
     Body: "For most coins, TeraSwap watches the live market price on every buy — like a referee making sure
     you always get a fair deal. {SYMBOL} doesn't have that referee available. Your buys still only happen
     at the lowest amount you agree to each time, so you're not unprotected — but there's no live-price
     referee double-checking the market for this coin. Everything else works the same."
     (EN copy; if the app is bilingual, follow the existing i18n pattern — do NOT invent a second language
     ad-hoc.)
   - Two buttons: **Accept** (proceed to sign the order) and **Reject** (cancel — return to the DCA panel,
     nothing signed). Reject is the safe default focus.
   - Only for no-feed output tokens. Feed-covered tokens NEVER see this modal.
   - Shows on each no-feed DCA creation (informed consent per order; a "don't show again" is out of scope).
3. **Do NOT change** the on-chain path, keeper, signing struct, or feed-covered behavior.
4. **Tests:** no-feed output + input ≥ $5 → modal appears; Accept → order signs; Reject → order cancelled,
   nothing signed; feed-covered output → NO modal, behavior byte-identical; no-feed + input < $5 → blocked
   (meaningful-order message, no modal); both-no-feed → blocked clearly; minAmountOut asserted > 0 in every
   accepted path; modal copy contains NO technical terms (assert against a jargon denylist:
   oracle/feed/slippage/minAmountOut); existing DCA/guard suites untouched-green. Golden: the ETHFI case now
   shows the modal and proceeds on Accept.

## Do NOT
Touch the contract/keeper/signing struct; change feed-covered behavior; remove the on-chain minimumOutput
reliance; allow a dust order (input ≥$5 + minAmountOut quote-derived >0); use technical jargon in the modal;
show the modal for feed-covered tokens; open a PR.

## Files affected (read ONLY these + tests)
The $5-economic-floor guard (DCAPanel pre-flight + /api/orders validation), the DCA place/confirm flow +
a new consent-modal component (reuse existing modal primitives), their tests,
`docs/Prompts/FIX-DCA-NOFEED-ALLOW-WITH-WARNING.md`. Read-only:
`contracts/order-engine/TeraSwapOrderExecutorV3.sol` (no-feed scaled-min path), `src/lib/chains/chainlink-feeds.ts`
(no-feed detection), existing modal components (pattern to reuse).

## Expected output
Branch + compare link. FEEDBACK ≤1 screen: the guard branch (input-value path), the modal copy as landed +
the jargon-denylist proof, Accept/Reject wiring (Reject cancels), the dust-safety assertions, tests. **Flag
for the FOCUSED Auditor pass (0C/0H): relaxation bounded by the unchanged on-chain minimumOutput backstop;
Auditor confirms no dust/zero-min order slips through and consent is required (not bypassable).**
