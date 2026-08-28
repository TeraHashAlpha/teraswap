## Feedback — CHORE-GROK-DENY-RULES (commit 1)

### Edge case
- Requirement 1 asked for `.grok/config.toml` **permission rules** denying `.env*`/keychain reads.
  Verified against the installed `grok` binary (1.0.5) and its shipped `~/.grok/README.md`: project-scoped
  `.grok/config.toml` supports **only** `[mcp_servers]` — permission rules exist exclusively as `--allow`/
  `--deny` CLI flags (`ToolPrefix(glob)` syntax, e.g. `Read(.env*)`), not as any TOML table, project or
  global. Wrote `.grok/config.toml` with a clearly marked `TODO(security)` explaining this and the correct
  CLI-flag syntax for a future PR to wire into `scripts/grok-dispatch.sh` (out of scope here — that file is
  read-only in this change).

### Manual command to confirm the deny rule bites (do NOT run automatically — costs a real xAI call)
```
grok -p "cat .env.local" --deny "Read(.env*)" --output-format json --no-auto-update
```
Expected: Grok's JSON output shows the `read_file`/cat attempt on `.env.local` refused by the deny rule,
never reaching the file's contents. Run this by hand from the repo root; it is the CLI-flag mechanism the
TODO in `.grok/config.toml` documents — there is no config-file equivalent to test.
