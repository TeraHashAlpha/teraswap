## Feedback — fix/curve-pool-type

### poolType table (pool → value → on-chain proof)

| Pool | poolType | Proof |
|---|---|---|
| 3pool | 1 | `eth_call` to CurveRouterNG.get_dy succeeds both directions (DAI→USDC amountOut=999837, USDC→DAI amountOut=999862301278919845). Control (poolType=0, today's hardcoded default) reverts. |
| steth | 1 | Succeeds both directions (ETH→stETH amountOut=1000004525021375898, stETH→ETH amountOut=999795375502711636). Control (0) reverts. |
| fraxusdc | 1 | Succeeds both directions (FRAX→USDC amountOut=991106, USDC→FRAX amountOut=1008770003259923488). Control (0) reverts. |
| tricrypto2 | **excluded — no value** | Every poolType candidate (0,1,2,3,4,10,20,30) reverts `get_dy` with this pool's configured `swapType=3`. Follow-up debugging (not part of this fix) found `swapType=1` succeeds instead — i.e. `swapType`, not `poolType`, is wrong for this pool. Out of this fix's scope (poolType/`_swap_params[..][3]` only). |
| crvusdusdc | **excluded — no value** | This file's declared `coins` order (`[crvUSD, USDC]`) does not match the pool's on-chain `coins()` order (`coins(0)=USDC, coins(1)=crvUSD`) — confirmed by calling `coins(0)`/`coins(1)` directly. `findCurvePool` derives `i`/`j` from the declared order, so any router `get_dy` result is not trustworthy proof of a correct poolType while this pre-existing ordering bug stands. Out of this fix's scope. |
| crvusdusdt | **excluded — no value** | Same issue as crvusdusdc: declared `[crvUSD, USDT]` vs on-chain `coins(0)=USDT, coins(1)=crvUSD`. |

### verify script output (full)

Run: `CURVE_VERIFY_RPC_URL=https://ethereum-rpc.publicnode.com npx tsx --tsconfig tsconfig.json scripts/verify-curve-pool-types.mjs`
(`https://eth.llamarpc.com`, the RPC named in the task, returned HTTP 521 "Web server is down" at run time — swapped to `https://ethereum-rpc.publicnode.com`, also public, also read-only.)

```
RPC: https://ethereum-rpc.publicnode.com
Router: 0x16C6521Dff6baB339122a0FE25a9116693265353 (len 42)

── 3pool ──
  pool 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7 (len 42)
  coin 0x6b175474e89094c44da98b954eedeac495271d0f (len 42)
  coin 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 (len 42)
  coin 0xdac17f958d2ee523a2206206994597c13d831ec7 (len 42)
  poolType=0: REVERT | reverse REVERT
  poolType=1: SUCCESS amountOut=999837 | reverse SUCCESS amountOut=999862301278919845
  poolType=2: REVERT | reverse REVERT
  poolType=3: REVERT | reverse REVERT
  poolType=4: REVERT | reverse REVERT
  poolType=10: SUCCESS amountOut=999837 | reverse SUCCESS amountOut=999862301278919845
  poolType=20: REVERT | reverse REVERT
  poolType=30: REVERT | reverse REVERT
  [control] poolType=0 (today's hardcoded default): REVERT
  RESULT: poolType=1 PROVEN on-chain both directions.

── steth ──
  poolType=0: REVERT | reverse REVERT
  poolType=1: SUCCESS amountOut=1000004525021375898 | reverse SUCCESS amountOut=999795375502711636
  poolType=2/3/4/20/30: REVERT
  poolType=10: SUCCESS amountOut=1000004525021375898 | reverse SUCCESS amountOut=999795375502711636
  [control] poolType=0: REVERT
  RESULT: poolType=1 PROVEN on-chain both directions.

── fraxusdc ──
  poolType=0: REVERT | reverse REVERT
  poolType=1: SUCCESS amountOut=991106 | reverse SUCCESS amountOut=1008770003259923488
  poolType=2/3/4/20/30: REVERT
  poolType=10: SUCCESS amountOut=991106 | reverse SUCCESS amountOut=1008770003259923488
  [control] poolType=0: REVERT
  RESULT: poolType=1 PROVEN on-chain both directions.

=== Summary ===
3pool: poolType=1
steth: poolType=1
fraxusdc: poolType=1
```

(3pool/steth/fraxusdc all accept both poolType=1 and poolType=10 with identical output — the
script picks the first candidate in ascending order, 1, which also matches "legacy stable" per
these being pre-NG factory-independent pools.)

The earlier run (before excluding tricrypto2/crvusdusdc/crvusdusdt from `CURVE_POOLS`) is what
produced the revert evidence documented in the table above for those three pools; full transcript
available by re-running the script against a checkout that still has them in `CURVE_POOLS`.

### Acceptance results

1. **Pin + negative control tests** — `src/lib/adapters/curve.pool-type.test.ts`. Pins `poolType`
   for 3pool/steth/fraxusdc, asserts `buildCurveRoute` encodes it into `_swap_params[0][3]`, and
   asserts `swapParams[0][3] !== 0n` for 3pool (this specific assertion fails against origin/main,
   which hardcodes `0n`, as confirmed by reading `origin/main`'s `curve.ts` before editing). PASS.
2. **get_dy selector unchanged** — same test file computes
   `keccak256("get_dy(address[11],uint256[5][5],uint256,address[5])")` and asserts it equals
   `0x637653cb`, and separately asserts the literal signature string reads that way — both sides
   computed, nothing hand-typed as an assumed constant beyond the literal `0x637653cb` in the
   assertion (which is what's being proven, not assumed). PASS.
3. **Verify script output** — see above: success for every pool kept in routing, revert for the
   `poolType=0` control on 3pool (and on steth/fraxusdc too). PASS.
4. **Full suite / lint / typecheck** — 254 test files / 3620 tests pass (`npx vitest run`); `npx tsc
   --noEmit` clean; `npx eslint` clean on all changed files. PASS.

### Edge case
- Discovered mid-investigation: `CURVE_POOLS.tricrypto2`'s `swapType=3` never succeeds against
  CurveRouterNG for any `poolType` — `swapType=1` does (verified with a direct pool `get_dy(0,1,dx)`
  call matching the router's output). This is a second, independent bug in the same file, out of
  this fix's scope (poolType only). tricrypto2 currently returns no Curve quotes at all as a result
  — same as before this fix (it was already broken via the `0n` poolType default), so this fix does
  not regress it, but a follow-up prompt is needed to actually restore tricrypto2 routing.

### Concern
- **Security-relevant finding**: `CURVE_POOLS.crvusdusdc` and `CURVE_POOLS.crvusdusdt`'s declared
  `coins` arrays are in the *wrong* on-chain order (`[crvUSD, token]` when the real pools are
  `[token, crvUSD]` — confirmed via `coins(0)`/`coins(1)`). Before this fix, calling the router
  through `findCurvePool`'s (wrong) `i`/`j` derivation for these two pools returned near-1:1 "echo"
  amounts identical across every `poolType` tried (`999999999999999999` / `999999`) that do **not**
  match a correct direct-pool `get_dy` call (`get_dy(int128,int128,uint256)`, which these plain-NG
  pools actually expose — the router's `uint256`-indexed ABI reverts on them directly too). Had
  these two pools stayed live with the reversed order, a real swap could have mispriced by a
  material amount. This fix removes both pools from routing entirely rather than risk that; a
  follow-up prompt is needed to fix the coin order (and confirm the correct `swapType`/`poolType`/
  ABI-signature combination) before re-enabling them.
