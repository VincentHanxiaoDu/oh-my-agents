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

oh-my-agents join <address>   join another machine's host, by the address it printed
oh-my-agents peers            the machines joined to this one
oh-my-agents forget <address> stop asking a machine
oh-my-agents agents           every agent on every joined machine, labelled with its machine
oh-my-agents agents --host <address> --host <address>
                              the same list from an explicit set of hosts, nothing joined
```

`status` exits **0** when a host is running, **4** when it has established that none is, and **5**
when it could not tell. Those are three different answers and they never share a code — see
[ARCHITECTURE.md](ARCHITECTURE.md) for why that matters more than it sounds like it does.

## Several machines, one view

Run `oh-my-agents join <address>` on each machine, pointed at the others. Every host then keeps its
own list and asks the others **directly** — there is no hub, so opening any one of them shows all of
them, and shutting one down changes nothing for the rest. No relay, no tunnel, no broker, no
account: the machines themselves are the whole of it.

A machine that does not answer is shown as **unreachable**, still named, with what it is running
stated as unknown. That is deliberately not the same as a machine with no agents — those are two
different facts and confusing them is how a list starts lying to you.

**Not finished.** How a host proves itself to a peer when joined is an open product decision on
Issue #3, and this build refuses to answer it rather than pick something. Until it is answered a
host holds no credential for its peers, so a joined machine reads as **not trusted yet** and its
agents are not listed. Failing that way round is on purpose: the alternative — hosts accepting each
other's device credentials — would let a revoked phone keep working on every machine except the one
you revoked it on.

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

Early. The host serves and reports itself, hosts can be joined into one view, and a remote attach
routes to the machine that owns the agent. Attaching itself is separate work in flight, and how a
host is trusted by a peer is an open decision that this build refuses rather than answers. See
[ARCHITECTURE.md](ARCHITECTURE.md) for what is built and what is a named seam.

The host does **not** come back after a reboot. Whether it should install itself as a login or
system service is an open product decision, and the flags that would imply it refuse rather than
answer it.
