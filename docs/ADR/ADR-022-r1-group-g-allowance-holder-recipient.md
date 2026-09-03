# ADR-022 — R1 Group G: unwrapping the recipient from `AllowanceHolder.exec`

- **Status:** Accepted — 2026-09-03
- **Implemented by:** `fix/r1-allowance-holder-recipient`
- **Follows:** [ADR-021](ADR-021-zerox-v2-allowance-holder.md), which opened SC-04 and the router
  whitelist for `0x2213bc0b` and explicitly deferred this gate
- **Followed by:** [ADR-023](ADR-023-zerox-settler-identity.md) — makes the "*fourth* decision" this
  ADR defers below, and **partially supersedes** it: `exec`'s `target` and `operator` are now checked
  against 0x's on-chain deployer/registry instead of the router whitelist. The `operator === target`
  narrowing is KEPT (added 2026-09-03; nothing else in this ADR changed)
- **Fund-flow:** yes. Unmerged until an Auditor pass returns 0C/0H.

## Context

ADR-021 moved every chain's 0x adapter onto the `/swap/allowance-holder/*` endpoint family and
recorded that a **third** gate still blocked execution: `calldata-recipient.ts` (`R1`) fails closed
on any selector outside `VALIDATED_SELECTORS` (`[API-M-02]`), and `exec` was not in it. 0x has been
quoting and winning while being unexecutable — on mainnet since ADR-021, and on Base/Arbitrum
unnoticed since SPRINT-9E.

`exec` could not simply be added to the list, because it fits none of the existing decode classes:

| Class | Why not |
|---|---|
| Group A — `msg.sender` implicit | False. `exec` has an explicit destination; calling it implicit would blind the gate exactly where it matters. |
| Group F — trusted router | False. `exec`'s counterparty is an argument, not a fixed trusted router. |
| Group E — `bytes[]` recursion | Wrong shape. One `bytes`, not an array, and the inner call is not itself a whitelisted swap. |

## The inner shape, derived

Pinned at `0xProject/0x-settler@1df908742d38cf407f667df6518dae6e04a01ac3` (master, 2026-08-27).
No selector below was typed: each is recomputed with viem `toFunctionSelector` from the canonical
signature, in source and again in the tests.

| Signature | Selector | Source |
|---|---|---|
| `exec(address,address,uint256,address,bytes)` | `0x2213bc0b` | [`src/allowanceholder/IAllowanceHolder.sol`](https://github.com/0xProject/0x-settler/blob/master/src/allowanceholder/IAllowanceHolder.sol) |
| `execute((address,address,uint256),bytes[],bytes32)` | `0x1fff991f` | [`src/interfaces/ISettlerTakerSubmitted.sol`](https://github.com/0xProject/0x-settler/blob/master/src/interfaces/ISettlerTakerSubmitted.sol) |
| `executeWithPermit((address,address,uint256),bytes[],bytes32,bytes)` | `0x06b8524c` | same file — **not** admitted |
| `executeMetaTxn((address,address,uint256),bytes[],bytes32,address,bytes)` | `0xfd3ad6d4` | [`src/interfaces/ISettlerMetaTxn.sol`](https://github.com/0xProject/0x-settler/blob/master/src/interfaces/ISettlerMetaTxn.sol) — **not** admitted |

`struct AllowedSlippage { address payable recipient; IERC20 buyToken; uint256 minAmountOut; }`
([`src/interfaces/ISettlerBase.sol`](https://github.com/0xProject/0x-settler/blob/master/src/interfaces/ISettlerBase.sol))
→ ABI tuple `(address,address,uint256)`. **`recipient` is field 0** — the swap's destination, and the
only thing R1 needs from the inner call.

The inner `data` is a plain ABI-encoded call: `AllowanceHolderBase._exec` copies it verbatim and
appends 20 bytes of ERC-2771-style sender *at call time*
([`src/allowanceholder/AllowanceHolderBase.sol`](https://github.com/0xProject/0x-settler/blob/master/src/allowanceholder/AllowanceHolderBase.sol)),
so the suffix is never part of the calldata R1 inspects. Decoding `data` as an ordinary call is
correct.

### Confirmed against real mainnet bytes

Four `AllowanceHolder` transactions read from Ethereum mainnet over a public RPC on 2026-09-03
(blocks 25897835–25897836). Two are 0x Settler flows; **two are a third party's** contract
(`0xD7185c…091F`, inner selector `0x3cdfaf67`), which is the finding that matters most: `exec` is a
generic primitive, and the identity of what it calls is not implied by the outer selector.

`0x962bc111baf4f44bf463a0b64fd06354f4904b75860e8e60ba8463e94b05d1a0` is committed verbatim as
`src/lib/__fixtures__/zerox-allowance-holder-mainnet.ts`. In it: `operator === target ===`
the live Settler, inner selector `0x1fff991f`, and `AllowedSlippage.recipient === tx.from`.

## Decision

**Group G — validated by unwrapping.** `exec` is admitted to `VALIDATED_SELECTORS` behind a handler
that decodes the five arguments, unwraps `data`, and validates the nested recipient with the *same*
`isValidRecipient` every other group uses, `routeViaFeeCollector` and `chainId` threaded unchanged.
Every step fails closed, and any throw is caught by the existing decode-error handler.

Two checks precede the recipient, because a recipient buried in `data` is meaningless until the
counterparties are known:

1. **`target`** — the contract `AllowanceHolder` will call. Must be a whitelisted router for the
   chain. An `exec` against an arbitrary target is a fund-transfer primitive, not a swap.
2. **`operator`** — the address authorised to pull the taker's tokens back out via
   `AllowanceHolder.transferFrom`. Must also be whitelisted. This goes **beyond** the letter of the
   task and is flagged for the Auditor: `operator` is the address that can actually move funds, and
   leaving it unchecked while checking `target` would validate the wrong half. In all four observed
   mainnet calls `operator === target`.

Group G is a **leaf**: it never re-enters the validator, so it neither spends nor raises the `depth`
budget Group E's single level of recursion owns.

Only `execute` is admitted as an inner selector. `executeWithPermit` is also only reachable through
the AllowanceHolder (`_isForwarded()`), but requires a taker-signed permit this repo never produces —
ADR-021 established there is no signing on the swap path at all — so no TeraSwap flow can emit it.

## Consequences

**The R1 ≡ SC-04 invariant is restored.** ADR-021 relaxed
`calldata-recipient.test.ts` to "differs by exactly `['0x2213bc0b']`"; it is back to equality in both
directions. A future SC-04 addition without a decode strategy here now fails a test instead of
silently reaching a gate that will reject it in production.

**0x is still NOT executable end-to-end.** Group G decodes 0x's real calldata correctly — the golden
vector proves it — but `exec`'s `target` is the **Settler**, and ADR-021 established that the Settler
rotates with every 0x release and therefore cannot be whitelisted. R1 now fails at the *target* check
instead of the *selector* check. This is a deliberate, documented outcome, not an oversight: leaving
the gate closed is the correct answer while the only alternatives are pinning an address that breaks
at the next rotation, or accepting whatever address the 0x API returns, which deletes the control.
Two tests pin it so it cannot be misreported as fixed.

Reopening 0x execution therefore needs a *fourth* decision, out of scope here: some way to establish
Settler identity that survives rotation — e.g. resolving the currently-deployed Settler from 0x's
on-chain deployer registry at quote time and passing it in as a per-request trusted target. That is a
new trust assumption and belongs in its own ADR.

> **Update, 2026-09-03 — [ADR-023](ADR-023-zerox-settler-identity.md) makes exactly that decision**,
> and the two tests pinning "0x is NOT executable" now pin the opposite. The whitelist check on
> `target`/`operator` described above is superseded by `ownerOf(2) || prev(2)` read from 0x's
> registry; the `operator === target` narrowing below is kept, because the two-address registry set
> does not subsume it.

**The confirmation modal shows the nested recipient.** `calldata-decoder.ts` gained the matching
display extractor; without it "clear signing" would have shown `implicit` (i.e. "goes to you by
design") for a call whose destination is written explicitly in the calldata. Display only — it grants
nothing.

## Verification

- Full suite: 3664 tests / 255 files passing. Lint 94 warnings / 0 errors (at the `--max-warnings 94`
  ceiling, unchanged). `tsc --noEmit` clean.
- Selectors recomputed in tests; `executeWithPermit` / `executeMetaTxn` asserted absent.
- Distinct fail-closed reasons asserted for: non-whitelisted `target`, non-whitelisted `operator`,
  unknown inner selector, empty inner `bytes`, malformed inner `bytes`, malformed outer args.
- Golden vector: real mainnet `exec` calldata decodes to the taker; retargeted to a whitelisted
  router it validates for the taker and is rejected for anyone else; as captured it is rejected on
  `target`.
