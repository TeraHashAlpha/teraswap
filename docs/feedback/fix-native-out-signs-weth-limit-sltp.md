# Feedback — fix/native-out-signs-weth-limit-sltp

Follow-on to `fix/dca-native-out-signs-weth` (PR #488, merged as 81fc11c), whose author flagged
`LimitOrderPanel.tsx:423` and `ConditionalOrderPanel.tsx:331` as carrying the identical defect and
out of scope there.

---

## 1. The two flagged line numbers — CONFIRMED

Read on `origin/main` @ `81fc11c` **before** any edit:

```
LimitOrderPanel.tsx
  421      let config: CreateOrderConfig = {
  422        tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
  423        tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals },

ConditionalOrderPanel.tsx
  329      let config: CreateOrderConfig = {
  330        tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
  331        tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
```

Both are the `tokenOut:` field of the `CreateOrderConfig` literal, built from the raw selector pick.
The defect is real and identical because the second half of the mechanism is shared:
`useOrderEngine.createOrder` (`src/hooks/useOrderEngine.ts:695-697`) resolves the native sentinel for
**tokenIn only** —

```ts
const tokenInAddress = config.tokenIn.address.toLowerCase() === NATIVE_ETH.toLowerCase()
  ? getWrappedNative(chainId)
  : (config.tokenIn.address as `0x${string}`)
```

— and then assigns `config.tokenOut.address` verbatim into the struct's `tokenOut` (`:713`). So a Limit or Take-Profit order buying native ETH signed `0xEeee…EEeE` as
`order.tokenOut`, which reverts on `IERC20(order.tokenOut).balanceOf(address(this))`
(TeraSwapOrderExecutorV3.sol:567 pre-swap, :579 post-swap — both unconditional, both ahead of every
delivery branch) on every fill, and never reaches the `order.tokenOut == WETH` ETH-forwarding branch
(:593) that is what actually buys the user native-ETH delivery.

Reproduced as a failing test before the fix, not assumed — see §7.

---

## 2. The single resolution point per panel

| Panel | Raw pick (nothing reads it) | THE resolution point |
|---|---|---|
| `LimitOrderPanel.tsx` | `buySelection` state | the `tokenOut` `useMemo` — `resolveSignableToken(buySelection, chainId)` |
| `ConditionalOrderPanel.tsx` | `buySelection` state | the `tokenOut` `useMemo` — `resolveSignableToken(buySelection, chainId)` |

Same shape as `DCAPanel`: the `useState` keeps the raw pick under a name no consumer reads, the
selector's `onSelect` writes that state, and every downstream reader — the Receive selector's own
label, the Chainlink feed lookup, the min-output derivation, the `$1` economic floor, the signed
`CreateOrderConfig`, the order hash and the review modal — reads the memo.

`resolveSignableToken` is **called**, never re-implemented and never wrapped. Call sites:

```
src/components/LimitOrderPanel.tsx        import { resolveSignableToken } from '@/lib/chains/tokens'
                                          const tokenOut = useMemo(() => resolveSignableToken(buySelection, chainId), …)
src/components/ConditionalOrderPanel.tsx  import { resolveSignableToken } from '@/lib/chains/tokens'
                                          const tokenOut = useMemo(() => resolveSignableToken(buySelection, chainId), …)
```

Fails closed to `null` (never back to the sentinel). `handleSubmit` refuses on it **before**
`startWaitingSound()`, and the submit button is disabled on it, so the null state can neither sign
nor strand the panel.

---

## 3. Signing paths

Two exist, and the fork is in `useOrderEngine.createOrder`:

* `signV3 = config.maxSlippageBps !== undefined && orderExecutorV3 !== null` (`useOrderEngine.ts:707`)
  — panels set `maxSlippageBps` only inside their `if (v3Live)` block, so **v3** = Base (8453) with
  the launch gate open, **v2** = everywhere else, including mainnet (1).
* The struct, domain and EIP-712 types then differ (`:820-833`).

The resolution sits in the panel's render body, ahead of `handleSubmit` entirely, therefore ahead of
both the `if (v3Live)` route-pinning block and the `signV3` branch. Both paths are **exercised**:
each panel's tests run chain 8453 and chain 1 and additionally assert the EIP-712 **domain version**
handed to the wallet is `'3'` and `'2'` respectively, so the claim "before the fork" is tested rather
than asserted.

---

## 4. UI copy — before / after

Captured by rendering each panel with a native-ETH buy leg and printing the live DOM, once against
`origin/main` and once against this branch (same test, source stashed in between).

**LimitOrderPanel** (sell USDC, buy native ETH):

| Surface | Before | After |
|---|---|---|
| Receive selector label | `ETH` | `WETH` |
| Order-intent hint | `Buy ETH when price drops` | `Buy WETH when price drops` |
| Price-direction button | `1 ETH = ? USDC` | `1 WETH = ? USDC` |
| Review modal — pair | `USDC → ETH` | `USDC → WETH` |
| Review modal — min received | `0,049 ETH` | `0,049 WETH` |

**ConditionalOrderPanel** (sell LINK, buy native ETH):

| Surface | Before | After |
|---|---|---|
| Receive selector label | `ETH` | `WETH` |
| Review modal — pair | `LINK → ETH` | `LINK → WETH` |
| Review modal — min received | `235,2 ETH` | `235,2 WETH` |

The persisted row's `tokenOutSymbol` comes from the same `config.tokenOut.symbol`, so the orders
list agrees too. No surface shows `ETH` over a struct carrying `WETH`.

---

## 5. Task 5 — the same-token trap: REACHABLE. Reported, NOT fixed here

Measured with a throwaway probe driving `LimitOrderPanel` to the real EIP-712 payload (probe removed
before commit; a separate prompt owns defaults, so nothing here changes a default token or a guard).

**Route A — pre-existing on `origin/main`, not caused by this change.**
Sell leg is `DEFAULT_TOKENS[0]` = native ETH by default. The Receive selector disables only
`tokenIn.address` (the sentinel), so **WETH is selectable as the buy leg**. Picking it:

```
PROBE-A  tokenIn= 0xC02aaA39…756Cc2  tokenOut= 0xC02aaA39…756Cc2  SAME= true
```

`createOrder` rewrites the sentinel tokenIn to WETH, the buy leg already is WETH, and a WETH→WETH
order is signed. Re-run with this branch's panel changes **stashed** — i.e. against `origin/main`'s
own source — with the identical result, so the attribution is measured, not argued: this is
reachable today on `main` and needs no interaction with this fix.

**Route B — newly reachable because of this change.**
Buy native ETH (now resolved to WETH), then pick native ETH as the **sell** leg. The Sell selector's
`disabledAddress` is now the resolved `WETH`, so the sentinel is **not** disabled and the pick goes
through; `handleTokenInSelect`'s "same token" swap compares `ETH !== WETH` and does not fire:

```
PROBE-B  sell label= ETH   buy label= WETH        # the screen looks like a normal pair
PROBE-B  tokenIn= 0xC02aaA39…756Cc2  tokenOut= 0xC02aaA39…756Cc2  SAME= true
```

This is the more dangerous of the two: the two selectors read differently, so nothing on screen
suggests a same-token order.

**Neither route is refused on v3.** `buildCanonicalRoute` does reject a same-token pair
(`canonical-route.ts:167-169`), but the panel hands it the **raw** `tokenIn.address` — the sentinel —
against the resolved `WETH`, so the two look different to that guard and it never fires:

```
PROBE-C (chain 8453, v3)  signed= 1  submitError= undefined
                          tokenIn= 0x4200…0006  tokenOut= 0x4200…0006  SAME= true
```

Suggested owner: whoever owns the defaults prompt. The cheapest containment is probably to compare
**resolved** legs in the two `handleToken*Select` handlers and in `disabledAddress`, rather than to
change a default.

---

## 6. Concern — the v3 pinned route is built from the RAW tokenIn (separate defect, not fixed here)

Same family as the bug this branch fixes, on the **input** leg, and only on the v3 path:

```
LimitOrderPanel.tsx        buildCanonicalRoute({ tokenIn: tokenIn.address, … })   // raw sentinel
ConditionalOrderPanel.tsx  buildCanonicalRoute({ tokenIn: tokenIn.address, … })   // raw sentinel
useOrderEngine.ts:695-697  order.tokenIn = getWrappedNative(chainId)              // resolved WETH
useOrderEngine.ts:724      routerDataHash: config.routerDataHash                  // passed through
```

So for a native **sell** leg on v3 the committed `routerDataHash` is the hash of calldata that swaps
`0xEeee…EEeE`, while the signed struct's `tokenIn` is WETH. The executor would approve WETH and then
replay calldata for a different token. The default Limit/TP sell leg **is** native ETH, so this is
the default configuration on the v3 chain. Out of scope here (this branch owns the output leg); it
wants its own prompt, and the DCA fix's stated reason for resolving tokenIn inside `createOrder`
rather than in the panel is what makes the two disagree.

Note: the persisted row carries only `routerDataHash`, not `routerData` (row keys verified in the
probe), so this cannot be spotted from the Supabase row alone.

## 7. Edge case — the resolved WETH had no Chainlink feed key

Not covered by the prompt, and it would have silently turned this fix into a regression.

`LimitOrderPanel` picks the **buy** leg as the Chainlink feed token whenever the sell leg is a
stablecoin (`const feedToken = sellIsStable ? tokenOut : tokenIn`) — i.e. for every "buy ETH when it
drops" limit order, exactly the shape the panel's own "Buy below" badge exists for. The feed map has
`ETH/USD` and **no** `WETH/USD` (`order-engine/config.ts:355`), so once the buy leg resolves to WETH
the lookup returns `''` and the order is refused with *"No Chainlink price feed available for WETH"*.
The fix would have traded an unexecutable order for an uncreatable one.

Handled inside each panel's existing local `findPriceFeed`: try the token's own symbol, and when the
token **is** the chain's wrapped native, fall back to the chain's native symbol — `ETH/USD` and
`WETH/USD` are the same number off the same aggregator. This is a feed-key lookup, not a second
token normalisation. Two deliberate consequences:

* `ConditionalOrderPanel` got the same fallback although its feed token is the **sell** leg, because
  after this change `handleSwapTokens` / `handleTokenInSelect` move the **resolved** buy leg into the
  sell slot — so the resolved WETH does reach that panel's feed lookup.
* Selling WETH directly was refused in both panels before this change and now resolves to `ETH/USD`.
  That is correct pricing for WETH, but it is a behaviour change slightly wider than the native-out
  scope, called out here for the Auditor rather than buried.

`getChainConfig` throws on an unsupported chain, so the fallback is wrapped — a throw inside
`handleSubmit` lands after `startWaitingSound()` and would strand the panel.

## 8. Tests — failing before, passing after

New: `src/components/LimitOrderPanel.native-out-signs-weth.test.tsx`,
`src/components/ConditionalOrderPanel.native-out-signs-weth.test.tsx` (9 tests each). They drive each
panel to the real EIP-712 payload; expected addresses are read from `getWrappedNative(chainId)` at
assertion time — there is not one address literal in an assertion in either file.

Against `origin/main`'s panels (source stashed, tests kept):

```
 ❯ LimitOrderPanel.native-out-signs-weth.test.tsx       (9 tests | 6 failed)
 ❯ ConditionalOrderPanel.native-out-signs-weth.test.tsx (9 tests | 6 failed)
   Tests  12 failed | 6 passed (18)

 AssertionError: expected '0xeeeeeeee…' to be '0x42000000…'   (chain 8453)
 AssertionError: expected '0xeeeeeeee…' to be '0xc02aaa39…'   (chain 1)
 AssertionError: expected 'ETH' to be 'WETH'
 AssertionError: expected 'USDC → ETH' to be 'USDC → WETH'
 AssertionError: expected 'LINK → ETH' to be 'LINK → WETH'
```

The 6 that passed both before and after are the controls: the negative control (a non-native
`tokenOut` passes through untouched) and the v2/v3 fork-premise test, neither of which should move.

With this branch: **18 passed (18)**.

Full suite: **3839 passed / 268 files** (was 3821 / 266 on `main` — +18 tests, +2 files).
`tsc --noEmit` clean. `npm run lint` → **94 warnings, 0 errors**, unchanged from `main`'s ceiling.
The no-feed fail-closed guard is untouched and still refuses: `DCAPanel.nofeed-fail-closed`,
`DCAPanel.nofeed-consent`, `executor-feed-registry` and `DCAPanel.native-out-signs-weth` → 32 passed.
