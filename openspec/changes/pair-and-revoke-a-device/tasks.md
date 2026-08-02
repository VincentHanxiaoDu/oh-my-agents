# Tasks

A box is ticked only where the work is done AND was run. One box below is deliberately left
unticked; it is named in the pull request body rather than quietly dropped.

Every assertion listed under "watched go red" was verified by breaking the code, observing the
failure, restoring it, and observing the pass — not by reading the test.

## The store, which is the thing that must not fail open

- [x] `pairing.json` and `pairing.lock` under the directory `src/paths.ts` resolves — no second location
- [x] Three-valued read: `present` / `absent` / `undetermined`, with `absent` never equal to `undetermined`
- [x] `undetermined` covers unreadable, corrupt JSON, unrecognised schema, and a path that is a directory
- [x] A store that cannot be read is never overwritten with a fresh empty one
- [x] Locked read-modify-write, written to a temp file and renamed, so no store is observed half-written
- [x] Store written `0600`; the mesh secret is random per store, not a constant
- [x] Watched go red: widening the `ENOENT` guard so every error reads `absent` fails the denial test
- [x] Watched go red: reporting an unreadable store as `unpaired` fails two tests

## Criterion 1 — an unpaired browser gets no agent data, even over the tailnet

- [x] `requireAuth` filled in `src/server/seams.ts`; the Issue #1 refusing stub is gone
- [x] Installed in `server.ts` before any route is matched, so later routes are behind it by construction
- [x] The upgrade path is authorised ahead of the socket, so Issue #2's attach lands behind it
- [x] Ran it: an unpaired `GET /api/status` on the real tailnet address `100.100.1.3` returned the opaque 404
- [x] Watched go red: disabling the upgrade authorisation fails the attach-leaks-nothing test

## Criterion 2 — a one-time code, on demand, and then nothing typed again

- [x] `oh-my-agents pair` prints a code; the alphabet excludes I, L, O and U
- [x] Input normalised before hashing, so lowercase, spaces and O-for-0 still pair
- [x] The code itself is never stored — only its sha256
- [x] `POST /api/pair` sets an `HttpOnly; SameSite=Strict` device cookie
- [x] Ran it: paired two browsers against a live host; later requests were served with nothing re-entered

## Criterion 3 — single-use and time-limited

- [x] Redeeming a code and marking it used are one locked transaction
- [x] Five-minute code lifetime, kept explicitly distinct from the device credential's lifetime
- [x] Mistyped, spent and expired produce one identical refusal
- [x] Ran it: reusing a live code returned the same 403 bytes as a never-valid code
- [x] Watched go red: ignoring `usedAt` fails 3 tests; ignoring `expiresAt` fails 1

## Criterion 4 — listable, distinguishable, individually revocable

- [x] `oh-my-agents devices` lists each device with a label, a short id and when it paired
- [x] The label is derived from the User-Agent and is stated to be a hint, not proof
- [x] `oh-my-agents revoke <id-or-prefix>`; an ambiguous prefix revokes nothing and says so
- [x] Exit code 7 (`NO_SUCH_THING`) for a device that is not there, distinct from 5 (`undetermined`)
- [x] Ran it: listed two live devices as `iPhone · Safari` and `Android · Chrome`; `revoke deadbeef` exited 7

## Criterion 5 — revoking one leaves the others alone

- [x] Revocation marks one record and copies every other through untouched
- [x] The store is re-read on every request and not cached, so "next request" means next request
- [x] Ran it: revoked one of two live devices; it got the opaque 404 and the prompt, the other still got agent data
- [x] Watched go red: revoking all devices fails 3 tests; making revoke a no-op fails 4
- [x] The positive path is asserted first in the same test, so it cannot pass on a build that authorised nothing

## Criterion 6 — the failure leaks nothing

- [x] The denial is byte-identical to the 404 for an unknown path: status, headers, body, length
- [x] No `WWW-Authenticate`, no `Set-Cookie`, no `Vary`, no explanatory body
- [x] Asserted against the real server's actual bytes, not against a constant
- [x] Timing compared, with the measurement skipping and stating why if the machine is too jittery
- [x] Ran it: a revoked device's attach attempt returned the opaque 404; a paired one got a 501 naming Issue #2
- [x] Watched go red: a 401 carrying a host name and session count fails 6 tests

## Criterion 7 — pairing survives a host restart

- [x] Nothing about pairing is held in memory
- [x] Ran it: stopped and restarted a live host; both paired devices were served with nothing re-entered

## Criterion 8 — paired once, not again per peer

- [x] The credential is an HMAC over a mesh key, verifiable by a host that did not issue it
- [x] `verifyForeignCredential` establishes authenticity only, and says so where it is defined
- [x] `establishPeerTrust` and `propagateRevocation` refuse and name Issue #3
- [x] The assumed credential shape recorded in `ARCHITECTURE.md` so #3 builds to it

## Criterion 9 — usable one-handed at 375px

- [x] `pair.html` and `devices.html` declare the device width and make no external request
- [x] No interactive element styled below 44px; every interactive element covered by a rule at or above it
- [x] Nothing requires hover, right-click or drag; the revoke control's confirm step is the same size as the first tap
- [x] Long content wraps or scrolls in its own box rather than scrolling the page sideways
- [ ] Measured in a real browser at 375×812 — NOT DONE HERE; see the pull request body for why

## The open decision, refused rather than answered

- [x] No device-credential self-expiry, idle timeout or max-age anywhere in the build
- [x] Twelve flags implying one refuse with exit code 6 and name Issue #5
- [x] Kept explicitly distinct from the pairing code's expiry, in code comments and in `ARCHITECTURE.md`
- [x] Ran it: `--device-ttl=30d`, `--session-lifetime=7d` and `--require-reauth` each exited 6

## Keeping `status` working now that everything is behind pairing

- [x] `status` authenticates as its own host's operator by proving it can read the pairing store
- [x] Not a bearer token: recomputed per use, never stored, in no device list, not revocable
- [x] A 404 to the probe reports that the host did not recognise the operator, not that no host runs
- [x] Ran it: `status` on a live host exited 0 and reported the address and session count

## Gates

- [x] `make ci` green: 106 tests, 0 failures
- [x] `./.workflow/bin/run-gates.sh` green
