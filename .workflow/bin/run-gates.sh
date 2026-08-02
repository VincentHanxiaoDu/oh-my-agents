#!/usr/bin/env bash
# Run the gates the way CI runs them. One command, no arguments to remember.
#
# WHY THIS EXISTS. Several gates behave DIFFERENTLY without their base sha rather than refusing —
# or they did, until each was made to refuse. An agent ran `check-naming.sh <branch>` with no base,
# reported `rc=0` twice, and CI then went red. The exit code was real; the invocation was a
# strictly weaker check than the one being claimed.
#
# So the invocations live HERE, next to the gates, and this is what agents and CI both use. An
# invocation assembled from memory is a place for memory to be wrong, on every run, for every agent.
#
# Usage: run-gates.sh [base-ref]      default: origin/main
#        run-gates.sh --self-test
set -euo pipefail

case "${1:-}" in
  -*) [ "$1" = "--self-test" ] || {
        echo "::error::unknown option '$1'. This is a typo, not an argument — refusing." >&2; exit 2; } ;;
esac

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# A GATE THIS RUNNER CANNOT RUN MUST BE NAMED HERE, WITH ITS REASON. An omission and a deliberate
# exclusion look identical from a green run, so the exclusion is data rather than an absence — and
# the self-test below requires that anything excluded is also disclosed in the closing message.
# Found by this file's own self-test, which failed the first time it was run.
#   check-review.sh     needs the PR's comments; only CI has them
#   check-readme.sh     answers about THIS repository's README, which a project does not have a copy
#                       of — it is the framework's own check and runs in the framework's own CI
#   check-no-orphans.sh answers about the BOARD, not about this diff — a role runs it when it wants
#                       to know whether anything has fallen out of every queue, not before a push
CANNOT_RUN_LOCALLY="check-review.sh check-no-orphans.sh check-readme.sh"

self_test() {
  local rc=0 g b
  # EVERY GATE THAT TAKES A BASE MUST BE GIVEN ONE HERE, asserted by pattern so a gate added later
  # without its argument is caught rather than discovered on a red CI run. Only gates this runner
  # actually invokes are in scope: asserting an argument for a gate we never call is a check that
  # cannot fail for the right reason.
  for g in check-naming; do
    grep -qE "$g\.sh\"? .*\\\$base" "${BASH_SOURCE[0]}" \
      || { echo "SELF-TEST FAIL: $g.sh is invoked without the base sha — it will check less than its name suggests" >&2; rc=1; }
  done
  # AND EVERY GATE THAT EXISTS MUST BE RUN OR EXPLICITLY EXCLUDED. A local runner silently missing
  # a gate is worse than no runner: it reports a green that CI will redden, which is the same shape
  # as the defect it was written for.
  for g in "$here"/check-*.sh; do
    b=$(basename "$g")
    case " $CANNOT_RUN_LOCALLY " in
      *" $b "*)
        # Excluded — but the closing message must SAY it is excluded, or a reader takes the pass
        # as covering it.
        # THE EXCLUSION MUST BE DISCLOSED WITH ITS REASON, not merely listed. A reader who cannot
        # see why takes the pass as covering it.
        grep -q "^#   $b" "${BASH_SOURCE[0]}" \
          || { echo "SELF-TEST FAIL: $b is excluded and no reason is recorded" >&2; rc=1; }
        continue ;;
    esac
    grep -q "$b" "${BASH_SOURCE[0]}" \
      || { echo "SELF-TEST FAIL: $b exists and this runner neither runs it nor declares it unrunnable" >&2; rc=1; }
  done
  [ "$rc" -eq 0 ] && echo "self-test passed: every gate present is run here, and every gate that takes a base sha is given one"
  return $rc
}

[ "${1:-}" = "--self-test" ] && { self_test; exit $?; }

base_ref=${1:-origin/main}
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" = HEAD ]; then
  # A DETACHED HEAD IS HOW A REVIEWER CHECKS OUT A PULL REQUEST, and reviewers are intended users.
  # This refused on every such checkout: the only recovery was `gh pr view`, which is GraphQL and
  # dead the moment that quota runs out — so the fallback failed exactly when it was needed. A
  # reviewer reported having to invent `git checkout -B` to get past a check "protecting against
  # nothing a reviewer does wrong".
  #
  # Any ref pointing at this commit answers it, and REST answers it when git cannot.
  branch=$(git for-each-ref --format='%(refname:short)' --points-at HEAD refs/heads refs/remotes 2>/dev/null \
           | sed 's#^origin/##' | grep -vx HEAD | head -1)
  if [ -z "$branch" ]; then
    repo=$(git config --get remote.origin.url 2>/dev/null | sed -E 's#^(https://[^/]+/|git@[^:]+:)##; s#\.git$##')
    [ -n "$repo" ] && branch=$(gh api "repos/$repo/commits/$(git rev-parse HEAD)/pulls" \
      -H "Accept: application/vnd.github.groot-preview+json" --jq '.[0].head.ref' 2>/dev/null || true)
  fi
  [ -n "$branch" ] && [ "$branch" != null ] || {
    echo "::error::HEAD is detached and no branch or pull request in this repository points at $(git rev-parse --short HEAD)." >&2
    echo "  That is a checkout problem, not a finding about this code. Check out the branch, or pass" >&2
    echo "  the name: run-gates.sh <base-ref> does not carry it." >&2
    exit 1; }
  echo "note: detached HEAD; taking the branch as '$branch'"
fi

# THE GATES READ COMMITS, SO UNCOMMITTED WORK IS INVISIBLE TO THEM. Run before committing, this
# reported `branch and commits: ok` for a commit that did not exist yet, and CI then failed on the
# trailer the uncommitted message was missing — costing a force-push, which is the one thing the
# instructions warn destroys a review.
if ! git diff --quiet HEAD 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
  echo "::error::this working tree has changes that are not committed, and every gate here reads COMMITS." >&2
  echo "  A pass would be about the last commit, not about your work. Commit first, then run this." >&2
  git status --short | sed 's/^/    /' >&2
  exit 1
fi

base=$(git merge-base "$base_ref" HEAD) || {
  echo "::error::could not resolve a merge base against $base_ref. Fetch it first — this is a lookup failure and not a verdict about anything." >&2; exit 1; }

# IS THE INSTALLED FRAMEWORK THE CURRENT ONE? Asked here because this is the command every role
# runs before handing off, and because the alternative is remembering — which failed three times in
# one day, each time leaving a fixed defect live in the repository under test.
#
# Never fatal, and never silent about being unable to tell: an offline run says so rather than
# implying the answer is yes.
if [ -f .agent-dev-flow ]; then
  _have=$(sed -n 's/^sha=//p' .agent-dev-flow)
  _url=$(sed -n 's/^url=//p' .agent-dev-flow); _url=${_url:-VincentHanxiaoDu/agent-dev-flow}
  if [ -n "$_have" ] && [ "$_have" != unknown ]; then
    _latest=$(gh api "repos/$_url/commits/main" --jq .sha 2>/dev/null || echo "")
    if [ -z "$_latest" ]; then
      echo "note: could not reach the framework, so whether this install is current is UNKNOWN."
    elif [ "$_have" != "$_latest" ]; then
      echo "NOTE: this project has agent-dev-flow ${_have:0:8}; the framework is at ${_latest:0:8}."
      echo "      Re-run the installer — a fix that is upstream and not here is a fix nobody has."
    fi
  fi
fi

echo "gates for $branch against $base_ref ($(git rev-parse --short "$base"))"
echo

rc=0
run() { local label=$1; shift; local out status=0
  out=$("$@" 2>&1) || status=$?
  if [ "$status" -eq 0 ]; then printf '  ok    %s\n' "$label"
  else printf '  FAIL  %s\n' "$label"; printf '%s\n' "$out" | sed 's/^/          /'; rc=1; fi
}

# The self-tests first: a gate that cannot be shown to fail is not a gate.
run "gate self-tests" bash -c "for s in $here/check-*.sh; do bash \"\$s\" --self-test >/dev/null || exit 1; done"
# NOT APPLICABLE INSIDE A WORKTREE, and this is not a nicety. `.claude/commands/` is gitignored —
# local to a checkout, absent from every `git worktree add`. The dev prompt tells an agent to work
# in a worktree AND to run this runner, so both sub-agents on the first real fan-out hit a red
# `prompts` gate caused by nothing in their diff, and one tried copying the directory in and
# produced thirty false assertion failures. CI deliberately excludes this check for the same
# reason. A runner that is a strict superset of CI is wrong in the direction its own header
# forbids: it reports a red that CI will not.
# TESTED WHERE check-prompts.sh WILL LOOK — the CURRENT DIRECTORY, not next to this script. The
# first version asked `$here/../.claude/commands`, which resolves to the main checkout even when the
# runner is invoked from a worktree, so the condition was true and the gate still failed. Found by
# running it in a worktree rather than by reading it.
if [ -d ".claude/commands" ]; then
  run "prompts"         "$here/check-prompts.sh"
else
  printf '  --    prompts (no .claude/commands here — local-only and gitignored, so not checked)\n'
fi
run "contexts"        "$here/check-contexts.sh"
run "queue"           "$here/queue.sh"        --self-test
run "queue watch"     "$here/watch-queue.sh"  --self-test
run "PR watch"        "$here/watch-prs.sh"    --self-test
run "tasks complete"  "$here/check-tasks-complete.sh" "$base"
run "generated files" "$here/check-generated.sh" "$base"
run "branch and commits" "$here/check-naming.sh" "$branch" "$base"

# THE PROJECT'S OWN BUILD, BECAUSE CI RUNS IT AND THIS FILE CLAIMS TO BE WHAT CI RUNS. It did not,
# and said "this is what CI runs" anyway — a false claim in the output of the tool whose entire
# purpose is that an invocation assembled from memory is a place for memory to be wrong.
if [ -f Makefile ] && grep -qE '^ci:' Makefile; then
  run "build and tests" make ci
  # PARITY IS GUARANTEED FOR THE FRAMEWORK'S GATES AND NOT FOR YOURS. This runs YOUR `make ci`, and
  # whether it answers the same here as on the runner is a property of your toolchain, not of this
  # script. Measured: a linter whose diagnostics depend on how files are passed and on its version
  # gave a green here and a red in CI on the same tree — the exact failure this file exists to
  # prevent, arriving through the one gate it does not own.
  printf '        (your `make ci` — parity with CI depends on your toolchain, not on this runner:\n'
  printf '         pin your linter'"'"'s version and severity or the two can disagree on one tree)\n'
else
  printf '  --    build and tests (no ci: target in a Makefile — CI errors on this if you have tests)\n'
fi

echo
if [ "$rc" -eq 0 ]; then
  echo "all gates pass — the framework's gates, with the arguments CI uses. Your own build is above,"
  echo "and it agrees with CI only as far as your toolchain is deterministic."
  echo "It does NOT run the review gate — that needs a second agent, and a pass here says nothing"
  echo "about it. A dev agent's pull request ENDS red on that status; that is the handoff, not a"
  echo "failure of yours."
else
  echo "at least one gate failed. Each line above is the gate's own output."
fi
exit $rc
