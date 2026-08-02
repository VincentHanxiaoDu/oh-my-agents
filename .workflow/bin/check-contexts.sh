#!/usr/bin/env bash
# Every context branch protection requires must actually be produced by the workflow.
#
# WHY THIS EXISTS. The installer derived the list from job NAMES. A job's name and the context it
# PUBLISHES are different strings, and the moment one job was renamed the protection required
# "Review gate ran (the verdict is a commit status)" — green whenever the job executes — while the
# verdict it publishes was required by nothing. A pull request merged with its review status red,
# and the protection was working exactly as configured.
#
# So the workflow DECLARES its contexts and this proves each one is real: produced either as a job
# name or as a status this workflow posts.
#
# Usage: check-contexts.sh [workflow]     default: .github/workflows/gates.yml
#        check-contexts.sh --self-test
set -euo pipefail

case "${1:-}" in
  -*) [ "$1" = "--self-test" ] || {
        echo "::error::unknown option '$1'. This is a typo, not an argument — refusing." >&2; exit 2; } ;;
esac

declared() { sed -n '/# BEGIN REQUIRED CONTEXTS/,/# END REQUIRED CONTEXTS/p' "$1" \
             | sed -n 's/^#   \(.*\)$/\1/p'; }

run_check() {
  local wf=${1:-.github/workflows/gates.yml} rc=0 c
  [ -f "$wf" ] || {
    echo "::error::$wf does not exist, so no context was examined. This is a LOOKUP FAILURE and NOT a statement that the contexts are correct." >&2
    return 1; }

  local list; list=$(declared "$wf")
  [ -n "$list" ] || {
    echo "::error::$wf declares no required contexts. Without the block, the installer has to guess, and guessing is what protected main on a context nothing produced." >&2
    return 1; }

  while IFS= read -r c; do
    [ -n "$c" ] || continue
    # Produced as a job name, or posted as a status by this workflow.
    if grep -qF "name: $c" "$wf" || grep -qF "context=\"$c\"" "$wf"; then
      echo "  ok  $c"
    else
      echo "::error::declared context '$c' is produced by nothing in $wf." >&2
      echo "  Requiring it would block every pull request on a check that never arrives." >&2
      rc=1
    fi
  done <<<"$list"

  # AND THE REVERSE: a job whose name is required must not be mistaken for a verdict it does not
  # carry. Any job that publishes a status must NOT have that status's name as its own job name.
  local ctx
  while IFS= read -r ctx; do
    [ -n "$ctx" ] || continue
    if grep -qF "context=\"$ctx\"" "$wf" && grep -qF "name: $ctx" "$wf"; then
      echo "::error::'$ctx' is both a job name and a published status. A green job name then reads as the verdict, which is how an unreviewed pull request looked reviewed." >&2
      rc=1
    fi
  done <<<"$list"

  [ "$rc" -eq 0 ] && echo "contexts ok: every declared context is produced, and no verdict shares a name with the job that computes it"
  return "$rc"
}

self_test() {
  local tmp rc=0 out; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN

  # 1. A MISSING WORKFLOW MUST REFUSE.
  out=$(run_check "$tmp/none.yml" 2>&1) && { echo "SELF-TEST FAIL: a missing workflow PASSED" >&2; rc=1; }
  case "$out" in *"LOOKUP FAILURE"*) : ;; *) echo "SELF-TEST FAIL: no explanation for a missing workflow" >&2; rc=1 ;; esac

  # 2. NO DECLARATION MUST REFUSE rather than pass for lack of anything to check.
  printf 'jobs:\n  a:\n    name: Something\n' > "$tmp/undeclared.yml"
  run_check "$tmp/undeclared.yml" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: a workflow declaring nothing PASSED" >&2; rc=1; }

  # 3. A DECLARED CONTEXT NOTHING PRODUCES MUST FAIL. This is the defect: protection on a check
  #    that never arrives holds every pull request forever.
  printf '# BEGIN REQUIRED CONTEXTS\n#   Ghost\n# END REQUIRED CONTEXTS\njobs:\n  a:\n    name: Real\n' > "$tmp/ghost.yml"
  run_check "$tmp/ghost.yml" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: a context produced by nothing PASSED" >&2; rc=1; }

  # 4. A VERDICT SHARING ITS NAME WITH ITS JOB MUST FAIL — the rename that caused all this.
  printf '# BEGIN REQUIRED CONTEXTS\n#   Reviewed\n# END REQUIRED CONTEXTS\njobs:\n  a:\n    name: Reviewed\n    run: gh api -f context="Reviewed"\n' > "$tmp/dup.yml"
  run_check "$tmp/dup.yml" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: a job named after the status it publishes PASSED" >&2; rc=1; }

  # 5. THE SHIPPED WORKFLOW MUST PASS.
  local here; here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  [ ! -f "$here/.github/workflows/gates.yml" ] || run_check "$here/.github/workflows/gates.yml" >/dev/null 2>&1 \
    || { echo "SELF-TEST FAIL: the shipped workflow does not satisfy this check" >&2; rc=1; }

  [ "$rc" -eq 0 ] && echo "self-test passed: a missing workflow refuses, an undeclared one refuses, a context nothing produces fails, and a job named after its own verdict fails"
  return "$rc"
}

case "${1:-}" in
  --self-test) self_test ;;
  *) run_check "${1:-.github/workflows/gates.yml}" ;;
esac
