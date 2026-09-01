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
