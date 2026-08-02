// The operator: a process on this machine that can read the pairing store.
//
// WHY THIS EXISTS. `oh-my-agents status` probes the running host over loopback and asks it for a
// session count. Once every route is behind pairing, that probe is a request from an unpaired
// client and it gets the same opaque 404 as anything else — which turns `status` into a permanent
// `undetermined` on a host that is serving perfectly well. That is a real regression and it is not
// fixed by exempting loopback: anything on this machine can open a loopback socket, and Issue #1's
// whole position is that reachability is not trust.
//
// WHAT IS ACTUALLY BEING CHECKED. The proof is an HMAC over the store's own mesh key. Computing it
// requires READING THE PAIRING STORE — and a process that can read the pairing store could just as
// well add a device to it. So this grants nothing that was not already implied by filesystem
// access; it makes an existing authority usable instead of inventing a new one. It is emphatically
// NOT a bearer token to hand out: it is recomputed from the store on each use and never stored.
//
// IT IS NOT A DEVICE. It appears in no device list, it cannot be revoked (revoking filesystem
// access is the filesystem's job), and it is not a credential a browser can hold — the browser
// never has the store.

import { createHmac } from 'node:crypto';
import { constantTimeEquals } from './credential.js';
import { readStore } from './store.js';
import type { PathEnv } from '../paths.js';

export const OPERATOR_HEADER = 'x-oma-operator';

const OPERATOR_CONTEXT = 'oma-operator-v1';

export type ProofResult = { kind: 'ok'; proof: string } | { kind: 'unavailable'; reason: string };

/** Compute the proof. Fails — it does not invent one — when the store cannot be read. */
export function operatorProof(env: PathEnv = process.env): ProofResult {
  const read = readStore(env);
  if (read.kind === 'absent') return { kind: 'unavailable', reason: 'this host has no pairing store yet' };
  if (read.kind === 'undetermined') return { kind: 'unavailable', reason: read.reason };
  return { kind: 'ok', proof: proofFor(read.store.meshSecret) };
}

function proofFor(meshSecret: string): string {
  return createHmac('sha256', Buffer.from(meshSecret, 'hex')).update(OPERATOR_CONTEXT, 'utf8').digest('hex');
}

/**
 * Verify a presented proof against a mesh key.
 *
 * Only called when the header is actually present, so a request that does not carry one does no
 * extra work — the denial path stays identical in cost to an ordinary 404, which criterion 6
 * requires. Compared in constant time regardless.
 */
export function operatorProofIsValid(meshSecret: string, presented: string | undefined): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  return constantTimeEquals(proofFor(meshSecret), presented);
}
