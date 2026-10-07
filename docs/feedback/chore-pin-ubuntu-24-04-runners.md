# chore/pin-ubuntu-24-04-runners

Pin `ubuntu-latest` -> `ubuntu-24.04` ahead of the 2026-10-19 label migration (actions/runner-images#14748).

- [x] Commit 1: mechanical pin (32 lines, 8 workflows; 0 non-`runs-on` lines changed)
- [x] Commit 2: proof
- [x] Push branch, report compare link (no PR, no CI poll)

## Evidence
1. `runs-on` lines changed: ci 25 · codeql 1 · daily-health-report 1 · e2e 1 · gitleaks 1 · keeper-tests 1 · monitoring-watchdog 1 · security-audit 1 (total 32). `token-catalog-refresh.yml` untouched (already `ubuntu-24.04` on origin/main via #550). No non-ubuntu images, matrices, containers or self-hosted runners found.
2. `grep -rn "ubuntu-latest" .github/workflows/` ->
   `ci.yml:455:      # FIX-GROK-GUARD-CLAIMS: ubuntu-latest has no zsh preinstalled — ...`
3. `actionlint` -> no output, rc=0. `git diff --stat` (pin commit): 8 workflow files, 32 insertions(+), 32 deletions(-).

## Concern
- Goal says grep must print only catalog lines or nothing, but `ci.yml:455` is a *comment* naming `ubuntu-latest`. Left untouched per "nothing else changes". Follow-up: reword it to `ubuntu-24.04` (note: same zsh claim should be re-checked on 24.04).
