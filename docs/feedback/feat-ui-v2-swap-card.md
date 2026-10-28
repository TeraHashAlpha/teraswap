# feat/ui-v2-swap-card — feedback (B3)

Off origin/main `96e2e0b`. Dedicated worktree, real `npm ci`. No PR (owner opens it). SSH-signed, noreply. Code diff only under `src/ui/v2/**`; v1 hooks/lib/api untouched. Files: `feat-ui-v2-swap-card/` (frame-vs-v2 webp, parity/scrim/v1-proof txt).
- [x] C1 `e07ed21` states 21a/21b/20 · [x] C2 `19ddc97` tiers + CTA + sound · [x] C3 `e72e6f1` per-photo scrim + pack bg-zakim · [x] evidence 1–7

## Premises (no owner answer needed; recorded)
`useQuoteChainId` is in `src/hooks/useChainId.ts` (no such file). Frame copy that is not a slot (idle "QUOTE BREAKDOWN" hint, trust chips, `STATE:` notes) omitted per "no copy beyond slots". Token buttons + ✎ + CTA click are real controls with B4/B5 stubs (`data-b4-stub`/`data-b5-stub`); goal named only ✎.

## Auditor note — amount / min-output / tier display
- **Min. output** = `deriveMinimumOutput` (bigint bps, what useSwap floors with), not v1's float `out×(1−s)`; same 4 dp on fixtures. It is the displayed floor, not the signed one.
- **Stale amount (new vs #604):** v1 leaves a pair's quote up while a new amount is typed and divides its output by the NEW amount. v2 shows a quote only while its echoed `amountRaw` = the field; else skeleton + CTA disabled. Pair/chain identity rule kept.
- **Tier:** priced/unknown → nothing; single-source → v1's amber text verbatim; unpriced → `No reference price — consent required before swapping` (dialog = B4). Route hop containing any `0x…{40}` → source name.
- **Not here (B5):** price-gate banners/consent (oracle, impact, depeg, DefiLlama), split, simulation/tx/share. CTA reads Review swap where v1 would block; nothing can execute (no click path).

## Evidence
1. `{21a,21b,20,24,29,m02}-frame-vs-v2.webp` (round7 left, v2 right; connected states use a fake EIP-6963 wallet + mocked `/api/{quote,rpc,swap-price-tier}`, so gas/fee USD come from the mock). Also `csingle|cunpriced|cins-v2.webp`. Deviations: gas USD first (owner) vs frame ETH first; 29 reads "Switch to Ethereum" (v1 target — selector = wallet in v2, "…Base" unreachable).
2. `parity.txt`: v1 SwapBox+QuoteBreakdown → v2, 7 variants (connected+balance, disconnected, USDC→ETH, CoW best, notices, single-source, unpriced): **0 missing text, 0 missing hrefs**. Allow-list: 6 decorative aria-hidden glyphs + the 3 unpriced sentences (owner's one line), each load-bearing (test fails without them).
3. `quote-model.test.ts` (19): rate/gas/fee/min/Δ via `@/lib/format` (thin-space, 4 dp, gas 2 sf, never 0.0000), route-names, bigint floor at 14 digits, stale amount.
4. CTA matrix `cta.test.ts` (12 rows) + card tests: Connect wallet · Enter amount · Insufficient balance · Review swap · Switch to X (text button, 0 solid CTAs) · plus Finding route / No quotes. Tier table `tier-notice.test.tsx`.
5. `scrim-contrast.txt`: `photoScrim` = lowest α keeping AA (p95; text/cream/muted/teal/green/amber/red ≥ 4.5, dim large ≥ 3; desktop+phone, avif+webp) — **DCA 0.47 (pinned; min 0.40), other seven 0**. Worst muted 5.64–6.73. p95 leaves the brightest 5 % (lamps) under AA text. bg-zakim = pack files, byte for byte (credits bytes updated).
6. `sounds-parity.swap.test.tsx` (8): real `sounds.ts`, fake Web Audio: quote arrival = v1's call once; same-winner poll silent; new winner +1; every other control silent; only `playQuoteReceived` imported in `swap/`.
7. **v1:** `v1-proof.txt` — 0 v2-marked chunks in any v1 route; route table identical (54); 0 v1/lib/hooks/api files changed. Chunk *names* regroup (Turbopack): 8 of 10 v1 routes same total bytes, `/` +2 839 B and `/swap` +2 382 B raw (+0.1 %), same as B1's accepted module-identical standard. Suite 355/5720 → **362/5805**; lint **93 = 93** (src/ui/v2 0); tsc 0; build 0 both. Diff 30 files +2526/−15 (code, before evidence). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-swap-card

## Content-map delta (v1 → v2, Swap)
0 v1 strings lost. Moved: sources count/queried under RECEIVE; Compare is a disclosure (open desktop, closed ≤ 600 px, rows stay in DOM); balance line always shows the identity line (v1 showed one or the other). New v2-only text: none.

## Concerns / open
`next dev` rewrites `AGENTS.md` (reverted, not committed). Existing `shell`/`round7`/`sounds-parity` tests now stub `SwapCard`; `panes` no longer lists swap. Popover for sources can run below the fold on a short viewport. Test gap: connected-state screenshots rely on a mock wallet, not a real one.
