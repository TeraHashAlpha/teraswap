# Feedback — docs/basket-dca-analyst-package (2026-11-16, off origin/main b47ca15e)

Goal: narrow analyst package + ADR-027 Accepted + two DEPLOYMENTS fixes. DOCS ONLY. Worked in-session on Sonnet 5.5 (the owner had set the session model before the goal; the goal text says Haiku, same as the earlier owner choice to stay in-session).

- [x] C1 narrow package + NOT-COPIED.md + this file (first commit)
- [x] C2 ADR-027 + SPEC re-copied (Accepted), ARCHITECT-INDEX row, state block regenerated
- [x] C3 DEPLOYMENTS: address check (identical, no correction) + "Keeper polling today?" note
- [ ] verify: gen-claude-state --check, diff --stat, push, compare link

## 1. Premise check
- ADR-027 is on origin/main (`docs/ADR/ADR-027-basket-dca-three-orders.md`, `docs/Prompts/SPEC-BASKET-DCA.md`), and the earlier branch is merged. origin/main was b47ca15e at fetch.
- Source package exists. Source ADR/SPEC exist in `~/Desktop/teraswap-architect-pack/basket/`; the source ADR status line reads Accepted.
- Goal lint: OK (3923 bytes).
- Premise detail that differs from the goal text: the "45 `generic-api-key` hits" appear only with the **default** gitleaks ruleset. With this repo's `.gitleaks.toml` the whole 220 MB source reports 0 (the config's 40-hex address rule and the `docs/Reports/.*\.json` path allow-list). I re-measured the six files with the default ruleset: 31 + 2 + 2 + 3 + 5 + 2 = 45, same rule, same files. The six files stay out of the copy regardless.
- Read in addition to the named files: `.gitleaks.toml` (to understand the zero), the README rebuild section, `docs/DEPLOYMENTS.md` lines 5-20 (the note).

## 2. Copy
- 100 files, 4 008 975 bytes (4.0 MB; limit 15 MB). By folder: src 41 files (about 0.66 MB), tests 5, config 1 (`feeds.json`), results 45 (csv/md under 1 MB), top level 8 (README, requirements, run_all, 5 RESULTS md). Plus `NOT-COPIED.md`.
- Gitleaks on the copy, run from outside `docs/` so no path allow-list applies: repo config 0 hits; default ruleset 0 hits. Matched text never printed. No file had to be removed and no allow-list entry was added.
- NOT-COPIED.md: lists the left-out folders with file count and bytes (data 250 files 111.9 MB, results over-1MB csv / gz / pkl / json 33 files, charts 45, `_inputs*` 8, html 5, `__pycache__` 31), the six flagged files with rule id and hit count, where the full package lives, and `python3 run_all.py`. Python not run.
- Copied files are untouched (rsync -a from an explicit list).

## 3. ADR-027 Accepted: sha256 pairs (source = repo copy, `cmp` byte-identical)
- ADR-027: `26eaa85460036a59cf444bd5e321d34e4842ae556b111c85a16c719e178d65d1` (source) = `26eaa85460036a59cf444bd5e321d34e4842ae556b111c85a16c719e178d65d1` (repo)
- SPEC-BASKET-DCA: `daa33be5bd0f45418b4ebd06955a8f3c0238a42c603a10f47f320264d9d11e0d` (source) = `daa33be5bd0f45418b4ebd06955a8f3c0238a42c603a10f47f320264d9d11e0d` (repo)
- ADR status line: `- **Status:** Accepted (owner, 2026-11-13). Proposed by the Architect the same day; the three points of §7 were closed before acceptance.`
- `ARCHITECT-INDEX.md`: ADR-027 row added after ADR-026, same columns as its neighbours (status `Accepted (2026-11-13)`). ADR-025 is not in that table on main; not touched.
- State block: `node scripts/gen-claude-state.mjs --write` changed one line of `CLAUDE.md` (latest ADR-027, Status: Accepted); AGENTS.md pin rewritten by `check-agents-parity.mjs --write` (no tracked diff).

## 4. DEPLOYMENTS address check
- Note (`docs/DEPLOYMENTS.md` line 11, Arbitrum V3 note of 2026-11-13): `0x5f47F6301ceD087D5e24FD15C7ff8fBF82CE39ab`. Keeper registry, Arbitrum row, Signer address: `0x5f47F6301ceD087D5e24FD15C7ff8fBF82CE39ab`. Compared as extracted strings (`[ "$NOTE" = "$REG" ]`): IDENTICAL, all 42 characters. The abbreviation with a different ending was in a report, not in the note, so the note address is unchanged.
- Call, public Arbitrum RPC (`cast chain-id` printed `42161`):
  `cast call 0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459 'whitelistedExecutors(address)(bool)' 0x5f47F6301ceD087D5e24FD15C7ff8fBF82CE39ab --rpc-url https://arb1.arbitrum.io/rpc`
  Result: `true` (2026-11-16, 15:1x WET).
- Keeper registry, Arbitrum row, column "Keeper polling today?": old text kept, appended `2026-11-13: owner confirmed on the host that the process teraswap-keeper-arbitrum is online.` The row still says **No** for 2026-08-26; the added sentence is the owner's report, not something this session measured.
