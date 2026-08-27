# Feedback — fix/dca-chain-eligibility-in-code

Branch `fix/dca-chain-eligibility-in-code` off `origin/main` @ `6356c34`. Cause: **INC-2026-08-26-001**
(DCA live and reachable on Arbitrum One for 22 days on a chain with no keeper, because one Vercel env var
made `getOrderExecutorV3(42161)` non-null). DCA gate logic ⇒ **Auditor-gated, PR unmerged until 0C/0H.**

A parallel agent owns `Audits/Incidents/` (the incident file) and `docs/Prompts/`; neither was touched here,
so this PR carries no spec commit — the `/goal` text is the spec.

---

## Feedback — Task 1: eligibility becomes a code decision (`src/lib/order-engine/config.ts`)

### The chains in `ORDER_EXECUTOR_V3_BY_CHAIN`: what resolves non-null today, and what the repo says

Vercel cannot be read from this session (no `.env`, no server); "today" below is what the repo records plus
the facts stated in the `/goal`.

| chainId | env slot | Resolves non-null in Production today? | What the repo says |
|---|---|---|---|
| **1** (mainnet) | `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS` | **null** — nothing in the repo says the var is set, and the repo says it must not be | No v3 executor on mainnet. `docs/DEPLOYMENTS.md:13-15` and the `README.md` table list OrderExecutor **V3 on Base only** (mainnet has v2). `docs/Runbooks/V3-EXECUTOR-DEPLOY.md §8 "Mainnet (deferred template)"`: *"Deploy only if/when DCA activates on mainnet (currently Base-only, ADR-009)"*; §5 of the same runbook: do **not** set the mainnet variant unless deploying mainnet. `src/lib/dca-launch.ts` `DCA_CHAINS` deliberately excludes 1; `src/lib/order-engine/limit-launch.ts` `LIMIT_TP_CHAIN_ID = 8453` only ("mainnet/Arbitrum are out of scope"). No Foundry broadcast for chain 1 anywhere. |
| **8453** (Base) | `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE` | **non-null — LIVE** | `docs/DEPLOYMENTS.md:15`: OrderExecutor V3 **LIVE** (cutover 2026-07-21); README table; ADR-014 "deployed and live on Base". Every keeper runbook configures the keeper for this chain: `EC2-EXECUTOR-HOST.md:50`, `AWS-KMS-EXECUTOR-SETUP.md:73`, `BASE-DCA-GOLIVE.md:23` (`CHAIN_ID=8453`). `DCAPanel.chain-availability.test.tsx` already models "8453 non-null, every other chain null". |
| **42161** (Arbitrum One) | `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM` | **null since 2026-08-26** (var re-scoped to Development only — `/goal`); **non-null from 2026-08-04 to 08-26** — the incident | The repo *records* **no** Arbitrum V3 deployment: no `docs/DEPLOYMENTS.md` row; `Audits/Sprint/AUDIT-ARBITRUM-V3-PREDEPLOY.md` is a *pre-deploy* gate; `docs/Runbooks/ARBITRUM-V3-EXECUTOR-DEPLOY.md:11` states the keeper is single-chain (Base-only); `docs/Prompts/SPRINT-KEEPER-MULTICHAIN-ARBITRUM.md` is the unshipped keeper blocker. **No keeper polls 42161.** ⚠️ But one *was* deployed on 2026-08-04 and the repo never recorded it — see **Concern → Deployment record vs. reality**. Ineligibility rests on the keeper (condition 2), not on the contract's absence. |

**Allowlist chosen: `ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS = [8453]`.** The repo settles all three chains — Base is
the only one with a deployed + verified V3 **and** a keeper that polls it — so the STOP condition was not hit.

### Confirmation that no chain's behaviour changed

- **8453** — eligible. `getOrderExecutorV3(8453)` returns exactly what it returned before: the env slot when set,
  `null` when unset. The documented rollback (`V3-EXECUTOR-DEPLOY.md` — unset the Vercel var) still works: env
  keeps the power to disable.
- **1** — per the repo the var is unset in Production ⇒ `null` before and after. If the var *were* set, this PR
  would null it — that is the intended semantic (env cannot enable), and the repo says there is no mainnet V3 for
  it to point at. Owner can confirm the premise with `vercel env ls` (Production) before merge.
- **42161** — `null` in Production today (var re-scoped 2026-08-26) ⇒ `null` before and after. Had the var still
  been scoped All Environments, this change alone would have closed the incident.
- **No chain gains capability.** `ORDER_EXECUTOR_V3_BY_CHAIN` is unchanged as the raw env view (same static
  `process.env.NEXT_PUBLIC_*` reads, so Next.js client inlining is unaffected); the duplicate-address module-load
  invariant is unchanged and still checks the raw map; `getOrderExecutorV3Domain`, `resolveSigningExecutor`,
  `isDcaLive`, `isLimitLive`, `DCAPanel` `v3Enabled`, `useOrderEngine`, `/api/orders` all read through
  `getOrderExecutorV3`, so the allowlist applies to every v3 consumer with no per-consumer change.
- Server side, by construction: `src/app/api/orders/route.ts:299` resolves the v3 executor via
  `getOrderExecutorV3`, so a direct POST of a v3 order for a non-eligible chain now lands in the existing
  fail-closed `!executorAddress` branch. The incident's "direct POST for 42161 was NOT tested" unknown is closed by
  construction — but **not pinned by a test in this PR** (see Test gap).

### What it takes to add a chain (documented in `config.ts` beside the allowlist)

1. A `TeraSwapOrderExecutorV3` **deployed + verified** on that chain — runbook run end to end, Foundry verifier
   passed, explorer source-verified, row in `docs/DEPLOYMENTS.md`.
2. A keeper instance that **actually polls that chain id**. The keeper scopes its active-orders query by
   `(status, chain_id)` — `contracts/order-engine/schema.sql:125` and `executor.js`
   `orders?status=eq.active&chain_id=eq.${CHAIN_ID}` — so a chain with no keeper accepts orders nobody executes.
   `executor.js` is single-chain: a new chain means a new keeper instance, boot-gated by `chain-verify.js`.
3. Only then the env slot + Production var. Removing an id is the code-level kill-switch; unsetting the var is the
   ops-level one.

---

## Feedback — Task 2: `src/app/page.arbitrum-dark.test.tsx`

- Both unset cases kept. **Both** renamed (the prompt asked for the second): the first was named *"today's real
  defaults (both Arbitrum vars unset)"* — the same claim about the world as the second, and equally false in
  Production. Each name now states which of the three variables it holds SET / UNSET.
- Added the missing case: **all three SET** (`NEXT_PUBLIC_DCA_ENABLED`, `NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR`,
  `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM`) — the Production shape 2026-08-04 → 08-26 — with sanity
  assertions that the env genuinely reached the *real* modules (`isChainActive(42161) === true`, raw v3 slot
  populated) so it cannot pass vacuously. Renders the `Soon` teaser, `<DCAPanel>` never mounts.
- Added a **positive control** on Base (all three Base vars SET ⇒ tab enabled, `<DCAPanel>` mounts — awaited with
  `findByTestId`, `next/dynamic`), so the negative assertions are proven non-vacuous.
- Static `import Home from './page'` replaced by a fresh dynamic import per case: the chain registry and the
  order-engine config read env at module load, so a static import pinned every case to the first load's env.
- **Fails against today's `main` — verified**, not assumed: with `config.ts`/`index.ts` stashed back to main and
  the tests kept, `AssertionError: expected '0x5555…' to be null` at `page.arbitrum-dark.test.tsx:150` (1 of 4
  cases fails; the Base positive control passes on main, as it should).

## Feedback — Task 3: data-driven guard (`src/lib/order-engine/config.test.ts`)

- New block `getOrderExecutorV3 — ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS gates EVERY env slot`, driven off
  `Object.keys(ORDER_EXECUTOR_V3_BY_CHAIN)`: for every chain **not** on the allowlist, its env var is stubbed to
  a syntactically valid address and `getOrderExecutorV3` must stay `null` (plus domain throws, v3 signing executor
  null); for every chain **on** it, set ⇒ resolves, unset ⇒ null; and an all-slots-set-at-once case.
- The chainId → env-var-name table lives in the test (not `config.ts`): mainnet's var has no suffix so it isn't
  derivable, and `process.env[name]` cannot be dynamic in the client bundle (Next.js inlines only static
  `process.env.NEXT_PUBLIC_*`). A **key-set pin** fails the day a chain is added to the map without a row in the
  table, and each `it.each` case first asserts the raw slot reflects the stub — so the table is validated against
  reality, and a new chain is covered the day it is added.
- An explicit pin `expect([...ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS]).toEqual([8453])` makes any change to the
  allowlist touch a test — the Auditor sees it.
- Against main the file fails at collection (`TypeError: Cannot read properties of undefined (reading
  'includes')`, `config.test.ts:426`) because the allowlist export does not exist there.

---

## Edge cases not covered by the prompt

- **`src/lib/dca-launch.arbitrum-activation.test.ts`** (not in the prompt's file list) *specified the defect*
  verbatim: `'ALL FOUR real conditions satisfied … ⇒ isDcaLive(42161) is true'`, two Arbitrum cases whose sanity
  assertions require `getOrderExecutorV3(42161)` non-null, and a mainnet case requiring `getOrderExecutorV3(1)`
  non-null. All four would fail with Task 1 (CI must be green, rule #11), so the block was rewritten to pin the
  Production shape as *dark*, with a Base positive control and three real-module single-term falsifications on
  Base (the only chain where the v3 term can now be true), and the mainnet case asserting both layers (config
  eligibility + `DCA_CHAINS`). Block 1 (unset state) untouched. Against main: `expected '0x5555…' to be null`
  (`:131`) and `expected '0x3333…' to be null` (`:176`).
- **`config.test.ts` "once configured (env override)"** block used **mainnet** as the configured chain; moved to
  Base. The "distinct addresses per chain" case now also asserts mainnet's populated slot resolves `null`.
- **`src/lib/order-engine/index.ts`** barrel: two new exports (`ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS`,
  `isOrderExecutorV3EligibleChain`) so consumers/tests reach them via `@/lib/order-engine`.
- **`src/lib/dca-launch.ts` `DCA_CHAINS` still lists 42161**, and its comment (lines 28-30) now gives the wrong
  reason for Arbitrum being dark ("Arbitrum's v3 slot is unset"). Deliberately untouched — out of scope, harmless
  (the config gate is upstream), and the parallel incident agent may cite it as-is. Architect: either drop 42161
  from `DCA_CHAINS` or re-comment it; two allowlists that disagree will mislead the next reader.
- `config.ts:63`'s *"no OrderExecutorV3 is deployed on Arbitrum yet"* was replaced by a pointer to
  `docs/DEPLOYMENTS.md`; the new comments cite repo documents instead of asserting present-day state.

## Concern

- **Deployment record vs. reality — RESOLVED, and worse than assumed (read 2026-08-26, second pass).** The earlier
  pass observed only the directory name of the owner's *untracked* `contracts/order-engine/broadcast/`
  `DeployOrderExecutorV3.s.sol/42161/`. It has now been read. It is **not** a dry run: `run-latest.json` records a
  `CREATE` of `TeraSwapOrderExecutorV3` with a real tx hash
  (`0x0792a2528f033215994b67afe6607dd3688a817973107ce759b946b87d13cb1a`), receipt `status: 0x1`, block
  `0x1d433dec` (490946028), **timestamp 2026-08-04 07:43 UTC**. An Arbitrum OrderExecutorV3 was really deployed.
  Three consequences the Auditor should weigh:
  1. **The incident was not a stray variable.** The deploy and the Vercel var landed on the *same day*
     (2026-08-04). The sequence was deploy → wire into Production → no keeper, not an accidental env edit. What was
     missing was never the contract; it was the decision and the executor. This is the strongest argument for the
     change in this PR: step 1 of the "to add a chain" checklist was arguably met and DCA *still* must not have
     lit up, because steps 2 and 3 were not.
  2. **The deployed address collides with a live mainnet fund-path contract.** It is
     `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` — byte-identical to the **mainnet FeeCollector V2**
     (`docs/DEPLOYMENTS.md:10`, `.env.example:62`, `NEXT_PUBLIC_FEE_COLLECTOR` default in `constants.ts`), by
     deployer-nonce alignment. It is also the exact address a Base OrderExecutor deploy was **abandoned** on for
     this same collision (`docs/DEPLOYMENTS.md:14`: *"collided w/ mainnet FeeCollector addr — abandoned,
     unbootstrapped, do not use"*). The repo's own standing warning is *"always qualify by chain"*
     (`docs/DEPLOYMENTS.md:20`). Recommend the Arbitrum V3 be treated as **abandoned on the same precedent**
     rather than allowlisted later — a chain-qualified mistake here misroutes against a live mainnet fee contract.
  3. **`docs/DEPLOYMENTS.md` has no row for it**, and neither the broadcast nor a verification record is committed
     (nothing was committed here either — this PR does not add the artifact; it only reports it). Until it is
     reconciled, "no Arbitrum V3 deployment" is a claim the repo *implies* and reality contradicts — the same
     failure mode as the stale `config.ts` comment this PR removed.

  **None of this changes the allowlist.** 42161 fails eligibility condition **2** (no keeper polls it —
  `executor.js:569` is `chain_id=eq.${CHAIN_ID}`, single-chain, `CHAIN_ID=8453` in every keeper runbook) and
  condition **3**, independently of whether a contract exists. `ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS = [8453]` stands.
- **Memory/prior notes are stale on CI shape:** `.github/workflows/ci.yml:435-454` now runs the *whole* vitest
  suite (coverage floor 220 files), so no per-file guard job is needed for these tests to be gated.

## Test gap

- No test posts a v3 order for a non-eligible chain to `/api/orders`. The path is closed by construction
  (`route.ts:299` → `getOrderExecutorV3`) but not pinned; suggest one case in `orders-v3.test.ts`.
- `useOrderEngine.ts:404`, `LimitOrderPanel.tsx:428`, `ConditionalOrderPanel.tsx:337`,
  `settlement-receipt.ts:387` are covered only transitively through `getOrderExecutorV3`.

---

## Verification

- **RED** (tests written first, `config.ts` untouched): 5 failed / 10 passed across the 3 files — page
  Production-shape case `expected '0x5555…' to be null`; activation Arbitrum + mainnet cases the same shape;
  `config.test.ts` collection `TypeError` on the missing export.
- **GREEN** (allowlist in place): `vitest run` on the 3 files — **3 files, 67 tests passed**.
- **Proof against main** (config.ts + index.ts stashed, tests kept): 4 failed / 11 passed — details per task above.
- `tsc --noEmit`: clean. `eslint` on the 5 changed files: clean.
- **Full vitest suite** (`CI=true npx vitest run`, the same whole-suite invocation as `ci.yml`): **227 test
  files passed, 3258 tests passed, 0 failed.**

### Independent re-verification (second pass, same worktree, before push)

Re-run from scratch rather than taken on trust from the notes above:

- **GREEN** — `CI=true npx vitest run` on the three files: **3 files, 67 tests passed, 0 failed.** ✔ matches.
- **RED against `origin/main`** — `config.ts` + `index.ts` checked out from `origin/main`, tests kept, re-run:
  **3 files failed, 4 tests failed / 11 passed** ✔ matches. Exact failures:
  - `page.arbitrum-dark.test.tsx` → Production-shape case: `AssertionError: expected '0x5555…' to be null`.
  - `dca-launch.arbitrum-activation.test.ts` → Arbitrum Production-shape case: `expected '0x5555…' to be null`;
    mainnet case: `expected '0x3333…' to be null`; Base positive control:
    `TypeError: Cannot read properties of undefined (reading 'includes')` (the allowlist export is absent on
    `main`) — **three** failures in this file, not the two listed in the edge-case note above.
  - `config.test.ts` → fails at *collection* with the same `TypeError`.
  Both files were restored from `HEAD` afterwards; `git status` clean, tree byte-identical to the commit.
- Repo claims behind the allowlist re-checked at source, not from the notes: `docs/DEPLOYMENTS.md:15` (V3 LIVE on
  Base) and the absence of any V3 row for chain 1 or 42161; `contracts/order-engine/executor/executor.js:569`
  (`orders?status=eq.active&chain_id=eq.${CHAIN_ID}`) and `:40` ("One keeper" per chain id);
  `contracts/order-engine/schema.sql:125` (`idx_orders_chain_status`); `CHAIN_ID=8453` in
  `EC2-EXECUTOR-HOST.md:50`, `AWS-KMS-EXECUTOR-SETUP.md:73`, `BASE-DCA-GOLIVE.md:23`. All hold.
