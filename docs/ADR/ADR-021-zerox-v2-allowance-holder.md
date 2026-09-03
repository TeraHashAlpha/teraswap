# ADR-021 — 0x executes through the AllowanceHolder, never the Settler

- **Status:** Accepted — 2026-09-03
- **Context finding:** production log, 2026-09-03 12:35–12:36 UTC — `[SC-04] Rejected unknown swap
  selector: 0x2213bc0b source: 0x` (×2) and `... 0x1fff991f source: 0x` (×1)
- **Implemented by:** `fix/zerox-v2-execution-path`
- **Supersedes (partially):** the per-chain endpoint split introduced by SPRINT-9E P3

## Context

PR #468 fixed 0x **quoting** on mainnet. 0x then quoted normally (ETH→USDC, 1 ETH = 2407.45 USDC
via PancakeSwap_V3) and every attempt to **execute** that quote was rejected at `/api/swap`.

SPRINT-9E migrated 0x to API **v2**, but only the quote path was actually moved to a v2-shaped
execution target. The two execution gates still described the v1 **Exchange Proxy**:

| Gate | Where | Held at decision time | What v2 actually produces |
|---|---|---|---|
| Selector allowlist (SC-04) | `src/lib/swap-selectors.ts` | `0xd9627aa4`, `0x415565b0` — Exchange Proxy v1 | `0x2213bc0b` |
| Mainnet router whitelist | `src/lib/api.ts` `ROUTER_WHITELIST` | `0xDef1C0…25EfF` — Exchange Proxy v1 | AllowanceHolder or a Settler |
| Approval spender | `src/lib/api.ts` `fetchApproveSpender` | `PERMIT2_ADDRESS` | depends on the endpoint family |

Chains 8453 and 42161 were already pointed at the v2 **allowance-holder** endpoint, whose
`transaction.to` is the AllowanceHolder — an address those chains already whitelist. **Mainnet was
the only chain still on the `permit2` endpoint family.**

### The two selectors, derived

Neither was taken as "known". Each was resolved to a canonical signature in 0x's published source
and then recomputed with viem `toFunctionSelector`, and the tests recompute both on every run
(`src/lib/swap-selectors.test.ts`). The same method reproduces the two long-standing v1 entries
exactly, which is the control for the method itself.

| Observed | Canonical signature | Exposed by | Endpoint family |
|---|---|---|---|
| `0x2213bc0b` | `exec(address,address,uint256,address,bytes)` | **AllowanceHolder** | `/swap/allowance-holder/*` |
| `0x1fff991f` | `execute((address,address,uint256),bytes[],bytes32)` | **Settler** | `/swap/permit2/*` |

- `exec` — `0xProject/0x-settler`,
  [`src/allowanceholder/AllowanceHolderBase.sol`](https://github.com/0xProject/0x-settler/blob/master/src/allowanceholder/AllowanceHolderBase.sol):
  `function exec(address operator, address token, uint256 amount, address payable target, bytes calldata data)`.
- `execute` — `0xProject/0x-settler`,
  [`src/Settler.sol`](https://github.com/0xProject/0x-settler/blob/master/src/Settler.sol):
  `function execute(AllowedSlippage memory slippage, bytes[] calldata actions, bytes32 zid)`, with
  [`src/interfaces/ISettlerBase.sol`](https://github.com/0xProject/0x-settler/blob/master/src/interfaces/ISettlerBase.sol):
  `struct AllowedSlippage { address payable recipient; IERC20 buyToken; uint256 minAmountOut; }`
  → ABI tuple `(address,address,uint256)`.

Cross-checked on-chain against mainnet `eth_getCode` for
`0x0000000000001fF3684f28c67538d4D072C22734` (1009 bytes): `2213bc0b` is present in its dispatch
table; `1fff991f` is not — it lives on the Settler, exactly as the table above says.

## Decision

**Mainnet moves to the `/swap/allowance-holder/*` endpoint family, matching 8453 and 42161. The
permit2 family is no longer used on any chain.**

`ROUTER_WHITELIST_BY_CHAIN[1]['0x']`, the mainnet `ROUTER_WHITELIST`, and the mainnet 0x approval
spender all become the AllowanceHolder. `KNOWN_SWAP_SELECTORS` gains exactly one entry, `0x2213bc0b`.

### Why not keep permit2

Three independent reasons; the first alone is decisive.

1. **The permit2 flow was never executable in this repo.** It requires the taker to sign the
   `permit2.eip712` payload 0x returns and the integrator to append that signature to the calldata.
   TeraSwap has no Permit2 signing on the swap path at all — `signTypedData` appears nowhere in
   `useSwap.ts` or `useSplitSwap.ts`. Opening both gates for permit2 would have produced a
   transaction that reverts on-chain instead of one that 400s at the API. The gates were not the
   only thing broken.

2. **A rotating Settler cannot be whitelisted — this is the question the goal asked and it has no
   answer.** 0x ships a new Settler with each release (V1.9, V1.10 … are observable as distinct
   on-chain counterparties of the AllowanceHolder). A whitelist entry pinned to today's Settler
   fails closed at the next rotation, producing a recurring production outage whose only remedy is
   an emergency deploy; not pinning it means accepting whatever address the 0x API returns, which
   deletes the control the whitelist exists to provide. There is no third option, and "we would
   notice and ship a fix each time" is an operational promise, not a security property.

3. **The AllowanceHolder is fixed and already trusted.** Same deterministic address on every chain
   0x deploys it to, already the whitelisted `'0x'` entry on 8453 and 42161, and verified deployed
   on mainnet. Adopting it makes all three chains use one address and one selector instead of two
   flows, and removes a per-chain branch rather than adding one.

The trade accepted: TeraSwap takes a dependency on a plain ERC-20 allowance to the AllowanceHolder
rather than a per-trade Permit2 signature. That is strictly the model chains 8453/42161 have run
since SPRINT-9E, and the AllowanceHolder's allowance is transient — it grants the Settler authority
only for the duration of the `exec` call — so the standing approval is to a contract that holds no
funds between calls.

## Consequences

**The Settler's `execute` selector `0x1fff991f` is NOT added to the allowlist.** It appears in the
production log, but only as evidence of the permit2 attempt we are removing. Under the chosen flow
it is *inner* calldata — the `data` argument of `exec` — never the first four bytes of
`transaction.data`. Adding it would widen a security gate for calldata no TeraSwap flow can emit,
against a contract address that is deliberately not whitelisted. A test pins that it stays rejected,
so the omission reads as a decision rather than an oversight.

**The swap registry and the order registry now diverge for `'0x'`, intentionally.**
`ROUTER_WHITELIST_BY_CHAIN[1]['0x']` is the v2 AllowanceHolder; `order-engine/config.ts`
`MAINNET_ROUTERS['0x']` remains the v1 Exchange Proxy, because that is the deployed
`TeraSwapOrderExecutor`'s **on-chain** whitelist and cannot be changed from this repo. Per ADR-020's
division of authority, `routers.ts` gates instant swaps and `config.ts` gates signed orders; this is
the first router where the correct answers differ. `src/lib/chains/routers.test.ts` now pins both
sides and asserts the inequality.

**The v1 Exchange Proxy entries are retained, not removed** (rule #4). No current flow emits
`0xd9627aa4` / `0x415565b0` — every chain's adapter is on v2 — but the v1 proxy is still whitelisted
on-chain by the deployed mainnet OrderExecutor, and `calldata-recipient.ts` still classifies both in
`MSG_SENDER_SELECTORS`. Both call sites carry a dated comment saying so.

**0x execution remains blocked by a third gate this ADR does not open.** `calldata-recipient.ts`
fails closed on any selector outside `VALIDATED_SELECTORS` (`[API-M-02]`), and `exec` is not in it,
so `/api/swap` now clears SC-04 and the router whitelist and still returns 400 at the R1 recipient
check — on mainnet **and** on Base/Arbitrum, which have been in this state unnoticed since
SPRINT-9E. That is deliberately out of scope here: `exec(operator, token, amount, target, data)`
carries no recipient of its own — the real destination is `AllowedSlippage.recipient` inside the
Settler call nested in `data` — so admitting it needs a nested-decode extractor and an Auditor
sign-off of its own, not a list entry. Classifying `exec` as `msg.sender`-implicit would be wrong
and would blind the gate that exists precisely to stop calldata delivering output elsewhere.
`src/lib/adapters/zerox.v2-execution-path.test.ts` pins the current blocking behaviour so the gap is
executable evidence rather than prose.

## Verification

- `eth_getCode(0x0000000000001fF3684f28c67538d4D072C22734)` on Ethereum mainnet via public RPC,
  2026-09-03 → **1009 bytes** (address string length 42). Non-empty, as Task 3 required before
  whitelisting.
- `toFunctionSelector` reproduces `0x2213bc0b`, `0x1fff991f`, and — as a control for the method —
  the two pre-existing v1 entries `0xd9627aa4` and `0x415565b0`.
- The mainnet router entry is pinned equal to the `transaction.to` the adapter's chosen endpoint
  returns, with the permit2 family modelled as returning a different (Settler) address, so a
  revert to permit2 fails the test.
