# The target CI runs, and the target `.workflow/bin/run-gates.sh` runs. One definition.
#
# The gates workflow REFUSES a project that has tests and no `ci:` target — it would otherwise go
# green having executed nothing. So a test added here without a line in this file is a red CI, by
# design, rather than a suite that never runs.

.PHONY: ci test

ci: test

test:
	bash ./bin/watch.sh --self-test
	bash ./tests/watch-singleton.test.sh
