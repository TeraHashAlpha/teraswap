# CHORE-AZ-SECURITY-BATCH — EIP-712 dedup + ignore-scripts + stablecoin constant + DEPLOY.md banner

> **Source:** A-Z review v2 (PR #268), top-of-RICE security/correctness items. Four **independent, droppable** commits
> (one per item). Mostly docs/config/dedup — **no execution-gate or on-chain change** — but items 1 & 3 are
> correctness/fund-flow-adjacent, so they carry equivalence tests and a "flag if drift" rule. SSH-signed (noreply
> committer). Separate commits so any one can be dropped.

## Commit 1 — dedup the twice-declared EIP-712 order types (fund-flow-adjacent)
The EIP-712 order types are declared **twice** (`order-engine/types.ts:37` + `orders/route.ts:30`); drift silently
breaks order signature recovery. **First verify the two declarations are byte-identical** (domain, types, field order).
- If **identical:** make `order-engine/types.ts` the single source, import it in `orders/route.ts`, remove the
  duplicate. Add a test that locks the typed-data hash of a known fixed order (asserting the post-dedup hash equals the
  pre-dedup hash — no behaviour change).
- If they have **already drifted:** do NOT blindly merge — **STOP and flag in FEEDBACK** (a live signature-recovery bug
  exists) for the Auditor; propose which declaration is the correct/deployed one but don't guess-fix.

## Commit 2 — revert the unnecessary `--ignore-scripts=false` (near-free security)
`.npmrc` sets `ignore-scripts=true`, but the CI jobs run `npm ci --ignore-scripts=false`, justified by a Prisma
`postinstall` that **does not exist** (0 occurrences in the lockfile). Remove the `--ignore-scripts=false` override from
**every** CI job/workflow (and any package script) so installs honour `ignore-scripts=true`. **Verify** nothing
legitimately needs an install lifecycle script: confirm no Prisma, and that `npm ci` + build + the test jobs still pass
with scripts ignored. If some dep genuinely needs a script (e.g. a native rebuild), do NOT force it — document the one
exception in FEEDBACK and scope the override to just that.

## Commit 3 — one chain-keyed stablecoin constant (correctness, not style)
There are **6 divergent stablecoin lists** (SlippageModal, 2× SwapBox, useSplitRoute, chains/tokens) — e.g. **USDbC
counts as ~$1 in one gate but not another**. Consolidate into **one source of truth, keyed by chainId** (mainnet:
USDC/USDT/DAI/…; Base: USDbC/USDC/…). Because the 6 lists diverged, consolidating **will change some gate's behaviour**
— so: enumerate the 6 lists + their diffs, determine the **correct canonical set per chain**, wire all call sites to
it, and **document in FEEDBACK which gates change behaviour and why the new value is correct** (e.g. USDbC must be a $1
stable on Base everywhere). Add a test asserting the per-chain set. If any list's exclusion looks intentional/unclear,
flag it rather than silently absorbing it.

## Commit 4 — banner the weak flat contract + fix DEPLOY.md + extend the guard
`TeraSwapFeeCollector_flat.sol` + `DEPLOY.md` still instruct deploying an **old, weaker** FeeCollector (1-arg
constructor; no admin/timelock/whitelist/minimumOutput; open `receive()`), with **no ⛔ banner** (unlike the exemplary
`..._V2_DEPRECATED_flat.sol`). Someone following `DEPLOY.md` deploys the wrong contract on the next deploy (Base OE /
V3). Fix (rule #4 — do **not** delete): add a ⛔ `DEPRECATED — DO NOT DEPLOY` banner to the flat file pointing to the
correct current source (cross-check `docs/security/DEPLOYED-SOURCES.md` from W2/#254); correct `DEPLOY.md` to reference
the correct contract + recipe; and **extend the `deployed-sources-guard` CI job** to cover this file so a stale/weak
deploy target can't slip back in.

## Do NOT
- No execution-gate / SC-04 / R1 / on-chain / contract-bytecode change. Don't guess-fix a drifted EIP-712 (flag it).
- Don't delete the flat file (banner it). Don't silently change a stablecoin gate without documenting it. Don't force
  `--ignore-scripts=false` for a script that isn't actually needed.

## Files affected (verify on main)
- 1: `order-engine/types.ts`, `orders/route.ts`, + a typed-data-hash test. 2: `.npmrc`, the CI workflow YAMLs. 3: a new
  chain-keyed stablecoin constant + SlippageModal / SwapBox (2×) / useSplitRoute / chains/tokens + a test. 4:
  `TeraSwapFeeCollector_flat.sol` (banner), `DEPLOY.md`, `deployed-sources-guard` (extend), read `DEPLOYED-SOURCES.md`.

## Expected output
- Branch `chore/az-security-batch` off latest `origin/main`; SSH-signed; CI green. Four independent commits. FEEDBACK
  per item: EIP-712 identical-or-drifted verdict + the hash-equivalence test; the ignore-scripts confirmation (+ any
  exception); the stablecoin per-chain canonical set + which gates changed behaviour; the DEPLOY.md/banner/guard change.

## Quality criteria
EIP-712 types are single-sourced (or the drift is flagged for the Auditor) with a hash-equivalence lock; installs
honour `ignore-scripts=true`; stablecoin membership is single-sourced + chain-correct with behaviour changes
documented; the weak flat contract is bannered + out of `DEPLOY.md` + guarded; nothing deleted; no gate/contract change.

---

### `/goal` paste for the Code Agent (≤4000)
```
CHORE-AZ-SECURITY-BATCH per docs/Prompts/CHORE-AZ-SECURITY-BATCH.md. Branch
chore/az-security-batch off origin/main, SSH-signed (noreply committer), CI green,
FOUR independent droppable commits. No execution-gate/SC-04/R1/on-chain/contract-
bytecode change. Items 1 & 3 are correctness/fund-flow-adjacent -> equivalence
tests + "flag if drift".

Commit 1 — EIP-712 dedup: order types are declared twice (order-engine/types.ts:37
+ orders/route.ts:30); drift breaks signature recovery. FIRST verify the two are
byte-identical (domain, types, field order). If identical: make
order-engine/types.ts the single source, import it in orders/route.ts, remove the
dup, add a test locking a known order's typed-data hash (post==pre, no behaviour
change). If already DRIFTED: STOP + flag in FEEDBACK for the Auditor (live
signature-recovery bug) — don't guess-fix.

Commit 2 — revert --ignore-scripts=false: .npmrc has ignore-scripts=true but CI
runs npm ci --ignore-scripts=false for a Prisma postinstall that DOESN'T exist (0
in lockfile). Remove the override from EVERY CI job/workflow so installs honour
ignore-scripts=true. Verify npm ci + build + tests still pass with scripts ignored;
if some dep genuinely needs a script, document the one exception + scope the
override to just it.

Commit 3 — one chain-keyed stablecoin constant: 6 divergent stablecoin lists
(SlippageModal, 2x SwapBox, useSplitRoute, chains/tokens) — USDbC counts as ~$1 in
one gate not another. Consolidate into ONE source keyed by chainId (mainnet
USDC/USDT/DAI; Base USDbC/USDC...). Consolidating WILL change some gate behaviour:
enumerate the 6 lists + diffs, pick the correct canonical set per chain, wire all
call sites, add a per-chain test, and DOCUMENT in FEEDBACK which gates change + why
correct. Flag any exclusion that looks intentional.

Commit 4 — banner weak flat + fix DEPLOY.md + extend guard:
TeraSwapFeeCollector_flat.sol + DEPLOY.md still instruct deploying an OLD weak
FeeCollector (1-arg ctor; no admin/timelock/whitelist/minimumOutput; open
receive()) with NO banner. Add a ⛔ DEPRECATED-DO-NOT-DEPLOY banner (rule #4, don't
delete) pointing to the correct source (cross-check docs/security/DEPLOYED-
SOURCES.md), fix DEPLOY.md to the correct contract+recipe, and EXTEND the
deployed-sources-guard CI to cover this file.

Do NOT: execution-gate/SC-04/R1/on-chain/contract change; guess-fix a drifted
EIP-712; delete the flat file; silently change a stablecoin gate; force
--ignore-scripts=false for a script that isn't needed.

FEEDBACK per item: EIP-712 identical-or-drifted verdict + hash test; ignore-scripts
confirmation (+ any exception); stablecoin per-chain set + gates changed; DEPLOY.md/
banner/guard change.
```
