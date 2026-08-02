#!/usr/bin/env bash
# The README names commands, scripts and gates. Each must exist.
#
# WHY THIS EXISTS. Every document in this project that named something drifted from it: a prompt
# called a script deleted two builds ago, an install printed a required context no job produced, a
# reviewer was told to look for a keyword the gate refuses. A README is the first thing a person or
# an agent acts on, and it is the document with the least reason to be checked and the most reason
# to be right.
#
# Usage: check-readme.sh [readme] [framework-dir]
#        check-readme.sh --self-test
set -euo pipefail

case "${1:-}" in
  -*) [ "$1" = "--self-test" ] || {
        echo "::error::unknown option '$1'. This is a typo, not an argument — refusing." >&2; exit 2; } ;;
esac

run_check() {
  local rd=${1:-README.md} fw=${2:-framework} rc=0 x
  [ -f "$rd" ] || {
    echo "::error::$rd does not exist, so nothing was checked. This is a LOOKUP FAILURE and NOT a statement that it is correct." >&2
    return 1; }
  [ -d "$fw" ] || {
    echo "::error::$fw does not exist, so no claim could be verified." >&2; return 1; }

  while IFS= read -r x; do
    [ -n "$x" ] || continue
    [ -f "$fw/$x" ] || { echo "::error::README names $x, which does not exist" >&2; rc=1; }
  done < <(grep -oE '\.workflow/bin/[a-z-]+\.sh' "$rd" | sort -u)

  while IFS= read -r x; do
    [ -n "$x" ] || continue
    [ -f "$fw/.claude/commands/$x.md" ] || { echo "::error::README names /$x, which is not a command" >&2; rc=1; }
  done < <(grep -oE '`/[a-z-]+' "$rd" | tr -d '`/' | sort -u)

  # EVERY REQUIRED CONTEXT MUST APPEAR. A README that lists four of five gates teaches somebody to
  # protect a branch on four.
  local wf="$fw/.github/workflows/gates.yml" c n=0
  [ -f "$wf" ] || { echo "::error::$wf not found, so the gate list is unverified." >&2; return 1; }
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    n=$((n+1))
    grep -qF "$(printf '%s' "$c" | cut -c1-25)" "$rd" \
      || { echo "::error::gate '$c' is required by CI and absent from the README" >&2; rc=1; }
  done < <(sed -n '/BEGIN REQUIRED CONTEXTS/,/END REQUIRED CONTEXTS/p' "$wf" | sed -n 's/^#   //p')
  [ "$n" -gt 0 ] || { echo "::error::the workflow declares no contexts, so the README's gate list is unverifiable." >&2; rc=1; }

  [ "$rc" -eq 0 ] && echo "readme ok: every script, command and gate it names exists ($n gates checked)"
  return "$rc"
}

self_test() {
  local tmp rc=0 out me
  me=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN

  # 1. A MISSING README MUST REFUSE, not pass for lack of anything to read.
  out=$(bash "$me" "$tmp/none.md" "$tmp" 2>&1) && { echo "SELF-TEST FAIL: a missing README PASSED" >&2; rc=1; }
  case "$out" in *"LOOKUP FAILURE"*) : ;; *) echo "SELF-TEST FAIL: no explanation for a missing README" >&2; rc=1 ;; esac

  # 2. A NAMED SCRIPT THAT DOES NOT EXIST MUST FAIL — the defect this file is for.
  mkdir -p "$tmp/fw/.claude/commands" "$tmp/fw/.github/workflows" "$tmp/fw/.workflow/bin"
  printf '# BEGIN REQUIRED CONTEXTS\n#   Only Gate\n# END REQUIRED CONTEXTS\n' > "$tmp/fw/.github/workflows/gates.yml"
  printf 'Run `.workflow/bin/ghost.sh`. Gate: Only Gate\n' > "$tmp/r.md"
  bash "$me" "$tmp/r.md" "$tmp/fw" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: a README naming a nonexistent script PASSED" >&2; rc=1; }

  # 3. A GATE THE README OMITS MUST FAIL — four of five teaches somebody to protect on four.
  : > "$tmp/fw/.workflow/bin/real.sh"
  printf 'Run `.workflow/bin/real.sh`.\n' > "$tmp/r2.md"
  bash "$me" "$tmp/r2.md" "$tmp/fw" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: a README omitting a required gate PASSED" >&2; rc=1; }

  # 4. AND A CORRECT ONE MUST PASS, or the arms above prove nothing.
  printf 'Run `.workflow/bin/real.sh`. Gate: Only Gate\n' > "$tmp/r3.md"
  bash "$me" "$tmp/r3.md" "$tmp/fw" >/dev/null 2>&1 || { echo "SELF-TEST FAIL: a correct README was rejected" >&2; rc=1; }

  [ "$rc" -eq 0 ] && echo "self-test passed: a missing README refuses, a nonexistent script fails, an omitted gate fails, and a correct one passes"
  return "$rc"
}

case "${1:-}" in
  --self-test) self_test ;;
  *) run_check "${1:-README.md}" "${2:-framework}" ;;
esac
