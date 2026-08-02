# Architecture

This document is the contract between Issues. It was written on Issue #1, which established the
project scaffold and the module boundaries; Issues #2–#9 stack on it. If you are about to add a
module, add it here first — a boundary that exists only in someone's head is a boundary two agents
will draw differently.

## The shape of the thing

One process per machine. It owns the machine's agent sessions, serves a browser client, and is
reachable over the user's own tailnet and nowhere else. There is no relay, no tunnel binary, no
account, and no reverse proxy — that absence is the product.

```
oh-my-agents (CLI)
  └─ start ──> a detached host process
                 ├─ tailnet detection ──> bind policy ──> HTTP listeners (one per address)
                 ├─ session registry
                 └─ state on disk  (~/.local/state/oh-my-agents/)
  └─ status ──> reads that state, probes the host over loopback
  └─ stop   ──> signals it
```

## Modules and what owns them

| Path | Owns | Status after Issue #1 |
| --- | --- | --- |
| `src/cli/main.ts` | the single command, `status`, `stop`, exit codes | built |
| `src/cli/exit-codes.ts` | every exit code, in one place | built |
| `src/host/daemon.ts` | detaching, readiness, the daemon body | built |
| `src/host/lock.ts` | the single-instance lock | built |
| `src/host/tailnet.ts` | detecting Tailscale, resolving the tailnet address | built |
| `src/host/bind.ts` | **which interfaces to listen on — the security boundary** | built |
| `src/host/banner.ts` | the startup output | built |
| `src/host/state.ts` | the record a running host publishes | built |
| `src/host/status.ts` | answering "is a host running here" | built |
| `src/server/server.ts` | HTTP, static client, `/api/status` | built, minimal |
| `src/server/seams.ts` | auth (#5), attach socket (#2), peer proxy (#3) | **refusing stubs** |
| `src/sessions/registry.ts` | the session interface; PTY sessions are #2 | interface + empty impl |
| `src/web/` | the browser client, served with no build step | minimal, mobile-safe |
| `src/paths.ts` | the XDG-respecting state directory | built |

### `src/host/bind.ts` is the security boundary

Everything the product will ever serve is reachable by anything that can open a socket to an address
`resolveBind` returns. The invariant, asserted in `test/bind.test.ts` against adversarial input:

> For any input, every returned address is loopback, or an address that Tailscale reported AND is
> inside Tailscale's own address space (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) AND is assigned to a
> local interface. `0.0.0.0` and `::` are never returned.

`assertSafeBindSet` re-checks this at the moment of binding, so a plan from anywhere other than
`resolveBind` cannot reach a socket. Do not add a "listen on all interfaces" option. If a later
Issue needs LAN reach, that is a product decision and belongs on an Issue, not in a flag.

### Three-valued answers, everywhere

`tailnet.ts` returns `up | absent | down | undetermined`. `state.ts` returns
`present | absent | undetermined`. `status.ts` returns `running | not-running | undetermined`.
`lock.ts` returns `acquired | held | undetermined`.

**"Determined to be nothing" and "could not determine" never share a value, a rendering, or an exit
code.** "Tailscale is not installed" and "I could not tell whether Tailscale is installed" lead a
user to different actions, and one of those actions is starting a second host beside a working one.
Any new answer a later Issue adds must carry the same distinction.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | the thing asked about is true |
| 1 | something went wrong |
| 3 | a host is already running here |
| 4 | we looked, and no host is running here |
| 5 | we looked, and could not tell — **not** the same as 4 |
| 6 | refused: an open product decision was asked for |

### State on disk

`src/paths.ts` resolves, in order: `$OMA_STATE_DIR` (tests and operators), `$XDG_STATE_HOME`
(absolute only, per the spec), then `~/.local/state/oh-my-agents/`.

Issue #1 creates only `host.json` (the record), `host.lock`, and `host.log`. Issues #2
(transcripts), #3 (peers) and #5 (pairing state) put their files under the same directory using the
same helper — do not invent a second location.

### The browser client has no build step

`src/web/index.html` is served as written. No bundler, no framework, no external requests. It is
copied verbatim into `dist/` at build time so `dist/` is a complete runnable tree. Everything it
shows comes from `GET /api/status`.

Criterion 8 of Issue #1 binds every human-facing surface this product ever grows: usable one-handed
at 375px, no horizontal page scroll, no interactive target under 44px, nothing requiring hover,
right-click or drag. `test/web.test.ts` checks what is decidable from the source; the layout itself
was measured in a real browser at 375×812.

## Toolchain

TypeScript on Node, compiled to `dist/`, tested with `node:test`. Two devDependencies
(`typescript`, `@types/node`), both pinned to exact versions, installed with `npm ci` from a
committed lockfile. `make ci` is what CI runs and what `./.workflow/bin/run-gates.sh` runs.

There is deliberately **no ESLint or formatter**: a linter whose diagnostics depend on its own
version is the documented way a local green becomes a CI red on one tree. `make lint` is
`tsc --noEmit` under `strict` + `noUnusedLocals` + `noUncheckedIndexedAccess`, and it is named
honestly rather than implying a style check that is not happening.

## Not built, and deliberately

**Reboot persistence.** Issue #1 records as unsettled whether the host installs itself as a
login/system service. This build survives its terminal closing (`detached`, output to a file,
`SIGHUP` ignored) and installs **no** launchd plist, systemd unit or login item. Flags that would
imply it — `--install-service`, `--launchd`, `--systemd`, `--enable-at-login`, and others — refuse
with exit code 6 and name the Issue. Do not "fix" this by picking an answer.
