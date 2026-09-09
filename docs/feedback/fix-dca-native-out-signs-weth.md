# Feedback — fix/dca-native-out-signs-weth

## On-chain evidence, re-derived (not taken from the prompt)

Every address and line number below was re-derived on 2026-09-09 against public RPCs
(`https://mainnet.base.org`, `https://ethereum-rpc.publicnode.com`) and the contract source in
this repo. The prompt's claims held, with one correction to the line number.

1. **The native sentinel has no code — on both chains.**
   ```
   eth_getCode(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE) → "0x"   # Base (8453)
   eth_getCode(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE) → "0x"   # Ethereum mainnet (1)
   ```
   `cast call 0xEeee… "balanceOf(address)"` refuses outright: *"contract … does not have any code"*.

2. **`IERC20(sentinel).balanceOf` really does revert — proved, not assumed.** A throwaway Foundry
   harness (scratchpad, not committed) reproducing the exact expression at
   `TeraSwapOrderExecutorV3.sol:567` reverts with **empty revert data** against a codeless address
   (Solidity's `extcodesize` guard), while the identical call against a real ERC-20 returns:
   ```
   [PASS] test_balanceOfOnCodelessSentinel_reverts()
   [PASS] test_balanceOfOnRealToken_succeeds()
   ```

3. **Line-number correction.** The prompt said "around sol:579". The *first* unconditional read is
   **`TeraSwapOrderExecutorV3.sol:567`** — `uint256 tokenOutBefore = IERC20(order.tokenOut).balanceOf(address(this));`
   — taken **before** the swap; `:579` is the post-swap re-read. Either reverts, but the fill dies at
   **567**, before the router is ever called. `_fairValueOut` at `:540` runs first and does **not**
   revert: `_readFeedUsd` returns early (`registered == false`) with no external call, so `hasFeed`
   is simply false. The revert is at 567, every time.

4. **The sentinel is not in the executor's fair-value registry; the wrapped native is.** Against the
   live Base V3 `0x686b4f812291F4De238E59ED00BA6dD6129e60a0` (docs/DEPLOYMENTS.md):
   ```
   tokenUsdFeeds(0xEeee…EEeE)                         → (0x0000…0000, 0, 0, 0, false)
   tokenUsdFeeds(0x4200000000000000000000000000000000000006) → (0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70, 8, 18, 3600, true)
   ```

5. **The unwrap branch is keyed on the WRAPPED address, never the sentinel.**
   `V3:593  else if (order.tokenOut == WETH && ethReceived >= floorOut)` and
   `cast call 0x686b…60a0 "WETH()(address)" → 0x4200…0006`.
   Signing the wrapped address is therefore what *buys* the user native-ETH delivery. Signing the
   sentinel forfeits that branch **and** reverts at 567 first. So "the contract unwraps, native ETH
   is a valid OUTPUT" — the comment that used to sit in `useOrderEngine.createOrder` — was false in
   both halves. That comment is corrected in this branch.

**Conclusion:** a DCA buying native ETH has never been executable. Confirmed.

## The single resolution point

**`src/lib/chains/tokens.ts::resolveSignableToken(token, chainId)`**, applied exactly once, at
**`DCAPanel.tsx`'s `tokenOut` memo** (`CreateDCAForm`).

The raw user pick now lives in a separate state variable, `buySelection`, which **nothing** reads.
Every existing consumer of `tokenOut` — the buy selector's own label, the oracle-less note, the
executor feed-coverage gate's `buy` leg, the v3 min-output derivation, the economic-floor check, the
signed-floor preview, the `CreateOrderConfig` handed to `createOrder` (and therefore the signed
struct, the order hash, and the review modal) — reads the resolved value. They cannot disagree,
because there is only one value.

Deliberately **not** done, per the brief:
- not normalised for display only (the struct reads the same value);
- not normalised inside `useOrderEngine.createOrder` (the panel's state would then still say ETH).
  The stale comment there is corrected in place and now explains why the resolution is upstream.

`resolveSignableToken` fails **closed**: `null` when a chain's catalog has no wrapped-native entry,
which callers already treat as "no token selected". It never falls back to the sentinel.

## UI copy — before / after (captured from the rendered DOM, both runs)

| Surface | Before | After |
|---|---|---|
| Buy selector label (`token-selector-out`) | `ETH` | `WETH` |
| Review modal pair (`order-pair`) | `USDC → ETH` | `USDC → WETH` |
| Review modal min received (`order-minout`) | `<0.0001 ETH` | `<0.0001 WETH` |

Captured on the v2 path (chain 1), where the modal mounts under both behaviours. On Base (v3) the
modal never mounted *before* the fix at all — the no-feed gate refused the sentinel first (below).

## Task 4 — existing rows: NOT QUERIED, and I did not seek credentials

**I cannot run this query, and I stopped rather than trying.** Every read path to the `orders` table
requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (`src/lib/supabase.ts:38-39`) or
`NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (`src/lib/order-engine/supabase.ts:19-20`).
All four live in `.env*`, which this task forbids reading, and the query would touch a production
server, which it also forbids. No row counts are reported here — none were obtained.

The read-only query for whoever does have access (`contracts/order-engine/schema.sql`: `token_out`,
`chain_id`, `status`, `order_type` all exist):

```sql
SELECT chain_id, status, order_type, count(*)
FROM orders
WHERE lower(token_out) = lower('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')
GROUP BY chain_id, status, order_type
ORDER BY chain_id, status;
```

Nothing in this branch reads, writes, or migrates that table.

## Tests — failing before, passing after

New file: `src/components/DCAPanel.native-out-signs-weth.test.tsx`. Written first; the RED run below
is against the production code with `resolveSignableToken` reduced to the identity function.

**Before — 6 failed | 1 passed**
```
× chain 8453: order.tokenOut === getWrappedNative(8453), never the sentinel
  → expected "vi.fn()" to be called 1 times, but got 0 times
× chain 8453: the persisted row's tokenOut is the SAME address that was signed
  → expected "vi.fn()" to be called 1 times, but got 0 times
× chain 1: order.tokenOut === getWrappedNative(1), never the sentinel
  → expected '0xeeeeeeee…' to be '0xc02aaa39…'
× chain 1: the persisted row's tokenOut is the SAME address that was signed
  → expected '0xeeeeeeee…' to be '0xc02aaa39…'
✓ NEGATIVE CONTROL — a non-native tokenOut is passed through completely untouched
× the BUY selector reads WETH (not ETH) once native output is chosen
  → expected 'ETH' to be 'WETH'
× the review modal names the pair the user is about to SIGN — USDC → WETH
  → expected 'USDC → ETH' to be 'USDC → WETH'
```

**After — 7 passed.** Full suite **3821 passed / 266 files**, `tsc --noEmit` clean, lint **94
warnings / 0 errors** — exactly today's `--max-warnings 94` ceiling, unchanged.

Notes on the shape of the tests:
- Two chain ids exercise **different signing paths on purpose**: 8453 is v3 (oracle floor, feed gate
  armed) and 1 is v2 (`minAmountOut = '1'`, gate inert). Passing on both proves the resolution sits
  *before* the v2/v3 fork, not inside a branch. `ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS` is `[8453]`, so
  the mainnet leg is the real v2 path, not a fiction.
- Every expected address is read from `getWrappedNative(chainId)` at assertion time. There is not one
  address literal in an assertion in the file.
- The two RED failures on 8453 are "no signature at all" because, pre-fix, the executor feed gate
  already refused the sentinel (see below) — an honest and expected failure mode, not a broken test.
- An extra assertion pins something adjacent that was easy to get wrong: `createOrderInSupabase` is
  called with `config.tokenOut.address` (not `order.tokenOut`), so the persisted row and the signed
  struct must carry the same address. They now do; the test fails if a future change resolves in one
  place and not the other.

## Two pinning tests from `fix/dca-no-feed-fail-closed` were rewritten — please review these closely

`fix/dca-no-feed-fail-closed` (merged in #484) deliberately pinned the old behaviour, in two files:

> `it('the DEFAULT output (native ETH) is refused too — the sentinel is what gets SIGNED')`
> *"Pinning it here so a future 'normalise the sentinel to WETH' convenience cannot quietly re-open
> the hole by answering a question the contract never asks."*

That premise is now false, and I did not delete either test — both are rewritten in place with the
reason recorded:

- The hole that pin guarded is a gate normalised **independently of the struct** — asking about WETH
  while still signing the sentinel. This branch does the opposite: the **struct** changed, so the
  sentinel never reaches `order.tokenOut` and asking about the wrapped native is precisely the
  question the contract asks. That is the address fidelity `executor-feed-registry.ts`'s own docblock
  demands ("the addresses as SIGNED … after any native→wrapped resolution the signing path performs").
- `DCAPanel.nofeed-fail-closed.test.tsx` now pins the **invariant** instead of one address: whatever
  the gate asks about must be exactly what appears in the signed message. That is strictly stronger
  than the original pin — it fails on drift in either direction.
- `DCAPanel.nofeed-consent.test.tsx` now records that the default output is no longer refused,
  because it resolves to a registered token.
- **The guard itself is untouched.** `src/lib/order-engine/executor-feed-registry.ts` has zero
  changes, and its fail-closed cases (ETHFI unregistered; registry unreadable) still pass unmodified —
  acceptance criterion 4.

Side effect worth naming: on Base today the no-feed gate is what stops a native-output DCA
("Recurring buys are unavailable for ETH (the token you're buying)…"). It was refusing the right
order for the wrong reason — the *token* is priceable, the *address* was not. After this fix the
feature works instead of being blocked.

## Edge case — the default DCA pair now names one token on both sides (MERGE-GATING)

**This is the one thing I could not close inside this branch, and it should gate the merge.**

`CHORE-DCA-WETH-INPUT` pinned the DCA **spend** leg to the chain's wrapped native. The **buy** leg
defaults to native ETH. Once a native buy leg resolves to the wrapped native, the shipped default
pair is **WETH → WETH** — a self-swap. It is signable: both legs are feed-registered, the economic
floor passes, and it only fails later, at keeper routing, after the user has spent an approval
transaction and a signature.

Today that pair is *refused* on Base (the gate blocks the sentinel). So this is a real behaviour
change on the default path and I am not going to pretend otherwise.

I measured all four ways to close it, and every one requires perturbing test infrastructure well
outside this fix:

| Option | Suite cost | Why it was not taken |
|---|---|---|
| Same-token guard (`canCreate` + hard guard + inline note) | **20 tests, 8 files** | 4 files' `TokenSelector` mocks ignore `onSelect` entirely, so each needs a new picker. Worse: substituting any buy token in `DCAPanel.v3.test.tsx` / `DCAPanel.chain-availability.test.tsx` puts the new token through the **real** `resolveFeed` identity ladder, which blocks creation — closing that means editing oracle-integrity mocks and an **Auditor-pinned** assertion (`minAmountOut === 97e18`, "[Auditor M-1]"). Not acceptable as collateral here. |
| Default buy → chain's canonical USD stable | **8 tests** | Same oracle-identity breakage in the v3 suite; also introduces a *chain-specific* default where today's is chain-agnostic, so switching chains would leave the other chain's USDC selected — a new cross-chain address bug needing its own effect. |
| Default buy → `null` ("Select") | **~40 tests** | Largest blast radius of the three. |
| Ship as-is | 0 | What this branch does — with this section as the flag. |

I implemented the guard, measured it at 20 failures, and **reverted it** rather than rewrite an
auditor-pinned oracle assertion as a side effect of an unrelated fix. The proper fix is "give the DCA
panel a default pair that is not a wrap/unwrap no-op", which is a product decision plus a test-suite
rebase — its own prompt, its own audit.

Note the pair was *already* meaningless before this branch: WETH → ETH is a wrap-loop that the
executor could never fill. This fix makes the meaninglessness visible rather than creating it.

Also, independently of the default: a user can still reach the self-swap by explicitly selecting ETH
as the buy token while spending WETH. The selector's `disabledAddress` blocks picking the *same*
address, but native ETH is a different entry that now resolves to it.

## Concern — the same bug exists in the sibling panels (out of scope here)

`LimitOrderPanel.tsx:423` and `ConditionalOrderPanel.tsx:331` build `config.tokenOut` from the raw
selection the same way DCAPanel did, and both still offer native ETH as an output. A limit or
stop-loss order bought into native ETH will revert at `V3:567` on every attempt for exactly the same
reason. This branch is scoped to DCA, so they are untouched — but `resolveSignableToken` was written
to be reusable by both, and they should get the same one-line treatment.

## Note — does this change make any already-signed order valid or invalid?

**Neither.** It affects only orders signed from now on. Existing signatures and order hashes are
untouched, and the hash binds `tokenOut`, so an already-signed native-output order still carries the
sentinel and still reverts at `V3:567` on every fill. Nothing is retroactively repaired and nothing
that used to work stops working.
