# Feedback — fix/catalog-workflow-jq-arg-too-long

Run 37505341116 (2026-10-06): step "Open a PR…" died at script line 44 (`jq -n`, workflow L218) —
`/usr/bin/jq: Argument list too long`, exit 126, all 3 chains. Cause: `--arg contents "$(base64 …)"`.

## Checklist
- [ ] C1 base64 → temp files → `jq --rawfile`; no file contents in argv
- [ ] C2 local proof (2 MiB: new OK / old E2BIG) + actionlint
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
