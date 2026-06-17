# CHORE-POLISH-4 — post-audit polish (5 non-gate items)

Each item = its OWN atomic SSH-signed commit. Branch `chore/polish-4` off latest `origin/main`. CI green
(test-contracts is a real blocking gate — keep it green), append `FEEDBACK.md`. None of these is a
security gate, but **P1 hardens security tooling** — treat its false-positive budget seriously.
Mainnet byte-identical (test-guarded). Keys server-only. No contract/Solidity/adapter/gate changes.

---

## P1 — gitleaks rule: bare-hex private key (the near-miss)

**Context.** A real 64-hex-char EVM private key was once pasted into a local, uncommitted runbook.
gitleaks did **not** flag it: its default rules catch labelled secrets but miss a *bare* `0x`-less /
`0x`-prefixed 64-hex string. We caught it by manual/semantic review. Close the tooling gap.

**The hard part — false positives.** This is a blockchain repo: 64-hex strings are EVERYWHERE
(keccak256 hashes, tx hashes, block hashes, merkle roots, storage slots, test fixtures). A naive
`[0-9a-fA-F]{64}` rule would flood. So:
- Primary rule: **keyword-proximity** — fire on a 64-hex value (optional `0x`) when it sits next to a
  private-key keyword: `(?i)(private[_-]?key|priv[_-]?key|secret[_-]?key|mnemonic|keystore|\bPK\b)`
  followed by an assignment/colon/quote then `(0x)?[0-9a-fA-F]{64}`. This catches the near-miss
  (`...KEY = abcd…64`) without touching loose hashes.
- Secondary (optional, stricter): a high-**entropy** bare-64-hex rule with an **allowlist** for the
  known noisy paths (`test/`, `tests/`, `*.t.sol`, `out/`, `cache/`, fixtures) and known-hash stopwords,
  so legitimate tx/block hashes don't trip it. Only ship this if you can get it green against the
  current tree with zero false positives.
- Confirm the rule applies to `docs/`, `Audits/`, and `*.md` runbooks (where the near-miss lived), not
  just source.

**Tests / proof.** Add a fixture: a file containing a FAKE bare-hex private key in a
`PRIVATE_KEY = 0x…` shape → gitleaks MUST flag it. A file with a real-looking keccak/tx hash (no
private-key keyword) → MUST NOT flag. Run gitleaks against the full current repo and confirm **zero new
findings** on existing committed files (no regression). Document the rule + rationale inline in the
gitleaks config and reference INC-2026-06-09-001 / the near-miss in a comment.

---

## P2 — H2 health-check baseline is empty (validation disabled)

**Context.** Health stack H1–H6. **H2's baseline/expected set is empty**, so the H2 check passes
vacuously — it validates nothing and would not catch the drift it exists to catch.

**Do.** Locate the H2 check and where its baseline is meant to be populated. Determine WHY it's empty
(never seeded? cleared by a refactor? wrong key/env?). Then either (a) populate/restore the baseline so
H2 actually validates, or (b) if a populated baseline isn't safely derivable, make the empty baseline a
**hard failure** (H2 must not report healthy on an empty baseline — fail-closed) and document what needs
seeding. Add a test that fails if the H2 baseline is empty / the check passes vacuously. State clearly in
FEEDBACK which path (a or b) you took and why.

---

## P3 — service worker caches 206 → Cache.put throws (sw.js)

**Context.** The service worker attempts to cache a **206 Partial Content** response; the Cache API
rejects it (`Failed to execute 'put' on 'Cache': Partial response (status code 206) is unsupported`),
surfacing as a console error and a failed cache write.

**Do.** In the SW fetch handler, guard before every `cache.put`: only cache when
`response && response.status === 200` (skip 206 and other non-200/opaque-range responses). Match the
existing caching strategy — don't change what IS cached on a 200, only stop trying to cache partials.
If there's an SW test harness, add a case (206 response → not cached, no throw); if not, note the manual
verification step (range request / media element → no console error) in FEEDBACK.

---

## P4 — remaining dead code

**Context.** Earlier dead-code passes ran on `chore/full-audit-cleanup`. Sweep the leftovers.

**Do.** Use a static pass (e.g. `knip` / `ts-prune`) to find provably-unused exports, files, and deps.
Remove ONLY what is provably unused — no behaviour change. Per CLAUDE.md rule #4, do not delete files
that are referenced by docs/ADRs as historical record; for genuinely orphaned source, removal is fine
(git history preserves it). Keep each logical removal reviewable (group sensibly, or split commits).
After each removal: tsc + lint + full test suite + next build + test-contracts gate stay green.
List everything removed in FEEDBACK. When in doubt, leave it and note it rather than risk a hidden import.

---

## P5 — qr pin: confirm + document (blocked upstream, do NOT bump)

**Context.** `qr@0.5.5` is pinned because `qr@0.6.0` threw `invalid border=0` (INC-2026-06-09-001). This
is **blocked on upstream** — not a fix item now.

**Do.** Do NOT bump qr. Just make the pin self-explanatory and tamper-evident:
- Add/confirm an inline comment at the pin (package.json / overrides) explaining WHY (border=0 crash,
  link INC-2026-06-09-001) so no future Dependabot batch silently bumps it.
- Confirm the single-instance invariant still holds: exactly one `qr@0.5.5` in the tree (the same
  discipline as @walletconnect/core, viem, coinbase-sdk). Note the result in FEEDBACK.
- No code change beyond the comment/guard. (Architect will set up a weekly upstream watcher for a qr
  release that fixes border=0, mirroring the rainbowkit-wagmi-v3 watcher — out of scope for the Code Agent.)

---

## Do NOT
- No contract / Solidity / adapter / oracle-gate / FeeCollector / router changes. No address changes.
- Do NOT bump qr (P5 is comment/guard only). Do NOT weaken the gitleaks default rules (P1 only ADDS).
- Mainnet byte-identical (test-guarded). Keys server-only (no `NEXT_PUBLIC_` for secrets).

## Output
- Branch `chore/polish-4`, up to 5 atomic SSH-signed commits (P1…P5; skip a Px commit if it turns out
  to be a no-op and say so in FEEDBACK), CI green incl. test-contracts.
- `FEEDBACK.md` appended: P1 false-positive analysis + the two test fixtures' results; P2 (a or b) +
  why; P3 verification; P4 full list of removals; P5 single-instance check result.
- No Auditor needed for P2/P3/P4/P5. **Flag for Architect review** if P1's bare-hex rule produces ANY
  finding on currently-committed files (could indicate a real exposure to triage immediately).
