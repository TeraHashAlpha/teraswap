# Feedback — fix/catalog-workflow-jq-arg-too-long

Run 37505341116 (2026-10-06): step "Open a PR…" died at script line 44 (`jq -n`, workflow L218) —
`/usr/bin/jq: Argument list too long`, exit 126, all 3 chains. Cause: `--arg contents "$(base64 …)"`.

## Checklist
- [x] C1 base64 → temp files → `jq --rawfile`; no file contents in argv (3ffb22f)
- [x] C2 local proof (2 MiB: new OK / old E2BIG) + actionlint (ff07004)
- [x] C3 empty-payload guard: loud, before the push and the API call
- [x] push → https://github.com/TeraHashAlpha/teraswap/compare/main...fix/catalog-workflow-jq-arg-too-long

## Findings
- **Assumption wrong — `gh api graphql -F input=@file` sends the file as a JSON *string***. Measured with gh 2.96
  via offline `GH_DEBUG=api` (dummy token, dead host): `{"input":"{\"branch\"…}"}`. Per the GraphQL spec a string
  cannot become `CreateCommitOnBranchInput!`, so the step would have failed even without E2BIG (the live API was not
  called). Now: full body `{query, variables:{input}}` via `--input`, verified to arrive as an object. Mutation unchanged.
- **Assumption wrong — no `set -euo pipefail` in the step**; it runs under the Actions default `bash -e {0}`. Not
  added, because pipefail would change the superseded-PR loop and the `printf | head -n1` semantics.
- **Old form failed silently on an empty file:** under `bash -e`, a failing `$(base64 …)` inside `--arg` is swallowed,
  and jq builds a payload with empty contents (observed). Now base64 runs as its own command, plus the C3 guard.
- **Not wired to "Loud failure alert" — #540 never did that:** the alert step runs *before* this step, so no failure
  here (run 37505341116 included) ever opened an issue. Follow-up: move the alert step after this one or add this step's outcome to its condition.
- **Follow-up (not fixed):** superseded PRs are closed and their branches deleted *before* the new commit and PR
  exist. Any later failure in this step leaves the chain with zero open PRs.

## Evidence
1. **Diff (abridged — comments and unchanged `--arg` lines dropped):**
   ```diff
   -git push origin "HEAD:refs/heads/${BRANCH}"             # was: before the payload was built
   -  --arg contents1 "$(base64 -w0 "$FILE")" \
   -  --arg contents2 "$(base64 -w0 "$TRUST_FILE")" \
   -  '{ branch: …, expectedHeadOid: $oid }' > "$PAYLOAD_FILE"
   -gh api graphql -f query="$QUERY" -F input=@"$PAYLOAD_FILE"
   +base64 -w0 "$FILE" > "$CONTENTS1_FILE"; base64 -w0 "$TRUST_FILE" > "$CONTENTS2_FILE"
   +  --arg query "$QUERY" --rawfile contents1 "$CONTENTS1_FILE" --rawfile contents2 "$CONTENTS2_FILE" \
   +  '{ query: $query, variables: { input: { branch: …, expectedHeadOid: $oid } } }' > "$PAYLOAD_FILE"
   +if [ ! -s "$CONTENTS1_FILE" ] || [ ! -s "$CONTENTS2_FILE" ]; then echo "::error::…empty (size 0)…"; exit 1; fi
   +git push origin "HEAD:refs/heads/${BRANCH}"
   +gh api graphql --input "$PAYLOAD_FILE"
   ```
2. **Big-file proof.** The snippet was extracted verbatim from the step into /tmp scratch scripts: new from this branch,
   old from origin/main. Run with `set -e`, `/bin/bash` 3.2.57, jq 1.7.1, on a 2,097,152-byte JSON. A PATH shim maps
   GNU `base64 -w0 FILE` onto macOS base64 and sits outside the snippet.
   - NEW: `jq -e .variables.input.fileChanges.additions[0].contents | wc -c` → **2796207**, exit 0. Decoded output is `cmp`-identical to the input.
   - OLD: `old.sh: line 7: /usr/bin/jq: Argument list too long`, exit 1 (CI's bash 5 reports 126). macOS hits
     ARG_MAX (1 MiB total); Linux hits MAX_ARG_STRLEN (128 KiB per string) first. Docker was not running, so no Linux rerun.
   - Guard: empty catalog → `::error::chain 1: encoded payload is empty (size 0)…`, exit 1, before the push line;
     2 MiB file passes.
3. **actionlint** 1.7.12 (`-verbose`: shellcheck active, pyflakes absent) → `Found total 0 errors`, exit 0.
4. **`git diff --stat origin/main`:**
   ```
    .github/workflows/token-catalog-refresh.yml        | 34 +++++++++----
    .../fix-catalog-workflow-jq-arg-too-long.md        | 55 ++++++++++++++++++++++
    2 files changed, 81 insertions(+), 8 deletions(-)
   ```
