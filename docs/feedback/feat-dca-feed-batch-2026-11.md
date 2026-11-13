# feat/dca-feed-batch-2026-11 — FEEDBACK (no PR, NO tx, no key; Draft PR + Auditor required)

Checklist (ticked as work lands; the evidence sections below replace this list at the end):
- [x] Premise check on-chain and against the directory, wstETH included
- [x] Commit 1: batch tool + fixture tests + batch-1 config
- [ ] Commit 2: what the mirror changes + pinned tests + keeper mirror data (owner answer 2026-11-13)
- [ ] Commit 3: runbook "Monthly batch"
- [ ] Verify: plan.ts table, agent-verify --codeql --keeper, gen-claude-state --check
- [ ] Push, compare link

Owner answer 2026-11-13 (asked once): "enabled: true" and "no keeper change" cannot both hold, because the keeper drift guard
(`contracts/order-engine/executor/price-sources.test.mjs`) requires the keeper Chainlink mirror to equal every enabled row.
Answer: **allow the keeper mirror DATA** (eight Base entries copied from the config, drift guard untouched), add `--keeper` to verify.
