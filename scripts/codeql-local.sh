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
#
# The query pack is PINNED (CODEQL_JS_PACK_VERSION below, env-overridable). It is used for the download AND in every
# query/suite reference, so the analysis never silently picks a newer cached pack. 2.5.1 once broke every run on CLI
# 2.27.2 ("Invalid data extension file"); a pack the installed CLI cannot read is a TOOL FAILURE (exit 3, one line on
# stderr), not a finding: report it, do not rerun, repair or install anything.
set -euo pipefail

# 2.5.0 is the pack bundled with CLI 2.27.4, the CLI the CodeQL workflow's pinned codeql-action (v4.37.4) ships.
CODEQL_JS_PACK_VERSION="${CODEQL_JS_PACK_VERSION:-2.5.0}"
PACK="codeql/javascript-queries"
EXIT_TOOL_FAILURE=3

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${CODEQL_OUT:-/tmp/ts-codeql}"
QUERY="${1:-codeql/javascript-queries:Security/CWE-117/LogInjection.ql}"
DB="$OUT/db"
SARIF="$OUT/result.sarif"

# An unpinned reference to the pack gets the pinned version; an explicit pack@version is left as given.
case "$QUERY" in
  "$PACK":*) QUERY="$PACK@$CODEQL_JS_PACK_VERSION:${QUERY#"$PACK":}" ;;
esac

mkdir -p "$OUT"
gh codeql version
CLI_VERSION="$(gh codeql version --format=terse 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
[ -n "$CLI_VERSION" ] || CLI_VERSION="unknown"
# The CLI does not bundle the query packs; fetch (idempotent, cached) the pinned version.
gh codeql pack download "$PACK@$CODEQL_JS_PACK_VERSION"

# Cheapest command that reproduces "pack not readable by this CLI": resolving the data extensions reads the pack's
# extension files (~0.2 s, no database). Runs BEFORE the database build; on failure no database is created.
echo "codeql-local: pack $CODEQL_JS_PACK_VERSION, CLI $CLI_VERSION"
if ! gh codeql resolve extensions "$QUERY" >"$OUT/pack-precheck.log" 2>&1; then
  echo "codeql-local: TOOL FAILURE: pack $CODEQL_JS_PACK_VERSION not readable by CLI $CLI_VERSION" >&2
  exit "$EXIT_TOOL_FAILURE"
fi

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
