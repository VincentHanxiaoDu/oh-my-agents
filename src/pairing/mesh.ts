// Criterion 8, and the part of it that is NOT this Issue's to decide.
//
// WHAT ISSUE #5 BUILT, because criterion 8 asserts it:
//
//   A device credential is verifiable by a host that did not issue it. It is an HMAC over a MESH
//   KEY (`store.meshSecret`) rather than a random token in one host's table, so a peer holding the
//   key can check a credential it has never seen. `verifyForeignCredential` below is that check
//   and it works today.
//
// WHAT ISSUE #3 STILL OWNS, and what this file refuses rather than answering:
//
//   1. HOW A PEER COMES TO HOLD THE MESH KEY. Whether hosts in a mesh share one key, or each holds
//      its own and hosts authenticate to each other and vouch for devices, is listed on Issue #3 as
//      its open decision ("how a peer is trusted when joined"). Picking one here would settle it by
//      implementation in a branch nobody reviewed for that.
//   2. HOW REVOCATION REACHES A PEER. `verifyForeignCredential` establishes AUTHENTICITY, not
//      current AUTHORISATION: only the issuing host's store knows a device was revoked. A peer that
//      accepted a foreign credential on the HMAC alone would keep serving a revoked phone, which
//      criterion 5 forbids. The mechanism — push, pull, or proxy-the-check-to-the-issuer — is #3's.
//
// The assumed shape is written down in ARCHITECTURE.md so #3 builds to this answer or replaces it
// deliberately, rather than inventing a second one.

import { macIsValid } from './credential.js';
import { NotImplementedOnThisIssue } from '../sessions/registry.js';

export type ForeignVerdict =
  /** The MAC checks out against this mesh key. Says NOTHING about revocation — see above. */
  | { kind: 'authentic'; deviceId: string }
  | { kind: 'not-authentic' };

/**
 * The half of criterion 8 that is decided: a peer can verify a credential it did not issue.
 * A caller MUST NOT treat `authentic` as authorisation without resolving revocation (#3).
 */
export function verifyForeignCredential(meshSecret: string, deviceId: string, mac: string): ForeignVerdict {
  return macIsValid(meshSecret, deviceId, mac) ? { kind: 'authentic', deviceId } : { kind: 'not-authentic' };
}

/** SEAM FOR ISSUE #3: how a joining peer comes to hold the mesh key. REFUSES. */
export function establishPeerTrust(_peerId: string, _peerAddress: string): never {
  throw new NotImplementedOnThisIssue(
    'establishing host-to-host trust (how a peer comes to hold the mesh key)',
    'Issue #3 (one view over several hosts) — its open decision, deliberately not answered on Issue #5',
  );
}

/** SEAM FOR ISSUE #3: how a revocation on one host reaches the others. REFUSES. */
export function propagateRevocation(_deviceId: string): never {
  throw new NotImplementedOnThisIssue(
    'propagating a device revocation across the mesh',
    'Issue #3 (one view over several hosts) — criterion 5 holds on the issuing host today',
  );
}
