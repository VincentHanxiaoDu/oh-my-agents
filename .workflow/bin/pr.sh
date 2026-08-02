#!/usr/bin/env bash
# Open a pull request, read its real state, arm auto-merge. One command per act, and each one says
# what it found rather than leaving the caller to know.
#
# WHY THIS EXISTS. Everything here was prose in a role prompt, and prose is read once, before it is
# needed. Each of these was a measured failure:
#
#   - `gh pr create` and `gh pr merge --auto` are GraphQL calls. That quota runs out separately from
#     REST and, when it did, they failed while REST kept working.
#   - CHECK RUNS AND COMMIT STATUSES ARE DIFFERENT ENDPOINTS. The review verdict lives only in the
#     status. An agent read the check runs, saw green, and took an unreviewed pull request as
#     reviewed. Another fixed the one red the check runs showed and never saw the one blocking it.
#   - `gh pr merge --auto` exits 0 while refusing, and some repositories disallow auto-merge
#     entirely. An agent that does not read back reports an armed pull request that is not armed.
#
# Usage: pr.sh open <branch> <title> <body-file>
#        pr.sh state <number> [--brief]     exits 1 on red, 2 on no answer yet — so it kills an
#                                            `&&` chain by design; use `;` or check $? .
#        pr.sh arm <number>
#        pr.sh rereview <number>
#        pr.sh --self-test
set -euo pipefail

case "${1:-}" in
  -*) [ "$1" = "--self-test" ] || {
        echo "::error::unknown option '$1'. This is a typo, not an argument — refusing." >&2; exit 2; } ;;
esac

resolve_repo() {
  [ -n "${REPO:-}" ] && return 0
  local url; url=$(git config --get remote.origin.url 2>/dev/null || echo "")
  [ -n "$url" ] && REPO=$(printf '%s' "$url" | sed -E 's#^(https://[^/]+/|git@[^:]+:)##; s#\.git$##')
  [ -n "${REPO:-}" ] || { echo "::error::no repository: no 'origin' remote here. Set REPO." >&2; exit 2; }
}

# --- open --------------------------------------------------------------------
do_open() {
  local branch=$1 title=$2 bodyfile=$3 out num base
  resolve_repo
  [ -f "$bodyfile" ] || { echo "::error::body file '$bodyfile' does not exist. Refusing to open a pull request with an empty body." >&2; exit 1; }
  base=$(gh api "repos/$REPO" --jq .default_branch 2>/dev/null || echo main)

  # REST. `gh pr create` is GraphQL; --field reads the body from a file so a shell never mangles it.
  if ! out=$(gh api -X POST "repos/$REPO/pulls" -f title="$title" -f head="$branch" -f base="$base" \
              --field body=@"$bodyfile" 2>&1); then
    echo "::error::could not open the pull request: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)" >&2
    case "$out" in
      *"No commits between"*) echo "  Nothing to merge — the branch has no commits the base lacks." >&2 ;;
      *"already exist"*)      echo "  A pull request for this branch is already open. Use 'pr.sh state <n>'." >&2 ;;
      *"not found"*)          echo "  Push the branch first: git push -u origin $branch" >&2 ;;
    esac
    exit 1
  fi
  num=$(printf '%s' "$out" | jq -r .number)
  echo "opened #$num  $branch -> $base"
  echo "  next: pr.sh arm $num       (auto-merge, read back)"
  echo "        pr.sh state $num     (every check AND every status)"
}

# --- state -------------------------------------------------------------------
# BOTH ENDPOINTS, ALWAYS, IN ONE PLACE. Reading one of them is how an unreviewed pull request looks
# reviewed, and how a blocking red stays invisible.
do_state() {
  local num=$1 brief=${2:-} sha runs st rc=0
  resolve_repo
  sha=$(gh api "repos/$REPO/pulls/$num" --jq .head.sha 2>/dev/null) || {
    echo "::error::could not read pull request #$num. This is a LOOKUP FAILURE and NOT a statement about its state." >&2; exit 1; }
  # A HEAD THAT IS NOT YOUR HEAD MUST SAY SO. For about a minute after a force-push this reported
  # the PREVIOUS commit and its verdicts, with nothing marking them as another commit's. An agent
  # that trusts the first reading acts on the result of work it has already replaced.
  local localsha warn=""
  localsha=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [ -n "$localsha" ] && [ "$localsha" != "$sha" ] \
     && git merge-base --is-ancestor "$sha" "$localsha" 2>/dev/null; then
    warn="  <- NOT your HEAD ($(printf '%s' "$localsha" | cut -c1-8)); these verdicts are an older commit's"
  fi
  [ -n "$brief" ] || echo "PR #$num  head $(printf '%s' "$sha" | cut -c1-8)$warn"
  [ -z "$brief" ] || [ -z "$warn" ] || printf 'STALE HEAD — the API still has %s, not your %s\n' "$(printf '%s' "$sha" | cut -c1-8)" "$(printf '%s' "$localsha" | cut -c1-8)"

  runs=$(gh api "repos/$REPO/commits/$sha/check-runs" 2>/dev/null) || {
    echo "::error::could not read check runs — not a green." >&2; exit 1; }
  if [ -z "$brief" ]; then
    echo
    echo "  CHECK RUNS — did the job run?"
    printf '%s' "$runs" | jq -r '.check_runs[]? | "    \(.conclusion // .status)  \(.name)"' | sort
    [ "$(printf '%s' "$runs" | jq '[.check_runs[]?] | length')" -gt 0 ] || echo "    (none yet — CI may not have started)"
  fi

  st=$(gh api "repos/$REPO/commits/$sha/status" 2>/dev/null) || {
    echo "::error::could not read commit statuses — not a green." >&2; exit 1; }
  if [ -z "$brief" ]; then
    echo
    echo "  COMMIT STATUSES — the verdicts. A gate that speaks here is the one branch protection reads."
    if [ "$(printf '%s' "$st" | jq '[.statuses[]?] | length')" -eq 0 ]; then
      echo "    (none)"
    else
      printf '%s' "$st" | jq -r '.statuses[]? | "    \(.state)  \(.context) — \(.description)"' | sort
    fi
  fi

  # THE ANSWER THE CALLER ACTUALLY WANTS, computed rather than left to be eyeballed across two lists.
  local badruns badst
  badruns=$(printf '%s' "$runs" | jq -r '[.check_runs[]? | select(.conclusion=="failure" or .conclusion=="timed_out" or .conclusion=="cancelled") | .name] | join(", ")')
  badst=$(printf '%s' "$st"   | jq -r '[.statuses[]? | select(.state=="failure" or .state=="error") | .context] | join(", ")')
  local pending
  pending=$(printf '%s' "$runs" | jq '[.check_runs[]? | select(.status!="completed")] | length')
  # NO CHECKS AT ALL IS NOT A GREEN. It printed "(none yet — CI may not have started)" and then
  # "all green." on the same run — two lines contradicting each other, and `all green` is the string
  # an agent greps for. The tool that enforces "could not determine is not determined to be nothing"
  # was breaking that rule itself.
  local total
  total=$(printf '%s' "$runs" | jq '[.check_runs[]?] | length')
  if [ "$total" -eq 0 ] && [ "$(printf '%s' "$st" | jq '[.statuses[]?] | length')" -eq 0 ]; then
    if [ -n "$brief" ]; then printf 'NO ANSWER YET — nothing has reported on this head\n'; else
      echo; echo "  NOTHING HAS REPORTED on this head yet. That is not a pass — it is no answer."; fi
    return 2
  fi
  if [ -n "$brief" ]; then
    if [ -n "$badruns" ] || [ -n "$badst" ]; then
      printf 'RED %s\n' "$(printf '%s %s' "$badruns" "$badst" | sed 's/^ *//; s/ *$//')"; return 1
    elif [ "$pending" -gt 0 ]; then printf 'RUNNING %s check(s)\n' "$pending"; return 2
    else printf 'GREEN\n'; return 0; fi
  fi
  echo
  if [ -n "$badruns" ] || [ -n "$badst" ]; then
    echo "  RED:"
    [ -z "$badruns" ] || echo "    check run:     $badruns"
    [ -z "$badst" ]   || echo "    commit status: $badst"
    rc=1
  elif [ "$pending" -gt 0 ]; then
    echo "  $pending check(s) still running — not an answer yet."
    rc=2
  else
    echo "  all green."
  fi
  return $rc
}

# --- rereview ----------------------------------------------------------------
# ASKING FOR A RE-REVIEW HAD NO VERB. The dev manual says "ask for a re-review" and named nothing to
# ask with, so an agent fell back to a bare comment and hoped a reviewer would notice the head sha
# had moved. A re-review request is a state change on the pull request, not a note.
do_rereview() {
  local num=$1 sha
  resolve_repo
  sha=$(gh api "repos/$REPO/pulls/$num" --jq .head.sha 2>/dev/null) || {
    echo "::error::could not read pull request #$num — this is a LOOKUP FAILURE, not a request sent." >&2; exit 1; }
  # A REQUEST NAMING THE WRONG SHA SENDS A REVIEWER TO THE WRONG COMMIT. Called straight after a
  # push, this raced it and asked for a re-review of the commit that had just been replaced —
  # `state` warns about a stale head and this did not.
  local localsha
  localsha=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [ -n "$localsha" ] && [ "$localsha" != "$sha" ] \
     && git merge-base --is-ancestor "$sha" "$localsha" 2>/dev/null; then
    echo "::error::the API still has $(printf '%s' "$sha" | cut -c1-8); your HEAD is $(printf '%s' "$localsha" | cut -c1-8)." >&2
    echo "  Nothing was sent. Push, wait a moment, and ask again — a request naming the wrong commit" >&2
    echo "  sends the reviewer to work you have already replaced." >&2
    exit 1
  fi
  local body="/tmp/.rereview-$num.md"
  {
    printf '**Re-review requested — the head has moved to `%s`.**\n\n' "$(printf '%s' "$sha" | cut -c1-8)"
    printf 'Any earlier verdict was posted against a different commit and no longer applies. The gate
'
    printf 'reads the sha, so it is already red until an independent agent posts a verdict for this one.

'
    printf 'What changed since the last review is in the comments above.
'
  } > "$body"
  gh api -X POST "repos/$REPO/issues/$num/comments" -F body=@"$body" >/dev/null || {
    echo "::error::the request was NOT posted. Do not report that a re-review was asked for." >&2; exit 1; }
  rm -f "$body"
  echo "re-review requested on #$num for $(printf '%s' "$sha" | cut -c1-8)"
  echo "  the status stays red until somebody who authored none of these commits posts a verdict."
}

# --- arm ---------------------------------------------------------------------
do_arm() {
  local num=$1 out armed
  resolve_repo
  # A REPOSITORY-WIDE SETTING IS NOT A PER-PULL-REQUEST FAILURE. Where auto-merge is disabled this
  # reported NOT ARMED on every pull request forever, which reads as something to fix and is not —
  # and the comment an agent then posted to explain it cancelled that PR'"'"'s own CI run. Asked once,
  # up front, so the answer is "not available here" rather than a recurring red herring.
  if [ "$(gh api "repos/$REPO" --jq .allow_auto_merge 2>/dev/null)" = "false" ]; then
    echo "NOT APPLICABLE: this repository has auto-merge disabled, so no pull request can be armed."
    echo "  A verifier merges by hand. This is a repository setting, not something about #$num."
    return 0
  fi
  # `gh pr merge --auto` is GraphQL and exits 0 while refusing, so the read-back below is the check,
  # not this call.
  out=$(gh pr merge "$num" --auto --squash 2>&1) || true
  armed=$(gh api "repos/$REPO/pulls/$num" --jq '.auto_merge != null' 2>/dev/null || echo "unknown")
  case "$armed" in
    true)  echo "ARMED — #$num merges itself when the gates go green." ;;
    false)
      echo "NOT ARMED. The call did not fail loudly; the read-back is how you know." >&2
      case "$out" in
        *"not allowed"*|*"enablePullRequestAutoMerge"*)
          echo "  This repository disallows auto-merge. That is a repository setting, not something to" >&2
          echo "  retry — say so on the pull request and hand off; a verifier will merge it." >&2 ;;
        *"Pull request is in clean status"*|*"already"*)
          echo "  It is already mergeable, and GitHub refuses to arm a pull request that could merge now." >&2 ;;
        *) [ -n "$out" ] && echo "  gh said: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)" >&2 ;;
      esac
      exit 1 ;;
    *) echo "::error::could not read back whether #$num is armed. This is a LOOKUP FAILURE — do not report it as armed." >&2; exit 1 ;;
  esac
}

self_test() {
  local rc=0 code
  code=$(grep -v '^[[:space:]]*#' "${BASH_SOURCE[0]}")

  # Unknown subcommands and flags must refuse rather than do something adjacent.
  ( REPO=x/y bash "${BASH_SOURCE[0]}" nonsense ) >/dev/null 2>&1 \
    && { echo "SELF-TEST FAIL: an unknown subcommand was accepted" >&2; rc=1; }
  ( bash "${BASH_SOURCE[0]}" --self-tests ) >/dev/null 2>&1 \
    && { echo "SELF-TEST FAIL: a mistyped flag was accepted" >&2; rc=1; }

  # `state` MUST READ BOTH ENDPOINTS. Reading one is the defect this subcommand exists for, and a
  # future edit that drops either would leave it reporting a green it cannot see past.
  printf '%s' "$code" | grep -q 'check-runs' \
    || { echo "SELF-TEST FAIL: state does not read check runs" >&2; rc=1; }
  printf '%s' "$code" | grep -q 'commits/\$sha/status' \
    || { echo "SELF-TEST FAIL: state does not read commit statuses — the verdict lives there" >&2; rc=1; }

  # `arm` MUST READ BACK. The call exits 0 while refusing.
  printf '%s' "$code" | grep -q 'auto_merge != null' \
    || { echo "SELF-TEST FAIL: arm does not read back whether it armed" >&2; rc=1; }

  # A LOOKUP FAILURE MUST NEVER READ AS A GREEN. Driven: point it at a repository that does not
  # exist and require a non-zero exit and an explanation.
  local out
  out=$( REPO=nonexistent-owner/nonexistent-repo bash "${BASH_SOURCE[0]}" state 1 2>&1 ) \
    && { echo "SELF-TEST FAIL: state on an unreadable repository exited 0" >&2; rc=1; }
  case "$out" in
    *"LOOKUP FAILURE"*|*"could not read"*) : ;;
    *) echo "SELF-TEST FAIL: an unreadable repository gave no explanation: $out" >&2; rc=1 ;;
  esac
  case "$out" in *"all green"*) echo "SELF-TEST FAIL: an unreadable repository reported green" >&2; rc=1 ;; esac

  # `open` MUST REFUSE AN ABSENT BODY FILE rather than open an empty pull request.
  out=$( REPO=x/y bash "${BASH_SOURCE[0]}" open some-branch "a title" /nonexistent/body.md 2>&1 ) \
    && { echo "SELF-TEST FAIL: open accepted a missing body file" >&2; rc=1; }
  case "$out" in *"does not exist"*) : ;; *) echo "SELF-TEST FAIL: a missing body file gave no explanation" >&2; rc=1 ;; esac

  [ "$rc" -eq 0 ] && echo "self-test passed: unknown input refuses, state reads both endpoints, arm reads back, and an unreadable repository never reports green"
  return $rc
}

case "${1:-}" in
  --self-test) self_test ;;
  open)  [ $# -eq 4 ] || { echo "usage: pr.sh open <branch> <title> <body-file>" >&2; exit 2; }; do_open "$2" "$3" "$4" ;;
  state) [ $# -ge 2 ] || { echo "usage: pr.sh state <number> [--brief]" >&2; exit 2; }; do_state "$2" "${3:-}" ;;
  arm)   [ $# -eq 2 ] || { echo "usage: pr.sh arm <number>" >&2; exit 2; };   do_arm "$2" ;;
  rereview) [ $# -eq 2 ] || { echo "usage: pr.sh rereview <number>" >&2; exit 2; }; do_rereview "$2" ;;
  "")    echo "usage: pr.sh open|state|arm ... | --self-test" >&2; exit 2 ;;
  *)     echo "::error::'$1' is not a subcommand. One of: open state arm rereview" >&2; exit 2 ;;
esac
