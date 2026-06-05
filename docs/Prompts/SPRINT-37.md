# Sprint 37 — Portfolio Discovery Fixes

**Goal:** Two fixes for the Alchemy discovery path in Portfolio: (1) include native ETH balance alongside ERC-20 discoveries, and (2) graceful fallback to multicall when the discovery endpoint fails persistently.

**Branch:** `fix/sprint-37-portfolio-fallback`  
**Base:** `main` (current HEAD)  
**Prerequisite:** Sprint 31B merged (Alchemy discovery), Sprint 36 merged (quote cache)  
**Test count baseline:** 1122 (vitest count)

---

## Background

The `useDiscoveredTokens` internal hook in `src/hooks/usePortfolio.ts` currently treats HTTP status codes as follows:

- **503** → sets `isAvailable = false`, triggers multicall fallback (correct — means ALCHEMY_API_KEY not configured)
- **Any other non-ok** (e.g. 502, 500, 429) → sets `isError = true` but keeps `isAvailable = true` — the multicall path never activates, and the user sees a permanent error with no data

When the Alchemy Enhanced API is down or the key is invalid (producing 502 from the server route), the user gets stuck on an error state. The correct UX is: try Alchemy, and if it fails repeatedly, degrade to the multicall path (DEFAULT_TOKENS only) so the user at least sees their core token balances.

---

## P195 — Include native ETH balance in Alchemy discovery path

### Context

- File: `src/hooks/usePortfolio.ts`, function `usePortfolio` (lines 278–447)
- The Alchemy path (`useAlchemyPath = true`) iterates `discovery.tokens` to build `heldEntries` (lines 320–347)
- `alchemy_getTokenBalances` returns only **ERC-20 tokens** — native ETH is NOT an ERC-20 and is never included
- The fallback multicall path correctly includes ETH via wagmi's `useBalance()` (line 96)
- Result: when Alchemy discovery is active, the user's ETH balance is invisible in the Portfolio tab

### Objective

When the Alchemy path is active, also fetch the native ETH balance via wagmi's `useBalance()` and prepend it to the `heldEntries` array.

### Requirements

1. The `useBalance()` hook (line 96) is currently inside `useTokenBalances()` which is **disabled** when `useAlchemyPath = true` (line 290: `useTokenBalances(!useAlchemyPath)`). We cannot simply enable it there — that would also fire the 80-call multicall which we want to avoid.

2. Add a **standalone** `useBalance()` call at the top of `usePortfolio()`, right after the `useDiscoveredTokens` and `useTokenBalances` calls:

   ```tsx
   // Native ETH balance — needed by the Alchemy path since
   // alchemy_getTokenBalances only returns ERC-20 tokens.
   const { address: walletAddress } = useAccount()
   const { data: nativeEthBalance } = useBalance({
     address: walletAddress,
     query: { enabled: useAlchemyPath && !!walletAddress, refetchInterval: 30_000 },
   })
   ```

   Note: `useAccount()` is already called at line 279. Reuse that `address` — do NOT add a second `useAccount()`. The `useBalance` here is enabled **only** when on the Alchemy path.

3. In the `heldEntries` memo (line 320), when `useAlchemyPath` is true, **prepend** the native ETH entry before iterating `discovery.tokens`:

   ```tsx
   if (useAlchemyPath) {
     const out: HeldEntry[] = []
     // Prepend native ETH (not included in alchemy_getTokenBalances)
     if (nativeEthBalance && nativeEthBalance.value > 0n) {
       const ethToken = DEFAULT_TOKENS.find(isNativeETH)
       if (ethToken) {
         out.push({
           token: ethToken,
           balance: nativeEthBalance.value,
           balanceFormatted: formatBalance(nativeEthBalance.value, 18),
         })
       }
     }
     for (const d of discovery.tokens) {
       // ... existing ERC-20 logic unchanged
     }
     return out
   }
   ```

4. Add `nativeEthBalance` to the `useMemo` dependency array for `heldEntries`.

### Do NOT

- Do NOT enable the multicall path when Alchemy is active — that wastes RPC quota.
- Do NOT modify `useTokenBalances()` — it stays as the fallback-only hook.
- Do NOT add a second `useAccount()` call — reuse the existing `address` from line 279.
- Do NOT change the server-side route.
- Do NOT change the fallback path logic — it already handles ETH correctly.

### Files affected

- `src/hooks/usePortfolio.ts`

### Expected output

After this change, native ETH appears at the top of the Portfolio token list when the Alchemy path is active. The TOTAL VALUE includes the ETH balance.

### Quality criteria

- ETH balance visible in Portfolio when Alchemy discovery is active
- ETH balance NOT double-counted (only one `useBalance` active at a time)
- `npm run typecheck` passes
- All existing tests pass

---

## P193 — Graceful fallback on persistent discovery failure

### Context

- File: `src/hooks/usePortfolio.ts`, function `useDiscoveredTokens` (lines 161–233)
- Currently: a single 502 sets `isError = true`, `isAvailable = true` → multicall disabled, user sees error
- The `fetchDiscovery` function is called on mount and every `DISCOVERY_REFRESH_MS` (60s) via `setInterval`
- The `usePortfolio` hook selects the path via `const useAlchemyPath = discovery.isAvailable` (line 282)

### Objective

Add a **consecutive failure counter** to `useDiscoveredTokens`. After `MAX_DISCOVERY_FAILURES` consecutive non-503 failures, set `isAvailable = false` (triggering the multicall fallback). Reset the counter on any successful response. The user gets degraded data instead of no data.

### Requirements

1. Add a `const MAX_DISCOVERY_FAILURES = 2` at module level (near `DISCOVERY_REFRESH_MS`).

2. Inside `useDiscoveredTokens`, add a `failCountRef = useRef(0)` to track consecutive failures.

3. Modify the fetch response handling:
   - **503**: unchanged — immediate `isAvailable = false`, reset `failCountRef.current = 0`
   - **Other non-ok** (e.g. 502, 500, 429):
     - Increment `failCountRef.current`
     - If `failCountRef.current >= MAX_DISCOVERY_FAILURES`:
       - Set `isAvailable(false)` — activates multicall fallback
       - Set `isError(false)` — not an error, it's a graceful degradation
       - `console.warn('[useDiscoveredTokens] Discovery failed %d times consecutively, falling back to multicall', failCountRef.current)`
     - Else:
       - Set `isError(true)`, `isAvailable(true)` — transient error, will retry on next interval
   - **Success** (ok response):
     - Reset `failCountRef.current = 0`
     - Existing behaviour unchanged
   - **Network error** (catch block):
     - Same logic as "other non-ok" — increment counter, check threshold

4. When `isAvailable` flips from `true` → `false` due to persistent failure, the next `setInterval` tick should still attempt discovery. If Alchemy recovers, the success path resets `failCountRef` and sets `isAvailable(true)` again, re-enabling the Alchemy path automatically.

5. Export `MAX_DISCOVERY_FAILURES` so tests can reference it.

### Do NOT

- Do NOT change the 503 behaviour — it must remain an immediate fallback (means key is not configured, not a transient error).
- Do NOT change the `useTokenBalances` hook or the multicall path.
- Do NOT change the server-side route (`/api/portfolio/tokens/route.ts`).
- Do NOT add retry logic with delays — the existing `setInterval` already retries every 60s.
- Do NOT import any new dependencies.
- Do NOT change `DISCOVERY_REFRESH_MS` or `PRICES_REFRESH_MS`.

### Files affected

- `src/hooks/usePortfolio.ts`

### Expected output

After this change:
- First 502 → `isError=true`, `isAvailable=true` (transient, will retry in 60s)
- Second consecutive 502 → `isAvailable=false`, `isError=false`, multicall activates
- User sees DEFAULT_TOKENS balances instead of error state
- If Alchemy recovers on next tick → `isAvailable=true` again, Alchemy path re-enabled

### Quality criteria

- `npm run typecheck` passes
- `npm run lint` passes
- All existing tests pass (the default mock returns 503 so existing behaviour is unchanged)
- No new warnings in browser console during normal operation

---

## P194 — Tests for discovery fallback behaviour

### Context

- File: `src/hooks/usePortfolio.test.ts` (462 lines)
- Existing tests mock `fetch` globally via `vi.stubGlobal('fetch', fetchMock)`
- The default mock returns 503 for `/api/portfolio/tokens` (exercises multicall path)
- `discoveryAvailable()` helper overrides to return 200 with tokens (exercises Alchemy path)
- Test for 503 fallback already exists: `'Alchemy 503: falls back to the multicall path (Sprint 31 behaviour)'` (line 351)

### Objective

Add tests covering P195 (native ETH in Alchemy path) and the new consecutive-failure fallback from P193.

### Requirements

Add these test cases inside the existing `describe('usePortfolio', ...)` block:

#### P195 coverage — native ETH in Alchemy path

0. **`'Alchemy available: native ETH balance is included alongside ERC-20 discoveries'`**
   - Use `discoveryAvailable()` to return USDC with a balance
   - The `balanceMock` already provides 2 ETH (set in `beforeEach`)
   - Assert that the result includes BOTH ETH and USDC
   - Assert ETH appears first (prepended, not appended)
   - Assert `totalValueUsd` includes the ETH value

#### P193 coverage — consecutive-failure fallback (after the 503 test):

1. **`'Alchemy 502: first failure shows error, second triggers multicall fallback'`**
   - Mock `/api/portfolio/tokens` to return `{ ok: false, status: 502 }` (not 503)
   - Render hook
   - After first fetch: assert `isError === true` (transient error)
   - Trigger the interval (use `vi.advanceTimersByTime(DISCOVERY_REFRESH_MS)` — you'll need `vi.useFakeTimers()` in this test)
   - After second fetch: assert `isError === false` (graceful degradation, not error)
   - Assert multicall data surfaces (ETH + USDC from wagmi mocks, same as 503 test)

2. **`'Alchemy recovery: fallback reverts to Alchemy path when discovery succeeds'`**
   - Mock `/api/portfolio/tokens` to return 502 twice (triggering fallback)
   - Then change mock to return 200 with discovery tokens
   - Trigger interval again
   - Assert Alchemy-path tokens appear (not multicall)
   - Assert `isError === false`

3. **`'Alchemy network error: counted as failure toward fallback threshold'`**
   - Mock `fetch` to throw `TypeError('Failed to fetch')` for `/api/portfolio/tokens`
   - Assert the same consecutive-failure → fallback behaviour as the 502 test

4. **`'Alchemy 429: counted as failure toward fallback threshold'`**
   - Mock `/api/portfolio/tokens` to return `{ ok: false, status: 429 }`
   - Same assertions as 502 test

### Do NOT

- Do NOT modify existing tests — only add new ones.
- Do NOT change the `discoveryAvailable()` helper.
- Do NOT add new external test dependencies.
- Do NOT test the server-side route in this file (that's `route.test.ts`).

### Files affected

- `src/hooks/usePortfolio.test.ts`

### Expected output

5 new test cases, all green. Total test count: 1122 + 5 = **1127** minimum (vitest count).

### Quality criteria

- `npm run test` passes — 0 failures
- `npm run typecheck` passes
- New tests isolated from existing tests (no mock bleed)
- Each test cleans up fake timers if used (`vi.useRealTimers()` in afterEach or per-test)
