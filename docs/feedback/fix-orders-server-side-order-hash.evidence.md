# fix/orders-server-side-order-hash: evidence (long output)

Companion to `fix-orders-server-side-order-hash.md`. Measured 2026-11-17 on the owner's Mac (Node v26.13.1,
forge 1.5.1-stable), worktree `~/ts-worktrees/orders-server-side-order-hash`.

## E1. Every write path to `orders` (grep at `4a4129ef`; lines at branch head)

Grep: `from('orders')`, PostgREST `orders?…` with PATCH/POST, `INSERT INTO/UPDATE orders` in `*.sql`, `order_hash`
outside tests, over `src/`, `contracts/order-engine/{api,executor}`, `scripts/`, `workers/`, `supabase/`.

| Path | What it writes | `order_hash`? |
|---|---|---|
| `src/app/api/orders/route.ts:754-788` POST insert | the whole row | **was `body.orderHash`; now `serverOrderHash` (:772), computed at :393** |
| `src/app/api/orders/[id]/route.ts:143-150` PATCH | `status: 'cancelled'` (wallet + active + chain_id gated) | no |
| `contracts/order-engine/executor/executor.js:687` `lockOrder` | `status: 'executing'`, `updated_at` | no |
| `executor.js:707` `updateOrderStatus` | `status`, `updated_at` | no |
| `executor.js:736` `patchOrderRow` (callers :866, :2070, :2073) | status, retry-state, infra-miss, execution fields | no (no keeper source names `order_hash`) |
| `executor.js:908` `unlockStaleOrders` | `status: 'active'`, `updated_at` | no |
| `executor/backfill-execution.mjs:282` (owner-run) | `computeOrderPatch` (:77): `status`, `dca_executed`, `dca_last_exec`, `updated_at` | no; it READS by `order_hash` = the OrderExecuted topic (:169) |
| `contracts/order-engine/api/orders.ts:150-165` insert, `:231` cancel | stores `body.orderHash` | yes, but **never served**: header says "reference implementation… will be copied to src/app/api", not under `src/app`, imported nowhere; left unchanged (contracts/ tree) |
| SQL (`supabase/*.sql`, `supabase/migrations/*`, `contracts/order-engine/schema.sql`) | no function or trigger writes `orders` | n/a |

The keeper never reads `order_hash`: it rebuilds the struct from `order_data` (`executor.js:1571`) and the contract
recomputes `getOrderHash` itself.

## E2. Hash definition and differential

- Contract: `TeraSwapOrderExecutorV3.sol:1149` `getOrderHash(Order) = keccak256(abi.encode(ORDER_TYPEHASH, 16 fields))`,
  the EIP-712 **struct hash**; it keys `cancelledOrders`/`dcaExecutions` (:357, :437, :638). The domain enters only the
  digest: `ECDSA.recover(_hashTypedDataV4(orderHash), sig)` (:360, :449). v2: `TeraSwapOrderExecutor.sol:964`, 15 fields.
- Server: `src/lib/order-engine/order-hash.ts` `computeOrderHash({ types, message })` = viem `hashStruct('Order')` over the
  same `types`/`message` objects the route passes to `recoverTypedDataAddress`; `computeOrderDigest` adds the domain.
- Foundry, the contracts' own functions `getOrderHash(Order)` and `domainSeparator()`, code at the production
  address with `block.chainid` set (`contracts/order-engine/test/OrderHashDifferential.t.sol`):

```
Ran 5 tests for test/OrderHashDifferential.t.sol:OrderHashDifferentialTest
[PASS] test_v2_base_serverHashEqualsGetOrderHash() (gas: 3840840)
[PASS] test_v2_mainnet_serverHashEqualsGetOrderHash() (gas: 3841928)
[PASS] test_v3_arbitrum_serverHashEqualsGetOrderHash() (gas: 5842657)
[PASS] test_v3_base_serverHashEqualsGetOrderHash() (gas: 5837071)
[PASS] test_v3_dcaTotal_1_and_365_on_both_chains() (gas: 2330165)
Suite result: ok. 5 passed; 0 failed; 0 skipped
Ran 3 test suites: 124 tests passed, 0 failed, 0 skipped (124 total tests)      # order-engine, as CI runs it
Suite result: ok. 19 passed; 0 failed                                           # contracts/ FeeCollector (compiles the new files)
```

| Set | Executor (docs/DEPLOYMENTS.md) | Chain | Seed | Orders |
|---|---|---|---|---|
| V3_BASE | `0x686b4f81…e60a0` | 8453 | 8453001 | 128 |
| V3_ARB | `0x47f24068…C7459` | 42161 | 42161001 | 128 |
| V2_MAINNET | `0xeFC31ADb…f130` | 1 | 1002 | 48 |
| V2_BASE | `0x135B3399…2598` | 8453 | 8453002 | 48 |

352 orders, each compared twice (struct hash, digest). Order types cycle `i % 3`; DCA `dcaTotal` cycles 1 / 365 /
random 2..364; magnitudes `x >> (x % 256)` from 0 to 2^256-1; addresses alternate lower case / checksummed. The vitest
side (`scripts/orders/order-hash-vectors.test.ts`) fails if `OrderHashVectors.sol` is not exactly what the server
function renders now, checks a second oracle (`keccak256(abi.encode(...))` over the `.sol` type strings) on all 352,
and checks the vector domains equal `getOrderExecutorDomain` / `getOrderExecutorV3Domain` (env slots stubbed).
No RPC, no fork, no ffi.

## E3. Route tests (`src/app/api/orders/orders-server-order-hash.test.ts`, real signatures + recovery + config)

```
 ✓ same signed order posted twice (two wrong texts): one row, then 409
 ✓ same signed order posted twice (the right hash, then a wrong text): one row, then 409
 ✓ same signed order posted twice (a wrong text, then the right hash): one row, then 409
 ✓ wrong hash text (another order's hash) is stored as the server hash and logged once, without the signature
 ✓ wrong hash text (not a hash at all) is stored as the server hash and logged once, without the signature
 ✓ correct hash: unchanged behaviour (201, the row stores that exact text, the response returns it, nothing logged)
 ✓ mixed case accepted (upper-case hex): 201, stored as the lower-case server hash, nothing logged
 ✓ mixed case accepted (0X prefix, upper case): 201, stored as the lower-case server hash, nothing logged
 ✓ mixed case accepted (no 0x prefix): 201, stored as the lower-case server hash, nothing logged
 ✓ a v2-signed order (Mainnet) stores the v2 hash; a wrong text is logged with version 2
 ✓ the hash covers only VERIFIED fields: a body field that differs from the signed one is refused, nothing stored
 Tests  11 passed (11)
```

The in-memory `orders` table enforces `UNIQUE (order_hash)` as `schema.sql:114`. Every `fetch` is stubbed to throw and
asserted uncalled; probe: removing the chainlink mock makes 9/11 fail (the v2 and refused cases never read decimals).
The logged line: `{"event":"orders_order_hash_mismatch","mode":"observe","chainId":8453,"version":3,"orderType":"dca",
"storedHash":"0x…","callerHash":"0xabab…"}`. All 206 pre-existing tests in `src/app/api/orders/` pass unchanged.

## E4. Mutation proof (scratch worktree at `60be03c7`, removed after)

M1, route stores the caller's text again (`order_hash: body.orderHash`): 9 failed / 628.
```
orders-server-order-hash.test.ts > same signed order posted twice (two wrong texts): one row, then 409
orders-server-order-hash.test.ts > same signed order posted twice (the right hash, then a wrong text): one row, then 409
orders-server-order-hash.test.ts > same signed order posted twice (a wrong text, then the right hash): one row, then 409
orders-server-order-hash.test.ts > wrong hash text (another order's hash) is stored as the server hash and logged once, without the signature
orders-server-order-hash.test.ts > wrong hash text (not a hash at all) is stored as the server hash and logged once, without the signature
orders-server-order-hash.test.ts > mixed case accepted (upper-case hex) / (0X prefix, upper case) / (no 0x prefix)   [3 tests]
orders-server-order-hash.test.ts > a v2-signed order (Mainnet) stores the v2 hash; a wrong text is logged with version 2
```

M2, `nonce` dropped from the types `computeOrderHash` hashes over: 20 failed / 628 in vitest.
```
order-hash-vectors.test.ts > the committed file equals what scripts/orders/gen-order-hash-vectors.ts renders now
order-hash-vectors.test.ts > second oracle: V2_BASE / V2_MAINNET / V3_ARB / V3_BASE computeOrderHash == keccak256(abi.encode(TYPEHASH, ...))  [4 tests]
order-hash.test.ts > computeOrderHash > every signed field changes the hash
check-order-hashes.test.ts > classifies every fixture row; a "match" is the contracts' own construction; CLI exit 1 case; CLI exit 0 case  [4 tests]
orders-server-order-hash.test.ts > all 10 tests that check a stored or logged hash (incl. "correct hash: unchanged behaviour")
```
and, with `OrderHashVectors.sol` regenerated from the mutant (so the drift guard alone would not catch it), Foundry:
```
[FAIL: v2 getOrderHash != server computeOrderHash, order 0] test_v2_mainnet_serverHashEqualsGetOrderHash()
[FAIL: v2 getOrderHash != server computeOrderHash, order 0] test_v2_base_serverHashEqualsGetOrderHash()
[FAIL: v3 getOrderHash != server computeOrderHash, order 0] test_v3_arbitrum_serverHashEqualsGetOrderHash()
[FAIL: v3 getOrderHash != server computeOrderHash, order 0] test_v3_base_serverHashEqualsGetOrderHash()
```

## E5. check-order-hashes on fixtures only (`scripts/orders/__fixtures__/order-rows.json`)

```
$ node --no-warnings scripts/orders/check-order-hashes.ts < scripts/orders/__fixtures__/order-rows.json
{"id":"v3-caller-text","chain_id":8453,"stored":"0xabab…ab","computed":"0x1d1e5df3…1879","version":3}
{"id":"v3-hash-of-another-order","chain_id":8453,"stored":"0x08010756…2527","computed":"0x02cd1200…d6f3","version":3}
{"id":"legacy-uuid-hash","chain_id":8453,"stored":"6f1c2a90-3b7e-4c1d-9a55-2f0e8b7d4c11","computed":"0x32081dc6…8ed9","version":3}
uncomputable {"id":"no-order-data",…,"reason":"order_data missing (the keeper skips such a row)"}
uncomputable {"id":"order-data-missing-nonce",…,"reason":"order_data.nonce missing"}
checked 8 rows: 3 match, 3 differ, 2 uncomputable
exit 1
```

## E6. Verify

`scripts/agent-verify.sh --codeql` at `341a9357` (the code head; the docs commit adding these two files sits on top):

```
=== EVIDENCE ===
branch: fix/orders-server-side-order-hash @ 341a9357 (base origin/main @ 4a4129ef)
suite:       PASS 10897 tests passed, 0 failed, 511 files
lint-delta:  PASS errors +0, warnings +0 (13 changed files; head 0 err/0 warn, base 0 err/0 warn)
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: PASS 123 tests passed, 0 failed, 11 files
rpc-budget:  PASS 36 tests passed, 0 failed, 3 files
codeql:      PASS security-extended: head 13, base 13, new by rule+file+message 0
keeper:      SKIP not requested (--keeper)
 17 files changed, 2214 insertions(+), 48 deletions(-)
compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/orders-server-side-order-hash
RESULT: PASS
=== END EVIDENCE ===
```

The first run of the same command at the same head said `codeql: FAIL head 20, base 13, new 7`. None of the 7 were in
the diff: 4 in `contracts/order-engine/lib/openzeppelin-contracts/fv/run.js` (OpenZeppelin's own script) and 3
`js/polynomial-redos` in untouched `SwapBox.tsx:535`, `format.ts:76`, `SwapCard.tsx:365` with "library input" sources.
Cause, measured: the head worktree had the OZ submodule initialised (for forge); verify's base worktree and CI's
`codeql.yml` checkout have none. CodeQL on a fresh HEAD worktree without the submodule: 13 alerts, identical to base by
rule+file+message in both directions. The submodule was then de-initialised and the command re-run (block above);
the forge runs in E2 were taken before that, with `--cache-path`/`--out` in the scratchpad so the tracked
`contracts/order-engine/cache/solidity-files-cache.json` stayed unchanged.

Also run: `node scripts/gen-claude-state.mjs --check` → `CLAUDE.md state block is current` (exit 0);
`gitleaks git --log-opts=4a4129ef..HEAD` → no leaks; `forge test -vvv` (order-engine) 124/124 and
`forge test --match-path 'test/*.t.sol'` (contracts/) 19/19, as `ci.yml` runs them.
