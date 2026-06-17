# Runbook — DCA go-live on Base

**Goal:** turn on conditional orders (DCA first) on Base. The contract side is **done**: OrderExecutor
`0x135B339902Ea4E0fB4CF059961dc8856bA1D2598` is deployed, verified, and bootstrapped (10 direct routers +
executor `0xd7F96B11C5686f22C72B3aB00642C0a530d233Fe`). This runbook starts the keeper, proves execution
end-to-end, then un-gates the DCA tab. **Phased — do not skip the e2e test before un-gating.**

Prereq: the wire-up commit (`ORDER_EXECUTOR_BY_CHAIN[8453] = 0x135B…`) is merged. Order creation/sign is
chain-aware + fail-closed (#184); plaintext executor key is refused on Base (#186 → KMS/Vault required).

---

## Phase A — Executor (keeper) infrastructure  [owner]

1. **Fund the executor wallet** `0xd7F96B11C5686f22C72B3aB00642C0a530d233Fe` with Base ETH (start ~0.02 ETH;
   it pays gas per execution). Set a low-balance alert + top-up plan.
2. **Load the key into KMS/Vault** (plaintext is refused on Base). Decrypt the keystore ONCE in a secure
   context and import into your secret store:
   ```bash
   cast wallet private-key --keystore ~/teraswap-executor-keystore/<uuid>   # prints PK → paste into KMS/Vault, never to disk
   ```
3. **Configure & start `executor.js`** (`contracts/order-engine/executor/`) with Base env:
   - `CHAIN_ID=8453`  (header default is Sepolia — must override)
   - `ORDER_EXECUTOR_ADDRESS=0x135B339902Ea4E0fB4CF059961dc8856bA1D2598`
   - `RPC_URL=<Alchemy Base RPC>`  (use Alchemy PAYG, not public — reliability)
   - `KMS_KEY_ID=…` **or** `VAULT_ADDR=…`  (NOT `EXECUTOR_PRIVATE_KEY` — blocked on Base)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TERASWAP_API_URL`
   - `FLASHBOTS_RPC=`  (leave empty — Flashbots is mainnet-only; Base routes via normal RPC)
   - gas tiers default fine for Base (cheap). Run under pm2/systemd.
4. **Confirm it's alive:** the health endpoint (`HEALTH_PORT`, `HEALTH_TOKEN`) responds, and logs show it
   polling Supabase for active orders with no key/RPC errors.

## Phase B — End-to-end test (controlled, tab still gated)  [owner]
5. Create **one small real DCA order on Base** (while the public tab is still "Soon" — create via the API
   with a signed order, or a temporary owner-only flag). Then verify the full path:
   - executor picks it up → `canExecute` true at the interval → submits `executeOrder`.
   - On BaseScan: tx success, tokens delivered to your wallet, 0.1% fee to `0x107F…`, order status updated
     in Supabase. `MIN_ORDER_AMOUNT` = 10000 base units (keep the test above it).
   - Let at least 2 DCA cycles run to confirm interval + nonce handling.
6. If anything misbehaves → **do NOT un-gate**; fix first. (This is the gate the deferred-launch decision
   was about — prefer delay over shipping broken.)

## Phase C — Un-gate the DCA tab  [Code Agent, after Phase B passes]
> Goal: in `src/app/page.tsx`, remove `dca` from the coming-soon set (`COMING_SOON_MODES`/`COMING_SOON_META`)
> so the DCA tab becomes active; wire the DCA panel to the order-creation flow (`useOrderEngine`), gated by
> `isChainActive(8453)` + `getOrderExecutor(8453)` (both now truthy). Keep Limit/SL·TP removed. Consider a
> rollout flag / beta allowlist for a staged launch. Signed commit, CI + test-contracts green, FEEDBACK.

## Phase D — Monitoring & kill-switch  [verify before public]
7. Confirm coverage for Base order execution:
   - Executor process health alert (down → notify).
   - On-chain monitor watching the Base OrderExecutor (chain-aware after #184 + wire-up).
   - Telegram/Sentry alerts on failed executions + on executor low balance.
   - **Kill-switch tested:** admin `0x9A38` can `pause()` the OrderExecutor (halts all `executeOrder`),
     `unpause()` to resume.

## Emergency / ops procedures
- **Pause execution:** `cast send 0x135B… "pause()" --account teraswap-admin --rpc-url <base>`  (`unpause()` to resume).
- **Rotate/revoke the executor key** (timelocked): `proposeExecutorChange(newExec, status)` → wait the
  timelock → `executeExecutorChange(newExec)`. Use to remove a compromised key or add a backup keeper.
- **Stuck/abuse:** fund-sweep is timelocked (`queueSweep`/`executeSweep`); router changes timelocked
  (`queueRouterChange`).
- **Top-up** the executor wallet before it runs out of Base ETH (executions silently stop otherwise).

## Rollout recommendation
Start gated/beta (allowlist or low `MAX_ACTIVE_ORDERS`), watch the first real orders closely, then open up.
DCA only for now; Limit/SL·TP stay off until their own go-live.
