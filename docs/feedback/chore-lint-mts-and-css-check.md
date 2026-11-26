# chore/lint-mts-and-css-check — feedback

**Owner answers (asked once, 2026-11-26, before building; they supersede the goal text).** (1) lint-delta runs `npm run lint` itself on HEAD and on a
merge-base worktree (HEAD's `node_modules` linked), same delta rule, deleted files do not offset, crash on either side = FAIL "lint crashed", FAIL too if
`npm run lint` fails on HEAD. (2) Premise false: no line in CLAUDE.md / AGENTS.md listed agent-verify's checks; add one to both.
**Tasks:** [x] A · [x] B · [x] C · [x] D (line in both; AGENTS pin by script; state block already current) · [x] evidence, one verify run

## 1. A — lint config
`eslint.config.mjs`: a block for `**/*.mts`, `**/*.cts` with typescript-eslint's parser, `sourceType: module`. Rules already matched `.ts` (63); only the parser differed.
- Warnings before 91, after 91, 0 errors, full lint output identical; `--max-warnings 94` untouched.
- Scratch: `releaseWhen: (stderrSoFar: string) => boolean` + unused import in a `.d.mts`, unused local in a `.mts`: exit 0, 2 warnings (93). Same `.d.mts`,
  origin/main config: exit 2, `node.params is not iterable`. `scripts/eslint-mts.test.mjs`: 20 of 24 first tests red before the change; 28 pass.
- My mistake: that first version wanted an unused-local warning in `.d.mts`/`.d.cts`; `.d.ts` reports none either (probed). Now: parity with the `.ts`/`.d.ts` twin + unused import = 1 warning.

## 2. B — why lint-delta missed it
It linted only `git diff --diff-filter=AMR <merge-base>` files matching `*.js *.jsx *.ts *.tsx *.mjs *.cjs`: **no `.mts`/`.cts`**, so the file was never linted (+0/+0).
It never ran the eslint CLI (Node API: `lintFiles` per file, `lintText` for base), so it never saw exit 2. A crash in a LISTED file made node exit 1: FAIL "eslint did not run", no crash line (measured).
- Fix: the owner's answer 1. Exit other than 0/1, or no readable report, = `lint crashed (head|base, exit N): <crash line | file | rule>`. "Deleted" = any file HEAD no longer lints.
- Tests (stub eslint; real git and `npm run`): old logic with an exit-2 stub said **PASS**; now FAIL "lint crashed" (head, base). One fix: bash 3.2 kept quotes in `${text//"$p"/}`.
- Real eslint: old config + that `.d.mts` → `lint crashed (head, exit 2): TypeError: node.params is not iterable | Occurred while linting scripts/zz-scratch.d.mts:1 | Rule: …`.
- Notes: base is linted with HEAD's `node_modules`; locally `eslint .` also sees untracked non-ignored files; ~2 full lints (~15 s each); fatal errors are no longer counted twice.

## 3. C — `scripts/check-v1-css.mjs`
v1 sheet = any built CSS declaring `--particle-color:` (hand-written in globals.css). Must have **`.bg-cream-15`, `.bg-surface-secondary/60`**; must not have **`.text-v2-text`, `.font-v2-mono`**;
each v2 marker must be in another sheet (else "stale marker"). Not `.bg-surface-secondary`/`.text-cream`: globals.css overrides keep them in the broken file. In agent-verify (`v1-css`) and the CI `build` job.
| run | result |
|---|---|
| real build, origin/main 623f58fd | PASS, 65,960 bytes |
| real build, branch 5e6e71fc (the verify's) | PASS, 65,960 bytes |
| crossed **fixture** (hand-written) | FAIL, exit 1: both v1 missing, both v2 present |
| extra: the **real** short sheet still in `~/ts-worktrees/audit-a97b-css` (#719 audit) | FAIL, 34,265 bytes, same 4 lines |

Existing agent-verify tests changed only for the new check: order list, PASS row, missing-tool list, "8 failed" → "9 failed". Nothing loosened.

## 4. Verify — one run, `--codeql`, last code commit **5e6e71fc** (base 623f58fd), 19:16:56, load1 5.84 → **PASS**
suite 11,690/0 (557 files) · lint-delta +0/+0 (1211 files, 91/91 warn) · tsc 0 · build ok · v1-css PASS · parity 123 · rpc-budget 36 · codeql 11/11, new 0 (pack 2.5.0, CLI 2.27.5) · keeper SKIP.
This file = docs-only commit on top. `origin/main...5e6e71fc`: 12 files, +695 −35. gitleaks (6 commits): no leaks.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/lint-mts-and-css-check
**NOT verified:** **Linux CI** (all of it: lint job, full-suite, the new build step, whether Linux Turbopack output passes it; lint-delta and its tests ran on macOS only); the stale Next 16.3.8
install was not re-created (the audit's kept output was used); `--keeper` (calls brew; no keeper code touched); the CSS check proves marker classes, not that the page looks right.
