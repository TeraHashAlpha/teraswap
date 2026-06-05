# SPRINT-9J — Live swap UX/reliability (post-9G/9H)

Three issues observed on live TeraSwap (2026-06-02). J1 blocks mainnet swaps and is the priority.

## J1 — Chainlink-deviation gate blocks legit swaps [HIGH · mainnet]
**Symptom:** a mainnet ETH→USDC swap whose best route is a PMM/low-liquidity pool (e.g.
`kipseli-pamm`) shows **price impact ~2.16%**, and the UI then **pauses the swap**: "Price deviates
2.2% from Chainlink oracle… waiting for price to return within safe parameters… PRICE OUTSIDE SAFE
RANGE — WAITING…". It never re-enables, because the deviation IS the trade's own price impact, not
oracle manipulation/staleness.
**Root issue:** the deviation gate compares the **execution rate (which includes the user's own
price impact)** to the Chainlink spot, so for small/illiquid trades the impact trips the
manipulation gate. Price impact is an expected, slippage-covered cost — NOT an oracle-safety event.
**Fix (careful — this is a safety gate, rule #9; do NOT just disable it):**
- Find the gate (frontend deviation check comparing quote rate vs Chainlink, with the "Swap paused /
  PRICE OUTSIDE SAFE RANGE — WAITING" state and auto-re-enable poll — likely in `useSwap` /
  `useChainlinkPrice` / SwapBox).
- Measure deviation against the **pre-impact / mid quote price** (or the Chainlink rate vs the
  aggregator's spot), so the trade's own price impact does NOT count as oracle deviation. Keep the
  gate firing for genuine oracle staleness / cross-source manipulation.
- The paused state must be **recoverable**: where the deviation ≈ the displayed price impact (i.e.
  expected slippage on an illiquid route), convert the hard-pause into an **informed-consent
  warning** the user can accept (they already accept slippage), instead of an indefinite block.
  Genuine manipulation/staleness still hard-blocks.
- Add tests: a high-price-impact small trade is NOT oracle-blocked; a real oracle deviation
  (stale/divergent feed) still blocks. Mainnet + Base.
- **Security gate change → Auditor review before prod.**

## J2 — Intermittent "Unexpected token '<', <!DOCTYPE… not valid JSON" on swap [HIGH/MED · Base/Velora]
**Symptom:** selecting Velora on Base intermittently fails the swap with the HTML-not-JSON error;
retrying 2–3× eventually succeeds. `/api/swap`'s own catch already returns `NextResponse.json(...,
{status:502})`, so the HTML comes from a **platform-level timeout/crash** (the function exceeds its
limit when the upstream swap-build — e.g. ParaSwap/Velora `/transactions/{chainId}` — is slow),
making Vercel serve an HTML error page the route never produced.
**Fix:**
- Add a bounded **timeout + AbortController** to the upstream swap-build fetches (Velora build, and
  any other adapter `fetchSwapData` HTTP calls) so they fail fast as a clean JSON error well within
  the function's max duration — the route never hangs to a platform 504/HTML.
- Add a small **retry (1–2×) with backoff** on a transient build failure/timeout so the common case
  succeeds without the user clicking retry.
- Verify `/api/swap` always returns JSON even on upstream timeout; surface a clear
  `{ error: "..." }`. Test the timeout path.

## J3 — Info tooltips (ⓘ) don't open [LOW · frontend]
The `ⓘ` togglers (Price impact, Platform fee, etc.) don't open. Find the tooltip/popover component
and fix the broken trigger (event handler / portal / state). Add a render test that the tooltip
opens on click/hover.

## Do NOT
- Do NOT disable or blanket-loosen the Chainlink/DefiLlama safety gates — distinguish price-impact
  from oracle deviation; genuine manipulation/staleness must still block.
- Do NOT change mainnet behaviour beyond the J1 gate fix; byte-identical elsewhere, test-guarded.
- No contract edits; keys server-only.
- TDD; atomic signed commits on `feat/sprint-9j-swap-ux`; CI green; append FEEDBACK.
- J1 is a security gate → Auditor review before prod. J2/J3 are lower-risk but still Preview-gated.

## Acceptance
- Mainnet: a legit high-impact small swap is no longer indefinitely oracle-paused (informed-consent
  warning instead); genuine oracle deviation still blocks. Base: Velora swap no longer intermittently
  fails with HTML (bounded + retried). Tooltips open. Mainnet otherwise byte-identical; suite green.
