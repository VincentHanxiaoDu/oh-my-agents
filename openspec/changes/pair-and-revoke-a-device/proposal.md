# Pair a device once, revoke it individually

Refs #5

## Why

Issue #1 put the host on the user's tailnet and nowhere else. That is most of the trust and it is
not all of it. A tailnet is a network of *devices*, and the person's own position is that a phone
they have handed to someone else, or lost, should stop working without anything changing on the
phones they still hold. Reachability cannot express that: every device on the tailnet is equally
reachable, so "revoke this one" has nowhere to live.

Until this change, anything that could open a socket to the host's tailnet address could list the
machine's agents. The gap is not theoretical — an old phone still enrolled in the tailnet, a work
laptop, a device lent to a family member, all reach the host and all see everything.

The risk this change has to carry is the one that authentication code fails at most often: appearing
to work. A guard that is not installed on some route, a store read that turns an unreadable file into
an empty one, a rejection that says *why* it rejected — each of those leaves a host that looks
authenticated and is not. So the substance of this change is where the check sits (in front of
everything, by construction) and what the refusal discloses (nothing).

## What Changes

- **Every route is behind a pairing check.** `requireAuth` is real middleware, called from
  `server.ts` before any route is matched, so a route added by a later Issue is behind it without
  its author remembering. The `seams.ts` stub Issue #1 left refusing is now filled.
- **A one-time pairing code, produced on demand.** `oh-my-agents pair` prints an 8-character code in
  an alphabet chosen so a code read off a screen and typed on a phone cannot become a different
  valid code. Entering it in the unpaired browser pairs it; later visits need nothing typed.
- **Codes are single-use and time-limited.** Redeeming one and marking it used are a single locked
  transaction, so two browsers racing on one code cannot both pair. Mistyped, spent and expired
  codes produce one identical refusal — telling a caller "that code was already used" confirms the
  code was real, which is the useful half of a guess.
- **Devices are listable and individually revocable**, from the CLI and from a phone, with a label
  derived from the browser's own User-Agent and labelled as the hint it is. An ambiguous id prefix
  revokes nothing and says so.
- **The rejection leaks nothing.** An unpaired or revoked caller receives byte-for-byte the 404 an
  unknown path receives — same status, headers, body and length, no `WWW-Authenticate`, no
  `Set-Cookie`. A browser asking for a *document* gets the pairing prompt instead, and that page
  names no agent, session, machine or host.
- **The attach upgrade is authorised at the upgrade path**, ahead of the socket Issue #2 has not
  landed yet, so whatever #2 lands lands behind it and an unpaired caller never learns attach exists.
- **A pairing store that cannot be read denies.** Three-valued exactly as `tailnet.ts` and
  `status.ts` are: `absent` (nobody has paired — a normal first run) is never confused with
  `undetermined` (unreadable, corrupt, wrong schema). `undetermined` grants nothing and says so
  loudly, and a store that cannot be read is never overwritten with a fresh empty one.
- **Pairing survives a host restart.** State lives in `pairing.json` under the directory
  `src/paths.ts` already resolves; nothing is held in memory.
- **A device credential is verifiable by a host that did not issue it** — an HMAC over a mesh key
  rather than a random token in one host's table — which is criterion 8's half that is decided.
- **`oh-my-agents status` authenticates as its own host's operator**, by proving it can read the
  pairing store. That is an authority the filesystem already granted, not a new one.

## Non-goals on this change

- **Whether a device credential ever expires on its own.** Unsettled on Issue #5; the criteria
  assert explicit revocation only, and that is what is built. Flags implying a lifetime refuse with
  exit code 6 rather than picking a number. This is *not* the pairing code's expiry, which is
  required by criterion 3 and is built.
- **How a peer comes to hold the mesh key, and how a revocation reaches a peer.** Issue #3's open
  decision. `src/pairing/mesh.ts` refuses both and the assumed credential shape is recorded in
  `ARCHITECTURE.md` so #3 builds to it rather than to a second answer.
- The attach socket itself (Issue #2). This change authorises the upgrade path; it does not build
  the socket.
