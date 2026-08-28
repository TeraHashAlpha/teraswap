#!/usr/bin/env bash
# grok-dispatch.sh — the ONLY sanctioned entry point for handing a spec to Grok Build.
#
# Usage: grok-dispatch.sh <spec> <branch> [--dry-run] [--execute]
#
# --dry-run is the default and NEVER invokes the `grok` binary — it only prints the plan
# (resolved model, approval mode, every refusal check) and exits 0. A real run requires the
# explicit --execute flag, and even then several conditions cause an outright refusal before
# `grok` is ever invoked. See AGENTS.md "What a Grok Build task must never touch".
set -euo pipefail

# --- the model table (one constant, read top-to-bottom) -------------------------------------
# effort tier (from the spec's CONTROL header) -> Grok model. This is the single place that
# maps tiers to models; nothing else in this script hardcodes a model name.
resolve_grok_model() {
  case "$1" in
    low) echo "grok-build-0.1" ;;
    medium) echo "grok-4.5" ;;
    high) echo "grok-4.6" ;;
    *) return 1 ;;
  esac
}

# --- the deny-flag list (one constant, indexed array — bash 3.2 has no `declare -A`) --------
# FIX-GROK-GUARD-CLAIMS: these flags are SPEED BUMPS AND INTENT SIGNALS ONLY, NOT enforcement —
# measured, see docs/security/GROK-DENY-CANARY-2026-08-28.md. A `Bash(...)` deny rule matches the
# invoked command name, not its arguments, so `Bash(*.env*)` cannot match `cat .env.canary`; Grok
# routes around a denied `Read(.env*)` by shelling out instead. Only `--deny "Bash(*)"` (blocking
# every shell command) actually refuses, and that is unusable for real work. The REAL control is
# GROK_WORKTREE_BASE_DIR below — Grok never runs anywhere near this repo's real .env* files.
# Verified against `grok --help` / ~/.grok/README.md's Permission Rules section (ToolPrefix(glob)
# syntax, Read(...)/Bash(...) prefixes). Never extend this list by guessing — a new entry needs
# the same verification.
#
# scripts/grok-guard.sh carries the SAME flags for interactive `grok` sessions — deliberately
# NOT shared code. That file is an interactive-shell function scoped to whatever shell sourced
# it; this script always runs as its own non-interactive subshell/subprocess and never inherits a
# caller's shell functions, so it cannot rely on grok-guard.sh having been sourced. Do not
# "de-duplicate" the two lists — they guard two different launch paths and must both be updated,
# in parallel, whenever one changes.
GROK_DENY_FLAGS=(
  --deny "Read(.env*)"
  --deny "Read(**/.env*)"
  --deny "Bash(security*)"
  --deny "Bash(git credential-*)"
)

# --- the worktree base directory (the REAL control, per docs/security/GROK-DENY-CANARY-2026-08-28.md) ---
# ALWAYS outside this repo — a fresh `git worktree add` only checks out TRACKED files, so a
# worktree rooted outside the repo simply has no .env* to reach: no path, walked or otherwise,
# leads back to them. .claude/worktrees/ (the old location) is still INSIDE the repo tree, three
# levels below the real .env* files (../../../.env.production.local reaches them) — never use it.
# Override with TS_WORKTREE_BASE for a non-default location; it is validated below to still be
# outside the repo.
GROK_WORKTREE_BASE_DIR="${TS_WORKTREE_BASE:-$HOME/ts-worktrees}"

# --- glob patterns that force interactive mode / outright refusal ---------------------------
SENSITIVE_FILE_PATTERNS=(
  "contracts/*"
  "keeper/*"
  "*executor*"
  "src/lib/chains/*"
  "*swap*"
  "*gate*"
  "*signer*"
)

usage() {
  echo "Usage: $0 <spec> <branch> [--dry-run] [--execute]" >&2
  exit 2
}

# --- args -------------------------------------------------------------------------------------
SPEC=""
BRANCH=""
DRY_RUN_FLAG=0
EXECUTE_FLAG=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN_FLAG=1 ;;
    --execute) EXECUTE_FLAG=1 ;;
    -*) usage ;;
    *)
      if [[ -z "$SPEC" ]]; then
        SPEC="$arg"
      elif [[ -z "$BRANCH" ]]; then
        BRANCH="$arg"
      else
        usage
      fi
      ;;
  esac
done

[[ -z "$SPEC" || -z "$BRANCH" ]] && usage

# --dry-run is the default. A real run needs --execute AND the absence of --dry-run — an
# explicit --dry-run always wins over a stray --execute, never the other way round.
if [[ "$EXECUTE_FLAG" -eq 1 && "$DRY_RUN_FLAG" -eq 0 ]]; then
  DRY_RUN=0
else
  DRY_RUN=1
fi

if [[ ! -f "$SPEC" ]]; then
  echo "Refusing: spec file not found: $SPEC" >&2
  exit 1
fi

# --- CONTROL header check ---------------------------------------------------------------------
# Convention from docs/Prompts/_PROMPT-TEMPLATE.md:
#   CONTROL: model <Model> · effort <low|medium|high> · ...
CONTROL_LINE="$(grep -m1 '^CONTROL:' "$SPEC" || true)"
CONTROL_OK=1
MISSING_REASON=""
if [[ -z "$CONTROL_LINE" ]]; then
  CONTROL_OK=0
  MISSING_REASON="no line starting with 'CONTROL:' found in $SPEC"
elif ! echo "$CONTROL_LINE" | grep -qE 'model[[:space:]]+[^ ]+'; then
  CONTROL_OK=0
  MISSING_REASON="CONTROL line is missing an explicit 'model <name>'"
elif ! echo "$CONTROL_LINE" | grep -qE 'effort[[:space:]]+(low|medium|high)'; then
  CONTROL_OK=0
  MISSING_REASON="CONTROL line is missing an explicit 'effort <low|medium|high>'"
fi

EFFORT=""
if [[ "$CONTROL_OK" -eq 1 ]]; then
  EFFORT="$(echo "$CONTROL_LINE" | grep -oE 'effort[[:space:]]+(low|medium|high)' | awk '{print $2}')"
fi

MODEL=""
MODEL_OK=1
if [[ "$CONTROL_OK" -eq 1 ]]; then
  if ! MODEL="$(resolve_grok_model "$EFFORT")"; then
    MODEL_OK=0
    MISSING_REASON="could not resolve a Grok model for effort '$EFFORT'"
  fi
else
  MODEL_OK=0
fi

# --- Files affected extraction ------------------------------------------------------------
# Everything between a "## Files affected" heading and the next "## " heading (or EOF).
FILES_SECTION="$(awk '
  /^## Files affected/ { capture=1; next }
  /^## / && capture { capture=0 }
  capture { print }
' "$SPEC")"

ENV_OR_KEYCHAIN_HIT=0
if echo "$FILES_SECTION" | grep -qE '\.env[a-zA-Z0-9._-]*|keychain|credential-'; then
  ENV_OR_KEYCHAIN_HIT=1
fi

SENSITIVE_PATH_HIT=0
SENSITIVE_MATCH=""
while IFS= read -r raw_line; do
  # Strip leading whitespace and a markdown bullet ("- " or "* ") so the glob below matches
  # the path itself, not "- path".
  line="${raw_line#"${raw_line%%[![:space:]]*}"}"
  line="${line#- }"
  line="${line#\* }"
  [[ -z "$line" ]] && continue
  # Case-insensitive: repo paths mix camelCase (oracleGate.ts) and kebab-case (order-executor.ts).
  # tr, not bash4-only ${var,,}, to stay compatible with macOS's stock bash 3.2.
  line_lower="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"
  for pattern in "${SENSITIVE_FILE_PATTERNS[@]}"; do
    # Intentional glob match (unquoted $pattern), not a literal string comparison.
    # shellcheck disable=SC2053
    if [[ "$line_lower" == $pattern ]]; then
      SENSITIVE_PATH_HIT=1
      SENSITIVE_MATCH="$pattern (matched: $line)"
      break 2
    fi
  done
done <<< "$FILES_SECTION"

HIGH_TIER_HIT=0
if [[ "$EFFORT" == "high" ]]; then
  HIGH_TIER_HIT=1
fi

INTERACTIVE_REQUIRED=0
if [[ "$SENSITIVE_PATH_HIT" -eq 1 || "$HIGH_TIER_HIT" -eq 1 ]]; then
  INTERACTIVE_REQUIRED=1
fi

# --- worktree ----------------------------------------------------------------------------------
REPO_ROOT="$(git rev-parse --show-toplevel)"
MAIN_ROOT_LINE="$(git worktree list --porcelain | grep -m1 '^worktree ')"
MAIN_ROOT="${MAIN_ROOT_LINE#worktree }"

# FIX-GROK-GUARD-CLAIMS: GROK_WORKTREE_BASE_DIR must resolve to somewhere outside MAIN_ROOT — the
# repo directory holding the real, untracked .env* files. A base dir under it defeats the whole
# point (see the comment on GROK_WORKTREE_BASE_DIR above): reject outright, in --dry-run and
# --execute alike, rather than silently creating a worktree that can still reach them via
# ../../../. This is a configuration error, not a per-spec judgment call, so it fails before the
# usual refusal-checks report the way a missing spec file does.
case "$GROK_WORKTREE_BASE_DIR" in
  "$MAIN_ROOT" | "$MAIN_ROOT"/*)
    echo "Refusing: GROK_WORKTREE_BASE_DIR ($GROK_WORKTREE_BASE_DIR) is inside the repo ($MAIN_ROOT) — this is the exact hole FIX-GROK-GUARD-CLAIMS closes. Set TS_WORKTREE_BASE to a path outside the repo." >&2
    exit 1
    ;;
esac

WORKTREE_DIR="$GROK_WORKTREE_BASE_DIR/$BRANCH"

if [[ "$WORKTREE_DIR" == "$MAIN_ROOT" ]]; then
  echo "Refusing: resolved worktree path equals the main checkout. Never run Grok there." >&2
  exit 1
fi

GROK_CMD=(grok -p "\$(cat $SPEC)" --output-format json --no-auto-update "${GROK_DENY_FLAGS[@]}")
if [[ "$INTERACTIVE_REQUIRED" -eq 0 ]]; then
  GROK_CMD+=(--always-approve)
fi

# --- report ------------------------------------------------------------------------------------
echo "== grok-dispatch plan =="
echo "spec:              $SPEC"
echo "branch:            $BRANCH"
echo "mode:              $([[ "$DRY_RUN" -eq 1 ]] && echo dry-run || echo execute)"
echo "worktree:          $WORKTREE_DIR (git worktree add off origin/main)"
echo
echo "-- refusal checks --"
if [[ "$CONTROL_OK" -eq 1 && "$MODEL_OK" -eq 1 ]]; then
  echo "[ok]     CONTROL header present, effort=$EFFORT"
else
  echo "[REFUSE] CONTROL header invalid: $MISSING_REASON"
fi
echo "resolved model:    ${MODEL:-<none>}"
if [[ "$ENV_OR_KEYCHAIN_HIT" -eq 1 ]]; then
  echo "[REFUSE] Files affected references .env* or a keychain/credential helper"
else
  echo "[ok]     no .env*/keychain reference in Files affected"
fi
if [[ "$SENSITIVE_PATH_HIT" -eq 1 ]]; then
  echo "[interactive-only] Files affected matches a fund-flow-adjacent path: $SENSITIVE_MATCH"
else
  echo "[ok]     no fund-flow-adjacent path in Files affected"
fi
if [[ "$HIGH_TIER_HIT" -eq 1 ]]; then
  echo "[interactive-only] effort tier is high"
else
  echo "[ok]     effort tier is not high"
fi
echo "approval mode:     $([[ "$INTERACTIVE_REQUIRED" -eq 1 ]] && echo "interactive (no --always-approve)" || echo "--always-approve")"
echo
echo "-- exact command (cwd=\$WORKTREE_DIR) --"
printf '%q ' "${GROK_CMD[@]}"
echo

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "(dry-run: no worktree created, grok not invoked)"
  exit 0
fi

# --- hard refusals below this line only apply to a real (--execute) run -----------------------
REFUSE=0
if [[ "$CONTROL_OK" -eq 0 || "$MODEL_OK" -eq 0 ]]; then
  echo "Refusing: $MISSING_REASON" >&2
  REFUSE=1
fi
if [[ "$ENV_OR_KEYCHAIN_HIT" -eq 1 ]]; then
  echo "Refusing: Files affected references .env* or a credential helper — never dispatched." >&2
  REFUSE=1
fi
if [[ "$REFUSE" -eq 1 ]]; then
  exit 1
fi

if [[ -d "$WORKTREE_DIR" ]]; then
  echo "Refusing: worktree dir already exists: $WORKTREE_DIR" >&2
  exit 1
fi

git -C "$REPO_ROOT" fetch origin main -q
git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR" -b "$BRANCH" origin/main

pushd "$WORKTREE_DIR" > /dev/null
if [[ "$INTERACTIVE_REQUIRED" -eq 1 ]]; then
  echo "Running interactively (fund-flow-adjacent files or high tier) — approve each step by hand." >&2
fi
EXEC_GROK_CMD=(grok -p "$(cat "$SPEC")" --output-format json --no-auto-update "${GROK_DENY_FLAGS[@]}")
if [[ "$INTERACTIVE_REQUIRED" -eq 0 ]]; then
  EXEC_GROK_CMD+=(--always-approve)
fi
GROK_OUTPUT="$("${EXEC_GROK_CMD[@]}")"
popd > /dev/null

mkdir -p "$WORKTREE_DIR/docs/feedback"
FEEDBACK_FILE="$WORKTREE_DIR/docs/feedback/$BRANCH.md"
{
  echo "# Grok dispatch — $BRANCH"
  echo
  echo "Spec: $SPEC"
  echo "Model: $MODEL (effort=$EFFORT)"
  echo "Approval mode: $([[ "$INTERACTIVE_REQUIRED" -eq 1 ]] && echo interactive || echo --always-approve)"
  echo
  echo '```json'
  echo "$GROK_OUTPUT"
  echo '```'
} > "$FEEDBACK_FILE"

echo "Wrote $FEEDBACK_FILE. CI is not polled by this script — push and report manually."
