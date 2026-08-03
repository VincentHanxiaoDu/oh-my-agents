#!/usr/bin/env bash
# Emit a line every time one of this role's pull requests changes state. Feed it to a monitor and a
# red gate or a requested change comes back to the agent that can fix it.
#
# WHY THIS EXISTS. watch-queue.sh watches for NEW work. It does not watch the work already opened —
# so an agent could open a pull request, have CI go red, have a reviewer ask for changes, and never
# hear about either. It would sit waiting for new Issues with its own branch broken.
#
# WHAT IT EMITS:
#
#   FAILING   #12  <title>  —  <which check>     a gate went red
#   CHANGES   #12  <title>                       a reviewer asked for changes
#   READY     #12  <title>                       green and mergeable
#   MERGED    #12  <title>                       it landed
#   ISSUE-MOVED #12 <title>                     the Issue changed after this head was written
#   NEEDS-REVIEW #12 <title>                    somebody else built it and it is waiting on a verdict
#   LOOKUP FAILED: <reason>                      the poll could not be answered
#
# **Every terminal state emits, not only the good one.** A watch that reported only READY would be
# silent through a red gate, and silence is indistinguishable from "still running" — which is how an
# agent waits forever on something that already failed.
#
#   WATCHING  <role>  <n> open  —  poll #k        the watch is ALIVE and was answered
#
# **A DEAD WATCH AND A QUIET QUEUE LOOK IDENTICAL, AND THAT IS THE WORST STATE THIS FILE CAN BE IN.**
# Every other emission here says something happened. `WATCHING` is the one that says *nothing*
# happened and the loop is still standing — because without it, silence has two meanings and the
# role that reads it cannot tell "no work" from "your watch died an hour ago". It is deliberately
# infrequent (every tenth poll, so ~10 minutes at the default interval): often enough that its
# absence is diagnosable, rare enough that it does not bury the events it accompanies.
#
# Usage: watch-prs.sh <role> [interval-seconds]      default interval: 60
#        watch-prs.sh <role> --sweep                 ONE pass over the board, then exit
#        watch-prs.sh --self-test
set -euo pipefail

# A DEATH MUST BE LOUD. This is the second half of the heartbeat and it is the more important half:
# the heartbeat says the watch is alive, and this says the watch has stopped, at the moment it stops
# and with the number that explains it. Before it, the process vanished and the role went on waiting
# — three outages for the `qa` role in one session, found only by sweeping every open pull request
# by hand hours later, by which time two heads had moved under reviews already posted.
#
# EXIT 0 IS SILENT ON PURPOSE. `--sweep` and `--main-state` finish normally and have nothing to
# report; announcing those would train the reader to skim the line that matters.
trap 'wrc=$?; [ "$wrc" -eq 0 ] || echo "WATCH DIED (exit $wrc) — this role is now BLIND and a dead watch looks exactly like a quiet queue. Restart it, then run: .workflow/bin/watch-prs.sh ${1:-<role>} --sweep" >&2' EXIT

# SIGURG IS IGNORED, AND WHAT THAT IS AND IS NOT EVIDENCE FOR IS RECORDED HERE HONESTLY.
# The observed deaths carried **exit 144**, which is `128 + 16` — killed by signal 16, `SIGURG` on
# this platform. Nothing in this file exits 144 on its own. SIGURG is effectively nobody's signal
# any more: the Go runtime took it over for goroutine preemption and sends it constantly, and `gh`
# is a Go binary.
#
# **This line is cheap insurance and NOT the fix, and it must not be mistaken for the fix.** SIGURG's
# POSIX default action is already *ignore*, so a plain `kill -URG` cannot kill a bash process, and a
# self-test arm asserting that it survives one passes just as happily with this line deleted — a
# vacuous test, which is worse than none. The reachable killer was an unguarded command substitution
# on a branch this clone had never fetched; see the note at the `authors=` line, which is where the
# driven regression test points.
#
# INT AND TERM ARE DELIBERATELY NOT TRAPPED. A watch that cannot be stopped is worse than one that
# dies: whoever starts it must be able to end it.
trap '' URG

case "${1:-}" in
  -*) [ "$1" = "--self-test" ] || [ "$1" = "--main-state" ] || {
        echo "::error::unknown option '$1'. This is a typo, not an argument — refusing." >&2; exit 2; } ;;
esac

resolve_repo() {
  [ -n "${REPO:-}" ] && return 0
  local url; url=$(git config --get remote.origin.url 2>/dev/null || echo "")
  [ -n "$url" ] && REPO=$(printf '%s' "$url" | sed -E 's#^(https://[^/]+/|git@[^:]+:)##; s#\.git$##')
  [ -n "${REPO:-}" ] || { echo "::error::no repository: no 'origin' remote here. Set REPO." >&2; exit 2; }
}

self_test() {
  local rc=0 tmp out

  # An unknown role must refuse rather than watch nothing forever.
  ( REPO=x/y bash "${BASH_SOURCE[0]}" not-a-role 1 ) >/dev/null 2>&1 \
    && { echo "SELF-TEST FAIL: an unknown role was accepted" >&2; rc=1; }

  # EVERY OUTCOME MUST HAVE AN EMISSION. A watch that only announces success is silent through the
  # failure it exists to catch.
  #
  # MATCHED ON THE CALL, `emit FAILING`, not on a quoted literal. The first version looked for
  # `"FAILING` — a quote followed by the state — which appears nowhere: the calls are written
  # `emit FAILING "$num"`. Every grep failed, and under `set -e` the failing command substitution
  # killed the whole self-test before it printed anything. **A check that greps the wrong shape
  # does not report "not found"; it reports nothing at all**, which is this project's subject
  # occurring inside the file written to police it.
  # COMMENTS ARE STRIPPED FIRST. Grepping the whole file matched the paragraph above, which
  # contains the very string it searches for — so deleting the real `emit FAILING` call left the
  # check green. **Second time in one hour, and the second one was committed inside the fix for
  # the first.** A check whose corpus includes its own documentation is asserting that the
  # documentation exists.
  local s code
  code=$(grep -v '^[[:space:]]*#' "${BASH_SOURCE[0]}")
  for s in FAILING CHANGES READY MERGED NEEDS-REVIEW ISSUE-MOVED; do
    printf '%s' "$code" | grep -q "emit $s " \
      || { echo "SELF-TEST FAIL: state '$s' is never emitted — an agent would not learn about it" >&2; rc=1; }
  done

  # THE FAILURE PATH MUST EMIT AND MUST NOT END THE WATCH, driven against a stub that always fails.
  tmp=$(mktemp -d)
  printf '#!/usr/bin/env bash\necho boom >&2\nexit 1\n' > "$tmp/gh"; chmod +x "$tmp/gh"
  cp "${BASH_SOURCE[0]}" "$tmp/watch-prs.sh"
  ( PATH="$tmp:$PATH" REPO=x/y bash "$tmp/watch-prs.sh" dev 1 >"$tmp/out" 2>&1 & echo $! > "$tmp/pid" )
  sleep 3
  kill "$(cat "$tmp/pid")" 2>/dev/null || true
  out=$(cat "$tmp/out" 2>/dev/null || echo "")
  local n; n=$(printf '%s\n' "$out" | grep -c '^LOOKUP FAILED' || true)
  rm -rf "$tmp"
  [ "$n" -ge 1 ] || { echo "SELF-TEST FAIL: a failing poll emitted nothing — an outage looks like 'no PRs'" >&2; rc=1; }
  [ "$n" -ge 2 ] || { echo "SELF-TEST FAIL: a failing poll emitted once and stopped — a transient outage must wake the role, not end the watch (got $n)" >&2; rc=1; }

  # MAIN'S THREE ANSWERS, DRIVEN. A red main reported as green is the whole reason this exists, and
  # so is an unreadable one reported as green. Driven through the real entry point against a stub
  # `gh`, so the parsing under test is the parsing that runs.
  local body want got
  tmp=$(mktemp -d)
  cp "${BASH_SOURCE[0]}" "$tmp/watch-prs.sh"
  while IFS='|' read -r body want; do
    [ -n "$body" ] || continue
    printf '#!/usr/bin/env bash\ncat <<'\''J'\''\n%s\nJ\n' "$body" > "$tmp/gh"; chmod +x "$tmp/gh"
    got=$(PATH="$tmp:$PATH" REPO=x/y bash "$tmp/watch-prs.sh" --main-state 2>/dev/null || echo "")
    case "$got" in
      *"$want"*) : ;;
      *) echo "SELF-TEST FAIL: main_state said '$got' — expected it to contain '$want'" >&2; rc=1 ;;
    esac
  done <<'CASES'
{"workflow_runs":[{"status":"completed","conclusion":"success","head_sha":"abcdef1234"}]}|main is GREEN
{"workflow_runs":[{"status":"completed","conclusion":"failure","head_sha":"abcdef1234"}]}|MAIN IS RED
{"workflow_runs":[{"status":"in_progress","conclusion":null,"head_sha":"abcdef1234"}]}|still running
{"workflow_runs":[]}|MAIN STATE UNKNOWN
CASES
  # AND WHEN THE LOOKUP ITSELF FAILS. An outage must not be spelled the same way as a green main.
  printf '#!/usr/bin/env bash\necho boom >&2\nexit 1\n' > "$tmp/gh"; chmod +x "$tmp/gh"
  got=$(PATH="$tmp:$PATH" REPO=x/y bash "$tmp/watch-prs.sh" --main-state 2>/dev/null || echo "")
  case "$got" in
    *"MAIN STATE UNKNOWN"*) : ;;
    *) echo "SELF-TEST FAIL: a failed lookup of main said '$got' — an outage must not read as a colour" >&2; rc=1 ;;
  esac
  rm -rf "$tmp"

  # A PULL REQUEST ON A BRANCH THIS CLONE HAS NEVER FETCHED MUST NOT END THE WATCH.
  #
  # THIS IS THE REGRESSION TEST FOR THE OUTAGE, and it is driven by making `git` fail the way an
  # unfetched branch makes it fail — not by grepping for the `gh api` call that replaced it. The
  # previous code asked git about `origin/<branch>` for every foreign pull request; a branch opened
  # after the last fetch is not there, git exits non-zero, and `set -euo pipefail` turned that into
  # the death of the whole watch with its stderr already routed to /dev/null.
  #
  # THE STUB `git` FAILS ON EVERYTHING, which is stronger than the real fault needs: if any part of
  # a poll still depends on this clone answering, this arm fails and says so.
  tmp=$(mktemp -d)
  cat > "$tmp/gh" <<'STUB'
#!/usr/bin/env bash
# One open pull request, on a branch belonging to another role, with an Agent: trailer.
case "$*" in
  *"pulls/7/commits"*) printf 'c1\tAgent: product\n' ;;
  *"/commits/c1"*)     echo 'internal/a.go' ;;
  *"state=closed"*)    echo '[]' ;;
  *"pulls?state=open"*) echo '[{"number":7,"title":"t","head":{"ref":"product/feat/7-x","sha":"deadbee"}}]' ;;
  *"/status"*)         echo '{"statuses":[]}' ;;
  *)                   echo '[]' ;;
esac
STUB
  chmod +x "$tmp/gh"
  printf '#!/usr/bin/env bash\nexit 128\n' > "$tmp/git"; chmod +x "$tmp/git"
  cp "${BASH_SOURCE[0]}" "$tmp/watch-prs.sh"
  # THE SIBLING GOES WITH IT. Independence is derived by pr-authors.sh next door, so a fixture that
  # copies only this file tests a script with half its dependencies missing.
  cp "$(dirname "${BASH_SOURCE[0]}")/pr-authors.sh" "$tmp/pr-authors.sh"
  ( PATH="$tmp:$PATH" REPO=x/y bash "$tmp/watch-prs.sh" dev 2 >"$tmp/out" 2>&1 & echo $! > "$tmp/pid" )
  sleep 4
  local wpid; wpid=$(cat "$tmp/pid")
  kill -0 "$wpid" 2>/dev/null \
    || { echo "SELF-TEST FAIL: a pull request on an unfetched branch ended the watch — this is the outage, and the role goes blind" >&2; rc=1; }
  out=$(cat "$tmp/out" 2>/dev/null || echo "")
  case "$out" in
    *NEEDS-REVIEW*) : ;;
    *) echo "SELF-TEST FAIL: a foreign pull request awaiting a verdict emitted no NEEDS-REVIEW (got: $out)" >&2; rc=1 ;;
  esac
  # AND THE HEARTBEAT MUST HAVE ARRIVED. Its entire purpose is that its ABSENCE is readable, which
  # is only true if its presence is guaranteed while the watch lives.
  case "$out" in
    *WATCHING*) : ;;
    *) echo "SELF-TEST FAIL: a live watch emitted no WATCHING line — silence would again mean both 'no work' and 'dead'" >&2; rc=1 ;;
  esac
  kill "$wpid" 2>/dev/null || true
  rm -rf "$tmp"

  # A DEATH MUST ANNOUNCE ITSELF. Driven by making the very first lookup fail in a mode the loop
  # does not catch, so the process really does exit non-zero.
  #
  # DRIVEN IN A DIRECTORY WITH NO REMOTE, so the exit is `resolve_repo`'s refusal and the loop is
  # never entered. An earlier version of this arm cleared `REPO` but left the real `git` on PATH in
  # the real repository — so the remote resolved, the watch started for real, and the self-test hung
  # until it was killed by hand. A test that hangs reports nothing, which is this file's subject.
  tmp=$(mktemp -d)
  cp "${BASH_SOURCE[0]}" "$tmp/watch-prs.sh"
  printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/git"; chmod +x "$tmp/git"
  out=$( cd "$tmp" && PATH="$tmp:$PATH" REPO="" bash "$tmp/watch-prs.sh" dev 2>&1 || true )
  case "$out" in
    *"WATCH DIED"*) : ;;
    *) echo "SELF-TEST FAIL: the watch exited non-zero without saying so — a silent death is the state this file exists to remove (got: $out)" >&2; rc=1 ;;
  esac
  rm -rf "$tmp"

  # A SWEEP MUST TERMINATE. It is the fallback for a dead watch, so a sweep that hangs like the
  # watch it replaces leaves the role with no way to find its work at all.
  tmp=$(mktemp -d)
  printf '#!/usr/bin/env bash\necho "[]"\n' > "$tmp/gh"; chmod +x "$tmp/gh"
  cp "${BASH_SOURCE[0]}" "$tmp/watch-prs.sh"
  ( PATH="$tmp:$PATH" REPO=x/y bash "$tmp/watch-prs.sh" dev --sweep >"$tmp/sout" 2>&1 & echo $! > "$tmp/spid" )
  sleep 3
  if kill -0 "$(cat "$tmp/spid")" 2>/dev/null; then
    kill "$(cat "$tmp/spid")" 2>/dev/null || true
    echo "SELF-TEST FAIL: --sweep did not exit — it is a watch, not a sweep" >&2; rc=1
  fi
  # A SWEEP THAT COULD NOT READ THE BOARD MUST NOT EXIT 0. Exit 0 with no events means "nothing is
  # waiting on you", and an outage is not that.
  printf '#!/usr/bin/env bash\necho boom >&2\nexit 1\n' > "$tmp/gh"
  ( PATH="$tmp:$PATH" REPO=x/y bash "$tmp/watch-prs.sh" dev --sweep >/dev/null 2>&1 ) \
    && { echo "SELF-TEST FAIL: a sweep whose lookup failed exited 0 — an outage would read as an empty board" >&2; rc=1; }
  rm -rf "$tmp"

  [ "$rc" -eq 0 ] && echo "self-test passed: every outcome emits including the failing ones, main's colour has three answers plus an outage, unknown roles refuse, a failed poll does not end the watch, an unfetched branch does not end it either, the heartbeat arrives, a death announces itself, and --sweep terminates and refuses to call an outage an empty board"
  return $rc
}

[ "${1:-}" = "--self-test" ] && { self_test; exit $?; }

role=${1:?usage: watch-prs.sh <role> [interval-seconds] | <role> --sweep | --self-test}
case "$role" in dev|qa|product|ops|pm|--main-state) : ;; *) echo "::error::'$role' is not a role." >&2; exit 2 ;; esac

# ONE PASS, ON DEMAND. The same code that feeds the monitor also answers "what is waiting on me
# right now", and it has to be the same code or the two answers drift and the on-demand one is the
# one nobody tests. A role runs this at the start of every round and whenever its watch has gone
# quiet, so **being woken is an optimisation and never the only way work is found.** A process in
# which a dead background process can strand fourteen pull requests is not a process; it is a
# process plus a single point of failure that nothing watches.
sweep=no
interval=60
case "${2:-}" in
  --sweep) sweep=yes ;;
  "")      : ;;
  -*)      echo "::error::unknown option '$2'. This is a typo, not an interval — refusing." >&2; exit 2 ;;
  *)       interval=$2 ;;
esac

resolve_repo
seen=""
polls=0
npr="?"

emit() { # emit <state> <number> <title> [detail]
  local key="$1|$2|${4:-}"
  case "$seen" in *"[$key]"*) return 0 ;; esac
  seen="$seen[$key]"
  if [ -n "${4:-}" ]; then echo "$1 #$2  $3  —  $4"; else echo "$1 #$2  $3"; fi
}

# WHAT MAIN LOOKS LIKE, READ FROM THE PUSH RUN AND NOT FROM ITS CHECK RUNS. `issue_comment` fires
# from the default branch, so its jobs — conditioned out for anything but a pull request — file
# themselves as **skipped check runs against main's head sha**, timestamped after the real push run.
# Reading check runs therefore returns "skipped" for a build that actually passed, and would return
# "skipped" just the same for one that actually failed. The push run is the only place main's real
# colour survives.
#
# THREE ANSWERS, NEVER TWO. A run still going is not a pass, and a lookup that failed is not a pass
# either; both would otherwise be spelled the same way as green and a red main would go unmentioned.
main_state() {
  local run concl st sha
  run=$(gh api "repos/$REPO/actions/runs?branch=main&event=push&per_page=1" 2>/dev/null) || {
    echo "MAIN STATE UNKNOWN (could not read the push run — check main yourself before merging more)"
    return 0
  }
  st=$(printf '%s' "$run" | jq -r '.workflow_runs[0].status // ""' 2>/dev/null || echo "")
  concl=$(printf '%s' "$run" | jq -r '.workflow_runs[0].conclusion // ""' 2>/dev/null || echo "")
  sha=$(printf '%s' "$run" | jq -r '.workflow_runs[0].head_sha // "" | .[0:8]' 2>/dev/null || echo "")
  case "$st|$concl" in
    "|"|"")        echo "MAIN STATE UNKNOWN (no push run found on main — check main yourself)" ;;
    *"|success")   echo "main is GREEN at ${sha:-?}" ;;
    completed"|"*) echo "MAIN IS RED at ${sha:-?} (${concl:-no conclusion}) — YOU merged into it, so this is yours to fix before merging anything else" ;;
    *)             echo "main's build is still running at ${sha:-?} — not green yet, watch it out" ;;
  esac
}

# The self-test drives main's colour through this, so what it asserts is what the watch runs.
[ "$role" = "--main-state" ] && { main_state; exit 0; }

while true; do
  # REST, not GraphQL: `gh pr list` is a GraphQL call and that quota runs out on its own schedule,
  # separately from REST. When it did, every such command returned nothing rather than an error.
  if ! prs=$(gh api "repos/$REPO/pulls?state=open&per_page=100" 2>&1); then
    echo "LOOKUP FAILED: $(printf '%s' "$prs" | tr '\n' ' ' | cut -c1-160)"
    # A SWEEP THAT COULD NOT READ THE BOARD MUST EXIT NON-ZERO. It is answering a question asked
    # once, and a caller that sees exit 0 and no events concludes there is nothing waiting on it —
    # which is this whole file's subject, arriving through its own front door.
    [ "$sweep" = no ] || exit 1
    sleep "$interval"; continue
  fi
  npr=$(printf '%s' "$prs" | jq -r 'length' 2>/dev/null || echo '?')

  while IFS=$'\t' read -r num title branch sha; do
    [ -n "$num" ] || continue
    # A PULL REQUEST THIS ROLE DID NOT WRITE IS A REVIEW WAITING TO HAPPEN. Review was the one step
    # nothing woke anybody for: a human had to notice a pull request existed and start an agent.
    # That is the coordinator this process removes, surviving in the one place it mattered most.
    #
    # Independence is derived from the `Agent:` trailers, which is what the gate reads — so the
    # event only ever goes to somebody the gate would accept.
    case "$branch" in
      "$role"/*) : ;;
      *)
        # THE AUTHORS COME FROM THE API, NOT FROM THIS CLONE — and this line is the whole bug.
        #
        # It used to read `git log "origin/main..origin/$branch"`. **A pull request opened after
        # this clone last fetched has no `origin/<branch>` here, so git exits non-zero, and under
        # `set -euo pipefail` a failing command substitution ENDS THE WATCH.** stderr was routed to
        # /dev/null, so it died without a word. That is the whole of the "the watcher keeps dying"
        # report: it was not random, it fired on the first foreign branch it had never fetched, and
        # a role learned about it by noticing hours later that nothing had arrived.
        #
        # It also explains the shape of the outages exactly. It killed the watch AFTER emitting
        # events (branches already fetched were processed first) and sometimes BEFORE emitting any
        # (the first branch examined was new). Running the script by hand survived because that
        # clone happened to have the branches. The self-test passed because it stubs `gh` and never
        # reaches git at all. **Every check anyone ran was green and every one of them was looking
        # somewhere else.**
        #
        # The API is also the more correct source, independently of the crash: the gate derives
        # independence from the pull request's own commit list, and a merge-base range in a local
        # clone is a different set of commits. A reviewer was wrongly cleared as independent by
        # exactly that difference and had to withdraw a verdict it had already posted.
        # THE SAME DERIVATION THE GATE USES, from the same file. Routing that disagrees with the
        # gate sends a role to do work the gate will refuse, which is worse than sending it nowhere.
        authors=$("$(dirname "${BASH_SOURCE[0]}")/pr-authors.sh" --pr "$num" 2>/dev/null || echo "")
        if [ -n "$authors" ] && ! printf '%s\n' "$authors" | grep -qi "^$role"; then
          # Only when it is actually waiting on one.
          rst=$(gh api "repos/$REPO/commits/$sha/status" --jq '[.statuses[]?|select(.context|test("Reviewed by an agent"))][0].state // ""' 2>/dev/null || echo "")
          [ "$rst" = success ] || emit NEEDS-REVIEW "$num" "$title" "[$branch] built by ${authors//$'\n'/, } — run /review-pr $num"
        fi
        continue ;;
    esac

    # Check runs on the head sha. A failure here is itself a lookup failure, not a green.
    if ! runs=$(gh api "repos/$REPO/commits/$sha/check-runs" 2>&1); then
      echo "LOOKUP FAILED: check runs for #$num: $(printf '%s' "$runs" | tr '\n' ' ' | cut -c1-120)"
      continue
    fi
    failing=$(printf '%s' "$runs" | jq -r '[.check_runs[]? | select(.conclusion=="failure" or .conclusion=="timed_out" or .conclusion=="cancelled") | .name] | join(", ")' 2>/dev/null || echo "")
    pending=$(printf '%s' "$runs" | jq -r '[.check_runs[]? | select(.status!="completed")] | length' 2>/dev/null || echo 0)

    # THE ISSUE MOVED UNDER AN OPEN PULL REQUEST. A ruling changes what an Issue asks for, and
    # nothing told the work already in flight: one pull request was cut three minutes before a
    # ruling landed and another fourteen minutes after it, and BOTH were built to the old reading.
    # The queue already knows a ruling makes a built Issue unbuilt — that only governs what is
    # picked up NEXT, and says nothing to a branch that is already open.
    #
    # A stale build and a wrong build look identical in a diff. This is the one thing that tells
    # them apart, and it has to arrive before the review does.
    iss=$(gh api "repos/$REPO/pulls/$num" --jq '.body' 2>/dev/null | grep -oE '(Refs|refs) #[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
    if [ -n "$iss" ]; then
      iupd=$(gh api "repos/$REPO/issues/$iss" --jq .updated_at 2>/dev/null || echo "")
      cupd=$(gh api "repos/$REPO/commits/$sha" --jq .commit.committer.date 2>/dev/null || echo "")
      if [ -n "$iupd" ] && [ -n "$cupd" ] && [ "$iupd" \> "$cupd" ]; then
        emit ISSUE-MOVED "$num" "$title" "Issue #$iss changed at $iupd, after this head was written at $cupd — re-read it before anyone reviews this"
      fi
    fi

    if [ -n "$failing" ]; then
      # THE GATE'S OWN MESSAGE, NOT JUST ITS NAME. Measured by handing a dev agent nothing but the
      # gate name: it recovered the diagnosis, but only by mapping the PR number to a branch over
      # REST and then re-running the gate locally to reproduce the text. Its own conclusion — "the
      # entire diagnosis was already printed by CI and then discarded before it reached me."
      #
      # A gate name is also ambiguous on purpose: `Branch name and commit convention` covers two
      # rules, and half of it was a red herring for the failure that actually occurred.
      why=$(gh api "repos/$REPO/commits/$sha/check-runs" \
              --jq '[.check_runs[]? | select(.conclusion=="failure" or .conclusion=="timed_out" or .conclusion=="cancelled") | .id][]' 2>/dev/null \
            | while read -r id; do
                gh api "repos/$REPO/check-runs/$id/annotations" \
                  --jq '.[]? | select(.message | test("exit code") | not) | .message' 2>/dev/null
              done | head -3 | tr '\n' ' ' | cut -c1-300)
      # AN ANNOTATION THAT COULD NOT BE READ IS NOT AN ABSENT ONE. Say which happened, or the reader
      # takes a bare gate name as "there was nothing more to say".
      [ -n "$why" ] || why="$failing (no annotation readable — fetch the run log)"
      emit FAILING "$num" "$title" "[$branch] $why"
      continue
    fi

    # A FAILING COMMIT STATUS IS A SECOND, INDEPENDENT RED. Check runs and commit statuses are
    # different endpoints, and the review verdict lives ONLY in the status — deliberately, so the
    # job can stay green and auto-merge can arm. Watching check runs alone reported a pull request
    # as needing one fix when it had two, and the invisible one was the one blocking the merge.
    # Measured: a dev agent fixed what the event named, then found the blocker by hand.
    if st=$(gh api "repos/$REPO/commits/$sha/status" 2>/dev/null); then
      badst=$(printf '%s' "$st" | jq -r '[.statuses[]? | select(.state=="failure" or .state=="error") | "\(.context): \(.description)"] | join("; ")' 2>/dev/null || echo "")
      [ -n "$badst" ] && { emit FAILING "$num" "$title" "[$branch] $badst"; continue; }
    fi

    # A review asking for changes is a state the author must hear about — it is not visible in any
    # check run, and a PR sitting on it looks identical to one waiting for a reviewer.
    if revs=$(gh api "repos/$REPO/pulls/$num/reviews" 2>/dev/null); then
      cr=$(printf '%s' "$revs" | jq -r '[.[] | select(.state=="CHANGES_REQUESTED")] | length' 2>/dev/null || echo 0)
      [ "${cr:-0}" -gt 0 ] && { emit CHANGES "$num" "$title"; continue; }
    fi

    [ "${pending:-0}" -eq 0 ] && emit READY "$num" "$title"
  done < <(printf '%s' "$prs" | jq -r '.[] | [.number, .title, .head.ref, .head.sha] | @tsv' 2>/dev/null || true)

  # Recently merged ones, so an agent learns its work landed rather than polling for it.
  #
  # TWO ROLES HEAR ABOUT ONE MERGE, AND THEY HEAR DIFFERENT THINGS. The author learns its work
  # landed. **The role that merged learns what main looks like afterwards** — which nothing told it
  # before, so a merge was performed and its result was observed by nobody. The loop was declared
  # closed at "merged and the Issue closed"; a merge produces a new state that no one consumed.
  #
  # THE MERGER IS DERIVED FROM THE BRANCH TYPE, NOT FROM `merged_by`. Every role authenticates as
  # the same GitHub account, so `merged_by.login` is identical for all of them and carries no role.
  # What does carry it is the rule that put the pull request in somebody's merge queue in the first
  # place — `queue.sh` routes `feat`/`spec` to product and everything else to qa. Same rule here, so
  # the role told to merge it is the role told how it went.
  if merged=$(gh api "repos/$REPO/pulls?state=closed&per_page=20&sort=updated&direction=desc" 2>/dev/null); then
    mainstate=""
    while IFS=$'\t' read -r num title branch; do
      [ -n "$num" ] || continue
      case "$branch" in "$role"/*) emit MERGED "$num" "$title" ;; esac

      case "$branch" in */feat/*|*/spec/*) merger=product ;; *) merger=qa ;; esac
      [ "$merger" = "$role" ] || continue
      [ -n "$mainstate" ] || mainstate=$(main_state)
      emit MERGED "$num" "$title" "you merged this — $mainstate"
    done < <(printf '%s' "$merged" | jq -r '.[] | select(.merged_at != null) | [.number, .title, .head.ref] | @tsv' 2>/dev/null || true)
  fi

  # A SWEEP IS ONE PASS AND THEN IT IS OVER.
  [ "$sweep" = no ] || exit 0

  # THE HEARTBEAT. Emitted on the first poll and every tenth after it — the first so that starting
  # the watch is observable at all (a watch shot dead in its first second previously produced no
  # output file, and "it never wrote anything" was indistinguishable from "there was nothing to
  # say"), and every tenth so that its absence is a diagnosis rather than a mood.
  polls=$((polls + 1))
  if [ "$polls" -eq 1 ] || [ $((polls % 10)) -eq 0 ]; then
    echo "WATCHING  $role  ${npr:-?} open  —  poll #$polls, nothing new. If this line stops arriving, this watch is DEAD: restart it and run '.workflow/bin/watch-prs.sh $role --sweep' to find what it missed."
  fi

  sleep "$interval"
done
