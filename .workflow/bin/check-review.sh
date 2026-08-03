#!/usr/bin/env bash
# Gate 5 of 5: this head sha carries a review by an agent that authored none of its commits.
#
# Two questions survive the mechanical gates, and no test answers either: does this do what the
# Issue asked, and did it go wider than it should. That is what a review is for and the whole of it.
#
# Usage: check-review.sh <head-sha> <comments-json> <base-sha>
#        check-review.sh --self-test
set -euo pipefail

case "${1:-}" in
  -*) [ "$1" = "--self-test" ] || {
        echo "::error::unknown option '$1'. This is a typo, not an argument — refusing." >&2; exit 2; } ;;
esac

# THERE IS NO SUBSTANCE FLOOR MEASURED IN CHARACTERS. The previous build had one at 40 and it
# rejected an accurate 38-character scope statement while accepting 45 characters of "looks fine
# to me". A length is not a proxy for having looked. Emptiness is the only thing checkable here;
# everything else is the reviewer's judgement, and pretending otherwise moved the judgement into
# a number that could not hold it.
run_gate() {
  local head=$1 comments=$2 base=${3:-} rc=0 refused=0 authors reviewer verdict sha

  [ -f "$comments" ] || {
    echo "::error::'$comments' does not exist, so no review was examined. This is a LOOKUP FAILURE and NOT a statement that no review exists." >&2
    return 1
  }
  [ -n "$base" ] || {
    echo "::error::no base sha given, so the authors of this PR cannot be determined and independence cannot be judged. Refusing." >&2
    return 1
  }
  git rev-parse --verify --quiet "$base^{commit}" >/dev/null || {
    echo "::error::base commit '$base' is not in this clone. This is a CHECKOUT problem and NOT a verdict about the review." >&2
    return 1
  }

  # Who built it: the Agent: trailer of every commit in the range.
  # DERIVED BY pr-authors.sh, WHICH THE ROUTING ALSO CALLS. The rule includes one exemption — a
  # commit that changes nothing outside `openspec/` confers no authorship — and it is stated in
  # exactly one place on purpose. product must archive onto the branch before merging, so without
  # the exemption product authors every feature pull request and qa becomes the only role that can
  # ever certify one. That is a single point of failure by construction, and it deadlocked a board
  # of eleven. The exemption is earned by the diff and never by the subject line.
  authors=$("$(dirname "${BASH_SOURCE[0]}")/pr-authors.sh" --range "$base" HEAD)
  [ -n "$authors" ] || {
    # SAY WHOSE PROBLEM THIS IS. This red is not about the review — it is about the commits, and a
    # reviewer reading "no independent review" concludes it is theirs to fix. The naming gate now
    # catches a missing trailer first and names the remedy; if this still fires, say plainly that
    # nothing here is a verdict on the review.
    echo "::error::no commit in $base..HEAD carries an 'Agent:' trailer, so who built this cannot be determined." >&2
    echo "  THIS IS NOT A VERDICT ON ANY REVIEW. It is a defect in the commits: add 'Agent: <role>'" >&2
    echo "  to each of them. The 'Branch name and commit convention' gate reports the same thing" >&2
    echo "  with the remedy, and it is the one to act on." >&2
    return 1
  }

  # The most recent review for THIS head sha. A push invalidates every prior review, which is why
  # the sha is part of the attestation rather than implied by it.
  local block
  block=$(jq -r --arg h "$head" '
    [ .[] | .body
      | select(test("Reviewed-by:"))
      | select(test("Reviewed-sha:[[:space:]]*" + $h)) ] | last // ""' "$comments")

  [ -n "$block" ] || {
    echo "::error::no review found for head $head. A push invalidates any earlier review — this head needs its own." >&2
    return 1
  }

  reviewer=$(printf '%s' "$block" | sed -n 's/^Reviewed-by:[[:space:]]*//p' | head -1)
  verdict=$(printf '%s' "$block"  | sed -n 's/^Verdict:[[:space:]]*//p'     | head -1)

  [ -n "$reviewer" ] || { echo "::error::the review names no reviewer" >&2; rc=1; }
  case "$verdict" in
    approve) : ;;
    # EXIT 2, NOT 1. A refused review and an absent one are different facts, and they shared an
    # exit code — so the workflow could only publish one description for both, and a reviewer that
    # had just refused a pull request read "No current review by an independent agent" and could not
    # tell its verdict had landed from its comment never being parsed. Caught by a reviewer that
    # checked the fix rather than the claim; the previous attempt grepped a log file and did not work.
    changes-requested) echo "::error::the current review requests changes" >&2; refused=1 ;;
    "") echo "::error::the review carries no Verdict:" >&2; rc=1 ;;
    *) echo "::error::unknown verdict '$verdict' — expected approve or changes-requested" >&2; rc=1 ;;
  esac

  # INDEPENDENCE. An agent that wrote any commit in this range cannot certify it — including the pm.
  if printf '%s\n' "$authors" | grep -qx "$reviewer"; then
    echo "::error::'$reviewer' authored commits in this PR, so its review does not establish independence" >&2
    rc=1
  fi

  # A REFUSAL SURVIVES EVERY OTHER COMPLAINT ABOUT THE SAME REVIEW, and this is the line that makes
  # it so. `rc` used to be one scalar that each check overwrote in turn, so a `changes-requested`
  # set 2 and the independence check three lines later set 1 — and the workflow, reading the exit
  # code to choose its wording, published "No current review by an independent agent" over a
  # verdict that had landed and refused. That is exactly the confusion the exit code was split to
  # end, reintroduced from the other side. Driven on PR #42: the log carried BOTH errors and the
  # process exited 1. The refusal is the fact the reviewer needs back, so it is the one that sets
  # the code; the other errors still print, and nothing is certified that was not certified before
  # — 2 is a failure like 1 is.
  # `if`, not `[ … ] && rc=2`: under `set -e` a bare AND-list whose test fails is a failing
  # statement, and the good-approve path (refused=0) would abort the script instead of returning 0.
  if [ "$refused" -eq 1 ]; then rc=2; fi

  [ "$rc" -eq 0 ] && echo "review ok: $head reviewed by '$reviewer', which authored none of its commits"
  return "$rc"
}

self_test() {
  local tmp rc=0 out me
  me=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN

  git -C "$tmp" init -q -b main 2>/dev/null || { mkdir -p "$tmp"; git -C "$tmp" init -q -b main; }
  git -C "$tmp" config user.email t@t; git -C "$tmp" config user.name t
  echo x > "$tmp/f"; git -C "$tmp" add -A; git -C "$tmp" commit -qm "chore: seed"
  local base; base=$(git -C "$tmp" rev-parse HEAD)
  echo y > "$tmp/g"; git -C "$tmp" add -A
  git -C "$tmp" commit -qm "fix(x): y

Agent: dev-a"
  local head; head=$(git -C "$tmp" rev-parse HEAD)

  _c() { printf '[{"body":"%s"}]' "$1" > "$tmp/c.json"; }
  _run() { ( cd "$tmp" && bash "$me" "$head" "$tmp/c.json" "$base" ) 2>&1; }

  # 1. A MISSING COMMENTS FILE MUST REFUSE — not report that no review exists. Those are different
  #    values and the whole project turns on the difference.
  out=$( cd "$tmp" && bash "$me" "$head" "$tmp/absent.json" "$base" 2>&1 ) \
    && { echo "SELF-TEST FAIL: a missing comments file PASSED" >&2; rc=1; }
  case "$out" in
    *"LOOKUP FAILURE"*) : ;;
    *) echo "SELF-TEST FAIL: a missing comments file was not distinguished from an absent review" >&2; rc=1 ;;
  esac

  # 2. An independent approve for this head must PASS.
  _c "Reviewed-by: reviewer-a\\nReviewed-sha: $head\\nVerdict: approve"
  _run >/dev/null || { echo "SELF-TEST FAIL: an independent approve was rejected" >&2; rc=1; }

  # 3. A REVIEW BY THE AUTHOR MUST FAIL. This is the rule the other four gates depend on.
  _c "Reviewed-by: dev-a\\nReviewed-sha: $head\\nVerdict: approve"
  _run >/dev/null 2>&1 && { echo "SELF-TEST FAIL: an author reviewing its own work PASSED" >&2; rc=1; }

  # 4. A review of a DIFFERENT sha must not certify this head — a push invalidates a review.
  _c "Reviewed-by: reviewer-a\\nReviewed-sha: 0000000000000000000000000000000000000000\\nVerdict: approve"
  _run >/dev/null 2>&1 && { echo "SELF-TEST FAIL: a review of another sha certified this head" >&2; rc=1; }

  # 5. changes-requested must FAIL, AND WITH ITS OWN EXIT CODE. Sharing one with "no review at all"
  #    is why a reviewer could not tell a landed refusal from an unparsed comment.
  _c "Reviewed-by: reviewer-a\\nReviewed-sha: $head\\nVerdict: changes-requested"
  local crc=0; _run >/dev/null 2>&1 || crc=$?
  [ "$crc" -eq 2 ] || { echo "SELF-TEST FAIL: changes-requested exited $crc, not 2 — it shares a code with an absent review" >&2; rc=1; }
  # And an ABSENT review must NOT use that code.
  _c "Reviewed-by: reviewer-a\\nReviewed-sha: 0000000000000000000000000000000000000000\\nVerdict: approve"
  local arc=0; _run >/dev/null 2>&1 || arc=$?
  [ "$arc" -eq 1 ] || { echo "SELF-TEST FAIL: an absent review exited $arc, not 1" >&2; rc=1; }

  # 5b. A REFUSAL BY A NON-INDEPENDENT REVIEWER STILL EXITS 2. Case 5 only ever exercised a refusal
  #     with nothing else wrong with it, so it stayed green while `rc` was a single scalar that the
  #     independence check overwrote — and PR #42, whose refusal came from an agent that had also
  #     committed, exited 1 and was published as "No current review by an independent agent". Two
  #     complaints about one review; the refusal is the one the reviewer needs back.
  _c "Reviewed-by: dev-a\\nReviewed-sha: $head\\nVerdict: changes-requested"
  local nrc=0; _run >/dev/null 2>&1 || nrc=$?
  [ "$nrc" -eq 2 ] || { echo "SELF-TEST FAIL: a refusal by a non-independent reviewer exited $nrc, not 2 — a landed refusal reads as no review at all" >&2; rc=1; }

  # 6. AN ACCURATE SHORT REVIEW MUST PASS. The previous build's character floor rejected a
  #    38-character scope statement and accepted 45 characters of "looks fine to me".
  _c "Reviewed-by: reviewer-a\\nReviewed-sha: $head\\nVerdict: approve\\nScope: one file, as asked."
  _run >/dev/null || { echo "SELF-TEST FAIL: a short but accurate review was rejected" >&2; rc=1; }

  [ "$rc" -eq 0 ] && echo "self-test passed: a missing file refuses, an author cannot certify its own work, a stale sha does not carry over, and a short accurate review passes"
  return "$rc"
}

case "${1:-}" in
  --self-test) self_test ;;
  "") echo "usage: check-review.sh <head-sha> <comments-json> <base-sha> | --self-test" >&2; exit 2 ;;
  *) run_gate "$1" "${2:-}" "${3:-}" ;;
esac
