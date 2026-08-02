# Tasks

Every box below is ticked because the work is done and was run, not because a gate wanted it green.
What did not get built is not on this list — it is named in the pull request body instead.

## Scaffold (belongs to no single Issue; later Issues stack on it)

- [x] `package.json`, `tsconfig.json` and a committed `package-lock.json`, devDependencies pinned to exact versions
- [x] `Makefile` with a deterministic `ci:` target that installs, builds, type-checks and tests
- [x] Directory layout and module boundaries: `src/host`, `src/server`, `src/sessions`, `src/web`, `src/cli`
- [x] `ARCHITECTURE.md` recording the boundaries, the three-valued-answer rule and the exit codes
- [x] `.gitignore` entries for `node_modules/` and `dist/`
- [x] `README.md` updated to say what this is and how to run it

## Criterion 1 — one command, no further configuration

- [x] `oh-my-agents` with no arguments starts the host
- [x] Zero runtime dependencies: no relay, no tunnel binary, no proxy, no signup
- [x] Ran it: `node dist/src/cli/main.js` started and served

## Criterion 2 — reachable on the tailnet at the address it prints

- [x] `src/host/tailnet.ts` resolves the tailnet address from `tailscale status --json`
- [x] The banner prints the tailnet address when there is one
- [x] Test asserts the *printed* address answers, on a machine with a real tailnet, and skips with a stated reason elsewhere

## Criterion 3 — binds only the tailnet interface and loopback

- [x] `src/host/bind.ts`: three checks per candidate address, wildcard never returned
- [x] `assertSafeBindSet` re-asserts the invariant at the moment of binding
- [x] One HTTP listener per address, never a wildcard listen
- [x] Invariant test over adversarial input: every output is loopback or a locally-assigned Tailscale address
- [x] Live test: a connection to the machine's LAN address on the host's port fails to establish
- [x] Mutation-tested: made the host listen on `0.0.0.0` and watched the live test go red

## Criterion 4 — loopback-only is stated, and distinguishable

- [x] Four-valued tailnet detection: up / absent / down / could-not-determine
- [x] `REACHABILITY:` and `DETERMINATION:` marker lines in the banner
- [x] "Could not determine" never renders as "Tailscale is absent"
- [x] Mutation-tested: pinned the marker to `tailnet` and watched the banner tests go red

## Criterion 5 — a status command with honest exit codes

- [x] Reports running state, serving address and session count; exits 0 when running
- [x] Exits 4 when it has established nothing is running, and prints no address, port or count
- [x] Exits 5 when it cannot tell, with a distinct message
- [x] Mutation-tested twice: made not-running exit 0, and collapsed undetermined onto not-running; both went red

## Criterion 6 — survives its terminal closing

- [x] Detached process group, output redirected to `host.log`, parent unrefs
- [x] `SIGHUP` explicitly ignored rather than left to its default action
- [x] Test asserts the host is reparented away from the starter and still answers after a `SIGHUP`

## Criterion 7 — starting twice does not produce two hosts

- [x] Exclusive-create lock file with a staleness rule; exclusive port bind as the real mutex
- [x] An unreadable lock is undetermined: not taken, and not reported as a running host
- [x] Second start exits 3 and names the first host
- [x] Mutation-tested: disabled the already-running branch and watched the lifecycle test go red

## Criterion 8 — usable one-handed at 375px

- [x] `src/web/index.html`, served with no build step, no external requests
- [x] 44px floor on every interactive element; no hover, right-click or drag interaction
- [x] Structural test over the shipped HTML
- [x] Measured in a real browser at 375×812: scrollWidth 375, smallest target 44px, no overflowing element

## The decision this change does not make

- [x] No launchd plist, systemd unit or login item is installed
- [x] Flags implying reboot persistence refuse with exit code 6 and name Issue #1
- [x] Test asserts each such flag refuses and starts no host

## Seams for later Issues

- [x] `src/sessions/registry.ts` — the session interface, with an empty implementation and a refusing `spawnSession` (#2)
- [x] `src/server/seams.ts` — `requireAuth` (#5), `handleAttachUpgrade` (#2), `proxyToPeer` (#3), all refusing
- [x] `src/paths.ts` — the XDG state directory that #2, #3 and #5 will persist into
- [x] Test asserts every seam throws and names the Issue that owns it
