# ADR-023 — 0x's Settler is identified by 0x's registry at use time, never by a list of ours

- **Status:** Accepted — 2026-09-03
- **Implemented by:** `feat/zerox-settler-identity`
- **Follows:** [ADR-021](ADR-021-zerox-v2-allowance-holder.md), which established that the Settler
  rotates, and [ADR-022](ADR-022-r1-group-g-allowance-holder-recipient.md), which decoded `exec` and
  then explicitly deferred "the *fourth* decision" this ADR makes
- **Supersedes (partially):** ADR-022's use of the **router whitelist** to admit `exec`'s `target`
  and `operator`. ADR-022's `operator === target` narrowing is **KEPT** — see §The narrowing survives
- **Fund-flow:** yes. Unmerged until an Auditor pass returns 0C/0H

## Context

After ADR-021 and ADR-022, a 0x quote cleared SC-04, cleared the router whitelist on `tx.to`, and
was decoded correctly by R1 Group G — and then died on the last check, `target`:

| Gate | On a real 0x v2 quote | Verdict |
|:--|:--|:--|
| SC-04 selector allowlist | `0x2213bc0b` (`exec`) | pass — ADR-021 |
| Router whitelist on `tx.to` | AllowanceHolder `0x0000000000001fF3684f28c67538d4D072C22734` | pass — ADR-021 |
| R1 Group G nested decode | `AllowedSlippage.recipient` == taker | pass — ADR-022 |
| R1 Group G `target` | the Settler | **REJECT** |

The reason was structural, not a bug. `exec`'s `target` is 0x's `Settler`, and ADR-021 established
that the Settler **rotates with each 0x release**. ADR-022 checked `target` against the per-chain
router whitelist — a hand-kept list — so the check could only ever be satisfied by pinning an address
that breaks at the next rotation. ADR-022 chose to leave the gate closed and pinned two tests saying
so. **0x was executable on zero chains, by design.**

### Why a rotating address cannot be whitelisted

A whitelist entry is a claim that survives until someone edits it. A Settler address is true until
0x ships. The two have different lifetimes, and the failure is silent and asymmetric:

- **Stale-closed** (the address moved on): every 0x swap 400s until a human notices. That is the
  benign half, and it is what we had.
- **Stale-open** (the address is kept "just in case"): the list vouches for a contract 0x has
  retired. Nothing on-chain revokes our opinion of it.

Neither is a security property. A list that must be edited on someone else's release schedule is
the address-hygiene failure this repo derives its way out of everywhere else.

### Why the registry is the authority

0x publishes the answer on-chain, and tells integrators in as many words to read it:

> "Do not hardcode any `Settler` address in your integration. _**ALWAYS**_ query the
> deployer/registry for the address of the most recent `Settler` contract before building or signing
> a transaction, metatransaction, or order."
> — <https://github.com/0xProject/0x-settler/blob/master/README.md>

The deployer/registry is an ERC721-shaped contract at the **same address on every chain**,
`0x00000000000004533Fe15556B1E086BB1A72cEae`. It is the only address this ADR pins, because it is
the root the rest is derived from and there is nothing above it to derive it from — so it is
verified at use time instead (§Fail-closed, and §Verification for the per-chain `eth_getCode`).

The README even ships the reference check, which is precisely what this ADR implements:

```solidity
if (ZERO_EX_DEPLOYER.ownerOf(featureId) != allegedSettler
    && ZERO_EX_DEPLOYER.prev(featureId) != allegedSettler) {
    revert CounterfeitSettler(allegedSettler);
}
```

### The feature id, derived

`ownerOf` is keyed by a **feature id**, and the goal was explicit that it must not be assumed. Two
independent lines of evidence, both measured 2026-09-03, agree on **2**:

1. **0x's documentation.** The README: *"For taker-submitted flows, the feature number is probably 2
   … For gasless/metatransaction flows, the feature number is probably 3. For intents, … 4. For
   bridge settler, … 5."* Its own TypeScript example labels the ids
   `{2: "taker submitted", 3: "metatransaction", 4: "intents", 5: "bridge"}`.
   `src/lib/adapters/zerox.ts` calls `/swap/allowance-holder/quote` with `taker`, and ADR-021
   established there is **no signing anywhere on this repo's swap path** — so our flow is
   taker-submitted, and cannot be any of the other three.

2. **Live traffic.** Every successful `AllowanceHolder.exec` sampled on chains 1, 8453 and 42161
   targeted that chain's **feature-2** address. (Feature-5 bridge Settlers also see traffic on
   chains 1 and 42161; this repo never produces it, so features 3, 4 and 5 are **not** admitted —
   the narrower set is the safer one.)

### The dwell window is not hypothetical — `prev` is mandatory

0x lags its own deployments: the API keeps emitting calldata for the previous Settler while the new
one is end-to-end tested. The README calls this the *dwell* window and says to fall back to `prev`.

On **2026-09-03 every one of the three chains was inside that window.** Each golden vector below is
a real, successful, taker-submitted swap whose `target` is `prev(2)` — not `ownerOf(2)`:

| Chain | Block | `ownerOf(2)` | `prev(2)` | `exec` target |
|:--|--:|:--|:--|:--|
| 1 | 25897835 | `0x666FEdd4…5a64A` | `0x0889e932…02c9A` | **`prev(2)`** |
| 8453 | 50834728 | `0x4f6f9159…7C059` | `0x7747F8D2…F2359` | **`prev(2)`** |
| 42161 | 501399900 | `0xdBcd6d6E…2A679` | `0xfeEA2A79…9b02a` | **`prev(2)`** |

An `ownerOf`-only check would have rejected **100% of the real 0x traffic on all three chains** that
day. Accepting `prev` is not laxity; it is the difference between a working integration and a
theatrical one. A test pins exactly this (`ownerOf`-only rejects the mainnet golden vector).

## Decision

1. **`exec`'s `target` is accepted iff it equals `ownerOf(2)` or `prev(2)` for that chain**, both
   read from `0x00000000000004533Fe15556B1E086BB1A72cEae` at use time, compared lower-cased. The
   router whitelist no longer admits `target`; the registry does.
2. **`operator` is held to the same registry-derived set.** ADR-022 checked it against the router
   whitelist; the registry set (two addresses) is strictly narrower than that whitelist ever was.
3. **`operator === target` is KEPT** as an additional check with its own reason — see below.
4. **The resolved set is an input, not a side effect.** `calldata-recipient.ts` stays synchronous and
   pure; it takes `RecipientCheckOptions.zeroxSettlers`. The new async entry point
   `validateCallDataRecipientAsync` resolves the set and passes it in, and every execution path
   (`/api/swap`, `/api/v1/swap`, `useSwap`, `useSplitSwap`) now calls it. Calldata that cannot reach
   Group G issues **no RPC at all**.
5. **The router whitelist, SC-04 and `FEE_*` are untouched.** `tx.to` is still the AllowanceHolder,
   which is whitelisted and does **not** rotate. Nothing was widened; Group G was narrowed.

### The narrowing survives — the registry does not dominate it

The question the goal poses is whether check (1) strictly dominates ADR-022's `operator === target`.
It does not, and the counterexample is concrete: the admitted set has **two** members, so
`operator = ownerOf(2)` paired with `target = prev(2)` clears both (1) and (2) and is still a shape
0x has never emitted. Keeping the narrowing collapses the admitted pairs from four to two at zero
cost and zero risk. **It is kept, and pinned by its own test.**

### Fail-closed policy

Every failure mode rejects the swap. There is **no static fallback list** and **no borrowing another
chain's answer**:

| Condition | Result |
|:--|:--|
| `eth_getCode` on the registry throws | reject |
| registry has **no code** on this chain | reject, without even asking for an address |
| `ownerOf(2)` or `prev(2)` reverts (0x's "Settler is paused" signal) | reject |
| either returns `0x` / empty returndata | reject |
| either returns a malformed or non-20-byte word | reject |
| either returns the zero address | reject |
| the RPC client is bound to a different chain | reject |
| the caller supplies no resolved set at all | reject |

The last row matters most: Group G's default is rejection, so a caller that forgets to resolve
cannot fail open. The registry check runs **before** the nested recipient decode, because a recipient
buried inside a call to an attacker's contract means nothing.

One deliberate asymmetry: a failed lookup is fatal for calldata that **is** an `exec`, but a Group E
multicall wrapping something else is not collateral damage of an RPC blip. A multicall that wraps an
`exec` still fails closed, on the "no Settler resolved" branch, because no set is passed down. Both
directions are tested.

### Cache TTL: 30s

A successful resolution is reused per chain for **30 000 ms** — the same figure
`chains/sequencer-check.ts` already uses for the same shape of read. Bounded on both sides:

- **Staleness is safe in the only direction it can go.** A rotation moves an address *into* the set
  (the new `ownerOf`); the one leaving is the old `prev`, which 0x API has already stopped emitting.
  A stale window can therefore only *reject* a genuine swap, never *admit* a retired one — and it
  self-heals inside the window. 30s is four orders of magnitude below 0x's dwell window, which runs
  hours to days.
- **Freshness costs an RPC on the swap path.** 30s collapses a burst of swaps into one read.

**Failures are never cached**, so a transient RPC blip cannot pin 0x shut for a whole TTL window;
the next swap retries. Concurrent misses single-flight into one read.

## Consequences

**0x is executable end-to-end for the first time.** The gate ADR-022 deliberately left closed is
open, and the two tests that pinned "0x is NOT executable" have been rewritten to pin the opposite —
including the mainnet golden vector, which is now accepted **as captured**, with no retargeting.

**The admitted set shrank, it did not grow.** Before: any address in the per-chain router whitelist
(dozens, on mainnet). After: exactly the two addresses 0x's own registry vouches for right now. The
AllowanceHolder itself — a whitelisted router — is now correctly *rejected* as an `exec` target,
which it always should have been.

**The swap path gained a network dependency.** A 0x swap now needs one registry read per chain per
30s. If that read fails, 0x swaps fail closed while every other source is unaffected. This is a real
availability trade and it is the correct side of it: the alternative is trusting an address the API
handed us.

**Nothing needs editing when 0x ships a release.** That is the point. No list, no follow-up PR, no
stale-open window.

**Chains where 0x never deployed the registry fail closed automatically**, via `eth_getCode`, with
no per-chain configuration.

## Verification

- **`eth_getCode` on `0x00000000000004533Fe15556B1E086BB1A72cEae`, read 2026-09-03** — identical
  58-byte runtime on all three chains, at the golden vectors' own blocks:
  chain **1** @ 25897835 ✅, chain **8453** @ 50834728 ✅, chain **42161** @ 501399900 ✅.
  Same 58 bytes again at head on each chain.
- **Registry answers** for feature 2 pinned per chain at those blocks, in
  `src/lib/__fixtures__/zerox-allowance-holder-{mainnet,base,arbitrum}.ts`, beside the calldata.
- **Golden vectors — one per chain, all three obtainable.** Real `AllowanceHolder.exec` calldata from
  a successful transaction, the registry answer at the same block, and the block number:
  mainnet `0x962bc111…d1a0`, Base `0xbc9aac55…c6d4`, Arbitrum `0xcc54b93d…cbcd2`. Each validates for
  its own taker and is rejected for anyone else. No chain was left without one.
- **All registry reads in tests are MOCKED** — the suite issues no RPC.
- Fail-closed reasons asserted individually for: non-Settler `target`, non-Settler `operator`,
  `operator !== target` (with both addresses admitted), another chain's Settler, the AllowanceHolder
  as target, a whitelisted-but-not-Settler router, no resolved set, empty resolved set, registry
  throw, registry `0x`, registry zero address, registry with no code, and a chain-mismatched client.
- Full suite green; lint and `tsc --noEmit` at or below the standing ceiling — figures in
  `docs/feedback/feat-zerox-settler-identity.md`.
