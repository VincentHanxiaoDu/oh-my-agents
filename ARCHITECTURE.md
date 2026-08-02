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
| `src/server/seams.ts` | auth (#5), attach socket (#2), peer proxy (#3) | `requireAuth` built on #5; #2/#3 still refuse |
| `src/server/pairing-http.ts` | the guard in front of every route, and the pairing routes | built on #5 |
| `src/pairing/store.ts` | the pairing store on disk — **must not fail open** | built on #5 |
| `src/pairing/auth.ts` | the per-request decision: may this request see anything | built on #5 |
| `src/pairing/codes.ts` | one-time, time-limited pairing codes | built on #5 |
| `src/pairing/credential.ts` | the device credential a paired browser holds | built on #5 |
| `src/pairing/devices.ts` | pair, list, revoke | built on #5 |
| `src/pairing/operator.ts` | how `status` identifies itself to its own host | built on #5 |
| `src/pairing/mesh.ts` | verifying a credential this host did not issue | half built on #5, **half refuses to #3** |
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

### Device pairing is in front of every route (Issue #5)

Tailnet reachability is necessary trust and not sufficient trust — that is the whole reason Issue #5
exists on top of Issue #1's bind policy. `requireAuth` in `src/server/seams.ts` is real middleware,
called from `server.ts` **before any route is matched**, so a route added by a later Issue is behind
it by construction rather than by its author remembering.

**The denial is not an answer.** An unpaired, revoked or unrecognised caller gets byte-for-byte the
same 404 that an unknown path gets: same status, same headers, same body, same length, no
`WWW-Authenticate`, no `Set-Cookie`, no `Vary`. Criterion 6 requires the failure to leak nothing, so
it leaks not even the fact that authentication is what failed. The one exception is a top-level
browser **document** request, which gets the pairing prompt at 200 — that page names no agent, no
session, no machine and no host, so it discloses only what completing a TCP handshake already did.

Issue #2's attach socket **must** route through `authoriseUpgrade` / `denyUpgradeOpaquely`. The
check is installed at the upgrade path in `server.ts`, ahead of the socket, precisely so that
whatever #2 lands, it lands behind it. An upgrade handler that authenticates *after* accepting has
already told the caller a socket exists.

**A store that cannot be read denies.** `readStore` is three-valued exactly as `tailnet.ts` and
`status.ts` are: `present | absent | undetermined`. `absent` means nobody has ever paired and is a
normal first run; `undetermined` means unreadable, corrupt, wrong schema or a directory, and it
grants nothing while saying so loudly in the host's log. Nothing in the request path turns an
`undetermined` into an empty store, and `mutateStore` refuses to overwrite a store it could not
read — overwriting it would silently revoke every device the user has.

### The mesh credential — what #3 must build to (criterion 8)

Criterion 8 ("paired once, not again per peer") is **settled and built**. The shape #3 should assume:

```
device credential:  oma1.<deviceId>.<mac>
  deviceId  128 bits of randomness, hex — not secret; it is what the device list shows
  mac       HMAC-SHA256(meshSecret, "oma1|" + deviceId), base64url — the secret half
```

It is an HMAC over a **mesh key** (`store.meshSecret`, 32 random bytes, per store) rather than a
random token in one host's table, specifically so a peer can verify a credential it has never seen
while holding only the key — no copy of every device's credential. `verifyForeignCredential` in
`src/pairing/mesh.ts` is that check and it works today.

**What Issue #5 deliberately did NOT decide, and what `src/pairing/mesh.ts` refuses rather than
answering:**

1. **How a peer comes to hold the mesh key.** Whether hosts share one key, or each holds its own and
   hosts authenticate to each other and vouch for devices, is Issue #3's open decision ("how a peer
   is trusted when joined"). `establishPeerTrust()` throws `NotImplementedOnThisIssue`.
2. **How a revocation reaches a peer.** `verifyForeignCredential` establishes **authenticity**, not
   current **authorisation** — only the issuing host's store knows a device was revoked. A peer
   accepting a foreign credential on the HMAC alone would keep serving a revoked phone, which
   criterion 5 forbids. Push, pull, or proxy-the-check-to-the-issuer is #3's call.
   `propagateRevocation()` throws.

#3 should either build to this shape or replace it deliberately — not invent a second one.

### Not decided: whether a device credential ever expires on its own

Issue #5 records as unsettled whether a paired device's credential has a lifetime of its own. The
acceptance criteria assert **explicit revocation only**, and that is what is built: `oh-my-agents
revoke` ends a device and nothing else ever does. The host never checks a credential's age.

**Do not conflate this with the pairing code's expiry.** The *code* is single-use and expires in
five minutes, which criterion 3 requires and which is built. The *device credential*'s lifetime is
the open question. They are both "expiry" and merging them silently answers a question that is not
a dev branch's to answer.

Flags that would settle it — `--device-ttl`, `--credential-ttl`, `--session-ttl`,
`--session-lifetime`, `--device-max-age`, `--max-age`, `--expire-after`, `--expire-devices`,
`--idle-timeout`, `--reauth-after`, `--require-reauth`, `--pairing-lifetime` — refuse with exit code
6 and name the Issue, the same pattern Issue #1 used for `--install-service`. If the decision lands
on "credentials expire", it is enforced server-side in `authenticate()`, not by shortening the
cookie's `Max-Age`.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | the thing asked about is true |
| 1 | something went wrong |
| 3 | a host is already running here |
| 4 | we looked, and no host is running here |
| 5 | we looked, and could not tell — **not** the same as 4 |
| 6 | refused: an open product decision was asked for |
| 7 | we looked, and the thing you named is not there (Issue #5: no such paired device) |

### State on disk

`src/paths.ts` resolves, in order: `$OMA_STATE_DIR` (tests and operators), `$XDG_STATE_HOME`
(absolute only, per the spec), then `~/.local/state/oh-my-agents/`.

Issue #1 creates only `host.json` (the record), `host.lock`, and `host.log`. Issues #2
(transcripts), #3 (peers) and #5 (pairing state) put their files under the same directory using the
same helper — do not invent a second location.

Issue #5 adds `pairing.json` (mode `0600`) and `pairing.lock` there, via `stateDir()` and nothing
else. That file is what makes pairing survive a host restart (criterion 7): nothing about pairing is
held in memory, and the store is re-read on **every** request rather than cached, because a cache
with any TTL turns criterion 5's "that device's next request is rejected" into "rejected once the
cache expires". Writes are a locked read-modify-write with a rename over the target, so a store is
never observed half-written and a pairing code cannot be redeemed twice by two racing processes.

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
