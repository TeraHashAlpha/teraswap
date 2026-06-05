# UX Security — Prompts 21–24

**Status:** COMPLETE (all 4 prompts shipped)
**Owner:** Code agent
**Architect reviewer:** TeraSwap Architect
**Last updated:** 2026-04-15

This file consolidates the four UX-security prompts that came out of the Permit2 phishing discussion and the CoW DNS hijack debrief. All four have been implemented and shipped.

| # | Prompt | Theme | Commit | Status |
|---|---|---|---|---|
| 21 | Permit2 Phishing Defense UX | Education + Revoke.cash link | `91d3c5b` | ✅ Shipped |
| 22 | Add BOLD token (Liquity v2) | Default token list extension | `f083092` | ✅ Shipped |
| 23 | Categorize tokens via CoinGecko | Build-time category snapshot | `0f3d673` | ✅ Shipped |
| 24 | Show token contract address (Kamino-style) | Anti-phishing UI affordance | `f9f7867` | ✅ Shipped |

Prompt 21 is reproduced in full at the bottom for reference (original in `SPRINT4-PROMPTS.md`). Prompts 22–24 are reconstructed here from the architecture conversation on 2026-04-14 and replace any transcript-only version.

---

## PROMPT 22 — Add BOLD token (Liquity v2) to the default token list

### Context

TeraSwap ships a curated default token list in `src/lib/tokens.ts`. Users can paste any address, but curated tokens surface in the selector without friction. BOLD is Liquity v2's decentralized stablecoin, launched early 2025, and has sufficient on-chain liquidity on 1inch/0x/Paraswap to route through TeraSwap. TeraHash has requested it be added to the default set.

**Canonical BOLD token:** `0x6440f144b7e50d6a8439336510312d2f54beb01d` (mainnet, 18 decimals, symbol `BOLD`, name "BOLD Stablecoin" — verify against CoinGecko / Etherscan at time of implementation).

### Objective

Add BOLD to `src/lib/tokens.ts` as a curated default token in the stablecoin section, alongside existing stables (USDC, USDT, DAI, crvUSD).

### Requirements

1. Add a new entry in `src/lib/tokens.ts` in the stablecoin block (next to crvUSD):
   - `address`: `0x6440f144b7e50d6a8439336510312d2f54beb01d` (checksum form)
   - `symbol`: `BOLD`
   - `name`: `BOLD Stablecoin` (confirm against CoinGecko + Etherscan; if CoinGecko has a different canonical name, use that)
   - `decimals`: `18` (verify on-chain via `cast call 0x6440... "decimals()(uint8)"` — do NOT trust this prompt)
   - `logoURI`: use the existing `logo(addressLowercase)` helper (whichever TrustWallet/1inch asset resolver the file already uses)
2. Manual verification before commit:
   - Fetch a quote on-chain from at least one aggregator (0x public endpoint is fine) for USDC→BOLD 1000 USDC, confirm a non-trivial quote returns. If no aggregator has BOLD liquidity, stop and escalate — do not merge a token that cannot be routed.
   - Confirm `decimals()` returns 18 via Etherscan read-contract or `cast`.
3. No test changes strictly required, but if there's a snapshot test on the default token count, update it.

### Do NOT

- Do NOT add BOLD to any denylist or special-case logic. It's a normal ERC20.
- Do NOT introduce a new logo hosting path — use the existing `logo()` helper even if the resulting URL 404s in the short term (fallback UI handles this). If the logo is broken, file a separate issue; don't block this PR on it.
- Do NOT change the order of other tokens. Append in the stablecoin block.

### Files affected

- `src/lib/tokens.ts` (edit)
- snapshot test file if one exists for the token list

### Expected output

BOLD appears in the swap token selector, sorts alongside other stables, and can be selected as source or destination. Aggregators that support BOLD return quotes; those that don't return empty (handled by existing no-route UI).

### Quality criteria

- Decimals verified on-chain (not taken from this prompt).
- At least one aggregator returns a non-zero quote for a BOLD pair in a manual smoke test.
- `npm run lint` and `npm run typecheck` clean.

---

## PROMPT 23 — Categorize tokens via CoinGecko build-time snapshot

### Context

The token selector currently lists all curated tokens in a flat alphabetical list. As the curated set grows (Prompt 22 adds BOLD; more will follow), users have trouble finding tokens. Categorization (Stablecoins, Liquid Staking, DeFi blue-chips, BTC-wrapped, Memes, etc.) is a well-known UX pattern. CoinGecko maintains category labels per token and is a credible source.

We want **build-time** categorization — not a runtime API call from the browser. This avoids CoinGecko rate limits, removes the browser's dependency on a third party at runtime, and makes the selector deterministic per deploy.

### Objective

Introduce a category field on each token in `src/lib/tokens.ts` (or a sibling structure), populated at build time from a CoinGecko snapshot, and render the selector grouped by category.

### Requirements

1. **Snapshot script** — new `scripts/sync-token-categories.ts`:
   - Reads the current curated token list from `src/lib/tokens.ts`.
   - For each token, calls CoinGecko `/coins/ethereum/contract/{address}` (free public tier; add delay between calls to stay under rate limits — 10s per call is safe).
   - Extracts `categories` array and picks one primary category per token using a priority ranking defined in the script (e.g., `Stablecoins > Liquid Staking > BTC > DeFi > Layer 1/2 > Meme > Other`). Rationale: CoinGecko assigns multiple categories per token; we need a deterministic single label for the selector.
   - Writes output to `src/lib/token-categories.json` — a map of `{ addressLowercase: categoryLabel }`.
   - The script is idempotent: running twice produces identical JSON (sort keys).
2. **Type integration** — extend the Token type in `src/lib/tokens.ts` with `category?: string` and compute category at module load from the JSON (or inline at build time via a simple generator). The token list stays authoritative; the JSON is a join.
3. **Selector UI** — update the token selector component to group tokens by category. Categories rendered in priority order. Uncategorized tokens (address not in JSON) fall under "Other".
4. **npm script** — add `"sync:token-categories": "tsx scripts/sync-token-categories.ts"` to `package.json`. Document in README or SPRINT notes that this is run manually when adding tokens.
5. **Test** — snapshot test that verifies the grouping renders in the expected order for a fixed input. No network call in tests.

### Do NOT

- Do NOT call CoinGecko at runtime from the browser or from Vercel serverless functions. Build-time only.
- Do NOT introduce a runtime dependency on a CoinGecko client library. The script uses native `fetch`.
- Do NOT fail the build if the JSON is missing or a token isn't in it — fall back to "Other" gracefully. The JSON is advisory.
- Do NOT map categories 1:1 from CoinGecko. Use the priority ranking to collapse to a single label per token; multi-label UI is out of scope.

### Files affected

- `scripts/sync-token-categories.ts` (new)
- `src/lib/token-categories.json` (new, committed; populated by the script)
- `src/lib/tokens.ts` (edit — extend type, wire JSON)
- `src/components/TokenSelector.tsx` or equivalent (edit — group rendering)
- `package.json` (add script)
- test file for the selector (update or add snapshot)

### Expected output

Users opening the token selector see tokens grouped into clear categories (Stablecoins, Liquid Staking, etc.). Adding a new token is a two-step manual process for the maintainer: edit `tokens.ts`, then run `npm run sync:token-categories`. If the script fails or is skipped, the new token appears under "Other" — no crash, no build failure.

### Quality criteria

- Script runs end-to-end on the current token set without hitting CoinGecko rate limits.
- JSON output is deterministic (re-running produces identical bytes).
- Selector renders correctly with an empty JSON (everything under "Other").
- `npm run lint`, `npm run typecheck`, `npm run build` all clean.

---

## PROMPT 24 — Show token contract address in selector/input/confirmation (Kamino-style)

### Context

Phishing tokens with identical names (`USDC`, `WETH`) but different contract addresses are a recurring attack on DEX aggregators. The best defense is to make the actual contract address visible at every step where the user is about to commit. Kamino Swap on Solana does this well: the address is shown in a monospace font, truncated with hover-to-expand, next to the symbol everywhere.

TeraSwap currently shows the address only in the selector list's secondary row and nowhere during confirmation. Users can be tricked if a phishing token list ever gets loaded (e.g., via an imported list URL).

### Objective

Add a reusable `TokenAddressBadge` component that renders a truncated, copyable, Etherscan-linked contract address. Use it in:
1. The token selector dropdown (next to symbol, not only in the secondary row)
2. The "From" and "To" token inputs on the main swap UI (subtle, below the symbol)
3. The final confirmation modal (prominent, above the "Confirm swap" button)

### Requirements

1. **New component** `src/components/TokenAddressBadge.tsx`:
   - Props: `address: string`, `size?: 'sm' | 'md'`, `showCopy?: boolean` (default true), `showEtherscan?: boolean` (default true)
   - Renders: `0xABCD…1234` (first 6 + last 4 chars, checksum-cased), monospace font, copy icon, external-link icon to `https://etherscan.io/token/{address}`.
   - Click on the truncated text copies the full address to clipboard with a 1.5s "Copied!" toast/tooltip.
   - Native ERC20 (0xEeee...EEeE pseudo-address for ETH) renders as "Native ETH" with no Etherscan link, no copy icon. Do NOT crash on ETH.
2. **Integrate in selector** — update the token list row to show symbol + name + `<TokenAddressBadge size="sm" />`. Keep existing behavior (click row selects token).
3. **Integrate in swap inputs** — below each selected token's symbol in the "From"/"To" fields, render `<TokenAddressBadge size="sm" showCopy={false} />` (copy is redundant when the badge is inline with live input state; keep Etherscan link). Subtle styling, do not dominate the input.
4. **Integrate in confirmation modal** — prominently show both token addresses with `<TokenAddressBadge size="md" />`. Position above the final action button. Add inline copy: "Verify addresses match the tokens you intend to swap."
5. **Accessibility** — full address accessible via tooltip (`title` attr) and screen-reader text (`<span className="sr-only">{fullAddress}</span>`).
6. **Tests** — unit tests for the component (renders, copies, handles native ETH).

### Do NOT

- Do NOT validate the address against any list inside this component. It's a display component only. Any trust decisions happen upstream (curated list + imported list handling).
- Do NOT introduce a new clipboard library. Use the native `navigator.clipboard.writeText` with a minimal try/catch.
- Do NOT replace any existing token display component; extend. Specifically, keep the existing secondary-row address display in the selector if present (redundancy is fine here — the more places the address is visible, the better the defense).
- Do NOT add the badge to the route visualization (where TeraSwap shows which aggregator/pool is used). That's a different concept (contract addresses of pools, not of tokens) and out of scope for this prompt.

### Files affected

- `src/components/TokenAddressBadge.tsx` (new)
- `src/components/TokenSelector.tsx` (edit)
- `src/components/SwapBox.tsx` (edit — token inputs)
- confirmation modal component (edit — likely `src/components/SwapConfirmModal.tsx` or similar)
- test files accordingly

### Expected output

At every moment in the swap flow, the user can see the exact on-chain address of the token they're about to swap, click it to verify on Etherscan, and copy it for independent verification. A user who has been tricked into importing a phishing token list has multiple chances to notice the address doesn't match what they expect.

### Quality criteria

- Component renders identically for every token (no per-token special-casing).
- ETH / native token handled gracefully.
- No visual regressions in existing components (before/after screenshots attached in PR description).
- `npm run lint`, `npm run typecheck`, test suite clean.

---

## PROMPT 21 — Permit2 Phishing Defense UX (R-UX-01) — *reference copy*

> Full prompt originally in `SPRINT4-PROMPTS.md` lines 119–166. Not duplicated here to avoid drift — treat `SPRINT4-PROMPTS.md` as the source of truth for Prompt 21.

Summary:
- New `Permit2EducationModal` shown once per user before their first Permit2 signature, gated on `localStorage` flag `teraswap:permit2-educated:v1`.
- Add a Revoke.cash link in `ActiveApprovals.tsx` directing users to see/revoke approvals outside TeraSwap's scope.
- Hook point is `src/hooks/useApproval.ts` (or wherever the Permit2 `signTypedData` call originates).
- Do NOT change Permit2 signature parameters (already correct: exact amount, 24h expiration).

See `SPRINT4-PROMPTS.md` for the complete Context / Objective / Requirements / Do NOT / Files / Expected Output / Quality criteria.

---

## Execution order (actual)

All four shipped in Sprint 4, prior to Sprint 5A:

1. **Prompt 21** (`91d3c5b`) — Permit2EducationModal + Revoke.cash link in ActiveApprovals
2. **Prompt 22** (`f083092`) — BOLD token added to curated stablecoin list
3. **Prompt 23** (`0f3d673`) — CoinGecko category sync script + category field on Token type + grouped selector
4. **Prompt 24** (`f9f7867`) — TokenAddressBadge component integrated in TokenSelector and SwapBox inputs

---

## References

- `SPRINT4-PROMPTS.md` — Prompt 21 source of truth
- `SPRINT5A-PLAN.md` — monitoring stack plan (not dependent on any of these prompts)
- CoinGecko contract endpoint: `https://api.coingecko.com/api/v3/coins/ethereum/contract/{address}`
- Uniswap Permit2 contract: `0x000000000022D473030F116dDEE9F6B43aC78BA3`
- Liquity v2 / BOLD: `0x6440f144b7e50d6a8439336510312d2f54beb01d`
