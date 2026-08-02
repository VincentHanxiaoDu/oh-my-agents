# Tasks

A box is ticked only where the work is done AND was run.

TWO THINGS WERE IN SCOPE AND ARE NOT HERE, and they are recorded as prose rather than as ticked
boxes, because a ticked box is a claim that something was done:

  1. Criterion 3 end to end against a REAL PTY SESSION. Issue #2 owns the attach socket, is not
     merged and is not on this branch, so there is nothing to attach to. Building a second PTY here
     would duplicate #2 and produce a conflict. What ran instead is the proxy path against a
     controllable stand-in at the upgrade boundary, which is where #2 will plug in.
  2. The 375px layout MEASURED BY HAND in a real browser. This environment has no browser. What ran
     is the set of checks decidable from the source, which is what Issue #1's own web test does and
     is described there in the same terms.

Both are named in the pull request body. Neither is ticked below.

Every assertion listed under "watched go red" was verified by breaking the code, observing the
failure, restoring it, and observing the pass — not by reading the test.

## The join records, which are where symmetry and deduplication actually live

- [x] `peers.json` under the directory `src/paths.ts` resolves — no second location
- [x] Three-valued read: `present` / `absent` / `undetermined`, with `absent` never equal to `undetermined`
- [x] One unreadable record makes the whole file `undetermined` rather than silently un-joining a machine
- [x] A file that cannot be read is never overwritten — `join` and `forget` both refuse on it
- [x] `join` is a LOCAL write, so symmetry is two joins and not a protocol with a hub
- [x] Watched go red: reporting a corrupt peers file as `absent` lets a join discard every machine

## Criterion 1 — joined by address, and either one lists both, labelled

- [x] `oh-my-agents join <address>` records a peer; `peers` lists them; `forget` removes one
- [x] A durable per-machine identity in `machine.json`, so a join survives a restart and labels agents
- [x] `GET /api/mesh` returns the unified list; every agent carries its machine and its address
- [x] Ran it: three hosts started on three ports with three state directories, joined, and listed

## Criterion 2 — symmetric, no hub, and it survives a host going away

- [x] Every host asks every peer directly; no host is in another's path
- [x] Peers are asked concurrently, each with its own deadline, so one dead peer does not stall the list
- [x] Tested by ACTUALLY SHUTTING A HOST DOWN, not by inspecting configuration
- [x] Asserted that the other two still list each other and each other's agents afterwards

## Criterion 3 — a remote attach is the same live attach

- [x] `proxyToPeer` filled in `src/server/seams.ts`; the Issue #1 refusing stub is gone
- [x] `proxyUpgrade` relays byte for byte in both directions, forwarding the client's leftover head
- [x] Verified against a controllable stand-in at the upgrade boundary: 101 returns, output streams
      unprompted, typed input arrives, a raw interrupt byte reaches the owning machine
- [x] The proxied upgrade is behind Issue #5's upgrade authorisation, with a really paired device
- [x] An attach naming an unjoined host gets the opaque 404 and does not echo the address back
- [x] Watched go red: opening a socket without a credential turns the refusal into an attempt

## Criterion 4 — unreachable is not empty, in the data AND on the screen

- [x] Four answers, and none of the four is an empty array: `listed` / `unreachable` / `not-trusted` / `undetermined`
- [x] The three non-answers carry `agents: null`, so nothing downstream can iterate and conclude "idle"
- [x] An unreachable machine is still NAMED, from its last answer or from the address it was joined at
- [x] The browser renderer is a served module a test can call, so the RENDERING is asserted, not just the payload
- [x] Four different status words, four different explanations, four different tones
- [x] Watched go red: mapping a transport failure to `listed: []` fails the payload assertion
- [x] Watched go red: rendering `unreachable` as "no agents" fails the rendering assertion

## Criterion 5 — two agents that look alike stay apart

- [x] The unified list is keyed on `hostId` plus the host's own session id
- [x] Every row names its machine, in the API, in the CLI and in the browser
- [x] Ran it: two machines each running an agent with the same title, start time and liveness — two rows
- [x] Watched go red: keying on the session id alone collapses them into one

## Criterion 6 — re-joining adds nothing

- [x] Canonical address form: five spellings of one machine resolve to one key
- [x] A second key, the peer's learned identity, collapses one machine joined at two addresses
- [x] Deduplication also applies to an explicit host list, which is not stored anywhere
- [x] The FIRST join is asserted to have succeeded in the same test, so the dedup check cannot pass vacuously
- [x] Watched go red: removing the address lookup produces a duplicate entry and a duplicated agent list

## Criterion 7 — an explicit list of hosts, nothing joined

- [x] `GET /api/mesh?host=…&host=…` and `oh-my-agents agents --host … --host …`
- [x] The join records are not consulted at all on that path, and nothing is written
- [x] The SAME assembly, so the unreachable rendering and the disambiguation cannot drift
- [x] Ran it: a host that has joined nothing lists two others named on the request

## Criterion 8 — no relay, no tunnel, no other process

- [x] Direct HTTP from the opened host to each peer's own address; no broker, no discovery, no account
- [x] Asserted that the only addresses involved in a unified list are the hosts' own
- [x] No new unauthenticated route: peer traffic is an ordinary request behind Issue #5's guard

## Criterion 9 — one-handed at 375px

- [x] The machine list, the status pills, the agent rows and the join control
- [x] Every interactive target at or above 44px, including the new text input
- [x] Nothing behind hover, right-click or drag; the status is a WORD, not only a colour
- [x] Long addresses and long failure reasons wrap; the join row wraps rather than widening the page
- [x] Issue #1's own web test was extended rather than weakened, so an unsized input still fails it

## The two open decisions — refused, not answered

- [x] `establishPeerTrust()` and `propagateRevocation()` still throw
- [x] The shipped credential supplier grants nothing for every peer, and carries the refusal as a
      VALUE so it renders as "not trusted yet" beside a named machine rather than breaking the page
- [x] Flags that would settle either half refuse with exit code 6 and name the Issue
- [x] `verifyForeignCredential` is called from NO request path — no host accepts a foreign device credential
- [x] Asserted from the outside: a credential issued by host A is refused by host B with Issue #5's
      byte-identical 404
- [x] Watched go red: accepting a foreign credential on the HMAC alone turns that 404 into a 200
- [x] Watched go red: a shipped supplier that hands out a credential fails the "not trusted" assertions

## Fixed on the way

- [x] A host with an upgraded socket could never finish shutting down: Node detaches the socket from
      the server's connection set while still counting it, so `close()`'s callback never fires.
      Upgraded sockets are now tracked and destroyed on close. Measured with a bare server first.
