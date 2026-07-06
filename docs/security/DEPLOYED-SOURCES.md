# DEPLOYED-SOURCES — canonical address → source → compiler → code-hash map

> **[AUDIT-W2 / W2-M-01]** This file is the **source-integrity** companion to
> [`docs/DEPLOYMENTS.md`](../DEPLOYMENTS.md) (the ops record: roles, wallets, env). For every deployed
> TeraSwap contract it pins the **exact source file (and revision), compiler settings, and on-chain
> runtime-code hash** — so no reviewer, auditor, or re-deploy can ever take the wrong source again
> (Wave 1 of T-SAF 2026-07-01 audited the stale `TeraSwapFeeCollectorV2_flat.sol` and wrongly concluded
> the live V2 had no `minimumOutput` — W1-I-02, refuted on-chain by Wave 2).
>
> **Re-verified on-chain 2026-07-02** via `scripts/verify-deployed-sources.mjs` (public RPCs,
> keccak256 of `eth_getCode`, CBOR-trailer solc decode, byte-compare vs `forge build` artifacts with
> immutables masked and metadata stripped, full selector audit). If code/docs disagree, a fresh run of
> that script against the chain wins.

## The map

Hash = first 8 bytes of `keccak256(runtime bytecode)` (same convention as the T-SAF W0 baseline).
"Byte-proven" = compiled artifact == on-chain code after masking `immutableReferences` and stripping
each side's CBOR metadata trailer (metadata differs by build path; it is not executable code).

| Role | Chain | Address | Source (exact) | Compiler | Code hash · size | Source == deployed |
|------|-------|---------|----------------|----------|------------------|--------------------|
| **FeeCollector V2** (instant swaps) | Ethereum (1) | `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` | `contracts/TeraSwapFeeCollector.sol` (tip — file unchanged since `94cb469`, the H-04 commit) | solc **0.8.28** (decoded from on-chain CBOR trailer) · via-IR **required** (source does not compile without it) · Remix deploy | `0x3bde15fc219da158` · 5,419 B | **Selector-proven** (19/19 source selectors on-chain, incl. `swapTokenWithFee(...,uint256)` `0x7f7663d4` + `swapETHWithFee(...,uint256)` `0x7739563c`; legacy no-minOutput `0x33178294` **absent**; stale-flat-only `setAllowedSelector`/`transferAdmin` **absent**) + W2 behavioral proof. Byte-exact repo reproduction still open — see §Follow-ups. |
| **FeeCollector** (instant swaps) | Base (8453) | `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` | `contracts/TeraSwapFeeCollector.sol` (tip, `94cb469`) | solc 0.8.28 · via-IR · optimizer 200 · cancun (= `contracts/foundry.toml`) | `0x2ff08ff8b42c44ba` · 5,339 B | **Byte-proven** (2026-07-02) |
| **FeeCollector V1** (frozen — do **not** route) | Ethereum (1) | `0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD` | `contracts/TeraSwapFeeCollector_flat.sol` (V1 flatten — this one IS a deployed source) | solc **0.8.20** · optimizer **off** · **no** via-IR (Remix defaults) | `0x0462a4dea82127de` · 5,826 B | **Byte-proven** (2026-07-02) |
| **OrderExecutor** (conditional orders) | Ethereum (1) | `0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` | `contracts/order-engine/TeraSwapOrderExecutor.sol` **at commit `c22794c`** ("fix: DCA routerDataHash bug + redeploy contract") — reproduce with `git show c22794c:contracts/order-engine/TeraSwapOrderExecutor.sol` | solc 0.8.28 · via-IR · optimizer 200 · cancun (= `order-engine/compile.js` pipeline) | `0x86c4cf824ab04c2d` · 13,244 B | **Byte-proven at that revision** (2026-07-02) |
| **OrderExecutor** (conditional orders) | Base (8453) | `0x135B339902Ea4E0fB4CF059961dc8856bA1D2598` | `contracts/order-engine/TeraSwapOrderExecutor.sol` (tip) | solc 0.8.28 · via-IR · optimizer 200 · cancun | `0x34ef10ab25a43c51` · 15,475 B — **new baseline this run** (W0 did not hash it) | **Byte-proven** (2026-07-02) |

### ⚠️ Same address, different contract per chain
`0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130` is the **OrderExecutor on mainnet** (13,244 B) but the
**FeeCollector on Base** (5,339 B). Never identify a contract by address alone — always by chain +
code hash (this is why BaseScan's "TeraSwapOrderExecutor" label for the Base FeeCollector is wrong;
see `docs/DEPLOYMENTS.md`).

### Mainnet vs Base OrderExecutor — deliberate revision split
The mainnet OrderExecutor is the **`c22794c` revision**. Everything added to the file after it —
R12 progressive timelocks (`433b5d3`), the 48 h executor-change timelock / `proposeExecutor` set
(`9dc383d`), `setOracleConfig`/`oracleConfigs`, and the `receive()` restriction (`617b51f`) — exists
**on Base only** (`0x135B…2598`, 15,475 B). Those 11 selectors are absent from mainnet bytecode by
construction, not by accident. A mainnet redeploy would ship them; that is a deploy decision, not a drift.

## Sources that are NOT deployed (do not audit / deploy / reference)

| File | Status |
|------|--------|
| `contracts/TeraSwapFeeCollectorV2_DEPRECATED_flat.sol` (renamed 2026-07-02 from `TeraSwapFeeCollectorV2_flat.sol`) | **Stale pre-deploy candidate, never deployed** (W2-M-01). Lacks the deployed `minimumOutput`/`InsufficientOutput` floor; contains `setAllowedSelector`/`transferAdmin` which exist on **no** deployed contract (selector-verified on both chains). Source of the refuted W1-I-02 reading. Kept for git history only (rule #4); carries a ⛔ banner. |

CI enforces this section: `scripts/check-deployed-sources.mjs` (job `deployed-sources-guard`) fails
the build if the deprecated flat loses its banner, reappears under the old name, is imported by any
Solidity/TS/JS file, or is listed as a deployed source here.

[CHORE-AZ-SECURITY-BATCH C4] The same guard also covers the **weak V1 flatten**
(`contracts/TeraSwapFeeCollector_flat.sol`). Unlike the row above it IS a deployed source — the
byte-proven source of the **frozen** mainnet V1 (`0x4dAE…58eD`) — but it is the OLD, WEAK
FeeCollector (1-arg constructor; no admin/whitelist/timelock/`minimumOutput`; open `receive()`) and
must **never be deployed again**: the guard fails if it loses its ⛔ DO-NOT-DEPLOY banner, is deleted
(rule #4), is referenced by Solidity/TS/JS code, or if `contracts/DEPLOY.md` stops prescribing the
canonical V2 recipe (`contracts/TeraSwapFeeCollector.sol`, solc 0.8.28, via-IR, 2-arg constructor)
or mentions the V1 flat outside a ⛔ warning line.

## How to re-verify (any time)

One-liner per contract (compare the printed hash with the table; metadata + immutables caveat above):

```sh
cast keccak $(cast code 0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459 --rpc-url https://ethereum-rpc.publicnode.com)
# vs the artifact:  cd contracts && forge build && forge inspect TeraSwapFeeCollector.sol:TeraSwapFeeCollector deployed-bytecode | cast keccak
```

Full automated check (all 5 rows: hash pin + selector audit + byte-compare where the recipe applies):

```sh
cd contracts && forge build && cd order-engine && forge build && cd ../..
node scripts/verify-deployed-sources.mjs
```

## Follow-ups (owner)

1. **Mainnet FeeCollector V2 byte-exactness** — identity is already pinned (hash + on-chain solc
   0.8.28 + full selector set + W2's behavioral `InsufficientOutput` proof), but byte-exact
   reproduction from the current tree fails by ~80 B: the Remix deploy most likely resolved a
   different OpenZeppelin revision than the pinned submodule (evm-version and optimizer-runs
   matrices were exhausted: shanghai/paris/london/cancun × runs 1/200/1k/10k/1M all mismatch;
   via-IR is mandatory). The contract is **not** on Sourcify and the Etherscan v2 source API needs
   an API key. Action: pull the Etherscan **verified source + settings** for `0x47f2…7459` (it is
   the publicly attested byte-level match) and pin them here.
2. **BaseScan relabel** — re-verify Base `0xeFC3…f130` against `contracts/TeraSwapFeeCollector.sol`
   so the explorer name stops saying "TeraSwapOrderExecutor" (tracked in `docs/DEPLOYMENTS.md`).

---
*Provenance: T-SAF campaign 2026-07-01 — W0 recon baseline (hashes), W2 fund-flow (selector proof,
W2-M-01/W2-L-01, W1-I-02 refutation), AUDIT-W2-source-integrity remediation (this file, byte proofs,
2026-07-02). Spec: `docs/Prompts/AUDIT-W2-source-integrity.md`.*
