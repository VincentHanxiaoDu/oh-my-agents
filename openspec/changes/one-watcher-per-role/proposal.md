# One watcher per role

## Why

Every concurrent `claude` session runs its own pollers, and they all spend ONE per-account GitHub
quota. Measured during Issue #11: **19 watcher processes across 14 sessions**, with `dev` and `qa`
each watched by two sessions at once. The result was a GitHub **secondary** (burst/concurrency)
rate limit — HTTP 403 on every call while the primary counters read nearly full (REST core
4437/5000, GraphQL 4908/5000). `gh api rate_limit` does not report secondary limits, so the obvious
diagnostic says "you have plenty of quota" and is useless. The queue was blind for about ten
minutes.

Two measurements decide the design:

- A single REST read **succeeded** during the outage while `queue.sh`'s aggregate query 403'd. It
  was a concurrency limit, not exhaustion, and calls that fan out are the trigger.
- Slowing the watchers 60s → 300s did **not** help; they 403'd on the *first* poll after restart.
  Interval is not the lever, so a backoff is not the fix — it still has N sessions colliding, just
  less often. Only stopping them cleared it.

And the structural problem that outlives the quota symptom: **two agents can hold the same role
concurrently.** Two `qa` sessions watching one queue are both told to verify, merge and close the
same pull request. The `[qa]` dedup marker makes *reporting* idempotent. It does not make *merging*
idempotent.

Explicitly ruled out by the Issue: "make the watcher exit when orphaned" — the wrong fix for a
diagnosis that turned out to be wrong, and it would have changed nothing here.

## What Changes

- **ADDED** `bin/watch.sh`, a project-owned singleton guard. It acquires a per-role, per-kind lock
  and then `exec`s the framework's `.workflow/bin/watch-<kind>.sh` unchanged. A second invocation
  for a role already being watched **refuses and names the holder**. It never kills anything.
- **ADDED** a three-valued lock answer with three distinct exit codes: `free` (0, acquire), `held`
  (4, a live holder positively identified), `undetermined` (3, a lock that cannot be interpreted).
  Undetermined never reads as free.
- **ADDED** positive identification by **pid + process start time**, so a recycled pid cannot be
  mistaken for a live holder and a live holder cannot be mistaken for a stale lock. A stale lock is
  takeable, so a crashed session cannot wedge a role forever.
- **ADDED** `tests/watch-singleton.test.sh` and a `Makefile` `ci:` target, which both CI and
  `run-gates.sh` execute. The suite probes its environment (no `flock`, no `/proc`, no hardcoded
  `/tmp`) and runs against its own lock directory, so it can never observe or disturb a live
  session's watcher.
- **ADDED** instructions in `.workflow/{dev,qa,product,ops}/AGENT.md` — project-owned files the
  installer creates once and never overwrites — telling each role to start watchers through
  `./bin/watch.sh`.
- **UNCHANGED:** nothing under `.workflow/bin/`, `.claude/` or `.github/`. Those belong to the
  installer and are replaced wholesale on every refresh, so a guard written there would be lost
  silently on the next install — the worst kind of loss, because the protection appears to exist
  and does not.

### Non-goals

- Making the framework's watchers themselves aware of the lock. That would require editing
  installer-owned files. The wrapper is the durable shape; the fix belongs upstream in
  agent-dev-flow as well, and that is noted on the pull request.
- Killing, stopping or reaping anything. The Issue asks the guard to refuse and name the holder,
  and its own postmortem is an agent killing another session's watchers on the strength of "they
  match my role", which is not identification.
