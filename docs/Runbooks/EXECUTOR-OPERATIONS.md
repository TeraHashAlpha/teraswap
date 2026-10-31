# Runbook — Executor Operations

**Scope:** deploying, operating, monitoring, and rotating the self-hosted TeraSwap order executor (`contracts/order-engine/executor/executor.js`). For security incidents involving the executor's private key, see `executor-compromise.md` — this document is for routine operations only.

**Audience:** on-call engineer, founder, infrastructure lead.

**Companion runbook:** [`executor-compromise.md`](./executor-compromise.md) — incident response when the executor key is suspected compromised.

---

## 1. Architecture Overview

The executor is a long-running Node.js process that:

1. Polls Supabase for orders in `active` status whose trigger conditions are met (Limit / Stop-Loss / Take-Profit / DCA).
2. Calls `canExecute(orderHash)` on `TeraSwapOrderExecutor` to confirm the contract agrees the order is fillable.
3. Builds aggregator calldata via `/api/swap`, then calls `executeOrder(orderHash, routerData)` on the contract.
4. Writes the resulting tx hash + status back to Supabase.

| Tunable | Value | Source |
|---------|-------|--------|
| Poll interval | 30 s | `POLL_INTERVAL_MS` in `executor.js` |
| Stale-lock recovery window | 60 s | `LOCK_TIMEOUT_MS` in `executor.js` |
| Gas tier — NORMAL ceiling | 30 gwei | `executor.js:101` |
| Gas tier — ELEVATED ceiling | 80 gwei | `executor.js:101` |
| Gas tier — URGENT ceiling | 100 gwei | `executor.js:101` |
| EIP-1559 priority fees | per-tier | `executor.js:107` |

**Dependency chain:** Supabase (order source) → Ethereum RPC → `TeraSwapOrderExecutor` contract → Supabase (status update). A failure in any link halts execution for that order but does not crash the process — see § 4 for the failure-mode mapping.

**Current state (2026-05-15):** Executor SHOULD NOT be running in production yet. The `order_executions` table is empty by design until launch.

---

## 2. Environment Variables

All variables are sourced from `contracts/order-engine/executor/.env.executor`. The example template lives at `.env.executor.example` in the same directory.

| Variable | Type | Required | Purpose |
|----------|------|----------|---------|
| `CHAIN_ID` | config | yes | `1` for mainnet |
| `RPC_URL` | secret | yes | Mainnet RPC endpoint (Alchemy / Infura / etc.) |
| `EXECUTOR_PRIVATE_KEY` | secret | conditional | Plaintext executor wallet key — **mainnet hard-fails on this**, KMS/Vault is required |
| `KMS_KEY_ID` + `KMS_REGION` | secret | conditional | AWS KMS asymmetric signing key (ECC_SECG_P256K1). Set this OR Vault, not both |
| `VAULT_ADDR` + `VAULT_TOKEN` + `VAULT_KEY_NAME` | secret | conditional | HashiCorp Vault Transit engine credentials (alternative to KMS) |
| `SUPABASE_URL` | config | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | yes | Service-role key — bypasses RLS for order reads/updates |
| `CONTRACT_ADDRESS` | config | yes | `TeraSwapOrderExecutor` mainnet address |
| `MAX_GAS_PRICE_GWEI` | config | no | Hard ceiling; overrides per-tier limits when set lower |
| `METRICS_PORT` | config | no | Prometheus scrape port — defaults to 9090 in PM2 config |

**Secrets handling:**
- Plaintext `EXECUTOR_PRIVATE_KEY` triggers a hard-fail on startup when `CHAIN_ID=1` (commit `539bd02`). To run on mainnet you MUST set either the KMS or Vault block — see `kms-signer.js` for the resolution order.
- Never check `.env.executor` into git. The file is in `.gitignore`; only `.env.executor.example` is tracked.
- `RPC_URL` is treated as a secret because it embeds the provider API key.

---

## 3. Deployment

The executor runs under PM2 using the bundled `ecosystem.config.cjs`. Single instance only — multiple instances would race for the same orders.

```bash
# First-time setup on the executor host
cd contracts/order-engine/executor
npm ci                                  # install dependencies
cp .env.executor.example .env.executor  # then edit with real values
pm2 start ecosystem.config.cjs          # registers `teraswap-executor`
pm2 save                                # persist across reboots
pm2 startup                             # follow printed instructions to wire systemd
```

Routine operations:

```bash
pm2 status                              # is teraswap-executor "online"?
pm2 logs teraswap-executor              # tail combined stdout/stderr
pm2 restart teraswap-executor           # graceful restart (5s delay)
pm2 stop teraswap-executor              # stop without removing from PM2
```

**Rolling out a keeper code change (owner-manual; Arbitrum first, then Base):** both keepers run
from this checkout under PM2 (`teraswap-keeper-arbitrum`, and `teraswap-executor` = Base, both in
`ecosystem.config.cjs`), so one pull + one install covers both; restart them one at a time.

```bash
cd contracts/order-engine/executor
git pull --ff-only                        # main, after the PR merged
npm ci --ignore-scripts                   # lockfile install, no lifecycle scripts on the host
pm2 restart teraswap-keeper-arbitrum      # Arbitrum first
pm2 logs teraswap-keeper-arbitrum --lines 50
pm2 restart teraswap-executor             # then Base
pm2 logs teraswap-executor --lines 50
```

Proof the `fix/unpriced-ack-paths` keeper change (ADR-024 amendment 2026-10-26) is live — one line
per cycle, after the per-order `DCA price quorum:` lines and before `Cycle done:` (on a cycle that
asked at least one DCA token; an idle cycle prints no such line):

```
  DCA price sources: tokens=4 chainlink=3 defillama=4 coingecko=4
  Cycle done: 0 executed, 2 skipped
```

`coingecko=0` with a reason in parentheses (`429 twice on 0x…`, `budget 20000 ms exhausted, …`,
`HTTP 400 on 0x…`) means that leg was absent THIS cycle and the quorum ran on the other two — read
the reason before touching anything; `coingecko` now climbs with the token count (one request per
token) instead of collapsing to 0 whenever two or more DCA tokens are registered.

**Verify it's running:**

| Check | Command / location |
|-------|--------------------|
| Process status | `pm2 status` — `teraswap-executor` should be `online` |
| Poll heartbeat | Logs show `Poll interval: 30s` on startup, then `Poll #N` lines every 30s |
| Prometheus metrics | `curl http://<host>:9090/metrics` |
| On-chain activity | Etherscan: executor EOA → `executeOrder` calls when work exists |

**Logs:** `./logs/error.log` and `./logs/out.log` (relative to the executor directory). `merge_logs: true` in the PM2 config interleaves multi-instance output — currently single-instance, so files map 1:1 to the process. There is no built-in rotation; configure host-level logrotate or PM2's `pm2 install pm2-logrotate` for production.

**Auto-restart policy** (from `ecosystem.config.cjs`):
- `autorestart: true` with `restart_delay: 5000` ms
- `max_restarts: 50` per session; crash-loops past that stop the process and require manual `pm2 restart`
- `max_memory_restart: 256M` — graceful restart if RSS climbs above this

---

## 4. Monitoring & Alerting

The executor itself does NOT push alerts. Alerting goes through the existing TeraSwap monitoring pipeline:

| Signal | Source | Alert path |
|--------|--------|-----------|
| Executor stopped polling | Absence of `OrderExecuted` events in P47 on-chain monitor | Telegram via `on-chain-monitor.ts` |
| Suspicious tx from executor EOA | P47 watches `OrderExecuted` topic | Telegram |
| Critical post-execution validation | P45 `/api/monitor/validate-execution` | Telegram + auto-disable of source |
| Gas-cap hit (no execution despite triggered order) | Supabase: `order_executions` row with `status='skipped'` and `reason` containing `gas` | Manual audit |
| Execution failure streak | Repeated rows with `status='failed'` for the same order | Manual audit |
| Process OOM / crash loop | PM2 logs, `pm2 status` | Host-level monitoring (out of scope here) |
| RPC provider rejects the key (allowlist / invalid key / 401 / 403) | Keeper itself (`rpc-auth.js`, INC-2026-10-30-001) | Telegram `🔐 RPC AUTH REJECTED — Urgency: HIGH`: once at boot (rate-limited across pm2 restarts), or once after 3 consecutive rejections at runtime, then at most hourly; one `RPC auth recovered` when it clears. State: `/health` `paused: "rpc-auth"`, `/metrics` `teraswap_executor_paused{reason="rpc-auth"} 1`, heartbeat `alive but PAUSED`, Supabase `keeper_runtime_config.paused`. Fix: § 7 |

**Where to look first:**
- `pm2 status` and `pm2 logs teraswap-executor` for process health.
- Supabase `orders` table — `status` column moves `active → executing → filled` (success) or `active → failed` (gas exhausted, revert, RPC failure).
- Supabase `order_executions` table — one row per attempt, with `tx_hash` and `reason`.
- Telegram ops channel (`@teraswap_monitor_bot`) for any P0/P1 alerts that fired.

---

## 5. Incident Response

For suspected key compromise, stop reading and follow [`executor-compromise.md`](./executor-compromise.md) instead — that runbook is alert-only and timelocked.

**Routine restart** (process unhealthy, no security concern):

```bash
pm2 restart teraswap-executor
pm2 logs teraswap-executor --lines 100   # confirm it restarted clean
```

**Pause execution without removing the executor wallet** (gas-price spike, congestion, planned maintenance):

Option A — stop the process:
```bash
pm2 stop teraswap-executor
```
Orders remain `active` in Supabase; they will be picked up when the executor resumes.

Option B — flip orders to `paused` in Supabase (covers cases where the process is on a host you don't control):
```sql
UPDATE orders SET status = 'paused', paused_at = now() WHERE status = 'active';
```
Reverse with `UPDATE orders SET status = 'active', paused_at = NULL WHERE status = 'paused';` once resumed.

**Resume after a gas spike subsides:**
1. Check current gas: `curl -s https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=$ETHERSCAN_KEY | jq .result.SafeGasPrice`
2. Confirm below the URGENT tier (100 gwei) if you want full execution coverage.
3. `pm2 start teraswap-executor` (or reverse the SQL paused-flag above).
4. Tail logs for the next two poll cycles (60 s) and confirm a `Gas: X gwei | tier: NORMAL` line.

---

## 6. Key Rotation

Rotating the executor wallet key is a 48 h timelocked operation on-chain plus an off-chain config swap. Do this proactively every 6 months OR immediately on any suspicion of compromise (see `executor-compromise.md` for the latter).

**Procedure:**

1. **Generate the new key** in your KMS / Vault. Capture the new EOA address.
2. **Queue the contract change** — call `proposeExecutor(newAddress)` from the admin wallet. This starts the 48 h timelock; the event `ExecutorChangeProposed` fires and the P47 monitor will alert.
3. **Fund the new EOA with gas** (ETH for `executeOrder` transactions).
4. **Wait 48 h.** No way to short-cut this — it's a contract-level guard.
5. **Execute the change** — call `executeExecutorChange()` from the admin wallet. `ExecutorChangeExecuted` fires.
6. **Update the executor host's config** — point `KMS_KEY_ID` / `VAULT_KEY_NAME` at the new key.
7. **Restart the executor:** `pm2 restart teraswap-executor`.
8. **Verify** on the next poll cycle that the executor's signing address matches the new whitelisted address. The startup log line is `Executor: 0x...`; cross-check it against the contract's `executor()` view.
9. **De-whitelist the old key** by re-running steps 2–5 with `proposeExecutor` pointing at the new address only — `whitelistExecutor(old, false)` if your contract version exposes it, otherwise the swap in step 5 already revokes the prior executor.
10. **Decommission the old KMS / Vault key** once the new one has executed at least one successful order.

**Do NOT** skip the test-execution step. A misconfigured signer fails silently on the first `executeOrder` call — verify with at least one real on-chain execution before considering the rotation complete.

---

## 7. Changing an RPC key (new key, rotation, allowlist, or any restriction)

**Why this exists:** in INC-2026-10-30-001 a domain allowlist went onto a key that the Base keeper's
`RPC_URL` also used. Its consumers had been checked by grepping for the **key prefix**, which missed the
keeper (the key sits inside a URL path in a host env file). Every keeper RPC call was refused for ~20 h.
**Inventory by RPC hostname, never by key.** Do not paste key values into tickets, chats or this file.

1. **Inventory every consumer by hostname** (e.g. `g.alchemy.com`). Print variable names and hosts only,
   never the path or query:
   - Keeper host, every env file of every keeper (`.env.executor` = Base, `.env.executor.arbitrum`, …),
     plus any backup copy (INC-2026-09-08-001 found one under the home directory):
     ```bash
     cd contracts/order-engine/executor
     # prints "file  VAR  scheme://host" — never the userinfo, path or query (where keys live)
     grep -HE '^[A-Z0-9_]+="?[a-z]+://' .env.executor* \
       | sed -E 's#^([^:]+):([A-Z0-9_]+)="?([a-z]+)://([^/?#@"]*@)?([^/?#"]+).*#\1  \2  \3://\5#' \
       | grep '<provider-host>'
     ```
   - Vercel, **Production + Preview + Development**: Project → Settings → Environment Variables, search
     for the hostname (or `vercel env pull` into a temp file OUTSIDE the repo, grep it the same way, then
     delete it).
   - Other secret stores holding an RPC URL (GitHub Actions secrets used by `daily-health-report`,
     Cloudflare Worker secrets): list them by name and record which provider/key each one uses.
   - Write the list down: one line per `consumer → variable → provider host`.
2. **Separate.** One key per consumer (web client, web server `RPC_URL_<chainId>`, keeper Base, keeper
   Arbitrum, CI). Never restrict a key that more than one consumer shares; create the new key first.
3. **Restrict to fit the consumer.** A *domain/origin allowlist* is for browser keys only. The keeper is
   a server process that sends no `Origin`, so a domain allowlist rejects it (`Unspecified origin not on
   whitelist`). Keeper keys get an IP allowlist (the host's egress IP) or no allowlist.
4. **Swap and verify the keeper host** — one process at a time:
   ```bash
   pm2 restart teraswap-keeper-arbitrum && pm2 logs teraswap-keeper-arbitrum --lines 50
   pm2 restart teraswap-executor && pm2 logs teraswap-executor --lines 50
   ```
   - Pass: the `[chain-verify] eth_chainId = …` line, no `rpc: AUTH REJECTED`, and a first cycle
     (`No active orders` / `Found N active order(s)`).
   - Fail fast: `rpc: AUTH REJECTED chain=<id> source=RPC_URL — check provider allowlist/key` means
     the boot refused. Go back to step 3.
   - After a few minutes: `/health` → `"paused": null`; `/metrics` →
     `teraswap_executor_paused{reason="rpc-auth"} 0`; Supabase → `keeper_runtime_config.paused IS NULL`.
5. **Verify Vercel.** Redeploy if a variable changed (env changes apply to new deployments only). Then
   watch the runtime logs for ~15 min for `403` / `401` / `whitelist` from RPC calls, and check that
   `/api/health` answers 200.
6. **Only then** restrict or revoke the old key. A key that ever appeared in a log, alert or chat is
   revoked, not merely restricted: an Origin allowlist is a header check that any non-browser client
   can satisfy.

---

## References

- ADR — order engine architecture (see `docs/ADR/`)
- `contracts/order-engine/executor/executor.js` — source of all tunables cited above
- `contracts/order-engine/executor/kms-signer.js` — KMS / Vault resolution logic
- `contracts/order-engine/executor/ecosystem.config.cjs` — PM2 deployment config
- [`executor-compromise.md`](./executor-compromise.md) — security incident runbook
- [`INC-2026-10-30-001`](../../Audits/Incidents/INC-2026-10-30-001.md) — RPC key allowlisted under the keeper (origin of § 7)
- [`KV-troubleshooting.md`](./KV-troubleshooting.md) — Upstash diagnostics (executor does not use KV directly, but shares the monitoring pipeline)
