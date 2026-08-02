# One view over several hosts

Refs #3

## Why

A person with agents on three machines has three bookmarks and has to remember which box the
refactor is on. Issue #1 put one host on the tailnet and Issue #5 put a pairing check in front of
it; neither made a second machine visible from the first. The product's own framing is "connect to
any host and it proxies the others" — any host is the hub, which means none of them is.

The risk this change carries is not that the list is hard to build. It is that the list quietly
LIES. A machine that has gone to sleep and a machine that is idle are one `?? []` apart in every
implementation of this, and once they render the same the list is worse than no list: a person
looks at "no agents" on a machine that is actually running four of them and concludes the work
finished. So the substance here is the shape of the answer — four values, none of which is an empty
array — carried unbroken from the socket to the screen.

The second risk is the one Issue #5 wrote down and refused to resolve: a credential is verifiable by
a host that did not issue it, but only the ISSUING host knows whether it has been revoked. A mesh
built on the HMAC alone keeps serving a phone that was given away. That is a decision, not a
detail, and this change does not make it.

## What Changes

- **A host is joined to another by address, and the join is durable and local.** Each host keeps its
  own peer records in the state directory `src/paths.ts` already resolves. There is no membership
  document, no leader and no gossip — symmetry is two local joins, one on each machine.
- **Opening any host lists every machine's agents, labelled with the machine.** The host asks each
  peer directly, concurrently, each with its own deadline, so one sleeping laptop does not stall
  the list.
- **Shutting a host down does not stop the rest seeing each other**, because no host was ever in
  anyone else's path.
- **Four answers per machine, and none of them is an empty list.** `listed` (possibly zero agents, a
  determined fact), `unreachable`, `not-trusted`, `undetermined`. The last three carry no agent list
  at all. Both the API payload and the browser client distinguish them, and the browser renderer is
  a served module a test can call rather than script buried in a page.
- **Two agents sharing a name, working directory or runtime stay apart**, because the unified list
  is keyed on the machine as well as the session id and every row names its machine.
- **Joining an already-joined host adds nothing**, deduplicated on a canonical address and, once a
  peer has answered, on its identity — so one machine reached at two addresses is one entry.
- **A client can be pointed at an explicit list of host addresses** and get the same unified list
  from the same assembly, with nothing joined to anything.
- **Nothing requires a relay, a tunnel or any process outside the hosts.** Direct HTTP between
  hosts, over the network Issue #1 put them on.
- **Attaching to an agent on another machine routes to the owning host**, as a byte-for-byte
  bidirectional relay so output, input and an interrupt traverse it unchanged.
- **Every mesh surface is usable one-handed at 375px** — no horizontal scroll, no target under
  44px, nothing behind hover, right-click or drag.

## Non-goals on this change

- **How a host authenticates to a peer when joined.** Issue #3's own listed open decision.
  `establishPeerTrust()` throws and the shipped credential supplier grants nothing for every peer;
  flags that would settle it refuse with exit code 6. **A joined mesh therefore does not list a
  peer's agents in this build** — everything around that decision is built, and the decision is
  left visible.
- **How a revocation reaches a peer.** The second half of the same decision.
  `propagateRevocation()` throws. Until it is answered **no host accepts a device credential issued
  by another host**: every device is authenticated by the host it opened, against that host's own
  store, on every request. Failing closed costs a working mesh today; failing open would cost a
  revocation that does not take effect, which Issue #5's criterion 5 forbids.
- **The attach socket itself (Issue #2).** This change builds the route to the owning host and
  verifies it against a controllable stand-in at the upgrade boundary. It does not build a PTY.
