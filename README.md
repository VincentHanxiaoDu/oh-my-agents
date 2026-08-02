# oh-my-agents

## Where project-owned machinery lives — `bin/`, and it reaches CI through `make ci`

**This is the project's convention, not a detail of any one tool.** Read it before adding a wrapper,
a gate, a hook or a check anywhere.

`.workflow/bin/`, `.claude/` and `.github/` **belong to the installer and are replaced WHOLESALE on
every refresh** — which has already happened twice in one round, mid-flight, with branches open.
Anything written there is lost on the next install *silently*, and a protection that appears to
exist and does not is worse than none at all.

| Path | Owner | Safe to put machinery in? |
| --- | --- | --- |
| `bin/` | project | **yes — this is the place** |
| `tests/`, `Makefile` | project | yes |
| `.workflow/<role>/AGENT.md` | project — installer creates ONCE, never overwrites | yes, for instructions to a role |
| `README.md` | project | yes, for the convention itself |
| `.workflow/bin/` | installer | **no — replaced wholesale** |
| `.claude/` | installer (and `.claude/commands/` is gitignored) | **no** |
| `.github/` | installer | **no** |

The rules that follow from it:

1. **Put the executable in `bin/`.** Never edit an installer-owned file to add project behaviour.
2. **Do not fork the framework's tool — wrap it.** `bin/watch.sh` acquires a lock and then `exec`s
   `.workflow/bin/watch-queue.sh` unmodified, so the framework can change underneath it without a
   merge conflict and without the wrapper going stale.
3. **Point roles at the wrapper from `.workflow/<role>/AGENT.md`.** That is the only per-role file
   the installer creates once and never overwrites, so it is where "use this instead" survives.
4. **A project-owned CHECK reaches CI through `make ci`, and only through it.** `.github/workflows/`
   is installer-owned, so a project cannot add a job — but the installer's own `Build and tests` job
   already runs `make ci` when a `ci:` target exists, and `run-gates.sh` runs the same target
   locally. That `ci:` target is the one durable seam between project-owned machinery and the gates.
   It is also load-bearing in the other direction: CI **fails** a repository that has tests and no
   `ci:` target, rather than going green having executed nothing.
5. **State the ownership in the pull request.** If a change genuinely must touch an installer-owned
   file, name the file and say that it is lost on the next refresh and what the recovery is. An
   *undeclared* edit to an installer-owned file is the failure mode this convention exists to stop.
6. **Fix it upstream too.** A guard that lives only here protects only this repository. Where the
   defect is the framework's, open an Issue on `VincentHanxiaoDu/agent-dev-flow` as well — a fix
   that is upstream and not here is a fix nobody has, and the reverse is a fix that evaporates.

`bin/watch.sh` is the first thing built to this convention. Anything project-owned that follows —
a gate, a wrapper, a hook — belongs in `bin/`, tested from `tests/`, wired in through `ci:`.

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

## Before pushing an OpenSpec change

```
openspec validate <change-name> --strict     # must report "is valid"
```

**Green gates do NOT mean your change is archivable.** `check-tasks-complete.sh` only verifies
structurally that `## ADDED Requirements`, `### Requirement:` and `#### Scenario:` exist; nothing
runs `openspec validate`, so a change can pass all five gates and then be refused at archive time.
The usual cause is a lowercase `shall` in requirement BODY text — the validator requires the
uppercase normative keyword (`SHALL`/`MUST`). Uppercase it in bodies only; uppercasing a
`### Requirement:` header renames the requirement and moves its identifier.

Automating this is Issue #12, and it is the first check that should follow the convention above:
`bin/`, tested from `tests/`, reaching CI through `make ci`.
