#!/usr/bin/env bash
# The prompts are the process. This checks that they still say what the PRD requires.
#
# WHY THIS EXISTS. In the previous build the routing rule lived in a prose document, the script
# that enforced part of it was deleted, and nothing noticed for hours — the document went on
# asserting an enforced rule that nothing enforced. And three of four role prompts had no
# parallelism instruction at all, so those roles worked one Issue at a time forever while the
# document said the process fanned out.
#
# So the properties the PRD names are asserted against the prompt files themselves, mechanically.
#
# Usage: check-prompts.sh [agents-dir]      default: .claude/commands
#        check-prompts.sh --self-test
set -euo pipefail

case "${1:-}" in
  -*) [ "$1" = "--self-test" ] || {
        echo "::error::unknown option '$1'. This is a typo, not an argument — refusing." >&2; exit 2; } ;;
esac

run_check() {
  local dir=${1:-.claude/commands} rc=0 f role

  # A MISSING DIRECTORY MUST NOT READ AS "EVERY PROMPT IS FINE". This is the defect this whole
  # project is about, and the check that reports on it is the last place it should appear.
  [ -d "$dir" ] || {
    echo "::error::$dir does not exist, so no prompt was examined. This is a LOOKUP FAILURE and NOT a statement that the prompts are correct." >&2
    return 1
  }

  # Every role the queue can dispatch must have a prompt. A role with a queue arm and no prompt is
  # a role that receives work and does not know what to do with it.
  for role in dev-workflow qa-workflow product-workflow create-feature release-version init-workflow review-pr; do
    [ -f "$dir/$role.md" ] || { echo "::error::no prompt for role '$role'" >&2; rc=1; }
  done

  # R1 — EVERY WORKING ROLE PULLS ITS WHOLE QUEUE AND FANS OUT. pm is excluded deliberately: it
  # dispatches one message per role and must NOT fan out over Issues itself.
  for role in dev-workflow qa-workflow product-workflow; do
    f="$dir/$role.md"; [ -f "$f" ] || continue
    grep -q 'queue\.sh' "$f" \
      || { echo "::error::$role.md never tells the role to pull its queue — it can only ever work what it is handed" >&2; rc=1; }
    grep -qi 'in parallel\|all at once' "$f" \
      || { echo "::error::$role.md has no instruction to work the queue in parallel — this is the defect that made three of four roles serial" >&2; rc=1; }
    grep -qi 'no cap on width' "$f" \
      || { echo "::error::$role.md does not say the width is uncapped, so the role will pick a safe small number" >&2; rc=1; }
    # The lookup-failure distinction, in the prompt rather than only in the script.
    grep -qi 'failed lookup and an empty queue are different\|not learned that you have no work' "$f" \
      || { echo "::error::$role.md does not tell the role that a failed lookup is not an empty queue" >&2; rc=1; }
    # SELF-DRIVING. A role that reads its queue once works one round and stops, and somebody then
    # has to notice new work and restart it — which is a coordinator, which is the bottleneck this
    # process exists to remove. The queue is a state the role watches.
    grep -q 'watch-queue\.sh' "$f" \
      || { echo "::error::$role.md starts no monitor, so the role works one round and waits to be told about the next" >&2; rc=1; }
    # AND IT MUST WATCH ITS OWN PULL REQUESTS. Watching only the Issue queue leaves an agent
    # waiting for new work with its own branch red and nothing saying so.
    grep -q 'watch-prs\.sh' "$f" \
      || { echo "::error::$role.md never watches its own PRs — a red gate or a requested change would never reach it" >&2; rc=1; }
    # AND IT MUST NOT DEPEND ON THAT WATCH SURVIVING. A monitor is a process and processes end, and
    # a dead one is indistinguishable from a quiet queue — measured: a watcher died three times in
    # one session, the role went on believing its board was clear, and fourteen pull requests
    # accumulated behind it with eight of them waiting on a review nobody had been told to do.
    #
    # A prompt that only says "start a monitor" has built the process on a single point of failure
    # that nothing watches. So the fallback must be IN THE PROMPT: a role has to know the watch can
    # die, know what aliveness looks like, and have a way to answer the question without it.
    grep -q -- '--sweep' "$f" \
      || { echo "::error::$role.md never tells the role to sweep the board, so a dead monitor strands its work silently and nothing recovers it" >&2; rc=1; }
    grep -q 'WATCHING' "$f" \
      || { echo "::error::$role.md never mentions the WATCHING heartbeat — the role cannot tell a live watch from a dead one, and silence would mean both" >&2; rc=1; }
  done

  # R4 — CLOSURE AUTHORITY LIVES IN THE PROMPT OF THE ROLE THAT CLOSES, and nowhere else.
  grep -qi 'you close bugs and chores' "$dir/qa-workflow.md" 2>/dev/null \
    || { echo "::error::qa.md does not state that qa closes bugs and chores" >&2; rc=1; }
  grep -qi 'you close features' "$dir/product-workflow.md" 2>/dev/null \
    || { echo "::error::product.md does not state that product closes features" >&2; rc=1; }
  for role in dev-workflow; do
    grep -qi 'close nothing\|You close nothing' "$dir/$role.md" 2>/dev/null \
      || { echo "::error::$role.md does not state that $role closes nothing" >&2; rc=1; }
  done

  # A GATE MUST HAVE A PROMPT THAT PRODUCES WHAT IT CHECKS. Two CI gates read `openspec/`, and for
  # a while no role prompt mentioned openspec at all — so nothing would ever create a change, the
  # gates would pass vacuously forever, and a gate that can never fire is not a gate. This is the
  # inverse of a rule nothing enforces: enforcement of a workflow nobody was told to follow.
  grep -qi 'openspec' "$dir/dev-workflow.md" 2>/dev/null \
    || { echo "::error::dev-workflow.md never mentions openspec, but a CI gate reads openspec/changes — nothing would create what it checks" >&2; rc=1; }
  grep -qi 'openspec archive' "$dir/product-workflow.md" 2>/dev/null \
    || { echo "::error::product-workflow.md does not say to archive, but a CI gate fails a spec edit that arrives without one" >&2; rc=1; }

  # EVERY ROLE MUST KNOW THE BAR IT HANDS OFF AT. A role that learns a gate's requirement from a red
  # check has already asked the next role to verify work it had itself called unfinished. The
  # standard belongs in the prompt, before the handoff, not in the failure afterwards.
  for role in dev-workflow qa-workflow product-workflow; do
    grep -qi 'tasks complete\|every task ticked\|task in .tasks.md. ticked' "$dir/$role.md" 2>/dev/null \
      || { echo "::error::$role.md never states the Tasks complete standard — the role would meet it by going red" >&2; rc=1; }
  done

  # WRITING REQUIREMENTS: a criterion that can be softened to make it reachable is not a criterion,
  # and the previous build produced one Issue carrying 247 of them in a single milestone.
  grep -qi 'testable or it is not a criterion' "$dir/create-feature.md" 2>/dev/null \
    || { echo "::error::create-feature.md does not require criteria to be testable" >&2; rc=1; }
  grep -qi 'never soften' "$dir/create-feature.md" 2>/dev/null \
    || { echo "::error::create-feature.md does not forbid softening a criterion to make it reachable" >&2; rc=1; }
  # AN OPEN QUESTION IS NOT A REQUIREMENT. Measured by driving this command against a real
  # specification: the instructions said nothing about decisions the spec had not made, and the
  # agent reported it as the most likely place two runs diverge — one would file the question as an
  # Issue, another would quietly pick an answer and write it as a criterion, where it stops looking
  # like a guess.
  grep -qi 'never answer one\|do not invent an answer' "$dir/create-feature.md" 2>/dev/null \
    || { echo "::error::create-feature.md does not forbid answering the specification's open questions" >&2; rc=1; }

  # AN OPEN DECISION GOES TO THE OWNER BEFORE AN ISSUE IS FILED. Five proving-ground rounds shipped
  # features that refused on their own main path, because nothing asked — the owner was one question
  # away each time and the prompt said only "do not answer it yourself".
  for role in create-feature product-workflow; do
    grep -q 'AskUserQuestion' "$dir/$role.md" 2>/dev/null \
      || { echo "::error::$role.md does not put an open decision to the owner — filing around one ships a capability that refuses" >&2; rc=1; }
  done
  grep -qi 'before you file anything\|ASK, before' "$dir/create-feature.md" 2>/dev/null \
    || { echo "::error::create-feature.md does not say to ask BEFORE filing" >&2; rc=1; }

  # RELEASING: product decides, ops executes; and an unnamed defect is not shippable.
  grep -qi 'product decides' "$dir/release-version.md" 2>/dev/null \
    || { echo "::error::release-version.md does not state that product decides and ops only executes" >&2; rc=1; }
  grep -qi 'named defect is shippable' "$dir/release-version.md" 2>/dev/null \
    || { echo "::error::release-version.md does not require known limitations to be named" >&2; rc=1; }

  # THE ROLE MARKER IS THE STATE. queue.sh reads `[qa]` / `[product]` at the start of a comment to
  # know a role has already looked — it is the one record that exists. A product agent UAT'd two
  # Issues, deliberately left them open, and the queue went on offering them because its verdict
  # comment began `## UAT` instead.
  for role in qa product; do
    grep -q "starts with \`\[$role\]\`" "$dir/$role-workflow.md" 2>/dev/null \
      || { echo "::error::$role-workflow.md does not require the [$role] marker on a verdict comment — the queue cannot tell you have looked" >&2; rc=1; }
  done

  # NO PROMPT MAY TEACH A CLOSING KEYWORD. The naming gate refuses one on every commit, because a
  # merge that closes an Issue skips the step that carries its open decisions forward — and a prompt
  # still telling a reviewer to look for `Closes #N` survived that fix by one round.
  # A LINE THAT FORBIDS THE KEYWORD MUST CONTAIN IT. The first version flagged dev-workflow's own
  # "`Refs #N`, never `Closes #N`" — a check that cannot tell teaching from forbidding will delete
  # the warning and keep the defect.
  for f in "$dir"/*.md; do
    grep -iE '(clos(e|es|ed)|fix(e[sd])?|resolv(e|es|ed)) #' "$f" \
      | grep -qivE 'never|not|refus|instead of|rather than' \
      && { echo "::error::$(basename "$f") tells a reader to use a closing keyword; the naming gate refuses one. Write Refs #N." >&2; rc=1; }
  done

  # SOMEBODY MUST DRIVE THE COMBINATION. Every gate certifies one head against main and every
  # reviewer reads one branch, so two pull requests that interact are verified by nobody. Product is
  # the only role that sees the merged tree, and three reviewers in a row reported the gap unprompted.
  grep -qi 'only role that sees the combination\|UAT the merged tree' "$dir/product-workflow.md" 2>/dev/null \
    || { echo "::error::product-workflow.md does not say to drive the merged tree — no role verifies two PRs that interact" >&2; rc=1; }

  # A REVIEW MUST START FROM THE MERGE BASE. A branch cut before something else landed shows that
  # thing as deleted, and a reviewer who diffs against the tip files a false finding about work
  # nobody did — reported after it nearly happened.
  grep -q 'merge-base' "$dir/review-pr.md" 2>/dev/null \
    || { echo "::error::review-pr.md does not say to diff from the merge base — a stale branch reads as deleting other people's work" >&2; rc=1; }
  # AND IT MUST CHECK THAT A BLOCKED DECISION WAS NOT SETTLED IN A TEST. A pull request that says it
  # settled nothing, whose test pins the undecided behaviour, has settled it — caught exactly once,
  # by a reviewer that implemented the other permitted answer and watched the suite go red.
  grep -qi 'in a test as well as in the code\|settled.*in a test' "$dir/review-pr.md" 2>/dev/null \
    || { echo "::error::review-pr.md does not say a test can settle an open decision the body claims is open" >&2; rc=1; }

  # A COMMAND MUST NOT NAME A SCRIPT THAT DOES NOT EXIST. A prompt referenced `./.workflow/bin/my-queue.sh`
  # four times — a name from a previous build — and every instruction using it was uncopyable. The
  # scripts are right here; checking is one loop.
  local ref
  for f in "$dir"/*.md; do
    while IFS= read -r ref; do
      [ -n "$ref" ] || continue
      [ -f "$dir/../../.workflow/bin/$ref" ] || [ -f "$(dirname "${BASH_SOURCE[0]}")/$ref" ] \
        || { echo "::error::$(basename "$f") calls ./.workflow/bin/$ref, which does not exist" >&2; rc=1; }
    done < <(grep -oE '\./.workflow/bin/[a-z-]+\.sh' "$f" | sed 's#\./.workflow/bin/##' | sort -u)
  done

  # EVERY COMMAND CARRIES ITS PROJECT INJECTION POINT. Without it a project cannot add its own
  # process or knowledge without editing a framework file, and an edit to a framework file is
  # reverted by the next install — silently, which is how a team learns to stop upgrading.
  for role in dev-workflow qa-workflow product-workflow create-feature release-version review-pr; do
    f="$dir/$role.md"; [ -f "$f" ] || continue
    grep -q '@\.workflow/' "$f" \
      || { echo "::error::$role.md has no @.workflow/<role>/AGENT.md injection point — a project could only extend it by editing a file the installer overwrites" >&2; rc=1; }
  done

  [ "$rc" -eq 0 ] && echo "prompts ok: every role pulls its own queue and fans out uncapped, closure authority is stated where it is exercised, criteria cannot be softened, every working role watches its queue and its own PRs and can sweep the board when that watch dies, and every command has its project injection point"
  return "$rc"
}

self_test() {
  local tmp rc=0 out
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN

  # 1. A MISSING DIRECTORY MUST FAIL, and say why. The vacuous pass is the whole point.
  out=$(run_check "$tmp/nope" 2>&1) && { echo "SELF-TEST FAIL: a missing directory PASSED" >&2; rc=1; }
  case "$out" in *"LOOKUP FAILURE"*) : ;; *) echo "SELF-TEST FAIL: a missing directory gave no explanation" >&2; rc=1 ;; esac

  # 2. A directory of EMPTY prompts must fail — files existing is not the property being checked.
  mkdir -p "$tmp/empty"; for r in dev-workflow qa-workflow product-workflow create-feature release-version; do : > "$tmp/empty/$r.md"; done
  run_check "$tmp/empty" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: empty prompts PASSED" >&2; rc=1; }

  # 3. THE REAL PROMPTS MUST PASS. If they do not, this check is wrong or the prompts regressed,
  #    and either way it must be visible here rather than discovered in a dispatch.
  local here; here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  if [ -d "$here/.claude/commands" ]; then
    run_check "$here/.claude/commands" >/dev/null 2>&1 \
      || { echo "SELF-TEST FAIL: the shipped prompts do not satisfy the check" >&2; rc=1; }

    # 4. AND THE CHECK MUST BE ABLE TO CATCH THE REGRESSION IT EXISTS FOR — the one that made three
    #    of four roles serial. Strip the parallelism line from a real prompt and require a red.
    cp -R "$here/.claude/commands" "$tmp/mutant"
    grep -qi 'in parallel' "$tmp/mutant/qa-workflow.md" || { echo "SELF-TEST FAIL: mutation target absent — refusing to report a mutation that did not happen" >&2; rc=1; }
    grep -vi 'in parallel\|all at once' "$tmp/mutant/qa-workflow.md" > "$tmp/m" && mv "$tmp/m" "$tmp/mutant/qa-workflow.md"
    run_check "$tmp/mutant" >/dev/null 2>&1 \
      && { echo "SELF-TEST FAIL: a prompt with its parallelism removed PASSED — this check would not have caught the defect it was written for" >&2; rc=1; }
  fi

  [ "$rc" -eq 0 ] && echo "self-test passed: a missing directory refuses, empty prompts fail, the shipped prompts pass, and removing a role's parallelism reddens it"
  return "$rc"
}

case "${1:-}" in
  --self-test) self_test ;;
  *) run_check "${1:-.claude/commands}" ;;
esac
