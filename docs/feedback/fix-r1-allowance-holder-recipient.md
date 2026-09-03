# Feedback — R1 Group G (`fix/r1-allowance-holder-recipient`)

Branch is `origin/main` + a merge of the APPROVED `origin/fix/zerox-v2-execution-path` (0C/0H/1L),
which is the prerequisite: without `0x2213bc0b` in `KNOWN_SWAP_SELECTORS` this handler has no
reachable caller.

## Task 1 — the inner shape, derived before any decoder was written

All sources pinned at `0xProject/0x-settler@1df908742d38cf407f667df6518dae6e04a01ac3`
(master, 2026-08-27; resolved via the GitHub API, not assumed).

| # | File | What it establishes |
|---|---|---|
| 1 | [`src/allowanceholder/IAllowanceHolder.sol`](https://github.com/0xProject/0x-settler/blob/master/src/allowanceholder/IAllowanceHolder.sol) | `exec(address operator, address token, uint256 amount, address payable target, bytes calldata data)`; also documents that `msg.sender` is appended to `data` ERC-2771-style **at call time** |
| 2 | [`src/allowanceholder/AllowanceHolderBase.sol`](https://github.com/0xProject/0x-settler/blob/master/src/allowanceholder/AllowanceHolderBase.sol) | `_exec` `calldatacopy`s `data` verbatim then `mstore`s the 20-byte sender **after** it → the sender suffix is never in the calldata we inspect, so `data` decodes as an ordinary call |
| 3 | [`src/interfaces/ISettlerTakerSubmitted.sol`](https://github.com/0xProject/0x-settler/blob/master/src/interfaces/ISettlerTakerSubmitted.sol) | the two taker-submitted entry points: `execute(...)` and `executeWithPermit(...)` |
| 4 | [`src/interfaces/ISettlerBase.sol`](https://github.com/0xProject/0x-settler/blob/master/src/interfaces/ISettlerBase.sol) | `struct AllowedSlippage { address payable recipient; IERC20 buyToken; uint256 minAmountOut; }` → tuple `(address,address,uint256)`, **`recipient` is field 0** |
| 5 | [`src/interfaces/ISettlerMetaTxn.sol`](https://github.com/0xProject/0x-settler/blob/master/src/interfaces/ISettlerMetaTxn.sol) | `executeMetaTxn(...)` — a different flow, not reachable here |
| 6 | [`src/Settler.sol`](https://github.com/0xProject/0x-settler/blob/master/src/Settler.sol) | `executeWithPermit` reverts unless `_isForwarded()`, i.e. it is an allowance-holder-family entry point too — the reason it had to be considered and then explicitly excluded rather than ignored |

### Every selector computed, never typed

`viem toFunctionSelector`, run locally; the same call is re-run inside the test suite so a typo
cannot survive a green run.

| Signature | Computed | Proof |
|---|---|---|
| `exec(address,address,uint256,address,bytes)` | `0x2213bc0b` | equals the SC-04 entry the approved branch added, **and** equals the first 4 bytes of 4 real mainnet transactions |
| `execute((address,address,uint256),bytes[],bytes32)` | `0x1fff991f` | equals the inner selector of the 2 real 0x transactions below |
| `executeWithPermit((address,address,uint256),bytes[],bytes32,bytes)` | `0x06b8524c` | asserted **absent** from the inner allowlist |
| `executeMetaTxn((address,address,uint256),bytes[],bytes32,address,bytes)` | `0xfd3ad6d4` | asserted **absent** from the inner allowlist |
| `transferFrom(address,address,address,uint256)` (AllowanceHolder callback) | `0x15dacbea` | matches the ADR-021 constant comment — control for the method |

### On-chain confirmation (public RPC, read-only, `ethereum-rpc.publicnode.com`)

Scanned the last 40 mainnet blocks for `tx.to == AllowanceHolder`; 4 hits at blocks 25897835–36
(2026-09-03). All 4 carry the `exec` selector, and in all 4 `operator === target`.

- `0x962bc111…d1a0` → target `0x0889e9327b98D7d1BE3C301A4585ff3330502c9A` (23 619 bytes, the live
  Settler), inner `0x1fff991f`, `AllowedSlippage.recipient === tx.from` ✓
- `0x74c56e5a…b324` → same target, inner `0x1fff991f`, `recipient === tx.from` ✓
- `0xb1f7f4c1…0e58` and `0x1215d1ba…5230` → target `0xD7185c486dD88eb9F3573B878a1469485644091F`
  (6 340 bytes), inner selector **`0x3cdfaf67`** — a *third party's* contract, not 0x.

That last pair is the most important observation in this PR: **`exec` is a generic call primitive.**
The outer selector implies nothing about what gets called, so the recipient inside `data` is
meaningless until the counterparties are checked.

The first transaction is committed verbatim as
`src/lib/__fixtures__/zerox-allowance-holder-mainnet.ts` and drives three tests.

## Task 2 — where recipient and target are read from

`src/lib/calldata-recipient.ts`, `decodeAllowanceHolderExecRecipient`, in order, all fail-closed:

| Step | Read from | Rejection reason |
|---|---|---|
| `target` | `exec` arg 3 | `AllowanceHolder exec target … is not a whitelisted router on chain …` |
| `operator` | `exec` arg 0 | `AllowanceHolder exec operator … is not a whitelisted router on chain …` |
| inner selector present | first 4 bytes of `exec` arg 4 | `AllowanceHolder exec inner calldata is too short to contain a selector` |
| inner selector allowed | `ALLOWANCE_HOLDER_INNER_SELECTORS` | `AllowanceHolder exec inner selector … is not in the Settler allowlist` |
| recipient | `execute` arg 0, tuple field 0 (`AllowedSlippage.recipient`) | `Recipient … does not match expected …` — the shared `isValidRecipient`, `routeViaFeeCollector` + `chainId` threaded unchanged |
| any throw | — | existing `Decode error: …` handler |

Whitelist source is `isWhitelistedRouter(addr, chainId)` from `@/lib/chains/routers` — the same set
the `tx.to` gate uses. No new whitelist, no widening. Group G is a **leaf**: it never re-enters the
validator, so `depth` is neither spent nor raised.

### Beyond the letter of the task — flagged deliberately

The task asked to check `target`. **`operator` is also checked.** `operator` is the address
authorised to call `AllowanceHolder.transferFrom` against the taker's standing approval — it is the
address that can actually move funds, and validating `target` while leaving `operator` free would
check the wrong half. In all 4 observed calls they are equal. Strike it if the Auditor disagrees;
it is one `if`.

## Task 3 — the cross-gate invariant, restored

`calldata-recipient.test.ts` no longer asserts "differs by exactly `['0x2213bc0b']`". It asserts
equality in **both** directions plus `size` parity, so an SC-04 addition without a decode strategy
here fails a test rather than reaching a gate that will reject it in production.
`VALIDATED_SELECTORS` is 22 → 23, and the new entry is the *derived* `ALLOWANCE_HOLDER_EXEC_SELECTOR`
constant, not a typed literal.

## Acceptance results

1. **PASS** — real `exec` calldata built with viem `encodeFunctionData` from the cited ABI validates
   when `AllowedSlippage.recipient` is the user, and is REJECTED with `does not match expected` when
   it is the attacker. Both controls present, plus a `routeViaFeeCollector` pair. The golden mainnet
   vector, retargeted to a whitelisted router, validates for the real taker and is rejected for
   anyone else.
2. **PASS** — six distinct reasons asserted: non-whitelisted `target`, non-whitelisted `operator`,
   unknown inner selector, empty inner `bytes`, malformed inner `bytes` behind a valid inner
   selector (decode error), malformed outer args (decode error).
3. **PASS** — `VALIDATED_SELECTORS` ≡ `KNOWN_SWAP_SELECTORS`, both directions + size, and a separate
   test pins that the entry which closed the gap is the recomputed `exec` selector.
4. **PASS** — 3664 tests / 255 files green. `tsc --noEmit` clean. Lint 94 warnings / 0 errors, i.e.
   exactly the `--max-warnings 94` ceiling, unchanged by this branch.

**Is 0x executable end-to-end? No — on no chain.** Group G decodes 0x's real calldata correctly, but
`exec`'s `target` is the **Settler**, and ADR-021 established that the Settler rotates with each 0x
release and cannot be whitelisted. R1 now fails at the *target* check instead of the *selector*
check. That is the correct fail-closed outcome, not a regression — but it means this PR moves the
blocker rather than removing it, and nobody should read "R1 gap closed" as "0x works". Two tests pin
the still-blocked state. Reopening 0x needs a fourth decision (establishing Settler identity in a way
that survives rotation, e.g. resolving it from 0x's on-chain deployer registry at quote time and
passing it as a per-request trusted target) — a new trust assumption, and its own ADR.

## Concern

- **Out-of-scope-but-adjacent fix.** `calldata-decoder.ts` had an existing invariant test —
  `SELECTOR_INFO` must cover every `VALIDATED_SELECTORS` entry — which the new entry broke. Adding
  the label alone would have left the confirmation modal reporting `recipientType: 'implicit'` for a
  call whose destination is explicit, i.e. the modal would have told the user "this goes to you by
  design" about the exact class of calldata R1 exists to police. A display-only extractor was added
  so the modal shows the nested recipient. It gates nothing.
- **Group G admits `exec` on every chain, including chains where no `'0x'` router is whitelisted.**
  There it simply fails at the `target` check, so the behaviour is correct, but the selector is now
  globally validated rather than chain-scoped. Consistent with how every other group works.

## What the Auditor should attack first

The `target`/`operator` whitelist check — specifically, whether `getRouterWhitelist(1)`'s
`MAINNET_FULL` is the right set to admit as an `exec` counterparty: it contains pools and settlement
contracts (Balancer Vault V2, CoW Settlement, Permit2, the FeeCollector), and any of them being
callable as an `exec` target with an ephemeral allowance granted to it is a different question from
it being a safe `tx.to`.
