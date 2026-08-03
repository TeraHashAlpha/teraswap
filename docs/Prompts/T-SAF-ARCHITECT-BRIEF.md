# BRIEF — Auditor → Architect: operationalize T-SAF into sprint packets

**From:** Auditor (independent). **To:** Architect. **Re:** turn the T-SAF framework into executable
sprints + Code-Agent prompts. **Source of truth:** `docs/security/TERASWAP-AUDIT-FRAMEWORK.md` (T-SAF v1).
**Language:** this brief is EN (audit corpus); your *design output* stays PT-PT, your *Code-Agent prompts*
are EN (CLAUDE.md conventions). **Binding:** CLAUDE.md 12 "Do NOT" rules, `AUDITOR-ROLE.md`, rules #1/#2/#3.

---

## 0. Role separation (read first — this is the crux)
The audit itself is **read-only adversarial review** and stays with the **Auditor** — do NOT ask the Code
Agent to "audit". The Code Agent's job in this campaign is only to build the **repeatable harness** that
makes the audit reproducible, and later to implement **remediations**. So there are three distinct outputs:
1. **Architect (you):** sprint plan + Code-Agent prompts (this brief).
2. **Code Agent:** implements the harness (invariant/fuzz/negative-path tests, Slither/semgrep config,
   on-chain verification scripts, CI wiring) and, later, the remediations the Auditor files.
3. **Auditor:** runs the adversarial review per wave, files findings, signs off (0C/0H), gates deploys.
A harness prompt ADDS tests/tooling/config; it must NOT change production logic, weaken a gate, or touch
contract/gate/fund-flow **source** (those are remediations, and each needs an Auditor pass — rules #2/#3).

## 1. Objective
Convert T-SAF's 12 waves (§5) into a **RICE-ranked sprint plan** and, for each sprint, a set of
**Code-Agent-ready prompts** that scaffold the wave's harness so the Auditor can run that wave
reproducibly. Preserve the wave dependency graph (T-SAF §7.6) and the completeness rule (every §9
attack-tree leaf exercised-and-refuted or filed).

## 2. What you must produce (deliverables)
1. **`docs/Prompts/SPRINT-SEC-PLAN.md`** — the campaign plan: waves grouped into sprints, RICE table
   (Reach×Impact×Confidence/Effort) setting sprint order, entry/exit criteria per sprint, the dependency
   sequence, and the coverage attestation target (100% of T-SAF §2 inventory).
2. **One sprint packet per group** — `docs/Prompts/SPRINT-SEC-{N}.md` — each containing the Code-Agent
   prompt(s) for that wave's harness, in the CLAUDE.md prompt format
   (**Context / Objective / Requirements / Do NOT / Files affected / Expected output / Quality criteria**).
3. **`/goal` paste blocks ≤ 4000 chars** for each Code-Agent prompt (full spec stays in the packet;
   the paste references it) — per the goal-char-limit rule.
4. A short **PT-PT design rationale** at the top of the plan (your Architect voice), EN for every prompt.

## 3. Suggested sprint grouping (you may re-RICE, but keep the dependencies)
- **SPRINT-SEC-1 — Contract & fund-flow harness (W1+W2).** Foundry invariant/fuzz tests for INV-1
  (fund custody), INV-2 (fee-once), INV-3 (router/selector allowlist), reentrancy + access-control
  negative tests; Slither config in CI; an on-chain verification script (Appendix A `cast` reads) that
  asserts deployed FeeCollector V2 / OrderExecutor / router-whitelist match source. Keep `forge test`
  (the real blocking gate) green.
- **SPRINT-SEC-2 — Gate & chain-awareness harness (W3+W4).** Fork-tests that feed stale/deviant/depeg/
  sequencer-down/DefiLlama-down inputs and assert **rejection** on chainId 1 AND 8453; a chain-pinned-
  residue scanner (grep-trace + a test that fails if a Base path resolves a mainnet client/feed/spender);
  numeric-chainId coercion tests at every JSON boundary.
- **SPRINT-SEC-3 — API & signing-trust harness (W5+W6).** Per-route request matrix tests (valid/
  malformed/oversized/wrong-method/missing-auth/wrong-chain/replay); error-shape-is-JSON assertions;
  RLS red-team tests (cross-user row access denied); a signing-path enumerator test that fails if any
  `signTypedData`/`sendTransaction`/permit path lacks a frozen-payload review; constant-time Bearer test.
- **SPRINT-SEC-4 — Adapter & keeper harness (W7+W8).** Per-adapter hostile-calldata fixtures (recipient/
  selector/fee) asserting refusal on both chains; the `partner-fee-invariant` extended to all 12 sources;
  keeper `node:test` for freeze delay-not-loss + single-writer + outflow, wired so CI (or a documented
  manual step) runs it.
- **SPRINT-SEC-5 — Wallet/frontend + supply-chain/CI/secrets harness (W9+W10).** WC single-core/`qr`-pin
  assertions; min-output/slippage enforced-both-sides tests; `npm ls` de-dup check + `overrides` pins in
  CI; `NEXT_PUBLIC_` server-secret scanner as a CI gate; header/CSP snapshot test; `test-contracts`
  stays blocking.
- **SPRINT-SEC-6 — Synthesis harness (W11).** A coverage attestation script that maps every §2 item and
  every §9 leaf to a test/finding and fails if any is uncovered; the master-report scaffold.

## 4. Per-wave Code-Agent prompt template (emit this shape)
For each harness prompt the Architect writes, require:
- **Context:** the wave + the T-SAF invariant(s) it proves (cite INV-# and §9 leaves).
- **Objective:** add the specific tests/tooling/config — no production-logic change.
- **Requirements:** exact files to add/extend; the negative-path cases that MUST fail-closed; on-chain
  reads to script; CI wiring; reuse existing single-source helpers (no forked gate/threshold/feed).
- **Do NOT:** weaken/duplicate any gate; touch contract/gate/fund-flow source (that's a remediation →
  Auditor); introduce `NEXT_PUBLIC_` secrets; break mainnet byte-identical; unsigned commits.
- **Files affected:** test/config/script paths (not production logic).
- **Expected output:** new tests green; CI gate added; on-chain script prints pass/fail; coverage delta.
- **Quality criteria:** atomic SSH-signed commits (rule #12); CI green incl. `test-contracts`; mainnet
  byte-identical test-pinned; FEEDBACK appended if edge cases surface; hand to Auditor for the wave review.

## 5. Sequencing & cadence
Follow T-SAF §7.6: SPRINT-SEC-1 → -2 in parallel with -3/-5, -4 after route facts land, -6 last. Full
campaign at release/quarterly + on any contract/gate/fund-flow change; targeted single-wave re-run (LIGHT
bar) on every PR touching that wave's surface.

## 6. Do NOT (Architect)
- Do NOT collapse the role separation (§0) — no "Code Agent audits" prompts; the review is the Auditor's.
- Do NOT let a harness prompt modify production/contract/gate logic — that path is a remediation with an
  Auditor pass (rules #2/#3), never bundled into a harness commit.
- Do NOT exceed 4000 chars in any `/goal` paste; keep full specs in the packet.
- Do NOT put marketing in the repo (rule #10); do NOT create ADRs/incidents outside conventions.
- Do NOT weaken a gate or the blocking `test-contracts` CI job to make anything pass.

## 7. Expected output from you (Architect)
`SPRINT-SEC-PLAN.md` + `SPRINT-SEC-1..6.md` under `docs/Prompts/`, each with EN Code-Agent prompts in
the standard 7-field format and ≤4000-char `/goal` pastes, RICE-ranked, dependency-ordered, with a PT-PT
rationale header. Hand SPRINT-SEC-1 first; the Auditor reviews each wave's output and only then clears
the next dependent sprint.

## 8. Acceptance (how the Auditor will check your output)
- Every T-SAF wave (§5) maps to exactly one sprint; every §2 inventory item and §9 attack-leaf is claimed
  by a sprint (100% coverage, no orphan surface).
- Role separation intact: harness = tests/tooling only; remediations flagged separately for Auditor pass.
- Each prompt is Code-Agent-ready (7 fields, files, negative-paths, CI, signed-commit + green-CI criteria).
- RICE table present and defensible; dependency order matches T-SAF §7.6.
