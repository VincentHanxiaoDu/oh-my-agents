# Fail a branch whose OpenSpec change cannot be archived

## Why

Nothing on a branch runs `openspec validate`. `check-tasks-complete.sh` verifies only STRUCTURALLY
that `## ADDED Requirements`, `### Requirement:` and `#### Scenario:` are present, so a change can
satisfy every gate in this repository and still be one `openspec archive` refuses. The work merges
and the specification does not, and the person who finds out is whoever merges.

It has cost two branches, with the same defect both times — lowercase `shall` in requirement BODY
text where the normative keyword must be uppercase:

- PR #10 passed all five gates, reached product at UAT, and `openspec archive` refused with 9
  errors. One full review round.
- PR #13 passed all five gates AND a thorough independent review that drove every criterion and ran
  its own mutation testing. It was caught only because someone ran `openspec validate` by hand.

A defect that survives five green gates and a careful review is exactly what a gate is for.

## What Changes

- Add `bin/check-archivable.sh`: a project-owned gate that runs `openspec validate <change> --strict`
  over the in-flight changes in scope and fails a branch carrying one openspec will not archive.
- Give it three outcomes that never share an exit code or a rendering: pass (0), NOT APPLICABLE for
  a project with no `openspec/` (0, said out loud), fail (1), and CANNOT TELL (3) when no CLI can be
  located or the tree and the range disagree.
- Locate the CLI by PROBING — `$OPENSPEC_BIN`, `$PATH`, `./node_modules/.bin`, then `npx` — so the
  gate runs on a GitHub runner that has node and no `openspec`, and on darwin where it is under nvm.
- Add `tests/archivable.test.sh`, which builds its fixture from this repository's own change by
  lowercasing `SHALL` in requirement bodies only, and asserts the unmodified copy passes in the same
  run.
- Wire both into `make ci` through a new `archivable` target, which is what CI and
  `.workflow/bin/run-gates.sh` both execute.
- Document it in `README.md` and in `.workflow/dev/AGENT.md`.

Nothing under `.workflow/bin/`, `.claude/` or `.github/` is modified: those are installer-owned and
replaced wholesale on every refresh, so a gate written there would be lost silently.
