# Archivability gate

## ADDED Requirements

### Requirement: A branch carrying an unarchivable change fails

The gate SHALL run `openspec validate <change> --strict` over every in-flight OpenSpec change in
scope, and MUST fail with exit code 1 when any of them is one `openspec archive` would refuse.

#### Scenario: lowercase shall in a requirement body

- **WHEN** a change's requirement body text uses lowercase `shall` where the normative keyword must
  be uppercase `SHALL`
- **THEN** the gate exits 1, names the change, and reproduces the validator's own errors

#### Scenario: a valid change is not obstructed

- **WHEN** every change in scope validates under `--strict`
- **THEN** the gate exits 0 and names each change it validated

### Requirement: The refusal points the author at requirement bodies

The message SHALL direct the author to rewrite requirement BODY text, and MUST warn against
uppercasing `### Requirement:` headers, because uppercasing a header renames the requirement and
moves its identifier.

#### Scenario: an author reads the refusal

- **WHEN** the gate refuses a change
- **THEN** the output says the body text is what must change and that headers stay in prose

### Requirement: A project without OpenSpec passes and says so

The gate SHALL exit 0 on a project with no `openspec/` directory, and MUST state that it is NOT
APPLICABLE rather than passing silently, so that it never becomes a permanent red that blocks every
pull request in a repository it does not apply to.

#### Scenario: a project that does not use OpenSpec

- **WHEN** the gate runs in a tree with no `openspec/` directory
- **THEN** it exits 0 and prints `NOT APPLICABLE` with the reason

### Requirement: A check that could not run is never reported as a pass

Could-not-determine and determined-to-be-nothing MUST NOT share an exit code or a rendering. The
gate SHALL exit 3 and say `CANNOT TELL`, naming what went unvalidated, when no usable `openspec`
CLI can be located, when the base sha it was given is not in the clone, or when a change in scope is
absent from the working tree.

#### Scenario: no openspec CLI anywhere

- **WHEN** there is no `openspec` on `$PATH`, none in `$OPENSPEC_BIN` or `./node_modules/.bin`, and
  `npx` cannot fetch one
- **THEN** the gate exits 3, says it CANNOT TELL, and lists the changes it did not validate

#### Scenario: an unreachable base sha

- **WHEN** the gate is given a base commit that is not in this clone
- **THEN** it exits 3 and MUST NOT report that there is no in-flight change to validate

### Requirement: The environment is probed, never named

The gate SHALL locate the CLI by probing `$OPENSPEC_BIN`, `$PATH`, `./node_modules/.bin` and then
`npx`, and MUST NOT hardcode any interpreter path or assume the host operating system, so that one
gate serves a darwin workstation and a Linux runner.

#### Scenario: a runner with node and no openspec

- **WHEN** the gate runs where `openspec` is absent but `npx` can fetch the pinned package
- **THEN** it validates through `npx` and reports a normal pass or failure

### Requirement: Scope is the branch's own work, and any widening is disclosed

Given a base sha, the gate SHALL validate only the changes the branch touches, excluding
`openspec/changes/archive/` and treating a change absent from HEAD as archived. Without a base sha
it MUST validate every in-flight change in the tree — a superset of the touched set — and SHALL
print that the scope was widened.

#### Scenario: an invalid change the branch never touched

- **WHEN** a base sha is given and an invalid change exists that the branch does not touch
- **THEN** the gate does not validate it and does not fail the branch for it

#### Scenario: a branch that archives its change

- **WHEN** the branch's only touched change has been moved into the archive
- **THEN** the gate exits 0 and says the change was archived rather than reporting nothing was found

### Requirement: A failure identifies the gate that produced it

Because `.github/workflows/` is installer-owned, this gate cannot have a commit status of its own
and fails inside the `Build and tests` job, where its red is indistinguishable from a failing unit
test. Every non-pass SHALL therefore name the gate, state that it is not a failing test or a compile
error, and give the command that reproduces it, in words that assume no knowledge that the gate
exists.

#### Scenario: a reader sees only "Build and tests failed"

- **WHEN** the gate refuses a change or reports that it could not check one
- **THEN** the output names the OpenSpec archivability gate, says it is not a failing unit test, and
  prints the command to reproduce it locally

### Requirement: The gate survives an installer refresh

The gate SHALL live in project-owned space and MUST NOT be written into `.workflow/bin/`, `.claude/`
or `.github/`, which the installer replaces wholesale, and it SHALL be reachable from `make ci`,
which both CI and `run-gates.sh` execute.

#### Scenario: the framework is reinstalled

- **WHEN** the installer refreshes `.workflow/`, `.claude/` and `.github/`
- **THEN** the gate and its tests are still present and still run from `make ci`
