# Feedback — fix/keeper-multichain-instance-identity

### The three recon claims, verified before any change (line numbers = origin/main `19cfb80`)
1. `executor.js:214` `const CHAIN_ID = parseInt(process.env.CHAIN_ID || "1")` — confirmed; also `parseInt` accepted `"8453abc"`.
2. `chain-verify.js` — `verifyChainBinding` (`:278`) reads `eth_chainId`, `eth_getCode`, `ORDER_TYPEHASH()` only; `grep whitelistedExecutors` over the executor dir returned nothing. Confirmed.
3. `ecosystem.config.cjs:11-37` — one app (`teraswap-executor`). Confirmed. The incident the prompt cites as `INC-2026-09-09-001` is `Audits/Incidents/INC-2026-09-08-001.md` in this repo (Supabase key attribution near-miss) — no `-09-09-001` file exists.

### Assumption that turned out wrong: "the existing host guard"
No host guard exists anywhere in the repo (grep'd `docs/`, `scripts/`, `Audits/`, git history for `hostname`/`host guard`; `EC2-EXECUTOR-HOST.md` had bare commands). S2.0 of the runbook now defines `ts_host_guard` (IMDSv2 token + instance-profile name `teraswap-executor-ec2`, bash 3.2) and every one of the 14 commands in the new section is prefixed with it. If the Architect's guard is a different idiom, S2.0 is the one place to swap it.

### Edge cases beyond the five listed identity vars
- `KMS_REGION` defaulted to `us-east-1` (`kms-signer.js`) — identity-bearing for a bare id/alias. Now required with `KMS_KEY_ID` (`executor.js:422`, and in `createExecutorAccount` for direct callers such as the runbook's signer check). Base's `.env.executor` per Step 5 already sets it; if the live file does not, Base's next restart refuses naming `KMS_REGION`.
- Blank (whitespace) values now count as missing (`validateConfig`, `isBlank`).
- No `paused()` boot read exists and none was added: pause is a runtime state the keeper must be running to observe (`event-watcher.js`); a paused executor is a reason to idle, not to refuse boot.
- `alert.js:59` / `event-watcher.js:153` `|| "1"` display fallbacks removed (`"unset"` / no explorer link). Remaining `8453`/`42161`/`"1"` literals are chain-keyed tables selected by the verified `CHAIN_ID` (`DEFILLAMA_CHAIN_SLUG`, `EXPLORER_BY_CHAIN`, gas-tier/submission-policy/eth-usd-feed regimes) — none is a default.

### Env per app (`ecosystem.config.cjs`; everything else lives in each app's env file)
- `teraswap-executor`: `NODE_ENV=production`, `METRICS_PORT=9090` (unchanged); file `.env.executor` (default).
- `teraswap-keeper-arbitrum`: `NODE_ENV=production`, `EXECUTOR_ENV_FILE=.env.executor.arbitrum`, `METRICS_PORT=9091`, `HEALTH_PORT=3002`.
- Shared value: `NODE_ENV` only (pinned by `ecosystem.test.mjs`). Env load: pm2 `env` → process env before node starts → `env.js` (first import, `executor.js:84`) reads `EXECUTOR_ENV_FILE` and loads the file before any later import evaluates (`env-order.test.mjs`).

### Boot sequence, in order (`executor.js`)
env file (`env.js:52-53`) → `CHAIN_ID` parse, exit on bad (`:237-243`, module scope) → env presence incl. `KMS_REGION` (`validateConfig` `:369`) → `verifyChainBinding` eth_chainId/code/ORDER_TYPEHASH (`:2206`) → signer from KMS (`:2228`) → `verifyExecutorWhitelist` (`:2237`, `chain-verify.js:496`) → balance/servers → first Supabase query `chain_id=eq.${CHAIN_ID}` (`:647`, also `:668`, `:825`). Query and idle backoff are per-process already: `CHAIN_ID` is a module constant of the process, and `createIdleCadence()` (`:2339`; `idle-backoff.js:45-48`) holds closure state — no change needed.

### Tests (51 new; suite 511 → 562, Node 25 locally — CI's Node 20/22 is the runtime proof)
`boot-identity.test.mjs`: `parseChainIdEnv` (15 cases) · `verifyExecutorWhitelist` (9, injected provider) · real-`executor.js` boots against RPC + KMS doubles (`AWS_ENDPOINT_URL_KMS`, no module mocked): missing/empty/unparseable `CHAIN_ID`; `CHAIN_ID ≠ eth_chainId` (KMS never reached); missing/blank `RPC_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; no executor address; no `KMS_KEY_ID`; `KMS_REGION` absent; `whitelistedExecutors(signer)=false` (negative); `=true` positive control asserting the full call order; v2 true + v3 false refuses. `ecosystem.test.mjs` (7). `env-order.test.mjs` +4 (`EXECUTOR_ENV_FILE`). `chain-verify.test.mjs` harness now dispatches `eth_call` by selector; `arbitrum-plumbing.test.mjs` re-pinned to the default-free parser.

### Side effect on the Base process
Only a stricter boot at its next restart: `CHAIN_ID`/`KMS_REGION` must be present and the signer must be whitelisted (it is — it fills today). No change to signing, order selection, floor or fill logic.
