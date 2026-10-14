# Feedback — fix/codeql-sanitizer-proof

Checklist
- [ ] C1 local harness `scripts/codeql-local.sh` + baseline
- [ ] C2 forLog recognised as sanitizer, after-fix = 0 on target files
- [ ] Suite / lint / tsc / diff --stat / compare link

## 1. CLI + commands
- gh-codeql ext `cb1d8f37`, CodeQL CLI v2.27.2 (`gh codeql set-version latest`); query sources read at tag `codeql-cli/v2.27.2`.
- `scripts/codeql-local.sh` wraps `gh codeql database create … --language=javascript-typescript` + `database analyze … codeql/javascript-queries:Security/CWE-117/LogInjection.ql --format=sarif-latest`.

## Deviations
- `.gitignore` +2 lines: `scripts/*.sh` is ignored; un-ignored `scripts/codeql-local.sh` (same precedent as grok-dispatch.sh).

## Root cause (from the .qll, read before any edit)
`StringReplaceSanitizer` only matches `replaces(s, "")` with `s` matching `\n`: the replacement MUST be the empty string.
`forLog` replaced CR/LF with `' '` (and its comment claimed "that exact shape" was recognised) -> barrier never matched.
