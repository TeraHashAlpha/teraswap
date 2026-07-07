# CHORE-TOKEN-LOGOS-COVERAGE — near-100% logo coverage (Matcha-level)

The logo fix improved things but coverage is still short: many tokens (e.g. **Pendle, FRAX, LUSD, PYUSD**)
still show generated initials. The owner's bar is **Matcha-level — virtually every token shows a real logo**.
Root cause: the DefiLlama **token-icons-by-address** endpoint (`token-icons.llamao.fi/icons/tokens/<chainId>/
<addr>`) has coverage GAPS — a token can have a logo in DefiLlama's coin/protocol index yet 404 on the
per-address icon endpoint (Pendle is the proof: logo exists on DefiLlama search, 404s by address ⇒ initials).
Continue on branch `sprint/token-selector-ux` (PR #207, not merged). Frontend (+ optional server route);
CI green; FEEDBACK with coverage proof. **The owner accepts this taking extra time/resources — coverage is a
must-have.**

## Goal
Resolve a real logo for **(near) every token** on Base + mainnet; generated initials must become genuinely
rare (only truly image-less tokens). Match Matcha's coverage.

## Approach (evaluate + implement the most reliable; you may combine)
1. **Diagnose first:** HEAD-test the current DefiLlama-by-address URL for the failing examples (Pendle/FRAX/
   LUSD/PYUSD on their Base AND mainnet addresses) and document what 404s vs 200s — don't guess.
2. **Add comprehensive sources** so gaps are filled (pick what gives the coverage, in priority order):
   - A **comprehensive token list with logoURIs** baked in — e.g. CoinGecko per-chain lists
     (`tokens.coingecko.com/{ethereum,base}/all.json`) or the Uniswap/0x aggregated lists. This is how
     Matcha-grade UIs get near-universal coverage. If bundling the full list is too heavy, fetch/cache it via
     a small **server route** (`/api/token-logo?chainId&address`) that resolves + caches (avoids client
     rate-limits + CORS), with a CDN-cache header.
   - **CoinGecko contract-address image** as a resolver source (the most comprehensive by-address source) —
     via the server route to avoid client-side rate limits.
   - Keep DefiLlama + Trust Wallet as additional fallbacks; **generated avatar = TRUE last resort.**
   - Discovered tokens already carry an Alchemy logo — keep using it.
3. Keep the core-10 local `/public/tokens` assets (instant, offline-proof).

## Verify (mandatory — coverage is the whole point)
- The named examples **Pendle, FRAX, LUSD, PYUSD show real logos** on Base + mainnet, plus a broad sample
  (≥20 mixed tokens incl. long-tail). Initials appear only for a deliberately fake/imageless token.
- Don't introduce client-side rate-limit failures or large bundle bloat (prefer the cached server route over
  shipping a multi-MB list to the client). Note bundle/route perf in FEEDBACK.

## Do NOT
- No backend/contract/gate changes beyond an optional read-only logo-resolver route. Don't regress the
  verified badge / category filter / the core-10 local logos. Avatar stays as the final fallback (just rare).

## Output
- On `sprint/token-selector-ux`: comprehensive resolver (+ optional cached `/api/token-logo` route), the named
  examples + broad sample verified showing real logos (Preview screenshots/notes in FEEDBACK). No Auditor.
