# Serve a machine's agents over my tailnet with one command

Refs #1

## Why

Reaching a machine's coding agents from a phone currently costs a Python relay, `cloudflared`, a
system service and a per-machine tunnel before anything appears in a browser. Each of those is a
process to install, a thing to keep running, and an account to hold. The cost is paid per machine,
and it is paid before any value arrives.

People who already run Tailscale have a private network between their own devices that is up,
authenticated and routable. A host that binds its tailnet address needs none of the rest: no relay
to run, no tunnel to keep alive, nothing published to the public internet.

The risk this change has to carry is that "reachable from my phone" and "reachable from the coffee
shop's LAN" look identical to the person typing the command. So the bind policy is the substance of
this change, and the startup output has to make the two cases impossible to confuse.

## What Changes

- **A single command starts a host.** `oh-my-agents` starts a detached process that serves. No
  tunnel binary, no relay, no signup, no reverse proxy, and no second command afterwards.
- **The host binds only the tailnet and loopback.** Never a wildcard. A candidate tailnet address is
  bound only if Tailscale reported it, it is inside Tailscale's own address space, and it is
  assigned to a local interface. Anything else is refused, named, and the host falls back to
  loopback.
- **Tailscale detection distinguishes four outcomes** — up, absent, down, and could-not-determine —
  and the last never renders as one of the others.
- **The startup banner states reachability in a line a person and a script can both read.** The
  tailnet case and the loopback-only case are distinguishable from the output alone.
- **A status command** reports whether a host is running here, its serving address and its session
  count, exits 0 when running, 4 when it has established that nothing is running, and 5 when it
  could not tell.
- **Starting twice does not produce two hosts.** The second invocation reports the first and exits
  non-zero. A lock file with a staleness rule catches it early; the exclusive port bind is the
  actual mutex.
- **The host outlives its terminal**, and does not install itself to outlive a reboot — that is an
  open product decision, and flags implying it refuse loudly rather than answer it.
- **A minimal browser client**, served with no build step, usable one-handed at 375px.
- **The project scaffold**: TypeScript on Node, `make ci`, the directory layout, and the module
  boundaries that Issues #2–#9 stack on. Recorded in `ARCHITECTURE.md`.

## Non-goals on this change

- PTY-backed sessions and attaching to them (Issue #2). The registry interface exists; the
  implementation refuses.
- Authentication and device pairing (Issue #5). The seam exists and refuses; no permissive default
  is installed anywhere in the request path.
- Several hosts in one view over the tailnet (Issue #3).
- Coming back after a reboot. Unsettled on Issue #1.
