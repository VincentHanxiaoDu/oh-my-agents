# oh-my-agents

Serve a machine's coding agents over your own tailnet, with one command.

No relay to run. No tunnel binary. No account. No reverse proxy. Nothing published to the public
internet.

```
$ oh-my-agents
oh-my-agents host is serving.

REACHABILITY: tailnet
DETERMINATION: determined

Reachable from any device on your tailnet. Open this address there:

    http://100.100.1.3:8787/

On this machine:  http://127.0.0.1:8787/
Nothing is published to the public internet, and this host is not on your LAN.
```

Open that address on your phone, if your phone is on the same tailnet. That is the whole setup.

## Commands

```
oh-my-agents            start the host
oh-my-agents status     is a host running here, where, and how many sessions
oh-my-agents stop       stop the host running on this machine
oh-my-agents help       the above, plus the exit codes
```

`status` exits **0** when a host is running, **4** when it has established that none is, and **5**
when it could not tell. Those are three different answers and they never share a code — see
[ARCHITECTURE.md](ARCHITECTURE.md) for why that matters more than it sounds like it does.

## Without Tailscale

The host still starts and serves on loopback, and says so:

```
REACHABILITY: local-only
DETERMINATION: determined

LOCAL ACCESS ONLY — no other device can reach this host.
```

You will never get a host that is quietly local when you believe it is remote: the two cases are
distinguishable from the startup output alone.

## What it binds

Loopback, and your tailnet address. Never `0.0.0.0`, never your LAN. An address is bound only if
Tailscale reported it, it is inside Tailscale's own address space, and it is really on one of this
machine's interfaces. Anything else is refused out loud.

## Build and test

```
make ci          # what CI runs: npm ci, build, typecheck, tests
make run         # build and start
make stop
```

Node 20.11 or newer. Two pinned devDependencies, no runtime dependencies.

## Status

Early. The host serves and reports itself; attaching to a running agent, device pairing, and
several hosts in one view are separate pieces of work in flight. See
[ARCHITECTURE.md](ARCHITECTURE.md) for what is built and what is a named seam.

The host does **not** come back after a reboot. Whether it should install itself as a login or
system service is an open product decision, and the flags that would imply it refuse rather than
answer it.
