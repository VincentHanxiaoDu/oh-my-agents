#!/usr/bin/env bash
# Is there API budget left, and how much of it belongs to the work rather than to watching the work?
#
# WHY THIS EXISTS. The watches and the agents draw on ONE 5000-requests-per-hour allowance, and
# nothing reserved any of it for the agents. **An instrument that consumes the thing it measures**:
# the watch polls, the poll spends the budget the role needs to do its job, the role's own calls then
# fail, and the watch reports LOOKUP FAILED for polls that its own polling made impossible. A role
# said it exactly: *"my check failed and cost the watch its poll in the same window."*
#
# THE ARITHMETIC, MEASURED RATHER THAN GUESSED, by counting calls through a stub `gh` on a board with
# six open pull requests:
#
#   watch-prs.sh   one poll  ≈  2 + 3 per open PR   ≈ 20 calls
#   queue.sh       one run   ≈  8 + 4 per open PR   ≈ 32 calls
#   ------------------------------------------------------------
#   one role, one poll of both                      ≈ 52 calls
#
#   at 60s  × 3 roles →  9360 calls/hour   — 1.9× OVER the limit, before any agent does any work
#   at 300s × 3 roles →  1872 calls/hour   — 37% of budget, leaving the rest for the work
#
# **The prompts prescribed 60 seconds.** A product agent independently raised its own watch to 300s
# and said why; it was right, and the framework was wrong. The default is now 300 and the number
# above is why. Nothing on a review board moves on a sixty-second timescale.
#
# READING THE LIMIT IS FREE. `GET /rate_limit` is documented as not counting against the limit, which
# is what makes a reservation checkable rather than another thing to spend.
#
# Usage: gh-budget.sh check [reserve]   # exit 0 if remaining > reserve, 1 if not, 2 if unknown
#        gh-budget.sh reset-in          # seconds until the core limit resets
#        gh-budget.sh --self-test
set -euo pipefail

# THE RESERVE IS FOR THE WORK, NOT FOR THE WATCHING. Below it, watching stops and the role keeps
# what is left — because a role that cannot call the API cannot review, merge, or close anything,
# and a watch that is still polling while that is true has inverted its own purpose.
DEFAULT_RESERVE=${ADF_BUDGET_RESERVE:-1500}

case "${1:-}" in
  check|reset-in|--self-test) : ;;
  *) echo "::error::usage: gh-budget.sh check [reserve] | reset-in | --self-test" >&2; exit 2 ;;
esac

read_budget() { # -> "<remaining> <reset-epoch>" or empty
  gh api rate_limit --jq '"\(.resources.core.remaining) \(.resources.core.reset)"' 2>/dev/null || echo ""
}

do_check() {
  local reserve=${1:-$DEFAULT_RESERVE} b rem reset
  b=$(read_budget)
  # UNKNOWN IS ITS OWN ANSWER AND IT IS NOT "PLENTY". If the budget cannot be read, saying yes would
  # spend what may not be there and saying no would stop a watch for a reason that may not exist.
  # Exit 2, and the caller decides — every caller here treats it as "poll, but say it was unknown".
  if [ -z "$b" ]; then
    echo "BUDGET UNKNOWN — could not read the rate limit. This is a LOOKUP FAILURE and NOT a statement that there is budget."
    return 2
  fi
  rem=${b% *}; reset=${b#* }
  if [ "$rem" -gt "$reserve" ]; then
    echo "$rem"
    return 0
  fi
  local in=$(( reset - $(date +%s) ))
  [ "$in" -lt 0 ] && in=0
  echo "$rem left, at or below the reserve of $reserve; resets in ${in}s"
  return 1
}

self_test() {
  local rc=0 tmp out
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN
  cp "${BASH_SOURCE[0]}" "$tmp/gh-budget.sh"

  # 1. PLENTY OF BUDGET PASSES.
  printf '#!/usr/bin/env bash\necho "4900 %s"\n' "$(( $(date +%s) + 600 ))" > "$tmp/gh"; chmod +x "$tmp/gh"
  ( PATH="$tmp:$PATH" bash "$tmp/gh-budget.sh" check 1500 ) >/dev/null 2>&1 \
    || { echo "SELF-TEST FAIL: 4900 remaining against a reserve of 1500 was reported as exhausted" >&2; rc=1; }

  # 2. BELOW THE RESERVE FAILS, AND SAYS WHEN IT WILL RECOVER. A stop with no recovery time is a
  #    stop a role cannot plan around.
  printf '#!/usr/bin/env bash\necho "900 %s"\n' "$(( $(date +%s) + 300 ))" > "$tmp/gh"
  out=$( PATH="$tmp:$PATH" bash "$tmp/gh-budget.sh" check 1500 2>&1 ) \
    && { echo "SELF-TEST FAIL: 900 remaining against a reserve of 1500 PASSED" >&2; rc=1; }
  case "$out" in
    *"resets in"*) : ;;
    *) echo "SELF-TEST FAIL: being below the reserve did not say when it recovers (got: $out)" >&2; rc=1 ;;
  esac

  # 3. AN UNREADABLE LIMIT IS NEITHER. **This is the one that matters.** Reporting "no budget" would
  #    stop every watch on an unrelated outage; reporting "budget" would spend what may not exist.
  #    It is exit 2, distinct from both, and it says LOOKUP FAILURE in the words this project uses.
  printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/gh"
  local urc=0
  out=$( PATH="$tmp:$PATH" bash "$tmp/gh-budget.sh" check 1500 2>&1 ) || urc=$?
  [ "$urc" -eq 2 ] || { echo "SELF-TEST FAIL: an unreadable rate limit exited $urc, not 2 — it must not share an answer with 'plenty' or with 'exhausted'" >&2; rc=1; }
  case "$out" in
    *"LOOKUP FAILURE"*) : ;;
    *) echo "SELF-TEST FAIL: an unreadable limit was not named as a lookup failure (got: $out)" >&2; rc=1 ;;
  esac

  [ "$rc" -eq 0 ] && echo "self-test passed: headroom passes, below-reserve fails and says when it recovers, and an unreadable limit is neither"
  return $rc
}

[ "$1" = "--self-test" ] && { self_test; exit $?; }
[ "$1" = "reset-in" ] && {
  b=$(read_budget)
  [ -n "$b" ] || { echo 60; exit 2; }
  in=$(( ${b#* } - $(date +%s) )); [ "$in" -lt 0 ] && in=0
  echo "$in"; exit 0
}
do_check "${2:-}"
