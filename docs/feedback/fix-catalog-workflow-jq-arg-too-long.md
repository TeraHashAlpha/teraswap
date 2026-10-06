# Feedback — fix/catalog-workflow-jq-arg-too-long

Run 37505341116 (2026-10-06): step "Open a PR…" died at script line 44 (`jq -n`, workflow L218) —
`/usr/bin/jq: Argument list too long`, exit 126, all 3 chains. Cause: `--arg contents "$(base64 …)"`.

## Checklist
- [x] C1 base64 → temp files → `jq --rawfile`; no file contents in argv (3ffb22f)
- [x] C2 local proof (2 MiB: new OK / old E2BIG) + actionlint
- [ ] C3 empty-payload guard, loud, before the API call
- [ ] push + compare link

## Findings
- **Assumption wrong — `gh api graphql -F input=@file` sends the file as a JSON *string*** (gh 2.96,
  offline `GH_DEBUG=api`, dummy token, dead host): `{"input":"{\"branch\"…}"}`. GraphQL cannot coerce a
  string into `CreateCommitOnBranchInput!`, so the step would have failed even without E2BIG (inferred
  from the GraphQL spec; the live API was not called). The payload is now the full body
  `{query, variables:{input}}`, sent with `--input` (verified to arrive as an object). Mutation text unchanged.
- **Assumption wrong — the step has no `set -euo pipefail`**: it runs under the Actions default
  `bash -e {0}`. Not added, because pipefail would change the superseded-PR loop and the `printf | head -n1` semantics.
- **Silent-empty hazard (old form):** under `bash -e`, a failing `$(base64 …)` *inside* `--arg` is
  swallowed — jq exits 0 and builds a payload with empty contents (observed locally). The new form puts
  base64 in standalone commands, so `-e` aborts.

## Evidence
2. **Big-file proof** — the snippet from QUERY= to `> "$PAYLOAD_FILE"` was extracted verbatim via sed (new from
   this branch, old from origin/main) into /tmp scratch scripts and run with `set -e`, `/bin/bash` 3.2.57, jq 1.7.1, on a 2,097,152-byte
   JSON. A PATH shim maps GNU `base64 -w0 FILE` onto macOS base64; it sits outside the snippet.
   - NEW: `jq -e .variables.input.fileChanges.additions[0].contents | wc -c` → **2796207**, exit 0;
     decoded contents `cmp`-identical to the input.
   - OLD: `old.sh: line 7: /usr/bin/jq: Argument list too long`, exit 1 (CI's bash 5 reports 126).
     On macOS the limit hit is ARG_MAX (1 MiB total); Linux hits MAX_ARG_STRLEN (128 KiB per string) first.
     Docker was not running, so no Linux rerun was done.
3. **actionlint** 1.7.12 (shellcheck integration active) on the workflow: no output, exit 0.
