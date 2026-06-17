# Runbook — AWS KMS executor key (Base)

**Goal:** run the Base keeper (`executor.js`) with its signing key inside **AWS KMS** (HSM-backed, the key
never exists in plaintext). The KMS key has a NEW Ethereum address (≠ the bootstrapped `0xd7F9…`), so it
must be whitelisted on the OrderExecutor via the **48-hour** executor-change timelock.

**⏱️ Lead time:** because of `TIMELOCK_EXECUTOR_CHANGE = 48h`, propose the KMS executor EARLY — you can do
the AWS + server setup during the 48h wait. Most secure path: never touch a plaintext key at all.

Target contract: OrderExecutor (Base) `0x135B339902Ea4E0fB4CF059961dc8856bA1D2598`. Admin = `teraswap-admin`
(`0x9A38…`).

---

## Step 1 — Create the KMS signing key  [AWS]
```bash
aws kms create-key --key-usage SIGN_VERIFY --key-spec ECC_SECG_P256K1 \
  --description "TeraSwap Executor Signing Key"
```
Note the `KeyId` / ARN from the response. (Region matters — pick one, e.g. `us-east-1`, and keep it.)

## Step 2 — IAM permissions for the executor host  [AWS]
Attach a policy to the IAM user/role the server will use:
```json
{ "Version": "2012-10-17", "Statement": [{
  "Effect": "Allow",
  "Action": ["kms:Sign", "kms:GetPublicKey"],
  "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY_ID"
}]}
```
The host authenticates with standard AWS creds (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or an instance role).

## Step 3 — Derive the KMS key's Ethereum address
From `contracts/order-engine/executor/` (ensure `@aws-sdk/client-kms` is installed: `npm ls @aws-sdk/client-kms || npm i @aws-sdk/client-kms`), with `KMS_KEY_ID` + `KMS_REGION` + AWS creds set:
```bash
node -e "import('./kms-signer.js').then(async m=>{const a=await m.createExecutorAccount();console.log('KMS executor address:', a.address)})"
```
Record this as **`$KMS_ADDR`** — this is your new executor address. (If the export name differs, the executor
also logs its signing address on startup.)

## Step 4 — Propose the executor change on-chain (starts the 48h clock)  [admin]
```bash
cast send 0x135B339902Ea4E0fB4CF059961dc8856bA1D2598 "proposeExecutorChange(address,bool)" $KMS_ADDR true \
  --account teraswap-admin --rpc-url https://mainnet.base.org
```
(Verify the exact signature on BaseScan if cast complains.) This queues the change; it becomes executable
after 48h, within a 7-day grace window.

## Step 5 — During the 48h: set up the server + executor config
- Provision the host (e.g. Hetzner ~$4/mo) with Node + pm2/systemd. `git pull` the repo (need #186 + the
  wired `ORDER_EXECUTOR_BY_CHAIN[8453]`).
- Prepare `.env.executor` (see Step 8) — but it can't execute orders until Step 6 completes.

## Step 6 — After 48h: execute the change  [admin]
```bash
cast send 0x135B339902Ea4E0fB4CF059961dc8856bA1D2598 "executeExecutorChange(address)" $KMS_ADDR \
  --account teraswap-admin --rpc-url https://mainnet.base.org
# verify:
cast call 0x135B339902Ea4E0fB4CF059961dc8856bA1D2598 "whitelistedExecutors(address)(bool)" $KMS_ADDR --rpc-url https://mainnet.base.org   # true
```
(Optional: later remove the unused `0xd7F9…` from the whitelist via another `proposeExecutorChange(0xd7F9, false)` → 48h → execute. Or keep it as a cold backup.)

## Step 7 — Fund the KMS executor address
Send ~0.02 ETH (Base) to `$KMS_ADDR` (it pays gas per execution). Set a low-balance top-up alert.

## Step 8 — Configure & run the executor  [host]
`.env.executor`:
```
KMS_KEY_ID=arn:aws:kms:us-east-1:ACCOUNT:key/KEY_ID
KMS_REGION=us-east-1
AWS_ACCESS_KEY_ID=…           # or an instance role
AWS_SECRET_ACCESS_KEY=…
CHAIN_ID=8453
ORDER_EXECUTOR_ADDRESS=0x135B339902Ea4E0fB4CF059961dc8856bA1D2598
RPC_URL=<Alchemy Base RPC>
SUPABASE_URL=…
SUPABASE_SERVICE_ROLE_KEY=…
TERASWAP_API_URL=…
FLASHBOTS_RPC=                # empty — Flashbots is mainnet-only
```
> No `EXECUTOR_PRIVATE_KEY` — KMS is the signer. (Plaintext is refused on Base anyway, #186.)
Start under pm2/systemd; confirm the logs show the **signing address = `$KMS_ADDR`**, health endpoint up,
and Supabase polling with no KMS/RPC errors.

## Step 9 — Proceed to e2e (Phase B of BASE-DCA-GOLIVE)
With the KMS executor whitelisted + running, do the small real DCA e2e test, then un-gate the DCA tab.

## Notes
- KMS cost ≈ $1/mo + $0.15 per 10k sign requests (negligible).
- Key rotation later = same 48h propose→execute flow with a new KMS key.
- Kill-switch unchanged: admin `pause()` / `unpause()` halts all execution instantly (no timelock).
