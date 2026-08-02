# Project-specific instructions for the dev role

**This file is yours. The installer creates it once and never overwrites it.** Everything in
`.claude/commands/` belongs to the framework and is replaced on every install, so anything you add
there is lost — put it here instead.

What belongs here: this project's build and test commands, its domain vocabulary, conventions a
newcomer would get wrong, and anything the dev role needs that is true of this project and not of
every project.

What does not: how the process works. That is the framework's half, and if you find yourself
restating it here, the framework is missing something — change it there.

## Starting a watcher: use `./bin/watch.sh`, never `.workflow/bin/watch-*.sh` directly

```
./bin/watch.sh queue dev 60      # instead of ./.workflow/bin/watch-queue.sh dev 60
./bin/watch.sh prs   dev 60      # instead of ./.workflow/bin/watch-prs.sh   dev 60
./bin/watch.sh status queue dev  # who, if anyone, is watching — starts nothing
```

`bin/watch.sh` takes a per-role lock and then execs the framework's watcher unchanged. If another
session is already watching this role it **refuses and names the holder** rather than quietly
running a second one.

**Why it matters, from Issue #11.** Every session runs its own pollers and they all spend ONE
per-account GitHub quota: 19 watcher processes across 14 sessions produced a GitHub *secondary*
rate limit, HTTP 403 on every call, with the primary counters reading nearly full — so
`gh api rate_limit` said there was plenty of quota and the queue was blind for ten minutes.
Slowing the watchers down did not help; they 403'd on the first poll after restart. And underneath
the quota symptom: two `dev` sessions watching one queue are both told to act on the same pull
request, which the `[dev]` dedup marker does not make safe.

**Read its three answers as three answers.** Exit 0 acquired, 4 held by a live watcher, 3
UNDETERMINED — there is a lock it cannot interpret. **Undetermined is not free.** Do not remove a
lock file to get past a 3 without first identifying what holds it, and do not kill a watcher you
have not identified; that is the mistake in this Issue's own postmortem.

The guard lives in `bin/`, which belongs to this project. `.workflow/bin/` belongs to the installer
and is replaced wholesale on every refresh, so a guard written there would vanish silently on the
next install. Nothing under `.workflow/bin/` was modified.

## Before you push a change: `make archivable`

```
make archivable OPENSPEC_BASE=origin/main   # only the changes your branch touches
./bin/check-openspec-archivable.sh --self-test       # the gate's own arms
```

`bin/check-openspec-archivable.sh` runs `openspec validate <change> --strict`. **`make ci` runs it, so CI
runs it** — you do not have to remember, and that is the point.

**Why it exists, from Issue #12.** No other gate on a branch runs `openspec validate`.
`check-tasks-complete.sh` checks only that `## ADDED Requirements`, `### Requirement:` and
`#### Scenario:` are *present*. So a change can be green on all five gates and still be one
`openspec archive` refuses. It happened twice, with the same defect: PR #10 reached product at UAT
and was refused with 9 errors; PR #13 passed all five gates *and* a thorough independent review and
was caught only because someone ran `openspec validate` by hand.

**The defect, and the fix that is NOT the fix.** Requirement **body** text must use uppercase
`SHALL` or `MUST`. Leave `### Requirement:` **headers in prose** — uppercasing a header renames the
requirement and moves its identifier, which breaks more than it fixes.

**A red from this gate says "Build and tests failed".** It cannot have a check of its own —
`.github/workflows/` is installer-owned and a project cannot add a job, so `make ci` is the only
seam. When it refuses, the output names itself and tells you it is not a failing unit test. Do not
go looking for a broken test.

**Read its answers as four answers.** `0` validated; `0` + `NOT APPLICABLE` (no `openspec/` here);
`1` a change openspec will not archive; `3` **CANNOT TELL** — no `openspec` CLI could be located, or
the base sha is not in this clone. A `3` is not a verdict about your specification and not a pass:
nothing was validated. Do not "fix" a `3` by editing your spec; install the CLI or fetch the base.

The gate lives in `bin/`, which belongs to this project. `.workflow/bin/` is replaced wholesale on
every installer refresh, so a gate written there would vanish silently. Nothing under
`.workflow/bin/` was modified.
