# Feedback — `fix/zerox-v2-execution-path` (ADR-021)

## The two selectors — derived, never assumed

Both resolved to a canonical signature in 0x's published source, then recomputed with viem
`toFunctionSelector`. The tests recompute both on every run and put the derived value on the
*expected* side of the assertion, with the production log line as the *actual* side.

**Control for the method first:** the same derivation reproduces the two long-standing v1 entries
exactly — `sellToUniswap(address[],uint256,uint256,bool)` → `0xd9627aa4` and
`transformERC20(address,address,uint256,uint256,(uint32,bytes)[])` → `0x415565b0`. If the keccak or
the canonical-signature convention were wrong, those would not reproduce.

| Observed in prod | Canonical signature | Computed | Exposed by | Endpoint family |
|---|---|---|---|---|
| `0x2213bc0b` | `exec(address,address,uint256,address,bytes)` | `0x2213bc0b` ✓ | **AllowanceHolder** | `/swap/allowance-holder/*` |
| `0x1fff991f` | `execute((address,address,uint256),bytes[],bytes32)` | `0x1fff991f` ✓ | **Settler** | `/swap/permit2/*` |

- **`exec`** — `0xProject/0x-settler`,
  <https://github.com/0xProject/0x-settler/blob/master/src/allowanceholder/AllowanceHolderBase.sol>
  `function exec(address operator, address token, uint256 amount, address payable target, bytes calldata data)`
  (`address payable` encodes as `address`).
- **`execute`** — `0xProject/0x-settler`,
  <https://github.com/0xProject/0x-settler/blob/master/src/Settler.sol>
  `function execute(AllowedSlippage memory slippage, bytes[] calldata actions, bytes32 zid)`, with
  <https://github.com/0xProject/0x-settler/blob/master/src/interfaces/ISettlerBase.sol>
  `struct AllowedSlippage { address payable recipient; IERC20 buyToken; uint256 minAmountOut; }`
  → ABI tuple `(address,address,uint256)`.

**Independent on-chain cross-check** (mainnet `eth_getCode`, no API key used): the AllowanceHolder's
runtime code *contains* `2213bc0b` in its dispatch table and does *not* contain `1fff991f` — which is
exactly what the table above claims about which contract exposes which. It also contains `15dacbea`
= `transferFrom(address,address,address,uint256)`, which is how it pulls the taker's ERC-20 and is
therefore the proof that the approval spender must be the AllowanceHolder, not Permit2.

## Decision: allowance-holder, on every chain

Three reasons; the first alone settles it.

1. **The permit2 flow was never executable here.** It requires the taker to sign the returned
   `permit2.eip712` payload and the integrator to append that signature to the calldata.
   `signTypedData` appears nowhere in `useSwap.ts` / `useSplitSwap.ts` — there is no Permit2 signing
   on the swap path at all. Opening both gates for permit2 would have converted a 400 into an
   on-chain revert. The gates were not the only thing broken.
2. **The rotation question has no answer — which is the argument.** 0x ships a new Settler with each
   release (V1.9, V1.10 … are observable as distinct on-chain counterparties of the AllowanceHolder).
   Pin today's Settler and the whitelist fails closed at the next rotation — a recurring outage whose
   only remedy is an emergency deploy. Don't pin it and you accept whatever address the 0x API
   returns, which deletes the control the whitelist exists to provide. "We'd notice and ship a fix
   each time" is an operational promise, not a security property.
3. **The AllowanceHolder is fixed and already trusted** on 8453/42161. Adopting it *removes* a
   per-chain branch instead of adding one.

Trade accepted: a standing ERC-20 allowance to the AllowanceHolder instead of a per-trade signature.
That is exactly the model 8453/42161 have run since SPRINT-9E, and the allowance the AllowanceHolder
grants onward to the Settler is transient (scoped to the `exec` call), so the standing approval is to
a contract that holds no funds between calls.

## `eth_getCode` (Task 3 precondition)

```
address        0x0000000000001fF3684f28c67538d4D072C22734   (string length 42 ✓)
eth_getCode    1009 bytes of runtime code                   (non-empty ✓)
RPC            https://ethereum-rpc.publicnode.com  (public, read-only, 2026-09-03)
```

## Acceptance results

1. **PASS (with one deliberate deviation — read this).** `isKnownSwapSelector` accepts `0x2213bc0b`,
   proven by a keccak computed in the test. It does **not** accept `0x1fff991f`, and a test pins that
   rejection. The criterion as written ("accepts *each* observed selector") conflicts with Task 3
   ("add only the selector(s) the chosen flow actually emits, no more"), and Task 3 wins: once
   mainnet is on allowance-holder, nothing we build can emit `execute` as an outer selector — it is
   the `data` *argument* of `exec` — and the Settler address is deliberately not whitelisted.
   Whitelisting it would widen a security gate for calldata no TeraSwap flow produces. `0x1fff991f`
   is still derived and proven in the test, as a documented negative.
2. **PASS.** `0xdeadbeef` still rejected; `KNOWN_SWAP_SELECTORS.size` 22 → **23**, i.e. grew by
   exactly the one selector named above.
3. **PASS.** `ROUTER_WHITELIST_BY_CHAIN[1]['0x']` is asserted equal to the `transaction.to` the
   adapter's chosen endpoint returns. The mock models *both* families — permit2 returns a (rotating)
   Settler stand-in, allowance-holder returns the AllowanceHolder — so reverting the endpoint breaks
   the test, as required.
4. **PASS.** Full suite **3642/3642 in 255 files**; `tsc --noEmit` clean; `eslint --max-warnings 94`
   exits 0 at **94** warnings — the existing ceiling, none added (no warning in any file this branch
   touches).

## ⚠️ Blocking gap this PR does NOT close — 0x still cannot execute

There is a **third** gate, and it still rejects `exec`. `calldata-recipient.ts` fails closed on any
selector outside `VALIDATED_SELECTORS` (`[API-M-02]`), so `/api/swap` now clears SC-04 *and* the
router whitelist and then returns 400 at the R1 recipient check.

This also means **0x execution has been broken on Base and Arbitrum too, unnoticed since SPRINT-9E** —
`KNOWN_SWAP_SELECTORS` is chain-agnostic, so `exec` was rejected on every chain, not just mainnet.
That is very likely why `0x2213bc0b` appears **twice** in the production log alongside a single
`0x1fff991f`; I could not attribute the individual log lines to chains without an API key, and I am
not going to guess.

I left R1 untouched because the goal explicitly forbids touching the recipient gate — and because
doing it right is a design decision, not a list entry: `exec(operator, token, amount, target, data)`
carries **no recipient of its own**. The real destination is `AllowedSlippage.recipient` inside the
Settler call nested in `data`. Classifying `exec` as `msg.sender`-implicit (Group A/F) would be wrong
and would blind the gate that exists precisely to stop calldata delivering output elsewhere. It needs
a nested-decode extractor and its own sign-off.

Consequence the Auditor must rule on: `calldata-recipient.test.ts` had an explicit invariant that
`VALIDATED_SELECTORS` and `KNOWN_SWAP_SELECTORS` are the **same set**. That invariant is now broken by
one element. I did not delete the test — I tightened it to assert an *exact, named, size-1*
difference, so any second divergence in either direction fails. Net security posture is unchanged
(the swap is still blocked, just one layer later), but the invariant is genuinely no longer true.

## Other things found on the way

### Scope — changes beyond "widen both gates", and why
- **`fetchApproveSpender('0x', 1)` changed from Permit2 → AllowanceHolder.** Not requested, but
  required by the chosen target: the allowance-holder flow pulls via `AllowanceHolder.transferFrom`
  (`0x15dacbea`, present in its runtime code). Leaving it on Permit2 would have users approving one
  contract while executing against another. Mirrors 8453/42161 exactly. **Please review as a
  fund-flow change.**
- **`ROUTER_WHITELIST` (api.ts) and `MAINNET_FULL` (routers.ts) both gained the AllowanceHolder.**
  Changing `ROUTER_WHITELIST_BY_CHAIN[1]['0x']` alone would have changed *nothing functionally* —
  mainnet validation reads `ROUTER_WHITELIST`, and `getRouterWhitelist(1)` short-circuits to
  `MAINNET_FULL`. Worth knowing: the mainnet `'0x'` entry in `ROUTER_WHITELIST_BY_CHAIN` is
  documentation, not a gate.
- **No new hardcoded address literals**: added `ZEROX_ALLOWANCE_HOLDER` to `constants.ts`. The
  8453/42161 literals are left untouched (goal said not to touch other chains' entries); a test pins
  the constant against both so they cannot drift.

### Swap registry and order registry now diverge for `'0x'`
`routers.test.ts` asserted `WHITELISTED_ROUTERS['0x'] === ROUTER_WHITELIST_BY_CHAIN[1]['0x']`. That
can no longer hold: the order side is the **deployed OrderExecutor's on-chain whitelist**, which still
holds the v1 Exchange Proxy and cannot be changed from this repo. Per ADR-020's division of authority
this is legitimate, and it is the first router where the two correct answers differ. The test now pins
both sides *and* the inequality.

### v1 selectors — the dated comment Task 3 asked for
No flow in this repo emits `0xd9627aa4` / `0x415565b0` any more (every chain's adapter is on v2).
Retained per rule #4 for two concrete reasons, both stated at the call sites: the v1 Exchange Proxy is
still whitelisted **on-chain** by the deployed mainnet OrderExecutor, and `calldata-recipient.ts`
still classifies both in `MSG_SENDER_SELECTORS`.

### Test gap noticed
`routers.test.ts` used the AllowanceHolder as its "Base-only address" example for per-chain
isolation. That example is now wrong by construction, so I swapped it for Base's Odos Router V2
(genuinely Base-only). Worth a sweep for other tests that assert isolation using an address that is
deterministic across chains — that class of assertion silently stops testing anything.

## What the Auditor should attack first

**The `fetchApproveSpender('0x', 1)` Permit2 → AllowanceHolder switch** — it is the only change here
that alters what a user is asked to sign, and it is the one change the goal did not ask for.
