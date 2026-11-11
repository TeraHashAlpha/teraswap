#!/usr/bin/env bash
# agent-verify.sh — one command, one fixed EVIDENCE block. Bash 3.2 compatible (macOS stock).
#
#   scripts/agent-verify.sh [--codeql] [--keeper] [--base REF]
#   scripts/agent-verify.sh --format RESULTS.tsv        (formatter only; used by the tests)
#
# Checks (always): suite, lint-delta, tsc, build, v1v2-parity, rpc-budget.
#   --codeql  FULL javascript-security-extended via scripts/codeql-local.sh, HEAD vs base, count must not grow.
#   --keeper  keeper `node --test` on every Node major CI uses (parsed from .github/workflows/keeper-tests.yml).
# A failing check, a missing tool, or an unparsable result is FAIL and the exit code is non-zero.
# Never polls CI, never prints environment values (logs stay in $AGENT_VERIFY_OUT; only their path is printed).
set -u
set -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_REF="origin/main"
DO_CODEQL=0
DO_KEEPER=0
FORMAT_ONLY=""
CODEQL_QLS="codeql/javascript-queries:codeql-suites/javascript-security-extended.qls"
KEEPER_DIR="contracts/order-engine/executor"
KEEPER_WORKFLOW=".github/workflows/keeper-tests.yml"
CHECK_ORDER="suite lint-delta tsc build v1v2-parity rpc-budget codeql keeper"

while [ $# -gt 0 ]; do
  case "$1" in
    --codeql) DO_CODEQL=1 ;;
    --keeper) DO_KEEPER=1 ;;
    --base) shift; BASE_REF="${1:-origin/main}" ;;
    --format) shift; FORMAT_ONLY="${1:-}" ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "agent-verify: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

OUT="${AGENT_VERIFY_OUT:-}"
if [ -z "$OUT" ]; then OUT="$(mktemp -d "${TMPDIR:-/tmp}/agent-verify.XXXXXX")"; fi
mkdir -p "$OUT"
if [ ! -d "$OUT" ]; then echo "agent-verify: cannot create output dir" >&2; exit 2; fi
RESULTS="$OUT/results.tsv"

# ---------- helpers ----------
record() { # name status detail
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$RESULTS"
}

strip_ansi() { sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g'; }

need() { # tool... -> 0 if all present; else records nothing, prints the missing one
  local t
  for t in "$@"; do
    if ! command -v "$t" >/dev/null 2>&1; then echo "$t"; return 1; fi
  done
  return 0
}

fail_missing() { # check tool
  record "$1" FAIL "missing tool: $2"
}

# "passed failed files" from a vitest log (ANSI stripped)
vitest_counts() {
  strip_ansi < "$1" | awk '
    /^ *Tests / { for (i = 1; i <= NF; i++) { if ($(i+1) == "passed") p = $i; if ($(i+1) == "failed") f = $i } }
    /^ *Test Files / { for (i = 1; i <= NF; i++) { if ($(i+1) == "passed") fp = $i; if ($(i+1) == "failed") ff = $i } }
    END { if (p == "") p = 0; if (f == "") f = 0; printf "%d %d %d\n", p, f, fp + ff }'
}

run_vitest_check() { # name log args...
  local name="$1" log="$2"; shift 2
  local m
  if m="$(need npx)"; then :; else fail_missing "$name" "$m"; return; fi
  (cd "$ROOT" && CI=1 npx vitest run "$@") > "$log" 2>&1
  local rc=$?
  local counts p f n
  counts="$(vitest_counts "$log")"
  p="${counts%% *}"; f="$(echo "$counts" | awk '{print $2}')"; n="$(echo "$counts" | awk '{print $3}')"
  if [ "$rc" -eq 0 ] && [ "$p" -gt 0 ] && [ "$f" -eq 0 ]; then
    record "$name" PASS "$p tests passed, 0 failed, $n files"
  else
    record "$name" FAIL "exit $rc; $p passed, $f failed, $n files (log: $log)"
  fi
}

# ---------- checks ----------
check_suite() { run_vitest_check suite "$OUT/suite.log"; }
check_parity() { run_vitest_check v1v2-parity "$OUT/parity.log" isolation parity; }
check_rpc_budget() { run_vitest_check rpc-budget "$OUT/rpc-budget.log" rpc-budget; }

check_tsc() {
  local m
  if m="$(need npx)"; then :; else fail_missing tsc "$m"; return; fi
  (cd "$ROOT" && npx tsc --noEmit) > "$OUT/tsc.log" 2>&1
  local rc=$? errs
  errs="$(grep -c 'error TS' "$OUT/tsc.log")"
  if [ "$rc" -eq 0 ] && [ "$errs" -eq 0 ]; then record tsc PASS "0 errors"
  else record tsc FAIL "exit $rc; $errs errors (log: $OUT/tsc.log)"; fi
}

check_build() {
  local m
  if m="$(need npm)"; then :; else fail_missing build "$m"; return; fi
  (cd "$ROOT" && npm run build) > "$OUT/build.log" 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ]; then record build PASS "next build ok"
  else record build FAIL "exit $rc (log: $OUT/build.log)"; fi
}

LINT_JS='
import { ESLint } from "eslint"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
const [mb] = process.argv.slice(1)
const files = readFileSync(0, "utf8").split("\n").filter(Boolean)
const eslint = new ESLint({ warnIgnored: false })
const sum = (rs) => rs.reduce((a, r) => [a[0] + r.errorCount + r.fatalErrorCount, a[1] + r.warningCount], [0, 0])
let he = 0, hw = 0, be = 0, bw = 0
for (const f of files) {
  const [e1, w1] = sum(await eslint.lintFiles([f]))
  he += e1; hw += w1
  let base = null
  try { base = execFileSync("git", ["show", mb + ":" + f], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) } catch {}
  if (base !== null) { const [e2, w2] = sum(await eslint.lintText(base, { filePath: f })); be += e2; bw += w2 }
}
console.log(JSON.stringify({ files: files.length, he, hw, be, bw }))
'

check_lint_delta() {
  local m
  if m="$(need git node npx)"; then :; else fail_missing lint-delta "$m"; return; fi
  local mb files json
  mb="$(cd "$ROOT" && git merge-base "$BASE_REF" HEAD 2>/dev/null)"
  if [ -z "$mb" ]; then record lint-delta FAIL "no merge-base with $BASE_REF"; return; fi
  files="$(cd "$ROOT" && git diff --name-only --diff-filter=AMR "$mb" -- '*.js' '*.jsx' '*.ts' '*.tsx' '*.mjs' '*.cjs')"
  if [ -z "$files" ]; then record lint-delta PASS "errors +0, warnings +0 (0 changed files)"; return; fi
  json="$(cd "$ROOT" && printf '%s\n' "$files" | node --input-type=module -e "$LINT_JS" "$mb" 2> "$OUT/lint.log")"
  if [ -z "$json" ]; then record lint-delta FAIL "eslint did not run (log: $OUT/lint.log)"; return; fi
  local n he hw be bw de dw
  n="$(node -e 'const j=JSON.parse(process.argv[1]);console.log([j.files,j.he,j.hw,j.be,j.bw].join(" "))' "$json")"
  set -- $n
  de=$(( $2 - $4 )); dw=$(( $3 - $5 ))
  local detail
  detail="$(printf 'errors %+d, warnings %+d (%s changed files; head %s err/%s warn, base %s err/%s warn)' "$de" "$dw" "$1" "$2" "$3" "$4" "$5")"
  if [ "$de" -le 0 ] && [ "$dw" -le 0 ]; then record lint-delta PASS "$detail"; else record lint-delta FAIL "$detail"; fi
}

codeql_total() { # dir -> prints total or empty
  CODEQL_OUT="$1" "$2/scripts/codeql-local.sh" "$CODEQL_QLS" 2>"$1.err" | tee "$1.log" | sed -n 's/^total: //p'
}

check_codeql() {
  local m
  if m="$(need gh node git)"; then :; else fail_missing codeql "$m"; return; fi
  if ! gh codeql version >/dev/null 2>&1; then record codeql FAIL "missing tool: gh codeql (gh extension install github/gh-codeql)"; return; fi
  local head_total base_total basewt
  head_total="$(codeql_total "$OUT/cq-head" "$ROOT")"
  basewt="$OUT/base-wt"
  if ! (cd "$ROOT" && git worktree add -q --detach "$basewt" "$BASE_REF") >/dev/null 2>&1; then
    record codeql FAIL "cannot create base worktree for $BASE_REF"; return
  fi
  base_total="$(codeql_total "$OUT/cq-base" "$basewt")"
  (cd "$ROOT" && git worktree remove --force "$basewt") >/dev/null 2>&1
  if [ -z "$head_total" ] || [ -z "$base_total" ]; then
    record codeql FAIL "no result total (head='${head_total}' base='${base_total}'; logs: $OUT/cq-*.log/.err)"; return
  fi
  local newn
  newn="$(comm -23 <(grep -E '^[^ ]+:[0-9]+$' "$OUT/cq-head.log" | sort -u) <(grep -E '^[^ ]+:[0-9]+$' "$OUT/cq-base.log" | sort -u) | wc -l | tr -d ' ')"
  local detail="security-extended: head $head_total, base $base_total, new file:line $newn"
  if [ "$head_total" -le "$base_total" ]; then record codeql PASS "$detail"; else record codeql FAIL "$detail"; fi
}

find_node_major() { # major -> prints a node binary path of that major, or nothing
  local want="$1" c v
  for c in "$(command -v node 2>/dev/null)" "/opt/homebrew/opt/node@$want/bin/node" "/usr/local/opt/node@$want/bin/node" \
           $HOME/.nvm/versions/node/v$want.*/bin/node $HOME/.volta/tools/image/node/$want.*/bin/node \
           $HOME/.local/share/fnm/node-versions/v$want.*/installation/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    v="$("$c" -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
    if [ "$v" = "$want" ]; then echo "$c"; return 0; fi
  done
  return 1
}

check_keeper() {
  local m
  if m="$(need node npm)"; then :; else fail_missing keeper "$m"; return; fi
  local wf="$ROOT/$KEEPER_WORKFLOW" majors
  if [ ! -f "$wf" ]; then record keeper FAIL "$KEEPER_WORKFLOW not found"; return; fi
  majors="$(sed -n 's/.*node-version: *"\{0,1\}\([0-9][0-9]*\).*/\1/p' "$wf" | sort -un)"
  if [ -z "$majors" ]; then record keeper FAIL "no node-version found in $KEEPER_WORKFLOW"; return; fi
  if [ ! -d "$ROOT/$KEEPER_DIR/node_modules" ]; then
    (cd "$ROOT/$KEEPER_DIR" && npm ci --ignore-scripts) > "$OUT/keeper-ci.log" 2>&1 \
      || { record keeper FAIL "npm ci --ignore-scripts failed (log: $OUT/keeper-ci.log)"; return; }
  fi
  local major bin log p f c rc parts="" bad=0
  for major in $majors; do
    if ! bin="$(find_node_major "$major")"; then
      parts="$parts node$major:MISSING"; bad=1
      continue
    fi
    log="$OUT/keeper-node$major.log"
    (cd "$ROOT/$KEEPER_DIR" && "$bin" --test) > "$log" 2>&1
    rc=$?
    p="$(strip_ansi < "$log" | sed -n 's/^[# ℹ]*pass \([0-9][0-9]*\).*/\1/p' | tail -1)"
    f="$(strip_ansi < "$log" | sed -n 's/^[# ℹ]*fail \([0-9][0-9]*\).*/\1/p' | tail -1)"
    c="$(strip_ansi < "$log" | sed -n 's/^[# ℹ]*cancelled \([0-9][0-9]*\).*/\1/p' | tail -1)"
    p="${p:-0}"; f="${f:-0}"; c="${c:-0}"
    parts="$parts node$major:$p-pass/$f-fail/$c-cancelled"
    if [ "$rc" -ne 0 ] || [ "$p" -eq 0 ] || [ "$f" -ne 0 ] || [ "$c" -ne 0 ]; then bad=1; fi
  done
  parts="${parts# }"
  if [ "$bad" -eq 0 ]; then record keeper PASS "$parts"
  else
    case "$parts" in
      *MISSING*) record keeper FAIL "$parts — CI Node version not installed locally (e.g. brew install node@20); not substituting another version" ;;
      *) record keeper FAIL "$parts (logs: $OUT/keeper-node*.log)" ;;
    esac
  fi
}

# ---------- formatter ----------
github_slug() { # origin url -> owner/repo (never echoes credentials)
  git -C "$ROOT" remote get-url origin 2>/dev/null | sed -E 's#^.*github\.com[:/]+##; s#\.git$##; s#/+$##'
}

format_block() { # results-file
  local f="$1" name line status detail fails=0 ran
  local branch sha base_sha slug
  branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  base_sha="$(git -C "$ROOT" rev-parse --short "$BASE_REF" 2>/dev/null || echo unknown)"
  slug="$(github_slug)"
  echo "=== EVIDENCE ==="
  echo "branch: $branch @ $sha (base $BASE_REF @ $base_sha)"
  for name in $CHECK_ORDER; do
    line="$(awk -F'\t' -v n="$name" '$1 == n { l = $0 } END { print l }' "$f" 2>/dev/null)"
    if [ -z "$line" ]; then
      case "$name" in
        codeql|keeper) status="SKIP"; detail="not requested (--$name)" ;;
        *) status="FAIL"; detail="not run"; fails=$((fails + 1)) ;;
      esac
    else
      status="$(echo "$line" | awk -F'\t' '{print $2}')"
      detail="$(echo "$line" | awk -F'\t' '{print $3}')"
      case "$status" in
        PASS|SKIP) ;;
        *) status="FAIL"; fails=$((fails + 1)) ;;
      esac
    fi
    printf '%-12s %-4s %s\n' "$name:" "$status" "$detail"
  done
  echo "diff --stat $BASE_REF...HEAD:"
  local stat nlines
  stat="$(git -C "$ROOT" diff --stat=100 "$BASE_REF...HEAD" 2>/dev/null)"
  if [ -z "$stat" ]; then echo "  (no diff or git unavailable)"
  else
    nlines="$(echo "$stat" | wc -l | tr -d ' ')"
    if [ "$nlines" -gt 26 ]; then
      echo "$stat" | head -20
      echo " ... $((nlines - 21)) more files"
      echo "$stat" | tail -1
    else
      echo "$stat"
    fi
  fi
  if [ -n "$slug" ] && [ "$branch" != "HEAD" ] && [ "$branch" != "unknown" ]; then
    echo "compare: https://github.com/$slug/compare/main...$branch"
  else
    echo "compare: unavailable (detached HEAD or no github origin)"
  fi
  if [ "$fails" -eq 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL ($fails failed)"; fi
  echo "=== END EVIDENCE ==="
  [ "$fails" -eq 0 ]
}

# ---------- main ----------
if [ -n "$FORMAT_ONLY" ]; then
  if [ ! -f "$FORMAT_ONLY" ]; then echo "agent-verify: no such results file: $FORMAT_ONLY" >&2; exit 2; fi
  format_block "$FORMAT_ONLY"
  exit $?
fi

: > "$RESULTS"
if ! command -v git >/dev/null 2>&1; then
  record suite FAIL "missing tool: git"
else
  check_suite
  check_lint_delta
  check_tsc
  check_build
  check_parity
  check_rpc_budget
  [ "$DO_CODEQL" -eq 1 ] && check_codeql
  [ "$DO_KEEPER" -eq 1 ] && check_keeper
fi
format_block "$RESULTS"
rc=$?
echo "logs: $OUT"
exit $rc
