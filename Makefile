# What CI runs, and what ./.workflow/bin/run-gates.sh runs. One definition, so a green locally and a
# green on the runner are the same claim.
#
# DETERMINISM IS THE POINT AND IT IS WHY THE TOOLCHAIN IS THIS SMALL. Two pinned devDependencies
# (typescript, @types/node), both at exact versions, installed with `npm ci` from a committed
# lockfile. There is no ESLint: a linter whose diagnostics depend on its own version and on how
# files are passed to it is the documented way this project's runner and CI disagree on one tree.
# `lint` here is the TYPE CHECKER, and it is named honestly below rather than implying more.

NPM ?= npm

.PHONY: ci install build lint test clean run status stop

ci: install build lint test

install:
	$(NPM) ci --no-audit --no-fund

build:
	$(NPM) run build

# `lint` is `tsc --noEmit` under strict mode with noUnusedLocals and noUncheckedIndexedAccess.
# It is a type check, not a style check. Nothing here has an opinion about formatting, because a
# formatter's opinion is a thing that changes between versions and reddens CI for nobody's benefit.
lint:
	$(NPM) run typecheck

test:
	$(NPM) test

clean:
	rm -rf dist

# Convenience, not part of ci.
run: build
	node dist/src/cli/main.js

status:
	node dist/src/cli/main.js status

stop:
	node dist/src/cli/main.js stop
