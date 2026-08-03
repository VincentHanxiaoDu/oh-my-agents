#!/usr/bin/env bash
# This repository must run under the process it distributes, and this is what says so mechanically.
#
# WHY THIS EXISTS. For seventy-one commits it did not. agent-dev-flow defines five gates, states that
# nobody merges or reviews their own work, ships a `--protect` flag that configures branch protection
# for other people — and had no `.github/` of its own, no protected branch, and not one pull request.
# Every change went straight to `main` and was replicated into consumer repositories by wholesale file
# replacement, with nothing between an edit and production.
#
# THREE DEFECTS SHIPPED THAT WAY IN A SINGLE DAY, and each is precisely what the missing control
# catches:
#
#   - the review gate refused an archive-only pull request as though its commits carried no `Agent:`
#     trailer, about a commit carrying `Agent: product`. Unmergeable except with --admin.
#   - an exemption that a leading blank line flipped, so the gate and the routing gave different
#     answers on different git versions and a reviewer withdrew a verdict it had already posted.
#   - a self-test whose assertion passed with the line it was testing deleted.
#
# None was caught by a gate, because no gate ran. All three were caught by qa, in production. **A
# process its own author is exempt from is a recommendation**, and the exemption was invisible
# because nothing looked for it — the repository's own README describes the discipline, and a README
# is not a control.
#
# WHAT THIS CHECKS, AND WHY IT IS NOT JUST "A FILE EXISTS". The workflow at the root is GENERATED
# from the framework's own, so the gates this repository runs on itself cannot quietly become weaker
# than the ones it hands to everybody else — which is the failure mode a hand-written second copy
# arrives at within a few edits, always in the same direction.
#
# Usage: check-dogfood.sh [repo-root]
#        check-dogfood.sh --self-test
set -euo pipefail

case "${1:-}" in
  -*) [ "$1" = "--self-test" ] || {
        echo "::error::unknown option '$1'. This is a typo, not a path — refusing." >&2; exit 2; } ;;
esac

# THE SUBSTITUTION IS THE ONLY PERMITTED DIFFERENCE. Consumers install the scripts at
# `.workflow/bin/`; here they live under `framework/`. Everything else must match, so a gate cannot
# be relaxed for this repository alone.
render() { sed 's#\./\.workflow/bin/#./framework/.workflow/bin/#g' "$1"; }

run_check() {
  local root=${1:-.} rc=0 src dst
  src="$root/framework/.github/workflows/gates.yml"
  dst="$root/.github/workflows/gates.yml"

  # A MISSING FILE MUST REFUSE, NOT PASS FOR LACK OF ANYTHING TO READ. This check exists because of
  # an absence; reporting an absence as a pass would be the whole defect, restated.
  [ -f "$src" ] || {
    echo "::error::$src does not exist, so nothing was compared. This is a LOOKUP FAILURE and NOT a statement that this repository runs under its own process." >&2
    return 1
  }
  [ -f "$dst" ] || {
    echo "::error::$dst does not exist — THIS REPOSITORY DOES NOT RUN THE GATES IT DISTRIBUTES." >&2
    echo "  It defines five gates for other people and runs none of them on itself. Generate it:" >&2
    echo "    sed 's#\./\.workflow/bin/#./framework/.workflow/bin/#g' $src > $dst" >&2
    return 1
  }

  # THE GENERATED COPY MUST STILL BE THE FRAMEWORK'S OWN. Compared on the job and context
  # definitions rather than byte for byte, because the root copy carries a header explaining why it
  # exists and a comment is not a gate.
  local a b
  a=$(render "$src" | grep -vE '^\s*#' | grep -v '^\s*$')
  b=$(grep -vE '^\s*#' "$dst" | grep -v '^\s*$')
  if [ "$a" != "$b" ]; then
    echo "::error::the gates this repository runs on itself have DRIFTED from the ones it distributes." >&2
    echo "  That drift only ever goes one way. Regenerate rather than hand-edit:" >&2
    echo "    sed 's#\./\.workflow/bin/#./framework/.workflow/bin/#g' $src > $dst" >&2
    diff <(printf '%s\n' "$a") <(printf '%s\n' "$b") | head -20 >&2 || true
    rc=1
  fi

  # AND EVERY REQUIRED CONTEXT MUST BE PRODUCED HERE TOO. A repository that runs four of the five
  # gates it ships is not running its own process, and the missing one is always the expensive one.
  local c n=0
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    n=$((n+1))
    grep -qF "$c" "$dst" \
      || { echo "::error::context '$c' is required of every consumer and is not produced by this repository's own workflow" >&2; rc=1; }
  done < <(sed -n '/BEGIN REQUIRED CONTEXTS/,/END REQUIRED CONTEXTS/p' "$src" | sed -n 's/^#   //p')
  [ "$n" -gt 0 ] || { echo "::error::the framework workflow declares no contexts, so this comparison is vacuous." >&2; rc=1; }

  [ "$rc" -eq 0 ] && echo "dogfood ok: this repository runs the same $n gates it distributes, generated from the same file"
  return "$rc"
}

self_test() {
  local tmp rc=0 out me
  me=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/framework/.github/workflows" "$tmp/.github/workflows"

  # A minimal stand-in for the framework workflow, carrying the context block this reads.
  cat > "$tmp/framework/.github/workflows/gates.yml" <<'WF'
# BEGIN REQUIRED CONTEXTS
#   Build and tests
#   Reviewed by an agent that authored none of its commits
# END REQUIRED CONTEXTS
jobs:
  build:
    name: Build and tests
    steps:
      - run: ./.workflow/bin/run-gates.sh
  review:
    name: Reviewed by an agent that authored none of its commits
WF

  # 1. NO WORKFLOW AT THE ROOT MUST FAIL. This is the state the repository was actually in, and it
  #    is the one thing this check must never call fine.
  out=$(bash "$me" "$tmp" 2>&1) && { echo "SELF-TEST FAIL: a repository running none of its own gates PASSED" >&2; rc=1; }
  case "$out" in
    *"DOES NOT RUN THE GATES IT DISTRIBUTES"*) : ;;
    *) echo "SELF-TEST FAIL: the missing workflow was not named as such (got: $out)" >&2; rc=1 ;;
  esac

  # 2. THE CORRECTLY GENERATED COPY MUST PASS.
  sed 's#\./\.workflow/bin/#./framework/.workflow/bin/#g' \
    "$tmp/framework/.github/workflows/gates.yml" > "$tmp/.github/workflows/gates.yml"
  bash "$me" "$tmp" >/dev/null 2>&1 || { echo "SELF-TEST FAIL: a correctly generated copy was rejected" >&2; rc=1; }

  # 3. A COPY WITH A GATE REMOVED MUST FAIL — the drift this exists to catch, and it only ever goes
  #    in this direction. Nobody hand-edits their own gates to be stricter.
  grep -v 'Reviewed by an agent' "$tmp/.github/workflows/gates.yml" > "$tmp/x" && mv "$tmp/x" "$tmp/.github/workflows/gates.yml"
  out=$(bash "$me" "$tmp" 2>&1) && { echo "SELF-TEST FAIL: a copy with the review gate deleted PASSED" >&2; rc=1; }
  case "$out" in
    *DRIFTED*|*"is not produced by this repository"*) : ;;
    *) echo "SELF-TEST FAIL: a deleted gate was not reported (got: $out)" >&2; rc=1 ;;
  esac

  # 4. A MISSING SOURCE MUST REFUSE RATHER THAN PASS. An absent framework file means nothing was
  #    compared, which is not the same as agreement.
  rm -f "$tmp/framework/.github/workflows/gates.yml"
  out=$(bash "$me" "$tmp" 2>&1) && { echo "SELF-TEST FAIL: a missing source workflow PASSED" >&2; rc=1; }
  case "$out" in
    *"LOOKUP FAILURE"*) : ;;
    *) echo "SELF-TEST FAIL: a missing source was not distinguished from agreement (got: $out)" >&2; rc=1 ;;
  esac

  [ "$rc" -eq 0 ] && echo "self-test passed: a repository running none of its own gates fails, a generated copy passes, a weakened copy fails, and a missing source refuses"
  return $rc
}

[ "${1:-}" = "--self-test" ] && { self_test; exit $?; }
run_check "${1:-.}"
