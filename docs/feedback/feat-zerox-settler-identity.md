## Feedback — feat/zerox-settler-identity

Implements [ADR-023](../ADR/ADR-023-zerox-settler-identity.md). Fund-flow; unmerged until an Auditor
pass returns 0C/0H.

### Derived feature id + evidence

**Feature id = 2** (taker-submitted). Not assumed — established twice, independently, 2026-09-03:

1. **0x's README / ABI.** *"For taker-submitted flows, the feature number is probably 2 … gasless/
   metatransaction … 3. For intents, … 4. For bridge settler, … 5."* Its own TypeScript example
   labels the ids `{2: "taker submitted", 3: "metatransaction", 4: "intents", 5: "bridge"}`.
   `src/lib/adapters/zerox.ts` calls `/swap/allowance-holder/quote` with `taker`, and ADR-021
   established there is **no signing anywhere on this repo's swap path**, so 3/4 are unreachable for
   us by construction.
2. **Live `exec` traffic.** Every successful `AllowanceHolder.exec` sampled on chains 1, 8453 and
   42161 targeted that chain's feature-2 address. Feature-5 (bridge) Settlers also carry traffic on
   chains 1 and 42161 — this repo never emits it, so 3/4/5 are deliberately **not** admitted.

The registry answers the sample matched, at each golden vector's own block:

| Chain | Block | `ownerOf(2)` | `prev(2)` | observed `exec` target |
|:--|--:|:--|:--|:--|
| 1 | 25897835 | `0x666FEdd4CdD4E890A5aD20E7B60975409435a64A` | `0x0889e9327b98D7d1BE3C301A4585ff3330502c9A` | `prev(2)` |
| 8453 | 50834728 | `0x4f6f91599858bf0d19fabCF2c5d591fE13f7C059` | `0x7747F8D2a76BD6345Cc29622a946A929647F2359` | `prev(2)` |
| 42161 | 501399900 | `0xdBcd6d6E3E6ff51648Ca73d4274CaFd34d22A679` | `0xfeEA2A79D7d3d36753C8917AF744D71f13C9b02a` | `prev(2)` |

**All three chains were inside 0x's dwell window that day.** An `ownerOf`-only check would have
rejected 100% of the real 0x traffic on every chain we support. That is why `prev` is accepted, and a
test pins it.

### `eth_getCode` per chain — `0x00000000000004533Fe15556B1E086BB1A72cEae`

Read at each golden vector's own block, and again at head:

| Chain | Block | Result |
|:--|--:|:--|
| 1 (Ethereum) | 25897835 | **58 bytes**, non-empty ✅ |
| 8453 (Base) | 50834728 | **58 bytes**, non-empty ✅ |
| 42161 (Arbitrum One) | 501399900 | **58 bytes**, non-empty ✅ |

Byte-identical runtime on all three:
`0x365f5f375f5f365f7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d5f5f3e6036573d5ffd5b3d5ff3`

The address sentinel (42 characters) is asserted at module load and in a test. A chain where the
registry has no code fails closed **without even asking it for an address** — asserted.

### Cache TTL + justification

**30 000 ms per chain, successes only.** Same figure `chains/sequencer-check.ts` already uses for the
same shape of read.

- Staleness is safe in the only direction it can go: a rotation moves an address *into* the set (the
  new `ownerOf`); the one leaving is the old `prev`, which 0x API has already stopped emitting. So a
  stale window can only **reject** a genuine swap, never **admit** a retired one — and it self-heals
  inside the window. 30s is four orders of magnitude below the dwell window, which runs hours to days.
- Freshness costs an RPC on the swap path; 30s collapses a burst of swaps into one read.
- **Failures are never cached** — a transient RPC blip cannot pin 0x shut for a whole window.
  Concurrent misses single-flight into one read. Both pinned by tests.

### Is #473's `operator === target` superseded? — **KEPT**

It is **not** dominated by the registry check, so it stays. Concrete counterexample: the admitted set
has **two** members, so `operator = ownerOf(2)` paired with `target = prev(2)` clears both registry
checks and is still a shape 0x has never emitted. Keeping the narrowing collapses the admitted pairs
from four to two at zero cost. It has its own test and its own reason string, unchanged.

What ADR-022 *did* lose is the **router whitelist** as the authority for `target`/`operator` — it
could never have admitted a rotating address, and the registry set (two addresses) is strictly
narrower than the whitelist (dozens on mainnet) ever was.

### New / changed rejection reasons

- `AllowanceHolder exec cannot be validated: no 0x Settler resolved from the registry for chain ${chainId}` — new; the fail-closed default when a caller supplies no resolved set.
- `AllowanceHolder exec cannot be validated: 0x Settler registry lookup failed on chain ${chainId} — ${message}` — new; the async entry point's lookup failure.
- `AllowanceHolder exec target ${target} is not the current or previous 0x Settler on chain ${chainId}` — replaces the whitelist wording.
- `AllowanceHolder exec operator ${operator} is not the current or previous 0x Settler on chain ${chainId}` — replaces the whitelist wording.
- `AllowanceHolder exec operator ${operator} does not match target ${target}` — **unchanged**, still fires.

### Acceptance results

1. **Registry MOCKED — current accepted, `prev` accepted, arbitrary rejected, `operator !== target` still fires.** ✅
   Plus: the AllowanceHolder itself rejected as a target, a whitelisted-but-not-Settler router
   rejected, another chain's Settler rejected, and `operator = ownerOf(2)` / `target = prev(2)`
   rejected on the narrowing.
2. **Registry throws / returns `0x` / returns zero ⇒ REJECTED, three cases.** ✅
   Plus: no code on the chain, `getCode` throws, non-string answer, short-hex answer, zero/revert
   from `prev` specifically, and a client bound to the wrong chain.
3. **One golden vector per chain — obtained for ALL THREE, none missing.** ✅
   Real `exec` calldata + registry answer + block, pinned together:
   mainnet `0x962bc111…d1a0` @ 25897835, Base `0xbc9aac55…c6d4` @ 50834728,
   Arbitrum `0xcc54b93d…cbcd2` @ 501399900. Mainnet's is now accepted **as captured** — no
   retargeting — and the retargeted-onto-an-attacker variant of the same bytes is rejected.
4. **Full suite green; lint and typecheck at the standing ceiling.** ✅
   `260 files / 3749 tests` passing. `eslint . --max-warnings 94` → **94 warnings / 0 errors**, exit
   0 (unchanged ceiling). `tsc --noEmit` clean.

### Is 0x executable end-to-end, and on which chains?

**Yes — on chains 1, 8453 and 42161**, the three chains this repo supports. Every gate now passes for
real 0x calldata: SC-04 (`0x2213bc0b`), the router whitelist on `tx.to` (the AllowanceHolder, which
does not rotate), R1 Group G's nested recipient decode, and — new — the registry identity check on
`target`/`operator`. The mainnet golden vector validates as captured; Base and Arbitrum validate
against their own pinned registry answers.

Two honest caveats, neither blocking:
- This is verified against **captured** calldata and registry answers, not a live end-to-end swap.
  No swap was broadcast and no key was touched.
- 0x swaps now carry a network dependency: one registry read per chain per 30s. If it fails, 0x
  fails closed while every other source is unaffected.

### What the Auditor should attack first

**The `RecipientCheckOptions.zeroxSettlers` seam** — prove there is no path that reaches Group G with
a *stale, wrong-chain, or attacker-influenced* set, or that bypasses `validateCallDataRecipientAsync`
and calls the sync entry point on an execution path (it fails closed by default, but the seam is
where a fail-open would hide).

### Environment note

The primary checkout at `/Users/tiagocruz/Desktop/Claude/dex-aggregator 2` is still gone — the
directory now contains only `.remember/`, no `.git`, no sources. This is the same breakage recorded
in `docs/feedback/chore-audit-followups-0x.md`; it has not been repaired. This branch was created as
a real `git worktree` off the fresh SSH clone at `~/teraswap-new` (`origin/main` @ `d72bde2`), living
at `~/ts-worktrees/feat-zerox-settler-identity`. `git worktree list` was run first, in both clones.
