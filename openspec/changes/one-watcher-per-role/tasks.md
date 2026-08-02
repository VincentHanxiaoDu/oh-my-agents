# Tasks

- [x] Read Issue #11 in full — the correction, the original wrong diagnosis, and the dev-role
      comment — and decide between a singleton guard and a shared backoff on the evidence that
      slowing the watchers did not help
- [x] Establish which paths are installer-owned (`.workflow/bin/`, `.claude/`, `.github/`) and which
      are project-owned (`bin/`, `tests/`, `Makefile`, `.workflow/<role>/AGENT.md`, `README.md`)
- [x] Add `bin/watch.sh`: acquire a per-role, per-kind lock, then `exec` the framework's watcher
- [x] Make the lock exclusive with `set -o noclobber` (O_CREAT|O_EXCL) rather than `flock`, which is
      absent on a stock macOS
- [x] Give `free`, `held` and `undetermined` three distinct exit codes (0 / 4 / 3) and three
      distinct renderings
- [x] Identify a holder positively by pid + process start time, so a recycled pid is not a holder
      and an exec'd holder is not a stranger
- [x] Make a stale lock takeable, so a crashed session cannot wedge a role forever
- [x] Refuse on undetermined without removing the lock, and never kill anything
- [x] Add `bin/watch.sh status <kind> <role>`, which answers without acquiring
- [x] Add `tests/watch-singleton.test.sh`: second-invocation-refuses (asserting the first acquired
      in the same test), stale-lock-is-takeable, unreadable-lock-is-undetermined-not-free, recycled
      pid, exec'd holder, kind/role independence, six-way race, usage refusals
- [x] Probe the environment in the tests rather than naming it — no `flock`, no `/proc`, no
      hardcoded `/tmp` — and skip with a stated reason where a check cannot run
- [x] Isolate the tests with `OMA_WATCH_LOCK_DIR` and `OMA_WORKFLOW_BIN` so no live watcher on this
      machine is read, signalled or stopped
- [x] Add a `Makefile` `ci:` target, without which CI refuses a project that has tests it cannot run
- [x] Mutation-run every behaviour: remove the exclusive create, collapse undetermined into 0,
      collapse held into 0, delete the stale-lock removal, treat an unreadable lock as free, and
      report a recycled pid as held — observe RED each time, restore, observe GREEN
- [x] Point `.workflow/{dev,qa,product,ops}/AGENT.md` at `./bin/watch.sh` with the reason and the
      three answers
- [x] Document the guard in `README.md`
- [x] Run `./.workflow/bin/run-gates.sh` from the worktree root on a clean tree
