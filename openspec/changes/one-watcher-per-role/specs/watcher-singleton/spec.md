# watcher-singleton

## ADDED Requirements

### Requirement: A role is watched by at most one watcher of each kind

A second invocation of a watcher for a role already being watched SHALL refuse. It SHALL NOT start
a watcher, and it SHALL NOT stop, signal or kill the existing one.

#### Scenario: a second invocation for a watched role refuses and names the holder

- **WHEN** `bin/watch.sh queue dev` is invoked while a live watcher already holds the `queue` lock
  for `dev`
- **THEN** it exits 4 and prints the holder's pid, its command, when it started, on which host, and
  in which working tree
- **AND** it states that nothing has been started and nothing has been killed
- **AND** no second watcher process exists

#### Scenario: the first invocation actually acquires

- **WHEN** `bin/watch.sh queue dev` is invoked and no lock exists for `queue`/`dev`
- **THEN** it writes a lock naming its own pid
- **AND** it execs the framework's `.workflow/bin/watch-queue.sh dev`

#### Scenario: two watcher kinds for one role are independent

- **WHEN** a `queue` watcher holds the lock for `dev` and `bin/watch.sh prs dev` is invoked
- **THEN** the `prs` watcher starts, because one queue watcher and one PR watcher per role is the
  intended shape

#### Scenario: simultaneous invocations produce exactly one watcher

- **WHEN** six invocations for the same role and kind start at the same moment
- **THEN** exactly one watcher process is started
- **AND** every other invocation exits non-zero, never 0

### Requirement: The lock has three answers and undetermined is never free

The guard SHALL distinguish "no watcher holds this role", "a live watcher holds it" and "there is a
lock that cannot be interpreted". The three SHALL have distinct exit codes and distinct wording. A
lock that cannot be interpreted SHALL NOT be taken, removed, or reported as free.

#### Scenario: an uninterpretable lock is undetermined, not free

- **WHEN** the lock file is unparseable, has no pid, has a pid that is not a number, claims a
  different role or kind, or names a live pid with no recorded start time
- **THEN** the guard exits 3
- **AND** it says UNDETERMINED and states that this is not a statement that the role is free
- **AND** the lock file is left in place
- **AND** no watcher is started

#### Scenario: liveness cannot be determined

- **WHEN** the lock names a pid and this machine cannot tell whether that pid is alive, or cannot
  read its start time
- **THEN** the guard exits 3 rather than treating the lock as stale
- **AND** it tells the operator to identify the holder and to remove the named file by hand only if
  sure nothing is watching

#### Scenario: the three answers do not share a rendering

- **WHEN** `bin/watch.sh status <kind> <role>` is run against a free role, a held role and an
  uninterpretable lock
- **THEN** the three results have three different exit codes and three different leading words

### Requirement: A stale lock is takeable and a holder is identified positively

A lock whose holder is provably gone SHALL be takeable, so that a crashed session cannot wedge a
role forever. A holder SHALL be declared live only on pid, liveness, and evidence tying that pid to
the process that wrote the lock. The guard SHALL NOT identify a holder by name, role or interval
alone.

#### Scenario: a dead holder does not wedge the role

- **WHEN** a lock names a pid that is not running
- **THEN** the guard takes the lock and starts the watcher
- **AND** the lock is rewritten naming the new holder

#### Scenario: a recycled pid is provably stale, not a holder

- **WHEN** a lock names a pid that IS running but whose process start time differs from the start
  time recorded in the lock
- **THEN** the guard treats the lock as stale and takes it, because a process cannot change its
  start time and the original holder has therefore exited
- **AND** the unrelated process wearing that pid is not signalled or killed

#### Scenario: identification survives the holder changing its own name

- **WHEN** the holder has `exec`ed and its command line no longer names any watcher
- **THEN** it is still reported as `held`, because identity is pid plus start time and not argv

### Requirement: The guard survives an installer refresh

The durable part of the guard SHALL live in a project-owned path. Files the installer replaces
wholesale — `.workflow/bin/`, `.claude/`, `.github/` — SHALL NOT carry it.

#### Scenario: an installer refresh replaces the framework's files

- **WHEN** the installer replaces `.workflow/bin/`, `.claude/` and `.github/` wholesale
- **THEN** `bin/watch.sh`, `tests/watch-singleton.test.sh`, the `Makefile` and the role `AGENT.md`
  files are untouched, so the guard and the instruction to use it both survive

### Requirement: The guard's tests probe their environment and never touch a live watcher

The tests SHALL run against their own lock directory and their own processes. They SHALL NOT assume
`flock`, a `/proc` filesystem, or `/tmp`. Where the environment cannot support a check they SHALL
skip with a stated reason rather than pass silently.

#### Scenario: the suite runs on a machine without the tools it would like

- **WHEN** `ps -p N -o lstart=` cannot be used on this machine
- **THEN** the checks that need a process start time SKIP with that reason printed
- **AND** the summary states that skips are not passes

#### Scenario: the suite is run while other sessions are watching

- **WHEN** `make ci` runs while unrelated live watchers exist on the same machine
- **THEN** no live watcher is inspected, signalled or stopped, because the suite reads only the lock
  directory it created and stops only pids it started
