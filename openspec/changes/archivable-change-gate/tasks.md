# Tasks

- [x] Write `bin/check-archivable.sh`, project-owned, running `openspec validate --strict` over the changes in scope
- [x] Give it three distinguishable outcomes: pass, NOT APPLICABLE, fail, and CANNOT TELL on its own exit code
- [x] Resolve the CLI by probing `$OPENSPEC_BIN`, `$PATH`, `./node_modules/.bin` and `npx`, never by naming a path
- [x] Scope to the changes the branch touches when a base sha is given, and disclose the widened scope when one is not
- [x] Give the refusal a message that points at requirement BODIES and warns against uppercasing headers
- [x] Write `bin/check-archivable.sh --self-test` covering every arm, and watch each go red under a mutation
- [x] Write `tests/archivable.test.sh` against a fixture built from this repository's real change
- [x] Wire both into `make ci` via an `archivable` target, extending #11's Makefile in its own shape
- [x] Document the gate in `README.md` and `.workflow/dev/AGENT.md`
- [x] Run the gate against a genuinely unarchivable change and against a valid one, and against a CI-shaped environment with no `openspec` on `$PATH`
