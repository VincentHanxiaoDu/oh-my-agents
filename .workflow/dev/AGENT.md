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
