# T-SAF Campaign Plan — operationalizing the audit framework into sprints

> **Source of truth:** `docs/security/TERASWAP-AUDIT-FRAMEWORK.md` (T-SAF v1). This plan turns that framework's
> 12 waves into an **executable sprint sequence** with entry packets, a finding→remediation pipeline, and a cadence.
> **Language:** EN (interoperates with `AUDIT-TOTAL.md`, `Audits/Campaign/*`, and Code-Agent prompts).
> **Binding:** CLAUDE.md roles + the 12 "Do NOT" rules (esp. #1/#2/#3/#12), T-SAF §1 principles, and
> `docs/Prompts/AUDITOR-ROLE.md` **(⚠ NOT PRESENT in the tree at plan time — locate/restore; until then the effective
> binding is T-SAF §1 + CLAUDE.md).** **Approval bar: 0C/0H = APPROVED; any C/H blocks prod.**
> Roles: **Auditor** runs each wave read-only (never edits code); **Architect** sequences + operationalizes + triages
> findings into prompts; **Code Agent** implements remediation prompts. Prepared 2026-07-01.

---

## 0. Baseline pinning — MANDATORY (W3-H-01 remediation)

> **Every wave audits `origin/main` (production HEAD), NOT the local working tree.** W3-H-01 (2026-07-01, HIGH,
> process) found the campaign was reading `docs/inc-2026-06-09` — **261 commits behind `origin/main`** — so the
> quote/swap-build sequencer gates (present in prod) looked absent. No product vuln (prod carries all gates), but it
> invalidated the branch-dependent conclusions. **Fix — do this at the start of EVERY wave:**
> 1. `git fetch origin && git rev-parse origin/main` → record the audited SHA in the wave report.
> 2. Read/checkout **`origin/main`** (or, if prod lags main, the exact deployed SHA/tag — record which).
> 3. Assert `git rev-list --count HEAD..origin/main == 0` before trusting any source read; if non-zero, STOP and
>    re-baseline.
> 4. **On-chain findings are branch-independent** (contracts/feeds by address) and need no re-baseline; **frontend/
>    API/keeper source findings MUST be read from the pinned prod ref.**
> **Re-baseline action for this campaign:** re-confirm the branch-dependent items of W1 (frontend/API touches) and
> W2 (`useSwap` minimumOutput derivation, `api/swap` recipient wiring) against `origin/main`; run W4+ against `main`.

## 1. Sprint map (12 waves → 6 sprints, per the §7.6 dependency graph)

| Sprint | Waves | Order | Parallel? | ⚠ rules | Exit gate |
|---|---|---|---|---|---|
| **SEC-0 · Recon** | W0 | first | — | — | §2 inventory regenerated from the current tree; deployed addresses snapshotted + on-chain-verified (both chains); invariant register built; every surface item owned by a wave. **Prerequisite for all others.** |
| **SEC-1 · Money core** | W1 → W2 | ordered | no | **#2/#3** | 0C/0H on contracts + fund-flow; INV-1/2/3 proven; on-chain addresses == source. |
| **SEC-2 · Gates / chain / signing** | W3, W4, W5 | — | yes (3-way) | #9 (W3) | INV-4/5/6 proven; no gate skippable/weakened/chain-blind; no un-reviewed signature path. |
| **SEC-3 · Perimeter** | W6 → W7 | ordered | no | — | 31 routes + 12 adapters uphold INV-1/7/10 + the money invariant on both chains; negative-path battery refused. |
| **SEC-4 · Off-chain / supply** | W8, W9, W10 | — | yes (3-way) | — | INV-9/11 proven; keeper compromise bounded by on-chain guards; single-instance critical deps; zero `NEXT_PUBLIC_` secret; CI gates blocking. |
| **SEC-5 · Synthesis** | W11 | last | — | — | Cross-wave attack chains built; C/H/M/L/I classified + RICE-ranked; MASTER-REPORT published; `AUDIT-TOTAL.md` appended; §2 coverage = 100%. |

**Execution order:** `SEC-0 → { SEC-1 } ∥ { SEC-2 } ∥ { SEC-3 } ∥ { SEC-4 } → SEC-5`. W1→W2 and W6→W7 are the only
intra-sprint ordered pairs; everything else fans out after W0. SEC-5 consumes all. Run sprints concurrently only up
to available reviewer capacity; **SEC-1 (money core) is highest priority** if serialized.

## 2. Entry-packet template (what the Architect emits per wave, §7.7)
Each wave gets one `Audits/Campaign/<date>/W<N>-<slug>.md` with:
1. **Objective** (from T-SAF §5).
2. **In-scope file list** — **verified on `main` by W0** (never from memory; principle #1).
3. **Attacker goals** (from §5 + the §9 G-leaves this wave owns).
4. **Invariants to prove** (the §6 INV-rows this wave owns) + the negative-path battery.
5. **Tool plan** (§7.5 per-wave tools + the exact commands).
6. **On-chain reads required** (Appendix A `cast` calls, correct chain RPC) for any address.
7. **Exit criteria** (from §5).
8. **Sub-reviewer panel** note for C/H-capable surfaces (§7.1): ≥N framings; a finding stands only if it survives a
   second reviewer's refutation.

## 3. Exit-report template (what the Auditor emits per wave)
`Audits/Campaign/<date>/W<N>-<slug>.md` (report section): checks-run table · findings table
(Sev · `file:line` · disposition) · negative-path results · **coverage fraction of its §2 slice** · verdict ·
list of remediation-prompt IDs produced. First-pass noise marked `REFUTED` with the reason (principle #1).

## 4. Finding → remediation-prompt pipeline
1. Every finding carries the **§4 evidence bundle**: `file:line` · why-defect · severity · attacker path ·
   reproduction (failing test / `cast` read / trace) · suggested fix · effort · **on-chain proof for any address**.
2. Disposition: `FIXED-in-PR` / `REMEDIATION-PROMPT` / `REFUTED` / `REPORT` (accepted risk / info).
3. Each `REMEDIATION-PROMPT` finding → a **Code-Agent prompt (EN)** in CLAUDE.md format
   (Context / Objective / Requirements / Do NOT / Files affected / Expected output / Quality criteria), full spec in
   `docs/Prompts/AUDIT-<wave>-<slug>.md`, with a **≤4000-char `/goal` paste**. Commits SSH-signed, noreply committer.
4. **RICE-rank** the remediation backlog (Reach × Impact × Confidence / Effort); split "auto-fixable / needs contract
   sprint / needs human".
5. **Contract / fund-flow / gate fixes** (rules #2/#3): require an **Auditor re-pass + on-chain address verification**;
   **never deploy without 0C/0H** and CI green incl. `test-contracts`. An H safely resolvable in-PR →
   APPROVED-WITH-NOTES until the fix + tests land.

## 5. Deliverables & folder structure
- Per wave: `Audits/Campaign/<date>/W<N>-<slug>.md` (entry packet + exit report).
- Remediation prompts: `docs/Prompts/AUDIT-<wave>-<slug>.md` (+ the ≤4000 paste handed to the Code Agent).
- Master: `Audits/Campaign/<date>/MASTER-REPORT.md` (exec summary, C/H/M/L/I counts, RICE plan, §2 coverage = 100%).
- Ledger: append the campaign verdict block to `docs/security/AUDIT-TOTAL.md`.

## 6. Cadence & boundaries
- **Full campaign:** each release / quarterly + on any **contract / gate / fund-flow** change.
- **Targeted:** single-wave re-run (LIGHT bar) on every PR touching that wave's §2 surface (use the file→wave map).
- **Boundaries (stop, document, no loop):** real-device wallet, live signatures, on-chain `pause()`/governance,
  deploys, secret rotation — human-only.

## 7. Status / next
- **SEC-0/W0 entry packet:** `Audits/Campaign/2026-07-01/W0-recon.md` (this campaign's kickoff). Run it first; its
  grounded inventory + on-chain address snapshot feed the SEC-1..SEC-4 packets.
- **After W0 lands:** the Architect generates the SEC-1..SEC-4 entry packets grounded on W0's inventory/addresses.
- **Open:** locate/restore `docs/Prompts/AUDITOR-ROLE.md`.

### Changelog
- v1 (2026-07-01) — operationalizes T-SAF v1 into 6 sprints (SEC-0..SEC-5), entry/exit templates, finding→prompt
  pipeline, cadence. Kickoff = SEC-0/W0.
