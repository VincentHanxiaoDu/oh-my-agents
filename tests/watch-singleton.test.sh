#!/usr/bin/env bash
# The singleton guard's tests.
#
# EVERY TEST HERE HAS BEEN WATCHED GO RED — by inverting its assertion or breaking the code it
# covers — before being kept. A test that has never failed is a test that asserts nothing.
#
# THIS SUITE NEVER TOUCHES A LIVE WATCHER. It runs against its own lock directory, handed to
# bin/watch.sh through OMA_WATCH_LOCK_DIR, and against a stub framework watcher handed over through
# OMA_WORKFLOW_BIN. It starts only its own processes, records their pids, and stops only those. It
# does not `pkill`, does not match by name, and does not look at $TMPDIR/oma-watch-locks. Killing
# another session's watcher on the strength of "it matches my role" is the mistake documented in
# Issue #11's own postmortem.
#
# ENVIRONMENT IS PROBED, NOT NAMED. `flock` is absent on a stock macOS and this repo runs on darwin;
# `/proc` is absent there too; `/tmp` is not the temp directory everywhere. Nothing below assumes
# any of them. Where a check genuinely cannot run, it SKIPS WITH A STATED REASON and the reason is
# printed — a test that silently passes because the thing it needed was missing is the exact defect
# this project exists to remove.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WATCH="$root/bin/watch.sh"

pass=0; fail=0; skip=0
ok()   { pass=$((pass+1)); printf '  ok    %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/          /'; }
skipf(){ skip=$((skip+1)); printf '  SKIP  %s — %s\n' "$1" "$2"; }
check(){ # check <name> <condition-rc> <detail>
  if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1" "${3:-}"; fi
}

# Everything this suite starts, so it can stop exactly those and nothing else.
STARTED=""
cleanup() {
  local p
  for p in $STARTED; do kill "$p" 2>/dev/null || true; done
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
  return 0
}
trap cleanup EXIT

WORK=$(mktemp -d)             # NOT /tmp: mktemp answers where temp files go on this machine.
LOCKS="$WORK/locks"
STUBBIN="$WORK/workflow-bin"
mkdir -p "$LOCKS" "$STUBBIN"
# CREATED EMPTY UP FRONT. `grep -c` on a MISSING file prints nothing and exits 2, while on a present
# file with no match it prints `0` and exits 1 — two different shapes for "none so far", and the
# arithmetic below silently took one of them as an empty string.
: > "$WORK/started.log"

# The stub framework watcher: it records that it was exec'd, then EXECS AWAY into `sleep`.
#
# THE SECOND EXEC IS THE POINT, not an economy. It destroys the holder's argv, so a guard that
# identifies holders by command line cannot recognise the lock it just wrote. The first version did
# exactly that and this stub caught it. Do not replace the `exec` with a plain call.
for k in queue prs; do
  cat > "$STUBBIN/watch-$k.sh" <<STUB
#!/usr/bin/env bash
echo "started \$0 \$*" >> "$WORK/started.log"
exec sleep 600
STUB
  chmod +x "$STUBBIN/watch-$k.sh"
done

w() { OMA_WATCH_LOCK_DIR="$LOCKS" OMA_WORKFLOW_BIN="$STUBBIN" bash "$WATCH" "$@"; }

# wt: an acquire attempt that is EXPECTED TO REFUSE, run with a deadline.
#
# WHY THE DEADLINE. A refusal exits; an acquisition `exec`s the watcher and never returns. So the
# failure mode of every "it must refuse" test is not a wrong exit code — it is a test that HANGS.
# Found in the mutation run: deleting the exclusive create left the suite blocked until an external
# two-minute timeout killed it, which is a red nobody can read. Overrunning the deadline returns 99,
# a code no branch of the guard produces, so "it started the watcher instead of refusing" fails with
# that written on it.
#
# NOT `timeout`: that is GNU coreutils and absent from a stock macOS, which is what this repo runs
# on. This repo has already shipped a self-test that died on `timeout: command not found`.
wt() {
  local pid rc=99 waited=0
  OMA_WATCH_LOCK_DIR="$LOCKS" OMA_WORKFLOW_BIN="$STUBBIN" bash "$WATCH" "$@" >"$WORK/wt.out" 2>&1 &
  pid=$!
  while [ "$waited" -lt 40 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then wait "$pid"; rc=$?; break; fi
    sleep 0.25; waited=$((waited+1))
  done
  [ "$rc" -eq 99 ] && { kill "$pid" 2>/dev/null; echo "DID NOT EXIT: it acquired and ran the watcher instead of refusing"; }
  cat "$WORK/wt.out"
  return "$rc"
}
wbg() { # start a guarded watcher in the background; echoes its pid
  local pid
  OMA_WATCH_LOCK_DIR="$LOCKS" OMA_WORKFLOW_BIN="$STUBBIN" bash "$WATCH" "$@" >>"$WORK/bg.out" 2>&1 &
  pid=$!
  STARTED="$STARTED $pid"
  printf '%s' "$pid"
}
lockof() { printf '%s/%s.%s.lock' "$LOCKS" "$1" "$2"; }

# ── environment probes ───────────────────────────────────────────────────────────────────────────
HAVE_PS=1
ps -p $$ -o command= >/dev/null 2>&1 || HAVE_PS=0

echo "watch.sh singleton guard"
echo "  environment: ps -o command= $([ "$HAVE_PS" = 1 ] && echo available || echo UNAVAILABLE); temp dir $WORK"
echo

# ── 1. the guard's own self-test: three distinct exit codes ──────────────────────────────────────
out=$(w --self-test 2>&1); rc=$?
check "the three answers have three distinct exit codes" "$rc" "$out"

# ── 2. a first invocation ACQUIRES and actually reaches the watcher ──────────────────────────────
# Asserted through the stub's own marker file, not through an exit code: `acquired` that never
# execs is not acquiring anything.
p1=$(wbg queue dev 5)
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$WORK/started.log" ] && break; sleep 0.3; done
if [ -s "$WORK/started.log" ] && grep -q 'watch-queue.sh dev' "$WORK/started.log"; then
  ok "a first invocation acquires and execs the framework watcher"
  FIRST_OK=1
else
  bad "a first invocation acquires and execs the framework watcher" "$(cat "$WORK/bg.out" 2>/dev/null)"
  FIRST_OK=0
fi
check "the lock file names the holding pid" "$([ -f "$(lockof queue dev)" ] && grep -qx "pid=$p1" "$(lockof queue dev)" && echo 0 || echo 1)" \
  "$(cat "$(lockof queue dev)" 2>/dev/null)"

# ── 3. a SECOND invocation for the same role REFUSES and NAMES THE HOLDER ────────────────────────
# GUARDED BY FIRST_OK. A "second invocation refuses" that passes because the FIRST one also failed
# is a test asserting that the script is broken. It is not allowed to count.
if [ "$FIRST_OK" != 1 ]; then
  skipf "a second invocation refuses and names the holder" "the first invocation did not acquire, so a refusal here would prove nothing"
else
  out=$(wt queue dev 5 2>&1); rc=$?
  check "a second invocation refuses with the 'held' exit code (4)" "$([ "$rc" -eq 4 ] && echo 0 || echo 1)" "rc=$rc: $out"
  check "the refusal NAMES the holder's pid" "$(printf '%s' "$out" | grep -q "pid $p1" && echo 0 || echo 1)" "$out"
  check "the refusal says nothing was started" "$(printf '%s' "$out" | grep -qi 'nothing has been started' && echo 0 || echo 1)" "$out"
  check "the refusal says nothing was killed" "$(printf '%s' "$out" | grep -qi 'nothing has been killed\|NOTHING HAS BEEN KILLED' && echo 0 || echo 1)" "$out"
  n=$(grep -c 'watch-queue.sh dev' "$WORK/started.log")
  check "the refused invocation did NOT start a second watcher" "$([ "$n" -eq 1 ] && echo 0 || echo 1)" "started.log has $n queue/dev starts"
fi

# ── 4. a different KIND for the same role is a different lock ────────────────────────────────────
# One queue watcher and one PR watcher per role is the intended shape; the guard must not collapse
# them into one.
p2=$(wbg prs dev 5)
for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q 'watch-prs.sh dev' "$WORK/started.log" 2>/dev/null && break; sleep 0.3; done
check "queue and prs for one role are separate locks" "$(grep -q 'watch-prs.sh dev' "$WORK/started.log" && echo 0 || echo 1)" "$(cat "$WORK/bg.out")"

# ── 5. a different ROLE is unaffected ────────────────────────────────────────────────────────────
p3=$(wbg queue qa 5)
for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q 'watch-queue.sh qa' "$WORK/started.log" 2>/dev/null && break; sleep 0.3; done
check "a different role is not blocked by dev's lock" "$(grep -q 'watch-queue.sh qa' "$WORK/started.log" && echo 0 || echo 1)" "$(cat "$WORK/bg.out")"

# ── 6. `status` reports HELD without acquiring anything ──────────────────────────────────────────
# AND THIS IS THE EXEC TEST. The stub `exec sleep 600`s, so the holder's command line no longer
# names any watcher at all — it reads `sleep 600`. The first version of the guard identified holders
# by command line and reported UNDETERMINED here, for a lock it had written itself thirty seconds
# earlier. It identifies by process START TIME now, which a process cannot change and an exec does
# not disturb. If this ever goes red again for a holder that is plainly alive, that is the
# regression.
out=$(w status queue dev 2>&1); rc=$?
check "status reports 'held' for a watched role, exit 4" "$([ "$rc" -eq 4 ] && printf '%s' "$out" | grep -q '^held:' && echo 0 || echo 1)" "rc=$rc: $out"
check "a holder is still identified after it execs away its own argv" \
  "$(printf '%s' "$out" | grep -q "pid $p1" && echo 0 || echo 1)" "$out"

# ── 7. A STALE LOCK IS TAKEABLE — a dead holder must not wedge the role forever ──────────────────
# The dead pid is obtained by starting a process WE started and waiting for it to exit, so the pid
# is one this suite owns and has observed terminate. It is not a guess and not a scan.
dead=$( ( sleep 0.1 & echo $! ) ); sleep 0.6
if kill -0 "$dead" 2>/dev/null; then
  skipf "a stale lock is takeable" "the sacrificial pid $dead is still alive, so it is not a dead holder"
else
  printf 'pid=%s\nrole=%s\nkind=%s\nrepo=%s\nhost=t\nstarted=t\n' "$dead" ops queue "$root" > "$(lockof queue ops)"
  before=$(grep -c 'watch-queue.sh ops' "$WORK/started.log" 2>/dev/null || true)
  p4=$(wbg queue ops 5)
  for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q 'watch-queue.sh ops' "$WORK/started.log" 2>/dev/null && break; sleep 0.3; done
  after=$(grep -c 'watch-queue.sh ops' "$WORK/started.log" 2>/dev/null || true)
  check "a stale lock (holder pid is dead) is taken, not refused" "$([ "$after" -gt "$before" ] && echo 0 || echo 1)" "$(cat "$WORK/bg.out")"
  check "taking a stale lock rewrites it with the new pid" "$(grep -qx "pid=$p4" "$(lockof queue ops)" && echo 0 || echo 1)" "$(cat "$(lockof queue ops)")"
fi

# ── 8. AN UNREADABLE LOCK IS UNDETERMINED — NOT FREE ─────────────────────────────────────────────
# Three separate shapes of "there is a lock I cannot interpret". Each must refuse with exit 3, must
# leave the lock in place, and must not start anything.
undetermined_case() { # undetermined_case <name> <role> <lock-body>
  local name=$1 role=$2 body=$3 f out rc n_before n_after
  f=$(lockof queue "$role")
  printf '%s' "$body" > "$f"
  n_before=$(grep -c "watch-queue.sh $role" "$WORK/started.log" 2>/dev/null || true)
  out=$(wt queue "$role" 5 2>&1); rc=$?
  n_after=$(grep -c "watch-queue.sh $role" "$WORK/started.log" 2>/dev/null || true)
  check "$name → exit 3 (undetermined), not 0" "$([ "$rc" -eq 3 ] && echo 0 || echo 1)" "rc=$rc: $out"
  check "$name → says UNDETERMINED and not that the role is free" \
    "$(printf '%s' "$out" | grep -q 'UNDETERMINED' && printf '%s' "$out" | grep -qi 'NOT a statement that the role is free' && echo 0 || echo 1)" "$out"
  check "$name → the lock is left in place, not taken" "$([ -f "$f" ] && echo 0 || echo 1)" "the lock at $f was removed"
  check "$name → nothing was started" "$([ "$n_after" -eq "$n_before" ] && echo 0 || echo 1)" "started.log grew"
  rm -f "$f"
}
undetermined_case "a lock with no pid field"        product 'garbage that is not a lock at all'
undetermined_case "a lock whose pid is not a number" product "$(printf 'pid=notanumber\nrole=product\nkind=queue\n')"
undetermined_case "a lock claiming a different role" product "$(printf 'pid=%s\nrole=qa\nkind=queue\n' "$$")"
# A LIVE PID WITH NO RECORDED START TIME. The pid is real and running — this suite's own shell — so
# liveness alone would say "held" and a naive staleness rule would say "free". Neither is known:
# without the start time nothing connects that pid to the process that wrote the lock.
undetermined_case "a live pid with no recorded start time" product "$(printf 'pid=%s\nrole=product\nkind=queue\n' "$$")"

# ── 9. A RECYCLED PID IS PROVABLY STALE — and the proof is what makes it takeable ────────────────
# The lock names a LIVE pid, so liveness alone would refuse forever. But the start time recorded in
# the lock does not match that pid's actual start time, and a process cannot change its start time —
# so the holder has provably exited and an unrelated program wears its number. This is the one case
# where "alive" and "stale" are true at once, and it is a DETERMINATION rather than a guess.
if [ "$HAVE_PS" = 0 ]; then
  skipf "a recycled pid is provably stale" "ps -p N -o lstart= does not work on this machine, so no process start time can be read at all"
else
  sleep 600 & imposter=$!; STARTED="$STARTED $imposter"
  printf 'pid=%s\npsstart=%s\nrole=%s\nkind=%s\nrepo=%s\nhost=t\nstarted=t\n' \
    "$imposter" 'Thu Jan 1 00:00:00 1970' pm queue "$root" > "$(lockof queue pm)"
  before=$(grep -c 'watch-queue.sh pm' "$WORK/started.log" 2>/dev/null || true)
  p5=$(wbg queue pm 5)
  for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q 'watch-queue.sh pm' "$WORK/started.log" 2>/dev/null && break; sleep 0.3; done
  after=$(grep -c 'watch-queue.sh pm' "$WORK/started.log" 2>/dev/null || true)
  check "a live pid whose start time does not match the lock is taken, not refused" \
    "$([ "${after:-0}" -gt "${before:-0}" ] && echo 0 || echo 1)" "$(cat "$WORK/bg.out")"
  check "…and the imposter process was NOT killed" "$(kill -0 "$imposter" 2>/dev/null && echo 0 || echo 1)" \
    "pid $imposter is gone — this guard must never kill anything"
  kill "$imposter" 2>/dev/null || true
fi

# ── 10. THE THREE ANSWERS DO NOT SHARE A RENDERING ───────────────────────────────────────────────
rm -f "$(lockof prs qa)"
free_out=$(w status prs qa 2>&1); free_rc=$?
held_out=$(w status queue dev 2>&1); held_rc=$?
printf 'pid=x\n' > "$(lockof prs product)"
und_out=$(w status prs product 2>&1); und_rc=$?
rm -f "$(lockof prs product)"
check "free / held / undetermined have three different exit codes" \
  "$([ "$free_rc" -ne "$held_rc" ] && [ "$free_rc" -ne "$und_rc" ] && [ "$held_rc" -ne "$und_rc" ] && echo 0 || echo 1)" \
  "free=$free_rc held=$held_rc undetermined=$und_rc"
check "free / held / undetermined have three different words" \
  "$(printf '%s' "$free_out" | grep -q '^free:' && printf '%s' "$held_out" | grep -q '^held:' && printf '%s' "$und_out" | grep -q '^undetermined:' && echo 0 || echo 1)" \
  "$free_out | $held_out | $und_out"

# ── 11. TWO INVOCATIONS RACING: EXACTLY ONE WINS ─────────────────────────────────────────────────
# The exclusive create is the whole mutex, so it is driven rather than trusted. Not a proof of
# atomicity — no test in a shell is — but it fails loudly if the create is ever relaxed to a
# test-then-write.
rm -f "$(lockof prs ops)"
racers="$WORK/race"; mkdir -p "$racers"
for i in 1 2 3 4 5 6; do
  ( OMA_WATCH_LOCK_DIR="$LOCKS" OMA_WORKFLOW_BIN="$STUBBIN" bash "$WATCH" prs ops 5 >/dev/null 2>&1; echo $? > "$racers/$i" ) &
  STARTED="$STARTED $!"
done
sleep 3
winners=$(grep -lx 0 "$racers"/* 2>/dev/null | wc -l | tr -d ' ')
started_ops=$(grep -c 'watch-prs.sh ops' "$WORK/started.log" 2>/dev/null || true)
# The winner never exits (it becomes the watcher), so its file stays empty; the losers all wrote a
# code. Exactly one watcher started is the assertion that matters.
check "six simultaneous invocations start exactly one watcher" "$([ "$started_ops" -eq 1 ] && echo 0 || echo 1)" \
  "started $started_ops prs/ops watchers; loser exit codes: $(cat "$racers"/* 2>/dev/null | tr '\n' ' ')"
losers_ok=$(cat "$racers"/* 2>/dev/null | grep -cvx 0 || true)
check "every loser exited 4 (held) or 3 (undetermined), never 0" \
  "$(cat "$racers"/* 2>/dev/null | grep -qx 0 && echo 1 || echo 0)" \
  "codes: $(cat "$racers"/* 2>/dev/null | tr '\n' ' ') ($losers_ok non-zero)"

# ── 12. usage refusals ───────────────────────────────────────────────────────────────────────────
out=$(w queue not-a-role 2>&1); rc=$?
check "an unknown role is refused with the usage code (2)" "$([ "$rc" -eq 2 ] && echo 0 || echo 1)" "rc=$rc: $out"
out=$(w not-a-kind dev 2>&1); rc=$?
check "an unknown watcher kind is refused with the usage code (2)" "$([ "$rc" -eq 2 ] && echo 0 || echo 1)" "rc=$rc: $out"
out=$(w --nonsense 2>&1); rc=$?
check "an unknown option is refused rather than treated as a role" "$([ "$rc" -eq 2 ] && echo 0 || echo 1)" "rc=$rc: $out"

echo
echo "$pass passed, $fail failed, $skip skipped"
[ "$skip" -gt 0 ] && echo "SKIPS ARE NOT PASSES — each one above states what this machine could not answer."
[ "$fail" -eq 0 ] || exit 1
exit 0
