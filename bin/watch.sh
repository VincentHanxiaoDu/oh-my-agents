#!/usr/bin/env bash
# One watcher per role, per kind, per machine — a singleton guard in front of the framework's
# watchers.
#
# WHY THIS EXISTS. Every `claude` session runs its own pollers, and they all spend ONE shared
# per-account GitHub quota. Measured on this machine during Issue #11: 19 watcher processes across
# 14 sessions, with `dev` and `qa` each being watched by TWO sessions at once. The result was a
# GitHub **secondary** (burst/concurrency) rate limit — HTTP 403 on every call while the primary
# counters read nearly full (REST core 4437/5000, GraphQL 4908/5000). `gh api rate_limit` does not
# report secondary limits, so the obvious diagnostic says "you have plenty of quota" and is useless.
#
# WHY A LOCK AND NOT A BACKOFF. Slowing the watchers 60s -> 300s did not help: they 403'd on the
# FIRST poll after restart. Interval is not the lever. A backoff still has N sessions colliding,
# just less often; a singleton has one.
#
# AND THE PROBLEM UNDER THE QUOTA SYMPTOM, which outlives it: two agents can hold the same role
# concurrently. Two `qa` sessions watching the same queue are both told to verify, merge and close
# the same pull request. The `[qa]` dedup marker makes REPORTING idempotent. It does not make
# MERGING idempotent.
#
# WHY IT LIVES HERE AND NOT IN `.workflow/bin/watch-*.sh`.
# `.workflow/bin/`, `.claude/` and `.github/` belong to the installer and are replaced WHOLESALE on
# every refresh — twice in one round, mid-flight, while branches were open. A guard written into
# `watch-queue.sh` is lost on the next install, SILENTLY, which is the worst kind: the protection
# appears to exist and does not. `bin/` is this project's own directory. The installer neither
# creates nor replaces it, so the guard survives an upgrade. This file EDITS NOTHING the installer
# owns; it wraps it.
#
# THE LOCK HAS THREE ANSWERS, NEVER TWO:
#
#   free           no lock, or a lock whose holder is provably gone. Acquire.       exit 0 -> exec
#   held           a live process identified as this role's watcher holds it.       exit 4
#   undetermined   there is a lock and this script cannot tell what it means.       exit 3
#
# **"Could not determine" is not "determined to be nothing."** They get different exit codes and
# different wording on purpose. Treating undetermined as free is precisely how you get two watchers
# again — so it refuses, names what it saw, and tells you what to do.
#
# NOTHING HERE EVER KILLS ANYTHING. Issue #11's own postmortem is an agent killing another
# session's watchers on the strength of "they match my role and my old interval", which is not
# identification. This script refuses and names the holder. That is the whole remedy.
#
# Usage:
#   bin/watch.sh queue <role> [interval-seconds]   guard, then exec .workflow/bin/watch-queue.sh
#   bin/watch.sh prs   <role> [interval-seconds]   guard, then exec .workflow/bin/watch-prs.sh
#   bin/watch.sh status <kind> <role>              report free | held | undetermined, acquire nothing
#   bin/watch.sh --self-test
#
# Environment:
#   OMA_WATCH_LOCK_DIR   where locks live. Default: $XDG_RUNTIME_DIR, else $TMPDIR, else /tmp,
#                        plus /oma-watch-locks. Tests point this at their own directory so they
#                        can never observe, take or disturb a live session's lock.
#   OMA_WORKFLOW_BIN     where the framework's watchers are. Default: <this repo>/.workflow/bin.
set -euo pipefail

ROLES="dev qa product ops pm"
KINDS="queue prs"

# Exit codes, named once. `free`, `held` and `undetermined` must never share one.
EX_USAGE=2
EX_UNDETERMINED=3
EX_HELD=4

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$here/.." && pwd)

lock_dir() {
  if [ -n "${OMA_WATCH_LOCK_DIR:-}" ]; then printf '%s' "$OMA_WATCH_LOCK_DIR"; return; fi
  local base=${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}
  printf '%s' "${base%/}/oma-watch-locks"
}

lock_file() { printf '%s/%s.%s.lock' "$(lock_dir)" "$1" "$2"; }  # <kind> <role>

# ── liveness and identity ────────────────────────────────────────────────────────────────────────
# A pid is not a holder. A pid PLUS liveness PLUS evidence that the process is this role's watcher
# is a holder. Anything short of that is undetermined, never free.

# ps_cmd <pid> -> prints the command line; rc 0 found, 1 no such pid, 2 ps unusable.
# PROBED, NOT NAMED. `ps -p N -o command=` is POSIX-ish and works on darwin and on Linux, but this
# refuses to assume it: if ps cannot answer about our OWN pid, ps is unusable here and every
# identity question becomes undetermined rather than silently "not a watcher".
ps_cmd() {
  local pid=$1 out
  ps -p $$ -o command= >/dev/null 2>&1 || return 2
  out=$(ps -p "$pid" -o command= 2>/dev/null) || return 1
  [ -n "$out" ] || return 1
  printf '%s' "$out"
}

# alive <pid> -> 0 alive, 1 gone, 2 cannot tell.
# `kill -0` returns non-zero for EPERM as well as ESRCH — alive-but-not-ours reads the same as gone.
# So a failed `kill -0` is cross-checked against ps before anything is called stale.
alive() {
  local pid=$1 rc
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ "$pid" -gt 0 ] || return 1
  if kill -0 "$pid" 2>/dev/null; then return 0; fi
  # `|| rc=$?` AND NOT `; rc=$?`. Under `set -e` a bare call that returns non-zero kills the whole
  # script — so every "cannot tell" branch below became a silent exit before any of them could be
  # reported. Found by the suite: `status` printed nothing and every held/stale case fell through to
  # the generic UNDETERMINED. **A three-valued function is only three-valued if its caller survives
  # two of the three.**
  rc=0; ps_cmd "$pid" >/dev/null 2>&1 || rc=$?
  case "$rc" in 0) return 0 ;; 1) return 1 ;; *) return 2 ;; esac
}

# ps_started <pid> -> prints the process's START TIME, whitespace-squeezed; rc 0 found, 1 no such
# pid, 2 ps unusable. `-o lstart=` is an absolute wall-clock timestamp on both darwin and Linux, and
# it is PROBED against our own pid rather than assumed.
ps_started() {
  local pid=$1 out
  ps -p $$ -o lstart= >/dev/null 2>&1 || return 2
  out=$(ps -p "$pid" -o lstart= 2>/dev/null) || return 1
  out=$(printf '%s' "$out" | tr -s '[:space:]' ' ')
  out=${out# }; out=${out% }
  [ -n "$out" ] || return 2
  printf '%s' "$out"
}

# is_same_process <pid> <recorded-start> -> 0 same incarnation, 1 pid was recycled, 2 cannot tell.
#
# WHY START TIME AND NOT THE COMMAND LINE. The first version of this matched `ps -o command=`
# against `watch-<kind>.sh` and the role. It was driven against a stub watcher that `exec`s, and it
# reported UNDETERMINED for a lock it had just written itself: after an exec the argv is the new
# program's, and the evidence had evaporated. A holder that changes its own name defeats a name
# check, and the framework's watchers are free to exec anything they like.
#
# A pid's start time cannot be changed by the process. pid + start time names one process
# INCARNATION and nothing else, which is exactly what a lock needs to survive pid reuse — the only
# way a dead holder's pid comes back to life. The lock file supplies the rest of the identity: it
# records `role` and `kind`, and it was written by this same incarnation.
is_same_process() {
  local pid=$1 want=$2 got rc=0
  [ -n "$want" ] || return 2   # No recorded start time: a lock this script cannot interpret.
  got=$(ps_started "$pid") || rc=$?
  [ "$rc" -ne 0 ] && return 2
  [ "$got" = "$want" ] && return 0
  return 1
}

read_field() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1; }

# inspect <kind> <role> -> prints "<state>\t<detail>", state in free|held|undetermined
inspect() {
  local kind=$1 role=$2 f pid lrole lkind lrepo lstarted lhost lpsstart cmd
  f=$(lock_file "$kind" "$role")
  [ -e "$f" ] || { printf 'free\tno lock at %s\n' "$f"; return 0; }
  if [ ! -r "$f" ]; then
    printf 'undetermined\ta lock exists at %s and cannot be READ (permissions). It has NOT been taken and no watcher has been shown to be running.\n' "$f"
    return 0
  fi
  pid=$(read_field "$f" pid); lrole=$(read_field "$f" role); lkind=$(read_field "$f" kind)
  lrepo=$(read_field "$f" repo); lstarted=$(read_field "$f" started); lhost=$(read_field "$f" host)
  lpsstart=$(read_field "$f" psstart)
  case "$pid" in
    ''|*[!0-9]*)
      printf 'undetermined\ta lock exists at %s but its pid field is missing or is not a number (%s). It has NOT been taken.\n' "$f" "${pid:-<empty>}"
      return 0 ;;
  esac
  if [ "$lrole" != "$role" ] || [ "$lkind" != "$kind" ]; then
    printf 'undetermined\ta lock exists at %s but claims role=%s kind=%s, which is not the %s %s watcher. It has NOT been taken.\n' \
      "$f" "${lrole:-<empty>}" "${lkind:-<empty>}" "$role" "$kind"
    return 0
  fi
  local a=0; alive "$pid" || a=$?
  if [ "$a" -eq 2 ]; then
    printf 'undetermined\ta lock at %s names pid %s and this machine cannot tell whether that pid is alive. It has NOT been taken.\n' "$f" "$pid"
    return 0
  fi
  if [ "$a" -eq 1 ]; then
    printf 'free\tthe lock at %s names pid %s, which is not running — stale, and takeable\n' "$f" "$pid"
    return 0
  fi
  local i=0; is_same_process "$pid" "$lpsstart" || i=$?
  cmd=$(ps_cmd "$pid" 2>/dev/null || echo "?")
  if [ "$i" -eq 0 ]; then
    printf 'held\tpid %s (%s), started %s, on %s, in %s\n' "$pid" "$cmd" "${lstarted:-?}" "${lhost:-?}" "${lrepo:-?}"
    return 0
  fi
  if [ "$i" -eq 2 ]; then
    printf 'undetermined\ta lock at %s names live pid %s and this machine cannot confirm it is the same process that wrote the lock (no readable start time). It has NOT been taken.\n' "$f" "$pid"
    return 0
  fi
  # PROVABLY RECYCLED. A pid's start time is immutable, so a different one means the process that
  # wrote this lock has exited and an unrelated program now wears its number. That is a
  # DETERMINATION, not a guess — which is why it is allowed to be `free` where the command-line
  # check it replaced could only ever have been "probably".
  printf 'free\tthe lock at %s names pid %s, whose start time does not match the one recorded — that process is gone and `%s` now holds the number. Stale, and takeable\n' \
    "$f" "$pid" "$cmd"
}

# ── acquisition ──────────────────────────────────────────────────────────────────────────────────

# write_lock_exclusively <file> -> 0 we created it, 1 it already existed, 2 could not create it.
# `set -o noclobber` makes `>` an O_CREAT|O_EXCL open: the kernel arbitrates, so two invocations
# racing in the same millisecond cannot both win. No `flock` — it is not on a stock macOS, and this
# repo runs on darwin.
write_lock_exclusively() {
  local f=$1 payload=$2 err
  err=$( { set -o noclobber; printf '%s' "$payload" > "$f"; } 2>&1 ) && return 0
  [ -e "$f" ] && return 1
  printf '%s' "$err" >&2
  return 2
}

acquire() { # acquire <kind> <role> ; 0 acquired, EX_HELD, EX_UNDETERMINED
  local kind=$1 role=$2 f state detail payload attempt
  f=$(lock_file "$kind" "$role")
  mkdir -p "$(lock_dir)" 2>/dev/null || {
    echo "::error::the lock directory $(lock_dir) could not be created, so whether a watcher already holds '$role' is UNDETERMINED. Nothing has been started." >&2
    return "$EX_UNDETERMINED"
  }
  # `psstart` IS THE IDENTITY, and it is recorded at acquisition because it cannot be recovered
  # afterwards. If ps cannot answer here it is written EMPTY rather than guessed — and an empty one
  # makes every later question about this lock UNDETERMINED, which refuses. On a machine with no
  # usable ps that means the role must be freed by deleting the file by hand. That is the honest
  # outcome: there is no way to tell a live holder from a dead one there, and refusing is the only
  # answer that cannot produce two watchers.
  local psstart; psstart=$(ps_started $$ 2>/dev/null || echo "")
  payload=$(printf 'pid=%s\npsstart=%s\nrole=%s\nkind=%s\nrepo=%s\nhost=%s\nstarted=%s\n' \
    "$$" "$psstart" "$role" "$kind" "$repo_root" "$(hostname 2>/dev/null || echo unknown)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")

  for attempt in 1 2; do
    write_lock_exclusively "$f" "$payload"
    case $? in
      0) return 0 ;;
      2) echo "::error::the lock file $f could not be written, so whether a watcher already holds '$role' is UNDETERMINED. Nothing has been started." >&2
         return "$EX_UNDETERMINED" ;;
    esac
    IFS=$'\t' read -r state detail < <(inspect "$kind" "$role")
    case "$state" in
      held)
        echo "::error::REFUSING: the $kind watcher for role '$role' is already held by $detail" >&2
        echo "  One watcher per role, per kind, per machine. Several sessions polling one shared GitHub" >&2
        echo "  quota is what produced the secondary rate limit in Issue #11 — and two agents holding" >&2
        echo "  one role both get told to merge the same pull request." >&2
        echo "  Nothing has been started and NOTHING HAS BEEN KILLED. Use that watcher, or stop it yourself." >&2
        return "$EX_HELD" ;;
      undetermined)
        echo "::error::UNDETERMINED: $detail" >&2
        echo "  This is NOT a statement that the role is free. It is a statement that this script" >&2
        echo "  cannot tell, and starting a second watcher on a guess is the failure it exists to" >&2
        echo "  prevent. Nothing has been started and nothing has been killed." >&2
        echo "  Identify the holder yourself, and remove $f BY HAND if you are sure nothing is watching." >&2
        return "$EX_UNDETERMINED" ;;
      free)
        # Stale, or it vanished between the two calls. Take it once and retry the exclusive create.
        rm -f "$f" 2>/dev/null || {
          echo "::error::a stale lock at $f could not be removed, so this is UNDETERMINED. Nothing has been started." >&2
          return "$EX_UNDETERMINED" ; }
        ;;
    esac
  done
  echo "::error::the lock at $f could neither be acquired nor shown to be held — UNDETERMINED. Nothing has been started." >&2
  return "$EX_UNDETERMINED"
}

usage() {
  cat <<'USAGE'
Usage:
  bin/watch.sh queue <role> [interval-seconds]   guard, then exec .workflow/bin/watch-queue.sh
  bin/watch.sh prs   <role> [interval-seconds]   guard, then exec .workflow/bin/watch-prs.sh
  bin/watch.sh status <kind> <role>              report free | held | undetermined, acquire nothing
  bin/watch.sh --self-test

Exit codes: 0 acquired (or free)   4 held by a live watcher   3 UNDETERMINED   2 usage
"Undetermined" is not "free". Never read it as one.
USAGE
}

# ── self-test ────────────────────────────────────────────────────────────────────────────────────
# The real suite is tests/watch-singleton.test.sh, driven by `make ci`. This arm is the cheap one:
# the three answers must not share an exit code, which is the property everything else rests on.
self_test() {
  local rc=0
  [ "$EX_UNDETERMINED" != "$EX_HELD" ] && [ "$EX_UNDETERMINED" != 0 ] && [ "$EX_HELD" != 0 ] \
    || { echo "SELF-TEST FAIL: free, held and undetermined do not have three distinct exit codes — 'cannot tell' would read as 'free to proceed'" >&2; rc=1; }
  [ "$rc" -eq 0 ] && echo "self-test passed: free, held and undetermined are three distinct exit codes (0 / $EX_HELD / $EX_UNDETERMINED)"
  return $rc
}

# ── entry point ──────────────────────────────────────────────────────────────────────────────────

cmd=${1:-}
case "$cmd" in
  --self-test) self_test; exit $? ;;
  -h|--help)   usage; exit 0 ;;
  -*)          echo "::error::unknown option '$cmd'. This is a typo, not an argument — refusing." >&2; usage >&2; exit "$EX_USAGE" ;;
esac

if [ "$cmd" = status ]; then
  kind=${2:-}; role=${3:-}
  case " $KINDS " in *" $kind "*) : ;; *) echo "::error::'$kind' is not a watcher kind. One of: $KINDS" >&2; exit "$EX_USAGE" ;; esac
  case " $ROLES " in *" $role "*) : ;; *) echo "::error::'$role' is not a role. One of: $ROLES" >&2; exit "$EX_USAGE" ;; esac
  IFS=$'\t' read -r state detail < <(inspect "$kind" "$role")
  echo "$state: $detail"
  case "$state" in
    free) exit 0 ;;
    held) exit "$EX_HELD" ;;
    *)    exit "$EX_UNDETERMINED" ;;
  esac
fi

kind=$cmd
role=${2:-}
interval=${3:-60}
case " $KINDS " in *" $kind "*) : ;; *)
  echo "::error::'$kind' is not a watcher kind. One of: $KINDS status" >&2; usage >&2; exit "$EX_USAGE" ;; esac
case " $ROLES " in *" $role "*) : ;; *)
  echo "::error::'$role' is not a role. One of: $ROLES" >&2; usage >&2; exit "$EX_USAGE" ;; esac
case "$interval" in ''|*[!0-9]*) echo "::error::interval '$interval' is not a number of seconds." >&2; exit "$EX_USAGE" ;; esac

workflow_bin=${OMA_WORKFLOW_BIN:-$repo_root/.workflow/bin}
target="$workflow_bin/watch-$kind.sh"
[ -x "$target" ] || [ -f "$target" ] || {
  echo "::error::$target does not exist — the framework's watcher is not installed here. Nothing has been started." >&2
  exit "$EX_USAGE"
}

acquire "$kind" "$role" || exit $?

# HANDED OVER BY `exec`, DELIBERATELY. The lock names THIS pid, and a pid survives exec — so the
# process the lock names is the process that is polling, and identifying it is a question about the
# thing itself rather than about a parent. The alternative, running the watcher as a child so a
# trap could delete the lock on exit, buys tidier cleanup at the price of an orphan: SIGKILL the
# wrapper and the child keeps polling with nothing holding its lock. That orphan is the shape of
# the problem this file exists to remove, so it is not worth a cleaner /tmp.
#
# NOTHING RELEASES THIS LOCK, AND NOTHING NEEDS TO. A lock whose pid is not running is stale and is
# taken by the next invocation. That rule is what makes it safe to never clean up — and what stops
# a crashed session from wedging a role forever.
echo "acquired the $kind watcher for role '$role' (pid $$, lock $(lock_file "$kind" "$role"))" >&2
exec bash "$target" "$role" "$interval"
