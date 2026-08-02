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

## Is this branch's OpenSpec change one that can be archived?

```
make ci                                   # runs it, among everything else
make archivable OPENSPEC_BASE=origin/main # only the changes this branch touches
./bin/check-openspec-archivable.sh --self-test     # a gate that cannot be shown to fail is not a gate
```

`bin/check-openspec-archivable.sh` runs `openspec validate <change> --strict` and **fails a branch carrying
a change `openspec archive` would refuse**.

**Why.** Nothing else on a branch runs `openspec validate`. `check-tasks-complete.sh` checks only
that the required headings are *present*. Twice a change has satisfied every gate and been refused
at archive time for lowercase `shall` in requirement bodies — once after a thorough independent
review as well (Issue #12). The work merges, the specification does not, and whoever merges finds
out.

**Fix bodies, never headers.** The normative keyword must be uppercase `SHALL` or `MUST` in
requirement **body** text. `### Requirement:` headers stay in prose — uppercasing one renames the
requirement and moves its identifier.

**It has no check of its own, deliberately.** `.github/workflows/` is installer-owned, so a project
cannot add a job — `make ci` is the only seam, and this gate fails *inside* `Build and tests`. So
every non-pass names itself, says it is not a failing unit test, and prints the command to reproduce
it, rather than leaving you hunting for a broken test that does not exist.

**Four answers, and they never share an exit code.** `0` every change in scope validates; `0` +
`NOT APPLICABLE` for a project with no `openspec/`; `1` a change openspec will not archive; `3`
**CANNOT TELL** — no CLI could be located, or the base sha is not in this clone. A `3` blocks, and
says in words that nothing was validated: *could not determine* is not *determined to be nothing*.

**The CLI is probed, not named:** `$OPENSPEC_BIN`, `$PATH`, `./node_modules/.bin`, then `npx`, so it
runs on a CI runner that has node and no `openspec`. With no base sha — the CI case, since that job
checks out shallow — every in-flight change in the tree is validated instead of only the touched
ones, and the widening is printed.

It lives in `bin/` for the same reason `watch.sh` does: `.workflow/bin/`, `.claude/` and `.github/`
belong to the installer and are replaced wholesale on every refresh, so a gate written there would
vanish silently. Nothing under those paths was modified.

## Tests

```
make ci
```
