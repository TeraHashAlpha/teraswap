# SPRINT-V3-P4-DEPLOY — v3 deploy runbook + scripts + verification (deploy itself = manual, owner-executed)

> **Source:** ADR-013 deploy plan (steps 1–6) — the final leg of the v3 arc. Preconditions ALL MET: V3-P1 merged
> (audited 0C/0H), #298 L-01/L-02 merged (delta 0C/0H), #299 P2 merged (0C/0H), #301 P3 (M-01 fix + v3 cancel
> single/mass) open Auditor-noted. This sprint produces the **runbook + deploy/verification scripts ONLY** — the
> Code Agent deploys NOTHING. After this PR is up, the Architect issues the **mandatory pre-deploy Auditor pass**
> (covers the #301 delta + this runbook/scripts + final repo state); **0C/0H = the owner is authorized to execute
> the runbook manually, Base first.** SSH-signed; branch `sprint/v3-p4-deploy` off latest `origin/main`
> (post-#301 merge) in a dedicated worktree; 3 droppable commits.

## Requirements (per-commit)

### 1. `docs/Runbooks/V3-EXECUTOR-DEPLOY.md` — per-chain runbook (Base 8453 first; mainnet section = deferred template)
Mirror the structure/rigor of the existing Base deploy + KMS runbooks. Sections, in execution order:
- **Pre-flight gate:** #301 merged; pre-deploy Auditor pass 0C/0H recorded; v3 cancel support live in prod build;
  Phase-0 `order-floor.js` + `submission-policy.js` confirmed ACTIVE (they stay on until v3 is live on every DCA
  chain); Base OrderExecutor v2 address + outstanding-order count snapshot.
- **Deploy:** Foundry script invocation (env names only, NEVER values); constructor/config params explicit —
  **owner = the 48h timelock**, `MAX_ORDER_SLIPPAGE_BPS` compiled 500, router whitelist = Base Augustus **V6,
  address re-verified on-chain at deploy time** (record the check; the Sprint-46 lesson: labels lie — verify
  bytecode/explorer, cite in the runbook), sequencer uptime feed set.
- **Verify:** source verification on BaseScan + the **mislabel precedent check** (BaseScan showed our FeeCollector
  as "OrderExecutor" — confirm the new contract displays correctly; if mislabeled, document the support path).
- **Oracle config:** queue token→feed sets through the timelock; the 48h wait is an explicit runbook step with a
  scheduled-check reminder; execute after the window; verifier script (below) must pass before proceeding.
- **Cutover:** set `ORDER_EXECUTOR_V3` (+ `NEXT_PUBLIC_*`) for Base in Vercel + keeper env; keeper picks up dual
  routing (v2 drains, v3 takes new orders — no new v2 orders once v3 signing is live); **e2e smoke = one tiny
  real DCA order end-to-end: create → first fill above floor → single cancel → mass-cancel path check.**
- **Rollback:** unset the v3 env (fail-closed back to v2-only signing — safe at any point before real v3 orders
  exist; after that, rollback = stop new v3 signing, keeper keeps executing/cancelling existing v3), plus the
  incident-record step (INC- append-only).
- **v2 drain policy:** v2 executes existing orders until drained/cancelled/expired; monitoring both executors;
  criteria for retiring the Phase-0 keeper floor (v3 live on EVERY DCA chain — not before).
- **Mainnet (deferred):** template with the deltas (Flashbots relay, Augustus V5, no sequencer feed) — deploy only
  if/when DCA activates on mainnet, per the L2-only decision.

### 2. Deploy + verification scripts
- Foundry deploy script (params from env by NAME; refuses to run with `ALLOW_PLAINTEXT_KEY`; chain-id assert).
- **Read-only post-deploy verifier** (script the owner runs at each runbook checkpoint): asserts on-chain that
  owner == timelock, cap == 500, router whitelist == the verified V6 address and nothing else, oracle feeds
  answer (fresh round, expected decimals), sequencer feed configured, `paused`/init state sane, and the EIP-712
  domain (chainId, verifyingContract) matches the frontend config. Exit non-zero on any mismatch.
- Nothing in scripts embeds an address that the runbook says must be re-verified — they take it as input and
  CHECK it.

### 3. Docs cross-wiring
ADR-013: append the deploy-plan status note (P1–P3 shipped, runbook ref). `docs/Prompts/SPRINT-V3-P4-DEPLOY.md`
committed. Keeper runbook cross-link (BASE-ORDEREXECUTOR-DEPLOY.md ↔ V3-EXECUTOR-DEPLOY.md).

## Do NOT
Deploy, simulate-with-real-keys, or touch any live env; no secrets or real key material anywhere (env NAMES
only); no contract changes; no frontend/keeper logic changes (config names only); do not weaken Phase-0.

## Files affected (read ONLY these + new)
**New:** `docs/Runbooks/V3-EXECUTOR-DEPLOY.md`, deploy/verifier scripts under `contracts/order-engine/script/`
(or the repo's existing script dir), `docs/Prompts/SPRINT-V3-P4-DEPLOY.md`. **Edit:** ADR-013 (status note).
**Read-only:** `TeraSwapOrderExecutorV3.sol`, existing Base/KMS runbooks, `src/lib/chains/**`, keeper env docs,
the #296/#298/#299/#301 audit reviews.

## Expected output
Branch + PR, CI green (push + report, don't poll). FEEDBACK ≤1 screen: runbook step list, verifier assertions
list, any discovered blocker for the Base deploy. **Then the Architect issues the pre-deploy Auditor pass — the
deploy is NOT authorized by this PR.**

---

### `/goal` paste for the Code Agent (≤4000)
```
CONTROL: model Sonnet · effort medium · NO CI-poll (push + report, don't watch) · read ONLY the listed files · FEEDBACK <= 1 screen.

SPRINT-V3-P4-DEPLOY per docs/Prompts/SPRINT-V3-P4-DEPLOY.md (commit the spec in this PR). Branch sprint/v3-p4-deploy off origin/main (post-#301 merge) in a DEDICATED worktree, SSH-signed, CI green. RUNBOOK + SCRIPTS ONLY — deploy NOTHING, touch NO live env, NO secrets/keys (env NAMES only). After this PR, the Architect issues the mandatory pre-deploy Auditor pass; deploy is NOT authorized by this PR.

Commits (droppable, in order):
1. docs/Runbooks/V3-EXECUTOR-DEPLOY.md (Base 8453 first; mainnet = deferred template with deltas: Flashbots relay, Augustus V5, no sequencer feed). Mirror the Base/KMS runbook rigor. Order: PRE-FLIGHT (#301 merged; pre-deploy audit 0C/0H recorded; v3 cancel live in prod build; Phase-0 order-floor.js + submission-policy.js confirmed ACTIVE — they stay until v3 live on EVERY DCA chain; v2 address + outstanding-order snapshot) -> DEPLOY (Foundry script, params explicit: owner = the 48h timelock, cap compiled 500, router whitelist = Base Augustus V6 RE-VERIFIED ON-CHAIN at deploy time — the Sprint-46 lesson: labels lie, verify bytecode/explorer and record the check; sequencer uptime feed set) -> VERIFY (BaseScan source verification + the mislabel precedent check: our FeeCollector shows as "OrderExecutor" there — confirm correct display, document the support path if not) -> ORACLE CONFIG (queue token->feed sets through the timelock; explicit 48h-wait step + reminder; execute; verifier must pass) -> CUTOVER (set ORDER_EXECUTOR_V3 + NEXT_PUBLIC_* for Base in Vercel + keeper env; v2 drains, v3 takes new orders, no new v2 orders once v3 signing live; e2e smoke = one tiny REAL DCA order: create -> first fill above floor -> single cancel -> mass-cancel path check) -> ROLLBACK (unset v3 env = fail-closed to v2-only signing, safe before real v3 orders exist; after: stop new v3 signing, keeper keeps executing/cancelling existing v3; INC- append-only record) -> V2 DRAIN POLICY (monitor both executors; Phase-0 floor retirement criteria = v3 live on every DCA chain, not before).
2. Scripts in the repo's contract script dir: (a) Foundry deploy script — params from env by NAME, refuses ALLOW_PLAINTEXT_KEY, chain-id assert; (b) READ-ONLY post-deploy verifier the owner runs at each checkpoint — asserts on-chain: owner==timelock, cap==500, router whitelist == the verified V6 address and NOTHING else, oracle feeds answer (fresh round, expected decimals), sequencer feed configured, init/pause state sane, EIP-712 domain (chainId, verifyingContract) matches frontend config; non-zero exit on any mismatch. Scripts NEVER embed addresses the runbook says to re-verify — take as input and CHECK.
3. Docs wiring: ADR-013 deploy-plan status note (P1-P3 shipped, runbook ref); cross-link BASE-ORDEREXECUTOR-DEPLOY.md <-> V3-EXECUTOR-DEPLOY.md; spec committed.

Do NOT: deploy or simulate with real keys; touch live envs; secrets anywhere; contract changes; frontend/keeper logic changes (config names only); weaken Phase-0.

Files: NEW docs/Runbooks/V3-EXECUTOR-DEPLOY.md + scripts under contracts/order-engine/script/ + docs/Prompts/SPRINT-V3-P4-DEPLOY.md; EDIT docs/ADR/ADR-013 (status note). Read-only: TeraSwapOrderExecutorV3.sol, existing Base/KMS runbooks, src/lib/chains/**, keeper env docs, the #296/#298/#299/#301 audit reviews.

Expected: PR open, CI green (push + report). FEEDBACK <=1 screen: runbook step list, verifier assertion list, any Base-deploy blocker discovered.
```
