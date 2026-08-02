#!/usr/bin/env bash
# Every open Issue appears in at least one role's queue.
#
# WHY THIS EXISTS. Two Issues sat open in a repository and every queue dropped them, each for a
# correct reason: dev's, because the work was already built; product's, because it had already
# verified them. They were waiting on a decision only the owner could make — a real state, and a
# legitimate one. It was also invisible, and correct-but-invisible is an orphan.
#
# The owner's first instruction about this process was that no state may be an orphan. This is that
# rule, made mechanical, because the filters that produce one are each individually right.
#
# Usage: check-no-orphans.sh
#        check-no-orphans.sh --self-test
set -euo pipefail

case "${1:-}" in
  -*) [ "$1" = "--self-test" ] || {
        echo "::error::unknown option '$1'. This is a typo, not an argument — refusing." >&2; exit 2; } ;;
esac

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

run_check() {
  local rc=0 open seen n
  # THE ISSUE LIST AND THE QUEUES MUST COME FROM THE SAME PLACE. Asking GitHub twice, differently,
  # would let a filtering bug in queue.sh hide behind a filtering bug here.
  open=$("$here/queue.sh" pm >/dev/null 2>&1 && gh api --paginate "repos/$(git config --get remote.origin.url | sed -E 's#^(https://[^/]+/|git@[^:]+:)##; s#\.git$##')/issues?state=open&per_page=100" 2>/dev/null \
         | jq -r '.[] | select(.pull_request==null) | .number' 2>/dev/null | sort -u) || {
    echo "::error::could not read the open Issues. This is a LOOKUP FAILURE and NOT a statement that none are orphaned." >&2
    return 1; }

  [ -n "$open" ] || { echo "no open Issues, so none can be orphaned."; return 0; }

  seen=$(for r in dev qa product ops pm; do
           "$here/queue.sh" "$r" 2>/dev/null | sed -n 's/^ *#\([0-9][0-9]*\) .*/\1/p'
         done | sort -u)

  while IFS= read -r n; do
    [ -n "$n" ] || continue
    printf '%s\n' "$seen" | grep -qx "$n" || {
      echo "::error::Issue #$n is open and appears in no role's queue." >&2
      echo "  Every filter that dropped it may be individually right; the Issue is still nobody's." >&2
      rc=1
    }
  done <<<"$open"

  [ "$rc" -eq 0 ] && echo "no orphans: every open Issue appears in at least one role's queue"
  return "$rc"
}

self_test() {
  local rc=0 out me
  # ABSOLUTE, because the arm below runs after a `cd`. A relative path there fails with "no such
  # file", which the assertion then reports as a missing explanation — a red for the wrong reason,
  # inside the check written to stop reds for the wrong reason.
  me=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")

  # A LOOKUP FAILURE MUST NOT READ AS "NO ORPHANS". Driven against a repository that cannot be read.
  out=$( cd "$(mktemp -d)" && git init -q -b main . && bash "$me" 2>&1 ) \
    && { echo "SELF-TEST FAIL: a repository with no remote reported no orphans" >&2; rc=1; }
  case "$out" in
    *"LOOKUP FAILURE"*|*"could not read"*|*"no repository"*) : ;;
    *) echo "SELF-TEST FAIL: an unreadable repository gave no explanation: $out" >&2; rc=1 ;;
  esac
  case "$out" in *"no orphans"*) echo "SELF-TEST FAIL: an unreadable repository reported no orphans" >&2; rc=1 ;; esac

  # THE QUEUES MUST BE THE SOURCE, not a second implementation of the routing rules — a copy would
  # agree with itself while both drifted from what a role actually sees.
  grep -q 'queue.sh" "\$r"' "${BASH_SOURCE[0]}" \
    || { echo "SELF-TEST FAIL: this does not read the real queues, so it cannot see what a role sees" >&2; rc=1; }

  [ "$rc" -eq 0 ] && echo "self-test passed: an unreadable repository refuses rather than reporting no orphans, and the queues are the source"
  return "$rc"
}

case "${1:-}" in
  --self-test) self_test ;;
  *) run_check ;;
esac
