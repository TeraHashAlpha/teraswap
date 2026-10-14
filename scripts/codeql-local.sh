#!/usr/bin/env bash
# Local CodeQL harness for js/log-injection (CWE-117). Bash 3.2 compatible.
#
# Builds a CodeQL database from this checkout and runs the LogInjection query, then prints a
# per-file:line summary of the SARIF. Idempotent: re-running recreates the DB (--overwrite) and the
# SARIF. Nothing is written inside the repo; output goes to $CODEQL_OUT (default /tmp/ts-codeql).
#
# Prereq (one-time):  gh extension install github/gh-codeql && gh codeql set-version latest
# Usage:              scripts/codeql-local.sh [query]
#   query defaults to codeql/javascript-queries:Security/CWE-117/LogInjection.ql
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${CODEQL_OUT:-/tmp/ts-codeql}"
QUERY="${1:-codeql/javascript-queries:Security/CWE-117/LogInjection.ql}"
DB="$OUT/db"
SARIF="$OUT/result.sarif"

mkdir -p "$OUT"
gh codeql version
# The CLI does not bundle the query packs; fetch (idempotent, cached) the one the query lives in.
gh codeql pack download codeql/javascript-queries

gh codeql database create "$DB" --language=javascript-typescript --source-root="$ROOT" --overwrite
gh codeql database analyze "$DB" "$QUERY" --format=sarif-latest --output="$SARIF" --rerun

echo "--- results (file:line) ---"
node -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const rows = [];
for (const run of s.runs) for (const r of run.results || []) {
  const l = r.locations[0].physicalLocation;
  rows.push(l.artifactLocation.uri + ":" + l.region.startLine);
}
rows.sort().forEach((x) => console.log(x));
console.log("total: " + rows.length);
' "$SARIF"
