# chore/codeql-local-pinned-pack — feedback

Tooling only. Pins the CodeQL query pack in `scripts/codeql-local.sh`, adds a pack-vs-CLI pre-check, and makes
`scripts/agent-verify.sh --codeql` record a `tool failure` once instead of "no result total" twice.

## Checklist
- [ ] 1 pin (one variable, env override, download + query/suite refs)
- [ ] 2 pre-check before the database build, exit 3 + one line
- [ ] 3 agent-verify `codeql FAIL tool failure: …`, one run for head+base
- [ ] 4 summary names pack + CLI versions
- [ ] 5 CLAUDE.md / AGENTS.md one line each, state block + parity regenerated
- [ ] tests + mutation proof
- [ ] one `agent-verify.sh --codeql` on the last CODE commit

## Premise deviation
- The goal says "the line of CLAUDE.md and AGENTS.md that describes agent-verify". Neither file mentions agent-verify (`grep -i verify`
  finds nothing in either). The requested line is therefore ADDED, not edited. Not worth a question: the instruction (add one line each) is unambiguous.
- `gh codeql …` typed directly in a tool call is refused by the command guard (not on the gh allow-list), so CLI and pack facts below
  come from the CLI binary under `~/.local/share/gh/extensions/gh-codeql/dist/release/<ver>/codeql` and from the repo's own scripts.
