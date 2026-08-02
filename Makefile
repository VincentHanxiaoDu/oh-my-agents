# The target CI runs, and the target `.workflow/bin/run-gates.sh` runs. One definition.
#
# The gates workflow REFUSES a project that has tests and no `ci:` target — it would otherwise go
# green having executed nothing. So a test added here without a line in this file is a red CI, by
# design, rather than a suite that never runs.

.PHONY: ci test archivable

ci: test archivable

test:
	bash ./bin/watch.sh --self-test
	bash ./tests/watch-singleton.test.sh

# Every in-flight OpenSpec change must be one `openspec archive` will accept. Twice now a change
# has passed all five gates — once also a full independent review — and been refused at archive
# time for lowercase `shall` in requirement bodies, because nothing on a branch ran
# `openspec validate`. This target is the thing that runs it.
#
# THE SELF-TEST AND THE SUITE RUN FIRST: a gate that cannot be shown to fail is not a gate, and a
# broken checker returning 0 would be the same vacuous green it exists to remove.
#
# OPENSPEC_BASE is empty by default, and that is the CI case: the `Build and tests` job checks out
# shallow, so there is no range to diff and the gate validates every in-flight change in the tree
# instead — a SUPERSET of what this branch touches, so a pass still covers the branch. Pass a base
# to narrow it to the touched changes only:  make archivable OPENSPEC_BASE=origin/main
OPENSPEC_BASE ?=

archivable:
	bash ./bin/check-openspec-archivable.sh --self-test
	bash ./tests/openspec-archivable.test.sh
	bash ./bin/check-openspec-archivable.sh $(OPENSPEC_BASE)
