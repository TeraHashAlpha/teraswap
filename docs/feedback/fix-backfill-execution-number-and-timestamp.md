# Feedback — fix/backfill-execution-number-and-timestamp

## Checklist

- [x] Task 1.1 — `buildExecutionRow` accepts optional `blockTimestamp`, sets `created_at`
- [x] Task 1.2 — `backfill-execution.mjs` derives `execution_number` from the chain (drops the
      hard-coded `1`)
- [x] Task 2 — `--repair` mode (idempotent, narrow, dry-run by default)
- [x] Task 3 — tests (a)-(d)
- [x] Task 4 — runbook: repair section + note that pre-fix backfilled rows must be repaired once

## Helper reuse points (as required by the prompt)

- `contracts/order-engine/executor/list-missing-fills.mjs:94` (`scanLogsChunked`) and
  `list-missing-fills.mjs:124` (`resolveBlockFromTimestamp`) — both imported directly into
  `backfill-execution.mjs` and driven by `computeExecutionNumber` (new,
  `backfill-execution.mjs:44`) to fetch every `OrderExecuted` log for one order hash and rank this
  tx within it, instead of re-implementing chunked `eth_getLogs`/binary-search block resolution.
- `contracts/order-engine/executor/record-execution.js:24` (`ORDER_EXECUTED_EVENT`) — reused as the
  `getLogs` event filter in `backfill-execution.mjs` (`args: { orderHash }`, indexed-topic filter at
  the RPC level, not a client-side scan of every log) instead of redeclaring the ABI a third time
  (list-missing-fills.mjs already reuses it this way for its own scan).

## Live keeper path — blockTimestamp NOT wired in (as instructed, "state which")

`executor.js`'s call site (`executor.js:1944`, `buildExecutionRow({ dbOrder, txHash, receipt,
decoded, nextBestOut, nextBestSource })`) is unchanged — it does not pass `blockTimestamp`.
`receipt` there comes from `txPublicClient.waitForTransactionReceipt()` (`executor.js:1880`), whose
return type has no timestamp field; getting one would require an additional `getBlock()` RPC call on
every single fill for a cosmetic `created_at` column. Kept the live path byte-for-byte (pinned by
`record-execution.test.mjs`'s new "(d) live path" test) rather than add that RPC call — flagging in
case the Architect wants it anyway for a future sprint (it's a real, if minor, on-chain-latency cost
per fill).

## Repair commands for the 6 Arbitrum hashes — BLOCKED, file not supplied

The prompt says to read the exact repair commands from `~/missing-fills.42161.txt`'s companion log
(owner supplies the file). Checked `~/missing-fills.42161.txt` and grepped the home directory for
any `*42161*`/`*missing-fills*` file — **neither the file nor a companion log exists on this
machine**, so the per-hash `--repair` command list could not be generated here.

The **generic** command (same shape for all 6, once the owner has each tx hash) is now documented in
`docs/Runbooks/EC2-EXECUTOR-HOST.md` under "Repair a row backfilled before
[FIX-BACKFILL-EXECUTION-NUMBER-AND-TIMESTAMP]":

```bash
EXECUTOR_ENV_FILE=.env.executor.arbitrum node backfill-execution.mjs <txHash> --repair
# then, once the printed patch looks correct:
BACKFILL_APPLY=1 EXECUTOR_ENV_FILE=.env.executor.arbitrum node backfill-execution.mjs <txHash> --repair
```

Once the owner supplies `~/missing-fills.42161.txt` (or the 6 hashes directly), run the dry-run form
above for each hash and confirm `execution_number` comes out 1/2/3 per order (not three "Fill #1"s)
before applying.

## Test names (Task 3)

- `backfill-execution.test.mjs`:
  - (a) `computeExecutionNumber — 1-based rank by (blockNumber, logIndex)` →
    `"(a) three fills in blocks 10/20/30 get numbers 1/2/3, whatever order the hashes are queried in"`
  - (c) `resolveRepairTarget — --repair only ever patches a uniquely-identified row` →
    `"(c) exactly one existing row → ok, returns it"`,
    `"(c) zero existing rows → refuses"`, `"(c) two existing rows → refuses"`
- `record-execution.test.mjs` (describe `"buildExecutionRow — optional blockTimestamp sets created_at"`):
  - (b) `"(b) created_at equals the block timestamp, not now()"`
  - (d) `"(d) live path — omitting blockTimestamp produces the same row as before (no created_at key)"`

Full executor suite (`node --test *.test.mjs` in `contracts/order-engine/executor`, after `npm ci
--ignore-scripts` there per [[teraswap-worktree-node-modules]]): 649/649 passing, 0 regressions.
