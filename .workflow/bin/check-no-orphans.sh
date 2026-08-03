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
# **pm IS NOT A WORKING QUEUE, AND COUNTING IT MADE THIS CHECK REPORT THE OPPOSITE OF THE TRUTH.**
# pm's arms are diagnostic: `UNTYPED — cannot be routed until they carry a type: label` lists exactly
# the Issues that no working role can see. Counting pm as "a role's queue" therefore meant **an Issue
# was considered routed BECAUSE it had been reported as unroutable.**
#
# Measured on a live board: twelve open Issues carried no `type:` label, so `queue.sh dev` — which
# filters on `any(startswith("type:"))` — showed none of them. Two were the blockers holding up a
# release, and a product agent correctly reported it could not determine whether anyone had picked
# them up. Nobody had, and nobody could. This check said `no orphans: every open Issue appears in at
# least one role's queue`, which was true as written and false about the thing it exists to answer.
#
# Only dev, qa, product and ops route work. If an Issue is in none of theirs, it is nobody's — and
# being named in pm's diagnostic list is the report of that, not a refutation of it.
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

  BLOCKED=$(gh api --paginate "repos/$(git config --get remote.origin.url | sed -E 's#^(https://[^/]+/|git@[^:]+:)##; s#\.git$##')/issues?state=open&labels=blocked&per_page=100" 2>/dev/null \
            | jq -r '.[] | select(.pull_request==null) | .number' 2>/dev/null | sort -u || echo "")

  # WORKING QUEUES ONLY. pm is excluded on purpose — see the note at the top of this file.
  seen=$(for r in dev qa product ops; do
           "$here/queue.sh" "$r" 2>/dev/null | sed -n 's/^ *#\([0-9][0-9]*\) .*/\1/p'
         done | sort -u)

  # pm's OWN DIAGNOSIS, READ SO THE REPORT CAN NAME THE REMEDY. An orphan with no explanation sends
  # somebody to read four queue implementations; "it carries no type: label" is one command to fix.
  local pmout untyped unclassified
  pmout=$("$here/queue.sh" pm 2>/dev/null || echo "")
  untyped=$(printf '%s\n' "$pmout" | sed -n '/UNTYPED/,/^$/p' | sed -n 's/^ *#\([0-9][0-9]*\) .*/\1/p')
  unclassified=$(printf '%s\n' "$pmout" | sed -n '/UNCLASSIFIED/,/^$/p' | sed -n 's/^ *#\([0-9][0-9]*\) .*/\1/p')

  local parked=""
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    printf '%s\n' "$seen" | grep -qx "$n" && continue
    # DELIBERATELY PARKED IS A DETERMINED STATE, NOT A LOST ONE, and the two must not render alike.
    # A `blocked` label is somebody's decision; it is NAMED so the parking stays visible, and it does
    # not fail — a check that is permanently red for states somebody chose is a check people stop
    # reading, and then it cannot report the ones nobody chose either.
    if printf '%s\n' "$BLOCKED" | grep -qx "$n"; then parked="$parked $n"; continue; fi
    echo "::error::Issue #$n is open and appears in NO WORKING role's queue (dev, qa, product, ops)." >&2
    if printf '%s\n' "$untyped" | grep -qx "$n"; then
      echo "  It carries no 'type:' label, so every working queue filters it out. Nobody can see it," >&2
      echo "  and pm listing it as UNTYPED is the report of that, not a route. Remedy:" >&2
      echo "    gh issue edit $n --add-label type:bug|type:feature|type:chore" >&2
    elif printf '%s\n' "$unclassified" | grep -qx "$n"; then
      echo "  It carries no 'area:' label. Remedy: gh issue edit $n --add-label area:product|area:machinery" >&2
    else
      echo "  Every filter that dropped it may be individually right; the Issue is still nobody's." >&2
    fi
    rc=1
  done <<<"$open"

  [ -n "$parked" ] && echo "parked, not orphaned — carrying the 'blocked' label and in no working queue by decision:$parked"
  [ "$rc" -eq 0 ] && echo "no orphans: every open Issue appears in a WORKING role's queue (dev, qa, product, ops; pm's diagnostic lists do not count)"
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

  # AN ISSUE VISIBLE ONLY TO pm IS AN ORPHAN, DRIVEN THROUGH THE REAL ENTRY POINT.
  #
  # **This is the arm that was missing, and its absence is why the defect shipped.** Everything here
  # was assertions about the source — "it reads the real queues" — and the source did read the real
  # queues; it just counted the wrong one. A grep cannot see that pm's UNTYPED list is a report of
  # unroutability rather than a route.
  local tmp out
  tmp=$(mktemp -d)
  git -C "$tmp" init -q -b main
  git -C "$tmp" remote add origin https://github.com/x/y.git
  cat > "$tmp/queue.sh" <<'STUB'
#!/usr/bin/env bash
# Stub board: #1 is routed to dev; #2 is visible ONLY in pm's UNTYPED list.
case "$1" in
  dev) printf '\nISSUES TO RESOLVE:\n  #1  routed\n' ;;
  pm)  printf '\nUNTYPED — cannot be routed until they carry a type: label:\n  #2  invisible\n\n' ;;
  *)   printf '\n(none)\n' ;;
esac
STUB
  chmod +x "$tmp/queue.sh"
  cat > "$tmp/gh" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *labels=blocked*) echo '[]' ;;
  *) echo '[{"number":1},{"number":2}]' ;;
esac
STUB
  chmod +x "$tmp/gh"
  cp "${BASH_SOURCE[0]}" "$tmp/check-no-orphans.sh"
  out=$( cd "$tmp" && PATH="$tmp:$PATH" bash "$tmp/check-no-orphans.sh" 2>&1 ) \
    && { echo "SELF-TEST FAIL: an Issue appearing ONLY in pm's UNTYPED list was reported as routed — pm's diagnosis of unroutability was counted as a route" >&2; rc=1; }
  case "$out" in
    *"#2 is open and appears in NO WORKING role"*) : ;;
    *) echo "SELF-TEST FAIL: the pm-only Issue was not named as an orphan (got: $out)" >&2; rc=1 ;;
  esac
  # AND THE REPORT MUST CARRY THE REMEDY. An orphan with no next action sends somebody to read four
  # queue implementations to discover it needed one label.
  case "$out" in
    *"--add-label type:"*) : ;;
    *) echo "SELF-TEST FAIL: an untyped orphan was reported without the one command that fixes it" >&2; rc=1 ;;
  esac
  # A ROUTED ISSUE MUST NOT BE REPORTED. An orphan check that flags everything is not a check.
  case "$out" in
    *"#1 is open"*) echo "SELF-TEST FAIL: an Issue routed to dev was reported as an orphan" >&2; rc=1 ;;
  esac

  # A `blocked` ISSUE IS PARKED, NOT ORPHANED, and must be named without failing — two different
  # states, and a check permanently red for states somebody chose stops being read at all.
  cat > "$tmp/gh" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *labels=blocked*) echo '[{"number":2}]' ;;
  *) echo '[{"number":1},{"number":2}]' ;;
esac
STUB
  chmod +x "$tmp/gh"
  out=$( cd "$tmp" && PATH="$tmp:$PATH" bash "$tmp/check-no-orphans.sh" 2>&1 ) \
    || { echo "SELF-TEST FAIL: an Issue deliberately parked with 'blocked' failed the check as an orphan" >&2; rc=1; }
  case "$out" in
    *"parked, not orphaned"*) : ;;
    *) echo "SELF-TEST FAIL: a parked Issue passed silently — the parking must stay visible (got: $out)" >&2; rc=1 ;;
  esac
  rm -rf "$tmp"

  [ "$rc" -eq 0 ] && echo "self-test passed: an unreadable repository refuses rather than reporting no orphans, the queues are the source, an Issue visible only to pm is an orphan and is told how to fix it, and a blocked Issue is parked rather than orphaned"
  return "$rc"
}

case "${1:-}" in
  --self-test) self_test ;;
  *) run_check ;;
esac
