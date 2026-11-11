## What / why
<!-- One paragraph: what changed and why. Link the spec/goal (docs/Prompts/...) or finding id. -->

## Evidence
<!-- Paste the EVIDENCE block printed by `scripts/agent-verify.sh` (add --codeql / --keeper when relevant). Do not retype numbers. -->
```
=== EVIDENCE ===
...
=== END EVIDENCE ===
```

## Auditor required?
<!-- docs/Prompts/_PROMPT-TEMPLATE.md §2. Tick exactly one. Fund-flow / gate / signer / contract PRs stay UNMERGED until the Auditor's last line is `VERDICT: 0C/0H → approved`. -->
- [ ] **Yes** — fund-flow, gate, signer, keeper, contract or security-sensitive. Auditor report / verdict: <!-- link or paste the VERDICT line -->
- [ ] **Note only** — gate-adjacent and strictly tightening (rides a future review)
- [ ] **No** — display, docs, read-only or frontend-only

## Feedback
<!-- Per-PR feedback file (CLAUDE.md "Code Agent Feedback Convention"): docs/feedback/<branch>.md -->
Path: `docs/feedback/<branch>.md`

## Checklist
- [ ] All commits SSH-signed (noreply committer)
- [ ] CI green before merge (the owner opens the PR; agents never open or merge one)
