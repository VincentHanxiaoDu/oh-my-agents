# oh-my-agents

## Starting a queue or PR watcher

Start watchers through the project's own wrapper, never through `.workflow/bin/watch-*.sh` directly:

```
./bin/watch.sh queue <role> [interval]   # dev | qa | product | ops | pm
./bin/watch.sh prs   <role> [interval]
./bin/watch.sh status <kind> <role>      # who holds it — starts nothing
```

It takes a per-role, per-kind lock and then execs the framework's watcher unchanged. A second
invocation for a role already being watched **refuses and names the holder**.

**Why.** Every concurrent session runs its own pollers against ONE shared per-account GitHub quota.
19 watcher processes across 14 sessions produced a GitHub *secondary* rate limit — HTTP 403 on
every call while the primary counters read nearly full, so `gh api rate_limit` reported plenty of
quota and every queue was blind for ten minutes (Issue #11). Underneath that: two sessions holding
one role are both told to merge the same pull request.

**Three answers, three exit codes.** `0` acquired, `4` held by a live watcher, `3` **undetermined** —
there is a lock the guard cannot interpret. Undetermined is not free: do not delete a lock to get
past a `3` without identifying what holds it, and do not kill a watcher you have not identified.

The guard lives in `bin/` because `.workflow/bin/`, `.claude/` and `.github/` belong to the
installer and are replaced wholesale on every refresh. Nothing under those paths was modified.

## Tests

```
make ci
```
