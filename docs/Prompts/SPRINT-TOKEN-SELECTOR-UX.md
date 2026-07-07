# SPRINT-TOKEN-SELECTOR-UX — token logos, verified badge, xStocks, category filter

Four UX improvements to the swap token selector (`src/components/TokenSelector.tsx` + the token catalog
`src/lib/chains/tokens.ts` / `src/lib/tokens.ts` + `TokenAddressBadge`). **Frontend only — no backend/contract
changes.** Branch `sprint/token-selector-ux` off latest `origin/main`. CI + test-contracts green; SSH-signed
commits; FEEDBACK. Keep the existing search / import-by-address / "Your Tokens" / balances behaviour intact.

## Part 1 — A logo for EVERY token (no blanks)
Today a missing/broken `logoURI` just hides the `<img>` (`onError → display:none`) → an empty circle (looks
amateur). Build a shared **`<TokenLogo token size>`** component with a proper fallback chain, used everywhere
(trigger button, popular chips, TokenRow):
1. `token.logoURI` if present/valid;
2. else a deterministic CDN-by-address (e.g. Trust Wallet assets for the token's chain by checksummed
   address) — best-effort, with onError → step 3;
3. final fallback: a **generated avatar** (jazzicon/blockie from the address, or a colored circle with the
   symbol's first 1-2 letters) — never a blank.
Also improve sourcing where cheap: discovered tokens (Alchemy metadata returns a `logo`) and the catalog's
`logoURI` should populate so most tokens hit step 1.

## Part 2 — Verified badge: green shield + check
The "certificate" stamp on each row (`TokenAddressBadge`) looks amateur. Redesign the **verified** indicator
as a clean **green shield with a white ✓ in the centre** (crisp SVG, not an emoji). Show it ONLY for
verified/curated tokens (the default-list / `isDefault` / `verified` flag). For imported/unverified tokens,
do NOT show the green check — keep a neutral/amber indicator (the import flow already warns users). Consistent
size/alignment with the address text.

## Part 3 — Add xStocks  ⚠️ address-accuracy is security-critical
Add **xStocks** (Backed Finance tokenized equities) to the catalog under a new **"Stocks"** category.
- **FIRST verify availability + liquidity** on TeraSwap's chains (Base / Ethereum mainnet). If xStocks aren't
  deployed/liquid there, **report it and skip** — do not force them in.
- **Addresses MUST come from official/authoritative sources** (Backed Finance / xStocks official list or a
  reputable verified token list) and be cross-checked — a wrong/typo'd address in the curated list = users
  buying a scam/wrong token = security incident. **Do NOT fabricate or guess addresses.** Include
  symbol/name/decimals/logoURI per token.
- Output the proposed xStocks address list in FEEDBACK for **Architect/owner sign-off BEFORE merge** (we
  verify each address against the official source). Only ship the verified set.

## Part 4 — Category filter index
Add a row of clickable **category chips** near the top (derived from the catalog categories — Native,
Stablecoin, DeFi, Stocks, Meme, etc.). Tapping a chip **filters** the list to that type (toggle on/off; one
active at a time is fine). Works alongside the search box (search within the active filter). When none is
active, show the current grouped view. Keep the existing popular-symbol quick-chips or fold them in — your
call, but don't regress quick-select.

## Do NOT
- No backend/contract/gate changes. Don't break search, import-by-address, balances, or the curated set.
  xStocks: verified official addresses only, owner sign-off before merge.

## Output
- Branch `sprint/token-selector-ux`; the 4 parts + tests (logo fallback renders for a no-logo token; verified
  badge shows only for curated; category filter filters correctly; xStocks render under Stocks IF verified).
  FEEDBACK with the xStocks proposed-address list (for sign-off) + screenshots/notes. **Architect/owner signs
  off the xStocks addresses before merge.**
