# Sprint 31B — Portfolio Alchemy Token Discovery

> **Objective:** Enhance the Portfolio tab to discover ALL ERC-20 tokens held by the connected wallet using Alchemy's Enhanced API (`alchemy_getTokenBalances`), replacing the current `DEFAULT_TOKENS`-only multicall approach. Users will see every non-zero ERC-20 in their wallet, not just the ~80 pre-configured tokens.
>
> **Prerequisite:** Sprint 33 (test coverage) merged to main. Branch from latest `main`.
>
> **Background:** The Portfolio tab (Sprint 31) currently reads balances via wagmi `useReadContracts` multicall against the static `DEFAULT_TOKENS` list (~80 tokens). Users holding ERC-20s outside that list (e.g. airdropped tokens, small-cap holdings, LP tokens) see nothing. Option A (approved by TeraHash): add a server-side Alchemy API route that discovers all held tokens, then merge with the existing DEFAULT_TOKENS data.

---

## P179 — Server-side Alchemy token discovery route

### Context

Alchemy's Enhanced API endpoint `alchemy_getTokenBalances` returns all ERC-20 balances for an address in a single call (no multicall needed, no token list required). The response includes contract addresses and raw balances. A second call to `alchemy_getTokenMetadata` resolves symbol, name, decimals, and logo for unknown tokens.

The existing RPC setup uses `NEXT_PUBLIC_RPC_URL` which may or may not be Alchemy. We need a dedicated server-only Alchemy API key (`ALCHEMY_API_KEY`) to call the Enhanced API, keeping the key out of the browser.

### Objective

Create `GET /api/portfolio/tokens` — a server-side route that calls Alchemy to discover all ERC-20 tokens with non-zero balance for a given wallet address, resolves metadata for any tokens not in `DEFAULT_TOKENS`, and returns a unified list.

### Requirements

1. **New env var:** `ALCHEMY_API_KEY` (server-only, NO `NEXT_PUBLIC_` prefix).
   - Add to `.env.example` under a new `# ── Alchemy Enhanced API ──` section after the RPC section.
   - Comment: `# Server-only. Required for Portfolio token discovery (getTokenBalances).`
   - Comment: `# Get free at https://dashboard.alchemy.com — 300M compute units/month on free tier.`

2. **New file:** `src/app/api/portfolio/tokens/route.ts`

3. **Query params:**
   - `address` (required) — wallet address to query. Validate with `isValidAddress()`.

4. **Flow:**
   ```
   1. Validate address param
   2. Rate limit: 5 req/min per IP (via checkRateLimit)
   3. Call alchemy_getTokenBalances(address, "erc20")
   4. Filter out zero balances
   5. Split results into:
      a) KNOWN: address exists in DEFAULT_TOKENS → use existing Token metadata
      b) UNKNOWN: address NOT in DEFAULT_TOKENS → batch call alchemy_getTokenMetadata
   6. Return unified array
   ```

5. **Response shape:**
   ```typescript
   interface DiscoveredToken {
     address: string        // lowercase
     symbol: string
     name: string
     decimals: number
     logoURI: string | null // Alchemy provides logos for major tokens, null for others
     balance: string        // raw balance as decimal string (not hex)
     isDefault: boolean     // true if in DEFAULT_TOKENS list
   }

   // Response:
   { tokens: DiscoveredToken[] }
   ```

6. **Alchemy API calls** (use raw `fetch`, NOT the Alchemy SDK — we don't want another dependency):
   ```typescript
   // getTokenBalances
   POST https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}
   Body: { jsonrpc: "2.0", method: "alchemy_getTokenBalances", params: [address, "erc20"], id: 1 }

   // getTokenMetadata (for each unknown token)
   POST https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}
   Body: { jsonrpc: "2.0", method: "alchemy_getTokenMetadata", params: [tokenAddress], id: 1 }
   ```

7. **Batch metadata resolution:** For UNKNOWN tokens, batch `alchemy_getTokenMetadata` calls using `Promise.allSettled` (max 20 concurrent). If a metadata call fails, use fallback: `{ symbol: addr.slice(0,6), name: 'Unknown Token', decimals: 18, logoURI: null }`.

8. **Cap:** Maximum 200 discovered tokens per response. If Alchemy returns more, take the first 200 (they come sorted by contract address — we'll re-sort by USD value on the client later).

9. **Caching:** `Cache-Control: public, s-maxage=30, stale-while-revalidate=60` — shorter than prices route because discovery is more dynamic (new airdrops, etc.).

10. **Error handling:**
    - Missing `ALCHEMY_API_KEY` → 503 with message `'Token discovery unavailable. Configure ALCHEMY_API_KEY.'`
    - Alchemy API error → 502 with message `'Token discovery temporarily unavailable.'`
    - Never 500 — always return a structured error.

11. **Graceful degradation:** If the route returns 503 (no key configured), the hook (P180) falls back to the existing DEFAULT_TOKENS multicall behaviour. Portfolio still works, just without discovery.

### Do NOT

- Install the `alchemy-sdk` package. Use raw `fetch` with JSON-RPC.
- Expose `ALCHEMY_API_KEY` to the browser. This is a server-only route.
- Call `getTokenBalances` for ALL token types — only `"erc20"`. We don't want ERC-721/1155 in the portfolio.
- Remove or modify the existing `/api/portfolio/prices` route. It stays as-is.

### Files affected

- `src/app/api/portfolio/tokens/route.ts` — NEW
- `.env.example` — EDIT (add `ALCHEMY_API_KEY`)

### Expected output

- 1 commit: `feat(portfolio): add Alchemy token discovery API route [P179]`
- Route responds correctly with mock/real Alchemy key.

### Quality criteria

- `isValidAddress()` validation on address param.
- Rate limiting via `checkRateLimit`.
- No `NEXT_PUBLIC_` prefix on the Alchemy key.
- Graceful fallback when metadata fetch fails.
- Response shape matches the `DiscoveredToken` interface exactly.

---

## P180 — Integrate Alchemy discovery into `usePortfolio` hook

### Context

Currently `usePortfolio()` calls `useTokenBalances()` which multicalls `balanceOf` for every token in `DEFAULT_TOKENS`. With the Alchemy discovery route (P179), we can replace this with a single API call that returns ALL held tokens with their balances and metadata — then enrich with prices from the existing `/api/portfolio/prices` route.

### Objective

Refactor `usePortfolio` to use Alchemy discovery as the primary data source, falling back to the current multicall approach if Alchemy is unavailable (503).

### Requirements

1. **New private hook:** `useDiscoveredTokens(address: string | undefined)` in `src/hooks/usePortfolio.ts`
   - Calls `GET /api/portfolio/tokens?address=${address}`
   - Returns `{ tokens: DiscoveredToken[], isLoading, isError, isAvailable }`
   - `isAvailable = false` when the route returns 503 (no Alchemy key) — triggers fallback.
   - Refreshes every 60s (same cadence as prices).
   - Uses the same `fetchIdRef` stale-request guard pattern as the existing price fetch.

2. **Refactor `usePortfolio()`:**
   ```
   if (alchemyDiscovery.isAvailable) {
     // Use discovered tokens (Alchemy path)
     // Convert DiscoveredToken[] to Token[] for price fetch
     // For isDefault tokens: use DEFAULT_TOKENS metadata (better logos)
     // For non-default: construct Token from Alchemy metadata
   } else {
     // Fallback: existing DEFAULT_TOKENS multicall (current behaviour)
   }
   ```

3. **Token construction for discovered non-default tokens:**
   ```typescript
   const token: Token = {
     address: discovered.address as `0x${string}`,
     symbol: discovered.symbol,
     name: discovered.name,
     decimals: discovered.decimals,
     logoURI: discovered.logoURI || logo1inch(discovered.address), // try 1inch CDN as fallback
     category: 'Other' as TokenCategory, // discovered tokens default to 'Other'
   }
   ```
   Where `logo1inch(addr)` is the existing pattern: `https://tokens.1inch.io/${addr.toLowerCase()}.png`

4. **Price fetch integration:**
   - The existing `/api/portfolio/prices` route already accepts any valid address.
   - When using Alchemy path, pass ALL discovered token addresses to the price fetch.
   - Cap at 100 addresses per price call (existing limit). If >100 held tokens, batch into multiple price calls.

5. **Balance source:**
   - Alchemy path: balances come from the discovery API response (`DiscoveredToken.balance` as decimal string). Convert to `bigint` for `PortfolioToken.balance`.
   - Fallback path: balances come from wagmi multicall (current behaviour, unchanged).

6. **Keep `useTokenBalances()` private hook:** Don't remove it — it's the fallback path. Just gate its execution:
   ```typescript
   // Only run multicall when Alchemy is unavailable
   const multicallEnabled = !alchemyAvailable && isConnected && isCorrectChain
   ```
   When `multicallEnabled` is false, the wagmi hooks should NOT fire (avoid unnecessary RPC calls). Pass `enabled: multicallEnabled` to the wagmi hooks.

7. **Merge strategy for DEFAULT tokens:**
   When Alchemy IS available, a token that exists in both DEFAULT_TOKENS and the Alchemy response should use:
   - Metadata (symbol, name, logoURI, category) → from DEFAULT_TOKENS (curated, better logos)
   - Balance → from Alchemy response (single source of truth)
   - This avoids the multicall entirely.

### Do NOT

- Remove `useTokenBalances()` — it's the fallback for environments without Alchemy.
- Change the `PortfolioData` or `PortfolioToken` interfaces (they stay backwards-compatible).
- Fire wagmi multicall hooks when Alchemy discovery is available (waste of RPC quota).
- Change `PortfolioTab.tsx` in this prompt (handled in P181).

### Files affected

- `src/hooks/usePortfolio.ts` — EDIT (major refactor)

### Expected output

- 1 commit: `feat(portfolio): integrate Alchemy token discovery with fallback [P180]`
- `usePortfolio()` returns discovered tokens when Alchemy is configured.
- Falls back to DEFAULT_TOKENS multicall when Alchemy returns 503.

### Quality criteria

- Zero RPC multicalls when Alchemy is available.
- Graceful degradation: removing `ALCHEMY_API_KEY` from env returns Portfolio to Sprint 31 behaviour.
- No UI changes yet (PortfolioTab still works identically).
- `PortfolioToken.token.category` is `'Other'` for discovered non-default tokens.

---

## P181 — PortfolioTab UI: "Discovered" category + token import CTA

### Context

With Alchemy discovery (P180), the Portfolio now shows tokens the user holds that are NOT in the DEFAULT_TOKENS curated list. These appear with `category: 'Other'` and potentially unknown logos. The UI needs a minor enhancement to handle this gracefully.

### Objective

Update `PortfolioTab.tsx` to visually distinguish discovered (non-default) tokens and offer a way to add them to the curated token selector for swaps.

### Requirements

1. **"Discovered" section:** Tokens with `category: 'Other'` that are NOT in `DEFAULT_TOKENS` should appear in a separate group at the bottom, under the label **"Discovered in Wallet"** instead of just "Other".
   - To distinguish: check `entry.token.address` against `DEFAULT_TOKENS` addresses. If not found → discovered.
   - Keep existing `CATEGORY_DISPLAY_ORDER` for all DEFAULT tokens. Append "Discovered in Wallet" at the very end.

2. **Visual differentiation for discovered tokens:**
   - Add a subtle dotted border instead of solid (`border-dashed border-cream-08` instead of `border border-cream-08`).
   - Show the truncated contract address under the token name: `0x1234...abcd` (first 6 + last 4 chars).
   - The existing `TokenAvatar` initials fallback already handles missing logos — no change needed.

3. **"Add to Tokens" button** (instead of "Swap" for discovered tokens):
   - If the token is NOT in DEFAULT_TOKENS, show an "Add" button (instead of "Swap").
   - On click: call the existing `useTokenImport` hook's `importToken()` with the discovered token data. This persists the token to localStorage so it appears in the TokenSelector for future swaps.
   - After import succeeds, the button changes to "Swap" (normal behaviour).
   - Check if `useTokenImport` already handles the `Token` type or needs adaptation.

4. **Empty discovery state:** If Alchemy returns tokens but all are in DEFAULT_TOKENS (nothing new discovered), don't show the "Discovered in Wallet" section at all.

5. **Discovery unavailable state:** If using the fallback path (no Alchemy), don't show any "Discovered" UI — the Portfolio works exactly as Sprint 31.

### Do NOT

- Change the visual design of existing DEFAULT token rows.
- Add any new dependencies or external components.
- Modify `usePortfolio.ts` or the API routes.

### Files affected

- `src/components/PortfolioTab.tsx` — EDIT

### Expected output

- 1 commit: `feat(portfolio): discovered tokens UI with import CTA [P181]`
- Discovered tokens appear in a "Discovered in Wallet" section at the bottom.
- "Add" button imports the token; after import, shows "Swap" instead.

### Quality criteria

- Discovered section only appears when there are non-default tokens.
- No layout shift when tokens load.
- Dotted border visually distinguishes discovered from curated tokens.
- Truncated address shown for discovered tokens only.

---

## P182 — Tests for Alchemy token discovery

### Context

P179 added the API route, P180 refactored the hook, P181 updated the UI. Now we need test coverage for the new code paths.

### Requirements

1. **`src/app/api/portfolio/tokens/route.test.ts`** — NEW (minimum 10 tests):
   - Missing address param → 400
   - Invalid address → 400
   - Missing `ALCHEMY_API_KEY` → 503 with specific message
   - Rate limit exceeded → 429
   - Alchemy returns empty balances → `{ tokens: [] }`
   - Alchemy returns mix of DEFAULT and unknown tokens → both appear with correct `isDefault` flag
   - Alchemy metadata call fails for unknown token → fallback metadata used
   - Alchemy API error → 502
   - Cap at 200 tokens
   - Response shape matches `DiscoveredToken` interface

2. **`src/hooks/usePortfolio.test.ts`** — EDIT (add ~8 tests to existing file):
   - Alchemy available: discovered tokens appear in output
   - Alchemy available: DEFAULT tokens use curated metadata (not Alchemy metadata)
   - Alchemy available: non-default tokens get `category: 'Other'`
   - Alchemy 503: falls back to multicall path (existing behaviour)
   - Alchemy available: wagmi multicall hooks not fired (mock should NOT be called)
   - Price fetch includes discovered token addresses
   - Balance from Alchemy correctly converted to bigint
   - >100 tokens: price fetches batched

3. **`src/components/PortfolioTab.test.tsx`** — EDIT (add ~5 tests to existing file):
   - Discovered tokens show "Discovered in Wallet" section label
   - Discovered tokens show truncated address
   - Discovered tokens show "Add" button (not "Swap")
   - No discovered section when all tokens are DEFAULT
   - No discovered section when Alchemy unavailable (fallback mode)

### Do NOT

- Mock the real Alchemy API in integration tests — use Jest mocks on `fetch`.
- Remove or modify existing test cases.

### Files affected

- `src/app/api/portfolio/tokens/route.test.ts` — NEW
- `src/hooks/usePortfolio.test.ts` — EDIT
- `src/components/PortfolioTab.test.tsx` — EDIT

### Expected output

- 1 commit: `test(portfolio): add Alchemy discovery tests [P182]`
- All new + existing tests pass.
- Minimum 23 new test cases.

### Quality criteria

- Every new code path from P179–P181 has at least one test.
- Mocks reset between tests.
- No flaky tests (all deterministic with mocked fetch).

---

## Sprint 31B — Summary

| Prompt | Scope | Files | Tests |
|--------|-------|-------|-------|
| P179 | Alchemy API route | 1 new + 1 edit | — |
| P180 | usePortfolio refactor | 1 edit | — |
| P181 | PortfolioTab discovered UI | 1 edit | — |
| P182 | Tests | 1 new + 2 edits | ~23 new |

**Branch:** `feat/sprint-31b-alchemy-discovery`

**New env var:** `ALCHEMY_API_KEY` (server-only)

**Expected total tests after sprint:** ~1131+ (1108 current + ~23 new)

**Acceptance criteria:**
- Portfolio shows ALL held ERC-20s when `ALCHEMY_API_KEY` is configured.
- Portfolio degrades gracefully to DEFAULT_TOKENS only when key is absent.
- Zero additional RPC multicalls when Alchemy path is active.
- All new + existing tests pass.
- Each prompt = 1 atomic commit with hash referenced.
- No npm audit regressions (no new dependencies).
