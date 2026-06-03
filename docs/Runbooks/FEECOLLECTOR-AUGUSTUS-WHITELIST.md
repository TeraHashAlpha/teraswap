# Runbook — Whitelist Augustus V6 on mainnet FeeCollector V2 (ADR-011 / SPRINT-9O)

**Scope:** add the ParaSwap/Velora **Augustus V6** router to the `whitelistedRouters` mapping of the
mainnet **FeeCollector V2** via the contract's 48h-timelocked governance. This unblocks all mainnet
Velora fee-routed swaps (they currently revert `RouterNotWhitelisted()` — see SPRINT-9O / ADR-011).

**Audience:** the owner holding the FeeCollector **admin** key. This is a **fund-flow contract STATE
change** → requires **light Auditor sign-off first** (CLAUDE.md #2/#3) and ADR-011 to be **Accepted**.

**Why:** ParaSwap V6.2 funnels every route through the single Augustus entry point; it is not whitelisted
on V2, so every Velora swap fails. This is a contract **state** change, **not** a redeploy and **not** a
selector change. The 48h timelock is the safety buffer (observable + cancellable during it).

> ⚠️ **This runbook does NOT broadcast anything.** Every `cast send` below is for the **owner** to run
> with the admin key after Auditor sign-off. Read-only `cast call` / `cast rpc` (fork) steps are safe.

---

## 0. Constants (verified on-chain 2026-06-03)

| Item | Value |
|---|---|
| FeeCollector **V2** (target) | `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` |
| Augustus **V6** (router to add) | `0x6A000F20005980200259B80c5102003040001068` |
| FeeCollector **admin** (required signer) | `0x9A387f681a7674F10d255f5b2651EBc4c672C73C` (**EOA** — `cast send` works directly) |
| `TIMELOCK_DELAY` | `48 hours` (172800 s) — earliest execute |
| `TIMELOCK_GRACE` | `7 days` (604800 s) — execute window closes at `readyAt + 7d` (`TimelockExpired` after) |
| FeeCollector V1 (frozen — do NOT target) | `0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD` |

**Precomputed, ABI-verified `actionHash = keccak256(abi.encode("setRouter", router, status))`:**

| status | actionHash |
|---|---|
| `true`  (whitelist) | `0x00f65fc56cefdc890561fc0402573c40df737b72dc6cd69441bd76c91f8ef70f` |
| `false` (rollback)  | `0xb011e056cd0794517d958212685869c17cac21d11cc4ab9ffa55e3bd651aa2c0` |

**Event topic0 (for log parsing):**

| event | topic0 |
|---|---|
| `TimelockQueued(bytes32,bytes32,uint256)` | `0x04932cd31bae302e076c1efd25602eac33efe413a44798fabaa0909c8655c2c0` |
| `TimelockExecuted(bytes32,string,bytes)` | `0x26a53932c486d0db34238c489e557a02dcf8da4741e77a7b15ea8c25e48ec21d` |
| `RouterWhitelisted(address,bool)` | `0xcf2b36bf2aa8353623d06f58eab9577176d9214e588362c013a7eeb0586463f1` |

### How `actionId` is derived (read this — it is NOT precomputable)

From `TeraSwapFeeCollector.sol` `queueRouterChange` (lines 116-117):

```solidity
bytes32 actionHash = keccak256(abi.encode("setRouter", router, status));   // deterministic (table above)
bytes32 actionId   = keccak256(abi.encode(actionHash, block.timestamp));   // depends on the QUEUE block timestamp
emit TimelockQueued(actionId, actionHash, block.timestamp + TIMELOCK_DELAY);
```

`actionId` mixes in `block.timestamp` of the **queue transaction's block**, which is not known ahead of
time. So you **read `actionId` from the `TimelockQueued` event** of the queue tx (§4), then pass it to
`executeRouterChange` (§7). `actionHash` is fixed and is used only to *verify* the queued action (§5).

---

## 1. Prerequisites

```bash
# Foundry (cast). Install if needed: https://book.getfoundry.sh/getting-started/installation
cast --version

# A mainnet RPC. Prefer a private/keyed endpoint; any archive-capable node works.
export RPC_URL="https://<your-mainnet-rpc>"

# Convenience vars
export FC=0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459
export AUGUSTUS=0x6A000F20005980200259B80c5102003040001068
export ADMIN=0x9A387f681a7674F10d255f5b2651EBc4c672C73C
```

**Admin key handling — do NOT paste a raw private key on the CLI.** Use a hardware wallet or an
encrypted keystore:

```bash
# Hardware (recommended):  add `--ledger` (or `--trezor`) to each `cast send`.
# Encrypted keystore:      import once, then use `--account teraswap-admin`.
cast wallet import teraswap-admin --interactive      # one-time; prompts for the admin key + a password
```

In the `cast send` steps below, append your chosen signer flag — shown as `--account teraswap-admin`.

---

## 2. Pre-flight reads (no state change)

```bash
cast call $FC "admin()(address)"                       --rpc-url "$RPC_URL"   # expect 0x9A38…C73C
cast call $FC "paused()(bool)"                          --rpc-url "$RPC_URL"   # expect false
cast call $FC "bootstrapped()(bool)"                    --rpc-url "$RPC_URL"   # expect true (bootstrap spent → timelock path)
cast call $FC "whitelistedRouters(address)(bool)" $AUGUSTUS --rpc-url "$RPC_URL"   # expect false (the bug)
```

Re-derive the `actionHash` yourself (must match the table in §0):

```bash
cast keccak $(cast abi-encode "x(string,address,bool)" "setRouter" $AUGUSTUS true)
# => 0x00f65fc56cefdc890561fc0402573c40df737b72dc6cd69441bd76c91f8ef70f
```

Abort if any value differs from the expectations above.

---

## 3. Dry-run / simulation (no broadcast)

### 3a. Quick `eth_call` simulation (does the queue revert?)

```bash
# Simulates with the admin as sender; returns nothing on success, reverts otherwise.
cast call $FC "queueRouterChange(address,bool)" $AUGUSTUS true --from $ADMIN --rpc-url "$RPC_URL"
```

> The `actionId` from a `cast call` is meaningless (state isn't persisted and the block timestamp differs
> from the real send). Use it only to confirm the call **wouldn't revert**.

### 3b. Full end-to-end fork simulation (recommended — proves queue → wait → execute → whitelist=true)

```bash
# Terminal 1 — fork mainnet locally
anvil --fork-url "$RPC_URL"

# Terminal 2 — drive the fork (no real funds, admin impersonated)
export F=http://127.0.0.1:8545
cast rpc anvil_impersonateAccount $ADMIN --rpc-url $F

# queue
QTX=$(cast send $FC "queueRouterChange(address,bool)" $AUGUSTUS true --from $ADMIN --unlocked --rpc-url $F --json | jq -r .transactionHash)
AID=$(cast receipt $QTX --rpc-url $F --json | jq -r '.logs[] | select(.topics[0]=="0x04932cd31bae302e076c1efd25602eac33efe413a44798fabaa0909c8655c2c0") | .topics[1]')
echo "fork actionId = $AID"

# fast-forward past the 48h timelock and mine
cast rpc evm_increaseTime 172801 --rpc-url $F
cast rpc evm_mine --rpc-url $F

# execute + verify
cast send $FC "executeRouterChange(bytes32,address,bool)" $AID $AUGUSTUS true --from $ADMIN --unlocked --rpc-url $F
cast call $FC "whitelistedRouters(address)(bool)" $AUGUSTUS --rpc-url $F   # => true
```

If the fork run ends with `true`, the real procedure (§4-§8) will behave identically.

---

## 4. QUEUE (broadcast — owner, admin key)

```bash
cast send $FC "queueRouterChange(address,bool)" $AUGUSTUS true \
  --rpc-url "$RPC_URL" --account teraswap-admin
```

Capture the tx hash, then extract `actionId` from the `TimelockQueued` event:

```bash
export QTX=<queue-tx-hash>
export ACTION_ID=$(cast receipt $QTX --rpc-url "$RPC_URL" --json \
  | jq -r '.logs[] | select(.topics[0]=="0x04932cd31bae302e076c1efd25602eac33efe413a44798fabaa0909c8655c2c0") | .topics[1]')
echo "ACTION_ID = $ACTION_ID"
```

**Deterministic cross-check** (recompute `actionId` from the queue block timestamp — must equal the event value):

```bash
QBLK=$(cast receipt $QTX --rpc-url "$RPC_URL" --json | jq -r .blockNumber)
QTS=$(cast block $QBLK --field timestamp --rpc-url "$RPC_URL")
cast keccak $(cast abi-encode "x(bytes32,uint256)" \
  0x00f65fc56cefdc890561fc0402573c40df737b72dc6cd69441bd76c91f8ef70f $QTS)
# => must equal $ACTION_ID above
```

---

## 5. Verify the action is queued

```bash
cast call $FC "timelockActions(bytes32)(bytes32,uint256,bool)" $ACTION_ID --rpc-url "$RPC_URL"
```

Expect three values:
1. `actionHash` == `0x00f65fc56cefdc890561fc0402573c40df737b72dc6cd69441bd76c91f8ef70f`
2. `readyAt`   == queue-block-timestamp + 172800  (this is when §7 becomes valid)
3. `exists`    == `true`

---

## 6. Wait for the timelock

- Earliest execute: `readyAt` (queue + 48h).
- **Latest execute: `readyAt + 7 days`** — after that the action `TimelockExpired`s and you must re-queue.
- During the window the change is public; cancel any time with §9 if anything looks wrong.

---

## 7. EXECUTE (broadcast — owner, admin key, after readyAt)

```bash
cast send $FC "executeRouterChange(bytes32,address,bool)" $ACTION_ID $AUGUSTUS true \
  --rpc-url "$RPC_URL" --account teraswap-admin
```

Confirm the events in the receipt (`TimelockExecuted` topic0 `0x26a539…` and `RouterWhitelisted` topic0
`0xcf2b36…`):

```bash
cast receipt <execute-tx-hash> --rpc-url "$RPC_URL" --json | jq '.logs[].topics[0]'
```

---

## 8. Verify the whitelist flipped

```bash
cast call $FC "whitelistedRouters(address)(bool)" $AUGUSTUS --rpc-url "$RPC_URL"
# => true
```

**Runtime confirmation (owner, post-execute):** do one real small mainnet Velora swap (e.g. ~$1 ETH→USDC)
end-to-end in a wallet and confirm it settles. This is the human acceptance check — not scriptable here.

---

## 9. Rollback / cancel

**Cancel a queued-but-not-yet-executed action** (no timelock wait — removes it immediately):

```bash
cast send $FC "cancelTimelockAction(bytes32)" $ACTION_ID --rpc-url "$RPC_URL" --account teraswap-admin
```

**Reverse an already-executed whitelist** (un-whitelist Augustus) — same flow with `status=false`,
including the full 48h timelock. Its `actionHash` is `0xb011e056cd0794517d958212685869c17cac21d11cc4ab9ffa55e3bd651aa2c0`:

```bash
cast send $FC "queueRouterChange(address,bool)" $AUGUSTUS false --rpc-url "$RPC_URL" --account teraswap-admin
# … capture actionId from the TimelockQueued event (as in §4), wait 48h, then:
cast send $FC "executeRouterChange(bytes32,address,bool)" <actionId-false> $AUGUSTUS false --rpc-url "$RPC_URL" --account teraswap-admin
cast call $FC "whitelistedRouters(address)(bool)" $AUGUSTUS --rpc-url "$RPC_URL"   # => false
```

---

## 10. Notes & gates

- **Auditor sign-off required before §4** (ADR-011: fund-flow contract state change, CLAUDE.md #2/#3).
- **No selector change** — Augustus `swapExactAmountIn 0xe3ead59e` and the 9H Curve methods are already
  allowlisted; the 9H recipient-decoder concern does not apply to this whitelist add.
- **Address provenance:** `0x6A00…1068` is the audited Velora Augustus V6 (`src/lib/chains/routers.ts`,
  SPRINT-9H selector audit, Base FeeCollector whitelist, SPRINT-9O live decode). Double-check the address
  character-for-character on the hardware-wallet screen before signing.
- **[ADR-011 cross-check]** Verify the Vercel **Production** env `NEXT_PUBLIC_FEE_COLLECTOR` points at **V2**
  (`0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459`), not V1 (`0x4dAEAf…58eD`). The live app routes to V2, but
  confirm the env matches so the front end and the whitelisted contract are the same one.
- SPRINT-9O Part B (auto-fallback off a reverting best route) stays as defense-in-depth after this lands.
