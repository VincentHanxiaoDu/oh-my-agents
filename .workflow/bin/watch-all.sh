#!/usr/bin/env bash
# Keep BOTH of a role's watches alive, in one process, and restart either one that dies.
#
# WHY THIS EXISTS. A role starts two monitors — `watch-queue.sh` for new Issues and `watch-prs.sh`
# for its own pull requests — and observed reality is that it ends up with one. Something ends a
# watch, nothing restarts it, and the role goes on believing it is being told about work of a kind
# it will now never hear about again. **Which half is missing is the part nobody notices**: a role
# with only the queue watch still gets new Issues, so it looks fine, and simply never learns that a
# gate went red or that a pull request is waiting on its verdict.
#
# Restarting was previously the role's job, which made it a thing an agent had to remember while
# doing something else. That is not a mechanism. This is: one process to start, and it is
# responsible for the other two existing.
#
# WHAT IT EMITS, beyond whatever the children emit:
#
#   WATCH RESTARTED <name> (exit n)   a child died and has been started again
#   WATCH SUPERVISOR ALIVE — ...      both children confirmed running
#   SUPERVISOR DIED (exit n)          this process is going away, so nothing is watching now
#
# **A RESTART IS ANNOUNCED, NEVER SILENT.** A supervisor that quietly patches over a child dying
# every thirty seconds looks identical to one with nothing wrong, and the repair hides the fault —
# so the count is carried in the line and a role can see it climbing.
#
# Usage: watch-all.sh <role> [interval-seconds]     default interval: 300
#        watch-all.sh --self-test
set -euo pipefail

# The same pair the children carry, for the same reasons — see watch-prs.sh.
# ANNOUNCED ONLY ONCE SUPERVISING HAS ACTUALLY STARTED. A refusal on a bad argument, or a failing
# self-test, is not a watch dying, and saying "this role is now blind" about either trains the
# reader to skim the line that means it.
SUPERVISING=0
trap 'src=$?; [ "$src" -eq 0 ] || [ "$SUPERVISING" -eq 0 ] || echo "SUPERVISOR DIED (exit $src) — BOTH watches are gone with it and this role is now fully blind. Restart it, then run .workflow/bin/watch-prs.sh $role --sweep to find what was missed." >&2' EXIT
trap '' URG

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

self_test() {
  local rc=0 tmp out
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN

  # Children that exit immediately, so the restart path is exercised without waiting on anything.
  # DRIVEN AGAINST REAL CHILDREN THAT REALLY DIE, not by grepping this file for the word restart.
  printf '#!/usr/bin/env bash\necho "child-queue up"\nexit 7\n' > "$tmp/watch-queue.sh"
  printf '#!/usr/bin/env bash\necho "child-prs up"\nsleep 30\n'  > "$tmp/watch-prs.sh"
  chmod +x "$tmp/watch-queue.sh" "$tmp/watch-prs.sh"
  cp "${BASH_SOURCE[0]}" "$tmp/watch-all.sh"

  ( bash "$tmp/watch-all.sh" dev 1 >"$tmp/out" 2>&1 & echo $! > "$tmp/pid" )
  sleep 6
  local pid; pid=$(cat "$tmp/pid")
  out=$(cat "$tmp/out" 2>/dev/null || echo "")

  # 1. A DEAD CHILD MUST COME BACK. This is the whole point: the role ends up with one watch and
  #    cannot tell which half it has lost.
  local n; n=$(printf '%s\n' "$out" | grep -c 'WATCH RESTARTED' || true)
  [ "$n" -ge 1 ] || { echo "SELF-TEST FAIL: a child that exited was never restarted — a role would silently keep one watch of two (got: $out)" >&2; rc=1; }

  # 2. AND THE RESTART MUST BE ANNOUNCED WITH WHICH ONE AND WHY. "Something restarted" is not a
  #    diagnosis, and a supervisor papering over a crash loop must be visible as one.
  case "$out" in
    *"watch-queue"*) : ;;
    *) echo "SELF-TEST FAIL: the restart did not name which watch died" >&2; rc=1 ;;
  esac
  case "$out" in
    *"exit 7"*) : ;;
    *) echo "SELF-TEST FAIL: the restart did not carry the child's exit code, so a crash loop cannot be told from a one-off" >&2; rc=1 ;;
  esac

  # 3. THE SUPERVISOR MUST STILL BE ALIVE. One that dies with its child has replaced two failures
  #    with one bigger one.
  kill -0 "$pid" 2>/dev/null || { echo "SELF-TEST FAIL: the supervisor died along with its child" >&2; rc=1; }

  # 4. AND IT MUST SAY IT IS ALIVE, for the same reason the children do — silence must not have two
  #    meanings here either.
  case "$out" in
    *"SUPERVISOR ALIVE"*) : ;;
    *) echo "SELF-TEST FAIL: the supervisor emitted no heartbeat — its own death would be indistinguishable from a quiet board" >&2; rc=1 ;;
  esac
  kill "$pid" 2>/dev/null || true
  pkill -P "$pid" 2>/dev/null || true

  # 5. AN UNKNOWN ROLE MUST REFUSE rather than supervise nothing forever.
  ( bash "$tmp/watch-all.sh" not-a-role 1 ) >/dev/null 2>&1 \
    && { echo "SELF-TEST FAIL: an unknown role was accepted" >&2; rc=1; }

  [ "$rc" -eq 0 ] && echo "self-test passed: a dead child is restarted, the restart names which one and its exit code, the supervisor outlives it and says so, and an unknown role refuses"
  return $rc
}

[ "${1:-}" = "--self-test" ] && { self_test; exit $?; }

role=${1:?usage: watch-all.sh <role> [interval-seconds] | --self-test}
# 300s, NOT 60. Measured on a six-pull-request board: one poll of both watches costs a role about 52
# API calls, so three roles at 60s is ~9360 calls/hour against a limit of 5000 — 1.9x over, before
# any agent does any work of its own. At 300s it is ~1872, about 37% of the budget. A product agent
# raised its own watch to 300 unilaterally and said why; it was right and this default was wrong.
# Nothing on a review board moves on a sixty-second timescale.
interval=${2:-300}
case "$role" in dev|qa|product|ops|pm) : ;; *) echo "::error::'$role' is not a role. One of: dev qa product ops pm" >&2; exit 2 ;; esac

# PLAIN VARIABLES, NOT AN ASSOCIATIVE ARRAY. `declare -A` is bash 4, and macOS ships bash 3.2 as
# /bin/bash — the first version of this file died on the developer's own laptop with `declare: -A:
# invalid option` and took both watches down with it. A supervisor that is less portable than the
# things it supervises is worse than none.
PID_QUEUE=""; PID_PRS=""
RESTARTS_QUEUE=0; RESTARTS_PRS=0

start_child() { # start_child <watch-queue|watch-prs>
  local name=$1
  "$here/$name.sh" "$role" "$interval" &
  case "$name" in
    watch-queue) PID_QUEUE=$! ;;
    watch-prs)   PID_PRS=$! ;;
  esac
}
pid_of()      { case "$1" in watch-queue) echo "$PID_QUEUE" ;; *) echo "$PID_PRS" ;; esac; }
restarts_of() { case "$1" in watch-queue) echo "$RESTARTS_QUEUE" ;; *) echo "$RESTARTS_PRS" ;; esac; }
bump()        { case "$1" in watch-queue) RESTARTS_QUEUE=$((RESTARTS_QUEUE+1)) ;; *) RESTARTS_PRS=$((RESTARTS_PRS+1)) ;; esac; }

start_child watch-queue
start_child watch-prs
SUPERVISING=1
echo "WATCH SUPERVISOR ALIVE — watch-queue and watch-prs started for '$role' (interval ${interval}s). If THIS line stops and no child output follows, nothing is watching."

# CHECKED OFTEN, ANNOUNCED RARELY. The poll is cheap and a gap between a child dying and coming back
# is a gap in coverage, so it is short; the heartbeat is not, because a line that arrives constantly
# is a line nobody reads.
ticks=0
while true; do
  sleep 5
  ticks=$((ticks + 1))
  for w in watch-queue watch-prs; do
    cpid=$(pid_of "$w")
    if ! kill -0 "$cpid" 2>/dev/null; then
      wait "$cpid" 2>/dev/null && crc=0 || crc=$?
      bump "$w"
      echo "WATCH RESTARTED $w (exit $crc) — it had died, so this role was watching only half of its work. Restart #$(restarts_of "$w") for this watch; if that number keeps climbing, the restart is hiding a fault rather than fixing it."
      start_child "$w"
    fi
  done
  # Every 24th tick ≈ 2 minutes.
  if [ $((ticks % 24)) -eq 0 ]; then
    echo "WATCH SUPERVISOR ALIVE — both watches up for '$role' (restarts so far: watch-queue $RESTARTS_QUEUE, watch-prs $RESTARTS_PRS)"
  fi
done
