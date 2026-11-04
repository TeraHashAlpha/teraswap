# Feedback — feat/dependabot-auto-merge (5 signed commits, no PR, CI not run)

- [x] feedback first · [x] workflow+script · [x] fixtures · [x] runbook · [x] verify · [x] dry-run · [x] push

**1. Rules** (`scripts/dependabot/auto-merge-eligibility.mjs`; workflow = `pull_request_target`, base-sha sparse checkout, write scopes only on `act`)

| Rule | Auto only if | Review example |
|---|---|---|
| R1 | PR author + every commit `dependabot[bot]`; fetch-metadata (v3.1.0, SHA-pinned, verifies signatures) found ≥1 dep | human push, no metadata |
| R2 | every pkg semver patch/minor; **0.x minor = major** (unknown prev version → review) | major, 0.x minor, unknown |
| R3 | npm or github-actions, root `/`, only `package*.json` / `.github/{workflows,actions}/*.yml` | `contracts/**`, other dir/ecosystem |
| R4 | not deny-listed; npm only `direct:development` (runtime/indirect → review: `src/app/api` usage **not computable** without PR code → owner's fallback) | `viem`, `eslint-config-next`, `@wagmi/*`… |
| R5 | grouped PR = AND of the above | one bad member |
| R6 | repo var `DEPS_AUTO_MERGE` == `on` (unset = off, job skipped) | `off`/unset |

**2. Fixtures** `npx vitest run scripts/dependabot`: 1 file, **59/59** — all-pass 2 · R1 5 · R2 8 (+5 for 0.x) · R3 7 · R4 20 (all 15 deny entries) · R5 4 · R6 3 · CLI fail-closed 3 · sanitize 1 · workflow static 6 (SHA pins, no PR-head checkout, no `--admin`, writes only in `act`).
Full suite 405 files / **6482 pass** (+1 file, +59 tests vs the 6423 of the #648 base; baseline not re-run separately). Lint 93 warn / 0 err = baseline (delta 0; new files clean) · tsc clean · actionlint clean on the new file · product-claims / bash3 / agents-parity guards pass.

**3. Dry run** (read-only `gh`; input rebuilt from each commit's YAML — what fetch-metadata parses — not from the live action):

| PR | Bump | Verdict | Reason |
|---|---|---|---|
| #638 | follow-redirects 1.16.1→1.16.2 (contracts/order-engine, indirect) | review | R3 non-root dir, R4 indirect |
| #639 | eslint-config-next 16.4.2→16.4.3 (dev group, patch) | review | R4 deny-listed (was auto before owner rev.) |
| #640 | viem 2.57.3→2.57.11 | review | R4 deny-listed |
| #641 | next 16.4.2→16.4.3 | review | R4 deny-listed |
| #642 | framer-motion 12.36→12.43 (minor) | review | R4 runtime dep |
| #643 | @tanstack/react-query 5.104.5→5.105.0 | review | R4 deny-listed |

**4. Diff** vs origin/main: workflow +141 · script +182 · tests +272 · runbook +46 · `vitest.config.ts` +2 · this file. No change to dependabot.yml, branch protection, catalog auto-merge, or app code; no new deps.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/dependabot-auto-merge

## Feedback — P(dependabot-auto-merge)
### Edge case
- `vitest.config.ts` include had no `scripts/dependabot/**`; +1 line (config, not app code) or the fixtures never run in CI.
- fetch-metadata reports GitHub Actions as `direct:production` → dev/runtime split applies to npm only.
- Owner rev. 2026-11-04: `eslint-config-next` deny-listed (moves with `next`); 0.x minor = major. **No open PR (#638–#643) is now auto**; first auto candidate will be a non-deny-listed dev-dep or an action.
- Dry-run harness left `prevVersion` blank for #639 (group-PR message parse); verdict unaffected (deny-listed). Live fetch-metadata supplies it.
### Concern
- Workflow loads only from the default branch (`pull_request_target`): untested live until merged; first real run = the proof. Owner must tick "Allow auto-merge" and set `DEPS_AUTO_MERGE=on`; guard checks should be required first (see catalog runbook).
- Already-armed PRs stay armed when the switch goes off → `gh pr merge <n> --disable-auto` (runbook).
