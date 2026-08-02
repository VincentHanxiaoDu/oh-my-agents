// HOW A HOST AUTHENTICATES ITSELF TO A PEER. THIS IS THE OPEN DECISION AND IT IS NOT ANSWERED HERE.
//
// ─── WHAT IS UNDECIDED ───────────────────────────────────────────────────────────────────────────
//
// Issue #3 lists, under "Blocked on a decision": *how a peer is trusted when joined — whether the
// pairing credential from the auth capability is reused for host-to-host, or hosts authenticate to
// each other separately*. Issue #5 refused to settle it and left `establishPeerTrust()` throwing.
// It still throws. Nothing in this file establishes trust; this file only supplies whatever
// credential a host ALREADY has for a peer, and on this branch a host has none.
//
// ─── WHY A PLAUSIBLE DEFAULT WOULD HAVE BEEN WORSE THAN A REFUSAL ────────────────────────────────
//
// The obvious implementation is one line: put the same `meshSecret` on every host in the tailnet and
// let each one present the other's operator proof. It would have made every criterion below green
// today. It is not taken, for two reasons that are not stylistic:
//
//   1. It makes one key the authority for every machine a person owns. Reading `pairing.json` on
//      the least-defended box in the mesh then grants operator authority on all of them — including
//      the authority to add a paired device. That is a different security model from the one Issue
//      #5 shipped and reviewed, and changing a security model is not a dev branch's call.
//   2. It answers the SECOND open question by accident. A shared key makes
//      `verifyForeignCredential` succeed on every host, and a host that accepts a foreign device
//      credential on the HMAC alone serves a phone that was revoked somewhere else — see below.
//
// ─── THE SECOND OPEN QUESTION, AND WHY THIS BUILD FAILS CLOSED ───────────────────────────────────
//
// `verifyForeignCredential` establishes AUTHENTICITY, not current AUTHORISATION: only the issuing
// host's store knows a device was revoked. Push, pull and proxy-the-check-to-the-issuer all work and
// all have different failure modes, and choosing between them is Issue #3's second open decision.
//
// UNTIL IT IS DECIDED, THIS BUILD NEVER ACCEPTS A FOREIGN DEVICE CREDENTIAL FOR ANYTHING.
// `verifyForeignCredential` is not called from any request path on this branch. Every device is
// authenticated by the host it opened, against that host's own store, on every request — which is
// exactly Issue #5's criterion 5 and is unweakened. A peer request is HOST-to-host and carries a
// HOST's credential, never a device's, so there is no path on which a revoked phone is served by a
// peer. What that costs is written down in `refusalNote` below and in the pull request.

import { NotImplementedOnThisIssue } from '../sessions/registry.js';
import { establishPeerTrust } from '../pairing/mesh.js';
import type { PathEnv } from '../paths.js';

/**
 * What a host presents to a peer to be served by it.
 *
 * `operator` is the ONLY form that exists, and it is Issue #5's existing operator proof — an
 * authority the filesystem already granted, not a new one. On this branch a host holds one only for
 * ITSELF, which is why `meshCredentialSupplier` returns `none` for every peer.
 */
export type PeerCredential =
  | { kind: 'operator'; proof: string }
  | { kind: 'none'; reason: string };

/** Asked once per peer, per view. Async so a later decision may involve a round trip. */
export type CredentialSupplier = (peer: { address: string; hostId: string | null }) => Promise<PeerCredential> | PeerCredential;

export const REFUSAL_NOTE =
  'this host holds no credential for that peer: how a host authenticates to a peer when joined is ' +
  'an OPEN PRODUCT DECISION on Issue #3 and this build refuses to answer it rather than picking one';

/**
 * The supplier this build ships. It grants nothing, for every peer, and says why.
 *
 * NOTE WHAT IT DOES NOT DO: it does not throw. A throw here would take out the whole unified view,
 * including the local host's agents and including the peers' *reachability*, and the person would
 * see a broken page instead of an honest "not trusted yet" beside each machine. The refusal is
 * carried as a VALUE, all the way to the rendering, which is where a person can act on it.
 */
export function meshCredentialSupplier(_env: PathEnv = process.env): CredentialSupplier {
  return () => ({ kind: 'none', reason: REFUSAL_NOTE });
}

/**
 * The loud form, for anything that cannot carry a value — a CLI flag, a wiring mistake.
 * Delegates to Issue #5's seam so there is ONE refusal, not a second one that could drift.
 */
export function refuseToEstablishTrust(peerId: string, peerAddress: string): never {
  try {
    establishPeerTrust(peerId, peerAddress);
  } catch (err) {
    throw err;
  }
  throw new NotImplementedOnThisIssue('establishing host-to-host trust', 'Issue #3 (one view over several hosts)');
}
