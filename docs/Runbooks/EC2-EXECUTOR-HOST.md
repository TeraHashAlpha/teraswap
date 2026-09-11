# Runbook — EC2 host for the Base executor (instance-role KMS)

Run `executor.js` 24/7 on a small EC2 in **eu-north-1**, with an **IAM instance role** granting KMS access
— so NO AWS access keys live on the box (the instance gets temporary creds automatically).

Inputs already in place: KMS key `arn:aws:kms:eu-north-1:299590374219:key/096547c1-7664-4d5e-998e-8e56ce67c08b`
(alias `teraswap-executor`), KMS executor address `0x71f5AC191587AE132D966a719569b2468e0Aa2E5`, policy
`teraswap-executor-kms` (kms:Sign + kms:GetPublicKey), OrderExecutor (Base) `0x135B339902Ea4E0fB4CF059961dc8856bA1D2598`.

## Step 1 — IAM role for EC2 (instance profile)
- IAM → **Roles** → **Create role** → Trusted entity: **AWS service** → **EC2** → Next.
- Attach the **`teraswap-executor-kms`** policy (the one you already made) → Next.
- Name: `teraswap-executor-ec2` → Create role.
  (This is what lets the instance call KMS without access keys.)

## Step 2 — Launch the instance
- EC2 → **Launch instance** (region **eu-north-1 / Stockholm**).
- Name: `teraswap-executor`.
- AMI: **Amazon Linux 2023** (good AWS/role integration).
- Type: **t4g.small** (ARM, ~$12/mo; t4g.micro is cheaper if you want). Well within the $200 credits.
- Key pair: create/select an SSH key pair (download the `.pem`, keep it safe).
- Network / Security group: **allow SSH (22) from YOUR IP only**. No other inbound. (The executor only makes
  OUTBOUND calls; do NOT expose the health port to the internet.)
- **Advanced details → IAM instance profile → `teraswap-executor-ec2`** (the role from Step 1). ← critical.
- Storage: default gp3 (8–16 GB) is fine. Launch.

## Step 3 — Connect + base setup
```bash
ssh -i teraswap-executor.pem ec2-user@<EC2_PUBLIC_IP>
sudo dnf update -y
sudo dnf install -y git
# Node 20 (Amazon Linux 2023):
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
sudo npm i -g pm2
```

## Step 4 — Get the code
Clone the repo (use a GitHub read-only **deploy key** or a PAT for the private repo), then:
```bash
cd teraswap/contracts/order-engine/executor   # path within the repo
npm ci                                        # installs from this dir's own package.json/lockfile
```

## Step 5 — Configure `.env.executor` (NO access keys — instance role provides creds)
```
KMS_KEY_ID=arn:aws:kms:eu-north-1:299590374219:key/096547c1-7664-4d5e-998e-8e56ce67c08b
KMS_REGION=eu-north-1
CHAIN_ID=8453
ORDER_EXECUTOR_ADDRESS=0x135B339902Ea4E0fB4CF059961dc8856bA1D2598
RPC_URL=<Alchemy Base RPC>
SUPABASE_URL=…
SUPABASE_SERVICE_ROLE_KEY=…
TERASWAP_API_URL=…
FLASHBOTS_RPC=
HEALTH_PORT=3001
HEALTH_TOKEN=<random secret>
```
> No `AWS_ACCESS_KEY_ID`/`SECRET` and no `EXECUTOR_PRIVATE_KEY` — the instance role + KMS are the signer.

## Step 6 — Verify the instance can sign as the right address
```bash
node -e "import('./kms-signer.js').then(async m=>{const a=await m.createExecutorAccount();console.log(a.address)})"
```
Must print **`0x71f5AC191587AE132D966a719569b2468e0Aa2E5`**. (Confirms the instance role → KMS works.)

## Step 7 — Run under pm2 (auto-restart + boot persistence)
```bash
pm2 start executor.js --name teraswap-executor
pm2 save
pm2 startup    # follow the printed command to enable on boot
pm2 logs teraswap-executor   # confirm: KMS signer loaded, address 0x71f5…, Supabase polling, no errors
```

## Notes / safety
- Prereq: the **executeExecutorChange** (T+48h) must be done so `0x71f5…` is whitelisted, AND the address
  funded with Base ETH — otherwise executions revert / can't pay gas.
- Keep the SG locked to your IP for SSH; rotate the SSH key if leaked.
- Cost: t4g.small ~$12/mo (or t4g.micro ~$6) + KMS ~$1/mo — covered by the $200 credits for a long time.
- Kill-switch is on-chain: admin `pause()` halts execution regardless of the host.
- Never leave an env backup on this host. If you copy `.env.executor` aside for a migration or
  a test, remove it in the same session — a backup that outlives its session is a second,
  unaudited copy of every credential on the box.
- When attributing a Supabase (or any) key on this host, compare the key **value** — fingerprint
  it, don't trust its filename or label. A key's name is only ever a claim about what it is,
  never proof (INC-2026-09-08-001).

---

## Second process — Arbitrum One keeper (`teraswap-keeper-arbitrum`) [FIX-KEEPER-MULTICHAIN-INSTANCE-IDENTITY]

The same host runs a SECOND `executor.js` for Arbitrum One (42161) beside the Base one. It is a
separate pm2 app with its **own env file, own KMS key, own Supabase key, own ports and own logs**
(`contracts/order-engine/executor/ecosystem.config.cjs`, app `teraswap-keeper-arbitrum`). The Base
process is not restarted, reconfigured or touched by anything below — verify that at the end.

Nothing identity-bearing has a default any more: a missing `CHAIN_ID` / `RPC_URL` / `SUPABASE_*` /
executor address / `KMS_KEY_ID` / `KMS_REGION` refuses to boot naming the variable, and the boot
also refuses unless `whitelistedExecutors(<this process's KMS signer>)` is `true` on the configured
executor. A wrong or incomplete file therefore fails loudly at `pm2 start` instead of silently
becoming another chain's keeper.

**No value in this section is copied from a document.** Addresses and key ids are *resolved* from
`docs/DEPLOYMENTS.md` (§ Contracts, OrderExecutor V3 · Arbitrum One row; § Keeper registry,
Arbitrum One row) at the moment you run the commands, then cross-checked on-chain and against AWS.

**Never `export EXECUTOR_ENV_FILE`** in any shell that touches either app. Both apps now pin their
own env file explicitly in `ecosystem.config.cjs` ([FIX-KEEPER-ENV-PIN-AND-RUNBOOK]) precisely so
a stray shell export can no longer win over the file it names (shell env always wins — env.js), but
a `pm2 restart <app> --update-env` still re-reads whatever *is* exported at that moment. To confirm
which file a running process actually loaded, don't trust memory — read that process's own `Env
file: …` boot line (S2.5 below for Arbitrum; the pre-restart check in S2.4 for Base).

### S2.0 — Host guard (define once per shell; EVERY command below is prefixed with it)

Every command in this section starts with `ts_host_guard &&`. The guard refuses to run anywhere
but the executor instance: IMDSv2 must answer, and the instance profile must be the role from
Step 1 (`teraswap-executor-ec2`). A laptop, a CI runner or the wrong box prints `HOST GUARD:` and
runs nothing. Bash 3.2-compatible.

```bash
ts_host_guard() {
  local tok
  tok=$(curl -sS -m 2 -X PUT "http://169.254.169.254/latest/api/token" \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null) \
    || { echo "HOST GUARD: no IMDSv2 — this is not an EC2 instance. Refusing." >&2; return 1; }
  curl -sS -m 2 -H "X-aws-ec2-metadata-token: $tok" \
        "http://169.254.169.254/latest/meta-data/iam/info" 2>/dev/null \
    | grep -q 'instance-profile/teraswap-executor-ec2' \
    || { echo "HOST GUARD: instance profile is not teraswap-executor-ec2. Refusing." >&2; return 1; }
}
ts_host_guard && echo "on the executor host"
```

### S2.1 — IAM: allow `kms:Sign` on the **Arbitrum** key (resolved, not typed)

The instance role's existing policy (`teraswap-executor-kms`) names only the Base key ARN, and the
instance role holds only `Sign` + `GetPublicKey` on that one resource (`AWS-KMS-EXECUTOR-SETUP.md`
Step 2) — it cannot itself call `kms:DescribeKey`, on the Arbitrum key or any other. Granting the
new permission is therefore IAM write access the instance role does not have and must not be given
just to bootstrap itself, so this step is split: the grant happens from an admin shell (the
owner's workstation, never the host), and the host only ever *verifies* the grant afterwards.

#### S2.1a — ADMIN-SHELL (owner's workstation — NOT the executor host)

Resolve the ARN from the alias recorded in `docs/DEPLOYMENTS.md` § Keeper registry (Arbitrum One
row: alias `teraswap-keeper-arbitrum`, region `eu-north-1`) and **compare the key id in the output
with that row before proceeding** — if they differ, stop: the registry or the alias is wrong, and
this is not the key to grant.

```bash
# ADMIN-SHELL — an identity with IAM + KMS admin permissions. Do NOT run this on the executor host;
# ts_host_guard is deliberately absent here because this step must NOT run on the instance.
ARB_KEY_ARN=$(aws kms describe-key --region eu-north-1 \
    --key-id alias/teraswap-keeper-arbitrum --query 'KeyMetadata.Arn' --output text) \
  && echo "$ARB_KEY_ARN"
# ↑ the trailing key id must equal the "KMS key id" cell of the Arbitrum One row in DEPLOYMENTS.md.
# Record that key id — S2.1b re-derives it on the host and compares against this same DEPLOYMENTS.md row.
```

Policy statement to add to `teraswap-executor-kms` (or as a second policy
`teraswap-keeper-arbitrum-kms` attached to the instance role, `teraswap-executor-ec2`). Only
`Sign` + `GetPublicKey`, only this ARN — the Base statement stays as it is:

```bash
# ADMIN-SHELL
cat <<POLICY
{
  "Effect": "Allow",
  "Action": ["kms:Sign", "kms:GetPublicKey"],
  "Resource": "${ARB_KEY_ARN}"
}
POLICY
```

Apply it in IAM (console, or `aws iam create-policy-version` from this same admin shell). Do not
proceed to S2.1b until the change has propagated (IAM is eventually consistent — a minute is
typically enough).

#### S2.1b — ON THE HOST (guarded): verify the grant before anything relies on it

The instance role cannot `DescribeKey`, so the host confirms the grant the same way the running
keeper eventually will — `GetPublicKey` by alias — and compares the key id it reaches against the
same DEPLOYMENTS.md row S2.1a used, before deriving or trusting any signer address:

```bash
ts_host_guard && cd ~/teraswap \
  && ARB_KEY_ID_HOST=$(aws kms get-public-key --region eu-north-1 \
       --key-id alias/teraswap-keeper-arbitrum --query 'KeyId' --output text | sed 's#.*/##') \
  && ARB_KEY_ID_DOC=$(grep 'Arbitrum One (42161)' docs/DEPLOYMENTS.md \
       | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1) \
  && if [ -n "$ARB_KEY_ID_HOST" ] && [ "$ARB_KEY_ID_HOST" = "$ARB_KEY_ID_DOC" ]; then \
       echo "MATCH: $ARB_KEY_ID_HOST"; \
     else \
       echo "DIFF: host reached '${ARB_KEY_ID_HOST:-<none>}', DEPLOYMENTS.md says '${ARB_KEY_ID_DOC:-<none>}' — stop"; \
     fi
```

`DIFF`, or either side empty, means the grant, the alias, or the registry entry is wrong — do not
continue until this prints `MATCH`. No ARN is typed anywhere in this step; the host only ever
addresses the key by alias, which is also what removes any need to carry `$ARB_KEY_ARN` from
S2.1a's shell (a different machine) into this one.

Only once S2.1b prints `MATCH` does deriving the signer address make sense — again by alias, never
a typed ARN — to confirm it resolves to the Arbitrum signer recorded in DEPLOYMENTS.md § Keeper
registry (Arbitrum One row), which is also the address `ARBITRUM-V3-STATE-2026-08-26.md` shows
whitelisted on-chain:

```bash
ts_host_guard && cd ~/teraswap/contracts/order-engine/executor \
  && KMS_KEY_ID="alias/teraswap-keeper-arbitrum" KMS_REGION=eu-north-1 \
     node -e "import('./kms-signer.js').then(async m=>{const a=await m.createExecutorAccount();console.log(a.address)})"
```

### S2.2 — Separate Supabase key (one key per consumer — INC-2026-09-08-001)

Create a **new** Supabase secret key for this consumer, named for what it is (e.g.
`keeper_ec2_arbitrum_<yyyy_mm>`), in the Supabase dashboard. Do **not** reuse the Base keeper's key
or the Vercel key: one consumer, one key, so it can be attributed and rotated alone. Before pasting
it, fingerprint it and record the fingerprint *only* in your local notes — never in this repo
(INC-2026-09-08-001 §7).

### S2.3 — Env file: location, permissions, contents

Path: `~/teraswap/contracts/order-engine/executor/.env.executor.arbitrum` (the name pinned in
`ecosystem.config.cjs`; git-ignored by the root `.env.*` rule). Mode `0600`, owner `ec2-user`,
created under `umask 077` so it never exists world-readable even for an instant. No backups — a
copy that outlives the session is a second, unaudited credential set (see Notes above).

```bash
ts_host_guard && cd ~/teraswap/contracts/order-engine/executor \
  && ( umask 077 && touch .env.executor.arbitrum ) && chmod 600 .env.executor.arbitrum \
  && ls -l .env.executor.arbitrum      # expect: -rw------- ec2-user ec2-user
```

Fill it (values are yours to paste; names are exact). **Do not copy any line from `.env.executor`.**

```
CHAIN_ID=42161
RPC_URL=<Alchemy/Infura Arbitrum One RPC — NOT the Base URL>
ORDER_EXECUTOR_V3_ADDRESS=<DEPLOYMENTS.md § Contracts, "OrderExecutor V3 · Arbitrum One (42161)" row>
#  no ORDER_EXECUTOR_ADDRESS: Arbitrum has no v2 OrderExecutor (v3-only boot is supported)
KMS_KEY_ID=<the ARN printed by S2.1a>
KMS_REGION=eu-north-1
SUPABASE_URL=<same project URL as the Base keeper>
SUPABASE_SERVICE_ROLE_KEY=<the NEW key from S2.2 — never the Base keeper's>
TERASWAP_API_URL=<same as Base>
HEALTH_TOKEN=<a NEW random secret — not the Base one>
FLASHBOTS_RPC_URL=
#  empty on purpose: Arbitrum One submits through its private sequencer (submission-policy.js);
#  ALLOW_PUBLIC_MEMPOOL is NOT set.
TELEGRAM_BOT_TOKEN=<optional; the same bot/chat is acceptable — every alert is stamped "Chain: 42161">
TELEGRAM_CHAT_ID=<optional>
```

Do **not** set `HEALTH_PORT`, `METRICS_PORT` or `EXECUTOR_ENV_FILE` in the file: pm2 injects them
per app (`3002` / `9091` / this file's name) and shell env wins over the file, so the ports cannot
collide with Base's `3001` / `9090` whatever the file says. Do **not** set `EXECUTOR_PRIVATE_KEY`
or `ALLOW_PLAINTEXT_KEY` — the instance role + KMS are the signer.

S2.2 requires the Supabase key pasted above to be a **new** key, never the Base keeper's. Verify
that mechanically — by content, not by filename or label (INC-2026-09-08-001 §7) — without ever
printing either key:

```bash
ts_host_guard && cd ~/teraswap/contracts/order-engine/executor \
  && BASE_HASH=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env.executor | cut -d= -f2- | sha256sum | cut -d' ' -f1) \
  && ARB_HASH=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env.executor.arbitrum | cut -d= -f2- | sha256sum | cut -d' ' -f1) \
  && if [ -n "$BASE_HASH" ] && [ -n "$ARB_HASH" ] && [ "$BASE_HASH" != "$ARB_HASH" ]; then \
       echo "ok  SUPABASE_SERVICE_ROLE_KEY differs between apps"; \
     else \
       echo "FAIL  SUPABASE_SERVICE_ROLE_KEY missing or identical between apps — stop"; \
     fi
```

Optional pre-flight without starting anything (needs Foundry's `cast` on the host; skip if absent
— the boot gate makes the identical read and refuses on `false`):

```bash
ts_host_guard && cd ~/teraswap/contracts/order-engine/executor \
  && ARB_SIGNER=$(KMS_KEY_ID="alias/teraswap-keeper-arbitrum" KMS_REGION=eu-north-1 node -e "import('./kms-signer.js').then(async m=>{const a=await m.createExecutorAccount();console.log(a.address)})" | tail -1) \
  && ARB_V3=$(grep '^ORDER_EXECUTOR_V3_ADDRESS=' .env.executor.arbitrum | cut -d= -f2-) \
  && ARB_RPC=$(grep '^RPC_URL=' .env.executor.arbitrum | cut -d= -f2-) \
  && cast call "$ARB_V3" "whitelistedExecutors(address)(bool)" "$ARB_SIGNER" --rpc-url "$ARB_RPC"
# expect: true   (false ⇒ the executor change for this signer has not been executed on-chain — stop)
```

### S2.4 — Start the new app ONLY

**START PRECONDITION.** `ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS` (`src/lib/order-engine/config.ts:117`)
is a code-level allowlist and today it is `[8453]` — Base only, Arbitrum One is not in it. That
list gates the **frontend/API** (order creation), not this keeper process, and nothing in this
runbook adds 42161 to it. Starting `teraswap-keeper-arbitrum` before that list includes 42161 is
therefore safe and intentional: the process boots green (chain-verify passes — OrderExecutorV3 is
already deployed and whitelisted on-chain), polls Supabase for `chain_id=eq.42161` orders, finds
none (the eligibility gate prevents any from being created), and idles — signing nothing. That is
the expected, unremarkable state of this app until the code-level allowlist is separately widened.

```bash
ts_host_guard && cd ~/teraswap/contracts/order-engine/executor \
  && git pull --ff-only \
  && npm ci --ignore-scripts \
  && install -d -m 700 logs \
  && pm2 start ecosystem.config.cjs --only teraswap-keeper-arbitrum \
  && pm2 save
```

(`install -d -m 700 logs` rather than `mkdir -p logs`: the directory's own permissions are the
real access control for the files pm2 creates inside it — see S2.6, where `create 0600` in the
logrotate stanza is a no-op under `copytruncate` and cannot substitute for this.)

`--only` starts exactly that app; `teraswap-executor` (Base) is neither restarted nor re-read.
Confirm: `ts_host_guard && pm2 describe teraswap-executor | grep -E 'status|uptime|restarts'` must
show the same uptime/restart count as before you began.

Side effect on Base, by design: `git pull` updates the code on disk, so Base's **next** restart
boots through the same stricter gate. That restart is not automatic — pm2 does not restart Base
just because `git pull` touched files on disk — so when the owner does restart Base (here or at
any later time), run this pre-restart check first, under `ts_host_guard`, names only (no value is
ever printed):

```bash
ts_host_guard && cd ~/teraswap/contracts/order-engine/executor \
  && ok=0 \
  && for v in CHAIN_ID KMS_REGION KMS_KEY_ID RPC_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY ORDER_EXECUTOR_ADDRESS ORDER_EXECUTOR_V3_ADDRESS; do \
       if grep -Eq "^${v}=[^[:space:]]+" .env.executor; then echo "ok  $v"; ok=$((ok+1)); else echo "MISSING/BLANK  $v"; fi; \
     done \
  && if grep -Eq '^CHAIN_ID=8453[[:space:]]*$' .env.executor; then echo "ok  CHAIN_ID=8453"; ok=$((ok+1)); else echo "MISSING/BLANK  CHAIN_ID=8453"; fi \
  && echo "checks ok: $ok / 9"
```

Expect **9** `ok` lines. Anything less: do not pull, do not restart — fix `.env.executor` first.
Also confirm no identity-bearing variable is sitting in the shell that could win over the file:

```bash
ts_host_guard && env | grep -E '^(EXECUTOR_ENV_FILE|CHAIN_ID|RPC_URL|KMS_|SUPABASE_)'
```

This must print **nothing**. Any output here is a stray export from an earlier session — unset it
before continuing; shell env wins over the file (env.js), so a leftover export would silently
override `.env.executor` at restart.

Only once both checks are clean:

```bash
ts_host_guard && cd ~/teraswap/contracts/order-engine/executor \
  && before=$(git rev-parse HEAD:contracts/order-engine/executor/package-lock.json 2>/dev/null) \
  && git pull --ff-only \
  && after=$(git rev-parse HEAD:contracts/order-engine/executor/package-lock.json 2>/dev/null) \
  && if [ "$before" != "$after" ]; then echo "package-lock.json changed — running npm ci"; npm ci --ignore-scripts; else echo "package-lock.json unchanged — skipping npm ci"; fi
ts_host_guard && pm2 restart teraswap-executor
# ATTENDED. Never --update-env (re-reads the shell env checked above into the process).
# Never `restart all` (would also bounce teraswap-keeper-arbitrum). Never a bare
# `pm2 start ecosystem.config.cjs` (re-declares both apps from this file).
```

Then read `pm2 logs teraswap-executor --lines 60 --nostream` and confirm the boot lines appear in
this order: `eth_chainId` matches `CHAIN_ID`, `ORDER_TYPEHASH` (×2 — v2 and v3), the KMS executor
address, `whitelistedExecutors = true` (×2 — v2 and v3), `Env file: …/.env.executor`, `Chain: 8453`.
Any `FATAL:` line ⇒ the env file is incomplete — fix the named variable; do not add an override.

### S2.5 — Boot log lines the owner must see (in this order)

```bash
ts_host_guard && pm2 logs teraswap-keeper-arbitrum --lines 60 --nostream
```

1. `[chain-verify] eth_chainId = 42161 — matches CHAIN_ID`
2. `[chain-verify] ORDER_EXECUTOR_V3_ADDRESS (v3) 0x… — <n> bytes of code on chain 42161`
3. `[chain-verify] ORDER_EXECUTOR_V3_ADDRESS (v3) 0x… — ORDER_TYPEHASH 0x… matches`
4. `[C-02] Using AWS KMS signer (key never leaves HSM)` then `[C-02] KMS executor address: 0x…` —
   the address must equal the Arbitrum One signer in DEPLOYMENTS.md § Keeper registry.
5. `[chain-verify] signer 0x… — whitelistedExecutors = true on ORDER_EXECUTOR_V3_ADDRESS (v3) 0x… (chain 42161)`
   ← the INSTANCE check. Absent, or a `FATAL: signer … is NOT a whitelisted executor` line,
   means the wrong key or an unexecuted executor change: the process exits, nothing was sent.
6. `Env file: …/.env.executor.arbitrum` · `Executor wallet: 0x…` · `Chain: 42161` ·
   `Contract (v2): not configured -- v2 orders will be skipped + flagged` · `Contract (v3): 0x…`
7. `Health check: http://localhost:3002/health` (Base stays on 3001)
8. `No active orders` / `Found <n> active order(s)` — the first Supabase query, filtered
   `chain_id=eq.42161`, authenticated with the S2.2 key.

Any `FATAL:` line ⇒ the refusal names the variable or check; fix the env file, `pm2 restart
teraswap-keeper-arbitrum`, re-read from line 1. Never work around a refusal with an override.

### S2.6 — logrotate coverage

pm2 does not rotate the ecosystem apps' `./logs/*.log`, and the Base app's `~/.pm2/logs/` files
were already unrotated (INC-2026-09-08-001 §8). One stanza covers both processes; `copytruncate`
because pm2 keeps the files open.

```bash
ts_host_guard && sudo tee /etc/logrotate.d/teraswap-keeper >/dev/null <<'ROTATE'
/home/ec2-user/teraswap/contracts/order-engine/executor/logs/*.log
/home/ec2-user/.pm2/logs/teraswap-*.log {
    daily
    rotate 14
    size 50M
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    create 0600 ec2-user ec2-user
}
ROTATE
ts_host_guard && sudo logrotate -d /etc/logrotate.d/teraswap-keeper   # dry run; no "error" lines expected
```

`create 0600` above is a no-op with `copytruncate`: copytruncate truncates the live file in place
rather than rotating-and-recreating it, so `create`'s permission-setting never actually runs
against it. The real protection is the `logs/` directory permissions set once, up front, in S2.4
(`install -d -m 700 logs`) — new files created inside a `700` directory by the `ec2-user`-owned
`teraswap-keeper-arbitrum` process are unreachable by any other local user regardless of what
`create` claims here. The `create 0600` line is left in place as documentation of intent (and in
case the stanza is ever changed to drop `copytruncate`), but do not rely on it for the guarantee
below.

The error log holds order data in plaintext (INC-2026-09-08-001 §8), so it must never become
group/world-readable through rotation.

### S2.7 — Roll back (Base untouched)

```bash
ts_host_guard && pm2 delete teraswap-keeper-arbitrum && pm2 save
```
